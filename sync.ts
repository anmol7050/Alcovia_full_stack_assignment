import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import {
  SyncPayload,
  SyncResponse,
  FocusSessionEvent,
  TaskUpdateEvent,
  StudentState,
  SubjectState,
} from '../db/types';
import axios from 'axios';

const router = Router();

const COINS_PER_SESSION = 50;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/focus-success';
const MOCK_NOTIFICATION_URL = process.env.MOCK_NOTIFICATION_URL || 'http://localhost:3001/mock-notify';

// ─────────────────────────────────────────────
// Lamport clock helpers
// ─────────────────────────────────────────────
function getServerClock(db: any): number {
  const row = db.prepare("SELECT value FROM server_state WHERE key='lamport_clock'").get() as any;
  return parseInt(row.value, 10);
}

function advanceClock(db: any, incomingClock: number): number {
  const current = getServerClock(db);
  const next = Math.max(current, incomingClock) + 1;
  db.prepare("UPDATE server_state SET value=? WHERE key='lamport_clock'").run(String(next));
  return next;
}

// ─────────────────────────────────────────────
// POST /api/sync
// ─────────────────────────────────────────────
router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const payload = req.body as SyncPayload;

  if (!payload || !payload.device_id || !payload.student_id) {
    return res.status(400).json({ error: 'Invalid sync payload' });
  }

  const serverLamport = advanceClock(db, payload.device_lamport);

  const accepted: string[] = [];
  const rejected: string[] = [];

  const processAll = db.transaction(() => {
    // 1. Process focus session events
    for (const evt of payload.focus_events || []) {
      const result = processFocusEvent(db, evt);
      if (result.accepted) {
        accepted.push(evt.event_id);
        if (result.shouldNotify) {
          triggerN8nNotification(db, evt).catch((e) =>
            console.error('N8n notification error:', e.message)
          );
        }
      } else {
        rejected.push(evt.event_id);
      }
    }

    // 2. Process task update events
    for (const evt of payload.task_events || []) {
      const result = processTaskEvent(db, evt);
      if (result.accepted) {
        accepted.push(evt.event_id);
      } else {
        rejected.push(evt.event_id);
      }
    }
  });

  processAll();

  // 3. Build full state response
  const state = buildFullState(db, payload.student_id, serverLamport);
  const response: SyncResponse = {
    ...state,
    server_lamport: serverLamport,
    accepted_event_ids: accepted,
    rejected_event_ids: rejected,
  };

  return res.json(response);
});

// ─────────────────────────────────────────────
// GET /api/sync/state/:studentId
// ─────────────────────────────────────────────
router.get('/state/:studentId', (req: Request, res: Response) => {
  const db = getDb();
  const state = buildFullState(db, req.params.studentId, getServerClock(db));
  return res.json(state);
});

// ─────────────────────────────────────────────
// Focus session processing
// ─────────────────────────────────────────────
function processFocusEvent(
  db: any,
  evt: FocusSessionEvent
): { accepted: boolean; shouldNotify: boolean } {
  // Idempotency: skip already-processed events
  const alreadyProcessed = db
    .prepare('SELECT 1 FROM processed_events WHERE event_id=?')
    .get(evt.event_id);
  if (alreadyProcessed) {
    return { accepted: false, shouldNotify: false };
  }

  // Mark as processed immediately (prevents double-processing in concurrent syncs)
  db.prepare("INSERT INTO processed_events VALUES (?, datetime('now'))").run(evt.event_id);

  // Check if session already exists (could be from same device different event_id scenario)
  const existing = db
    .prepare('SELECT * FROM focus_sessions WHERE session_id=?')
    .get(evt.session_id) as any;

  if (existing) {
    // Session exists: only update if incoming has higher lamport clock
    // and existing is not already in a terminal state
    if (existing.status !== 'pending' && evt.lamport_clock <= existing.lamport_clock) {
      return { accepted: false, shouldNotify: false };
    }
    // Update terminal state if newer
    if (existing.status === 'pending') {
      db.prepare(`
        UPDATE focus_sessions SET
          status=?, fail_reason=?, completed_at=?, lamport_clock=?, synced_at=datetime('now')
        WHERE session_id=? AND status='pending'
      `).run(
        evt.status,
        evt.fail_reason || null,
        evt.completed_at || null,
        evt.lamport_clock,
        evt.session_id
      );
    }
  } else {
    // New session: insert
    db.prepare(`
      INSERT INTO focus_sessions
        (session_id, student_id, target_minutes, started_at, completed_at,
         status, fail_reason, device_id, lamport_clock, synced_at, notification_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 0)
    `).run(
      evt.session_id,
      evt.student_id,
      evt.target_minutes,
      evt.started_at,
      evt.completed_at || null,
      evt.status,
      evt.fail_reason || null,
      evt.device_id,
      evt.lamport_clock
    );
  }

  // Apply rewards only for success sessions, idempotently
  let shouldNotify = false;
  if (evt.status === 'success') {
    shouldNotify = applyFocusRewards(db, evt);
  }

  return { accepted: true, shouldNotify };
}

function applyFocusRewards(db: any, evt: FocusSessionEvent): boolean {
  // Check if rewards already applied for this session
  const session = db
    .prepare('SELECT notification_sent FROM focus_sessions WHERE session_id=?')
    .get(evt.session_id) as any;
  if (!session || session.notification_sent === 1) {
    return false; // Already rewarded
  }

  const student = db
    .prepare('SELECT * FROM students WHERE student_id=?')
    .get(evt.student_id) as any;
  if (!student) return false;

  const sessionDate = evt.completed_at
    ? evt.completed_at.substring(0, 10)
    : evt.started_at.substring(0, 10);
  const today = new Date().toISOString().substring(0, 10);
  const lastFocusDate = student.last_focus_date;

  // Streak logic: consecutive calendar days
  let newStreak = student.streak;
  let todayMinutes = student.today_focus_minutes;

  if (lastFocusDate === null) {
    newStreak = 1;
  } else if (lastFocusDate === sessionDate) {
    // Same day: no streak change, just accumulate minutes
  } else {
    // Check if sessionDate is the day after lastFocusDate
    const last = new Date(lastFocusDate);
    const sess = new Date(sessionDate);
    const diffDays = Math.round((sess.getTime() - last.getTime()) / 86400000);
    if (diffDays === 1) {
      newStreak = student.streak + 1;
    } else if (diffDays > 1) {
      newStreak = 1; // streak broken
    }
    // if diffDays <= 0 treat as same day scenario
  }

  // Only update today_focus_minutes if the session is "today" (server date)
  if (sessionDate === today) {
    todayMinutes = student.today_focus_minutes + evt.target_minutes;
  }

  db.prepare(`
    UPDATE students SET
      coins = coins + ?,
      streak = ?,
      last_focus_date = ?,
      today_focus_minutes = ?
    WHERE student_id = ?
  `).run(COINS_PER_SESSION, newStreak, sessionDate, todayMinutes, evt.student_id);

  // Mark notification as pending (will be sent)
  db.prepare('UPDATE focus_sessions SET notification_sent=1 WHERE session_id=?').run(
    evt.session_id
  );

  return true; // trigger notification
}

// ─────────────────────────────────────────────
// Task event processing
// Conflict resolution: Lamport clock Last-Write-Wins
// (Lamport clocks are monotonic per-device; ties broken by device_id lexicographically)
// Special cases:
//   - deleted vs edited: deleted wins if higher lamport (tombstone takes priority)
//   - same lamport from different devices: higher device_id wins (deterministic tiebreak)
// ─────────────────────────────────────────────
function processTaskEvent(
  db: any,
  evt: TaskUpdateEvent
): { accepted: boolean } {
  // Idempotency check
  const alreadyProcessed = db
    .prepare('SELECT 1 FROM processed_events WHERE event_id=?')
    .get(evt.event_id);
  if (alreadyProcessed) {
    return { accepted: false };
  }

  db.prepare("INSERT INTO processed_events VALUES (?, datetime('now'))").run(evt.event_id);

  const existing = db
    .prepare('SELECT * FROM tasks WHERE task_id=?')
    .get(evt.task_id) as any;

  if (!existing) {
    return { accepted: false }; // Task not found on server
  }

  // Conflict resolution: Lamport LWW with device_id tiebreak
  const incomingWins =
    evt.lamport_clock > existing.lamport_clock ||
    (evt.lamport_clock === existing.lamport_clock && evt.device_id > existing.device_id);

  if (!incomingWins) {
    return { accepted: false }; // Existing state wins
  }

  if (evt.status === 'deleted') {
    db.prepare('UPDATE tasks SET deleted=1, lamport_clock=?, updated_at=? WHERE task_id=?').run(
      evt.lamport_clock,
      evt.updated_at,
      evt.task_id
    );
  } else {
    db.prepare(
      'UPDATE tasks SET status=?, lamport_clock=?, updated_at=?, deleted=0 WHERE task_id=?'
    ).run(evt.status, evt.lamport_clock, evt.updated_at, evt.task_id);
  }

  return { accepted: true };
}

// ─────────────────────────────────────────────
// N8n notification trigger
// ─────────────────────────────────────────────
async function triggerN8nNotification(db: any, evt: FocusSessionEvent): Promise<void> {
  const student = db
    .prepare('SELECT * FROM students WHERE student_id=?')
    .get(evt.student_id) as any;
  if (!student) return;

  const payload = {
    session_id: evt.session_id,
    student_id: evt.student_id,
    streak: student.streak,
    coins_earned: COINS_PER_SESSION,
    total_coins: student.coins,
    target_minutes: evt.target_minutes,
    completed_at: evt.completed_at,
    event_id: evt.event_id, // stable id for n8n deduplication
  };

  // Try real n8n webhook first, fall back to mock
  const urls = [N8N_WEBHOOK_URL, MOCK_NOTIFICATION_URL];
  for (const url of urls) {
    try {
      await axios.post(url, payload, { timeout: 5000 });
      console.log(`[Notification] Sent for session ${evt.session_id} to ${url}`);
      return;
    } catch (e: any) {
      console.warn(`[Notification] Failed to reach ${url}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────
// Build full state from DB
// ─────────────────────────────────────────────
function buildFullState(
  db: any,
  studentId: string,
  serverLamport: number
): Omit<SyncResponse, 'server_lamport' | 'accepted_event_ids' | 'rejected_event_ids'> {
  const student = db
    .prepare('SELECT * FROM students WHERE student_id=?')
    .get(studentId) as StudentState;

  const subjects = db
    .prepare('SELECT * FROM subjects WHERE student_id=?')
    .all(studentId) as any[];

  const subjectStates: SubjectState[] = subjects.map((subj) => {
    const chapters = db
      .prepare('SELECT * FROM chapters WHERE subject_id=?')
      .all(subj.subject_id) as any[];

    const chapterStates = chapters.map((ch) => {
      const tasks = db
        .prepare('SELECT * FROM tasks WHERE chapter_id=? AND deleted=0')
        .all(ch.chapter_id) as any[];

      const done = tasks.filter((t) => t.status === 'done').length;
      const progress = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100);

      return {
        chapter_id: ch.chapter_id,
        subject_id: ch.subject_id,
        name: ch.name,
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          chapter_id: t.chapter_id,
          name: t.name,
          status: t.status,
          deleted: t.deleted === 1,
          lamport_clock: t.lamport_clock,
          updated_at: t.updated_at,
        })),
        progress,
      };
    });

    const totalTasks = chapterStates.reduce((sum, ch) => sum + ch.tasks.length, 0);
    const doneTasks = chapterStates.reduce(
      (sum, ch) => sum + ch.tasks.filter((t) => t.status === 'done').length,
      0
    );
    const subjProgress =
      totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100);

    return {
      subject_id: subj.subject_id,
      name: subj.name,
      chapters: chapterStates,
      progress: subjProgress,
    };
  });

  const sessions = db
    .prepare(
      "SELECT * FROM focus_sessions WHERE student_id=? ORDER BY started_at DESC LIMIT 20"
    )
    .all(studentId) as any[];

  return {
    student,
    subjects: subjectStates,
    sessions: sessions.map((s) => ({
      session_id: s.session_id,
      target_minutes: s.target_minutes,
      started_at: s.started_at,
      completed_at: s.completed_at,
      status: s.status,
      fail_reason: s.fail_reason,
      device_id: s.device_id,
    })),
  };
}

export default router;

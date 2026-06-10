import { v4 as uuidv4 } from 'uuid';
import { loadState, saveState, setStorageNamespace } from '../db/storage';
import {
  AppState,
  DEFAULT_STATE,
  LocalFocusSession,
  LocalSubject,
  LocalStudentState,
  PendingFocusEvent,
  PendingTaskEvent,
  TaskStatus,
  STUDENT_ID,
  COINS_PER_SESSION,
  BACKEND_URL,
} from './types';

type Listener = (state: AppState) => void;

class AppStore {
  private state: AppState = { ...DEFAULT_STATE };
  private listeners: Listener[] = [];
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  // ──────────────────────────────────────
  // Init
  // ──────────────────────────────────────
  async init(deviceNamespace: string): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    setStorageNamespace(deviceNamespace);

    const saved = await loadState();
    if (saved) {
      this.state = saved;
    } else {
      // Generate stable device ID for this namespace
      this.state = {
        ...DEFAULT_STATE,
        deviceId: `device-${deviceNamespace}-${uuidv4().substring(0, 8)}`,
      };
      await saveState(this.state);
    }

    // Start sync loop
    this.syncTimer = setInterval(() => {
      if (this.state.isOnline) this.sync();
    }, 5000);

    this.emit();
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit() {
    for (const l of this.listeners) l(this.state);
  }

  private async persist() {
    await saveState(this.state);
  }

  private mutate(updater: (s: AppState) => AppState) {
    this.state = updater(this.state);
    this.emit();
    this.persist();
  }

  private advanceClock(): number {
    const next = this.state.lamportClock + 1;
    this.state = { ...this.state, lamportClock: next };
    return next;
  }

  private addLog(msg: string) {
    const ts = new Date().toLocaleTimeString();
    this.mutate((s) => ({
      ...s,
      syncLog: [`[${ts}] ${msg}`, ...s.syncLog].slice(0, 50),
    }));
  }

  // ──────────────────────────────────────
  // Online / Offline toggle
  // ──────────────────────────────────────
  setOnline(online: boolean) {
    this.mutate((s) => ({ ...s, isOnline: online }));
    this.addLog(online ? '🟢 Back online' : '🔴 Gone offline');
    if (online) {
      this.sync();
    }
  }

  // ──────────────────────────────────────
  // Focus sessions
  // ──────────────────────────────────────
  startFocusSession(targetMinutes: number): string {
    const session: LocalFocusSession = {
      session_id: uuidv4(),
      target_minutes: targetMinutes,
      started_at: new Date().toISOString(),
      status: 'active',
      device_id: this.state.deviceId,
      synced: false,
    };

    this.mutate((s) => ({
      ...s,
      activeSession: session,
      sessions: [session, ...s.sessions],
    }));

    this.addLog(`▶️ Started ${targetMinutes}min focus session`);
    return session.session_id;
  }

  completeFocusSession(sessionId: string) {
    const completedAt = new Date().toISOString();
    const session = this.state.sessions.find((s) => s.session_id === sessionId);
    if (!session || session.status !== 'active') return;

    const clock = this.advanceClock();

    const event: PendingFocusEvent = {
      event_id: uuidv4(),
      session_id: sessionId,
      student_id: STUDENT_ID,
      device_id: this.state.deviceId,
      target_minutes: session.target_minutes,
      started_at: session.started_at,
      completed_at: completedAt,
      status: 'success',
      lamport_clock: clock,
    };

    // Apply rewards optimistically on device
    const newStudent = this.applyRewardsLocally(this.state.student, session.target_minutes);

    this.mutate((s) => ({
      ...s,
      lamportClock: clock,
      activeSession: null,
      sessions: s.sessions.map((sess) =>
        sess.session_id === sessionId
          ? { ...sess, status: 'success', completed_at: completedAt }
          : sess
      ),
      pendingFocusEvents: [...s.pendingFocusEvents, event],
      student: newStudent,
    }));

    this.addLog(`✅ Session complete! +${COINS_PER_SESSION} coins`);

    if (this.state.isOnline) this.sync();
  }

  failFocusSession(sessionId: string, reason: 'give_up' | 'app_switch') {
    const session = this.state.sessions.find((s) => s.session_id === sessionId);
    if (!session || session.status !== 'active') return;

    const clock = this.advanceClock();

    const event: PendingFocusEvent = {
      event_id: uuidv4(),
      session_id: sessionId,
      student_id: STUDENT_ID,
      device_id: this.state.deviceId,
      target_minutes: session.target_minutes,
      started_at: session.started_at,
      status: 'failed',
      fail_reason: reason,
      lamport_clock: clock,
    };

    this.mutate((s) => ({
      ...s,
      lamportClock: clock,
      activeSession: null,
      sessions: s.sessions.map((sess) =>
        sess.session_id === sessionId
          ? { ...sess, status: 'failed', fail_reason: reason }
          : sess
      ),
      pendingFocusEvents: [...s.pendingFocusEvents, event],
    }));

    this.addLog(`❌ Session ${reason === 'give_up' ? 'abandoned' : 'interrupted'}`);

    if (this.state.isOnline) this.sync();
  }

  private applyRewardsLocally(student: LocalStudentState, minutes: number): LocalStudentState {
    const today = new Date().toISOString().substring(0, 10);
    const lastDate = student.last_focus_date;
    let newStreak = student.streak;
    let todayMinutes = student.today_focus_minutes;

    if (lastDate === null) {
      newStreak = 1;
    } else if (lastDate === today) {
      // same day, streak unchanged
    } else {
      const last = new Date(lastDate);
      const now = new Date(today);
      const diffDays = Math.round((now.getTime() - last.getTime()) / 86400000);
      newStreak = diffDays === 1 ? student.streak + 1 : 1;
    }

    return {
      ...student,
      coins: student.coins + COINS_PER_SESSION,
      streak: newStreak,
      last_focus_date: today,
      today_focus_minutes: todayMinutes + minutes,
    };
  }

  // ──────────────────────────────────────
  // Task management
  // ──────────────────────────────────────
  updateTaskStatus(taskId: string, status: TaskStatus) {
    const clock = this.advanceClock();
    const updatedAt = new Date().toISOString();

    const event: PendingTaskEvent = {
      event_id: uuidv4(),
      task_id: taskId,
      student_id: STUDENT_ID,
      device_id: this.state.deviceId,
      status,
      updated_at: updatedAt,
      lamport_clock: clock,
    };

    this.mutate((s) => ({
      ...s,
      lamportClock: clock,
      subjects: s.subjects.map((subj) => ({
        ...subj,
        chapters: subj.chapters.map((ch) => ({
          ...ch,
          tasks: ch.tasks.map((t) =>
            t.task_id === taskId
              ? { ...t, status, lamport_clock: clock, updated_at: updatedAt }
              : t
          ),
        })),
      })),
      pendingTaskEvents: [...s.pendingTaskEvents, event],
    }));

    this.addLog(`📝 Task ${status}`);

    if (this.state.isOnline) this.sync();
  }

  deleteTask(taskId: string) {
    const clock = this.advanceClock();
    const updatedAt = new Date().toISOString();

    const event: PendingTaskEvent = {
      event_id: uuidv4(),
      task_id: taskId,
      student_id: STUDENT_ID,
      device_id: this.state.deviceId,
      status: 'deleted',
      updated_at: updatedAt,
      lamport_clock: clock,
    };

    this.mutate((s) => ({
      ...s,
      lamportClock: clock,
      subjects: s.subjects.map((subj) => ({
        ...subj,
        chapters: subj.chapters.map((ch) => ({
          ...ch,
          tasks: ch.tasks.filter((t) => t.task_id !== taskId),
        })),
      })),
      pendingTaskEvents: [...s.pendingTaskEvents, event],
    }));

    this.addLog(`🗑️ Task deleted`);

    if (this.state.isOnline) this.sync();
  }

  // ──────────────────────────────────────
  // Sync
  // ──────────────────────────────────────
  async sync(): Promise<void> {
    if (!this.state.isOnline) return;

    const { pendingFocusEvents, pendingTaskEvents, deviceId, lamportClock } = this.state;

    const payload = {
      device_id: deviceId,
      student_id: STUDENT_ID,
      device_lamport: lamportClock,
      focus_events: pendingFocusEvents,
      task_events: pendingTaskEvents,
    };

    try {
      const resp = await fetch(`${BACKEND_URL}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      this.applyServerState(data);
      this.addLog(`🔄 Synced ✓ (accepted: ${data.accepted_event_ids?.length || 0})`);
    } catch (e: any) {
      this.addLog(`⚠️ Sync failed: ${e.message}`);
    }
  }

  private applyServerState(data: any) {
    // After successful sync: replace local state with server truth,
    // but keep pending events that weren't accepted yet.
    const acceptedIds = new Set<string>(data.accepted_event_ids || []);

    this.mutate((s) => ({
      ...s,
      // Advance lamport clock to max of server and local
      lamportClock: Math.max(s.lamportClock, data.server_lamport || 0),
      // Replace student state with server's authoritative version
      student: data.student || s.student,
      // Replace subjects with server state
      subjects: mapServerSubjects(data.subjects || s.subjects),
      // Replace sessions with server state, keep active session
      sessions: mergeSessionsWithActive(data.sessions || [], s.activeSession),
      // Remove all events that the server accepted
      pendingFocusEvents: s.pendingFocusEvents.filter((e) => !acceptedIds.has(e.event_id)),
      pendingTaskEvents: s.pendingTaskEvents.filter((e) => !acceptedIds.has(e.event_id)),
      lastSyncAt: new Date().toISOString(),
    }));
  }

  destroy() {
    if (this.syncTimer) clearInterval(this.syncTimer);
  }
}

function mapServerSubjects(serverSubjects: any[]): LocalSubject[] {
  return (serverSubjects || []).map((subj: any) => ({
    subject_id: subj.subject_id,
    name: subj.name,
    chapters: (subj.chapters || []).map((ch: any) => ({
      chapter_id: ch.chapter_id,
      subject_id: ch.subject_id,
      name: ch.name,
      tasks: (ch.tasks || []).map((t: any) => ({
        task_id: t.task_id,
        chapter_id: t.chapter_id,
        name: t.name,
        status: t.status,
        deleted: t.deleted,
        lamport_clock: t.lamport_clock,
        updated_at: t.updated_at,
      })),
    })),
  }));
}

function mergeSessionsWithActive(
  serverSessions: any[],
  activeSession: LocalFocusSession | null
): LocalFocusSession[] {
  const mapped = serverSessions.map((s: any) => ({
    session_id: s.session_id,
    target_minutes: s.target_minutes,
    started_at: s.started_at,
    completed_at: s.completed_at,
    status: s.status as 'active' | 'success' | 'failed',
    fail_reason: s.fail_reason,
    device_id: s.device_id,
    synced: true,
  }));

  // If there's an active local session, keep it at the front
  if (activeSession) {
    const hasActive = mapped.find((s) => s.session_id === activeSession.session_id);
    if (!hasActive) {
      return [activeSession, ...mapped];
    }
  }

  return mapped;
}

// Singleton store per module import
// Two devices = two browser tabs with separate namespaces = two store instances
let _store: AppStore | null = null;

export function getStore(): AppStore {
  if (!_store) _store = new AppStore();
  return _store;
}

export function resetStore() {
  if (_store) _store.destroy();
  _store = new AppStore();
}

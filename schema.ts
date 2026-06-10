import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '../../alcovia.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    -- Student state (single student, hardcoded id)
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      coins INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      last_focus_date TEXT,  -- ISO date string YYYY-MM-DD
      today_focus_minutes INTEGER NOT NULL DEFAULT 0
    );

    -- Focus sessions
    CREATE TABLE IF NOT EXISTS focus_sessions (
      session_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      target_minutes INTEGER NOT NULL,
      started_at TEXT NOT NULL,         -- ISO timestamp (logical clock basis)
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | success | failed
      fail_reason TEXT,                 -- give_up | app_switch | null
      device_id TEXT NOT NULL,
      lamport_clock INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT,
      notification_sent INTEGER NOT NULL DEFAULT 0,  -- 0 | 1 idempotency flag
      FOREIGN KEY(student_id) REFERENCES students(student_id)
    );

    -- Subjects
    CREATE TABLE IF NOT EXISTS subjects (
      subject_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY(student_id) REFERENCES students(student_id)
    );

    -- Chapters
    CREATE TABLE IF NOT EXISTS chapters (
      chapter_id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY(subject_id) REFERENCES subjects(subject_id)
    );

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_started',  -- not_started | in_progress | done
      updated_at TEXT NOT NULL,       -- ISO timestamp
      lamport_clock INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,  -- soft delete flag
      FOREIGN KEY(chapter_id) REFERENCES chapters(chapter_id)
    );

    -- Sync log for idempotency (track processed event ids)
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );

    -- Server lamport clock
    CREATE TABLE IF NOT EXISTS server_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO server_state VALUES ('lamport_clock', '0');

    -- Seed default student
    INSERT OR IGNORE INTO students VALUES ('student-001', 0, 0, NULL, 0);
  `);

  // Seed syllabus if empty
  const subjectCount = (db.prepare('SELECT COUNT(*) as c FROM subjects').get() as any).c;
  if (subjectCount === 0) {
    seedSyllabus(db);
  }
}

function seedSyllabus(db: Database.Database) {
  const subjects = [
    { id: 'subj-math', name: 'Mathematics' },
    { id: 'subj-sci', name: 'Science' },
    { id: 'subj-eng', name: 'English' },
  ];

  const chapters: Record<string, { id: string; name: string }[]> = {
    'subj-math': [
      { id: 'ch-math-1', name: 'Algebra Basics' },
      { id: 'ch-math-2', name: 'Geometry' },
    ],
    'subj-sci': [
      { id: 'ch-sci-1', name: 'Cell Biology' },
      { id: 'ch-sci-2', name: 'Periodic Table' },
    ],
    'subj-eng': [
      { id: 'ch-eng-1', name: 'Grammar' },
    ],
  };

  const tasks: Record<string, { id: string; name: string }[]> = {
    'ch-math-1': [
      { id: 'task-m1-1', name: 'Variables & Expressions' },
      { id: 'task-m1-2', name: 'Linear Equations' },
      { id: 'task-m1-3', name: 'Inequalities' },
    ],
    'ch-math-2': [
      { id: 'task-m2-1', name: 'Triangles' },
      { id: 'task-m2-2', name: 'Circles' },
    ],
    'ch-sci-1': [
      { id: 'task-s1-1', name: 'Cell Structure' },
      { id: 'task-s1-2', name: 'Mitosis' },
      { id: 'task-s1-3', name: 'Cell Membrane' },
    ],
    'ch-sci-2': [
      { id: 'task-s2-1', name: 'Elements & Symbols' },
      { id: 'task-s2-2', name: 'Periods & Groups' },
    ],
    'ch-eng-1': [
      { id: 'task-e1-1', name: 'Parts of Speech' },
      { id: 'task-e1-2', name: 'Sentence Structure' },
      { id: 'task-e1-3', name: 'Punctuation' },
    ],
  };

  const insertSubject = db.prepare('INSERT INTO subjects VALUES (?, ?)');
  const insertChapter = db.prepare('INSERT INTO chapters VALUES (?, ?, ?)');
  const insertTask = db.prepare(
    "INSERT INTO tasks VALUES (?, ?, ?, ?, 'not_started', datetime('now'), 0, 0)"
  );

  for (const subj of subjects) {
    insertSubject.run(subj.id, 'student-001', subj.name);
    for (const ch of chapters[subj.id] || []) {
      insertChapter.run(ch.id, subj.id, ch.name);
      for (const task of tasks[ch.id] || []) {
        insertTask.run(task.id, ch.id, 'student-001', task.name);
      }
    }
  }
}

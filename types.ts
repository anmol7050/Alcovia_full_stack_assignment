export const STUDENT_ID = 'student-001';
export const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://localhost:3001';
export const GRACE_PERIOD_MS = 5000; // 5s grace before app-switch fail
export const COINS_PER_SESSION = 50;

export type TaskStatus = 'not_started' | 'in_progress' | 'done';

export interface LocalTask {
  task_id: string;
  chapter_id: string;
  name: string;
  status: TaskStatus;
  deleted: boolean;
  lamport_clock: number;
  updated_at: string;
}

export interface LocalChapter {
  chapter_id: string;
  subject_id: string;
  name: string;
  tasks: LocalTask[];
}

export interface LocalSubject {
  subject_id: string;
  name: string;
  chapters: LocalChapter[];
}

export interface LocalStudentState {
  student_id: string;
  coins: number;
  streak: number;
  last_focus_date: string | null;
  today_focus_minutes: number;
}

export interface LocalFocusSession {
  session_id: string;
  target_minutes: number;
  started_at: string;
  completed_at?: string;
  status: 'active' | 'success' | 'failed';
  fail_reason?: 'give_up' | 'app_switch';
  device_id: string;
  synced: boolean; // has this been successfully sent to server?
}

export interface PendingFocusEvent {
  event_id: string;
  session_id: string;
  student_id: string;
  device_id: string;
  target_minutes: number;
  started_at: string;
  completed_at?: string;
  status: 'success' | 'failed';
  fail_reason?: 'give_up' | 'app_switch';
  lamport_clock: number;
}

export interface PendingTaskEvent {
  event_id: string;
  task_id: string;
  student_id: string;
  device_id: string;
  status: TaskStatus | 'deleted';
  updated_at: string;
  lamport_clock: number;
}

export interface AppState {
  deviceId: string;
  lamportClock: number;
  student: LocalStudentState;
  subjects: LocalSubject[];
  sessions: LocalFocusSession[];
  pendingFocusEvents: PendingFocusEvent[];
  pendingTaskEvents: PendingTaskEvent[];
  activeSession: LocalFocusSession | null;
  isOnline: boolean;
  lastSyncAt: string | null;
  syncLog: string[];
}

export const DEFAULT_STATE: AppState = {
  deviceId: '',
  lamportClock: 0,
  student: {
    student_id: STUDENT_ID,
    coins: 0,
    streak: 0,
    last_focus_date: null,
    today_focus_minutes: 0,
  },
  subjects: [],
  sessions: [],
  pendingFocusEvents: [],
  pendingTaskEvents: [],
  activeSession: null,
  isOnline: true,
  lastSyncAt: null,
  syncLog: [],
};

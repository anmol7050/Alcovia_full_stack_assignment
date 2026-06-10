import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  AppState as RNAppState,
  Platform,
} from 'react-native';
import { useAppStore } from '../src/store/useAppStore';
import { GRACE_PERIOD_MS } from '../src/store/types';

// ─────────────────────────────────────────────
// Colours
// ─────────────────────────────────────────────
const C = {
  bg: '#0f0f1a',
  card: '#1a1a2e',
  border: '#2a2a45',
  accent: '#7c6af0',
  green: '#22c55e',
  red: '#ef4444',
  yellow: '#f59e0b',
  text: '#e2e8f0',
  muted: '#64748b',
  white: '#fff',
};

// ─────────────────────────────────────────────
// Tab bar
// ─────────────────────────────────────────────
type Tab = 'focus' | 'syllabus' | 'dev';

export default function HomeScreen() {
  const [tab, setTab] = useState<Tab>('focus');
  const { state, store } = useAppStore();

  // App state listener for background detection
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef(RNAppState.currentState);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = RNAppState.addEventListener('change', (nextState) => {
      if (
        appStateRef.current === 'active' &&
        nextState.match(/inactive|background/) &&
        state.activeSession
      ) {
        // Start grace timer
        backgroundTimerRef.current = setTimeout(() => {
          if (state.activeSession) {
            store.failFocusSession(state.activeSession.session_id, 'app_switch');
          }
        }, GRACE_PERIOD_MS);
      } else if (nextState === 'active') {
        if (backgroundTimerRef.current) clearTimeout(backgroundTimerRef.current);
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [state.activeSession]);

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.logo}>📚 Alcovia</Text>
          <Text style={styles.deviceLabel}>{state.deviceId.substring(0, 20)}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.onlineDot, { backgroundColor: state.isOnline ? C.green : C.red }]} />
          <Text style={styles.onlineLabel}>{state.isOnline ? 'Online' : 'Offline'}</Text>
        </View>
      </View>

      {/* Stats bar */}
      <View style={styles.statsBar}>
        <Stat icon="🪙" label="Coins" value={state.student.coins} />
        <Stat icon="🔥" label="Streak" value={`${state.student.streak}d`} />
        <Stat icon="⏱" label="Today" value={`${state.student.today_focus_minutes}m`} />
        {state.pendingFocusEvents.length + state.pendingTaskEvents.length > 0 && (
          <Stat
            icon="⏳"
            label="Pending"
            value={state.pendingFocusEvents.length + state.pendingTaskEvents.length}
            accent={C.yellow}
          />
        )}
      </View>

      {/* Tab content */}
      <View style={styles.tabBar}>
        {(['focus', 'syllabus', 'dev'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} style={[styles.tabBtn, tab === t && styles.tabBtnActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>
              {t === 'focus' ? '⏱ Focus' : t === 'syllabus' ? '📖 Study' : '🛠 Dev'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 40 }}>
        {tab === 'focus' && <FocusTab />}
        {tab === 'syllabus' && <SyllabusTab />}
        {tab === 'dev' && <DevPanel />}
      </ScrollView>
    </View>
  );
}

function Stat({ icon, label, value, accent }: { icon: string; label: string; value: any; accent?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={[styles.statValue, accent ? { color: accent } : {}]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────
// Focus Tab
// ─────────────────────────────────────────────
function FocusTab() {
  const { state, store } = useAppStore();
  const [selectedMins, setSelectedMins] = useState(25);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const session = state.activeSession;

  useEffect(() => {
    if (session) {
      timerRef.current = setInterval(() => {
        const started = new Date(session.started_at).getTime();
        setElapsed(Math.floor((Date.now() - started) / 1000));
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    } else {
      setElapsed(0);
    }
  }, [session?.session_id]);

  // Auto-complete when timer reaches target
  useEffect(() => {
    if (session && elapsed >= session.target_minutes * 60) {
      store.completeFocusSession(session.session_id);
    }
  }, [elapsed, session?.session_id]);

  const targetSecs = session ? session.target_minutes * 60 : selectedMins * 60;
  const progress = session ? Math.min(elapsed / targetSecs, 1) : 0;
  const remaining = Math.max(targetSecs - elapsed, 0);
  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');

  return (
    <View style={styles.focusContainer}>
      {/* Timer circle */}
      <View style={styles.timerCircle}>
        <Text style={styles.timerText}>{session ? `${mm}:${ss}` : `${selectedMins}:00`}</Text>
        <Text style={styles.timerSub}>
          {session ? `${Math.round(progress * 100)}% complete` : 'ready'}
        </Text>
      </View>

      {/* Progress bar */}
      {session && (
        <View style={styles.progressBg}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` as any }]} />
        </View>
      )}

      {/* Duration selector */}
      {!session && (
        <View style={styles.durationRow}>
          {[15, 25, 45, 60, 90].map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.durationBtn, selectedMins === m && styles.durationBtnActive]}
              onPress={() => setSelectedMins(m)}
            >
              <Text style={[styles.durationLabel, selectedMins === m && { color: C.white }]}>
                {m}m
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Action buttons */}
      {!session ? (
        <TouchableOpacity style={styles.startBtn} onPress={() => store.startFocusSession(selectedMins)}>
          <Text style={styles.startBtnText}>▶ Start Session</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.sessionBtns}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: C.green }]}
            onPress={() => store.completeFocusSession(session.session_id)}
          >
            <Text style={styles.actionBtnText}>✓ Complete Early</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: C.red }]}
            onPress={() => store.failFocusSession(session.session_id, 'give_up')}
          >
            <Text style={styles.actionBtnText}>✗ Give Up</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Session history */}
      <Text style={styles.sectionTitle}>Recent Sessions</Text>
      {state.sessions.slice(0, 8).map((s) => (
        <View key={s.session_id} style={styles.sessionRow}>
          <Text style={styles.sessionIcon}>
            {s.status === 'success' ? '✅' : s.status === 'failed' ? '❌' : '▶️'}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.sessionText}>
              {s.target_minutes}min · {s.status}
              {s.fail_reason ? ` (${s.fail_reason})` : ''}
            </Text>
            <Text style={styles.sessionMeta}>
              {new Date(s.started_at).toLocaleString()} · {s.device_id.substring(0, 14)}
            </Text>
          </View>
          {!s.synced && <Text style={styles.pendingBadge}>⏳</Text>}
        </View>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────
// Syllabus Tab
// ─────────────────────────────────────────────
function SyllabusTab() {
  const { state, store } = useAppStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function toggle(id: string) {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  }

  const STATUS_CYCLE: Record<string, 'not_started' | 'in_progress' | 'done'> = {
    not_started: 'in_progress',
    in_progress: 'done',
    done: 'not_started',
  };

  function chapterProgress(ch: any): number {
    const tasks = ch.tasks || [];
    if (tasks.length === 0) return 0;
    const done = tasks.filter((t: any) => t.status === 'done').length;
    return Math.round((done / tasks.length) * 100);
  }

  function subjectProgress(subj: any): number {
    const chapters = subj.chapters || [];
    const allTasks = chapters.flatMap((ch: any) => ch.tasks || []);
    if (allTasks.length === 0) return 0;
    const done = allTasks.filter((t: any) => t.status === 'done').length;
    return Math.round((done / allTasks.length) * 100);
  }

  return (
    <View>
      {state.subjects.map((subj) => {
        const sp = subjectProgress(subj);
        return (
          <View key={subj.subject_id} style={styles.card}>
            <TouchableOpacity onPress={() => toggle(subj.subject_id)} style={styles.subjectHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.subjectName}>{subj.name}</Text>
                <ProgressBar value={sp} color={C.accent} />
                <Text style={styles.progressLabel}>{sp}% complete</Text>
              </View>
              <Text style={styles.chevron}>{expanded[subj.subject_id] ? '▲' : '▼'}</Text>
            </TouchableOpacity>

            {expanded[subj.subject_id] &&
              subj.chapters.map((ch) => {
                const cp = chapterProgress(ch);
                return (
                  <View key={ch.chapter_id} style={styles.chapterBlock}>
                    <TouchableOpacity onPress={() => toggle(ch.chapter_id)}>
                      <Text style={styles.chapterName}>
                        {expanded[ch.chapter_id] ? '▼' : '▶'} {ch.name}
                        <Text style={styles.chapterPct}>  {cp}%</Text>
                      </Text>
                    </TouchableOpacity>

                    {expanded[ch.chapter_id] &&
                      ch.tasks.map((task) => (
                        <View key={task.task_id} style={styles.taskRow}>
                          <TouchableOpacity
                            style={[styles.statusDot, { backgroundColor: statusColor(task.status) }]}
                            onPress={() => store.updateTaskStatus(task.task_id, STATUS_CYCLE[task.status])}
                          />
                          <Text style={styles.taskName}>{task.name}</Text>
                          <Text style={styles.statusLabel}>{task.status.replace('_', ' ')}</Text>
                          <TouchableOpacity onPress={() => store.deleteTask(task.task_id)}>
                            <Text style={styles.deleteBtn}>🗑</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                  </View>
                );
              })}
          </View>
        );
      })}

      {state.subjects.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No syllabus yet. Sync to load data.</Text>
          <TouchableOpacity style={styles.syncBtn} onPress={() => getStore().sync()}>
            <Text style={styles.syncBtnText}>Sync Now</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function statusColor(status: string): string {
  if (status === 'done') return C.green;
  if (status === 'in_progress') return C.yellow;
  return C.border;
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <View style={styles.progressBg}>
      <View style={[styles.progressFill, { width: `${value}%` as any, backgroundColor: color }]} />
    </View>
  );
}

// ─────────────────────────────────────────────
// Dev Panel
// ─────────────────────────────────────────────
function DevPanel() {
  const { state, store } = useAppStore();
  const [notifications, setNotifications] = useState<any[]>([]);

  const BACKEND = require('../src/store/types').BACKEND_URL;

  useEffect(() => {
    fetchNotifications();
  }, []);

  async function fetchNotifications() {
    try {
      const r = await fetch(`${BACKEND}/mock-notify/log`);
      const data = await r.json();
      setNotifications(data);
    } catch {}
  }

  async function clearNotifications() {
    try {
      await fetch(`${BACKEND}/mock-notify/log`, { method: 'DELETE' });
      setNotifications([]);
    } catch {}
  }

  return (
    <View>
      <Text style={styles.devTitle}>🛠 Developer Panel</Text>
      <Text style={styles.devSubtitle}>Device: {state.deviceId}</Text>

      {/* Online/Offline toggle */}
      <View style={styles.devCard}>
        <Text style={styles.devCardTitle}>Network</Text>
        <View style={styles.devRow}>
          <TouchableOpacity
            style={[styles.devBtn, state.isOnline && styles.devBtnActive]}
            onPress={() => store.setOnline(true)}
          >
            <Text style={styles.devBtnText}>🟢 Online</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.devBtn, !state.isOnline && { ...styles.devBtnActive, backgroundColor: C.red }]}
            onPress={() => store.setOnline(false)}
          >
            <Text style={styles.devBtnText}>🔴 Offline</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Manual triggers */}
      <View style={styles.devCard}>
        <Text style={styles.devCardTitle}>Quick Actions</Text>
        <TouchableOpacity style={styles.devActionBtn} onPress={() => store.sync()}>
          <Text style={styles.devActionText}>🔄 Force Sync Now</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.devActionBtn}
          onPress={() => {
            // Simulate a quick offline success scenario: 1-min session
            const id = store.startFocusSession(1);
            setTimeout(() => store.completeFocusSession(id), 500);
          }}
        >
          <Text style={styles.devActionText}>⚡ Instant Session (1min)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.devActionBtn}
          onPress={() => {
            const id = store.startFocusSession(25);
            setTimeout(() => store.failFocusSession(id, 'give_up'), 200);
          }}
        >
          <Text style={styles.devActionText}>❌ Instant Fail Session</Text>
        </TouchableOpacity>
      </View>

      {/* State snapshot */}
      <View style={styles.devCard}>
        <Text style={styles.devCardTitle}>Current State</Text>
        <DevRow label="Coins" value={state.student.coins} />
        <DevRow label="Streak" value={`${state.student.streak} days`} />
        <DevRow label="Today focus" value={`${state.student.today_focus_minutes} min`} />
        <DevRow label="Lamport clock" value={state.lamportClock} />
        <DevRow label="Pending focus events" value={state.pendingFocusEvents.length} />
        <DevRow label="Pending task events" value={state.pendingTaskEvents.length} />
        <DevRow label="Last sync" value={state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleTimeString() : 'never'} />
        <DevRow label="Total sessions" value={state.sessions.length} />
      </View>

      {/* Notifications */}
      <View style={styles.devCard}>
        <View style={styles.devRow}>
          <Text style={styles.devCardTitle}>Notifications (n8n/mock)</Text>
          <TouchableOpacity onPress={fetchNotifications}>
            <Text style={{ color: C.accent, fontSize: 12 }}>Refresh</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={clearNotifications} style={{ marginLeft: 8 }}>
            <Text style={{ color: C.red, fontSize: 12 }}>Clear</Text>
          </TouchableOpacity>
        </View>
        {notifications.length === 0 ? (
          <Text style={styles.devMuted}>No notifications yet</Text>
        ) : (
          notifications.slice().reverse().map((n, i) => (
            <View key={i} style={styles.notifRow}>
              <Text style={styles.notifTime}>{new Date(n.received_at).toLocaleTimeString()}</Text>
              <Text style={styles.notifText}>
                Session {n.payload.session_id?.substring(0, 8)} · Streak {n.payload.streak} · +{n.payload.coins_earned} coins
              </Text>
            </View>
          ))
        )}
      </View>

      {/* Sync log */}
      <View style={styles.devCard}>
        <Text style={styles.devCardTitle}>Sync Log</Text>
        {state.syncLog.length === 0 && <Text style={styles.devMuted}>Empty</Text>}
        {state.syncLog.map((entry, i) => (
          <Text key={i} style={styles.logEntry}>{entry}</Text>
        ))}
      </View>
    </View>
  );
}

function DevRow({ label, value }: { label: string; value: any }) {
  return (
    <View style={styles.devDataRow}>
      <Text style={styles.devDataLabel}>{label}</Text>
      <Text style={styles.devDataValue}>{String(value)}</Text>
    </View>
  );
}

function getStore() {
  const { getStore: gs } = require('../src/store/store');
  return gs();
}

// ─────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12,
    borderBottomWidth: 1, borderColor: C.border,
  },
  logo: { fontSize: 20, fontWeight: '800', color: C.white },
  deviceLabel: { fontSize: 10, color: C.muted, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  onlineDot: { width: 10, height: 10, borderRadius: 5 },
  onlineLabel: { color: C.text, fontSize: 13 },
  statsBar: {
    flexDirection: 'row', backgroundColor: C.card, paddingVertical: 10,
    borderBottomWidth: 1, borderColor: C.border,
  },
  stat: { flex: 1, alignItems: 'center' },
  statIcon: { fontSize: 16 },
  statValue: { fontSize: 18, fontWeight: '700', color: C.white },
  statLabel: { fontSize: 10, color: C.muted },
  tabBar: {
    flexDirection: 'row', backgroundColor: C.card,
    borderBottomWidth: 1, borderColor: C.border,
  },
  tabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabBtnActive: { borderBottomWidth: 2, borderColor: C.accent },
  tabLabel: { color: C.muted, fontWeight: '600', fontSize: 13 },
  tabLabelActive: { color: C.accent },
  content: { flex: 1 },

  // Focus
  focusContainer: { padding: 16 },
  timerCircle: {
    width: 200, height: 200, borderRadius: 100,
    borderWidth: 4, borderColor: C.accent,
    justifyContent: 'center', alignItems: 'center',
    alignSelf: 'center', marginVertical: 24,
    backgroundColor: C.card,
  },
  timerText: { fontSize: 42, fontWeight: '800', color: C.white },
  timerSub: { fontSize: 13, color: C.muted, marginTop: 4 },
  progressBg: { height: 6, backgroundColor: C.border, borderRadius: 3, marginVertical: 8 },
  progressFill: { height: 6, backgroundColor: C.accent, borderRadius: 3 },
  durationRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginVertical: 16 },
  durationBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1, borderColor: C.border,
  },
  durationBtnActive: { backgroundColor: C.accent, borderColor: C.accent },
  durationLabel: { color: C.muted, fontWeight: '600' },
  startBtn: {
    backgroundColor: C.accent, padding: 16, borderRadius: 12,
    alignItems: 'center', marginVertical: 8,
  },
  startBtnText: { color: C.white, fontSize: 18, fontWeight: '700' },
  sessionBtns: { flexDirection: 'row', gap: 12, marginVertical: 8 },
  actionBtn: { flex: 1, padding: 14, borderRadius: 10, alignItems: 'center' },
  actionBtnText: { color: C.white, fontWeight: '700', fontSize: 15 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: C.text, marginTop: 20, marginBottom: 8 },
  sessionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.card, padding: 12, borderRadius: 8,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  sessionIcon: { fontSize: 20 },
  sessionText: { color: C.text, fontSize: 13, fontWeight: '600' },
  sessionMeta: { color: C.muted, fontSize: 11 },
  pendingBadge: { fontSize: 14 },

  // Syllabus
  card: {
    margin: 8, backgroundColor: C.card, borderRadius: 12,
    borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  subjectHeader: {
    flexDirection: 'row', alignItems: 'center',
    padding: 16, gap: 12,
  },
  subjectName: { fontSize: 17, fontWeight: '700', color: C.white, marginBottom: 6 },
  progressLabel: { fontSize: 11, color: C.muted, marginTop: 2 },
  chevron: { color: C.muted, fontSize: 16 },
  chapterBlock: {
    backgroundColor: '#161625', paddingHorizontal: 16, paddingBottom: 8,
    borderTopWidth: 1, borderColor: C.border,
  },
  chapterName: { fontSize: 14, fontWeight: '600', color: C.text, paddingVertical: 8 },
  chapterPct: { color: C.muted, fontWeight: '400' },
  taskRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 7, paddingLeft: 8,
  },
  statusDot: { width: 14, height: 14, borderRadius: 7 },
  taskName: { flex: 1, color: C.text, fontSize: 13 },
  statusLabel: { color: C.muted, fontSize: 11 },
  deleteBtn: { fontSize: 16, paddingLeft: 4 },
  empty: { padding: 32, alignItems: 'center' },
  emptyText: { color: C.muted, marginBottom: 16 },
  syncBtn: { backgroundColor: C.accent, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  syncBtnText: { color: C.white, fontWeight: '700' },

  // Dev panel
  devTitle: { fontSize: 20, fontWeight: '800', color: C.white, padding: 16, paddingBottom: 4 },
  devSubtitle: { fontSize: 11, color: C.muted, paddingHorizontal: 16, marginBottom: 8 },
  devCard: {
    margin: 8, backgroundColor: C.card, borderRadius: 10,
    padding: 14, borderWidth: 1, borderColor: C.border,
  },
  devCardTitle: { fontSize: 13, fontWeight: '700', color: C.text, marginBottom: 10 },
  devRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  devBtn: {
    flex: 1, padding: 10, borderRadius: 8, borderWidth: 1,
    borderColor: C.border, alignItems: 'center',
  },
  devBtnActive: { backgroundColor: C.green, borderColor: C.green },
  devBtnText: { color: C.white, fontWeight: '600', fontSize: 13 },
  devActionBtn: {
    backgroundColor: '#252540', padding: 12, borderRadius: 8,
    marginBottom: 6, borderWidth: 1, borderColor: C.border,
  },
  devActionText: { color: C.text, fontWeight: '600', fontSize: 13 },
  devDataRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  devDataLabel: { color: C.muted, fontSize: 12 },
  devDataValue: { color: C.text, fontSize: 12, fontWeight: '600' },
  notifRow: { backgroundColor: '#1e2a1e', padding: 8, borderRadius: 6, marginBottom: 4 },
  notifTime: { color: C.green, fontSize: 10, marginBottom: 2 },
  notifText: { color: C.text, fontSize: 12 },
  logEntry: { color: C.text, fontSize: 11, fontFamily: 'monospace', paddingVertical: 1 },
  devMuted: { color: C.muted, fontSize: 12, fontStyle: 'italic' },
});

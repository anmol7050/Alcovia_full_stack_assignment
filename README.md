# Alcovia — Offline-First Study App

A full-stack offline-first study app with two-device sync, built for the Alcovia engineering internship take-home assignment.

**Stack**: TypeScript · React Native (Expo) · Express · SQLite · n8n

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo>
cd alcovia

# Backend
cd backend && npm install

# Frontend
cd ../frontend && npm install
```

### 2. Run the backend

```bash
cd backend
npm run dev
# Server starts on http://localhost:3001
# SQLite database created at alcovia.db
# Logs: "[Server] Alcovia backend running on http://localhost:3001"
```

### 3. Run the frontend (two devices = two browser tabs)

```bash
cd frontend
npm run web
# Opens http://localhost:8081
```

**To simulate two devices:**

Open two browser tabs (or one normal + one incognito):
- Tab 1: `http://localhost:8081?device=deviceA`
- Tab 2: `http://localhost:8081?device=deviceB`

Each tab gets its own `AsyncStorage` namespace (`alcovia:deviceA:appstate` vs `alcovia:deviceB:appstate`), so they behave like independent devices sharing the same server account.

If you don't pass `?device=`, a random namespace is assigned and the URL is updated automatically.

### 4. Set up n8n (optional, mock fallback works without it)

**Option A: n8n Cloud (free tier)**
1. Sign up at https://app.n8n.cloud
2. Create a new workflow → Import from file → upload `n8n/n8n-workflow.json`
3. Activate the workflow
4. Copy the webhook URL (it will look like `https://yourname.app.n8n.cloud/webhook/focus-success`)
5. Set environment variable: `N8N_WEBHOOK_URL=https://...` before running the backend

**Option B: Self-hosted**
```bash
npx n8n
# Opens at http://localhost:5678
# Import n8n/n8n-workflow.json, activate workflow
# Webhook URL: http://localhost:5678/webhook/focus-success
```

**Option C: Mock only (default)**
If no n8n is configured, the backend falls back to the built-in mock notification endpoint at `http://localhost:3001/mock-notify`. The Dev Panel in the app shows all notifications received there.

---

## Demo: Two-Device Scenario

### Basic offline focus session
1. Open `?device=deviceA` — take it offline (Dev Panel → 🔴 Offline)
2. Start a 1-min focus session (or use "⚡ Instant Session" in Dev Panel)
3. Complete it — coins and streak update immediately on Device A
4. Open `?device=deviceB` — also offline — start another 1-min session and complete it
5. Bring both online (🟢 Online) — both sync within 5 seconds
6. Both devices now show the same coins, streak, and sessions
7. Dev Panel → Notifications shows **exactly one** notification per session (not two)

### Conflicting task edit
1. Both devices offline
2. Device A: tap a task to change it to "In Progress"
3. Device B: tap the same task to change it to "Done" (Device B will have a higher Lamport clock if it made the edit after Device A started)
4. Bring both online
5. Both devices converge to "Done" (higher Lamport wins)

### Task edit vs delete conflict
1. Device A offline: mark a task "Done"
2. Device B offline (different Lamport): delete the same task
3. Bring online — whichever had the higher Lamport clock wins:
   - If delete was later → task disappears on both devices
   - If edit was later → task is restored as Done on both devices

### Notification idempotency
1. Run an offline session on Device A
2. Run the same instant session scenario on Device B (creates a different session — they can't share session IDs since UUIDs are generated on device)
3. Both sync → two sessions → two notifications, one per session
4. Re-sync (force sync again) → notification count doesn't increase (events already in `processed_events`)

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  Device A        │     │  Device B        │
│  (browser tab 1) │     │  (browser tab 2) │
│                 │     │                 │
│  AsyncStorage   │     │  AsyncStorage   │
│  Pending queue  │     │  Pending queue  │
└────────┬────────┘     └────────┬────────┘
         │  POST /api/sync       │
         └──────────┬────────────┘
                    ▼
         ┌──────────────────────┐
         │  Express Backend     │
         │  SQLite (WAL)        │
         │                     │
         │  processed_events   │ ← idempotency
         │  focus_sessions     │
         │  tasks              │
         │  students           │
         └──────────┬──────────┘
                    │ webhook (on success, once)
                    ▼
         ┌──────────────────────┐
         │  n8n Workflow        │
         │  Static data dedup  │ ← idempotency
         │  → Notification     │
         └──────────────────────┘
```

---

## Conflict Resolution Strategy

See `DECISIONS.md` for full detail. Summary:

| Scenario | Resolution |
|---|---|
| Same task edited on two devices | Lamport LWW: higher clock wins; ties broken by `device_id` lexicographic order |
| Task edited on one device, deleted on other | Higher Lamport wins (delete or edit, whichever is causally later) |
| Same sync payload arrives twice | `processed_events` table deduplicates by `event_id` |
| Same session synced from two devices | `notification_sent` flag on session row prevents double rewards; `processed_events` prevents double event processing |
| Two sessions at same Lamport from different devices | Deterministic tiebreak by `device_id` string |

---

## What I Left Out / Would Do Next

- **User-visible conflict surfacing**: when an automatic resolution overrides a user's edit, the app silently corrects. A production app would show a toast: "Your edit was overridden by another device."
- **Incremental sync**: currently devices send all pending events; a large backlog would be fine, but a production version would send only events since the last acknowledged server clock.
- **Three-way merge for task status**: currently uses LWW. A richer merge (e.g. "Done always beats In Progress") could be implemented without LWW's limitations.
- **Real WhatsApp delivery**: swapping the mock URL for AiSensy / Twilio is a one-line config change.
- **JWT auth**: currently hardcoded `student-001`; a real app would use device-bound tokens.
- **Crash recovery mid-session**: the active session is stored in AsyncStorage, so an app restart during a session would lose the active timer (it would show as orphaned). Fixing: persist the session start time and restore it on mount.
- **Fuzz/property testing**: a property test that generates random offline edit sequences across two devices and asserts they always converge would be the right CI guard.
- **Real device (Expo Go)**: the code is Expo-compatible and would run on a physical device with `npx expo start --tunnel`.

## Extensions Implemented

- **Survives app restart**: all state is persisted to `AsyncStorage` and reloaded on init.
- **Mock notification sink**: fully functional, visible in Dev Panel.
- **Dev panel**: toggle online/offline per device, instant session triggers, full state snapshot, notification log, sync log.

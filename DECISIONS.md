# DECISIONS.md — Alcovia Sync Design

## Data & Sync Model

### Approach: Event-Sourced Sync with Lamport Clocks

Rather than syncing full snapshots or using CRDTs from a library, I chose a **lightweight event-sourced approach**:

1. Every mutation on a device generates an **event** with a stable UUID (`event_id`) and a **Lamport clock** timestamp.
2. Events accumulate in a local **pending queue** while offline.
3. On reconnect, the device POSTs its full pending queue to the server (`POST /api/sync`).
4. The server processes events, applies conflict resolution, and returns the **full authoritative state**.
5. The device replaces its local state with the server's response, then removes the accepted events from its queue.

This is a **pull-to-truth** model: the server is the single source of truth, and devices reconcile by fetching its state after pushing their events.

### Why Lamport Clocks, Not Wall-Clock Time

Device clocks disagree (especially on budget phones and hostel Wi-Fi). Lamport clocks are:
- **Monotonically increasing** per device.
- **Advanced on receive**: when the server receives a sync, it sets its clock to `max(server, incoming) + 1`.
- **Deterministic**: a tie between two events from different devices is broken by `device_id` lexicographic order — arbitrary but stable.

### Storage

**On-device**: `AsyncStorage` (React Native / Expo web). Each browser tab gets a URL query param `?device=<namespace>` so that two tabs don't share the same key space — simulating two devices.

**Server**: SQLite via `better-sqlite3`. Simple, zero-config, file-based. Fine for the demo; would be Postgres in production.

---

## Conflict Resolution

### Task Status Conflicts

**Strategy: Lamport-clock Last-Write-Wins with deterministic tiebreak.**

| Scenario | Resolution |
|---|---|
| Phone sets task → Done; Laptop sets same task → In Progress (higher lamport) | In Progress wins — the higher Lamport clock reflects the causally later edit |
| Both devices edit same task at same Lamport value (parallel) | Higher `device_id` string wins — deterministic, avoids split-brain |
| Task edited on device A, deleted on device B (B has higher clock) | Deleted wins — tombstone takes priority when causally later |
| Task edited on device A (higher clock), deleted on device B | Edit wins — deletion loses to a causally later edit |
| Same sync message arrives twice | Rejected — `processed_events` table stores every `event_id`; duplicate is silently dropped |
| Events arrive out of order | Handled — each event carries its own Lamport clock; the server applies them independently and the Lamport comparison still produces the correct winner |

**Why not vector clocks?** With only two devices and a server acting as arbiter, Lamport clocks are sufficient to establish a total order. Vector clocks would be necessary if we needed to detect true concurrency (two edits with no causal relationship), but here we resolve all conflicts deterministically anyway, so detecting concurrency vs ordering them doesn't change the outcome.

**Why not "last wall-clock time wins"?** Device clocks are untrustworthy. A phone set to the wrong timezone or with clock drift would incorrectly win over a causally later edit.

### Focus Session Conflicts

Sessions are **append-only** on device and **terminal-state wins** on server:
- A session in `pending` state can be updated to `success` or `failed`.
- Once a session is `success` or `failed`, it cannot be updated (terminal state is immutable).
- If two devices both try to close the same session, the first to sync wins; the second is a no-op (event_id deduplicated via `processed_events`).

In practice, the same physical session can only run on one device, so this conflict scenario doesn't arise in real usage — but the idempotency still handles it correctly.

---

## Why Two Devices Always End Up Identical

Both devices converge to the server's authoritative state after each sync:

1. Device A syncs → server applies A's events, returns full state → A replaces local state.
2. Device B syncs → server applies B's events (conflicts resolved by Lamport LWW), returns same full state → B replaces local state.
3. After both syncs, both devices hold exactly the server's state.

The key invariant: **the server is always the arbiter**. Devices never merge with each other; they only merge with the server. This avoids any multi-party merge complexity.

---

## Idempotency

### Backend

Every event carries a stable `event_id` (UUID generated at mutation time, not at sync time).

Before processing any event, the server checks `processed_events`:
```sql
SELECT 1 FROM processed_events WHERE event_id = ?
```
If found → skip. If not → insert + process. This is done inside a single SQLite transaction per sync batch, so a retry of the same batch (e.g. network dropped after server processed but before client received response) is safe.

### Rewards

Focus session rewards (coins, streak, today's minutes) are applied inside `applyFocusRewards`, which also sets `notification_sent = 1` on the session row. Before applying rewards, we check:
```sql
SELECT notification_sent FROM focus_sessions WHERE session_id = ?
```
If already `1` → skip rewards. So even if the same session is synced from two devices (e.g. both were offline and both have the session's terminal event), rewards are applied exactly once.

### n8n

The n8n workflow uses **workflow static data** (`$getWorkflowStaticData('global')`) as a key-value store of seen `event_id`s. On each webhook trigger:
1. Extract `event_id` from payload.
2. Check if `seenEventIds[event_id]` exists in static data.
3. If yes → respond `{ notified: false, reason: 'duplicate' }` without sending.
4. If no → mark seen, send notification, respond `{ notified: true }`.

This deduplicates even if the backend fires the webhook twice (e.g. network retry), or if two devices independently trigger the backend's notification logic for the same session.

**Note on n8n static data persistence**: n8n static data persists across workflow executions but not across restarts in some configurations. For production, this would be backed by a database key-value store (Redis or Postgres). For this demo it's sufficient.

---

## Tradeoff Made

**Chose pull-to-truth (server replaces local state) over true bidirectional CRDT merge.**

*Pros:*
- Simple to reason about. The server is always right.
- No complex three-way merge logic.
- Easy to debug: the server state is the ground truth you can always inspect.
- No divergence possible once a sync completes.

*Cons:*
- A device's pending changes can be "shadowed" if the server state has moved on. For example: device A sets a task to In Progress offline. Meanwhile device B sets it to Done and syncs first. When device A syncs, it sends its event (In Progress, lower Lamport), loses the conflict, and the server returns Done. Device A's local view is then corrected to Done — which may surprise the user. The user's edit is lost silently.

*What I'd do differently in production:*
- Surface conflicts to the user where automatic resolution is unclear (e.g. "Your edit was overridden by another device — was that OK?").
- Use a per-field version vector so we can detect which specific fields diverged.
- Consider CRDTs (e.g. a grow-only counter for coins, a last-write-wins register per task status) to enable offline-local correctness without round-trip correction.

---

## Where It Could Still Break

1. **n8n static data reset**: If n8n restarts with `staticData: null`, the seen-event-ids set is lost and a replayed event could send a duplicate notification.
2. **Clock skew on the server itself**: The "today's focus date" logic uses the server's wall clock. If the server's timezone is different from the student's, sessions near midnight could be attributed to the wrong day.
3. **Partial sync crash**: If the server processes events and updates the DB, but the HTTP response is lost before the client receives it, the client will retry the sync with the same events. The `processed_events` table handles this correctly (idempotent). But: if the server crashes mid-transaction, partial state could be written. SQLite WAL mode mitigates this.
4. **3+ devices**: The pull-to-truth model scales to any number of devices, but the Lamport tiebreak assumes deterministic ordering holds. If three devices all make the same edit with the same Lamport clock (unlikely but theoretically possible after a reset), the `device_id` tiebreak still produces a deterministic winner.
5. **Offline session from "the future"**: If a device's clock is ahead of the server's, a session's `started_at` could be in the future relative to the server's `today`. The streak calculation would be wrong. Mitigation: always use server-side `datetime('now')` for reward application, not the device-provided timestamp — which we do.

# Frozen engine API — `deepwork-engine` (crate root `src-tauri/src/engine`)

Status: **frozen for the first implementation wave**. The backend/frontend workers may code
against this document. Any later change must be additive and announced in `docs/PROGRESS.md`.

Owner: engine worker. Owned paths: `src-tauri/src/engine/**` only.

---

## 1. Crate and integration

| Item | Value |
|---|---|
| Manifest | `src-tauri/src/engine/Cargo.toml` |
| Package name | `deepwork-engine` |
| Crate (import) name | `deepwork_engine` |
| Version | `0.1.0-alpha.1` |
| Edition | 2021 (`rust-version = 1.74`) |
| `[lib]` | `name = "deepwork_engine"`, `path = "mod.rs"` |
| Dependencies | `serde` (derive), `serde_json`, `uuid` (`v4`, `serde`) — nothing else |
| Build | `#![forbid(unsafe_code)]`, `#![deny(missing_docs)]`, no `unsafe`, no I/O, no clock reads |

Backend integration (integration worker owns `src-tauri/Cargo.toml`):

```toml
[dependencies]
deepwork-engine = { path = "src/engine" }
```

```rust
use deepwork_engine::{Action, Config, Engine, EngineError, Snapshot, Transition};
```

The engine crate declares **its own `[workspace]` root** and `autotests = false`:

* the own workspace root lets the engine be built and tested standalone
  (`cargo test --manifest-path src-tauri/src/engine/Cargo.toml`) without the Tauri backend
  package, which is still under construction in parallel;
* `autotests = false` keeps cargo from treating `src-tauri/src/engine/tests/` as a set of
  integration-test binaries — the engine keeps its unit tests inside the library;
* a path dependency that is its own workspace root is still consumed normally by the backend
  package (`deepwork-engine = { path = "src/engine" }`); this was verified with a throw-away
  parent crate.

The engine folder therefore contains its own `Cargo.lock` (offline resolved). When the backend
package builds the engine as a path dependency, the backend workspace lockfile governs; the
integrator may keep or delete the engine lockfile.

---

## 2. Public API (exact signatures)

Everything below is re-exported at the crate root (`deepwork_engine::*`).

```rust
// ---- types (engine/types.rs) ----
pub const MIN_DURATION_MS: u64 = 1_000;              // 1 second
pub const MAX_DURATION_MS: u64 = 86_400_000;         // 24 hours
pub const MAX_LABEL_CHARS: usize = 120;              // Unicode scalar values, not bytes
pub const MIN_LONG_BREAK_INTERVAL: u32 = 1;
pub const MAX_LONG_BREAK_INTERVAL: u32 = 100;
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

pub const ERROR_INVALID_DURATION: &str = "INVALID_DURATION";
pub const ERROR_INVALID_LABEL: &str = "INVALID_LABEL";     // extension, see §7
pub const ERROR_INVALID_STATE: &str = "INVALID_STATE";
pub const ERROR_STALE_REVISION: &str = "STALE_REVISION";   // produced by the service, not the engine
pub const ERROR_STORAGE_UNAVAILABLE: &str = "STORAGE_UNAVAILABLE";
pub const ERROR_UNSUPPORTED: &str = "UNSUPPORTED";
pub const ERROR_SHORTCUT_CONFLICT: &str = "SHORTCUT_CONFLICT";
pub const ERROR_PERMISSION_DENIED: &str = "PERMISSION_DENIED";
pub const ERROR_CORRUPT_DATA: &str = "CORRUPT_DATA";
pub const ERROR_INTERNAL: &str = "INTERNAL";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode { Countdown, Cycle }              // "countdown" | "cycle"

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase { Focus, ShortBreak, LongBreak } // "focus" | "short_break" | "long_break"

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle, Running, Paused, Completed, RecoveryPending,
}                                              // "idle" | "running" | "paused" | "completed" | "recovery_pending"

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub mode: Mode,
    pub focus_ms: u64,
    pub short_break_ms: u64,
    pub long_break_ms: u64,
    pub long_break_interval: u32,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u32,      // always 1 in this version
    pub revision: u64,
    pub session_id: Option<String>,
    pub phase_id: Option<String>,
    pub mode: Mode,
    pub phase: Phase,
    pub status: Status,
    pub duration_ms: u64,
    pub remaining_ms: u64,
    pub completed_focus_count: u32,
    pub label: String,
    pub interrupted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Action {
    Configure { config: Config },
    Start,
    Pause,
    Resume,
    Reset,
    Skip,
    Advance,
    End,
    AcceptRecovery,
    DiscardRecovery,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Effect {
    PhaseCompleted { phase_id: String, phase: Phase, duration_ms: u64, label: String, interrupted: bool },
    PhaseSkipped   { phase_id: String, phase: Phase, duration_ms: u64, label: String, interrupted: bool },
    SessionEnded   { phase_id: String, phase: Phase, duration_ms: u64, label: String, interrupted: bool },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineError { pub code: String, pub message: String }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition { pub snapshot: Snapshot, pub effects: Vec<Effect> }

// ---- engine (engine/transition.rs) ----
pub struct Engine { /* private fields */ }

impl Engine {
    pub fn new() -> Self;
    pub fn snapshot(&self) -> Snapshot;                                  // owned clone
    pub fn config(&self) -> Config;                                      // owned clone
    pub fn apply(&mut self, action: Action, elapsed_ms: u64) -> Result<Transition, EngineError>;
    pub fn tick(&mut self, elapsed_ms: u64) -> Transition;
    pub fn restore(snapshot: Snapshot, config: Config) -> Result<Self, EngineError>;
    pub fn mark_interrupted(&mut self) -> Transition;                     // extra, §5.4
    pub fn mark_recovery_pending(&mut self, elapsed_ms: u64) -> Transition; // extra, §5.4
}

impl Default for Engine { fn default() -> Self { Self::new() } }

impl Config {
    pub fn default() -> Self;                                  // 50/10/30 min, interval 4, cycle, empty label
    pub fn validate(&self) -> Result<(), EngineError>;
}

impl EngineError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self;
    pub fn invalid_duration(message: impl Into<String>) -> Self;
    pub fn invalid_label(message: impl Into<String>) -> Self;
    pub fn invalid_state(message: impl Into<String>) -> Self;
    pub fn corrupt_data(message: impl Into<String>) -> Self;
    pub fn unsupported(message: impl Into<String>) -> Self;
}
```

`EngineError` also implements `Display` and `std::error::Error`.

---

## 3. JSON contract (serde)

### 3.1 Snapshot (camelCase fields, snake_case enum values)

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "sessionId": "1f9d0f3c-0a54-4c2e-9c2f-6b0a2f5c8e11",
  "phaseId": "6f1a52d8-0d3b-4a77-9d10-5b3a5c7e9f22",
  "mode": "cycle",
  "phase": "focus",
  "status": "running",
  "durationMs": 3000000,
  "remainingMs": 2400000,
  "completedFocusCount": 1,
  "label": "Deep work",
  "interrupted": false
}
```

`sessionId` / `phaseId` are `null` (never omitted) when absent.

### 3.2 Action (internally tagged, `"type"`)

```json
{"type": "configure", "config": {"mode": "cycle", "focusMs": 3000000, "shortBreakMs": 600000,
                                 "longBreakMs": 1800000, "longBreakInterval": 4, "label": ""}}
{"type": "start"} {"type": "pause"} {"type": "resume"} {"type": "reset"}
{"type": "skip"} {"type": "advance"} {"type": "end"}
{"type": "accept_recovery"} {"type": "discard_recovery"}
```

### 3.3 Effect (internally tagged, `"type"`)

```json
{"type": "phase_completed", "phaseId": "…", "phase": "focus",
 "durationMs": 3000000, "label": "Deep work", "interrupted": false}
{"type": "phase_skipped",   "phaseId": "…", "phase": "short_break", "durationMs": 600000, "label": "", "interrupted": false}
{"type": "session_ended",   "phaseId": "…", "phase": "focus", "durationMs": 3000000, "label": "", "interrupted": true}
```

`durationMs` in an effect is the **configured duration of the phase the effect refers to**.
The elapsed part of a phase is derived by the backend from the accompanying snapshot
(`durationMs - remainingMs`).

### 3.4 Transition

```json
{"snapshot": { … }, "effects": [ … ]}
```

### 3.5 EngineError

```json
{"code": "INVALID_STATE", "message": "start requires the timer to be idle"}
```

`code` is one of the stable codes in §2. `message` is safe user text (no paths, no labels, no secrets).

---

## 4. Timing model

* `elapsed_ms` is an **absolute, monotonically increasing, suspend-inclusive** millisecond counter
  supplied by the service (e.g. `CLOCK_BOOTTIME` / `mach_continuous_time` / `GetTickCount64`).
  The engine never reads the clock, the filesystem or any global state.
* The engine never decrements a counter per tick. It stores two runtime values per phase:
  `remaining_at_anchor_ms` (the remaining time when the anchor was taken) and `anchor_ms` (the
  absolute elapsed sample of the anchor). The remaining time is always
  `remaining_at_anchor_ms - (elapsed_ms - anchor_ms)`, saturating at 0.
* `anchor_ms` is set on `Start`, `Resume` and `AcceptRecovery` and cleared when a phase stops
  running. Pausing freezes `remaining_ms`; resuming re-anchors at the supplied sample with the
  frozen remainder, so no time is lost or double counted.
* A sample that is older than the current anchor never increases the remaining time: the
  remaining time is clamped to the value it already had, so out-of-order or replayed samples
  cannot extend a countdown.
* `remaining_ms` is always in `0 ..= duration_ms` and `duration_ms` is always in
  `1_000 ..= 86_400_000`.

---

## 5. State machine

### 5.1 Command table

| Action | Valid in | Result |
|---|---|---|
| `Configure` | `idle`, `completed` | Validate config, then create a fresh **idle focus** phase with the new configuration. Does not touch a running/paused phase (rejected). |
| `Start` | `idle` | New anchor, `status = running`. On `running` it is a **harmless no-op** (keyboard repeat). Creates a new session id and resets the completed-focus count when no session is active. |
| `Pause` | `running` | Sample remaining first; if the phase already expired → **complete instead** (completion effect returned, pause absorbed). Otherwise freeze `remaining_ms`, `status = paused`. On `paused` it is a harmless no-op. |
| `Resume` | `paused` | New anchor, keep frozen remaining, `status = running`. On `running` harmless no-op. |
| `Reset` | `idle`, `running`, `paused`, `completed` | **New phase id**, same phase kind, full configured duration, `status = idle`, `interrupted = false`. No history effect, completed history untouched, focus count untouched. Not allowed while `recovery_pending`. |
| `Skip` | `running`, `paused`, `completed` | Record `phase_skipped` **only when the phase was not already completed**; then select the next phase **idle**. Never increments the completed-focus count. |
| `Advance` | `completed`, **cycle mode only** | Select the next phase **idle**. The focus count was already incremented at completion — never again here. |
| `End` | `running`, `paused`, `completed` | Record `session_ended` **only when the phase was not already completed**; then clear to the idle default (fresh idle focus phase, count 0, new phase id). The session id is retained in the snapshot so the backend can correlate the record. |
| `AcceptRecovery` | `recovery_pending` | Accept the recovered session: new anchor, `status = running`, frozen remaining preserved, `interrupted` flag preserved. |
| `DiscardRecovery` | `recovery_pending` | Discard the recovered session: clear to the idle default (no session id, count 0). |

Invalid combinations return `Err(EngineError { code: "INVALID_STATE", .. })` and leave the state
**completely unchanged** (no revision bump, no effects).

### 5.2 Expiry sampling order (all commands)

`apply(action, elapsed_ms)` always does this, in this order:

1. **Sample expiry** — if the engine is `running`, recompute `remaining_ms` from the anchor.
   If it reaches 0 the phase completes **exactly once**: `status = completed`, `remaining_ms = 0`,
   completed-focus count incremented (focus phases only), one `phase_completed` effect.
2. **Apply the action** against the post-sample state.
3. **Roll back** the whole thing if the action is invalid: the error is returned and the engine
   state (including the sampled expiry) is unchanged. The pending expiry is detected again on the
   next successful sample, so no completion is ever lost or double counted.
   Exception: `Pause` on an expired running phase is *absorbed* by the completion (PLAN §5), so it
   succeeds and returns the completion effect.

`tick(elapsed_ms)` performs step 1 only, and only while `running`; in every other status it
returns the current snapshot with no effects and no revision change.

### 5.3 Cycle progression

* Completed **focus** → completed-focus count `+1` (exactly once) → next phase is
  `long_break` when `count % long_break_interval == 0`, otherwise `short_break`.
* Completed **break** → next phase is `focus`.
* **Skipped** break → next phase is `focus`.
* **Skipped** focus → count unchanged; next phase is `long_break` when
  `count > 0 && count % long_break_interval == 0`, otherwise `short_break`.
  (A skipped focus never earns a long break at count 0.)
* `Reset` never changes the phase kind and never increments the count.
* `countdown` mode: the phase is always `focus` with `focus_ms`; `advance` is not available
  (`INVALID_STATE`), `skip` records the skip and restarts the same single phase idle.
* The count is reset when a **new session** starts (first `Start` after `End`/`Configure`/engine
  creation), not at midnight and not on every `Start`.

### 5.4 Interruption and recovery helpers

| Method | Effect |
|---|---|
| `mark_interrupted()` | Records that an interruption (suspend/resume or an unexpected long gap) was observed. The flag is set on the snapshot immediately, in every status. When a phase is active it marks that phase, which the backend has to exclude from confirmed focus totals until the user accepts it; when the timer is idle it marks the next phase that starts, so a phase that follows an interruption is never counted as confirmed work by accident. The flag is cleared when the marked phase ends (completion or skip) or when the phase is reset. No effects, the revision bumps when the flag changed. |
| `mark_recovery_pending(elapsed_ms)` | Samples the remaining first, then moves an active phase to `recovery_pending` with the remaining frozen. If the phase expired in the same instant it completes instead (exactly one completion). |

`Engine::restore(snapshot, config)`:

| Restored snapshot status | Engine status after restore |
|---|---|
| `running`, `paused`, `recovery_pending` | `recovery_pending` (user must `accept_recovery` or `discard_recovery`) |
| `completed` | `completed` — **no new completion effect**, so a restart never re-announces a finished phase |
| `idle` | `idle` |

The restored phase keeps its persisted `phase_id`, `duration_ms`, `remaining_ms`,
`completed_focus_count`, `label` and `interrupted` flag. The restored engine has **no clock
anchor**: time that passed while the application was closed is *not* counted (the UI shows the
checkpoint age; `accept_recovery` starts a new anchor). The restored `revision` is
`persisted_revision + 1` (saturating).

`restore` rejects: a config that fails validation (`INVALID_DURATION` / `INVALID_LABEL`), a
`schemaVersion` other than 1 (`UNSUPPORTED`), a duration outside 1 s–24 h or `remainingMs >
durationMs` (`CORRUPT_DATA`), and a label longer than 120 characters (`INVALID_LABEL`).

---

## 6. Revision and effect rules

* `revision` is monotonically increasing (`u64`, saturating). It is bumped **once** whenever any
  observable snapshot field changes — including published ticks where only `remainingMs` moved.
  A no-op command does not bump it.
* An invalid command does not bump it (the state is unchanged).
* Effects are returned in causal order, at most one per transition. `phase_completed` is emitted
  exactly once per phase: the phase moves to `completed` and stays there, so repeated ticks or
  later commands cannot re-emit it.
* `phase_completed` and `phase_skipped` identify the phase by `phaseId` — the stable completion id
  used by durable history upserts.
* A `session_ended` effect is emitted only for a phase that was **not** completed, so a phase is
  never recorded twice (completed *or* ended).

---

## 7. Documented interpretations and deviations

1. **`INVALID_LABEL` is an added error code.** PLAN §6 fixes nine stable codes and none fits a
   120-character label cap. The engine rejects an over-long label with `INVALID_LABEL` instead of
   silently truncating user data. The frontend can map it onto any existing code; the integrator
   may decide to rename it.
2. **`Advance` is cycle-mode only.** PLAN §5 lists `Advance` for "completed cycle". In
   `countdown` mode the engine returns `INVALID_STATE`; `Reset` is the countdown equivalent.
3. **`Skip` in countdown mode** records the skip and restarts the same single phase idle, because
   a countdown session has no "next phase" to select.
4. **Skipped focus phase → break.** PLAN does not define the phase after a *skipped* focus. The
   engine keeps the cycle structure (focus → break → focus) but never counts the skipped focus.
5. **`End` on a completed phase** clears to idle **without** a `session_ended` effect, because the
   phase was already recorded as completed. The session id is retained in the snapshot for
   correlation; the next `Start` creates a new session id.
6. **`Configure` resets the completed-focus count and drops the session id**, because settings
   edits affect the *next* session.
7. **`restore` adopts the snapshot's `mode`** for the restored session; the `mode` of the passed
   configuration is ignored during recovery.
8. **`durationMs` inside an effect is the configured phase duration**, not the elapsed part of the
   phase (the effect shape is frozen by the task).
9. The engine crate owns **no** persistence, no notification/sound and no staleness check:
   `STALE_REVISION` is raised by the service layer that owns the snapshot revision.

---

## 8. How the service is expected to call the engine

```rust
use deepwork_engine::{Action, Engine, EngineError};

let mut engine = Engine::new();

// The service owns the clock adapter and passes absolute, suspend-inclusive samples.
let elapsed_ms = clock.suspend_inclusive_millis();

// Commands: the service serialises them through one owner.
match engine.apply(Action::Start, elapsed_ms) {
    Ok(transition) => {
        // 1. persist the checkpoint for transition.snapshot
        // 2. dispatch transition.effects (append history, notify, sound) — best effort
        // 3. publish transition.snapshot to the frontend
    }
    Err(error) => {
        // error.code is one of the stable codes; error.message is safe user text.
    }
}

// Deadline checks: the service calls tick() when the nearest deadline is reached.
let transition = engine.tick(clock.suspend_inclusive_millis());
if let Some(effect) = transition.effects.first() {
    // Persist the completion before any notification.
}

// Startup recovery: a persisted snapshot becomes recovery_pending.
let mut engine = Engine::restore(persisted_snapshot, persisted_config)?;
```

Rules for the service layer:

* One owner serialises commands and deadline checks; the engine has no internal locking.
* Check the expiry **before** dispatching a command to the frontend (the engine already does it
  inside `apply`), and reject stale revisions with `STALE_REVISION` before calling `apply`.
* Persist a checkpoint on every transition and at least every 30 s while running; a persisted
  `Snapshot` is exactly what `Engine::restore` expects.
* Never hold a lock across filesystem, notification or UI work; copy the `Snapshot` out of the
  engine, release the lock, then do the I/O.
* `Effect::PhaseCompleted.phase_id` is the stable completion id: upsert history by it so a
  repeated checkpoint can never create a second record.

## 9. Deterministic test coverage (engine worker)

* Configuration validation: bounds 1 s–24 h, interval bounds, 120-character label cap counted in
  characters (multi-byte), serde defaults.
* Countdown: start/pause/resume/reset/end, freeze on pause, re-anchor on resume, no decrement
  drift, delayed tick, pause exactly at expiry.
* Cycle: four focus completions select the long break, focus count increments exactly once,
  skip/reset never increment, advance after completion never increments, repeated ticks after a
  completion emit no second effect.
* Errors: every action in every invalid status returns `INVALID_STATE` and leaves the state
  unchanged; invalid durations/labels are rejected.
* Recovery: restore of a running/paused record → `recovery_pending`; accept → running with a new
  anchor; discard → idle; restore of a completed record emits no completion.
* Serialization: exact JSON field names/values, tagged action/effect round trip.
* Property test: deterministic pseudo-random action sequences assert `0 <= remaining <= duration`,
  no duplicate completion effect per phase id, and a monotonic revision.

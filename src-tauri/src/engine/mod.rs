//! `deepwork-engine` — the deterministic, platform-free timer engine of Deepwork Clock.
//!
//! The crate owns the authoritative timer state: countdown, focus/break cycle, completion
//! counting and the recovery state machine. It is intentionally free of every platform concern:
//!
//! * no file system access, no network access, no global mutable state;
//! * no clock reads — every caller supplies an absolute, monotonically increasing,
//!   suspend-inclusive millisecond sample;
//! * no `unsafe` code;
//! * no dependency on Tauri, GTK or any desktop toolkit, so the tests run headless.
//!
//! # Example
//!
//! ```
//! use deepwork_engine::{Action, Engine, Status};
//!
//! let mut engine = Engine::new();
//! engine.apply(Action::Start, 0).expect("start is valid while idle");
//!
//! let transition = engine.tick(1_000);
//! assert_eq!(transition.snapshot.status, Status::Running);
//! assert_eq!(transition.snapshot.remaining_ms, 2_999_000);
//! ```
//!
//! # Timing model
//!
//! The engine never decrements a counter per tick. It stores a clock anchor and recomputes the
//! remaining time from the supplied sample, so a delayed or repeated sample can never make the
//! countdown drift. A phase completes exactly once, and the completion is reported as an
//! [`Effect`] that the service persists before it dispatches any notification.
//!
//! See `docs/PLAN.md` section 5 for the authoritative specification and the engine API note for
//! the frozen contract of this crate.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod transition;
mod types;

#[cfg(test)]
mod tests;

pub use transition::Engine;
pub use types::{
    Action, Config, Effect, EngineError, Mode, Phase, Snapshot, Status, Transition,
    ERROR_CORRUPT_DATA, ERROR_INTERNAL, ERROR_INVALID_DURATION, ERROR_INVALID_LABEL,
    ERROR_INVALID_STATE, ERROR_PERMISSION_DENIED, ERROR_SHORTCUT_CONFLICT, ERROR_STALE_REVISION,
    ERROR_STORAGE_UNAVAILABLE, ERROR_UNSUPPORTED, MAX_DURATION_MS, MAX_LABEL_CHARS,
    MAX_LONG_BREAK_INTERVAL, MIN_DURATION_MS, MIN_LONG_BREAK_INTERVAL, SNAPSHOT_SCHEMA_VERSION,
};

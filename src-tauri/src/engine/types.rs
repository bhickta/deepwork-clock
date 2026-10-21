//! Public data types of the `deepwork-engine` timer engine.
//!
//! Every type in this module is part of the frozen bridge contract described in
//! `docs/HANDOFF.md` and PLAN section 6. Field names are serialised in `camelCase`, enum
//! values in `snake_case`, and the command/effect enums are internally tagged with `"type"`.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Smallest phase duration accepted by the engine: one second.
pub const MIN_DURATION_MS: u64 = 1_000;

/// Largest phase duration accepted by the engine: 24 hours.
pub const MAX_DURATION_MS: u64 = 86_400_000;

/// Largest number of Unicode scalar values accepted in a session label.
pub const MAX_LABEL_CHARS: usize = 120;

/// Smallest accepted number of focus phases between two long breaks.
pub const MIN_LONG_BREAK_INTERVAL: u32 = 1;

/// Largest accepted number of focus phases between two long breaks.
pub const MAX_LONG_BREAK_INTERVAL: u32 = 100;

/// Schema version of [`Snapshot`] produced and accepted by this crate.
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

/// Error code for a duration outside the supported range.
pub const ERROR_INVALID_DURATION: &str = "INVALID_DURATION";

/// Error code for a label longer than [`MAX_LABEL_CHARS`].
///
/// Extension to the stable code list of PLAN section 6; see `docs/HANDOFF.md` and the engine
/// API note for the rationale.
pub const ERROR_INVALID_LABEL: &str = "INVALID_LABEL";

/// Error code for a command that is not valid in the current state.
pub const ERROR_INVALID_STATE: &str = "INVALID_STATE";

/// Error code for a stale command revision.
///
/// Raised by the service layer that owns the snapshot revision, not by this crate.
pub const ERROR_STALE_REVISION: &str = "STALE_REVISION";

/// Error code for an unavailable storage backend.
pub const ERROR_STORAGE_UNAVAILABLE: &str = "STORAGE_UNAVAILABLE";

/// Error code for an unsupported request, for example a future snapshot schema version.
pub const ERROR_UNSUPPORTED: &str = "UNSUPPORTED";

/// Error code for a shortcut conflict.
pub const ERROR_SHORTCUT_CONFLICT: &str = "SHORTCUT_CONFLICT";

/// Error code for a denied permission.
pub const ERROR_PERMISSION_DENIED: &str = "PERMISSION_DENIED";

/// Error code for malformed or inconsistent persisted data.
pub const ERROR_CORRUPT_DATA: &str = "CORRUPT_DATA";

/// Error code for an unexpected internal failure.
pub const ERROR_INTERNAL: &str = "INTERNAL";

/// Timer mode of a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// A single countdown that never advances to a break.
    Countdown,
    /// A focus/break cycle that advances until the session ends.
    Cycle,
}

/// Phase of the current countdown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// A focus phase.
    Focus,
    /// A short break phase.
    ShortBreak,
    /// A long break phase.
    LongBreak,
}

/// State of the current phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// A phase exists but is not running.
    Idle,
    /// The phase is counting down.
    Running,
    /// The phase is frozen and can be resumed.
    Paused,
    /// The phase reached its deadline and waits for `Advance` or `Reset`.
    Completed,
    /// A recovered phase awaits an explicit accept or discard decision.
    RecoveryPending,
}

/// Frozen configuration of a session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Timer mode of the session.
    pub mode: Mode,
    /// Duration of a focus phase in milliseconds.
    pub focus_ms: u64,
    /// Duration of a short break phase in milliseconds.
    pub short_break_ms: u64,
    /// Duration of a long break phase in milliseconds.
    pub long_break_ms: u64,
    /// Number of completed focus phases between two long breaks.
    pub long_break_interval: u32,
    /// Optional session label, at most [`MAX_LABEL_CHARS`] Unicode scalar values.
    pub label: String,
}

impl Default for Config {
    /// The default 50/10/30 minute cycle.
    fn default() -> Self {
        Self {
            mode: Mode::Cycle,
            focus_ms: 50 * 60 * 1_000,
            short_break_ms: 10 * 60 * 1_000,
            long_break_ms: 30 * 60 * 1_000,
            long_break_interval: 4,
            label: String::new(),
        }
    }
}

impl Config {
    /// Validates the configuration.
    ///
    /// Durations must be between [`MIN_DURATION_MS`] and [`MAX_DURATION_MS`], the long break
    /// interval between [`MIN_LONG_BREAK_INTERVAL`] and [`MAX_LONG_BREAK_INTERVAL`], and the
    /// label at most [`MAX_LABEL_CHARS`] Unicode scalar values long.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::invalid_duration`] for an out-of-range duration or interval and
    /// [`EngineError::invalid_label`] for an over-long label.
    pub fn validate(&self) -> Result<(), EngineError> {
        let durations = [
            ("focus", self.focus_ms),
            ("short break", self.short_break_ms),
            ("long break", self.long_break_ms),
        ];
        for (name, value) in durations {
            if !(MIN_DURATION_MS..=MAX_DURATION_MS).contains(&value) {
                return Err(EngineError::invalid_duration(format!(
                    "{name} duration must be between {MIN_DURATION_MS} and {MAX_DURATION_MS} milliseconds"
                )));
            }
        }
        if !(MIN_LONG_BREAK_INTERVAL..=MAX_LONG_BREAK_INTERVAL).contains(&self.long_break_interval)
        {
            return Err(EngineError::invalid_duration(format!(
                "long break interval must be between {MIN_LONG_BREAK_INTERVAL} and {MAX_LONG_BREAK_INTERVAL}"
            )));
        }
        if self.label.chars().count() > MAX_LABEL_CHARS {
            return Err(EngineError::invalid_label(format!(
                "label must not exceed {MAX_LABEL_CHARS} characters"
            )));
        }
        Ok(())
    }
}

/// Serializable view of the engine state.
///
/// Frontend snapshots never contain runtime clock handles, only the frozen values that are
/// needed to render and to validate incoming state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Schema version of the snapshot, always `1` in this version.
    pub schema_version: u32,
    /// Monotonically increasing revision of the engine state.
    pub revision: u64,
    /// Identifier of the current session, `None` before the first start.
    pub session_id: Option<String>,
    /// Identifier of the current phase, the stable completion id used by history upserts.
    pub phase_id: Option<String>,
    /// Timer mode of the session.
    pub mode: Mode,
    /// Phase of the current countdown.
    pub phase: Phase,
    /// State of the current phase.
    pub status: Status,
    /// Configured duration of the current phase in milliseconds.
    pub duration_ms: u64,
    /// Remaining time of the current phase in milliseconds.
    pub remaining_ms: u64,
    /// Number of completed focus phases in the current session.
    pub completed_focus_count: u32,
    /// Optional session label.
    pub label: String,
    /// Whether an interruption was observed during the current phase.
    pub interrupted: bool,
}

/// Command that can be applied to the engine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    /// Validate a configuration and create a fresh idle focus phase with it.
    Configure {
        /// The new configuration.
        config: Config,
    },
    /// Start the idle phase.
    Start,
    /// Freeze the running phase.
    Pause,
    /// Continue the paused phase with a new clock anchor.
    Resume,
    /// Replace the current phase with a fresh idle phase of the same kind.
    Reset,
    /// Record the current phase as skipped and select the next phase idle.
    Skip,
    /// Select the next phase idle after a completed phase.
    Advance,
    /// End the session and clear to the idle default.
    End,
    /// Accept a recovered phase and continue it.
    AcceptRecovery,
    /// Discard a recovered phase and clear to the idle default.
    DiscardRecovery,
}

/// Result of a transition that the service has to act upon.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Effect {
    /// The phase reached its deadline.
    PhaseCompleted {
        /// Identifier of the completed phase.
        phase_id: String,
        /// Kind of the completed phase.
        phase: Phase,
        /// Configured duration of the completed phase in milliseconds.
        duration_ms: u64,
        /// Label of the session the phase belonged to.
        label: String,
        /// Whether an interruption was observed during the phase.
        interrupted: bool,
    },
    /// The phase was skipped by the user.
    PhaseSkipped {
        /// Identifier of the skipped phase.
        phase_id: String,
        /// Kind of the skipped phase.
        phase: Phase,
        /// Configured duration of the skipped phase in milliseconds.
        duration_ms: u64,
        /// Label of the session the phase belonged to.
        label: String,
        /// Whether an interruption was observed during the phase.
        interrupted: bool,
    },
    /// The session ended while the phase was unfinished.
    SessionEnded {
        /// Identifier of the phase that was active when the session ended.
        phase_id: String,
        /// Kind of that phase.
        phase: Phase,
        /// Configured duration of that phase in milliseconds.
        duration_ms: u64,
        /// Label of the session that ended.
        label: String,
        /// Whether an interruption was observed during the phase.
        interrupted: bool,
    },
}

/// Typed error returned by the engine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    /// Stable machine readable error code, see the `ERROR_*` constants.
    pub code: String,
    /// Safe, user facing explanation. Never contains paths, labels or secrets.
    pub message: String,
}

impl EngineError {
    /// Creates an error with an explicit code and message.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    /// Creates an [`ERROR_INVALID_DURATION`] error.
    pub fn invalid_duration(message: impl Into<String>) -> Self {
        Self::new(ERROR_INVALID_DURATION, message)
    }

    /// Creates an [`ERROR_INVALID_LABEL`] error.
    pub fn invalid_label(message: impl Into<String>) -> Self {
        Self::new(ERROR_INVALID_LABEL, message)
    }

    /// Creates an [`ERROR_INVALID_STATE`] error.
    pub fn invalid_state(message: impl Into<String>) -> Self {
        Self::new(ERROR_INVALID_STATE, message)
    }

    /// Creates an [`ERROR_CORRUPT_DATA`] error.
    pub fn corrupt_data(message: impl Into<String>) -> Self {
        Self::new(ERROR_CORRUPT_DATA, message)
    }

    /// Creates an [`ERROR_UNSUPPORTED`] error.
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ERROR_UNSUPPORTED, message)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

/// Result of applying a command or sampling the clock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    /// The state after the transition.
    pub snapshot: Snapshot,
    /// Effects the service has to persist or dispatch, in causal order.
    pub effects: Vec<Effect>,
}

//! The deterministic timer engine.
//!
//! The engine owns the authoritative timer state. It never reads the clock, the filesystem or any
//! global state: every caller supplies an absolute, monotonically increasing, suspend-inclusive
//! millisecond sample. Remaining time is always recomputed from the clock anchor, never
//! decremented per tick, so delayed or repeated samples cannot cause drift.
//!
//! See `docs/PLAN.md` section 5 for the authoritative behaviour specification.

use uuid::Uuid;

use crate::types::{
    Action, Config, Effect, EngineError, Mode, Phase, Snapshot, Status, Transition,
    MAX_DURATION_MS, SNAPSHOT_SCHEMA_VERSION,
};

/// Authoritative timer state machine.
///
/// The engine is cheap to clone; commands are applied on a copy so that an invalid command can be
/// rejected without changing the state at all.
#[derive(Clone, Debug)]
pub struct Engine {
    config: Config,
    session_id: Option<String>,
    session_started: bool,
    phase_id: Option<String>,
    phase: Phase,
    status: Status,
    duration_ms: u64,
    remaining_ms: u64,
    remaining_at_anchor_ms: u64,
    anchor_ms: u64,
    completed_focus_count: u32,
    label: String,
    interrupted: bool,
    revision: u64,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    /// Creates an engine with an idle focus phase using the default configuration.
    pub fn new() -> Self {
        let config = Config::default();
        Self {
            duration_ms: config.focus_ms,
            remaining_ms: config.focus_ms,
            remaining_at_anchor_ms: config.focus_ms,
            label: config.label.clone(),
            phase: Phase::Focus,
            phase_id: Some(new_id()),
            status: Status::Idle,
            anchor_ms: 0,
            session_id: None,
            session_started: false,
            completed_focus_count: 0,
            interrupted: false,
            revision: 1,
            config,
        }
    }

    /// Returns an owned copy of the current state.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            revision: self.revision,
            session_id: self.session_id.clone(),
            phase_id: self.phase_id.clone(),
            mode: self.config.mode,
            phase: self.phase,
            status: self.status,
            duration_ms: self.duration_ms,
            remaining_ms: self.remaining_ms,
            completed_focus_count: self.completed_focus_count,
            label: self.label.clone(),
            interrupted: self.interrupted,
        }
    }

    /// Returns an owned copy of the frozen configuration of the current session.
    pub fn config(&self) -> Config {
        self.config.clone()
    }

    /// Applies a command to the engine.
    ///
    /// The engine samples the expiry of a running phase before the command is evaluated, so a
    /// command that arrives at the deadline observes the completed phase. If the command is not
    /// valid in the resulting state, the whole call is rolled back: the error is returned and the
    /// engine state, including the revision, is unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::invalid_state`] when the command is not valid in the current state,
    /// [`EngineError::invalid_duration`] or [`EngineError::invalid_label`] when a configuration is
    /// rejected.
    pub fn apply(&mut self, action: Action, elapsed_ms: u64) -> Result<Transition, EngineError> {
        let before = self.snapshot();
        let mut candidate = self.clone();
        let mut effects = candidate.sample_expiry(elapsed_ms);
        let expired_now = !effects.is_empty();
        let produced = candidate.apply_action(&action, elapsed_ms, expired_now)?;
        effects.extend(produced);
        candidate.bump_revision_if_changed(&before);
        *self = candidate;
        Ok(Transition {
            snapshot: self.snapshot(),
            effects,
        })
    }

    /// Samples the clock without applying a command.
    ///
    /// While the engine runs, the remaining time is recomputed from the clock anchor. A phase
    /// that reached its deadline completes exactly once and produces a single
    /// [`Effect::PhaseCompleted`]. In every other status the call is a no-op.
    pub fn tick(&mut self, elapsed_ms: u64) -> Transition {
        let before = self.snapshot();
        let effects = self.sample_expiry(elapsed_ms);
        self.bump_revision_if_changed(&before);
        Transition {
            snapshot: self.snapshot(),
            effects,
        }
    }

    /// Restores an engine from a persisted snapshot.
    ///
    /// A snapshot of an active session is restored as [`Status::RecoveryPending`]: the user has
    /// to accept or discard it explicitly, and no clock anchor is reconstructed, so the time that
    /// passed while the application was closed is not counted. A completed snapshot stays
    /// completed and produces no completion effect, so a restart never re-announces a finished
    /// phase.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::invalid_duration`] or [`EngineError::invalid_label`] for an invalid
    /// configuration, [`EngineError::unsupported`] for an unknown snapshot schema version and
    /// [`EngineError::corrupt_data`] for inconsistent snapshot values.
    pub fn restore(snapshot: Snapshot, config: Config) -> Result<Self, EngineError> {
        config.validate()?;
        if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION {
            return Err(EngineError::unsupported(format!(
                "unsupported snapshot schema version {}",
                snapshot.schema_version
            )));
        }
        if snapshot.duration_ms == 0 || snapshot.duration_ms > MAX_DURATION_MS {
            return Err(EngineError::corrupt_data(
                "snapshot duration is outside the supported range",
            ));
        }
        if snapshot.remaining_ms > snapshot.duration_ms {
            return Err(EngineError::corrupt_data(
                "snapshot remaining time exceeds its duration",
            ));
        }
        if snapshot.label.chars().count() > crate::types::MAX_LABEL_CHARS {
            return Err(EngineError::invalid_label(format!(
                "snapshot label must not exceed {} characters",
                crate::types::MAX_LABEL_CHARS
            )));
        }

        let was_active = matches!(
            snapshot.status,
            Status::Running | Status::Paused | Status::RecoveryPending
        );
        let status = if was_active {
            Status::RecoveryPending
        } else {
            snapshot.status
        };
        let mut effective_config = config;
        effective_config.mode = snapshot.mode;

        Ok(Self {
            config: effective_config,
            session_id: snapshot.session_id,
            session_started: was_active,
            phase_id: snapshot.phase_id.or_else(|| Some(new_id())),
            phase: snapshot.phase,
            status,
            duration_ms: snapshot.duration_ms,
            remaining_ms: snapshot.remaining_ms,
            remaining_at_anchor_ms: snapshot.remaining_ms,
            anchor_ms: 0,
            completed_focus_count: snapshot.completed_focus_count,
            label: snapshot.label,
            interrupted: snapshot.interrupted,
            revision: snapshot.revision.saturating_add(1),
        })
    }

    /// Records that an interruption was observed.
    ///
    /// The platform layer calls this after an observed suspend/resume or an unexpected long gap.
    /// The flag is set on the snapshot immediately. When a phase is active it marks that phase,
    /// which then has to be excluded from confirmed focus totals until the user accepts the
    /// interruption. When the timer is idle it marks the next phase that starts, so a phase that
    /// follows an interruption is never counted as confirmed work by accident. The flag is cleared
    /// when the marked phase ends (completion or skip) or when the phase is reset.
    pub fn mark_interrupted(&mut self) -> Transition {
        let before = self.snapshot();
        self.interrupted = true;
        self.bump_revision_if_changed(&before);
        Transition {
            snapshot: self.snapshot(),
            effects: Vec::new(),
        }
    }

    /// Moves an active phase into [`Status::RecoveryPending`].
    ///
    /// The remaining time is sampled first and then frozen, so the recovered phase continues
    /// where it stopped. A phase that expired in the same instant completes instead, so a
    /// completion is never lost or duplicated.
    pub fn mark_recovery_pending(&mut self, elapsed_ms: u64) -> Transition {
        let before = self.snapshot();
        let mut effects = Vec::new();
        if matches!(self.status, Status::Running | Status::Paused) {
            let remaining = self.compute_remaining(elapsed_ms);
            self.remaining_ms = remaining;
            if remaining == 0 {
                effects = self.complete_phase();
            } else {
                self.status = Status::RecoveryPending;
                self.anchor_ms = 0;
                self.remaining_at_anchor_ms = self.remaining_ms;
            }
        }
        self.bump_revision_if_changed(&before);
        Transition {
            snapshot: self.snapshot(),
            effects,
        }
    }

    /// Applies a command to an already sampled candidate state.
    fn apply_action(
        &mut self,
        action: &Action,
        elapsed_ms: u64,
        expired_now: bool,
    ) -> Result<Vec<Effect>, EngineError> {
        match action {
            Action::Configure { config } => self.apply_configure(config),
            Action::Start => self.apply_start(elapsed_ms),
            Action::Pause => self.apply_pause(expired_now),
            Action::Resume => self.apply_resume(elapsed_ms),
            Action::Reset => self.apply_reset(),
            Action::Skip => self.apply_skip(),
            Action::Advance => self.apply_advance(),
            Action::End => self.apply_end(),
            Action::AcceptRecovery => self.apply_accept_recovery(elapsed_ms),
            Action::DiscardRecovery => self.apply_discard_recovery(),
        }
    }

    fn apply_configure(&mut self, config: &Config) -> Result<Vec<Effect>, EngineError> {
        config.validate()?;
        if !matches!(self.status, Status::Idle | Status::Completed) {
            return Err(EngineError::invalid_state(
                "configure is only allowed while the timer is idle or after a completed phase",
            ));
        }
        self.config = config.clone();
        self.label = config.label.clone();
        self.phase = Phase::Focus;
        self.duration_ms = config.focus_ms;
        self.remaining_ms = config.focus_ms;
        self.remaining_at_anchor_ms = config.focus_ms;
        self.status = Status::Idle;
        self.phase_id = Some(new_id());
        self.session_id = None;
        self.session_started = false;
        self.completed_focus_count = 0;
        self.interrupted = false;
        self.anchor_ms = 0;
        Ok(Vec::new())
    }

    fn apply_start(&mut self, elapsed_ms: u64) -> Result<Vec<Effect>, EngineError> {
        match self.status {
            Status::Running => Ok(Vec::new()),
            Status::Idle => {
                if !self.session_started {
                    self.session_id = Some(new_id());
                    self.session_started = true;
                    self.completed_focus_count = 0;
                }
                self.status = Status::Running;
                self.anchor_ms = elapsed_ms;
                self.remaining_ms = self.duration_ms;
                self.remaining_at_anchor_ms = self.duration_ms;
                Ok(Vec::new())
            }
            _ => Err(EngineError::invalid_state(
                "start requires the timer to be idle",
            )),
        }
    }

    fn apply_pause(&mut self, expired_now: bool) -> Result<Vec<Effect>, EngineError> {
        if expired_now {
            // The phase completed while the expiry was sampled, so the pause is absorbed by the
            // completion instead of freezing a phase that already reached its deadline.
            return Ok(Vec::new());
        }
        match self.status {
            Status::Paused => Ok(Vec::new()),
            Status::Running => {
                self.status = Status::Paused;
                self.anchor_ms = 0;
                self.remaining_at_anchor_ms = self.remaining_ms;
                Ok(Vec::new())
            }
            _ => Err(EngineError::invalid_state(
                "pause requires the timer to be running",
            )),
        }
    }

    fn apply_resume(&mut self, elapsed_ms: u64) -> Result<Vec<Effect>, EngineError> {
        match self.status {
            Status::Running => Ok(Vec::new()),
            Status::Paused => {
                self.status = Status::Running;
                self.anchor_ms = elapsed_ms;
                self.remaining_at_anchor_ms = self.remaining_ms;
                Ok(Vec::new())
            }
            _ => Err(EngineError::invalid_state(
                "resume requires the timer to be paused",
            )),
        }
    }

    fn apply_reset(&mut self) -> Result<Vec<Effect>, EngineError> {
        if matches!(self.status, Status::RecoveryPending) {
            return Err(EngineError::invalid_state(
                "reset is not available while a recovery is pending, use discard_recovery",
            ));
        }
        self.phase_id = Some(new_id());
        self.status = Status::Idle;
        self.remaining_ms = self.duration_ms;
        self.remaining_at_anchor_ms = self.duration_ms;
        self.interrupted = false;
        self.anchor_ms = 0;
        Ok(Vec::new())
    }

    fn apply_skip(&mut self) -> Result<Vec<Effect>, EngineError> {
        let effect = match self.status {
            Status::Running | Status::Paused => Some(Effect::PhaseSkipped {
                phase_id: self.current_phase_id(),
                phase: self.phase,
                duration_ms: self.duration_ms,
                label: self.label.clone(),
                interrupted: self.interrupted,
            }),
            Status::Completed => None,
            _ => {
                return Err(EngineError::invalid_state(
                    "skip requires a running, paused or completed phase",
                ))
            }
        };
        let previous = self.phase;
        self.select_next_phase(previous);
        Ok(effect.into_iter().collect())
    }

    fn apply_advance(&mut self) -> Result<Vec<Effect>, EngineError> {
        if self.config.mode != Mode::Cycle {
            return Err(EngineError::invalid_state(
                "advance is only available in cycle mode, use reset for a countdown",
            ));
        }
        if self.status != Status::Completed {
            return Err(EngineError::invalid_state(
                "advance requires a completed phase",
            ));
        }
        let previous = self.phase;
        self.select_next_phase(previous);
        Ok(Vec::new())
    }

    fn apply_end(&mut self) -> Result<Vec<Effect>, EngineError> {
        let effect = match self.status {
            Status::Running | Status::Paused => Some(Effect::SessionEnded {
                phase_id: self.current_phase_id(),
                phase: self.phase,
                duration_ms: self.duration_ms,
                label: self.label.clone(),
                interrupted: self.interrupted,
            }),
            Status::Completed => None,
            _ => return Err(EngineError::invalid_state("end requires an active session")),
        };
        self.clear_to_idle_default();
        Ok(effect.into_iter().collect())
    }

    fn apply_accept_recovery(&mut self, elapsed_ms: u64) -> Result<Vec<Effect>, EngineError> {
        if self.status != Status::RecoveryPending {
            return Err(EngineError::invalid_state(
                "accept_recovery requires a pending recovery",
            ));
        }
        self.status = Status::Running;
        self.anchor_ms = elapsed_ms;
        self.remaining_at_anchor_ms = self.remaining_ms;
        self.session_started = true;
        Ok(Vec::new())
    }

    fn apply_discard_recovery(&mut self) -> Result<Vec<Effect>, EngineError> {
        if self.status != Status::RecoveryPending {
            return Err(EngineError::invalid_state(
                "discard_recovery requires a pending recovery",
            ));
        }
        self.clear_to_idle_default();
        self.session_id = None;
        Ok(Vec::new())
    }

    /// Samples the expiry of a running phase and completes it exactly once.
    fn sample_expiry(&mut self, elapsed_ms: u64) -> Vec<Effect> {
        if self.status != Status::Running {
            return Vec::new();
        }
        let remaining = self.compute_remaining(elapsed_ms);
        self.remaining_ms = remaining;
        if remaining == 0 {
            self.complete_phase()
        } else {
            Vec::new()
        }
    }

    /// Completes the current phase and returns its completion effect.
    fn complete_phase(&mut self) -> Vec<Effect> {
        self.status = Status::Completed;
        self.remaining_ms = 0;
        self.remaining_at_anchor_ms = 0;
        self.anchor_ms = 0;
        if self.phase == Phase::Focus {
            self.completed_focus_count = self.completed_focus_count.saturating_add(1);
        }
        vec![Effect::PhaseCompleted {
            phase_id: self.current_phase_id(),
            phase: self.phase,
            duration_ms: self.duration_ms,
            label: self.label.clone(),
            interrupted: self.interrupted,
        }]
    }

    /// Selects the phase that follows `previous` and prepares it in the idle state.
    fn select_next_phase(&mut self, previous: Phase) {
        let next = match self.config.mode {
            Mode::Cycle => match previous {
                Phase::Focus => self.break_phase_for_count(self.completed_focus_count),
                Phase::ShortBreak | Phase::LongBreak => Phase::Focus,
            },
            Mode::Countdown => Phase::Focus,
        };
        self.phase = next;
        self.duration_ms = self.duration_for_phase(next);
        self.remaining_ms = self.duration_ms;
        self.remaining_at_anchor_ms = self.duration_ms;
        self.phase_id = Some(new_id());
        self.status = Status::Idle;
        self.interrupted = false;
        self.anchor_ms = 0;
    }

    /// Clears the engine to the idle default of a fresh focus phase.
    fn clear_to_idle_default(&mut self) {
        self.phase = Phase::Focus;
        self.duration_ms = self.config.focus_ms;
        self.remaining_ms = self.duration_ms;
        self.remaining_at_anchor_ms = self.duration_ms;
        self.phase_id = Some(new_id());
        self.status = Status::Idle;
        self.session_started = false;
        self.completed_focus_count = 0;
        self.interrupted = false;
        self.anchor_ms = 0;
    }

    /// Returns the break phase that follows `count` completed focus phases.
    fn break_phase_for_count(&self, count: u32) -> Phase {
        // The interval is validated to be at least one, so the divisibility
        // test is the same as the former remainder comparison.
        let interval = self.config.long_break_interval.max(1);
        if count > 0 && count.is_multiple_of(interval) {
            Phase::LongBreak
        } else {
            Phase::ShortBreak
        }
    }

    /// Returns the configured duration of a phase kind.
    fn duration_for_phase(&self, phase: Phase) -> u64 {
        match phase {
            Phase::Focus => self.config.focus_ms,
            Phase::ShortBreak => self.config.short_break_ms,
            Phase::LongBreak => self.config.long_break_ms,
        }
    }

    /// Computes the remaining time from the clock anchor without drifting.
    ///
    /// The remaining time at the anchor is the base of the computation, so a phase that was
    /// paused and resumed keeps its frozen remainder. An out-of-order sample can never increase
    /// the remaining time.
    fn compute_remaining(&self, elapsed_ms: u64) -> u64 {
        let elapsed = elapsed_ms.saturating_sub(self.anchor_ms);
        let computed = self.remaining_at_anchor_ms.saturating_sub(elapsed);
        computed.min(self.remaining_ms)
    }

    /// Returns the identifier of the current phase.
    fn current_phase_id(&self) -> String {
        self.phase_id.clone().unwrap_or_default()
    }

    /// Bumps the revision when the observable state changed.
    fn bump_revision_if_changed(&mut self, before: &Snapshot) {
        if self.snapshot() != *before {
            self.revision = before.revision.saturating_add(1);
        }
    }
}

/// Creates a new random identifier.
fn new_id() -> String {
    Uuid::new_v4().to_string()
}

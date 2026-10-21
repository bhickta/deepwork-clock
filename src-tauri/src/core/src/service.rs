//! The timer service.
//!
//! One instance owns the pure engine and the current settings. Every command
//! and every deadline check passes through this owner, so the state machine
//! has exactly one writer. The service itself performs no I/O and calls no
//! operating system API: the caller supplies the elapsed sample and the wall
//! clock reading, which keeps the whole timer path deterministic in tests.

use chrono::{DateTime, Utc};
use deepwork_engine::{Action, Config, Effect, Engine, Mode, Snapshot, Status, Transition};

use crate::error::BridgeError;
use crate::settings::Settings;

/// Interval at which a running timer is sampled by the deadline thread.
pub const TICK_INTERVAL_MS: u64 = 1_000;

/// Extra slack on top of two tick intervals before a completion is treated as
/// having happened across a gap (suspend, stall or a missed deadline check).
pub const TICK_GAP_TOLERANCE_MS: u64 = 1_000;

/// Largest sampling gap that still counts as continuous awake time.
///
/// A completion that happened after a longer gap is never advanced
/// automatically: the machine may have been asleep, so the phase waits for an
/// explicit user action.
pub const AUTO_ADVANCE_GAP_LIMIT_MS: u64 = TICK_INTERVAL_MS * 2 + TICK_GAP_TOLERANCE_MS;

/// Owns the engine and the settings document.
#[derive(Debug)]
pub struct TimerService {
    engine: Engine,
    settings: Settings,
    /// Engine revision produced by the most recent *command*. Background
    /// deadline checks also advance the engine revision, but they must not
    /// invalidate a command that the client issued against the last state it
    /// actually saw.
    command_revision: u64,
    /// Phase the current start time belongs to.
    tracked_phase_id: Option<String>,
    /// Wall clock moment at which the current phase started.
    phase_started_at: Option<DateTime<Utc>>,
    /// Set when a suspend, resume or other long gap was observed. The next
    /// finished phase is then recorded as interrupted.
    interruption_pending: bool,
    /// Elapsed sample of the previous command or deadline check. It is used to
    /// recognise a sampling gap, so that an automatic phase change never
    /// happens across a suspend or a stalled process.
    last_sample_elapsed: Option<u64>,
}

impl TimerService {
    pub fn new(settings: Settings) -> Self {
        let engine = Engine::new();
        let command_revision = engine.snapshot().revision;
        Self {
            engine,
            settings,
            command_revision,
            tracked_phase_id: None,
            phase_started_at: None,
            interruption_pending: false,
            last_sample_elapsed: None,
        }
    }

    /// The current snapshot, cloned for publication.
    pub fn snapshot(&self) -> Snapshot {
        self.engine.snapshot()
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn config(&self) -> Config {
        self.engine.config()
    }

    /// The revision of the most recent command driven transition.
    pub fn command_revision(&self) -> u64 {
        self.command_revision
    }

    /// Wall clock moment at which the current phase started.
    pub fn phase_started_at(&self) -> Option<DateTime<Utc>> {
        self.phase_started_at
    }

    /// Whether an interruption is waiting to be attached to the next finished
    /// phase.
    pub fn interruption_pending(&self) -> bool {
        self.interruption_pending
    }

    /// Records that an interruption was observed.
    ///
    /// The engine flags the active phase, so the published snapshot shows the
    /// interruption as well. The return value tells whether the phase was
    /// actually flagged.
    pub fn mark_interrupted(&mut self) -> bool {
        let transition = self.engine.mark_interrupted();
        let flagged = transition.snapshot.interrupted;
        if flagged {
            self.interruption_pending = true;
        }
        flagged
    }

    /// Forgets a recorded interruption. It is called once the interruption was
    /// attached to a finished phase.
    pub fn clear_interruption(&mut self) {
        self.interruption_pending = false;
    }

    /// Applies a command.
    ///
    /// `expected_revision` is the revision the client believes to be current.
    /// When it is `None` the command is trusted (the tray menu and the tick
    /// thread are internal callers). A client that is older than the last
    /// command driven transition is rejected with `STALE_REVISION`; a client
    /// that merely missed background deadline checks is not, because those
    /// only change the remaining time.
    pub fn apply(
        &mut self,
        action: Action,
        elapsed_ms: u64,
        now: DateTime<Utc>,
        expected_revision: Option<u64>,
    ) -> Result<Transition, BridgeError> {
        if let Some(expected) = expected_revision {
            let current = self.engine.snapshot();
            if expected > current.revision || expected < self.command_revision {
                return Err(BridgeError::stale(
                    "The timer moved on before this action arrived. The latest state was returned.",
                    current,
                ));
            }
        }

        let transition = self
            .engine
            .apply(action, elapsed_ms)
            .map_err(BridgeError::from)?;
        self.command_revision = transition.snapshot.revision;
        self.last_sample_elapsed = Some(elapsed_ms);
        self.track_phase(&transition.snapshot, now);
        Ok(transition)
    }

    /// Applies a deadline check.
    ///
    /// A deadline check that only moves the remaining time is *tolerated*: a
    /// client that did not see the intermediate snapshots may still send its
    /// command, because nothing about the state machine changed.
    ///
    /// A completion is different. It is a semantic boundary: the phase is
    /// over and it was recorded. A client that still holds the revision from
    /// before the completion is therefore stale, so that a destructive command
    /// cannot be applied to a phase that has already ended.
    ///
    /// When `settings.auto_advance` is on and the completion happened during
    /// continuous awake time, the next cycle phase is selected in the same
    /// call. The completion effect is kept, so a completion is still recorded
    /// and announced exactly once. After a long sampling gap the phase stays
    /// completed and waits for an explicit action.
    pub fn tick(&mut self, elapsed_ms: u64, now: DateTime<Utc>) -> Transition {
        let previous_sample = self.last_sample_elapsed.replace(elapsed_ms);
        let mut transition = self.engine.tick(elapsed_ms);
        let completed = transition
            .effects
            .iter()
            .any(|effect| matches!(effect, Effect::PhaseCompleted { .. }));
        if !transition.effects.is_empty() {
            self.command_revision = transition.snapshot.revision;
        }
        if completed && self.auto_advance_allowed(&transition.snapshot, previous_sample, elapsed_ms)
        {
            // `Advance` can only fail in countdown mode, which is filtered out
            // by `auto_advance_allowed`. If it fails anyway the completed
            // phase simply stays visible, exactly like a manual advance that
            // was not accepted.
            if let Ok(mut advanced) = self.engine.apply(Action::Advance, elapsed_ms) {
                let mut effects = std::mem::take(&mut transition.effects);
                effects.append(&mut advanced.effects);
                transition = Transition {
                    snapshot: advanced.snapshot,
                    effects,
                };
                self.command_revision = transition.snapshot.revision;
            }
        }
        self.track_phase(&transition.snapshot, now);
        transition
    }

    /// Whether a completion that was just observed may move to the next phase
    /// on its own.
    ///
    /// Auto-advance is opt-in and only valid for a cycle. It is refused when
    /// the completion may have happened across a suspend or a stalled
    /// process, because the next phase must never start itself after the
    /// machine was asleep.
    fn auto_advance_allowed(
        &self,
        snapshot: &Snapshot,
        previous_sample: Option<u64>,
        elapsed_ms: u64,
    ) -> bool {
        if !self.settings.auto_advance || snapshot.mode != Mode::Cycle {
            return false;
        }
        match previous_sample {
            Some(previous) => elapsed_ms.saturating_sub(previous) <= AUTO_ADVANCE_GAP_LIMIT_MS,
            // No previous sample: the elapsed history is unknown, so the
            // conservative choice is to wait for an explicit action.
            None => false,
        }
    }

    /// Restores a checkpoint. The engine turns an active record into
    /// `recovery_pending`; it never resumes on its own.
    pub fn restore(&mut self, snapshot: Snapshot, config: Config) -> Result<(), BridgeError> {
        let engine = Engine::restore(snapshot, config).map_err(BridgeError::from)?;
        self.engine = engine;
        self.command_revision = self.engine.snapshot().revision;
        self.tracked_phase_id = None;
        self.phase_started_at = None;
        self.interruption_pending = false;
        // The sample history of this process says nothing about the time
        // between the checkpoint and the restart.
        self.last_sample_elapsed = None;
        Ok(())
    }

    /// Validates a settings document and prepares it for storing.
    ///
    /// The revision is assigned by the backend. The document is *staged*: the
    /// in-memory settings are not touched, so the caller can write the
    /// document to disk first and only commit it when the write succeeded.
    pub fn stage_settings(
        &self,
        mut settings: Settings,
        expected_revision: u64,
    ) -> Result<Settings, BridgeError> {
        if expected_revision != self.settings.revision {
            return Err(BridgeError::stale(
                "The settings changed before this save arrived. The latest settings were returned.",
                self.engine.snapshot(),
            ));
        }
        settings.validate()?;
        settings.revision = self.settings.next_revision();
        Ok(settings)
    }

    /// Takes a staged settings document into use.
    pub fn commit_settings(&mut self, settings: Settings) {
        self.settings = settings;
    }

    /// Keeps track of the phase the current start time belongs to.
    fn track_phase(&mut self, snapshot: &Snapshot, now: DateTime<Utc>) {
        if !matches!(snapshot.status, Status::Running | Status::Paused) {
            // The phase is idle, completed or awaiting a recovery decision.
            // The start time of the phase that just ended is kept until the
            // next phase starts so that the history record stays accurate.
            return;
        }
        let phase_id = snapshot.phase_id.clone();
        let phase_changed = self.tracked_phase_id.as_deref() != phase_id.as_deref();
        if phase_changed || self.phase_started_at.is_none() {
            self.tracked_phase_id = phase_id;
            self.phase_started_at = Some(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepwork_engine::{Action, Config, Phase};

    fn service() -> TimerService {
        TimerService::new(Settings::default())
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T10:00:00Z")
            .expect("parse")
            .with_timezone(&Utc)
    }

    fn cycle_config() -> Config {
        Config {
            mode: Mode::Cycle,
            focus_ms: 1_000,
            short_break_ms: 1_000,
            long_break_ms: 1_000,
            long_break_interval: 4,
            label: String::new(),
        }
    }

    /// Configures and starts a short cycle phase.
    fn started_cycle(service: &mut TimerService) {
        let revision = service.snapshot().revision;
        service
            .apply(
                Action::Configure {
                    config: cycle_config(),
                },
                0,
                now(),
                Some(revision),
            )
            .expect("configure");
        let revision = service.snapshot().revision;
        service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");
    }

    #[test]
    fn start_moves_the_timer_into_running() {
        let mut service = service();
        let revision = service.snapshot().revision;
        let transition = service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");
        assert_eq!(transition.snapshot.status, Status::Running);
    }

    #[test]
    fn a_stale_revision_is_rejected_with_the_latest_snapshot() {
        let mut service = service();
        let revision = service.snapshot().revision;
        service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");
        let error = service
            .apply(Action::Reset, 10, now(), Some(revision))
            .expect_err("stale");
        assert_eq!(error.code, crate::error::CODE_STALE_REVISION);
        assert!(error.snapshot.is_some());
    }

    #[test]
    fn a_client_that_only_missed_deadline_checks_is_not_stale() {
        let mut service = service();
        let revision = service.snapshot().revision;
        service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");
        let seen = service.snapshot().revision;
        service.tick(1_000, now());
        let transition = service
            .apply(Action::Pause, 1_000, now(), Some(seen))
            .expect("not stale");
        assert_eq!(transition.snapshot.status, Status::Paused);
    }

    #[test]
    fn a_completion_makes_the_revision_from_before_it_stale() {
        let mut service = service();
        let revision = service.snapshot().revision;
        service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");
        // The revision the client still holds while the phase runs.
        let seen = service.snapshot().revision;
        // The phase reaches its deadline.
        let deadline = Config::default().focus_ms + 1;
        let transition = service.tick(deadline, now());
        assert!(
            !transition.effects.is_empty(),
            "the phase completed: {:?}",
            transition.effects
        );

        // A destructive command with the old revision must not be applied to
        // a phase that has already ended.
        let error = service
            .apply(Action::Reset, deadline, now(), Some(seen))
            .expect_err("stale");
        assert_eq!(error.code, crate::error::CODE_STALE_REVISION);
        assert!(error.snapshot.is_some());
    }

    #[test]
    fn a_tick_without_a_completion_keeps_the_revision_usable() {
        let mut service = service();
        let revision = service.snapshot().revision;
        service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");
        let seen = service.snapshot().revision;
        // The phase is far from its deadline, so nothing but the remaining
        // time changes.
        let transition = service.tick(1_000, now());
        assert!(transition.effects.is_empty(), "{:?}", transition.effects);

        let transition = service
            .apply(Action::Pause, 1_000, now(), Some(seen))
            .expect("not stale");
        assert_eq!(transition.snapshot.status, Status::Paused);
    }

    #[test]
    fn trusted_callers_may_act_without_a_revision() {
        let mut service = service();
        let transition = service.apply(Action::Start, 0, now(), None).expect("start");
        assert_eq!(transition.snapshot.status, Status::Running);
    }

    #[test]
    fn the_phase_start_time_is_recorded_once() {
        let mut service = service();
        let revision = service.snapshot().revision;
        service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");
        let started = service.phase_started_at().expect("start time");
        service.tick(500, now());
        assert_eq!(service.phase_started_at(), Some(started));
    }

    #[test]
    fn settings_use_the_backend_revision() {
        let mut service = service();
        let settings = Settings::default();
        let staged = service.stage_settings(settings, 0).expect("stage");
        assert_eq!(staged.revision, 1);
        service.commit_settings(staged);
        let error = service
            .stage_settings(Settings::default(), 0)
            .expect_err("stale");
        assert_eq!(error.code, crate::error::CODE_STALE_REVISION);
    }

    #[test]
    fn staging_settings_does_not_change_the_stored_document() {
        let mut service = service();
        let settings = Settings {
            theme: crate::settings::Theme::Dark,
            ..Settings::default()
        };
        let staged = service.stage_settings(settings, 0).expect("stage");
        assert_eq!(staged.revision, 1);
        // The document is not in use until it was stored successfully.
        assert_eq!(service.settings().revision, 0);
        assert_eq!(service.settings().theme, crate::settings::Theme::System);
        service.commit_settings(staged);
        assert_eq!(service.settings().revision, 1);
        assert_eq!(service.settings().theme, crate::settings::Theme::Dark);
    }

    #[test]
    fn invalid_settings_are_rejected() {
        let service = service();
        let settings = Settings {
            text_scale: 9.0,
            ..Settings::default()
        };
        let error = service.stage_settings(settings, 0).expect_err("invalid");
        assert_eq!(error.code, crate::error::CODE_INVALID_STATE);
        assert_eq!(service.settings().revision, 0);
    }

    #[test]
    fn an_interruption_is_remembered() {
        let mut service = service();
        assert!(!service.interruption_pending());
        service.mark_interrupted();
        assert!(service.interruption_pending());
    }

    #[test]
    fn auto_advance_completes_the_phase_and_selects_the_next_one() {
        let mut service = service();
        service.settings.auto_advance = true;
        started_cycle(&mut service);

        let transition = service.tick(1_000, now());
        assert_eq!(transition.effects.len(), 1, "{:?}", transition.effects);
        assert!(matches!(
            transition.effects[0],
            Effect::PhaseCompleted {
                phase: Phase::Focus,
                ..
            }
        ));
        // One completion selected the next phase, which waits idle.
        assert_eq!(transition.snapshot.phase, Phase::ShortBreak);
        assert_eq!(transition.snapshot.status, Status::Idle);
        assert_eq!(transition.snapshot.completed_focus_count, 1);

        // A later deadline check cannot advance a second time.
        let later = service.tick(1_100, now());
        assert!(later.effects.is_empty(), "{:?}", later.effects);
        assert_eq!(later.snapshot.phase, Phase::ShortBreak);
        assert_eq!(later.snapshot.status, Status::Idle);
    }

    #[test]
    fn a_completed_phase_stays_completed_without_auto_advance() {
        let mut service = service();
        assert!(!service.settings.auto_advance, "off by default");
        started_cycle(&mut service);

        let transition = service.tick(1_000, now());
        assert_eq!(transition.effects.len(), 1, "{:?}", transition.effects);
        assert_eq!(transition.snapshot.phase, Phase::Focus);
        assert_eq!(transition.snapshot.status, Status::Completed);
        assert_eq!(transition.snapshot.completed_focus_count, 1);
    }

    #[test]
    fn auto_advance_does_not_cross_a_large_gap() {
        let mut service = service();
        service.settings.auto_advance = true;
        started_cycle(&mut service);

        // More than two tick intervals plus the tolerance passed between the
        // start of the phase and this check: the machine may have been
        // asleep, so the phase has to wait for an explicit action.
        let transition = service.tick(AUTO_ADVANCE_GAP_LIMIT_MS + 1, now());
        assert_eq!(transition.effects.len(), 1, "{:?}", transition.effects);
        assert_eq!(transition.snapshot.phase, Phase::Focus);
        assert_eq!(transition.snapshot.status, Status::Completed);
    }

    #[test]
    fn auto_advance_never_changes_a_countdown() {
        let mut service = service();
        service.settings.auto_advance = true;
        let revision = service.snapshot().revision;
        service
            .apply(
                Action::Configure {
                    config: Config {
                        mode: Mode::Countdown,
                        ..cycle_config()
                    },
                },
                0,
                now(),
                Some(revision),
            )
            .expect("configure");
        let revision = service.snapshot().revision;
        service
            .apply(Action::Start, 0, now(), Some(revision))
            .expect("start");

        let transition = service.tick(1_000, now());
        assert_eq!(transition.snapshot.phase, Phase::Focus);
        assert_eq!(transition.snapshot.status, Status::Completed);
    }
}

//! The application service.
//!
//! One owner serialises every command, every deadline check and every side
//! effect. The rules that matter for the rest of the code are:
//!
//! * the state lock is never held while a file is written, while an event is
//!   emitted or while the operating system is called,
//! * a *operation gate* serialises the whole sequence "transition, then
//!   persist, then notify". Two transitions can therefore never interleave
//!   their side effects, while a plain snapshot read never waits for a disk
//!   write,
//! * the deadline check keeps running while the window is hidden, so a phase
//!   completes even when nobody is looking,
//! * a periodic snapshot is published at most once per second and only while
//!   the window is visible,
//! * a storage failure never stops the timer. It is reported as a warning
//!   that stays visible and the previous good data stays in place.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, Utc};
use deepwork_core::history::{HistoryOutcome, HistoryPhase, HistoryRecord};
use deepwork_core::recovery::RecoveryRecord;
use deepwork_core::{BridgeError, HistoryBook, Settings, TimerService};
use deepwork_engine::{Action, Effect, Mode, Phase, Snapshot, Status};

use crate::platform;
use crate::platform::capabilities::{Capability, CapabilityState};
use crate::platform::host::PlatformHost;
use crate::storage::Store;

/// Interval between two periodic snapshots.
pub const PUBLISH_INTERVAL_MS: u64 = 1_000;

/// Interval between two durable checkpoints while a phase runs.
pub const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(30);

/// A gap larger than this between two samples is treated as an interruption:
/// the machine was probably asleep or the process was stalled.
pub const LONG_GAP_THRESHOLD_MS: u64 = 60_000;

/// Name of the event that carries a snapshot.
pub const SNAPSHOT_EVENT: &str = "timer:snapshot";

/// Name of the event that carries a warning.
pub const ERROR_EVENT: &str = "timer:error";

/// The mutable state of the service.
struct Inner {
    timer: TimerService,
    history: HistoryBook,
    /// The last elapsed sample that was handed to the engine. The deadline of
    /// the running phase is computed from it.
    last_sample_elapsed: u64,
    /// The most recent durable checkpoint, used to report its age.
    recovery: Option<RecoveryRecord>,
}

/// What the frontend needs to know about a recovered session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    /// RFC 3339 UTC timestamp of the checkpoint.
    pub saved_at: String,
    /// How long ago the checkpoint was written.
    pub age_ms: u64,
    /// The phase the checkpoint belongs to.
    pub phase_id: Option<String>,
    /// The remaining time of that phase.
    pub remaining_ms: u64,
}

/// Redacted diagnostics that the user can preview before sharing them.
///
/// The document deliberately contains no session or phase identifiers, no
/// label, no settings text, no absolute paths and no environment variables. It
/// is safe to show in the About view and to copy into a bug report.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    /// The version of this build.
    pub app_version: &'static str,
    /// The operating system family, for example `linux`.
    pub os: &'static str,
    /// The processor architecture, for example `x86_64`.
    pub architecture: &'static str,
    /// Revision of the settings document; never its content.
    pub settings_revision: u64,
    /// The settings that are switches, without any text value.
    pub features: DiagnosticFeatures,
    /// The timer state, without identifiers or a label.
    pub timer: DiagnosticTimer,
    /// Capability names with their state and reason.
    pub capabilities: BTreeMap<String, Capability>,
    /// Codes of the warnings that are still relevant, never their messages.
    pub warning_codes: Vec<String>,
    /// Number of retained history records.
    pub history_records: usize,
}

/// The boolean settings, exposed as feature flags.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticFeatures {
    pub notifications: bool,
    pub sound: bool,
    pub global_shortcut_enabled: bool,
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub history_enabled: bool,
    pub auto_advance: bool,
}

/// The observable timer state that is safe to share.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticTimer {
    pub mode: Mode,
    pub phase: Phase,
    pub status: Status,
}

/// The application service.
pub struct AppService {
    /// The desktop the service talks to.
    host: Arc<dyn PlatformHost>,
    store: Store,
    inner: Mutex<Inner>,
    /// Serialises "transition, persist, notify" sequences.
    ///
    /// The gate is separate from the state lock: a snapshot read never waits
    /// for a disk write, but two transitions can never interleave their side
    /// effects.
    operation_gate: Mutex<()>,
    /// Warnings that are still relevant. They survive until the problem is
    /// gone, so a frontend that starts late still learns about them.
    warnings: Mutex<Vec<BridgeError>>,
    /// Wakes the deadline thread when the state changed.
    wake: Mutex<Option<Sender<()>>>,
    shutdown: AtomicBool,
    /// Whether the system tray could be created.
    tray_available: AtomicBool,
    /// Whether a global shortcut is currently registered.
    shortcut_registered: AtomicBool,
    /// Time of the last published snapshot.
    last_publish: Mutex<Instant>,
    /// Status that the tray menu currently shows.
    last_tray_status: Mutex<Option<Status>>,
}

impl AppService {
    /// Creates the service and restores the durable state.
    ///
    /// A damaged document is quarantined and the application continues with
    /// safe defaults. A document from a newer schema version is refused; the
    /// application starts with defaults and never overwrites that file.
    pub fn new(host: Arc<dyn PlatformHost>, store: Store) -> Result<Arc<Self>, BridgeError> {
        let mut warnings: Vec<BridgeError> = Vec::new();

        let settings = match store.load_settings() {
            Ok(outcome) => {
                warnings.extend(outcome.warning);
                outcome.value
            }
            Err(error) => {
                warnings.push(error);
                Settings::default()
            }
        };

        let history = match store.load_history() {
            Ok(outcome) => {
                warnings.extend(outcome.warning);
                outcome.value
            }
            Err(error) => {
                warnings.push(error);
                HistoryBook::default()
            }
        };

        let recovery = match store.load_recovery() {
            Ok(outcome) => {
                warnings.extend(outcome.warning);
                outcome.value
            }
            Err(error) => {
                warnings.push(error);
                None
            }
        };

        let mut timer = TimerService::new(settings);
        let mut restored = false;
        if let Some(record) = recovery.as_ref() {
            if let Err(error) = timer.restore(record.snapshot.clone(), record.config.clone()) {
                warnings.push(error);
                let _ = store.clear_recovery();
            } else {
                restored = true;
            }
        }
        // A checkpoint that could not be restored is not offered.
        let recovery = if restored { recovery } else { None };

        let service = Arc::new(Self {
            host,
            store,
            inner: Mutex::new(Inner {
                timer,
                history,
                last_sample_elapsed: platform::clock::elapsed_ms(),
                recovery,
            }),
            operation_gate: Mutex::new(()),
            warnings: Mutex::new(Vec::new()),
            wake: Mutex::new(None),
            shutdown: AtomicBool::new(false),
            tray_available: AtomicBool::new(false),
            shortcut_registered: AtomicBool::new(false),
            last_publish: Mutex::new(Instant::now()),
            last_tray_status: Mutex::new(None),
        });

        for warning in warnings {
            service.report_warning(warning);
        }
        Ok(service)
    }

    /// The current snapshot.
    pub fn snapshot(&self) -> Snapshot {
        self.inner
            .lock()
            .map(|inner| inner.timer.snapshot())
            .unwrap_or_else(|_| deepwork_engine::Engine::new().snapshot())
    }

    /// The current settings.
    pub fn settings(&self) -> Settings {
        self.inner
            .lock()
            .map(|inner| inner.timer.settings().clone())
            .unwrap_or_default()
    }

    /// Publishes the current snapshot immediately.
    pub fn publish_now(&self) {
        let snapshot = self.snapshot();
        self.publish(&snapshot, true);
    }

    /// Applies a command and publishes the result.
    ///
    /// The whole sequence - transition, durable write, notification - runs
    /// under the operation gate, so it can never interleave with the deadline
    /// thread or with another command.
    pub fn apply_command(
        &self,
        action: Action,
        elapsed_ms: u64,
        now: DateTime<Utc>,
        expected_revision: Option<u64>,
    ) -> Result<Snapshot, BridgeError> {
        let _gate = self.lock_operation_gate()?;
        let (transition, started_at, before) = {
            let mut inner = self.lock_inner()?;
            let started_at = inner.timer.phase_started_at();
            let before = inner.timer.snapshot();
            let transition = inner
                .timer
                .apply(action, elapsed_ms, now, expected_revision)?;
            inner.last_sample_elapsed = elapsed_ms;
            (transition, started_at, before)
        };

        self.apply_effects(&transition.effects, &before, started_at, now);
        self.persist_state(&transition.snapshot, started_at, now);
        self.notify_completion(&transition.effects);
        self.publish(&transition.snapshot, true);
        self.notify_wake();
        Ok(transition.snapshot)
    }

    /// Performs a deadline check.
    ///
    /// Returns the new snapshot when the observable state changed, so that the
    /// caller can publish it. A plain deadline check never writes a file; only
    /// a real transition does.
    pub fn tick(&self, elapsed_ms: u64, now: DateTime<Utc>, gap_ms: u64) -> Option<Snapshot> {
        let _gate = self.lock_operation_gate().ok()?;
        let (transition, started_at, before, changed, interruption) = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return None,
            };
            let mut interruption = None;
            if gap_ms > LONG_GAP_THRESHOLD_MS {
                // The machine was probably asleep or the process was stalled.
                // The phase is marked as interrupted and needs an explicit
                // confirmation from the user.
                let clock_kind = platform::clock::kind();
                if inner.timer.mark_interrupted() {
                    let source = if clock_kind.includes_suspend() {
                        "the clock includes the time the machine was asleep, so the phase continued"
                    } else {
                        "the clock only counts the time the machine was awake"
                    };
                    interruption = Some(BridgeError::internal(format!(
                        "A long interruption of {gap_ms} ms was detected (clock: {}, {source}). The phase was marked as interrupted.",
                        clock_kind.as_str()
                    )));
                }
            }
            let started_at = inner.timer.phase_started_at();
            let before = inner.timer.snapshot();
            let transition = inner.timer.tick(elapsed_ms, now);
            inner.last_sample_elapsed = elapsed_ms;
            let changed = transition.snapshot.revision != before.revision;
            (transition, started_at, before, changed, interruption)
        };

        if let Some(warning) = interruption {
            self.report_warning(warning);
        }
        if !transition.effects.is_empty() {
            // A real transition: the durable state has to follow immediately.
            self.apply_effects(&transition.effects, &before, started_at, now);
            self.persist_state(&transition.snapshot, started_at, now);
            self.notify_completion(&transition.effects);
        }
        if changed {
            Some(transition.snapshot)
        } else {
            None
        }
    }

    /// Stores the settings and applies the parts that have an operating system
    /// side effect.
    pub fn save_settings(
        &self,
        settings: Settings,
        expected_revision: u64,
    ) -> Result<Settings, BridgeError> {
        if settings.global_shortcut_enabled {
            // A binding that would swallow ordinary typing is refused before
            // it is stored, not only when it is registered.
            platform::shortcut::validate_accelerator(&settings.global_shortcut)?;
        }
        let _gate = self.lock_operation_gate()?;
        let previous = self.settings();

        // Stage first: the document is validated and gets its revision, but
        // the running application does not use it yet.
        let staged = {
            let inner = self.lock_inner()?;
            inner.timer.stage_settings(settings, expected_revision)?
        };

        // Store second. The settings are only in use when they are durable,
        // so a failed write leaves the running application unchanged.
        self.store.save_settings(&staged)?;

        {
            let mut inner = self.lock_inner()?;
            inner.timer.commit_settings(staged.clone());
        }
        self.apply_platform_settings(&previous, &staged);
        Ok(staged)
    }

    /// Applies the settings that have an operating system side effect.
    ///
    /// A failing global shortcut never replaces a working one: the previous
    /// binding is restored and the failure is reported as a warning.
    fn apply_platform_settings(&self, previous: &Settings, current: &Settings) {
        if previous.global_shortcut_enabled != current.global_shortcut_enabled
            || previous.global_shortcut != current.global_shortcut
        {
            self.host.unregister_shortcuts();
            self.set_shortcut_registered(false);
            if current.global_shortcut_enabled {
                match self.host.register_shortcut(&current.global_shortcut) {
                    Ok(()) => self.set_shortcut_registered(true),
                    Err(error) => {
                        self.report_warning(error);
                        if previous.global_shortcut_enabled {
                            match self.host.register_shortcut(&previous.global_shortcut) {
                                Ok(()) => self.set_shortcut_registered(true),
                                Err(error) => self.report_warning(error),
                            }
                        }
                    }
                }
            }
        }

        if previous.launch_at_login != current.launch_at_login {
            if let Err(error) = self.host.set_autostart(current.launch_at_login) {
                self.report_warning(BridgeError::internal(format!(
                    "The start at login setting could not be changed. {error}"
                )));
            }
        }
    }

    /// The recorded history, newest first.
    pub fn list_history(&self, limit: u32, before: Option<&str>) -> Vec<HistoryRecord> {
        self.inner
            .lock()
            .map(|inner| inner.history.list(limit, before))
            .unwrap_or_default()
    }

    /// Every recorded history entry, used by the export.
    pub fn all_history(&self) -> Vec<HistoryRecord> {
        self.inner
            .lock()
            .map(|inner| inner.history.list(u32::MAX, None))
            .unwrap_or_default()
    }

    /// Removes every history entry.
    pub fn delete_history(&self, confirmation: &str) -> Result<(), BridgeError> {
        if confirmation != DELETE_CONFIRMATION {
            return Err(BridgeError::invalid_state(
                "Deleting the history needs an explicit confirmation.",
            ));
        }
        let _gate = self.lock_operation_gate()?;
        {
            let mut inner = self.lock_inner()?;
            inner.history.clear();
        }
        self.store.save_history(&self.history_book())?;
        Ok(())
    }

    /// Accepts an interrupted phase.
    pub fn confirm_history(&self, phase_id: &str) -> Result<(), BridgeError> {
        let _gate = self.lock_operation_gate()?;
        {
            let mut inner = self.lock_inner()?;
            if !inner.history.confirm(phase_id) {
                return Err(BridgeError::invalid_state(
                    "This session is not in the history.",
                ));
            }
        }
        self.store.save_history(&self.history_book())?;
        Ok(())
    }

    /// The capabilities of the current machine.
    pub fn capabilities(&self) -> BTreeMap<String, Capability> {
        let mut capabilities = BTreeMap::new();

        let (pin_support, pin_reason) = self.host.pin_support();
        capabilities.insert(
            "pin".to_string(),
            Capability::new(
                match pin_support {
                    platform::window::PinSupport::Available => CapabilityState::Available,
                    platform::window::PinSupport::Unavailable => CapabilityState::Unavailable,
                    platform::window::PinSupport::Unknown => CapabilityState::Unknown,
                },
                pin_reason,
            ),
        );

        capabilities.insert(
            "tray".to_string(),
            if self.tray_available.load(Ordering::Relaxed) {
                Capability::new(
                    CapabilityState::Available,
                    "The system tray icon is available.",
                )
            } else {
                Capability::new(
                    CapabilityState::Unknown,
                    "This desktop did not confirm a system tray icon. The window stays usable.",
                )
            },
        );

        let shortcut = self.host.shortcut_support();
        capabilities.insert(
            "globalShortcut".to_string(),
            if self.shortcut_registered.load(Ordering::Relaxed) {
                Capability::new(
                    shortcut.state,
                    format!("{} The shortcut is currently registered.", shortcut.reason),
                )
            } else {
                shortcut
            },
        );

        capabilities.insert(
            "notifications".to_string(),
            self.host.notification_support(),
        );

        let launch_at_login = self.settings().launch_at_login;
        capabilities.insert(
            "autostart".to_string(),
            Capability::new(
                CapabilityState::Available,
                if launch_at_login {
                    "The application is registered to start when you log in."
                } else {
                    "The application can be registered to start when you log in. It is currently switched off."
                },
            ),
        );

        capabilities.insert(
            "sound".to_string(),
            Capability::new(
                CapabilityState::Available,
                "A short completion sound plays in the application when a phase completes. It is off until you enable it.",
            ),
        );

        capabilities
    }

    /// Marks the tray as available or unavailable.
    pub fn set_tray_available(&self, available: bool) {
        self.tray_available.store(available, Ordering::Relaxed);
    }

    /// Marks the global shortcut as registered or not.
    pub fn set_shortcut_registered(&self, registered: bool) {
        self.shortcut_registered
            .store(registered, Ordering::Relaxed);
    }

    /// Whether the tray can be trusted to restore a hidden window.
    pub fn tray_is_reliable(&self) -> bool {
        self.tray_available.load(Ordering::Relaxed)
    }

    /// Reports a warning to the frontend without interrupting the timer.
    ///
    /// The warning is kept until the problem is gone, so a frontend that
    /// starts after the warning was raised still learns about it through
    /// [`AppService::warnings`]. The same warning is not stored twice.
    pub fn report_warning(&self, error: BridgeError) {
        if let Ok(mut warnings) = self.warnings.lock() {
            let known = warnings
                .iter()
                .any(|warning| warning.code == error.code && warning.message == error.message);
            if !known {
                warnings.push(error.clone());
            }
        }
        self.host.emit_error(&error);
    }

    /// Performs an allowlisted window action.
    ///
    /// The name is checked against the allowlist; an unknown name never
    /// reaches the operating system.
    pub fn window_action(&self, action: &str) -> Result<(), BridgeError> {
        let action = platform::window::parse_action(action)
            .ok_or_else(|| BridgeError::invalid_state("This window action is not supported."))?;
        self.host.apply_window_action(action)
    }

    /// The most recent durable checkpoint with its age.
    ///
    /// A recovered session shows how old the checkpoint is, so the user can
    /// decide whether to resume or to discard it.
    pub fn recovery_info(&self) -> Option<RecoveryInfo> {
        let inner = self.inner.lock().ok()?;
        let record = inner.recovery.as_ref()?;
        let saved_at = DateTime::parse_from_rfc3339(&record.saved_at)
            .ok()
            .map(|value| value.with_timezone(&Utc));
        let age_ms = saved_at
            .map(|value| Utc::now().signed_duration_since(value).num_milliseconds())
            .map(|value| value.max(0) as u64)
            .unwrap_or_default();
        Some(RecoveryInfo {
            saved_at: record.saved_at.clone(),
            age_ms,
            phase_id: record.snapshot.phase_id.clone(),
            remaining_ms: record.snapshot.remaining_ms,
        })
    }

    /// The warnings that are still relevant.
    pub fn warnings(&self) -> Vec<BridgeError> {
        self.warnings
            .lock()
            .map(|warnings| warnings.clone())
            .unwrap_or_default()
    }

    /// The number of retained history records.
    pub fn history_count(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.history.records().len())
            .unwrap_or_default()
    }

    /// The redacted diagnostics document.
    ///
    /// Only the fields documented on [`Diagnostics`] are collected, so
    /// personal text cannot leak through a new setting by accident.
    pub fn diagnostics(&self) -> Diagnostics {
        let settings = self.settings();
        let snapshot = self.snapshot();
        Diagnostics {
            app_version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            settings_revision: settings.revision,
            features: DiagnosticFeatures {
                notifications: settings.notifications,
                sound: settings.sound,
                global_shortcut_enabled: settings.global_shortcut_enabled,
                launch_at_login: settings.launch_at_login,
                close_to_tray: settings.close_to_tray,
                history_enabled: settings.history_enabled,
                auto_advance: settings.auto_advance,
            },
            timer: DiagnosticTimer {
                mode: snapshot.mode,
                phase: snapshot.phase,
                status: snapshot.status,
            },
            capabilities: self.capabilities(),
            warning_codes: self
                .warnings()
                .iter()
                .map(|warning| warning.code.clone())
                .collect(),
            history_records: self.history_count(),
        }
    }

    /// The redacted diagnostics document as pretty JSON.
    pub fn diagnostics_json(&self) -> Result<String, BridgeError> {
        serde_json::to_string_pretty(&self.diagnostics()).map_err(|error| {
            BridgeError::internal(format!("The diagnostics could not be prepared. {error}"))
        })
    }

    /// Shows a notification for a finished phase.
    ///
    /// The notification is only sent after the phase was stored durably, and a
    /// failing notification never undoes the completion.
    fn notify_completion(&self, effects: &[Effect]) {
        if effects.is_empty() {
            return;
        }
        if !self.settings().notifications {
            return;
        }
        let completed = effects.iter().find_map(|effect| match effect {
            Effect::PhaseCompleted { phase, label, .. } => Some((*phase, label.clone())),
            _ => None,
        });
        let Some((phase, label)) = completed else {
            return;
        };
        let title = match phase {
            deepwork_engine::Phase::Focus => "Focus complete",
            deepwork_engine::Phase::ShortBreak => "Short break complete",
            deepwork_engine::Phase::LongBreak => "Long break complete",
        };
        let body = if label.is_empty() {
            "The next phase is ready when you are.".to_string()
        } else {
            label
        };
        if let Err(error) = self.host.notify(title, &body) {
            // The phase is already stored. A missing notification service is
            // only a warning.
            self.report_warning(BridgeError::internal(format!(
                "The completion notification could not be shown. {error}"
            )));
        }
    }

    /// Takes the operation gate.
    fn lock_operation_gate(&self) -> Result<std::sync::MutexGuard<'_, ()>, BridgeError> {
        self.operation_gate
            .lock()
            .map_err(|_| BridgeError::internal("The timer is busy."))
    }

    /// Stops the deadline thread.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.notify_wake();
    }

    /// Whether the service was asked to stop.
    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    /// Wakes the deadline thread.
    pub fn notify_wake(&self) {
        if let Ok(wake) = self.wake.lock() {
            if let Some(sender) = wake.as_ref() {
                let _ = sender.send(());
            }
        }
    }

    /// How long the deadline thread may sleep before the next check.
    fn sleep_duration(&self) -> Duration {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return Duration::from_millis(PUBLISH_INTERVAL_MS),
        };
        let snapshot = inner.timer.snapshot();
        if snapshot.status != Status::Running {
            return Duration::from_millis(PUBLISH_INTERVAL_MS);
        }
        let now = platform::clock::elapsed_ms();
        let deadline = inner
            .last_sample_elapsed
            .saturating_add(snapshot.remaining_ms);
        let until_deadline = deadline.saturating_sub(now);
        Duration::from_millis(until_deadline.clamp(1, PUBLISH_INTERVAL_MS))
    }

    /// Publishes a snapshot. Periodic publications are limited to one per
    /// second and only happen while the window is visible.
    fn publish(&self, snapshot: &Snapshot, force: bool) {
        self.update_tray(snapshot.status);
        if !force {
            if !self.host.is_window_visible() {
                return;
            }
            let mut last = match self.last_publish.lock() {
                Ok(last) => last,
                Err(_) => return,
            };
            if last.elapsed() < Duration::from_millis(PUBLISH_INTERVAL_MS - 100) {
                return;
            }
            *last = Instant::now();
        } else if let Ok(mut last) = self.last_publish.lock() {
            *last = Instant::now();
        }
        self.host.emit_snapshot(snapshot);
    }

    /// Keeps the label of the tray entry in sync with the timer status.
    ///
    /// The native menu is only touched when the status actually changed.
    fn update_tray(&self, status: Status) {
        {
            let mut last = match self.last_tray_status.lock() {
                Ok(last) => last,
                Err(_) => return,
            };
            if *last == Some(status) {
                return;
            }
            *last = Some(status);
        }
        let snapshot = self.snapshot();
        self.host.update_tray(&snapshot);
    }

    /// Turns the effects of a transition into history entries.
    fn apply_effects(
        &self,
        effects: &[Effect],
        before: &Snapshot,
        started_at: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) {
        if effects.is_empty() {
            return;
        }
        let enabled = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return,
            };
            if !inner.timer.settings().history_enabled {
                return;
            }
            let interrupted = inner.timer.interruption_pending();
            for effect in effects {
                let record = build_record(effect, before, started_at, now, interrupted);
                inner.history.upsert(record);
            }
            // The interruption belongs to the phase that just finished.
            inner.timer.clear_interruption();
            let settings = inner.timer.settings().clone();
            inner.history.prune(
                settings.retention_days,
                deepwork_core::history::MAX_HISTORY_RECORDS,
                now,
            );
            true
        };
        if enabled {
            if let Err(error) = self.store.save_history(&self.history_book()) {
                self.report_warning(error);
            }
        }
    }

    /// Writes the durable state after a transition or a checkpoint.
    fn persist_state(
        &self,
        snapshot: &Snapshot,
        started_at: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) {
        match snapshot.status {
            Status::Running | Status::Paused | Status::RecoveryPending => {
                let record = RecoveryRecord::new(
                    now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    started_at
                        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
                    snapshot.clone(),
                    self.config(),
                );
                if let Err(error) = self.store.save_recovery(&record) {
                    self.report_warning(error);
                } else if let Ok(mut inner) = self.inner.lock() {
                    inner.recovery = Some(record);
                }
            }
            _ => {
                // The session is over, the checkpoint is not needed any more.
                if let Err(error) = self.store.clear_recovery() {
                    self.report_warning(error);
                } else if let Ok(mut inner) = self.inner.lock() {
                    inner.recovery = None;
                }
            }
        }
    }

    /// Writes a periodic checkpoint.
    pub fn persist_checkpoint(&self) {
        // The gate keeps the checkpoint ordered against the transitions that
        // happen at the same time.
        let Ok(_gate) = self.lock_operation_gate() else {
            return;
        };
        let (snapshot, started_at) = match self.inner.lock() {
            Ok(inner) => (inner.timer.snapshot(), inner.timer.phase_started_at()),
            Err(_) => return,
        };
        if snapshot.status != Status::Running {
            return;
        }
        self.persist_state(&snapshot, started_at, Utc::now());
    }

    fn history_book(&self) -> HistoryBook {
        self.inner
            .lock()
            .map(|inner| inner.history.clone())
            .unwrap_or_default()
    }

    fn config(&self) -> deepwork_engine::Config {
        self.inner
            .lock()
            .map(|inner| inner.timer.config())
            .unwrap_or_default()
    }

    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, Inner>, BridgeError> {
        self.inner
            .lock()
            .map_err(|_| BridgeError::internal("The timer state is unavailable."))
    }
}

/// Confirmation phrase that the frontend has to send to delete the history.
pub const DELETE_CONFIRMATION: &str = "DELETE";

/// Builds the history entry of one effect.
///
/// The configured duration of the phase comes from the effect. The elapsed
/// part is derived from the snapshot: a completed phase ran to its deadline,
/// a skipped or ended phase only ran for the time that was left.
fn build_record(
    effect: &Effect,
    before: &Snapshot,
    started_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    interrupted: bool,
) -> HistoryRecord {
    let (phase_id, phase, duration_ms, label, effect_interrupted, outcome) = match effect {
        Effect::PhaseCompleted {
            phase_id,
            phase,
            duration_ms,
            label,
            interrupted,
        } => (
            phase_id.clone(),
            *phase,
            *duration_ms,
            label.clone(),
            *interrupted,
            HistoryOutcome::Completed,
        ),
        Effect::PhaseSkipped {
            phase_id,
            phase,
            duration_ms,
            label,
            interrupted,
        } => (
            phase_id.clone(),
            *phase,
            *duration_ms,
            label.clone(),
            *interrupted,
            HistoryOutcome::Skipped,
        ),
        Effect::SessionEnded {
            phase_id,
            phase,
            duration_ms,
            label,
            interrupted,
        } => (
            phase_id.clone(),
            *phase,
            *duration_ms,
            label.clone(),
            *interrupted,
            HistoryOutcome::Ended,
        ),
    };

    let elapsed_ms = match effect {
        // The phase reached its deadline, so the whole duration elapsed.
        Effect::PhaseCompleted { .. } => duration_ms,
        // The phase was left with the time that was still on the clock.
        _ => duration_ms.saturating_sub(before.remaining_ms),
    };

    HistoryRecord {
        phase_id,
        phase: match phase {
            deepwork_engine::Phase::Focus => HistoryPhase::Focus,
            deepwork_engine::Phase::ShortBreak => HistoryPhase::ShortBreak,
            deepwork_engine::Phase::LongBreak => HistoryPhase::LongBreak,
        },
        started_at: started_at
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .unwrap_or_else(|| now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        ended_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        duration_ms: elapsed_ms,
        label,
        outcome,
        interrupted: interrupted || effect_interrupted,
        confirmed: false,
        local_date: Local::now().format("%Y-%m-%d").to_string(),
    }
}

/// Starts the thread that performs the deadline checks.
pub fn spawn_tick_thread(service: Arc<AppService>) -> Option<JoinHandle<()>> {
    let (sender, receiver): (Sender<()>, Receiver<()>) = channel();
    if let Ok(mut wake) = service.wake.lock() {
        *wake = Some(sender);
    }

    std::thread::Builder::new()
        .name("deepwork-tick".to_string())
        .spawn(move || {
            let mut last_sample = platform::clock::elapsed_ms();
            let mut last_checkpoint = Instant::now();
            while !service.is_shutdown() {
                let sleep = service.sleep_duration();
                match receiver.recv_timeout(sleep) {
                    Ok(()) => {}
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if service.is_shutdown() {
                    break;
                }
                let now_elapsed = platform::clock::elapsed_ms();
                let gap = now_elapsed.saturating_sub(last_sample);
                last_sample = now_elapsed;
                let now_wall = Utc::now();
                if let Some(snapshot) = service.tick(now_elapsed, now_wall, gap) {
                    // The state changed: publish it. A transition also wrote
                    // its durable state inside `tick`.
                    service.publish(&snapshot, false);
                }
                // The periodic checkpoint has its own timer, so it is not
                // postponed by the deadline checks that run in between. An
                // ordinary deadline check never writes a file.
                if last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL {
                    service.persist_checkpoint();
                    last_checkpoint = Instant::now();
                }
            }
        })
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::host::test_host::TestHost;
    use deepwork_engine::{Config, Mode};

    /// Builds a service on a temporary directory with a recording host.
    fn service(directory: &std::path::Path) -> Arc<AppService> {
        service_with_settings_path(directory, directory.join("settings.json"))
    }

    /// Builds a service whose settings document cannot be stored.
    fn service_with_blocked_settings(directory: &std::path::Path) -> Arc<AppService> {
        // A file where a directory would be needed: the write cannot succeed.
        let blocked = directory.join("blocked");
        std::fs::write(&blocked, b"not a directory").expect("write");
        service_with_settings_path(directory, blocked.join("settings.json"))
    }

    fn service_with_settings_path(
        directory: &std::path::Path,
        settings_path: std::path::PathBuf,
    ) -> Arc<AppService> {
        service_with_host(directory, settings_path).0
    }

    /// Builds a service and gives the recording host back to the test.
    fn service_with_host(
        directory: &std::path::Path,
        settings_path: std::path::PathBuf,
    ) -> (Arc<AppService>, Arc<TestHost>) {
        let store = Store::new(crate::storage::StorePaths {
            settings: settings_path,
            history: directory.join("history.json"),
            recovery: directory.join("recovery.json"),
        });
        let host = Arc::new(TestHost::new());
        let service = AppService::new(host.clone(), store).expect("service");
        (service, host)
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T10:00:00Z")
            .expect("parse")
            .with_timezone(&Utc)
    }

    fn short_config() -> Config {
        Config {
            mode: Mode::Countdown,
            focus_ms: 1_000,
            short_break_ms: 1_000,
            long_break_ms: 1_000,
            long_break_interval: 4,
            label: String::new(),
        }
    }

    #[test]
    fn a_command_is_written_to_the_checkpoint() {
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service(directory.path());
        let revision = service.snapshot().revision;
        service
            .apply_command(Action::Start, 0, now(), Some(revision))
            .expect("start");
        let checkpoint = directory.path().join("recovery.json");
        assert!(checkpoint.exists(), "the checkpoint was written");
        let content = std::fs::read_to_string(&checkpoint).expect("read");
        let record: RecoveryRecord = serde_json::from_str(&content).expect("parse");
        assert_eq!(record.snapshot.revision, service.snapshot().revision);
    }

    #[test]
    fn a_completion_is_recorded_as_confirmed_focus() {
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service(directory.path());
        let revision = service.snapshot().revision;
        service
            .apply_command(
                Action::Configure {
                    config: short_config(),
                },
                0,
                now(),
                Some(revision),
            )
            .expect("configure");
        let revision = service.snapshot().revision;
        service
            .apply_command(Action::Start, 0, now(), Some(revision))
            .expect("start");
        // One second later the phase is over.
        service.tick(1_500, now(), 0);

        let history = service.all_history();
        assert_eq!(history.len(), 1, "{history:?}");
        assert_eq!(history[0].phase, HistoryPhase::Focus);
        assert_eq!(history[0].outcome, HistoryOutcome::Completed);
        assert!(history[0].confirmed, "an ordinary completion counts");
        assert!(!history[0].interrupted);
        assert!(directory.path().join("history.json").exists());
    }

    #[test]
    fn the_checkpoint_always_matches_the_newest_state() {
        // The transition, the durable write and the effects of two
        // transitions must never interleave: the checkpoint on disk always
        // belongs to the newest transition and is never newer than the state
        // that the application is in.
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service(directory.path());
        let checkpoint = directory.path().join("recovery.json");
        let mut revision = service.snapshot().revision;
        for step in 0..6u64 {
            let action = match step % 3 {
                0 => Action::Start,
                1 => Action::Pause,
                _ => Action::Resume,
            };
            let transition = service
                .apply_command(action, step * 100, now(), Some(revision))
                .expect("command");
            revision = transition.revision;

            let content = std::fs::read_to_string(&checkpoint).expect("the checkpoint exists");
            let record: RecoveryRecord = serde_json::from_str(&content).expect("parse");
            assert_eq!(
                record.snapshot.revision, transition.revision,
                "the checkpoint does not belong to the newest transition after step {step}"
            );

            // A deadline check changes the remaining time but writes nothing.
            service.tick(step * 100 + 50, now(), 0);
            let content = std::fs::read_to_string(&checkpoint).expect("the checkpoint exists");
            let record: RecoveryRecord = serde_json::from_str(&content).expect("parse");
            assert!(
                record.snapshot.revision <= service.snapshot().revision,
                "the checkpoint is newer than the state after step {step}"
            );
        }
    }

    #[test]
    fn an_ordinary_deadline_check_does_not_write() {
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service(directory.path());
        let revision = service.snapshot().revision;
        service
            .apply_command(Action::Start, 0, now(), Some(revision))
            .expect("start");
        std::fs::remove_file(directory.path().join("recovery.json")).expect("remove");
        // A deadline check that changes nothing but the remaining time.
        service.tick(100, now(), 0);
        assert!(
            !directory.path().join("recovery.json").exists(),
            "an ordinary deadline check must not write a file"
        );
    }

    #[test]
    fn a_failing_settings_write_keeps_the_running_settings() {
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service_with_blocked_settings(directory.path());
        let mut settings = service.settings();
        settings.theme = deepwork_core::settings::Theme::Dark;
        let error = service.save_settings(settings, 0).expect_err("not stored");
        assert_eq!(error.code, deepwork_core::CODE_STORAGE_UNAVAILABLE);
        // The settings that could not be stored are not in use.
        assert_eq!(
            service.settings().theme,
            deepwork_core::settings::Theme::System
        );
        assert_eq!(service.settings().revision, 0);
    }

    #[test]
    fn a_stored_settings_document_is_in_use() {
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service(directory.path());
        let mut settings = service.settings();
        settings.theme = deepwork_core::settings::Theme::Dark;
        let saved = service.save_settings(settings, 0).expect("saved");
        assert_eq!(saved.revision, 1);
        assert_eq!(
            service.settings().theme,
            deepwork_core::settings::Theme::Dark
        );
        assert_eq!(service.settings().revision, 1);
    }

    #[test]
    fn the_history_is_bounded_and_confirmable() {
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service(directory.path());
        let revision = service.snapshot().revision;
        service
            .apply_command(
                Action::Configure {
                    config: short_config(),
                },
                0,
                now(),
                Some(revision),
            )
            .expect("configure");
        let revision = service.snapshot().revision;
        service
            .apply_command(Action::Start, 0, now(), Some(revision))
            .expect("start");
        service.tick(1_500, now(), 0);
        let history = service.all_history();
        assert_eq!(history.len(), 1);
        let phase_id = history[0].phase_id.clone();
        service.confirm_history(&phase_id).expect("confirm");
        assert!(service.all_history()[0].confirmed);
    }

    #[test]
    fn warnings_survive_until_the_frontend_asks_for_them() {
        let directory = tempfile::tempdir().expect("temp dir");
        let service = service(directory.path());
        service.report_warning(BridgeError::storage("The disk is full."));
        service.report_warning(BridgeError::storage("The disk is full."));
        let warnings = service.warnings();
        assert_eq!(warnings.len(), 1, "the same warning is stored once");
        assert_eq!(warnings[0].code, deepwork_core::CODE_STORAGE_UNAVAILABLE);
    }

    #[test]
    fn a_restart_offers_the_recovered_phase_without_resuming_it() {
        let directory = tempfile::tempdir().expect("temp dir");
        {
            let service = service(directory.path());
            let revision = service.snapshot().revision;
            service
                .apply_command(Action::Start, 0, now(), Some(revision))
                .expect("start");
        }
        // The application starts again with the same data.
        let service = service(directory.path());
        let snapshot = service.snapshot();
        assert_eq!(
            snapshot.status,
            Status::RecoveryPending,
            "a recovered phase waits for an explicit decision"
        );
        assert!(
            snapshot.remaining_ms > 0,
            "the remaining time of the phase is kept"
        );
        let info = service.recovery_info().expect("recovery information");
        assert_eq!(info.phase_id, snapshot.phase_id);
        assert_eq!(info.remaining_ms, snapshot.remaining_ms);
    }

    #[test]
    fn a_completion_notifies_once_and_publishes_the_new_state() {
        let directory = tempfile::tempdir().expect("temp dir");
        let (service, host) =
            service_with_host(directory.path(), directory.path().join("settings.json"));
        // Notifications are switched on.
        let mut settings = service.settings();
        settings.notifications = true;
        service.save_settings(settings, 0).expect("settings");

        let revision = service.snapshot().revision;
        service
            .apply_command(
                Action::Configure {
                    config: short_config(),
                },
                0,
                now(),
                Some(revision),
            )
            .expect("configure");
        let revision = service.snapshot().revision;
        service
            .apply_command(Action::Start, 0, now(), Some(revision))
            .expect("start");
        service.tick(1_500, now(), 0);

        let recorded = host.recorded();
        assert_eq!(
            recorded.notifications.len(),
            1,
            "exactly one notification per completion"
        );
        assert!(
            !recorded.snapshots.is_empty(),
            "the new state was published"
        );
    }

    #[test]
    fn auto_advance_publishes_the_next_phase_once() {
        let directory = tempfile::tempdir().expect("temp dir");
        let (service, host) =
            service_with_host(directory.path(), directory.path().join("settings.json"));
        let mut settings = service.settings();
        settings.notifications = true;
        settings.auto_advance = true;
        service.save_settings(settings, 0).expect("settings");

        let revision = service.snapshot().revision;
        service
            .apply_command(
                Action::Configure {
                    config: Config {
                        mode: Mode::Cycle,
                        ..short_config()
                    },
                },
                0,
                now(),
                Some(revision),
            )
            .expect("configure");
        let revision = service.snapshot().revision;
        service
            .apply_command(Action::Start, 0, now(), Some(revision))
            .expect("start");

        let changed = service.tick(1_500, now(), 0).expect("the state changed");
        assert_eq!(changed.status, Status::Idle);
        assert_eq!(
            changed.phase,
            deepwork_engine::Phase::ShortBreak,
            "{changed:?}"
        );
        assert_eq!(changed.completed_focus_count, 1);

        // One completion, one notification and one history record; the next
        // deadline check does not complete or advance anything again.
        assert_eq!(host.recorded().notifications.len(), 1);
        assert_eq!(service.all_history().len(), 1);
        assert!(service.tick(1_600, now(), 0).is_none());
        assert_eq!(service.all_history().len(), 1);
    }

    #[test]
    fn a_deadline_check_reports_the_changed_remaining_time() {
        let directory = tempfile::tempdir().expect("temp dir");
        let (service, host) =
            service_with_host(directory.path(), directory.path().join("settings.json"));
        let revision = service.snapshot().revision;
        service
            .apply_command(Action::Start, 0, now(), Some(revision))
            .expect("start");
        let before = service.snapshot().remaining_ms;
        let published_before = host.recorded().snapshots.len();
        // The deadline check reports the changed state, so that the caller
        // can publish it once per second.
        let changed = service.tick(1_000, now(), 0).expect("the state changed");
        assert!(changed.remaining_ms < before, "{changed:?}");
        assert_eq!(
            host.recorded().snapshots.len(),
            published_before,
            "the deadline check itself does not publish"
        );
    }

    #[test]
    fn accepting_a_recovered_phase_continues_it() {
        let directory = tempfile::tempdir().expect("temp dir");
        {
            let service = service(directory.path());
            let revision = service.snapshot().revision;
            service
                .apply_command(Action::Start, 0, now(), Some(revision))
                .expect("start");
        }
        let service = service(directory.path());
        let revision = service.snapshot().revision;
        let snapshot = service
            .apply_command(Action::AcceptRecovery, 10, now(), Some(revision))
            .expect("accept");
        assert_eq!(snapshot.status, Status::Running);
        assert!(
            snapshot.remaining_ms > 0,
            "the frozen remaining time is preserved"
        );
    }
}

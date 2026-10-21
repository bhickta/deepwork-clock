//! The narrow desktop interface the service uses.
//!
//! The service does not know Tauri. It talks to the desktop through this
//! trait, which keeps the timer logic free of window handles, plugins and
//! event loops. The Tauri implementation lives in [`TauriHost`]; the tests
//! use a recording host, so the whole service can be exercised without a
//! display.

use deepwork_core::BridgeError;
use deepwork_engine::Snapshot;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::ManagerExt as AutoStartManagerExt;

use super::capabilities::Capability;
use super::window::{self, PinSupport, WindowAction};

/// Everything the service needs from the desktop.
pub trait PlatformHost: Send + Sync {
    /// Publishes a snapshot to the user interface.
    fn emit_snapshot(&self, snapshot: &Snapshot);

    /// Publishes a warning to the user interface.
    fn emit_error(&self, error: &BridgeError);

    /// Whether the timer window is on screen.
    fn is_window_visible(&self) -> bool;

    /// Applies an allowlisted window action.
    fn apply_window_action(&self, action: WindowAction) -> Result<(), BridgeError>;

    /// How well the desktop supports keeping the window above other windows.
    fn pin_support(&self) -> (PinSupport, &'static str);

    /// Shows a notification.
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;

    /// Registers a global shortcut.
    fn register_shortcut(&self, accelerator: &str) -> Result<(), BridgeError>;

    /// Removes every global shortcut of this application.
    fn unregister_shortcuts(&self);

    /// Turns the start at login registration on or off.
    fn set_autostart(&self, enabled: bool) -> Result<(), String>;

    /// Whether a global shortcut can be registered on this machine.
    fn shortcut_support(&self) -> Capability;

    /// Whether notifications can be delivered on this machine.
    fn notification_support(&self) -> Capability;

    /// Keeps the label of the tray entry in sync with the timer status.
    fn update_tray(&self, snapshot: &Snapshot);
}

/// The Tauri implementation of the desktop interface.
pub struct TauriHost {
    app: AppHandle<Wry>,
}

impl TauriHost {
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self { app }
    }
}

impl PlatformHost for TauriHost {
    fn emit_snapshot(&self, snapshot: &Snapshot) {
        let _ = self
            .app
            .emit(crate::service::SNAPSHOT_EVENT, snapshot.clone());
    }

    fn emit_error(&self, error: &BridgeError) {
        let _ = self.app.emit(crate::service::ERROR_EVENT, error);
    }

    fn is_window_visible(&self) -> bool {
        window::is_visible(&self.app)
    }

    fn apply_window_action(&self, action: WindowAction) -> Result<(), BridgeError> {
        window::apply(&self.app, action)
    }

    fn pin_support(&self) -> (PinSupport, &'static str) {
        window::pin_support()
    }

    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        // The plugin is not available in every situation, for example while
        // the application is shutting down.
        if self
            .app
            .try_state::<tauri_plugin_notification::Notification<Wry>>()
            .is_none()
        {
            return Err("The notification service is not ready.".to_string());
        }
        super::notification::notify(&self.app, title, body)
    }

    fn register_shortcut(&self, accelerator: &str) -> Result<(), BridgeError> {
        super::shortcut::register(&self.app, accelerator)
    }

    fn unregister_shortcuts(&self) {
        super::shortcut::unregister_all(&self.app);
    }

    fn set_autostart(&self, enabled: bool) -> Result<(), String> {
        let result = if enabled {
            self.app.autolaunch().enable()
        } else {
            self.app.autolaunch().disable()
        };
        result.map_err(|error| error.to_string())
    }

    fn shortcut_support(&self) -> Capability {
        super::shortcut::support()
    }

    fn notification_support(&self) -> Capability {
        super::notification::support()
    }

    fn update_tray(&self, snapshot: &Snapshot) {
        if let Some(tray) = self.app.try_state::<super::tray::TrayState>() {
            super::tray::update(&tray.menu, snapshot);
        }
    }
}

/// A host that records what the service asked for.
///
/// Used by the tests; it never touches a desktop.
#[cfg(test)]
pub mod test_host {
    use super::super::capabilities::CapabilityState;
    use super::*;
    use std::sync::Mutex;

    /// Everything the service asked the desktop to do.
    #[derive(Debug, Default)]
    pub struct Recorded {
        pub snapshots: Vec<Snapshot>,
        pub errors: Vec<BridgeError>,
        pub notifications: Vec<(String, String)>,
        pub shortcuts: Vec<String>,
        pub autostart: Vec<bool>,
        pub window_actions: Vec<WindowAction>,
    }

    /// A desktop that only remembers.
    #[derive(Debug, Default)]
    pub struct TestHost {
        pub recorded: Mutex<Recorded>,
        pub visible: Mutex<bool>,
    }

    impl TestHost {
        pub fn new() -> Self {
            Self {
                recorded: Mutex::new(Recorded::default()),
                visible: Mutex::new(true),
            }
        }

        pub fn recorded(&self) -> Recorded {
            self.recorded
                .lock()
                .map(|recorded| Recorded {
                    snapshots: recorded.snapshots.clone(),
                    errors: recorded.errors.clone(),
                    notifications: recorded.notifications.clone(),
                    shortcuts: recorded.shortcuts.clone(),
                    autostart: recorded.autostart.clone(),
                    window_actions: recorded.window_actions.clone(),
                })
                .unwrap_or_default()
        }
    }

    impl PlatformHost for TestHost {
        fn emit_snapshot(&self, snapshot: &Snapshot) {
            if let Ok(mut recorded) = self.recorded.lock() {
                recorded.snapshots.push(snapshot.clone());
            }
        }

        fn emit_error(&self, error: &BridgeError) {
            if let Ok(mut recorded) = self.recorded.lock() {
                recorded.errors.push(error.clone());
            }
        }

        fn is_window_visible(&self) -> bool {
            self.visible.lock().map(|visible| *visible).unwrap_or(false)
        }

        fn apply_window_action(&self, action: WindowAction) -> Result<(), BridgeError> {
            if let Ok(mut recorded) = self.recorded.lock() {
                recorded.window_actions.push(action);
            }
            Ok(())
        }

        fn pin_support(&self) -> (PinSupport, &'static str) {
            (PinSupport::Available, "The test host can do everything.")
        }

        fn notify(&self, title: &str, body: &str) -> Result<(), String> {
            if let Ok(mut recorded) = self.recorded.lock() {
                recorded
                    .notifications
                    .push((title.to_string(), body.to_string()));
            }
            Ok(())
        }

        fn register_shortcut(&self, accelerator: &str) -> Result<(), BridgeError> {
            if let Ok(mut recorded) = self.recorded.lock() {
                recorded.shortcuts.push(accelerator.to_string());
            }
            Ok(())
        }

        fn unregister_shortcuts(&self) {}

        fn set_autostart(&self, enabled: bool) -> Result<(), String> {
            if let Ok(mut recorded) = self.recorded.lock() {
                recorded.autostart.push(enabled);
            }
            Ok(())
        }

        fn shortcut_support(&self) -> Capability {
            Capability::new(
                CapabilityState::Available,
                "The test host can register shortcuts.",
            )
        }

        fn notification_support(&self) -> Capability {
            Capability::new(
                CapabilityState::Available,
                "The test host can show notifications.",
            )
        }

        fn update_tray(&self, _snapshot: &Snapshot) {}
    }
}

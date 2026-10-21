//! Notification adapter.
//!
//! Notifications are optional and never block the timer. A missing
//! notification service, a denied permission or a failing delivery are all
//! reported as a local error and never change the timer state.

use tauri::Runtime;
use tauri_plugin_notification::NotificationExt;

/// Shows a notification. The error text is meant for the local log.
pub fn notify<R: Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    body: &str,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

/// Whether a notification service is expected to exist.
///
/// The answer is deliberately conservative: on Linux the delivery depends on
/// a running notification service, and on macOS a signed bundle is required.
pub fn support() -> super::capabilities::Capability {
    use super::capabilities::{Capability, CapabilityState};

    if cfg!(target_os = "windows") {
        return Capability::new(
            CapabilityState::Available,
            "Notifications can be shown on this system.",
        );
    }
    if cfg!(target_os = "macos") {
        return Capability::new(
            CapabilityState::PermissionRequired,
            "macOS asks the user for the permission to show notifications, and only a signed bundle can show them.",
        );
    }
    Capability::new(
        CapabilityState::Unknown,
        "Notifications depend on a notification service that this desktop may not run.",
    )
}

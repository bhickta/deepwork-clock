//! Platform adapters.
//!
//! Every operating system specific call lives in this module. The adapters
//! are deliberately small, they never reach into the timer engine and they
//! never hold a lock while talking to the operating system.

pub mod capabilities;
pub mod clock;
pub mod host;
pub mod notification;
pub mod placement;
pub mod shortcut;
pub mod tray;
pub mod window;

/// Whether the session runs on Wayland.
///
/// Wayland does not give ordinary applications global window placement or
/// keep-above control, and the global shortcut library used by the plugin
/// only supports X11. The detection is used to report those features as
/// unavailable instead of pretending that they work.
pub fn session_is_wayland() -> bool {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return true;
    }
    matches!(std::env::var("XDG_SESSION_TYPE").as_deref(), Ok("wayland"))
}

/// Whether the session runs on X11.
pub fn session_is_x11() -> bool {
    matches!(std::env::var("XDG_SESSION_TYPE").as_deref(), Ok("x11"))
}

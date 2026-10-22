//! Window adapter.
//!
//! The timer uses a single window. Compact mode and the normal view are two
//! sizes of that window, so switching between them can never pause or reset
//! the session and there is never a second state owner.
//!
//! The floating action combines the compact size with "keep above other
//! windows". Placement persistence, monitor recovery and the "Restore
//! defaults" rectangle live in [`super::placement`].

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime};

use deepwork_core::BridgeError;

use super::placement;

// Called from `lib.rs` setup.
pub use super::placement::{install_placement_tracking, restore_placement};

/// Label of the only window of the application.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Logical size of the normal view.
pub const NORMAL_WIDTH: f64 = 420.0;
pub const NORMAL_HEIGHT: f64 = 440.0;

/// Logical size of the compact view.
///
/// The compact view keeps enough room for 44 logical pixel control targets,
/// which the frontend asked for after its accessibility review. The window
/// may still be smaller, because the interface reflows.
pub const COMPACT_WIDTH: f64 = 320.0;
pub const COMPACT_HEIGHT: f64 = 200.0;

/// The smallest window size that placement recovery restores.
///
/// A saved rectangle smaller than this is treated as corrupt, so a bad value
/// cannot reopen an invisible window.
pub const MIN_WIDTH: f64 = 160.0;
pub const MIN_HEIGHT: f64 = 120.0;

/// The allowlisted window actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowAction {
    Compact,
    Normal,
    Pin,
    Unpin,
    Float,
    Unfloat,
    Restore,
}

/// Parses an action name. Unknown names are rejected.
pub fn parse_action(raw: &str) -> Option<WindowAction> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "compact" => Some(WindowAction::Compact),
        "normal" => Some(WindowAction::Normal),
        "pin" => Some(WindowAction::Pin),
        "unpin" => Some(WindowAction::Unpin),
        "float" => Some(WindowAction::Float),
        "unfloat" => Some(WindowAction::Unfloat),
        "restore" => Some(WindowAction::Restore),
        _ => None,
    }
}

/// How well the desktop supports keeping the window above other windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinSupport {
    /// The platform implements the request.
    Available,
    /// The platform cannot do it at all.
    Unavailable,
    /// The platform may do it, but the window manager decides.
    Unknown,
}

/// Reports the pin capability of the current desktop.
pub fn pin_support() -> (PinSupport, &'static str) {
    if cfg!(target_os = "windows") {
        return (
            PinSupport::Available,
            "The window can be kept above other windows.",
        );
    }
    if cfg!(target_os = "macos") {
        return (
            PinSupport::Available,
            "The window can be kept above other windows.",
        );
    }
    if super::session_is_wayland() {
        return (
            PinSupport::Unavailable,
            "This desktop does not support keeping the window above other windows.",
        );
    }
    (
        PinSupport::Unknown,
        "Keeping the window above other windows depends on the window manager of this desktop.",
    )
}

/// Applies an allowlisted window action.
pub fn apply<R: Runtime>(app: &AppHandle<R>, action: WindowAction) -> Result<(), BridgeError> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| BridgeError::invalid_state("The timer window is not available."))?;

    match action {
        WindowAction::Compact => {
            set_size(&window, COMPACT_WIDTH, COMPACT_HEIGHT)?;
        }
        WindowAction::Normal => {
            set_size(&window, NORMAL_WIDTH, NORMAL_HEIGHT)?;
        }
        WindowAction::Pin => {
            let (support, reason) = pin_support();
            if support == PinSupport::Unavailable {
                return Err(BridgeError::unsupported(reason));
            }
            window.set_always_on_top(true).map_err(|error| {
                BridgeError::internal(format!("Could not pin the window. {error}"))
            })?;
        }
        WindowAction::Unpin => {
            window.set_always_on_top(false).map_err(|error| {
                BridgeError::internal(format!("Could not unpin the window. {error}"))
            })?;
        }
        WindowAction::Float => {
            // On Wayland the compositor owns the stacking order. Return the
            // typed capability error and change nothing at all, so the
            // interface cannot show a compact window that claims to float.
            let (support, reason) = pin_support();
            if support == PinSupport::Unavailable {
                return Err(BridgeError::unsupported(reason));
            }
            // Ask a tiling window manager to float the window *before* the
            // size request: a tiled window ignores the size.
            request_floating_layout(true);
            set_size(&window, COMPACT_WIDTH, COMPACT_HEIGHT)?;
            window.set_always_on_top(true).map_err(|error| {
                BridgeError::internal(format!("Could not float the window. {error}"))
            })?;
        }
        WindowAction::Unfloat => {
            window.set_always_on_top(false).map_err(|error| {
                BridgeError::internal(format!("Could not unfloat the window. {error}"))
            })?;
            request_floating_layout(false);
            set_size(&window, NORMAL_WIDTH, NORMAL_HEIGHT)?;
        }
        WindowAction::Restore => {
            // "Restore defaults": forget an invalid remembered rectangle,
            // return to the normal size and centre on the primary monitor.
            // This is the reliable recovery path after a monitor change.
            let placement = placement::default_placement(app);
            set_size(&window, placement.width, placement.height)?;
            // Wayland compositors may ignore the position; showing and
            // focusing the window below still works, so a failed position
            // request is not an error here.
            let _ = window.set_position(LogicalPosition::new(placement.x, placement.y));
            placement::forget(app);
            restore(&window);
        }
    }
    Ok(())
}

/// Applies the remembered layout after placement recovery.
///
/// A floating window is restored as a floating compact window. Without this,
/// a tiling window manager would reopen the window tiled and ignore the saved
/// compact size.
pub fn restore_layout<R: Runtime>(
    app: &AppHandle<R>,
    compact: bool,
    floating: bool,
) -> Result<(), BridgeError> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| BridgeError::invalid_state("The timer window is not available."))?;
    if floating {
        request_floating_layout(true);
        set_size(&window, COMPACT_WIDTH, COMPACT_HEIGHT)?;
        window.set_always_on_top(true).map_err(|error| {
            BridgeError::internal(format!("Could not restore the floating window. {error}"))
        })?;
    } else {
        let (width, height) = if compact {
            (COMPACT_WIDTH, COMPACT_HEIGHT)
        } else {
            (NORMAL_WIDTH, NORMAL_HEIGHT)
        };
        set_size(&window, width, height)?;
    }
    Ok(())
}

/// Ask a tiling window manager to take the window out of the tiling layout.
///
/// Best effort: the window manager owns the result, and a desktop without i3
/// or sway simply reports that no command was sent.
fn request_floating_layout(floating: bool) {
    #[cfg(target_os = "linux")]
    {
        let _ = super::wm::set_floating(floating);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = floating;
    }
}

/// Shows the window again and gives it the focus.
pub fn restore<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Brings the main window to the front. Used by the tray and by the single
/// instance handler.
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        restore(&window);
    }
}

/// Whether the main window is currently on screen.
pub fn is_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

fn set_size<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    width: f64,
    height: f64,
) -> Result<(), BridgeError> {
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| BridgeError::internal(format!("Could not resize the window. {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_actions_are_accepted() {
        assert_eq!(parse_action("compact"), Some(WindowAction::Compact));
        assert_eq!(parse_action("NORMAL"), Some(WindowAction::Normal));
        assert_eq!(parse_action(" pin "), Some(WindowAction::Pin));
        assert_eq!(parse_action("unpin"), Some(WindowAction::Unpin));
        assert_eq!(parse_action("float"), Some(WindowAction::Float));
        assert_eq!(parse_action("UNFLOAT"), Some(WindowAction::Unfloat));
        assert_eq!(parse_action("restore"), Some(WindowAction::Restore));
    }

    #[test]
    fn unknown_actions_are_rejected() {
        assert_eq!(parse_action(""), None);
        assert_eq!(parse_action("close"), None);
        assert_eq!(parse_action("exec"), None);
        assert_eq!(parse_action("../etc/passwd"), None);
        // `float` is an action, but only the exact name; no variants.
        assert_eq!(parse_action("float-on-top"), None);
        assert_eq!(parse_action("float "), Some(WindowAction::Float));
    }

    #[test]
    fn the_compact_view_is_smaller_than_the_normal_view() {
        const { assert!(COMPACT_WIDTH < NORMAL_WIDTH) };
        const { assert!(COMPACT_HEIGHT < NORMAL_HEIGHT) };
    }

    #[test]
    fn the_compact_view_keeps_room_for_44_pixel_targets() {
        // The frontend asked for 44 logical pixel control targets in the
        // compact view, so the view is not smaller than the main controls.
        const { assert!(COMPACT_WIDTH >= 44.0 * 2.0) };
        const { assert!(COMPACT_HEIGHT >= 44.0) };
    }
}

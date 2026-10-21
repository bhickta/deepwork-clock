//! Global shortcut adapter.
//!
//! Global shortcuts are opt-in and disabled by default. The plugin is backed
//! by a library that supports X11 on Linux only; on Wayland the regular
//! plugin cannot deliver a global shortcut. The adapter therefore reports
//! Wayland as unavailable instead of registering a binding that would never
//! fire. A Wayland implementation would need the separately tested
//! `GlobalShortcuts` portal session, which this build does not contain.

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{Error, GlobalShortcutExt};

use deepwork_core::{BridgeError, CODE_PERMISSION_DENIED, CODE_SHORTCUT_CONFLICT};

use super::capabilities::{Capability, CapabilityState};

/// Reason shown when the desktop cannot deliver a global shortcut.
pub const WAYLAND_REASON: &str =
    "Global shortcuts need the GlobalShortcuts portal on Wayland, which this build does not implement. Use the X11 session or the in-app shortcuts.";

/// Reports whether a global shortcut can be registered on this machine.
pub fn support() -> Capability {
    if super::session_is_wayland() {
        return Capability::new(CapabilityState::Unavailable, WAYLAND_REASON);
    }
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        return Capability::new(
            CapabilityState::Available,
            "Global shortcuts can be registered on this system.",
        );
    }
    if super::session_is_x11() {
        return Capability::new(
            CapabilityState::Available,
            "Global shortcuts can be registered on this X11 session.",
        );
    }
    Capability::new(
        CapabilityState::Unknown,
        "Global shortcuts depend on the display server of this desktop, which was not recognised as X11.",
    )
}

/// Registers one accelerator.
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), BridgeError> {
    if super::session_is_wayland() {
        return Err(BridgeError::unsupported(WAYLAND_REASON));
    }
    validate_accelerator(accelerator)?;
    app.global_shortcut()
        .register(accelerator)
        .map_err(|error| map_error(&error))
}

/// Removes every accelerator that this application registered.
pub fn unregister_all<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.global_shortcut().unregister_all();
}

/// Modifier names that the accelerator syntax accepts.
const MODIFIERS: [&str; 12] = [
    "ctrl",
    "control",
    "cmdorctrl",
    "cmdorcontrol",
    "alt",
    "option",
    "shift",
    "super",
    "win",
    "cmd",
    "command",
    "meta",
];

/// Key combinations that the operating system or the desktop owns.
const RESERVED: [&str; 5] = [
    "alt+tab",
    "alt+f4",
    "ctrl+alt+delete",
    "ctrl+alt+esc",
    "cmdorctrl+alt+delete",
];

/// Validates an accelerator before it is registered.
///
/// A global shortcut must
///
/// * contain at least one modifier key, so that it never swallows ordinary
///   typing,
/// * not consist of a single letter key, and
/// * not use a combination that the operating system reserves.
pub fn validate_accelerator(accelerator: &str) -> Result<(), BridgeError> {
    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_state("The global shortcut is empty."));
    }
    let normalized = trimmed.to_ascii_lowercase().replace(' ', "");
    if RESERVED.contains(&normalized.as_str()) {
        return Err(BridgeError::invalid_state(
            "This combination is reserved by the operating system.",
        ));
    }

    let parts: Vec<&str> = normalized
        .split('+')
        .filter(|part| !part.is_empty())
        .collect();
    let (key, modifiers) = match parts.split_last() {
        Some((key, modifiers)) => (key, modifiers),
        None => {
            return Err(BridgeError::invalid_state(
                "The global shortcut could not be understood.",
            ))
        }
    };
    if !modifiers
        .iter()
        .any(|modifier| MODIFIERS.contains(&modifier.to_string().as_str()))
    {
        return Err(BridgeError::invalid_state(
            "A global shortcut needs at least one modifier key, such as Alt or Ctrl.",
        ));
    }
    if key.len() == 1 && key.chars().all(|character| character.is_ascii_alphabetic()) {
        return Err(BridgeError::invalid_state(
            "A global shortcut must not be a single letter key.",
        ));
    }
    Ok(())
}

/// Tracks the pressed state of the global shortcut.
///
/// A key that is held down produces repeated press events. Only the first
/// press of a series is acted upon, so one held key cannot toggle the timer
/// again and again.
#[derive(Debug, Default)]
pub struct ShortcutPressState {
    pressed: std::sync::atomic::AtomicBool,
}

impl ShortcutPressState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a press. Returns `true` when this is a new press.
    pub fn press(&self) -> bool {
        !self.pressed.swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    /// Records a release.
    pub fn release(&self) {
        self.pressed
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether the key is currently held down.
    #[cfg(test)]
    pub fn is_pressed(&self) -> bool {
        self.pressed.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Maps a plugin error onto the stable error vocabulary.
fn map_error(error: &Error) -> BridgeError {
    let text = error.to_string();
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("already registered")
        || lowered.contains("conflict")
        || lowered.contains("in use")
    {
        return BridgeError::new(
            CODE_SHORTCUT_CONFLICT,
            "Another application already uses this shortcut.",
        );
    }
    if lowered.contains("parse")
        || lowered.contains("invalid")
        || lowered.contains("unknown key")
        || lowered.contains("modifier")
    {
        return BridgeError::invalid_state(
            "This shortcut could not be understood. Use names such as Alt+Shift+Space.",
        );
    }
    BridgeError::new(
        CODE_PERMISSION_DENIED,
        "The system refused to register this shortcut.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_is_reported_as_unavailable() {
        if super::super::session_is_wayland() {
            let capability = support();
            assert_eq!(capability.state, CapabilityState::Unavailable);
            assert!(
                capability.reason.contains("Wayland"),
                "{}",
                capability.reason
            );
        }
    }

    #[test]
    fn a_conflict_is_reported_as_a_conflict() {
        let error = map_error(&Error::GlobalHotkey(
            "HotKey already registered".to_string(),
        ));
        assert_eq!(error.code, CODE_SHORTCUT_CONFLICT);
    }

    #[test]
    fn an_unparsable_accelerator_is_reported_as_invalid() {
        let error = map_error(&Error::GlobalHotkey(
            "failed to parse hotkey: unknown key".to_string(),
        ));
        assert_eq!(error.code, "INVALID_STATE");
    }

    #[test]
    fn an_os_refusal_is_reported_as_a_permission_problem() {
        let error = map_error(&Error::GlobalHotkey(
            "Failed to register hotkey".to_string(),
        ));
        assert_eq!(error.code, CODE_PERMISSION_DENIED);
    }

    #[test]
    fn a_shortcut_without_a_modifier_is_refused() {
        assert!(validate_accelerator("Space").is_err());
        assert!(validate_accelerator("F5").is_err());
    }

    #[test]
    fn a_bare_letter_is_refused() {
        assert!(validate_accelerator("A").is_err());
        assert!(validate_accelerator("Ctrl+A").is_err());
    }

    #[test]
    fn a_reserved_combination_is_refused() {
        assert!(validate_accelerator("Alt+Tab").is_err());
        assert!(validate_accelerator("ctrl+alt+delete").is_err());
    }

    #[test]
    fn a_normal_combination_is_accepted() {
        assert!(validate_accelerator("Alt+Shift+Space").is_ok());
        assert!(validate_accelerator("CmdOrCtrl+Shift+Space").is_ok());
        assert!(validate_accelerator("Ctrl+Alt+F4").is_ok());
    }

    #[test]
    fn an_empty_shortcut_is_refused() {
        assert!(validate_accelerator("").is_err());
        assert!(validate_accelerator("   ").is_err());
    }

    #[test]
    fn a_held_key_only_acts_once() {
        let state = ShortcutPressState::new();
        assert!(state.press(), "the first press acts");
        assert!(!state.press(), "a repeated press is ignored");
        assert!(!state.press(), "a repeated press is ignored");
        assert!(state.is_pressed());
        state.release();
        assert!(!state.is_pressed());
        assert!(state.press(), "after the release a new press acts");
    }
}

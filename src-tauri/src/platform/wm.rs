//! Window-manager adapter for tiling desktops.
//!
//! Tauri can request a size and an always-on-top state, but a tiling window
//! manager (i3, Regolith, sway) ignores both while the window is tiled. The
//! compact and floating views only make sense as a floating window, so this
//! module asks i3 to move the window out of the tiling layout.
//!
//! The adapter is intentionally small and best effort:
//!
//! * it only runs on X11 sessions where i3 exported `I3SOCK`;
//! * a missing socket, a different window manager or a malformed reply is not
//!   an error for the timer, it only means "the window manager decides";
//! * sway speaks the same IPC protocol but exports `SWAYSOCK`; it is handled
//!   the same way.
//!
//! No shell command is executed. The i3 IPC protocol is a Unix socket with a
//! fixed header (`i3-ipc` magic, payload length, message type).

#![cfg(target_os = "linux")]

use std::env;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

/// Message type 0 is RUN_COMMAND in the i3 IPC protocol.
const RUN_COMMAND: u32 = 0;

/// The window class that i3 matches. It is the second value of `WM_CLASS`.
pub const WINDOW_CLASS: &str = "Deepwork-clock";

/// The i3 command that toggles the layout of this application's window.
pub fn command(floating: bool) -> String {
    if floating {
        format!("[class=\"{WINDOW_CLASS}\"] floating enable")
    } else {
        format!("[class=\"{WINDOW_CLASS}\"] floating disable")
    }
}

/// Ask the running tiling window manager to float or tile the window.
///
/// Returns `Ok(false)` when the session is not i3/sway, and `Ok(true)` when a
/// command was delivered. Delivery is not a promise that the window manager
/// changed anything.
pub fn set_floating(floating: bool) -> Result<bool, String> {
    let Some(path) = socket_path() else {
        return Ok(false);
    };
    let mut stream = UnixStream::connect(&path)
        .map_err(|error| format!("Could not reach the window manager at {path}: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| error.to_string())?;

    let payload = command(floating);
    let mut message = Vec::with_capacity(14 + payload.len());
    message.extend_from_slice(b"i3-ipc");
    message.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    message.extend_from_slice(&RUN_COMMAND.to_ne_bytes());
    message.extend_from_slice(payload.as_bytes());
    stream
        .write_all(&message)
        .map_err(|error| format!("Could not send the window manager command: {error}"))?;

    // Read the reply header so a broken socket does not leak into the next
    // command. The payload itself is not needed.
    let mut header = [0u8; 14];
    let _ = stream.read_exact(&mut header);
    Ok(true)
}

fn socket_path() -> Option<String> {
    if super::session_is_wayland() {
        return None;
    }
    ["I3SOCK", "SWAYSOCK"]
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_matches_the_application_class() {
        assert_eq!(command(true), "[class=\"Deepwork-clock\"] floating enable");
        assert_eq!(
            command(false),
            "[class=\"Deepwork-clock\"] floating disable"
        );
    }
}

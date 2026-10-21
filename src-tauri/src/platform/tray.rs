//! Tray adapter.
//!
//! The tray is a native menu, not a web view. On Linux the menu is always
//! reachable through the context menu of the tray icon, because desktop
//! environments differ in the way they deliver clicks on a tray icon. The
//! application therefore never depends on a left click.
//!
//! The menu is rebuilt from the timer state: the second entry reads "Start",
//! "Pause" or "Resume" depending on the current status.

use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime, Wry};

use deepwork_core::BridgeError;
use deepwork_engine::{Mode, Snapshot, Status};

/// Identifier of the tray icon.
pub const TRAY_ID: &str = "deepwork-clock-tray";

/// Menu item identifiers.
pub const MENU_SHOW: &str = "tray-show";
pub const MENU_TOGGLE: &str = "tray-toggle";
pub const MENU_NEXT: &str = "tray-next";
pub const MENU_QUIT: &str = "tray-quit";

/// What the tray menu can do in the current state.
///
/// The table follows the command table of the engine: a menu entry that the
/// engine would reject is disabled instead of failing after the click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrayActions {
    /// Label of the start/pause entry.
    pub toggle_label: &'static str,
    /// Whether the start/pause entry can be used.
    pub toggle_enabled: bool,
    /// Whether the next phase entry can be used.
    pub next_enabled: bool,
}

/// The actions for one snapshot.
pub fn actions_for(snapshot: &Snapshot) -> TrayActions {
    match snapshot.status {
        // Start is valid while a phase is idle.
        Status::Idle => TrayActions {
            toggle_label: "Start",
            toggle_enabled: true,
            // There is no phase to skip while the timer is idle.
            next_enabled: false,
        },
        Status::Running => TrayActions {
            toggle_label: "Pause",
            toggle_enabled: true,
            next_enabled: true,
        },
        Status::Paused => TrayActions {
            toggle_label: "Resume",
            toggle_enabled: true,
            next_enabled: true,
        },
        // A finished phase waits for the next phase. Only a cycle can move on
        // by itself; a countdown is restarted.
        Status::Completed => TrayActions {
            toggle_label: "Reset",
            toggle_enabled: true,
            next_enabled: snapshot.mode == Mode::Cycle,
        },
        // A recovered phase needs an explicit decision in the window, so the
        // tray only offers to show it.
        Status::RecoveryPending => TrayActions {
            toggle_label: "Resume or discard in the window",
            toggle_enabled: false,
            next_enabled: false,
        },
    }
}

/// The menu items whose label depends on the timer status.
pub struct TrayMenu<R: Runtime> {
    pub toggle: MenuItem<R>,
    pub next: MenuItem<R>,
}

/// The tray menu of the running application.
///
/// The state is managed by Tauri so that the service can keep the labels in
/// sync with the timer status.
pub struct TrayState<R: Runtime = Wry> {
    pub menu: TrayMenu<R>,
}

/// Builds the tray icon and its native menu.
///
/// The caller receives the identifiers of the activated menu item so that the
/// tray shares the same command path as the rest of the application.
pub fn build<R, F>(
    app: &AppHandle<R>,
    on_menu: F,
) -> Result<(tauri::tray::TrayIcon<R>, TrayMenu<R>), BridgeError>
where
    R: Runtime,
    F: Fn(&AppHandle<R>, &str) + Send + Sync + 'static,
{
    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        BridgeError::unsupported("The application has no icon for the system tray.")
    })?;

    let show = MenuItem::with_id(app, MENU_SHOW, "Show Deepwork Clock", true, None::<&str>)
        .map_err(|error| {
            BridgeError::internal(format!("Could not build the tray menu. {error}"))
        })?;
    let toggle =
        MenuItem::with_id(app, MENU_TOGGLE, "Start", true, None::<&str>).map_err(|error| {
            BridgeError::internal(format!("Could not build the tray menu. {error}"))
        })?;
    let next =
        MenuItem::with_id(app, MENU_NEXT, "Next phase", true, None::<&str>).map_err(|error| {
            BridgeError::internal(format!("Could not build the tray menu. {error}"))
        })?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>).map_err(|error| {
        BridgeError::internal(format!("Could not build the tray menu. {error}"))
    })?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&toggle)
        .item(&next)
        .separator()
        .item(&quit)
        .build()
        .map_err(|error| {
            BridgeError::internal(format!("Could not build the tray menu. {error}"))
        })?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Deepwork Clock")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let id = event.id().0.as_str();
            on_menu(app, id);
        })
        .build(app)
        .map_err(|error| {
            BridgeError::unsupported(format!(
                "This desktop did not accept a system tray icon. {error}"
            ))
        })?;

    Ok((tray, TrayMenu { toggle, next }))
}

/// Updates the label of the start/pause entry and enables the entries that
/// make sense for the current status.
pub fn update<R: Runtime>(menu: &TrayMenu<R>, snapshot: &Snapshot) {
    let actions = actions_for(snapshot);
    let _ = menu.toggle.set_text(actions.toggle_label);
    let _ = menu.toggle.set_enabled(actions.toggle_enabled);
    let _ = menu.next.set_enabled(actions.next_enabled);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(status: Status, mode: Mode) -> Snapshot {
        Snapshot {
            status,
            mode,
            ..deepwork_engine::Engine::new().snapshot()
        }
    }

    #[test]
    fn an_idle_timer_can_be_started_but_has_no_phase_to_skip() {
        let actions = actions_for(&snapshot(Status::Idle, Mode::Cycle));
        assert_eq!(actions.toggle_label, "Start");
        assert!(actions.toggle_enabled);
        assert!(!actions.next_enabled);
    }

    #[test]
    fn a_running_timer_can_be_paused_and_skipped() {
        let actions = actions_for(&snapshot(Status::Running, Mode::Cycle));
        assert_eq!(actions.toggle_label, "Pause");
        assert!(actions.toggle_enabled);
        assert!(actions.next_enabled);
    }

    #[test]
    fn a_paused_timer_can_be_resumed_and_skipped() {
        let actions = actions_for(&snapshot(Status::Paused, Mode::Cycle));
        assert_eq!(actions.toggle_label, "Resume");
        assert!(actions.toggle_enabled);
        assert!(actions.next_enabled);
    }

    #[test]
    fn a_finished_timer_can_advance_a_cycle_but_not_a_countdown() {
        let cycle = actions_for(&snapshot(Status::Completed, Mode::Cycle));
        assert!(cycle.next_enabled, "a cycle can move to the next phase");
        assert!(cycle.toggle_enabled, "a finished phase can be reset");

        let countdown = actions_for(&snapshot(Status::Completed, Mode::Countdown));
        assert!(
            !countdown.next_enabled,
            "a countdown has no next phase to advance to"
        );
    }

    #[test]
    fn a_recovered_phase_offers_no_start_and_no_skip() {
        let actions = actions_for(&snapshot(Status::RecoveryPending, Mode::Cycle));
        assert!(!actions.toggle_enabled, "start is invalid while recovering");
        assert!(!actions.next_enabled, "skip is invalid while recovering");
        assert!(actions.toggle_label.contains("window"));
    }
}

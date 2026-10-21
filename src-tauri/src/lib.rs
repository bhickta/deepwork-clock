//! Deepwork Clock — native backend.
//!
//! The backend owns the timer. The frontend only renders snapshots and sends
//! commands; it never decides when a phase completes.
//!
//! Structure:
//!
//! * `deepwork-engine` (a separate crate) is the pure timer state machine.
//! * `deepwork-core` (a separate crate) holds the durable stores, the
//!   validation and the service around the engine. It has no desktop
//!   dependency and is covered by unit tests.
//! * This crate adds Tauri: the bridge commands, the deadline thread, the
//!   tray, the window and the operating system adapters.

mod commands;
mod platform;
mod service;
mod storage;

use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, ShortcutState};

use deepwork_core::BridgeError;
use deepwork_engine::Action;
use tauri_plugin_autostart::ManagerExt as AutoStartManagerExt;

use crate::platform::shortcut::ShortcutPressState;
use crate::platform::tray::{MENU_NEXT, MENU_QUIT, MENU_SHOW, MENU_TOGGLE};
use crate::service::AppService;

/// Starts the application.
pub fn run() {
    // A key that is held down produces repeated press events. Only the first
    // press of a series is acted upon.
    let shortcut_state = ShortcutPressState::new();

    let builder = tauri::Builder::default()
        // The single instance plugin is registered first on purpose: a second
        // launch has to be recognised before the application writes any file
        // or restores any state.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            platform::window::focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            GlobalShortcutBuilder::new()
                .with_handler(move |app, _shortcut, event| match event.state() {
                    ShortcutState::Pressed => {
                        if shortcut_state.press() {
                            toggle_timer(app);
                        }
                    }
                    ShortcutState::Released => shortcut_state.release(),
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = storage::StorePaths::resolve(&handle)?;
            let store = storage::Store::new(paths);
            let host: Arc<dyn platform::host::PlatformHost> =
                Arc::new(platform::host::TauriHost::new(handle.clone()));
            let service = AppService::new(host, store)?;
            app.manage(service.clone());

            // The tray is optional. When the desktop does not accept a tray
            // icon the application keeps working and the window stays the
            // only way to reach it.
            match platform::tray::build(&handle, |app, id| {
                handle_tray_menu(app, id);
            }) {
                Ok((_tray, menu)) => {
                    service.set_tray_available(true);
                    app.manage(platform::tray::TrayState { menu });
                }
                Err(error) => {
                    service.report_warning(error);
                }
            }

            // Register the global shortcut that the user asked for.
            let settings = service.settings();
            if settings.global_shortcut_enabled {
                match platform::shortcut::register(&handle, &settings.global_shortcut) {
                    Ok(()) => service.set_shortcut_registered(true),
                    Err(error) => service.report_warning(error),
                }
            }

            // Keep the start at login registration in sync with the setting.
            if settings.launch_at_login {
                let registered = handle
                    .autolaunch()
                    .is_enabled()
                    .map_err(|error| format!("{error}"));
                match registered {
                    Ok(true) => {}
                    Ok(false) => {
                        if let Err(error) = handle.autolaunch().enable() {
                            service.report_warning(BridgeError::internal(format!(
                                "The application could not register itself to start when you log in. {error}"
                            )));
                        }
                    }
                    Err(error) => service.report_warning(BridgeError::internal(format!(
                        "The start at login registration could not be checked. {error}"
                    ))),
                }
            }

            // The deadline thread keeps running while the window is hidden.
            service::spawn_tick_thread(service.clone());
            service.publish_now();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let service = app.try_state::<Arc<AppService>>();
                let close_to_tray = service
                    .as_ref()
                    .map(|service| service.settings().close_to_tray)
                    .unwrap_or(false);
                let tray_reliable = service
                    .as_ref()
                    .map(|service| service.tray_is_reliable())
                    .unwrap_or(false);
                if close_to_tray && tray_reliable {
                    // A reliable restore path exists, so the window is only
                    // hidden.
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    // Closing quits by default. The application is never
                    // stranded without a way back.
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::timer_command,
            commands::get_settings,
            commands::save_settings,
            commands::get_capabilities,
            commands::get_warnings,
            commands::get_recovery,
            commands::window_action,
            commands::list_history,
            commands::export_history,
            commands::delete_history,
            commands::confirm_history,
        ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Deepwork Clock could not start: {error}");
            return;
        }
    };

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(service) = handle.try_state::<Arc<AppService>>() {
                service.shutdown();
            }
            platform::shortcut::unregister_all(handle);
        }
    });
}

/// Handles an entry of the tray menu.
fn handle_tray_menu(app: &AppHandle, id: &str) {
    match id {
        MENU_SHOW => platform::window::focus_main(app),
        MENU_TOGGLE => toggle_timer(app),
        MENU_NEXT => next_phase(app),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

/// Starts, pauses or resumes the timer.
///
/// The tray only offers the actions that the engine accepts in the current
/// state, so this never sends a command that the engine would reject.
fn toggle_timer(app: &AppHandle) {
    let Some(service) = app.try_state::<Arc<AppService>>() else {
        return;
    };
    let snapshot = service.snapshot();
    let action = match snapshot.status {
        deepwork_engine::Status::Idle => Action::Start,
        deepwork_engine::Status::Running => Action::Pause,
        deepwork_engine::Status::Paused => Action::Resume,
        deepwork_engine::Status::Completed => Action::Reset,
        deepwork_engine::Status::RecoveryPending => {
            // A recovered phase needs an explicit decision, so the window is
            // brought to the front instead of guessing.
            platform::window::focus_main(app);
            return;
        }
    };
    apply_trusted(app, action);
}

/// Moves on to the next phase.
///
/// Skipping an unfinished phase is destructive, so the user has to confirm
/// it. The confirmation is a native dialog, so it also works while the window
/// is hidden.
fn next_phase(app: &AppHandle) {
    let Some(service) = app.try_state::<Arc<AppService>>() else {
        return;
    };
    let snapshot = service.snapshot();
    match snapshot.status {
        // A finished phase moves on without a confirmation.
        deepwork_engine::Status::Completed if snapshot.mode == deepwork_engine::Mode::Cycle => {
            apply_trusted(app, Action::Advance);
        }
        deepwork_engine::Status::Running | deepwork_engine::Status::Paused => {
            confirm_skip(app);
        }
        _ => {}
    }
}

/// Asks the user before a running phase is skipped.
fn confirm_skip(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .message("Skip the running phase? This phase is not counted as focus time.")
        .title("Deepwork Clock")
        .buttons(MessageDialogButtons::OkCancel)
        .show_with_result(move |result| {
            if result != MessageDialogResult::Ok {
                return;
            }
            let handle = handle.clone();
            // The command runs on a worker thread so that the user interface
            // stays responsive while the state is stored.
            tauri::async_runtime::spawn(async move {
                apply_trusted(&handle, Action::Skip);
            });
        });
}

/// Applies a command that comes from the application itself.
///
/// The tray and the global shortcut are trusted callers: they always act on
/// the newest state and never carry a revision of their own.
fn apply_trusted(app: &AppHandle, action: Action) {
    let Some(service) = app.try_state::<Arc<AppService>>() else {
        return;
    };
    let elapsed = platform::clock::elapsed_ms();
    let now = chrono::Utc::now();
    if let Err(error) = service.apply_command(action, elapsed, now, None) {
        service.report_warning(error);
    }
}

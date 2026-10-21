//! The bridge between the frontend and the backend.
//!
//! Every command is allowlisted, validates its payload and returns either a
//! value or a structured error of the shape `{ code, message, snapshot? }`.
//! There is no shell bridge and no general purpose file system bridge.

use std::collections::BTreeMap;
use std::sync::Arc;

use chrono::Utc;
use deepwork_core::history::HistoryRecord;
use deepwork_core::{BridgeError, Settings};
use deepwork_engine::{Action, Snapshot};
use serde::Deserialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::platform;
use crate::platform::capabilities::Capability;
use crate::service::AppService;

/// One timer command.
///
/// Tauri extracts the argument named `request` from the payload and
/// deserialises it into this type, so the frontend sends
/// `{ request: { requestId, expectedRevision, action } }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerCommand {
    /// Identifier of the request. It is accepted for correlation only; the
    /// backend does not echo it back.
    #[serde(default)]
    #[allow(dead_code)]
    pub request_id: String,
    /// Revision the frontend believes to be current.
    pub expected_revision: u64,
    /// The action, tagged with `type`.
    pub action: Action,
}

/// One settings save.
///
/// The frontend sends `{ request: { expectedSettingsRevision, settings } }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettings {
    /// Revision the frontend believes to be current.
    pub expected_settings_revision: u64,
    /// The complete settings document.
    pub settings: Settings,
}

/// The current snapshot of the timer.
#[tauri::command]
pub fn get_snapshot(service: State<'_, Arc<AppService>>) -> Snapshot {
    service.snapshot()
}

/// Applies a timer command.
///
/// The frontend sends `{ request: { requestId, expectedRevision, action } }`.
#[tauri::command]
pub fn timer_command(
    service: State<'_, Arc<AppService>>,
    request: TimerCommand,
) -> Result<Snapshot, BridgeError> {
    let elapsed = platform::clock::elapsed_ms();
    let now = Utc::now();
    service.apply_command(
        request.action,
        elapsed,
        now,
        Some(request.expected_revision),
    )
}

/// The current settings.
#[tauri::command]
pub fn get_settings(service: State<'_, Arc<AppService>>) -> Settings {
    service.settings()
}

/// Stores the settings.
///
/// The frontend sends `{ request: { expectedSettingsRevision, settings } }`.
#[tauri::command]
pub fn save_settings(
    service: State<'_, Arc<AppService>>,
    request: SaveSettings,
) -> Result<Settings, BridgeError> {
    service.save_settings(request.settings, request.expected_settings_revision)
}

/// The capabilities of the current machine.
#[tauri::command]
pub fn get_capabilities(service: State<'_, Arc<AppService>>) -> BTreeMap<String, Capability> {
    service.capabilities()
}

/// The warnings that are still relevant.
///
/// A frontend that starts after a warning was raised - for example after a
/// restart that found damaged data - fetches the warnings once at startup so
/// that no message is lost. The same warnings are also sent as
/// `timer:error` events while the application runs.
#[tauri::command]
pub fn get_warnings(service: State<'_, Arc<AppService>>) -> Vec<BridgeError> {
    service.warnings()
}

/// The most recent durable checkpoint with its age.
///
/// The frontend shows the age of a recovered session, so the user can decide
/// whether to resume or to discard it.
#[tauri::command]
pub fn get_recovery(service: State<'_, Arc<AppService>>) -> Option<crate::service::RecoveryInfo> {
    service.recovery_info()
}

/// Performs an allowlisted window action.
///
/// The frontend sends `{ action: "compact" | "normal" | "pin" | "unpin" | "restore" }`.
#[tauri::command]
pub fn window_action(
    service: State<'_, Arc<AppService>>,
    action: String,
) -> Result<(), BridgeError> {
    service.window_action(&action)
}

/// The recorded history, newest first.
///
/// The frontend sends `{ limit, before? }`.
#[tauri::command]
pub fn list_history(
    service: State<'_, Arc<AppService>>,
    limit: u32,
    before: Option<String>,
) -> Vec<HistoryRecord> {
    service.list_history(limit, before.as_deref())
}

/// Exports the history through a save dialog owned by the backend.
///
/// The frontend sends `{ format: "csv" | "json" }`. `None` means that the
/// user cancelled the dialog.
#[tauri::command]
pub async fn export_history(
    app: AppHandle,
    service: State<'_, Arc<AppService>>,
    format: String,
) -> Result<Option<String>, BridgeError> {
    let records = service.all_history();
    let (file_name, filter_name, extensions, content) =
        match format.trim().to_ascii_lowercase().as_str() {
            "csv" => (
                "deepwork-history.csv".to_string(),
                "CSV".to_string(),
                vec!["csv"],
                deepwork_core::csv::records_to_csv(&records),
            ),
            "json" => (
                "deepwork-history.json".to_string(),
                "JSON".to_string(),
                vec!["json"],
                deepwork_core::csv::records_to_json(&records, Utc::now()),
            ),
            other => {
                return Err(BridgeError::invalid_state(format!(
                    "Unknown export format '{other}'. Use 'csv' or 'json'."
                )))
            }
        };

    let (sender, mut receiver) = tauri::async_runtime::channel::<Option<FilePath>>(1);
    app.dialog()
        .file()
        .set_title("Save session history")
        .set_file_name(&file_name)
        .add_filter(&filter_name, &extensions)
        .save_file(move |path| {
            let sender = sender.clone();
            tauri::async_runtime::spawn(async move {
                let _ = sender.send(path).await;
            });
        });

    let selected = receiver.recv().await.flatten();
    let Some(selected) = selected else {
        // The user cancelled the dialog.
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| {
        BridgeError::storage(format!("The chosen location cannot be used. {error}"))
    })?;
    std::fs::write(&path, content).map_err(|error| {
        BridgeError::storage(format!("The history could not be written. {error}"))
    })?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Removes every history entry.
///
/// The frontend sends `{ confirmation: "DELETE" }`.
#[tauri::command]
pub fn delete_history(
    service: State<'_, Arc<AppService>>,
    confirmation: String,
) -> Result<(), BridgeError> {
    service.delete_history(&confirmation)
}

/// Accepts an interrupted phase.
///
/// The frontend sends `{ phaseId: "..." }`; Tauri converts the argument name
/// to camel case.
#[tauri::command]
pub fn confirm_history(
    service: State<'_, Arc<AppService>>,
    phase_id: String,
) -> Result<(), BridgeError> {
    service.confirm_history(&phase_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::Manager;

    /// A mock application with a webview window that the commands are
    /// invoked through.
    struct TestApp {
        /// The application is kept alive while the webview is used.
        #[allow(dead_code)]
        app: tauri::App<tauri::test::MockRuntime>,
        webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
    }

    /// Builds a mock application with the real command handler and a managed
    /// service.
    fn app(directory: &std::path::Path) -> TestApp {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                get_snapshot,
                timer_command,
                get_settings,
                save_settings,
                get_capabilities,
                get_warnings,
                get_recovery,
                window_action,
                list_history,
                delete_history,
                confirm_history,
            ])
            .build(mock_context(noop_assets()))
            .expect("mock application");
        let store = crate::storage::Store::new(crate::storage::StorePaths {
            settings: directory.join("settings.json"),
            history: directory.join("history.json"),
            recovery: directory.join("recovery.json"),
        });
        let service = crate::service::AppService::new(
            Arc::new(crate::platform::host::test_host::TestHost::new()),
            store,
        )
        .expect("service");
        app.manage(service);
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        TestApp { app, webview }
    }

    /// Invokes a command the way the frontend does and returns the answer.
    fn invoke(app: &TestApp, cmd: &str, body: Value) -> Result<Value, Value> {
        let request = InvokeRequest {
            cmd: cmd.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost".parse().unwrap()
            } else {
                "tauri://localhost".parse().unwrap()
            },
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        match get_ipc_response(&app.webview, request) {
            Ok(response) => Ok(response.deserialize::<Value>().expect("json")),
            Err(error) => Err(error),
        }
    }

    #[test]
    fn the_frontend_payload_of_timer_command_is_accepted() {
        // Exactly the payload of `src/bridge.ts`:
        // invoke("timer_command", { request: { requestId, expectedRevision, action } })
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let snapshot = invoke(
            &app,
            "timer_command",
            json!({
                "request": {
                    "requestId": "r-1",
                    "expectedRevision": 1,
                    "action": { "type": "start" }
                }
            }),
        )
        .expect("the command must not fail");
        assert_eq!(snapshot["status"], "running", "{snapshot}");
        assert_eq!(snapshot["schemaVersion"], 1);
        assert!(snapshot["phaseId"].is_string());
    }

    #[test]
    fn a_stale_revision_is_reported_as_an_error_with_a_snapshot() {
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let error = invoke(
            &app,
            "timer_command",
            json!({
                "request": {
                    "requestId": "r-1",
                    "expectedRevision": 99,
                    "action": { "type": "start" }
                }
            }),
        )
        .expect_err("the command must fail");
        assert_eq!(error["code"], "STALE_REVISION", "{error}");
        assert!(error["message"].is_string());
        assert_eq!(error["snapshot"]["status"], "idle", "{error}");
    }

    #[test]
    fn the_frontend_payload_of_save_settings_is_accepted() {
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let settings = invoke(&app, "get_settings", json!({})).expect("settings");
        let saved = invoke(
            &app,
            "save_settings",
            json!({
                "request": {
                    "expectedSettingsRevision": settings["revision"],
                    "settings": settings
                }
            }),
        )
        .expect("the command must not fail");
        assert_eq!(saved["revision"], 1, "{saved}");
        assert_eq!(saved["schemaVersion"], 1);
    }

    #[test]
    fn the_flat_history_payloads_are_accepted() {
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let history = invoke(&app, "list_history", json!({ "limit": 10 })).expect("history");
        assert!(history.is_array(), "{history}");

        // The cursor is optional.
        let history = invoke(
            &app,
            "list_history",
            json!({ "limit": 10, "before": "2026-01-01T00:00:00Z" }),
        )
        .expect("history");
        assert!(history.is_array(), "{history}");

        let error = invoke(
            &app,
            "delete_history",
            json!({ "confirmation": "NOT_DELETE" }),
        )
        .expect_err("the command must fail");
        assert_eq!(error["code"], "INVALID_STATE", "{error}");
    }

    #[test]
    fn confirming_an_unknown_phase_is_reported_as_an_error() {
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let error = invoke(
            &app,
            "confirm_history",
            json!({ "phaseId": "does-not-exist" }),
        )
        .expect_err("the command must fail");
        assert_eq!(error["code"], "INVALID_STATE", "{error}");
    }

    #[test]
    fn an_unknown_window_action_is_refused() {
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let error = invoke(&app, "window_action", json!({ "action": "close" }))
            .expect_err("the command must fail");
        assert_eq!(error["code"], "INVALID_STATE", "{error}");
    }

    #[test]
    fn the_capability_report_has_the_contract_shape() {
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let capabilities = invoke(&app, "get_capabilities", json!({})).expect("capabilities");
        for name in [
            "pin",
            "tray",
            "globalShortcut",
            "notifications",
            "autostart",
        ] {
            assert!(
                capabilities[name].is_object(),
                "{name} is missing in {capabilities}"
            );
            let state = capabilities[name]["state"].as_str().unwrap_or_default();
            assert!(
                ["available", "unavailable", "permission_required", "unknown"].contains(&state),
                "unexpected state {state} for {name}"
            );
            assert!(capabilities[name]["reason"].is_string());
        }
    }

    #[test]
    fn the_warning_report_has_the_contract_shape() {
        let directory = tempfile::tempdir().expect("temp dir");
        let app = app(directory.path());
        let warnings = invoke(&app, "get_warnings", json!({})).expect("warnings");
        assert!(warnings.is_array(), "{warnings}");
    }
}

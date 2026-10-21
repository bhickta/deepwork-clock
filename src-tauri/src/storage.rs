//! Application level persistence.
//!
//! The pure file handling lives in `deepwork-core`; this module adds the
//! locations that the operating system provides and the policy for damaged
//! files:
//!
//! * a malformed or oversized document is quarantined next to the original
//!   and the application continues with safe defaults,
//! * a document from a newer schema version is refused and never written to,
//! * a write failure never stops the timer; it is reported as a warning and
//!   the previous good copy stays in place.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use deepwork_core::history::{HistoryBook, HistoryFile};
use deepwork_core::recovery::RecoveryRecord;
use deepwork_core::settings::Settings;
use deepwork_core::storage::{self, StorageError};
use deepwork_core::BridgeError;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The files that the application owns.
#[derive(Debug, Clone)]
pub struct StorePaths {
    pub settings: PathBuf,
    pub history: PathBuf,
    pub recovery: PathBuf,
}

impl StorePaths {
    /// Uses the configuration and data directories of the operating system.
    pub fn resolve(app: &AppHandle) -> Result<Self, BridgeError> {
        let config_dir = app.path().app_config_dir().map_err(|error| {
            BridgeError::storage(format!("No configuration directory. {error}"))
        })?;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| BridgeError::storage(format!("No data directory. {error}")))?;
        Ok(Self {
            settings: config_dir.join("settings.json"),
            history: data_dir.join("history.json"),
            recovery: data_dir.join("recovery.json"),
        })
    }
}

/// The result of loading a document.
#[derive(Debug)]
pub struct LoadOutcome<T> {
    pub value: T,
    /// A problem that was recovered from, for example a quarantined file.
    pub warning: Option<BridgeError>,
}

/// Reads and writes the durable documents.
#[derive(Debug)]
pub struct Store {
    paths: StorePaths,
    /// Documents that must not be written because they were written by a
    /// newer version of the application.
    locked: Mutex<HashSet<PathBuf>>,
}

impl Store {
    pub fn new(paths: StorePaths) -> Self {
        Self {
            paths,
            locked: Mutex::new(HashSet::new()),
        }
    }

    /// The files that the store owns.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn paths(&self) -> &StorePaths {
        &self.paths
    }

    pub fn load_settings(&self) -> Result<LoadOutcome<Settings>, BridgeError> {
        let outcome = self.load_document(
            &self.paths.settings,
            storage::MAX_SETTINGS_BYTES,
            Some(Settings::default()),
            |settings| settings.schema_version,
        )?;
        Ok(LoadOutcome {
            value: outcome.value.unwrap_or_default(),
            warning: outcome.warning,
        })
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), BridgeError> {
        self.save_document(&self.paths.settings, settings)
    }

    pub fn load_history(&self) -> Result<LoadOutcome<HistoryBook>, BridgeError> {
        let outcome = self.load_document(
            &self.paths.history,
            storage::MAX_HISTORY_BYTES,
            Some(HistoryFile::default()),
            |file| file.schema_version,
        )?;
        Ok(LoadOutcome {
            value: HistoryBook::new(outcome.value.unwrap_or_default().records),
            warning: outcome.warning,
        })
    }

    pub fn save_history(&self, book: &HistoryBook) -> Result<(), BridgeError> {
        let file = HistoryFile {
            schema_version: deepwork_core::settings::SETTINGS_SCHEMA_VERSION,
            records: book.records().to_vec(),
        };
        self.save_document(&self.paths.history, &file)
    }

    pub fn load_recovery(&self) -> Result<LoadOutcome<Option<RecoveryRecord>>, BridgeError> {
        self.load_document(
            &self.paths.recovery,
            storage::MAX_RECOVERY_BYTES,
            None,
            |record| record.schema_version,
        )
    }

    pub fn save_recovery(&self, record: &RecoveryRecord) -> Result<(), BridgeError> {
        self.save_document(&self.paths.recovery, record)
    }

    pub fn clear_recovery(&self) -> Result<(), BridgeError> {
        self.remove_document(&self.paths.recovery)
    }

    fn is_locked(&self, path: &Path) -> bool {
        self.locked
            .lock()
            .map(|locked| locked.contains(path))
            .unwrap_or(false)
    }

    fn lock(&self, path: &Path) {
        if let Ok(mut locked) = self.locked.lock() {
            locked.insert(path.to_path_buf());
        }
    }

    fn load_document<T, F>(
        &self,
        path: &Path,
        limit: u64,
        default: Option<T>,
        schema_version: F,
    ) -> Result<LoadOutcome<Option<T>>, BridgeError>
    where
        T: DeserializeOwned + Serialize,
        F: Fn(&T) -> u32,
    {
        if !path.exists() {
            return Ok(LoadOutcome {
                value: default,
                warning: None,
            });
        }

        let bytes = match storage::read_limited(path, limit) {
            Ok(bytes) => bytes,
            Err(StorageError::TooLarge { .. }) | Err(StorageError::Corrupt(_)) => {
                let warning = self.quarantine(path);
                return Ok(LoadOutcome {
                    value: default,
                    warning: Some(warning),
                });
            }
            Err(error) => return Err(storage::to_bridge_error(&error)),
        };

        let value: T = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_error) => {
                // The document cannot be parsed, so it is set aside and the
                // application continues with safe defaults.
                let warning = self.quarantine(path);
                return Ok(LoadOutcome {
                    value: default,
                    warning: Some(warning),
                });
            }
        };

        let found = schema_version(&value);
        if found > deepwork_core::settings::SETTINGS_SCHEMA_VERSION {
            // Refuse the document instead of deleting or overwriting it.
            self.lock(path);
            return Err(BridgeError::unsupported(format!(
                "Stored data uses schema version {found}; this build supports {}. The file was left untouched.",
                deepwork_core::settings::SETTINGS_SCHEMA_VERSION
            )));
        }

        Ok(LoadOutcome {
            value: Some(value),
            warning: None,
        })
    }

    fn save_document<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), BridgeError> {
        if self.is_locked(path) {
            return Err(BridgeError::unsupported(
                "The stored file uses a newer schema and was left untouched.",
            ));
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
            BridgeError::internal(format!("Could not encode the data. {error}"))
        })?;
        storage::write_atomic(path, &bytes).map_err(|error| storage::to_bridge_error(&error))
    }

    fn remove_document(&self, path: &Path) -> Result<(), BridgeError> {
        storage::remove_file(path).map_err(|error| storage::to_bridge_error(&error))
    }

    fn quarantine(&self, path: &Path) -> BridgeError {
        let stamp = storage::quarantine_stamp();
        match storage::quarantine_file(path, &stamp) {
            Ok(target) => BridgeError::corrupt(format!(
                "Stored data could not be read. It was kept as {}.",
                target
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "a backup file".to_string())
            )),
            Err(error) => {
                // The original must not be overwritten, so the path is locked.
                self.lock(path);
                BridgeError::corrupt(format!(
                    "Stored data could not be read and could not be set aside. {error}"
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepwork_core::settings::SETTINGS_SCHEMA_VERSION;

    fn store(directory: &Path) -> Store {
        Store::new(StorePaths {
            settings: directory.join("settings.json"),
            history: directory.join("history.json"),
            recovery: directory.join("recovery.json"),
        })
    }

    #[test]
    fn missing_documents_produce_defaults_without_a_warning() {
        let directory = tempfile::tempdir().expect("temp dir");
        let store = store(directory.path());
        let outcome = store.load_settings().expect("load");
        assert!(outcome.warning.is_none());
        assert_eq!(outcome.value.revision, 0);
        assert_eq!(outcome.value.theme, deepwork_core::settings::Theme::System);
    }

    #[test]
    fn settings_round_trip() {
        let directory = tempfile::tempdir().expect("temp dir");
        let store = store(directory.path());
        let mut settings = Settings::default();
        settings.theme = deepwork_core::settings::Theme::Dark;
        settings.text_scale = 1.5;
        settings.revision = 3;
        store.save_settings(&settings).expect("save");
        let outcome = store.load_settings().expect("load");
        assert!(outcome.warning.is_none());
        assert_eq!(outcome.value.theme, deepwork_core::settings::Theme::Dark);
        assert_eq!(outcome.value.text_scale, 1.5);
        assert_eq!(outcome.value.revision, 3);
    }

    #[test]
    fn a_corrupt_document_is_quarantined_and_never_overwritten() {
        let directory = tempfile::tempdir().expect("temp dir");
        let store = store(directory.path());
        std::fs::write(&store.paths().settings, b"{ this is not json").expect("write");
        let outcome = store.load_settings().expect("load");
        assert!(outcome.warning.is_some(), "a warning is expected");
        assert_eq!(outcome.value.revision, 0);
        assert!(!store.paths().settings.exists(), "the file was set aside");
        let quarantined: Vec<_> = std::fs::read_dir(directory.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("quarantine"))
            .collect();
        assert_eq!(quarantined.len(), 1, "{quarantined:?}");
        let content = std::fs::read(directory.path().join(&quarantined[0])).expect("read");
        assert_eq!(content, b"{ this is not json");
    }

    #[test]
    fn a_future_schema_document_is_refused_and_never_overwritten() {
        let directory = tempfile::tempdir().expect("temp dir");
        let store = store(directory.path());
        let future = format!(
            "{{\"schemaVersion\":{},\"revision\":1}}",
            SETTINGS_SCHEMA_VERSION + 1
        );
        std::fs::write(&store.paths().settings, future.as_bytes()).expect("write");

        let error = store.load_settings().expect_err("refused");
        assert_eq!(error.code, deepwork_core::CODE_UNSUPPORTED);

        // The document must survive every later write attempt.
        let error = store
            .save_settings(&Settings::default())
            .expect_err("refused");
        assert_eq!(error.code, deepwork_core::CODE_UNSUPPORTED);
        let content = std::fs::read(&store.paths().settings).expect("read");
        assert_eq!(content, future.as_bytes());
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("read dir")
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().contains("quarantine"))
                .count(),
            0,
            "a future document is not corrupt, so it is not quarantined"
        );
    }

    #[test]
    fn two_corrupt_documents_in_the_same_second_keep_both_copies() {
        let directory = tempfile::tempdir().expect("temp dir");
        let store = store(directory.path());
        std::fs::write(&store.paths().settings, b"first").expect("write");
        let _ = store.load_settings();
        std::fs::write(&store.paths().settings, b"second").expect("write");
        let _ = store.load_settings();
        let quarantined: Vec<_> = std::fs::read_dir(directory.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains("quarantine"))
            .collect();
        assert_eq!(quarantined.len(), 2, "both copies are kept");
    }

    #[test]
    fn the_history_round_trips_and_keeps_one_record_per_phase() {
        let directory = tempfile::tempdir().expect("temp dir");
        let store = store(directory.path());
        let mut book = deepwork_core::HistoryBook::default();
        book.upsert(record("phase-1", "completed"));
        book.upsert(record("phase-1", "completed"));
        store.save_history(&book).expect("save");
        let outcome = store.load_history().expect("load");
        assert!(outcome.warning.is_none());
        assert_eq!(outcome.value.len(), 1);
    }

    fn record(phase_id: &str, outcome: &str) -> deepwork_core::HistoryRecord {
        deepwork_core::HistoryRecord {
            phase_id: phase_id.to_string(),
            phase: deepwork_core::HistoryPhase::Focus,
            started_at: "2026-01-01T10:00:00Z".to_string(),
            ended_at: "2026-01-01T10:25:00Z".to_string(),
            duration_ms: 1_500_000,
            label: String::new(),
            outcome: if outcome == "completed" {
                deepwork_core::HistoryOutcome::Completed
            } else {
                deepwork_core::HistoryOutcome::Ended
            },
            interrupted: false,
            confirmed: true,
            local_date: "2026-01-01".to_string(),
        }
    }
}

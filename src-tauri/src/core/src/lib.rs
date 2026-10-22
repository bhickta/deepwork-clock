//! Desktop-free logic for Deepwork Clock.
//!
//! This crate deliberately contains no Tauri, no windowing and no notification
//! code so that the durable parts of the application (settings, history,
//! recovery checkpoints, atomic file replacement and the timer service) can be
//! exercised by `cargo test` on any machine, with or without a display server.
//!
//! The crate depends on `deepwork-engine`, which owns the pure timer state
//! machine. `deepwork-core` adds the persistence and validation layers around
//! it.

pub mod csv;
pub mod markdown;
pub mod error;
pub mod history;
pub mod recovery;
pub mod service;
pub mod settings;
pub mod storage;

pub use csv::{escape_cell, records_to_csv, records_to_json};
pub use error::{
    BridgeError, CODE_CORRUPT_DATA, CODE_INTERNAL, CODE_INVALID_DURATION, CODE_INVALID_STATE,
    CODE_PERMISSION_DENIED, CODE_SHORTCUT_CONFLICT, CODE_STALE_REVISION, CODE_STORAGE_UNAVAILABLE,
    CODE_UNSUPPORTED,
};
pub use history::{
    HistoryBook, HistoryOutcome, HistoryPhase, HistoryRecord, DEFAULT_RETENTION_DAYS,
    MAX_HISTORY_RECORDS,
};
pub use recovery::RecoveryRecord;
pub use service::TimerService;
pub use settings::{
    validate_config, Settings, Theme, ViewMode, MAX_DURATION_MS, MAX_LABEL_CHARS,
    MAX_RETENTION_DAYS, MAX_TEXT_SCALE, MIN_DURATION_MS, MIN_RETENTION_DAYS, MIN_TEXT_SCALE,
    SETTINGS_SCHEMA_VERSION,
};
pub use storage::{
    quarantine_file, read_limited, write_atomic, StorageError, MAX_HISTORY_BYTES,
    MAX_RECOVERY_BYTES, MAX_SETTINGS_BYTES,
};

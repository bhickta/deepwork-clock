//! Structured, serialisable errors shared by the bridge and the storage layer.
//!
//! The frontend contract fixes the wire shape to `{ code, message, snapshot? }`.
//! The set of stable codes is fixed as well, so every failure that can reach
//! the user interface is normalised into one of the codes below. Diagnostic
//! detail never travels to the frontend; it stays in the local log.

use deepwork_engine::{EngineError, Snapshot};
use serde::{Deserialize, Serialize};

pub const CODE_INVALID_DURATION: &str = "INVALID_DURATION";
pub const CODE_INVALID_STATE: &str = "INVALID_STATE";
pub const CODE_STALE_REVISION: &str = "STALE_REVISION";
pub const CODE_STORAGE_UNAVAILABLE: &str = "STORAGE_UNAVAILABLE";
pub const CODE_UNSUPPORTED: &str = "UNSUPPORTED";
pub const CODE_SHORTCUT_CONFLICT: &str = "SHORTCUT_CONFLICT";
pub const CODE_PERMISSION_DENIED: &str = "PERMISSION_DENIED";
pub const CODE_CORRUPT_DATA: &str = "CORRUPT_DATA";
pub const CODE_INTERNAL: &str = "INTERNAL";

/// Extension to the stable code list of PLAN section 6.
///
/// The engine rejects a label that is longer than the documented cap with
/// this code instead of silently truncating user data.
pub const CODE_INVALID_LABEL: &str = "INVALID_LABEL";

/// Every error that can be returned through a Tauri command.
///
/// `snapshot` carries the newest authoritative state for commands that failed
/// because the client was out of date, so the interface can refresh without
/// guessing. The snapshot is boxed, because a large error type would be
/// copied on every failed call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Box<Snapshot>>,
}

impl BridgeError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            snapshot: None,
        }
    }

    pub fn with_snapshot(mut self, snapshot: Snapshot) -> Self {
        self.snapshot = Some(Box::new(snapshot));
        self
    }

    pub fn invalid_duration(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_DURATION, message)
    }

    pub fn invalid_state(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_STATE, message)
    }

    pub fn stale(message: impl Into<String>, snapshot: Snapshot) -> Self {
        Self::new(CODE_STALE_REVISION, message).with_snapshot(snapshot)
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(CODE_STORAGE_UNAVAILABLE, message)
    }

    pub fn corrupt(message: impl Into<String>) -> Self {
        Self::new(CODE_CORRUPT_DATA, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(CODE_UNSUPPORTED, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CODE_INTERNAL, message)
    }
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BridgeError {}

impl From<EngineError> for BridgeError {
    fn from(error: EngineError) -> Self {
        // The engine already uses the stable code vocabulary. Unknown codes are
        // mapped to INTERNAL so the frontend never has to deal with a new
        // string.
        let known = [
            CODE_INVALID_DURATION,
            CODE_INVALID_LABEL,
            CODE_INVALID_STATE,
            CODE_STALE_REVISION,
            CODE_STORAGE_UNAVAILABLE,
            CODE_UNSUPPORTED,
            CODE_SHORTCUT_CONFLICT,
            CODE_PERMISSION_DENIED,
            CODE_CORRUPT_DATA,
            CODE_INTERNAL,
        ];
        let code = if known.contains(&error.code.as_str()) {
            error.code.clone()
        } else {
            CODE_INTERNAL.to_string()
        };
        Self::new(&code, error.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_without_snapshot_field_when_absent() {
        let error = BridgeError::invalid_duration("too long");
        let json = serde_json::to_string(&error).expect("serialise");
        assert!(!json.contains("snapshot"), "{json}");
        assert!(json.contains("\"code\":\"INVALID_DURATION\""), "{json}");
    }

    #[test]
    fn serialises_snapshot_when_present() {
        let error = BridgeError::stale("out of date", deepwork_engine::Engine::new().snapshot());
        let json = serde_json::to_string(&error).expect("serialise");
        assert!(json.contains("\"snapshot\""), "{json}");
    }

    #[test]
    fn unknown_engine_code_becomes_internal() {
        let error = BridgeError::from(EngineError {
            code: "WEIRD".to_string(),
            message: "odd".to_string(),
        });
        assert_eq!(error.code, CODE_INTERNAL);
    }

    #[test]
    fn known_engine_code_is_preserved() {
        let error = BridgeError::from(EngineError {
            code: CODE_INVALID_STATE.to_string(),
            message: "odd".to_string(),
        });
        assert_eq!(error.code, CODE_INVALID_STATE);
    }
}

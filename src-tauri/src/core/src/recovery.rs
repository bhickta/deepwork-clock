//! Durable recovery checkpoints.
//!
//! A checkpoint is written whenever the timer changes phase or every thirty
//! seconds while a phase is running. It contains everything that is needed to
//! offer a recovery choice after a restart, and nothing that would resume the
//! timer on its own: restoring a checkpoint always yields
//! `recovery_pending`, never a running phase.

use deepwork_engine::{Config, Snapshot};
use serde::{Deserialize, Serialize};

pub const RECOVERY_SCHEMA_VERSION: u32 = 1;

/// One durable checkpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub schema_version: u32,
    /// RFC 3339 UTC timestamp of the checkpoint.
    pub saved_at: String,
    /// RFC 3339 UTC timestamp of the moment the current phase started.
    #[serde(default)]
    pub phase_started_at: Option<String>,
    /// The engine snapshot at the time of the checkpoint.
    pub snapshot: Snapshot,
    /// The configuration frozen for the running session.
    pub config: Config,
}

impl RecoveryRecord {
    pub fn new(
        saved_at: String,
        phase_started_at: Option<String>,
        snapshot: Snapshot,
        config: Config,
    ) -> Self {
        Self {
            schema_version: RECOVERY_SCHEMA_VERSION,
            saved_at,
            phase_started_at,
            snapshot,
            config,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_case_field_names() {
        let json = serde_json::to_string(&RecoveryRecord {
            schema_version: RECOVERY_SCHEMA_VERSION,
            saved_at: "2026-01-01T00:00:00Z".to_string(),
            phase_started_at: None,
            snapshot: deepwork_engine::Engine::new().snapshot(),
            config: Config::default(),
        })
        .expect("serialise");
        assert!(json.contains("\"schemaVersion\""), "{json}");
        assert!(json.contains("\"savedAt\""), "{json}");
        assert!(json.contains("\"phaseStartedAt\""), "{json}");
    }

    #[test]
    fn missing_phase_start_is_tolerated() {
        let mut record = RecoveryRecord::new(
            "2026-01-01T00:00:00Z".to_string(),
            None,
            deepwork_engine::Engine::new().snapshot(),
            Config::default(),
        );
        record.phase_started_at = None;
        let parsed: RecoveryRecord =
            serde_json::from_str(&serde_json::to_string(&record).expect("serialise"))
                .expect("parse");
        assert!(parsed.phase_started_at.is_none());
    }
}

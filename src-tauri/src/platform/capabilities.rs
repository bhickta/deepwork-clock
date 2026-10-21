//! Capability reporting.
//!
//! A capability is reported as `available`, `unavailable`,
//! `permission_required` or `unknown`. The states are deliberately
//! conservative: a request that was merely accepted is not the same as an
//! integration that was observed working, so anything that depends on the
//! desktop environment is reported as `unknown` with a readable reason.

use serde::Serialize;

/// The state of one platform capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    Available,
    Unavailable,
    PermissionRequired,
    Unknown,
}

/// One capability with a short, user facing explanation.
#[derive(Debug, Clone, Serialize)]
pub struct Capability {
    pub state: CapabilityState,
    pub reason: String,
}

impl Capability {
    pub fn new(state: CapabilityState, reason: impl Into<String>) -> Self {
        Self {
            state,
            reason: reason.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_use_the_contract_names() {
        assert_eq!(
            serde_json::to_string(&CapabilityState::Available).expect("json"),
            "\"available\""
        );
        assert_eq!(
            serde_json::to_string(&CapabilityState::PermissionRequired).expect("json"),
            "\"permission_required\""
        );
        assert_eq!(
            serde_json::to_string(&CapabilityState::Unknown).expect("json"),
            "\"unknown\""
        );
        assert_eq!(
            serde_json::to_string(&CapabilityState::Unavailable).expect("json"),
            "\"unavailable\""
        );
    }

    #[test]
    fn a_capability_carries_a_reason() {
        let capability = Capability::new(CapabilityState::Unknown, "depends on the desktop");
        let json = serde_json::to_string(&capability).expect("json");
        assert!(json.contains("\"state\":\"unknown\""), "{json}");
        assert!(
            json.contains("\"reason\":\"depends on the desktop\""),
            "{json}"
        );
    }
}

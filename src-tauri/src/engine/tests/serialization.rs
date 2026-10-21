//! The serialized contract: field names, enum values and tagged enums.

use crate::tests::{apply, engine, started_engine};
use crate::{Action, Config, Effect, EngineError, Mode, Phase, Snapshot, Status, Transition};
use serde_json::Value;

#[test]
fn the_snapshot_uses_camel_case_fields_and_snake_case_values() {
    let engine = engine();
    let json = serde_json::to_string(&engine.snapshot()).expect("serialisable");
    let value: Value = serde_json::from_str(&json).expect("valid json");

    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["mode"], "cycle");
    assert_eq!(value["phase"], "focus");
    assert_eq!(value["status"], "idle");
    assert_eq!(value["durationMs"], 3_000_000);
    assert_eq!(value["remainingMs"], 3_000_000);
    assert_eq!(value["completedFocusCount"], 0);
    assert_eq!(value["interrupted"], false);
    assert_eq!(value["label"], "");
    assert!(value["sessionId"].is_null(), "an absent session is null");
    assert!(
        value["phaseId"].is_string(),
        "the phase id is always present"
    );

    for snake_case in [
        "schema_version",
        "session_id",
        "phase_id",
        "duration_ms",
        "remaining_ms",
        "completed_focus_count",
    ] {
        assert!(
            value.get(snake_case).is_none(),
            "{snake_case} must not be part of the contract"
        );
    }
}

#[test]
fn the_configuration_uses_camel_case_fields() {
    let config = Config::default();
    let json = serde_json::to_string(&config).expect("serialisable");
    assert_eq!(
        json,
        r#"{"mode":"cycle","focusMs":3000000,"shortBreakMs":600000,"longBreakMs":1800000,"longBreakInterval":4,"label":""}"#
    );
}

#[test]
fn the_actions_are_tagged_with_their_type() {
    let cases = [
        (Action::Start, r#"{"type":"start"}"#),
        (Action::Pause, r#"{"type":"pause"}"#),
        (Action::Resume, r#"{"type":"resume"}"#),
        (Action::Reset, r#"{"type":"reset"}"#),
        (Action::Skip, r#"{"type":"skip"}"#),
        (Action::Advance, r#"{"type":"advance"}"#),
        (Action::End, r#"{"type":"end"}"#),
        (Action::AcceptRecovery, r#"{"type":"accept_recovery"}"#),
        (Action::DiscardRecovery, r#"{"type":"discard_recovery"}"#),
    ];
    for (action, expected) in cases {
        assert_eq!(
            serde_json::to_string(&action).expect("serialisable"),
            expected
        );
        let parsed: Action = serde_json::from_str(expected).expect("deserialisable");
        assert_eq!(parsed, action);
    }
}

#[test]
fn the_configure_action_carries_the_configuration() {
    let action = Action::Configure {
        config: Config::default(),
    };
    let json = serde_json::to_string(&action).expect("serialisable");
    assert_eq!(
        json,
        r#"{"type":"configure","config":{"mode":"cycle","focusMs":3000000,"shortBreakMs":600000,"longBreakMs":1800000,"longBreakInterval":4,"label":""}}"#
    );
    let parsed: Action = serde_json::from_str(&json).expect("deserialisable");
    assert_eq!(parsed, action);
}

#[test]
fn the_effects_are_tagged_with_camel_case_fields() {
    let effect = Effect::PhaseCompleted {
        phase_id: "phase-1".to_string(),
        phase: Phase::Focus,
        duration_ms: 3_000_000,
        label: "Deep work".to_string(),
        interrupted: false,
    };
    let json = serde_json::to_string(&effect).expect("serialisable");
    assert_eq!(
        json,
        r#"{"type":"phase_completed","phaseId":"phase-1","phase":"focus","durationMs":3000000,"label":"Deep work","interrupted":false}"#
    );
    let parsed: Effect = serde_json::from_str(&json).expect("deserialisable");
    assert_eq!(parsed, effect);

    let skipped = Effect::PhaseSkipped {
        phase_id: "phase-2".to_string(),
        phase: Phase::ShortBreak,
        duration_ms: 600_000,
        label: String::new(),
        interrupted: true,
    };
    let json = serde_json::to_string(&skipped).expect("serialisable");
    assert_eq!(
        json,
        r#"{"type":"phase_skipped","phaseId":"phase-2","phase":"short_break","durationMs":600000,"label":"","interrupted":true}"#
    );

    let ended = Effect::SessionEnded {
        phase_id: "phase-3".to_string(),
        phase: Phase::LongBreak,
        duration_ms: 1_800_000,
        label: String::new(),
        interrupted: false,
    };
    let json = serde_json::to_string(&ended).expect("serialisable");
    assert_eq!(
        json,
        r#"{"type":"session_ended","phaseId":"phase-3","phase":"long_break","durationMs":1800000,"label":"","interrupted":false}"#
    );
}

#[test]
fn the_transition_carries_the_snapshot_and_the_effects() {
    let mut engine = started_engine();
    let transition = engine.tick(3_000_000);
    let json = serde_json::to_string(&transition).expect("serialisable");
    let value: Value = serde_json::from_str(&json).expect("valid json");
    assert!(value["snapshot"].is_object());
    assert_eq!(value["effects"].as_array().expect("an array").len(), 1);
    let parsed: Transition = serde_json::from_str(&json).expect("deserialisable");
    assert_eq!(parsed, transition);
}

#[test]
fn the_error_carries_a_code_and_a_message() {
    let error = EngineError::invalid_state("start requires the timer to be idle");
    let json = serde_json::to_string(&error).expect("serialisable");
    assert_eq!(
        json,
        r#"{"code":"INVALID_STATE","message":"start requires the timer to be idle"}"#
    );
    let parsed: EngineError = serde_json::from_str(&json).expect("deserialisable");
    assert_eq!(parsed, error);
}

#[test]
fn a_snapshot_round_trips_through_serialization() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let snapshot: Snapshot = engine.snapshot();
    let json = serde_json::to_string(&snapshot).expect("serialisable");
    let parsed: Snapshot = serde_json::from_str(&json).expect("deserialisable");
    assert_eq!(parsed, snapshot);
    assert_eq!(parsed.status, Status::Running);
    assert_eq!(parsed.mode, Mode::Cycle);
}

#[test]
fn a_snapshot_with_an_unknown_field_is_still_parsable() {
    let json = r#"{"schemaVersion":1,"revision":4,"sessionId":null,"phaseId":null,"mode":"cycle","phase":"focus","status":"idle","durationMs":3000000,"remainingMs":3000000,"completedFocusCount":0,"label":"","interrupted":false,"futureField":42}"#;
    let parsed: Snapshot = serde_json::from_str(json).expect("unknown fields are ignored");
    assert_eq!(parsed.revision, 4);
}

#[test]
fn the_engine_survives_a_serialization_round_trip_of_a_transition() {
    let mut engine = started_engine();
    let transition = apply(&mut engine, Action::Skip, 0);
    let json = serde_json::to_string(&transition).expect("serialisable");
    let parsed: Transition = serde_json::from_str(&json).expect("deserialisable");
    assert_eq!(parsed.snapshot.status, Status::Idle);
    assert_eq!(parsed.effects.len(), 1);
}

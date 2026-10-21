//! Recovery, interruption and restore behaviour.

use crate::tests::{apply, engine, started_engine};
use crate::{Action, Config, Engine, EngineError, Snapshot, Status};

#[test]
fn restore_of_a_running_snapshot_is_recovery_pending() {
    let mut running = started_engine();
    running.tick(1_000);
    let snapshot = running.snapshot();
    let restored = Engine::restore(snapshot.clone(), Config::default()).expect("restorable");
    let after = restored.snapshot();
    assert_eq!(after.status, Status::RecoveryPending);
    assert_eq!(after.remaining_ms, snapshot.remaining_ms);
    assert_eq!(after.duration_ms, snapshot.duration_ms);
    assert_eq!(after.phase_id, snapshot.phase_id);
    assert_eq!(after.session_id, snapshot.session_id);
    assert_eq!(after.completed_focus_count, snapshot.completed_focus_count);
    assert_eq!(
        after.revision,
        snapshot.revision + 1,
        "the restored state is a new revision"
    );
}

#[test]
fn restore_of_a_paused_snapshot_is_recovery_pending() {
    let mut paused = started_engine();
    apply(&mut paused, Action::Pause, 1_000);
    let snapshot = paused.snapshot();
    let restored = Engine::restore(snapshot.clone(), Config::default()).expect("restorable");
    assert_eq!(restored.snapshot().status, Status::RecoveryPending);
    assert_eq!(restored.snapshot().remaining_ms, snapshot.remaining_ms);
}

#[test]
fn restore_of_a_completed_snapshot_stays_completed() {
    let mut running = started_engine();
    running.tick(3_000_000);
    let snapshot = running.snapshot();
    let restored = Engine::restore(snapshot.clone(), Config::default()).expect("restorable");
    assert_eq!(
        restored.snapshot().status,
        Status::Completed,
        "a completed record must not restart as a pending recovery"
    );
    assert_eq!(restored.snapshot().remaining_ms, 0);
}

#[test]
fn restore_of_an_idle_snapshot_stays_idle() {
    let idle = engine();
    let snapshot = idle.snapshot();
    let restored = Engine::restore(snapshot.clone(), Config::default()).expect("restorable");
    assert_eq!(restored.snapshot().status, Status::Idle);
    assert_eq!(restored.snapshot().phase_id, snapshot.phase_id);
}

#[test]
fn accepting_a_recovery_creates_a_new_anchor() {
    let mut running = started_engine();
    running.tick(1_000);
    let snapshot = running.snapshot();
    let mut restored = Engine::restore(snapshot, Config::default()).expect("restorable");

    let transition = apply(&mut restored, Action::AcceptRecovery, 10_000);
    assert_eq!(transition.snapshot.status, Status::Running);
    assert_eq!(transition.snapshot.remaining_ms, 2_999_000);

    // The downtime is not counted, the new anchor is the supplied sample.
    let transition = restored.tick(11_000);
    assert_eq!(transition.snapshot.remaining_ms, 2_998_000);
}

#[test]
fn discarding_a_recovery_clears_to_idle() {
    let mut running = started_engine();
    running.tick(1_000);
    let snapshot = running.snapshot();
    let mut restored = Engine::restore(snapshot, Config::default()).expect("restorable");

    let transition = apply(&mut restored, Action::DiscardRecovery, 10_000);
    assert_eq!(transition.snapshot.status, Status::Idle);
    assert_eq!(transition.snapshot.session_id, None);
    assert_eq!(transition.snapshot.completed_focus_count, 0);
    assert_eq!(
        transition.snapshot.remaining_ms, transition.snapshot.duration_ms,
        "a discarded recovery starts from the full duration"
    );
    assert!(transition.effects.is_empty());
}

#[test]
fn restore_rejects_an_unsupported_schema_version() {
    let mut snapshot = engine().snapshot();
    snapshot.schema_version = 2;
    let result = Engine::restore(snapshot, Config::default());
    match result {
        Ok(_) => panic!("a future schema version must be rejected"),
        Err(error) => assert_eq!(error.code, "UNSUPPORTED"),
    }
}

#[test]
fn restore_rejects_inconsistent_snapshots() {
    let mut snapshot = engine().snapshot();
    snapshot.remaining_ms = snapshot.duration_ms + 1;
    assert_eq!(
        Engine::restore(snapshot.clone(), Config::default())
            .expect_err("remaining above duration is corrupt")
            .code,
        "CORRUPT_DATA"
    );

    snapshot.remaining_ms = 0;
    snapshot.duration_ms = 0;
    assert_eq!(
        Engine::restore(snapshot.clone(), Config::default())
            .expect_err("a zero duration is corrupt")
            .code,
        "CORRUPT_DATA"
    );

    snapshot.duration_ms = u64::MAX;
    assert_eq!(
        Engine::restore(snapshot.clone(), Config::default())
            .expect_err("an oversized duration is corrupt")
            .code,
        "CORRUPT_DATA"
    );
}

#[test]
fn restore_rejects_an_invalid_configuration() {
    let snapshot = engine().snapshot();
    let config = Config {
        focus_ms: 10,
        ..Config::default()
    };
    let error: EngineError =
        Engine::restore(snapshot.clone(), config).expect_err("a too short duration is rejected");
    assert_eq!(error.code, "INVALID_DURATION");

    let config = Config {
        label: "x".repeat(121),
        ..Config::default()
    };
    let error = Engine::restore(snapshot, config).expect_err("a long label is rejected");
    assert_eq!(error.code, "INVALID_LABEL");
}

#[test]
fn marking_an_interruption_flags_the_active_phase() {
    let mut running = started_engine();
    let transition = running.mark_interrupted();
    assert!(transition.snapshot.interrupted);
    assert_eq!(transition.snapshot.status, Status::Running);
    assert!(transition.effects.is_empty());

    let before = running.snapshot();
    let transition = running.mark_interrupted();
    assert_eq!(
        transition.snapshot.revision, before.revision,
        "marking twice does not change the state"
    );
}

#[test]
fn an_interruption_observed_while_idle_marks_the_next_phase() {
    let mut idle = engine();
    let transition = idle.mark_interrupted();
    assert!(transition.snapshot.interrupted);

    // The flag survives into the phase that starts after the interruption.
    let transition = apply(&mut idle, Action::Start, 0);
    assert!(transition.snapshot.interrupted);

    // And it reaches the completion effect of that phase.
    let transition = idle.tick(3_000_000);
    assert_eq!(transition.snapshot.status, Status::Completed);
    match &transition.effects[0] {
        crate::Effect::PhaseCompleted { interrupted, .. } => assert!(
            *interrupted,
            "a phase that follows an interruption is not confirmed work"
        ),
        other => panic!("unexpected effect {other:?}"),
    }
}

#[test]
fn marking_a_recovery_pending_freezes_the_remaining_time() {
    let mut running = started_engine();
    let transition = running.mark_recovery_pending(1_000);
    assert_eq!(transition.snapshot.status, Status::RecoveryPending);
    assert_eq!(transition.snapshot.remaining_ms, 2_999_000);

    let transition = running.tick(9_000);
    assert_eq!(
        transition.snapshot.remaining_ms, 2_999_000,
        "a pending recovery ignores the clock"
    );
}

#[test]
fn marking_a_recovery_pending_at_the_deadline_completes_the_phase() {
    let mut running = started_engine();
    let transition = running.mark_recovery_pending(3_000_000);
    assert_eq!(transition.snapshot.status, Status::Completed);
    assert_eq!(transition.effects.len(), 1);
}

#[test]
fn a_restored_snapshot_round_trips_through_serialization() {
    let mut running = started_engine();
    running.tick(1_000);
    let snapshot: Snapshot = running.snapshot();
    let json = serde_json::to_string(&snapshot).expect("the snapshot is serialisable");
    let parsed: Snapshot = serde_json::from_str(&json).expect("the snapshot is deserialisable");
    assert_eq!(parsed, snapshot);
}

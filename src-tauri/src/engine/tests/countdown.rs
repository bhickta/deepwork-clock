//! Countdown behaviour of a single phase.

use crate::tests::{apply, engine, started_engine};
use crate::{Action, Effect, Phase, Status};

#[test]
fn a_new_engine_is_idle_with_a_focus_phase() {
    let engine = engine();
    let snapshot = engine.snapshot();
    assert_eq!(snapshot.status, Status::Idle);
    assert_eq!(snapshot.phase, Phase::Focus);
    assert_eq!(snapshot.duration_ms, 3_000_000);
    assert_eq!(snapshot.remaining_ms, 3_000_000);
    assert_eq!(snapshot.session_id, None);
    assert!(snapshot.phase_id.is_some());
    assert_eq!(snapshot.completed_focus_count, 0);
    assert_eq!(snapshot.revision, 1);
    assert!(!snapshot.interrupted);
}

#[test]
fn start_anchors_the_clock_and_the_remaining_time_is_recomputed() {
    let mut engine = started_engine();
    let snapshot = engine.snapshot();
    assert_eq!(snapshot.status, Status::Running);
    assert_eq!(snapshot.remaining_ms, 3_000_000);
    assert!(snapshot.session_id.is_some());

    let transition = engine.tick(1_000);
    assert_eq!(transition.snapshot.remaining_ms, 2_999_000);
    assert_eq!(transition.snapshot.status, Status::Running);
    assert!(transition.effects.is_empty());
}

#[test]
fn repeated_ticks_do_not_drift() {
    let mut engine = started_engine();
    for step in 1..=1_000u64 {
        engine.tick(step);
    }
    assert_eq!(
        engine.snapshot().remaining_ms,
        3_000_000 - 1_000,
        "1000 single millisecond samples must not drift"
    );

    let mut single = started_engine();
    single.tick(1_000);
    assert_eq!(
        single.snapshot().remaining_ms,
        engine.snapshot().remaining_ms,
        "one large sample must equal many small samples"
    );
}

#[test]
fn a_repeated_sample_does_not_change_the_state() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let before = engine.snapshot();
    let transition = engine.tick(1_000);
    assert_eq!(
        transition.snapshot, before,
        "the same sample changes nothing"
    );
}

#[test]
fn an_out_of_order_sample_never_increases_the_remaining_time() {
    let mut engine = started_engine();
    engine.tick(5_000);
    assert_eq!(engine.snapshot().remaining_ms, 2_995_000);
    engine.tick(1_000);
    assert_eq!(
        engine.snapshot().remaining_ms,
        2_995_000,
        "an older sample must not extend the countdown"
    );
}

#[test]
fn pause_freezes_the_remaining_time_and_resume_re_anchors_it() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let transition = apply(&mut engine, Action::Pause, 1_000);
    assert_eq!(transition.snapshot.status, Status::Paused);
    assert_eq!(transition.snapshot.remaining_ms, 2_999_000);

    engine.tick(9_000);
    assert_eq!(
        engine.snapshot().remaining_ms,
        2_999_000,
        "a paused phase ignores the clock"
    );

    let transition = apply(&mut engine, Action::Resume, 9_000);
    assert_eq!(transition.snapshot.status, Status::Running);
    assert_eq!(transition.snapshot.remaining_ms, 2_999_000);

    let transition = engine.tick(10_000);
    assert_eq!(
        transition.snapshot.remaining_ms, 2_998_000,
        "resuming must not lose or double count time"
    );
}

#[test]
fn pause_at_the_deadline_completes_instead_of_pausing() {
    let mut engine = started_engine();
    let transition = apply(&mut engine, Action::Pause, 3_000_000);
    assert_eq!(transition.snapshot.status, Status::Completed);
    assert_eq!(transition.snapshot.remaining_ms, 0);
    assert_eq!(transition.effects.len(), 1);
    assert!(matches!(
        transition.effects[0],
        Effect::PhaseCompleted { .. }
    ));
    assert_eq!(transition.snapshot.completed_focus_count, 1);
}

#[test]
fn a_phase_completes_exactly_once() {
    let mut engine = started_engine();
    let transition = engine.tick(3_000_000);
    assert_eq!(transition.snapshot.status, Status::Completed);
    assert_eq!(transition.effects.len(), 1);
    let completed = engine.snapshot();

    for elapsed in [3_000_001, 4_000_000, 10_000_000] {
        let transition = engine.tick(elapsed);
        assert!(transition.effects.is_empty(), "no second completion effect");
        assert_eq!(
            transition.snapshot, completed,
            "the completed state is stable"
        );
    }
}

#[test]
fn an_overflowing_elapsed_sample_completes_the_phase() {
    let mut engine = started_engine();
    let transition = engine.tick(u64::MAX);
    assert_eq!(transition.snapshot.status, Status::Completed);
    assert_eq!(transition.effects.len(), 1);
}

#[test]
fn reset_creates_a_new_phase_with_the_full_duration() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let before = engine.snapshot();
    let transition = apply(&mut engine, Action::Reset, 1_000);
    assert_eq!(transition.snapshot.status, Status::Idle);
    assert_eq!(
        transition.snapshot.remaining_ms,
        transition.snapshot.duration_ms
    );
    assert_eq!(transition.snapshot.duration_ms, before.duration_ms);
    assert_ne!(
        transition.snapshot.phase_id, before.phase_id,
        "a reset creates a new phase id"
    );
    assert!(
        transition.effects.is_empty(),
        "a reset is not a history event"
    );
    assert_eq!(transition.snapshot.completed_focus_count, 0);
}

#[test]
fn end_records_the_unfinished_phase_and_clears_to_idle() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let before = engine.snapshot();
    let transition = apply(&mut engine, Action::End, 1_000);
    assert_eq!(transition.snapshot.status, Status::Idle);
    assert_eq!(transition.effects.len(), 1);
    match &transition.effects[0] {
        Effect::SessionEnded {
            phase_id,
            phase,
            duration_ms,
            ..
        } => {
            assert_eq!(phase_id, before.phase_id.as_deref().unwrap());
            assert_eq!(*phase, Phase::Focus);
            assert_eq!(*duration_ms, before.duration_ms);
        }
        other => panic!("unexpected effect {other:?}"),
    }
    assert_eq!(
        transition.snapshot.session_id, before.session_id,
        "the session id is retained so the record can be correlated"
    );
    assert_eq!(
        transition.snapshot.remaining_ms,
        transition.snapshot.duration_ms
    );
}

#[test]
fn a_tick_outside_the_running_status_changes_nothing() {
    let mut engine = engine();
    let before = engine.snapshot();
    let transition = engine.tick(1_000);
    assert_eq!(transition.snapshot, before);
    assert!(transition.effects.is_empty());
}

#[test]
fn a_repeated_start_is_a_harmless_no_op() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let before = engine.snapshot();
    let transition = apply(&mut engine, Action::Start, 1_000);
    assert_eq!(
        transition.snapshot, before,
        "a repeated start changes nothing"
    );
    assert!(transition.effects.is_empty());
}

#[test]
fn a_repeated_pause_is_a_harmless_no_op() {
    let mut engine = started_engine();
    apply(&mut engine, Action::Pause, 0);
    let before = engine.snapshot();
    let transition = apply(&mut engine, Action::Pause, 0);
    assert_eq!(transition.snapshot, before);
    assert!(transition.effects.is_empty());
}

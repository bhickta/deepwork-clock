//! Focus/break cycle behaviour.

use crate::tests::{apply, complete_focus_phase, engine, started_engine};
use crate::{Action, Effect, Phase, Status};

#[test]
fn four_completed_focus_phases_select_the_long_break() {
    let mut engine = started_engine();
    let mut elapsed = 0u64;

    for expected_count in 1..=4u32 {
        // A completed focus phase always earns a break.
        elapsed = complete_focus_phase(&mut engine, elapsed);
        assert_eq!(engine.snapshot().completed_focus_count, expected_count);
        let expected_break = if expected_count.is_multiple_of(4) {
            Phase::LongBreak
        } else {
            Phase::ShortBreak
        };
        assert_eq!(engine.snapshot().phase, expected_break);

        // A completed break always leads back to focus and never counts.
        elapsed = complete_focus_phase(&mut engine, elapsed);
        assert_eq!(engine.snapshot().completed_focus_count, expected_count);
        assert_eq!(engine.snapshot().phase, Phase::Focus);
    }

    assert_eq!(
        engine.snapshot().completed_focus_count,
        4,
        "four focus phases were completed"
    );
    assert_eq!(engine.snapshot().phase, Phase::Focus);
}

#[test]
fn the_focus_count_increments_exactly_once_per_completion() {
    let mut engine = started_engine();
    let transition = engine.tick(3_000_000);
    assert_eq!(transition.snapshot.completed_focus_count, 1);
    assert_eq!(transition.effects.len(), 1);

    // Further samples of the completed phase must not count it again.
    let transition = engine.tick(9_000_000);
    assert_eq!(transition.snapshot.completed_focus_count, 1);
    assert!(transition.effects.is_empty());
}

#[test]
fn advancing_after_a_completion_never_counts_the_phase_again() {
    let mut engine = started_engine();
    engine.tick(3_000_000);
    let transition = apply(&mut engine, Action::Advance, 3_000_000);
    assert_eq!(transition.snapshot.completed_focus_count, 1);
    assert_eq!(transition.snapshot.status, Status::Idle);
    assert_eq!(transition.snapshot.phase, Phase::ShortBreak);
    assert!(
        transition.effects.is_empty(),
        "the completion was already recorded"
    );
}

#[test]
fn skipping_a_phase_never_increments_the_focus_count() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let transition = apply(&mut engine, Action::Skip, 1_000);
    assert_eq!(transition.snapshot.completed_focus_count, 0);
    assert_eq!(transition.snapshot.status, Status::Idle);
    assert_eq!(transition.snapshot.phase, Phase::ShortBreak);
    assert_eq!(transition.effects.len(), 1);
    match &transition.effects[0] {
        Effect::PhaseSkipped { phase, .. } => assert_eq!(*phase, Phase::Focus),
        other => panic!("unexpected effect {other:?}"),
    }
}

#[test]
fn skipping_a_completed_phase_records_no_second_history_event() {
    let mut engine = started_engine();
    engine.tick(3_000_000);
    let transition = apply(&mut engine, Action::Skip, 3_000_000);
    assert!(
        transition.effects.is_empty(),
        "a completed phase is not skipped a second time"
    );
    assert_eq!(transition.snapshot.status, Status::Idle);
    assert_eq!(transition.snapshot.phase, Phase::ShortBreak);
    assert_eq!(transition.snapshot.completed_focus_count, 1);
}

#[test]
fn resetting_never_increments_the_focus_count() {
    let mut engine = started_engine();
    engine.tick(1_000);
    let transition = apply(&mut engine, Action::Reset, 1_000);
    assert_eq!(transition.snapshot.completed_focus_count, 0);
    assert_eq!(transition.snapshot.phase, Phase::Focus);
    assert_eq!(transition.snapshot.status, Status::Idle);
}

#[test]
fn skipping_a_break_returns_to_focus() {
    let mut engine = started_engine();
    engine.tick(3_000_000);
    apply(&mut engine, Action::Advance, 3_000_000);
    assert_eq!(engine.snapshot().phase, Phase::ShortBreak);

    // The break has to run before it can be skipped.
    apply(&mut engine, Action::Start, 3_000_000);
    let transition = apply(&mut engine, Action::Skip, 3_000_000);
    assert_eq!(transition.snapshot.phase, Phase::Focus);
    assert_eq!(transition.snapshot.completed_focus_count, 1);
    assert_eq!(transition.effects.len(), 1);
}

#[test]
fn a_new_session_resets_the_focus_count() {
    let mut engine = started_engine();
    engine.tick(3_000_000);
    assert_eq!(engine.snapshot().completed_focus_count, 1);
    apply(&mut engine, Action::End, 3_000_000);
    assert_eq!(engine.snapshot().completed_focus_count, 0);
    let transition = apply(&mut engine, Action::Start, 3_000_000);
    assert_eq!(transition.snapshot.completed_focus_count, 0);
    assert_eq!(transition.snapshot.status, Status::Running);
}

#[test]
fn the_session_id_changes_with_every_new_session() {
    let mut engine = started_engine();
    let first = engine.snapshot().session_id;
    apply(&mut engine, Action::End, 0);
    apply(&mut engine, Action::Start, 0);
    let second = engine.snapshot().session_id;
    assert_ne!(first, second, "a new session gets a new id");
    assert!(first.is_some() && second.is_some());
}

#[test]
fn advancing_in_countdown_mode_is_rejected() {
    let mut engine = engine();
    let config = crate::Config {
        mode: crate::Mode::Countdown,
        ..crate::Config::default()
    };
    apply(&mut engine, Action::Configure { config }, 0);
    apply(&mut engine, Action::Start, 0);
    engine.tick(3_000_000);
    let result = engine.apply(Action::Advance, 3_000_000);
    assert_eq!(crate::tests::error_code(result), "INVALID_STATE");
}

#[test]
fn skipping_in_countdown_mode_restarts_the_same_phase() {
    let mut engine = engine();
    let config = crate::Config {
        mode: crate::Mode::Countdown,
        ..crate::Config::default()
    };
    apply(&mut engine, Action::Configure { config }, 0);
    apply(&mut engine, Action::Start, 0);
    engine.tick(1_000);
    let transition = apply(&mut engine, Action::Skip, 1_000);
    assert_eq!(transition.snapshot.status, Status::Idle);
    assert_eq!(transition.snapshot.phase, Phase::Focus);
    assert_eq!(
        transition.snapshot.remaining_ms,
        transition.snapshot.duration_ms
    );
    assert_eq!(transition.effects.len(), 1);
}

#[test]
fn the_long_break_interval_is_configurable() {
    let mut engine = engine();
    let config = crate::Config {
        long_break_interval: 2,
        ..crate::Config::default()
    };
    apply(&mut engine, Action::Configure { config }, 0);
    apply(&mut engine, Action::Start, 0);
    let mut elapsed = 0u64;

    elapsed = complete_focus_phase(&mut engine, elapsed);
    assert_eq!(engine.snapshot().phase, Phase::ShortBreak);
    elapsed = complete_focus_phase(&mut engine, elapsed);
    assert_eq!(engine.snapshot().phase, Phase::Focus);
    complete_focus_phase(&mut engine, elapsed);
    assert_eq!(
        engine.snapshot().phase,
        Phase::LongBreak,
        "the second completed focus phase earns the long break"
    );
}

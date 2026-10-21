//! Invalid commands return a typed error and never change the state.

use crate::tests::{apply, engine, error_code, started_engine};
use crate::{Action, Config, Engine, Snapshot, Status};

/// Builds an engine in the requested status.
fn engine_in(status: Status) -> Engine {
    let engine = match status {
        Status::Idle => engine(),
        Status::Running => started_engine(),
        Status::Paused => {
            let mut engine = started_engine();
            apply(&mut engine, Action::Pause, 0);
            engine
        }
        Status::Completed => {
            let mut engine = started_engine();
            engine.tick(3_000_000);
            engine
        }
        Status::RecoveryPending => {
            let engine = started_engine();
            let snapshot = engine.snapshot();
            Engine::restore(snapshot, Config::default()).expect("the snapshot is restorable")
        }
    };
    assert_eq!(engine.snapshot().status, status);
    engine
}

/// Actions that are invalid in the given status.
fn invalid_actions(status: Status) -> Vec<Action> {
    let configure = || Action::Configure {
        config: Config::default(),
    };
    match status {
        Status::Idle => vec![
            Action::Pause,
            Action::Resume,
            Action::Skip,
            Action::Advance,
            Action::End,
            Action::AcceptRecovery,
            Action::DiscardRecovery,
        ],
        Status::Running => vec![
            configure(),
            Action::Advance,
            Action::AcceptRecovery,
            Action::DiscardRecovery,
        ],
        Status::Paused => vec![
            configure(),
            Action::Start,
            Action::Advance,
            Action::AcceptRecovery,
            Action::DiscardRecovery,
        ],
        Status::Completed => vec![
            Action::Start,
            Action::Pause,
            Action::Resume,
            Action::AcceptRecovery,
            Action::DiscardRecovery,
        ],
        Status::RecoveryPending => vec![
            configure(),
            Action::Start,
            Action::Pause,
            Action::Resume,
            Action::Reset,
            Action::Skip,
            Action::Advance,
            Action::End,
        ],
    }
}

#[test]
fn invalid_commands_return_invalid_state_and_keep_the_state_unchanged() {
    for status in [
        Status::Idle,
        Status::Running,
        Status::Paused,
        Status::Completed,
        Status::RecoveryPending,
    ] {
        for action in invalid_actions(status) {
            let mut engine = engine_in(status);
            let before: Snapshot = engine.snapshot();
            let result = engine.apply(action.clone(), 0);
            assert_eq!(
                error_code(result),
                "INVALID_STATE",
                "{action:?} must be invalid while {status:?}"
            );
            assert_eq!(
                engine.snapshot(),
                before,
                "{action:?} must not change the state while {status:?}"
            );
        }
    }
}

#[test]
fn a_command_that_is_invalid_after_the_expiry_sample_is_rolled_back() {
    let mut engine = started_engine();
    let before = engine.snapshot();
    // The phase expired at this sample, so the start command is not valid any more.
    let result = engine.apply(Action::Start, 3_000_000);
    assert_eq!(error_code(result), "INVALID_STATE");
    assert_eq!(
        engine.snapshot(),
        before,
        "the expiry sample is rolled back together with the invalid command"
    );

    // The pending expiry is detected again on the next sample and completes exactly once.
    let transition = engine.tick(3_000_000);
    assert_eq!(transition.snapshot.status, Status::Completed);
    assert_eq!(transition.effects.len(), 1);
}

#[test]
fn an_invalid_command_does_not_bump_the_revision() {
    let mut engine = engine_in(Status::Idle);
    let before = engine.snapshot();
    let result = engine.apply(Action::End, 0);
    assert_eq!(error_code(result), "INVALID_STATE");
    assert_eq!(engine.snapshot().revision, before.revision);
}

#[test]
fn a_valid_command_bumps_the_revision_exactly_once() {
    let mut engine = engine_in(Status::Idle);
    let before = engine.snapshot();
    let transition = apply(&mut engine, Action::Start, 0);
    assert_eq!(
        transition.snapshot.revision,
        before.revision + 1,
        "one state change is one revision"
    );
}

#[test]
fn the_revision_is_monotonic_across_many_commands() {
    let mut engine = engine();
    let mut revision = engine.snapshot().revision;
    for step in 0..50u64 {
        let elapsed = step * 1_000;
        let transition = apply(&mut engine, Action::Start, elapsed);
        assert!(transition.snapshot.revision >= revision);
        revision = transition.snapshot.revision;
        let transition = engine.tick(elapsed + 10);
        assert!(transition.snapshot.revision >= revision);
        revision = transition.snapshot.revision;
    }
}

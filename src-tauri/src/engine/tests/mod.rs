//! Deterministic tests for the timer engine.
//!
//! No test sleeps, waits on the wall clock or depends on the machine it runs on: every test
//! drives the engine with explicit elapsed samples.

#![allow(dead_code)]

mod config;
mod countdown;
mod cycle;
mod errors;
mod properties;
mod recovery;
mod serialization;

use crate::{Action, Config, Engine, EngineError, Phase, Status, Transition};

/// Default focus duration of the default configuration.
pub const FOCUS_MS: u64 = 3_000_000;
/// Default short break duration of the default configuration.
pub const SHORT_BREAK_MS: u64 = 600_000;
/// Default long break duration of the default configuration.
pub const LONG_BREAK_MS: u64 = 1_800_000;

/// Creates an engine with the default configuration.
pub fn engine() -> Engine {
    Engine::new()
}

/// Creates an engine with a started focus phase.
pub fn started_engine() -> Engine {
    let mut engine = Engine::new();
    engine
        .apply(Action::Start, 0)
        .expect("start is valid while idle");
    engine
}

/// Creates an engine with a started focus phase and a custom configuration.
pub fn started_engine_with(config: Config) -> Engine {
    let mut engine = Engine::new();
    engine
        .apply(Action::Configure { config }, 0)
        .expect("configure is valid while idle");
    engine
        .apply(Action::Start, 0)
        .expect("start is valid while idle");
    engine
}

/// Runs the current phase to its deadline and returns the transition.
pub fn run_to_completion(engine: &mut Engine, elapsed_ms: u64) -> Transition {
    engine.tick(elapsed_ms)
}

/// Applies an action and unwraps the transition.
pub fn apply(engine: &mut Engine, action: Action, elapsed_ms: u64) -> Transition {
    engine
        .apply(action, elapsed_ms)
        .expect("action is valid in this state")
}

/// Starts the current phase, runs it to its deadline and selects the next phase.
///
/// Returns the elapsed time after the completed phase.
pub fn complete_focus_phase(engine: &mut Engine, elapsed_ms: u64) -> u64 {
    apply(engine, Action::Start, elapsed_ms);
    let after = elapsed_ms + engine.snapshot().duration_ms;
    let transition = engine.tick(after);
    assert_eq!(
        transition.snapshot.status,
        Status::Completed,
        "the phase must be completed at the deadline"
    );
    assert_eq!(transition.effects.len(), 1, "exactly one completion effect");
    apply(engine, Action::Advance, after);
    after
}

/// Returns the error code of a failed action.
pub fn error_code(result: Result<Transition, EngineError>) -> String {
    match result {
        Ok(_) => panic!("the action was expected to fail"),
        Err(error) => error.code,
    }
}

/// Returns the error code of a failed validation.
pub fn unit_error_code(result: Result<(), EngineError>) -> String {
    match result {
        Ok(()) => panic!("the validation was expected to fail"),
        Err(error) => error.code,
    }
}

/// Returns the phase of a snapshot.
pub fn phase_of(transition: &Transition) -> Phase {
    transition.snapshot.phase
}

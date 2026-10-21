//! Property test over deterministic pseudo random command sequences.
//!
//! The generator is a fixed seed linear congruential generator, so the run is reproducible and
//! never depends on the wall clock.

use std::collections::HashSet;

use crate::tests::engine;
use crate::{Action, Config, Effect, Mode, Phase, Snapshot, Transition};

/// A small deterministic pseudo random generator.
struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }

    fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            0
        } else {
            self.next_u64() % bound
        }
    }
}

/// Builds a random but valid command.
fn random_action(rng: &mut Lcg) -> Action {
    let seconds = 1 + rng.below(3_600);
    match rng.below(11) {
        0 => Action::Configure {
            config: Config {
                mode: if rng.below(2) == 0 {
                    Mode::Cycle
                } else {
                    Mode::Countdown
                },
                focus_ms: seconds * 1_000,
                short_break_ms: (1 + rng.below(600)) * 1_000,
                long_break_ms: (1 + rng.below(1_800)) * 1_000,
                long_break_interval: 1 + rng.below(8) as u32,
                label: String::new(),
            },
        },
        1 => Action::Start,
        2 => Action::Pause,
        3 => Action::Resume,
        4 => Action::Reset,
        5 => Action::Skip,
        6 => Action::Advance,
        7 => Action::End,
        8 => Action::AcceptRecovery,
        9 => Action::DiscardRecovery,
        _ => Action::Start,
    }
}

/// Asserts the invariants that must hold for every state of the engine.
fn check(
    snapshot: &Snapshot,
    effects: &[Effect],
    last_revision: &mut u64,
    completed_phase_ids: &mut HashSet<String>,
    focus_completions: &mut u32,
) {
    assert!(
        snapshot.remaining_ms <= snapshot.duration_ms,
        "the remaining time must never exceed the duration"
    );
    assert!(
        snapshot.duration_ms >= crate::MIN_DURATION_MS
            && snapshot.duration_ms <= crate::MAX_DURATION_MS,
        "the duration must stay inside the supported range"
    );
    assert!(
        snapshot.revision >= *last_revision,
        "the revision must never decrease"
    );
    assert!(
        effects.len() <= 1,
        "a transition produces at most one effect"
    );
    for effect in effects {
        if let Effect::PhaseCompleted {
            phase_id, phase, ..
        } = effect
        {
            assert!(
                completed_phase_ids.insert(phase_id.clone()),
                "a phase must never complete twice"
            );
            if *phase == Phase::Focus {
                *focus_completions += 1;
            }
        }
    }
    assert!(
        snapshot.completed_focus_count <= *focus_completions,
        "the focus count must not exceed the number of completed focus phases"
    );
    assert!(snapshot.phase_id.is_some(), "a phase always has an id");
    *last_revision = snapshot.revision;
}

#[test]
fn random_command_sequences_keep_the_invariants() {
    let mut rng = Lcg(0x5eed_1234_5678_9abc);
    let mut engine = engine();
    let mut elapsed = 0u64;
    let mut last_revision = engine.snapshot().revision;
    let mut completed_phase_ids: HashSet<String> = HashSet::new();
    let mut focus_completions = 0u32;

    for _ in 0..10_000 {
        let action = random_action(&mut rng);
        elapsed = elapsed.saturating_add(rng.below(3_000));
        // Every fourth step replays an older sample to exercise the monotonic guard.
        let sample = if rng.below(4) == 0 {
            elapsed.saturating_sub(rng.below(2_000))
        } else {
            elapsed
        };

        if let Ok(transition) = engine.apply(action, sample) {
            let Transition { snapshot, effects } = transition;
            check(
                &snapshot,
                &effects,
                &mut last_revision,
                &mut completed_phase_ids,
                &mut focus_completions,
            );
        }

        if rng.below(2) == 0 {
            let transition = engine.tick(sample);
            check(
                &transition.snapshot,
                &transition.effects,
                &mut last_revision,
                &mut completed_phase_ids,
                &mut focus_completions,
            );
        }
    }
}

#[test]
fn a_long_run_of_ticks_completes_a_phase_exactly_once() {
    let mut engine = engine();
    let mut elapsed = 0u64;
    let mut completions = 0u32;
    let mut phase_ids = HashSet::new();
    for _ in 0..20_000 {
        elapsed = elapsed.saturating_add(17);
        let transition = engine.tick(elapsed);
        for effect in &transition.effects {
            if let Effect::PhaseCompleted { phase_id, .. } = effect {
                assert!(phase_ids.insert(phase_id.clone()));
                completions += 1;
            }
        }
    }
    assert!(
        completions <= 1,
        "without a start the phase can complete at most once"
    );
}

//! Configuration validation and serialization of the default configuration.

use crate::tests::{apply, engine, error_code, unit_error_code};
use crate::{Action, Config, Mode, Snapshot, MAX_DURATION_MS, MIN_DURATION_MS};

#[test]
fn default_config_is_a_valid_50_10_30_cycle() {
    let config = Config::default();
    assert_eq!(config.mode, Mode::Cycle);
    assert_eq!(config.focus_ms, 3_000_000);
    assert_eq!(config.short_break_ms, 600_000);
    assert_eq!(config.long_break_ms, 1_800_000);
    assert_eq!(config.long_break_interval, 4);
    assert_eq!(config.label, "");
    assert!(config.validate().is_ok());
}

#[test]
fn durations_outside_one_second_to_24_hours_are_rejected() {
    let rejected = [0, 1, 999, MAX_DURATION_MS + 1, u64::MAX];
    for value in rejected {
        let config = Config {
            focus_ms: value,
            ..Config::default()
        };
        assert_eq!(
            unit_error_code(config.validate()),
            "INVALID_DURATION",
            "focus duration {value} must be rejected"
        );

        let config = Config {
            short_break_ms: value,
            ..Config::default()
        };
        assert_eq!(unit_error_code(config.validate()), "INVALID_DURATION");

        let config = Config {
            long_break_ms: value,
            ..Config::default()
        };
        assert_eq!(unit_error_code(config.validate()), "INVALID_DURATION");
    }
}

#[test]
fn boundary_durations_are_accepted() {
    for value in [MIN_DURATION_MS, MAX_DURATION_MS] {
        let config = Config {
            focus_ms: value,
            short_break_ms: value,
            long_break_ms: value,
            ..Config::default()
        };
        assert!(
            config.validate().is_ok(),
            "duration {value} is inside the supported range"
        );
    }
}

#[test]
fn long_break_interval_is_bounded() {
    let config = Config {
        long_break_interval: 0,
        ..Config::default()
    };
    assert_eq!(unit_error_code(config.validate()), "INVALID_DURATION");

    let config = Config {
        long_break_interval: 1,
        ..Config::default()
    };
    assert!(config.validate().is_ok());

    let config = Config {
        long_break_interval: 100,
        ..Config::default()
    };
    assert!(config.validate().is_ok());

    let config = Config {
        long_break_interval: 101,
        ..Config::default()
    };
    assert_eq!(unit_error_code(config.validate()), "INVALID_DURATION");
}

#[test]
fn label_cap_counts_unicode_characters_not_bytes() {
    let config = Config {
        label: "é".repeat(120),
        ..Config::default()
    };
    assert_eq!(config.label.len(), 240, "120 characters are 240 bytes");
    assert!(config.validate().is_ok());

    let config = Config {
        label: "é".repeat(121),
        ..Config::default()
    };
    assert_eq!(unit_error_code(config.validate()), "INVALID_LABEL");

    let config = Config {
        label: "🦀".repeat(120),
        ..Config::default()
    };
    assert_eq!(config.label.len(), 480, "120 characters are 480 bytes");
    assert!(config.validate().is_ok());
}

#[test]
fn missing_configuration_fields_fall_back_to_the_defaults() {
    let config: Config = serde_json::from_str("{}").expect("the configuration is deserialisable");
    assert_eq!(config, Config::default());
}

#[test]
fn configure_with_an_invalid_configuration_leaves_the_state_unchanged() {
    let mut engine = engine();
    let before = engine.snapshot();
    let config = Config {
        focus_ms: 0,
        ..Config::default()
    };
    let result = engine.apply(Action::Configure { config }, 0);
    assert_eq!(error_code(result), "INVALID_DURATION");
    assert_eq!(engine.snapshot(), before, "the state must be unchanged");

    let config = Config {
        label: "x".repeat(121),
        ..Config::default()
    };
    let result = engine.apply(Action::Configure { config }, 0);
    assert_eq!(error_code(result), "INVALID_LABEL");
    assert_eq!(engine.snapshot(), before, "the state must be unchanged");
}

#[test]
fn configure_applies_a_valid_configuration_to_the_next_session() {
    let mut engine = engine();
    let config = Config {
        focus_ms: 1_000,
        short_break_ms: 2_000,
        long_break_ms: 3_000,
        long_break_interval: 2,
        label: "Deep work".to_string(),
        mode: Mode::Cycle,
    };
    let transition = apply(
        &mut engine,
        Action::Configure {
            config: config.clone(),
        },
        0,
    );
    assert_eq!(transition.snapshot.duration_ms, 1_000);
    assert_eq!(transition.snapshot.remaining_ms, 1_000);
    assert_eq!(transition.snapshot.label, "Deep work");
    assert_eq!(transition.snapshot.status, crate::Status::Idle);
    assert!(transition.effects.is_empty());
    assert_eq!(engine.config(), config);
}

#[test]
fn a_new_engine_exposes_the_default_configuration() {
    let engine = engine();
    assert_eq!(engine.config(), Config::default());
    let snapshot: Snapshot = engine.snapshot();
    assert_eq!(snapshot.schema_version, 1);
    assert_eq!(snapshot.mode, Mode::Cycle);
}

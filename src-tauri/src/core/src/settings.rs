//! Durable user settings.
//!
//! The shape is frozen by the frontend contract: camelCase field names, a
//! schema version and a monotonically increasing revision. The backend owns
//! the revision counter; a client may only submit a settings document together
//! with the revision it believes to be current.

use std::collections::BTreeMap;

use deepwork_engine::Config;
use serde::{Deserialize, Serialize};

use crate::error::BridgeError;

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// Longest accepted session label, counted in Unicode scalar values.
///
/// The value is owned by the engine crate; it is re-exported here so that the
/// settings layer and the engine can never disagree.
pub const MAX_LABEL_CHARS: usize = deepwork_engine::MAX_LABEL_CHARS;

/// One second.
pub const MIN_DURATION_MS: u64 = deepwork_engine::MIN_DURATION_MS;

/// Twenty four hours.
pub const MAX_DURATION_MS: u64 = deepwork_engine::MAX_DURATION_MS;

pub const MIN_TEXT_SCALE: f64 = 1.0;
pub const MAX_TEXT_SCALE: f64 = 2.0;

pub const MIN_RETENTION_DAYS: u32 = 1;
pub const MAX_RETENTION_DAYS: u32 = 3_650;

/// Longest accepted global shortcut description.
pub const MAX_SHORTCUT_CHARS: usize = 64;

/// Longest accepted long-break interval (number of focus phases).
pub const MAX_LONG_BREAK_INTERVAL: u32 = deepwork_engine::MAX_LONG_BREAK_INTERVAL;

/// Default global shortcut suggestion. It stays disabled until the user opts
/// in; the string uses the platform-neutral modifier names understood by the
/// global shortcut plugin.
pub const DEFAULT_GLOBAL_SHORTCUT: &str = "Alt+Shift+Space";

/// Highest accepted completion sound volume (percent).
pub const MAX_SOUND_VOLUME: u8 = 100;

/// Volume of a completion sound when the user has not changed it.
pub const DEFAULT_SOUND_VOLUME: u8 = 60;

/// Hard upper bound on the number of local shortcut bindings.
pub const MAX_LOCAL_SHORTCUTS: usize = 32;

/// Longest accepted local shortcut action name.
pub const MAX_LOCAL_SHORTCUT_KEY_CHARS: usize = 32;

/// Longest accepted local shortcut accelerator.
pub const MAX_LOCAL_SHORTCUT_VALUE_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    System,
    Light,
    Dark,
    HighContrast,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
            Theme::HighContrast => "high-contrast",
        }
    }
}

/// The complete settings document as exchanged with the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub revision: u64,
    pub theme: Theme,
    pub text_scale: f64,
    pub config: Config,
    pub notifications: bool,
    pub sound: bool,
    pub global_shortcut_enabled: bool,
    pub global_shortcut: String,
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub history_enabled: bool,
    pub retention_days: u32,
    /// Moves to the next phase automatically after a phase completes while the
    /// application is awake. Off by default, because an automatic cycle has to
    /// be an explicit decision.
    pub auto_advance: bool,
    /// Volume of the optional completion sound, in percent.
    pub sound_volume: u8,
    /// Local keyboard bindings, keyed by a short action name.
    pub local_shortcuts: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            revision: 0,
            theme: Theme::System,
            text_scale: 1.0,
            config: Config::default(),
            notifications: false,
            sound: false,
            global_shortcut_enabled: false,
            global_shortcut: DEFAULT_GLOBAL_SHORTCUT.to_string(),
            launch_at_login: false,
            close_to_tray: false,
            history_enabled: true,
            retention_days: 90,
            auto_advance: false,
            sound_volume: DEFAULT_SOUND_VOLUME,
            local_shortcuts: BTreeMap::new(),
        }
    }
}

impl Settings {
    /// Validates the document before it is written to disk.
    ///
    /// Duration problems use `INVALID_DURATION` because the user can repair
    /// them directly; everything else uses `INVALID_STATE`.
    pub fn validate(&self) -> Result<(), BridgeError> {
        if self.schema_version != SETTINGS_SCHEMA_VERSION {
            return Err(BridgeError::unsupported(format!(
                "Settings schema version {} is not supported by this build (expected {}).",
                self.schema_version, SETTINGS_SCHEMA_VERSION
            )));
        }
        if !self.text_scale.is_finite()
            || self.text_scale < MIN_TEXT_SCALE
            || self.text_scale > MAX_TEXT_SCALE
        {
            return Err(BridgeError::invalid_state(format!(
                "Text scale must be between {MIN_TEXT_SCALE} and {MAX_TEXT_SCALE}."
            )));
        }
        if self.retention_days < MIN_RETENTION_DAYS || self.retention_days > MAX_RETENTION_DAYS {
            return Err(BridgeError::invalid_state(format!(
                "Retention must be between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS} days."
            )));
        }
        if self.global_shortcut.chars().count() > MAX_SHORTCUT_CHARS {
            return Err(BridgeError::invalid_state(format!(
                "Global shortcut must be at most {MAX_SHORTCUT_CHARS} characters."
            )));
        }
        if self.global_shortcut_enabled && self.global_shortcut.trim().is_empty() {
            return Err(BridgeError::invalid_state(
                "Global shortcut cannot be enabled without an accelerator.",
            ));
        }
        if self.sound_volume > MAX_SOUND_VOLUME {
            return Err(BridgeError::invalid_state(format!(
                "Sound volume must be between 0 and {MAX_SOUND_VOLUME}."
            )));
        }
        validate_local_shortcuts(&self.local_shortcuts)?;
        validate_config(&self.config)
    }

    /// The revision the backend assigns after a successful save.
    pub fn next_revision(&self) -> u64 {
        self.revision.saturating_add(1)
    }
}

/// Validates the local shortcut map.
///
/// The map is deliberately boring: a small, bounded set of action names that
/// only use lower-case ASCII letters, digits and `-`, and a non-empty
/// accelerator string. The backend does not interpret the accelerator here;
/// that is the job of the shortcut layer. Rejecting unknown keys would make
/// forward compatibility worse, so only the shape is enforced.
pub fn validate_local_shortcuts(shortcuts: &BTreeMap<String, String>) -> Result<(), BridgeError> {
    if shortcuts.len() > MAX_LOCAL_SHORTCUTS {
        return Err(BridgeError::invalid_state(format!(
            "At most {MAX_LOCAL_SHORTCUTS} local shortcuts can be stored."
        )));
    }
    for (key, value) in shortcuts {
        let key_length = key.chars().count();
        if key_length == 0 || key_length > MAX_LOCAL_SHORTCUT_KEY_CHARS {
            return Err(BridgeError::invalid_state(format!(
                "A local shortcut name must be between 1 and {MAX_LOCAL_SHORTCUT_KEY_CHARS} characters."
            )));
        }
        if !key.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        }) {
            return Err(BridgeError::invalid_state(
                "A local shortcut name may only contain lower-case letters, digits and '-'.",
            ));
        }
        let value_length = value.chars().count();
        if value_length == 0 || value_length > MAX_LOCAL_SHORTCUT_VALUE_CHARS {
            return Err(BridgeError::invalid_state(format!(
                "A local shortcut must be between 1 and {MAX_LOCAL_SHORTCUT_VALUE_CHARS} characters."
            )));
        }
    }
    Ok(())
}

/// Validates a timer configuration document.
///
/// The engine owns the canonical rules for durations, the long break
/// interval and the label cap; the settings layer only maps the engine error
/// onto the bridge vocabulary.
pub fn validate_config(config: &Config) -> Result<(), BridgeError> {
    config.validate().map_err(BridgeError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{
        CODE_INVALID_DURATION, CODE_INVALID_LABEL, CODE_INVALID_STATE, CODE_UNSUPPORTED,
    };

    #[test]
    fn defaults_are_valid() {
        assert!(Settings::default().validate().is_ok());
    }

    #[test]
    fn camel_case_field_names() {
        let json = serde_json::to_string(&Settings::default()).expect("serialise");
        for expected in [
            "\"schemaVersion\"",
            "\"revision\"",
            "\"textScale\"",
            "\"globalShortcutEnabled\"",
            "\"globalShortcut\"",
            "\"launchAtLogin\"",
            "\"closeToTray\"",
            "\"historyEnabled\"",
            "\"retentionDays\"",
            "\"autoAdvance\"",
            "\"soundVolume\"",
            "\"localShortcuts\"",
        ] {
            assert!(json.contains(expected), "missing {expected} in {json}");
        }
    }

    #[test]
    fn new_features_have_calm_defaults() {
        let settings = Settings::default();
        assert!(!settings.auto_advance, "auto-advance is opt-in");
        assert_eq!(settings.sound_volume, DEFAULT_SOUND_VOLUME);
        assert!(settings.local_shortcuts.is_empty());
    }

    #[test]
    fn old_documents_without_the_new_fields_still_load() {
        // A settings document written before auto-advance, sound volume and
        // local shortcuts existed.
        let json = r#"{
            "schemaVersion": 1,
            "revision": 7,
            "theme": "dark",
            "textScale": 1.25,
            "config": {
                "mode": "cycle",
                "focusMs": 3000000,
                "shortBreakMs": 600000,
                "longBreakMs": 1800000,
                "longBreakInterval": 4,
                "label": ""
            },
            "notifications": true,
            "sound": false,
            "globalShortcutEnabled": false,
            "globalShortcut": "Alt+Shift+Space",
            "launchAtLogin": false,
            "closeToTray": false,
            "historyEnabled": true,
            "retentionDays": 90
        }"#;
        let settings: Settings = serde_json::from_str(json).expect("parse");
        assert_eq!(settings.revision, 7);
        assert_eq!(settings.theme, Theme::Dark);
        assert!(!settings.auto_advance);
        assert_eq!(settings.sound_volume, DEFAULT_SOUND_VOLUME);
        assert!(settings.local_shortcuts.is_empty());
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn sound_volume_bounds_are_enforced() {
        let loudest = Settings {
            sound_volume: MAX_SOUND_VOLUME,
            ..Settings::default()
        };
        assert!(loudest.validate().is_ok());
        let silent = Settings {
            sound_volume: 0,
            ..Settings::default()
        };
        assert!(silent.validate().is_ok());
        let too_loud = Settings {
            sound_volume: MAX_SOUND_VOLUME + 1,
            ..Settings::default()
        };
        let error = too_loud.validate().expect_err("too loud");
        assert_eq!(error.code, CODE_INVALID_STATE);
    }

    #[test]
    fn local_shortcut_entries_are_bounded() {
        let valid = Settings {
            local_shortcuts: BTreeMap::from([
                ("start-pause".to_string(), "Space".to_string()),
                ("next".to_string(), "Ctrl+Shift+N".to_string()),
                ("a1".to_string(), "F1".to_string()),
            ]),
            ..Settings::default()
        };
        assert!(valid.validate().is_ok());

        let too_many = Settings {
            local_shortcuts: (0..=MAX_LOCAL_SHORTCUTS)
                .map(|index| (format!("action-{index}"), "Space".to_string()))
                .collect(),
            ..Settings::default()
        };
        assert_eq!(
            too_many.validate().unwrap_err().code,
            CODE_INVALID_STATE,
            "the entry count is capped"
        );

        for key in ["", "Has-Caps", "with space", "under_score", "é"] {
            let settings = Settings {
                local_shortcuts: BTreeMap::from([(key.to_string(), "Space".to_string())]),
                ..Settings::default()
            };
            assert!(
                settings.validate().is_err(),
                "the key {key:?} must be refused"
            );
        }

        let too_long_key = Settings {
            local_shortcuts: BTreeMap::from([(
                "a".repeat(MAX_LOCAL_SHORTCUT_KEY_CHARS + 1),
                "Space".to_string(),
            )]),
            ..Settings::default()
        };
        assert!(too_long_key.validate().is_err());

        let empty_value = Settings {
            local_shortcuts: BTreeMap::from([("start".to_string(), String::new())]),
            ..Settings::default()
        };
        assert!(
            empty_value.validate().is_err(),
            "an empty accelerator is refused"
        );

        let too_long_value = Settings {
            local_shortcuts: BTreeMap::from([(
                "start".to_string(),
                "x".repeat(MAX_LOCAL_SHORTCUT_VALUE_CHARS + 1),
            )]),
            ..Settings::default()
        };
        assert!(
            too_long_value.validate().is_err(),
            "an over-long accelerator is refused"
        );
    }

    #[test]
    fn theme_uses_kebab_case() {
        let json = serde_json::to_string(&Theme::HighContrast).expect("serialise");
        assert_eq!(json, "\"high-contrast\"");
    }

    #[test]
    fn text_scale_bounds_are_enforced() {
        let too_small = Settings {
            text_scale: 0.5,
            ..Settings::default()
        };
        assert_eq!(too_small.validate().unwrap_err().code, CODE_INVALID_STATE);
        let too_large = Settings {
            text_scale: 2.5,
            ..Settings::default()
        };
        assert_eq!(too_large.validate().unwrap_err().code, CODE_INVALID_STATE);
        let largest = Settings {
            text_scale: 2.0,
            ..Settings::default()
        };
        assert!(largest.validate().is_ok());
    }

    #[test]
    fn retention_bounds_are_enforced() {
        let too_small = Settings {
            retention_days: 0,
            ..Settings::default()
        };
        assert!(too_small.validate().is_err());
        let too_large = Settings {
            retention_days: MAX_RETENTION_DAYS + 1,
            ..Settings::default()
        };
        assert!(too_large.validate().is_err());
    }

    #[test]
    fn future_schema_version_is_refused() {
        let future = Settings {
            schema_version: SETTINGS_SCHEMA_VERSION + 1,
            ..Settings::default()
        };
        assert_eq!(future.validate().unwrap_err().code, CODE_UNSUPPORTED);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let settings: Settings = serde_json::from_str("{}").expect("parse");
        assert_eq!(settings.revision, 0);
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.retention_days, 90);
    }

    #[test]
    fn label_cap_counts_characters() {
        let at_cap = Config {
            label: "é".repeat(MAX_LABEL_CHARS),
            ..Config::default()
        };
        assert!(validate_config(&at_cap).is_ok());
        let over_cap = Config {
            label: "é".repeat(MAX_LABEL_CHARS + 1),
            ..Config::default()
        };
        assert_eq!(
            validate_config(&over_cap).unwrap_err().code,
            CODE_INVALID_LABEL
        );
    }

    #[test]
    fn duration_bounds_are_enforced() {
        let too_short = Config {
            focus_ms: 0,
            ..Config::default()
        };
        assert_eq!(
            validate_config(&too_short).unwrap_err().code,
            CODE_INVALID_DURATION
        );
        let too_long = Config {
            focus_ms: MAX_DURATION_MS + 1,
            ..Config::default()
        };
        assert!(validate_config(&too_long).is_err());
        let shortest = Config {
            focus_ms: MIN_DURATION_MS,
            ..Config::default()
        };
        assert!(validate_config(&shortest).is_ok());
    }

    #[test]
    fn enabled_shortcut_requires_an_accelerator() {
        let settings = Settings {
            global_shortcut_enabled: true,
            global_shortcut: "   ".to_string(),
            ..Settings::default()
        };
        assert!(settings.validate().is_err());
    }
}

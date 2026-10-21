//! Safe CSV and JSON export of the session history.
//!
//! CSV is a spreadsheet format, so a cell that starts with `=`, `+`, `-` or
//! `@` is executed as a formula by spreadsheet applications. Cells are
//! therefore guarded with a leading apostrophe when the first non-blank
//! character is one of those, including when the cell starts with whitespace
//! or control characters. JSON export keeps the raw strings untouched.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::json;

use crate::history::HistoryRecord;

/// Column order of the CSV export.
pub const CSV_HEADER: [&str; 10] = [
    "phaseId",
    "phase",
    "startedAt",
    "endedAt",
    "durationMs",
    "label",
    "outcome",
    "interrupted",
    "confirmed",
    "localDate",
];

/// Escapes a single CSV cell.
///
/// The value is quoted when it contains a separator, a quote or a line break.
/// Control characters other than tab, carriage return and line feed are
/// removed because they confuse spreadsheet applications.
pub fn escape_cell(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\t' | '\r' | '\n'))
        .collect();
    let guarded = if needs_formula_guard(&cleaned) {
        format!("'{cleaned}")
    } else {
        cleaned
    };
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

/// Detects cells that a spreadsheet would interpret as a formula.
fn needs_formula_guard(value: &str) -> bool {
    let first = value
        .trim_start_matches(|character: char| character.is_whitespace() || character.is_control())
        .chars()
        .next();
    matches!(first, Some('=') | Some('+') | Some('-') | Some('@'))
}

/// Renders the history as CSV, newest first.
pub fn records_to_csv(records: &[HistoryRecord]) -> String {
    let mut output = String::new();
    output.push_str(&CSV_HEADER.join(","));
    output.push('\n');
    for record in records {
        let row = [
            escape_cell(&record.phase_id),
            escape_cell(record.phase.as_str()),
            escape_cell(&record.started_at),
            escape_cell(&record.ended_at),
            record.duration_ms.to_string(),
            escape_cell(&record.label),
            escape_cell(record.outcome.as_str()),
            record.interrupted.to_string(),
            record.confirmed.to_string(),
            escape_cell(&record.local_date),
        ];
        output.push_str(&row.join(","));
        output.push('\n');
    }
    output
}

/// Renders the history as JSON, preserving the raw strings.
pub fn records_to_json(records: &[HistoryRecord], exported_at: DateTime<Utc>) -> String {
    let payload = json!({
        "schemaVersion": 1,
        "exportedAt": exported_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        "records": records,
    });
    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{HistoryOutcome, HistoryPhase};

    fn record(label: &str) -> HistoryRecord {
        HistoryRecord {
            phase_id: "phase-1".to_string(),
            phase: HistoryPhase::Focus,
            started_at: "2026-01-01T10:00:00Z".to_string(),
            ended_at: "2026-01-01T10:25:00Z".to_string(),
            duration_ms: 1_500_000,
            label: label.to_string(),
            outcome: HistoryOutcome::Completed,
            interrupted: false,
            confirmed: true,
            local_date: "2026-01-01".to_string(),
        }
    }

    #[test]
    fn plain_cells_are_not_quoted() {
        assert_eq!(escape_cell("focus"), "focus");
    }

    #[test]
    fn formula_prefixes_are_guarded() {
        assert_eq!(escape_cell("=1+1"), "'=1+1");
        assert_eq!(escape_cell("+cmd"), "'+cmd");
        assert_eq!(escape_cell("-cmd"), "'-cmd");
        assert_eq!(escape_cell("@cmd"), "'@cmd");
    }

    #[test]
    fn whitespace_and_control_prefixes_are_guarded() {
        assert_eq!(escape_cell(" =1+1"), "' =1+1");
        assert_eq!(escape_cell("\t=1+1"), "'\t=1+1");
        assert_eq!(escape_cell("\u{0}=1+1"), "'=1+1");
    }

    #[test]
    fn separators_quotes_and_newlines_are_escaped() {
        assert_eq!(escape_cell("a,b"), "\"a,b\"");
        assert_eq!(escape_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(escape_cell("line\nbreak"), "\"line\nbreak\"");
    }

    #[test]
    fn unicode_labels_survive() {
        assert_eq!(escape_cell("éàü"), "éàü");
        assert_eq!(escape_cell("日本語, テスト"), "\"日本語, テスト\"");
    }

    #[test]
    fn csv_has_a_header_and_one_row_per_record() {
        let csv = records_to_csv(&[record("work"), record("more")]);
        let mut lines = csv.lines();
        assert_eq!(lines.next(), Some(CSV_HEADER.join(",").as_str()));
        assert_eq!(lines.count(), 2);
    }

    #[test]
    fn csv_keeps_numeric_columns_numeric() {
        let csv = records_to_csv(&[record("work")]);
        assert!(csv.contains(",1500000,"), "{csv}");
    }

    #[test]
    fn json_export_preserves_raw_strings() {
        let json = records_to_json(
            &[record("=danger")],
            DateTime::parse_from_rfc3339("2026-01-01T10:30:00Z")
                .expect("parse")
                .with_timezone(&Utc),
        );
        assert!(json.contains("\"label\": \"=danger\""), "{json}");
        assert!(json.contains("\"schemaVersion\": 1"), "{json}");
    }
}

//! Bounded session history.
//!
//! History is a small, inspectable JSON document rather than a database. The
//! invariants enforced here are:
//!
//! * at most one record per phase identifier (durable effects are upserted),
//! * at most 5 000 records,
//! * records older than the retention window are dropped,
//! * interrupted phases stay unconfirmed until the user accepts them.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Hard upper bound on the number of retained records.
pub const MAX_HISTORY_RECORDS: usize = 5_000;

/// Default retention window in days.
pub const DEFAULT_RETENTION_DAYS: u32 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryOutcome {
    Completed,
    Skipped,
    Ended,
}

impl HistoryOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            HistoryOutcome::Completed => "completed",
            HistoryOutcome::Skipped => "skipped",
            HistoryOutcome::Ended => "ended",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryPhase {
    Focus,
    ShortBreak,
    LongBreak,
}

impl HistoryPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            HistoryPhase::Focus => "focus",
            HistoryPhase::ShortBreak => "short_break",
            HistoryPhase::LongBreak => "long_break",
        }
    }
}

/// One finished phase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub phase_id: String,
    pub phase: HistoryPhase,
    /// RFC 3339 UTC timestamp.
    pub started_at: String,
    /// RFC 3339 UTC timestamp.
    pub ended_at: String,
    pub duration_ms: u64,
    pub label: String,
    pub outcome: HistoryOutcome,
    pub interrupted: bool,
    pub confirmed: bool,
    /// Local calendar date (`YYYY-MM-DD`) captured when the phase ended.
    pub local_date: String,
}

impl HistoryRecord {
    /// A record counts towards confirmed focus time only when it completed
    /// without interruption and the user did not have to accept it.
    pub fn counts_as_confirmed_focus(&self) -> bool {
        self.confirmed && self.phase == HistoryPhase::Focus
    }

    pub fn ended_at_datetime(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.ended_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
    }
}

/// The on-disk history document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryFile {
    pub schema_version: u32,
    pub records: Vec<HistoryRecord>,
}

impl Default for HistoryFile {
    fn default() -> Self {
        Self {
            schema_version: crate::settings::SETTINGS_SCHEMA_VERSION,
            records: Vec::new(),
        }
    }
}

/// In-memory view of the history document, newest first.
#[derive(Debug, Clone, Default)]
pub struct HistoryBook {
    records: Vec<HistoryRecord>,
}

impl HistoryBook {
    pub fn new(records: Vec<HistoryRecord>) -> Self {
        let mut book = Self { records };
        book.sort();
        book
    }

    pub fn records(&self) -> &[HistoryRecord] {
        &self.records
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Inserts or replaces the record for `record.phase_id`.
    ///
    /// The interruption flag is sticky: once a phase is known to be
    /// interrupted it stays interrupted. A confirmation that the user already
    /// gave for an interrupted phase is never lost because of a repeated
    /// effect, while a late interruption signal correctly withdraws the
    /// implicit confirmation of an otherwise clean phase.
    pub fn upsert(&mut self, record: HistoryRecord) {
        let incoming_confirmed = record.confirmed;
        let incoming_interrupted = record.interrupted;
        match self
            .records
            .iter_mut()
            .find(|candidate| candidate.phase_id == record.phase_id)
        {
            Some(existing) => {
                let user_accepted = (existing.interrupted && existing.confirmed)
                    || (incoming_interrupted && incoming_confirmed);
                existing.phase = record.phase;
                existing.started_at = record.started_at;
                existing.ended_at = record.ended_at;
                existing.duration_ms = record.duration_ms;
                existing.label = record.label;
                existing.outcome = record.outcome;
                existing.local_date = record.local_date;
                existing.interrupted = existing.interrupted || incoming_interrupted;
                existing.confirmed = (existing.outcome == HistoryOutcome::Completed
                    && !existing.interrupted)
                    || user_accepted;
            }
            None => {
                let mut record = record;
                // A brand new record is confirmed only when it completed
                // cleanly; interruptions always require an explicit
                // acceptance from the user and skipped or ended phases never
                // count as confirmed focus time.
                record.confirmed =
                    record.outcome == HistoryOutcome::Completed && !record.interrupted;
                self.records.push(record);
            }
        }
        self.sort();
    }

    /// Marks a phase as accepted by the user.
    pub fn confirm(&mut self, phase_id: &str) -> bool {
        if let Some(record) = self
            .records
            .iter_mut()
            .find(|candidate| candidate.phase_id == phase_id)
        {
            record.confirmed = true;
            true
        } else {
            false
        }
    }

    /// Removes every record.
    pub fn clear(&mut self) {
        self.records.clear();
    }

    /// Returns at most `limit` records, newest first.
    ///
    /// `before` is an exclusive cursor: only records that ended strictly
    /// before that timestamp are returned.
    pub fn list(&self, limit: u32, before: Option<&str>) -> Vec<HistoryRecord> {
        let limit = (limit as usize).min(MAX_HISTORY_RECORDS);
        let cursor = before.and_then(|value| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|parsed| parsed.with_timezone(&Utc))
        });
        self.records
            .iter()
            .filter(|record| match (&cursor, before) {
                (Some(cursor), _) => record
                    .ended_at_datetime()
                    .map(|ended| ended < *cursor)
                    .unwrap_or(false),
                (None, Some(raw)) => record.ended_at.as_str() < raw,
                (None, None) => true,
            })
            .take(limit)
            .cloned()
            .collect()
    }

    /// Drops records that fall outside the retention window and enforces the
    /// hard record cap.
    pub fn prune(&mut self, retention_days: u32, max_records: usize, now: DateTime<Utc>) {
        let cutoff = now - chrono::Duration::days(retention_days as i64);
        self.records
            .retain(|record| match record.ended_at_datetime() {
                Some(ended) => ended >= cutoff,
                // Records with an unreadable timestamp are kept rather than
                // silently destroyed; the record cap still applies to them.
                None => true,
            });
        let max_records = max_records.min(MAX_HISTORY_RECORDS);
        if self.records.len() > max_records {
            self.records.truncate(max_records);
        }
    }

    /// Total confirmed focus milliseconds.
    ///
    /// Only confirmed focus phases contribute; the sum is computed from
    /// milliseconds and never from rounded display values.
    pub fn confirmed_focus_ms(&self) -> u64 {
        self.records
            .iter()
            .filter(|record| record.counts_as_confirmed_focus())
            .map(|record| record.duration_ms)
            .sum()
    }

    fn sort(&mut self) {
        self.records.sort_by(|left, right| {
            right
                .ended_at_datetime()
                .cmp(&left.ended_at_datetime())
                .then_with(|| right.phase_id.cmp(&left.phase_id))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, ended: &str, interrupted: bool) -> HistoryRecord {
        HistoryRecord {
            phase_id: id.to_string(),
            phase: HistoryPhase::Focus,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            ended_at: ended.to_string(),
            duration_ms: 60_000,
            label: String::new(),
            outcome: HistoryOutcome::Completed,
            interrupted,
            confirmed: !interrupted,
            local_date: "2026-01-01".to_string(),
        }
    }

    #[test]
    fn camel_case_field_names() {
        let json =
            serde_json::to_string(&record("a", "2026-01-01T00:00:00Z", false)).expect("serialise");
        for expected in [
            "\"phaseId\"",
            "\"startedAt\"",
            "\"endedAt\"",
            "\"durationMs\"",
            "\"localDate\"",
            "\"interrupted\"",
            "\"confirmed\"",
        ] {
            assert!(json.contains(expected), "missing {expected} in {json}");
        }
    }

    #[test]
    fn upsert_replaces_the_same_phase_only_once() {
        let mut book = HistoryBook::default();
        book.upsert(record("a", "2026-01-01T00:00:00Z", false));
        book.upsert(record("a", "2026-01-01T00:00:00Z", false));
        assert_eq!(book.len(), 1);
    }

    #[test]
    fn upsert_keeps_an_existing_confirmation() {
        let mut book = HistoryBook::default();
        book.upsert(record("a", "2026-01-01T00:00:00Z", true));
        assert!(!book.records()[0].confirmed);
        book.confirm("a");
        assert!(book.records()[0].confirmed);
        book.upsert(record("a", "2026-01-01T00:00:00Z", true));
        assert!(book.records()[0].confirmed);
    }

    #[test]
    fn interrupted_records_stay_unconfirmed_after_upsert() {
        let mut book = HistoryBook::default();
        let mut replacement = record("a", "2026-01-01T00:00:00Z", true);
        replacement.confirmed = true;
        book.upsert(replacement);
        assert!(!book.records()[0].confirmed);
    }

    #[test]
    fn list_returns_newest_first_and_honours_the_cursor() {
        let mut book = HistoryBook::default();
        book.upsert(record("a", "2026-01-01T00:00:00Z", false));
        book.upsert(record("b", "2026-01-02T00:00:00Z", false));
        book.upsert(record("c", "2026-01-03T00:00:00Z", false));
        let all = book.list(10, None);
        assert_eq!(
            all.iter()
                .map(|item| item.phase_id.as_str())
                .collect::<Vec<_>>(),
            vec!["c", "b", "a"]
        );
        let page = book.list(10, Some("2026-01-03T00:00:00Z"));
        assert_eq!(
            page.iter()
                .map(|item| item.phase_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
    }

    #[test]
    fn prune_drops_old_records_and_enforces_the_cap() {
        let now = DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z")
            .expect("parse")
            .with_timezone(&Utc);
        let mut book = HistoryBook::default();
        book.upsert(record("old", "2026-01-01T00:00:00Z", false));
        book.upsert(record("new", "2026-05-30T00:00:00Z", false));
        book.prune(90, MAX_HISTORY_RECORDS, now);
        assert_eq!(book.len(), 1);
        assert_eq!(book.records()[0].phase_id, "new");
    }

    #[test]
    fn prune_truncates_to_the_record_cap() {
        let now = DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z")
            .expect("parse")
            .with_timezone(&Utc);
        let mut book = HistoryBook::default();
        for index in 0..10 {
            let ended = format!("2026-05-{:02}T00:00:00Z", index + 1);
            book.upsert(record(&format!("p{index}"), &ended, false));
        }
        book.prune(90, 4, now);
        assert_eq!(book.len(), 4);
    }

    #[test]
    fn confirmed_focus_totals_only_count_accepted_focus_phases() {
        let mut book = HistoryBook::default();
        book.upsert(record("a", "2026-01-01T00:00:00Z", false));
        let mut interrupted = record("b", "2026-01-02T00:00:00Z", true);
        interrupted.phase = HistoryPhase::Focus;
        book.upsert(interrupted);
        let mut skipped = record("c", "2026-01-03T00:00:00Z", false);
        skipped.outcome = HistoryOutcome::Skipped;
        skipped.confirmed = false;
        book.upsert(skipped);
        assert_eq!(book.confirmed_focus_ms(), 60_000);
        book.confirm("b");
        assert_eq!(book.confirmed_focus_ms(), 120_000);
    }

    #[test]
    fn clear_removes_everything() {
        let mut book = HistoryBook::default();
        book.upsert(record("a", "2026-01-01T00:00:00Z", false));
        book.clear();
        assert!(book.is_empty());
    }
}

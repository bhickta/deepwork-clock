//! Git-friendly session records.
//!
//! The history can be shared between computers without a server: one small
//! Markdown file per finished phase, written into a folder that the user keeps
//! in a git repository. Git merges the files by name, so concurrent work on two
//! machines does not create conflicts, and every file stays readable in an
//! editor.
//!
//! Each file has a human-readable table and one HTML comment with the exact
//! record as JSON. The JSON is the source of truth when the file is read back;
//! the table is only presentation. Files whose comment is missing, malformed
//! or unsafe are skipped instead of being trusted.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate};

use crate::history::{HistoryPhase, HistoryRecord};

/// Folder inside the user's sync repository.
pub const SESSION_DIRECTORY: &str = "deepwork-sessions";

const MARKER_START: &str = "<!-- deepwork-clock:v1 ";
const MARKER_END: &str = " -->";

/// Largest Markdown session file accepted from disk.
const MAX_FILE_BYTES: u64 = 64 * 1024;

/// One finished phase rendered as Markdown.
pub fn render(record: &HistoryRecord) -> String {
    let duration = human_duration(record.duration_ms);
    let label = if record.label.trim().is_empty() {
        "—".to_string()
    } else {
        record.label.trim().to_string()
    };
    let json = serde_json::to_string(record).unwrap_or_else(|_| "null".to_string());
    format!(
        "# {phase} session — {date}\n\n\
         | Field | Value |\n\
         | --- | --- |\n\
         | Phase | {phase} |\n\
         | Started | {started} |\n\
         | Ended | {ended} |\n\
         | Duration | {duration} |\n\
         | Outcome | {outcome} |\n\
         | Interrupted | {interrupted} |\n\
         | Confirmed | {confirmed} |\n\
         | Label | {label} |\n\
         | Session id | `{id}` |\n\n\
         <!-- This line is read by Deepwork Clock. Keep it intact. -->\n\
         {marker}{json}{end}\n",
        phase = phase_name(record.phase),
        date = record.local_date,
        started = record.started_at,
        ended = record.ended_at,
        duration = duration,
        outcome = record.outcome.as_str(),
        interrupted = yes_no(record.interrupted),
        confirmed = yes_no(record.confirmed),
        label = label,
        id = record.phase_id,
        marker = MARKER_START,
        json = json,
        end = MARKER_END,
    )
}

/// Reads a record back from a Markdown session file.
///
/// Returns `None` when the marker is absent, the JSON is invalid or the record
/// fails the safety checks.
pub fn parse(text: &str) -> Option<HistoryRecord> {
    let start = text.find(MARKER_START)?;
    let rest = &text[start + MARKER_START.len()..];
    let end = rest.find(MARKER_END)?;
    let json = rest[..end].trim();
    let record: HistoryRecord = serde_json::from_str(json).ok()?;
    validate(&record).then_some(record)
}

/// A stable, filesystem-safe file name. Git stores one file per phase.
pub fn file_name(record: &HistoryRecord) -> String {
    let date = if NaiveDate::parse_from_str(&record.local_date, "%Y-%m-%d").is_ok() {
        record.local_date.clone()
    } else {
        record
            .started_at
            .get(..10)
            .filter(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok())
            .unwrap_or("undated")
            .to_string()
    };
    format!("{date}-{}.md", sanitize_id(&record.phase_id))
}

/// Rejects records that could escape the folder or contain absurd values.
fn validate(record: &HistoryRecord) -> bool {
    if record.phase_id.is_empty() || record.phase_id.len() > 128 {
        return false;
    }
    if !record
        .phase_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return false;
    }
    if record.label.chars().count() > 500 {
        return false;
    }
    if record.duration_ms == 0 || record.duration_ms > 7 * 24 * 60 * 60 * 1000 {
        return false;
    }
    if NaiveDate::parse_from_str(&record.local_date, "%Y-%m-%d").is_err() {
        return false;
    }
    let started = DateTime::parse_from_rfc3339(&record.started_at);
    let ended = DateTime::parse_from_rfc3339(&record.ended_at);
    matches!((started, ended), (Ok(start), Ok(end)) if end >= start)
}

fn sanitize_id(id: &str) -> String {
    let mut value: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if value.is_empty() {
        value.push_str("session");
    }
    value.truncate(64);
    value
}

fn phase_name(phase: HistoryPhase) -> &'static str {
    match phase {
        HistoryPhase::Focus => "Focus",
        HistoryPhase::ShortBreak => "Short break",
        HistoryPhase::LongBreak => "Long break",
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

/// A short human duration, for the Markdown table only.
pub fn human_duration(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m {seconds:02}s")
    } else if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

/// What one sync pass did.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncOutcome {
    /// Markdown files found in the session folder.
    pub files: usize,
    /// New local files written for records that were missing.
    pub written: usize,
    /// Records read back from Markdown files.
    pub parsed: Vec<HistoryRecord>,
    /// Files skipped because the marker or record was invalid.
    pub rejected: usize,
}

/// Writes missing records and reads every valid record in the folder.
///
/// The chosen folder must already exist (it is normally a git checkout). The
/// session files live in [`SESSION_DIRECTORY`] so the rest of the repository is
/// never touched.
pub fn sync_directory(root: &Path, records: &[HistoryRecord]) -> Result<SyncOutcome, String> {
    if !root.is_dir() {
        return Err(format!(
            "The sync folder does not exist or is not a directory: {}",
            root.display()
        ));
    }
    let directory = root.join(SESSION_DIRECTORY);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("The session folder could not be created: {error}"))?;

    let mut written = 0usize;
    for record in records {
        if !validate(record) {
            continue;
        }
        let path = directory.join(file_name(record));
        if path.exists() {
            continue;
        }
        write_atomic(&path, render(record).as_bytes())?;
        written += 1;
    }

    let mut parsed = Vec::new();
    let mut rejected = 0usize;
    let mut files = 0usize;
    let entries = fs::read_dir(&directory)
        .map_err(|error| format!("The session folder could not be read: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        files += 1;
        match read_limited(&path) {
            Some(text) => match parse(&text) {
                Some(record) => parsed.push(record),
                None => rejected += 1,
            },
            None => rejected += 1,
        }
    }
    parsed.sort_by(|left, right| left.started_at.cmp(&right.started_at));

    Ok(SyncOutcome {
        files,
        written,
        parsed,
        rejected,
    })
}

/// Path of the session folder inside a repository, for display and tests.
pub fn session_directory(root: &Path) -> PathBuf {
    root.join(SESSION_DIRECTORY)
}

fn read_limited(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("md.tmp");
    {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("A session file could not be created: {error}"))?;
        file.write_all(content)
            .map_err(|error| format!("A session file could not be written: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("A session file could not be flushed: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("A session file could not be replaced: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::HistoryOutcome;

    fn record() -> HistoryRecord {
        HistoryRecord {
            phase_id: "ab917686-2b0a-4372-be01-f47e2b8fd5b9".to_string(),
            phase: HistoryPhase::Focus,
            started_at: "2026-10-22T09:00:00Z".to_string(),
            ended_at: "2026-10-22T09:50:00Z".to_string(),
            duration_ms: 3_000_000,
            label: "Writing | notes".to_string(),
            outcome: HistoryOutcome::Completed,
            interrupted: false,
            confirmed: true,
            local_date: "2026-10-22".to_string(),
        }
    }

    #[test]
    fn a_record_round_trips_through_markdown() {
        let text = render(&record());
        assert!(text.contains("| Focus |") || text.contains("| Phase | Focus |"));
        assert!(text.contains("50m 00s"));
        assert_eq!(parse(&text), Some(record()));
    }

    #[test]
    fn the_file_name_is_bounded_and_safe() {
        let mut value = record();
        value.phase_id = "../../etc/passwd".to_string();
        let name = file_name(&value);
        assert!(!name.contains('/'));
        assert!(name.starts_with("2026-10-22-"));
        assert!(name.ends_with(".md"));
    }

    #[test]
    fn unsafe_or_malformed_records_are_refused() {
        let text = render(&record());
        assert!(parse(&text.replace("deepwork-clock:v1", "other")).is_none());
        assert!(parse("no marker here").is_none());

        let mut bad = record();
        bad.duration_ms = 0;
        assert!(!validate(&bad));

        let mut bad_date = record();
        bad_date.local_date = "22-10-2026".to_string();
        assert!(!validate(&bad_date));

        let mut reversed = record();
        reversed.ended_at = "2026-10-22T08:00:00Z".to_string();
        assert!(!validate(&reversed));
    }

    #[test]
    fn syncing_writes_missing_files_and_reads_them_back() {
        let root = tempfile::tempdir().expect("temp dir");
        let first = record();
        let outcome = sync_directory(root.path(), std::slice::from_ref(&first)).expect("sync");
        assert_eq!(outcome.written, 1);
        assert_eq!(outcome.files, 1);
        assert_eq!(outcome.parsed, vec![first.clone()]);

        // A second pass does not duplicate the file.
        let again = sync_directory(root.path(), &[first]).expect("sync");
        assert_eq!(again.written, 0);
        assert_eq!(again.files, 1);
        assert_eq!(again.parsed.len(), 1);
    }

    #[test]
    fn a_malformed_file_is_reported_but_does_not_stop_the_sync() {
        let root = tempfile::tempdir().expect("temp dir");
        sync_directory(root.path(), &[record()]).expect("sync");
        fs::write(session_directory(root.path()).join("broken.md"), "hello").expect("write");

        let outcome = sync_directory(root.path(), &[]).expect("sync");
        assert_eq!(outcome.files, 2);
        assert_eq!(outcome.rejected, 1);
        assert_eq!(outcome.parsed.len(), 1);
    }

    #[test]
    fn a_missing_folder_is_an_error() {
        let result = sync_directory(Path::new("/definitely/not/a/folder"), &[]);
        assert!(result.is_err());
    }
}

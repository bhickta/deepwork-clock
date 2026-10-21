//! Durable file helpers.
//!
//! Every durable document is replaced with the same sequence:
//!
//! 1. write a temporary file in the *same* directory,
//! 2. flush it to the device (`File::sync_all`),
//! 3. copy the previous good document to `<name>.bak`,
//! 4. rename the temporary file over the target,
//! 5. flush the directory entry (POSIX only).
//!
//! The temporary file lives in the same directory so that the final rename
//! never crosses a file-system boundary and therefore stays atomic. On
//! Windows `std::fs::rename` maps to `MoveFileExW` with
//! `MOVEFILE_REPLACE_EXISTING`, which replaces an existing file; it can still
//! fail when another process holds the target open, which is why the backup
//! exists and why a failed write never destroys the previous document.
//!
//! Corrupt or oversized documents are quarantined by renaming them next to
//! the original with a timestamp suffix. The original bytes are never
//! overwritten and never deleted.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{BridgeError, CODE_CORRUPT_DATA, CODE_STORAGE_UNAVAILABLE, CODE_UNSUPPORTED};

/// Largest settings document that is accepted.
pub const MAX_SETTINGS_BYTES: u64 = 256 * 1024;

/// Largest history document that is accepted.
pub const MAX_HISTORY_BYTES: u64 = 32 * 1024 * 1024;

/// Largest recovery document that is accepted.
pub const MAX_RECOVERY_BYTES: u64 = 256 * 1024;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum StorageError {
    /// The file system refused the operation.
    Io(std::io::Error),
    /// The document exists but cannot be parsed.
    Corrupt(String),
    /// The document was written by a newer version of the application.
    FutureSchema { found: u32, supported: u32 },
    /// The document is larger than the accepted bound.
    TooLarge { size: u64, limit: u64 },
    /// The document does not exist.
    NotFound,
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::Io(error) => write!(f, "storage I/O error: {error}"),
            StorageError::Corrupt(detail) => write!(f, "corrupt document: {detail}"),
            StorageError::FutureSchema { found, supported } => write!(
                f,
                "document uses schema version {found}, this build supports {supported}"
            ),
            StorageError::TooLarge { size, limit } => {
                write!(f, "document is {size} bytes, the limit is {limit}")
            }
            StorageError::NotFound => write!(f, "document not found"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        StorageError::Io(error)
    }
}

impl StorageError {
    /// Maps a storage failure onto the stable bridge error vocabulary.
    pub fn to_bridge_error(&self) -> BridgeError {
        match self {
            StorageError::Io(error) => BridgeError::storage(format!(
                "The application could not write its data. {error}"
            )),
            StorageError::Corrupt(detail) => BridgeError::corrupt(format!(
                "Stored data could not be read and was set aside. {detail}"
            )),
            StorageError::FutureSchema { found, supported } => BridgeError::unsupported(format!(
                "Stored data uses schema version {found}; this build supports {supported}. The file was left untouched."
            )),
            StorageError::TooLarge { size, limit } => BridgeError::corrupt(format!(
                "Stored data is {size} bytes, which exceeds the {limit} byte limit. The file was set aside."
            )),
            StorageError::NotFound => BridgeError::storage("The requested data does not exist."),
        }
    }
}

/// Path of the previous good copy of a document.
pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

/// Writes `bytes` to `path` using the durable replacement sequence.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path.file_name().unwrap_or_default().to_os_string();
    let temp_name = format!(
        ".{}.tmp-{}-{}",
        file_name.to_string_lossy(),
        std::process::id(),
        counter
    );
    let temp_path = parent.join(temp_name);

    let write_result = (|| -> Result<(), StorageError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    if path.exists() {
        // Keep the previous good document before replacing it.
        if let Err(error) = copy_backup(path) {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }

    sync_directory(parent);
    Ok(())
}

/// Copies the current document to its `.bak` companion, atomically.
pub fn copy_backup(path: &Path) -> Result<(), StorageError> {
    let backup = backup_path(path);
    let temp = backup.with_extension("bak.tmp");
    fs::copy(path, &temp)?;
    let file = File::open(&temp)?;
    file.sync_all()?;
    fs::rename(&temp, &backup)?;
    Ok(())
}

/// Reads a document, refusing anything larger than `limit` bytes.
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, StorageError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > limit {
        return Err(StorageError::TooLarge {
            size: metadata.len(),
            limit,
        });
    }
    Ok(fs::read(path)?)
}

/// Moves a document aside so that it is never overwritten or lost.
///
/// The quarantined file keeps a timestamp suffix and stays next to the
/// original. When a file with that name already exists - two corrupt
/// documents inside the same second - a counter is appended, so a quarantine
/// never destroys an earlier one.
pub fn quarantine_file(path: &Path, stamp: &str) -> Result<PathBuf, StorageError> {
    let file_name = path.file_name().unwrap_or_default().to_os_string();
    let mut target = path.with_file_name(format!(
        "{}.quarantine-{}",
        file_name.to_string_lossy(),
        stamp
    ));
    let mut counter = 1u32;
    while target.exists() {
        target = path.with_file_name(format!(
            "{}.quarantine-{}-{}",
            file_name.to_string_lossy(),
            stamp,
            counter
        ));
        counter = counter.saturating_add(1);
    }
    fs::rename(path, &target)?;
    sync_directory(path.parent().unwrap_or_else(|| Path::new(".")));
    Ok(target)
}

/// A short, sortable timestamp used for quarantine file names.
pub fn quarantine_stamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    format!("{seconds}")
}

/// Removes a document, ignoring a missing file.
pub fn remove_file(path: &Path) -> Result<(), StorageError> {
    match fs::remove_file(path) {
        Ok(()) => {
            sync_directory(path.parent().unwrap_or_else(|| Path::new(".")));
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Flushes a directory entry so that a rename survives a power loss.
///
/// Windows does not allow opening a directory as a file, so the call is a
/// no-op there; `MoveFileExW` already orders its metadata updates.
fn sync_directory(directory: &Path) {
    #[cfg(unix)]
    {
        if let Ok(handle) = File::open(directory) {
            let _ = handle.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
    }
}

/// Checks the schema version of a serialisable document.
pub fn check_schema_version(found: u32, supported: u32) -> Result<(), StorageError> {
    if found > supported {
        return Err(StorageError::FutureSchema { found, supported });
    }
    Ok(())
}

/// Convenience helper for documents that report a corrupt payload.
pub fn corrupt(detail: impl Into<String>) -> StorageError {
    StorageError::Corrupt(detail.into())
}

/// Maps a storage error to the bridge vocabulary, keeping the corrupt-data
/// code for quarantined documents.
pub fn to_bridge_error(error: &StorageError) -> BridgeError {
    match error {
        StorageError::FutureSchema { found, supported } => BridgeError::new(
            CODE_UNSUPPORTED,
            format!(
                "Stored data uses schema version {found}; this build supports {supported}. The file was left untouched."
            ),
        ),
        StorageError::Corrupt(_) | StorageError::TooLarge { .. } => BridgeError::new(
            CODE_CORRUPT_DATA,
            "Stored data could not be read and was set aside.",
        ),
        StorageError::Io(_) => BridgeError::new(
            CODE_STORAGE_UNAVAILABLE,
            "The application could not read or write its data.",
        ),
        StorageError::NotFound => BridgeError::new(
            CODE_STORAGE_UNAVAILABLE,
            "The requested data does not exist.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    #[test]
    fn writes_and_reads_back() {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");
        write_atomic(&path, b"hello").expect("write");
        assert_eq!(read_limited(&path, 1024).expect("read"), b"hello");
    }

    #[test]
    fn creates_missing_directories() {
        let dir = temp_dir();
        let path = dir.path().join("nested").join("deep").join("settings.json");
        write_atomic(&path, b"{}").expect("write");
        assert!(path.exists());
    }

    #[test]
    fn replacement_keeps_a_backup_of_the_previous_document() {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");
        write_atomic(&path, b"first").expect("write");
        write_atomic(&path, b"second").expect("write");
        assert_eq!(read_limited(&path, 1024).expect("read"), b"second");
        assert_eq!(
            read_limited(&backup_path(&path), 1024).expect("read"),
            b"first"
        );
    }

    #[test]
    fn temporary_files_are_removed_after_a_successful_write() {
        let dir = temp_dir();
        let path = dir.path().join("settings.json");
        write_atomic(&path, b"hello").expect("write");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn oversized_documents_are_refused() {
        let dir = temp_dir();
        let path = dir.path().join("history.json");
        let mut file = File::create(&path).expect("create");
        file.write_all(&[b'x'; 64]).expect("write");
        drop(file);
        let error = read_limited(&path, 16).expect_err("too large");
        assert!(matches!(error, StorageError::TooLarge { .. }));
    }

    #[test]
    fn quarantine_moves_the_original_aside() {
        let dir = temp_dir();
        let path = dir.path().join("history.json");
        write_atomic(&path, b"broken").expect("write");
        let quarantined = quarantine_file(&path, "123").expect("quarantine");
        assert!(!path.exists());
        assert!(quarantined.exists());
        assert_eq!(read_limited(&quarantined, 1024).expect("read"), b"broken");
    }

    #[test]
    fn quarantine_never_overwrites_an_earlier_quarantine() {
        let dir = temp_dir();
        let path = dir.path().join("history.json");
        write_atomic(&path, b"first").expect("write");
        let first = quarantine_file(&path, "123").expect("quarantine");
        write_atomic(&path, b"second").expect("write");
        let second = quarantine_file(&path, "123").expect("quarantine");
        assert_ne!(first, second);
        assert!(first.exists());
        assert!(second.exists());
        assert_eq!(read_limited(&first, 1024).expect("read"), b"first");
        assert_eq!(read_limited(&second, 1024).expect("read"), b"second");
    }

    #[test]
    fn future_schema_versions_are_refused() {
        assert!(check_schema_version(1, 1).is_ok());
        let error = check_schema_version(2, 1).expect_err("future");
        assert!(matches!(
            error,
            StorageError::FutureSchema {
                found: 2,
                supported: 1
            }
        ));
    }

    #[test]
    fn removing_a_missing_document_is_not_an_error() {
        let dir = temp_dir();
        remove_file(&dir.path().join("missing.json")).expect("remove");
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            to_bridge_error(&StorageError::Io(std::io::Error::other("x"))).code,
            CODE_STORAGE_UNAVAILABLE
        );
        assert_eq!(to_bridge_error(&corrupt("x")).code, CODE_CORRUPT_DATA);
        assert_eq!(
            to_bridge_error(&StorageError::FutureSchema {
                found: 2,
                supported: 1
            })
            .code,
            CODE_UNSUPPORTED
        );
    }
}

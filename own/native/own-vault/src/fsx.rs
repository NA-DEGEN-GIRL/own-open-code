//! Windows file primitives: atomic replace/create via MoveFileExW, flushed
//! temp files, a cross-process exclusive lock, and retries for the transient
//! sharing violations that antivirus scanners and indexers cause.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime};

use windows::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};
use windows::core::PCWSTR;

const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;

/// How long transient sharing violations are retried before giving up.
const RETRY_FOR: Duration = Duration::from_secs(2);

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Converts a windows-rs error into an io::Error whose raw_os_error is the
/// Win32 code (windows-rs keeps the HRESULT form, e.g. 0x80070020).
pub fn win_error(error: windows::core::Error) -> io::Error {
    let hr = error.code().0 as u32;
    if hr & 0xFFFF_0000 == 0x8007_0000 {
        return io::Error::from_raw_os_error((hr & 0xFFFF) as i32);
    }
    io::Error::from_raw_os_error(hr as i32)
}

fn is_transient(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
    )
}

/// Runs `op`, retrying transient sharing violations for up to [`RETRY_FOR`].
pub(crate) fn retrying<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let deadline = Instant::now() + RETRY_FOR;
    let mut delay = Duration::from_millis(5);
    loop {
        match op() {
            Err(error) if is_transient(&error) && Instant::now() < deadline => {
                sleep(delay);
                delay = (delay * 2).min(Duration::from_millis(100));
            }
            result => return result,
        }
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// `MoveFileExW(from, to, MOVEFILE_WRITE_THROUGH [| MOVEFILE_REPLACE_EXISTING])`.
/// Without `replace`, an existing target fails with `ErrorKind::AlreadyExists`,
/// which turns "write temp, then move" into an atomic create-with-content.
pub fn move_file(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    let (src, dst) = (wide(from), wide(to));
    let flags = match replace {
        true => MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        false => MOVEFILE_WRITE_THROUGH,
    };
    retrying(|| unsafe { MoveFileExW(PCWSTR(src.as_ptr()), PCWSTR(dst.as_ptr()), flags) }.map_err(win_error))
}

/// Writes `bytes` to a new `<stem>.<pid>.<n>.tmp` in `dir` and flushes it (FlushFileBuffers).
pub fn write_temp(dir: &Path, stem: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    loop {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("{stem}.{}.{n}.tmp", std::process::id()));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let written = file.write_all(bytes).and_then(|_| file.sync_all());
        drop(file);
        if let Err(error) = written {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        return Ok(path);
    }
}

/// temp → fsync → MoveFileExW. With `replace == false` the call fails with
/// `AlreadyExists` instead of overwriting.
pub fn write_atomic(target: &Path, bytes: &[u8], replace: bool) -> io::Result<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let stem = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = write_temp(dir, &stem, bytes)?;
    move_file(&temp, target, replace).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// Reads a whole file; `Ok(None)` when it does not exist.
pub fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match retrying(|| fs::read(path)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Removes a file; `Ok(false)` when it did not exist.
pub fn remove(path: &Path) -> io::Result<bool> {
    match retrying(|| fs::remove_file(path)) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Overwrites a file in place with zeros and flushes it (best-effort shred;
/// SSD wear levelling may keep old blocks, which only ever held DPAPI blobs).
pub fn overwrite_zeros(path: &Path) -> io::Result<()> {
    let mut file = retrying(|| OpenOptions::new().write(true).open(path))?;
    let len = file.metadata()?.len() as usize;
    file.write_all(&vec![0u8; len])?;
    file.sync_all()
}

/// Deletes `*.tmp` files older than `age` left behind by crashed writers.
pub fn sweep_temps(dir: &Path, age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .filter(|entry| {
            entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| now.duration_since(modified).is_ok_and(|elapsed| elapsed >= age))
        })
        .for_each(|entry| {
            let _ = fs::remove_file(entry.path());
        });
}

/// Cross-process exclusive lock. The file is opened with share mode 0, so any
/// other open fails with a sharing violation until the handle is closed. The
/// kernel closes the handle when the holder exits or is killed, so the lock
/// can never go stale. The file itself is never deleted.
pub struct ExclusiveLock {
    _file: File,
}

impl ExclusiveLock {
    /// `Ok(None)` when the lock is still held by someone else after `timeout`.
    pub fn acquire(path: &Path, timeout: Duration) -> io::Result<Option<Self>> {
        let deadline = Instant::now() + timeout;
        let mut delay = Duration::from_millis(1);
        loop {
            match OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .share_mode(0)
                .open(path)
            {
                Ok(file) => return Ok(Some(Self { _file: file })),
                Err(error) if is_transient(&error) => {
                    if Instant::now() >= deadline {
                        return Ok(None);
                    }
                    sleep(delay);
                    delay = (delay * 2).min(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

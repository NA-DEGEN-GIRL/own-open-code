//! The vault directory (`OWN_HOME\vault`, 01 §5.1, 02 §2.3):
//!
//! - `<id>.dpapi`       current secret (raw DPAPI blob)
//! - `<id>.dpapi.prev`  previous secret, kept by `put{keepPrev}` (02 §3.5 F4)
//! - `<id>.lock`        refresh lease `{pid, startedAt, until}` (02 §3.5 F3)
//! - `.own-vault.mutex` cross-process mutex for every mutation (never deleted)
//! - `*.tmp`            in-flight temp files; stale ones are swept on open
//!
//! Reads take no lock: every file is replaced atomically, so a reader sees
//! either the old or the new complete blob.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::dpapi;
use crate::fsx::{self, ExclusiveLock};
use crate::lease::{self, Lease};
use crate::secret::Secret;

/// Upper bound for one plaintext value (an OAuth bundle is a few KiB).
pub const MAX_VALUE_BYTES: usize = 256 * 1024;
pub const MAX_ID_LEN: usize = 128;
const MUTEX_FILE: &str = ".own-vault.mutex";
const TEMP_MAX_AGE: Duration = Duration::from_secs(600);
const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum VaultError {
    InvalidId,
    BadRequest(String),
    NotFound {
        has_prev: bool,
    },
    DecryptFailed {
        has_prev: bool,
    },
    EncryptFailed,
    /// `ifGeneration` did not match; carries the generation actually stored.
    Conflict {
        generation: Option<u64>,
    },
    /// The vault mutex stayed held by another process for the whole timeout.
    Busy,
    Io(io::Error),
}

impl From<io::Error> for VaultError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub struct Entry {
    /// Plaintext, guaranteed to be valid UTF-8.
    pub value: Secret,
    pub generation: Option<u64>,
}

impl Entry {
    pub fn text(&self) -> &str {
        std::str::from_utf8(self.value.as_bytes()).unwrap_or_default()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Acquire {
    Acquired(Lease),
    /// Someone else holds a live lease; `None` when its file is unreadable but fresh.
    Held(Option<Lease>),
}

enum LeaseFile {
    Absent,
    Stale,
    Live(Option<Lease>),
}

pub struct Vault {
    dir: PathBuf,
    lock_timeout: Duration,
}

impl Vault {
    /// Creates the directory if needed and sweeps temp files older than 10 minutes.
    pub fn open(dir: impl Into<PathBuf>) -> io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        fsx::sweep_temps(&dir, TEMP_MAX_AGE);
        Ok(Self {
            dir,
            lock_timeout: DEFAULT_LOCK_TIMEOUT,
        })
    }

    pub fn with_lock_timeout(self, lock_timeout: Duration) -> Self {
        Self { lock_timeout, ..self }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn mutex_path(&self) -> PathBuf {
        self.dir.join(MUTEX_FILE)
    }

    fn file(&self, id: &str, suffix: &str) -> PathBuf {
        self.dir.join(format!("{id}{suffix}"))
    }

    fn has_prev(&self, id: &str) -> bool {
        self.file(id, ".dpapi.prev").is_file()
    }

    /// Takes the vault mutex. Recreates the directory first, so a vault
    /// directory removed while the helper runs does not wedge every write.
    fn lock(&self) -> Result<ExclusiveLock, VaultError> {
        fs::create_dir_all(&self.dir)?;
        ExclusiveLock::acquire(&self.mutex_path(), self.lock_timeout)?.ok_or(VaultError::Busy)
    }

    /// Reads `<id>.dpapi`, or `<id>.dpapi.prev` when `prev`.
    pub fn get(&self, id: &str, prev: bool) -> Result<Entry, VaultError> {
        check_id(id)?;
        let path = self.file(id, if prev { ".dpapi.prev" } else { ".dpapi" });
        let has_prev = || !prev && self.has_prev(id);
        let Some(sealed) = fsx::read_optional(&path)? else {
            return Err(VaultError::NotFound { has_prev: has_prev() });
        };
        unseal(id, &sealed).ok_or_else(|| VaultError::DecryptFailed { has_prev: has_prev() })
    }

    /// Atomically replaces `<id>.dpapi` (temp → fsync → MoveFileExW with
    /// REPLACE_EXISTING | WRITE_THROUGH). With `keep_prev`, the current blob is
    /// first copied to `<id>.dpapi.prev` the same way, so at every instant
    /// both files are complete. With `if_generation`, the write only happens
    /// when the stored value's `generation` equals it (compare-and-swap).
    /// Returns the `generation` of the new value, if it has one.
    pub fn put(
        &self,
        id: &str,
        value: &str,
        keep_prev: bool,
        if_generation: Option<u64>,
    ) -> Result<Option<u64>, VaultError> {
        check_id(id)?;
        if value.len() > MAX_VALUE_BYTES {
            return Err(VaultError::BadRequest(format!("value exceeds {MAX_VALUE_BYTES} bytes")));
        }
        let sealed = dpapi::protect(value.as_bytes(), &dpapi::entropy(id)).map_err(|_| VaultError::EncryptFailed)?;
        let _guard = self.lock()?;
        let target = self.file(id, ".dpapi");
        let current = fsx::read_optional(&target)?;
        if let Some(expected) = if_generation {
            let Some(current) = &current else {
                return Err(VaultError::Conflict { generation: None });
            };
            let stored = unseal(id, current)
                .ok_or_else(|| VaultError::DecryptFailed {
                    has_prev: self.has_prev(id),
                })?
                .generation;
            if stored != Some(expected) {
                return Err(VaultError::Conflict { generation: stored });
            }
        }
        if let (true, Some(current)) = (keep_prev, &current) {
            fsx::write_atomic(&self.file(id, ".dpapi.prev"), current, true)?;
        }
        fsx::write_atomic(&target, &sealed, true)?;
        Ok(generation_of(value))
    }

    /// Removes `<id>.dpapi`, `<id>.dpapi.prev` and leftover temp files of this
    /// id, plus a stale lease file. With `shred`, each blob is overwritten with
    /// zeros and flushed before removal. Returns whether a secret existed.
    pub fn delete(&self, id: &str, shred: bool) -> Result<bool, VaultError> {
        check_id(id)?;
        let _guard = self.lock()?;
        let prefix = format!("{id}.dpapi.");
        let leftovers = fs::read_dir(&self.dir)?
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(&prefix) && name.ends_with(".tmp"))
            .map(|name| self.dir.join(name));
        let mut existed = false;
        for (index, path) in [self.file(id, ".dpapi"), self.file(id, ".dpapi.prev")]
            .into_iter()
            .chain(leftovers)
            .enumerate()
        {
            if shred && path.is_file() {
                fsx::overwrite_zeros(&path)?;
            }
            let removed = fsx::remove(&path)?;
            existed |= removed && index < 2;
        }
        let lease_path = self.file(id, ".lock");
        if let LeaseFile::Stale = read_lease(&lease_path, lease::now_ms())? {
            fsx::remove(&lease_path)?;
        }
        Ok(existed)
    }

    /// Account ids that have a current secret file, sorted.
    pub fn list(&self) -> Result<Vec<String>, VaultError> {
        let mut ids: Vec<String> = fs::read_dir(&self.dir)?
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let id = name.strip_suffix(".dpapi")?;
                valid_id(id).then(|| id.to_owned())
            })
            .collect();
        ids.sort();
        Ok(ids)
    }

    /// Takes the refresh lease `<id>.lock` for `pid` unless a live one exists.
    /// A lease is stale when `until` has passed, its pid is not running, or its
    /// file is unreadable and older than the default TTL; stale leases are
    /// replaced. The whole check-and-create runs under the vault mutex.
    pub fn lease_acquire(&self, id: &str, pid: u32, ttl_ms: u64) -> Result<Acquire, VaultError> {
        check_id(id)?;
        if pid == 0 {
            return Err(VaultError::BadRequest("pid must be a running process id".into()));
        }
        if !(lease::MIN_TTL_MS..=lease::MAX_TTL_MS).contains(&ttl_ms) {
            return Err(VaultError::BadRequest(format!(
                "ttlMs must be within {}..={}",
                lease::MIN_TTL_MS,
                lease::MAX_TTL_MS
            )));
        }
        let _guard = self.lock()?;
        let path = self.file(id, ".lock");
        let now = lease::now_ms();
        match read_lease(&path, now)? {
            LeaseFile::Live(holder) => return Ok(Acquire::Held(holder)),
            LeaseFile::Stale => {
                fsx::remove(&path)?;
            }
            LeaseFile::Absent => {}
        }
        let lease = Lease {
            pid,
            started_at: now,
            until: now + ttl_ms,
        };
        let body = serde_json::to_vec(&lease).map_err(io::Error::other)?;
        match fsx::write_atomic(&path, &body, false) {
            Ok(()) => Ok(Acquire::Acquired(lease)),
            // Only reachable when a writer bypasses the vault mutex.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => match read_lease(&path, now)? {
                LeaseFile::Live(holder) => Ok(Acquire::Held(holder)),
                _ => Ok(Acquire::Held(None)),
            },
            Err(error) => Err(error.into()),
        }
    }

    /// Removes `<id>.lock` only if it is still the lease `(pid, started_at)`.
    pub fn lease_release(&self, id: &str, pid: u32, started_at: u64) -> Result<bool, VaultError> {
        check_id(id)?;
        let _guard = self.lock()?;
        let path = self.file(id, ".lock");
        let Some(bytes) = fsx::read_optional(&path)? else {
            return Ok(false);
        };
        match serde_json::from_slice::<Lease>(&bytes) {
            Ok(lease) if lease.pid == pid && lease.started_at == started_at => Ok(fsx::remove(&path)?),
            _ => Ok(false),
        }
    }
}

fn read_lease(path: &Path, now: u64) -> io::Result<LeaseFile> {
    let Some(bytes) = fsx::read_optional(path)? else {
        return Ok(LeaseFile::Absent);
    };
    if let Ok(lease) = serde_json::from_slice::<Lease>(&bytes) {
        return Ok(if lease.is_live(now) {
            LeaseFile::Live(Some(lease))
        } else {
            LeaseFile::Stale
        });
    }
    // Unreadable, e.g. created by open("wx") in another client that crashed
    // before writing. Treat it as held until it is older than the default TTL.
    let modified = match fs::metadata(path).and_then(|meta| meta.modified()) {
        Ok(modified) => modified,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(LeaseFile::Absent),
        Err(error) => return Err(error),
    };
    let age = modified.elapsed().unwrap_or_default();
    Ok(match age >= Duration::from_millis(lease::DEFAULT_TTL_MS) {
        true => LeaseFile::Stale,
        false => LeaseFile::Live(None),
    })
}

fn unseal(id: &str, sealed: &[u8]) -> Option<Entry> {
    let value = dpapi::unprotect(sealed, &dpapi::entropy(id)).ok()?;
    let generation = generation_of(std::str::from_utf8(value.as_bytes()).ok()?);
    Some(Entry { value, generation })
}

/// `generation` of a vault value (02 §2.4.5) when it is a JSON object with an
/// unsigned integer `generation`; other fields are skipped without copying.
fn generation_of(text: &str) -> Option<u64> {
    #[derive(Deserialize)]
    struct Peek {
        generation: Option<u64>,
    }
    serde_json::from_str::<Peek>(text).ok()?.generation
}

/// `[A-Za-z0-9_-]{1,128}` and not a DOS device name. Account ids are `acc_<ulid>`.
pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let device = || {
        ["CON", "PRN", "AUX", "NUL"]
            .iter()
            .any(|name| id.eq_ignore_ascii_case(name))
            || (bytes.len() == 4
                && [b"COM", b"LPT"]
                    .iter()
                    .any(|prefix| bytes[..3].eq_ignore_ascii_case(*prefix))
                && bytes[3].is_ascii_digit())
    };
    (1..=MAX_ID_LEN).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
        && !device()
}

fn check_id(id: &str) -> Result<(), VaultError> {
    match valid_id(id) {
        true => Ok(()),
        false => Err(VaultError::InvalidId),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("own-vault-unit-{}-{nanos}-{n}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TempDir, Vault) {
        let dir = TempDir::new();
        let vault = Vault::open(dir.0.join("vault")).unwrap();
        (dir, vault)
    }

    fn oauth(generation: u64) -> String {
        format!(
            r#"{{"v":1,"type":"oauth","family":"openai-chatgpt","access":"fake-access-{generation}","refresh":"fake-refresh-{generation}","idToken":"fake-id","expiresAt":1790000000000,"generation":{generation}}}"#
        )
    }

    const ID: &str = "acc_01JAX3TESTFAKE";

    #[test]
    fn round_trip_and_blob_is_not_plaintext() {
        let (_dir, vault) = fixture();
        assert_eq!(vault.put(ID, &oauth(7), false, None).unwrap(), Some(7));
        let entry = vault.get(ID, false).unwrap();
        assert_eq!(entry.text(), oauth(7));
        assert_eq!(entry.generation, Some(7));
        let raw = fs::read(vault.dir().join(format!("{ID}.dpapi"))).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("fake-refresh-7"));
        // Raw DPAPI blob with the documented entropy, readable by any DPAPI client.
        let plain = dpapi::unprotect(&raw, format!("own-open-code/v1/{ID}").as_bytes()).unwrap();
        assert_eq!(plain.as_bytes(), oauth(7).as_bytes());
        assert_eq!(vault.list().unwrap(), vec![ID.to_owned()]);
    }

    #[test]
    fn values_without_generation_are_opaque() {
        let (_dir, vault) = fixture();
        assert_eq!(vault.put("acc_plain", "not json at all", false, None).unwrap(), None);
        assert_eq!(vault.put("acc_arr", "[1,2]", false, None).unwrap(), None);
        assert_eq!(
            vault
                .put("acc_key", r#"{"v":1,"type":"key","key":"sk-fake"}"#, false, None)
                .unwrap(),
            None
        );
        assert_eq!(vault.get("acc_plain", false).unwrap().text(), "not json at all");
        assert_eq!(vault.put("acc_empty", "", false, None).unwrap(), None);
        assert_eq!(vault.get("acc_empty", false).unwrap().text(), "");
    }

    #[test]
    fn missing_and_invalid_ids() {
        let (_dir, vault) = fixture();
        assert!(matches!(
            vault.get(ID, false),
            Err(VaultError::NotFound { has_prev: false })
        ));
        let long = "a".repeat(MAX_ID_LEN + 1);
        for bad in [
            "",
            "../x",
            "a.b",
            "a/b",
            "a\\b",
            "CON",
            "nul",
            "com1",
            "LPT9",
            "acc ü",
            "a€",
            long.as_str(),
        ] {
            assert!(!valid_id(bad), "{bad:?} should be invalid");
            assert!(matches!(vault.get(bad, false), Err(VaultError::InvalidId)));
            assert!(matches!(vault.put(bad, "x", false, None), Err(VaultError::InvalidId)));
        }
        for good in [
            "acc_01JAX3",
            "a",
            "COM",
            "COMX",
            "console",
            "acc-1_B",
            &"z".repeat(MAX_ID_LEN),
        ] {
            assert!(valid_id(good), "{good:?} should be valid");
        }
        let big = "x".repeat(MAX_VALUE_BYTES + 1);
        assert!(matches!(
            vault.put(ID, &big, false, None),
            Err(VaultError::BadRequest(_))
        ));
    }

    #[test]
    fn keep_prev_keeps_exactly_the_previous_blob() {
        let (_dir, vault) = fixture();
        vault.put(ID, &oauth(1), true, None).unwrap();
        assert!(matches!(vault.get(ID, true), Err(VaultError::NotFound { .. })));
        vault.put(ID, &oauth(2), true, None).unwrap();
        assert_eq!(vault.get(ID, true).unwrap().generation, Some(1));
        vault.put(ID, &oauth(3), false, None).unwrap();
        assert_eq!(
            vault.get(ID, true).unwrap().generation,
            Some(1),
            "keepPrev:false leaves .prev alone"
        );
        vault.put(ID, &oauth(4), true, None).unwrap();
        assert_eq!(vault.get(ID, true).unwrap().generation, Some(3));
        assert_eq!(vault.get(ID, false).unwrap().generation, Some(4));
        assert_eq!(vault.list().unwrap(), vec![ID.to_owned()], ".prev is not an id");
    }

    #[test]
    fn corrupt_file_reports_decrypt_failed_and_prev_recovers() {
        let (_dir, vault) = fixture();
        let main = vault.dir().join(format!("{ID}.dpapi"));
        fs::write(&main, b"garbage, not a DPAPI blob").unwrap();
        assert!(matches!(
            vault.get(ID, false),
            Err(VaultError::DecryptFailed { has_prev: false })
        ));

        vault.put(ID, &oauth(1), false, None).unwrap();
        vault.put(ID, &oauth(2), true, None).unwrap();
        let mut truncated = fs::read(&main).unwrap();
        truncated.truncate(truncated.len() / 2);
        fs::write(&main, truncated).unwrap();
        assert!(matches!(
            vault.get(ID, false),
            Err(VaultError::DecryptFailed { has_prev: true })
        ));
        // CAS against an unreadable current value is refused, not guessed.
        assert!(matches!(
            vault.put(ID, &oauth(3), false, Some(2)),
            Err(VaultError::DecryptFailed { .. })
        ));
        // Recovery path: read .prev, write it back.
        let prev = vault.get(ID, true).unwrap();
        vault.put(ID, prev.text(), false, None).unwrap();
        assert_eq!(vault.get(ID, false).unwrap().generation, Some(1));
    }

    #[test]
    fn blob_is_bound_to_its_id_and_must_be_utf8() {
        let (_dir, vault) = fixture();
        vault.put("acc_A", &oauth(1), false, None).unwrap();
        fs::copy(vault.dir().join("acc_A.dpapi"), vault.dir().join("acc_B.dpapi")).unwrap();
        assert!(matches!(
            vault.get("acc_B", false),
            Err(VaultError::DecryptFailed { .. })
        ));
        let sealed = dpapi::protect(&[0xff, 0xfe, 0x00], &dpapi::entropy("acc_C")).unwrap();
        fs::write(vault.dir().join("acc_C.dpapi"), sealed).unwrap();
        assert!(matches!(
            vault.get("acc_C", false),
            Err(VaultError::DecryptFailed { .. })
        ));
    }

    #[test]
    fn if_generation_is_compare_and_swap() {
        let (_dir, vault) = fixture();
        assert!(matches!(
            vault.put(ID, &oauth(1), false, Some(0)),
            Err(VaultError::Conflict { generation: None })
        ));
        vault.put(ID, &oauth(1), false, None).unwrap();
        assert!(matches!(
            vault.put(ID, &oauth(2), false, Some(5)),
            Err(VaultError::Conflict { generation: Some(1) })
        ));
        assert_eq!(vault.put(ID, &oauth(2), true, Some(1)).unwrap(), Some(2));
        // A delete in between makes a late refresh write fail instead of resurrecting the account.
        vault.delete(ID, true).unwrap();
        assert!(matches!(
            vault.put(ID, &oauth(3), true, Some(2)),
            Err(VaultError::Conflict { generation: None })
        ));
    }

    #[test]
    fn delete_shreds_main_prev_and_leftovers() {
        let (_dir, vault) = fixture();
        vault.put(ID, &oauth(1), true, None).unwrap();
        vault.put(ID, &oauth(2), true, None).unwrap();
        let leftover = vault.dir().join(format!("{ID}.dpapi.999.0.tmp"));
        fs::write(&leftover, b"half-written").unwrap();
        vault.put("acc_other", &oauth(1), false, None).unwrap();
        assert!(vault.delete(ID, true).unwrap());
        for suffix in [".dpapi", ".dpapi.prev"] {
            assert!(!vault.dir().join(format!("{ID}{suffix}")).exists());
        }
        assert!(!leftover.exists());
        assert!(!vault.delete(ID, false).unwrap(), "idempotent");
        assert_eq!(vault.list().unwrap(), vec!["acc_other".to_owned()]);
        assert_eq!(vault.get("acc_other", false).unwrap().generation, Some(1));
    }

    #[test]
    fn delete_removes_stale_lease_but_keeps_live_one() {
        let (_dir, vault) = fixture();
        let lock = vault.dir().join(format!("{ID}.lock"));
        let now = lease::now_ms();
        fs::write(
            &lock,
            format!(
                r#"{{"pid":{},"startedAt":{},"until":{}}}"#,
                std::process::id(),
                now - 5,
                now - 1
            ),
        )
        .unwrap();
        vault.delete(ID, false).unwrap();
        assert!(!lock.exists());
        assert!(matches!(
            vault.lease_acquire(ID, std::process::id(), 60_000).unwrap(),
            Acquire::Acquired(_)
        ));
        vault.delete(ID, false).unwrap();
        assert!(lock.exists());
    }

    #[test]
    fn temp_files_are_ignored_and_old_ones_swept_on_open() {
        let dir = TempDir::new();
        let vault_dir = dir.0.join("vault");
        let vault = Vault::open(&vault_dir).unwrap();
        vault.put(ID, &oauth(1), false, None).unwrap();
        let old = vault_dir.join(format!("{ID}.dpapi.1.1.tmp"));
        let fresh = vault_dir.join(format!("{ID}.dpapi.1.2.tmp"));
        fs::write(&old, b"x").unwrap();
        fs::write(&fresh, b"x").unwrap();
        let file = fs::OpenOptions::new().write(true).open(&old).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(3600))
            .unwrap();
        drop(file);
        assert_eq!(vault.list().unwrap(), vec![ID.to_owned()]);
        let _reopened = Vault::open(&vault_dir).unwrap();
        assert!(!old.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn held_mutex_makes_mutations_busy_but_reads_proceed() {
        let (_dir, vault) = fixture();
        vault.put(ID, &oauth(1), false, None).unwrap();
        let vault = vault.with_lock_timeout(Duration::from_millis(50));
        let guard = ExclusiveLock::acquire(&vault.mutex_path(), Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert!(
            ExclusiveLock::acquire(&vault.mutex_path(), Duration::from_millis(20))
                .unwrap()
                .is_none()
        );
        assert!(matches!(vault.put(ID, &oauth(2), false, None), Err(VaultError::Busy)));
        assert!(matches!(vault.delete(ID, false), Err(VaultError::Busy)));
        assert!(matches!(vault.lease_acquire(ID, 1, 60_000), Err(VaultError::Busy)));
        assert_eq!(vault.get(ID, false).unwrap().generation, Some(1));
        drop(guard);
        assert_eq!(vault.put(ID, &oauth(2), false, None).unwrap(), Some(2));
    }

    #[test]
    fn concurrent_compare_and_swap_loses_no_update() {
        let (dir, vault) = fixture();
        vault.put(ID, &oauth(0), false, None).unwrap();
        let root = dir.0.join("vault");
        let workers: Vec<_> = (0..6)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || {
                    // Separate instances: the mutex is a file handle, not an in-process lock.
                    let vault = Vault::open(root).unwrap().with_lock_timeout(Duration::from_secs(30));
                    let mut done = 0;
                    while done < 10 {
                        let current = vault.get(ID, false).unwrap().generation.unwrap();
                        match vault.put(ID, &oauth(current + 1), true, Some(current)) {
                            Ok(_) => done += 1,
                            Err(VaultError::Conflict { .. }) => {}
                            Err(error) => panic!("unexpected {error:?}"),
                        }
                    }
                })
            })
            .collect();
        workers.into_iter().for_each(|worker| worker.join().unwrap());
        assert_eq!(vault.get(ID, false).unwrap().generation, Some(60));
        assert_eq!(vault.get(ID, true).unwrap().generation, Some(59));
    }

    #[test]
    fn lease_acquire_hold_release() {
        let (_dir, vault) = fixture();
        let me = std::process::id();
        let Acquire::Acquired(lease) = vault.lease_acquire(ID, me, 60_000).unwrap() else {
            panic!("expected acquire")
        };
        assert_eq!(lease.pid, me);
        assert_eq!(lease.until - lease.started_at, 60_000);
        let on_disk: Lease =
            serde_json::from_slice(&fs::read(vault.dir().join(format!("{ID}.lock"))).unwrap()).unwrap();
        assert_eq!(on_disk, lease);
        assert_eq!(vault.lease_acquire(ID, me, 60_000).unwrap(), Acquire::Held(Some(lease)));
        assert!(
            !vault.lease_release(ID, me, lease.started_at + 1).unwrap(),
            "wrong owner"
        );
        assert!(
            !vault.lease_release(ID, me + 1, lease.started_at).unwrap(),
            "wrong owner"
        );
        assert!(vault.lease_release(ID, me, lease.started_at).unwrap());
        assert!(
            !vault.lease_release(ID, me, lease.started_at).unwrap(),
            "already released"
        );
        assert!(matches!(
            vault.lease_acquire(ID, me, 60_000).unwrap(),
            Acquire::Acquired(_)
        ));
        // Leases are per account.
        assert!(matches!(
            vault.lease_acquire("acc_other", me, 60_000).unwrap(),
            Acquire::Acquired(_)
        ));
    }

    #[test]
    fn stale_leases_are_taken_over() {
        let (_dir, vault) = fixture();
        let lock = vault.dir().join(format!("{ID}.lock"));
        let now = lease::now_ms();
        let me = std::process::id();

        // Expired.
        fs::write(
            &lock,
            format!(
                r#"{{"pid":{me},"startedAt":{},"until":{}}}"#,
                now - 70_000,
                now - 10_000
            ),
        )
        .unwrap();
        assert!(matches!(
            vault.lease_acquire(ID, me, 60_000).unwrap(),
            Acquire::Acquired(_)
        ));

        // Owner process is gone.
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        let dead = child.id();
        child.wait().unwrap();
        drop(child);
        fs::write(
            &lock,
            format!(r#"{{"pid":{dead},"startedAt":{now},"until":{}}}"#, now + 60_000),
        )
        .unwrap();
        assert!(matches!(
            vault.lease_acquire(ID, me, 60_000).unwrap(),
            Acquire::Acquired(_)
        ));

        // Unreadable but fresh: held with unknown holder. Unreadable and old: stale.
        fs::write(&lock, b"").unwrap();
        assert_eq!(vault.lease_acquire(ID, me, 60_000).unwrap(), Acquire::Held(None));
        let file = fs::OpenOptions::new().write(true).open(&lock).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(120)).unwrap();
        drop(file);
        assert!(matches!(
            vault.lease_acquire(ID, me, 60_000).unwrap(),
            Acquire::Acquired(_)
        ));
    }

    #[test]
    fn lease_argument_bounds() {
        let (_dir, vault) = fixture();
        assert!(matches!(
            vault.lease_acquire(ID, 0, 60_000),
            Err(VaultError::BadRequest(_))
        ));
        assert!(matches!(
            vault.lease_acquire(ID, 1, 999),
            Err(VaultError::BadRequest(_))
        ));
        assert!(matches!(
            vault.lease_acquire(ID, 1, lease::MAX_TTL_MS + 1),
            Err(VaultError::BadRequest(_))
        ));
        assert!(matches!(
            vault.lease_acquire("../x", 1, 60_000),
            Err(VaultError::InvalidId)
        ));
    }
}

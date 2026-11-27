//! Read-only access to the API keys saved by the older codex-multi-provider app ("linked" key import, 02 §3.2b).
//!
//! The old app encrypts each saved key with DPAPI CurrentUser, **no optional entropy**, flags
//! `CRYPTPROTECT_UI_FORBIDDEN` (`scripts\manager_core\providers.py` `_crypt_secret`), and stores the raw blob at
//!
//! - `<app>\profiles\deepseek.dpapi` (`credential_ref` `legacy:deepseek`)
//! - `<app>\work\control-center\credentials\<providerId>.dpapi` (`credential_ref` `dpapi:<providerId>`)
//!
//! where `<app>` is a directory named `codex-multi-provider`. [`get`] decrypts one such file in memory and returns
//! the key. It never writes, renames, copies or re-encrypts the file (it is opened read-only and shared with
//! writers), and it refuses every other path, so the helper cannot be used to unwrap arbitrary DPAPI blobs of the
//! user (browsers and other apps also keep DPAPI blobs without entropy).

use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use crate::dpapi;
use crate::fsx;
use crate::secret::Secret;
use crate::vault::valid_id;

/// Largest accepted blob. A DPAPI blob of a few hundred key bytes is well under 1 KiB.
pub const MAX_FILE_BYTES: u64 = 16 * 1024;
/// Longest accepted path, in characters.
pub const MAX_PATH_CHARS: usize = 1024;
/// Name of the old app's root directory (compared case-insensitively).
pub const APP_DIR: &str = "codex-multi-provider";
const EXTENSION: &str = ".dpapi";
/// Directory chains below the app directory that may hold a saved key.
const LOCATIONS: &[&[&str]] = &[&["profiles"], &["work", "control-center", "credentials"]];

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
/// `CreateFileW` opens the reparse point itself instead of following it.
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

#[derive(Debug)]
pub enum LinkedError {
    /// Not an allowlisted legacy key file, or not a plain regular file there. Carries a fixed reason, never a value.
    Denied(&'static str),
    NotFound,
    /// Not a DPAPI blob of this Windows user without entropy (other user or PC, damaged), or not UTF-8.
    DecryptFailed,
    Io(io::Error),
}

impl From<io::Error> for LinkedError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            _ => Self::Io(error),
        }
    }
}

/// A decrypted legacy key and the file facts the caller caches it by.
pub struct LinkedKey {
    /// Plaintext, guaranteed to be valid UTF-8; zeroed on drop.
    pub value: Secret,
    pub size: u64,
    /// Last write time, Unix epoch milliseconds.
    pub mtime_ms: u64,
}

impl LinkedKey {
    pub fn text(&self) -> &str {
        std::str::from_utf8(self.value.as_bytes()).unwrap_or_default()
    }
}

/// A path that passed [`check_path`]: the file and the directories from the app directory down to its parent.
#[derive(Debug, PartialEq, Eq)]
pub struct Checked {
    pub file: PathBuf,
    pub dirs: Vec<PathBuf>,
}

/// Validates a legacy key path without touching the file system. Accepted: a drive-absolute path (`X:\…`, `/` or
/// `\`) whose last components are `codex-multi-provider\profiles\<name>.dpapi` or
/// `codex-multi-provider\work\control-center\credentials\<name>.dpapi` (case-insensitive), `<name>` =
/// `[A-Za-z0-9_-]{1,128}` and not a DOS device name. Refused: relative, drive-relative, UNC, `\\?\` and `\\.\`
/// forms, empty, `.` and `..` components, trailing dots or spaces (Windows would silently strip them), reserved
/// characters (so no alternate data streams) and anything outside the two locations.
pub fn check_path(path: &str) -> Result<Checked, &'static str> {
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS {
        return Err("path is empty or too long");
    }
    let bytes = path.as_bytes();
    if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || !is_separator(bytes[2]) {
        return Err("path is not a drive-absolute path");
    }
    let components: Vec<&str> = path[3..].split(['\\', '/']).collect();
    if let Some(problem) = components.iter().find_map(|component| component_problem(component)) {
        return Err(problem);
    }
    let Some((file, dirs)) = components.split_last() else {
        return Err("path has no file name");
    };
    let stem = strip_suffix_ignore_case(file, EXTENSION).ok_or("not a .dpapi file")?;
    if !valid_id(stem) {
        return Err("file name is not a plain key name");
    }
    let chain = LOCATIONS
        .iter()
        .find(|chain| {
            dirs.len() > chain.len()
                && dirs[dirs.len() - chain.len()..]
                    .iter()
                    .zip(chain.iter())
                    .all(|(dir, expected)| dir.eq_ignore_ascii_case(expected))
                && dirs[dirs.len() - chain.len() - 1].eq_ignore_ascii_case(APP_DIR)
        })
        .ok_or("not a codex-multi-provider key location")?;
    let drive = &path[..2];
    let join = |parts: &[&str]| PathBuf::from(format!("{drive}\\{}", parts.join("\\")));
    let app = dirs.len() - chain.len() - 1;
    Ok(Checked {
        file: join(&components),
        dirs: (app..dirs.len()).map(|end| join(&dirs[..=end])).collect(),
    })
}

/// Decrypts an allowlisted legacy key file (see the module docs) in memory. Read-only: the file is opened for
/// reading with full sharing, so the old app can replace it at any time.
pub fn get(path: &str) -> Result<LinkedKey, LinkedError> {
    let checked = check_path(path).map_err(LinkedError::Denied)?;
    // A junction or symlink anywhere from the app directory down would let an allowlisted name point elsewhere.
    for dir in &checked.dirs {
        let meta = fs::symlink_metadata(dir)?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(LinkedError::Denied("a key directory is a reparse point"));
        }
        if !meta.is_dir() {
            return Err(LinkedError::Denied("a key directory is not a directory"));
        }
    }
    plain_file(&fs::symlink_metadata(&checked.file)?)?;
    // Opened on the reparse point itself and checked again on the handle, so a swap after the check above is caught.
    let mut file = fsx::retrying(|| {
        OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&checked.file)
    })?;
    let meta = file.metadata()?;
    plain_file(&meta)?;
    let mut sealed = Vec::with_capacity(meta.len() as usize);
    (&mut file).take(MAX_FILE_BYTES + 1).read_to_end(&mut sealed)?;
    drop(file);
    if sealed.len() as u64 > MAX_FILE_BYTES {
        return Err(LinkedError::Denied("the key file is too large"));
    }
    let value = dpapi::unprotect_with(&sealed, None).map_err(|_| LinkedError::DecryptFailed)?;
    if std::str::from_utf8(value.as_bytes()).is_err() {
        return Err(LinkedError::DecryptFailed);
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    Ok(LinkedKey {
        value,
        size: meta.len(),
        mtime_ms,
    })
}

fn plain_file(meta: &fs::Metadata) -> Result<(), LinkedError> {
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(LinkedError::Denied("the key file is a reparse point"));
    }
    if !meta.is_file() {
        return Err(LinkedError::Denied("the key file is not a regular file"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(LinkedError::Denied("the key file is too large"));
    }
    Ok(())
}

fn is_separator(byte: u8) -> bool {
    byte == b'\\' || byte == b'/'
}

fn component_problem(component: &str) -> Option<&'static str> {
    if component.is_empty() {
        return Some("path has an empty component");
    }
    if component == "." || component == ".." {
        return Some("path is not normalized");
    }
    if component.ends_with('.') || component.ends_with(' ') {
        return Some("path component ends with a dot or space");
    }
    if component.chars().count() > 255 {
        return Some("path component is too long");
    }
    if component
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Some("path component has a reserved character");
    }
    None
}

fn strip_suffix_ignore_case<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let split = text.len().checked_sub(suffix.len())?;
    let (stem, tail) = (text.get(..split)?, text.get(split..)?);
    tail.eq_ignore_ascii_case(suffix).then_some(stem)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    /// A temp root with the old app's layout: `<tmp>\…\codex-multi-provider\{profiles, work\control-center\credentials}`.
    struct Legacy(PathBuf);

    impl Legacy {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("own-vault-linked-{}-{nanos}-{n}", std::process::id()));
            fs::create_dir_all(root.join(APP_DIR).join("profiles")).unwrap();
            fs::create_dir_all(
                root.join(APP_DIR)
                    .join("work")
                    .join("control-center")
                    .join("credentials"),
            )
            .unwrap();
            Self(root)
        }

        fn app(&self) -> PathBuf {
            self.0.join(APP_DIR)
        }

        fn profiles(&self, name: &str) -> PathBuf {
            self.app().join("profiles").join(name)
        }

        fn credentials(&self, name: &str) -> PathBuf {
            self.app()
                .join("work")
                .join("control-center")
                .join("credentials")
                .join(name)
        }
    }

    impl Drop for Legacy {
        fn drop(&mut self) {
            // Junction first, so removal never walks into its target.
            let _ = fs::remove_dir(self.app().join("profiles"));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn text(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    fn seal(plain: &[u8]) -> Vec<u8> {
        dpapi::protect_with(plain, None).unwrap()
    }

    const FAKE_KEY: &str = "sk-fake0000000000000000000000000000legacy";

    #[test]
    fn accepts_exactly_the_two_legacy_locations() {
        for path in [
            r"C:\x\codex-multi-provider\profiles\deepseek.dpapi",
            r"D:\#Projects\codex-multi-provider\profiles\deepseek.dpapi",
            r"d:\#Projects\Codex-Multi-Provider\PROFILES\DeepSeek.DPAPI",
            r"C:\a b\codex-multi-provider\work\control-center\credentials\207a1ccd-b02d-42f3-b559-8c577bf22e9c.dpapi",
            r"C:/x/codex-multi-provider/profiles/deepseek.dpapi",
            r"C:\codex-multi-provider\codex-multi-provider\profiles\k_1.dpapi",
        ] {
            assert!(check_path(path).is_ok(), "{path}");
        }
        let checked = check_path(r"C:/x/codex-multi-provider/work/control-center/credentials/k.dpapi").unwrap();
        assert_eq!(
            checked.file,
            PathBuf::from(r"C:\x\codex-multi-provider\work\control-center\credentials\k.dpapi")
        );
        assert_eq!(
            checked.dirs,
            [
                r"C:\x\codex-multi-provider",
                r"C:\x\codex-multi-provider\work",
                r"C:\x\codex-multi-provider\work\control-center",
                r"C:\x\codex-multi-provider\work\control-center\credentials",
            ]
            .map(PathBuf::from)
        );
    }

    #[test]
    fn refuses_everything_else() {
        let long = format!(
            r"C:\{}\codex-multi-provider\profiles\k.dpapi",
            "a".repeat(MAX_PATH_CHARS)
        );
        for path in [
            "",
            r"codex-multi-provider\profiles\deepseek.dpapi",
            r"\codex-multi-provider\profiles\deepseek.dpapi",
            r"C:codex-multi-provider\profiles\deepseek.dpapi",
            r"\\server\share\codex-multi-provider\profiles\deepseek.dpapi",
            r"\\?\C:\x\codex-multi-provider\profiles\deepseek.dpapi",
            r"\\.\C:\x\codex-multi-provider\profiles\deepseek.dpapi",
            r"C:\x\codex-multi-provider\profiles\..\profiles\deepseek.dpapi",
            r"C:\x\codex-multi-provider\profiles\.\deepseek.dpapi",
            r"C:\x\codex-multi-provider\x\..\profiles\deepseek.dpapi",
            r"C:\x\\codex-multi-provider\profiles\deepseek.dpapi",
            r"C:\x\codex-multi-provider\profiles\deepseek.txt",
            r"C:\x\codex-multi-provider\profiles\deepseek.dpapi.prev",
            r"C:\x\codex-multi-provider\profiles\sub\deepseek.dpapi",
            r"C:\x\codex-multi-provider\deepseek.dpapi",
            r"C:\x\other-app\profiles\deepseek.dpapi",
            r"C:\x\codex-multi-provider-2\profiles\deepseek.dpapi",
            r"C:\x\codex-multi-provider\work\control-center\deepseek.dpapi",
            r"C:\x\codex-multi-provider\work\credentials\deepseek.dpapi",
            r"C:\x\codex-multi-provider\profiles\deepseek.dpapi:stream",
            r"C:\x\codex-multi-provider\profiles\deepseek.dpapi.",
            r"C:\x\codex-multi-provider \profiles\deepseek.dpapi",
            r"C:\x\codex-multi-provider\profiles\con.dpapi",
            r"C:\x\codex-multi-provider\profiles\LPT1.dpapi",
            r"C:\x\codex-multi-provider\profiles\.dpapi",
            r"C:\x\codex-multi-provider\profiles\deep seek.dpapi",
            r"C:\x\codex-multi-provider\profiles\deep*.dpapi",
            r"C:\Users\me\AppData\Local\own-open-code\vault\acc_01JAX3.dpapi",
            r"C:\",
            &long,
        ] {
            assert!(check_path(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn reads_a_key_saved_by_the_old_app_without_touching_the_file() {
        let legacy = Legacy::new();
        let path = legacy.profiles("deepseek.dpapi");
        let blob = seal(FAKE_KEY.as_bytes());
        fs::write(&path, &blob).unwrap();
        let before = fs::metadata(&path).unwrap().modified().unwrap();

        let key = get(text(&path)).unwrap();
        assert_eq!(key.text(), FAKE_KEY);
        assert_eq!(key.size, blob.len() as u64);
        let expected = before.duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        assert_eq!(key.mtime_ms, expected);

        assert_eq!(fs::read(&path).unwrap(), blob, "the blob is never rewritten");
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names, ["deepseek.dpapi"], "no temp or copy is left next to it");

        let manager = legacy.credentials("207a1ccd-b02d-42f3-b559-8c577bf22e9c.dpapi");
        fs::write(&manager, seal(b"fake-manager-key")).unwrap();
        assert_eq!(get(text(&manager)).unwrap().text(), "fake-manager-key");
    }

    #[test]
    fn reports_missing_undecryptable_and_oversized_files() {
        let legacy = Legacy::new();
        let path = legacy.profiles("deepseek.dpapi");
        assert!(matches!(get(text(&path)), Err(LinkedError::NotFound)));
        let orphan = legacy
            .0
            .join("gone")
            .join(APP_DIR)
            .join("profiles")
            .join("deepseek.dpapi");
        assert!(matches!(get(text(&orphan)), Err(LinkedError::NotFound)));

        // A blob of our own vault (bound to an account id by entropy) is not a legacy key.
        fs::write(
            &path,
            dpapi::protect(FAKE_KEY.as_bytes(), &dpapi::entropy("acc_X")).unwrap(),
        )
        .unwrap();
        assert!(matches!(get(text(&path)), Err(LinkedError::DecryptFailed)));
        fs::write(&path, b"definitely not a dpapi blob").unwrap();
        assert!(matches!(get(text(&path)), Err(LinkedError::DecryptFailed)));
        fs::write(&path, seal(&[0xff, 0xfe, 0x00])).unwrap();
        assert!(matches!(get(text(&path)), Err(LinkedError::DecryptFailed)));
        fs::write(&path, vec![7u8; MAX_FILE_BYTES as usize]).unwrap();
        assert!(matches!(get(text(&path)), Err(LinkedError::DecryptFailed)));
        fs::write(&path, vec![7u8; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(matches!(get(text(&path)), Err(LinkedError::Denied(_))));

        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(matches!(get(text(&path)), Err(LinkedError::Denied(_))));
        fs::remove_dir(&path).unwrap();

        let denied = get(r"C:\Windows\System32\drivers\etc\hosts");
        assert!(matches!(denied, Err(LinkedError::Denied(_))));
    }

    #[test]
    fn refuses_a_junctioned_key_directory() {
        let legacy = Legacy::new();
        let elsewhere = legacy.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("deepseek.dpapi"), seal(FAKE_KEY.as_bytes())).unwrap();
        let profiles = legacy.app().join("profiles");
        fs::remove_dir(&profiles).unwrap();
        let made = Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&profiles)
            .arg(&elsewhere)
            .output()
            .is_ok_and(|output| output.status.success());
        if !made {
            eprintln!("skipped: mklink /J is not available");
            return;
        }
        let path = profiles.join("deepseek.dpapi");
        assert!(fs::read(&path).is_ok(), "the junction resolves for ordinary readers");
        assert!(matches!(get(text(&path)), Err(LinkedError::Denied(_))));
    }
}

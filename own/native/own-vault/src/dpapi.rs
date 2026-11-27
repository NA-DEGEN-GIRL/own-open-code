//! DPAPI CurrentUser protect/unprotect. The blob is the raw output of
//! `CryptProtectData`, so PowerShell `ProtectedData` or any other DPAPI client
//! with the same entropy can read files written here (AC-P21 cross-read).

use std::io;

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows::core::PCWSTR;

use crate::fsx::win_error;
use crate::secret::{Secret, wipe};

/// Entropy that binds a blob to its account id (02 §2.4.5, 01 §13).
pub fn entropy(id: &str) -> Vec<u8> {
    format!("own-open-code/v1/{id}").into_bytes()
}

pub fn protect(plain: &[u8], entropy: &[u8]) -> io::Result<Vec<u8>> {
    protect_with(plain, Some(entropy))
}

pub fn unprotect(sealed: &[u8], entropy: &[u8]) -> io::Result<Secret> {
    unprotect_with(sealed, Some(entropy))
}

/// `CryptProtectData` with optional entropy. `None` passes a null `pOptionalEntropy`, the format of the older
/// codex-multi-provider app's saved API keys (`providers.py` `_crypt_secret`, flags `CRYPTPROTECT_UI_FORBIDDEN`).
pub fn protect_with(plain: &[u8], entropy: Option<&[u8]>) -> io::Result<Vec<u8>> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    let entropy = entropy.map(blob);
    unsafe {
        CryptProtectData(
            &blob(plain),
            PCWSTR::null(),
            entropy.as_ref().map(|entropy| entropy as *const _),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .map_err(win_error)?;
    Ok(take(out))
}

/// `CryptUnprotectData` with optional entropy (see [`protect_with`]).
pub fn unprotect_with(sealed: &[u8], entropy: Option<&[u8]>) -> io::Result<Secret> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    let entropy = entropy.map(blob);
    unsafe {
        CryptUnprotectData(
            &blob(sealed),
            None,
            entropy.as_ref().map(|entropy| entropy as *const _),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .map_err(win_error)?;
    Ok(Secret::new(take(out)))
}

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    // DPAPI only reads input blobs; the mut cast is an FFI signature artifact.
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

/// Copies a DPAPI-allocated output blob, zeroes it, and frees it with LocalFree.
fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if out.pbData.is_null() {
        return Vec::new();
    }
    let data = unsafe { std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize) };
    let copy = data.to_vec();
    wipe(data);
    unsafe { LocalFree(Some(HLOCAL(out.pbData.cast()))) };
    copy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_entropy() {
        let plain = br#"{"v":1,"type":"key","key":"sk-test-fake","generation":1}"#;
        let sealed = protect(plain, &entropy("acc_A")).unwrap();
        assert_ne!(sealed.as_slice(), plain.as_slice());
        assert_eq!(unprotect(&sealed, &entropy("acc_A")).unwrap().as_bytes(), plain);
    }

    #[test]
    fn wrong_entropy_or_garbage_fails() {
        let sealed = protect(b"fake-secret", &entropy("acc_A")).unwrap();
        assert!(unprotect(&sealed, &entropy("acc_B")).is_err());
        assert!(unprotect(&sealed, b"").is_err());
        assert!(unprotect(b"definitely not a dpapi blob", &entropy("acc_A")).is_err());
        assert!(unprotect(&[], &entropy("acc_A")).is_err());
    }

    #[test]
    fn no_entropy_round_trips_and_differs_from_entropy_blobs() {
        let sealed = protect_with(b"sk-fake-legacy", None).unwrap();
        assert_eq!(unprotect_with(&sealed, None).unwrap().as_bytes(), b"sk-fake-legacy");
        assert!(unprotect(&sealed, &entropy("acc_A")).is_err());
        let bound = protect(b"sk-fake-legacy", &entropy("acc_A")).unwrap();
        assert!(unprotect_with(&bound, None).is_err());
    }

    #[test]
    fn empty_plaintext_round_trips() {
        let sealed = protect(b"", &entropy("acc_E")).unwrap();
        assert!(unprotect(&sealed, &entropy("acc_E")).unwrap().as_bytes().is_empty());
    }
}

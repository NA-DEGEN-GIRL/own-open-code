//! Best-effort wiping of plaintext buffers. Copies made by the allocator on
//! growth, by the OS pipe buffers or by the stdin reader cannot be reached, so
//! this only shortens how long secrets stay in memory we own.

use std::sync::atomic::{Ordering, compiler_fence};

pub fn wipe(buf: &mut [u8]) {
    for byte in buf.iter_mut() {
        // Volatile so the optimizer cannot drop stores to memory freed right after.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

pub fn wipe_string(text: &mut String) {
    // Zero bytes are valid UTF-8, so the String stays well formed.
    wipe(unsafe { text.as_mut_vec() });
}

/// Owned plaintext that is zeroed when dropped.
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret(<{} bytes>)", self.0.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_zeroes_everything() {
        let mut text = String::from("sk-test-not-a-real-key");
        wipe_string(&mut text);
        assert!(text.bytes().all(|b| b == 0));
        assert_eq!(format!("{:?}", Secret::new(b"abc".to_vec())), "Secret(<3 bytes>)");
    }
}

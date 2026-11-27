//! own-vault: the DPAPI secret vault helper of own-open-code (01 §13.1, 02 §2.4.5, §3.5).
//!
//! One long-lived child process per server process. Requests and responses are
//! JSON lines on stdin/stdout (see README.md). Each account secret is one file
//! `vault\<accountId>.dpapi` holding a raw DPAPI blob (CurrentUser scope,
//! entropy `"own-open-code/v1/" + accountId`). The helper never touches the
//! network, never logs, and never receives secrets through argv or env.
//!
//! One read-only exception to "only the vault directory": `linked.get` decrypts
//! an API key file saved by the older codex-multi-provider app, only at its two
//! allowlisted locations and never writing it (`linked.rs`, 02 §3.2b).

#[cfg(not(windows))]
compile_error!(
    "own-vault supports Windows only (DPAPI CurrentUser). Other platforms need a different backend with the same protocol."
);

pub mod dpapi;
pub mod fsx;
pub mod lease;
pub mod linked;
pub mod protocol;
pub mod secret;
pub mod vault;

pub const NAME: &str = "own-vault";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Wire protocol version reported by `hello`. Bump on incompatible changes.
pub const PROTOCOL: u32 = 1;

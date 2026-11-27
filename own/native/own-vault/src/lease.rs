//! Refresh lease record `vault\<accountId>.lock` = `{pid, startedAt, until}` (02 §3.5 F3).
//! The file operations live in `Vault::lease_acquire` / `Vault::lease_release`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::fsx::win_error;

pub const DEFAULT_TTL_MS: u64 = 60_000;
pub const MIN_TTL_MS: u64 = 1_000;
pub const MAX_TTL_MS: u64 = 600_000;

const STILL_ACTIVE: u32 = 259;
const ERROR_INVALID_PARAMETER: i32 = 87;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub pid: u32,
    /// Unix epoch milliseconds.
    pub started_at: u64,
    /// Unix epoch milliseconds.
    pub until: u64,
}

impl Lease {
    /// Live while the deadline has not passed, the span is sane (a lease can
    /// never be longer than MAX_TTL_MS), and the owner process still runs.
    pub fn is_live(&self, now: u64) -> bool {
        now < self.until && self.until.saturating_sub(self.started_at) <= MAX_TTL_MS && pid_alive(self.pid)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether a process with this id is running. Access denied means it exists
/// (e.g. another user's or an elevated process), so it counts as alive.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => {
            let mut code = 0u32;
            let queried = unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok();
            let _ = unsafe { CloseHandle(handle) };
            !queried || code == STILL_ACTIVE
        }
        Err(error) => win_error(error).raw_os_error() != Some(ERROR_INVALID_PARAMETER),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_process_is_alive_and_exited_child_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        drop(child); // closes our handle so the process object can go away
        assert!(!pid_alive(pid));
    }

    #[test]
    fn liveness_rules() {
        let now = now_ms();
        let pid = std::process::id();
        assert!(
            Lease {
                pid,
                started_at: now,
                until: now + DEFAULT_TTL_MS
            }
            .is_live(now)
        );
        assert!(
            !Lease {
                pid,
                started_at: now - 2_000,
                until: now - 1
            }
            .is_live(now)
        );
        assert!(
            !Lease {
                pid,
                started_at: now,
                until: now + MAX_TTL_MS + 1
            }
            .is_live(now)
        );
        assert!(
            !Lease {
                pid: 0,
                started_at: now,
                until: now + DEFAULT_TTL_MS
            }
            .is_live(now)
        );
    }

    #[test]
    fn wire_shape_is_camel_case() {
        let text = serde_json::to_string(&Lease {
            pid: 7,
            started_at: 1,
            until: 2,
        })
        .unwrap();
        assert_eq!(text, r#"{"pid":7,"startedAt":1,"until":2}"#);
    }
}

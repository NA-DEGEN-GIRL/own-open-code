//! End-to-end tests against the built own-vault.exe over real pipes, run with
//! a minimal environment the way own-runtime launches it.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use serde_json::{Value, json};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("own-vault-e2e-{}-{nanos}-{n}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_own-vault"));
    command.env_clear();
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    command
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Helper {
    fn spawn(vault_dir: &Path) -> Self {
        let mut child = command()
            .arg("--vault-dir")
            .arg(vault_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdin, stdout }
    }

    fn call(&mut self, request: Value) -> Value {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{request}").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("bad response line {line:?}"))
    }

    /// Closes stdin and returns the exit status and everything written to stderr.
    fn finish(mut self) -> (ExitStatus, String) {
        drop(self.stdin.take());
        let status = self.child.wait().unwrap();
        let mut stderr = String::new();
        self.child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
        (status, stderr)
    }
}

fn bundle(generation: u64) -> String {
    format!(
        r#"{{"v":1,"type":"oauth","family":"openai-chatgpt","access":"fake-access-{generation}","refresh":"fake-refresh-{generation}","idToken":"fake-id","expiresAt":1790000000000,"obtainedAt":1789990000000,"generation":{generation}}}"#
    )
}

#[test]
fn full_session_over_pipes_with_minimal_env() {
    let dir = TempDir::new();
    let vault_dir = dir.0.join("home").join("vault");
    let mut helper = Helper::spawn(&vault_dir);

    let hello = helper.call(json!({"op": "hello", "rid": 1}));
    assert_eq!(hello["ok"], true);
    assert_eq!(hello["name"], "own-vault");
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["vaultDir"], vault_dir.to_string_lossy().as_ref());
    assert!(vault_dir.is_dir(), "vault dir is created on start");

    let put = helper.call(json!({"op": "put", "rid": 2, "id": "acc_E2E", "value": bundle(7), "keepPrev": true}));
    assert_eq!(put, json!({"ok": true, "rid": 2, "generation": 7}));
    let get = helper.call(json!({"op": "get", "rid": 3, "id": "acc_E2E"}));
    assert_eq!(get, json!({"ok": true, "rid": 3, "value": bundle(7), "generation": 7}));
    let key = r#"{"v":1,"type":"key","key":"sk-fake-e2e","generation":1}"#;
    assert_eq!(
        helper.call(json!({"op": "put", "id": "acc_KEY", "value": key}))["generation"],
        1
    );
    assert_eq!(
        helper.call(json!({"op": "list"})),
        json!({"ok": true, "ids": ["acc_E2E", "acc_KEY"]})
    );
    assert_eq!(
        helper.call(json!({"op": "delete", "id": "acc_KEY", "shred": true})),
        json!({"ok": true, "deleted": true})
    );
    assert_eq!(helper.call(json!({"op": "get", "id": "acc_KEY"}))["error"], "not_found");

    let (status, stderr) = helper.finish();
    assert!(status.success(), "exits 0 on stdin EOF");
    assert_eq!(stderr, "", "the helper never logs");
    let on_disk: Vec<u8> = fs::read_dir(&vault_dir)
        .unwrap()
        .flatten()
        .flat_map(|entry| fs::read(entry.path()).unwrap_or_default())
        .collect();
    assert!(!String::from_utf8_lossy(&on_disk).contains("fake-refresh-7"));
}

#[test]
fn restart_reads_what_the_previous_process_wrote() {
    let dir = TempDir::new();
    let mut first = Helper::spawn(&dir.0);
    first.call(json!({"op": "put", "id": "acc_R", "value": bundle(1)}));
    first.child.kill().unwrap();
    first.child.wait().unwrap();
    let mut second = Helper::spawn(&dir.0);
    assert_eq!(second.call(json!({"op": "get", "id": "acc_R"}))["generation"], 1);
    assert!(second.finish().0.success());
}

#[test]
fn killed_mid_stream_leaves_complete_current_and_prev() {
    let dir = TempDir::new();
    let mut helper = Helper::spawn(&dir.0);
    let mut stdin = helper.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        for generation in 1..=2000u64 {
            let line = json!({"op": "put", "id": "acc_K", "value": bundle(generation), "keepPrev": true});
            if writeln!(stdin, "{line}").is_err() {
                return;
            }
        }
    });
    let mut line = String::new();
    for _ in 0..40 {
        line.clear();
        helper.stdout.read_line(&mut line).unwrap();
    }
    helper.child.kill().unwrap(); // TerminateProcess, somewhere inside a put
    helper.child.wait().unwrap();
    writer.join().unwrap();

    let mut next = Helper::spawn(&dir.0);
    let current = next.call(json!({"op": "get", "id": "acc_K"}));
    let prev = next.call(json!({"op": "get", "id": "acc_K", "prev": true}));
    let (current, prev) = (
        current["generation"].as_u64().unwrap(),
        prev["generation"].as_u64().unwrap(),
    );
    assert!(current >= 40, "at least the acknowledged puts are durable: {current}");
    assert!(
        prev == current || prev + 1 == current,
        "prev {prev} vs current {current}"
    );
    assert_eq!(next.call(json!({"op": "list"}))["ids"], json!(["acc_K"]));
    assert!(next.finish().0.success());
}

#[test]
fn two_processes_serialize_compare_and_swap() {
    let dir = TempDir::new();
    let mut seed = Helper::spawn(&dir.0);
    seed.call(json!({"op": "put", "id": "acc_C", "value": bundle(0)}));
    seed.finish();
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let root = dir.0.clone();
            std::thread::spawn(move || {
                let mut helper = Helper::spawn(&root);
                let mut done = 0;
                while done < 15 {
                    let current = helper.call(json!({"op": "get", "id": "acc_C"}))["generation"].as_u64().unwrap();
                    let put = helper.call(json!({
                        "op": "put", "id": "acc_C", "value": bundle(current + 1), "keepPrev": true, "ifGeneration": current
                    }));
                    match put["ok"].as_bool().unwrap() {
                        true => done += 1,
                        false => assert_eq!(put["error"], "conflict"),
                    }
                }
                assert!(helper.finish().0.success());
            })
        })
        .collect();
    workers.into_iter().for_each(|worker| worker.join().unwrap());
    let mut check = Helper::spawn(&dir.0);
    assert_eq!(check.call(json!({"op": "get", "id": "acc_C"}))["generation"], 30);
    check.finish();
}

#[test]
fn lease_of_a_dead_holder_is_taken_over() {
    let dir = TempDir::new();
    let mut holder = Helper::spawn(&dir.0);
    let holder_pid = holder.child.id();
    let taken = holder.call(json!({"op": "lease.acquire", "id": "acc_L", "pid": holder_pid, "ttlMs": 60000}));
    assert_eq!(taken["acquired"], true);

    let mut other = Helper::spawn(&dir.0);
    let me = std::process::id();
    let blocked = other.call(json!({"op": "lease.acquire", "id": "acc_L", "pid": me}));
    assert_eq!(blocked["acquired"], false);
    assert_eq!(blocked["lease"], taken["lease"]);

    holder.child.kill().unwrap();
    holder.child.wait().unwrap();
    let acquired = other.call(json!({"op": "lease.acquire", "id": "acc_L", "pid": me}));
    assert_eq!(acquired["acquired"], true);
    let started_at = acquired["lease"]["startedAt"].clone();
    assert_eq!(
        other.call(json!({"op": "lease.release", "id": "acc_L", "pid": me, "startedAt": started_at})),
        json!({"ok": true, "released": true})
    );
    assert!(!dir.0.join("acc_L.lock").exists());
    other.finish();
}

#[test]
fn command_line_contract() {
    let dir = TempDir::new();
    let version = command().arg("--version").output().unwrap();
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).starts_with(&format!("own-vault {}", env!("CARGO_PKG_VERSION"))));

    for args in [
        vec![],
        vec!["--vault-dir"],
        vec!["--vault-dir", "relative\\vault"],
        vec!["--bogus"],
    ] {
        let output = command().args(&args).stdin(Stdio::null()).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "args {args:?}");
    }

    // --home <OWN_HOME> means <OWN_HOME>\vault.
    let output = command()
        .arg("--home")
        .arg(&dir.0)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(dir.0.join("vault").is_dir());

    // OWN_HOME from the environment when no flag is given.
    let env_home = dir.0.join("env-home");
    let mut child = command()
        .env("OWN_HOME", &env_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), r#"{{"op":"hello"}}"#).unwrap();
    let output = child.wait_with_output().unwrap();
    let hello: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(hello["vaultDir"], env_home.join("vault").to_string_lossy().as_ref());
}

/// AC-P21 cross-read: blobs are plain DPAPI with the documented entropy, so
/// .NET ProtectedData (PowerShell) reads ours and we read theirs.
#[test]
fn cross_reads_with_powershell_protected_data() {
    let available = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
        .status()
        .is_ok_and(|status| status.success());
    if !available {
        eprintln!("skipped: powershell.exe not available");
        return;
    }
    let dir = TempDir::new();
    let mut helper = Helper::spawn(&dir.0);
    helper.call(json!({"op": "put", "id": "acc_PS1", "value": bundle(3)}));

    let script = format!(
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; \
         $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; \
         $e1=[Text.Encoding]::UTF8.GetBytes('own-open-code/v1/acc_PS1'); \
         $p=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('{ours}'),$e1,$scope); \
         [Console]::Out.Write([Convert]::ToBase64String($p)); \
         $e2=[Text.Encoding]::UTF8.GetBytes('own-open-code/v1/acc_PS2'); \
         $v=[Text.Encoding]::UTF8.GetBytes('{{\"v\":1,\"type\":\"key\",\"key\":\"sk-fake-ps\",\"generation\":5}}'); \
         [IO.File]::WriteAllBytes('{theirs}',[Security.Cryptography.ProtectedData]::Protect($v,$e2,$scope))",
        ours = dir.0.join("acc_PS1.dpapi").display(),
        theirs = dir.0.join("acc_PS2.dpapi").display(),
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "powershell failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let decoded = decode_base64(String::from_utf8_lossy(&output.stdout).trim());
    assert_eq!(String::from_utf8(decoded).unwrap(), bundle(3));

    let theirs = helper.call(json!({"op": "get", "id": "acc_PS2"}));
    assert_eq!(
        theirs["value"],
        r#"{"v":1,"type":"key","key":"sk-fake-ps","generation":5}"#
    );
    assert_eq!(theirs["generation"], 5);
    helper.finish();
}

/// Linked legacy keys (02 §3.2b): a key the older codex-multi-provider app saved (DPAPI CurrentUser, no entropy,
/// here written by .NET ProtectedData like the old app's ctypes call) is decrypted in memory by `linked.get`; the
/// file is never written and nothing lands in the vault. Fake key only.
#[test]
fn linked_get_reads_a_key_the_old_app_saved_without_entropy() {
    let available = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
        .status()
        .is_ok_and(|status| status.success());
    if !available {
        eprintln!("skipped: powershell.exe not available");
        return;
    }
    let dir = TempDir::new();
    let profiles = dir.0.join("codex-multi-provider").join("profiles");
    fs::create_dir_all(&profiles).unwrap();
    let key = profiles.join("deepseek.dpapi");
    let script = format!(
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; \
         $v=[Text.Encoding]::UTF8.GetBytes('sk-fake-legacy-0000000000000000000000'); \
         [IO.File]::WriteAllBytes('{key}',[Security.Cryptography.ProtectedData]::Protect($v,$null,\
         [Security.Cryptography.DataProtectionScope]::CurrentUser))",
        key = key.display(),
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "powershell failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let blob = fs::read(&key).unwrap();
    let modified = fs::metadata(&key).unwrap().modified().unwrap();

    let vault_dir = dir.0.join("home").join("vault");
    let mut helper = Helper::spawn(&vault_dir);
    let got = helper.call(json!({"op": "linked.get", "rid": 1, "path": key.to_string_lossy()}));
    assert_eq!(got["ok"], true);
    assert_eq!(got["value"], "sk-fake-legacy-0000000000000000000000");
    assert_eq!(got["size"], blob.len());
    let denied = helper.call(json!({"op": "linked.get", "path": vault_dir.join("x.dpapi").to_string_lossy()}));
    assert_eq!(denied["error"], "path_denied");
    // The same bytes are not an own vault item (no entropy): `get` never confuses the two.
    fs::copy(&key, vault_dir.join("acc_COPY.dpapi")).unwrap();
    assert_eq!(
        helper.call(json!({"op": "get", "id": "acc_COPY"}))["error"],
        "decrypt_failed"
    );
    let (status, stderr) = helper.finish();
    assert!(status.success());
    assert_eq!(stderr, "", "the helper never logs");

    assert_eq!(fs::read(&key).unwrap(), blob, "the old app's file is only read");
    assert_eq!(fs::metadata(&key).unwrap().modified().unwrap(), modified);
    let names: Vec<_> = fs::read_dir(&profiles)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name())
        .collect();
    assert_eq!(names, ["deepseek.dpapi"]);
}

fn decode_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let digits: Vec<u32> = text
        .bytes()
        .filter(|byte| *byte != b'=')
        .map(|byte| ALPHABET.iter().position(|a| *a == byte).unwrap() as u32)
        .collect();
    digits
        .chunks(4)
        .flat_map(|chunk| {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |acc, (i, d)| acc | d << (18 - 6 * i));
            let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
            bytes.into_iter().take(chunk.len() - 1)
        })
        .collect()
}

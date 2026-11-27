//! JSON-lines protocol over stdin/stdout (README.md is the contract).
//! One request per line, one response line per request, in order.

use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::lease::{self, Lease};
use crate::linked::{self, LinkedError, LinkedKey};
use crate::secret::{wipe, wipe_string};
use crate::vault::{Acquire, Entry, MAX_ID_LEN, Vault, VaultError};
use crate::{NAME, PROTOCOL, VERSION};

/// Longest accepted request line (a 256 KiB value can grow when JSON-escaped).
pub const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

/// Every op this helper answers, reported by `hello` so a client can tell an older helper apart.
pub const OPS: &[&str] = &[
    "hello",
    "get",
    "put",
    "delete",
    "list",
    "lease.acquire",
    "lease.release",
    "linked.get",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    op: String,
    id: Option<String>,
    value: Option<String>,
    #[serde(default)]
    keep_prev: bool,
    if_generation: Option<u64>,
    #[serde(default)]
    shred: bool,
    #[serde(default)]
    prev: bool,
    pid: Option<u32>,
    ttl_ms: Option<u64>,
    started_at: Option<u64>,
    /// `linked.get` only: an allowlisted legacy key file (`linked.rs`). A path, never a secret.
    path: Option<String>,
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Some(value) = self.value.as_mut() {
            wipe_string(value);
        }
    }
}

#[derive(Serialize)]
struct GetOk<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    rid: Option<&'a Value>,
    value: &'a str,
    generation: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedOk<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    rid: Option<&'a Value>,
    value: &'a str,
    size: u64,
    mtime_ms: u64,
}

/// Serves requests until stdin reaches EOF. Returns Err only on stdio failure.
pub fn serve(vault: &Vault, mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let mut line = Vec::new();
    loop {
        wipe(&mut line);
        line.clear();
        let mut response = match read_line(&mut input, &mut line, MAX_LINE_BYTES)? {
            None => return Ok(()),
            Some(false) => failure(None, "bad_request", Some("request line too long"), Map::new()),
            Some(true) if line.trim_ascii().is_empty() => continue,
            Some(true) => handle_line(vault, &line),
        };
        response.push(b'\n');
        let written = output.write_all(&response).and_then(|_| output.flush());
        wipe(&mut response);
        written?;
    }
}

/// Reads one `\n`-terminated line into `line` (without the newline).
/// `None` at EOF, `Some(false)` when the line exceeded `max` (the rest is discarded).
fn read_line(input: &mut impl BufRead, line: &mut Vec<u8>, max: usize) -> io::Result<Option<bool>> {
    let mut overflow = false;
    let mut seen = false;
    loop {
        let chunk = match input.fill_buf() {
            Ok(chunk) => chunk,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if chunk.is_empty() {
            return Ok(seen.then_some(!overflow));
        }
        seen = true;
        let (take, done) = match chunk.iter().position(|byte| *byte == b'\n') {
            Some(index) => (index, true),
            None => (chunk.len(), false),
        };
        if !overflow && line.len() + take > max {
            overflow = true;
            wipe(line);
            line.clear();
        }
        if !overflow {
            line.extend_from_slice(&chunk[..take]);
        }
        input.consume(take + usize::from(done));
        if done {
            return Ok(Some(!overflow));
        }
    }
}

/// Handles one request line and returns the response JSON (no newline).
pub fn handle_line(vault: &Vault, line: &[u8]) -> Vec<u8> {
    let Ok(mut raw) = serde_json::from_slice::<Value>(line) else {
        return failure(None, "bad_request", Some("invalid JSON"), Map::new());
    };
    let rid = raw.as_object_mut().and_then(|object| object.remove("rid"));
    let request = match serde_json::from_value::<Request>(raw) {
        Ok(request) => request,
        // serde messages quote offending string values; never echo those.
        Err(error) => {
            let message = error.to_string();
            let message = if message.contains('"') {
                "malformed request".to_owned()
            } else {
                message
            };
            return failure(rid.as_ref(), "bad_request", Some(&message), Map::new());
        }
    };
    dispatch(vault, &request, rid.as_ref())
}

fn dispatch(vault: &Vault, request: &Request, rid: Option<&Value>) -> Vec<u8> {
    let id = || request.id.as_deref().ok_or_else(|| missing("id"));
    let result = match request.op.as_str() {
        "hello" => Ok(json!({
            "name": NAME,
            "version": VERSION,
            "protocol": PROTOCOL,
            "pid": std::process::id(),
            "vaultDir": vault.dir().to_string_lossy(),
            "ops": OPS,
        })),
        "get" => {
            return match id().and_then(|id| vault.get(id, request.prev)) {
                Ok(entry) => get_ok(rid, &entry),
                Err(error) => vault_failure(rid, error),
            };
        }
        "put" => id().and_then(|id| {
            let value = request.value.as_deref().ok_or_else(|| missing("value"))?;
            let generation = vault.put(id, value, request.keep_prev, request.if_generation)?;
            Ok(json!({ "generation": generation }))
        }),
        "delete" => id().and_then(|id| Ok(json!({ "deleted": vault.delete(id, request.shred)? }))),
        "list" => vault.list().map(|ids| json!({ "ids": ids })),
        "lease.acquire" => id().and_then(|id| {
            let pid = request.pid.ok_or_else(|| missing("pid"))?;
            let ttl = request.ttl_ms.unwrap_or(lease::DEFAULT_TTL_MS);
            Ok(match vault.lease_acquire(id, pid, ttl)? {
                Acquire::Acquired(lease) => json!({ "acquired": true, "lease": lease }),
                Acquire::Held(holder) => json!({ "acquired": false, "lease": holder.map(lease_json) }),
            })
        }),
        "lease.release" => id().and_then(|id| {
            let pid = request.pid.ok_or_else(|| missing("pid"))?;
            let started_at = request.started_at.ok_or_else(|| missing("startedAt"))?;
            Ok(json!({ "released": vault.lease_release(id, pid, started_at)? }))
        }),
        "linked.get" => {
            let Some(path) = request.path.as_deref() else {
                return vault_failure(rid, missing("path"));
            };
            return match linked::get(path) {
                Ok(key) => linked_ok(rid, &key),
                Err(error) => linked_failure(rid, error),
            };
        }
        _ => return failure(rid, "unknown_op", Some("unknown op"), Map::new()),
    };
    match result {
        Ok(Value::Object(fields)) => reply(rid, true, fields),
        Ok(_) => unreachable!("dispatch arms build objects"),
        Err(error) => vault_failure(rid, error),
    }
}

fn lease_json(lease: Lease) -> Value {
    serde_json::to_value(lease).unwrap_or(Value::Null)
}

fn missing(field: &str) -> VaultError {
    VaultError::BadRequest(format!("missing field `{field}`"))
}

fn get_ok(rid: Option<&Value>, entry: &Entry) -> Vec<u8> {
    serde_json::to_vec(&GetOk {
        ok: true,
        rid,
        value: entry.text(),
        generation: entry.generation,
    })
    .expect("serializing a response cannot fail")
}

fn linked_ok(rid: Option<&Value>, key: &LinkedKey) -> Vec<u8> {
    serde_json::to_vec(&LinkedOk {
        ok: true,
        rid,
        value: key.text(),
        size: key.size,
        mtime_ms: key.mtime_ms,
    })
    .expect("serializing a response cannot fail")
}

fn linked_failure(rid: Option<&Value>, error: LinkedError) -> Vec<u8> {
    match error {
        LinkedError::Denied(reason) => failure(rid, "path_denied", Some(reason), Map::new()),
        LinkedError::NotFound => failure(rid, "not_found", None, Map::new()),
        LinkedError::DecryptFailed => failure(rid, "decrypt_failed", None, Map::new()),
        LinkedError::Io(error) => failure(rid, "io_error", Some(&error.to_string()), Map::new()),
    }
}

fn vault_failure(rid: Option<&Value>, error: VaultError) -> Vec<u8> {
    let with = |key: &str, value: Value| Map::from_iter([(key.to_owned(), value)]);
    match error {
        VaultError::InvalidId => failure(
            rid,
            "invalid_id",
            Some(&format!(
                "id must match [A-Za-z0-9_-]{{1,{MAX_ID_LEN}}} and not be a device name"
            )),
            Map::new(),
        ),
        VaultError::BadRequest(message) => failure(rid, "bad_request", Some(&message), Map::new()),
        VaultError::NotFound { has_prev } => failure(rid, "not_found", None, with("hasPrev", json!(has_prev))),
        VaultError::DecryptFailed { has_prev } => {
            failure(rid, "decrypt_failed", None, with("hasPrev", json!(has_prev)))
        }
        VaultError::EncryptFailed => failure(rid, "encrypt_failed", None, Map::new()),
        VaultError::Conflict { generation } => failure(rid, "conflict", None, with("generation", json!(generation))),
        VaultError::Busy => failure(rid, "busy", Some("vault mutex held by another process"), Map::new()),
        VaultError::Io(error) => failure(rid, "io_error", Some(&error.to_string()), Map::new()),
    }
}

fn failure(rid: Option<&Value>, code: &str, message: Option<&str>, mut fields: Map<String, Value>) -> Vec<u8> {
    fields.insert("error".into(), json!(code));
    if let Some(message) = message {
        fields.insert("message".into(), json!(message));
    }
    reply(rid, false, fields)
}

fn reply(rid: Option<&Value>, ok: bool, mut fields: Map<String, Value>) -> Vec<u8> {
    fields.insert("ok".into(), json!(ok));
    if let Some(rid) = rid {
        fields.insert("rid".into(), rid.clone());
    }
    serde_json::to_vec(&Value::Object(fields)).expect("serializing a response cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run(vault: &Vault, input: &[u8]) -> Vec<Value> {
        let mut output = Vec::new();
        serve(vault, Cursor::new(input.to_vec()), &mut output).unwrap();
        output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    fn vault() -> (std::path::PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!(
            "own-vault-proto-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let vault = Vault::open(&dir).unwrap();
        (dir, vault)
    }

    #[test]
    fn requests_round_trip_in_order_with_rid() {
        let (dir, vault) = vault();
        let input = concat!(
            r#"{"op":"hello","rid":1}"#,
            "\n",
            r#"{"op":"put","rid":"a","id":"acc_P","value":"{\"v\":1,\"type\":\"key\",\"key\":\"sk-fake\",\"generation\":3}","keepPrev":true}"#,
            "\r\n",
            "\n",
            r#"{"op":"get","rid":{"n":2},"id":"acc_P"}"#,
            "\n",
            r#"{"op":"list"}"#,
            "\n",
            r#"{"op":"lease.acquire","id":"acc_P","pid":4294967295,"ttlMs":1000}"#,
            "\n",
            r#"{"op":"delete","id":"acc_P","shred":true}"#,
            "\n",
            r#"{"op":"get","id":"acc_P"}"#,
        );
        let responses = run(&vault, input.as_bytes());
        assert_eq!(responses.len(), 7);
        assert_eq!(responses[0]["ok"], true);
        assert_eq!(responses[0]["rid"], 1);
        assert_eq!(responses[0]["name"], "own-vault");
        assert_eq!(responses[0]["protocol"], 1);
        assert!(responses[0]["ops"].as_array().unwrap().contains(&json!("linked.get")));
        assert_eq!(responses[1], json!({"ok": true, "rid": "a", "generation": 3}));
        assert_eq!(responses[2]["rid"], json!({"n": 2}));
        assert_eq!(
            responses[2]["value"],
            r#"{"v":1,"type":"key","key":"sk-fake","generation":3}"#
        );
        assert_eq!(responses[2]["generation"], 3);
        assert_eq!(responses[3], json!({"ok": true, "ids": ["acc_P"]}));
        assert_eq!(responses[4]["acquired"], true);
        assert_eq!(responses[4]["lease"]["pid"], 4294967295u32);
        assert_eq!(responses[5], json!({"ok": true, "deleted": true}));
        assert_eq!(
            responses[6],
            json!({"ok": false, "error": "not_found", "hasPrev": false})
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn errors_are_reported_and_serving_continues() {
        let (dir, vault) = vault();
        let input = concat!(
            "not json\n",
            r#"{"op":"frobnicate","rid":5}"#,
            "\n",
            r#"{"op":"put","rid":6,"id":"acc_P"}"#,
            "\n",
            r#"{"op":"put","rid":7,"id":"../evil","value":"x"}"#,
            "\n",
            r#"{"op":"put","rid":8,"id":"acc_P","value":"sk-fake","keepPrev":"sk-secret-in-wrong-field"}"#,
            "\n",
            r#"{"rid":9}"#,
            "\n",
            r#"{"op":"lease.release","rid":10,"id":"acc_P","pid":1}"#,
            "\n",
            r#"{"op":"put","rid":11,"id":"acc_P","value":"{\"generation\":1}","ifGeneration":4}"#,
            "\n",
            r#"[1,2,3]"#,
            "\n",
        );
        let responses = run(&vault, input.as_bytes());
        assert_eq!(responses.len(), 9);
        assert_eq!(
            responses[0],
            json!({"ok": false, "error": "bad_request", "message": "invalid JSON"})
        );
        assert_eq!(responses[1]["error"], "unknown_op");
        assert_eq!(responses[1]["rid"], 5);
        assert_eq!(responses[2]["error"], "bad_request");
        assert_eq!(responses[2]["message"], "missing field `value`");
        assert_eq!(responses[3]["error"], "invalid_id");
        assert_eq!(responses[4]["error"], "bad_request");
        assert_eq!(responses[4]["rid"], 8);
        assert!(
            !responses[4].to_string().contains("sk-secret"),
            "serde messages must not echo values"
        );
        assert_eq!(responses[5]["error"], "bad_request");
        assert_eq!(responses[5]["rid"], 9);
        assert_eq!(responses[6]["message"], "missing field `startedAt`");
        assert_eq!(
            responses[7],
            json!({"ok": false, "rid": 11, "error": "conflict", "generation": null})
        );
        assert_eq!(responses[8]["error"], "bad_request");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn linked_get_reads_an_allowlisted_legacy_key_and_refuses_other_paths() {
        let (dir, vault) = vault();
        let profiles = dir.join("legacy").join("codex-multi-provider").join("profiles");
        std::fs::create_dir_all(&profiles).unwrap();
        let key = profiles.join("deepseek.dpapi");
        let blob = crate::dpapi::protect_with(b"sk-fake-linked-protocol", None).unwrap();
        std::fs::write(&key, &blob).unwrap();
        let outside = dir.join("legacy").join("deepseek.dpapi");
        std::fs::write(&outside, &blob).unwrap();
        let request = |rid: u32, path: &std::path::Path| {
            json!({"op": "linked.get", "rid": rid, "path": path.to_string_lossy()}).to_string() + "\n"
        };
        let input = [
            request(1, &key),
            request(2, &outside),
            request(3, &profiles.join("missing.dpapi")),
            r#"{"op":"linked.get","rid":4}"#.to_owned() + "\n",
        ]
        .concat();
        let responses = run(&vault, input.as_bytes());
        assert_eq!(responses[0]["ok"], true);
        assert_eq!(responses[0]["rid"], 1);
        assert_eq!(responses[0]["value"], "sk-fake-linked-protocol");
        assert_eq!(responses[0]["size"], blob.len());
        assert!(responses[0]["mtimeMs"].as_u64().unwrap() > 0);
        assert_eq!(responses[1]["error"], "path_denied");
        assert!(!responses[1].to_string().contains("sk-fake"), "no value in a refusal");
        assert_eq!(responses[2], json!({"ok": false, "rid": 3, "error": "not_found"}));
        assert_eq!(responses[3]["error"], "bad_request");
        assert_eq!(responses[3]["message"], "missing field `path`");
        assert_eq!(std::fs::read(&key).unwrap(), blob, "the legacy file is only read");
        assert_eq!(
            vault.list().unwrap(),
            Vec::<String>::new(),
            "nothing lands in the vault"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn overlong_line_is_rejected_without_losing_the_next_one() {
        let (dir, vault) = vault();
        let mut input = format!(
            r#"{{"op":"put","id":"acc_P","value":"{}"}}"#,
            "x".repeat(MAX_LINE_BYTES)
        )
        .into_bytes();
        input.extend_from_slice(b"\n{\"op\":\"list\"}\n");
        let responses = run(&vault, &input);
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["message"], "request line too long");
        assert_eq!(responses[1], json!({"ok": true, "ids": []}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_line_handles_eof_without_newline_and_limits() {
        let mut input = Cursor::new(b"abc\ndef".to_vec());
        let mut line = Vec::new();
        assert_eq!(read_line(&mut input, &mut line, 10).unwrap(), Some(true));
        assert_eq!(line, b"abc");
        line.clear();
        assert_eq!(read_line(&mut input, &mut line, 10).unwrap(), Some(true));
        assert_eq!(line, b"def");
        line.clear();
        assert_eq!(read_line(&mut input, &mut line, 10).unwrap(), None);
        let mut input = Cursor::new(b"0123456789AB\nok\n".to_vec());
        assert_eq!(read_line(&mut input, &mut line, 10).unwrap(), Some(false));
        assert!(line.is_empty());
        assert_eq!(read_line(&mut input, &mut line, 10).unwrap(), Some(true));
        assert_eq!(line, b"ok");
    }
}

// Codex's tool definitions differ by host OS in three places (codex-rs/core/src/tools/handlers/shell_spec.rs,
// rust-v0.162.1, rust-v0.171.0): on Windows, exec_command's description gains the "Windows safety rules" paragraph,
// its `yield_time_ms` is described for Windows' range, and its `login` for PowerShell profiles. The captures in
// codex-data are Windows ones; this turns their text into what Codex sends elsewhere.
// Ported from openai/codex (Apache-2.0) @ rust-v0.171.0.
export * as Platform from "./platform.js"

/** `windows_shell_guidance()`, as it follows the description after a blank line. */
const GUIDANCE = /\n\nWindows safety rules:\n(?:- [^\n]*(?:\n|$))+/

const YIELD_WINDOWS =
  "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
const YIELD_POSIX = "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms."

/** `exec_command`'s `login` text with a PowerShell environment, and without one (shell_spec.rs, rust-v0.171.0). */
const LOGIN_POWERSHELL =
  "Login-shell startup. In PowerShell, false skips profiles. Keep them enabled for profile-defined commands, even unattended. Omit to inherit."
const LOGIN_POSIX = "Request login-shell startup. Omit to inherit."

export const windows = process.platform === "win32"

/** Codex's text for this host: the Windows capture as it is on Windows, without its Windows parts elsewhere. */
export function text(captured: string, host = windows) {
  if (host) return captured
  return captured
    .replace(GUIDANCE, (match) => (match.endsWith("\n") ? "\n" : ""))
    .replaceAll(YIELD_WINDOWS, YIELD_POSIX)
    .replaceAll(LOGIN_POWERSHELL, LOGIN_POSIX)
}

/** A captured JSON value with every string passed through {@link text}. */
export function value<A>(captured: A, host = windows): A {
  if (host) return captured
  return JSON.parse(JSON.stringify(captured), (_, entry) => (typeof entry === "string" ? text(entry, false) : entry))
}

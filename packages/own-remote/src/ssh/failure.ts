export * as Failure from "./failure.js"

import { Log } from "../log.js"
import type { OwnRemote } from "../protocol/rpc-remote.js"
import type { SshFailure } from "../vendor/ssh/command.js"
import type { Tunnel } from "./tunnel.js"

export interface Classified {
  readonly error: OwnRemote.HostError
  /** `host_key` → `unknown | changed`; otherwise a short scrubbed message. */
  readonly detail: string
  /** Stop background retries until the user acts (04 §6.3 pause rule). */
  readonly pause: boolean
}

/** Errors that always pause (04 §6.3). */
export const PAUSING: ReadonlySet<OwnRemote.HostError> = new Set([
  "input",
  "ssh_missing",
  "host_key",
  "platform_unsupported",
  "version_skew",
  "other_owner",
  "host_identity_changed",
  "forwarding_disabled",
  "loopback_unavailable",
  "service_not_loopback",
  "service_unresponsive",
  "forward_conflict",
  "auth",
])

/** Classifies ssh's own stderr (OpenSSH message texts; Win32-OpenSSH uses the same strings). */
export function classifyText(text: string): Classified {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text))
    return { error: "host_key", detail: "changed", pause: true }
  if (/Host key verification failed|No .* host key is known|host key .* not in known_hosts/i.test(text))
    return { error: "host_key", detail: "unknown", pause: true }
  if (/Permission denied|Too many authentication failures|Authentication failed/i.test(text))
    return { error: "auth", detail: firstLine(text), pause: true }
  if (/administratively prohibited|forwarding disabled|AllowTcpForwarding/i.test(text))
    return { error: "forwarding_disabled", detail: firstLine(text), pause: true }
  if (/cannot listen to port|Could not request local forwarding|bind \[?127\.0\.\d+\.\d+\]?:\d+/i.test(text))
    return { error: "loopback_unavailable", detail: firstLine(text), pause: true }
  return { error: "connection", detail: firstLine(text), pause: false }
}

/** Remote-forward failures (04 §7.4): the socket directory, a leftover socket, or a busy TCP port. */
export function remoteForwardFailed(text: string) {
  return /remote port forwarding failed|Error: remote port forwarding|streamlocal forward/i.test(text)
}

export function classify(failure: SshFailure): Classified {
  if (failure.code === "ssh-missing" || /spawn .*ENOENT/.test(failure.message))
    return { error: "ssh_missing", detail: firstLine(failure.message), pause: true }
  if (failure.code === "input") return { error: "input", detail: "", pause: true }
  return classifyText(failure.message)
}

/**
 * A tunnel start that ended before the ensure result (04 §7.1). The remote ensure script shares ssh's stderr, so ssh's
 * own texts count only when ssh itself failed (exit 255): `mkdir: ...: Permission denied` from a script that exits 1
 * is not an auth failure and must not pause the host. Every other end retries with the scrubbed stderr tail.
 */
export function classifyStart(failure: Extract<Tunnel.StartResult, { ok: false }>): Classified {
  if (failure.reason === "exited" && failure.code === 255) return classifyText(failure.stderr || "ssh exited (255)")
  const summary = failure.reason === "exited" ? `exited (${failure.code})` : failure.reason
  const tail = lastLine(Log.scrub(failure.stderr))
  return {
    // A numeric exit other than 255 is the remote command's own status: ssh connected and the ensure script failed.
    error: failure.reason === "exited" && failure.code !== null ? "service_failed" : "connection",
    detail: tail ? `${summary}: ${tail}` : summary,
    pause: false,
  }
}

function firstLine(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 300) ?? ""
  )
}

function lastLine(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .findLast(Boolean)
      ?.slice(0, 300) ?? ""
  )
}

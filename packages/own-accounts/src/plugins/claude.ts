export * as Claude from "./claude.js"

import { Account, type Plugin } from "@own/protocol"
import type { Contract } from "../broker/contract.js"
import type { Deps } from "../deps.js"

/** `anthropic`: the reserved provider and integration of the Claude subscription slot (02 §8.3 I1). */
export const PROVIDER_ID = "anthropic"

/** Exact version and lock integrity of the bundled claude-auth (`own-bundle.json`, 02 §8.2). */
export interface Pin {
  readonly version: string
  readonly integrity: string
}

/**
 * The remote consent (`Plugin.ClaudeRemoteAck`, 04 §8.11.12) is valid only while the version and integrity match the
 * bundled plugin and the notice hash is one of `noticeHashes` (the remote notice in each language). The local slot
 * needs no consent since the plugin ships with the app (02 §8.4, user decision 2026-10-18).
 */
export function ackValid(
  ack: Plugin.ClaudeRemoteAck | undefined,
  reference: Pin | undefined,
  noticeHashes: ReadonlyArray<string>,
) {
  if (!ack || !reference) return false
  return (
    ack.pluginVersion === reference.version &&
    ack.integrity === reference.integrity &&
    noticeHashes.includes(ack.noticeHash)
  )
}

/** What the PC's verdict for a host needs (04 §8.11.4.3), all read without I/O. */
export interface RemoteFacts {
  /** The slot is detected and verified here and `anthropic` has an active connection. */
  readonly ready: boolean
  /** That connection is an API key or env (`billsApi`, 02 §8.9). */
  readonly billing: boolean
  /** `ack:claudeRemote` matches the bundled pin and the remote notice hash. */
  readonly acknowledged: boolean
}

/**
 * The PC's verdict for the Claude subscription slot on one SSH host (04 §8.11.4.3); the first row that matches wins:
 * `not_ready`, `billing`, `off` (not in `claudeSlot.remoteHosts`), `consent`, `host_scope` (the host's account scope is
 * `only` without any of this PC's Claude accounts, the rule of `Mirror.allowed`), else `enabled`. `accounts`: the ids
 * of this PC's Claude accounts (02 §8.7); absent = the slot's own only.
 */
export function remoteState(input: {
  readonly facts: RemoteFacts
  readonly remoteHosts: ReadonlyArray<string> | undefined
  readonly hostId: string
  readonly scope: Contract.AccountScope
  readonly accounts?: ReadonlyArray<string>
}): Plugin.ClaudeRemoteState {
  if (!input.facts.ready) return "not_ready"
  if (input.facts.billing) return "billing"
  if (!(input.remoteHosts ?? []).includes(input.hostId)) return "off"
  if (!input.facts.acknowledged) return "consent"
  const accounts = input.accounts ?? [Account.ID.claudeSlot]
  const scope = input.scope
  if (scope.mode === "only" && !accounts.some((accountID) => scope.ids.includes(accountID))) return "host_scope"
  return "enabled"
}

type ConnectionInfo = NonNullable<Awaited<ReturnType<Deps["ctx"]["integration"]["connection"]["active"]>>>

/**
 * The `anthropic` active connection as shown to the UI (02 §8.9): `oauth(claude-code)`, `key` or `env`. Labels carry
 * the plan tier and the email the plugin recorded; the email is masked.
 */
export function connection(info: ConnectionInfo | undefined): Account.Connection | null {
  if (!info) return null
  if (info.type === "env") return { type: "env", label: info.name }
  if (info.method === "oauth") return { type: "oauth", method: "claude-code", label: maskEmail(info.label) }
  return { type: "key", label: maskEmail(info.label) }
}

/** `name@example.com` → `na***@…` (02 §9.1 "이메일은 마스킹"). */
export function maskEmail(text: string) {
  return text.replace(/([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+/g, "$1***@…")
}

// The Claude subscription slot on SSH hosts (04 §8.11): this PC relays a host's Claude requests once the PC's Claude
// card switched that host on. One place decides what the slot is on a host now, for the switcher (a reason row instead
// of an endless model list, the `PC 경유` chip), the new-session default, the session header, 설정 > 원격 호스트 and the
// Claude card: the PC's `hosts.list` row (`broker.claude`, own.remote) first, then the host's own `health.claudeSlot`
// (its mirror of the PC's verdict, and whether the host has a Claude login of its own). Pure but for `serverClaude`.
import type { Plugin } from "@own/protocol"
import type { HostView, ServerRuntime } from "@/data"
import type { RemoteKey } from "@/remote/strings"
import { remoteStore } from "./active"

/**
 * The slot on a host: the PC's verdict (04 §8.11.4.3), `offline` (the host's broker is not connected to this PC, or
 * nothing is known yet) or `conflict` (the host has its own Claude login or claude-auth and never uses the PC's).
 */
export type ClaudeVerdict = Plugin.ClaudeRemoteState | "offline" | "conflict"

type HostRow = Pick<HostView, "broker">
type HostHealth = { readonly state: Plugin.ClaudeRemoteState | null; readonly conflict: boolean }

export function claudeVerdict(host: HostRow | undefined, health: HostHealth | undefined): ClaudeVerdict {
  if (health?.conflict) return "conflict"
  const connected = host?.broker.state === "connected"
  const state = host?.broker.claude?.state ?? health?.state
  // Connected without a verdict: this PC has no slot (or runs a broker older than the relay).
  if (!state) return connected ? "not_ready" : "offline"
  if (state === "enabled" && host && !connected) return "offline"
  return state
}

/** An SSH server's verdict (reactive); `undefined` for this PC. */
export function serverClaude(runtime: ServerRuntime | undefined): ClaudeVerdict | undefined {
  if (runtime?.kind !== "ssh") return undefined
  return claudeVerdict(remoteStore()?.host(runtime.key), runtime.own.state.health?.claudeSlot)
}

/** 04 §8.11.13: a new session on an SSH host starts on the Claude slot only while the host's verdict is `enabled`. */
export function claudeServes(runtime: ServerRuntime, kind: string) {
  return kind !== "claude-sub" || runtime.kind !== "ssh" || serverClaude(runtime) === "enabled"
}

/** Where the reason row's action leads: this PC's Claude card, or the host's panel in 설정 > 원격 호스트. */
export type ClaudeFix = "accounts" | "host"

const REASONS = {
  off: { key: "own.remote.claudeSlot.off", fix: "accounts" },
  consent: { key: "own.remote.claudeSlot.consent", fix: "accounts" },
  not_ready: { key: "own.remote.claudeSlot.notReady", fix: "accounts" },
  billing: { key: "own.remote.claudeSlot.billing", fix: "accounts" },
  host_scope: { key: "own.remote.claudeSlot.hostScope", fix: "host" },
  offline: { key: "own.remote.claudeSlot.offline", fix: "host" },
  conflict: { key: "own.remote.claudeSlot.conflict", fix: "host" },
} as const satisfies Record<Exclude<ClaudeVerdict, "enabled">, { key: RemoteKey; fix: ClaudeFix }>

/**
 * The switcher's models column for an account on an SSH host (04 §8.11.13 표시 규칙): why the Claude slot lists no
 * model, and where to fix it, instead of an endless `불러오는 중`; `undefined` when the models show, or may still come
 * (`enabled`, this PC, another account).
 */
export function claudeEmpty(verdict: ClaudeVerdict | undefined, kind: string | undefined, models: number) {
  if (kind !== "claude-sub" || models > 0 || verdict === undefined || verdict === "enabled") return undefined
  return REASONS[verdict]
}

/** `PC 경유` (04 §8.11.12) next to a Claude account on an SSH host whose requests this PC relays. */
export function viaPc(verdict: ClaudeVerdict | undefined, kind: string | undefined) {
  return kind === "claude-sub" && verdict === "enabled"
}

/** The Claude card's and 설정 > 원격 호스트's word for one host: `own.claude.remote.state.<this>`. */
export type ClaudeHostState =
  | "enabled"
  | "off"
  | "hostScope"
  | "consent"
  | "notReady"
  | "billing"
  | "disconnected"
  | "reauth"

const STATE_WORDS = {
  off: "off",
  consent: "consent",
  host_scope: "hostScope",
  not_ready: "notReady",
  billing: "billing",
} as const satisfies Record<Exclude<Plugin.ClaudeRemoteState, "enabled">, ClaudeHostState>

/**
 * One host's word from the PC's verdict: a switched-on host is `reauth` while Anthropic's refusal holds its relay
 * (`needs_reauth` until `holdUntil`), `disconnected` while its broker is not connected (or it is not listed).
 */
export function claudeHostState(state: Plugin.ClaudeRemoteState, host: HostRow | undefined, now: number) {
  if (state !== "enabled") return STATE_WORDS[state]
  const relay = host?.broker.claude
  if (relay?.lastError === "needs_reauth" && relay.holdUntil !== null && relay.holdUntil > now) return "reauth"
  return host?.broker.state === "connected" ? "enabled" : "disconnected"
}

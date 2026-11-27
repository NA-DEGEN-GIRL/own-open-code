// OWN-PATCH(P-039) begin
export * as ClaudeObserver from "./observer.js"

import type { AccountInfo, SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-052) begin
import type { ClaudeRelay } from "./relay.js"
// OWN-PATCH(P-052) end

// Claude Code reports plan limits on its own stream (`rate_limit_event`), the login a process started with, and usage
// answers to a control request, with no HTTP response a plugin hook could read. own's accounts plugin is another
// bundle, so the provider hands these over a channel under a registered symbol: listeners get each observation, and
// `usage` asks claude for an account folder's plan windows (a live process of that folder, else a short one that sends
// no prompt). A channel nobody listens to costs nothing.
export interface Observation {
  // The account folder of the process (its CLAUDE_CONFIG_DIR), when the provider settings name one.
  readonly configDir?: string
  readonly sessionID?: string
  readonly rateLimit?: SDKRateLimitInfo
  // The plan of the login only: never its e-mail or organization.
  readonly account?: Plan
  readonly usage?: SDKControlGetUsageResponse
  // OWN-PATCH(P-044) begin
  // The process pool: live processes, the cap, the conversations waiting for a slot (`sessionID` names the one that
  // just started waiting).
  readonly pool?: PoolStatus
  // OWN-PATCH(P-044) end
  // OWN-PATCH(P-053) begin
  // A turn's per-model context windows as Claude Code reported them in its result (`modelUsage[*].contextWindow`),
  // with the catalog model the turn asked for: the provider fills a window its login check could not read.
  readonly windows?: TurnWindows
  // OWN-PATCH(P-053) end
  // OWN-PATCH(P-060) begin
  // The provider's model list as Claude Code reported it (the concrete model of each alias, its window, Fast), sent
  // whenever it changes; also kept as `channel().models` for a listener that starts later.
  readonly models?: ReadonlyArray<ModelFact>
  // A turn's Fast mode as Claude Code reported it (`fast_mode_state` of the result), with what the request asked.
  readonly fast?: FastState
  // OWN-PATCH(P-060) end
  readonly at: number
}

// OWN-PATCH(P-060) begin
export interface ModelFact {
  // The catalog id (Claude Code's alias `opus`, `opus[1m]`, or a model id).
  readonly id: string
  readonly name: string
  // The model the alias runs now (`claude-opus-5-5`), when Claude Code said.
  readonly resolvedModel?: string
  readonly contextWindow?: number
  readonly supportsFastMode?: boolean
}

export interface FastState {
  readonly model: string
  readonly requested: boolean
  readonly state?: "off" | "cooldown" | "on"
  readonly reason?: string
}

/** The latest model list any provider instance of this process reported. */
export function models() {
  return channel().models
}
// OWN-PATCH(P-060) end

// OWN-PATCH(P-053) begin
export interface TurnWindows {
  // The catalog model id the turn ran (`opus`, `opus[1m]` …).
  readonly model: string
  // Each model the turn's query used, keyed as Claude Code keys `modelUsage`, with its canonical id when given.
  readonly usage: ReadonlyArray<{ readonly key: string; readonly canonical?: string; readonly contextWindow: number }>
}
// OWN-PATCH(P-053) end

// OWN-PATCH(P-044) begin
export interface PoolStatus {
  readonly live: number
  readonly cap: number
  readonly waiting: ReadonlyArray<{ readonly sessionID?: string; readonly since: number }>
  readonly over: number
}

/** own's pool settings: the cap on live claude processes and spare processes per account (02 §8.10.12). */
export interface Settings {
  readonly processes?: number
  readonly spares?: number
}

export function settings(): Settings {
  return channel().settings ?? {}
}

/** Sets the pool settings for this service's provider (own-accounts, from its policy); every pool applies them now. */
export function configure(next: Settings) {
  channel().settings = next
  for (const recheck of channel().rechecks ?? []) recheck()
}

/** A pool's re-check, run whenever the settings change (CAG-36); answers its removal. */
export function watch(recheck: () => void) {
  const rechecks = (channel().rechecks ??= new Set())
  rechecks.add(recheck)
  return () => void rechecks.delete(recheck)
}

/** The conversations whose claude processes on an account folder are busy; with `close` its idle ones close first. */
export type Busy = (configDir: string, close: boolean) => Promise<ReadonlyArray<string>>

/** The pool as last reported, for a view that opens later. */
export function pool(): PoolStatus | undefined {
  return channel().pool
}
// OWN-PATCH(P-044) end

export type Plan = Pick<AccountInfo, "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider">

export function plan(account: AccountInfo): Plan {
  return {
    ...(account.subscriptionType === undefined ? {} : { subscriptionType: account.subscriptionType }),
    ...(account.tokenSource === undefined ? {} : { tokenSource: account.tokenSource }),
    ...(account.apiKeySource === undefined ? {} : { apiKeySource: account.apiKeySource }),
    ...(account.apiProvider === undefined ? {} : { apiProvider: account.apiProvider }),
  }
}

export type Usage = (configDir: string) => Promise<SDKControlGetUsageResponse>

export interface Channel {
  readonly version: 1
  readonly listeners: Set<(observation: Observation) => void>
  usage?: Usage
  // OWN-PATCH(P-044) begin
  settings?: Settings
  pool?: PoolStatus
  // Every live pool's re-check: own-accounts runs them after it changes `settings`, as `configure` does.
  rechecks?: Set<() => void>
  // own-accounts asks this before an account folder moves to the other route (CAG-37).
  busy?: Busy
  // OWN-PATCH(P-044) end
  // OWN-PATCH(P-043) begin
  // The shared transcript folder own manages (`<OWN_HOME>\claude-agent\projects`, CAG-34): an account folder's
  // transcripts are swept, removed and written only when its `projects` is that folder.
  shared?: string
  // OWN-PATCH(P-043) end
  // OWN-PATCH(P-052) begin
  // On an SSH host: own-accounts (remote mode) relays the provider's claude processes and transcript work to the PC
  // (02 §8.10.13); while it is set, `ClaudeIO.real` uses it.
  relay?: ClaudeRelay.Transport
  // On the PC: the provider serves hosts' relayed processes and transcript work (own-accounts' broker calls it).
  hosts?: ClaudeRelay.Server
  // On the PC: the root of the hosts' working folders (`<OWN_HOME>\claude-agent\hosts`); the provider's own sweep leaves
  // their transcripts to their hosts.
  hostsRoot?: string
  // OWN-PATCH(P-052) end
  // OWN-PATCH(P-060) begin
  models?: ReadonlyArray<ModelFact>
  // OWN-PATCH(P-060) end
}

const KEY = Symbol.for("opencode.claude-agent.observer")
const SERVERS = Symbol.for("opencode.claude-agent.observer.servers")

export function channel(): Channel {
  const scope = globalThis as { [KEY]?: Channel }
  scope[KEY] ??= { version: 1, listeners: new Set() }
  return scope[KEY]
}

// Every live provider instance (one per Location) serves usage questions. `usage` answers through the latest one still
// open, so closing a project Location never unserves the control Location's; it is gone only when none is left.
// OWN-PATCH(P-044) begin
// `busy` likewise (CAG-37): with no provider left, no claude runs.
// OWN-PATCH(P-052) begin
// `hosts` likewise: the relayed processes of SSH hosts (02 §8.10.13).
export function serve(usage: Usage, busy?: Busy, hosts?: ClaudeRelay.Server) {
  const current = channel() as Channel & {
    [SERVERS]?: Array<{ readonly usage: Usage; readonly busy?: Busy; readonly hosts?: ClaudeRelay.Server }>
  }
  const servers = (current[SERVERS] ??= [])
  const served = { usage, busy, hosts }
  // OWN-PATCH(P-052) end
  servers.push(served)
  const dispatch: Usage = (configDir) => {
    const server = servers.at(-1)
    if (!server) return Promise.reject(new Error("Claude Agent is not running"))
    return server.usage(configDir)
  }
  if (servers.length === 1) current.usage = dispatch
  current.busy = (configDir, close) => servers.at(-1)?.busy?.(configDir, close) ?? Promise.resolve([])
  // OWN-PATCH(P-052) begin
  current.hosts = {
    open: (input, signal) => {
      const server = servers.findLast((item) => item.hosts)?.hosts
      if (!server) return Promise.reject(new Error("Claude Agent is not running"))
      return server.open(input, signal)
    },
    call: (input, op, request) => {
      const server = servers.findLast((item) => item.hosts)?.hosts
      if (!server) return Promise.reject(new Error("Claude Agent is not running"))
      return server.call(input, op, request)
    },
    callStream: (input, op) => {
      const server = servers.findLast((item) => item.hosts)?.hosts
      if (!server) throw new Error("Claude Agent is not running")
      return server.callStream(input, op)
    },
  }
  // OWN-PATCH(P-052) end
  return () => {
    const index = servers.indexOf(served)
    if (index >= 0) servers.splice(index, 1)
    if (servers.length === 0) current.usage = undefined
    // OWN-PATCH(P-052) begin
    if (!servers.some((item) => item.hosts)) current.hosts = undefined
    // OWN-PATCH(P-052) end
  }
}

// OWN-PATCH(P-052) begin
/** The PC relay own-accounts named on an SSH host (02 §8.10.13), if any. */
export function relay() {
  return channel().relay
}

/** The root of SSH hosts' working folders on the PC, when own-accounts named it. */
export function hostsRoot() {
  return channel().hostsRoot
}
// OWN-PATCH(P-052) end
// OWN-PATCH(P-044) end

// OWN-PATCH(P-043) begin
/** The shared transcript folder own manages, when own-accounts runs (CAG-34). */
export function shared() {
  return channel().shared
}

/** Names the shared transcript folder (own-accounts sets the field itself; core's tests use this). */
export function share(folder: string | undefined) {
  channel().shared = folder
}
// OWN-PATCH(P-043) end

export function emit(observation: Omit<Observation, "at">) {
  // OWN-PATCH(P-044) begin
  if (observation.pool) channel().pool = observation.pool
  // OWN-PATCH(P-044) end
  // OWN-PATCH(P-060) begin
  if (observation.models) channel().models = observation.models
  // OWN-PATCH(P-060) end
  const listeners = channel().listeners
  if (listeners.size === 0) return
  const stamped = { ...observation, at: Date.now() }
  for (const listener of listeners) listener(stamped)
}
// OWN-PATCH(P-039) end

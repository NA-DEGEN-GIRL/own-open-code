export * as Broadcast from "./broadcast.js"

import type { Alert, Ledger, Limit, OwnAccounts, OwnSkillset, Plugin } from "@own/protocol"

/**
 * Process-wide notifications between the plugin instances of one build (02 §3.8 "재조정", §9.1). Plugin modules are
 * imported again per Location, so an instance can only reach the others through the runtime singleton. Payloads are
 * plain facts; they never carry secrets. Listeners run synchronously in registration order and must not throw
 * (a throwing listener is isolated and reported through `onError`).
 */
export interface Topics {
  /**
   * A registry file changed. `origin: "local"` = written by this process (an RPC, a fetch), `"external"` = another
   * process (file watcher). Every Location reloads providers for `accounts`, `policy` (hideBuiltinProviders), re-checks
   * the plugin allowlist for `trust`, re-reads the group defaults for `presets` (no provider reload) and re-reads its
   * Codex metadata snapshot for `codex-meta`, reloading providers only when the snapshot changed (07 §4.5).
   */
  readonly "store.changed": {
    readonly store: "accounts" | "policy" | "ratecards" | "trust" | "presets" | "codex-meta"
    readonly origin: "local" | "external"
    readonly revision?: number
  }
  /**
   * Claude slot detection or its ack changed; every Location reloads providers (02 §8.4 "전파"). 04 §8.11: also the
   * remote consent (`remote`), the Fast consent (`fast`), the `anthropic` connection (`connection`), and on a remote
   * service the mirrored verdict (`remote`); the local broker re-judges every host and pushes `mirror.changed`.
   */
  readonly "claudeSlot.changed": {
    /** `accounts`: the Claude accounts or the default changed (02 §8.7); `patch`: the local patch was applied. */
    readonly reason: "detected" | "removed" | "ack" | "remote" | "fast" | "connection" | "accounts" | "patch"
  }
  /**
   * Conversations moved to another Claude account (02 §8.7): the switcher, an automatic switch (C-D3) or a removed
   * account. Every instance drops its cached bindings of these sessions.
   */
  readonly "claude.bound": { readonly sessionIDs: ReadonlyArray<string>; readonly accountID: string }
  /** 02 §8.10 (CAG phase 2): the same for a Claude Agent account; `teamID` names a team binding that moved. */
  readonly "claudeAgent.bound": {
    readonly sessionIDs: ReadonlyArray<string>
    readonly accountID: string
    readonly teamID?: string
  }
  /**
   * A web search service's key was stored or removed (`websearch.key.set`, 02 §9.2): every Location folds the web search
   * services again. Names the service only, never the key.
   */
  readonly "searchKey.changed": { readonly service: string }
  /**
   * The MCP servers own added or the list's kept switches changed (03 §18.14, SM): every Location reads them again and
   * folds its MCP servers. No values.
   */
  readonly "mcp.changed": Readonly<Record<string, never>>
  /**
   * What this PC lets an SSH host's MCP servers get changed (`mcp.hosts.send`/`unsend`, 04 §13 "MCP", MH): the broker
   * tells that host to ask for its values again (`mcp.changed` push). Ids only, never a value.
   */
  readonly "mcp.hosts.changed": { readonly hostId: string }
  /**
   * The GitHub accounts, their choices, the settings or the tool list changed (16, GH): every Location reads
   * `github.json` again and registers its GitHub tools again when what it offers changed. No tokens.
   */
  readonly "github.changed": Readonly<Record<string, never>>
  /**
   * 내 브라우저 사용's setting changed (`browse.set`, BRW): every Location of this PC reads `browse.json` again and folds
   * its MCP servers when the program it runs changed. No values.
   */
  readonly "browse.changed": Readonly<Record<string, never>>
  /**
   * The skill switches or scopes changed (03 §19.6.1, SG, `skillset.switch`): every Location reads them again and folds
   * its skills when its snapshot changed. No ids. `settle`: each Location hands over its re-read and reload, so the
   * writer can announce the change once every open Location folded it (a plugin's `ctx.skill.reload()` tells clients
   * nothing they can tie to a Location: core publishes its `skill.updated` without one).
   */
  readonly "skillset.changed": { readonly settle?: (folded: Promise<unknown>) => void }
  /**
   * Synchronous query for what the skill fold of the Location of `directory` removed last (`skillset.view{directory}`,
   * which answers in the control location): the live instance of that Location calls `reply`. No reply: that Location
   * is not open in this process.
   */
  readonly "skillset.removed.query": {
    readonly directory: string
    readonly reply: (removed: ReadonlyArray<OwnSkillset.Off>) => void
  }
  /**
   * Limit windows changed significantly (`Limits.Store.upsert` result), from either plugin (02 §7.2). `dropped`: the
   * windows the store forgot (`Limits.Store.drop`, a removed budget); their accounts' `quota.updated` then says what is
   * left, and the broker tells connected hosts to forget them too.
   */
  readonly "limits.updated": {
    readonly windows: ReadonlyArray<Limit.Window>
    readonly dropped?: ReadonlyArray<Pick<Limit.Window, "accountID" | "id">>
    /**
     * Reset credit counts that changed (`Limits.Store.upsertCredits`, 02 §7.1.1), or that a redeem read again: their
     * accounts' next `quota.updated` carries them. Hosts never get them (the broker pushes windows only).
     */
    readonly resetCredits?: ReadonlyArray<Limit.ResetCredits>
    /**
     * Accounts whose reset credit count is unknown now (`Limits.Store.forgetCredits`): their next `quota.updated` says
     * `resetCredits: null` unless a count came in since.
     */
    readonly creditsUnknown?: ReadonlyArray<Limit.ResetCredits["accountID"]>
  }
  /** A retry hook classified a failure as hard or auth and recorded it (02 §5.2, §8.8). */
  readonly exhausted: {
    readonly exhaustion: Limit.Exhaustion
    readonly providerID: string
    readonly sessionID?: string
  }
  /**
   * An alert judged by a plugin that does not own the RPC (own-telemetry's `claude_extra_usage`, 02 §7.7). The
   * own-accounts leader re-emits it as the `alert` RPC event.
   */
  readonly alert: {
    readonly code: Alert.Code
    readonly severity: Alert.Severity
    readonly message: string
    readonly sessionID?: string
    readonly accountID?: string
    readonly directory?: string
    /** What else the alert is about (a model id); de-duplication only. */
    readonly subject?: string
  }
  /** A usage ledger line was written; the session's own-accounts instance emits `ledger.step` (02 §7.5). */
  readonly "ledger.line": { readonly eid: string; readonly line: Ledger.Line }
  /**
   * A Location's project plugin allowlist state changed (02 §4.2). Each own-accounts instance computes only its own
   * Location; the leader turns this into `plugin.trust.changed`.
   */
  readonly "location.state": LocationState
  /**
   * Synchronous query for every open Location's allowlist state (`health.locations`, `plugin.trust.list`): each live
   * instance calls `reply` with its state. Stopped instances have unsubscribed, so no closed Location answers.
   */
  readonly "location.query": { readonly reply: (state: LocationState) => void }
  /**
   * Synchronous query for the hidden agents' models each live own-accounts instance's agent fold removed (07 §5.4,
   * `diagnostics.selfTest.agentModels`): a project config's `agents.<id>.model` is folded only in that project's
   * Location, while selfTest runs in the control location. Each live instance calls `reply` with its removals.
   */
  readonly "agents.removed.query": { readonly reply: (removed: ReadonlyArray<AgentModelRemoval>) => void }
  /**
   * The auth swap verdict of an own slot changed (02 §4.2): the latest observed request carried exactly the injected
   * credential (`ok`) or not (`broken`). Requests run in the session's Location while `diagnostics.selfTest` runs in
   * the control location, so every instance keeps the process-wide latest verdict.
   */
  readonly "auth.swap": { readonly providerID: string; readonly verdict: "ok" | "broken" }
  /**
   * A user replaced an account's stored credential (`accounts.update{replaceKey}`, a ChatGPT re-login). Not sent for a
   * refresh. The local credential broker revokes the leases SSH hosts hold for the slot (04 §8.9 "폐기").
   */
  readonly "credential.replaced": { readonly accountID: string; readonly providerID: string }
  /**
   * The user's protected paths changed (`protectedPaths.add`/`remove`, 01 §13 에이전트가 못 여는 파일·폴더, PP): every
   * own-accounts instance takes the new list for its permission hook. The paths as added (`~` kept); not secret.
   */
  readonly "protectedPaths.changed": { readonly paths: ReadonlyArray<string> }
}

/** A hidden agent's configured model that an agent fold removed (`diagnostics.selfTest.agentModels.removed`). */
export type AgentModelRemoval = NonNullable<OwnAccounts.SelfTest["agentModels"]>["removed"][number]

/** One Location's allowlist state as its own-accounts instance last computed it. */
export interface LocationState {
  readonly directory: string
  readonly status: Plugin.TrustStatus
  /** Plugins outside the default allowlist; `sha256` is `null` when the entry was unreadable. */
  readonly candidates: ReadonlyArray<{ readonly id: string; readonly source: string; readonly sha256: string | null }>
  /** Candidates without a matching approval. */
  readonly pending: number
}

export type Topic = keyof Topics
export type Listener<T extends Topic> = (payload: Topics[T]) => void

export class Hub {
  readonly #listeners = new Map<Topic, Set<(payload: never) => void>>()
  readonly #onError: (topic: Topic, error: unknown) => void

  constructor(options: { readonly onError?: (topic: Topic, error: unknown) => void } = {}) {
    this.#onError = options.onError ?? (() => {})
  }

  /** Subscribes; returns the unsubscribe function. Call it from the plugin's cleanup. */
  on<T extends Topic>(topic: T, listener: Listener<T>) {
    const set = this.#listeners.get(topic) ?? new Set()
    set.add(listener)
    this.#listeners.set(topic, set)
    return () => {
      set.delete(listener)
    }
  }

  emit<T extends Topic>(topic: T, payload: Topics[T]) {
    const set = this.#listeners.get(topic)
    if (!set) return
    // Listeners are stored per topic, so every listener in this set accepts `Topics[T]`.
    for (const listener of [...set] as Listener<T>[]) {
      try {
        listener(payload)
      } catch (error) {
        this.#onError(topic, error)
      }
    }
  }

  /** Number of listeners of a topic, for tests and health. */
  size(topic: Topic) {
    return this.#listeners.get(topic)?.size ?? 0
  }

  clear() {
    this.#listeners.clear()
  }
}

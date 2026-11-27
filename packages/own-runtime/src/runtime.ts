export * as Runtime from "./runtime.js"

import type { Policy, Preset, Ratecard, Registry, Voice } from "@own/protocol"
import { Broadcast } from "./broadcast.js"
import { ClaudeAccounts } from "./claude-accounts.js"
import { Credentials } from "./credentials.js"
import { Home } from "./home.js"
import { LastResponse } from "./last-response.js"
import { LedgerWriter } from "./ledger-writer.js"
import { Limits } from "./limits.js"
import { Lock } from "./lock.js"
import { Sessions } from "./sessions.js"
import { SlotSamples } from "./slot-samples.js"
import { SpeedMarks } from "./speed-marks.js"
import { Store } from "./store.js"
import { Vault } from "./vault.js"

/** How the vault client reaches its helper. */
export type VaultOption =
  /** `own-vault.exe` (default: the installed version's, `Home.layout().vaultExe`), or a replacement command line. */
  | { readonly exePath?: string; readonly command?: ReadonlyArray<string>; readonly timeoutMs?: number }
  /** Any transport, e.g. `Vault.memory()` in tests. */
  | { readonly transport: Vault.Transport }

export interface Options {
  /** Build id stamped into both plugin bundles (01 §4). Old and new builds never share a singleton. */
  readonly buildId: string
  /** Plugin option `home` (02 §2.3). */
  readonly home?: string
  readonly vault?: VaultOption
  /** The control location instance asks for leadership; otherwise the first instance leads (02 §7.2 poller). */
  readonly preferLeader?: boolean
  /**
   * Leadership group, normally the plugin id. Every plugin of a build shares the singleton, but each plugin elects its
   * own leader among its own instances, so own-accounts' control instance never keeps own-remote's control instance
   * from publishing `own.remote` events (and the reverse). Default {@link DEFAULT_ROLE}.
   */
  readonly role?: string
  /** Initial `policy.secretCacheSeconds`; change it later with `credentials.configure`. */
  readonly secretCacheSeconds?: number
  /** Development seed of `ratecards.json`, e.g. `own/config/ratecards.default.json`. */
  readonly ratecardsSeed?: string
  readonly now?: () => number
}

/** The process-wide services, shared by every plugin instance of one build. */
export interface Services {
  readonly buildId: string
  readonly layout: Home.Layout
  readonly registry: Store.JsonFile<typeof Registry.File>
  readonly policy: Store.JsonFile<typeof Policy.File>
  readonly ratecards: Store.JsonFile<typeof Ratecard.File>
  readonly trust: Store.JsonFile<typeof Registry.TrustFile>
  readonly presets: Store.JsonFile<typeof Preset.File>
  /** Voice input settings and usage minutes (02 §3.9). */
  readonly voice: Store.JsonFile<typeof Voice.File>
  readonly limits: Limits.Store
  /** Session → slot index written by each session's Location instance, read by every instance (02 §9.2). */
  readonly sessions: Sessions.Index
  /** Subagent calls the presets gate let through, per root session (07 §2.6 세는 법). In memory only. */
  readonly reservations: Reservations
  readonly ledger: LedgerWriter.Writer
  readonly lastResponse: LastResponse.Store
  /** Speed tier marks, Sign in with ChatGPT tier lists and tier-change cache retention (02 §4.8). In memory only. */
  readonly speed: SpeedMarks.Store
  /**
   * Each slot's Z and exchange samples, added by every own.accounts instance from its Location's sessions and read by
   * `estimate.request` at the control Location (09 §5.6). In memory only.
   */
  readonly samples: SlotSamples.Store
  /** Which Claude account signed an `anthropic` request (02 §8.5, G4): own-accounts resolves, observers ask. */
  readonly claude: ClaudeAccounts.Attribution
  readonly credentials: Credentials.Service
  /** Process-wide notifications between plugin instances (registry reconcile, own-telemetry to own-accounts). */
  readonly broadcast: Broadcast.Hub
  /**
   * Workspace notes and idea notes writes (02 §9.2), one at a time: each reads and rewrites a workspace's index, or
   * compares an idea's revision and counts the ideas, in the plugin KV, so two devices saving at once must not
   * interleave.
   */
  readonly notes: Lock.Mutex
  /** Vault health only; secrets are reached through {@link Services.credentials}. */
  readonly vault: {
    readonly status: () => "unknown" | "ok" | "unavailable"
    readonly hello: Vault.Client["hello"]
    readonly list: Vault.Client["list"]
  }
}

/** One plugin instance's reference to the singleton. */
export interface Handle extends Services {
  /**
   * Whether this instance leads its {@link Options.role} group: for own-accounts global events, pollers, ledger
   * maintenance and `limits.json`; for own-remote the `own.remote` events.
   */
  isLeader(): boolean
  /** Drops this reference; the last one flushes the ledger, saves limits and stops the vault helper. Idempotent. */
  release(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

interface Holder {
  readonly id: number
  readonly preferLeader: boolean
  readonly role: string
}

/** {@link Options.role} of instances that name none: own-accounts, the runtime's main user. */
export const DEFAULT_ROLE = "own.accounts"

interface Shared {
  readonly services: Services
  readonly ready: Promise<void>
  readonly holders: Holder[]
  readonly close: () => Promise<void>
  next: number
}

/** `globalThis` key of a build's singleton (01 §4). */
export function key(buildId: string) {
  return Symbol.for(`own-open-code.runtime/${buildId}`)
}

/**
 * Acquires the singleton of this build, creating it on first use (01 §4 "싱글턴 규칙"). Plugin modules are imported
 * again per Location and on reload, so module-level state is never shared; `globalThis` under a build-id key is.
 * Call from plugin setup and `release()` from the scope finalizer. Old and new builds that overlap after a reload
 * use different keys and are kept apart by the file locks, not by memory.
 */
export async function acquire(options: Options): Promise<Handle> {
  const shared = slot(options.buildId) ?? create(options)
  const home = Home.resolve({ home: options.home })
  if (shared.services.layout.root !== home)
    throw new Error(`own runtime ${options.buildId} already uses OWN_HOME ${shared.services.layout.root}, not ${home}`)
  const holder: Holder = {
    id: shared.next++,
    preferLeader: options.preferLeader ?? false,
    role: options.role ?? DEFAULT_ROLE,
  }
  shared.holders.push(holder)
  await shared.ready.catch((error: unknown) => {
    shared.holders.splice(shared.holders.indexOf(holder), 1)
    if (shared.holders.length === 0) clear(options.buildId, shared)
    throw error
  })
  const release = once(async () => {
    shared.holders.splice(shared.holders.indexOf(holder), 1)
    if (shared.holders.length > 0) return
    clear(options.buildId, shared)
    await shared.close()
  })
  return {
    ...shared.services,
    isLeader: () => {
      const group = shared.holders.filter((item) => item.role === holder.role)
      return (group.find((item) => item.preferLeader) ?? group[0])?.id === holder.id
    },
    release,
    [Symbol.asyncDispose]: release,
  }
}

/**
 * Reference count, home and references per {@link Options.role} of a build's singleton, if it exists. A role without
 * references is absent from `roles`.
 */
export function peek(buildId: string) {
  const shared = slot(buildId)
  return (
    shared && {
      refs: shared.holders.length,
      home: shared.services.layout.root,
      roles: shared.holders.reduce<Partial<Record<string, number>>>(
        (counts, holder) => ({ ...counts, [holder.role]: (counts[holder.role] ?? 0) + 1 }),
        {},
      ),
    }
  )
}

function create(options: Options): Shared {
  const now = options.now ?? Date.now
  const paths = Home.layout(Home.resolve({ home: options.home }))
  const vaultOption = options.vault ?? {}
  const client = new Vault.Client(
    "transport" in vaultOption
      ? vaultOption.transport
      : Vault.spawnHelper({
          exePath: vaultOption.exePath ?? paths.vaultExe,
          home: paths.root,
          command: vaultOption.command,
          timeoutMs: vaultOption.timeoutMs,
          now,
        }),
  )
  const lastResponse = new LastResponse.Store({ now })
  const limits = new Limits.Store({ file: paths.limits, now })
  // The listeners run on the first update or removal, after `reservations` exists.
  const sessions = new Tracked(
    { file: paths.sessions, now },
    (entry) => reservations.observe(entry),
    (sessionID) => reservations.forget(sessionID),
  )
  const reservations = new Reservations(sessions)
  const ledger = new LedgerWriter.Writer({ dir: paths.ledger, now })
  const registryFiles = { layout: paths, mutex: new Lock.Mutex() }
  const services: Services = {
    buildId: options.buildId,
    layout: paths,
    registry: Store.accounts(registryFiles),
    policy: Store.policy(registryFiles),
    ratecards: Store.ratecards(registryFiles, options.ratecardsSeed),
    trust: Store.trust(registryFiles),
    presets: Store.presets(registryFiles),
    voice: Store.voice(registryFiles),
    limits,
    sessions,
    reservations,
    ledger,
    lastResponse,
    speed: new SpeedMarks.Store(),
    samples: new SlotSamples.Store(),
    claude: new ClaudeAccounts.Attribution(),
    credentials: new Credentials.Service({
      vault: client,
      now,
      secretCacheSeconds: options.secretCacheSeconds,
      onInjected: (sessionID, providerID, hash) => lastResponse.recordInjected(sessionID, providerID, hash),
    }),
    broadcast: new Broadcast.Hub(),
    notes: new Lock.Mutex(),
    vault: { status: () => client.status(), hello: () => client.hello(), list: () => client.list() },
  }
  const shared: Shared = {
    services,
    ready: Home.ensure(paths).then(() => Promise.all([limits.load(), sessions.load()]).then(() => undefined)),
    holders: [],
    next: 1,
    close: async () => {
      services.broadcast.clear()
      await Promise.allSettled([ledger.flush(), limits.save(), sessions.save()])
      await client.close()
    },
  }
  // Written before the first await so concurrent acquires in the same tick join this instance.
  globals()[key(options.buildId)] = shared
  return shared
}

/** One of a root session's three subagent caps (07 §2.6, `Preset.Cap`). */
export type Cap = "concurrent" | "perMessage" | "perSession"

/**
 * The caps in force for one call: `Preset.caps`, the per-message cap raised for one message by `raiseOnce`.
 * `perSession: null` is no conversation cap (the default).
 */
export interface Caps {
  readonly concurrent: number
  readonly perMessage: number
  readonly perSession: number | null
}

/** A subagent call the presets gate let through (07 §5.4 step 6), from its `execute.before` to its `execute.after`. */
export interface Claim {
  /** The root session, whose caps the call counts against. */
  readonly root: string
  /** The calling session: the parent of the child. */
  readonly parent: string
  /** The tool call id; its `execute.after` settles the claim ({@link Reservations.finish}). */
  readonly callID?: string
  /**
   * The root's user message a new child counts against. Absent for a continued child, which counts only while it
   * runs (07 §2.6: per message and per conversation count the subagents a call creates).
   */
  readonly message?: string
  /** The child a continued call wakes; for a background launch, the child once `execute.after` names it. */
  readonly child?: string
  /**
   * What the LLM reads with the call's result: the role ran on a fallback target (07 §1.2, §3.3), and a per-call
   * effort sent otherwise than asked (07 §2.3), one sentence each.
   */
  readonly notice?: string
  /**
   * A per-call effort (07 §2.3 대화에서 정하는 강도): the intent the call asked for and the variant it went with
   * (`null` = none, the provider default). `execute.after` puts it in the result's `metadata.own.effort`.
   */
  readonly effort?: { readonly requested: string; readonly used: string | null }
}

/** The answer of {@link Reservations.take}: held, or the first cap that is full and its value. */
export type Taken = { readonly ok: true } | { readonly ok: false; readonly cap: Cap; readonly max: number }

/** What a root uses now: subagents running, new ones for its current user message, new ones in the conversation. */
export interface Counts {
  readonly running: number
  readonly message: number
  readonly session: number
  /** The user message `message` counts for: the last one a new child counted against. */
  readonly messageID?: string
}

interface Held extends Claim {
  child?: string
  /** Counted as running: the child has not shown up busy in the session index yet. */
  pending: boolean
  /** `execute.after` saw a background launch; the claim stays until the child shows up busy. */
  launched: boolean
}

interface Usage {
  session: number
  message?: { readonly id: string; readonly count: number }
}

/** Parents a running session's root is looked for through; core nests subagents one level deep by default. */
const MAX_DEPTH = 16

/**
 * The presets gate's reservation map (07 §2.6 세는 법). Core runs every tool call of a step at once and has no cap on
 * subagents, so the gate counts them itself. Running = the root's busy descendants in the session index plus the
 * calls held here whose child has not shown up busy yet. Checking the caps and holding a call is one synchronous step
 * ({@link take}), so the parallel calls of one step never read the same count.
 *
 * A held call stops counting as running when its child's busy entry appears (the oldest held call of that parent
 * without a child yet takes the first new busy child), and is settled by its `execute.after` ({@link finish}): a
 * failed call whose child never ran is taken back from the message and conversation counts. When the calling
 * session stops running, whatever it still holds never got a child (a later hook refused the call, the turn was
 * interrupted) and is taken back too. Per-message and per-conversation counts live here per root; the gate persists
 * the conversation count (KV `presetUsage`), and {@link take} never counts below the persisted value.
 */
export class Reservations {
  readonly #sessions: Sessions.Index
  /** In {@link take} order: the first held call of a parent is its oldest. */
  readonly #held = new Set<Held>()
  readonly #roots = new Map<string, Usage>()

  constructor(sessions: Sessions.Index) {
    this.#sessions = sessions
  }

  counts(root: string): Counts {
    const usage = this.#roots.get(root)
    return {
      running: this.#running(root),
      message: usage?.message?.count ?? 0,
      session: usage?.session ?? 0,
      ...(usage?.message ? { messageID: usage.message.id } : {}),
    }
  }

  /**
   * Checks the caps and holds the call. A new child (`message`) is checked against the conversation cap (when there
   * is one), then its message's, then the running cap; a continued child only against the running cap, and not at all when it is
   * running already (a steer). `stored` is the persisted conversation count.
   */
  take(claim: Claim, caps: Caps, stored = 0): Taken {
    const usage = this.#roots.get(claim.root) ?? { session: 0 }
    usage.session = Math.max(usage.session, stored)
    this.#roots.set(claim.root, usage)
    const message = claim.message
    const count = message !== undefined && usage.message?.id === message ? usage.message.count : 0
    const running = claim.child !== undefined && this.#sessions.get(claim.child)?.busy === true
    if (message !== undefined && caps.perSession !== null && usage.session >= caps.perSession)
      return { ok: false, cap: "perSession", max: caps.perSession }
    if (message !== undefined && count >= caps.perMessage) return { ok: false, cap: "perMessage", max: caps.perMessage }
    if (!running && this.#running(claim.root) >= caps.concurrent)
      return { ok: false, cap: "concurrent", max: caps.concurrent }
    if (message !== undefined) {
      usage.session += 1
      usage.message = { id: message, count: count + 1 }
    }
    this.#held.add({ ...claim, pending: !running, launched: false })
    return { ok: true }
  }

  /**
   * The call's `execute.after`. A failed call is settled (and taken back from the counts when its child never ran);
   * a background launch (`launched`, the child's id) keeps counting as running until that child shows up busy;
   * anything else is settled. Answers the held claim, `undefined` when the call holds none.
   */
  finish(callID: string, outcome: { readonly failed: boolean; readonly launched?: string }): Claim | undefined {
    const held = [...this.#held].find((item) => item.callID === callID)
    if (!held) return undefined
    if (!outcome.failed && outcome.launched !== undefined && held.pending) {
      held.child = outcome.launched
      held.launched = true
      return held
    }
    this.#settle(held, outcome.failed)
    return held
  }

  /** The session index saw a session start or stop running. */
  observe(entry: Sessions.Entry) {
    if (!entry.busy) {
      this.#release(entry.sessionID)
      return
    }
    const held =
      this.#first((item) => item.pending && item.child === entry.sessionID) ??
      this.#first((item) => item.pending && item.child === undefined && item.parent === entry.parentID)
    if (!held) return
    held.pending = false
    held.child = entry.sessionID
    if (held.launched) this.#held.delete(held)
  }

  /** The session index removed a session (deleted): like a caller that stopped, and its root counts go. */
  forget(sessionID: string) {
    this.#release(sessionID)
    this.#roots.delete(sessionID)
  }

  /** A calling session stopped: its held calls never got a child running. */
  #release(parent: string) {
    for (const held of this.#held) if (held.parent === parent) this.#settle(held, true)
  }

  #settle(held: Held, failed: boolean) {
    this.#held.delete(held)
    if (!failed || !held.pending || held.message === undefined) return
    const usage = this.#roots.get(held.root)
    if (!usage) return
    usage.session = Math.max(0, usage.session - 1)
    if (usage.message?.id === held.message)
      usage.message = { id: usage.message.id, count: Math.max(0, usage.message.count - 1) }
  }

  #first(match: (held: Held) => boolean) {
    return [...this.#held].find(match)
  }

  #running(root: string) {
    const under = (parentID: string | null, depth: number): boolean =>
      parentID !== null &&
      depth < MAX_DEPTH &&
      (parentID === root || under(this.#sessions.get(parentID)?.parentID ?? null, depth + 1))
    const busy = this.#sessions.list().filter((entry) => entry.busy && under(entry.parentID, 0)).length
    return busy + [...this.#held].filter((held) => held.pending && held.root === root).length
  }
}

/** The session index, telling the reservations when a session starts or stops running and when one is removed. */
class Tracked extends Sessions.Index {
  readonly #changed: (entry: Sessions.Entry) => void
  readonly #removed: (sessionID: string) => void

  constructor(
    options: ConstructorParameters<typeof Sessions.Index>[0],
    changed: (entry: Sessions.Entry) => void,
    removed: (sessionID: string) => void,
  ) {
    super(options)
    this.#changed = changed
    this.#removed = removed
  }

  override update(sessionID: string, patch: Sessions.Patch) {
    const busy = this.get(sessionID)?.busy ?? false
    const entry = super.update(sessionID, patch)
    if (entry.busy !== busy) this.#changed(entry)
    return entry
  }

  override remove(sessionID: string) {
    super.remove(sessionID)
    this.#removed(sessionID)
  }
}

function slot(buildId: string) {
  return globals()[key(buildId)]
}

function clear(buildId: string, shared: Shared) {
  if (globals()[key(buildId)] === shared) delete globals()[key(buildId)]
}

function once(run: () => Promise<void>) {
  const state: { promise?: Promise<void> } = {}
  return () => (state.promise ??= run())
}

// The singleton lives on globalThis by design (01 §4); this is the one place that indexes it.
function globals() {
  return globalThis as unknown as Record<symbol, Shared | undefined>
}

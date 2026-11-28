export * as Telemetry from "./telemetry.js"

import { Option, Schema } from "effect"
import type { Message } from "@opencode/ai/effect"
import type {
  SessionHttpRequest,
  SessionHttpResponse,
  SessionModelRequest,
  SessionRetry,
  SessionWebSocketReceive,
} from "@opencode/plugin/promise/session"
import { Event } from "@opencode/schema/event"
import type { FinishReason } from "@opencode/schema/llm"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { Hash, type LastResponse } from "@own/runtime"
import {
  Account,
  Cache,
  CompactionCache,
  type Alert,
  Kind,
  Kv,
  Ledger,
  type Limit,
  LimitModel,
  OwnID,
  Ratecard,
  Speed,
} from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { Resets } from "../resets.js"
import { RpcTypes } from "../rpc/types.js"
import type { Slots } from "../slots/slots.js"
import { Alerts } from "./alerts.js"
import { Book } from "./book.js"
import { CacheState } from "./cache.js"
import { Capture } from "./capture.js"
import { Classify } from "./classify.js"
import { LimitReset } from "./limit-reset.js"
import { Poller } from "./poller.js"
import { Rates } from "./rates.js"
import { Relay } from "./relay.js"
import { StreamUsage } from "./stream.js"
import { Totals } from "./totals.js"
import { Windows } from "./windows.js"

/**
 * Owner: TELEMETRY agent. Passive observation of own slots (02 §7, 01 §14): limit capture from `http.response`
 * headers and `experimental.ws.receive` frames (read-only, never consume the body), `lastResponse`, 401 hand-off
 * to `logins.unauthorized`, retry classification (hard/transient/auth, 02 §5.2) with exhaustion records, one
 * ledger line per step from the event stream (02 §7.5, `anthropic` sessions too), cache state per session and
 * slot (KV `sess:<sid>:cache:<pid>`), balance pollers (leader), alerts (02 §7.7), the usage/quota RPCs, and ChatGPT's
 * reset credits (`quota.resetCredits.*`, 02 §7.1.1: read for the dialog, redeemed only after the user confirms).
 * Also re-emits what own-telemetry pushes through `runtime.broadcast` (`limits.updated`, `exhausted`, `alert`), and
 * owns the opt-in wire evidence capture (`capture`, P0-3a), which the same read-only hooks feed while a window runs.
 */

/** Retry-hook classification handed to switching (02 §5.2). */
export interface Verdict {
  /** `hard`/`auth` are switch triggers; `transient` keeps retrying the same account; `unknown` = not ours / no data. */
  readonly class: Limit.ExhaustionClass | "unknown"
  readonly accountID?: Account.ID
  /** Exhaustion end (reset + jitter, or backoff). */
  readonly until?: number
}

export interface AlertInput {
  readonly code: Alert.Code
  readonly severity: Alert.Severity
  /** User-facing text; no secrets. */
  readonly message: string
  readonly sessionID?: string
  readonly accountID?: string
  readonly directory?: string
  /** What else the alert is about, e.g. a model id; part of the de-duplication key only, never sent. */
  readonly subject?: string
  /**
   * Facts about the alert (e.g. `providerID`, `modelID`, `finish`) for the `events.jsonl` line and the log; the `alert`
   * RPC event does not carry them, and they are not part of the de-duplication key. No secrets.
   */
  readonly fields?: Readonly<Record<string, string>>
}

export interface Api extends Module.Lifecycle {
  /**
   * One call of own's image tool (02 §9.6): a `kind: "image"` ledger line on the slot that answered. An API key's line
   * carries the Images API tokens (`input`, its cached part, `output`) and the image card's USD (`source: "ratecard"`);
   * a subscription's carries none: it counts against the plan's limits, which the answer's usage headers update.
   */
  recordImage(input: {
    readonly sessionID: string
    readonly providerID: string
    readonly modelID: string
    readonly at: number
    readonly tokens?: { readonly input: number; readonly cached: number; readonly output: number }
    readonly costUSD?: number
  }): Promise<void>
  /**
   * One side question (곁질문, 02 §9.7): a `kind: "side"` line with the usage core reported (`usageSource: "event"`;
   * none: the size estimate is unknown, so no tokens). Never a step: it moves no cache entry, alert or compaction.
   * Answers the line's cost.
   */
  recordSide(input: {
    readonly sessionID: string
    readonly model: Model.Ref
    readonly at: number
    readonly tokens: Tokens | null
    readonly costUSD: number | null
  }): Promise<Ledger.Cost | null>
  /** Records `{sessionID → kind, providerID}` for ledger correlation of compaction/title/generate (02 §7.5 step 3, 4). */
  onModelRequest(event: SessionModelRequest): void
  /**
   * The session's last primary request in this process and its slot's cache lifetime (idle compaction, 02 §4.7.7; the
   * P-034 verdict), and whether a Claude account switch since left it on another account's (empty) cache (SL-8).
   */
  primaryCache(sessionID: string): Promise<
    | {
        readonly model: Model.Ref
        readonly providerID: string
        readonly kind: Kind.Own | undefined
        readonly startedAt: number
        readonly ttl: CacheState.Ttl | undefined
        /** The session's next request runs on another Claude account than its latest did (SL-8): a cold cache. */
        readonly moved: boolean
      }
    | undefined
  >
  /** P-034: whether a compaction of the session may send the whole history (`CompactionCache.CACHE_KEY`). */
  prefixVerdict(event: { readonly sessionID: string; readonly model: Model.Ref }): Promise<CompactionCache.CacheVerdict>
  /**
   * P-034's second run (CC-12): why the older request would read the cache as well (decline the whole history), or
   * `undefined` to send it.
   */
  recentVerdict(event: {
    readonly sessionID: string
    readonly model: Model.Ref
    readonly messages: ReadonlyArray<Message>
    readonly kept: { readonly messageID: string }
  }): Promise<CompactionCache.RecentReason | undefined>
  /** Read-only: when a compaction request is sent (the cache clock of its line, CC-12). */
  onHttpRequest(event: SessionHttpRequest): void
  /** Read-only. Headers only; for status ≥ 400 the first 2 KB of `response.clone().text()` (02 §7.2). */
  onHttpResponse(event: SessionHttpResponse): Promise<void>
  /** Read-only; substring prefilter before any JSON parse; returns the frame untouched (02 §7.2). */
  onWsReceive(event: SessionWebSocketReceive): void
  /** Classifies own-slot failures; `hard` sets `event.decision = { retry: false }` and records exhaustion. */
  onRetry(event: SessionRetry): Promise<Verdict>
  /** Raise an alert: `events.jsonl` via the ledger writer and the `alert` RPC event, de-duplicated per code/subject. */
  alert(input: AlertInput): void
  /** Resolves once queued ledger/cache work and background stream reads have finished (tests, shutdown). */
  flush(): Promise<void>
  /** Emits the session's `cache.state` again, e.g. after its compaction threshold changed (02 §9.3). */
  refreshCacheState(sessionID: string): void

  quotaSnapshot: RpcTypes.Handler<"quota.snapshot">
  /** 02 §7.1.1 리셋권 (./limit-reset). */
  resetCreditsList: RpcTypes.Handler<"quota.resetCredits.list">
  resetCreditsPlan: RpcTypes.Handler<"quota.resetCredits.redeem.plan">
  resetCreditsExecute: RpcTypes.Handler<"quota.resetCredits.redeem.execute">
  ledgerSession: RpcTypes.Handler<"ledger.session">
  usage: RpcTypes.Handler<"accounts.usage">
  cacheState: RpcTypes.Handler<"cache.state">
  cacheSetTtlMode: RpcTypes.Handler<"cache.setTtlMode">
  ratecardsGet: RpcTypes.Handler<"ratecards.get">
  ratecardsSet: RpcTypes.Handler<"ratecards.set">
  /** Opt-in wire evidence capture (`diagnostics.capture.*`, 02 §7.8); off unless a window runs. */
  readonly capture: Capture.Api
}

/** Frames parsed by `ws.receive`; anything else is returned without a JSON parse (01 §14.3). */
export const FRAME_FILTER = ['"codex.rate_limits"', "usage_limit", "rate_limit", "response.failed", '"type":"error"']
/** Error bodies are read at most this long (they are not streams, but a stalled server must not stall the hook). */
export const BODY_TIMEOUT_MS = 2_000
/** Background usage read of a `generate`/`title` stream gives up after this. */
export const STREAM_TIMEOUT_MS = 5 * 60_000
/** `generate_usage_missing` (02 §7.7): more than this many generate/title lines without stream usage in an hour. */
export const USAGE_MISSING_PER_HOUR = 3
/** Same code and subject are not raised again within this window. */
export const ALERT_DEDUPE_MS = 30 * 60_000
/** `401/403` count without a success in between that makes an `auth` verdict (02 §5.2: after one refresh). */
export const AUTH_REPEAT = 2
/** Exhaustion `until` without a known reset: 15, 30, then 60 minutes (02 §5.2). */
export const BACKOFF_MINUTES = [15, 30, 60] as const
/**
 * A second OpenRouter "fewer max_tokens" 402 of an account within this time, without a success in between, is
 * exhaustion with the shortest backoff (02 §5.2): nothing lowers the requested output, so switching has to move on.
 */
export const UNAFFORDABLE_REPEAT_MS = 10 * 60_000
/** Session memory unused this long is dropped. */
export const SESSION_IDLE_MS = 6 * 3_600_000
/** Step starts kept per session for P-034's second run: far more steps than a lookback spans after the older end. */
export const STARTED_KEPT = 1_000
/** Anthropic's lookback in blocks (the Claude subscription has no card; an `anth` card may leave it out). */
const CLAUDE_LOOKBACK = 20
/** Ledger maintenance (gzip, retention) by the leader. */
export const MAINTAIN_MS = 24 * 3_600_000
/** Waiting for a session's Location to become known before a relayed session alert falls back to the leader. */
export const RELAY_WAIT_MS = 1_500

type Tokens = Ledger.Tokens
type RequestKind = Ledger.RequestKind

interface Step {
  readonly model: Model.Ref
  readonly started: number
}

interface Memory {
  directory?: string
  projectID?: string
  model?: Model.Ref
  readonly steps: Map<string, Step>
  /** Recent steps by assistant message, kept after they end: which request wrote an entry (P-034's second run). */
  readonly started: Map<string, Step>
  /** The compaction request sent last (CC-12): its start and, for an own slot, its own usage read from the stream. */
  compactionSent?: { readonly at: number; tokens?: Promise<Tokens | undefined> }
  /** The running compaction's message (core: its `inputID`, else the started event's id), for its ledger line (SL). */
  compactionMessage?: string | null
  readonly requests: Map<RequestKind, { readonly model: Model.Ref; readonly at: number }>
  switchEpoch?: number
  pendingSwitches: number
  compactionEpoch?: number
  lastProvider?: string
  lastEpoch?: number
  history: Alerts.Step[]
  selections: Alerts.Selection[]
  touched: number
  boundary?: () => void
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeEntry = Schema.decodeUnknownOption(Cache.Entry)
const decodeEpoch = Schema.decodeUnknownOption(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
const decodeTtlMode = Schema.decodeUnknownOption(Cache.TtlMode)
const decodeSessionID = Schema.decodeUnknownOption(SessionID)
const decodeAccountID = Schema.decodeUnknownOption(Account.ID)
const decodeEventID = Schema.decodeUnknownOption(Event.ID)
const toJson = Schema.decodeUnknownSync(Schema.Json)

/** Core's id of a message an event appended (`SessionMessage.ID.fromEvent`); `null` for an id that is no event's. */
const messageOfEvent = (id: string) => Option.getOrNull(Option.map(decodeEventID(id), SessionMessage.ID.fromEvent))

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("telemetry")
  const runtime = deps.runtime
  const book = new Book.Reader({ ledger: runtime.ledger, now: () => deps.clock.now() })
  const relay = Relay.create(deps)
  const sessions = new Map<string, Memory>()
  /** Location directory of every session seen in the event stream (all Locations), for relayed session data. */
  const locations = new Map<string, string>()
  /**
   * Project of every session created while this instance runs (all Locations): `accounts.usage{groupBy:"session"}` is a
   * global method answered in the control location, not in the session's.
   */
  const projects = new Map<string, string>()
  const queues = new Map<string, Promise<void>>()
  const background = new Set<Promise<unknown>>()
  const written = new Set<string>()
  const alerted = new Map<string, number>()
  const authFailures = new Map<string, number>()
  /** Account → when its last OpenRouter max_tokens 402 came (`UNAFFORDABLE_REPEAT_MS`). */
  const unaffordable = new Map<string, number>()
  const backoff = new Map<string, number>()
  const timers = new Set<() => void>()
  const unsubscribe: Array<() => void> = []
  const state: { cards: ReadonlyArray<Ratecard.Card>; stopped: boolean } = { cards: [], stopped: false }
  const poller = Poller.create(deps, peers, (windows, credits) => publish(windows, credits))
  const limitReset = LimitReset.create(deps, peers, { publish: (windows, credits) => publish(windows, credits) })

  // -------------------------------------------------------------------------------------------------------------
  // Plumbing

  const track = <A>(promise: Promise<A>) => {
    background.add(promise)
    void promise.finally(() => background.delete(promise))
    return promise
  }

  /** Serializes work per session so lines, KV updates and alerts of one session keep event order. */
  const enqueue = (sessionID: string, work: () => Promise<void>) => {
    const next = (queues.get(sessionID) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => log.error("session_work_failed", { sessionID, error }))
    queues.set(sessionID, next)
    void track(next).finally(() => {
      if (queues.get(sessionID) === next) queues.delete(sessionID)
    })
  }

  const every = (ms: number, run: () => void) => {
    const loop = () => {
      const cancel = deps.clock.schedule(ms, () => {
        timers.delete(cancel)
        if (state.stopped) return
        run()
        loop()
      })
      timers.add(cancel)
    }
    loop()
  }

  const once = (ms: number, run: () => void) => {
    const cancel = deps.clock.schedule(ms, () => {
      timers.delete(cancel)
      if (!state.stopped) run()
    })
    timers.add(cancel)
    return () => {
      cancel()
      timers.delete(cancel)
    }
  }

  const memory = (sessionID: string): Memory => {
    const existing = sessions.get(sessionID)
    if (existing) {
      existing.touched = deps.clock.now()
      return existing
    }
    const created: Memory = {
      steps: new Map(),
      started: new Map(),
      requests: new Map(),
      pendingSwitches: 0,
      history: [],
      selections: [],
      touched: deps.clock.now(),
    }
    sessions.set(sessionID, created)
    return created
  }

  const slot = (providerID: string) => peers().slots.slot(providerID)
  const capture = Capture.create(deps, { slot, alert: (input) => alert(input), track })

  /**
   * Own account of a provider; for `anthropic` while the Claude slot is present, the Claude account that signed the
   * session's latest request (G4, 02 §8.5, from own-telemetry's observation), else the session's account now.
   */
  const accountOf = (providerID: string, sessionID?: string): Account.ID | null => {
    const own = slot(providerID)
    if (own) return own.account.id
    // The Claude Agent account the session's tree runs on (CAG-53): per-account usage, cache and limit clearing.
    if (providerID === Provider.ID.claudeAgent) return peers().claudeAgent.member(providerID, sessionID)?.id ?? null
    if (providerID !== Provider.ID.anthropic || !peers().plugins.claudeSlot().detected) return null
    if (sessionID === undefined) return Account.ID.claudeSlot
    const signed = runtime.claude.lastOf(sessionID)
    return signed !== undefined && peers().claude.entry(signed)
      ? (signed as Account.ID)
      : peers().claude.peek(sessionID)
  }

  /**
   * The account that signs the session's next request on a provider: its own slot's, for `anthropic` while the Claude
   * slot is present the account the session's tree runs on (SL-8: each Claude account has its own cache), else none.
   * Read from the tree's binding: the sync `peek` answers the default account until a request or a binding read ran
   * after a restart (SL-17).
   */
  const signsNext = async (providerID: string, sessionID: string): Promise<Account.ID | null> => {
    const own = slot(providerID)
    if (own) return own.account.id
    if (providerID === Provider.ID.claudeAgent) return (await peers().claudeAgent.accountOf(sessionID)) ?? null
    if (providerID !== Provider.ID.anthropic || !peers().plugins.claudeSlot().detected) return null
    return peers().claude.accountOf(sessionID)
  }

  /** session → the Claude Agent account of its latest request in this process (CAG-53, idle compaction's `moved`). */
  const agentSigned = new Map<string, string>()

  /** `<accountID>|<source>` pairs this instance logged a first observation of (`limits_observed`). */
  const observedOnce = new Set<string>()
  /** Sign in with ChatGPT accounts this instance logged a plan-less answer of (`limits_absent`). */
  const planless = new Set<string>()
  /** Sign in with ChatGPT accounts this instance logged a usage-limit answer of (`usage_limit_answer`). */
  const limitAnswered = new Set<string>()

  /** Windows and a ChatGPT account's reset credit count (02 §7.1.1) into the runtime store; changes go out. */
  const publish = (windows: ReadonlyArray<Limit.Window>, credits?: Limit.ResetCredits) => {
    const counted = credits !== undefined && runtime.limits.upsertCredits(credits)
    if (windows.length === 0) {
      if (counted) runtime.broadcast.emit("limits.updated", { windows: [], resetCredits: [credits] })
      return
    }
    // One info line per account and source and instance: the service log then says which path brought an account's
    // limits (the 2026-10-18 report of Codex limits never shown could not be told apart from the log).
    for (const window of windows) {
      const key = `${window.accountID}|${window.source}`
      if (observedOnce.has(key)) continue
      observedOnce.add(key)
      log.info("limits_observed", {
        accountID: window.accountID,
        providerID: window.providerID,
        source: window.source,
        windows: windows.filter((item) => item.accountID === window.accountID).map((item) => item.id),
      })
    }
    const changed = runtime.limits.upsert(windows)
    if (changed.length > 0 || counted)
      runtime.broadcast.emit("limits.updated", { windows: changed, ...(counted ? { resetCredits: [credits] } : {}) })
  }

  const isLocalSession = (sessionID: string) => {
    const directory = locations.get(sessionID) ?? sessions.get(sessionID)?.directory
    return directory === deps.location.directory
  }

  // -------------------------------------------------------------------------------------------------------------
  // Alerts

  const raise = (input: AlertInput) => {
    const now = deps.clock.now()
    const key = [
      input.code,
      input.sessionID ?? "",
      input.accountID ?? "",
      input.directory ?? "",
      input.subject ?? "",
    ].join("|")
    const last = alerted.get(key)
    if (last !== undefined && now - last < ALERT_DEDUPE_MS) return
    alerted.set(key, now)
    const sessionID =
      input.sessionID === undefined ? undefined : Option.getOrUndefined(decodeSessionID(input.sessionID))
    const accountID =
      input.accountID === undefined ? undefined : Option.getOrUndefined(decodeAccountID(input.accountID))
    const body = {
      code: input.code,
      severity: input.severity,
      message: input.message,
      ...(sessionID === undefined ? {} : { sessionID }),
      ...(accountID === undefined ? {} : { accountID }),
      ...(input.directory === undefined ? {} : { directory: input.directory }),
    }
    void runtime.ledger
      .event({
        eid: `alert_${OwnID.ulid(now)}`,
        ts: now,
        type: "alert",
        accountID: input.accountID ?? null,
        sessionID: input.sessionID ?? null,
        data: {
          code: input.code,
          severity: input.severity,
          message: input.message,
          directory: input.directory ?? null,
          ...(input.fields === undefined ? {} : { fields: input.fields }),
        },
      })
      .catch((error: unknown) => log.warn("alert_record_failed", { code: input.code, error }))
    log.info("alert", {
      ...input.fields,
      code: input.code,
      severity: input.severity,
      sessionID: input.sessionID,
      accountID: input.accountID,
    })
    if (sessionID !== undefined) return void deps.emitter.session("alert", body)
    void deps.emitter.global("alert", body)
  }

  const alert = (input: AlertInput) => {
    if (input.sessionID !== undefined || runtime.isLeader()) return raise(input)
    // Global alert raised in a non-leader instance: the leader emits it (02 §9.1).
    runtime.broadcast.emit("alert", input)
  }

  /** An alert relayed through the runtime (own-telemetry, or a non-leader instance). */
  const relayed = (input: AlertInput) => {
    if (input.sessionID === undefined) return runtime.isLeader() ? raise(input) : undefined
    const sessionID = input.sessionID
    if (locations.has(sessionID)) return isLocalSession(sessionID) ? raise(input) : undefined
    once(RELAY_WAIT_MS, () => {
      if (locations.has(sessionID)) return isLocalSession(sessionID) ? raise(input) : undefined
      if (runtime.isLeader()) raise(input)
    })
  }

  // -------------------------------------------------------------------------------------------------------------
  // KV helpers (own-accounts namespace)

  const kvGet = async <A>(key: string, decode: (value: unknown) => Option.Option<A>) => {
    const value = await deps.ctx.storage.get(key)
    return value === undefined ? undefined : Option.getOrUndefined(decode(value))
  }

  const kvScan = async (prefix: string) => {
    const entries: Array<{ readonly key: string; readonly value: unknown }> = []
    const page = async (after?: string): Promise<void> => {
      const result = await deps.ctx.storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: 200 })
      entries.push(...result.entries)
      if (result.next !== undefined && result.entries.length > 0) return page(result.next)
    }
    await page()
    return entries
  }

  const compactionEpoch = async (sessionID: string, session: Memory) => {
    if (session.compactionEpoch !== undefined) return session.compactionEpoch
    session.compactionEpoch = (await kvGet(Kv.epoch(sessionID), decodeEpoch)) ?? 0
    return session.compactionEpoch
  }

  const switchEpoch = async (sessionID: string, session: Memory) => {
    if (session.switchEpoch !== undefined) return session.switchEpoch
    const last = (await book.session(sessionID)).at(-1)?.line.switchEpoch ?? 0
    session.switchEpoch = last + session.pendingSwitches
    session.pendingSwitches = 0
    return session.switchEpoch
  }

  // -------------------------------------------------------------------------------------------------------------
  // Rates and TTLs

  const kindOf = (providerID: string) => slot(providerID)?.kind

  const catalogCost = (info: Slots.SlotInfo, modelID: string): Rates.CatalogCost | undefined => {
    // 02 §3.3a: a local model costs nothing, whatever rates its models still carry.
    if (Account.isLocal(info.account)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const model = peers().slots.model(info.providerID, modelID)
    const cost = model?.cost.find((item) => item.tier === undefined)
    if (!cost) return undefined
    return { input: cost.input, output: cost.output, cacheRead: cost.cache.read, cacheWrite: cost.cache.write }
  }

  /**
   * Rates for a request made at `at`: outside a card's peak windows every rate is multiplied by `offPeakMul` (02 §6.2).
   * `timed` = the card has peak windows.
   */
  const ratesOf = (providerID: string, modelID: string, at: number) => {
    const info = slot(providerID)
    const card = info ? Rates.match(state.cards, info.kind, modelID) : undefined
    if (!info || !card) return undefined
    const rates = Rates.resolve(card, catalogCost(info, modelID))
    const factor = Ratecard.multiplier(card, at)
    const price = (rate: number | undefined) => (rate === undefined ? undefined : rate * factor)
    return {
      timed: card.peak !== undefined,
      rates: {
        unit: rates.unit,
        input: price(rates.input),
        read: price(rates.read),
        write: price(rates.write),
        output: price(rates.output),
      },
    }
  }

  const ttlOf = (providerID: string, modelID: string, mode: Cache.TtlMode | undefined, accountID?: string | null) => {
    const kind = kindOf(providerID)
    if (kind) return Rates.ttl(Rates.ttlCard(state.cards, kind, modelID), mode)
    if (providerID === Provider.ID.anthropic) return Rates.claudeTtl(mode)
    // Claude Code keeps one-hour entries on a plan, five minutes on an API key (02 §8.10.5), per account (CAG-53).
    if (peers().claudeAgent.member(providerID)) return Rates.claudeTtl(peers().claudeAgent.ttl(accountID ?? undefined))
    return undefined
  }

  /**
   * 02 §7.5 "비용": codex credits from the rate card; API USD from core, else the rate card, except that a card with
   * peak windows (ds) wins over core, whose catalog price has no time of day; others core USD. Rates are those at
   * `at`, the request time.
   */
  const costOf = (input: {
    readonly providerID: string
    readonly modelID: string
    readonly tokens: Tokens | null
    readonly costUSD: number | null
    readonly P: number | null
    readonly at: number
  }): Ledger.Cost | null => {
    const info = slot(input.providerID)
    const priced = ratesOf(input.providerID, input.modelID, input.at)
    const rates = priced?.rates
    if (input.tokens === null) {
      const amount = rates && input.P !== null ? Rates.estimate(rates, input.P) : undefined
      return rates && amount !== undefined ? { unit: rates.unit, amount, source: "estimate" } : null
    }
    // Plan-billed ChatGPT logins (codex, siwc) cost rate-card credits, never a catalog USD price.
    if (info && Kind.isOAuth(info.kind)) {
      const amount = rates ? Rates.cost(rates, input.tokens) : undefined
      return rates && amount !== undefined ? { unit: rates.unit, amount, source: "ratecard" } : null
    }
    if (!priced?.timed && input.costUSD !== null && input.costUSD > 0)
      return { unit: "USD", amount: input.costUSD, source: "opencode" }
    const amount = rates ? Rates.cost(rates, input.tokens) : undefined
    if (rates && amount !== undefined && rates.unit === "USD") return { unit: "USD", amount, source: "ratecard" }
    return input.costUSD === null ? null : { unit: "USD", amount: input.costUSD, source: "opencode" }
  }

  /**
   * 02 §4.8: the cost of a step sent at a speed tier. The tier billed is the one sent unless the response named a slower
   * one (a silent downgrade bills Standard, `undefined` here). Plan kinds (`codex`, `siwc`) multiply the rate-card
   * credits by the tier's `credits` multiple; API kinds and the Claude subscription slot price the tokens at the
   * catalog's mode price (the slot's fast usage is billed to usage credits, while claude-auth registers every cost as 0).
   */
  const speedCost = async (input: {
    readonly model: Model.Ref
    readonly tokens: Tokens | null
    readonly speed: Ledger.Line["speed"]
    readonly base: Ledger.Cost | null
  }): Promise<Ledger.Cost | null | undefined> => {
    const speed = input.speed
    if (!speed || !input.tokens) return undefined
    const tier = speed.served === null ? speed.requested : Speed.choiceOf({ id: speed.served }) && speed.served
    if (!tier) return undefined
    const info = slot(input.model.providerID)
    if (info && Kind.isOAuth(info.kind)) {
      const multiple = await peers().speed.credits(input.model.providerID, input.model.id, tier)
      if (multiple === undefined || !input.base) return input.base
      return { ...input.base, amount: input.base.amount * multiple }
    }
    const price = await peers().speed.price(input.model.providerID, input.model.id, tier)
    if (!price) return undefined
    const amount = Rates.cost(
      {
        unit: "USD",
        input: price.input,
        output: price.output,
        ...(price.cacheRead === undefined ? {} : { read: price.cacheRead }),
        ...(price.cacheWrite === undefined ? {} : { write: price.cacheWrite }),
      },
      input.tokens,
    )
    return amount === undefined ? undefined : { unit: "USD", amount, source: "ratecard" }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Ledger lines

  const buildLine = async (input: {
    readonly sessionID: Ledger.Line["sessionID"]
    readonly session: Memory
    readonly ts: number
    readonly kind: RequestKind
    readonly messageID: string | null
    readonly model: Model.Ref
    readonly tokens: Tokens | null
    readonly costUSD: number | null
    readonly P?: number | null
    /** Estimator prediction for the first step after a switch (primary lines only). */
    readonly coldExpected?: number | null
    readonly usageSource: Ledger.UsageSource
    /** When the request was sent, for time-of-day prices (02 §6.2); `ts` when unknown. */
    readonly requestedAt?: number
    /** The speed tier the request sent and the one served (02 §4.8). */
    readonly speed?: Ledger.Line["speed"]
  }): Promise<Ledger.Line> => {
    const info = slot(input.model.providerID)
    const P = input.tokens ? Totals.inputOf(input.tokens) : (input.P ?? null)
    const cost = costOf({
      providerID: input.model.providerID,
      modelID: input.model.id,
      tokens: input.tokens,
      costUSD: input.costUSD,
      P,
      at: input.requestedAt ?? input.ts,
    })
    const priced = await speedCost({ model: input.model, tokens: input.tokens, speed: input.speed, base: cost })
    return {
      v: 1,
      ts: input.ts,
      sessionID: input.sessionID,
      messageID: input.messageID,
      kind: input.kind,
      accountID: accountOf(input.model.providerID, input.sessionID),
      providerID: input.model.providerID,
      modelID: input.model.id,
      variant: input.model.variant ?? null,
      credentialRef: null,
      transport: info ? (info.slot.transport ?? (info.kind === "codex" ? "websocket" : "http")) : null,
      switchEpoch: await switchEpoch(input.sessionID, input.session),
      compactionEpoch: await compactionEpoch(input.sessionID, input.session),
      tokens: input.tokens,
      P,
      hit: input.tokens && P !== null && P > 0 ? input.tokens.cacheRead / P : null,
      cost: priced === undefined ? cost : priced,
      costUSDOpenCode: input.costUSD,
      coldExpected: input.coldExpected ?? null,
      usageSource: input.usageSource,
      ...(input.speed ? { speed: input.speed } : {}),
    }
  }

  /** Writes one line once per `eid` and tells every instance (`ledger.line`). */
  const commit = async (eid: string, line: Ledger.Line) => {
    const outcome = await runtime.ledger.usage(eid, line)
    if (outcome === "duplicate") return false
    written.add(eid)
    runtime.broadcast.emit("ledger.line", { eid, line })
    return true
  }

  /**
   * Cache state, alert history and exhaustion clearance after a line with tokens (02 §2.4.6, §7.7). `requestedAt` is
   * when the request started: a cache's lifetime counts from there, not from the end of the reply (CC 2026-10-24).
   */
  const afterLine = async (session: Memory, line: Ledger.Line, tokens: Tokens, requestedAt = line.ts) => {
    const sessionID = line.sessionID
    // The Claude Agent account that ran the session's latest request: a later move makes its cache another account's.
    if (line.providerID === Provider.ID.claudeAgent && line.accountID) agentSigned.set(sessionID, line.accountID)
    const prefix = `${Kv.sessionPrefix(sessionID)}cache:`
    // SL-8: a Claude account's entry is its own (each account has its own cache); every other slot is one account.
    const account = Cache.keyAccount(line.providerID, line.accountID)
    const key = Kv.cache(sessionID, line.providerID, account)
    const previous = await CacheState.read((at) => deps.ctx.storage.get(at), sessionID, line.providerID, line.accountID)
    // An entry written before per-account keys that this account's entry now replaces.
    const legacy = Kv.cache(sessionID, line.providerID)
    if (account !== undefined && CacheState.legacyOf(await kvGet(legacy, decodeEntry), account))
      await deps.ctx.storage.remove(legacy)
    const P = Totals.inputOf(tokens)
    await deps.ctx.storage.set(
      key,
      toJson(
        CacheState.afterStep(previous, {
          at: requestedAt,
          P,
          epoch: line.compactionEpoch,
          modelID: line.modelID,
          variant: line.variant,
          // A compaction line names its compaction message (SL), which is no breakpoint of a later request.
          messageID: line.kind === "primary" ? line.messageID : null,
          accountID: line.accountID,
        }),
      ),
    )
    if (line.kind === "primary")
      for (const entry of await kvScan(prefix)) {
        if (entry.key === key) continue
        const other = Option.getOrUndefined(decodeEntry(entry.value))
        if (other) await deps.ctx.storage.set(entry.key, toJson(CacheState.aged(other)))
      }
    // The step's own time: a line its session queue writes late never clears an exhaustion recorded after the step.
    if (line.accountID && runtime.limits.exhaustion(line.accountID, line.modelID))
      runtime.limits.clearExhaustion(line.accountID, line.ts, line.modelID)
    if (line.accountID) authFailures.delete(line.accountID)
    if (line.accountID) unaffordable.delete(line.accountID)
    if (line.accountID) backoff.delete(line.accountID)
    if (line.kind === "primary") judge(session, line, tokens, previous)
  }

  const judge = (session: Memory, line: Ledger.Line, tokens: Tokens, previous: Cache.Entry | undefined) => {
    const first = session.lastProvider !== line.providerID || session.lastEpoch !== line.compactionEpoch
    session.lastProvider = line.providerID
    session.lastEpoch = line.compactionEpoch
    const step: Alerts.Step = {
      ts: line.ts,
      providerID: line.providerID,
      P: Totals.inputOf(tokens),
      cacheRead: tokens.cacheRead,
      cold: tokens.input + tokens.cacheWrite,
      first,
    }
    session.history = [...session.history.filter((item) => item.ts >= line.ts - 3_600_000), step].slice(-50)
    const subject = { sessionID: line.sessionID, ...(line.accountID ? { accountID: line.accountID } : {}) }
    const low = Alerts.lowHit(session.history)
    if (low !== undefined)
      alert({
        ...subject,
        code: "low_hit",
        severity: "warning",
        message: `캐시 적중률이 낮습니다(최근 ${Alerts.LOW_HIT.steps} step ${percent(low)}). hook 결정성과 헤더를 점검하세요.`,
      })
    const ttl = ttlOf(line.providerID, line.modelID, undefined, line.accountID)
    const expected = Alerts.returnMiss({
      previous,
      step,
      epoch: line.compactionEpoch,
      modelID: line.modelID,
      variant: line.variant,
      ttlLoMs: ttl?.lo ?? 0,
    })
    if (expected !== undefined)
      alert({
        ...subject,
        code: "return_miss",
        severity: "warning",
        message: `캐시가 살아 있을 시간 안에 돌아왔지만 적중률이 ${percent(step.cacheRead / step.P)}입니다(기대 ${percent(expected)}). lookback, compaction, variant를 점검하세요.`,
      })
    const factor = runtime.policy.cached()?.hysteresis.coldSumFactor ?? 3
    const cold = Alerts.prefixDrift(session.history, line.ts, factor)
    if (cold !== undefined)
      alert({
        ...subject,
        code: "prefix_drift",
        severity: "warning",
        message: `최근 15분 동안 캐시되지 않은 입력이 ${cold} 토큰으로 현재 입력의 ${factor}배를 넘었습니다. prefix 변동이 의심됩니다.`,
      })
  }

  const emitCacheState = async (sessionID: Ledger.Line["sessionID"], session: Memory) => {
    const snapshot = await cacheSnapshot(sessionID, session)
    void deps.emitter.session("cache.state", snapshot)
    session.boundary?.()
    const next = CacheState.nextBoundary(snapshot.slots, snapshot.now)
    session.boundary =
      next === undefined
        ? undefined
        : once(next - snapshot.now + 1, () => {
            session.boundary = undefined
            enqueue(sessionID, () => emitCacheState(sessionID, session))
          })
  }

  const cacheSnapshot = async (sessionID: Ledger.Line["sessionID"], session: Memory): Promise<Cache.Snapshot> => {
    const now = deps.clock.now()
    const prefix = `${Kv.sessionPrefix(sessionID)}cache:`
    const epoch = await compactionEpoch(sessionID, session)
    const entries = (await kvScan(prefix)).flatMap((item) => {
      const entry = Option.getOrUndefined(decodeEntry(item.value))
      const slot = Kv.cacheSlot(item.key.slice(prefix.length))
      const accountID = slot.accountID ?? entry?.accountID ?? undefined
      return entry ? [{ providerID: Provider.ID.make(slot.providerID), accountID, entry }] : []
    })
    // The session is on a slot, and of `anthropic` on the Claude account its tree runs on (SL-8): another account's
    // entry is another slot, whatever the session's model now.
    const signer = session.model ? await signsNext(session.model.providerID, sessionID) : null
    const slots = await Promise.all(
      entries.map(async (item): Promise<Cache.Slot> => {
        const mode = await kvGet(Kv.ttlMode(sessionID, item.providerID), decodeTtlMode)
        const current =
          session.model?.providerID === item.providerID &&
          (Cache.keyAccount(item.providerID, item.accountID) === undefined || item.accountID === signer)
            ? { modelID: session.model.id, variant: session.model.variant ?? null }
            : undefined
        const temperature = CacheState.temperature({
          entry: item.entry,
          ttl: ttlOf(item.providerID, item.entry.modelID, mode, item.accountID),
          now,
          epoch,
          ...(current ? { current } : {}),
        })
        return {
          providerID: item.providerID,
          state: temperature.state,
          L: item.entry.L,
          lastReqAt: item.entry.lastReqAt,
          warmUntil: temperature.state === "warm" ? temperature.warmUntil : null,
          coldAfter: temperature.state === "cold" ? null : temperature.coldAfter,
          epoch: item.entry.epoch,
          blocksSince: item.entry.blocksSince,
          ...(mode === undefined ? {} : { ttlMode: mode }),
          ...(item.accountID ? { accountID: Account.ID.make(item.accountID) } : {}),
        }
      }),
    )
    const compaction = await peers()
      .switching.compactionView(sessionID)
      .catch((error: unknown) => {
        log.warn("compaction_view_failed", { sessionID, error })
        return null
      })
    return { sessionID, now, slots: slots.toSorted((a, b) => b.lastReqAt - a.lastReqAt), compaction }
  }

  /**
   * A committed revert (02 §4.7.4): one more cold point (the epoch only grows, so the estimator sees "changed") and
   * every slot's cache state re-baselined; the next step measures it again.
   */
  const onRevertCommitted = async (sessionID: Ledger.Line["sessionID"], to: string) => {
    const session = memory(sessionID)
    const epoch = (await compactionEpoch(sessionID, session)) + 1
    session.compactionEpoch = epoch
    await deps.ctx.storage.set(Kv.epoch(sessionID), epoch)
    const prefix = `${Kv.sessionPrefix(sessionID)}cache:`
    for (const entry of await kvScan(prefix)) {
      const current = Option.getOrUndefined(decodeEntry(entry.value))
      if (current) await deps.ctx.storage.set(entry.key, toJson(CacheState.reverted(current, to)))
    }
    await emitCacheState(sessionID, session)
  }

  /**
   * A context reset delivered or undone (11 §7, 02 §4.7.4): a cold point like a committed revert, every slot's cache
   * state re-baselined; the next step measures the new size.
   */
  const onReset = async (sessionID: Ledger.Line["sessionID"], kind: Resets.ColdPoint["kind"]) => {
    const session = memory(sessionID)
    const epoch = (await compactionEpoch(sessionID, session)) + 1
    session.compactionEpoch = epoch
    await deps.ctx.storage.set(Kv.epoch(sessionID), epoch)
    const prefix = `${Kv.sessionPrefix(sessionID)}cache:`
    for (const entry of await kvScan(prefix)) {
      const current = Option.getOrUndefined(decodeEntry(entry.value))
      if (current) await deps.ctx.storage.set(entry.key, toJson(CacheState.cleared(current)))
    }
    log.info("context_reset", { sessionID, kind, epoch })
    await emitCacheState(sessionID, session)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Event stream (02 §7.5 correlation)

  const onStepEnd = async (input: {
    readonly eid: string
    readonly ts: number
    readonly sessionID: Ledger.Line["sessionID"]
    readonly messageID: string
    readonly tokens:
      | {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
      | undefined
    readonly cost: number | undefined
    readonly coldExpected: number | null
    readonly finish: FinishReason | undefined
  }) => {
    const session = memory(input.sessionID)
    const step = session.steps.get(input.messageID)
    session.steps.delete(input.messageID)
    const model = step?.model ?? session.model ?? session.requests.get("primary")?.model
    if (!model || !input.tokens) return
    const tokens = tokensOf(input.tokens)
    const speed = peers().speed.step({
      sessionID: input.sessionID,
      providerID: model.providerID,
      endedAt: input.ts,
      tokens,
    })
    const line = await buildLine({
      sessionID: input.sessionID,
      session,
      ts: input.ts,
      kind: "primary",
      messageID: input.messageID,
      model,
      tokens,
      costUSD: input.cost ?? null,
      coldExpected: input.coldExpected,
      usageSource: "event",
      requestedAt: step?.started,
      ...(speed ? { speed } : {}),
    })
    if (!(await commit(input.eid, line))) return
    if (input.finish !== undefined) judgeOutcome(input.sessionID, model, input.finish, tokens)
    await afterLine(session, line, tokens, step?.started ?? input.ts)
    await emitCacheState(input.sessionID, session)
  }

  /**
   * P2-16: an own slot's answer cut at the output limit (`length`) or empty (`stop` with no visible output) is raised as
   * a session info alert, once per session and code within {@link ALERT_DEDUPE_MS}. Since upstream v2.0.32
   * (a3f7f42ac9) core continues a `length` step by itself and fails the turn with `output-limit` only when three
   * answers in a row were cut; an empty answer still ends the turn without an error. Only step events reach this;
   * compaction and generate never do.
   */
  const judgeOutcome = (sessionID: string, model: Model.Ref, finish: FinishReason, tokens: Tokens) => {
    if (!slot(model.providerID)) return
    const name = `${model.providerID}/${model.id}`
    const fields = { providerID: model.providerID, modelID: model.id, finish }
    if (finish === "length")
      return alert({
        code: "output_truncated",
        severity: "info",
        sessionID,
        fields,
        message: `${name}의 답이 출력 한도에서 잘렸습니다(finish length). core가 이어서 쓰게 하고, 세 번 연달아 잘리면 턴이 output-limit 오류로 끝납니다.`,
      })
    // All-zero usage means the provider reported none, not an empty answer: a request always has input.
    if (finish === "stop" && tokens.output === 0 && Totals.inputOf(tokens) > 0)
      alert({
        code: "empty_completion",
        severity: "info",
        sessionID,
        fields,
        message: `${name}이(가) 보이는 출력 없이 답을 끝냈습니다(finish stop, 출력 0 토큰). 턴이 답 없이 끝났을 수 있습니다.`,
      })
  }

  const onCompaction = async (input: {
    readonly eid: string
    readonly ts: number
    readonly sessionID: Ledger.Line["sessionID"]
    /** The compaction message the line belongs to (SL 2026-10-26): the UI names the account that signed it. */
    readonly messageID: string | null
    readonly model: Model.Ref | undefined
    readonly tokens: Parameters<typeof tokensOf>[0] | undefined
    readonly cost: number | undefined
    readonly ended: boolean
    /** The checkpoint's metadata: the request it came from (P-034) and an idle trigger. */
    readonly metadata: Readonly<Record<string, unknown>> | undefined
  }) => {
    const session = memory(input.sessionID)
    const requested = session.requests.get("compaction")
    const model = input.model ?? requested?.model ?? session.model
    const sent = session.compactionSent
    session.compactionSent = undefined
    if (model && input.tokens) {
      const tokens = tokensOf(input.tokens)
      const speed = peers().speed.step({
        sessionID: input.sessionID,
        providerID: model.providerID,
        endedAt: input.ts,
        tokens,
      })
      const line = await buildLine({
        sessionID: input.sessionID,
        session,
        ts: input.ts,
        kind: "compaction",
        messageID: input.messageID,
        model,
        tokens,
        costUSD: input.cost ?? null,
        usageSource: "event",
        ...(speed ? { speed } : {}),
      })
      const request = CompactionCache.sentOf(input.metadata)
      const written = request === undefined ? line : { ...line, compaction: request }
      // The cache entry is the request sent last (a failed full request's fallback): its start and, when the stream
      // showed it, its own size rather than the sum.
      const last = sent?.tokens === undefined ? undefined : await sent.tokens
      if (await commit(input.eid, written))
        await afterLine(session, written, last ?? tokens, sent?.at ?? requested?.at ?? input.ts)
    }
    if (!input.ended) return
    // A compaction is a cold point for every slot of the session (02 §4.7.5, §2.4.6 `epoch`).
    const epoch = (await compactionEpoch(input.sessionID, session)) + 1
    session.compactionEpoch = epoch
    await deps.ctx.storage.set(Kv.epoch(input.sessionID), epoch)
    await emitCacheState(input.sessionID, session)
  }

  const onSelected = (sessionID: string, session: Memory, at: number, model: Model.Ref, previous?: Model.Ref) => {
    const changed =
      previous !== undefined &&
      (previous.providerID !== model.providerID || previous.id !== model.id || previous.variant !== model.variant)
    session.model = model
    if (changed && session.switchEpoch !== undefined) session.switchEpoch += 1
    if (changed && session.switchEpoch === undefined) session.pendingSwitches += 1
    // A session created on A has no selection of A: its first switch names A as `previous`, so A → B → A counts.
    const last = session.selections.at(-1)
    const seed =
      previous !== undefined && last?.providerID !== previous.providerID
        ? [{ at, providerID: previous.providerID }]
        : []
    session.selections = [...session.selections, ...seed, { at, providerID: model.providerID }].slice(-10)
    const windowMs = (runtime.policy.cached()?.hysteresis.breakerFlapMinutes ?? 10) * 60_000
    if (Alerts.flap(session.selections, windowMs))
      alert({
        code: "flap",
        severity: "warning",
        sessionID,
        message: `${Math.round(windowMs / 60_000)}분 안에 같은 계정으로 되돌아왔습니다(${previous?.providerID ?? "?"} → ${model.providerID}). 전환이 반복되고 있습니다.`,
      })
  }

  const onEvent = (event: Module.OpenCodeEvent, meta: Module.EventMeta) => {
    const raw = sessionIdOf(event)
    const sessionID = raw === undefined ? undefined : Option.getOrUndefined(decodeSessionID(raw))
    if (sessionID === undefined) return
    const directory = "location" in event ? event.location?.directory : undefined
    if (directory !== undefined) remember(sessionID, directory)
    if (event.type === "session.created") bounded(projects, sessionID, event.data.projectID)
    if (event.type === "session.deleted") {
      sessions.get(sessionID)?.boundary?.()
      sessions.delete(sessionID)
      return
    }
    if (!meta.local) return
    const session = memory(sessionID)
    if (directory !== undefined) session.directory = directory
    if (event.type === "session.created") session.projectID = event.data.projectID
    if (event.type === "session.model.selected") {
      const at = event.created
      const model = refOf(event.data.model)
      const previous = event.data.previous === undefined ? undefined : refOf(event.data.previous)
      // Queued like the steps, so a line built for an earlier step never sees a later switch.
      enqueue(sessionID, async () => onSelected(sessionID, session, at, model, previous))
    }
    if (event.type === "session.step.started") {
      const model = refOf(event.data.model)
      session.steps.set(event.data.assistantMessageID, { model, started: event.data.started })
      session.started.set(event.data.assistantMessageID, { model, started: event.data.started })
      const oldest = session.started.size > STARTED_KEPT ? session.started.keys().next().value : undefined
      if (oldest !== undefined) session.started.delete(oldest)
      session.model ??= model
    }
    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      const input = {
        eid: event.id,
        ts: event.created,
        sessionID,
        messageID: event.data.assistantMessageID,
        tokens: event.data.tokens,
        cost: event.data.cost,
        // Read now, before switching (later in the event order) settles the switch this step completes.
        coldExpected: coldExpectedOf(sessionID, session, event.data.assistantMessageID),
        finish: event.data.finish,
      }
      enqueue(sessionID, () => onStepEnd(input))
    }
    if (event.type === "session.revert.committed") {
      const to = event.data.to
      enqueue(sessionID, () => onRevertCommitted(sessionID, to))
    }
    const reset = meta.reset
    if (reset !== undefined) enqueue(sessionID, () => onReset(sessionID, reset.kind))
    // Core's id of the compaction message: the running one's, else the failed event's `inputID`, else the event's own.
    if (event.type === "session.compaction.started")
      session.compactionMessage = event.data.inputID ?? messageOfEvent(event.id)
    if (event.type === "session.compaction.ended" || event.type === "session.compaction.failed") {
      const data = event.data
      const messageID =
        session.compactionMessage ?? ("inputID" in data ? data.inputID : undefined) ?? messageOfEvent(event.id)
      session.compactionMessage = undefined
      const input = {
        eid: event.id,
        ts: event.created,
        sessionID,
        messageID,
        model: "model" in data && data.model !== undefined ? refOf(data.model) : undefined,
        tokens: data.tokens,
        cost: data.cost,
        ended: event.type === "session.compaction.ended",
        metadata: "metadata" in event ? record(event.metadata) : undefined,
      }
      enqueue(sessionID, () => onCompaction(input))
    }
  }

  /** Times of generate/title lines written without stream usage, last hour only. */
  const usageMissing: number[] = []

  const coldExpectedOf = (sessionID: string, session: Memory, messageID: string) => {
    const providerID = (session.steps.get(messageID)?.model ?? session.model)?.providerID
    return providerID === undefined ? null : peers().switching.coldExpected(sessionID, providerID)
  }

  const remember = (sessionID: string, directory: string) => {
    if (locations.get(sessionID) !== directory) bounded(locations, sessionID, directory)
  }

  const bounded = (map: Map<string, string>, key: string, value: string) => {
    map.set(key, value)
    if (map.size <= 20_000) return
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Hooks

  const onHttpResponse = async (event: SessionHttpResponse) => {
    const info = slot(event.model.providerID)
    if (!info) return
    const now = deps.clock.now()
    const response = event.response
    const status = response.status
    const bodyHead = status >= 400 ? await head(response.clone()) : null
    runtime.lastResponse.record(event.sessionID, {
      providerID: event.model.providerID,
      status,
      headers: response.headers,
      bodyHead,
      authHash8: Hash.auth(event.request.headers)[0]?.hash ?? null,
      at: now,
    })
    const windows = Windows.fromResponse(
      info.kind,
      response.headers,
      { accountID: info.account.id, providerID: event.model.providerID },
      { observedAt: now, source: status >= 400 ? "error" : "header" },
    )
    publish(windows)
    // 02 §7.1: the token-sharing route has answered without plan headers so far (open item 48), and nothing else may
    // ask for a siwc plan's use. One line per account and instance names the answer's headers (names only, never
    // values), so the log shows what the route sends if that ever changes.
    if (
      info.kind === "siwc" &&
      status < 400 &&
      event.kind === "primary" &&
      !windows.some((window) => window.id.startsWith("codex.")) &&
      !planless.has(info.account.id)
    ) {
      planless.add(info.account.id)
      log.info("limits_absent", {
        accountID: info.account.id,
        providerID: event.model.providerID,
        headers: [...response.headers.keys()].sort(),
      })
    }
    // 02 §3.2c: a usage limit whose body says when it resets is a full `siwc.usage` window, unless the answer's plan
    // headers already show the full window. The first one per account and instance logs the header and body field
    // names (never values), so the next build can tell what the route sends.
    if (
      info.kind === "siwc" &&
      bodyHead !== null &&
      Classify.sharingCode(bodyHead) === "subscription_sharing_usage_limit_exceeded"
    ) {
      const json = Option.getOrUndefined(decodeJson(bodyHead))
      const full = windows.some((window) => window.id.startsWith("codex.") && window.status === "exhausted")
      const limit = full
        ? []
        : Windows.sharingLimit(
            json,
            { accountID: info.account.id, providerID: event.model.providerID },
            { observedAt: now, source: "error" },
          )
      publish(limit)
      if (!limitAnswered.has(info.account.id)) {
        limitAnswered.add(info.account.id)
        const body = record(json)
        log.info("usage_limit_answer", {
          accountID: info.account.id,
          providerID: event.model.providerID,
          status,
          headers: [...response.headers.keys()].sort(),
          fields: [
            ...Object.keys(body ?? {}),
            ...Object.keys(record(body?.error) ?? {}).map((key) => `error.${key}`),
          ].sort(),
          reset: limit.length > 0,
        })
      }
    }
    if (status >= 400) return
    // A success while a usage limit's own window still says full: the limit no longer blocks, so it reset by now.
    const lifted =
      info.kind === "siwc"
        ? runtime.limits
            .list({ accountID: info.account.id })
            .find((window) => window.id === Windows.SHARING_LIMIT_ID && window.status === "exhausted")
        : undefined
    if (lifted) publish([{ ...lifted, resetAt: now }])
    authFailures.delete(info.account.id)
    if (runtime.limits.exhaustion(info.account.id)) runtime.limits.clearExhaustion(info.account.id)
    relay.succeeded(info.account.id)
    // RS: a connection test's 401 left `인증 실패` on the card while requests work again.
    if (peers().slots.account(info.account.id)?.status === "auth_failed") void peers().logins.accepted(info.account)
    // A side question's line comes from core's own usage (`recordSide`), not from the stream.
    if ((event.kind === "generate" && !event.side) || event.kind === "title")
      streamUsage(event, info, response.clone(), now)
    // The compaction's own line sums all of its requests; its cache entry is the last one's (CC-12).
    const sent = event.kind === "compaction" ? memory(event.sessionID).compactionSent : undefined
    if (sent)
      sent.tokens = track(
        StreamUsage.read(response.clone(), AbortSignal.timeout(STREAM_TIMEOUT_MS)).catch(() => undefined),
      )
  }

  /** 02 §7.5 "core가 기록하지 않는 사용량": reads a clone of a generate/title stream in the background. */
  const streamUsage = (event: SessionHttpResponse, info: Slots.SlotInfo, clone: Response, at: number) => {
    const sessionID = event.sessionID
    const kind: RequestKind = event.kind === "title" ? "title" : "generate"
    void track(
      (async () => {
        const tokens = (await StreamUsage.read(clone, AbortSignal.timeout(STREAM_TIMEOUT_MS))) ?? null
        const session = memory(sessionID)
        const previous = await kvGet(Kv.cache(sessionID, event.model.providerID), decodeEntry)
        const line = await buildLine({
          sessionID,
          session,
          ts: at,
          kind,
          messageID: null,
          model: event.model,
          tokens,
          costUSD: null,
          P: tokens ? undefined : (previous?.L ?? null),
          // No usage in the stream: the line keeps the size estimate only.
          usageSource: tokens ? "stream" : "estimate",
        })
        if (!(await commit(`${kind}_${OwnID.ulid(at)}`, line))) return
        if (tokens) {
          await afterLine(session, line, tokens)
          return
        }
        log.debug("stream_usage_missing", { sessionID, providerID: info.providerID, kind })
        usageMissing.splice(0, usageMissing.length, ...usageMissing.filter((ts) => at - ts < 3_600_000), at)
        if (usageMissing.length > USAGE_MISSING_PER_HOUR)
          alert({
            code: "generate_usage_missing",
            severity: "info",
            message: "최근 1시간 동안 generate·title 요청의 사용량을 응답에서 읽지 못해 추정값으로 기록했습니다.",
          })
      })().catch((error: unknown) => log.warn("stream_usage_failed", { sessionID, error })),
    )
  }

  const onWsReceive = (event: SessionWebSocketReceive) => {
    const frame = event.frame
    if (!FRAME_FILTER.some((needle) => frame.includes(needle))) return
    const info = slot(event.model.providerID)
    if (!info) return
    const json = record(Option.getOrUndefined(decodeJson(frame)))
    if (!json || typeof json.type !== "string") return
    const now = deps.clock.now()
    const subject = { accountID: info.account.id, providerID: event.model.providerID }
    publish(Windows.codexFrame(json, subject, { observedAt: now, source: "ws_event" }))
    if (json.type === "codex.rate_limits") {
      runtime.lastResponse.record(event.sessionID, {
        providerID: event.model.providerID,
        status: null,
        frame: { type: json.type, rateLimits: json.rate_limits },
        at: now,
      })
      return
    }
    if (json.type !== "error" && json.type !== "response.failed") return
    const summary = frameSummary(json, now)
    runtime.lastResponse.record(event.sessionID, {
      providerID: event.model.providerID,
      status: summary.status ?? null,
      frame: summary,
      bodyHead: JSON.stringify(json.error ?? record(json.response)?.error ?? {}),
      at: now,
    })
  }

  const onRetry = async (event: SessionRetry): Promise<Verdict> => {
    const info = slot(event.model.providerID)
    if (!info) return { class: "unknown" }
    const accountID = info.account.id
    const now = deps.clock.now()
    const capture = runtime.lastResponse.get(event.sessionID)
    const result = Classify.classify({
      kind: info.kind,
      error: event.error,
      ...(capture && capture.providerID === event.model.providerID ? { capture } : {}),
      windows: runtime.limits.list({ accountID }),
      now,
    })
    // Token sharing codes that retrying cannot heal (usage limit, eligibility, unsupported feature, rejected login).
    if (result.stop) event.decision = { retry: false }
    if (result.class === "auth") return authVerdict(event, info, result, now)
    if (result.reason === "max_tokens_unaffordable") return unaffordableVerdict(event, info, now)
    if (result.class !== "hard") return { class: result.class, accountID }
    event.decision = { retry: false }
    const until = untilOf(accountID, result.resetAt, now)
    const affected = affectedAccounts(info, result.scope)
    for (const account of affected)
      exhaust(event.sessionID, account, { class: "hard", windowId: result.windowId, until, reason: result.reason })
    return { class: "hard", accountID, until }
  }

  /** First OpenRouter max_tokens 402: the account stays usable; again soon without a success: `hard`, 15 minutes. */
  const unaffordableVerdict = (event: SessionRetry, info: Slots.SlotInfo, now: number): Verdict => {
    const accountID = info.account.id
    const last = unaffordable.get(accountID)
    unaffordable.set(accountID, now)
    if (last === undefined || now - last > UNAFFORDABLE_REPEAT_MS) return { class: "unknown", accountID }
    event.decision = { retry: false }
    const until = now + BACKOFF_MINUTES[0] * 60_000
    exhaust(event.sessionID, info.account, { class: "hard", windowId: null, until, reason: "max_tokens_unaffordable" })
    return { class: "hard", accountID, until }
  }

  /**
   * First 401/403: refresh on next use (`logins.unauthorized`); again without a success: `auth` (02 §5.2 T-AUTH). A
   * rejected token-sharing login (`reauth`) is final at once: no refresh heals it (02 §3.2c).
   */
  const authVerdict = async (
    event: SessionRetry,
    info: Slots.SlotInfo,
    result: Classify.Result,
    now: number,
  ): Promise<Verdict> => {
    const accountID = info.account.id
    const count = (authFailures.get(accountID) ?? 0) + 1
    authFailures.set(accountID, count)
    if (result.reauth) await peers().logins.rejected(info.account, result.reason)
    if (!result.reauth) peers().logins.unauthorized(info.account)
    if (count < AUTH_REPEAT && !result.reauth) return { class: "transient", accountID }
    const until = untilOf(accountID, undefined, now)
    exhaust(event.sessionID, info.account, { class: "auth", windowId: null, until, reason: result.reason })
    // RS: the registry says so, so every view does (a rejected login is `needs_reauth` through `rejected` already).
    if (!result.reauth) await peers().logins.refused(info.account)
    if (info.account.credential?.type === "linked-codex-source")
      alert({
        code: "codex_source_stale",
        severity: "warning",
        accountID,
        message: `가져온 Codex 로그인(${info.account.label})의 토큰이 거부되었고 이전 앱이 아직 갱신하지 않았습니다. 이전 앱에서 다시 로그인하거나 갱신을 기다리세요.`,
      })
    return { class: "auth", accountID, until }
  }

  const affectedAccounts = (info: Slots.SlotInfo, scope: Classify.Scope) => {
    if (scope === "account") return [info.account]
    const accounts = peers()
      .slots.snapshot()
      .accounts.filter((account) => account.status !== "retired")
    if (scope === "quota_domain") {
      const same = accounts.filter((account) => account.quotaDomain === info.account.quotaDomain)
      return same.length > 0 ? same : [info.account]
    }
    const workspace = info.account.identity.workspaceId
    if (!workspace) return [info.account]
    const same = accounts.filter((account) => account.identity.workspaceId === workspace && account.kind === info.kind)
    return same.length > 0 ? same : [info.account]
  }

  /** `resetAt + 1–3 min` jitter, or the next 15/30/60 min backoff step when the reset is unknown (02 §5.2). */
  const untilOf = (accountID: string, resetAt: number | undefined, now: number) => {
    if (resetAt !== undefined && resetAt > now) return resetAt + 60_000 + Math.floor(Math.random() * 120_000)
    const level = backoff.get(accountID) ?? 0
    backoff.set(accountID, Math.min(level + 1, BACKOFF_MINUTES.length - 1))
    return now + BACKOFF_MINUTES[Math.min(level, BACKOFF_MINUTES.length - 1)] * 60_000
  }

  const exhaust = (
    sessionID: string,
    account: Account.Info,
    input: {
      readonly class: "hard" | "auth"
      readonly windowId: string | null
      readonly until: number
      readonly reason: string
    },
  ) => {
    const exhaustion: Limit.Exhaustion = {
      accountID: account.id,
      windowId: input.windowId,
      until: input.until,
      class: input.class,
      reason: input.reason,
    }
    runtime.limits.exhaust(exhaustion)
    void runtime.ledger
      .event({
        eid: `exh_${OwnID.ulid(deps.clock.now())}`,
        type: "exhaustion",
        accountID: account.id,
        providerID: account.providerID,
        sessionID,
        data: { class: input.class, windowId: input.windowId, until: input.until, reason: input.reason },
      })
      .catch((error: unknown) => log.warn("exhaustion_record_failed", { accountID: account.id, error }))
    log.info("exhausted", { accountID: account.id, class: input.class, reason: input.reason, until: input.until })
    runtime.broadcast.emit("exhausted", { exhaustion, providerID: account.providerID, sessionID })
  }

  const onModelRequest = (event: SessionModelRequest) => {
    const session = memory(event.sessionID)
    session.requests.set(event.kind, { model: event.model, at: deps.clock.now() })
    if (event.kind === "primary") session.model = event.model
  }

  /**
   * The session's last primary request in this process (its model and start), that slot's cache lifetime, and whether
   * the session's tree moved to another Claude account since (SL-8): the account that signed the session's latest
   * `anthropic` request (G4) is not the one its next request runs on, and that account has none of this cache.
   */
  const primaryCache = async (sessionID: string) => {
    const last = memory(sessionID).requests.get("primary")
    if (!last) return undefined
    const providerID = last.model.providerID
    const mode = await kvGet(Kv.ttlMode(sessionID, providerID), decodeTtlMode)
    const signed =
      providerID === Provider.ID.anthropic
        ? runtime.claude.lastOf(sessionID)
        : providerID === Provider.ID.claudeAgent
          ? agentSigned.get(sessionID)
          : undefined
    const next =
      signed === undefined
        ? null
        : providerID === Provider.ID.claudeAgent
          ? ((await peers().claudeAgent.accountOf(sessionID)) ?? null)
          : await claudeAccountOf(sessionID)
    return {
      model: last.model,
      providerID,
      kind: kindOf(providerID),
      startedAt: last.at,
      ttl: ttlOf(providerID, last.model.id, mode, signed),
      moved: next !== null && next !== signed,
    }
  }

  /** The Claude account the session's tree runs on while the Claude slot is present (its next request's), else none. */
  const claudeAccountOf = async (sessionID: string) =>
    peers().plugins.claudeSlot().detected ? await peers().claude.accountOf(sessionID) : null

  /**
   * The lookback in blocks of the Anthropic engine's breakpoint cache, `anth` and the Claude subscription (20 blocks):
   * the one cache where the whole history was measured to read more than the older part (live 2026-10-24).
   * `unmeasured`: OpenAI GPT-5.6+, whose card sets a breakpoint lookback too, keeps the older request until the full
   * request is measured there (CC-16). `null`: a cache that reads the longest cached prefix by itself.
   */
  const lookbackOf = (providerID: string, modelID: string): number | "unmeasured" | null => {
    const kind = kindOf(providerID)
    if (kind === undefined) return providerID === Provider.ID.anthropic ? CLAUDE_LOOKBACK : null
    if (kind !== "anth" && kind !== "oai") return null
    const card = Rates.ttlCard(state.cards, kind, modelID)?.lookback
    if (kind === "oai") return card ? "unmeasured" : null
    return card && "blocks" in card ? card.blocks : CLAUDE_LOOKBACK
  }

  /**
   * P-034 (CC 2026-10-24), the first run: whether a compaction may send the whole history, which reads the session's
   * cache. Only on the Anthropic engine's breakpoint cache ({@link lookbackOf}; elsewhere the older request already reads
   * the longest cached prefix, so the whole history only costs more, or it is not measured yet), and only while the last
   * primary request on the compaction's model
   * and variant started less than `TTL_lo` ago; a colder cache would write the whole history again instead of the older
   * part. The second run ({@link recentVerdict}) narrows it to the kept parts the older request would miss.
   */
  const prefixVerdict = async (event: {
    readonly sessionID: string
    readonly model: Model.Ref
  }): Promise<CompactionCache.CacheVerdict> => {
    const cache = await primaryCache(event.sessionID)
    const model = event.model
    if (!cache || !sameModel(cache.model, model)) return { prefix: "older", reason: "model" }
    const lookback = lookbackOf(model.providerID, model.id)
    if (lookback === null) return { prefix: "older", reason: "longest-prefix" }
    if (lookback === "unmeasured") return { prefix: "older", reason: "unmeasured" }
    const ageMs = Math.max(0, deps.clock.now() - cache.startedAt)
    // Right after a Claude account switch the compaction runs on the new account, whose cache is empty (SL-8).
    if (cache.moved) return { prefix: "older", reason: "account", ageMs }
    if (!cache.ttl || cache.ttl.lo <= 0) return { prefix: "older", reason: "no-ttl", ageMs }
    const warm = ageMs < cache.ttl.lo
    return { prefix: warm ? "full" : "older", reason: warm ? "warm" : "cold", ageMs, ttlMs: cache.ttl.lo }
  }

  /**
   * P-034's second run (CC-12, live 2026-10-24): the older request misses only when the kept part is longer than the
   * lookback, counted as Anthropic counts ({@link blockPositions}), and the entry it would read is stale. That
   * entry is the one written by the latest step whose request ended within the lookback after the older end; when it
   * started less than `TTL_lo` ago on this model, the older request reads it (`fresh`). A step this process did not see
   * start may be stale, so the whole history goes.
   */
  const recentVerdict = async (event: {
    readonly sessionID: string
    readonly model: Model.Ref
    readonly messages: ReadonlyArray<Message>
    readonly kept: { readonly messageID: string }
  }): Promise<CompactionCache.RecentReason | undefined> => {
    const limit = lookbackOf(event.model.providerID, event.model.id)
    const at = event.messages.findIndex((message) => message.id === event.kept.messageID)
    // Every other cache was refused on the first run; a kept start own-harness cannot find it declines itself.
    if (typeof limit !== "number" || at < 0) return undefined
    const recent = event.messages.slice(at)
    const before = blockPositions(recent)
    if ((before.at(-1) ?? 0) <= limit) return "short"
    const covering = recent.findLast((message, index) => message.role === "assistant" && (before[index] ?? 0) <= limit)
    const step = covering?.id === undefined ? undefined : memory(event.sessionID).started.get(covering.id)
    const mode = await kvGet(Kv.ttlMode(event.sessionID, event.model.providerID), decodeTtlMode)
    const ttl = ttlOf(event.model.providerID, event.model.id, mode)
    const fresh =
      step !== undefined &&
      ttl !== undefined &&
      sameModel(step.model, event.model) &&
      deps.clock.now() - step.started < ttl.lo
    return fresh ? "fresh" : undefined
  }

  /** P-034's verdicts: the same model and variant is the same cache. */
  const sameModel = (left: Model.Ref, right: Model.Ref) =>
    left.providerID === right.providerID && left.id === right.id && (left.variant ?? null) === (right.variant ?? null)

  /** The start of a compaction request actually sent: the last one of a compaction is its line's cache clock. */
  const onHttpRequest = (event: SessionHttpRequest) => {
    if (event.kind === "compaction") memory(event.sessionID).compactionSent = { at: deps.clock.now() }
  }

  // -------------------------------------------------------------------------------------------------------------
  // RPC

  /** The last budget refresh of this instance ({@link refreshBudgets} runs one at a time). */
  let budgetRuns = Promise.resolve()

  /**
   * The monthly budget windows (02 §7.3 `budget`: this month's ledger spend over `account.budget.monthlyUSD`) go into the
   * runtime store like every other window (LV 2026-10-25), so the account's state (`Views.summary`), `quota.updated` and
   * `quota.snapshot` all rank them: a 92 %-spent budget leads the card on both sides and stays after the next
   * `quota.updated`. The leader refreshes them at start, after each ledger line of an account with a budget and after an
   * accounts change; `quota.snapshot` refreshes the ones it answers. An account that lost its budget loses the window.
   * Throws when the ledger cannot be read. A remote service keeps the local PC's (pushed with its other windows): it has
   * neither budgets nor the ledger of record. One at a time, so an earlier spend never replaces a later one.
   */
  const refreshBudgets = (filter?: ReadonlySet<string>) => {
    const run = budgetRuns.then(async () => {
      if (deps.remote) return
      const windows = await budgetWindows(filter)
      const kept = new Set(windows.map((window) => window.accountID))
      const dropped = runtime.limits
        .list()
        .filter(
          (window) =>
            window.id === BUDGET_WINDOW &&
            !kept.has(window.accountID) &&
            (filter === undefined || filter.has(window.accountID)),
        )
        .map((window) => ({ accountID: window.accountID, id: window.id }))
      dropped.forEach((window) => runtime.limits.drop(window.accountID, window.id))
      publish(windows)
      if (dropped.length > 0) runtime.broadcast.emit("limits.updated", { windows: [], dropped })
    })
    budgetRuns = run.catch(() => undefined)
    return run
  }

  const budgetWindows = async (filter: ReadonlySet<string> | undefined): Promise<Limit.Window[]> => {
    const accounts = peers()
      .slots.snapshot()
      .accounts.filter((account) => budgeted(account) && (filter === undefined || filter.has(account.id)))
    if (accounts.length === 0) return []
    const now = deps.clock.now()
    const lines = (await book.month(Book.months(now, 1)[0])).map((entry) => entry.line)
    const start = new Date(now)
    const resetAt = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
    return accounts.map((account): Limit.Window => {
      const limit = account.budget?.monthlyUSD ?? 0
      const spent = lines
        .filter((line) => line.accountID === account.id && line.cost?.unit === "USD")
        .reduce((sum, line) => sum + (line.cost?.amount ?? 0), 0)
      const usedPercent = (100 * spent) / limit
      return {
        id: BUDGET_WINDOW,
        accountID: account.id,
        providerID: account.providerID,
        scope: "account",
        kind: "budget",
        label: "이번 달 예산",
        usedPercent: Math.round(usedPercent * 100) / 100,
        remaining: Math.round((limit - spent) * 1e6) / 1e6,
        limit,
        unit: "USD",
        resetAt,
        status: usedPercent >= 100 ? "exhausted" : usedPercent >= Windows.WARNING_PERCENT ? "warning" : "ok",
        confidence: "live",
        source: "ledger",
        observedAt: now,
      }
    })
  }

  const budgetFailed = (error: unknown) => log.warn("budget_unreadable", { error })

  const quotaSnapshot: Api["quotaSnapshot"] = async (input) => {
    const filter = input.accountIDs ? new Set<string>(input.accountIDs) : undefined
    const wanted = (accountID: string) => filter === undefined || filter.has(accountID)
    // The budgets as of now (PresetBudget's gate reads them here), into the store the other readers share.
    await refreshBudgets(filter)
    const windows = runtime.limits.list().filter((window) => wanted(window.accountID))
    // The ones `account.status` announced: account-wide only (a model bucket's is not the account's state, Relay).
    const exhausted = runtime.limits
      .exhaustions()
      .filter((exhaustion) => wanted(exhaustion.accountID) && LimitModel.accountWide(exhaustion.windowId))
      .map((exhaustion) => ({
        accountID: exhaustion.accountID,
        reason: Relay.reasonOf(exhaustion),
        until: exhaustion.until,
      }))
    const resetCredits = runtime.limits.credits().filter((credits) => wanted(credits.accountID))
    return { windows, exhausted, ...(resetCredits.length > 0 ? { resetCredits } : {}) }
  }

  const ledgerSession: Api["ledgerSession"] = async (input) => {
    // 04 §16.5 `server`: the local service answers for every server (remote lines carry `server = hostId`).
    const entries = (await book.session(input.sessionID)).filter(
      (entry) => input.server === undefined || Ledger.serverOf(entry.line) === input.server,
    )
    const limit = input.limit ?? 200
    const end =
      input.cursor === undefined
        ? entries.length
        : Math.max(
            0,
            entries.findIndex((entry) => entry.eid === input.cursor),
          )
    const start = Math.max(0, end - limit)
    const lines = entries.map((entry) => entry.line)
    return {
      steps: lines.slice(start, end),
      totals: {
        byAccount: Totals.byAccount(lines),
        ...(lines.some((line) => line.kind === "side")
          ? { side: Totals.of(lines.filter((line) => line.kind === "side")) }
          : {}),
      },
      switchCount: Math.max(0, ...lines.map((line) => line.switchEpoch)),
      ...(start > 0 ? { cursor: entries[start].eid } : {}),
    }
  }

  const usage: Api["usage"] = async (input, context) => {
    const accountID = input.accountID
    if (
      accountID !== undefined &&
      accountID !== Account.ID.claudeSlot &&
      !peers().claude.entry(accountID) &&
      !peers().claudeAgent.entry(accountID) &&
      !peers().slots.account(accountID)
    )
      return context.error("account_not_found", "account_not_found", { accountID })
    if (input.to <= input.from) return { rows: [] }
    const lines = (await book.range(input.from, input.to))
      .map((entry) => entry.line)
      .filter((line) => accountID === undefined || line.accountID === accountID)
    return {
      rows: Totals.rows(lines, input.groupBy, {
        projectOf: (sessionID) => projects.get(sessionID) ?? sessions.get(sessionID)?.projectID ?? null,
      }),
    }
  }

  const cacheStateRpc: Api["cacheState"] = async (input) => cacheSnapshot(input.sessionID, memory(input.sessionID))

  const cacheSetTtlMode: Api["cacheSetTtlMode"] = async (input, context) => {
    // Phase 3 (02 §4.5): only the default 5-minute mode exists in the MVP.
    if (input.mode !== "5m")
      return context.error("unsupported_strategy", "ttl_mode_unsupported", { strategy: input.mode })
    await deps.ctx.storage.remove(Kv.ttlMode(input.sessionID, input.providerID))
    return { mode: "5m" }
  }

  const ratecardsGet: Api["ratecardsGet"] = async (_input, context) => {
    const file = await runtime.ratecards.read().catch((error: unknown) => {
      log.error("ratecards_unreadable", { error })
      return undefined
    })
    if (!file) return context.error("internal_error", "ratecards_unreadable", {})
    state.cards = file.cards
    return file
  }

  const ratecardsSet: Api["ratecardsSet"] = async (input, context) => {
    const today = new Date(deps.clock.now()).toISOString().slice(0, 10)
    const file = await runtime.ratecards
      .update((current) => ({ ...current, updatedAt: today, cards: input.cards }))
      .catch((error: unknown) => {
        log.error("ratecards_write_failed", { error })
        return undefined
      })
    if (!file) return context.error("internal_error", "ratecards_write_failed", {})
    state.cards = file.cards
    runtime.broadcast.emit("store.changed", { store: "ratecards", origin: "local" })
    return file
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lifecycle

  /** `cached`: the copy another Location's instance already read (setup); changes read the file. */
  const loadCards = async (cached?: Ratecard.File) => {
    const file =
      cached ??
      (await runtime.ratecards.read().catch((error: unknown) => {
        log.warn("ratecards_unreadable", { error })
        return undefined
      }))
    if (file) state.cards = file.cards
  }

  const start = async () => {
    await loadCards(runtime.ratecards.cached())
    unsubscribe.push(
      runtime.broadcast.on("limits.updated", (payload) =>
        relay.limits(payload.windows, payload.dropped, payload.resetCredits, payload.creditsUnknown),
      ),
      runtime.broadcast.on("exhausted", (payload) => {
        relay.exhausted(payload.exhaustion)
        // A read of the count only (02 §7.1.1); a reset credit is never redeemed here.
        void track(limitReset.exhausted(payload.exhaustion))
      }),
      runtime.broadcast.on("alert", (payload) => relayed(payload)),
      runtime.broadcast.on("ledger.line", (payload) => {
        const accountID = payload.line.accountID
        if (accountID && payload.line.tokens) relay.succeeded(accountID)
        // This PC's line or a host's: a budget's spend moved (02 §7.3 `budget`).
        const account = accountID ? peers().slots.account(accountID) : undefined
        if (runtime.isLeader() && account && budgeted(account) && payload.line.cost?.unit === "USD")
          void track(refreshBudgets(new Set([account.id])).catch(budgetFailed))
        if (written.delete(payload.eid) || isLocalSession(payload.line.sessionID))
          void deps.emitter.session("ledger.step", { line: payload.line })
      }),
      runtime.broadcast.on("store.changed", (payload) => {
        // Any writer (another Location's `ratecards.set`, or another process) invalidates this instance's cards.
        if (payload.store === "ratecards") void track(loadCards())
        // Account and kind compaction settings move thresholds: open local sessions get a fresh `cache.state` (9.3).
        if (payload.store === "accounts" || payload.store === "policy") refreshLocal()
        // A budget set, changed or removed.
        if (payload.store === "accounts" && runtime.isLeader()) void track(refreshBudgets().catch(budgetFailed))
      }),
    )
    // A remote service polls no balances (04 §9.1): the local leader does, with its own credentials.
    if (!deps.remote) every(Poller.TICK_MS, () => void track(poller.tick()))
    // The stored budgets may be of another month or of a budget since removed.
    if (runtime.isLeader()) void track(refreshBudgets().catch(budgetFailed))
    once(60_000, () => maintain())
    every(MAINTAIN_MS, () => maintain())
    every(10 * 60_000, () => sweep())
  }

  const maintain = () => {
    if (!runtime.isLeader()) return
    void track(runtime.ledger.maintain().catch((error: unknown) => log.warn("ledger_maintain_failed", { error })))
    void track(capture.maintain())
  }

  const sweep = () => {
    const cutoff = deps.clock.now() - SESSION_IDLE_MS
    for (const [sessionID, session] of sessions)
      if (session.touched < cutoff && !queues.has(sessionID)) {
        session.boundary?.()
        sessions.delete(sessionID)
      }
    for (const [key, at] of alerted) if (at < deps.clock.now() - ALERT_DEDUPE_MS) alerted.delete(key)
  }

  const flush = async () => {
    while (background.size > 0) await Promise.allSettled([...background])
  }

  const refreshCacheState = (sessionID: string) => {
    const decoded = Option.getOrUndefined(decodeSessionID(sessionID))
    if (decoded === undefined) return
    const session = memory(decoded)
    enqueue(decoded, () => emitCacheState(decoded, session))
  }

  /** Sessions of this Location used within the last hour, after a settings change (bounded, one event each). */
  const refreshLocal = () => {
    const since = deps.clock.now() - 3_600_000
    for (const [sessionID, session] of sessions)
      if (session.touched >= since && session.model !== undefined && isLocalSession(sessionID))
        refreshCacheState(sessionID)
  }

  const stop = async () => {
    state.stopped = true
    for (const off of unsubscribe.splice(0)) off()
    for (const cancel of [...timers]) cancel()
    timers.clear()
    for (const session of sessions.values()) session.boundary?.()
    relay.stop()
    await capture.close()
    await flush()
  }

  const recordImage: Api["recordImage"] = async (input) => {
    const sessionID = SessionID.make(input.sessionID)
    const tokens: Tokens | null = input.tokens
      ? {
          input: count(input.tokens.input - input.tokens.cached),
          cacheRead: count(input.tokens.cached),
          cacheWrite: 0,
          cacheWrite1h: null,
          output: count(input.tokens.output),
          reasoning: 0,
        }
      : null
    const line = await buildLine({
      sessionID,
      session: memory(sessionID),
      ts: input.at,
      kind: "image",
      messageID: null,
      model: { providerID: Provider.ID.make(input.providerID), id: Model.ID.make(input.modelID) },
      tokens,
      costUSD: input.costUSD ?? null,
      usageSource: tokens ? "stream" : "estimate",
    })
    const cost =
      input.costUSD === undefined ? null : { unit: "USD" as const, amount: input.costUSD, source: "ratecard" as const }
    await commit(`image_${OwnID.ulid(input.at)}`, { ...line, cost, hit: null })
  }

  const recordSide: Api["recordSide"] = async (input) => {
    const sessionID = SessionID.make(input.sessionID)
    const line = await buildLine({
      sessionID,
      session: memory(sessionID),
      ts: input.at,
      kind: "side",
      messageID: null,
      model: input.model,
      tokens: input.tokens,
      costUSD: input.costUSD,
      P: null,
      usageSource: input.tokens ? "event" : "estimate",
    })
    await commit(`side_${OwnID.ulid(input.at)}`, line)
    return line.cost
  }

  return {
    recordImage,
    recordSide,
    start,
    stop,
    onEvent,
    onModelRequest,
    primaryCache,
    prefixVerdict,
    recentVerdict,
    onHttpRequest,
    onHttpResponse,
    onWsReceive,
    onRetry,
    alert,
    flush,
    refreshCacheState,
    quotaSnapshot,
    resetCreditsList: limitReset.list,
    resetCreditsPlan: limitReset.plan,
    resetCreditsExecute: limitReset.execute,
    ledgerSession,
    usage,
    cacheState: cacheStateRpc,
    cacheSetTtlMode,
    ratecardsGet,
    ratecardsSet,
    capture,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function tokensOf(input: {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}): Tokens {
  return {
    input: count(input.input),
    cacheRead: count(input.cache.read),
    cacheWrite: count(input.cache.write),
    cacheWrite1h: null,
    output: count(input.output),
    reasoning: count(input.reasoning),
  }
}

function count(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function sessionIdOf(event: Module.OpenCodeEvent) {
  const data = "data" in event ? record(event.data) : undefined
  return typeof data?.sessionID === "string" ? data.sessionID : undefined
}

/** First 2 KB of an error body, or `null` when it cannot be read in time (02 §7.2). */
async function head(response: Response) {
  const timeout = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), BODY_TIMEOUT_MS)
    timer.unref?.()
  })
  const text = response.text().then(
    (value) => value.slice(0, 2048),
    () => null,
  )
  return Promise.race([text, timeout])
}

/** Retry-relevant facts of a WS `error` / `response.failed` frame (01 §14.3); never the frame itself. */
function frameSummary(json: Readonly<Record<string, unknown>>, now: number): LastResponse.Frame {
  const response = record(json.response)
  const error = record(json.error) ?? record(response?.error)
  const status = [json.status, json.status_code, error?.status].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  )
  const code = [error?.type, error?.code].find((value): value is string => typeof value === "string")
  const inSeconds = typeof error?.resets_in_seconds === "number" ? error.resets_in_seconds : undefined
  const atSeconds = typeof error?.resets_at === "number" ? error.resets_at : undefined
  const resetsInSeconds =
    inSeconds ?? (atSeconds === undefined ? undefined : Math.max(0, Math.round(atSeconds - now / 1000)))
  return {
    type: typeof json.type === "string" ? json.type : "unknown",
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(resetsInSeconds === undefined ? {} : { resetsInSeconds }),
  }
}

/** The monthly budget window of an account with a budget (02 §7.3 `budget`). */
const BUDGET_WINDOW = "api.budget_month"

/** An account whose month the ledger measures against a budget: a paid one with a monthly limit. */
function budgeted(account: Account.Info) {
  return account.billing !== "subscription" && (account.budget?.monthlyUSD ?? 0) > 0
}

/** An event's encoded model ref as the branded `Model.Ref` (event payloads arrive encoded). */
function refOf(model: { readonly id: string; readonly providerID: string; readonly variant?: string }): Model.Ref {
  return {
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.providerID),
    ...(model.variant === undefined ? {} : { variant: Model.VariantID.make(model.variant) }),
  }
}

/**
 * Anthropic's lookback positions before each message of `messages`, and after the last (CC-12): content blocks, a run
 * of tool calls or of tool results as one position (study §5).
 */
function blockPositions(messages: ReadonlyArray<Message>) {
  const counted = messages.reduce(
    (state, message) => {
      state.before.push(state.count)
      return message.content.reduce((inner, part) => {
        const run = (part.type === "tool-call" || part.type === "tool-result") && part.type === inner.last
        return { ...inner, count: inner.count + (run ? 0 : 1), last: part.type }
      }, state)
    },
    { count: 0, last: "", before: new Array<number>() },
  )
  return [...counted.before, counted.count]
}

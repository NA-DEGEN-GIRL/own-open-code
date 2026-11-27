export * as SessionSpeed from "./speed.js"

import { Option, Schema } from "effect"
import type {
  SessionContext,
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRetry,
  SessionWebSocketReceive,
} from "@opencode/plugin/promise/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { Kv, Speed, type Ledger, type Ratecard } from "@own/protocol"
import type { ClaudeAgent } from "../claude-agent/agent.js"
import { ChatgptSharing } from "../credentials/sharing.js"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import { CacheState } from "../telemetry/cache.js"
import { Classify } from "../telemetry/classify.js"
import { Rates } from "../telemetry/rates.js"
import { SpeedEstimate } from "./estimate.js"
import { SpeedOffers } from "./offers.js"
import { SpeedRefusal } from "./refusal.js"
import { SpeedWire } from "./wire.js"

/**
 * Owner: SPEED (02 §4.8, 03 §4.6, 07 §2.10; user decisions of 2026-10-06). A root session's speed (`표준 | Fast |
 * Ultrafast`), stored in KV `sess:<root>:speed`, never in a preset, Standard in every new conversation:
 * - Requests: an OpenAI-family slot (`codex`, `siwc`, `oai`) gets the request option `serviceTier` in its `context` and
 *   `compaction` hooks (never `generate`); an Anthropic request (`anth`, and the Claude subscription slot by the
 *   documented exception 02 §8.3 I5a) gets `speed: "fast"` and the beta header in `http.request`. The beta stays on the
 *   conversation's later requests (it is part of the cache key) until the model changes or a compaction ends.
 * - Choice → request (decision 6): `Speed.resolve` falls back Ultrafast → Fast → Standard; a child follows its root by
 *   `Speed.inherit` (same account, its model lists the speed). A main on a catalog mode entry (`-fast`) is left as it is.
 * - A refused tier (not entitled, rejected, Anthropic's fast rate limit) is marked for the account and model
 *   (`runtime.speed`), the request goes again at once without it (`retry` hook: nothing was produced yet), the root
 *   gets `session.speed.changed` and the alert `speed_fallback`. The account is never switched (R2/R4); a speed never
 *   changes a context limit (R8).
 * - The served tier (OpenAI `service_tier`, Anthropic `usage.speed`) is read from the response only while a tier was
 *   sent; a silent downgrade goes to the ledger line (`Ledger.Line.speed`) and the root's view (grey badge). Only the
 *   first of a run is announced (`downgraded`, `speed_downgraded`); a tier the provider never honored for the account
 *   and model and served slower {@link Speed.IGNORED_AFTER} times in a row is marked unavailable and falls back like a
 *   refusal (`ignored`, `speed_fallback`). The first request after a tier change measures whether the cache was kept.
 * Hooks never throw on purpose (`hooks.ts` guards them anyway); a failure leaves the request as core built it.
 */
export interface Api extends Module.Lifecycle {
  get: RpcTypes.Handler<"session.speed.get">
  set: RpcTypes.Handler<"session.speed.set">
  /** `speed.offers`: a main's offers before any session runs on it (the new-conversation composer, the switcher). */
  offers: RpcTypes.Handler<"speed.offers">
  /** `context`/`compaction` of an OpenAI-family own slot: the request option `serviceTier`. */
  onRequestShape(event: SessionContext, hook: "context" | "compaction" | "generate"): Promise<void>
  /** `http.request` of an Anthropic request (own `anth` slot, Claude subscription slot): `speed` and the beta. */
  onHttpRequest(event: SessionHttpRequest): Promise<void>
  /** `http.response` after a tier was sent: the error head for the retry decision, else the served tier. */
  onHttpResponse(event: SessionHttpResponse): Promise<void>
  /** `ws.receive` after a tier was sent (Codex): the served tier and error frames. */
  onWsReceive(event: SessionWebSocketReceive): void
  /** `retry`: a refused tier is marked and the request goes again at once without it. */
  onRetry(event: SessionRetry): Promise<void>
  /** Claude Code's Fast answer for a Claude Agent turn (core P-060 via the observer channel, CAM-6). */
  claudeAgentFast(sessionID: string, fast: ClaudeAgent.FastState): void
  /**
   * The ledger's `speed` of the request a step (or a compaction) that ended at `endedAt` sent; also the retention
   * measure of the first request after a tier change. `undefined` for a Standard request.
   */
  step(input: {
    readonly sessionID: string
    readonly providerID: string
    readonly endedAt: number
    readonly tokens: Ledger.Tokens | null
  }): Ledger.Line["speed"]
  /** The catalog price of a speed tier for a ledger line (API kinds, the Claude slot); `undefined` otherwise. */
  price(providerID: string, modelID: string, tier: string): Promise<Rates.CatalogCost | undefined>
  /** The plan credits multiple of a tier (`codex`, `siwc`); `undefined` without a speed card. */
  credits(providerID: string, modelID: string, tier: string): Promise<number | undefined>
  /** A Sign in with ChatGPT account's catalog was read (`accounts.test`): its tiers per model (02 §4.8). */
  sharing(accountID: string, models: ReadonlyArray<ChatgptSharing.RemoteModel>): void
}

/** Kinds whose requests take a speed tier (`service_tier` or Anthropic's `speed`); the others offer none (`kind`). */
const TIERED: ReadonlySet<string> = new Set(["codex", "siwc", "oai", "anth", "claude-sub", "claude-agent"])

/**
 * Kinds whose Fast is billed to a Claude plan's usage credits, never the plan itself: the Claude subscription slot and
 * the Claude Agent route (Claude Code's Fast mode, CAM-6). Both need the one-time consent (`Kv.ackClaudeFast`).
 */
const CREDITS: ReadonlySet<string> = new Set(["claude-sub", "claude-agent"])

/** Claude Code's reasons it ran a Fast turn at Standard that hold until something changes (its `fast_mode_disabled_reason`). */
const AGENT_REFUSALS: ReadonlySet<string> = new Set([
  "free",
  "preference",
  "extra_usage_disabled",
  "not_first_party",
  "disabled_by_env",
  "model_not_allowed",
  "sdk_opt_in_required",
])

/** Requests remembered per (session, provider) for the ledger, the served tier and the retry decision. */
const RING = 4
/** The Responses events that end a response over the WebSocket: their tier is what was served (02 §4.8). */
const FINAL_EVENTS: ReadonlySet<unknown> = new Set(["response.completed", "response.incomplete"])
/** Sessions whose state and requests stay in memory; older ones are forgotten first. */
export const MEMORY_KEYS = 4_000
/** How long after a step its successor's cache read still says whether a tier change kept the cache. */
export const RETENTION_WINDOW_MS = 5 * 60_000
/** A cloned response stream is read for its served tier at most this long. */
const SERVED_TIMEOUT_MS = 10 * 60_000
/** Error bodies are read up to this many characters for the retry decision. */
const ERROR_HEAD = 4_096
/** The `session-id` of the Sign in with ChatGPT catalog read; it names no session. */
const SHARING_SESSION = "own-accounts:speed-sharing"

const decodeState = Schema.decodeUnknownOption(Speed.State)
const decodeConsent = Schema.decodeUnknownOption(Speed.Consent)
const encodeState = Schema.encodeSync(Speed.State)
const encodeConsent = Schema.encodeSync(Speed.Consent)
const toJson = Schema.decodeUnknownSync(Schema.Json)

/** One request that went with a speed decision. */
interface Sent {
  readonly at: number
  readonly sessionID: string
  readonly root: string
  readonly accountID: string
  readonly modelID: string
  readonly wire: Speed.Wire
  /** `undefined` for a Standard request. */
  readonly tier: string | undefined
  served?: string | null
}

/** What a request of a session sends now. */
interface Decision {
  readonly target: SpeedOffers.Target
  readonly root: string
  readonly resolved: Speed.Resolved
}

/** The last step of a session and provider, for the retention measure of the next one. */
interface Step {
  readonly tier: string | undefined
  readonly modelID: string
  readonly input: number
  readonly at: number
}

/** A failed answer of a request that carried a tier, kept for the retry decision. */
interface Failure {
  readonly status: number | undefined
  readonly text: string
  readonly at: number
  readonly retryAfterMs?: number
}

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("speed")
  const states = new Map<string, Speed.State>()
  const sent = new Map<string, Sent[]>()
  const failures = new Map<string, Failure>()
  const served = new Map<string, Speed.Served>()
  const steps = new Map<string, Step>()
  const timers = new Set<() => void>()
  const background = new Set<Promise<unknown>>()
  const consent = { value: undefined as boolean | undefined }

  const sharing: Api["sharing"] = (accountID, models) =>
    deps.runtime.speed.setList(accountID, {
      fetchedAt: deps.clock.now(),
      models: new Map(models.map((model) => [model.slug, ChatgptSharing.tiersOf(model)])),
    })

  const offers = SpeedOffers.create(deps, peers, async (accountID) => {
    const account = peers().slots.account(accountID)
    const slot = account && peers().slots.slot(account.providerID)
    if (!account || !slot) return
    const auth = await peers().logins.headers(account, SHARING_SESSION)
    if (!auth.ok) return
    const catalog = await ChatgptSharing.fetchModels(slot.slot.baseURL ?? deps.endpoints.url.openai, auth.headers)
    if (catalog.ok) sharing(accountID, catalog.models)
  })

  const track = <A>(promise: Promise<A>) => {
    background.add(promise)
    void promise.finally(() => background.delete(promise))
    return promise
  }

  /** Waits for the background work, and for what it started meanwhile (a served tier's announcement). */
  const drain = async (): Promise<void> => {
    if (background.size === 0) return
    await Promise.allSettled([...background])
    return drain()
  }

  // -------------------------------------------------------------------------------------------------------------
  // Sessions and state

  /** The root of a session tree: the runtime index first, then a session lookup. */
  const rootOf = async (sessionID: string): Promise<string> => {
    const indexed = deps.runtime.sessions.get(sessionID)
    const parentID = indexed
      ? indexed.parentID
      : (await deps.ctx.session.get({ sessionID: SessionID.make(sessionID) }).catch(() => undefined))?.parentID
    return parentID ? rootOf(parentID) : sessionID
  }

  /** A session's current model: the runtime index, else a session lookup. */
  const mainOf = async (sessionID: string): Promise<Model.Ref | undefined> => {
    const indexed = deps.runtime.sessions.get(sessionID)
    const looked =
      indexed?.providerID && indexed.modelID
        ? { providerID: indexed.providerID, id: indexed.modelID, variant: indexed.variant ?? undefined }
        : (await deps.ctx.session.get({ sessionID: SessionID.make(sessionID) }).catch(() => undefined))?.model
    if (!looked) return undefined
    return {
      providerID: Provider.ID.make(looked.providerID),
      id: Model.ID.make(looked.id),
      ...(looked.variant ? { variant: Model.VariantID.make(looked.variant) } : {}),
    }
  }

  const stateOf = async (sessionID: string): Promise<Speed.State> => {
    const known = states.get(sessionID)
    if (known) return known
    const stored = await deps.ctx.storage.get(Kv.speed(sessionID)).catch(() => undefined)
    const state = Option.getOrUndefined(decodeState(stored)) ?? {}
    remember(states, sessionID, state)
    return state
  }

  const writeState = async (sessionID: string, state: Speed.State) => {
    remember(states, sessionID, state)
    await deps.ctx.storage.set(Kv.speed(sessionID), toJson(encodeState(state)))
  }

  /**
   * The one-time consent that Fast on the Claude subscription slot is billed to usage credits. A remote service reads
   * the PC's (the mirrored `claude.fast`, 04 §8.11.9), never its own KV, and keeps no copy.
   */
  const consented = async () => {
    if (deps.remote) return deps.remote.claude()?.fast ?? false
    if (consent.value !== undefined) return consent.value
    const stored = await deps.ctx.storage.get(Kv.ackClaudeFast).catch(() => undefined)
    consent.value = Option.isSome(decodeConsent(stored))
    return consent.value
  }

  // -------------------------------------------------------------------------------------------------------------
  // Decisions

  /**
   * What a request of `sessionID` on `model` sends now. A root resolves its choice on its offers; a child inherits the
   * root's effective speed when it runs on the root main's account and its model lists it. The Claude slot without the
   * consent sends Standard. `undefined` for a provider own does not run, or a catalog mode entry.
   */
  const decide = async (sessionID: string, model: Model.Ref, choice?: Speed.Choice): Promise<Decision | undefined> => {
    const target = await offers.target(model.providerID, model.id)
    if (!target || target.fixed) return undefined
    const root = await rootOf(sessionID)
    const wanted = choice ?? (await stateOf(root)).choice ?? "standard"
    const resolved =
      root === sessionID ? Speed.resolve(wanted, offers.offers(target)) : await inherited(root, wanted, model, target)
    const blocked = CREDITS.has(target.kind) && resolved.effective !== "standard" && !(await consented())
    return { target, root, resolved: blocked ? { effective: "standard", fell: true } : resolved }
  }

  /** A child's speed: the root main's effective speed, if the child's main shares its account and lists it. */
  const inherited = async (root: string, choice: Speed.Choice, model: Model.Ref, target: SpeedOffers.Target) => {
    const main = await mainOf(root)
    const rootTarget = main && (await offers.target(main.providerID, main.id))
    const effective =
      rootTarget && !rootTarget.fixed ? Speed.resolve(choice, offers.offers(rootTarget)).effective : "standard"
    return Speed.inherit({
      root: { providerID: main?.providerID ?? "", effective },
      child: { providerID: model.providerID, offers: offers.offers(target) },
    })
  }

  /** A request of the session needs no speed work: its root is Standard and the session never sent the beta. */
  const idle = async (sessionID: string) => {
    const root = await rootOf(sessionID)
    return ((await stateOf(root)).choice ?? "standard") === "standard" && (await stateOf(sessionID)).beta === undefined
  }

  const keyOf = (sessionID: string, providerID: string) => `${sessionID}\u0000${providerID}`

  const latest = (sessionID: string, providerID: string) => sent.get(keyOf(sessionID, providerID))?.at(-1)

  /** Remembers what a request sent; a Standard request is kept only after a faster one, so the ledger never misreads. */
  const record = (sessionID: string, providerID: string, request: Omit<Sent, "at" | "sessionID">) => {
    const key = keyOf(sessionID, providerID)
    if (request.tier === undefined && latest(sessionID, providerID)?.tier === undefined) return
    remember(sent, key, [...(sent.get(key) ?? []), { ...request, at: deps.clock.now(), sessionID }].slice(-RING))
  }

  /** A Standard record for a request the speed left alone. */
  const standard = (sessionID: string, providerID: string, accountID: string, modelID: string, wire: Speed.Wire) =>
    record(sessionID, providerID, { root: sessionID, accountID, modelID, wire, tier: undefined })

  // -------------------------------------------------------------------------------------------------------------
  // Views

  const view = async (sessionID: string, choice?: Speed.Choice): Promise<Speed.View> => {
    const root = await rootOf(sessionID)
    const wanted = choice ?? (await stateOf(root)).choice ?? "standard"
    const model = await mainOf(sessionID)
    const target = model && (await offers.target(model.providerID, model.id))
    const decision = model && target && !target.fixed ? await decide(sessionID, model, wanted) : undefined
    const state = await stateOf(sessionID)
    const last = sessionID === root ? served.get(root) : undefined
    const resolved = decision?.resolved
    const list = target && !target.fixed ? offers.offers(target) : []
    return {
      sessionID: SessionID.make(sessionID),
      root: SessionID.make(root),
      choice: wanted,
      effective: target?.fixed ?? resolved?.effective ?? "standard",
      tier: resolved?.offer?.tier ?? null,
      offers: list,
      ...(target?.fixed ? { fixed: target.fixed } : {}),
      ...(target && CREDITS.has(target.kind)
        ? { consent: (await consented()) ? ("given" as const) : ("needed" as const) }
        : {}),
      beta: state.beta !== undefined && state.beta.modelID === model?.id,
      ...(last ? { served: last } : {}),
      ...withNone(model ? noneOf(target, list) : "session"),
    }
  }

  /** {@link Api.offers}: the view's facts for a main without a session. */
  const targeted = async (providerID: string, modelID: string): Promise<Speed.Targeted> => {
    const target = await offers.target(providerID, modelID)
    const list = target && !target.fixed ? offers.offers(target) : []
    return {
      providerID,
      modelID,
      offers: list,
      ...(target?.fixed ? { fixed: target.fixed } : {}),
      ...(target && CREDITS.has(target.kind)
        ? { consent: (await consented()) ? ("given" as const) : ("needed" as const) }
        : {}),
      ...withNone(noneOf(target, list)),
    }
  }

  /** The root's view now as `session.speed.changed` (a refusal's code as `cause`); never throws. */
  const announce = (root: string, reason: Speed.Reason, cause?: string) =>
    void track(
      view(root).then((next) =>
        deps.emitter.session("session.speed.changed", {
          sessionID: SessionID.make(root),
          choice: next.choice,
          effective: next.effective,
          tier: next.tier,
          reason,
          ...(cause === undefined ? {} : { cause }),
        }),
      ),
    ).catch((error: unknown) => log.warn("speed_announce_failed", { sessionID: root, error }))

  // -------------------------------------------------------------------------------------------------------------
  // The estimate of a change (decision 7)

  const estimate = async (root: string, from: Speed.Choice, to: Speed.Choice, target: SpeedOffers.Target) => {
    const list = offers.offers(target)
    const offerOf = (choice: Speed.Choice) => list.find((offer) => offer.choice === choice)
    const cards =
      deps.runtime.ratecards.cached()?.cards ??
      (await deps.runtime.ratecards.read().catch(() => undefined))?.cards ??
      []
    const base = standardRates(cards, target)
    const ratesOf = async (choice: Speed.Choice): Promise<SpeedEstimate.Rates | undefined> => {
      if (choice === "standard") return base
      const offer = offerOf(choice)
      if (!offer) return undefined
      if (offer.billing?.type === "plan") return SpeedEstimate.scale(base, offer.billing.credits ?? undefined)
      const price = await offers.price(target, offer.tier)
      if (!price) return undefined
      if (CREDITS.has(target.kind))
        return {
          unit: "USD",
          input: price.input,
          read: price.cacheRead ?? price.input,
          cold: price.cacheWrite ?? price.input,
        }
      return base?.input ? SpeedEstimate.scale(base, price.input / base.input) : undefined
    }
    // The cache of the account the root signs with (SL-8: each Claude account has its own), read from the tree's
    // binding: the sync `peek` answers the default account until a request or a binding read ran after a restart
    // (SL-17). A root core does not answer for yet (like `rootOf`) keeps the last known account.
    const claude = peers().claude
    const entry = await CacheState.read(
      (key) => deps.ctx.storage.get(key),
      root,
      target.providerID,
      target.kind === "claude-sub" && peers().plugins.claudeSlot().detected
        ? await claude.accountOf(root).catch(() => claude.peek(root))
        : undefined,
    )
    const ttl =
      target.kind === "claude-sub"
        ? Rates.claudeTtl(undefined)
        : Rates.ttl(Rates.ttlCard(cards, target.kind, target.modelID), undefined)
    const warm =
      entry !== undefined && entry.modelID === target.modelID && deps.clock.now() - entry.lastReqAt < (ttl?.lo ?? 0)
    const faster = to === "standard" ? from : to
    const billing = offerOf(faster)?.billing
    const multiple = billing?.type === "plan" ? (billing.included ?? undefined) : undefined
    const retention = deps.runtime.speed.retention(target.kind)
    return SpeedEstimate.change({
      from,
      to,
      wire: target.wire,
      P: deps.runtime.sessions.get(root)?.P ?? 0,
      L: warm ? entry.L : 0,
      before: await ratesOf(from),
      after: await ratesOf(to),
      ...(multiple === undefined ? {} : { multiple }),
      beta: (await stateOf(root)).beta !== undefined,
      extra: CREDITS.has(target.kind),
      ...(retention ? { retention } : {}),
      unverified: offerOf(to)?.status === "unverified",
    })
  }

  /** The Standard rates of the target's model (02 §6.2): its rate card, else the catalog price of an API kind. */
  const standardRates = (
    cards: ReadonlyArray<Ratecard.Card>,
    target: SpeedOffers.Target,
  ): SpeedEstimate.Rates | undefined => {
    if (CREDITS.has(target.kind)) return undefined
    const model = peers().slots.model(target.providerID, target.modelID)
    const cost = model?.cost.find((item) => item.tier === undefined) ?? model?.cost[0]
    const catalog = cost && {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cache.read,
      cacheWrite: cost.cache.write,
    }
    const card = Rates.match(cards, target.kind, target.modelID)
    if (card) {
      const rates = Rates.resolve(card, catalog)
      return {
        unit: rates.unit,
        ...(rates.input === undefined ? {} : { input: rates.input }),
        ...(rates.read === undefined ? {} : { read: rates.read }),
        ...(rates.write === undefined ? {} : { cold: rates.write }),
      }
    }
    if (!catalog || catalog.input <= 0 || target.kind === "codex" || target.kind === "siwc") return undefined
    return { unit: "USD", input: catalog.input, read: catalog.cacheRead, cold: catalog.cacheWrite }
  }

  // -------------------------------------------------------------------------------------------------------------
  // RPC

  const set: Api["set"] = async (input, context) => {
    const root = await rootOf(input.sessionID)
    const model = await mainOf(root)
    const target = model && (await offers.target(model.providerID, model.id))
    const refuse = (reason: string, message: string) =>
      context.error("speed_unavailable", message, { speed: input.speed, reason })
    if (input.speed !== "standard") {
      if (!model) return refuse("no_model", "the session has no model yet")
      if (target?.fixed) return refuse("fixed_model", "the main is a model entry of a fixed speed")
      const offer = target && offers.offers(target).find((item) => item.choice === input.speed)
      if (!offer) return refuse("not_offered", `${input.speed} is not offered for this main`)
      if (!Speed.usable(offer)) return refuse(offer.status, `${input.speed} is ${offer.status} now`)
    }
    const before = (await stateOf(root)).choice ?? "standard"
    const change =
      target && !target.fixed && before !== input.speed ? await estimate(root, before, input.speed, target) : null
    if (input.dryRun) return { view: await view(root, input.speed), change, dryRun: true }
    if (target && CREDITS.has(target.kind) && input.speed !== "standard" && !(await consented())) {
      // 04 §8.11.9: on a remote service the consent is recorded on the PC (`plugin.claudeAuth.fastAck`), never here.
      if (deps.remote)
        return context.error("speed_consent_required", "record the Fast consent on the local PC first", {
          recordOn: "local",
        })
      if (!input.consent)
        return context.error("speed_consent_required", "Fast on the Claude subscription slot bills usage credits", {})
      await deps.ctx.storage.set(Kv.ackClaudeFast, toJson(encodeConsent({ at: deps.clock.now() })))
      consent.value = true
    }
    await writeState(root, { ...(await stateOf(root)), choice: input.speed, setAt: deps.clock.now() })
    log.info("speed_set", { sessionID: root, from: before, to: input.speed })
    if (before !== input.speed) announce(root, "user")
    return { view: await view(input.sessionID), change, dryRun: false }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Request hooks

  const onRequestShape: Api["onRequestShape"] = async (event, hook) => {
    if (hook === "generate") return
    if (event.model.providerID === Provider.ID.claudeAgent) return agentShape(event)
    const slot = peers().slots.slot(event.model.providerID)
    if (!slot || (slot.kind !== "codex" && slot.kind !== "siwc" && slot.kind !== "oai")) return
    const decision = (await idle(event.sessionID)) ? undefined : await decide(event.sessionID, event.model)
    const tier = decision?.resolved.offer?.tier
    if (!decision || tier === undefined)
      return standard(event.sessionID, event.model.providerID, slot.account.id, event.model.id, "service_tier")
    event.options.serviceTier = tier
    record(event.sessionID, event.model.providerID, {
      root: decision.root,
      accountID: decision.target.accountID,
      modelID: event.model.id,
      wire: "service_tier",
      tier,
    })
  }

  /**
   * A Claude Agent request (CAM-6): Fast is Claude Code's own mode, so the request asks for it with the provider option
   * `fastMode` (core P-060 turns Claude Code's `fastMode` flag setting on before the turn's input) and nothing else
   * changes. Claude Code answers in the turn's result whether it ran Fast ({@link claudeAgentFast}).
   */
  const agentShape = async (event: SessionContext) => {
    const decision = (await idle(event.sessionID)) ? undefined : await decide(event.sessionID, event.model)
    const tier = decision?.resolved.offer?.tier
    if (!decision || tier === undefined)
      return standard(event.sessionID, event.model.providerID, SpeedOffers.AGENT_MARKS, event.model.id, "speed")
    event.options.fastMode = true
    record(event.sessionID, event.model.providerID, {
      root: decision.root,
      accountID: decision.target.accountID,
      modelID: event.model.id,
      wire: "speed",
      tier,
    })
  }

  /**
   * Claude Code's answer to a turn own asked Fast for (core P-060's `fast` observation): `on` served Fast; a lasting
   * reason (usage credits off, a model or plan without Fast) marks Fast unavailable for the route's model until the
   * list is read again, and `cooldown` (its Fast rate limit) for a while; each falls back to Standard on the next turn
   * as an HTTP refusal does, never switching the account. A Standard answer without a reason counts as slower.
   */
  const claudeAgentFast: Api["claudeAgentFast"] = (sessionID, fast) => {
    const request = latest(sessionID, Provider.ID.claudeAgent)
    if (!fast.requested || request?.tier === undefined) return
    const marks = deps.runtime.speed
    const reason = fast.reason
    if (fast.state === "on") return observe(request, request.tier, true)
    if (fast.state === "cooldown" || (reason !== undefined && AGENT_REFUSALS.has(reason))) {
      const cooldown = fast.state === "cooldown"
      const strikes = cooldown ? marks.strikes(request.accountID, request.modelID, request.tier) : 0
      marks.mark(request.accountID, request.modelID, {
        tier: request.tier,
        status: cooldown ? "cooldown" : "unavailable",
        reason: reason ?? "cooldown",
        ...(cooldown ? { until: deps.clock.now() + SpeedRefusal.cooldownMs(undefined, strikes) } : {}),
      })
      log.info("speed_fallback", { sessionID, providerID: Provider.ID.claudeAgent, tier: request.tier, reason })
      request.served = "standard"
      announce(request.root, cooldown ? "cooldown" : "fallback", reason)
      return
    }
    observe(request, "standard", true)
  }

  const onHttpRequest: Api["onHttpRequest"] = async (event) => {
    if (event.kind !== "primary" && event.kind !== "compaction") return
    const providerID = event.model.providerID
    const own = peers().slots.slot(providerID)
    if (own ? own.kind !== "anth" : providerID !== Provider.ID.anthropic) return
    if (await idle(event.sessionID)) return
    const decision = await decide(event.sessionID, event.model)
    if (!decision || decision.target.wire !== "speed") return
    const state = await stateOf(event.sessionID)
    const beta = state.beta !== undefined && state.beta.modelID === event.model.id
    const tier = decision.resolved.offer?.tier
    if (tier === undefined && !beta)
      return standard(event.sessionID, providerID, decision.target.accountID, event.model.id, "speed")
    const shaped = await SpeedWire.anthropic(event.request, { speed: tier })
    if (!shaped) return
    event.request = shaped
    record(event.sessionID, providerID, {
      root: decision.root,
      accountID: decision.target.accountID,
      modelID: event.model.id,
      wire: "speed",
      tier,
    })
    if (tier !== undefined && !beta)
      await writeState(event.sessionID, { ...state, beta: { since: deps.clock.now(), modelID: event.model.id } })
  }

  const onHttpResponse: Api["onHttpResponse"] = async (event) => {
    const request = latest(event.sessionID, event.model.providerID)
    if (request?.tier === undefined) return
    const response = event.response
    if (response.status >= 400) {
      const now = deps.clock.now()
      const text = await SpeedWire.head(response.clone(), ERROR_HEAD).catch(() => "")
      const retryAt = Classify.retryAfter(Object.fromEntries(response.headers), now)
      failures.set(keyOf(event.sessionID, event.model.providerID), {
        status: response.status,
        text,
        at: now,
        ...(retryAt === undefined ? {} : { retryAfterMs: Math.max(0, retryAt - now) }),
      })
      return
    }
    if (event.kind !== "primary" && event.kind !== "compaction") return
    const clone = response.clone()
    const kind = peers().slots.slot(event.model.providerID)?.kind
    void track(
      SpeedWire.servedOfStream(clone, AbortSignal.timeout(SERVED_TIMEOUT_MS)).then(
        (tier) => observe(request, SpeedWire.reported(kind, tier), true),
        (error: unknown) => log.debug("speed_served_unread", { error }),
      ),
    )
  }

  const onWsReceive: Api["onWsReceive"] = (event) => {
    const frame = event.frame
    if (!frame.includes('"service_tier"') && !frame.includes('"error"') && !frame.includes("response.failed")) return
    const request = latest(event.sessionID, event.model.providerID)
    if (request?.tier === undefined) return
    const json = SpeedWire.json(frame)
    if (json?.type === "error" || json?.type === "response.failed") {
      failures.set(keyOf(event.sessionID, event.model.providerID), {
        status: typeof json.status === "number" ? json.status : undefined,
        text: frame.slice(0, ERROR_HEAD),
        at: deps.clock.now(),
      })
      return
    }
    // `response.created` may echo what was asked: the ledger keeps the latest tier, the ending event decides.
    const kind = peers().slots.slot(event.model.providerID)?.kind
    observe(request, SpeedWire.reported(kind, SpeedWire.servedOf(json)), FINAL_EVENTS.has(json?.type))
  }

  /**
   * The tier a response served: the ledger's `served` and the root's badge on every report; the response's final one
   * also counts for the account and model (`runtime.speed.served`). The first slower answer of a run is announced once;
   * a tier never honored and served slower {@link Speed.IGNORED_AFTER} times in a row is marked unavailable, so the next
   * request falls back (Ultrafast → Fast → Standard) as on a refusal. The account is never switched (R2/R4).
   */
  const observe = (request: Sent, tier: string | undefined, final: boolean) => {
    if (tier === undefined || request.tier === undefined) return
    request.served = tier
    const downgraded = Speed.downgraded(request.tier, tier)
    if (request.sessionID === request.root)
      served.set(request.root, { requested: request.tier, served: tier, downgraded, at: deps.clock.now() })
    if (!final) return
    const marks = deps.runtime.speed
    const run = marks.served(request.accountID, request.modelID, request.tier, !downgraded)
    if (!downgraded) {
      // A fast success after a cooldown: a later cooldown starts from the shortest wait again.
      if (marks.unmark(request.accountID, request.modelID, request.tier)) announce(request.root, "recovered")
      return
    }
    const fields = { accountID: request.accountID, modelID: request.modelID, requested: request.tier, served: tier }
    const label = Speed.choiceOf({ id: tier }) === "fast" ? "Fast 속도" : "표준 속도"
    if (run.slower === 1) {
      log.info("speed_downgraded", { sessionID: request.sessionID, ...fields, honored: run.honored })
      peers().telemetry.alert({
        code: "speed_downgraded",
        severity: "info",
        sessionID: request.sessionID,
        subject: `${request.accountID}|${request.modelID}|${request.tier}`,
        fields,
        message: `${request.modelID}에 ${request.tier}로 보낸 요청을 provider가 ${tier}(${label}, 그 요금)로 처리했습니다.`,
      })
      announce(request.root, "downgraded")
    }
    if (run.honored || run.slower !== Speed.IGNORED_AFTER) return
    marks.mark(request.accountID, request.modelID, { tier: request.tier, status: "unavailable", reason: "ignored" })
    log.info("speed_ignored", { sessionID: request.sessionID, ...fields, slower: run.slower })
    peers().telemetry.alert({
      code: "speed_fallback",
      severity: "info",
      sessionID: request.sessionID,
      subject: `${request.accountID}|${request.modelID}|${request.tier}|ignored`,
      fields: { ...fields, tier: request.tier, reason: "ignored" },
      message:
        `${request.modelID}에 ${request.tier}로 보낸 요청이 ${run.slower}번 연달아 ${tier}(${label})로 처리되어, ` +
        `이 계정·모델은 ${request.tier}를 지원하지 않는 것으로 보고 더 느린 속도로 보냅니다. 계정 목록을 다시 읽으면 다시 시도합니다.`,
    })
    announce(request.root, "ignored")
  }

  const onRetry: Api["onRetry"] = async (event) => {
    const providerID = event.model.providerID
    const request = latest(event.sessionID, providerID)
    if (request?.tier === undefined) return
    const key = keyOf(event.sessionID, providerID)
    const failure = failures.get(key)
    failures.delete(key)
    const fresh = failure && failure.at >= request.at ? failure : undefined
    const error: { readonly type: string; readonly message: string; readonly status?: number } = event.error
    const text = [fresh?.text, error.type, error.message].filter(Boolean).join("\n")
    const verdict = SpeedRefusal.judge({
      wire: request.wire,
      tier: request.tier,
      status: fresh?.status ?? error.status,
      text,
      ...(fresh?.retryAfterMs === undefined ? {} : { retryAfterMs: fresh.retryAfterMs }),
    })
    if (!verdict) return
    const marks = deps.runtime.speed
    if (verdict.type === "refused")
      marks.mark(request.accountID, request.modelID, {
        tier: request.tier,
        status: "unavailable",
        reason: verdict.reason,
      })
    if (verdict.type === "cooldown") {
      const before = marks
        .marks(request.accountID, request.modelID)
        .some((mark) => mark.tier === request.tier && mark.status === "cooldown")
      const strikes = before ? marks.strikes(request.accountID, request.modelID, request.tier) + 1 : 0
      const ms = SpeedRefusal.cooldownMs(verdict.retryAfterMs, strikes)
      marks.mark(request.accountID, request.modelID, {
        tier: request.tier,
        status: "cooldown",
        reason: verdict.reason,
        until: deps.clock.now() + ms,
      })
      schedule(request.root, ms)
    }
    // Nothing was produced yet (a failure before output): send it again at once; the next shaping leaves the tier out.
    event.decision = { retry: true, delay: 0 }
    const said = SpeedRefusal.detail(text)
    log.info("speed_fallback", { sessionID: event.sessionID, providerID, tier: request.tier, ...verdict })
    peers().telemetry.alert({
      code: "speed_fallback",
      severity: "info",
      sessionID: event.sessionID,
      subject: `${request.accountID}|${request.modelID}|${request.tier}|${verdict.type}`,
      fields: {
        providerID,
        modelID: request.modelID,
        tier: request.tier,
        reason: verdict.reason,
        ...(said === undefined ? {} : { detail: said }),
      },
      message:
        verdict.type === "cooldown"
          ? `${request.modelID}의 Fast 한도에 걸려 잠시 표준 속도로 보냅니다(${verdict.reason}).`
          : `${request.modelID}에서 ${request.tier} 속도를 provider가 거절해 더 느린 속도로 다시 보냅니다. ` +
            `${refusalText(verdict.reason)}${said === undefined ? "" : ` provider 답: "${said}"`}`,
    })
    announce(request.root, verdict.type === "cooldown" ? "cooldown" : "fallback", verdict.reason)
  }

  /** The root hears `recovered` when a cooldown ends (its offer is usable again). */
  const schedule = (root: string, ms: number) => {
    const cancel = deps.clock.schedule(ms, () => {
      timers.delete(cancel)
      announce(root, "recovered")
    })
    timers.add(cancel)
  }

  const step: Api["step"] = (input) => {
    const key = keyOf(input.sessionID, input.providerID)
    const request = sent.get(key)?.findLast((item) => item.at <= input.endedAt)
    const tier = request?.tier
    const tokens = input.tokens
    const previous = steps.get(key)
    const kind = peers().slots.slot(input.providerID)?.kind
    // The first request after a tier change on the same model read the cached prefix (half of the last input) or not.
    if (
      kind &&
      tokens &&
      previous &&
      request &&
      previous.tier !== tier &&
      previous.modelID === request.modelID &&
      previous.input > 0 &&
      input.endedAt - previous.at < RETENTION_WINDOW_MS
    )
      deps.runtime.speed.observe(kind, tokens.cacheRead >= previous.input / 2)
    if (tokens && request)
      remember(steps, key, {
        tier,
        modelID: request.modelID,
        input: tokens.input + tokens.cacheRead + tokens.cacheWrite,
        at: input.endedAt,
      })
    return tier === undefined ? undefined : { requested: tier, served: request?.served ?? null }
  }

  return {
    get: (input) => view(input.sessionID),
    set,
    offers: (input) => targeted(input.providerID, input.modelID),
    onRequestShape,
    onHttpRequest,
    onHttpResponse,
    onWsReceive,
    onRetry,
    claudeAgentFast,
    step,
    sharing,
    price: async (providerID, modelID, tier) => {
      const target = await offers.target(providerID, modelID)
      return target ? offers.price(target, tier) : undefined
    },
    credits: async (providerID, modelID, tier) => {
      const target = await offers.target(providerID, modelID)
      const offer = target && offers.offers(target).find((item) => item.tier === tier)
      return offer?.billing?.type === "plan" ? (offer.billing.credits ?? undefined) : undefined
    },
    start: async () => {
      // 04 §8.11.9: `plugin.claudeAuth.fastAck` writes the consent from another module or Location; read it again.
      const stop = deps.runtime.broadcast.on("claudeSlot.changed", (change) => {
        if (change.reason === "fast") consent.value = undefined
      })
      timers.add(stop)
    },
    stop: async () => {
      for (const cancel of timers) cancel()
      timers.clear()
      await drain()
    },
    onEvent: async (event, meta) => {
      // A moved session is another Location's now; if it comes back, its state is read again (it may have changed).
      if (event.type === "session.moved") {
        states.delete(event.data.sessionID)
        return
      }
      if (!meta.local) return
      // A compaction rebuilds the prefix: the next request starts without the beta unless Fast is on.
      if (event.type === "session.compaction.ended") {
        const sessionID = event.data.sessionID
        const state = await stateOf(sessionID)
        if (!state.beta) return
        const { beta: _beta, ...rest } = state
        await writeState(sessionID, rest)
      }
      if (event.type === "session.deleted") {
        states.delete(event.data.sessionID)
        served.delete(event.data.sessionID)
      }
    },
  }
}

/** Why a tier was refused, in Korean, from {@link SpeedRefusal.judge}'s code. */
function refusalText(reason: string) {
  if (reason === "unsupported_tier") return "이 계정·모델은 그 속도를 지원하지 않는다고 답했습니다."
  if (reason === "subscription_sharing_unsupported_capability") return "구독 공유는 그 속도를 지원하지 않습니다."
  if (reason === "usage_credits") return "추가 사용량 크레딧이 없습니다."
  const status = /^status_(\d{3})$/.exec(reason)?.[1]
  return status === undefined ? "거절 이유는 알려 주지 않았습니다." : `HTTP ${status} 오류로 거절했습니다.`
}

/** Insertion-ordered bounded map write: the entry moves to the end and the oldest one goes past the bound. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size <= MEMORY_KEYS) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

/**
 * Why a main offers no faster speed: own does not run its provider (`provider`), its kind has no tier (`kind`), or its
 * account and model list none now (`model`). `undefined` when it offers one or is a fixed-speed mode entry.
 */
function noneOf(target: SpeedOffers.Target | undefined, list: ReadonlyArray<Speed.Offer>): Speed.None | undefined {
  if (!target) return "provider"
  if (target.fixed || list.length > 0) return undefined
  return TIERED.has(target.kind) ? "model" : "kind"
}

function withNone(none: Speed.None | undefined) {
  return none ? { none } : {}
}

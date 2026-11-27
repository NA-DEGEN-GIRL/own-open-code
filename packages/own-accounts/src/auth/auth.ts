export * as Auth from "./auth.js"

import type {
  SessionContext,
  SessionHttpResponse,
  SessionModelRequest,
  SessionRetry,
  SessionWebSocketHandshake,
  SessionWebSocketReceive,
} from "@opencode/plugin/promise/session"
import { Option, Schema } from "effect"
import { Cache, Kv, OutputLimit } from "@own/protocol"
import { Hash } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { Slots } from "../slots/slots.js"
import { PrefixWatch } from "../telemetry/prefix-watch.js"
import { Shape } from "./shape.js"
import { StripRules } from "./strip.js"
import { Toolset } from "./toolset.js"

/**
 * Owner: AUTH agent. Request shaping for own slots only (02 §4): per-request auth injection in `model.request`
 * (`Auth.none` path, no `apiKey`, no `integrationID`; codex adds `chatgpt-account-id`, `session-id` = the session
 * affinity (a child sends its parent's), `originator`; siwc adds Bearer and the session headers of upstream's token
 * sharing, `session-id` = the affinity, `thread-id` and `x-client-request-id` = the session), the deterministic
 * `context`/`compaction`/`generate` transform (D1–D9: identity normalization, Anthropic cache hints, strip rules, the
 * request options the route rejects, and on `context` and `compaction` the output limit of the ChatGPT, OpenAI and
 * OpenRouter routes and DeepSeek's with thinking off), the runtime
 * `toolset_changed` detection (D10), the opt-in prefix fingerprint that rides on a capture window (`PrefixWatch`,
 * P0-2b) and the read-only auth-swap and strip-pattern checks on `http.response` and, for WebSocket slots (codex), on
 * the handshake and inbound error frames.
 *
 * Invariants: filter by `peers().slots.slot(event.model.providerID)` on the first line and return untouched for
 * anything else (including `anthropic`); inject nothing when `peers().plugins.trustStatus() !== "ok"`; never change
 * `baseURL`; never throw (the hook dispatcher also catches); never log header values.
 */
export interface Api extends Module.Lifecycle {
  /**
   * Session `model.request` (all four kinds): the credential injection. Stateless `ctx.generate.text` never reaches
   * here (02 §4.1).
   */
  onModelRequest(event: SessionModelRequest): Promise<void>
  /**
   * Session `model.request`, before {@link onModelRequest} and in a guard of its own: settles the D10 and prefix
   * comparisons of the request `onRequestShape` just shaped (only this hook knows its kind). Separate, so a failing
   * alert or ledger write can never keep the credential off an own-slot request.
   */
  settle(event: SessionModelRequest): void
  /**
   * Session `context`, `compaction` and `generate` (`hook`): the same pure transform for all three (D1, D2) but the
   * output limit, which only the first two get, as with upstream's `omitOutputLimit`. A `generate` caller's limit stays.
   */
  onRequestShape(event: SessionContext, hook?: RequestHook): Promise<void>
  /** Session `http.response`, after telemetry captured it. Read-only: auth swap check (4.2), strip patterns (4.4). */
  onHttpResponse(event: SessionHttpResponse): Promise<void>
  /** Session `experimental.ws.handshake`. Read-only: the auth swap check on the handshake headers (4.2). */
  onWsHandshake(event: SessionWebSocketHandshake): Promise<void>
  /** Session `experimental.ws.receive`, after telemetry. Read-only: strip patterns in error frames (4.4). */
  onWsReceive(event: SessionWebSocketReceive): Promise<void>
  /**
   * Session `retry`, after speed: a Sign in with ChatGPT request the route still refused as an unsupported feature
   * that no speed fallback is sending again raises `sharing_unsupported_input` in Korean (02 §3.2c). Never retries
   * and never switches the account: the same history would be refused again.
   */
  onRetry(event: SessionRetry): void
  /**
   * Latest auth swap verdict of a slot in this instance (02 §4.2, `diagnostics.selfTest`): `ok` when the last observed
   * request carried exactly the injected credential, `broken` when it did not, `unknown` before any request.
   */
  authSwap(providerID: string): "ok" | "broken" | "unknown"
  /**
   * When this instance last saw the tool definitions or system of the session's primary requests change
   * (`toolset_changed`, 02 §4.3 D10), else `undefined`. Cache entries of the session recorded before it share no prefix
   * with the next request, so the estimator takes `W = 0` for them (`Estimator.Context.toolsetAt`).
   */
  toolsetChangedAt(sessionID: string): number | undefined
}

/** The session hooks that shape a request. */
export type RequestHook = "context" | "compaction" | "generate"

/** Credential-carrying request headers; an injection replaces all of them as one set (02 §4.1). */
const AUTH_HEADERS: ReadonlySet<string> = new Set(Hash.AUTH_HEADERS)
const CODEX_HEADERS: ReadonlySet<string> = new Set(["chatgpt-account-id", "session-id", "originator"])
/** The Codex client's session headers that upstream's token sharing sends too (`chatgpt.ts`, 5183ea45c3). */
const SHARING_SESSION_HEADERS: ReadonlySet<string> = new Set(["session-id", "thread-id", "x-client-request-id"])
/** One log line per (slot, reason) per interval, so a failing session cannot flood the log. */
export const LOG_INTERVAL_MS = 60_000
/** Error bodies are scanned for strip patterns up to this many characters (02 §7.2 "앞 2KB"). */
export const ERROR_HEAD_CHARS = 2048
/** Substrings of WebSocket frames worth scanning for strip patterns (error frames only; others pass untouched). */
const ERROR_FRAMES = ['"type":"error"', '"response.failed"', '"type": "error"']
/**
 * Per-session memory (injection outcomes, last shaped message, toolset baselines) is bounded; older sessions are
 * forgotten first.
 */
export const MEMORY_KEYS = 4_000
/**
 * Kinds whose route takes no requested output limit: the ChatGPT backend rejects one, OpenAI counts it against the
 * rate limit, and OpenRouter holds its price against the balance, so a low balance answers 402 where a shorter answer
 * would have fitted (02 §4.1).
 */
const NO_OUTPUT_LIMIT: ReadonlySet<string> = new Set(["codex", "oai", "or"])
/**
 * Output limit of a DeepSeek request with thinking off when nothing set one (external-repos report P0-4, option C).
 * The server default there is 8K, which ends long answers and file writes silently; this is its thinking-on default.
 */
export const DS_THINKING_OFF_OUTPUT = OutputLimit.DS_THINKING_OFF

const decodeCacheEntry = Schema.decodeUnknownOption(Cache.Entry)

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("auth")
  const strips = new StripRules.Store(deps)
  // Outcome of the latest injection per (session, slot): the credential `hash8`, or `null` when nothing was
  // injected. The read-only auth swap check compares the request that `http.response` observed with it (02 §4.2).
  const injections = new Map<string, string | null>()
  // Newest message id of the latest shaped request per (session, slot): `dropBefore` of a strip rule (02 §4.4).
  const shaped = new Map<string, string>()
  // D10 per (session, slot, model, agent): the latest shaped request's hashes until its `model.request`, and the
  // baseline, the hashes of the latest primary request (memory only: the first request after a restart sets it).
  const unsettled = new Map<string, Toolset.Fingerprint>()
  const baselines = new Map<string, Toolset.Fingerprint>()
  // Per session: when D10 last saw a change (`toolsetChangedAt`).
  const toolsetChanges = new Map<string, number>()
  const alerted = new Set<string>()
  const logged = new Map<string, number>()
  // Off unless a capture window records the session and slot (02 §7.8).
  const prefixes = PrefixWatch.create(deps, {
    alert: (input) => peers().telemetry.alert(input),
    capture: () => peers().telemetry.capture,
  })
  // Latest auth swap verdict per slot, process-wide (`auth.swap` broadcast), for `diagnostics.selfTest`.
  const swaps = new Map<string, "ok" | "broken">()
  const stops: Array<() => void> = []
  const judge = (providerID: string, verdict: "ok" | "broken") => {
    if (swaps.get(providerID) === verdict) return
    remember(swaps, providerID, verdict)
    deps.runtime.broadcast.emit("auth.swap", { providerID, verdict })
  }

  const throttled = (key: string, write: () => void) => {
    const now = deps.clock.now()
    if ((logged.get(key) ?? Number.NEGATIVE_INFINITY) + LOG_INTERVAL_MS > now) return
    remember(logged, key, now)
    write()
  }

  const alertOnce = (key: string, input: Parameters<ReturnType<Module.Peers>["telemetry"]["alert"]>[0]) => {
    if (alerted.has(key)) return
    alerted.add(key)
    peers().telemetry.alert(input)
  }

  /** Auth swap is broken for this slot: the account leaves the switch targets until fixed (02 §4.2). */
  const brokenSwap = (slot: Slots.SlotInfo, sessionID: string, reason: string) => {
    judge(slot.providerID, "broken")
    log.error("auth_swap_broken", { providerID: slot.providerID, accountID: slot.account.id, reason })
    alertOnce(`auth_swap_broken:${slot.providerID}`, {
      code: "auth_swap_broken",
      severity: "error",
      sessionID,
      accountID: slot.account.id,
      message: `The request of ${slot.providerID} did not carry exactly the credential own-accounts injected (${reason}).`,
    })
    if (slot.account.status !== "ready") return
    void peers()
      .slots.mutate((current) => {
        const account = current.accounts.find((item) => item.id === slot.account.id)
        if (!account || account.status !== "ready") return undefined
        return {
          ...current,
          accounts: current.accounts.map((item) =>
            item.id === account.id ? { ...item, status: "misconfigured" as const } : item,
          ),
        }
      })
      .catch((error: unknown) => log.error("status_update_failed", { accountID: slot.account.id, error }))
  }

  /** Read-only auth swap check (02 §4.2): the observed credential must be exactly the one injected for this request. */
  const checkSwap = (slot: Slots.SlotInfo, sessionID: string, headers: Hash.HeadersLike) => {
    const expected = injections.get(keyOf(sessionID, slot.providerID))
    if (expected === undefined) return
    const observed = Hash.auth(headers)
    if (expected === null && observed.length > 0) brokenSwap(slot, sessionID, "foreign_credential")
    if (expected !== null && (observed.length !== 1 || observed[0]?.hash !== expected))
      brokenSwap(slot, sessionID, observed.length === 0 ? "credential_dropped" : "credential_replaced")
    else if (expected !== null) judge(slot.providerID, "ok")
  }

  const addStripRule = async (slot: Slots.SlotInfo, sessionID: string, pattern: string) => {
    const dropBefore = shaped.get(keyOf(sessionID, slot.providerID))
    if (!dropBefore) {
      log.warn("strip_rule_skipped", { providerID: slot.providerID, pattern, reason: "no_shaped_request" })
      return
    }
    const added = await strips.add(sessionID, {
      providerID: slot.providerID,
      dropBefore,
      kinds: ["reasoning.encrypted", "thinking.signature", "item.id"],
      until: "next-compaction",
    })
    if (added) log.warn("strip_rule_added", { providerID: slot.providerID, accountID: slot.account.id, pattern })
  }

  /**
   * Anthropic cache hints (02 §4.5). Manual hints only where core's auto policy cannot place them. OpenRouter needs
   * none: from upstream 74dbc509d7 the auto policy places tools, system and tail breakpoints on its `anthropic/` models
   * (`ai/src/cache-policy.ts` gatewayPolicy), which own once did by hand (R15, AC-P31).
   */
  const hints = async (event: SessionContext, slot: Slots.SlotInfo) => {
    if (slot.kind !== "anth") return
    const stored: unknown = await deps.ctx.storage
      .get(Kv.cache(event.sessionID, slot.providerID))
      .catch(() => undefined)
    const entry = Option.getOrUndefined(decodeCacheEntry(stored))
    const threshold = deps.runtime.policy.cached()?.thresholds.anthropicWatermarkBlocks ?? DEFAULT_WATERMARK_BLOCKS
    if (!entry?.watermark || entry.blocksSince < threshold) return
    const watermark = entry.watermark
    const completed = event.messages.findIndex((message) => message.id === watermark.messageID)
    if (completed < 0) return
    // Telemetry records the completed assistant message. Only the preceding request input was cached;
    // its new assistant output (often a thinking block) cannot be a breakpoint for that previous request.
    const index =
      event.messages[completed]?.role === "assistant" ? Shape.tailIndex(event.messages.slice(0, completed)) : completed
    if (index < 0) return
    Shape.addHints(event.system, event.messages, [
      { type: "message", index, ...(index === completed ? { part: watermark.partIndex } : {}) },
      { type: "message", index: Shape.tailIndex(event.messages) },
    ])
  }

  /**
   * D10 runtime detection (02 §4.3, §7.7): a primary request whose tool definitions or system differ from the previous
   * primary request of the same session, slot, model and agent raises `toolset_changed` (info). The `context`,
   * `compaction` and `generate` hooks share one event shape, so `onRequestShape` leaves the hashes and the
   * `model.request` that follows it (it carries the kind) settles them. Compaction and generate requests never
   * compare; a compaction request forgets the session's baselines, because the compaction it starts moves the
   * instruction epoch the system renders (before the `compaction.ended` event can arrive).
   */
  const settleToolset = (event: SessionModelRequest) => {
    if (event.kind === "title") return
    const key = toolsetKey(event)
    const next = unsettled.get(key)
    unsettled.delete(key)
    if (event.kind === "compaction") return forgetToolsets(event.sessionID)
    if (event.kind !== "primary" || !next) return
    const previous = baselines.get(key)
    remember(baselines, key, next)
    const parts = previous ? Toolset.changed(previous, next) : []
    if (parts.length === 0) return
    remember(toolsetChanges, event.sessionID, deps.clock.now())
    const model = event.model
    peers().telemetry.alert({
      code: "toolset_changed",
      severity: "info",
      sessionID: event.sessionID,
      subject: [model.providerID, model.id, event.agent, ...parts].join("|"),
      fields: { providerID: model.providerID, modelID: model.id, agent: event.agent, changed: parts.join(",") },
      message:
        `The request's ${parts.join(" and ")} changed mid-session on ${model.providerID} ` +
        `(${model.id}, agent ${event.agent}), so the cached prefix is written again.`,
    })
  }

  const forgetToolsets = (sessionID: string) => {
    const prefix = keyOf(sessionID, "")
    for (const key of [...baselines.keys()].filter((item) => item.startsWith(prefix))) baselines.delete(key)
  }

  return {
    start: async () => {
      stops.push(deps.runtime.broadcast.on("auth.swap", (change) => remember(swaps, change.providerID, change.verdict)))
    },
    stop: async () => {
      for (const stop of stops.splice(0)) stop()
    },

    onEvent: async (event, meta) => {
      if (!meta.local) return
      prefixes.onEvent(event, meta.reset)
      // A committed revert clears the instruction epoch, so the next request renders another system (D10 baseline).
      if (event.type === "session.revert.committed") forgetToolsets(event.data.sessionID)
      // A context reset moves the epoch: the system renders the instruction values of that moment (11 §7).
      if (meta.reset?.kind === "reset") forgetToolsets(meta.reset.sessionID)
      if (event.type === "session.compaction.ended") await strips.clear(event.data.sessionID)
    },

    settle: (event) => {
      settleToolset(event)
      prefixes.settle(event)
    },

    onModelRequest: async (event) => {
      const slot = peers().slots.slot(event.model.providerID)
      if (!slot) return
      const key = keyOf(event.sessionID, slot.providerID)
      remember(injections, key, null)
      // Own slots carry only the credential injected here: whatever is already on the request is dropped first,
      // so every failure below fails closed (401) instead of sending someone else's credential. Token sharing takes
      // no Codex account or originator header, so a siwc request loses those and any session header already on it:
      // its session headers come from the session alone (below).
      for (const name of Object.keys(event.headers))
        if (AUTH_HEADERS.has(name.toLowerCase()) || (slot.kind === "siwc" && sharingDropped(name)))
          delete event.headers[name]
      // Right after boot the allowlist is not checked yet; wait for that first check instead of failing the first
      // request (bounded, still fail closed).
      const trust = peers().plugins.trustStatus() === "ok" ? "ok" : await peers().plugins.trustSettled()
      if (trust !== "ok") {
        throttled(`blocked:${slot.providerID}`, () =>
          log.warn("auth_blocked_by_plugin", { providerID: slot.providerID, directory: deps.location.directory }),
        )
        return
      }
      if (slot.retired || slot.account.status === "disabled") {
        throttled(`unusable:${slot.providerID}`, () =>
          log.warn("auth_slot_unusable", { providerID: slot.providerID, status: slot.account.status }),
        )
        return
      }
      const started = performance.now()
      const auth = await peers()
        .logins.headers(slot.account, event.sessionID)
        .catch(() => ({ ok: false as const, problem: "vault_unavailable" as const, detail: "headers_threw" }))
      // The first request per account after a service start may wait for the vault helper (Health warms it up after
      // VAULT_WARM_MS); this line is how that wait is compared on a real install.
      log.debug("auth_headers", {
        providerID: slot.providerID,
        ok: auth.ok,
        latencyMs: Math.round(performance.now() - started),
      })
      if (!auth.ok) {
        // Fail closed: no header, the provider answers 401 and the retry hook records T-AUTH (02 §4.1 "실패 처리").
        throttled(`missing:${slot.providerID}:${auth.problem}`, () =>
          log.warn("auth_missing", {
            providerID: slot.providerID,
            accountID: slot.account.id,
            kind: event.kind,
            problem: auth.problem,
            detail: auth.detail,
          }),
        )
        return
      }
      const names = new Set(Object.keys(auth.headers).map((name) => name.toLowerCase()))
      for (const name of Object.keys(event.headers)) if (names.has(name.toLowerCase())) delete event.headers[name]
      Object.assign(event.headers, auth.headers)
      // ChatGPT routes its prompt cache on `session-id`, so like upstream's `openai` (1fc05ca590) and token-sharing
      // `chatgpt` (5183ea45c3) plugins a child sends its parent's and a fork its source's: core's `x-session-affinity`
      // (`SessionAffinity.get`), which `prompt_cache_key` comes from too. Token sharing also takes the Codex client's
      // `thread-id` and `x-client-request-id`, both the session's own id as upstream sends them.
      const affinity = event.headers["x-session-affinity"] ?? event.sessionID
      if (slot.kind === "codex") event.headers["session-id"] = affinity
      if (slot.kind === "siwc")
        Object.assign(event.headers, {
          "session-id": affinity,
          "thread-id": event.sessionID,
          "x-client-request-id": event.sessionID,
        })
      // A local model added without a key (02 §3.3a) sends no credential: the check then expects none.
      remember(injections, key, Object.keys(auth.headers).length === 0 ? null : auth.hash)
    },

    onRequestShape: async (event, hook = "context") => {
      const slot = peers().slots.slot(event.model.providerID)
      if (!slot) return
      // 02 §3.3: a compat model registered without tools chats without them. Core sends every tool whatever the model's
      // `capabilities.tools`, and a server such as Ollama refuses a request with tools for a model that has none.
      if (slot.kind === "compat" && peers().slots.model(slot.providerID, event.model.id)?.capabilities.tools === false)
        event.tools = {}
      if (slot.kind === "compat" && slot.account.compat?.server?.family === "ollama")
        event.messages = Shape.ollamaImages(event.messages)
      if (slot.kind === "siwc") {
        const removed = Shape.stripSharingOptions(event.options)
        if (removed.length > 0) log.debug("sharing_options_stripped", { providerID: slot.providerID, removed })
        const messages = Shape.withoutEffortUpdates(event.messages)
        if (messages.length !== event.messages.length) {
          log.debug("sharing_effort_updates_dropped", {
            providerID: slot.providerID,
            count: event.messages.length - messages.length,
          })
          event.messages = messages
        }
      }
      // From upstream d9987ef9c8 core puts a default output limit on primary and compaction requests and leaves it out
      // for the `openai` provider only (`plugin/provider/openai.ts` omitOutputLimit, a `context` and `compaction`
      // hook); own slots of those routes match, and OpenRouter slots go without one as they did before. A limit a
      // `generate` caller set is its own and stays.
      const limited = hook !== "generate"
      if (limited && NO_OUTPUT_LIMIT.has(slot.kind)) delete event.options.maxTokens
      // `none` is the only DeepSeek variant with thinking off (`core/src/variant.ts` deepseekChat). A limit already set,
      // such as core's own from upstream d9987ef9c8, wins; none is left when the user's output limit says
      // `보내지 않기` (02 §4.9), and then this one is fitted to the model's limit and the room the prompt leaves, as core
      // fits its own. Generation options never enter the prompt bytes.
      if (limited && slot.kind === "ds" && event.model.variant === "none" && event.options.maxTokens === undefined)
        event.options.maxTokens = Math.min(DS_THINKING_OFF_OUTPUT, event.outputCeiling ?? DS_THINKING_OFF_OUTPUT)
      const identity = Shape.normalizeIdentity(event.system, slot.providerID, slot.canonical)
      if (identity === "missing")
        alertOnce("identity_format_changed", {
          code: "identity_format_changed",
          severity: "warning",
          sessionID: event.sessionID,
          message: "The built-in identity block changed shape; own slots of one cache domain no longer share a prefix.",
        })
      const rules = await strips.get(event.sessionID)
      const stripped = rules.length > 0 && Shape.applyStrip(event.messages, rules, slot.providerID)
      if (stripped) log.debug("strip_applied", { providerID: slot.providerID })
      await hints(event, slot)
      const newest = Shape.newestMessageID(event.messages)
      if (newest) remember(shaped, keyOf(event.sessionID, slot.providerID), newest)
      remember(unsettled, toolsetKey(event), Toolset.fingerprint(event))
      // Last, so nothing it does can hold back the shaping above; it folds the cache hints out by name.
      prefixes.shaped(event, { accountID: slot.account.id, strip: stripped ? rules : [] })
    },

    authSwap: (providerID) => swaps.get(providerID) ?? "unknown",

    toolsetChangedAt: (sessionID) => toolsetChanges.get(sessionID),

    onHttpResponse: async (event) => {
      const slot = peers().slots.slot(event.model.providerID)
      if (!slot) return
      checkSwap(slot, event.sessionID, event.request.headers)
      if (event.response.status < 400) return
      const head = await readHead(event.response.clone(), ERROR_HEAD_CHARS).catch(() => "")
      const pattern = Shape.stripPattern(head)
      if (pattern) await addStripRule(slot, event.sessionID, pattern)
    },

    onWsHandshake: async (event) => {
      const slot = peers().slots.slot(event.model.providerID)
      if (slot) checkSwap(slot, event.sessionID, event.headers)
    },

    onRetry: (event) => {
      if (event.decision.retry) return
      const slot = peers().slots.slot(event.model.providerID)
      if (slot?.kind !== "siwc") return
      const text = `${event.error.response?.body ?? ""}\n${event.error.message}`
      if (!text.includes(UNSUPPORTED_CAPABILITY)) return
      const param = /"param"\s*:\s*"([^"]{1,64})"/.exec(text)?.[1] ?? "unknown"
      peers().telemetry.alert({
        code: "sharing_unsupported_input",
        severity: "error",
        sessionID: event.sessionID,
        accountID: slot.account.id,
        subject: `${slot.providerID}|${event.model.id}|${param}`,
        fields: { providerID: slot.providerID, modelID: event.model.id, param },
        message:
          `이 대화에는 ChatGPT 구독 공유가 지원하지 않는 항목(${PARAM_LABELS[param] ?? param})이 있습니다. ` +
          "다른 계정으로 바꾸거나 이 항목을 빼고 다시 시도하세요.",
      })
    },

    onWsReceive: async (event) => {
      const frame = event.frame
      if (!ERROR_FRAMES.some((needle) => frame.includes(needle))) return
      const slot = peers().slots.slot(event.model.providerID)
      if (!slot) return
      const pattern = Shape.stripPattern(frame.slice(0, ERROR_HEAD_CHARS))
      if (pattern) await addStripRule(slot, event.sessionID, pattern)
    },
  }
}

const DEFAULT_WATERMARK_BLOCKS = 15

/** The token-sharing error code of a request the route does not support (02 §3.2c). */
const UNSUPPORTED_CAPABILITY = "subscription_sharing_unsupported_capability"
/** What the error's `param` names, for the `sharing_unsupported_input` message. */
const PARAM_LABELS: Readonly<Record<string, string>> = {
  input: "대화 기록의 입력 항목",
  tools: "도구 정의",
  service_tier: "속도 설정",
  unknown: "알 수 없는 기능",
}

function keyOf(sessionID: string, providerID: string) {
  return `${sessionID}\u0000${providerID}`
}

/** D10 key (02 §4.3): session, slot, model and agent, so a model or agent change starts another baseline. */
function toolsetKey(event: Pick<SessionModelRequest, "sessionID" | "model" | "agent">) {
  return `${keyOf(event.sessionID, event.model.providerID)}\u0000${event.model.id}\u0000${event.agent}`
}

/**
 * Headers a siwc request drops before injection (02 §3.2c): the Codex route's own (`chatgpt-account-id`, `originator`,
 * `x-codex-*`) and, in any case, the session headers own-accounts sets itself ({@link SHARING_SESSION_HEADERS}).
 */
function sharingDropped(name: string) {
  const lower = name.toLowerCase()
  return CODEX_HEADERS.has(lower) || SHARING_SESSION_HEADERS.has(lower) || lower.startsWith("x-codex-")
}

/** Insertion-ordered bounded map write: the entry moves to the end and the oldest one goes past the bound. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size <= MEMORY_KEYS) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

/** The first `limit` characters of a response body; stops reading there. Read-only on a clone. */
async function readHead(response: Response, limit: number) {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  const read = async (text: string): Promise<string> => {
    if (text.length >= limit) return text
    const chunk = await reader.read()
    if (chunk.done) return text
    return read(text + decoder.decode(chunk.value, { stream: true }))
  }
  const text = await read("")
  await reader.cancel().catch(() => undefined)
  return text.slice(0, limit)
}

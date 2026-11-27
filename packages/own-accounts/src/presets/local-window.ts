export * as LocalWindow from "./local-window.js"

import { Option, Schema } from "effect"
import type { Account } from "@own/protocol"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { ServiceTarget } from "@own/runtime"
import type { Clock } from "../clock.js"
import type { Logger } from "../logger.js"
import type { Module } from "../module.js"
import { CompatProbe } from "../slots/compat-probe.js"
import { Tracker } from "../switching/tracker.js"
import type { Telemetry } from "../telemetry/telemetry.js"

/**
 * The running context window of a local LLM server (07 §6.2 #8, PG9). Upstream registers an Ollama model with its
 * trained maximum (`model_info.*.context_length`) and never sends `num_ctx` (`core/src/plugin/provider/ollama.ts`), so
 * a server that runs the model with a smaller window silently cuts the system prompt and tools; no overflow error
 * comes back and core never recovers. This reads the window the server runs (or will run) each model with, on the
 * discovery cadence, and judges it against what a request needs. Only a `verified` model may be suggested (07 §3.4).
 * The registered window itself is never changed (R8).
 */

/** Upstream's local discovery cadence (`core/src/plugin/provider/{ollama,lmstudio}.ts` `interval`). */
export const INTERVAL_MS = 30_000
/** First-step request sizes kept for {@link needed}. */
const SAMPLES = 20
/** Sessions whose first step is still awaited. */
const FRESH_MAX = 1_000

/** Where a server's running windows come from. */
export type Source =
  /** Ollama: the loaded model in `/api/ps`, else the model's `num_ctx`, else `OLLAMA_CONTEXT_LENGTH`. */
  | {
      readonly type: "ollama"
      /** The OpenAI-compatible base URL (`…/v1`). */
      readonly baseURL: string
      readonly headers: () => Promise<Readonly<Record<string, string>>>
    }
  /** The registered window already is the running one (LM Studio's loaded `context_length`, 07 §4.1). */
  | { readonly type: "registered" }

/** One local server and the models it serves, as the provider fold (or the registry, for a compat slot) knows them. */
export interface Target {
  readonly providerID: string
  readonly source: Source
  readonly models: ReadonlyArray<{
    readonly id: string
    readonly tools: boolean
    /** The registered window. */
    readonly window: number
  }>
  /** The own account behind a compat slot, for the alert. */
  readonly accountID?: string
}

export interface Input {
  readonly clock: Clock.Clock
  readonly log: Logger.Logger
  /** The local servers to watch now; read at every poll and lookup (no I/O). */
  readonly targets: () => ReadonlyArray<Target>
  /** Core `keep` (K): the room a request needs beyond system and tools. */
  readonly keep: () => number
  readonly alert: (alert: Telemetry.AlertInput) => void
  /** `OLLAMA_CONTEXT_LENGTH` of this process's environment; used only for a server on this PC. */
  readonly ollamaContextLength?: number
}

export interface Api {
  /** A local model's running window, what a request needs, and whether it fits; `undefined` for any other model. */
  get(providerID: string, modelID: string): Account.LocalWindow | undefined
  /** Learns the request size from the first step of new sessions own.import did not write. */
  observe(event: Module.OpenCodeEvent): void
  /** Reads every Ollama target once now (single flight) and raises `local_window_unverified` once per model. */
  poll(): Promise<void>
  /** Polls now and then every {@link INTERVAL_MS}. */
  start(): void
  stop(): Promise<void>
}

const decodePs = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          model: Schema.optionalKey(Schema.String),
          context_length: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        }),
      ),
    }),
  ),
)
const decodeTags = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ models: Schema.Array(Schema.Struct({ name: Schema.String, digest: Schema.String })) }),
  ),
)

export function create(input: Input): Api {
  const readings = new Map<string, number | null>()
  /** Ollama `num_ctx` per server and model, kept while the model's digest stays the same. */
  const shows = new Map<string, { readonly digest: string; readonly numCtx: number | undefined }>()
  const alerted = new Set<string>()
  const fresh = new Set<string>()
  const samples: number[] = []
  const state = {
    started: false,
    stopped: false,
    cancel: undefined as (() => void) | undefined,
    running: undefined as Promise<void> | undefined,
    controller: new AbortController(),
  }

  const required = () => needed(samples, input.keep())

  const runtimeOf = (target: Target, model: Target["models"][number]) =>
    target.source.type === "registered"
      ? (positive(model.window) ?? null)
      : (readings.get(key(target.providerID, model.id)) ?? null)

  const get = (providerID: string, modelID: string) => {
    const target = input.targets().find((item) => item.providerID === providerID)
    const model = target?.models.find((item) => item.id === modelID)
    if (!target || !model) return undefined
    return judge(runtimeOf(target, model), required())
  }

  const read = async (target: Target, source: Extract<Source, { type: "ollama" }>) => {
    const base = CompatProbe.root(source.baseURL)
    if (!base) return
    const signal = state.controller.signal
    const headers = await source.headers()
    const [ps, tags] = await Promise.all([
      CompatProbe.request(`${base}/api/ps`, { headers, signal }),
      CompatProbe.request(`${base}/api/tags`, { headers, signal }),
    ])
    const loaded = Option.getOrUndefined(decodePs(ps))
    // An older Ollama without `/api/ps`, or a server that is down: keep what was read before.
    if (!loaded) return
    const running = new Map(
      loaded.models.flatMap((item): Array<[string, number]> => {
        const context = positive(item.context_length)
        return context === undefined ? [] : [item.name, item.model ?? item.name].map((name) => [tagged(name), context])
      }),
    )
    const digests = new Map(
      Option.getOrUndefined(decodeTags(tags))?.models.map((item) => [tagged(item.name), item.digest]),
    )
    const env = onThisPC(base) ? input.ollamaContextLength : undefined
    await Promise.all(
      target.models.map(async (model) => {
        const name = tagged(model.id)
        const configured = running.has(name) ? undefined : await numCtx(base, model.id, digests.get(name), headers)
        readings.set(key(target.providerID, model.id), running.get(name) ?? configured ?? env ?? null)
      }),
    )
  }

  /** The model's `num_ctx`, fetched again only when its digest changed (like upstream's discovery). */
  const numCtx = async (
    base: string,
    model: string,
    digest: string | undefined,
    headers: Readonly<Record<string, string>>,
  ) => {
    const cacheKey = key(base, tagged(model))
    const cached = shows.get(cacheKey)
    if (cached && digest !== undefined && cached.digest === digest) return cached.numCtx
    const value = await CompatProbe.parameter(base, model, "num_ctx", { headers, signal: state.controller.signal })
    if (digest !== undefined) shows.set(cacheKey, { digest, numCtx: value })
    return value
  }

  /** `local_window_unverified` once per tool-capable model the server was read for and that does not fit. */
  const warn = (target: Target) => {
    const need = required()
    const known = (id: string) => target.source.type === "registered" || readings.has(id)
    target.models
      .map((model) => ({ model, id: key(target.providerID, model.id) }))
      .filter((entry) => entry.model.tools && known(entry.id) && !alerted.has(entry.id))
      .map((entry) => ({ ...entry, window: judge(runtimeOf(target, entry.model), need) }))
      .filter((entry) => entry.window.status !== "verified")
      .forEach((entry) => {
        alerted.add(entry.id)
        input.alert({
          code: "local_window_unverified",
          severity: "info",
          message: message(target, entry.model.id, entry.window),
          subject: `${target.providerID}/${entry.model.id}`,
          ...(target.accountID === undefined ? {} : { accountID: target.accountID }),
        })
      })
  }

  const round = async () => {
    for (const target of input.targets()) {
      const source = target.source
      if (source.type === "ollama")
        await read(target, source).catch((error: unknown) =>
          input.log.warn("local_window_unreadable", { providerID: target.providerID, error }),
        )
      if (!state.stopped) warn(target)
    }
  }

  const poll = () => {
    state.running ??= round()
      .catch((error: unknown) => input.log.warn("local_window_poll_failed", { error }))
      .finally(() => {
        state.running = undefined
      })
    return state.running
  }

  const loop = () => {
    if (state.stopped) return
    state.cancel = input.clock.schedule(INTERVAL_MS, () => void poll().finally(loop))
  }

  return {
    get,
    observe: (event) => {
      // An own.import session's first step carries the imported history, not one request's system and tools (09 §4.2).
      if (event.type === "session.created" && !OwnImportRouting.marked(event.data.metadata)) {
        fresh.add(event.data.sessionID)
        if (fresh.size > FRESH_MAX) fresh.delete(fresh.values().next().value ?? "")
      }
      if (event.type === "session.deleted") fresh.delete(event.data.sessionID)
      if (event.type !== "session.step.ended" || !fresh.delete(event.data.sessionID)) return
      const tokens = event.data.tokens
      samples.push(tokens.input + tokens.cache.read + tokens.cache.write)
      if (samples.length > SAMPLES) samples.shift()
    },
    poll,
    start: () => {
      if (state.started || state.stopped) return
      state.started = true
      void poll()
      loop()
    },
    stop: async () => {
      state.stopped = true
      state.cancel?.()
      state.controller.abort()
      await state.running
    },
  }
}

/**
 * What a request to a local model needs (07 §6.2 #8): system and tools (`Z`, the median first-step request of recent
 * sessions, never below the 02 §6.4 default) plus core's `keep`, the room it keeps for the conversation itself.
 */
export function needed(samples: ReadonlyArray<number>, keep: number) {
  const sorted = samples.toSorted((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  return Math.ceil(Math.max(Tracker.DEFAULTS.Z, median)) + keep
}

/** `verified` only when the running window holds what a request needs; `unknown` while the server has not said. */
export function judge(runtime: number | null, needed: number): Account.LocalWindow {
  return {
    runtime,
    needed,
    status: runtime === null ? "unknown" : runtime >= needed ? "verified" : "unverified",
  }
}

/** Ollama names a model without a tag `:latest`. */
function tagged(name: string) {
  return name.includes(":") ? name : `${name}:latest`
}

function key(scope: string, modelID: string) {
  return `${scope}\u0000${modelID}`
}

/** Whether a server runs on this PC, so this process's `OLLAMA_CONTEXT_LENGTH` is likely the server's too. */
export function onThisPC(base: string) {
  const host = new URL(base).hostname
  return host === "localhost" || ServiceTarget.isLoopback(host)
}

function positive(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}

function message(target: Target, modelID: string, window: Account.LocalWindow) {
  const raise =
    target.source.type === "ollama"
      ? "Ollama를 OLLAMA_CONTEXT_LENGTH로 다시 시작하거나 모델의 num_ctx를 올리면 늘어납니다."
      : "서버에서 더 큰 창으로 모델을 다시 불러오면 늘어납니다."
  if (window.runtime === null)
    return `로컬 모델 ${modelID}의 실행 창을 확인하지 못해 하위 에이전트로 제안하지 않습니다. 모델을 한 번 불러오거나 num_ctx를 정하면 확인됩니다.`
  return `로컬 모델 ${modelID}의 실행 창(${count(window.runtime)} 토큰)이 요청에 필요한 ${count(window.needed)} 토큰보다 작아 하위 에이전트로 제안하지 않습니다. ${raise}`
}

function count(value: number) {
  return value.toLocaleString("en-US")
}

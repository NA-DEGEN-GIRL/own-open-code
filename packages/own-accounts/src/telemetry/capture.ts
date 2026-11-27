export * as Capture from "./capture.js"

import fs from "node:fs/promises"
import path from "node:path"
import type {
  SessionHttpResponse,
  SessionRequestKind,
  SessionRetry,
  SessionWebSocketHandshake,
  SessionWebSocketReceive,
} from "@opencode/plugin/promise/session"
import { Hash, Lock, Redact, Wiretap } from "@own/runtime"
import { OwnAccounts, OwnID } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { RpcTypes } from "../rpc/types.js"
import type { Slots } from "../slots/slots.js"
import type { Telemetry } from "./telemetry.js"

/**
 * Opt-in wire evidence capture (P0-3a, 02 §7.8) for the real-account gates G7 and G8 (`own/scripts/gates/g7.ts`,
 * `g8.ts`). Off by default: while no window runs, the `http.response`, `experimental.ws.*` and `retry` hooks it shares
 * with telemetry only read one field, never clone a body and register nothing of their own.
 *
 * A window (`diagnostics.capture.start`, at most a day) records own-slot traffic of its sessions and slots: every
 * response header name with the status (the census `LastResponse` cannot give, it keeps an allowlist), the shape or
 * hash of error bodies (`Wiretap.shape`), WebSocket frames and stream events (each structure once, limit, error and
 * usage events every time), WebSocket handshake header names, and the retry hook's verdicts. Lines carry the request
 * `kind` and `transport`, go through `Redact.value`, and land owner-only in
 * `<OWN_HOME>\diagnostics\captures\<YYYY-MM-DD>\<sessionID>.jsonl`, kept {@link RETENTION_DAYS} days; each window's
 * summary (counts per frame type) goes to `windows.jsonl` of its day. A window that ends with nothing recorded raises
 * `capture_empty`.
 *
 * Hooks run in each Location's instance while the RPC runs in the control location, so the window lives in a
 * process singleton of the build (`globalThis`, like the runtime, 01 §4). The instance that started a window owns
 * its timer and step counter and ends it as `shutdown` when it stops.
 */

/** Days a capture folder is kept. */
export const RETENTION_DAYS = 7
/** Lines one window writes at most; later ones are counted as `dropped`. */
export const MAX_RECORDS = 5_000
/** Characters of an error body read for its shape. */
export const BODY_CHARS = 64 * 1024
/** An error body must arrive within this (as telemetry's own error-body read). */
export const BODY_TIMEOUT_MS = 2_000
/** A captured stream is read in the background at most this long. */
export const STREAM_TIMEOUT_MS = 5 * 60_000
/** Larger frames and stream events are counted by type only. */
export const MAX_EVENT_CHARS = 1_000_000
/** Shapes one stream line keeps at most. */
export const MAX_STREAM_SHAPES = 50
/** `diagnostics.capture.stop` waits this long for reads of the window still running; later lines are lost. */
export const SETTLE_MS = 2_000
/** Frame and event types written every time (limits, errors, usage); any other type once per structure. */
export const WATCH: ReadonlySet<string> = new Set([
  "error",
  "response.failed",
  "response.incomplete",
  "response.completed",
  "response.done",
  "codex.rate_limits",
])

export interface Api {
  /** Read-only. Census and, for an error, the body's shape; an event stream is read from a clone in the background. */
  onHttpResponse(event: SessionHttpResponse): void
  /** Read-only. The header names the WebSocket handshake carries (WS responses have no header hook). */
  onWsHandshake(event: SessionWebSocketHandshake): void
  /** Read-only; never changes the frame. */
  onWsReceive(event: SessionWebSocketReceive): void
  /** The retry hook's error (type and status, never the message) and telemetry's verdict. */
  onRetry(event: SessionRetry, verdict: Telemetry.Verdict): void
  start: RpcTypes.Handler<"diagnostics.capture.start">
  stop: RpcTypes.Handler<"diagnostics.capture.stop">
  status: RpcTypes.Handler<"diagnostics.capture.status">
  /**
   * Whether a running window records this session and slot (its filters only; the caller knows the slot is its own).
   * Ends a window past its time first, as the RPCs do.
   */
  recording(sessionID: string, providerID: string): boolean
  /** Deletes capture folders older than {@link RETENTION_DAYS}. */
  maintain(): Promise<void>
  /** Plugin cleanup: ends a window this instance started (`shutdown`, no alert) and detaches. */
  close(): Promise<void>
}

export interface Input {
  readonly slot: (providerID: string) => Slots.SlotInfo | undefined
  readonly alert: (input: Telemetry.AlertInput) => void
  /** Telemetry's background set, so `telemetry.flush()` waits for capture reads and writes too. */
  readonly track: <A>(promise: Promise<A>) => Promise<A>
}

type Transport = "http" | "ws"

interface Window {
  readonly id: string
  readonly mode: OwnAccounts.CaptureMode
  readonly startedAt: number
  readonly until: number
  readonly sessionID: OwnAccounts.CaptureWindow["sessionID"]
  readonly providerIDs: OwnAccounts.CaptureWindow["providerIDs"]
  records: number
  dropped: number
  steps: number
  endedAt: number | null
  end: OwnAccounts.CaptureEnd | null
  /** Relative to the capture folder, `/`-separated. */
  readonly files: Set<string>
  /** Frame and event structures written once: `<providerID>|<kind>|<transport>|<type>|<structure>`. */
  readonly seen: Set<string>
  /** Frames and stream events per `<providerID>|<kind>|<transport>|<type>`. */
  readonly counts: Map<string, number>
  /** Reads and writes of this window still running. */
  readonly pending: Set<Promise<unknown>>
  /** Cancels the expiry timer and the step counter of the starting instance. */
  readonly release: () => void
}

interface Shared {
  /** The running window, else the last one. */
  current: Window | undefined
  readonly mutex: Lock.Mutex
  holders: number
}

/** The base of every line: who sent the request and how. */
interface Envelope {
  readonly sessionID: string
  readonly providerID: string
  readonly modelID: string
  readonly accountID: string | null
  readonly accountKind: string | null
  readonly kind: SessionRequestKind | null
  readonly transport: Transport | null
}

export function key(buildId: string) {
  return Symbol.for(`own-open-code.accounts-capture/${buildId}`)
}

export function create(deps: Deps, input: Input): Api {
  const log = deps.log.child("capture")
  const dir = path.join(deps.runtime.layout.root, "diagnostics", "captures")
  const shared = attach(deps.runtime.buildId)
  const owned = new Set<Window>()
  const closed = { value: false }

  /** The window that records this request, if any: a property read when none runs. */
  const active = (sessionID: string, providerID: string) => {
    const window = shared.current
    if (window === undefined || window.end !== null || deps.clock.now() >= window.until) return undefined
    if (window.sessionID !== null && window.sessionID !== sessionID) return undefined
    if (window.providerIDs !== null && !window.providerIDs.some((id) => id === providerID)) return undefined
    return input.slot(providerID) ? window : undefined
  }

  const envelope = (
    event: { readonly sessionID: string; readonly model: { readonly providerID: string; readonly id: string } },
    kind: SessionRequestKind | null,
    transport: Transport | null,
  ): Envelope => {
    const info = input.slot(event.model.providerID)
    return {
      sessionID: event.sessionID,
      providerID: event.model.providerID,
      modelID: event.model.id,
      accountID: info?.account.id ?? null,
      accountKind: info?.kind ?? null,
      kind,
      transport,
    }
  }

  const later = (window: Window, work: Promise<unknown>) => {
    window.pending.add(work)
    void input.track(work.finally(() => window.pending.delete(work)))
  }

  const write = (window: Window, base: Envelope, payload: Readonly<Record<string, unknown>>) => {
    if (window.end !== null) return
    if (window.records >= MAX_RECORDS) {
      window.dropped += 1
      return
    }
    window.records += 1
    const now = deps.clock.now()
    const relative = `${day(now)}/${fileName(base.sessionID)}.jsonl`
    window.files.add(relative)
    const line = JSON.stringify(Redact.value({ v: 1, capture: window.id, ts: now, ...base, ...payload }))
    later(window, append(relative, line))
  }

  const append = (relative: string, line: string) =>
    shared.mutex
      .run(async () => {
        const file = path.join(dir, ...relative.split("/"))
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await fs.appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600 })
      })
      .catch((error: unknown) => log.warn("capture_write_failed", { error }))

  /** A frame or stream event worth a line: limit, error and usage events always, others once per structure. */
  const worth = (window: Window, slot: string, type: string, json: Readonly<Record<string, unknown>>) => {
    if (WATCH.has(type) || record(json.usage) !== undefined || (json.error !== undefined && json.error !== null))
      return true
    const seen = `${slot}|${type}|${Wiretap.structure(json)}`
    if (window.seen.has(seen)) return false
    window.seen.add(seen)
    return true
  }

  const evidence = (window: Window, type: string, json: Readonly<Record<string, unknown>>) => {
    const essentials = Wiretap.essentials(json)
    return {
      type,
      structure: Wiretap.structure(json),
      hash: Wiretap.hash(essentials),
      ...(window.mode === "shape" ? { shape: Wiretap.shape(essentials) } : {}),
    }
  }

  const count = (window: Window, slot: string, type: string) => {
    const name = `${slot}|${type}`
    window.counts.set(name, (window.counts.get(name) ?? 0) + 1)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Hooks

  const onHttpResponse = (event: SessionHttpResponse) => {
    const window = active(event.sessionID, event.model.providerID)
    if (!window) return
    const response = event.response
    const census = Wiretap.census(response.headers)
    const base = envelope(event, event.kind, "http")
    const contentType = response.headers.get("content-type")
    const head = {
      event: "response",
      status: response.status,
      url: where(event.request.url),
      contentType,
      names: census.names,
      ...(window.mode === "shape" ? { values: census.values } : {}),
      authHash8: Hash.auth(event.request.headers)[0]?.hash ?? null,
    }
    if (response.status >= 400) {
      const clone = response.clone()
      later(
        window,
        bodyText(clone).then((text) =>
          write(window, base, { ...head, body: text === null ? null : body(window, text) }),
        ),
      )
      return
    }
    write(window, base, head)
    if (!contentType?.includes("text/event-stream")) return
    later(window, stream(window, base, response.clone()))
  }

  /** One `stream` line when the clone ends: event types, and the shapes of new structures and watched events. */
  const stream = async (window: Window, base: Envelope, clone: Response) => {
    const body = clone.body
    if (!body) return
    const reader = body.pipeThrough(new TextDecoderStream()).getReader()
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), STREAM_TIMEOUT_MS)
    timer.unref?.()
    const slot = `${base.providerID}|${base.kind}|http`
    const state = { buffer: "", events: 0, oversized: 0 }
    const types = new Map<string, number>()
    const shapes: Array<ReturnType<typeof evidence>> = []
    const observe = (item: Wiretap.ServerEvent) => {
      if (item.data === "[DONE]") return
      state.events += 1
      const json = item.data.length > MAX_EVENT_CHARS ? undefined : record(Wiretap.parse(item.data))
      const type = json ? typeOf(json, item.name) : (item.name ?? "<not-json>")
      types.set(type, (types.get(type) ?? 0) + 1)
      count(window, slot, type)
      if (!json) return
      if (worth(window, slot, type, json) && shapes.length < MAX_STREAM_SHAPES)
        shapes.push(evidence(window, type, json))
    }
    const pump = async (): Promise<void> => {
      const chunk = await reader.read()
      if (chunk.done) return
      const split = Wiretap.events(state.buffer + chunk.value)
      state.buffer = split.rest.length > MAX_EVENT_CHARS ? "" : split.rest
      if (split.rest.length > MAX_EVENT_CHARS) state.oversized += 1
      split.events.forEach(observe)
      return pump()
    }
    const complete = await pump().then(
      () => true,
      () => false,
    )
    clearTimeout(timer)
    if (complete) Wiretap.event(state.buffer).forEach(observe)
    write(window, base, {
      event: "stream",
      complete,
      events: state.events,
      types: Object.fromEntries(types),
      shapes,
      ...(state.oversized > 0 ? { oversized: state.oversized } : {}),
    })
  }

  const onWsHandshake = (event: SessionWebSocketHandshake) => {
    const window = active(event.sessionID, event.model.providerID)
    if (!window) return
    write(window, envelope(event, event.kind, "ws"), {
      event: "handshake",
      url: where(event.url),
      names: Wiretap.census(event.headers).names,
      authHash8: Hash.auth(event.headers)[0]?.hash ?? null,
    })
  }

  const onWsReceive = (event: SessionWebSocketReceive) => {
    const window = active(event.sessionID, event.model.providerID)
    if (!window) return
    const frame = event.frame
    const json = frame.length > MAX_EVENT_CHARS ? undefined : record(Wiretap.parse(frame))
    const type = json ? typeOf(json, undefined) : "<not-json>"
    const slot = `${event.model.providerID}|${event.kind}|ws`
    count(window, slot, type)
    if (!json || !worth(window, slot, type, json)) return
    write(window, envelope(event, event.kind, "ws"), { event: "frame", ...evidence(window, type, json) })
  }

  const onRetry = (event: SessionRetry, verdict: Telemetry.Verdict) => {
    const window = active(event.sessionID, event.model.providerID)
    if (!window) return
    write(window, envelope(event, null, null), {
      event: "retry",
      attempt: event.attempt,
      error: {
        type: event.error.type,
        ...(event.error.status === undefined ? {} : { status: event.error.status }),
        message: `<str:${event.error.message.length}>`,
      },
      verdict: verdict.class,
      decision: event.decision.retry ? "retry" : "stop",
    })
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Windows

  const view = (window: Window): OwnAccounts.CaptureWindow => ({
    id: window.id,
    mode: window.mode,
    startedAt: window.startedAt,
    until: window.until,
    endedAt: window.endedAt,
    end: window.end,
    sessionID: window.sessionID,
    providerIDs: window.providerIDs,
    records: window.records,
    dropped: window.dropped,
    steps: window.steps,
    dir,
    files: [...window.files].sort(),
  })

  const snapshot = (): OwnAccounts.CaptureStatus => {
    const window = shared.current
    return { active: window !== undefined && window.end === null, window: window === undefined ? null : view(window) }
  }

  /** Ends the running window: its summary line, and `capture_empty` when it recorded nothing (not at shutdown). */
  const finish = (end: OwnAccounts.CaptureEnd) => {
    const window = shared.current
    if (window === undefined || window.end !== null) return
    const now = deps.clock.now()
    window.release()
    window.end = end
    window.endedAt = now
    owned.delete(window)
    const summary = `${day(now)}/windows.jsonl`
    window.files.add(summary)
    const counts = [...window.counts].map((entry) => {
      const parts = entry[0].split("|")
      return {
        providerID: parts[0],
        kind: parts[1],
        transport: parts[2],
        type: parts.slice(3).join("|"),
        count: entry[1],
      }
    })
    later(window, append(summary, JSON.stringify(Redact.value({ v: 1, ...view(window), counts }))))
    log.info("capture_ended", { captureID: window.id, end, records: window.records, steps: window.steps })
    if (window.records > 0 || end === "shutdown") return
    input.alert({
      code: "capture_empty",
      severity: window.steps > 0 ? "warning" : "info",
      subject: window.id,
      fields: { captureID: window.id, steps: String(window.steps), mode: window.mode },
      message:
        window.steps > 0
          ? `증거 수집 창(${window.id})이 아무것도 기록하지 못했습니다. 그동안 own slot step ${window.steps}개가 돌았으므로 hook이 그 응답을 보지 못했습니다. 플러그인 차단과 hook 순서를 점검하세요.`
          : `증거 수집 창(${window.id})이 아무것도 기록하지 못했습니다. 그동안 own slot 요청이 없었습니다.`,
    })
  }

  /** A window past its time that no timer ended (its instance stopped): ended on the next RPC. */
  const expire = () => {
    const window = shared.current
    if (window && window.end === null && deps.clock.now() >= window.until) finish("expired")
  }

  const start: Api["start"] = async (request) => {
    await maintain()
    // From here to `shared.current = window` nothing awaits, so starts that overlap each end the window before them.
    expire()
    finish("replaced")
    const now = deps.clock.now()
    const until = now + (request.minutes ?? OwnAccounts.CAPTURE_DEFAULT_MINUTES) * 60_000
    const sessionID = request.sessionID ?? null
    const providerIDs = request.providerIDs ?? null
    const window: Window = {
      id: `cap_${OwnID.ulid(now)}`,
      mode: request.mode,
      startedAt: now,
      until,
      sessionID,
      providerIDs,
      records: 0,
      dropped: 0,
      steps: 0,
      endedAt: null,
      end: null,
      files: new Set(),
      seen: new Set(),
      counts: new Map(),
      pending: new Set(),
      release: () => {
        cancel()
        off()
      },
    }
    const cancel = deps.clock.schedule(until - now, () => {
      if (shared.current === window) finish("expired")
    })
    // Own-slot usage lines of the window's sessions and slots, from whichever instance wrote them.
    const off = deps.runtime.broadcast.on("ledger.line", (payload) => {
      const line = payload.line
      if (line.ts < window.startedAt || line.ts > window.until || !input.slot(line.providerID)) return
      if (sessionID !== null && line.sessionID !== sessionID) return
      if (providerIDs !== null && !providerIDs.some((id) => id === line.providerID)) return
      window.steps += 1
    })
    shared.current = window
    owned.add(window)
    log.info("capture_started", { captureID: window.id, mode: window.mode, until })
    return snapshot()
  }

  const stop: Api["stop"] = async () => {
    expire()
    const window = shared.current
    if (window && window.end === null) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS).unref?.())
      await Promise.race([Promise.allSettled([...window.pending]), timeout])
      finish("stopped")
    }
    // The summary line and every queued line are on disk before the answer.
    await shared.mutex.run(async () => {})
    return snapshot()
  }

  const status: Api["status"] = async () => {
    expire()
    return snapshot()
  }

  const recording: Api["recording"] = (sessionID, providerID) => {
    expire()
    const window = shared.current
    if (window === undefined || window.end !== null) return false
    return (
      (window.sessionID === null || window.sessionID === sessionID) &&
      (window.providerIDs === null || window.providerIDs.some((id) => id === providerID))
    )
  }

  const maintain = async () => {
    const cutoff = day(deps.clock.now() - RETENTION_DAYS * 86_400_000)
    const names = await fs.readdir(dir).catch(() => [])
    await Promise.all(
      names
        .filter((name) => DAY.test(name) && name < cutoff)
        .map((name) =>
          fs
            .rm(path.join(dir, name), { recursive: true, force: true })
            .catch((error: unknown) => log.warn("capture_retention_failed", { name, error })),
        ),
    )
  }

  const close = async () => {
    if (closed.value) return
    closed.value = true
    if (shared.current && owned.has(shared.current)) finish("shutdown")
    shared.holders -= 1
    if (shared.holders === 0 && slots()[key(deps.runtime.buildId)] === shared) delete slots()[key(deps.runtime.buildId)]
  }

  return { onHttpResponse, onWsHandshake, onWsReceive, onRetry, start, stop, status, recording, maintain, close }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const DAY = /^\d{4}-\d{2}-\d{2}$/

function attach(buildId: string): Shared {
  const existing = slots()[key(buildId)]
  const shared = existing ?? { current: undefined, mutex: new Lock.Mutex(), holders: 0 }
  shared.holders += 1
  slots()[key(buildId)] = shared
  return shared
}

// The capture window is a process singleton of the build by design, like the runtime (01 §4).
function slots() {
  return globalThis as unknown as Record<symbol, Shared | undefined>
}

/** `YYYY-MM-DD` (UTC) of an epoch-millisecond time: the capture folder of a line. */
function day(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}

/** A session id as a file name; anything but letters, digits, `_` and `-` becomes `_`. */
function fileName(sessionID: string) {
  return sessionID.replace(/[^\w-]/g, "_").slice(0, 120) || "_"
}

/** Origin and path of a request URL: no query, no credentials. */
function where(url: string) {
  const parsed = URL.parse(url)
  return parsed ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : "<url>"
}

function typeOf(json: Readonly<Record<string, unknown>>, name: string | undefined) {
  if (typeof json.type === "string") return json.type
  if (name !== undefined) return name
  return typeof json.object === "string" ? json.object : "<untyped>"
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

/** The shape (shape mode) or only the hash of an error body; text that is not JSON shapes as its length. */
function body(window: { readonly mode: OwnAccounts.CaptureMode }, text: string) {
  const parsed = Wiretap.parse(text)
  const value = parsed === undefined ? text : parsed
  return {
    json: parsed !== undefined,
    chars: text.length,
    hash: Wiretap.hash(value),
    ...(window.mode === "shape" ? { shape: Wiretap.shape(value) } : {}),
  }
}

/** At most {@link BODY_CHARS} of an error body, or `null` when it does not arrive in {@link BODY_TIMEOUT_MS}. */
async function bodyText(response: Response) {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BODY_TIMEOUT_MS).unref?.())
  const text = response.text().then(
    (value) => value.slice(0, BODY_CHARS),
    () => null,
  )
  return Promise.race([text, timeout])
}

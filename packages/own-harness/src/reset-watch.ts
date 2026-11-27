// What of a session's pending input reaches its running turn (core P-035, 11 §7.2) as this plugin instance knows it,
// so that only such input ends a `clock.sleep` or a `wait_agent` (Codex's input-queue activity). As in Codex, where a
// queued message stays in the client until the turn ends, queued input (`delivery: "queue"`) does not reach the turn
// until it is steered. A context reset waiting for the turn is no input of it, and the input admitted behind it reaches
// the new context, not the turn; a background notice crosses the reset and does. When the reset is cancelled, the
// steered input it held reaches the running turn, and so does a notice it held passive. The instance's own
// `session.inbox.*` events keep it; a session older than the instance (a restart, a reload of the plugin) has its inbox
// read back at its first step here (`reader`: self-HTTP, since the plugin API lists no inbox, 06 §2.6).
export * as ResetWatch from "./reset-watch.js"

import type { ServiceTarget } from "@own/runtime"
import { Option, Schema } from "effect"

/** Requests to the own service give up after this. */
export const TIMEOUT_MS = 15_000
/** The pauses before a read back is tried again while the service gives no answer yet. */
export const RETRY_MS = [500, 2_000, 8_000] as const

/** The `metadata` of an input, which a `wait_agent` reads (an inter-agent message does not end it). */
type Metadata = Readonly<Record<string, unknown>> | undefined

/** The fields of an inbox item, from an event or `session.inbox.list`, this module reads. */
export interface Item {
  readonly type: string
  readonly delivery?: string
  readonly payload?: {
    readonly background?: boolean
    readonly beforeReset?: string
    readonly metadata?: Readonly<Record<string, unknown>>
  }
}

const Listed = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  delivery: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.Struct({
      background: Schema.optional(Schema.Boolean),
      beforeReset: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
})
export type Listed = typeof Listed.Type

/**
 * A session's pending inbox items in enqueue order; `"retry"` when the service may answer later (none answered, a 503,
 * a 401 after which the registration is read again), `undefined` when it will not (another refusal).
 */
export type Reader = (sessionID: string) => Promise<ReadonlyArray<Listed> | "retry" | undefined>

/** A pending input: queued or steered, and whether a waiting reset holds it from the running turn. */
interface Input {
  readonly metadata: Metadata
  queued: boolean
  behind: boolean
}

export class Watch {
  /** Per session: the waiting reset's id, and the pending input that could reach the running turn. */
  private readonly sessions = new Map<string, { reset?: string; readonly inputs: Map<string, Input> }>()
  /** Sessions whose inbox this instance knows: created since it started, or read back (or being read). */
  private readonly known = new Set<string>()
  /** Inbox events per session: a read back that one overtook is dropped. */
  private readonly marks = new Map<string, number>()

  /** A session created since this instance started: its events tell all. */
  created(sessionID: string) {
    this.known.add(sessionID)
  }

  /** An admitted item: the metadata to end the running turn's waits with, or `undefined` when it does not reach it. */
  enqueued(sessionID: string, inboxID: string, item: Item) {
    this.mark(sessionID)
    return this.admit(sessionID, inboxID, item)
  }

  /**
   * A changed delivery (the queue dock's toggle and `지금 보내기`, own-web steering what it queued behind a cancelled
   * reset): queued input that is steered while no reset holds it reaches the running turn now.
   */
  changed(sessionID: string, inboxID: string, delivery: string) {
    this.mark(sessionID)
    const input = this.sessions.get(sessionID)?.inputs.get(inboxID)
    if (input === undefined) return undefined
    const reaches = input.queued && delivery === "steer" && !input.behind
    input.queued = delivery === "queue"
    return reaches ? { metadata: input.metadata } : undefined
  }

  /** A delivered or cancelled item: what reaches the running turn now, the steered input a cancelled reset held. */
  settled(sessionID: string, inboxID: string, cancelled: boolean): ReadonlyArray<Metadata> {
    this.mark(sessionID)
    const state = this.sessions.get(sessionID)
    if (state === undefined) return []
    if (state.reset !== inboxID) {
      state.inputs.delete(inboxID)
      return []
    }
    state.reset = undefined
    const held = [...state.inputs.values()].filter((input) => input.behind)
    held.forEach((input) => (input.behind = false))
    // Delivered, the reset ended the running turn: what it held starts the new context. Cancelled, queued input waits
    // for the turn's end as without the reset.
    return cancelled ? held.filter((input) => !input.queued).map((input) => input.metadata) : []
  }

  /**
   * Reads a session's inbox back once, for a session this instance does not know yet (`read` answers `undefined` for
   * one it has no waits for, or when the service refuses). While the service gives no answer it tries again after each
   * of `delays`, then gives up. An inbox event while a read runs makes its answer possibly older than that event: it is
   * dropped, and the session's next step reads again.
   */
  readBack(
    sessionID: string,
    read: () => Promise<ReadonlyArray<Listed> | "retry" | undefined>,
    delays: ReadonlyArray<number> = RETRY_MS,
  ): Promise<void> {
    if (this.known.has(sessionID)) return Promise.resolve()
    this.known.add(sessionID)
    const attempt = async (left: ReadonlyArray<number>): Promise<void> => {
      const mark = this.marks.get(sessionID) ?? 0
      const items = await read().catch(() => "retry" as const)
      // Forgotten meanwhile (the session was deleted): nothing to keep.
      if (!this.known.has(sessionID) || items === undefined) return
      if (items === "retry") {
        if (left.length === 0) return
        await Bun.sleep(left[0]!)
        return this.known.has(sessionID) ? attempt(left.slice(1)) : undefined
      }
      if ((this.marks.get(sessionID) ?? 0) !== mark) return void this.known.delete(sessionID)
      this.sessions.delete(sessionID)
      items.forEach((item) => this.admit(sessionID, item.id, item))
    }
    return attempt(delays)
  }

  /**
   * The input that reached the session's running turn and waits for its next step (Codex's pending turn input). A
   * `clock.sleep` or `wait_agent` that starts while there is some returns at once (Codex 0.164.0, #55644), as input that
   * arrives during it ends it.
   */
  pending(sessionID: string): ReadonlyArray<Metadata> {
    const inputs = this.sessions.get(sessionID)?.inputs
    if (inputs === undefined) return []
    return [...inputs.values()].filter((input) => !input.queued && !input.behind).map((input) => input.metadata)
  }

  forget(sessionID: string) {
    this.sessions.delete(sessionID)
    this.known.delete(sessionID)
    this.marks.delete(sessionID)
  }

  private mark(sessionID: string) {
    this.marks.set(sessionID, (this.marks.get(sessionID) ?? 0) + 1)
  }

  private admit(sessionID: string, inboxID: string, item: Item): { readonly metadata: Metadata } | undefined {
    const state = this.sessions.get(sessionID) ?? { inputs: new Map<string, Input>() }
    this.sessions.set(sessionID, state)
    if (item.type === "reset") {
      state.reset = inboxID
      return undefined
    }
    const synthetic = item.type === "synthetic"
    // A compaction or a move steered into the turn reaches it at its next boundary too.
    const metadata = synthetic || item.type === "user" ? item.payload?.metadata : undefined
    const passive = synthetic ? item.payload?.beforeReset : undefined
    // A passive notice never promotes on its own: it rides with the next input, unless the waiting reset it names is
    // cancelled, which makes it an ordinary notice of the running turn.
    if (passive !== undefined && passive !== state.reset) return undefined
    const behind =
      state.reset !== undefined && (passive !== undefined || !(synthetic && item.payload?.background === true))
    const queued = item.delivery === "queue"
    state.inputs.set(inboxID, { metadata, queued, behind })
    return behind || queued ? undefined : { metadata }
  }
}

/**
 * Self-HTTP to the own service: `GET /api/session/:id/inbox` for a session of this Location (`location[directory]`),
 * through an `@own/runtime` `ServiceTarget.Source` (the channel's registration file in an installed build). A 401 makes
 * the source read the registration again for the next try. The password goes only into `Authorization` of that
 * loopback request.
 */
export function reader(source: () => ServiceTarget.Source, directory: string, timeoutMs = TIMEOUT_MS): Reader {
  return async (sessionID) => {
    const service = source()
    const target = await service.current().catch(() => undefined)
    if (!target) return "retry"
    const url = new URL(`/api/session/${encodeURIComponent(sessionID)}/inbox`, target.url)
    url.searchParams.set("location[directory]", directory)
    const response = await fetch(url, {
      headers: { authorization: target.authorization },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined)
    if (!response) return "retry"
    if (!response.ok) await response.body?.cancel().catch(() => {})
    if (response.status === 401) service.invalidate()
    if (response.status === 401 || response.status === 503) return "retry"
    if (!response.ok) return undefined
    return Option.getOrUndefined(decodeListed(await response.json().catch(() => undefined)))?.data
  }
}

const decodeListed = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Array(Listed) }))

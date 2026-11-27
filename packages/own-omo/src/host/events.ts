export * as V1Events from "./events.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Model } from "@opencode/schema/model"
import type { SessionError } from "@opencode/schema/session-error"
import type { Stream } from "effect"
import type { V1Event } from "../omo-runtime.js"
import { Names } from "./names.js"
import { V1View } from "./view.js"

/** One event of `ctx.event.subscribe()`. */
export type V2Event =
  ReturnType<Context["event"]["subscribe"]> extends Stream.Stream<infer A, infer _E, infer _R> ? A : never

/** The OpenCode 2 events the pump turns into OpenCode 1 ones; anything else is dropped before any lookup. */
export const SOURCES = new Set([
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.text.ended",
  "session.compaction.ended",
  "session.inbox.enqueued",
  "session.inbox.cancelled",
  "session.inbox.delivered",
])

/**
 * An admitted inbox item whose delivery OpenCode 1 would have announced: a user or synthetic message (its text, and a
 * user message's metadata with omo's append), a manual compaction, or a context reset (core P-035), which omo sees as
 * a compaction.
 */
export type Pending =
  | { readonly type: "user"; readonly text: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly type: "synthetic"; readonly text: string }
  | { readonly type: "compaction" }
  | { readonly type: "reset" }

/** The session's agent and model when an item is delivered (the pump reads them), which its v1 message names. */
export interface Selection {
  readonly agent?: string
  readonly model?: Model.Ref
}

/**
 * What OpenCode 1 would have known about omo's sessions here (15 §3.4): which run (`session.status`, busy only, as
 * OpenCode 1's map), the children omo started, each step's assistant message (for `message.updated`), each running
 * tool's name, each session's latest user message (an assistant message's `parentID`) and the inbox items admitted
 * and not delivered yet.
 */
export class State {
  readonly status = new Map<string, { type: "busy" }>()
  readonly children = new Map<string, Set<string>>()
  readonly steps = new Map<string, { sessionID: string; agent: string; model: Model.Ref; created: number }>()
  readonly tools = new Map<string, string>()
  readonly lastUser = new Map<string, string>()
  readonly inbox = new Map<string, Map<string, Pending>>()

  addChild(parentID: string, childID: string) {
    const known = this.children.get(parentID) ?? new Set<string>()
    known.add(childID)
    this.children.set(parentID, known)
  }

  /** Whether this item's delivery becomes OpenCode 1 events, which name the session's agent and model. */
  pending(sessionID: string, inboxID: string) {
    return this.inbox.get(sessionID)?.has(inboxID) === true
  }

  admit(sessionID: string, inboxID: string, item: Pending) {
    const items = this.inbox.get(sessionID) ?? new Map<string, Pending>()
    items.set(inboxID, item)
    this.inbox.set(sessionID, items)
  }

  /** The item delivered or cancelled, no longer pending. */
  settle(sessionID: string, inboxID: string) {
    const items = this.inbox.get(sessionID)
    const item = items?.get(inboxID)
    items?.delete(inboxID)
    if (items?.size === 0) this.inbox.delete(sessionID)
    return item
  }

  forget(sessionID: string) {
    this.status.delete(sessionID)
    this.children.delete(sessionID)
    this.lastUser.delete(sessionID)
    this.inbox.delete(sessionID)
    this.children.forEach((set) => set.delete(sessionID))
  }
}

/**
 * The OpenCode 1 events an OpenCode 2 event means for omo, updating `state` (15 §3.4). `directory` is the Location's,
 * which OpenCode 1 sessions and messages name. Pure apart from `state`.
 */
export function project(
  event: V2Event,
  state: State,
  input: Input,
): Array<V1Event> {
  if (event.type === "session.created") {
    if (event.data.parentID !== undefined) state.addChild(event.data.parentID, event.data.sessionID)
    return [
      {
        type: "session.created",
        properties: {
          sessionID: event.data.sessionID,
          info: {
            id: event.data.sessionID,
            slug: event.data.slug,
            projectID: event.data.projectID,
            directory: event.data.location.directory,
            ...(event.data.parentID === undefined ? {} : { parentID: event.data.parentID }),
            title: event.data.title ?? "",
            version: event.data.version,
            time: { created: input.now, updated: input.now },
          },
        },
      },
    ]
  }
  if (event.type === "session.deleted") {
    state.forget(event.data.sessionID)
    return [
      {
        type: "session.deleted",
        properties: { sessionID: event.data.sessionID, info: { id: event.data.sessionID, directory: input.directory } },
      },
    ]
  }
  if (event.type === "session.execution.started") {
    state.status.set(event.data.sessionID, { type: "busy" })
    return [{ type: "session.status", properties: { sessionID: event.data.sessionID, status: { type: "busy" } } }]
  }
  if (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  ) {
    const sessionID = event.data.sessionID
    state.status.delete(sessionID)
    const idle: Array<V1Event> = [
      { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID } },
    ]
    if (event.type === "session.execution.failed")
      return [{ type: "session.error", properties: { sessionID, error: V1View.assistantError(event.data.error) } }, ...idle]
    if (event.type === "session.execution.interrupted") {
      // A shutdown is no turn end: the restarted service resumes the same execution.
      if (event.data.reason === "shutdown") return []
      return [
        {
          type: "session.error",
          properties: {
            sessionID,
            error: { name: "MessageAbortedError", data: { message: `Interrupted (${event.data.reason})` } },
          },
        },
        ...idle,
      ]
    }
    return idle
  }
  if (event.type === "session.inbox.enqueued") {
    const item = event.data.item
    if (item.type === "user")
      state.admit(event.data.sessionID, event.data.inboxID, {
        type: "user",
        text: item.payload.text,
        ...(item.payload.metadata === undefined ? {} : { metadata: item.payload.metadata }),
      })
    if (item.type === "synthetic") state.admit(event.data.sessionID, event.data.inboxID, { type: "synthetic", text: item.payload.text })
    if (item.type === "compaction" || item.type === "reset") state.admit(event.data.sessionID, event.data.inboxID, { type: item.type })
    return []
  }
  if (event.type === "session.inbox.cancelled") {
    state.settle(event.data.sessionID, event.data.inboxID)
    return []
  }
  if (event.type === "session.inbox.delivered") {
    state.lastUser.set(event.data.sessionID, event.data.inboxID)
    const item = state.settle(event.data.sessionID, event.data.inboxID)
    return item === undefined ? [] : delivered(event.data.sessionID, event.data.inboxID, item, input)
  }
  if (event.type === "session.step.started") {
    const step = {
      sessionID: event.data.sessionID,
      agent: input.agents.toV1(event.data.agent),
      model: event.data.model,
      created: event.data.started,
    }
    state.steps.set(event.data.assistantMessageID, step)
    return [{ type: "message.updated", properties: { sessionID: step.sessionID, info: assistant(event.data.assistantMessageID, step, state, input.directory) } }]
  }
  if (event.type === "session.step.ended" || event.type === "session.step.failed") {
    const step = state.steps.get(event.data.assistantMessageID)
    state.steps.delete(event.data.assistantMessageID)
    if (step === undefined) return []
    const info = {
      ...assistant(event.data.assistantMessageID, step, state, input.directory),
      time: { created: step.created, completed: input.now },
      ...(event.type === "session.step.ended"
        ? {
            finish: event.data.finish,
            cost: event.data.cost,
            tokens: {
              input: event.data.tokens.input,
              output: event.data.tokens.output,
              reasoning: event.data.tokens.reasoning,
              cache: { read: event.data.tokens.cache.read, write: event.data.tokens.cache.write },
            },
          }
        : { error: V1View.assistantError(event.data.error as SessionError.Error) }),
    }
    return [{ type: "message.updated", properties: { sessionID: step.sessionID, info } }]
  }
  if (event.type === "session.tool.input.started") {
    state.tools.set(event.data.id, event.data.name)
    return []
  }
  if (event.type === "session.tool.called" || event.type === "session.tool.success" || event.type === "session.tool.failed") {
    const name = state.tools.get(event.data.id) ?? "unknown"
    if (event.type !== "session.tool.called") state.tools.delete(event.data.id)
    const v1 = Names.toolToV1(name, event.type === "session.tool.called" ? event.data.input : {})
    const base = {
      id: `prt_${event.data.assistantMessageID.replace(/^msg_/, "")}_${event.data.id}`,
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      type: "tool",
      callID: event.data.id,
      tool: v1.tool,
    }
    const state1 =
      event.type === "session.tool.called"
        ? { status: "running", input: v1.args, time: { start: input.now } }
        : event.type === "session.tool.success"
          ? {
              status: "completed",
              input: {},
              output: V1View.contentText(event.data.content),
              title: typeof event.data.metadata?.title === "string" ? event.data.metadata.title : "",
              metadata: { ...event.data.metadata },
              time: { start: input.now, end: input.now },
            }
          : {
              status: "error",
              input: {},
              error: event.data.error.message,
              time: { start: input.now, end: input.now },
            }
    return [{ type: "message.part.updated", properties: { sessionID: event.data.sessionID, part: { ...base, state: state1 } } }]
  }
  if (event.type === "session.text.ended") {
    return [
      {
        type: "message.part.updated",
        properties: {
          sessionID: event.data.sessionID,
          part: {
            id: `prt_${event.data.assistantMessageID.replace(/^msg_/, "")}_t${event.data.ordinal}`,
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            type: "text",
            text: event.data.text,
          },
        },
      },
    ]
  }
  if (event.type === "session.compaction.ended")
    return [{ type: "session.compacted", properties: { sessionID: event.data.sessionID } }]
  return []
}

/**
 * What OpenCode 1 announced when a message joined a session: `message.updated` with the user message, then
 * `message.part.updated` with each text part (synthetic for a synthetic item, which omo's internal prompts are,
 * client.ts). omo's continuation then tells the user's next message from its own notices, as on OpenCode 1. A manual
 * compaction is announced as OpenCode 1's compaction user message and its `compaction` part, which end a running
 * continuation countdown as on OpenCode 1 (one that ended inside the countdown was otherwise followed by a
 * continuation); its end is `session.compacted`, and V1View renders the pair once it completed or failed. A context
 * reset is announced as the whole compaction pair (V1View renders it the same way); it is no `session.compacted`, so
 * omo restores nothing (ultrawork, the compaction guard) into a context the user emptied.
 */
function delivered(sessionID: string, id: string, item: Pending, input: Input): Array<V1Event> {
  const model = V1View.modelOf(input.session?.model)
  const compaction: Array<V1Event> = [
    {
      type: "message.updated",
      properties: { sessionID, info: { id, sessionID, role: "user", time: { created: input.now }, agent: "compaction", model } },
    },
    {
      type: "message.part.updated",
      properties: { sessionID, part: { id: V1View.partID(id, 0), sessionID, messageID: id, type: "compaction", auto: false } },
    },
  ]
  if (item.type === "compaction") return compaction
  if (item.type === "reset")
    return [
      ...compaction,
      {
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: `${id}s`,
            sessionID,
            role: "assistant",
            time: { created: input.now, completed: input.now },
            parentID: id,
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "compaction",
            agent: "compaction",
            path: { cwd: input.directory, root: input.directory },
            summary: true,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
        },
      },
    ]
  const append = item.type === "user" ? V1View.appendOf(item.metadata) : undefined
  const texts = [
    { text: `${item.text}${append?.suffix ?? ""}`, synthetic: item.type === "synthetic" },
    ...(append?.parts ?? []).map((text) => ({ text, synthetic: true })),
  ]
  return [
    {
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id,
          sessionID,
          role: "user",
          time: { created: input.now },
          agent: input.agents.toV1(input.session?.agent ?? "build"),
          model,
        },
      },
    },
    ...texts.map(
      (entry, index): V1Event => ({
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            id: V1View.partID(id, index),
            sessionID,
            messageID: id,
            type: "text",
            text: entry.text,
            ...(entry.synthetic ? { synthetic: true } : {}),
          },
        },
      }),
    ),
  ]
}

interface Input {
  readonly agents: Names.Agents
  readonly directory: string
  readonly now: number
  /** For a delivered item {@link State.pending} names. */
  readonly session?: Selection
}

/** The session an event is about, for the events the pump forwards. */
export function sessionOf(event: V2Event): string | undefined {
  if (!SOURCES.has(event.type)) return undefined
  const data: unknown = event.data
  if (typeof data !== "object" || data === null || !("sessionID" in data)) return undefined
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}

function assistant(
  id: string,
  step: { readonly sessionID: string; readonly agent: string; readonly model: Model.Ref; readonly created: number },
  state: State,
  directory: string,
) {
  return {
    id,
    sessionID: step.sessionID,
    role: "assistant",
    time: { created: step.created },
    parentID: state.lastUser.get(step.sessionID) ?? id,
    modelID: step.model.id,
    providerID: step.model.providerID,
    mode: step.agent,
    agent: step.agent,
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

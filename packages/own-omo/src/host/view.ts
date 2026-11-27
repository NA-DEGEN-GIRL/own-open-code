export * as V1View from "./view.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import type { SessionError } from "@opencode/schema/session-error"
import { SessionID } from "@opencode/schema/session-id"
import type { SessionMessage } from "@opencode/schema/session-message"
import { SessionV1 } from "@opencode/schema/v1/session"
import { DateTime } from "effect"
import { Names } from "./names.js"

/** One OpenCode 1 message as `client.session.messages` returned it: the message and its parts. */
export interface Message {
  info: SessionV1.Info
  parts: Array<SessionV1.Part>
}

/** The text own-omo appended to a user message after omo's `chat.message` (hooks.ts), kept in its metadata. */
export const APPEND_KEY = "own.omo"
export interface Append {
  /** Text appended to the message's own text part (omo's keyword blocks). */
  readonly suffix?: string
  /** Text parts omo added after it. */
  readonly parts?: ReadonlyArray<string>
  /** Where the message's own text is in the model's copy when attached skills' texts come first (their count). */
  readonly at?: number
}

export interface Session {
  readonly id: string
  readonly agent?: string
  readonly model?: Model.Ref
  readonly directory: string
}

/**
 * OpenCode 2 history → the OpenCode 1 messages omo reads (15 §3.3). A user message keeps its id, its agent and model are
 * the session's at that point (folded back from `agent-switched` and `model-switched`), and its text is what omo made
 * of it (`own.omo` append). A synthetic message is a user message with a synthetic text part. An assistant message is
 * one OpenCode 1 assistant message with text, reasoning and tool parts (tools under their OpenCode 1 names and inputs);
 * an aborted one carries `MessageAbortedError`. A completed compaction is OpenCode 1's pair: a `compaction` user message
 * and a summary assistant message. A failed one is the pair too, its summary message with the error and no text, as
 * OpenCode 1 kept it, so omo does not continue after a failed manual compaction either. A context reset (core P-035) is
 * a completed pair with no summary text, so omo sees a compaction boundary as the latest message and continues nothing
 * into the emptied context; an undone reset bounds nothing and is left out. A running compaction, idle, system, shell
 * and switch markers are left out. `tools` is the session's tool overlay, which OpenCode 1 recorded on its user
 * messages.
 */
export function messages(input: {
  readonly history: ReadonlyArray<SessionMessage.Info>
  readonly session: Session
  readonly agents: Names.Agents
  readonly tools?: Record<string, boolean>
}): Array<Message> {
  const sessionID = SessionID.make(input.session.id)
  const at = folded(input.history, input.session)
  const state = { lastUser: undefined as SessionV1.MessageID | undefined }
  return input.history.flatMap((message, index): Array<Message> => {
    const agent = input.agents.toV1(at[index]!.agent ?? "build")
    const model = at[index]!.model
    if (message.type === "user" || message.type === "synthetic" || message.type === "skill") {
      const id = SessionV1.MessageID.make(message.id)
      state.lastUser = id
      const append = message.type === "user" ? appendOf(message.metadata) : undefined
      const text = message.type === "user" ? `${message.text}${append?.suffix ?? ""}` : message.text
      const parts: Array<SessionV1.Part> = [
        {
          id: partID(message.id, 0),
          sessionID,
          messageID: id,
          type: "text",
          text,
          ...(message.type === "user" ? {} : { synthetic: true }),
        },
        ...(append?.parts ?? []).map(
          (extra, offset): SessionV1.Part => ({
            id: partID(message.id, offset + 1),
            sessionID,
            messageID: id,
            type: "text",
            text: extra,
            synthetic: true,
          }),
        ),
        ...(message.type === "user" ? (message.files ?? []) : []).map(
          (file, offset): SessionV1.Part => ({
            id: partID(message.id, (append?.parts?.length ?? 0) + offset + 1),
            sessionID,
            messageID: id,
            type: "file",
            mime: file.mime,
            ...(file.name === undefined ? {} : { filename: file.name }),
            url: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
          }),
        ),
      ]
      return [
        {
          info: {
            id,
            sessionID,
            role: "user",
            time: { created: millis(message.time.created) },
            agent,
            model: modelOf(model),
            ...(input.tools === undefined ? {} : { tools: { ...input.tools } }),
          },
          parts,
        },
      ]
    }
    if (message.type === "assistant") {
      const id = SessionV1.MessageID.make(message.id)
      const created = millis(message.time.created)
      const completed = message.time.completed === undefined ? undefined : millis(message.time.completed)
      const assistantAgent = input.agents.toV1(message.agent)
      const parts = message.content.map((content, offset) =>
        part(content, { id: partID(message.id, offset), sessionID, messageID: id, created, completed }),
      )
      return [
        {
          info: {
            id,
            sessionID,
            role: "assistant",
            time: { created, ...(completed === undefined ? {} : { completed }) },
            parentID: state.lastUser ?? id,
            modelID: Model.ID.make(message.model.id),
            providerID: Provider.ID.make(message.model.providerID),
            ...(message.model.variant === undefined ? {} : { variant: message.model.variant }),
            mode: assistantAgent,
            agent: assistantAgent,
            path: { cwd: input.session.directory, root: input.session.directory },
            cost: message.cost ?? 0,
            tokens: {
              input: message.tokens?.input ?? 0,
              output: message.tokens?.output ?? 0,
              reasoning: message.tokens?.reasoning ?? 0,
              cache: { read: message.tokens?.cache.read ?? 0, write: message.tokens?.cache.write ?? 0 },
            },
            ...(message.finish === undefined ? {} : { finish: message.finish }),
            ...(message.error === undefined ? {} : { error: assistantError(message.error) }),
          },
          parts,
        },
      ]
    }
    if (
      message.type === "compaction" &&
      ((message.status === "completed" && message.undone === undefined) || message.status === "failed")
    ) {
      const user = SessionV1.MessageID.make(message.id)
      const summary = SessionV1.MessageID.make(`${message.id}s`)
      const created = millis(message.time.created)
      const summaryModel = (message.status === "completed" ? message.model : undefined) ?? model
      state.lastUser = user
      return [
        {
          info: { id: user, sessionID, role: "user", time: { created }, agent: "compaction", model: modelOf(model) },
          parts: [{ id: partID(message.id, 0), sessionID, messageID: user, type: "compaction", auto: message.reason === "auto" }],
        },
        {
          info: {
            id: summary,
            sessionID,
            role: "assistant",
            time: { created, completed: created },
            parentID: user,
            modelID: Model.ID.make(summaryModel?.id ?? "unknown"),
            providerID: Provider.ID.make(summaryModel?.providerID ?? "unknown"),
            mode: "compaction",
            agent: "compaction",
            path: { cwd: input.session.directory, root: input.session.directory },
            summary: true,
            cost: message.cost ?? 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ...(message.status === "failed" ? { error: assistantError(message.error) } : { finish: "stop" }),
          },
          parts:
            message.status === "failed" || message.summary === ""
              ? []
              : [{ id: partID(message.id, 1), sessionID, messageID: summary, type: "text", text: message.summary }],
        },
      ]
    }
    return []
  })
}

/** The last `limit` messages, as OpenCode 1's `session.messages({query: {limit}})` returned them. */
export function limited<T>(list: ReadonlyArray<T>, limit: number | undefined) {
  return limit === undefined || limit <= 0 || limit >= list.length ? [...list] : list.slice(list.length - limit)
}

/** The append omo made to a user message, from the message's metadata. */
export function appendOf(metadata: Readonly<Record<string, unknown>> | undefined): Append | undefined {
  const value = metadata?.[APPEND_KEY]
  if (typeof value !== "object" || value === null || !("append" in value)) return undefined
  const append = value.append
  if (typeof append !== "object" || append === null) return undefined
  const suffix = "suffix" in append && typeof append.suffix === "string" ? append.suffix : undefined
  const parts =
    "parts" in append && Array.isArray(append.parts)
      ? append.parts.filter((entry): entry is string => typeof entry === "string")
      : undefined
  const at = "at" in append && typeof append.at === "number" ? append.at : undefined
  return {
    ...(suffix === undefined ? {} : { suffix }),
    ...(parts === undefined ? {} : { parts }),
    ...(at === undefined ? {} : { at }),
  }
}

/** The text a tool result gave the model: its text contents, files named. */
export function contentText(content: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly name?: string; readonly uri?: string }>) {
  return content.map((entry) => (entry.type === "text" ? (entry.text ?? "") : `[file: ${entry.name ?? entry.uri ?? ""}]`)).join("\n")
}

/** OpenCode 1's error of an assistant message: an aborted step is `MessageAbortedError`. */
export function assistantError(error: SessionError.Error): NonNullable<SessionV1.Assistant["error"]> {
  if (error.type === "aborted") return { name: "MessageAbortedError", data: { message: error.message } }
  return {
    name: "APIError",
    data: {
      message: error.message,
      isRetryable: false,
      ...(error.status === undefined ? {} : { statusCode: error.status }),
      ...(error.response === undefined ? {} : { responseBody: error.response.body }),
    },
  }
}

function part(
  content: SessionMessage.AssistantContent,
  base: {
    readonly id: SessionV1.PartID
    readonly sessionID: SessionID
    readonly messageID: SessionV1.MessageID
    readonly created: number
    readonly completed: number | undefined
  },
): SessionV1.Part {
  const ids = { id: base.id, sessionID: base.sessionID, messageID: base.messageID }
  if (content.type === "text") return { ...ids, type: "text", text: content.text }
  if (content.type === "reasoning")
    return {
      ...ids,
      type: "reasoning",
      text: content.text,
      time: {
        start: content.time === undefined ? base.created : millis(content.time.created),
        ...(content.time?.completed === undefined ? {} : { end: millis(content.time.completed) }),
      },
    }
  const v1 = Names.toolToV1(content.name, content.state.status === "streaming" ? {} : content.state.input)
  const start = millis(content.time.ran ?? content.time.created)
  const end = content.time.completed === undefined ? (base.completed ?? start) : millis(content.time.completed)
  const state = ((): SessionV1.ToolState => {
    if (content.state.status === "streaming") return { status: "pending", input: {}, raw: content.state.input }
    if (content.state.status === "running")
      return {
        status: "running",
        input: v1.args,
        ...(typeof content.state.metadata.title === "string" ? { title: content.state.metadata.title } : {}),
        metadata: { ...content.state.metadata },
        time: { start },
      }
    if (content.state.status === "completed")
      return {
        status: "completed",
        input: v1.args,
        output: contentText(content.state.content),
        title: typeof content.state.metadata?.title === "string" ? content.state.metadata.title : "",
        metadata: { ...content.state.metadata },
        time: { start, end },
      }
    return {
      status: "error",
      input: v1.args,
      error: content.state.error.message,
      ...(content.state.metadata === undefined ? {} : { metadata: { ...content.state.metadata } }),
      time: { start, end },
    }
  })()
  return { ...ids, type: "tool", callID: content.id, tool: v1.tool, state }
}

/** Each message's agent and model: the session's current ones, walked back over the switches. */
function folded(history: ReadonlyArray<SessionMessage.Info>, session: Session) {
  const at: Array<{ agent?: string; model?: Model.Ref }> = new Array(history.length)
  const current: { agent?: string; model?: Model.Ref } = { agent: session.agent, model: session.model }
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!
    at[index] = { ...current }
    if (message.type === "agent-switched" && message.previous !== undefined) current.agent = message.previous
    if (message.type === "model-switched" && message.previous !== undefined) current.model = message.previous
    if (message.type === "assistant" && current.agent === undefined) current.agent = message.agent
  }
  return at
}

export function modelOf(model: Model.Ref | undefined): SessionV1.User["model"] {
  return {
    providerID: Provider.ID.make(model?.providerID ?? "unknown"),
    modelID: Model.ID.make(model?.id ?? "unknown"),
    ...(model?.variant === undefined ? {} : { variant: model.variant }),
  }
}

export function partID(messageID: string, index: number) {
  return SessionV1.PartID.make(`prt_${messageID.replace(/^msg_/, "")}_${index}`)
}

function millis(value: DateTime.Utc | number) {
  return typeof value === "number" ? value : DateTime.toEpochMillis(value)
}

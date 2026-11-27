export * as Bridge from "./hooks.js"

import { Message, type SystemPart } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/effect/session"
import { SessionID } from "@opencode/schema/session-id"
import { Tool } from "@opencode/schema/tool"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect } from "effect"
import type { V1Part } from "../omo-runtime.js"
import type { Runtime } from "../runtime.js"
import { Names } from "./names.js"
import type { Overlays } from "./overlay.js"
import type { OmoSessions } from "./session.js"
import { Tools } from "./tools.js"
import { V1View } from "./view.js"

type Ctx = Pick<Context, "session" | "tool">

export interface Deps {
  readonly host: Runtime.Host
  readonly sessions: OmoSessions.Cache
  readonly overlays: Overlays.Store
  readonly warn: (message: string, fields: Readonly<Record<string, unknown>>) => void
  /**
   * The session's messages as core stores them, for the user messages' metadata (`own.omo.append`): the request's
   * messages carry none since @opencode/ai v2.2.6 split Message by role. Absent reads none.
   */
  readonly history?: (
    sessionID: SessionID,
  ) => Promise<ReadonlyArray<{ readonly id: string; readonly type: string; readonly metadata?: Readonly<Record<string, unknown>> }>>
}

/**
 * omo's OpenCode 1 hooks on OpenCode 2's (15 §3.4), for omo sessions only: `prompt` → `chat.message`, the request hooks
 * (`context`, `compaction`, `generate`, one transform so a compaction reads the session's prompt cache) → Sisyphus as
 * `build`, `experimental.chat.system.transform`, omo's text appended to the user messages, the tool list and
 * `tool.definition`, and the tool hooks → `tool.execute.before` / `tool.execute.after`. A hook that fails is logged and
 * leaves the request as core built it, except `tool.execute.before`, whose error refuses the call as omo intends.
 */
export const register = (ctx: Ctx, deps: Deps) =>
  Effect.gen(function* () {
    yield* ctx.session.hook("prompt", (event) =>
      Effect.promise(() => prompt(ctx, deps, event).catch((error: unknown) => deps.warn("chat_message_failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }))),
    )
    // A history that cannot be read only loses omo's appends, not the rest of the transform.
    const history = (sessionID: SessionID) =>
      Effect.runPromise(ctx.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => [])))
    const request = (event: SessionContext) =>
      Effect.promise(() => transform({ ...deps, history }, event).catch((error: unknown) => deps.warn("request_hook_failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) })))
    yield* ctx.session.hook("context", request)
    yield* ctx.session.hook("compaction", request)
    yield* ctx.session.hook("generate", request)
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.tryPromise({
        try: () => before(deps, event),
        catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
      }),
    )
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.promise(() => after(deps, event).catch((error: unknown) => deps.warn("tool_after_failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }))),
    )
  })

/**
 * `chat.message` for a user prompt: omo sees the message as OpenCode 1 would and may edit its parts. The stored text
 * stays the user's; what omo appended to it and the text parts it added go to the message's metadata
 * (`own.omo.append`), which the request hooks add to the model's copy of that message. Changes to the message's agent,
 * model or variant are not applied (policy `inherit`).
 */
async function prompt(ctx: Pick<Context, "session">, deps: Deps, event: SessionPrompt) {
  if (!(await deps.sessions.isOmo(event.sessionID))) return
  const started = await deps.host.ensure()
  const chat = started.hooks["chat.message"]
  if (chat === undefined) return
  const info = await Effect.runPromise(ctx.session.get({ sessionID: event.sessionID }))
  if (info.parentID === undefined) started.runtime.setMainSession(event.sessionID)
  const agent = started.agents.toV1(info.agent ?? "build")
  const model = info.model === undefined ? undefined : { providerID: info.model.providerID, modelID: info.model.id }
  const text = event.prompt.text
  const own: V1Part = {
    id: `prt_${event.messageID.replace(/^msg_/, "")}_0`,
    sessionID: event.sessionID,
    messageID: event.messageID,
    type: "text",
    text,
  }
  const message: Record<string, unknown> = {
    id: event.messageID,
    sessionID: event.sessionID,
    role: "user",
    agent,
    ...(model === undefined ? {} : { model }),
    time: { created: Date.now() },
  }
  const selection = (value: Record<string, unknown>) => JSON.stringify([value.agent, value.model, value.variant])
  const selected = selection(message)
  const output = { message, parts: [own] }
  await chat({ sessionID: event.sessionID, agent, ...(model === undefined ? {} : { model }), messageID: event.messageID }, output)
  const after = typeof own.text === "string" ? own.text : text
  const suffix = after.startsWith(text) && after.length > text.length ? after.slice(text.length) : undefined
  if (!after.startsWith(text)) deps.warn("chat_message_rewrote_text", { sessionID: event.sessionID })
  const parts = output.parts.flatMap((part) =>
    part !== own && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  )
  // Policy `inherit`: omo's agent, model or variant choice for the message is not applied.
  if (selection(output.message) !== selected) deps.warn("chat_message_switch_dropped", { sessionID: event.sessionID })
  if (suffix === undefined && parts.length === 0) return
  // Core puts attached skills' texts before the message's own text in the model's copy (to-llm-message.ts).
  const at = event.prompt.skills?.length ?? 0
  event.metadata = {
    ...event.metadata,
    [V1View.APPEND_KEY]: {
      append: {
        ...(suffix === undefined ? {} : { suffix }),
        ...(parts.length === 0 ? {} : { parts }),
        ...(at === 0 ? {} : { at }),
      },
    },
  }
}

/**
 * The request of an omo session (15 §3.4): own's preset guidance left out, Sisyphus's prompt for `build`, omo's system
 * transform, omo's appends on the user messages, omo's tools under their OpenCode 1 names, core `subagent` and the
 * tools the agent or the session's overlay turns off removed, `tool.definition` applied, and the overlay's system text
 * last.
 */
export async function transform(deps: Pick<Deps, "host" | "sessions" | "overlays" | "history">, event: SessionContext) {
  if (!(await deps.sessions.isOmo(event.sessionID))) return
  withoutPreset(event)
  const started = await deps.host.ensure()
  const overlay = await Effect.runPromise(deps.overlays.get(event.sessionID))
  if (event.agent === "build" && started.sisyphus !== undefined && event.system[0] !== undefined)
    event.system[0] = { ...event.system[0], text: started.sisyphus }
  const system = started.hooks["experimental.chat.system.transform"]
  if (system !== undefined) {
    const output = { system: event.system.map((part) => part.text) }
    await system({ sessionID: event.sessionID, model: { id: event.model.id, providerID: event.model.providerID } }, output)
    event.system = output.system.map((text, index): SystemPart =>
      event.system[index]?.text === text ? event.system[index]! : { type: "text", text },
    )
  }
  const stored = new Map((deps.history === undefined ? [] : await deps.history(event.sessionID)).map((message) => [message.id, message]))
  event.messages = event.messages.map((message) => {
    const source = message.id === undefined ? undefined : stored.get(message.id)
    const append = message.role === "user" && source?.type === "user" ? V1View.appendOf(source.metadata) : undefined
    if (message.role !== "user" || append === undefined) return message
    const at = append.at ?? message.content.findIndex((part) => part.type === "text")
    const content = message.content.map((part, index) =>
      index === at && part.type === "text" && append.suffix !== undefined ? { ...part, text: `${part.text}${append.suffix}` } : part,
    )
    return Message.make({ ...message, content: [...content, ...(append.parts ?? []).map((text) => Message.text(text))] })
  })
  Object.keys(event.tools)
    .filter((name) => name.startsWith(Names.TOOL_PREFIX))
    .forEach((name) => {
      const definition = event.tools[name]!
      delete event.tools[name]
      event.tools[name.slice(Names.TOOL_PREFIX.length)] = definition
    })
  delete event.tools.subagent
  const agentKey = started.runtime.getAgentConfigKey(started.agents.toV1(event.agent))
  const off = {
    ...(started.registered.some((agent) => agent.key === agentKey)
      ? started.runtime.getAgentToolRestrictions(agentKey, { includeTeamToolDenylist: false })
      : {}),
    ...overlay.tools,
  }
  Object.entries(off)
    .filter(([, enabled]) => enabled === false)
    .forEach(([name]) => delete event.tools[Names.toolToV2(name)])
  const definition = started.hooks["tool.definition"]
  if (definition !== undefined)
    for (const [name, tool] of Object.entries(event.tools)) {
      const output = { description: tool.description, parameters: tool.input }
      await definition({ toolID: Names.toolToV1(name, {}).tool }, output)
      // The definition object stays the same: core maps a renamed tool back to its registration by identity.
      if (output.description !== tool.description) tool.description = output.description
    }
  if (overlay.system !== undefined && overlay.system !== "") event.system = [...event.system, { type: "text", text: overlay.system }]
  // The Claude Agent provider reads its system prompt only from these options, which its own hooks filled from core's
  // system before this one ran: Sisyphus, omo's transform and the overlay go to Claude as the agent role, after Claude
  // Code's own prompt, with core's parts they kept.
  if (event.model.providerID !== OwnHarness.CLAUDE_AGENT) return
  event.options[OwnHarness.CLAUDE_AGENT_ROLE] = event.system.map((part) => part.text).join("\n\n")
  event.options[OwnHarness.CLAUDE_AGENT_INSTRUCTIONS] = ""
}

/**
 * own-accounts' preset guidance (the `own.preset` session instruction entry, 07 §3.3) is about core's `subagent` tool,
 * which an omo request removes: it would name a tool omo does not have. Core renders the entry into the instruction
 * baseline and later changes and removals into System messages; an omo request carries none of them, whichever
 * 에이전트 방식 the session ran when the entry was written, so a switch to or from omo needs no rewrite. Other entries
 * (the team's) stay.
 */
export const PRESET_KEY = "own.preset"

const PRESET_ENTRY = (() => {
  const key = PRESET_KEY.replaceAll(".", "\\.")
  const entry = `(?:The context under "${key}" changed and supersedes the previous value:\\n)?<context key="${key}">\\n[\\s\\S]*?\\n</context>|The context under "${key}" no longer applies\\. Disregard it\\.`
  // With the blank line that joins it to the text before it, else to the text after it.
  return new RegExp(`\\n\\n(?:${entry})|(?:${entry})(?:\\n\\n)?`, "g")
})()

function withoutPreset(event: SessionContext) {
  const strip = (text: string) => text.replace(PRESET_ENTRY, "")
  event.system = event.system.flatMap((part): SystemPart[] => {
    const text = strip(part.text)
    if (text === part.text) return [part]
    return text === "" ? [] : [{ ...part, text }]
  })
  event.messages = event.messages.flatMap((message) => {
    if (message.role !== "system" || !message.content.some((part) => part.type === "text" && part.text !== strip(part.text)))
      return [message]
    const content = message.content
      .map((part) => (part.type === "text" ? { ...part, text: strip(part.text) } : part))
      .filter((part) => part.type !== "text" || part.text !== "")
    return content.length === 0 ? [] : [Message.make({ ...message, content })]
  })
}

/** `tool.execute.before`: omo sees the call under its OpenCode 1 name and input; its argument changes are kept. */
async function before(
  deps: Pick<Deps, "host" | "sessions">,
  event: { readonly tool: string; readonly sessionID: string; readonly id: string; input: unknown; readonly registered?: string },
) {
  if (!(await deps.sessions.isOmo(event.sessionID))) return
  const hook = deps.host.current()?.hooks["tool.execute.before"]
  if (hook === undefined) return
  const v1 = Names.toolToV1(event.tool, event.input, event.registered)
  const output = { args: { ...v1.args } }
  await hook({ tool: v1.tool, sessionID: event.sessionID, callID: event.id }, output)
  if (JSON.stringify(output.args) !== JSON.stringify(v1.args))
    event.input = Names.argsToV2(event.registered ?? event.tool, output.args)
}

/**
 * OpenCode 2's `edit` failures that omo's edit-error-recovery knows, with OpenCode 1's text for each (the patterns it
 * looks for). Other failures reach no after hook, as on OpenCode 1.
 */
export const EDIT_ERRORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^No changes to apply: oldString and newString are identical/, "oldString and newString must be different"],
  [/^Could not find oldString in /, "oldString not found in content"],
  [
    /^Found \d+ matches for oldString/,
    "oldString found multiple times and requires more code context to uniquely identify the intended match",
  ],
]

/**
 * `tool.execute.after` of a completed call: omo may rewrite the result's text and metadata. A failed `edit` of
 * {@link EDIT_ERRORS} reaches it too, with OpenCode 1's text for the failure as its output (OpenCode 1 ran no after
 * hook for a failed tool, so omo's edit-error-recovery only ever saw such text in a result); what omo appends to that
 * text is appended to the error the model gets.
 */
async function after(
  deps: Pick<Deps, "host" | "sessions">,
  event: {
    readonly tool: string
    readonly sessionID: string
    readonly id: string
    readonly input: unknown
    readonly status: "completed" | "error"
    result?: Tool.Result
    error?: Tool.Error
  },
) {
  if (event.status === "error") return failed(deps, event)
  if (event.result === undefined) return
  if (!(await deps.sessions.isOmo(SessionID.make(event.sessionID)))) return
  const hook = deps.host.current()?.hooks["tool.execute.after"]
  if (hook === undefined) return
  const v1 = Names.toolToV1(event.tool, event.input)
  const content = event.result.content
  const text = typeof content === "string" ? content : V1View.contentText(content ?? [])
  const metadata = { ...event.result.metadata }
  const output = { title: typeof metadata.title === "string" ? metadata.title : "", output: text, metadata: { ...metadata } }
  await hook({ tool: v1.tool, sessionID: event.sessionID, callID: event.id, args: v1.args }, output)
  const changedText = output.output !== text
  const nextMetadata = Tools.json({ ...output.metadata, ...(output.title === "" ? {} : { title: output.title }) })
  const changedMetadata = JSON.stringify(nextMetadata) !== JSON.stringify(metadata)
  if (!changedText && !changedMetadata) return
  event.result = {
    ...event.result,
    ...(changedText ? { content: output.output } : {}),
    ...(changedMetadata ? { metadata: nextMetadata } : {}),
  }
}

/** A failed `edit` of {@link EDIT_ERRORS} in an omo session through `tool.execute.after` (see {@link after}). */
async function failed(
  deps: Pick<Deps, "host" | "sessions">,
  event: { readonly tool: string; readonly sessionID: string; readonly id: string; readonly input: unknown; error?: Tool.Error },
) {
  const error = event.error
  if (event.tool !== "edit" || error === undefined) return
  const text = EDIT_ERRORS.find(([pattern]) => pattern.test(error.message))?.[1]
  if (text === undefined || !(await deps.sessions.isOmo(SessionID.make(event.sessionID)))) return
  const hook = deps.host.current()?.hooks["tool.execute.after"]
  if (hook === undefined) return
  const output = { title: "", output: text, metadata: {} }
  await hook({ tool: "edit", sessionID: event.sessionID, callID: event.id, args: Names.toolToV1(event.tool, event.input).args }, output)
  if (!output.output.startsWith(text) || output.output === text) return
  event.error = new Tool.Error({
    ...(error.error === undefined ? {} : { error: error.error }),
    ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
    message: `${error.message}${output.output.slice(text.length)}`,
  })
}

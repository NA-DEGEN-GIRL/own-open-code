export * as Tools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { SessionID } from "@opencode/schema/session-id"
import { Tool } from "@opencode/schema/tool"
import { Effect, type Schema } from "effect"
import type { V1ToolDefinition, ZodLike } from "../omo-runtime.js"
import { Names } from "./names.js"
import { Todos } from "./todo.js"

/** omo's tools the MVP registers (15 §5); omo creates more, which stay unregistered. */
export const BRIDGED = ["task", "background_output", "background_cancel", "call_omo_agent"] as const

type Ctx = Pick<Context, "permission" | "location">

/**
 * An OpenCode 1 tool definition as an OpenCode 2 tool named `omo_<name>` (15 §3.5): its zod arguments become JSON
 * Schema, the input is checked with zod before `execute` runs, interruption aborts it, `metadata()` becomes progress
 * (with `sessionId` as `sessionID`, which own-web's subagent card reads) and `ask()` asks OpenCode 2's permissions.
 * A string result is the model's text; an object result's `output` is, with its `metadata` and `title` kept.
 */
export function bridge(
  ctx: Ctx,
  input: {
    readonly name: string
    readonly definition: V1ToolDefinition
    readonly z: ZodLike
    readonly agents: Names.Agents
    readonly permission: string
  },
): Tool.Info {
  const schema = input.z.object(input.definition.args)
  return {
    name: `${Names.TOOL_PREFIX}${input.name}`,
    description: input.definition.description,
    input: Todos.standard(parameters(input.z, input.definition.args)),
    options: { codemode: false, permission: input.permission },
    execute: (raw, context) =>
      Effect.gen(function* () {
        const parsed = schema.safeParse(raw)
        if (!parsed.success) return yield* new Tool.Error({ message: `Invalid ${input.name} input: ${parsed.error.message}` })
        // The child session a call reported (`metadata({sessionId})`): own-web's subagent card opens it from the result.
        const child: { sessionID?: string } = {}
        const result = yield* Effect.tryPromise({
          try: (signal) => input.definition.execute(parsed.data, v1Context(ctx, input.agents, context, signal, child)),
          catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
        })
        const linked = child.sessionID === undefined ? {} : { sessionID: child.sessionID }
        if (typeof result === "string")
          return { content: result || "(no output)", ...(child.sessionID === undefined ? {} : { metadata: linked }) }
        return {
          content: result.output || "(no output)",
          metadata: json({ ...linked, ...result.metadata, ...(result.title === undefined ? {} : { title: result.title }) }),
        }
      }),
  }
}

/**
 * The tool's JSON Schema as OpenCode 1 listed it: one property per argument, each from the override omo attaches
 * (`normalizeToolArgSchemas`, which strips `$schema`) or zod's own conversion, and the arguments that do not accept
 * `undefined` required. Converting the whole object at once fails in zod 4.6 once those overrides are attached.
 */
export function parameters(z: ZodLike, args: Record<string, unknown>) {
  const entries = Object.entries(args)
  const required = entries.filter(([, value]) => !accepts(value, undefined)).map(([key]) => key)
  return {
    type: "object",
    properties: Object.fromEntries(entries.map(([key, value]) => [key, property(z, value)])),
    ...(required.length === 0 ? {} : { required }),
  }
}

function property(z: ZodLike, value: unknown) {
  const override = isRecord(value) && isRecord(value._zod) ? value._zod.toJSONSchema : undefined
  const json = typeof override === "function" ? override() : z.toJSONSchema(value, { target: "draft-2020-12", io: "input" })
  return isRecord(json) ? Object.fromEntries(Object.entries(json).filter(([key]) => key !== "$schema")) : {}
}

function accepts(value: unknown, input: unknown) {
  if (!isRecord(value) || typeof value.safeParse !== "function") return true
  const result: unknown = value.safeParse(input)
  return isRecord(result) && result.success === true
}

/**
 * Tool metadata as JSON: OpenCode 2 records only JSON values, and an `undefined` field (which OpenCode 1 dropped when it
 * stored the part) would make the whole result unrecordable, leaving the call without a result.
 */
export function json(value: Record<string, unknown>): Record<string, Schema.Json> {
  const copied: unknown = JSON.parse(JSON.stringify(value, (_, entry: unknown) => (typeof entry === "bigint" ? String(entry) : entry)))
  return isRecord(copied) ? (copied as Record<string, Schema.Json>) : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function v1Context(
  ctx: Ctx,
  agents: Names.Agents,
  context: Tool.Context,
  signal: AbortSignal,
  child: { sessionID?: string },
) {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: agents.toV1(context.agent),
    directory: ctx.location.directory,
    worktree: ctx.location.directory,
    callID: context.id,
    abort: signal,
    metadata: (update: { readonly title?: string; readonly metadata?: Record<string, unknown> }) => {
      const sessionID = update.metadata?.sessionId
      if (typeof sessionID === "string") child.sessionID = sessionID
      Effect.runFork(
        context.progress(
          json({
            ...update.metadata,
            ...(update.title === undefined ? {} : { title: update.title }),
            ...(typeof sessionID === "string" ? { sessionID } : {}),
          }),
        ),
      )
    },
    ask: (request: {
      readonly permission: string
      readonly patterns: ReadonlyArray<string>
      readonly always?: ReadonlyArray<string>
      readonly metadata?: Record<string, unknown>
    }) =>
      Effect.runPromise(
        ctx.permission.assert({
          sessionID: SessionID.make(context.sessionID),
          agent: Agent.ID.make(context.agent),
          action: request.permission,
          resources: [...request.patterns],
          ...(request.always === undefined ? {} : { save: [...request.always] }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
          source: { type: "tool", messageID: context.messageID, id: context.id },
        }),
      ),
  }
}

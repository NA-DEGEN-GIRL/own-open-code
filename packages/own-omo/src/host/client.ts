export * as V1Client from "./client.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import { SessionID } from "@opencode/schema/session-id"
import { OwnGitHub } from "@own/protocol"
import { Effect } from "effect"
import type { V1Part } from "../omo-runtime.js"
import type { V1Events } from "./events.js"
import { Names } from "./names.js"
import type { Overlays } from "./overlay.js"
import type { Todos } from "./todo.js"
import { V1View } from "./view.js"

type Ctx = Pick<Context, "session" | "location" | "model">

/** The metadata `source` of every message own-omo adds for omo (own-web and the tests find omo's messages by it). */
export const SOURCE = "own.omo"

/** An agent as OpenCode 1's `client.app.agents()` listed it. */
export interface AgentInfo {
  readonly name: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden?: boolean
  readonly description?: string
  readonly model?: string
}

/** A child session omo created that OpenCode 2 creates with its first prompt (15 §3.4 deferred create). */
interface Pending {
  readonly parentID: string
  readonly title?: string
  readonly permission: ReadonlyArray<unknown>
  readonly directory: string
  readonly projectID: string
  readonly created: number
}

export interface Deps {
  readonly ctx: Ctx
  readonly state: V1Events.State
  readonly overlays: Overlays.Store
  readonly todos: Todos.Store
  /** The started runtime's agent names; before the config ran, names pass through. */
  readonly agents: () => Names.Agents
  /** `client.app.agents()`: the agents omo registered as OpenCode 1 saw them, then OpenCode 2's. */
  readonly listAgents: () => Promise<ReadonlyArray<AgentInfo>>
  /** omo's internal-initiator marker (`<!-- OMO_INTERNAL_INITIATOR -->`). */
  readonly marker: string
  /** Where a toast goes: own writes omo's toasts to its log (15 §4.7). */
  readonly toast: (body: Record<string, unknown>) => void
}

/**
 * The part of OpenCode 1's SDK client omo calls (15 §3.4), on OpenCode 2's plugin API. Every method resolves to
 * `{data, error, response}` like the SDK, or throws with `throwOnError`. Model choices in prompt bodies are not applied
 * (policy `inherit`): a child runs on its parent's model, and a top-level session's agent and model are never switched.
 * `session.delete` does nothing: the children omo starts stay for the user to read.
 */
export function make(deps: Deps) {
  const pending = new Map<string, Pending>()
  const created = new Set<string>()
  const ctx = deps.ctx
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const info = (sessionID: string) => run(ctx.session.get({ sessionID: SessionID.make(sessionID) }))

  const view = async (sessionID: string) => {
    const session = await info(sessionID)
    const [history, overlay] = await Promise.all([
      run(ctx.session.context({ sessionID: session.id })),
      run(deps.overlays.get(sessionID)),
    ])
    return V1View.messages({
      history,
      session: {
        id: session.id,
        ...(session.agent === undefined ? {} : { agent: session.agent }),
        ...(session.model === undefined ? {} : { model: session.model }),
        directory: session.location.directory,
      },
      agents: deps.agents(),
      ...(overlay.tools === undefined ? {} : { tools: overlay.tools }),
    })
  }

  /** Admits omo's prompt: creates a pending child, records the overlay, then a synthetic message or a user prompt. */
  const admit = async (args: PromptArgs) => {
    const sessionID = args.path.id
    const body = args.body
    const agent = typeof body.agent === "string" ? deps.agents().toV2(body.agent) : undefined
    const child = pending.get(sessionID)
    if (child !== undefined) {
      const parent = await info(child.parentID)
      await run(
        ctx.session.create({
          id: SessionID.make(sessionID),
          parentID: SessionID.make(child.parentID),
          ...(child.title === undefined ? {} : { title: child.title }),
          ...(agent === undefined ? {} : { agent: Agent.ID.make(agent) }),
          ...(parent.model === undefined ? {} : { model: parent.model }),
          // GitHub's writes ask in a child too, after its parent's rules (an allow-all `*` among them) and omo's (GH-26).
          permissions: [...(parent.permissions ?? []), ...permissions(child.permission), ASK_GITHUB_WRITES],
          // omo's background manager tells the parent itself; core's own report would wake it twice (core P-063).
          metadata: { "own.report": false },
        }),
      )
      pending.delete(sessionID)
      created.add(sessionID)
    } else if (agent !== undefined && created.has(sessionID)) {
      const current = await info(sessionID)
      if (current.agent !== agent) await run(ctx.session.switchAgent({ sessionID: current.id, agent: Agent.ID.make(agent) }))
    }
    if (typeof body.system === "string" || isRecord(body.tools))
      await run(
        deps.overlays.set(sessionID, {
          ...(typeof body.system === "string" ? { system: body.system } : {}),
          ...(isRecord(body.tools) ? { tools: booleans(body.tools) } : {}),
        }),
      )
    const texts = (Array.isArray(body.parts) ? body.parts : []).filter(
      (part): part is V1Part & { text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    const text = texts.map((part) => part.text).join("\n\n")
    const internal = texts.length > 0 && texts.every((part) => part.synthetic === true || part.text.includes(deps.marker))
    const resume = body.noReply !== true
    if (internal)
      await run(
        ctx.session.synthetic({
          sessionID: SessionID.make(sessionID),
          text,
          description: describe(text),
          metadata: { source: SOURCE },
          background: true,
          resume,
        }),
      )
    else await run(ctx.session.prompt({ sessionID: SessionID.make(sessionID), text, resume, metadata: { source: SOURCE } }))
  }

  return {
    /** Ids of the children omo created through this client (agent switches apply to them only). */
    created,
    session: {
      create: (args?: { readonly body?: Record<string, unknown>; readonly throwOnError?: boolean }) =>
        call(args, async () => {
          const body = args?.body ?? {}
          const title = typeof body.title === "string" ? body.title : undefined
          if (typeof body.parentID !== "string") {
            const made = await run(ctx.session.create({ ...(title === undefined ? {} : { title }), location: ctx.location }))
            return sessionInfo(made)
          }
          const parent = await info(body.parentID)
          const id = SessionID.create()
          const now = Date.now()
          pending.set(id, {
            parentID: parent.id,
            ...(title === undefined ? {} : { title }),
            permission: Array.isArray(body.permission) ? body.permission : [],
            directory: parent.location.directory,
            projectID: parent.projectID,
            created: now,
          })
          deps.state.addChild(parent.id, id)
          return {
            id,
            slug: id,
            projectID: parent.projectID,
            directory: parent.location.directory,
            parentID: parent.id,
            title: title ?? "",
            version: "",
            time: { created: now, updated: now },
          }
        }),
      get: (args: IdArgs) =>
        call(args, async () => {
          const waiting = pending.get(args.path.id)
          if (waiting !== undefined)
            return {
              id: args.path.id,
              slug: args.path.id,
              projectID: waiting.projectID,
              directory: waiting.directory,
              parentID: waiting.parentID,
              title: waiting.title ?? "",
              version: "",
              time: { created: waiting.created, updated: waiting.created },
            }
          return sessionInfo(await info(args.path.id))
        }),
      messages: (args: IdArgs & { readonly query?: { readonly limit?: number } }) =>
        call(args, async () =>
          pending.has(args.path.id) ? [] : V1View.limited(await view(args.path.id), args.query?.limit),
        ),
      message: (args: { readonly path: { readonly id: string; readonly messageID: string }; readonly throwOnError?: boolean }) =>
        call(args, async () => {
          const found = (await view(args.path.id)).find((message) => message.info.id === args.path.messageID)
          if (found === undefined) throw new Error(`message ${args.path.messageID} not found`)
          return found
        }),
      status: (args?: { readonly throwOnError?: boolean }) =>
        call(args, async () => Object.fromEntries([...deps.state.status].map(([id, status]) => [id, { ...status }]))),
      abort: (args: IdArgs) =>
        call(args, async () => {
          if (pending.has(args.path.id)) return true
          return (await run(ctx.session.interrupt({ sessionID: SessionID.make(args.path.id) }))).interrupted
        }),
      todo: (args: IdArgs) => call(args, async () => [...(await run(deps.todos.get(args.path.id)))]),
      promptAsync: (args: PromptArgs) =>
        call(args, async () => {
          await admit(args)
          return undefined
        }),
      prompt: (args: PromptArgs) =>
        call(args, async () => {
          await admit(args)
          await run(ctx.session.wait({ sessionID: SessionID.make(args.path.id) }))
          return (await view(args.path.id)).findLast((message) => message.info.role === "assistant")
        }),
      delete: (args: IdArgs) => call(args, async () => true),
      summarize: (args: IdArgs) =>
        call(args, async () => {
          await run(ctx.session.compact({ sessionID: SessionID.make(args.path.id) }))
          return true
        }),
      children: (args: IdArgs) =>
        call(args, async () => {
          const ids = [...(deps.state.children.get(args.path.id) ?? [])].filter((id) => !pending.has(id))
          const infos = await Promise.all(ids.map((id) => info(id).then(sessionInfo, () => undefined)))
          return infos.filter((entry) => entry !== undefined)
        }),
      list: (args?: { readonly throwOnError?: boolean }) =>
        call(args, async () => {
          const ids = [...new Set([...deps.state.children.keys(), ...[...deps.state.children.values()].flatMap((set) => [...set])])]
          const infos = await Promise.all(
            ids.filter((id) => !pending.has(id)).map((id) => info(id).then(sessionInfo, () => undefined)),
          )
          return infos.filter((entry) => entry !== undefined)
        }),
    },
    tui: {
      showToast: (args: { readonly body?: Record<string, unknown>; readonly throwOnError?: boolean }) =>
        call(args, async () => {
          deps.toast(args.body ?? {})
          return true
        }),
    },
    app: {
      agents: (args?: { readonly throwOnError?: boolean }) => call(args, async () => [...(await deps.listAgents())]),
      skills: (args?: { readonly throwOnError?: boolean }) => call(args, async () => []),
    },
    provider: {
      list: (args?: { readonly throwOnError?: boolean }) =>
        call(args, async () => {
          const models = (await run(ctx.model.list())).data
          const providers = [...new Set(models.map((model) => model.providerID))]
          return {
            all: providers.map((providerID) => ({
              id: providerID,
              name: providerID,
              models: Object.fromEntries(
                models
                  .filter((model) => model.providerID === providerID)
                  .map((model) => [model.id, { id: model.id, name: model.name, providerID }]),
              ),
            })),
            connected: providers,
            default: {},
          }
        }),
    },
    config: {
      get: (args?: { readonly throwOnError?: boolean }) =>
        call(args, async () => {
          const model = (await run(ctx.model.default())).data
          return model === undefined ? {} : { model: `${model.providerID}/${model.id}` }
        }),
    },
  }
}

export type Client = ReturnType<typeof make>

interface IdArgs {
  readonly path: { readonly id: string }
  readonly throwOnError?: boolean
}

interface PromptArgs extends IdArgs {
  readonly body: Record<string, unknown> & { readonly parts?: unknown }
}

/** Korean labels for omo's notices in the transcript (own-web shows a synthetic message's description). */
export function describe(text: string) {
  if (text.includes("TODO CONTINUATION")) return "omo: 남은 할 일을 이어서 해요"
  if (text.includes("[BACKGROUND TASK") || text.includes("[ALL BACKGROUND TASKS COMPLETE]")) return "omo: 배경 작업이 끝났어요"
  return "omo 알림"
}

/**
 * OpenCode 1 session rules omo puts on a child (`{permission, action, pattern}`) as OpenCode 2 rules. Only denials and
 * asks: omo never widens what a child may do (15 §4.7).
 */
/** own.accounts asks every GitHub write (16 §5.4); a child's session rules end with it. */
const ASK_GITHUB_WRITES: Permission.Rule = { action: OwnGitHub.WRITE_ACTION, resource: "*", effect: "ask" }

export function permissions(rules: ReadonlyArray<unknown>): Array<Permission.Rule> {
  return rules.flatMap((rule): Array<Permission.Rule> => {
    if (!isRecord(rule) || typeof rule.permission !== "string" || typeof rule.pattern !== "string") return []
    if (rule.action !== "deny" && rule.action !== "ask") return []
    return [{ action: Names.toolToV2(rule.permission), resource: rule.pattern, effect: rule.action }]
  })
}

function sessionInfo(session: Session.Info) {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    directory: session.location.directory,
    ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    title: session.title ?? "",
    ...(session.agent === undefined ? {} : { agent: session.agent }),
    ...(session.model === undefined
      ? {}
      : { model: { id: session.model.id, providerID: session.model.providerID, variant: session.model.variant } }),
    version: "",
    time: { created: Date.now(), updated: Date.now() },
  }
}

/** OpenCode 1 SDK result shape: `{data, error, response}`, or a throw with `throwOnError`. */
async function call<T>(args: { readonly throwOnError?: boolean } | undefined, run: () => Promise<T>) {
  try {
    return { data: await run(), error: undefined, response: { status: 200, ok: true } }
  } catch (error) {
    if (args?.throwOnError === true) throw error
    const message = error instanceof Error ? error.message : String(error)
    return { data: undefined, error: { name: "UnknownError", data: { message } }, response: { status: 500, ok: false } }
  }
}

function booleans(tools: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(tools).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

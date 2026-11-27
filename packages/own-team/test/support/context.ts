// Plugin-level test support (06 §11.2 "플러그인 단위"): a fake PluginContext per Location over one shared "world"
// (the global KV, the sessions, own.accounts' RPC answers and the event bus), the real `@own/runtime` on a temp
// OWN_HOME, and fixture builders for team and area records. Every value is fake; nothing reads this PC's accounts.
// A context member a test did not need throws when touched, so a test fails loudly instead of using a default.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { Controller } from "../../src/controller.js"
import type { Hub } from "../../src/hub.js"
import plugin from "../../src/index.js"
import { Log } from "../../src/log.js"
import type { Services } from "../../src/services.js"
import { removeTree } from "./remove.js"

let counter = 0

/** A unique build id per test, so tests never share a controller or a runtime singleton. */
export function buildId(name = "t") {
  return `test-team-${name}-${process.pid}-${++counter}`
}

export async function tempHome() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-team-home-")))
  return {
    root,
    async [Symbol.asyncDispose]() {
      await removeTree(root)
    },
  }
}

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export interface FakeSession {
  readonly id: string
  readonly directory: string
  permissions: Rule[]
}

export interface Registered {
  readonly definition: { readonly methods: Readonly<Record<string, unknown>> }
  readonly handlers: Readonly<Record<string, (input: unknown, context: unknown) => Promise<unknown>>>
  readonly emitted: Array<{ readonly name: string; readonly data: Readonly<Record<string, unknown>> }>
  disposed: boolean
}

export interface ToolAdded {
  readonly name: string
  readonly description: string
  readonly input: unknown
  readonly output: unknown
  readonly options: {
    readonly namespace?: string
    readonly permission?: string
    readonly codemode?: boolean
    readonly pinned?: boolean
  }
  readonly execute: (
    input: unknown,
    context: { readonly sessionID: string },
  ) => Promise<{
    readonly output?: unknown
    readonly content?: unknown
  }>
}

export interface AgentInfo {
  id: string
  permissions: Rule[]
}

/** State every Location of one fake server shares. */
export class World {
  readonly kv = new Map<string, Schema.Json>()
  readonly sessions = new Map<string, FakeSession>()
  /** own.accounts method answers; a missing method rejects like `rpc.method_not_found`. */
  readonly accounts = new Map<string, (input: unknown) => unknown>()
  readonly calls: Array<{ readonly method: string; readonly input: unknown }> = []
  readonly #subscribers = new Set<(event: Hub.Incoming) => void>()

  /** Publishes a core event to every subscribed instance. */
  publish(event: Hub.Incoming) {
    for (const subscriber of this.#subscribers) subscriber(event)
  }

  subscribe(subscriber: (event: Hub.Incoming) => void) {
    this.#subscribers.add(subscriber)
    return () => {
      this.#subscribers.delete(subscriber)
    }
  }
}

export interface Fake {
  readonly ctx: Plugin.Context
  readonly registrations: Registered[]
  readonly tools: ToolAdded[]
  readonly namespaces: Array<{ readonly name: string; readonly description: string }>
  /** The worktree conversation tools (namespace `worktree`, 06 §13), kept apart from the team's. */
  readonly worktreeTools: ToolAdded[]
  /** Worktree strategies registered (06 §4.12a: own.team's `git`). */
  readonly strategies: Array<{ readonly id: string }>
  /** Agent transforms in registration order (`null` once disposed). */
  readonly agentTransforms: Array<((editor: AgentEditorFake) => void) | null>
  readonly hooks: Map<string, Array<(input: never) => Promise<void> | void>>
}

export interface AgentEditorFake {
  list(): AgentInfo[]
  update(id: string, update: (agent: AgentInfo) => void): void
}

export function context(
  world: World,
  input: {
    readonly directory: string
    readonly options?: Readonly<Record<string, unknown>>
    readonly version?: string
    readonly channel?: string
  },
): Fake {
  const registrations: Registered[] = []
  const tools: ToolAdded[] = []
  const namespaces: Array<{ name: string; description: string }> = []
  const worktreeTools: ToolAdded[] = []
  const strategies: Array<{ readonly id: string }> = []
  const agentTransforms: Array<((editor: AgentEditorFake) => void) | null> = []
  const hooks = new Map<string, Array<(input: never) => Promise<void> | void>>()
  const hook = (name: string, callback: (input: never) => Promise<void> | void) => {
    hooks.set(name, [...(hooks.get(name) ?? []), callback])
    return Promise.resolve({
      dispose: async () => {
        hooks.set(
          name,
          (hooks.get(name) ?? []).filter((item) => item !== callback),
        )
      },
    })
  }
  const rpcClient = (definition: { readonly id: string; readonly methods: Readonly<Record<string, unknown>> }) =>
    Object.fromEntries(
      Object.keys(definition.methods).map((method) => [
        method,
        async (callInput: unknown) => {
          world.calls.push({ method, input: callInput })
          const answer = world.accounts.get(method)
          if (!answer) throw { type: "rpc.method_not_found", message: `Unknown RPC method: ${definition.id}.${method}` }
          return answer(callInput)
        },
      ]),
    )
  const parts: Readonly<Record<string, unknown>> = {
    app: { name: "opencode", version: input.version ?? "local", channel: input.channel ?? "local" },
    location: { directory: input.directory },
    options: input.options ?? {},
    storage: {
      get: async (key: string) => world.kv.get(key),
      set: async (key: string, value: Schema.Json) => {
        world.kv.set(key, structuredClone(value))
      },
      remove: async (key: string) => {
        world.kv.delete(key)
      },
      scan: async (options: { readonly prefix: string; readonly after?: string; readonly limit?: number }) => {
        const keys = [...world.kv.keys()]
          .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
          .sort()
        const limit = options.limit ?? 100
        const page = keys.slice(0, limit)
        const entries = page.map((key) => ({ key, value: world.kv.get(key) }))
        return keys.length > limit ? { entries, next: page[page.length - 1] } : { entries }
      },
    },
    rpc: Object.assign(rpcClient, {
      register: async (definition: Registered["definition"], handlers: Registered["handlers"]) => {
        const registered: Registered = { definition, handlers, emitted: [], disposed: false }
        registrations.push(registered)
        return {
          dispose: async () => {
            registered.disposed = true
          },
          events: {
            emit: async (name: string, data: Readonly<Record<string, unknown>>) => {
              registered.emitted.push({ name, data })
            },
          },
        }
      },
    }),
    agent: {
      transform: async (callback: (editor: AgentEditorFake) => void) => {
        const index = agentTransforms.push(callback) - 1
        return {
          dispose: async () => {
            agentTransforms[index] = null
          },
        }
      },
    },
    tool: {
      transform: async (
        callback: (editor: {
          namespace(info: { name: string; description: string }): void
          add(tool: ToolAdded): void
        }) => void,
      ) => {
        callback({
          namespace: (info) => (info.name === "worktree" ? undefined : namespaces.push(info)),
          add: (tool) => (tool.options.namespace === "worktree" ? worktreeTools.push(tool) : tools.push(tool)),
        })
        return { dispose: async () => {} }
      },
      hook: (name: string, callback: (input: never) => Promise<void> | void) => hook(`tool.${name}`, callback),
    },
    session: {
      get: async (request: { readonly sessionID: string }) => {
        const found = world.sessions.get(request.sessionID)
        if (!found) throw new Error(`session ${request.sessionID} not found`)
        return { id: found.id, location: { directory: found.directory }, permissions: [...found.permissions] }
      },
      update: async (request: { readonly sessionID: string; readonly permissions?: Rule[] }) => {
        const found = world.sessions.get(request.sessionID)
        if (!found) throw new Error(`session ${request.sessionID} not found`)
        if (request.permissions) found.permissions = request.permissions.map((rule) => ({ ...rule }))
      },
      hook: (name: string, callback: (input: never) => Promise<void> | void) => hook(`session.${name}`, callback),
    },
    worktree: {
      transform: async (callback: (editor: { add(definition: { readonly id: string }): void }) => void) => {
        callback({ add: (definition) => strategies.push({ id: definition.id }) })
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: (name: string, callback: (input: never) => Promise<void> | void) => hook(`permission.${name}`, callback),
    },
    event: {
      subscribe: (options?: { readonly signal?: AbortSignal }) => events(world, options?.signal),
    },
  }
  const strict = new Proxy(parts, {
    get: (target, key) => {
      if (typeof key === "symbol" || key === "then") return undefined
      if (key in target) return target[key]
      throw new Error(`test context: ctx.${key} was not provided`)
    },
  })
  // SAFETY: the fake provides the context members own.team uses; any other access throws above.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    ctx: strict as unknown as Plugin.Context,
    registrations,
    tools,
    namespaces,
    worktreeTools,
    strategies,
    agentTransforms,
    hooks,
  }
}

/** One instance's event stream: the world's events from now on, until `signal` aborts. */
function events(world: World, signal: AbortSignal | undefined): AsyncIterable<Hub.Incoming> {
  return {
    [Symbol.asyncIterator]() {
      const queue: Hub.Incoming[] = []
      const waiting: Array<(result: IteratorResult<Hub.Incoming>) => void> = []
      const stop = world.subscribe((event) => {
        const next = waiting.shift()
        if (next) next({ value: event, done: false })
        else queue.push(event)
      })
      const end = () => {
        stop()
        for (const next of waiting.splice(0)) next({ value: undefined, done: true })
      }
      signal?.addEventListener("abort", end, { once: true })
      return {
        next: () => {
          if (signal?.aborted) return Promise.resolve({ value: undefined, done: true })
          const queued = queue.shift()
          if (queued) return Promise.resolve({ value: queued, done: false })
          return new Promise((resolve) => waiting.push(resolve))
        },
        return: () => {
          end()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

/** Sets `OWN_OPEN_CODE` (and optionally `OWN_REMOTE`) for this test process; the returned function restores them. */
export function managedEnv(values: { readonly OWN_OPEN_CODE?: string; readonly OWN_REMOTE?: string } = {}) {
  const saved = { OWN_OPEN_CODE: process.env.OWN_OPEN_CODE, OWN_REMOTE: process.env.OWN_REMOTE }
  const apply = (name: "OWN_OPEN_CODE" | "OWN_REMOTE", value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  apply("OWN_OPEN_CODE", "OWN_OPEN_CODE" in values ? values.OWN_OPEN_CODE : "1")
  apply("OWN_REMOTE", values.OWN_REMOTE)
  return () => {
    apply("OWN_OPEN_CODE", saved.OWN_OPEN_CODE)
    apply("OWN_REMOTE", saved.OWN_REMOTE)
  }
}

/** Runs the plugin's setup on a fake context; returns the fake and its cleanup. */
export async function boot(
  world: World,
  input: Parameters<typeof context>[1],
): Promise<Fake & { readonly cleanup: () => Promise<void> }> {
  const fake = context(world, input)
  const cleanup = await plugin.setup(fake.ctx)
  return { ...fake, cleanup: async () => void (await cleanup?.()) }
}

/**
 * A controller without the plugin around it: one fake instance attached (its storage is the world's KV), started at
 * once (no lock), on a manual clock. For registry, op and service tests.
 */
export function controller(
  world: World,
  input: {
    readonly directory: string
    readonly clock: Services.Clock
    readonly home?: string
    readonly source?: ServiceTarget.Source
    readonly features?: Partial<Services.Factories>
    readonly log?: Log.Logger
  },
) {
  const fake = context(world, { directory: input.directory })
  const service = new Controller.Service({
    buildId: buildId("controller"),
    home: input.home ?? input.directory,
    log: input.log ?? Log.silent,
    clock: input.clock,
    source: input.source ?? ServiceTarget.fixed({ url: "http://127.0.0.1:9", password: "fake-password-unused" }),
    ...(input.features === undefined ? {} : { features: input.features }),
  })
  const detach = service.attach({ ctx: fake.ctx, directory: input.directory, control: true, leader: () => true })
  const published: Hub.Outgoing[] = []
  service.hub.subscribe((event) => published.push(event))
  service.start()
  return {
    controller: service,
    services: service.services,
    fake,
    published,
    detach,
    close: async () => {
      detach()
      await service.close()
    },
  }
}

/** The handler of `method` in a registration, called with a context whose `error` returns the error object. */
export function call(registered: Registered, method: string, input: unknown) {
  const handler = registered.handlers[method]
  if (!handler) throw new Error(`no handler ${method}`)
  return handler(input, {
    signal: new AbortController().signal,
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture records

export const TEAM_ID = OwnTeam.TeamID.make("tm_0123456789ab")
export const MAIN_SESSION = SessionID.make("ses_main0000000000000000000001")
export const OWNER_SESSION = SessionID.make("ses_owner000000000000000000001")
export const OLD_OWNER = SessionID.make("ses_owner000000000000000000000")

/**
 * The shared test team. `directHold` is off unless a test asks for it (2026-11-14): with it on, a user message in an
 * owner conversation would hold the area, which only the direct-work tests are about.
 */
export function team(input: {
  readonly home: string
  readonly state?: "on" | "off"
  readonly directHold?: boolean
}): OwnTeam.Team {
  return {
    id: TEAM_ID,
    projectID: "prj_test",
    commonDir: path.join(input.home, ".git"),
    target: "main",
    state: input.state ?? "on",
    rev: 0,
    home: { directory: input.home, linked: false, chosenBy: "session" },
    main: { sessionID: MAIN_SESSION, previous: [] },
    worktreeRoot: `${input.home}-team`,
    heavy: { dirs: [], measuredAt: null, forcedBytes: 0 },
    shared: [],
    commands: { setup: null, code: [], assets: [] },
    env: { symlinkFix: "none", bunCache: "unused", lfs: "unused" },
    external: [],
    policy: { ...OwnTeam.POLICY, directHold: input.directHold ?? false },
    patterns: [],
  }
}

export function area(input: { readonly slug: string; readonly directory: string; readonly at?: number }): OwnTeam.Area {
  return {
    id: OwnTeam.AreaID.make(`ar_${input.slug}`),
    teamID: TEAM_ID,
    name: input.slug,
    goal: "",
    origin: "created",
    state: "active",
    branch: input.slug,
    gitDir: path.join(input.directory, ".git"),
    base: { sha: "a".repeat(40), at: input.at ?? 0 },
    directory: input.directory,
    shape: "plain",
    cone: { extra: {}, kept: {} },
    owner: {
      sessionID: OWNER_SESSION,
      previous: [{ sessionID: OLD_OWNER, endedAt: 0, why: "user" }],
      attached: true,
    },
    preset: Preset.builtinID("codex"),
    paused: false,
    status: { kind: "idle", at: 0, text: "" },
    handoff: null,
  }
}

export const MODEL = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-test", providerID: "openai" })

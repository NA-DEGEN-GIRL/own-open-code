export * as Runtime from "./runtime.js"

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Home } from "@own/runtime"
import { Effect, Scope } from "effect"
import { OmoConfig } from "./config.js"
import { Agents } from "./host/agents.js"
import { V1Client } from "./host/client.js"
import { Commands } from "./host/commands.js"
import type { V1Events } from "./host/events.js"
import { Names } from "./host/names.js"
import type { Overlays } from "./host/overlay.js"
import type { OmoSessions } from "./host/session.js"
import { Todos } from "./host/todo.js"
import { Tools } from "./host/tools.js"
import type { OmoRuntime, V1CreatedHooks, V1Event, V1Hooks } from "./omo-runtime.js"
import type { Options } from "./options.js"

/** The OpenCode 1 plugin API omo v5.1.50 was built for (its `@opencode-ai/plugin` 1.18.31); omo's version checks read it. */
export const V1_API = "1.18.31"
/** The tool gate of omo's tools (own-harness `gate.ts` `OMO_ACTION`): listed only in sessions bound to `omo`. */
export const GATE = "own_harness_omo"
const KEY = Symbol.for("own.omo.runtime")

/** A started omo runtime of one Location. */
export interface Started {
  readonly runtime: OmoRuntime
  readonly hooks: V1Hooks
  readonly agents: Names.Agents
  readonly registered: ReadonlyArray<Agents.Registered>
  /** omo's Sisyphus prompt, which core `build` runs as in omo sessions (system[0]). */
  readonly sisyphus: string | undefined
  readonly client: V1Client.Client
}

/**
 * `omo-runtime.js`: `OWN_OMO_RUNTIME`, else next to this module (the release bundle's `plugins/own-omo/`), else the
 * source run's build output `own/.out/omo` (script/bundle.ts default).
 */
export function locate() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.OWN_OMO_RUNTIME,
    path.join(here, "omo-runtime.js"),
    path.join(here, "..", "..", "..", "own", ".out", "omo", "omo-runtime.js"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "")
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (found === undefined) throw new Error(`omo-runtime.js not found (looked at ${candidates.join(", ")})`)
  return found
}

/**
 * The runtime module, loaded once per process like an OpenCode 1 plugin (each Location starts its own `server()`).
 * own's folders for omo (OMO-P2, OMO-P4, OMO-P6) are set before the import: omo resolves some of them while it loads
 * (`OPENCODE_STORAGE`, where the agent-usage-reminder writes, and the update checker's cache root), and would otherwise
 * use OpenCode 1's `~/.local/share/opencode/storage` and create `~/.cache`. `OMO_OWN_PROJECT_SKILLS` tells omo's own
 * skill discovery whether it may read the project's skills (OMO-P9).
 */
export function module(home?: string): Promise<OmoRuntime> {
  const holder = globalThis as typeof globalThis & { [KEY]?: Promise<OmoRuntime> }
  if (holder[KEY] !== undefined) return holder[KEY]
  const dirs = paths(home)
  process.env.OMO_OWN_HOST = "1"
  process.env.OMO_OWN_DATA_HOME = dirs.data
  process.env.OMO_OWN_CACHE_HOME = dirs.cache
  process.env.OMO_OWN_STATE_HOME = dirs.projects
  process.env.OMO_OWN_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || dirs.config
  process.env.OMO_OWN_PROJECT_SKILLS = projectSkills() ? "1" : "0"
  // SAFETY: omo-runtime.js is the bundle of src/runtime-entry.ts, whose exports omo-runtime.d.ts declares.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  holder[KEY] = import(pathToFileURL(locate()).href) as Promise<OmoRuntime>
  return holder[KEY]
}

/**
 * Whether this service reads project config, the way core's CLI decides it (`packages/cli/src/server-process.ts`:
 * `OPENCODE_CONFIG_PROJECT_DISABLE`, else `OPENCODE_DISABLE_PROJECT_CONFIG`). omo finds skills by itself, beside
 * core's list, so without this it named and loaded a project's `.opencode/skills` and `.agents/skills` on an SSH host
 * whose project settings are off, or in the PC's untrusted mode. Instruction files alone (a host's `지시 파일만`) do
 * not turn project skills on: they need project config, like core's own skill list.
 */
export function projectSkills(env: Readonly<Record<string, string | undefined>> = process.env) {
  const disabled = env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG
  return !(disabled === "1" || disabled?.toLowerCase() === "true")
}

/**
 * `<OWN_HOME>/thirdparty/omo`: omo's data, caches, config fallback, per-project state and log (OMO-P2, OMO-P4,
 * OMO-P6), and own-omo's own log in own's log folder (`<OWN_HOME>/logs/own-omo.log`: omo's notices). `home` is the
 * plugin option (a remote host's install names it, 04 §5.6), else `OWN_HOME` or its default.
 */
export function paths(home?: string) {
  const own = Home.resolve(home === undefined ? {} : { home })
  const root = path.join(own, "thirdparty", "omo")
  return {
    root,
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    projects: path.join(root, "projects"),
    log: path.join(root, "logs", "omo.log"),
    notices: path.join(own, "logs", "own-omo.log"),
  }
}

type Ctx = Pick<Context, "session" | "location" | "model" | "agent" | "tool" | "command" | "permission" | "storage">

export interface Parts {
  readonly state: V1Events.State
  readonly overlays: Overlays.Store
  readonly todos: Todos.Store
  readonly sessions: OmoSessions.Cache
  /** The plugin's scope: tools, agents and commands registered at start live as long as the plugin. */
  readonly scope: Scope.Scope
  /** Hands OpenCode 1 events to omo, in order per session (index.ts). */
  readonly deliver: (sessionID: string, events: ReadonlyArray<V1Event>) => void
}

/**
 * One Location's omo, started on first need (15 §2.3): an omo session's prompt, its creation, a binding to `omo`. Start
 * runs omo's plugin entry with own's client and startup steps, its config hook with own's config, and registers its
 * agents, tools and commands.
 */
export class Host {
  private started: Promise<Started> | undefined
  private ready: Started | undefined

  constructor(
    private readonly ctx: Ctx,
    private readonly options: Options.Info,
    private readonly parts: Parts,
  ) {}

  current() {
    return this.ready
  }

  ensure() {
    this.started ??= this.start().then(
      (started) => (this.ready = started),
      (error: unknown) => {
        this.started = undefined
        throw error
      },
    )
    return this.started
  }

  dispose() {
    const started = this.ready
    this.ready = undefined
    this.started = undefined
    return started?.hooks.dispose?.() ?? Promise.resolve()
  }

  private async start(): Promise<Started> {
    const ctx = this.ctx
    const parts = this.parts
    const runtime = await module(this.options.home)
    const dirs = paths(this.options.home)
    fs.mkdirSync(path.dirname(dirs.log), { recursive: true })
    runtime.setVersionCache(V1_API)
    runtime.setLogFile(dirs.log)
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
    const fallback = (await run(ctx.model.default())).data
    const model = fallback === undefined ? "" : `${fallback.providerID}/${fallback.id}`
    const config = OmoConfig.resolve(runtime, { model, ...(this.options.config === undefined ? {} : { user: this.options.config }) })
    const names = { current: Names.agents({ registered: new Map(), keyOf: runtime.getAgentConfigKey }) }
    const v1Config: Record<string, unknown> & { agent: Record<string, unknown>; command: Record<string, unknown> } = {
      model,
      agent: {},
      command: {},
      mcp: {},
      provider: {},
      permission: {},
      tools: {},
    }
    const client = V1Client.make({
      ctx,
      state: parts.state,
      overlays: parts.overlays,
      todos: parts.todos,
      agents: () => names.current,
      listAgents: async () => Agents.list(v1Config.agent, (await run(ctx.agent.list())).data, names.current),
      marker: runtime.OMO_INTERNAL_INITIATOR_MARKER,
      toast: (body) => toast(dirs.notices, body),
    })
    const hooks = await runtime
      .createPluginModule(overrides(runtime, config, (sessionID) => parts.sessions.isTeam(sessionID)))
      .server(
        {
          client,
          directory: ctx.location.directory,
          worktree: ctx.location.directory,
          project: { id: "own", worktree: ctx.location.directory },
          serverUrl: undefined,
          $: Bun.$,
          experimental_workspace: { register() {} },
        },
        {},
      )
    await hooks.config?.(v1Config)
    const registered = Agents.translate(v1Config.agent, {
      keyOf: runtime.getAgentConfigKey,
      restrictions: (key) => runtime.getAgentToolRestrictions(key, { includeTeamToolDenylist: false }),
    })
    names.current = Names.agents({
      registered: new Map(registered.map((agent) => [agent.key, agent.display])),
      keyOf: runtime.getAgentConfigKey,
    })
    const sisyphus = v1Config.agent[Names.SISYPHUS]
    const tools: Array<Tool.Info> = [
      ...Tools.BRIDGED.flatMap((name) => {
        const definition = hooks.tool?.[name]
        return definition === undefined
          ? []
          : [Tools.bridge(ctx, { name, definition, z: runtime.z, agents: names.current, permission: GATE })]
      }),
    ]
    await Effect.runPromise(
      Effect.all(
        [
          Agents.register(ctx, registered),
          ctx.tool.transform((editor) => tools.forEach((tool) => editor.add(tool))).pipe(Effect.andThen(ctx.tool.reload())),
          Commands.register(ctx, {
            commands: v1Config.command,
            hooks,
            isOmo: (sessionID) => parts.sessions.isOmo(sessionID),
            isTeam: (sessionID) => parts.sessions.isTeam(sessionID),
            // An idle session with open todos continues now, as at the end of its next turn.
            resumed: (sessionID) => {
              if (!parts.state.status.has(sessionID))
                parts.deliver(sessionID, [{ type: "session.idle", properties: { sessionID } }])
            },
          }),
        ],
        { discard: true },
      ).pipe(Scope.provide(parts.scope)),
    )
    return {
      runtime,
      hooks,
      agents: names.current,
      registered,
      sisyphus:
        typeof sisyphus === "object" && sisyphus !== null && "prompt" in sisyphus && typeof sisyphus.prompt === "string"
          ? sisyphus.prompt
          : undefined,
      client,
    }
  }
}

/**
 * omo's startup steps own replaces (15 §2.3): no sweeps, migrations, detection, live routes, telemetry, OpenClaw, tmux.
 * omo's hooks are its own, but its todo continuation gets no `session.idle` of own.team's sessions ({@link outsideTeams}).
 */
function overrides(runtime: OmoRuntime, config: Record<string, unknown>, isTeam: (sessionID: string) => Promise<boolean>) {
  return {
    createHooks: (args: Record<string, unknown>) => outsideTeams(runtime.createHooks(args), isTeam),
    installAgentSortShim: () => {},
    setAgentSortOrder: () => {},
    logLegacyPluginStartupWarning: () => {},
    migrateLegacyWorkspaceDirectory: () => {},
    runOpenCodeStartupMigration: () => ({
      migratedFrom: [],
      skippedConflictCount: 0,
      targetBackupPaths: [],
      journalResumed: false,
    }),
    startOmoProcessSweep: () => Promise.resolve(),
    detectDuplicateOmoPlugin: () => ({ detected: false, duplicatePlugins: [] }),
    detectExternalSkillPlugin: () => ({ detected: false }),
    injectServerAuthIntoClient: () => {},
    initLiveServerRoute: () => {},
    setLiveParentWakeRoutingDisabled: () => {},
    warmLiveServerProbe: () => {},
    recordPluginTelemetry: () => {},
    initializeOpenClaw: () => Promise.resolve(),
    isTmuxIntegrationEnabled: () => false,
    startTmuxCheck: () => {},
    loadConfigChain: () => ({ valid: true, messages: [], warnings: [], path: null, config }),
    loadPluginConfig: () => config,
    createManagers: (args: Record<string, unknown>) =>
      runtime.createManagers({
        ...args,
        deps: { registerManagerForCleanupFn: () => {}, markServerRunningInProcessFn: () => {} },
      }),
  }
}

/**
 * omo's hooks with a todo continuation that never continues own.team's sessions (15 §3.10): own.team decides when a
 * team main, owner or peer runs (its requests, team updates, safe points, handoff turns and pauses), so the
 * continuation's `session.idle` of such a session is not passed on. It would otherwise run an owner the team paused or
 * just replaced (right after its handoff turn), or keep the main doing what it handed to the areas between team
 * updates. Every other event, and every other hook, still sees them.
 */
export function outsideTeams(hooks: V1CreatedHooks, isTeam: (sessionID: string) => Promise<boolean>): V1CreatedHooks {
  const enforcer = hooks.todoContinuationEnforcer
  if (enforcer === undefined || enforcer === null) return hooks
  return {
    ...hooks,
    todoContinuationEnforcer: {
      ...enforcer,
      handler: async (input) => {
        const sessionID = input.event.type === "session.idle" ? input.event.properties?.sessionID : undefined
        if (typeof sessionID === "string" && (await isTeam(sessionID))) return
        return enforcer.handler(input)
      },
    },
  }
}

/** own-omo's log past this size moves to `<file>.1` before the next line, as own-accounts' log does (02 §7.2). */
export const NOTICE_LOG_MAX_BYTES = 10 * 1024 * 1024

/**
 * omo's toasts, which OpenCode 1 showed in its terminal, as `info` lines of own's log (`<OWN_HOME>/logs/own-omo.log`,
 * 15 §3.4). A skill folder that does not exist is no failure, though omo reports one `Skill load error` per missing
 * folder at every start: that notice is left out (omo's own log keeps its `[skill-load]` line).
 */
export function toast(file: string, body: Record<string, unknown>) {
  const message = typeof body.message === "string" ? body.message : ""
  if (body.title === "Skill load error" && message.includes("ENOENT")) return
  const line = `${JSON.stringify({
    ts: Date.now(),
    level: "info",
    scope: "own.omo",
    msg: "omo notice",
    title: body.title,
    message: body.message,
    variant: body.variant,
  })}\n`
  fs.mkdir(path.dirname(file), { recursive: true }, () =>
    fs.stat(file, (error, stats) => {
      if (error !== null || stats.size < NOTICE_LOG_MAX_BYTES) return fs.appendFile(file, line, () => {})
      fs.rename(file, `${file}.1`, () => fs.appendFile(file, line, () => {}))
    }),
  )
}

export function todoUpdated(sessionID: string, todos: ReadonlyArray<Todos.Item>): V1Event {
  return { type: "todo.updated", properties: { sessionID, todos: todos.map((todo) => ({ ...todo })) } }
}

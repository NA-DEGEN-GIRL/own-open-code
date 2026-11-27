// Test support for the plugins and health modules: a fake Location (plugin list derived from a temp
// OPENCODE_CONFIG_DIR, the way the config watcher would reload it), a fake of the bundled claude-auth (02 §8.2),
// recording peers and an RPC call helper. Real third-party packages are never touched.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { Plugin, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import type { Deps } from "../../src/deps.js"
import type { Module } from "../../src/module.js"
import type { Modules } from "../../src/modules.js"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import type { Inventory } from "../../src/plugins/inventory.js"
import { Plugins } from "../../src/plugins/plugins.js"
import type { RemoteHost } from "../../src/remote/host.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { removeTree } from "../e2e-kit/harness/remove.js"
import { testDeps } from "../support/deps.js"
import { FAKE_BUNDLE_PIN, type FakeClaudeAuthOptions, writeFakeClaudeAuth } from "../support/fake-claude-auth.js"

export type Entry = Inventory.Entry
type Connection = Awaited<ReturnType<Deps["ctx"]["integration"]["connection"]["active"]>>

/** The fake bundle's pin (`own-bundle.json`). */
export const FAKE_PIN = FAKE_BUNDLE_PIN

export function configText(input: { readonly accounts: string; readonly telemetry: string; readonly extra?: string }) {
  return [
    "{",
    "  // own-open-code global config (test)",
    '  "update": "disable",',
    '  "plugins": [',
    `    ${JSON.stringify(input.accounts)},`,
    "    // The Claude subscription plugin ships with the app (02 §8.2)",
    ...(input.extra ? [`    ${JSON.stringify(input.extra)},`] : []),
    `    ${JSON.stringify(input.telemetry)}`,
    "  ],",
    '  "share": "disabled"',
    "}",
    "",
  ].join("\n")
}

export interface World extends AsyncDisposable {
  readonly deps: Deps
  readonly clock: Awaited<ReturnType<typeof testDeps>>["clock"]
  readonly root: string
  readonly workspace: string
  readonly configDir: string
  /** Where this app ships the Claude plugin (`app\<version>\plugins\claude-auth`); empty until {@link bundle}. */
  readonly bundleDir: string
  /** `<OWN_HOME>\thirdparty\claude-auth`: own's account list and the plugin's per-account state. */
  readonly stateDir: string
  readonly own: { readonly root: string; readonly accounts: string; readonly telemetry: string }
  readonly storage: Map<string, unknown>
  /** Plugins discovered in the workspace (they come first, like upstream's `.opencode/plugins`). */
  readonly project: Entry[]
  /** Replaces the whole plugin list (otherwise it is derived from the config file). */
  override: { entries?: ReadonlyArray<Entry> }
  connection: Connection
  readonly alerts: Telemetry.AlertInput[]
  readonly events: Array<{ readonly name: string; readonly payload: Readonly<Record<string, unknown>> }>
  readonly reloads: { count: number; agents: number }
  readonly plugins: Plugins.Api
  registry: Registry.File
  /** Writes the fake bundle into {@link bundleDir} (`own-bundle.json` and all) and answers its entry file. */
  bundle(options?: FakeClaudeAuthOptions): string
  /** A second instance of the plugins module for another Location of the same process. */
  location(directory: string, entries: () => ReadonlyArray<Entry>): Promise<Plugins.Api>
  entries(): Promise<ReadonlyArray<Entry>>
  ctx: Record<string, unknown>
}

/**
 * One control-location plugins module on a real runtime (temp OWN_HOME, memory vault, manual clock) with a temp
 * OPENCODE_CONFIG_DIR. Not started; call `plugins.start()`. The config names the bundle folder between own-accounts
 * and own-telemetry, as the launcher writes it; nothing is in the folder until {@link World.bundle}.
 */
export async function world(
  options: {
    readonly config?: string
    readonly leader?: boolean
    readonly extraCtx?: Record<string, unknown>
    /** A remote service (04 §8.11.4.3): the members the plugins module reads of `Deps.remote`. */
    readonly remote?: RemoteHost.Api
  } = {},
): Promise<World> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-plugins-test-")))
  const workspace = path.join(root, "workspace")
  const configDir = path.join(root, "config")
  const ownRoot = path.join(root, "app", "plugins")
  const own = {
    root: ownRoot,
    accounts: path.join(ownRoot, "own-accounts"),
    telemetry: path.join(ownRoot, "own-telemetry"),
  }
  const bundleDir = path.join(ownRoot, ClaudeBundle.DIR_NAME)
  await Promise.all(
    [workspace, configDir, own.accounts, own.telemetry].map((dir) => fs.mkdir(dir, { recursive: true })),
  )
  await Bun.write(
    path.join(configDir, "opencode.jsonc"),
    options.config ?? configText({ accounts: own.accounts, telemetry: own.telemetry, extra: bundleDir }),
  )
  const storage = new Map<string, unknown>()
  const state = {
    project: [] as Entry[],
    override: {} as { entries?: ReadonlyArray<Entry> },
    connection: undefined as Connection,
  }
  const derived = async (): Promise<ReadonlyArray<Entry>> => {
    if (state.override.entries) return state.override.entries
    const text = await fs.readFile(path.join(configDir, "opencode.jsonc"), "utf8").catch(() => "{}")
    const targets: unknown = parse(text)?.plugins
    const configured = (Array.isArray(targets) ? targets : []).flatMap((target): Entry[] =>
      typeof target === "string" ? configuredEntry(target) : [],
    )
    return [builtin("core"), ...state.project, ...(await Promise.all(configured.map(loadable))), builtin("post")]
  }
  const ctx: Record<string, unknown> = {
    plugin: { list: async () => ({ location: { directory: workspace }, data: await derived() }) },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
    },
    integration: { connection: { active: async () => state.connection } },
    ...options.extraCtx,
  }
  const test = await testDeps({
    ctx,
    directory: workspace,
    control: true,
    leader: options.leader ?? true,
    ...(options.remote ? { remote: options.remote } : {}),
  })
  const stateDir = ClaudeBundle.stateDir(test.deps.runtime.layout.thirdparty)
  const alerts: Telemetry.AlertInput[] = []
  const reloads = { count: 0, agents: 0 }
  const events = recordEvents(test.deps)
  const config: Plugins.Config = { bundleDir, ownRoots: [own.root] }
  const holder: { registry: Registry.File } = { registry: Store.emptyRegistry() }
  const peers: Module.Peers = () =>
    // SAFETY: the plugins module only uses slots.reload/snapshot/mutate, telemetry.alert and itself.
    ({
      slots: {
        reload: async () => {
          reloads.count++
        },
        snapshot: () => holder.registry,
        // As `Slots.mutate`: the registry file through the runtime, then `store.changed` when it changed.
        mutate: async (change: (current: Registry.File) => Registry.File | undefined) => {
          const outcome = { changed: false }
          holder.registry = await test.deps.runtime.registry.update((current) => {
            const result = change(current)
            outcome.changed = result !== undefined && result !== current
            return result
          })
          if (outcome.changed)
            test.deps.runtime.broadcast.emit("store.changed", {
              store: "accounts",
              origin: "local",
              revision: holder.registry.revision,
            })
          return holder.registry
        },
      },
      telemetry: { alert: (input: Telemetry.AlertInput) => alerts.push(input) },
      claude: { sync: async () => {} },
      presets: {
        recheckAgents: () => {
          reloads.agents++
        },
      },
      plugins,
    }) as unknown as Modules.All
  const plugins = Plugins.make(test.deps, peers, config)
  const extra: Plugins.Api[] = []
  const result: World = {
    deps: test.deps,
    clock: test.clock,
    root,
    workspace,
    configDir,
    bundleDir,
    stateDir,
    own,
    storage,
    project: state.project,
    get override() {
      return state.override
    },
    set override(value) {
      state.override = value
    },
    get connection() {
      return state.connection
    },
    set connection(value) {
      state.connection = value
    },
    alerts,
    events,
    reloads,
    plugins,
    get registry() {
      return holder.registry
    },
    set registry(value) {
      holder.registry = value
    },
    ctx,
    entries: derived,
    bundle: (bundleOptions = { multi: true }) => writeFakeClaudeAuth(bundleDir, bundleOptions).entry,
    location: async (directory, entries) => {
      const deps: Deps = {
        ...test.deps,
        // SAFETY: the second instance only uses ctx.plugin.list, ctx.storage and ctx.integration.
        ctx: {
          ...ctx,
          plugin: { list: async () => ({ location: { directory }, data: entries() }) },
        } as unknown as Deps["ctx"],
        location: { directory, control: false },
      }
      const second = Plugins.make(deps, peers, config)
      await second.start()
      extra.push(second)
      return second
    },
    async [Symbol.asyncDispose]() {
      await Promise.all([plugins, ...extra].map((item) => item.stop()))
      await test[Symbol.asyncDispose]()
      await removeTree(root)
    },
  }
  return result
}

export function builtin(id: string): Entry {
  return { id, source: { type: "builtin" }, features: { server: true }, state: { status: "active" } }
}

export function local(id: string | undefined, file: string, status: "active" | "failed" = "active"): Entry {
  return {
    ...(id ? { id } : {}),
    source: { type: "local", path: file },
    features: { server: true },
    state: status === "active" ? { status } : { status, error: "load failed" },
  }
}

/** What the supervisor would list for one configured directory. */
function configuredEntry(target: string): Entry[] {
  const name = path.basename(target)
  if (name === "own-accounts") return [local("own.accounts", path.join(target, "index.js"))]
  if (name === "own-telemetry") return [local("own.telemetry", path.join(target, "index.js"))]
  if (name === ClaudeBundle.DIR_NAME) return [local(Plugin.CLAUDE_AUTH_ID, path.join(target, "server.js"))]
  return [local(undefined, target)]
}

/** A configured Claude plugin folder loads only when its package is there; otherwise the supervisor reports a failure. */
async function loadable(entry: Entry): Promise<Entry> {
  if (entry.id !== Plugin.CLAUDE_AUTH_ID || entry.source.type !== "local") return entry
  const installed = await fs
    .stat(path.join(path.dirname(entry.source.path), "node_modules", Plugin.CLAUDE_AUTH_PACKAGE, "package.json"))
    .then(
      () => true,
      () => false,
    )
  return installed ? entry : local(undefined, path.dirname(entry.source.path), "failed")
}

/** Binds the emitter to a recorder, so global events are captured instead of dropped. */
export function recordEvents(deps: Deps) {
  const events: Array<{ readonly name: string; readonly payload: Readonly<Record<string, unknown>> }> = []
  const registration = {
    dispose: async () => {},
    events: {
      emit: async (...args: ReadonlyArray<unknown>) => {
        events.push({ name: String(args[0]), payload: args[1] as Readonly<Record<string, unknown>> })
      },
    },
  }
  // SAFETY: the recorder implements the only member the emitter calls (`events.emit`).
  deps.emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
  return events
}

type AnyHandler = (input: never, context: never) => Promise<unknown>
/** A handler result without the declared-error records (`{ type, message, … }`). */
type Success<H extends AnyHandler> = Exclude<
  Awaited<ReturnType<H>>,
  { readonly type: string; readonly message: string }
>

export type CallResult<H extends AnyHandler> =
  | { readonly ok: true; readonly output: Success<H> }
  | { readonly ok: false; readonly type: string; readonly message: string; readonly data: unknown }

/** Calls a handler with a recording context; `error` results come back as `{ ok: false }`. */
export async function call<H extends AnyHandler>(handler: H, input: Parameters<H>[0]): Promise<CallResult<H>> {
  const failure = Symbol("failure")
  const context = {
    signal: new AbortController().signal,
    error: (type: string, message: string, data: unknown) => ({ [failure]: true, type, message, data }),
  }
  // SAFETY: the test context builds plain failure records instead of the host's branded handler errors.
  const result = await (handler as unknown as (input: unknown, context: unknown) => Promise<unknown>)(input, context)
  if (typeof result === "object" && result !== null && failure in result) {
    const error = result as unknown as { readonly type: string; readonly message: string; readonly data: unknown }
    return { ok: false, type: error.type, message: error.message, data: error.data }
  }
  return { ok: true, output: result as Success<H> }
}

/** The output of a successful call; fails the test with the error otherwise. */
export async function ok<H extends AnyHandler>(handler: H, input: Parameters<H>[0]): Promise<Success<H>> {
  const result = await call(handler, input)
  if (!result.ok) throw new Error(`expected success, got ${result.type}: ${result.message}`)
  return result.output
}

/** Polls (real time) until `probe` holds; for work a test cannot await directly. */
export async function until(probe: () => boolean, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs
  while (!probe()) {
    if (performance.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(5)
  }
}

/** A fake session event as the event stream delivers it. */
export function sessionEvent(type: string, data: Record<string, unknown>, directory?: string): Module.OpenCodeEvent {
  // SAFETY: tests build only the fields the plugins module reads (`type`, `data`, `location`).
  return {
    id: `evt_${type}`,
    created: 0,
    type,
    data,
    ...(directory ? { location: { directory } } : {}),
  } as unknown as Module.OpenCodeEvent
}

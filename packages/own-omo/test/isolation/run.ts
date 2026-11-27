// Starts the built omo runtime through own-omo's host with a fake plugin context, in a process of its own, and prints
// what it changed outside its own folders as JSON (test/unit/isolation.test.ts reads it). Usage:
// `bun test/isolation/run.ts <empty temp root>`. The temp root holds OWN_HOME, OPENCODE_CONFIG_DIR and the workspace.
//
// The fetch spy replaces `globalThis.fetch` for this process: the one way to see that omo sends nothing (telemetry,
// update checks, model catalogs), which is the point of this check.
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Result, Scope } from "effect"

const root = process.argv[2]
if (root === undefined) throw new Error("usage: bun test/isolation/run.ts <empty temp root>")
const home = path.join(root, "own-home")
const config = path.join(root, "config")
const workspace = path.join(root, "workspace")
for (const dir of [home, config, workspace]) fs.mkdirSync(dir, { recursive: true })
process.env.OWN_HOME = home
process.env.OPENCODE_CONFIG_DIR = config
// OpenCode 1's data and cache folders, as an installed OpenCode 1 or omo uses them: omo must write in neither. They are
// not created here, so any folder omo makes there shows.
const xdgData = path.join(root, "xdg-data")
const xdgCache = path.join(root, "xdg-cache")
process.env.XDG_DATA_HOME = xdgData
process.env.XDG_CACHE_HOME = xdgCache

const fetches: Array<string> = []
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    fetches.push(String(input instanceof Request ? input.url : input))
    throw new Error("network is off in this check")
  },
  { preconnect: () => {} },
) as typeof fetch
// Every process omo starts, by its command only (never its environment); an `opencode` one is refused.
const spawns: Array<string> = []
const command = (first: unknown) => {
  const value = typeof first === "object" && first !== null && "cmd" in first ? first.cmd : first
  return Array.isArray(value) ? value.map(String).join(" ") : String(value)
}
const record =
  <F extends (...args: Array<never>) => unknown>(name: string, original: F) =>
  (...args: Parameters<F>) => {
    const line = command(args[0])
    spawns.push(`${name}: ${line}`)
    if (/(^|[\\/\s])opencode(\.exe)?(\s|$)/i.test(line)) throw new Error("an opencode process is refused in this check")
    return original(...args)
  }
const methods = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const
for (const name of methods) Object.assign(childProcess, { [name]: record(name, childProcess[name]) })
Object.assign(Bun, { spawn: record("Bun.spawn", Bun.spawn), spawnSync: record("Bun.spawnSync", Bun.spawnSync) })

const SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "beforeExit", "exit", "uncaughtException", "unhandledRejection"] as const
const listeners = () => Object.fromEntries(SIGNALS.map((signal) => [signal, process.listenerCount(signal)]))
const watched = [
  path.join(os.homedir(), ".cache"),
  path.join(os.homedir(), ".local", "share"),
  path.join(os.homedir(), ".config", "opencode"),
  path.join(os.homedir(), ".omo"),
  path.join(os.tmpdir(), "oh-my-opencode.log"),
  path.join(os.tmpdir(), "oh-my-opencode-data"),
  path.join(os.tmpdir(), "opencode-data"),
  path.join(os.tmpdir(), "opencode-cache"),
]
const snapshot = (target: string) => {
  if (!fs.existsSync(target)) return "absent"
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return `file ${stat.size} ${stat.mtimeMs}`
  return `dir ${fs.readdirSync(target).sort().join("|")}`
}
const files = (dir: string): Array<string> =>
  fs.existsSync(dir)
    ? (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    : []

const before = { sort: Array.prototype.sort, toSorted: Array.prototype.toSorted, listeners: listeners() }
const watchedBefore = watched.map(snapshot)

const { Runtime } = await import("../../src/runtime.js")
const { V1Events } = await import("../../src/host/events.js")
const { Overlays } = await import("../../src/host/overlay.js")
const { OmoSessions } = await import("../../src/host/session.js")
const { Todos } = await import("../../src/host/todo.js")
const { Options } = await import("../../src/options.js")

const stored = new Map<string, unknown>()
const registration = { dispose: Effect.void }
const editor = {
  agents: new Map<string, Record<string, unknown>>(),
  tools: [] as Array<string>,
  commands: [] as Array<string>,
}
const ctx = {
  location: { directory: workspace },
  storage: {
    get: (key: string) => Effect.sync(() => stored.get(key)),
    set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
    remove: (key: string) => Effect.sync(() => void stored.delete(key)),
  },
  model: {
    default: () => Effect.succeed({ data: { providerID: "fake-ds", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" } }),
    list: () => Effect.succeed({ data: [{ providerID: "fake-ds", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }] }),
  },
  session: { get: () => Effect.fail(new Error("no sessions here")) },
  agent: {
    transform: (callback: (input: unknown) => void) =>
      Effect.sync(() => {
        callback({
          update: (id: string, update: (info: Record<string, unknown>) => void) => {
            const info = editor.agents.get(id) ?? { id, permissions: [] }
            update(info)
            editor.agents.set(id, info)
          },
        })
        return registration
      }),
    reload: () => Effect.void,
    list: () => Effect.succeed({ data: [] }),
  },
  tool: {
    transform: (callback: (input: unknown) => void) =>
      Effect.sync(() => {
        callback({ add: (tool: { name: string }) => void editor.tools.push(tool.name) })
        return registration
      }),
    reload: () => Effect.void,
  },
  command: {
    transform: (callback: (input: unknown) => void) =>
      Effect.sync(() => {
        callback({ add: (command: { name: string }) => void editor.commands.push(command.name) })
        return registration
      }),
    reload: () => Effect.void,
  },
  permission: { assert: () => Effect.void },
}
// SAFETY: the fake implements what Runtime.Host calls on the plugin context during a start.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const host = new Runtime.Host(ctx as never, Result.getOrUndefined(Options.decodeResult({}))!, {
  state: new V1Events.State(),
  overlays: new Overlays.Store(ctx as never),
  todos: new Todos.Store(ctx as never),
  sessions: new OmoSessions.Cache(ctx as never),
  scope: Effect.runSync(Scope.make()),
  deliver: () => {},
})
const started = await host.ensure()
await started.hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_unknown" } } })
// A `task` call: omo's agent-usage-reminder records it in its storage folder, which omo resolves when it is imported.
await started.hooks["tool.execute.after"]?.(
  { tool: "task", sessionID: "ses_unknown", callID: "call_task" },
  { title: "", output: "done", metadata: {} },
)
await host.dispose()
// omo's logger flushes on a timer.
await Bun.sleep(1500)

const watchedAfter = watched.map(snapshot)
process.stdout.write(
  `${JSON.stringify({
    sortSame: Array.prototype.sort === before.sort && Array.prototype.toSorted === before.toSorted,
    listenersBefore: before.listeners,
    listenersAfter: listeners(),
    fetches,
    spawns,
    changed: watched.filter((_, index) => watchedBefore[index] !== watchedAfter[index]),
    config: files(config),
    workspace: files(workspace),
    home: files(home),
    xdg: [xdgData, xdgCache].filter((dir) => fs.existsSync(dir)).map((dir) => path.basename(dir)),
    xdgData: files(xdgData),
    agents: [...editor.agents.keys()].sort(),
    tools: editor.tools.sort(),
    commands: editor.commands,
  })}\n`,
)
process.exit(0)

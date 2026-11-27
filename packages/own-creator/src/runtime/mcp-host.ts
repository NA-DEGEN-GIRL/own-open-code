// mcp-host.ts: the trusted own script core starts for a creator MCP server (own/docs/17 §11.2). own writes it once
// into `OWN_HOME\creator\runtime` and registers `[<bun>, mcp-host.ts, <config>]` as the server's command, started with
// `--no-env-file` and the scrubbed allow-listed environment own computed. The host does not run the server's code
// itself: it loads own's WebAssembly JavaScript engine (QuickJS, `quickjs-emscripten-core` + a release variant), puts
// the server's staged bundle inside it, and speaks MCP over stdio (newline-delimited JSON-RPC 2.0: initialize,
// tools/list, tools/call, ping), relaying each call into the sandbox.
//
// The sandbox is the boundary (17 §11.6): the server's code has no host globals at all — no `process`, `Bun`,
// `require`, `fetch`, no Node or disk — only own's bridge `__own`, every call of which the host checks here. File
// access is the project folder only, with own's fence (no `..`, no absolute or UNC paths, no `:` streams, no trailing
// dots or spaces, no 8.3 names, no junction or symlink out, and none of the denied credential files/folders at any
// depth). `fetch` reaches only the hosts the user approved with the version. CPU, wall-clock and memory limits come
// from the engine (an interrupt handler on the deadline, the runtime's memory limit).

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

interface Fence {
  readonly project: string
  readonly deny: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
  readonly paths: ReadonlyArray<string>
  readonly hosts: ReadonlyArray<string>
  readonly callMs: number
  readonly outputChars: number
  readonly memoryMb: number
}

interface HostConfig {
  /** The server's staged bundle: one JavaScript file (the item's files, own-mcp.ts and dependencies, bundled). */
  readonly bundle: string
  /** own's QuickJS engine: absolute module paths own resolved on the PC. */
  readonly quickjs: { readonly core: string; readonly variant: string }
  readonly fence: Fence
  /** The extension's log file. */
  readonly log: string
  readonly logBytes: number
  /** `<id> v<n> <server>`, for the log. */
  readonly label: string
  /** `serve` (default) speaks MCP over stdio; `test` runs the bundle's tests once and prints one JSON line. */
  readonly run?: "serve" | "test"
}

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")) as HostConfig
const fence = config.fence

main().catch((error: unknown) => {
  write(`could not start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

async function main() {
  const core = (await import(pathToFileURL(config.quickjs.core).href)) as {
    newQuickJSWASMModuleFromVariant: (variant: unknown) => Promise<QuickJSModule>
  }
  const variant = ((await import(pathToFileURL(config.quickjs.variant).href)) as { default: unknown }).default
  const mod = await core.newQuickJSWASMModuleFromVariant(variant)
  const sandbox = createSandbox(mod)
  if (config.run === "test") {
    await sandbox.load(fs.readFileSync(config.bundle, "utf8"))
    const result = await sandbox.runTests()
    process.stdout.write(`${JSON.stringify(result)}
`)
    process.exit(0)
  }
  write(`start ${config.label} pid ${process.pid}`)
  await sandbox.load(fs.readFileSync(config.bundle, "utf8"))
  serveStdio(sandbox)
}

// ---- MCP over stdio ----

interface JsonRpc {
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, unknown>
}

function serveStdio(sandbox: Sandbox) {
  const pending = { buffer: "" }
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    pending.buffer += chunk
    const lines = pending.buffer.split("\n")
    pending.buffer = lines.pop() ?? ""
    for (const line of lines) if (line.trim() !== "") void receive(sandbox, line)
  })
  process.stdin.on("end", () => process.exit(0))
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0))
}

async function receive(sandbox: Sandbox, line: string) {
  const message = parse(line)
  if (message === undefined) return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
  const id = message.id
  if (id === undefined) return
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result })
  const fail = (code: number, text: string) => send({ jsonrpc: "2.0", id, error: { code, message: text } })
  if (message.method === "initialize")
    return reply({
      protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: sandbox.info(),
    })
  if (message.method === "ping") return reply({})
  if (message.method === "tools/list") {
    const listed = attempt(() => sandbox.list())
    if (listed.ok) return reply({ tools: listed.value })
    return fail(-32603, `tools/list failed: ${listed.error}`)
  }
  if (message.method === "tools/call") {
    const name = typeof message.params?.name === "string" ? message.params.name : ""
    const args = isRecord(message.params?.arguments) ? message.params.arguments : {}
    const answer = await sandbox.call(name, args).catch((error: unknown) => ({
      content: [{ type: "text", text: `The call failed: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    }))
    return reply(answer)
  }
  return fail(-32601, `unknown method ${String(message.method)}`)
}

// ---- the sandbox ----

interface QuickJSModule {
  newRuntime(options?: { memoryLimitBytes?: number }): QuickJSRuntime
}
interface QuickJSRuntime {
  setMemoryLimit(bytes: number): void
  setMaxStackSize(bytes: number): void
  setModuleLoader(loader: (name: string) => string | { error: Error }): void
  setInterruptHandler(handler: () => boolean): void
  removeInterruptHandler(): void
  executePendingJobs(): void
  newContext(): QuickJSContext
}
interface QuickJSContext {
  readonly undefined: QuickJSHandle
  readonly global: QuickJSHandle
  newString(value: string): QuickJSHandle
  newNumber(value: number): QuickJSHandle
  newFunction(name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void): QuickJSHandle
  newPromise(): { handle: QuickJSHandle; resolve(value: QuickJSHandle): void; reject(value: QuickJSHandle): void; settled: Promise<void> }
  newObject(): QuickJSHandle
  getString(handle: QuickJSHandle): string
  getProp(handle: QuickJSHandle, key: string): QuickJSHandle
  setProp(handle: QuickJSHandle, key: string, value: QuickJSHandle): void
  callFunction(fn: QuickJSHandle, thisArg: QuickJSHandle, ...args: QuickJSHandle[]): { error?: QuickJSHandle; value?: QuickJSHandle }
  evalCode(code: string, filename?: string, options?: { type?: "module" | "global" }): { error?: QuickJSHandle; value?: QuickJSHandle }
  resolvePromise(handle: QuickJSHandle): Promise<{ error?: QuickJSHandle; value?: QuickJSHandle }>
  getPromiseState(handle: QuickJSHandle): { type: "fulfilled" | "rejected" | "pending"; value?: QuickJSHandle }
  dump(handle: QuickJSHandle): unknown
  unwrapResult(result: { error?: QuickJSHandle; value?: QuickJSHandle }): QuickJSHandle
  typeof(handle: QuickJSHandle): string
}
interface QuickJSHandle {
  dispose(): void
  dup(): QuickJSHandle
  readonly alive: boolean
}

interface Sandbox {
  load(bundle: string): Promise<void>
  info(): { name: string; version: string }
  list(): ReadonlyArray<unknown>
  call(name: string, args: Record<string, unknown>): Promise<unknown>
  runTests(): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> }>
}

function createSandbox(mod: QuickJSModule): Sandbox {
  const rt = mod.newRuntime()
  rt.setMemoryLimit(fence.memoryMb * 1024 * 1024)
  rt.setMaxStackSize(1024 * 1024)
  const ctx = rt.newContext()
  const dispatch: { list?: QuickJSHandle; call?: QuickJSHandle; info: { name: string; version: string } } = {
    info: { name: "creator", version: "1.0.0" },
  }
  const deadline = { at: Number.MAX_SAFE_INTEGER }
  const tests: Array<{ name: string; fn: QuickJSHandle }> = []
  rt.setInterruptHandler(() => Date.now() > deadline.at)
  installBridge(rt, ctx, dispatch, deadline, tests)

  // Drives the engine's microtasks and the host-side work (fetches) a call started, until `settled` resolves or the
  // deadline passes.
  const pump = async (settled: Promise<void>) => {
    let done = false
    void settled.then(() => (done = true))
    while (!done) {
      rt.executePendingJobs()
      if (Date.now() > deadline.at) throw new Error(`timed out after ${fence.callMs} ms`)
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 5))])
    }
    rt.executePendingJobs()
  }

  return {
    load: async (bundle) => {
      deadline.at = Date.now() + Math.max(fence.callMs, 15_000)
      const evaluated = ctx.evalCode(bundle, "server.js", { type: "module" })
      if (evaluated.error !== undefined) {
        const detail = JSON.stringify(ctx.dump(evaluated.error))
        evaluated.error.dispose()
        throw new Error(`the server did not load: ${detail}`)
      }
      const value = evaluated.value!
      const state = ctx.getPromiseState(value)
      if (state.type === "pending") {
        const settled = ctx.resolvePromise(value).then((result) => {
          result.value?.dispose()
          if (result.error !== undefined) throw new Error(JSON.stringify(ctx.dump(result.error)))
        })
        await pump(settled.then(() => undefined))
      } else value.dispose()
      deadline.at = Number.MAX_SAFE_INTEGER
      // A test bundle registers tests and need not call serve(); a server bundle must.
      if (config.run !== "test" && (dispatch.list === undefined || dispatch.call === undefined))
        throw new Error("the server never called serve()")
    },
    info: () => dispatch.info,
    list: () => {
      // The server's list() is its code too: the same deadline as a call, so a loop there is interrupted.
      deadline.at = Date.now() + fence.callMs
      try {
        const result = ctx.callFunction(dispatch.list!, ctx.undefined)
        const handle = ctx.unwrapResult(result)
        const json = ctx.getString(handle)
        handle.dispose()
        return JSON.parse(json) as ReadonlyArray<unknown>
      } finally {
        deadline.at = Number.MAX_SAFE_INTEGER
      }
    },
    call: async (name, args) => {
      deadline.at = Date.now() + fence.callMs
      try {
        const nameHandle = ctx.newString(name)
        const argsHandle = ctx.newString(JSON.stringify(args))
        const result = ctx.callFunction(dispatch.call!, ctx.undefined, nameHandle, argsHandle)
        nameHandle.dispose()
        argsHandle.dispose()
        const promise = ctx.unwrapResult(result)
        const native = ctx.resolvePromise(promise)
        promise.dispose()
        await pump(native.then(() => undefined))
        const settled = await native
        if (settled.error !== undefined) {
          const detail = JSON.stringify(ctx.dump(settled.error))
          settled.error.dispose()
          throw new Error(detail)
        }
        const json = ctx.getString(settled.value!)
        settled.value!.dispose()
        return JSON.parse(json) as unknown
      } finally {
        deadline.at = Number.MAX_SAFE_INTEGER
      }
    },
    runTests: async () => {
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
      for (const entry of tests) {
        deadline.at = Date.now() + Math.max(fence.callMs, 30_000)
        try {
          const result = ctx.callFunction(entry.fn, ctx.undefined)
          const value = ctx.unwrapResult(result)
          if (ctx.typeof(value) === "object" && ctx.getPromiseState(value).type !== "fulfilled") {
            const native = ctx.resolvePromise(value)
            await pump(native.then(() => undefined))
            const settled = await native
            if (settled.error !== undefined) {
              const detail = String(ctx.dump(settled.error))
              settled.error.dispose()
              throw new Error(detail)
            }
            settled.value?.dispose()
          }
          value.dispose()
          checks.push({ name: entry.name, ok: true })
        } catch (error) {
          checks.push({ name: entry.name, ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 600) })
        } finally {
          deadline.at = Number.MAX_SAFE_INTEGER
        }
      }
      if (tests.length === 0) checks.push({ name: "tests", ok: true })
      return { ok: checks.every((check) => check.ok), checks }
    },
  }
}

/** Installs own's bridge (`__own`) into the sandbox global: the server's only way out, each call checked here. */
function installBridge(
  rt: QuickJSRuntime,
  ctx: QuickJSContext,
  dispatch: { list?: QuickJSHandle; call?: QuickJSHandle; info: { name: string; version: string } },
  deadline: { at: number },
  tests: Array<{ name: string; fn: QuickJSHandle }>,
) {
  const bridge = ctx.newObject()
  const set = (key: string, value: QuickJSHandle) => {
    ctx.setProp(bridge, key, value)
    value.dispose()
  }
  // A bridge function that returns a string, a boolean or nothing; a throw becomes a sandbox exception (the `\uE000ERR`
  // marker, which `own-mcp.ts` turns back into a thrown Error before the server's code sees it).
  const guarded = (key: string, fn: (...args: string[]) => string | boolean | void) =>
    set(
      key,
      ctx.newFunction(key, (...handles) => {
        const args = handles.map((handle) => (ctx.typeof(handle) === "string" ? ctx.getString(handle) : ""))
        try {
          const out = fn(...args)
          if (typeof out === "boolean") return out ? trueHandle(ctx) : ctx.undefined
          return typeof out === "string" ? ctx.newString(out) : ctx.undefined
        } catch (error) {
          return ctx.newString(`\uE000ERR${error instanceof Error ? error.message : String(error)}`)
        }
      }),
    )

  set("project", ctx.newString(fence.project))
  set("outputChars", ctx.newNumber(fence.outputChars))
  guarded("read", (file) => readProject(file))
  guarded("write", (file, text) => void writeProject(file, text))
  guarded("list", (folder) => JSON.stringify(listProject(folder)))
  guarded("exists", (file) => existsProject(file))
  guarded("log", (line) => void write(`log ${line.replaceAll("\n", " ").slice(0, 2_000)}`))
  set("deadline", ctx.newFunction("deadline", () => ctx.newNumber(deadline.at)))
  set(
    "fetch",
    ctx.newFunction("fetch", (requestH) => {
      const promise = ctx.newPromise()
      doFetch(ctx.getString(requestH)).then(
        (body) => {
          const value = ctx.newString(body)
          promise.resolve(value)
          value.dispose()
          rt.executePendingJobs()
        },
        (error: unknown) => {
          const value = ctx.newString(error instanceof Error ? error.message : String(error))
          promise.reject(value)
          value.dispose()
          rt.executePendingJobs()
        },
      )
      return promise.handle
    }),
  )
  set(
    "serve",
    ctx.newFunction("serve", (dispatchH) => {
      dispatch.list = ctx.getProp(dispatchH, "list")
      dispatch.call = ctx.getProp(dispatchH, "call")
      const info = ctx.getProp(dispatchH, "info")
      if (ctx.typeof(info) === "object") {
        const name = ctx.getProp(info, "name")
        const version = ctx.getProp(info, "version")
        if (ctx.typeof(name) === "string") dispatch.info.name = ctx.getString(name)
        if (ctx.typeof(version) === "string") dispatch.info.version = ctx.getString(version)
        name.dispose()
        version.dispose()
      }
      info.dispose()
      return ctx.undefined
    }),
  )
  set(
    "test",
    ctx.newFunction("test", (nameH, fnH) => {
      tests.push({ name: ctx.typeof(nameH) === "string" ? ctx.getString(nameH) : `test ${tests.length + 1}`, fn: fnH.dup() })
      return ctx.undefined
    }),
  )
  ctx.setProp(ctx.global, "__own", bridge)
  bridge.dispose()
}

function trueHandle(ctx: QuickJSContext) {
  return ctx.unwrapResult(ctx.evalCode("true"))
}

// ---- the fence: project files only ----

/** Reads a project file; throws when the path leaves the project or names a denied place. */
function readProject(file: string) {
  return fs.readFileSync(resolveInside(file, false), "utf8")
}

function writeProject(file: string, text: string) {
  const target = resolveInside(file, true)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
}

function listProject(folder: string) {
  return fs.readdirSync(resolveInside(folder || ".", false), { withFileTypes: true }).map((item) => (item.isDirectory() ? `${item.name}/` : item.name))
}

function existsProject(file: string) {
  try {
    return fs.existsSync(resolveInside(file, false))
  } catch {
    return false
  }
}

/**
 * `file` resolved inside the project, or a throw. Refuses: absolute, drive-qualified, UNC and `\\?\` paths; any `..`
 * part; a `:` (alternate data streams and drive letters); a part ending in a dot or space; an 8.3 short name
 * (`NAME~1`); a denied credential name or path at any depth; a target that (through a junction or symlink) resolves
 * outside the project or into a denied folder (own's home, the config folder, `.codex`, `.claude`).
 */
function resolveInside(file: string, create: boolean) {
  const raw = String(file)
  if (raw.includes("\0")) throw new Error("the path holds a NUL")
  if (raw.includes(":")) throw new Error(`'${raw}' is not a path inside the project`)
  if (/^[\\/]/.test(raw) || /^\\\\\?\\/.test(raw) || raw.startsWith("\\\\")) throw new Error(`'${raw}' is not a path inside the project`)
  const parts = raw.split(/[\\/]+/).filter((part) => part !== "" && part !== ".")
  for (const part of parts) {
    if (part === "..") throw new Error(`'${raw}' leaves the project`)
    if (/[. ]$/.test(part)) throw new Error(`'${raw}' has a part ending in a dot or space`)
    if (/~\d/.test(part)) throw new Error(`'${raw}' uses an 8.3 short name`)
    const lower = part.toLowerCase()
    if (fence.names.some((name) => name.toLowerCase() === lower)) throw new Error(`'${raw}' names a protected file or folder`)
    if (/^\.env/i.test(part)) throw new Error(`'${raw}' names an env file`)
  }
  const joined = parts.join("/").toLowerCase()
  if (fence.paths.some((p) => joined === p.toLowerCase() || joined.startsWith(`${p.toLowerCase()}/`)))
    throw new Error(`'${raw}' names a protected path`)
  const target = path.resolve(fence.project, ...parts)
  const base = real(fence.project)
  const resolved = create ? path.join(real(path.dirname(target)), path.basename(target)) : real(target)
  if (!within(resolved, base)) throw new Error(`'${raw}' is outside the project`)
  if ([...fence.deny].some((denied) => within(resolved, real(denied)))) throw new Error(`'${raw}' is a protected folder`)
  return resolved
}

/** The real path of `target`, following links; a part that does not exist yet is resolved from its parent. */
function real(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
    const parent = path.dirname(target)
    if (parent === target) return target
    return path.join(real(parent), path.basename(target))
  }
}

function within(target: string, folder: string) {
  const key = (value: string) => {
    const forward = path.resolve(value).replaceAll("\\", "/")
    return process.platform === "win32" ? forward.toLowerCase() : forward
  }
  const a = key(target)
  const b = key(folder)
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`)
}

// ---- the fence: declared hosts only ----

async function doFetch(request: string) {
  const parsed = JSON.parse(request) as { url?: string; method?: string; headers?: Record<string, string>; body?: string }
  const url = new URL(String(parsed.url ?? ""))
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`fetch: ${url.protocol} is not allowed`)
  const host = url.port === "" ? url.hostname.toLowerCase() : `${url.hostname.toLowerCase()}:${url.port}`
  const bare = url.hostname.toLowerCase()
  if (!fence.hosts.some((allowed) => allowed.toLowerCase() === host || allowed.toLowerCase() === bare))
    throw new Error(`fetch: '${host}' is not a declared host of this extension`)
  const response = await fetch(url, {
    method: parsed.method ?? "GET",
    headers: parsed.headers ?? {},
    ...(parsed.body === undefined ? {} : { body: parsed.body }),
    redirect: "manual",
    signal: AbortSignal.timeout(Math.max(1_000, fence.callMs)),
  })
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => (headers[key] = value))
  const body = (await response.text()).slice(0, fence.outputChars)
  return JSON.stringify({ status: response.status, url: response.url, headers, body })
}

// ---- log (token-shaped text masked), used by the host and the sandbox's log bridge ----

function write(line: string) {
  try {
    fs.mkdirSync(path.dirname(config.log), { recursive: true })
    const size = fs.statSync(config.log, { throwIfNoEntry: false })?.size ?? 0
    if (size > config.logBytes) fs.renameSync(config.log, `${config.log}.1`)
    fs.appendFileSync(config.log, `${new Date().toISOString()} ${mask(line).slice(0, 4_000)}\n`)
  } catch {
    // A log that cannot be written never stops the server.
  }
}

function mask(text: string) {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "***jwt***")
}

function parse(line: string): JsonRpc | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? (value as JsonRpc) : undefined
  } catch {
    return undefined
  }
}

// A synchronous sandbox step whose throw becomes an MCP error instead of an unhandled rejection that ends the host.
function attempt<T>(run: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

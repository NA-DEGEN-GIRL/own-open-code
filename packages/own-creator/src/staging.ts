export * as Staging from "./staging.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Creator } from "@own/protocol/creator"
import { Fsx, ProcessTree } from "@own/runtime"
import { Runtime } from "./runtime.js"
import { Safety } from "./safety.js"
import type { CreatorStore } from "./store.js"

/**
 * Staging of a code version (17 §11.4, §12.3): before a C2 or C3 version exists, its folder is built and checked in
 * `OWN_HOME\creator\stage\…`, every step in a child process with the allow-listed environment of a server
 * (`Safety.serverEnv`). Only when every step passes does the store move the folder into place as the new version; a
 * failure removes it and the active version stays as it was.
 *
 * C2, per `mcp.server`: the files and own's `own-mcp.ts` → dependencies from the allow-list (`bun install
 * --ignore-scripts`, own's cache, no install scripts) → typecheck (`bun check`, Bun's and Node's types) → the
 * extension's own tests (`bun test`) → the smoke test: the server starts through own's host as core would start it, and
 * a scripted client plays the model (initialize, tools/list, the item's smoke calls).
 *
 * C3: the files, own's API, shim and entry → typecheck against own's plugin API alone (`own-plugin.ts`, no Bun or Node
 * types) → the extension's tests → the e2e and golden check (`plugin-check.ts`): the shim runs each hook on the fake
 * model's fixed request, twice, and a plugin that keeps the cache must leave the cached prefix byte for byte.
 */

export interface Options {
  /** Bun: the service's executable, which runs as Bun with `BUN_BE_BUN=1`. */
  readonly bun: string
  /** An npm registry for dependencies (tests); the user's default otherwise. */
  readonly registry?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly ms: number
  readonly detail?: string
}

export type Result =
  | { readonly ok: true; readonly staged: CreatorStore.Staged; readonly checks: ReadonlyArray<Check> }
  | { readonly ok: false; readonly checks: ReadonlyArray<Check>; readonly problems: ReadonlyArray<Creator.Problem> }

const INSTALL_MS = 180_000
const CHECK_MS = 120_000
const TEST_MS = 120_000
const SMOKE_MS = 20_000

/** Builds and checks the version folder of `extension` (kind `mcp` or `plugin`). */
export async function run(store: CreatorStore.Store, extension: Creator.Extension, options: Options): Promise<Result> {
  await Runtime.materialize(store.root)
  const places = Runtime.paths(store.root)
  const dir = path.join(places.stage, `${extension.id}.${Date.now()}.${randomBytes(4).toString("hex")}`)
  const scratch = `${dir}.scratch`
  await fs.mkdir(scratch, { recursive: true })
  const checks: Check[] = []
  const done = await (Creator.kindOf(extension) === "plugin"
    ? stagePlugin(store, extension, dir, scratch, options, checks)
    : stageServers(store, extension, dir, scratch, options, checks)
  ).catch((error: unknown) => {
    checks.push({ name: "stage", ok: false, ms: 0, detail: error instanceof Error ? error.message : String(error) })
    return false
  })
  await Fsx.removeTree(scratch)
  await Runtime.log(
    store.root,
    extension.id,
    checks.map((check) => `stage ${check.name} ${check.ok ? "ok" : "failed"} ${check.ms} ms${detailLine(check)}`),
  ).catch(() => undefined)
  if (done && checks.every((check) => check.ok))
    return { ok: true, staged: { dir, checks: checks.map((check) => ({ name: check.name, ms: check.ms })) }, checks }
  await Fsx.removeTree(dir)
  return {
    ok: false,
    checks,
    problems: checks
      .filter((check) => !check.ok)
      .map((check) => ({ path: `stage.${check.name}`, message: check.detail ?? "failed" })),
  }
}

/**
 * The host's staging of a C2 version mirrored from the PC (17 §10). Its files already hash as the PC's version, own's
 * bundle included, so nothing is installed or built again: per server the version's own tests (bundled here) and the
 * smoke run once more in this host's sandbox, on this host's Bun, with this host's fence. Nothing runs outside the
 * sandbox. The result decides whether the host registers the version's servers.
 */
export async function hostCheck(
  store: CreatorStore.Store,
  extension: Creator.Extension,
  dir: string,
  options: Options,
): Promise<{ readonly ok: boolean; readonly checks: ReadonlyArray<Check>; readonly problems: ReadonlyArray<Creator.Problem> }> {
  await Runtime.materialize(store.root)
  const scratch = path.join(Runtime.paths(store.root).stage, `${extension.id}.host.${Date.now()}.${randomBytes(4).toString("hex")}`)
  await fs.mkdir(scratch, { recursive: true })
  const checks: Check[] = []
  const quickjs = Runtime.quickjs()
  const servers = extension.items.filter((item): item is Creator.McpServer => item.type === "mcp.server")
  const done = await (async () => {
    for (const item of servers) {
      const folder = path.join(dir, "servers", item.name)
      const bundlePath = path.join(folder, Runtime.BUNDLE)
      const project = path.join(scratch, "project", item.name)
      await fs.mkdir(project, { recursive: true })
      const fence = Safety.fence({ project, home: store.home, env: options.env ?? process.env, item })
      for (const file of Object.keys(item.files).filter((name) => /\.test\.m?[jt]s$/.test(name))) {
        const out = path.join(scratch, `${item.name}.${file.replaceAll("/", "_")}.bundle.js`)
        if (!(await bundleStep(checks, `${item.name}: host tests`, path.join(folder, file), folder, out))) return false
        if (!(await sandboxTests(checks, `${item.name}: host tests`, options.bun, quickjs, out, fence, store, extension, scratch)))
          return false
      }
      const smoked = await smoke(store, extension, item, bundlePath, quickjs, fence, options, scratch)
      checks.push({ ...smoked, name: `${item.name}: host smoke` })
      if (!smoked.ok) return false
    }
    return true
  })().catch((error: unknown) => {
    checks.push({ name: "host", ok: false, ms: 0, detail: error instanceof Error ? error.message : String(error) })
    return false
  })
  await Fsx.removeTree(scratch)
  await Runtime.log(
    store.root,
    extension.id,
    checks.map((check) => `host staging ${check.name} ${check.ok ? "ok" : "failed"} ${check.ms} ms${detailLine(check)}`),
  ).catch(() => undefined)
  const ok = done && checks.every((check) => check.ok)
  return {
    ok,
    checks,
    problems: checks
      .filter((check) => !check.ok)
      .map((check) => ({ path: `stage.${check.name}`, message: check.detail ?? "failed" })),
  }
}

/** Removes a staged folder the store did not take (a write that failed after staging). */
export function discard(staged: CreatorStore.Staged) {
  return Fsx.removeTree(staged.dir)
}

async function stageServers(
  store: CreatorStore.Store,
  extension: Creator.Extension,
  dir: string,
  scratch: string,
  options: Options,
  checks: Check[],
) {
  const servers = extension.items.filter((item): item is Creator.McpServer => item.type === "mcp.server")
  const quickjs = Runtime.quickjs()
  for (const item of servers) {
    const folder = path.join(dir, "servers", item.name)
    await writeFiles(folder, { ...item.files, ...Runtime.SERVER_FILES })
    // The sandbox offers only standard JavaScript plus own's `__own` (declared in own-mcp.ts): no Node or Bun types.
    await Fsx.writeSynced(path.join(folder, "tsconfig.json"), tsconfig({ types: [] }))
    const toolEnv = (extra: Readonly<Record<string, string>> = {}) =>
      Safety.serverEnv(options.env ?? process.env, {
        temp: scratch,
        extra: { BUN_INSTALL_CACHE_DIR: Runtime.paths(store.root).cache, ...extra },
      })
    const dependencies = item.dependencies ?? {}
    if (Object.keys(dependencies).length > 0) {
      await Fsx.writeSynced(
        path.join(folder, "package.json"),
        `${JSON.stringify({ name: `creator-${extension.id}-${item.name}`, private: true, type: "module", dependencies }, null, 2)}\n`,
      )
      const installed = await step(checks, `${item.name}: install`, options.bun, ["install", "--ignore-scripts", "--no-progress"], {
        cwd: folder,
        env: toolEnv(options.registry === undefined ? {} : { BUN_CONFIG_REGISTRY: options.registry, NPM_CONFIG_REGISTRY: options.registry }),
        timeoutMs: INSTALL_MS,
      })
      if (!installed) return false
    }
    // An early typecheck (a lint, not a boundary): the sandbox contains the code whatever this says.
    const typed = await step(checks, `${item.name}: typecheck`, options.bun, ["check", "-p", "tsconfig.json", "--no-pretty"], {
      cwd: folder,
      env: toolEnv(),
      timeoutMs: CHECK_MS,
    })
    if (!typed) return false
    // Bundle the server (and each test file) into one JavaScript file for the sandbox; nothing runs unsandboxed again.
    const bundlePath = path.join(folder, Runtime.BUNDLE)
    const built = await bundleStep(checks, `${item.name}: bundle`, path.join(folder, Creator.entryOf(item)), folder, bundlePath)
    if (!built) return false
    const project = path.join(scratch, "project", item.name)
    await fs.mkdir(project, { recursive: true })
    const fence = Safety.fence({ project, home: store.home, env: options.env ?? process.env, item })
    const testFiles = Object.keys(item.files).filter((file) => /\.test\.m?[jt]s$/.test(file))
    for (const file of testFiles) {
      const out = path.join(scratch, `${item.name}.${file.replaceAll("/", "_")}.bundle.js`)
      const testBuilt = await bundleStep(checks, `${item.name}: tests`, path.join(folder, file), folder, out)
      if (!testBuilt) return false
      const tested = await sandboxTests(checks, `${item.name}: tests`, options.bun, quickjs, out, fence, store, extension, scratch)
      if (!tested) return false
    }
    const smoked = await smoke(store, extension, item, bundlePath, quickjs, fence, options, scratch)
    checks.push(smoked)
    if (!smoked.ok) return false
  }
  return true
}

/** Bundles one entry into `out`; records a failed bundle as `name` and returns whether it succeeded. */
async function bundleStep(checks: Check[], name: string, entry: string, cwd: string, out: string) {
  const started = Date.now()
  const built = await Runtime.bundle({ entry, cwd, out })
  if (built.ok) return true
  checks.push({ name, ok: false, ms: Date.now() - started, detail: built.detail })
  return false
}

/** Runs a test bundle in the sandbox (own's host, `run: "test"`); records each test and returns whether all passed. */
async function sandboxTests(
  checks: Check[],
  name: string,
  bun: string,
  quickjs: { readonly core: string; readonly variant: string },
  bundle: string,
  fence: Safety.Fence,
  store: CreatorStore.Store,
  extension: Creator.Extension,
  scratch: string,
): Promise<boolean> {
  const started = Date.now()
  const command = hostCommand({
    bun,
    host: Runtime.paths(store.root).host,
    bundle,
    quickjs,
    fence,
    log: Runtime.logFile(store.root, extension.id),
    label: `${extension.id} staging tests`,
    run: "test",
  })
  const ran = await spawn(bun, command.slice(1), { cwd: scratch, env: hostEnv(), timeoutMs: TEST_MS })
  const report = parseReport(ran.output)
  if (report === undefined) {
    checks.push({ name, ok: false, ms: Date.now() - started, detail: tailOf(ran.output) || `exit ${ran.code}` })
    return false
  }
  report.checks.forEach((check) =>
    checks.push({
      name: `${name}: ${check.name}`,
      ok: check.ok,
      ms: Date.now() - started,
      ...(check.detail === undefined ? {} : { detail: check.detail }),
    }),
  )
  return report.ok
}

/** The environment own's host (a trusted own script) runs with: scrubbed, no TEMP, Bun's switch on. */
function hostEnv() {
  return Safety.serverEnv(process.env, {})
}

async function stagePlugin(
  store: CreatorStore.Store,
  extension: Creator.Extension,
  dir: string,
  scratch: string,
  options: Options,
  checks: Check[],
) {
  const item = extension.items.find((entry): entry is Creator.PluginCode => entry.type === "plugin.code")
  if (item === undefined) return false
  await writeFiles(dir, { ...item.files, ...Runtime.PLUGIN_FILES })
  await Fsx.writeSynced(
    path.join(dir, "tsconfig.json"),
    tsconfig({ types: [], exclude: ["server.ts", "own-shim.ts", "**/*.test.ts"] }),
  )
  const env = Safety.serverEnv(options.env ?? process.env, { temp: scratch })
  const typed = await step(checks, "typecheck", options.bun, ["check", "-p", "tsconfig.json", "--no-pretty"], {
    cwd: dir,
    env,
    timeoutMs: CHECK_MS,
  })
  if (!typed) return false
  const tests = Object.keys(item.files).filter((file) => /\.test\.[cm]?[jt]s$/.test(file))
  if (tests.length > 0) {
    const tested = await step(checks, "tests", options.bun, ["test", ...tests.map((file) => `./${file}`)], {
      cwd: dir,
      env,
      timeoutMs: TEST_MS,
    })
    if (!tested) return false
  }
  const config = {
    folder: dir,
    extension: extension.id,
    entry: Creator.entryOf(item),
    version: 0,
    cache: item.cache ?? "keeps",
    scratch,
    hookMs: 2_000,
  }
  const started = Date.now()
  const ran = await spawn(options.bun, [Runtime.paths(store.root).check, encode(config)], {
    cwd: scratch,
    env,
    timeoutMs: CHECK_MS,
  })
  const report = parseReport(ran.output)
  if (report === undefined) {
    checks.push({ name: "e2e", ok: false, ms: Date.now() - started, detail: tailOf(ran.output) || `exit ${ran.code}` })
    return false
  }
  report.checks.forEach((check) =>
    checks.push({ name: check.name, ok: check.ok, ms: Date.now() - started, ...(check.detail === undefined ? {} : { detail: check.detail }) }),
  )
  return report.ok
}

/**
 * The smoke test of one server: it starts through own's host exactly as core starts it (the same command, environment
 * and fence), and a scripted client plays the model: initialize, tools/list (at least one tool, valid names and
 * schemas), then each smoke call, whose answer must not be an error and must contain `expect` when given.
 */
async function smoke(
  store: CreatorStore.Store,
  extension: Creator.Extension,
  item: Creator.McpServer,
  bundle: string,
  quickjs: { readonly core: string; readonly variant: string },
  fence: Safety.Fence,
  options: Options,
  scratch: string,
): Promise<Check> {
  const name = `${item.name}: smoke`
  const started = Date.now()
  await fs.mkdir(fence.project, { recursive: true })
  const command = hostCommand({
    bun: options.bun,
    host: Runtime.paths(store.root).host,
    bundle,
    quickjs,
    fence,
    log: Runtime.logFile(store.root, extension.id),
    label: `${extension.id} staging ${item.name}`,
  })
  const child = Bun.spawn(command, {
    cwd: scratch,
    env: hostEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    ...ProcessTree.SPAWN,
  })
  const client = rpcClient(child)
  const fail = (detail: string): Check => ({ name, ok: false, ms: Date.now() - started, detail })
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "own-creator-smoke", version: "1" },
    })
    if (init.error !== undefined) return fail(`initialize: ${init.error}`)
    client.notify("notifications/initialized")
    const listed = await client.request("tools/list", {})
    const tools = isRecord(listed.result) && Array.isArray(listed.result.tools) ? listed.result.tools : []
    if (tools.length === 0) return fail("tools/list answered no tools")
    const bad = tools.find(
      (tool) =>
        !isRecord(tool) ||
        typeof tool.name !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
        !isRecord(tool.inputSchema) ||
        tool.inputSchema.type !== "object",
    )
    if (bad !== undefined) return fail(`tools/list: a tool without a valid name or object input schema (${JSON.stringify(bad).slice(0, 200)})`)
    for (const call of item.smoke ?? []) {
      const answer = await client.request("tools/call", { name: call.tool, arguments: call.arguments ?? {} })
      const result = isRecord(answer.result) ? answer.result : {}
      const text = (Array.isArray(result.content) ? result.content : [])
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n")
      if (answer.error !== undefined) return fail(`${call.tool}: ${answer.error}`)
      if (result.isError === true) return fail(`${call.tool} answered an error: ${text.slice(0, 300)}`)
      if (call.expect !== undefined && !text.includes(call.expect))
        return fail(`${call.tool} answered without '${call.expect}': ${text.slice(0, 300)}`)
    }
    return { name, ok: true, ms: Date.now() - started }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  } finally {
    client.close()
    await ProcessTree.exited(child, { timeoutMs: 3_000 })
  }
}

/**
 * The command core runs for a server: Bun with `--no-env-file` and `--no-install`, own's host and the host's settings
 * (17 §11.2). `--no-install`: the engine and the server bundle resolve from the release's own folders only, never through
 * a download from npm at run time (RL4-P1: staging passed through Bun's auto-install while the server could not start).
 */
export function hostCommand(input: {
  readonly bun: string
  readonly host: string
  readonly bundle: string
  readonly quickjs: { readonly core: string; readonly variant: string }
  readonly fence: Safety.Fence
  readonly log: string
  readonly label: string
  readonly run?: "serve" | "test"
}) {
  return [
    input.bun,
    "--no-env-file",
    "--no-install",
    input.host,
    encode({
      bundle: input.bundle,
      quickjs: input.quickjs,
      fence: input.fence,
      log: input.log,
      logBytes: Runtime.LOG_BYTES,
      label: input.label,
      ...(input.run === undefined ? {} : { run: input.run }),
    }),
  ]
}

function rpcClient(child: Bun.Subprocess<"pipe", "pipe", "ignore">) {
  const waiting = new Map<number, (answer: { result?: unknown; error?: string }) => void>()
  const counter = { next: 1 }
  const reader = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      lines
        .filter((line) => line.trim() !== "")
        .forEach((line) => {
          const message = parseLine(line)
          if (message === undefined || typeof message.id !== "number") return
          const error = isRecord(message.error) ? String(message.error.message ?? "error") : undefined
          waiting.get(message.id)?.({ result: message.result, ...(error === undefined ? {} : { error }) })
          waiting.delete(message.id)
        })
    }
  })().catch(() => undefined)
  const write = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    void child.stdin.flush()
  }
  return {
    request: (method: string, params: unknown) =>
      new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
        const id = counter.next++
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`${method}: no answer in ${SMOKE_MS / 1000} s`))
        }, SMOKE_MS)
        waiting.set(id, (answer) => {
          clearTimeout(timer)
          resolve(answer)
        })
        write({ jsonrpc: "2.0", id, method, params })
      }),
    notify: (method: string) => write({ jsonrpc: "2.0", method }),
    close: () => {
      void Promise.resolve(child.stdin.end()).catch(() => undefined)
      void reader
    },
  }
}

/** One step: a child process with the server environment; ok when it exits 0 in time. */
async function step(
  checks: Check[],
  name: string,
  bun: string,
  args: ReadonlyArray<string>,
  input: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
) {
  const started = Date.now()
  const ran = await spawn(bun, args, input)
  const ok = ran.code === 0 && ran.stop === undefined
  checks.push({
    name,
    ok,
    ms: Date.now() - started,
    ...(ok ? {} : { detail: ran.stop === "timeout" ? `timed out after ${input.timeoutMs / 1000} s` : tailOf(ran.output) || `exit ${ran.code}` }),
  })
  return ok
}

async function spawn(
  bun: string,
  args: ReadonlyArray<string>,
  input: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
) {
  const child = Bun.spawn([bun, ...args], {
    cwd: input.cwd,
    env: { ...input.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...ProcessTree.SPAWN,
  })
  const [stdout, stderr, ended] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    ProcessTree.exited(child, { timeoutMs: input.timeoutMs }),
  ])
  return { code: ended.code, stop: ended.stop, output: [stdout, stderr].filter((part) => part.trim() !== "").join("\n") }
}

async function writeFiles(folder: string, files: Readonly<Record<string, string>>) {
  await Promise.all(
    Object.entries(files).map(async ([name, text]) => {
      const file = path.join(folder, ...name.split("/"))
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Fsx.writeSynced(file, text)
    }),
  )
}

function tsconfig(input: { readonly types: ReadonlyArray<string>; readonly typeRoots?: string; readonly exclude?: ReadonlyArray<string> }) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ESNext"],
        types: input.types,
        ...(input.typeRoots === undefined ? {} : { typeRoots: [input.typeRoots] }),
        allowImportingTsExtensions: true,
        skipLibCheck: true,
      },
      include: ["**/*.ts"],
      exclude: ["node_modules", ...(input.exclude ?? [])],
    },
    null,
    2,
  )}\n`
}

function parseReport(output: string) {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{"))
  const value = line === undefined ? undefined : parseLine(line)
  if (value === undefined || typeof value.ok !== "boolean" || !Array.isArray(value.checks)) return undefined
  return {
    ok: value.ok,
    checks: value.checks.flatMap((check) =>
      isRecord(check) && typeof check.name === "string" && typeof check.ok === "boolean"
        ? [{ name: check.name, ok: check.ok, ...(typeof check.detail === "string" ? { detail: check.detail } : {}) }]
        : [],
    ),
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64")
}

function tailOf(output: string) {
  const trimmed = output.trim()
  return trimmed.length <= 2_000 ? trimmed : trimmed.slice(-2_000)
}

function detailLine(check: Check) {
  return check.detail === undefined ? "" : `: ${check.detail.replaceAll("\n", " | ").slice(0, 600)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

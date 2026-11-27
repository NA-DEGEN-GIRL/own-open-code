import type { Subprocess } from "bun"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isRecord, parseJson } from "../fakes/shared"
import { removeTree } from "./remove"
import { RELEASE_FLAGS } from "../../../../../own/scripts/test/release-flags.ts"

/** Repository root (this file lives in packages/own-accounts/test/e2e-kit/harness). */
export const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..")
export const CLI_ENTRY = path.join(REPO_ROOT, "packages/cli/src/index.ts")
/**
 * The CLI imports TUI modules that need its Solid JSX preload (packages/cli/bunfig.toml), named here by its resolved
 * file. Bun resolves a bunfig's `preload` from the working directory, and a boot runs in its temp workspace, outside the
 * repository: with `--config=packages/cli/bunfig.toml` every boot auto-installed the latest `@opentui/solid` and its
 * Babel from npm into its own cache (about 220 packages, 61 MB), not the locked ones, and failed outright while npm
 * held a partial Babel release (7.29.14, 2026-11-12: `Cannot find module '@babel/types'`; decisions US6-21).
 */
export const CLI_PRELOAD = Bun.resolveSync("@opentui/solid/preload", path.join(REPO_ROOT, "packages/cli"))
/**
 * Bun's transpiler cache for every e2e boot: one per checkout, so boots after the first stay warm. Not in the OS temp
 * folder: the own-web suites move TEMP, which gave each suite its own cold cache.
 */
export const E2E_TRANSPILER_CACHE =
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? path.join(REPO_ROOT, "node_modules/.cache/own-e2e-bun-transpiler")

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export type ConfigInput = Readonly<Record<string, unknown>> | string

export interface OpencodeServerOptions {
  /**
   * Written as `opencode.jsonc` into the temp global config directory; objects are JSON-encoded. Pass a
   * function to reference the temp paths, e.g. `(paths) => ({ plugins: [{ package, options: { home: paths.ownHome } }] })`.
   */
  readonly config: ConfigInput | ((paths: OpencodeServerPaths) => ConfigInput)
  /** Extra child environment. An `undefined` value removes an inherited variable. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * A models.dev catalog file (`api.json` shape) the server starts from instead of its bundled snapshot
   * (`OPENCODE_MODELS_PATH`). Core reads it once, when the catalog is first needed, and never refreshes it while model
   * fetching is off: a test that changes the catalog writes another file and restarts the server on the same `root`.
   */
  readonly models?: string
  /** Files created in the temp workspace (the session Location) before boot, keyed by relative path. */
  readonly workspaceFiles?: Readonly<Record<string, string>>
  /**
   * Discover project config (`.opencode/`, `opencode.jsonc`) upward from the workspace. Off by default
   * because the walk from the OS temp directory reaches the developer's real home directory.
   */
  readonly projectConfig?: boolean
  /** Reuse an existing temp root, e.g. to restart against the same database. Never deleted by `stop()`. */
  readonly root?: string
  /** Per boot wait (the ready line, then `GET /api/info`); default 170 s, under most suites' 180 s `beforeAll`. */
  readonly startupTimeoutMs?: number
  /**
   * Replaces the source boot (`bun --config=… packages/cli/src/index.ts`) with another CLI, e.g. a release
   * `opencode.exe` (real-host suites run the release build so its version matches the remote bundle). `serve --stdio
   * --port 0` is appended.
   */
  readonly command?: readonly string[]
  /** Keep the temp root after `stop()`. Also enabled by `OWN_E2E_KEEP=1`. */
  readonly keepTemp?: boolean
  /** Mirror server logs to this process's stderr. Also enabled by `OWN_E2E_LOGS=1`. */
  readonly printLogs?: boolean
}

export interface OpencodeServerPaths {
  readonly root: string
  /** `HOME` / `OPENCODE_TEST_HOME` of the child. */
  readonly home: string
  /** `OPENCODE_CONFIG_DIR`; holds the generated `opencode.jsonc`. */
  readonly config: string
  /** OpenCode data, state and cache directories (`<XDG_*_HOME>/opencode`). */
  readonly data: string
  readonly state: string
  readonly cache: string
  /** `LOCALAPPDATA`/`APPDATA` of the child, so a plugin's default `OWN_HOME` can never be the real one. */
  readonly localAppData: string
  /** Suggested `home` plugin option for own-accounts (`OWN_HOME`); created empty by the harness. */
  readonly ownHome: string
  /** The session Location directory, also the child's cwd. */
  readonly workspace: string
  readonly database: string
}

export interface RequestOptions {
  readonly body?: unknown
  readonly query?: Readonly<Record<string, string>>
  readonly headers?: Readonly<Record<string, string>>
  /** Directory sent as `x-opencode-directory` for Location-scoped routes (default: the workspace). */
  readonly directory?: string
}

export interface OpencodeServer {
  readonly url: string
  readonly pid: number
  readonly paths: OpencodeServerPaths
  /** Value for the `authorization` header (HTTP basic with the generated server password). */
  readonly authorization: string
  /** Raw request against the server; adds auth and the Location header. */
  request(method: string, route: string, options?: RequestOptions): Promise<Response>
  /** Like `request`, but throws with the response text on a non-2xx status and decodes JSON bodies. */
  call(method: string, route: string, options?: RequestOptions): Promise<unknown>
  createSession(input?: {
    readonly model?: ModelRef
    readonly title?: string
    readonly directory?: string
  }): Promise<{ readonly id: string } & Record<string, unknown>>
  /** Admits a prompt (`POST /api/session/:id/prompt`); combine with `waitIdle` to await the run. */
  prompt(sessionID: string, text: string, options?: { readonly delivery?: "steer" | "queue" }): Promise<unknown>
  switchModel(sessionID: string, model: ModelRef): Promise<void>
  /** Blocks until the session agent loop is idle (`POST /api/experimental/session/:id/wait`). */
  waitIdle(sessionID: string): Promise<void>
  messages(sessionID: string): Promise<readonly Record<string, unknown>[]>
  models(): Promise<readonly Record<string, unknown>[]>
  /** Polls `GET /api/model` until every ref is listed; the first snapshot may precede plugin settlement. */
  waitForModels(refs: readonly ModelRef[], timeoutMs?: number): Promise<void>
  /**
   * Polls `GET /api/plugin` on the workspace Location until `count` configured (non-built-in) plugins are active or
   * failed: plugins load in the background since upstream v2.4.0 (#63814), so an RPC before that is `rpc.unavailable`.
   */
  waitForPlugins(count: number, timeoutMs?: number): Promise<void>
  /** Captured stdout and stderr (server logs are printed to stderr). */
  logs(): string
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Boots the upstream OpenCode v2 server from source (`bun packages/cli/src/index.ts serve --stdio`) with
 * isolated temp home/config/data directories and the given config, and returns an authenticated client.
 */
export async function startOpencodeServer(options: OpencodeServerOptions): Promise<OpencodeServer> {
  const owned = options.root === undefined
  const root = options.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-")))
  const paths = {
    root,
    home: path.join(root, "home"),
    config: path.join(root, "config"),
    data: path.join(root, "xdg-data", "opencode"),
    state: path.join(root, "xdg-state", "opencode"),
    cache: path.join(root, "xdg-cache", "opencode"),
    localAppData: path.join(root, "localappdata"),
    ownHome: path.join(root, "own-home"),
    workspace: path.join(root, "workspace"),
    database: path.join(root, "opencode.db"),
  }
  await Promise.all(
    [paths.home, paths.config, paths.localAppData, paths.ownHome, paths.workspace].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  )
  const config = typeof options.config === "function" ? options.config(paths) : options.config
  const configuredPlugins = pluginCount(config)
  await Bun.write(
    path.join(paths.config, "opencode.jsonc"),
    typeof config === "string" ? config : JSON.stringify(config, null, 2),
  )
  await Promise.all(
    Object.entries(options.workspaceFiles ?? {}).map(([name, content]) =>
      Bun.write(path.join(paths.workspace, name), content),
    ),
  )
  const password = randomBytes(24).toString("base64url")
  const printLogs = options.printLogs ?? process.env.OWN_E2E_LOGS === "1"
  const cli = options.command ?? [process.execPath, `--preload=${CLI_PRELOAD}`, CLI_ENTRY]
  const proc = Bun.spawn([...cli, "serve", "--stdio", "--port", "0"], {
    cwd: paths.workspace,
    env: childEnv(paths, password, options),
    // The server treats EOF on stdin as the end of its lease and shuts down gracefully.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const output: string[] = []
  const ready = Promise.withResolvers<string>()
  const drained = Promise.all([
    drain(proc.stdout, (line) => {
      output.push(line)
      const url = readyURL(line)
      if (url) ready.resolve(url)
    }),
    drain(proc.stderr, (line) => {
      output.push(line)
      if (printLogs) process.stderr.write(`[opencode ${proc.pid}] ${line}\n`)
    }),
  ])
  proc.exited.then((code) => ready.reject(new Error(`opencode server exited with code ${code} before it was ready`)))
  const authorization = `Basic ${btoa(`opencode:${password}`)}`
  const logs = () => output.join("\n")
  const stop = once(async () => {
    await shutdown(proc)
    await drained
    if (owned && !(options.keepTemp ?? process.env.OWN_E2E_KEEP === "1")) await removeTree(root)
  })

  // A source boot is CPU-bound transpiling: about 10-30 s on a quiet PC, and past 90 s under load (2026-10-16).
  const timeoutMs = options.startupTimeoutMs ?? 170_000
  const url = await withTimeout(ready.promise, timeoutMs, "opencode server did not report readiness").catch(
    async (error: unknown) => {
      await stop()
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- server output ---\n${logs()}`)
    },
  )

  // Plugins load in the background since upstream v2.4.0 (#63814), in every Location: an own RPC into a Location whose
  // configured plugins have not all loaded answers `rpc.unavailable`, so it is sent again (up to 60 s) until they have.
  // A plugin that loaded and registered nothing (a guard) still answers `rpc.unavailable` at once.
  const request = async (method: string, route: string, requestOptions: RequestOptions = {}) => {
    const deadline = Date.now() + 60_000
    while (true) {
      const response = await send(method, route, requestOptions)
      if (!route.startsWith("/api/rpc/") || response.status !== 400) return response
      const text = await response.text()
      const answered = new Response(text, { status: response.status, headers: response.headers })
      if (!text.includes("rpc.unavailable") || Date.now() > deadline) return answered
      if (await pluginsLoaded(requestOptions.query?.["location[directory]"] ?? requestOptions.directory)) return answered
      await Bun.sleep(200)
    }
  }
  const pluginsLoaded = async (directory: string | undefined) => {
    const response = await send("GET", "/api/plugin", { directory }).catch(() => undefined)
    if (!response?.ok) return false
    const listed = data(await response.json().catch(() => undefined))
    const plugins = Array.isArray(listed) ? listed.filter(isRecord) : []
    return (
      plugins.filter(
        (plugin) =>
          isRecord(plugin.source) && plugin.source.type !== "builtin" && isRecord(plugin.state) && plugin.state.status,
      ).length >= configuredPlugins
    )
  }
  const send = (method: string, route: string, requestOptions: RequestOptions = {}) => {
    const target = new URL(route, url)
    Object.entries(requestOptions.query ?? {}).forEach(([key, value]) => target.searchParams.set(key, value))
    return fetch(target, {
      method,
      headers: {
        authorization,
        "x-opencode-directory": encodeURIComponent(requestOptions.directory ?? paths.workspace),
        ...(requestOptions.body === undefined ? {} : { "content-type": "application/json" }),
        ...requestOptions.headers,
      },
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    })
  }
  const call = async (method: string, route: string, requestOptions?: RequestOptions) => {
    const response = await request(method, route, requestOptions)
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${route} failed with ${response.status}: ${text}`)
    if (text === "") return undefined
    return response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text
  }
  const data = (value: unknown) => (isRecord(value) ? value.data : undefined)

  await poll(
    async () => (await request("GET", "/api/info").catch(() => undefined))?.ok === true,
    timeoutMs,
    "opencode server did not answer /api/info",
  ).catch(async (error: unknown) => {
    await stop()
    throw error
  })

  return {
    url,
    pid: proc.pid,
    paths,
    authorization,
    request,
    call,
    async createSession(input = {}) {
      const session = data(
        await call("POST", "/api/session", {
          body: {
            ...(input.title === undefined ? { title: "own e2e" } : { title: input.title }),
            ...(input.model === undefined ? {} : { model: input.model }),
            location: { directory: input.directory ?? paths.workspace },
          },
        }),
      )
      if (!isRecord(session) || typeof session.id !== "string") throw new Error("session.create returned no id")
      return { ...session, id: session.id }
    },
    async prompt(sessionID, text, promptOptions = {}) {
      return data(
        await call("POST", `/api/session/${sessionID}/prompt`, {
          body: { text, ...(promptOptions.delivery === undefined ? {} : { delivery: promptOptions.delivery }) },
        }),
      )
    },
    async switchModel(sessionID, model) {
      await call("POST", `/api/session/${sessionID}/model`, { body: { model } })
    },
    async waitIdle(sessionID) {
      await call("POST", `/api/experimental/session/${sessionID}/wait`)
    },
    async messages(sessionID) {
      const list = data(await call("GET", `/api/session/${sessionID}/message`))
      return Array.isArray(list) ? list.filter(isRecord) : []
    },
    async models() {
      const list = data(await call("GET", "/api/model"))
      return Array.isArray(list) ? list.filter(isRecord) : []
    },
    // 120 s: three e2e files booting at once on a loaded PC listed their models after more than 30 s (2026-10-29).
    async waitForModels(refs, waitMs = 120_000) {
      await poll(
        async () => {
          // The server answers 503 while the Location's plugins still activate (server/src/location.ts waits 5 s).
          const listed = data(await call("GET", "/api/model").catch(activating))
          const models = Array.isArray(listed) ? listed.filter(isRecord) : []
          return refs.every((ref) => models.some((model) => model.providerID === ref.providerID && model.id === ref.id))
        },
        waitMs,
        `models not listed: ${refs.map((ref) => `${ref.providerID}/${ref.id}`).join(", ")}`,
      )
    },
    async waitForPlugins(count, waitMs = 120_000) {
      await poll(
        async () => {
          const listed = data(await call("GET", "/api/plugin").catch(activating))
          const plugins = Array.isArray(listed) ? listed.filter(isRecord) : []
          return (
            plugins.filter(
              (plugin) =>
                isRecord(plugin.source) &&
                plugin.source.type !== "builtin" &&
                isRecord(plugin.state) &&
                plugin.state.status !== undefined,
            ).length >= count
          )
        },
        waitMs,
        `${count} configured plugin(s) not loaded`,
      )
    },
    logs,
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

/**
 * Inherits PATH-like variables but drops every OpenCode setting and provider credential of the
 * developer's shell, so a test can never reach a real account or real config.
 */
function childEnv(paths: OpencodeServerPaths, password: string, options: OpencodeServerOptions) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^OPENCODE_/i.test(entry[0]) && !/(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(entry[0]),
    ),
  )
  const merged: Record<string, string | undefined> = {
    ...inherited,
    HOME: paths.home,
    OPENCODE_TEST_HOME: paths.home,
    OPENCODE_CONFIG_DIR: paths.config,
    OPENCODE_DB: paths.database,
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    ...(options.models === undefined ? {} : { OPENCODE_MODELS_PATH: options.models }),
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: options.projectConfig ? "false" : "true",
    OPENCODE_PRINT_LOGS: "1",
    // Core's feature flags as a release has them (own/scripts/test/release-flags.ts); a test may set its own.
    OPENCODE_FLAGS: process.env.OPENCODE_FLAGS ?? RELEASE_FLAGS,
    // As own's services (launcher, own-remote): no CLAUDE.md in instructions.
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ?? "1",
    // XDG_CACHE_HOME below would move Bun's transpiler cache into this boot's temp root; keep the shared one.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: E2E_TRANSPILER_CACHE,
    XDG_CACHE_HOME: path.dirname(paths.cache),
    XDG_CONFIG_HOME: path.join(paths.root, "xdg-config"),
    XDG_DATA_HOME: path.dirname(paths.data),
    XDG_STATE_HOME: path.dirname(paths.state),
    LOCALAPPDATA: paths.localAppData,
    APPDATA: paths.localAppData,
    // own-accounts reads the Codex CLI's config and model cache for the ChatGPT group's default (07 §2.2); a fresh
    // folder keeps this PC's `.codex` out of every test (USERPROFILE still names the real home on Windows).
    CODEX_HOME: path.join(paths.root, "codex-home"),
    // The own HOME hides the user's global `core.longpaths`: with a long temp root, core's snapshot `git init` fails
    // on Windows (`hooks/: Filename too long`), so there are no snapshots and no session diffs. Set it for the child.
    ...(process.platform === "win32"
      ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "true" }
      : {}),
    ...options.env,
  }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/** Closes stdin (graceful lease end), then kills the process tree if it has not exited in time. */
async function shutdown(proc: Subprocess<"pipe", "pipe", "pipe">) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await Promise.resolve(proc.stdin.end()).catch(() => undefined)
  const graceful = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (graceful) return
  if (process.platform === "win32")
    await Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
  if (process.platform !== "win32") proc.kill("SIGKILL")
  await proc.exited
}

/** Reads a child pipe to the end as lines; keeping pipes drained means the child never blocks on writes. */
async function drain(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const state = { pending: "" }
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    const lines = (state.pending + decoder.decode(chunk.value, { stream: true })).split(/\r?\n/)
    state.pending = lines.pop() ?? ""
    lines.forEach(onLine)
  }
  const rest = state.pending + decoder.decode()
  if (rest !== "") onLine(rest)
}

/** `serve --stdio` prints `{"url":"http://127.0.0.1:<port>"}` once it listens. */
function readyURL(line: string) {
  const parsed = parseJson(line)
  return isRecord(parsed) && typeof parsed.url === "string" ? parsed.url : undefined
}

/** `undefined` for the 503 a request gets while the Location's plugins still activate; any other error is thrown again. */
export function activating(error: unknown) {
  if (error instanceof Error && error.message.includes("failed with 503") && error.message.includes("finish activating"))
    return undefined
  throw error
}

/** Re-runs `probe` every 100ms until it returns true; throws after `ms`. */
async function poll(probe: () => Promise<boolean>, ms: number, message: string) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return
    await Bun.sleep(100)
  }
  throw new Error(`${message} within ${ms}ms`)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  const timer = Promise.withResolvers<never>()
  const handle = setTimeout(() => timer.reject(new Error(`${message} within ${ms}ms`)), ms)
  return Promise.race([promise, timer.promise]).finally(() => clearTimeout(handle))
}

function once(run: () => Promise<void>) {
  const state: { promise?: Promise<void> } = {}
  return () => {
    state.promise ??= run()
    return state.promise
  }
}

/** The configured plugins of a kit config (an object, or JSON text); 0 when it cannot be read. */
function pluginCount(config: unknown) {
  const parsed = typeof config === "string" ? parseJson(config) : config
  return isRecord(parsed) && Array.isArray(parsed.plugins) ? parsed.plugins.length : 0
}

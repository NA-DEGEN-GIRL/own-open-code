export * as RemoteModel from "./model.js"

import { createHash } from "node:crypto"
import path from "node:path"
import type { Registry } from "../registry.js"
import { Scripts } from "./scripts.js"

const posix = path.posix

// ---------------------------------------------------------------------------------------------------------------
// inspect report (04 §5.4)

export type EnvMode = "SHL" | "LOGIN" | "INTERACTIVE"

export interface ShellEnvReport {
  readonly state: "ok" | "unavailable"
  readonly HOME?: string
  readonly XDG_DATA_HOME?: string
  readonly XDG_STATE_HOME?: string
  readonly XDG_CONFIG_HOME?: string
  readonly PATH?: string
}

export interface Inspect {
  readonly complete: boolean
  readonly os: string
  readonly arch: string
  readonly target: string
  readonly libc: string
  readonly uid: string
  readonly shell: string
  readonly home: string
  readonly identity: string
  readonly ownHome: string
  readonly freeKb: number | null
  readonly installed: ReadonlyArray<string>
  readonly current: string | null
  readonly running: {
    readonly pid: number | null
    readonly alive: boolean
    readonly version: string | null
    readonly exeOk: boolean
  } | null
  readonly owner: string | null
  readonly ownerLabel: string | null
  readonly upstreamOpencode: boolean
  readonly sha256Tool: string
  readonly tar: boolean
  readonly opsPending: ReadonlyArray<{ readonly opId: string; readonly kind: string }>
  readonly linger: string | null
  readonly killUserProcesses: string | null
  readonly tmpFlags: string
  readonly ownHomeFlags: string
  readonly sockPathLen: number | null
  readonly env: Readonly<Record<EnvMode, ShellEnvReport>>
}

/** R1 platforms (04 §5.1). musl targets are R3. */
export const SUPPORTED_TARGETS = ["linux-x64-baseline", "linux-arm64"] as const

export function parseInspect(output: string): Inspect {
  const report = Scripts.parseReport(output, "OWN_INSPECT")
  const get = (key: string) => report.get(key) ?? ""
  const num = (key: string) => {
    const value = Number(get(key))
    return get(key) !== "" && Number.isFinite(value) ? value : null
  }
  const env = (mode: EnvMode): ShellEnvReport => {
    const state = get(`ENV_${mode}_STATE`) === "ok" ? "ok" : "unavailable"
    const pick = (key: string) => report.get(`ENV_${mode}_${key}`)
    return {
      state,
      ...(pick("HOME") !== undefined ? { HOME: pick("HOME") } : {}),
      ...(pick("XDG_DATA_HOME") !== undefined ? { XDG_DATA_HOME: pick("XDG_DATA_HOME") } : {}),
      ...(pick("XDG_STATE_HOME") !== undefined ? { XDG_STATE_HOME: pick("XDG_STATE_HOME") } : {}),
      ...(pick("XDG_CONFIG_HOME") !== undefined ? { XDG_CONFIG_HOME: pick("XDG_CONFIG_HOME") } : {}),
      ...(pick("PATH") !== undefined ? { PATH: pick("PATH") } : {}),
    }
  }
  const list = (key: string) => get(key).split(",").filter(Boolean)
  return {
    complete: get("DONE") === "1" && get("V") === "1",
    os: get("OS"),
    arch: get("ARCH"),
    target: get("TARGET"),
    libc: get("LIBC"),
    uid: get("UID"),
    shell: get("SHELL"),
    home: get("HOME"),
    identity: get("HOST_IDENTITY") || "unavailable",
    ownHome: get("OWN_HOME"),
    freeKb: num("FREE_KB"),
    installed: list("INSTALLED"),
    current: get("CURRENT") || null,
    running: report.has("RUNNING_PID")
      ? {
          pid: num("RUNNING_PID"),
          alive: get("RUNNING_PID_ALIVE") === "1",
          version: get("RUNNING_VERSION") || null,
          exeOk: get("RUNNING_EXE_OK") === "1",
        }
      : null,
    owner: get("OWNER") || null,
    ownerLabel: get("OWNER_LABEL") || null,
    upstreamOpencode: get("UPSTREAM_OPENCODE") === "1",
    sha256Tool: get("SHA256_TOOL") || "none",
    tar: get("TAR") === "1",
    opsPending: list("OPS_PENDING").map((item) => {
      const [opId = "", kind = ""] = item.split(":")
      return { opId, kind }
    }),
    linger: get("LINGER") || null,
    killUserProcesses: get("KILL_USER_PROCESSES") || null,
    tmpFlags: get("TMP_FLAGS") || "unknown",
    ownHomeFlags: get("OWN_HOME_FLAGS") || "unknown",
    sockPathLen: num("SOCK_PATH_LEN"),
    env: { SHL: env("SHL"), LOGIN: env("LOGIN"), INTERACTIVE: env("INTERACTIVE") },
  }
}

const MODE_OF: Readonly<Record<Registry.HostRecord["shellEnv"], EnvMode>> = {
  login: "LOGIN",
  "login-interactive": "INTERACTIVE",
  sh: "SHL",
}

/** Maximum socket path length we accept before switching to a short directory (04 §7.4). */
export const SOCKET_PATH_LIMIT = 100

/**
 * Remote paths from the shell mode that builds the service environment (04 §5.3): the same `HOME` and XDG values the
 * service sees. Falls back to the non-login shell of inspect when that mode is unavailable.
 */
export function remotePaths(
  inspect: Inspect,
  shellEnv: Registry.HostRecord["shellEnv"],
  installRoot?: string | null,
  testRoot?: string,
) {
  const mode = inspect.env[MODE_OF[shellEnv]]
  const base = mode.state === "ok" ? mode : inspect.env.SHL.state === "ok" ? inspect.env.SHL : undefined
  const home = (base?.HOME || inspect.home).replace(/\/+$/, "") || inspect.home
  const xdg = (value: string | undefined, fallback: string) =>
    value && posix.isAbsolute(value) ? value.replace(/\/+$/, "") : posix.join(home, fallback)
  // A test root (Options `remoteTest`) wins over whatever the shell reported: nothing may land on a real install's path.
  const roots = testRoot === undefined ? undefined : testXdg(testRoot)
  const data = roots?.XDG_DATA_HOME ?? xdg(base?.XDG_DATA_HOME, ".local/share")
  const state = roots?.XDG_STATE_HOME ?? xdg(base?.XDG_STATE_HOME, ".local/state")
  const config = roots?.XDG_CONFIG_HOME ?? xdg(base?.XDG_CONFIG_HOME, ".config")
  const ownHome =
    roots === undefined && installRoot && posix.isAbsolute(installRoot)
      ? installRoot.replace(/\/+$/, "")
      : posix.join(data, "own-open-code")
  return {
    home,
    ownHome,
    configDir: posix.join(config, "own-open-code"),
    upstreamConfigDir: posix.join(config, "opencode"),
    stateDir: posix.join(state, "opencode"),
    dataDir: posix.join(data, "opencode"),
    // Under a test root the short-directory fallbacks stay inside it too (`<root>/.own-r/<hash>` before `/tmp`).
    socketDir: socketDir(ownHome, testRoot ?? home, inspect.uid),
  } satisfies Registry.RemotePaths
}

/** The XDG roots of a test root (Options `remoteTest`, decisions RL35). */
export function testXdg(root: string) {
  return {
    XDG_DATA_HOME: posix.join(root, "data"),
    XDG_CONFIG_HOME: posix.join(root, "config"),
    XDG_STATE_HOME: posix.join(root, "state"),
    XDG_CACHE_HOME: posix.join(root, "cache"),
  }
}

/**
 * The remote command of an ssh call: unchanged, or under a test root `env XDG_DATA_HOME=<root>/data … <command>`, so
 * the scripts, the login shells they start and the service those start all resolve their paths inside the root. The
 * root is checked by the option's schema (an absolute path of `[A-Za-z0-9._/-]`), so it needs no quoting in any shell.
 */
export function remoteCommand(command: string, testRoot?: string) {
  if (testRoot === undefined) return command
  const roots = testXdg(testRoot)
  return `env ${Object.entries(roots)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ")} ${command}`
}

/**
 * Under a test root, the shell mode that starts the service must keep the root's XDG values (a profile that sets its
 * own would start the service on the real paths): the name of the first one it does not keep, else undefined.
 */
export function testRootLost(inspect: Inspect, shellEnv: Registry.HostRecord["shellEnv"], testRoot: string) {
  const mode = inspect.env[MODE_OF[shellEnv]]
  const base = mode.state === "ok" ? mode : inspect.env.SHL
  const roots = testXdg(testRoot)
  return (["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"] as const).find((name) => base[name] !== roots[name])
}

/**
 * `<OWN_HOME>/run`, or a short directory when the longest socket path (10-digit epoch) would pass 100 bytes:
 * `$HOME/.own-r/<hash8>`, then `/tmp/own-<uid>/<hash8>` (04 §7.4). The hash keeps separate installs apart.
 */
export function socketDir(ownHome: string, home: string, uid: string) {
  const fits = (dir: string) => Buffer.byteLength(posix.join(dir, "broker-0000000000.sock")) <= SOCKET_PATH_LIMIT
  const run = posix.join(ownHome, "run")
  if (fits(run)) return run
  const hash = createHash("sha256").update(ownHome).digest("hex").slice(0, 8)
  const short = posix.join(home, ".own-r", hash)
  if (fits(short)) return short
  return posix.join("/tmp", `own-${uid || "u"}`, hash)
}

export function socketPath(dir: string, epoch: number) {
  return posix.join(dir, `broker-${epoch}.sock`)
}

/**
 * The Claude egress relay's socket next to the broker's (04 §8.11.4.2): `egress-<epoch>.sock`, the same length as
 * `broker-<epoch>.sock`, so the socket directory rule of {@link socketDir} holds for both.
 */
export function egressSocketPath(dir: string, epoch: number) {
  return posix.join(dir, `egress-${epoch}.sock`)
}

/** Channel default port of upstream (`service-config.ts:34-38`): `10000 + sha1("own")[0..8] % 50000`. */
export function defaultPort(channel = "own") {
  return 10_000 + (Number.parseInt(createHash("sha1").update(channel).digest("hex").slice(0, 8), 16) % 50_000)
}

/** Warnings derived from inspect (04 §16.2 `warnings`). */
export function warnings(inspect: Inspect, shellEnv: Registry.HostRecord["shellEnv"]) {
  const result: string[] = []
  const chosen = inspect.env[MODE_OF[shellEnv]]
  const interactive = inspect.env.INTERACTIVE
  if (shellEnv !== "login-interactive" && interactive.state === "ok" && chosen.state === "ok") {
    const have = new Set((chosen.PATH ?? "").split(":"))
    if ((interactive.PATH ?? "").split(":").some((entry) => entry && !have.has(entry)))
      result.push("path_differs_interactive")
  }
  if (/^yes$/i.test(inspect.killUserProcesses ?? "") && !/^yes$/i.test(inspect.linger ?? ""))
    result.push("kill_user_processes")
  if (inspect.tmpFlags === "noexec") result.push("tmp_noexec")
  if (inspect.upstreamOpencode) result.push("upstream_opencode")
  if (inspect.identity === "unavailable") result.push("identity_unavailable")
  return result
}

// ---------------------------------------------------------------------------------------------------------------
// ensure report (04 §6.1)

export interface Registration {
  readonly url: string
  readonly password: string
  readonly version: string
  readonly pid: number
}

export interface EnsureReport {
  readonly result: string | undefined
  readonly identity: string | undefined
  readonly port: number | undefined
  readonly controlDir: string | undefined
  readonly home: string | undefined
  readonly runningVersion: string | undefined
  readonly staleEpoch: number | undefined
  readonly socketDir: "ok" | "unsafe" | undefined
  readonly ownerLabel: string | undefined
  readonly ops: string | undefined
  readonly hostname: string | undefined
  readonly registration: Registration | undefined
  /** This ensure started the service (it printed START_EXIT), so the current settings are applied. */
  readonly startedService: boolean
}

/**
 * The registration block, accepted only when it is the one the status line names (upstream `parseRegistration`,
 * `bootstrap.ts:31-53`) and its URL host is `127.0.0.1` or `[::1]`. Upstream also takes `0.0.0.0` and `[::]`, i.e. a
 * service open to the LAN; own stops with `service_not_loopback` instead (04 §6.1 step 7).
 */
export function parseRegistration(output: string): Registration | "not_loopback" | undefined {
  const status = output
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("OPENCODE_SSH_STATUS="))
    ?.slice("OPENCODE_SSH_STATUS=".length)
  if (!status) return undefined
  for (const match of output.matchAll(
    /OPENCODE_SSH_REGISTRATION_BEGIN\r?\n([\s\S]*?)\r?\nOPENCODE_SSH_REGISTRATION_END/g,
  )) {
    const value = safeJson(match[1] ?? "")
    if (!value || typeof value !== "object") continue
    const record = value as Record<string, unknown>
    if (
      typeof record.url !== "string" ||
      typeof record.password !== "string" ||
      typeof record.version !== "string" ||
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      record.url !== status
    )
      continue
    const url = URL.parse(record.url)
    if (!url || url.protocol !== "http:") continue
    if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return "not_loopback"
    return { url: record.url, password: record.password, version: record.version, pid: record.pid }
  }
  return undefined
}

export function parseEnsure(output: string): EnsureReport {
  const report = Scripts.parseReport(output, "OWN_ENSURE")
  const num = (key: string) => {
    const value = Number(report.get(key))
    return report.has(key) && Number.isFinite(value) ? value : undefined
  }
  const registration = parseRegistration(output)
  const socketDir = report.get("SOCKDIR")
  return {
    result: Scripts.parseResult(output, "OWN_ENSURE"),
    identity: report.get("IDENTITY"),
    port: num("PORT"),
    controlDir: report.get("CONTROL_DIR"),
    home: report.get("HOME"),
    runningVersion: report.get("RUNNING_VERSION") ?? report.get("VERSION"),
    staleEpoch: num("STALE_EPOCH"),
    socketDir: socketDir === "ok" || socketDir === "unsafe" ? socketDir : undefined,
    ownerLabel: report.get("OWNER_LABEL"),
    ops: report.get("OPS"),
    hostname: registration === "not_loopback" ? "not_loopback" : report.get("HOSTNAME"),
    registration: typeof registration === "object" ? registration : undefined,
    startedService: report.has("START_EXIT"),
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Managed settings (04 §5.6)

/**
 * The managed global config of the remote service: `<configDir>/opencode.json`, owned entirely by own-remote.
 * Deviation from 04 §5.6 (which edits `opencode.jsonc` in place): the remote has no JSONC editor (no node, python,
 * jq), so own keeps its keys in `opencode.json` and never touches the user's `opencode.jsonc`. Upstream loads both
 * files of the config directory, `opencode.json` first (`ConfigDiscovery.names`), so our plugins keep positions 1-6
 * and user plugins follow; user scalars in `opencode.jsonc` override ours. The plugins are the remote bundle's
 * (`REMOTE_PLUGINS`) in the local order: own.team third (06 §2.6, §4.13), own.telemetry fourth for the Claude slot
 * this PC relays (04 §8.11.14), own.harness after it as on this PC (10 §6.1: its request hooks run after every other
 * own plugin's; no options, so new host sessions get its default `codex` unless their creator names one), and own.omo
 * last as on this PC (15 §1: the host's `omo` sessions run omo; `home` puts omo's folders and log in this install's
 * OWN_HOME). The guards of own.telemetry, own.harness and own.omo need `OWN_OPEN_CODE=1` ({@link serviceEnv}) and the
 * same app version (the bundle is this release's, and a host on another version is `incompatible`); own-computer-use
 * never runs on a host and claude-auth is never installed there. own.creator goes last, as on this PC (17 §10,
 * 2026-11-06): `mode: "remote"` keeps a read-only mirror of the PC's extensions under this OWN_HOME through the broker;
 * a C3 code plugin the user allowed on this host is added by own.creator itself to `opencode.jsonc` (this file is
 * rewritten at every connection).
 */
export function managedConfig(paths: Registry.RemotePaths) {
  const plugins = `${paths.ownHome}/app/current/plugins`
  const deny = (resource: string) => [
    { action: "read", resource, effect: "deny" },
    { action: "edit", resource, effect: "deny" },
  ]
  return JSON.stringify(
    {
      update: "disable",
      share: "disabled",
      // As on this PC (decisions MR18-8): no background compaction, no automations (own-web cannot show them).
      compaction: { background: false },
      automations: false,
      plugins: [
        { package: `${plugins}/own-accounts`, options: { mode: "remote", home: paths.ownHome } },
        { package: `${plugins}/own-remote`, options: { mode: "agent", home: paths.ownHome } },
        { package: `${plugins}/own-team`, options: { mode: "remote", home: paths.ownHome } },
        { package: `${plugins}/own-telemetry`, options: { home: paths.ownHome } },
        { package: `${plugins}/own-harness` },
        { package: `${plugins}/own-omo`, options: { home: paths.ownHome } },
        { package: `${plugins}/own-creator`, options: { home: paths.ownHome, mode: "remote" } },
      ],
      permissions: [
        { action: "shell", resource: "*", effect: "ask" },
        ...deny(`${paths.ownHome}/run/*`),
        ...deny(`${paths.ownHome}/spool/*`),
        ...deny(`${paths.configDir}/service-own.json`),
        ...deny(`${paths.upstreamConfigDir}/service-own.json`),
        ...deny(`${paths.stateDir}/service-own.json`),
        ...deny(`${paths.dataDir}/opencode-own.db*`),
      ],
    },
    null,
    2,
  )
}

/**
 * The service `env` (04 §5.6): own markers, the config directory, `TMPDIR` under OWN_HOME (native modules are
 * extracted there, `/tmp` may be noexec, 04 §5.3), project config off unless the host is `trusted`, the repository's
 * instruction files on for `instructions`, then the host's own variables (provider key names refused earlier, the two
 * project variables never taken from them). `instructions` keeps `OPENCODE_CONFIG_PROJECT_DISABLE=1` and adds a second
 * variable: a service older than the three states does not know it and reads nothing from the repository, as for
 * `disabled`. A `NO_PROXY`/`no_proxy` of the host's variables gets `127.0.0.1,localhost` added (04 §8.11.14: a user
 * proxy must not take the loopback calls to the Claude relay's stub and the sink); start.sh adds them to the login
 * shell's own value the same way.
 */
export function serviceEnv(record: Registry.HostRecord, paths: Registry.RemotePaths) {
  const env: Record<string, string> = {
    OPENCODE_CONFIG_DIR: paths.configDir,
    OWN_OPEN_CODE: "1",
    OWN_REMOTE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    // Upstream's signed-out OpenCode models never stand in for an account the user did not set up (decisions TLM).
    OPENCODE_DISABLE_FREE_MODELS: "1",
    // Upstream v2.3.1 reads CLAUDE.md beside or instead of AGENTS.md and falls back to ~/.claude/CLAUDE.md; own's
    // services keep to AGENTS.md (decisions MR18).
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    TMPDIR: `${paths.ownHome}/tmp`,
  }
  if (record.projectConfig !== "trusted") env.OPENCODE_CONFIG_PROJECT_DISABLE = "1"
  if (record.projectConfig === "instructions") env.OPENCODE_CONFIG_PROJECT_INSTRUCTIONS = "1"
  for (const [key, value] of Object.entries(record.env)) {
    if (Scripts.isProviderEnv(key) || key in env || PROJECT_ENV.test(key)) continue
    env[key] = /^no_proxy$/i.test(key) ? withLoopback(value) : value
  }
  return env
}

/** A `NO_PROXY` list with `127.0.0.1` and `localhost` (kept once, the user's entries first). */
export function withLoopback(value: string) {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...entries, ...LOOPBACK.filter((entry) => !entries.includes(entry))].join(",")
}

const LOOPBACK = ["127.0.0.1", "localhost"]

/** The two variables of the project state: `serviceEnv` alone sets them, whatever a stored record's `env` holds. */
const PROJECT_ENV = /^OPENCODE_CONFIG_PROJECT_(DISABLE|INSTRUCTIONS)$/
/** Names `hosts.update{env}` refuses: `serviceEnv` decides them. */
const MANAGED_ENV = /^(OPENCODE_CONFIG_DIR|OWN_|TMPDIR$|OPENCODE_CONFIG_PROJECT_(DISABLE|INSTRUCTIONS)$)/

/** Validation of `hosts.update{env, pathPrepend}` (04 §5.6 "provider 키 이름은 거부"). */
export function validateEnv(env: Readonly<Record<string, string>>) {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `env name ${key}`
    if (Scripts.isProviderEnv(key)) return `provider key ${key}`
    if (MANAGED_ENV.test(key)) return `managed ${key}`
    if (/[\0\n\r]/.test(value)) return `env value ${key}`
  }
  return undefined
}

export function validatePathPrepend(entries: ReadonlyArray<string>) {
  for (const entry of entries) if (!posix.isAbsolute(entry) || /[:\0\n\r]/.test(entry)) return entry
  return undefined
}

/**
 * `<OWN_HOME>/tools/<tool>/current`: the link the tool script points at the verified version (06 §4.13). It goes into
 * the host's `pathPrepend`, so the service's shells (pre-push hooks) find the tool after the next restart.
 */
export function toolDir(ownHome: string, tool: string) {
  return `${ownHome}/tools/${tool}/current`
}

/** Hash of the settings that need a remote restart (04 §6.4 "설정 대기"). */
export function settingsHash(record: Registry.HostRecord) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectConfig: record.projectConfig,
        shellEnv: record.shellEnv,
        env: Object.entries(record.env).sort(),
        pathPrepend: record.pathPrepend,
      }),
    )
    .digest("hex")
    .slice(0, 16)
}

export * as McpHostRules from "./mcp-host-rules.js"

import { references } from "./mcp-rules.js"
import { secretName } from "./mcp-secrets.js"

/**
 * MCP servers of this PC on an SSH host (04 §13 "MCP", 03 §18.14 "SSH 호스트에 설치", MH 2026-11-26): the plain rules
 * own-web and own.accounts share without the schema graph. {@link analyze} reads one server as this PC knows it (own's
 * server or a config file's, names of its values only) against a host's probe and says how it could run there: its
 * kind, the runtime its command needs, the package it names, which arguments are paths on this PC and what they become
 * on the host, which values it needs, and one result (`ready` 바로 설치 가능, `prepare` 호스트 준비 필요, `assist` AI 도움
 * 필요, `pc-only` 이 PC 전용, `unknown` before the host was probed) with every reason. {@link translate} builds the
 * host's definition from it; {@link hash} names the PC's definition, so a host row can tell when the PC changed
 * (`PC와 다름`). Nothing here reads a value: a value travels only through `mcp.hosts.send` (the user's explicit step).
 */

/** The host's install tool of `AI에게 설치 맡기기` (its permission too): `McpHost.TOOL`. */
export const TOOL = "own_mcp_install"

/** A runtime a command may need on the host. `bun` may be the host's own-bundled one (`BUN_BE_BUN=1`). */
export const RUNTIMES = ["node", "npx", "uv", "uvx", "python", "pipx", "docker", "podman", "bun", "deno"] as const
export type RuntimeName = (typeof RUNTIMES)[number]

/** What a host has (`mcp.host.probe`): read only, in the service's own environment (the one MCP servers start in). */
export interface Probe {
  readonly at: number
  readonly os: string
  readonly arch: string
  /** The service user's home folder on the host (`~` of a mapped path). */
  readonly home: string
  /** Each runtime found on the service's PATH with its version line; absent = not found. */
  readonly runtimes: Partial<Record<RuntimeName, { readonly version?: string; readonly command?: string }>>
  /** `docker` (and `podman`) can talk to their daemon without sudo (`docker info`), or not. */
  readonly containers?: { readonly docker?: "ok" | "denied"; readonly podman?: "ok" | "denied" }
  /** Plain programs asked for by name (`binaries` of the probe's input): found on PATH or not. */
  readonly binaries: Readonly<Record<string, boolean>>
  /**
   * The host's own service program, which is a Bun build and runs as `bun` with `BUN_BE_BUN=1`: a bun command runs
   * with it when the host has no bun of its own.
   */
  readonly ownBun?: { readonly command: string; readonly version?: string }
}

/** One server as this PC knows it: names of values only. */
export type Transport =
  | {
      readonly type: "local"
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly cwd?: string
      /** Names of its environment values. */
      readonly env: ReadonlyArray<string>
      readonly codemode?: boolean
    }
  | {
      readonly type: "remote"
      readonly url: string
      readonly query: boolean
      readonly hidden?: boolean
      readonly headers: ReadonlyArray<string>
      readonly oauth: boolean
      readonly codemode?: boolean
    }

export interface Source {
  /** `own:<id>` for own's server, `file:<name>` for a config file's. */
  readonly key: string
  readonly name: string
  readonly origin: "own" | "file"
  readonly transport: Transport
  /** Off on this PC (still offered: the user may want it on the host). */
  readonly disabled?: boolean
}

export interface Context {
  /** This PC's home folder (`C:\Users\demo`): a path inside it maps to `~/…` on the host. */
  readonly home: string
  /** The project folder on this PC the page shows: a path inside it maps to a relative path (the host's project). */
  readonly project?: string
  /** The host's probe; without it the runtimes are unknown (`unknown`). */
  readonly probe?: Probe
}

export type Result = "ready" | "prepare" | "assist" | "pc-only" | "unknown"

export type ArgKind =
  /** Kept as written. */
  | "plain"
  /** Names a stored value (`${NAME}`): the value comes with the values the user sends. */
  | "reference"
  /** A path in this PC's home folder: `~/…` on the host. */
  | "home"
  /** A path in this PC's project folder: relative on the host (MCP servers start in the conversation's folder). */
  | "project"
  /** A path or address of this PC that means nothing on the host: needs a host value. */
  | "host"

export interface Arg {
  readonly text: string
  readonly kind: ArgKind
  /** What it becomes on the host (`home`, `project`), or a suggestion for `host`. */
  readonly host?: string
}

export type Reason =
  | { readonly code: "remote_url" }
  | { readonly code: "localhost_url" }
  | { readonly code: "oauth" }
  | { readonly code: "windows_program"; readonly command: string }
  | { readonly code: "windows_shell"; readonly command: string }
  | { readonly code: "windows_resource"; readonly name: string }
  | { readonly code: "script"; readonly path: string }
  | { readonly code: "python_module"; readonly module: string }
  | { readonly code: "uv_project" }
  | { readonly code: "binary"; readonly command: string; readonly found?: boolean }
  | { readonly code: "runtime_missing"; readonly runtime: RuntimeName }
  | { readonly code: "container_denied"; readonly runtime: "docker" | "podman" }
  | { readonly code: "own_bun" }
  | { readonly code: "host_value"; readonly args: ReadonlyArray<number> }
  | { readonly code: "cwd_host_value" }
  | { readonly code: "mapped"; readonly args: ReadonlyArray<number> }
  | { readonly code: "values"; readonly names: ReadonlyArray<string> }
  | { readonly code: "unwrapped"; readonly shell: string }
  | { readonly code: "no_probe" }
  | { readonly code: "unknown_command"; readonly command: string }

export interface Package {
  readonly registry: "npm" | "pypi" | "oci" | "jsr"
  readonly name: string
  readonly version?: string
}

export interface Value {
  readonly name: string
  readonly kind: "env" | "header" | "address"
  /** Looks like a secret (its name, or the command names it as `${NAME}`). Every value still waits for the send step. */
  readonly secret: boolean
}

export interface Analysis {
  readonly key: string
  readonly name: string
  readonly kind: "local" | "remote"
  /** `url` for a remote server, `windows` for a program only this PC runs, `binary` for a plain program on PATH. */
  readonly runtime: RuntimeName | "url" | "binary" | "windows" | "script"
  readonly package?: Package
  /** The command as the host runs it (no Windows path or extension, `cmd /c` unwrapped). */
  readonly command?: string
  readonly args: ReadonlyArray<Arg>
  readonly cwd?: Arg
  readonly values: ReadonlyArray<Value>
  readonly result: Result
  readonly reasons: ReadonlyArray<Reason>
  /** Runtimes the host lacks for it (`prepare`). */
  readonly needs: ReadonlyArray<RuntimeName>
  /** Programs to look up on the host (`Probe.binaries`). */
  readonly binaries: ReadonlyArray<string>
}

/** How the host runs a server: its command and arguments, no values (env names only), plus fixed plain variables. */
export type HostTransport =
  | {
      readonly type: "local"
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly cwd?: string
      readonly env: ReadonlyArray<string>
      readonly codemode?: boolean
      /** Plain variables the translation sets (`BUN_BE_BUN=1` for the host's own bun), never a value of the PC. */
      readonly fixed?: Readonly<Record<string, string>>
    }
  | {
      readonly type: "remote"
      readonly url: string
      readonly query: boolean
      readonly hidden?: boolean
      readonly headers: ReadonlyArray<string>
      readonly oauth: boolean
      readonly codemode?: boolean
    }

// ---------------------------------------------------------------------------------------------------------------

const WINDOWS_EXT = /\.(exe|cmd|bat|ps1|com)$/i
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/
const SHELLS = new Set(["cmd", "powershell", "pwsh", "wscript", "cscript", "wsl", "start"])
/** Names of programs or packages that drive this PC's desktop or Windows itself. */
const WINDOWS_RESOURCE =
  /(^|[-_/@.])(windows|win32|winapi|powershell|autohotkey|uiautomation|outlook-com|computer-use|desktop-automation)([-_/@.]|$)/i
const LOCALHOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i

/** The program's own name: no folder, no `.exe`/`.cmd`, lower case. */
export function programName(command: string) {
  const base = command.split(/[\\/]/).at(-1) ?? command
  return base.replace(WINDOWS_EXT, "").toLowerCase()
}

export function windowsPath(text: string) {
  return WINDOWS_ABSOLUTE.test(text) || /^file:\/\/\/[A-Za-z]:/i.test(text)
}

/**
 * One server against a host. The result is the strictest of its reasons: `pc-only` (a Windows program, the PC's
 * localhost, its desktop), then `assist` (a script or a project that must come along, a program that is not there, a
 * path that needs a host value), then `prepare` (a runtime the host lacks, or docker without access), then `ready`.
 * Without a probe a local server that needs a runtime is `unknown`.
 */
export function analyze(source: Source, context: Context): Analysis {
  const transport = source.transport
  if (transport.type === "remote") return remote(source, transport)
  const unwrapped = unwrap(transport.command, transport.args)
  const program = programName(unwrapped.command)
  const values = transport.env.map((name): Value => ({ name, kind: "env", secret: secret(name, transport) }))
  const args = unwrapped.args.map((text) => classify(text, context))
  const cwd = transport.cwd === undefined ? undefined : classify(transport.cwd, context)
  const reasons: Reason[] = []
  if (unwrapped.shell) reasons.push({ code: "unwrapped", shell: unwrapped.shell })
  const base = {
    key: source.key,
    name: source.name,
    kind: "local" as const,
    args,
    ...(cwd ? { cwd } : {}),
    values,
  }
  const absolute = windowsPath(unwrapped.command)
  const known = runtimeOf(program)
  // A Windows program by path, or a shell only Windows has.
  if (SHELLS.has(program))
    return finish({ ...base, runtime: "windows", command: unwrapped.command }, [
      ...reasons,
      { code: "windows_shell", command: program },
    ])
  if (absolute && known === undefined)
    return finish({ ...base, runtime: "windows", command: unwrapped.command }, [
      ...reasons,
      { code: "windows_program", command: unwrapped.command },
    ])
  if (WINDOWS_EXT.test(unwrapped.command) && known === undefined && !/\.(exe|cmd)$/i.test(unwrapped.command))
    return finish({ ...base, runtime: "windows", command: unwrapped.command }, [
      ...reasons,
      { code: "windows_shell", command: unwrapped.command },
    ])
  const identity = packageOf(program, unwrapped.args)
  const resource = [program, identity?.name ?? ""].find((name) => WINDOWS_RESOURCE.test(name))
  if (resource)
    return finish({ ...base, runtime: known ?? "binary", command: program }, [
      ...reasons,
      { code: "windows_resource", name: identity?.name ?? program },
    ])
  const pathArgs = (kind: ArgKind) => args.flatMap((arg, index) => (arg.kind === kind ? [index] : []))
  const mapped = [...pathArgs("home"), ...pathArgs("project")].toSorted((a, b) => a - b)
  if (mapped.length > 0) reasons.push({ code: "mapped", args: mapped })
  const hostArgs = pathArgs("host")
  if (hostArgs.length > 0) reasons.push({ code: "host_value", args: hostArgs })
  if (cwd?.kind === "host") reasons.push({ code: "cwd_host_value" })
  if (values.length > 0) reasons.push({ code: "values", names: values.map((value) => value.name) })
  const probe = context.probe
  const needs = (runtime: RuntimeName, alternatives: ReadonlyArray<RuntimeName> = []) => {
    if (!probe) return [{ code: "no_probe" } as const]
    const found = [runtime, ...alternatives].some((name) => probe.runtimes[name] !== undefined)
    return found ? [] : [{ code: "runtime_missing", runtime } as const]
  }
  const name = identity ? { package: identity } : {}
  switch (known) {
    case "npx":
      return finish({ ...base, ...name, runtime: "npx", command: program === "npm" ? "npm" : "npx" }, [
        ...reasons,
        ...needs("npx"),
      ])
    case "uvx":
      // `uv tool run` is uvx: a host with uv alone runs it (build-host's uv 0.12 install put no `uvx` on PATH).
      return finish({ ...base, ...name, runtime: "uvx", command: "uvx" }, [...reasons, ...needs("uvx", ["uv"])])
    case "pipx":
      return finish({ ...base, ...name, runtime: "pipx", command: "pipx" }, [...reasons, ...needs("pipx")])
    case "uv": {
      // `uv tool run <pkg>` is uvx; `uv run` runs a project or a script of this PC.
      if (identity) return finish({ ...base, ...name, runtime: "uv", command: "uv" }, [...reasons, ...needs("uv")])
      return finish({ ...base, runtime: "uv", command: "uv" }, [...reasons, { code: "uv_project" }, ...needs("uv")])
    }
    case "python": {
      const module = moduleOf(unwrapped.args)
      if (module)
        return finish({ ...base, runtime: "python", command: "python3" }, [
          ...reasons,
          { code: "python_module", module },
          ...needs("python"),
        ])
      return finish({ ...base, runtime: "script", command: "python3" }, [
        ...reasons,
        { code: "script", path: scriptOf(unwrapped.args) ?? "" },
        ...needs("python"),
      ])
    }
    case "node":
      return finish({ ...base, runtime: "script", command: "node" }, [
        ...reasons,
        { code: "script", path: scriptOf(unwrapped.args) ?? "" },
        ...needs("node"),
      ])
    case "bun": {
      // The host's bun, else its own service program as bun.
      const own = probe !== undefined && probe.runtimes.bun === undefined && probe.ownBun !== undefined
      const bunReasons = own ? [{ code: "own_bun" } as const] : needs("bun")
      // `bunx <pkg>` / `bun x <pkg>` fetch a package; anything else runs a script of this PC.
      if (identity) return finish({ ...base, ...name, runtime: "bun", command: program }, [...reasons, ...bunReasons])
      return finish({ ...base, runtime: "script", command: program }, [
        ...reasons,
        { code: "script", path: scriptOf(unwrapped.args.filter((arg) => arg !== "run")) ?? "" },
        ...bunReasons,
      ])
    }
    case "deno": {
      if (identity)
        return finish({ ...base, ...name, runtime: "deno", command: "deno" }, [...reasons, ...needs("deno")])
      return finish({ ...base, runtime: "script", command: "deno" }, [
        ...reasons,
        { code: "script", path: scriptOf(unwrapped.args.filter((arg) => arg !== "run")) ?? "" },
        ...needs("deno"),
      ])
    }
    case "docker":
    case "podman": {
      const access = probe?.containers?.[known]
      const extra: Reason[] = !probe
        ? [{ code: "no_probe" }]
        : probe.runtimes[known] === undefined
          ? [{ code: "runtime_missing", runtime: known }]
          : access === "ok"
            ? []
            : [{ code: "container_denied", runtime: known }]
      return finish({ ...base, ...name, runtime: known, command: known }, [...reasons, ...extra])
    }
    default: {
      if (absolute || program === "")
        return finish({ ...base, runtime: "windows", command: unwrapped.command }, [
          ...reasons,
          { code: "unknown_command", command: unwrapped.command },
        ])
      const found = probe?.binaries[program]
      return finish({ ...base, runtime: "binary", command: program, binaries: [program] }, [
        ...reasons,
        ...(probe ? [{ code: "binary", command: program, found } as const] : [{ code: "no_probe" } as const]),
      ])
    }
  }
}

/** The strictest result of the reasons (see {@link analyze}). */
export function resultOf(reasons: ReadonlyArray<Reason>): Result {
  const codes = new Set(reasons.map((reason) => reason.code))
  if (
    ["localhost_url", "windows_program", "windows_shell", "windows_resource"].some((code) => codes.has(code as never))
  )
    return "pc-only"
  const binary = reasons.find((reason) => reason.code === "binary")
  if (
    ["script", "python_module", "uv_project", "host_value", "cwd_host_value", "unknown_command"].some((code) =>
      codes.has(code as never),
    ) ||
    (binary?.code === "binary" && binary.found !== true)
  )
    return "assist"
  if (codes.has("no_probe")) return "unknown"
  if (codes.has("runtime_missing") || codes.has("container_denied")) return "prepare"
  return "ready"
}

function finish(
  base: Omit<Analysis, "result" | "reasons" | "needs" | "binaries"> & { readonly binaries?: ReadonlyArray<string> },
  reasons: ReadonlyArray<Reason>,
): Analysis {
  return {
    ...base,
    binaries: base.binaries ?? [],
    reasons,
    result: resultOf(reasons),
    needs: reasons.flatMap((reason) => (reason.code === "runtime_missing" ? [reason.runtime] : [])),
  }
}

function remote(source: Source, transport: Extract<Transport, { type: "remote" }>): Analysis {
  const host = hostOf(transport.url)
  const values: Value[] = [
    ...transport.headers.map((name): Value => ({ name, kind: "header", secret: secretName(name) })),
    ...(transport.query || transport.hidden ? [{ name: "URL", kind: "address" as const, secret: true }] : []),
  ]
  const reasons: Reason[] = [
    { code: host !== undefined && LOCALHOST.test(host) ? "localhost_url" : "remote_url" },
    ...(transport.oauth ? [{ code: "oauth" } as const] : []),
    ...(values.length > 0 ? [{ code: "values", names: values.map((value) => value.name) } as const] : []),
  ]
  return {
    key: source.key,
    name: source.name,
    kind: "remote",
    runtime: "url",
    args: [],
    values,
    reasons,
    result: resultOf(reasons),
    needs: [],
    binaries: [],
  }
}

function hostOf(url: string) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url)
  return match?.[1]
}

function secret(name: string, transport: Extract<Transport, { type: "local" }>) {
  return secretName(name) || [transport.command, ...transport.args].some((text) => references(text).includes(name))
}

/** `cmd /c <program> …` (Claude Code's Windows advice) is the program itself. */
function unwrap(
  command: string,
  args: ReadonlyArray<string>,
): {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly shell?: string
} {
  if (programName(command) !== "cmd") return { command, args }
  const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg))
  const rest = at === -1 ? [] : args.slice(at + 1)
  if (rest.length === 0) return { command, args }
  return { command: rest[0]!, args: rest.slice(1), shell: "cmd" }
}

function runtimeOf(program: string): RuntimeName | undefined {
  if (program === "npx" || program === "npm") return "npx"
  if (program === "uvx") return "uvx"
  if (program === "uv") return "uv"
  if (program === "pipx") return "pipx"
  if (program === "node" || program === "nodejs") return "node"
  if (program === "python" || program === "python3" || program === "py") return "python"
  if (program === "bun" || program === "bunx") return "bun"
  if (program === "deno") return "deno"
  if (program === "docker") return "docker"
  if (program === "podman") return "podman"
  return undefined
}

/** Options of a launcher that take the next argument as their value. */
const TAKES_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  npx: new Set(["-p", "--package", "-c", "--call", "--registry", "--cache", "--prefix", "-w", "--workspace"]),
  uvx: new Set([
    "--from",
    "--with",
    "--with-editable",
    "--with-requirements",
    "--python",
    "-p",
    "--index",
    "--index-url",
  ]),
  pipx: new Set(["--spec", "--python", "--pip-args", "--index-url"]),
  docker: new Set([
    "-e",
    "--env",
    "--env-file",
    "-v",
    "--volume",
    "--mount",
    "--name",
    "--network",
    "--net",
    "-p",
    "--publish",
    "-w",
    "--workdir",
    "-u",
    "--user",
    "--entrypoint",
    "--platform",
    "--pull",
    "-l",
    "--label",
    "--add-host",
    "--memory",
    "-m",
    "--cpus",
    "--hostname",
    "-h",
    "--ipc",
    "--pid",
    "--runtime",
    "--security-opt",
    "--cap-add",
    "--cap-drop",
    "--device",
    "--gpus",
    "--log-driver",
    "--tmpfs",
    "--ulimit",
  ]),
  deno: new Set(["--config", "-c", "--import-map", "--location", "--seed", "--v8-flags", "--env-file", "--lock"]),
}

/** The first positional argument after the launcher's options (`-p x` skipped, `--x=y` one argument). */
function positional(args: ReadonlyArray<string>, takes: ReadonlySet<string>) {
  const at = args.findIndex(
    (arg, index) => !arg.startsWith("-") && (index === 0 || !takes.has(args[index - 1]!)) && arg !== "--",
  )
  return at === -1 ? undefined : { at, text: args[at]! }
}

/** The package a launcher fetches: npm for npx/bunx, PyPI for uvx/pipx/`uv tool run`, OCI for docker, jsr/npm for deno. */
export function packageOf(program: string, args: ReadonlyArray<string>): Package | undefined {
  const runtime = runtimeOf(program)
  if (runtime === "npx") {
    const rest = program === "npm" ? (args[0] === "exec" || args[0] === "x" ? args.slice(1) : undefined) : args
    if (!rest) return undefined
    const flag = rest.findIndex((arg) => arg === "-p" || arg === "--package")
    const named = rest.find((arg) => arg.startsWith("--package="))?.slice("--package=".length)
    const spec = named ?? (flag === -1 ? positional(rest, TAKES_VALUE.npx!)?.text : rest[flag + 1])
    return spec === undefined ? undefined : npmSpec(spec)
  }
  if (runtime === "bun") {
    const rest = program === "bunx" ? args : args[0] === "x" ? args.slice(1) : undefined
    const spec = rest ? positional(rest, new Set(["-p", "--package"]))?.text : undefined
    return spec === undefined ? undefined : npmSpec(spec)
  }
  if (runtime === "uvx" || runtime === "uv" || runtime === "pipx") {
    const rest =
      runtime === "uv"
        ? args[0] === "tool" && args[1] === "run"
          ? args.slice(2)
          : undefined
        : runtime === "pipx"
          ? args[0] === "run"
            ? args.slice(1)
            : undefined
          : args
    if (!rest) return undefined
    const from = rest.findIndex((arg) => arg === "--from" || arg === "--spec")
    const spec = from === -1 ? positional(rest, TAKES_VALUE.uvx!)?.text : rest[from + 1]
    return spec === undefined ? undefined : pypiSpec(spec)
  }
  if (runtime === "docker" || runtime === "podman") {
    const at = args.indexOf("run")
    if (at === -1) return undefined
    const image = positional(args.slice(at + 1), TAKES_VALUE.docker!)?.text
    return image === undefined ? undefined : ociSpec(image)
  }
  if (runtime === "deno") {
    const at = args.indexOf("run")
    const spec = at === -1 ? undefined : positional(args.slice(at + 1), TAKES_VALUE.deno!)?.text
    if (spec?.startsWith("npm:")) return npmSpec(spec.slice(4))
    if (spec?.startsWith("jsr:")) {
      const parsed = npmSpec(spec.slice(4))
      return { ...parsed, registry: "jsr" }
    }
    return undefined
  }
  return undefined
}

function npmSpec(spec: string): Package {
  const scoped = spec.startsWith("@")
  const at = spec.indexOf("@", scoped ? 1 : 0)
  if (at <= 0) return { registry: "npm", name: spec }
  const version = spec.slice(at + 1)
  return { registry: "npm", name: spec.slice(0, at), ...(version ? { version } : {}) }
}

function pypiSpec(spec: string): Package {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:==|@|>=|~=)\s*([^\s,;]+)/.exec(spec)
  if (match) return { registry: "pypi", name: match[1]!, version: match[2]! }
  return { registry: "pypi", name: spec.replace(/\[[^\]]*\]$/, "") }
}

function ociSpec(image: string): Package {
  const digest = image.indexOf("@")
  if (digest !== -1) return { registry: "oci", name: image.slice(0, digest), version: image.slice(digest + 1) }
  const slash = image.lastIndexOf("/")
  const colon = image.lastIndexOf(":")
  if (colon > slash) return { registry: "oci", name: image.slice(0, colon), version: image.slice(colon + 1) }
  return { registry: "oci", name: image }
}

function moduleOf(args: ReadonlyArray<string>) {
  const at = args.indexOf("-m")
  return at === -1 ? undefined : args[at + 1]
}

function scriptOf(args: ReadonlyArray<string>) {
  return args.find((arg) => !arg.startsWith("-"))
}

/**
 * One argument: a `${NAME}` reference, a path of this PC (inside its home: `~/…`; inside the project: relative; else
 * it needs a host value), the PC's localhost in an address (needs a host value), or plain. `--flag=<path>` maps the
 * part after `=`; a docker volume `C:\x:/data` maps its host side.
 */
export function classify(text: string, context: Context): Arg {
  if (references(text).length > 0) return { text, kind: "reference" }
  const eq = /^(--?[A-Za-z0-9][A-Za-z0-9_.-]*=|[A-Za-z_][A-Za-z0-9_]*=)(.+)$/.exec(text)
  if (eq) {
    const inner = classify(eq[2]!, context)
    if (inner.kind === "plain" || inner.kind === "reference") return { text, kind: inner.kind }
    return { text, kind: inner.kind, ...(inner.host === undefined ? {} : { host: eq[1]! + inner.host }) }
  }
  const volume = /^((?:[A-Za-z]:)?[^:]+):(\/.*)$/.exec(text)
  if (volume && windowsPath(volume[1]!)) {
    const inner = classify(volume[1]!, context)
    return { text, kind: inner.kind, ...(inner.host === undefined ? {} : { host: `${inner.host}:${volume[2]}` }) }
  }
  const local = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(text)
  if (local && LOCALHOST.test(local[1]!)) return { text, kind: "host" }
  if (!windowsPath(text)) return { text, kind: "plain" }
  const file = text.replace(/^file:\/\/\//i, "")
  const project = context.project === undefined ? undefined : inside(file, context.project)
  if (project !== undefined) return { text, kind: "project", host: project === "" ? "." : `./${project}` }
  const home = inside(file, context.home)
  if (home !== undefined) return { text, kind: "home", host: home === "" ? "~" : `~/${home}` }
  return { text, kind: "host" }
}

/** The part of `file` under `folder` with `/` separators (`""` for the folder itself), or `undefined`. */
function inside(file: string, folder: string) {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const a = norm(file)
  const b = norm(folder)
  if (b === "") return undefined
  if (a.toLowerCase() === b.toLowerCase()) return ""
  if (!a.toLowerCase().startsWith(`${b.toLowerCase()}/`)) return undefined
  return a.slice(b.length + 1)
}

/**
 * The host's definition of an analysed server: the command as the host runs it, mapped paths (`~/…`, which the host
 * makes absolute when it saves), `host` arguments from `values` (by index; the analysis's suggestion otherwise is
 * not used: a path the user has not given cannot be guessed), and for a bun command without bun on the host's PATH
 * the host's own-bundled bun (`BUN_BE_BUN=1`). `undefined` while an argument still needs a host value, or for a
 * server that cannot run on a host (`pc-only`).
 */
export function translate(
  source: Source,
  analysis: Analysis,
  input: { readonly probe?: Probe; readonly args?: Readonly<Record<number, string>>; readonly cwd?: string } = {},
): HostTransport | undefined {
  const transport = source.transport
  if (transport.type === "remote")
    return analysis.result === "pc-only"
      ? undefined
      : {
          type: "remote",
          url: transport.url,
          query: transport.query,
          ...(transport.hidden ? { hidden: true } : {}),
          headers: [...transport.headers],
          oauth: transport.oauth,
          ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
        }
  if (analysis.result === "pc-only" || analysis.command === undefined) return undefined
  const args = analysis.args.map((arg, index) => {
    const given = input.args?.[index]
    if (given !== undefined && given.trim() !== "") return given
    if (arg.kind === "home" || arg.kind === "project") return arg.host
    if (arg.kind === "host") return undefined
    return arg.text
  })
  if (args.some((arg) => arg === undefined)) return undefined
  const cwd =
    input.cwd !== undefined && input.cwd.trim() !== ""
      ? input.cwd
      : analysis.cwd === undefined
        ? undefined
        : analysis.cwd.kind === "host"
          ? null
          : (analysis.cwd.host ?? analysis.cwd.text)
  if (cwd === null) return undefined
  const probe = input.probe
  const ownBun =
    (analysis.command === "bun" || analysis.command === "bunx") &&
    probe !== undefined &&
    probe.runtimes.bun === undefined &&
    probe.ownBun !== undefined
  // `bunx pkg` becomes `bun x pkg` so the host's own bun (one program) runs it.
  const bunArgs = ownBun && analysis.command === "bunx" ? ["x", ...(args as string[])] : (args as string[])
  // `uvx pkg` becomes `uv tool run pkg` on a host with uv but no uvx.
  const uvOnly =
    analysis.command === "uvx" && probe !== undefined && probe.runtimes.uvx === undefined && probe.runtimes.uv !== undefined
  return {
    type: "local",
    command: ownBun ? probe!.ownBun!.command : uvOnly ? "uv" : analysis.command,
    args: uvOnly ? ["tool", "run", ...bunArgs] : bunArgs,
    ...(cwd === undefined ? {} : { cwd }),
    env: [...transport.env],
    ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
    ...(ownBun ? { fixed: { BUN_BE_BUN: "1" } } : {}),
  }
}

/**
 * The PC's definition of a server as one short name (FNV-1a 64, hex): its name and transport, values by name only.
 * The host keeps it with what it installed; a different one now means the PC changed it (`PC와 다름`).
 */
export function hash(source: Pick<Source, "name" | "transport">) {
  const transport = source.transport
  const parts =
    transport.type === "local"
      ? [
          "local",
          source.name,
          transport.command,
          transport.args,
          transport.cwd ?? null,
          transport.env.toSorted(),
          transport.codemode ?? null,
        ]
      : [
          "remote",
          source.name,
          transport.url,
          transport.query,
          transport.hidden === true,
          transport.headers.map((name) => name.toLowerCase()).toSorted(),
          transport.oauth,
          transport.codemode ?? null,
        ]
  return fnv(JSON.stringify(parts))
}

function fnv(text: string) {
  const bytes = new TextEncoder().encode(text)
  let h = 0xcbf29ce484222325n
  for (const byte of bytes) h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n)
  return h.toString(16).padStart(16, "0")
}

/** Resolves `~` and `~/…` (a mapped home path) against the host's home folder; the host does this when it saves. */
export function hostPath(text: string, home: string): string {
  const at = text.indexOf("~")
  if (text === "~") return home
  if (text.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${text.slice(2)}`
  // `--root=~/x`, `KEY=~/x`, a volume `~/x:/data`.
  if (at > 0 && /[=]$/.test(text.slice(0, at)) && (text[at + 1] === "/" || text.length === at + 1))
    return text.slice(0, at) + hostPath(text.slice(at), home)
  return text
}

// ---------------------------------------------------------------------------------------------------------------
// The AI-assisted install's brief (`AI에게 설치 맡기기`): the first message of a new conversation on the host. It is
// self-contained: the definition with values masked (the caller passes the masked command line), the analysis, the
// probe, the goal and what not to do. The host's tool `own_mcp_install` is allowed in that conversation only.

export interface BriefInput {
  readonly locale: "ko" | "en"
  /** The host's name as the user sees it. */
  readonly host: string
  readonly source: Source
  readonly analysis: Analysis
  readonly probe?: Probe
  /** The command line as the page shows it (values as `${NAME}` or `••••`). */
  readonly shown: string
  /** The tool's name (`McpHost.TOOL`). */
  readonly tool: string
}

const RESULT_TEXT = {
  ko: {
    ready: "바로 설치 가능",
    prepare: "호스트 준비 필요",
    assist: "AI 도움 필요",
    "pc-only": "이 PC 전용",
    unknown: "확인 필요",
  },
  en: {
    ready: "Ready to install",
    prepare: "Host needs setup",
    assist: "Needs AI help",
    "pc-only": "This PC only",
    unknown: "Not checked",
  },
} as const

const list = (indexes: ReadonlyArray<number>) => indexes.map((index) => index + 1).join(", ")

/** One line per reason, in the brief's language (the settings page shows its own texts). */
export function reasonText(reason: Reason, locale: "ko" | "en"): string {
  const ko = locale === "ko"
  switch (reason.code) {
    case "remote_url":
      return ko ? "원격 주소(HTTP) 서버" : "a remote (HTTP) server"
    case "localhost_url":
      return ko ? "주소가 이 PC(localhost)를 가리킴" : "its address points at this PC (localhost)"
    case "oauth":
      return ko ? "서버가 요구하면 호스트에서 로그인(OAuth)" : "signs in (OAuth) on the host if the server asks"
    case "windows_program":
      return ko ? `Windows 프로그램(${reason.command})` : `a Windows program (${reason.command})`
    case "windows_shell":
      return ko ? `Windows 셸(${reason.command})` : `a Windows shell (${reason.command})`
    case "windows_resource":
      return ko
        ? `Windows나 이 PC의 화면을 다루는 서버(${reason.name})`
        : `drives Windows or this PC's desktop (${reason.name})`
    case "script":
      return ko ? `이 PC의 스크립트를 실행(${reason.path})` : `runs a script of this PC (${reason.path})`
    case "python_module":
      return ko
        ? `파이썬 모듈 ${reason.module}이 호스트에 있어야 함`
        : `needs the Python module ${reason.module} on the host`
    case "uv_project":
      return ko ? "이 PC의 uv 프로젝트를 실행" : "runs a uv project of this PC"
    case "binary":
      if (reason.found === true)
        return ko ? `호스트 PATH에 ${reason.command} 있음` : `${reason.command} is on the host's PATH`
      return ko ? `호스트 PATH에 ${reason.command} 없음` : `${reason.command} is not on the host's PATH`
    case "runtime_missing":
      return ko ? `호스트에 ${reason.runtime} 없음` : `the host has no ${reason.runtime}`
    case "container_denied":
      return ko ? `${reason.runtime}를 sudo 없이 쓸 수 없음` : `${reason.runtime} is not usable without sudo`
    case "own_bun":
      return ko ? "호스트의 own 서비스 프로그램을 bun으로 씀" : "uses the host's own service program as bun"
    case "host_value":
      return ko
        ? `인자 ${list(reason.args)}번은 이 PC의 경로나 주소라 호스트 값이 필요함`
        : `argument(s) ${list(reason.args)} are paths or addresses of this PC and need a host value`
    case "cwd_host_value":
      return ko
        ? "작업 폴더가 이 PC의 경로라 호스트 값이 필요함"
        : "its working folder is a path of this PC and needs a host value"
    case "mapped":
      return ko
        ? `인자 ${list(reason.args)}번은 호스트의 홈·프로젝트 경로로 바꿈`
        : `argument(s) ${list(reason.args)} map to the host's home or project`
    case "values":
      return ko
        ? `값 ${reason.names.length}개(${reason.names.join(", ")})`
        : `${reason.names.length} value(s) (${reason.names.join(", ")})`
    case "unwrapped":
      return ko
        ? `\`${reason.shell} /c\`를 벗기고 그 안의 명령을 씀`
        : `\`${reason.shell} /c\` removed, its command used`
    case "no_probe":
      return ko ? "호스트를 아직 확인하지 않음" : "the host was not checked yet"
    case "unknown_command":
      return ko ? `알 수 없는 명령(${reason.command})` : `an unknown command (${reason.command})`
  }
}

export function brief(input: BriefInput): string {
  const ko = input.locale === "ko"
  const analysis = input.analysis
  const transport = input.source.transport
  const values = analysis.values.map((value) =>
    value.secret
      ? ko
        ? `${value.name} (비밀)`
        : `${value.name} (secret)`
      : ko
        ? `${value.name} (비밀 아님: 이 호스트에 맞게 정해도 됨)`
        : `${value.name} (not a secret: may be set for this host)`,
  )
  const secrets = analysis.values.some((value) => value.secret)
  const probe = input.probe
  const runtimes = probe
    ? Object.entries(probe.runtimes)
        .map(([name, found]) => `${name}${found?.version ? ` (${found.version})` : ""}`)
        .join(", ") || (ko ? "없음" : "none")
    : undefined
  const pkg = analysis.package
    ? `${analysis.package.registry} ${analysis.package.name}${analysis.package.version ? ` ${analysis.package.version}` : ""}`
    : undefined
  const cwd = transport.type === "local" ? transport.cwd : undefined
  const lines = ko
    ? [
        `[MCP 서버 설치] 이 PC의 MCP 서버 \`${input.source.name}\`를 이 SSH 호스트(${input.host})에서 쓸 수 있게 설치해 주세요.`,
        "",
        "## 서버 정의 (이 PC, 값은 가림)",
        `- 종류: ${transport.type === "local" ? "명령(stdio)" : "원격 주소(HTTP)"}`,
        `- 명령: \`${input.shown}\``,
        ...(cwd ? [`- 작업 폴더: \`${cwd}\``] : []),
        `- 값: ${values.length > 0 ? values.join(", ") : "없음"}. 값은 이 대화에 없어요.${secrets ? " 비밀 값은 사용자가 PC에서 따로 보내야 서버가 켜져요." : ""}`,
        "",
        "## 분석",
        `- 결과: ${RESULT_TEXT.ko[analysis.result]}`,
        `- 필요한 런타임: ${analysis.runtime}${pkg ? `, 패키지: ${pkg}` : ""}`,
        ...analysis.reasons.map((reason) => `- ${reasonText(reason, "ko")}`),
        "",
        "## 호스트 확인 결과",
        ...(probe
          ? [`- ${probe.os} ${probe.arch}, 홈 \`${probe.home}\``, `- 런타임: ${runtimes}`]
          : ["- 아직 확인하지 않았어요. 필요하면 직접 확인해 주세요(읽기만)."]),
        ...(probe?.ownBun
          ? [`- own 서비스 프로그램을 bun으로 쓸 수 있음: \`BUN_BE_BUN=1 ${probe.ownBun.command}\``]
          : []),
        "",
        "## 할 일",
        "1. 필요한 것을 사용자 공간에만 설치해요(sudo 없이). 예: uv는 `~/.local/bin`, npm 전역 설치는 `--prefix ~/.local`.",
        `2. 동작하는 명령이 정해지면 \`${input.tool}\` 도구로 등록해요(command, args, cwd, fixed). 이 도구가 호스트의 own MCP 설정에 쓰고 연결 시험을 돌려요. 셸로 설정 파일을 직접 고치지 않아요.`,
        "   - 비밀이 아닌 값(예: 상태·캐시 폴더, 모드)은 이 호스트에 맞는 값으로 `fixed`에 넣어요. 그 값은 PC에서 보낼 필요가 없어져요(PC의 값은 이 PC의 경로라 호스트에서 맞지 않아요).",
        "   - 비밀 값은 `fixed`나 명령에 넣지 않아요. PC에서 보내기 전에는 서버가 꺼져 있고 연결 시험도 돌지 않아요.",
        "3. 연결 시험 결과를 확인하고, 마지막 줄에 결과를 한 줄로 적어요: `결과: 설치됨 — …` 또는 `결과: 못 함 — 이유`. 비밀 값을 아직 보내지 않아 시험이 돌지 않았으면 그렇다고 적어요.",
        "",
        "## 하지 말 것",
        "- 시스템 패키지 설치(apt, dnf, yum, brew 등)와 sudo는 먼저 묻지 않고 하지 않아요.",
        "- 비밀 값을 명령이나 파일에 넣지 않아요(값은 PC에서 따로 와요).",
        "- 홈 폴더 밖은 고치지 않아요.",
        "- 이 PC 전용(Windows) 부분은 흉내 내지 말고 못 한다고 알려 줘요.",
      ]
    : [
        `[Install an MCP server] Please set up this PC's MCP server \`${input.source.name}\` so it runs on this SSH host (${input.host}).`,
        "",
        "## Definition (this PC, values masked)",
        `- Kind: ${transport.type === "local" ? "command (stdio)" : "remote address (HTTP)"}`,
        `- Command: \`${input.shown}\``,
        ...(cwd ? [`- Working folder: \`${cwd}\``] : []),
        `- Values: ${values.length > 0 ? values.join(", ") : "none"}. They are not in this conversation.${secrets ? " The user sends the secret ones from the PC, and the server stays off until then." : ""}`,
        "",
        "## Analysis",
        `- Result: ${RESULT_TEXT.en[analysis.result]}`,
        `- Runtime: ${analysis.runtime}${pkg ? `, package: ${pkg}` : ""}`,
        ...analysis.reasons.map((reason) => `- ${reasonText(reason, "en")}`),
        "",
        "## Host check",
        ...(probe
          ? [`- ${probe.os} ${probe.arch}, home \`${probe.home}\``, `- Runtimes: ${runtimes}`]
          : ["- Not checked yet. Check what you need yourself (read only)."]),
        ...(probe?.ownBun ? [`- The own service program runs as bun: \`BUN_BE_BUN=1 ${probe.ownBun.command}\``] : []),
        "",
        "## Goal",
        "1. Install what is needed in user space only (no sudo), e.g. uv in `~/.local/bin`, global npm installs with `--prefix ~/.local`.",
        `2. Once a command works, register it with the \`${input.tool}\` tool (command, args, cwd, fixed). The tool writes the host's own MCP settings and runs the connection test. Do not edit settings files from the shell.`,
        "   - Set the values that are not secrets (e.g. a state or cache folder, a mode) in `fixed` with what fits this host. The PC then need not send them (the PC's value is a path or setting of the PC, which does not fit the host).",
        "   - Never put a secret value into `fixed` or a command. Until the PC sends it the server stays off and the connection test does not run.",
        "3. Check the connection test and end with one line: `Result: installed — …` or `Result: not done — reason`. If the test did not run because a secret value was not sent yet, say so.",
        "",
        "## Do not",
        "- Install system packages (apt, dnf, yum, brew …) or use sudo without asking first.",
        "- Put secret values into commands or files (they come from the PC separately).",
        "- Change anything outside the user's home folder.",
        "- Imitate parts that only run on this PC (Windows); say they cannot be done.",
      ]
  return lines.join("\n")
}

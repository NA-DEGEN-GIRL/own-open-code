// Pure view logic of 설정 > MCP 서버 `SSH 호스트에서 쓰기` (04 §13 "MCP", 03 §18.14, MH 2026-11-26): every MCP server
// this PC knows (own's, imported ones included, and the config files' of the page's project, disabled ones too) as
// `McpHostRules.Source`, its analysis against one host's probe, and the row state per host: installed (the host's
// server came from this PC's key), `PC와 다름` (the PC's definition or own's values changed since), or what installing
// would take. An installed row reads the host's own definition, not this PC's analysis: one state of what the host
// runs ({@link live}), each value where it comes from ({@link hostValues}) and only the reasons that still hold
// ({@link reasonsOf}). No Solid, no DOM; unit-tested in hosts.test.ts. The rules are own-protocol's `McpHostRules`.
import type { ConfigEntry } from "@opencode/client"
import type { OwnMcp } from "@own/protocol"
import { McpHostRules } from "@own/protocol/mcp-host-rules"
import { address, maskAddress, maskArgs } from "@own/protocol/mcp-secrets"

type Rules = typeof McpHostRules
export type Source = McpHostRules.Source
export type Analysis = McpHostRules.Analysis
export type Probe = McpHostRules.Probe

/** `mcp.host.view`'s server (own-protocol `McpHost.Server`), written out so this chunk needs no schema. */
export interface HostServer {
  readonly id: string
  readonly name: string
  readonly transport: McpHostRules.HostTransport
  readonly pc?: { readonly key: string; readonly hash: string; readonly at: number }
  readonly values: "none" | "ready" | "missing"
  readonly check?: OwnMcp.Check
  readonly createdAt: number
  readonly updatedAt: number
}

export interface HostView {
  readonly servers: ReadonlyArray<HostServer>
  readonly home: string
  /** The host's own list of them (`<OWN_HOME>/mcp.json` there); an older host leaves it out. */
  readonly file?: string
}

/** `mcp.hosts.view`'s record. */
export interface Send {
  readonly hostId: string
  readonly server: string
  readonly names: ReadonlyArray<string>
  readonly source: { readonly type: "own"; readonly id: string } | { readonly type: "file"; readonly name: string }
  readonly at: number
  readonly differs?: boolean
}

/** What the page knows of one host now. */
export type HostData =
  /** Not connected: only what needs no probe is known. */
  | { readonly status: "offline" }
  | { readonly status: "loading" }
  /** The host's service is older than `mcp.host.*` (`rpc.method_not_found`): it needs the update first. */
  | { readonly status: "old" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly view: HostView; readonly probe?: Probe }

export type RowState =
  | "installed"
  | "differs"
  | "ready"
  | "prepare"
  | "assist"
  | "pc-only"
  | "unknown"
  | "old"
  | "offline"

export interface Row {
  readonly source: Source
  readonly analysis: Analysis
  readonly state: RowState
  /** The host's server installed from this source. */
  readonly installed?: HostServer
  /** What the user sent to that server. */
  readonly send?: Send
  /** Why `differs`: the PC's definition, own's values, or both. */
  readonly changed?: { readonly definition: boolean; readonly values: boolean }
}

/** own's server (`mcp.list`) as a source: names of values only. */
export function ownSource(server: OwnMcp.Server): Source {
  const transport = server.transport
  return {
    key: `own:${server.id}`,
    name: server.name,
    origin: "own",
    transport:
      transport.type === "local"
        ? {
            type: "local",
            command: transport.command,
            args: transport.args,
            ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
            env: transport.env.map((item) => item.name),
            ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
          }
        : {
            type: "remote",
            url: transport.url,
            query: transport.query,
            ...(transport.hidden ? { hidden: true } : {}),
            headers: transport.headers.map((item) => item.name),
            oauth: transport.oauth,
            ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
          },
  }
}

type ServerConfig = NonNullable<
  NonNullable<Extract<ConfigEntry, { type: "document" }>["info"]["mcp"]>["servers"]
>[string]

/**
 * The config documents' servers (a later file's of the same name wins) as sources, except those own's list replaces
 * (own's server of the same name runs in their place).
 */
export function fileSources(entries: ReadonlyArray<ConfigEntry>, own: ReadonlyArray<{ readonly name: string }>): Source[] {
  const found = new Map<string, ServerConfig>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [name, server] of Object.entries(entry.info.mcp?.servers ?? {})) found.set(name, server)
  }
  const taken = new Set(own.map((item) => item.name.toLowerCase()))
  return [...found].flatMap(([name, server]): Source[] => {
    if (taken.has(name.toLowerCase())) return []
    const disabled = server.disabled === true ? { disabled: true } : {}
    if (server.type === "local")
      return [
        {
          key: `file:${name}`,
          name,
          origin: "file",
          ...disabled,
          transport: {
            type: "local",
            command: server.command[0] ?? "",
            args: server.command.slice(1),
            ...(server.cwd ? { cwd: server.cwd } : {}),
            env: Object.keys(server.environment ?? {}),
          },
        },
      ]
    const parts = URL.canParse(server.url) ? address(server.url) : undefined
    return [
      {
        key: `file:${name}`,
        name,
        origin: "file",
        ...disabled,
        transport: {
          type: "remote",
          url: parts?.shown ?? server.url,
          query: (parts?.search ?? "") !== "",
          ...(parts?.hidden ? { hidden: true } : {}),
          headers: Object.keys(server.headers ?? {}),
          oauth: server.oauth !== false,
        },
      },
    ]
  })
}

/** The definition as a page may show it (values as `${NAME}` or `••••`). */
export function shown(source: Source) {
  const transport = source.transport
  if (transport.type === "remote") return `${maskAddress(transport.url)}${transport.query ? "?…" : ""}`
  return [transport.command, ...maskArgs(transport.command, transport.args)]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ")
}

/** Every source's analysis and state on one host. */
export function rows(
  sources: ReadonlyArray<Source>,
  host: HostData,
  sends: ReadonlyArray<Send>,
  context: { readonly home: string; readonly project?: string; readonly hostId: string },
  rules: Rules = McpHostRules,
): Row[] {
  const probe = host.status === "ready" ? host.probe : undefined
  const servers = host.status === "ready" ? host.view.servers : []
  return sources.map((source) => {
    const analysis = rules.analyze(source, {
      home: context.home,
      ...(context.project === undefined ? {} : { project: context.project }),
      ...(probe ? { probe } : {}),
    })
    const installed = servers.find((server) => server.pc?.key === source.key)
    const send = installed ? sends.find((item) => item.hostId === context.hostId && item.server === installed.id) : undefined
    if (installed) {
      const definition = installed.pc?.hash !== rules.hash(source)
      const values = send?.differs === true
      return {
        source,
        analysis,
        installed,
        ...(send ? { send } : {}),
        state: definition || values ? "differs" : "installed",
        ...(definition || values ? { changed: { definition, values } } : {}),
      }
    }
    if (analysis.result === "pc-only") return { source, analysis, state: "pc-only" }
    if (host.status === "old") return { source, analysis, state: "old" }
    if (host.status !== "ready") return { source, analysis, state: "offline" }
    return { source, analysis, state: analysis.result }
  })
}

/** The host's servers from this PC whose source is gone here (removed or renamed away): `PC에 없음`. */
export function orphans(sources: ReadonlyArray<Source>, host: HostData): HostServer[] {
  if (host.status !== "ready") return []
  const keys = new Set(sources.map((source) => source.key))
  return host.view.servers.filter((server) => server.pc !== undefined && !keys.has(server.pc.key))
}

export const STATE_ORDER: ReadonlyArray<RowState> = [
  "installed",
  "differs",
  "ready",
  "prepare",
  "assist",
  "pc-only",
  "unknown",
  "old",
  "offline",
]

/** How many rows are in each state (zeros left out), in {@link STATE_ORDER}. */
export function summary(list: ReadonlyArray<Row>) {
  return STATE_ORDER.flatMap((state) => {
    const count = list.filter((row) => row.state === state).length
    return count > 0 ? [{ state, count }] : []
  })
}

/** The arguments (and the folder) the user must give a host value for before it installs directly. */
export function hostInputs(analysis: Analysis) {
  return {
    args: analysis.args.flatMap((arg, index) => (arg.kind === "host" ? [{ index, text: arg.text }] : [])),
    cwd: analysis.cwd?.kind === "host" ? analysis.cwd.text : undefined,
  }
}

/**
 * Whether the row installs without the AI: `ready`, an update of an installed one, or `assist` only for host values
 * the user filled in (`fills` by argument index, `cwd`) and nothing else that needs the AI.
 */
export function direct(row: Row, fills: Readonly<Record<number, string>> = {}, cwd?: string) {
  if (row.state === "installed" || row.state === "differs" || row.state === "ready") return true
  if (row.state !== "assist") return false
  const only = row.analysis.reasons.every((reason) =>
    ["host_value", "cwd_host_value", "mapped", "values", "unwrapped", "remote_url", "oauth", "own_bun"].includes(
      reason.code,
    ),
  )
  if (!only) return false
  const inputs = hostInputs(row.analysis)
  return (
    inputs.args.every((item) => (fills[item.index] ?? "").trim() !== "") &&
    (inputs.cwd === undefined || (cwd ?? "").trim() !== "")
  )
}

/** The value names a send step offers (env, header, the address's `URL`), each with whether it looks secret. */
export function values(analysis: Analysis) {
  return analysis.values
}

/**
 * The host's install conversation's job (own-protocol `McpHost.Job`) for a local source: its value names, and the ones
 * the analysis takes for secrets (only those must come from the PC; the AI may set the others for the host).
 */
export function job(source: Source, analysis: Analysis, rules: Rules = McpHostRules) {
  if (source.transport.type !== "local") return undefined
  const secrets = analysis.values.flatMap((value) => (value.kind === "env" && value.secret ? [value.name] : []))
  return {
    key: source.key,
    hash: rules.hash(source),
    name: source.name,
    env: [...source.transport.env],
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(source.transport.codemode === undefined ? {} : { codemode: source.transport.codemode }),
  }
}

/** The start intent (`composer/start-intent.ts`) of `AI에게 설치 맡기기`: the brief, the job, the tool's allow. */
export function assistIntent(serverKey: string, row: Pick<Row, "source" | "analysis">, brief: string) {
  const work = job(row.source, row.analysis)
  if (!work) return undefined
  return {
    serverKey,
    text: brief,
    metadata: { own: { mcpInstall: work } },
    permissions: [{ action: McpHostRules.TOOL, resource: "*", effect: "allow" as const }],
  }
}

/** Where one value of an installed server comes from on its host. */
export type HostValue =
  | { readonly name: string; readonly secret: boolean; readonly from: "host"; readonly value: string }
  | { readonly name: string; readonly secret: boolean; readonly from: "pc"; readonly sent: boolean }

/**
 * The values of a row as its host has them: set on the host (a name in the host's `fixed` that it does not wait for,
 * shown with its value: never a secret), or from this PC (sent or not). Before an install, every value is from the PC.
 */
export function hostValues(row: Row): HostValue[] {
  const transport = row.installed?.transport
  const local = transport?.type === "local" ? transport : undefined
  return row.analysis.values.map((value): HostValue => {
    const own = local?.fixed?.[value.name]
    if (local && own !== undefined && !local.env.includes(value.name))
      return { name: value.name, secret: value.secret, from: "host", value: own }
    return { name: value.name, secret: value.secret, from: "pc", sent: row.send?.names.includes(value.name) ?? false }
  })
}

/**
 * The one state of what an installed row's host runs, from the host's definition and its last test: `off` while values
 * the host waits for from the PC have not come (the host keeps the server off, and a test then starts nothing, so an
 * older result says nothing), else the last test's result, else untested.
 */
export type Live =
  | { readonly kind: "off"; readonly waiting: ReadonlyArray<string> }
  | { readonly kind: "connected"; readonly tools: number }
  | { readonly kind: "failed"; readonly check: OwnMcp.Check }
  | { readonly kind: "untested" }

export function live(row: Row): Live | undefined {
  const server = row.installed
  if (!server) return undefined
  if (server.values === "missing")
    return {
      kind: "off",
      waiting: hostValues(row).flatMap((value) => (value.from === "pc" && !value.sent ? [value.name] : [])),
    }
  const check = server.check
  if (!check) return { kind: "untested" }
  return check.ok ? { kind: "connected", tools: check.tools.length } : { kind: "failed", check }
}

/**
 * The reasons a row shows. Before an install, all of the analysis; once installed, the host runs its own command, so
 * what this PC's definition would need on a host (its paths, its script, its runtime, its values) no longer applies:
 * only what the server itself is (an address, a sign-in).
 */
export function reasonsOf(row: Row): ReadonlyArray<McpHostRules.Reason> {
  if (!row.installed) return row.analysis.reasons
  return row.analysis.reasons.filter((reason) => reason.code === "remote_url" || reason.code === "oauth")
}

/** The host's command line of an installed server (no value: the host stores none). */
export function hostShown(server: HostServer) {
  const transport = server.transport
  if (transport.type === "remote") return `${maskAddress(transport.url)}${transport.query ? "?…" : ""}`
  return [transport.command, ...transport.args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ")
}

/**
 * A row's next step: install what installs by itself, update an installed one whose PC definition changed when that
 * definition still installs by itself, and the AI for the rest of the command servers: what needs setup or help, an
 * update of what the AI set up (its host command is not this PC's translation), and an installed server that stays off
 * only for values that are not secrets (the PC's copy would be this PC's path; the AI sets them for the host).
 */
export function nextStep(row: Row): "install" | "update" | "assist" | undefined {
  if (row.state === "ready") return "install"
  if (row.state === "differs" && row.analysis.result === "ready") return "update"
  if (row.source.transport.type !== "local") return undefined
  if (row.state === "prepare" || row.state === "assist" || row.state === "unknown") return "assist"
  // Only the values changed: sending them again (the values step) is the update.
  if (row.state === "differs") return row.changed?.definition ? "assist" : undefined
  const state = live(row)
  if (state?.kind !== "off") return undefined
  const waiting = hostValues(row).filter((value) => state.waiting.includes(value.name))
  return waiting.length > 0 && waiting.every((value) => !value.secret) ? "assist" : undefined
}

/** An update keeps the values the host set for itself (they are not this PC's to replace). */
export function keepHostValues(transport: McpHostRules.HostTransport, row: Row): McpHostRules.HostTransport {
  const own = hostValues(row).flatMap((value) => (value.from === "host" ? [[value.name, value.value] as const] : []))
  if (transport.type !== "local" || own.length === 0) return transport
  const names = own.map((item) => item[0])
  return {
    ...transport,
    env: transport.env.filter((name) => !names.includes(name)),
    fixed: { ...transport.fixed, ...Object.fromEntries(own) },
  }
}

/** A name for a host conversation's dismissal: the set of servers the host lacks (changes when that set changes). */
export function missingKey(list: ReadonlyArray<Row>) {
  return list
    .filter((row) => row.state === "ready")
    .map((row) => row.source.key)
    .toSorted()
    .join("|")
}

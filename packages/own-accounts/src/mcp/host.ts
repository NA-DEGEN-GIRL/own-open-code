export * as McpHostService from "./host.js"

import os from "node:os"
import { McpHost, McpHostRules, McpRules, OwnMcp } from "@own/protocol"
import { ProcessTree, Store } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { RemoteHost } from "../remote/host.js"
import { McpProbe } from "./probe.js"
import type { McpServers } from "./register.js"
import { McpService } from "./service.js"
import { McpStore } from "./store.js"

/**
 * An SSH host's own MCP servers installed from the PC (04 §13 "MCP", MH 2026-11-26): `mcp.host.*` of a remote
 * service's own.accounts. The host keeps them in its `<OWN_HOME>/mcp.json` (the same file shape as the PC's list, every
 * server `global`, each with the PC's key and definition hash it was installed from) and folds them into every
 * Location like the PC does ({@link source} for `McpServers.register`). No value is stored here: a server that needs
 * values gets the ones the user sent from the PC over the broker (`mcp.values`), into this process's memory; until
 * then it stays off. The probe reads what the service's own environment has (the one MCP servers start in), never
 * with sudo; the pre-fetch fetches into the user's caches only (`npm exec`, `uv tool install`).
 */

const PROBE_TTL_MS = 30_000
const VERSION_TIMEOUT_MS = 6_000
const PREFETCH_TAIL = 1_500

/** One store per file and process: the control Location's methods and the install tool share its mutex. */
const stores = new Map<string, Store.JsonFile<typeof McpStore.File>>()

export function file(deps: Pick<Deps, "runtime">) {
  const known = stores.get(deps.runtime.layout.mcp)
  if (known) return known
  const created = McpStore.file(deps)
  stores.set(deps.runtime.layout.mcp, created)
  return created
}

/** The fold's values on a host: none for a server that needs none, else what the PC sent, else off. */
export function source(mcp: RemoteHost.Mcp): McpServers.Source {
  return {
    values: async (entry) => resolve(mcp, entry, false),
    on: (listener) => mcp.on(listener),
    retry: false,
  }
}

async function resolve(mcp: RemoteHost.Mcp, entry: McpStore.Entry, wait: boolean) {
  if (!McpStore.holds(entry)) return McpStore.NO_VALUES
  const sent = await mcp.values(entry.id, { wait })
  if (!sent?.sent) return undefined
  const values: McpStore.Values = {
    env: sent.env,
    headers: sent.headers,
    ...(sent.search === undefined ? {} : { search: sent.search }),
    ...(sent.url === undefined ? {} : { url: sent.url }),
  }
  return values
}

type Answer<T> = McpService.Answer<T>

export function create(deps: Deps, mcp: RemoteHost.Mcp) {
  const store = file(deps)
  const log = deps.log.child("mcp-host")
  const now = () => deps.clock.now()
  const cache: { probe?: { readonly at: number; readonly key: string; readonly value: McpHost.Probe } } = {}
  const fail = (type: string, message: string, data: object = {}): Answer<never> => ({
    ok: false,
    error: { type: type as never, message, data },
  })

  async function view(): Promise<McpHost.View> {
    const read = await store.read()
    const servers = await Promise.all(
      read.servers.map(async (entry): Promise<McpHost.Server> => {
        const state: McpHost.ValuesState = !McpStore.holds(entry)
          ? "none"
          : (await mcp.values(entry.id, { wait: false }))?.sent
            ? "ready"
            : "missing"
        return {
          id: entry.id,
          name: entry.name,
          transport: hostTransport(entry.transport),
          ...(entry.pc ? { pc: entry.pc } : {}),
          values: state,
          ...(entry.check ? { check: entry.check } : {}),
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }
      }),
    )
    return { servers, home: os.homedir() }
  }

  async function probe(input: McpHost.ProbeInput = {}): Promise<McpHost.Probe> {
    const names = [...new Set(input.binaries ?? [])].toSorted()
    const key = names.join("\n")
    const known = cache.probe
    if (known && known.key === key && now() - known.at < PROBE_TTL_MS) return known.value
    const value = await detect(names, now())
    cache.probe = { at: now(), key, value }
    log.info("mcp_host_probed", {
      runtimes: Object.keys(value.runtimes),
      docker: value.containers?.docker,
      ownBun: value.ownBun !== undefined,
    })
    return value
  }

  async function save(input: McpHost.SaveInput): Promise<Answer<McpHost.View>> {
    const read = await store.read()
    const existing = input.id === undefined ? undefined : read.servers.find((entry) => entry.id === input.id)
    if (input.id !== undefined && existing === undefined)
      return fail("mcp_not_found", "no such server", { id: input.id })
    const lower = input.name.toLowerCase()
    if (read.servers.some((entry) => entry.id !== input.id && entry.name.toLowerCase() === lower))
      return fail("mcp_name_taken", "another server has this name here", { name: input.name })
    const transport = absolute(input.transport, os.homedir())
    if (transport.type === "remote" && !/^https?:\/\//i.test(transport.url))
      return fail("mcp_invalid", "not an http(s) address", { field: "url" })
    if (transport.type === "local") {
      const unknown = [transport.command, ...transport.args]
        .flatMap(McpRules.references)
        .find((name) => !transport.env.includes(name))
      if (unknown !== undefined) return fail("mcp_invalid", "a reference names no environment value", { field: "args" })
    }
    const at = now()
    const entry: McpStore.Entry = {
      id: existing?.id ?? OwnMcp.ID.create(),
      name: input.name,
      scope: { type: "global" },
      transport,
      ...(input.pc ? { pc: input.pc } : existing?.pc ? { pc: existing.pc } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
    await store.update((current) => ({
      ...current,
      servers: [...current.servers.filter((item) => item.id !== entry.id), entry],
    }))
    log.info("mcp_host_saved", { id: entry.id, name: entry.name, type: transport.type, new: !existing, pc: !!entry.pc })
    changed()
    return { ok: true, value: await view() }
  }

  async function remove(id: OwnMcp.ID): Promise<Answer<McpHost.View>> {
    const read = await store.read()
    if (!read.servers.some((entry) => entry.id === id)) return fail("mcp_not_found", "no such server", { id })
    await store.update((current) => ({
      ...current,
      servers: current.servers.filter((item) => item.id !== id),
    }))
    log.info("mcp_host_removed", { id })
    changed()
    return { ok: true, value: await view() }
  }

  /** The connection test here, with the values the PC sent (none sent: it runs without them and may fail). */
  async function test(id: OwnMcp.ID): Promise<Answer<OwnMcp.Check>> {
    const entry = (await store.read()).servers.find((item) => item.id === id)
    if (!entry) return fail("mcp_not_found", "no such server", { id })
    const values = (await resolve(mcp, entry, true)) ?? McpStore.NO_VALUES
    const transport = entry.transport
    const target: McpProbe.Target =
      transport.type === "local"
        ? {
            type: "local",
            command: McpRules.expand(transport.command, values.env),
            args: transport.args.map((arg) => McpRules.expand(arg, values.env)),
            cwd: McpProbe.workingFolder(transport.cwd, os.homedir()),
            env: { ...transport.fixed, ...values.env },
          }
        : {
            type: "remote",
            url:
              (transport.hidden ? (values.url ?? transport.url) : transport.url) +
              (transport.query ? (values.search ?? "") : ""),
            headers: values.headers,
          }
    const check = await McpProbe.probe(target, { now, secrets: McpService.secretsOf(transport, values) })
    log.info("mcp_host_tested", {
      id,
      name: entry.name,
      ok: check.ok,
      tools: check.tools.length,
      ...(check.failure ? { failure: check.failure } : {}),
    })
    await store.update((current) => ({
      ...current,
      servers: current.servers.map((item) => (item.id === id ? { ...item, check } : item)),
    }))
    changed()
    return { ok: true, value: check }
  }

  /** Fetches the server's package into the user's caches: npm's for npx, uv's tools for uvx. Never sudo. */
  async function prefetch(id: OwnMcp.ID): Promise<Answer<McpHost.Prefetch>> {
    const entry = (await store.read()).servers.find((item) => item.id === id)
    if (!entry) return fail("mcp_not_found", "no such server", { id })
    const plan = prefetchPlan(entry.transport)
    if (plan === undefined) return { ok: true, value: { ok: true, kind: "none" } }
    const values = (await resolve(mcp, entry, false)) ?? McpStore.NO_VALUES
    const result = await run(plan.argv, McpHost.PREFETCH_TIMEOUT_MS)
    const output = McpProbe.mask(result.output.trim(), McpService.secretsOf(entry.transport, values)).slice(
      -PREFETCH_TAIL,
    )
    log.info("mcp_host_prefetched", { id, kind: plan.kind, ok: result.ok })
    return { ok: true, value: { ok: result.ok, kind: plan.kind, ...(output ? { output } : {}) } }
  }

  function changed() {
    deps.runtime.broadcast.emit("mcp.changed", {})
    void deps.emitter.global("mcp.changed", {})
  }

  return { view, probe, save, remove, test, prefetch, changed }
}

export type Service = ReturnType<typeof create>

/** The answer's form of a host's server: names of values only, fixed plain variables as they are. */
function hostTransport(transport: McpStore.Entry["transport"]): McpHost.Transport {
  if (transport.type === "local")
    return {
      type: "local",
      command: transport.command,
      args: transport.args,
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      env: transport.env,
      ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
      ...(transport.fixed === undefined ? {} : { fixed: transport.fixed }),
    }
  return {
    type: "remote",
    url: transport.url,
    query: transport.query,
    ...(transport.hidden ? { hidden: true } : {}),
    headers: transport.headers,
    oauth: transport.oauth,
    ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
  }
}

/** `~` and `~/…` in the command, arguments and folder as this host's absolute paths. */
export function absolute(transport: McpHost.Transport, home: string): McpStore.Entry["transport"] {
  if (transport.type === "remote")
    return {
      type: "remote",
      url: transport.url,
      query: transport.query,
      ...(transport.hidden ? { hidden: true } : {}),
      headers: [...transport.headers],
      oauth: transport.oauth,
      ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
    }
  const fix = (text: string) => McpHostRules.hostPath(text, home)
  return {
    type: "local",
    command: fix(transport.command),
    args: transport.args.map(fix),
    ...(transport.cwd === undefined ? {} : { cwd: fix(transport.cwd) }),
    env: [...transport.env],
    ...(transport.codemode === undefined ? {} : { codemode: transport.codemode }),
    ...(transport.fixed === undefined ? {} : { fixed: { ...transport.fixed } }),
  }
}

/** What a pre-fetch runs for a server: npm's cache for an npx package, a uv tool for a uvx one, else nothing. */
export function prefetchPlan(
  transport: McpStore.Entry["transport"],
): { readonly kind: "npm" | "uv"; readonly argv: ReadonlyArray<string> } | undefined {
  if (transport.type !== "local") return undefined
  const program = McpHostRules.programName(transport.command)
  const identity = McpHostRules.packageOf(program, transport.args)
  if (identity === undefined) return undefined
  const spec = identity.version ? `${identity.name}@${identity.version}` : identity.name
  if (program === "npx" && identity.registry === "npm")
    return { kind: "npm", argv: ["npm", "exec", "--yes", `--package=${spec}`, "--", "true"] }
  if ((program === "uvx" || program === "uv") && identity.registry === "pypi")
    return {
      kind: "uv",
      argv: ["uv", "tool", "install", identity.version ? `${identity.name}==${identity.version}` : identity.name],
    }
  return undefined
}

/**
 * What this host has, read in the service's own environment (the one MCP servers start in): OS, architecture, home,
 * each runtime on PATH with its `--version` line, whether docker and podman reach their daemon without sudo, the named
 * programs, and whether the service's own program runs as bun (`BUN_BE_BUN=1`).
 */
async function detect(binaries: ReadonlyArray<string>, at: number): Promise<McpHost.Probe> {
  const which = (name: string) => Bun.which(name) ?? undefined
  const commands: Record<McpHostRules.RuntimeName, ReadonlyArray<string>> = {
    node: ["node"],
    npx: ["npx"],
    uv: ["uv"],
    uvx: ["uvx"],
    python: ["python3", "python"],
    pipx: ["pipx"],
    docker: ["docker"],
    podman: ["podman"],
    bun: ["bun"],
    deno: ["deno"],
  }
  const found = await Promise.all(
    McpHostRules.RUNTIMES.map(async (runtime) => {
      const program = commands[runtime].map(which).find((item) => item !== undefined)
      if (program === undefined) return undefined
      const version = await versionOf([program, "--version"])
      return [runtime, version === undefined ? {} : { version }] as const
    }),
  )
  const runtimes = Object.fromEntries(found.filter((item) => item !== undefined))
  const access = async (runtime: "docker" | "podman") =>
    runtimes[runtime] === undefined
      ? undefined
      : (await run([which(runtime)!, "info", "--format", "{{.ServerVersion}}"], VERSION_TIMEOUT_MS)).ok
        ? ("ok" as const)
        : ("denied" as const)
  const [docker, podman] = await Promise.all([access("docker"), access("podman")])
  const own = await versionOf([process.execPath, "--version"], { BUN_BE_BUN: "1" })
  return {
    at,
    os: os.platform() === "linux" ? `linux ${os.release()}` : `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    home: os.homedir(),
    runtimes,
    ...(docker || podman ? { containers: { ...(docker ? { docker } : {}), ...(podman ? { podman } : {}) } } : {}),
    binaries: Object.fromEntries(binaries.map((name) => [name, which(name) !== undefined])),
    ...(own === undefined ? {} : { ownBun: { command: process.execPath, version: own } }),
  }
}

async function versionOf(argv: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) {
  const result = await run(argv, VERSION_TIMEOUT_MS, env)
  if (!result.ok) return undefined
  return result.output
    .split(/\r?\n/)
    .find((line) => line.trim() !== "")
    ?.trim()
    .slice(0, 120)
}

/** Runs a program (no shell) with stdin closed; its exit and output, stopped with its whole tree after `timeoutMs`. */
async function run(argv: ReadonlyArray<string>, timeoutMs: number, env?: Readonly<Record<string, string>>) {
  const spawned = (() => {
    try {
      return Bun.spawn([...argv], {
        cwd: os.homedir(),
        env: { ...process.env, ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...ProcessTree.SPAWN,
      })
    } catch {
      return undefined
    }
  })()
  if (!spawned) return { ok: false, output: "" }
  const proc = spawned
  const timer = setTimeout(() => void ProcessTree.kill(proc), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
    proc.exited,
  ])
  clearTimeout(timer)
  return { ok: code === 0, output: `${stdout}${stderr ? `\n${stderr}` : ""}` }
}

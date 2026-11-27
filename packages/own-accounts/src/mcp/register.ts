export * as McpServers from "./register.js"

import path from "node:path"
import { parse } from "jsonc-parser"
import { Fsx } from "@own/runtime"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import { McpFold } from "./fold.js"
import { McpStore } from "./store.js"

/**
 * Registers own's `mcp.transform` on this Location (03 §18.14, SM) and keeps its snapshot: the servers own added with
 * their values, the list's kept switches and the global config's `mcp.timeout`. Core folds as soon as a transform is
 * registered, so `mcp.json` and the config are read first: a kept `off` switch holds a config file's server back from
 * its first start, and a server with stored values starts off until they are read. The values are read after
 * registering, not awaited (a process's first vault request starts the vault helper, and plugin setup must not wait
 * on it); once read, after every `mcp.changed`, and when a fold finds the global `mcp.timeout` changed, core folds the
 * MCP servers again (`ctx.mcp.reload()`, which leaves servers whose config did not change running). While the vault
 * gives a server no values, they are read again after {@link RETRY_MS} (doubling up to {@link RETRY_MAX_MS}; the
 * vault has no signal of its own when it answers again): the Location that finds them back folds and tells every
 * Location and open page (`mcp.changed`), so the page's missing-values notice and the running servers agree again.
 * An SSH host's service registers it too (04 §13 "MCP", MH) with its own {@link Source}: the servers installed from the
 * PC in the host's `mcp.json`, their values from the PC over the broker (memory only), read again when the PC comes
 * back or changes what it sent. The result stops the reloads.
 */
export const RETRY_MS = 1_000
export const RETRY_MAX_MS = 60_000

/** Where a Location's servers get their values. */
export interface Source {
  /** A server's values, or `undefined` while they cannot be had (the server stays off). */
  readonly values: (entry: McpStore.Entry) => Promise<McpStore.Values | undefined>
  /** Read again when this says so (a host: the PC came back, or changed what it sent). */
  readonly on?: (listener: () => void) => () => void
  /** Ask again with a growing wait while values are missing (this PC's vault); a host waits for {@link on}. */
  readonly retry: boolean
}

export async function register(deps: Deps, given?: Source) {
  const source: Source = given ?? { values: (entry) => McpStore.values(deps, entry), retry: true }
  const log = deps.log.child("mcp")
  const hook = Hooks.guard(log)
  const store = McpStore.file(deps)
  const [file, timeout] = await Promise.all([
    store.read().catch(() => McpStore.EMPTY),
    globalTimeout(deps.configDir),
  ])
  const state: {
    snapshot: McpFold.Snapshot
    read: number
    /** The next read again while values are missing, and how long it waits. */
    retry: { delay: number; cancel?: () => void }
    /** Names whose values were missing at the last read (logged once per change). */
    missing: string
    stopped: boolean
  } = {
    snapshot: {
      // Values come from the vault later; until then a server that stores some is off.
      servers: file.servers.map((entry) => ({ entry, values: McpStore.holds(entry) ? undefined : McpStore.NO_VALUES })),
      overrides: file.overrides,
      timeout,
    },
    read: 0,
    retry: { delay: RETRY_MS },
    missing: "",
    stopped: false,
  }
  const reload = () => void deps.ctx.mcp.reload().catch((error: unknown) => log.error("mcp_reload_failed", { error }))
  // Core reloads on a config change too: a changed `mcp.timeout` is read then and folded once more.
  const recheck = async () => {
    const next = await globalTimeout(deps.configDir)
    if (JSON.stringify(next) === JSON.stringify(state.snapshot.timeout)) return
    state.snapshot = { ...state.snapshot, timeout: next }
    reload()
  }
  await deps.ctx.mcp.transform((editor) =>
    hook.sync("mcp.transform", () => {
      McpFold.fold(editor, state.snapshot, deps.location)
      void recheck().catch((error: unknown) => log.error("mcp_config_read_failed", { error }))
    }),
  )
  const refresh = async (cause: "change" | "retry") => {
    const current = ++state.read
    state.retry.cancel?.()
    state.retry.cancel = undefined
    const read = await store.read()
    const servers = await Promise.all(
      read.servers.map(async (entry) => ({ entry, values: await source.values(entry) })),
    )
    // A newer read started meanwhile, or the Location went: that one folds, or none.
    if (current !== state.read || state.stopped) return
    const before = state.snapshot
    state.snapshot = { servers, overrides: read.overrides, timeout: before.timeout }
    const unavailable = servers.filter((item) => item.values === undefined).map((item) => item.entry.name)
    if (unavailable.join("\n") !== state.missing && unavailable.length > 0)
      log.warn("mcp_values_unavailable", { names: unavailable })
    state.missing = unavailable.join("\n")
    const delay = state.retry.delay
    state.retry =
      unavailable.length === 0 || !source.retry
        ? { delay: RETRY_MS }
        : { delay: Math.min(delay * 2, RETRY_MAX_MS), cancel: deps.clock.schedule(delay, () => reread("retry")) }
    if (JSON.stringify(before) === JSON.stringify(state.snapshot)) return
    await deps.ctx.mcp.reload()
    // Values that came back on a retry: the other Locations read them too, and open pages read the list again.
    const back = servers.some(
      (item) =>
        item.values !== undefined &&
        before.servers.some((old) => old.entry.id === item.entry.id && old.values === undefined),
    )
    if (cause !== "retry" || !back) return
    log.info("mcp_values_back", { names: servers.flatMap((item) => (item.values ? [item.entry.name] : [])) })
    deps.runtime.broadcast.emit("mcp.changed", {})
    void deps.emitter.global("mcp.changed", {})
  }
  const reread = (cause: "change" | "retry") =>
    void refresh(cause).catch((error: unknown) => log.error("mcp_reload_failed", { error }))
  reread("change")
  const off = deps.runtime.broadcast.on("mcp.changed", () => reread("change"))
  const offSource = source.on?.(() => reread("change")) ?? (() => {})
  return () => {
    state.stopped = true
    state.retry.cancel?.()
    off()
    offSource()
  }
}

const TIMEOUTS = ["startup", "catalog", "execution"] as const

/**
 * `mcp.timeout` of the global config documents (`opencode.json`, then `opencode.jsonc` of `OPENCODE_CONFIG_DIR`, in
 * core's order; a later file's field wins), which core merges under its config servers' own. A project file's
 * `mcp.timeout` is not read (like the compaction settings, 02 §4.7.2).
 */
export async function globalTimeout(configDir: string | undefined): Promise<McpFold.Timeout> {
  if (!configDir) return {}
  const texts = await Promise.all(
    ["opencode.json", "opencode.jsonc"].map((name) =>
      Fsx.readText(path.join(configDir, name)).catch(() => undefined),
    ),
  )
  return Object.assign({}, ...texts.map(timeoutOf))
}

function timeoutOf(text: string | undefined) {
  if (!text) return {}
  const root: unknown = parse(text, [], { allowTrailingComma: true, disallowComments: false })
  const mcp = isRecord(root) ? root.mcp : undefined
  const timeout = isRecord(mcp) ? mcp.timeout : undefined
  if (!isRecord(timeout)) return {}
  return Object.fromEntries(
    TIMEOUTS.flatMap((key) => {
      const value = timeout[key]
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? [[key, value]] : []
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

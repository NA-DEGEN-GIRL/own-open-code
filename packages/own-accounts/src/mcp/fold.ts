export * as McpFold from "./fold.js"

import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { Mcp } from "@opencode/schema/mcp"
import { McpRules, type OwnMcp } from "@own/protocol"
import { Location } from "../location.js"
import { McpStore } from "./store.js"

/**
 * own's `mcp.transform` fold (03 §18.14, SM), run in every Location after core's config fold: the servers own added
 * whose scope covers this Location (`global`: every Location but the control one, which runs no conversation;
 * `project`: the folder and the folders inside it), then the list's kept switches that reach this Location (the global
 * switch first, then the project folders from the shallowest to the deepest, so the deepest wins; SG), which set
 * `disabled` on own's servers and a config file's alike. A server of own's whose values are missing stays off whatever
 * a switch says. No I/O: the snapshot is read before ({@link McpServers.register}).
 *
 * core's pre-plugin defaults reach only the servers of its config fold, which runs first, so own gives its servers
 * the same ones here: the global `mcp.timeout` under each server's own, and `McpCodeModeDefaultsPlugin`'s Code Mode
 * and header defaults for a server whose `codemode` is not set (check-surface `mcp-config-fold`, `mcp-codemode`).
 */

/** A server with its values; `values: undefined` (vault unavailable, or not read yet) keeps it off. */
export interface Resolved {
  readonly entry: McpStore.Entry
  readonly values: McpStore.Values | undefined
}

export type Timeout = Mcp.TimeoutConfig

export interface Snapshot {
  readonly servers: ReadonlyArray<Resolved>
  readonly overrides: ReadonlyArray<OwnMcp.Override>
  /** The global config's `mcp.timeout` (core merges it under every config server's own). */
  readonly timeout?: Timeout
}

export const EMPTY: Snapshot = { servers: [], overrides: [] }

export function fold(
  editor: MCPEditor,
  snapshot: Snapshot,
  location: { readonly directory: string; readonly control: boolean },
) {
  if (location.control) return
  const here = snapshot.servers.filter((item) => applies(item.entry.scope, location.directory))
  for (const item of here) editor.set(item.entry.name, config(item, snapshot.timeout))
  const off = new Set(here.filter((item) => item.values === undefined).map((item) => item.entry.name))
  const overrides = snapshot.overrides
    .filter(
      (override) =>
        !off.has(override.name) &&
        (override.directory === undefined || Location.within(location.directory, override.directory)),
    )
    .toSorted((a, b) => McpStore.depth(a) - McpStore.depth(b))
  for (const override of overrides)
    editor.update(override.name, (server) => {
      server.disabled = !override.enabled
    })
}

export function applies(scope: OwnMcp.Scope, directory: string) {
  return scope.type === "global" || Location.within(directory, scope.directory)
}

/**
 * Core's config of one server: the command as `[command, ...args]` with the `${NAME}` references put in, the address
 * from the vault when it is hidden, values from the vault.
 */
export function config(item: Resolved, timeout?: Timeout): Mcp.ServerConfig {
  const values = item.values
  const off = values === undefined ? { disabled: true } : {}
  const timeouts = timeout !== undefined && Object.keys(timeout).length > 0 ? { timeout } : {}
  const codemode = item.entry.transport.codemode === undefined ? {} : { codemode: item.entry.transport.codemode }
  const transport = item.entry.transport
  if (transport.type === "local") {
    const env = values?.env ?? {}
    const environment = {
      ...transport.fixed,
      ...Object.fromEntries(transport.env.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]]))),
    }
    return defaults({
      type: "local",
      command: [McpRules.expand(transport.command, env), ...transport.args.map((arg) => McpRules.expand(arg, env))],
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      ...codemode,
      ...timeouts,
      ...off,
    })
  }
  const headers = Object.fromEntries(
    transport.headers.flatMap((name) => (values?.headers[name] === undefined ? [] : [[name, values.headers[name]]])),
  )
  const base = transport.hidden ? (values?.url ?? transport.url) : transport.url
  return defaults({
    type: "remote",
    url: base + (transport.query ? (values?.search ?? "") : ""),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(transport.oauth ? {} : { oauth: false }),
    ...codemode,
    ...timeouts,
    ...off,
  })
}

// core's McpCodeModeDefaultsPlugin (packages/core/src/plugin/mcp-codemode-defaults.ts), for own's servers: servers
// that are Code Mode themselves get `codemode: false`; PostHog is asked for its plain tools. A set `codemode` is kept.
const EXECUTOR = [/^https:\/\/executor\.sh\/[^/]+\/mcp$/]
const POSTHOG = /^mcp(?:-eu|\.us|\.eu)?\.posthog\.com$/
const POSTHOG_MODE = "x-posthog-mcp-mode"

function defaults(server: Mcp.ServerConfig): Mcp.ServerConfig {
  if (server.codemode !== undefined) return server
  if (server.type === "local")
    return server.command[0] === "executor" && server.command[1] === "mcp" ? { ...server, codemode: false } : server
  if (!URL.canParse(server.url)) return server
  const url = new URL(server.url)
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  const executor = EXECUTOR.some((pattern) => pattern.test(endpoint)) ? { codemode: false } : {}
  const posthog =
    POSTHOG.test(url.hostname) &&
    !url.searchParams.has("mode") &&
    !Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === POSTHOG_MODE)
  return { ...server, ...executor, ...(posthog ? { headers: { ...server.headers, [POSTHOG_MODE]: "tools" } } : {}) }
}

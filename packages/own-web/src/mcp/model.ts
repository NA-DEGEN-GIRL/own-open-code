// Pure MCP view logic (03 §18.14): rows from `GET /api/mcp` (`packages/schema/src/mcp.ts:69-93`), the summary of the
// server status popover, and whether a server is Code Mode (catalog delta when toggled) or registers its tools
// directly (whole-prefix rewrite). No Solid, no DOM; unit-tested in mcp.test.ts.
import type { ConfigEntry, McpServer } from "@opencode/client"
import { samePath } from "@/projects/path"

export type McpStatus = McpServer["status"]["status"]

export interface McpRow {
  readonly name: string
  readonly status: McpStatus
  /** `failed` and `needs_auth` carry the server's message (shown folded, 18.14 "오류 원문(접기)"). */
  readonly error?: string
  readonly integrationID?: string
  /** `false`: tools go into the request's `tools` directly (`codemode:false`), toggling rewrites every cache. */
  readonly codemode: boolean
}

export interface McpSummary {
  readonly total: number
  readonly connected: number
  readonly needsAuth: number
  readonly failed: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

export function toRows(servers: readonly McpServer[], codemode: Readonly<Record<string, boolean>>): McpRow[] {
  return servers
    .map((server) => ({
      name: server.name,
      status: server.status.status,
      error: "error" in server.status ? server.status.error : undefined,
      integrationID: server.integrationID,
      codemode: codemode[server.name] ?? true,
    }))
    .toSorted((a, b) => collator.compare(a.name, b.name))
}

export function summarize(rows: readonly Pick<McpRow, "status">[]): McpSummary {
  return {
    total: rows.length,
    connected: rows.filter((row) => row.status === "connected").length,
    needsAuth: rows.filter((row) => row.status === "needs_auth").length,
    failed: rows.filter((row) => row.status === "failed").length,
  }
}

/** The switch shows what the server is meant to be: on unless disabled (a failed or signed-out server is still on). */
export function switchedOn(status: McpStatus) {
  return status !== "disabled"
}

/**
 * `codemode` per server from the config documents (`GET /api/config`, lowest priority first; the last value set
 * wins), plus core's built-in defaults for servers that are Code Mode themselves
 * (`packages/core/src/plugin/mcp-codemode-defaults.ts`). Unset means Code Mode (`packages/core/src/mcp/client.ts`).
 */
export function codeModeOf(entries: readonly ConfigEntry[]): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [name, server] of Object.entries(entry.info.mcp?.servers ?? {})) {
      if (server.codemode !== undefined) result[name] = server.codemode
      else if (result[name] === undefined && selfCodeMode(server)) result[name] = false
    }
  }
  return result
}

type ServerConfig = NonNullable<
  NonNullable<Extract<ConfigEntry, { type: "document" }>["info"]["mcp"]>["servers"]
>[string]

function selfCodeMode(server: ServerConfig) {
  if (server.type === "local") return server.command[0] === "executor" && server.command[1] === "mcp"
  if (!URL.canParse(server.url)) return false
  const url = new URL(server.url)
  return /^https:\/\/executor\.sh\/[^/]+\/mcp$/.test(`${url.origin}${url.pathname.replace(/\/+$/, "")}`)
}

/** Whether an `mcp.status.changed` / `integration.updated` event concerns this Location (events are server-wide). */
export function sameLocation(event: { readonly location?: { readonly directory: string } }, directory: string) {
  const from = event.location?.directory
  return !from || samePath(from, directory)
}

export * as McpRpc from "./mcp.js"

import { OwnAccounts } from "@own/protocol"
import type { Rpc } from "@opencode/schema/rpc"
import type { Deps } from "../deps.js"
import { McpHostService } from "../mcp/host.js"
import { McpSends } from "../mcp/sends.js"
import { McpService } from "../mcp/service.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: MCP (03 §18.14, SM 2026-10-24). The MCP servers own adds for the user, the list's kept switches, the
 * connection test, the import from other tools, the read-only summary and 찾아서 설치 (the MCP Registry); the logic is
 * `McpService`, these handlers only turn its declared failures into RPC errors. Global methods at the control
 * Location. A remote service refuses this PC's list (`REMOTE_MANAGED`); its own servers installed from the PC are
 * `mcp.host.*` (MH, below).
 */
export type Methods =
  | "mcp.list"
  | "mcp.summary"
  | "mcp.save"
  | "mcp.remove"
  | "mcp.enable"
  | "mcp.test"
  | "mcp.import.scan"
  | "mcp.import.apply"
  | "mcp.registry.search"
  | "mcp.host.view"
  | "mcp.host.probe"
  | "mcp.host.save"
  | "mcp.host.remove"
  | "mcp.host.test"
  | "mcp.host.prefetch"
  | "mcp.hosts.send"
  | "mcp.hosts.unsend"
  | "mcp.hosts.view"

/**
 * MH (04 §13 "MCP", 2026-11-26): `mcp.host.*` answer on an SSH host's service only (its installed servers, `McpHostService`);
 * this PC's service answers `mcp_host_only`. `mcp.hosts.*` are this PC's records of values sent to hosts (`McpSends`);
 * a host refuses them (`REMOTE_MANAGED`).
 */
export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const service = McpService.create(deps)
  const sends = McpSends.create(deps)
  const remote = deps.remote
  // Made on the first host method (most Locations never answer one).
  const state: { host?: McpHostService.Service } = {}
  const hostService = () => (remote ? (state.host ??= McpHostService.create(deps, remote.mcp)) : undefined)
  const hostOnly = <M extends Methods>(method: M, context: RpcTypes.Context<M>) =>
    settle(method, context, Promise.resolve(onlyHost(method)))
  return {
    "mcp.list": (input, context) =>
      service.list(input).catch((error: unknown) => context.error("internal_error", message(error), {})),
    "mcp.summary": (_input, context) =>
      service.summary().catch((error: unknown) => context.error("internal_error", message(error), {})),
    "mcp.save": (input, context) => settle("mcp.save", context, service.save(input)),
    "mcp.remove": (input, context) => settle("mcp.remove", context, service.remove(input.id)),
    "mcp.enable": (input, context) => settle("mcp.enable", context, service.enable(input)),
    "mcp.test": (input, context) => settle("mcp.test", context, service.test(input)),
    "mcp.import.scan": (input, context) =>
      service.scan(input).catch((error: unknown) => context.error("internal_error", message(error), {})),
    "mcp.import.apply": (input, context) => settle("mcp.import.apply", context, service.apply(input)),
    "mcp.registry.search": (input, context) => settle("mcp.registry.search", context, service.registry(input)),
    "mcp.host.view": (_input, context) =>
      hostService()
        ? hostService()!.view().catch((error: unknown) => context.error("internal_error", message(error), {}))
        : hostOnly("mcp.host.view", context),
    "mcp.host.probe": (input, context) =>
      hostService()
        ? hostService()!.probe(input).catch((error: unknown) => context.error("internal_error", message(error), {}))
        : hostOnly("mcp.host.probe", context),
    "mcp.host.save": (input, context) =>
      hostService() ? settle("mcp.host.save", context, hostService()!.save(input)) : hostOnly("mcp.host.save", context),
    "mcp.host.remove": (input, context) =>
      hostService() ? settle("mcp.host.remove", context, hostService()!.remove(input.id)) : hostOnly("mcp.host.remove", context),
    "mcp.host.test": (input, context) =>
      hostService() ? settle("mcp.host.test", context, hostService()!.test(input.id)) : hostOnly("mcp.host.test", context),
    "mcp.host.prefetch": (input, context) =>
      hostService() ? settle("mcp.host.prefetch", context, hostService()!.prefetch(input.id)) : hostOnly("mcp.host.prefetch", context),
    "mcp.hosts.send": (input, context) => settle("mcp.hosts.send", context, sends.send(input)),
    "mcp.hosts.unsend": (input, context) => settle("mcp.hosts.unsend", context, sends.unsend(input)),
    "mcp.hosts.view": (input, context) =>
      sends.view(input).catch((error: unknown) => context.error("internal_error", message(error), {})),
  }
}

function onlyHost(method: string): McpService.Answer<never> {
  return {
    ok: false,
    error: { type: "mcp_host_only", message: `${method} is an SSH host's method`, data: { method } },
  }
}

/** The service's value, its declared failure as the method's error, or `internal_error` for anything thrown. */
async function settle<M extends Methods, T>(
  method: M,
  context: RpcTypes.Context<M>,
  run: Promise<McpService.Answer<T>>,
) {
  const result = await run.catch(
    (error: unknown): McpService.Answer<never> => ({
      ok: false,
      error: { type: "internal_error", message: message(error), data: {} },
    }),
  )
  if (result.ok) return result.value
  const known = Object.hasOwn(OwnAccounts.Definition.methods[method].errors, result.error.type)
  // SAFETY: `type` is a declared error of `method` (checked above); McpService builds each failure's data to its schema.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const error = context.error as unknown as (
    type: string,
    message: string,
    data: object,
  ) => Rpc.HandlerError<RpcTypes.Definition["methods"][M]>
  return known
    ? error(result.error.type, result.error.message, result.error.data)
    : error("internal_error", result.error.message, {})
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

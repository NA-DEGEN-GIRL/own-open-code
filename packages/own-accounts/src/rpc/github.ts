export * as GitHubRpc from "./github.js"

import { OwnAccounts } from "@own/protocol"
import type { Rpc } from "@opencode/schema/rpc"
import type { Deps } from "../deps.js"
import { GitHubService } from "../github/service.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: GitHub connection (16, GH 2026-10-31). The accounts, their tokens in the vault, the choices per project,
 * team area folder and conversation, the settings and the browser login; the logic is `GitHubService`, these handlers
 * only turn its declared failures into RPC errors. Global methods at the control Location. A remote service refuses
 * them (`REMOTE_MANAGED`): the tokens are this PC's.
 */
export type Methods =
  | "github.view"
  | "github.add.token"
  | "github.device.start"
  | "github.device.status"
  | "github.device.cancel"
  | "github.update"
  | "github.remove"
  | "github.bind"
  | "github.settings.set"
  | "github.test"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const service = GitHubService.create(deps)
  return {
    "github.view": (input, context) =>
      service.view(input).catch((error: unknown) => context.error("internal_error", message(error), {})),
    "github.add.token": (input, context) => settle("github.add.token", context, service.addToken(input)),
    "github.device.start": (input, context) => settle("github.device.start", context, service.deviceStart(input)),
    "github.device.status": (input, context) =>
      settle("github.device.status", context, service.deviceStatus(input.nonce)),
    "github.device.cancel": (input, context) =>
      settle("github.device.cancel", context, service.deviceCancel(input.nonce)),
    "github.update": (input, context) => settle("github.update", context, service.update(input)),
    "github.remove": (input, context) => settle("github.remove", context, service.remove(input.id)),
    "github.bind": (input, context) => settle("github.bind", context, service.bind(input)),
    "github.settings.set": (input, context) => settle("github.settings.set", context, service.settings(input)),
    "github.test": (input, context) => settle("github.test", context, service.test(input.id)),
  }
}

/** The service's value, its declared failure as the method's error, or `internal_error` for anything thrown. */
async function settle<M extends Methods, T>(
  method: M,
  context: RpcTypes.Context<M>,
  run: Promise<GitHubService.Answer<T>>,
) {
  const result = await run.catch(
    (error: unknown): GitHubService.Answer<never> => ({
      ok: false,
      error: { type: "internal_error", message: message(error), data: {} },
    }),
  )
  if (result.ok) return result.value
  const known = Object.hasOwn(OwnAccounts.Definition.methods[method].errors, result.error.type)
  // SAFETY: `type` is a declared error of `method` (checked above); GitHubService builds each failure's data to its schema.
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

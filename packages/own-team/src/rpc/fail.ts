export * as RpcFailure from "./fail.js"

import { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"

/**
 * Service failures as declared RPC errors (06 §2.7). Until T2 this file also answered the methods of later builds with
 * `unsupported{feature}`; every method has its group now, and a group answers `unsupported` itself for what its build
 * lacks.
 */

/**
 * A service failure as `method`'s declared error. A failure the method does not declare becomes `internal_error`
 * (with the failure's message), so the host never has to encode an undeclared error.
 */
export function fail<N extends TeamRpc.MethodName>(
  method: N,
  context: TeamRpc.Context<N>,
  failure: Services.Failure,
): TeamRpc.HandlerError<N> {
  // SAFETY: the RPC context's `error` takes a declared name and that error's data; both are checked here at run time
  // (`declared`), and `failure.data` was typed by the error's own schema (`Services.Failure`).
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const error = context.error as unknown as (type: string, message: string, data: unknown) => TeamRpc.HandlerError<N>
  const declared = Object.hasOwn(OwnTeam.Definition.methods[method].errors, failure.error)
  return declared ? error(failure.error, failure.message, failure.data) : error("internal_error", failure.message, {})
}

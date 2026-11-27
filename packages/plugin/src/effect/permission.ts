import type { PermissionApi } from "@opencode/client/effect/api"
import type { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import type { Tool } from "@opencode/schema/tool"
import type { Effect } from "effect"
import type { AssertInput } from "../permission.js"
import type { Hooks } from "./registration.js"

export interface PermissionEvaluation {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: Permission.Effect
  message?: string
  // OWN-PATCH(P-047) begin
  /**
   * The resources of the project's saved approvals (`항상 허용`) whose action matches this one, as they are saved
   * now: a hook can tell an allow a saved rule gives from one the agent's or the session's rules give.
   */
  readonly saved?: ReadonlyArray<string>
  // OWN-PATCH(P-047) end
}

export interface PermissionHooks {
  readonly evaluate: PermissionEvaluation
}

// OWN-PATCH(P-019) begin
/** A path a plugin tool touches, resolved against the session's Location as core file tools resolve theirs. */
export interface PermissionPath {
  readonly absolute: string
  /** The rule resource: relative to the Location with "/" inside it, else the absolute path. */
  readonly resource: string
  readonly external: boolean
}
// OWN-PATCH(P-019) end

export type PermissionDomain = Pick<PermissionApi<unknown>, "list" | "get" | "reply"> & {
  readonly hook: Hooks<PermissionHooks>
  /**
   * Evaluates the session's permission rules and, when approval is required, prompts the user and
   * waits for the reply. Succeeds when allowed. A deny rule or a rejection with feedback fails with a
   * `Tool.Error` carrying the reason; a plain rejection ends the current step.
   */
  readonly assert: (input: AssertInput) => Effect.Effect<void, Tool.Error>
  // OWN-PATCH(P-019) begin
  /** Resolves paths and asks `external_directory` for those outside the Location (one request, first-seen order). */
  readonly paths: (
    input: { readonly paths: ReadonlyArray<string>; readonly kind: "file" | "directory" },
    context: Tool.Context,
  ) => Effect.Effect<ReadonlyArray<PermissionPath>, Tool.Error>
  // OWN-PATCH(P-019) end
}

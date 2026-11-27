export * as HarnessPermission from "./permission.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"

/** A permission a harness tool needs: the agent's and the session's rules, then the user. */
export interface Ask {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  /** Patterns an "always" reply saves for the project. */
  readonly save?: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
}

/**
 * Asks on behalf of the tool call in `call`, as core tools ask theirs (upstream `permission.assert`, v2.0.32). The
 * agent must be passed: upstream makes it optional, and without it the read-only mode's and the explore role's agent
 * rules would not apply. The source ties the approval card to the tool call. A deny or a corrected reply fails with a
 * `Tool.Error` the session reports as `permission.rejected`; a plain decline ends the step as it does for core tools.
 */
export const assert = (ctx: Pick<Context, "permission">, input: Ask, call: Tool.Context) =>
  ctx.permission.assert({
    ...input,
    sessionID: call.sessionID,
    agent: call.agent,
    source: { type: "tool", messageID: call.messageID, id: call.id },
  })

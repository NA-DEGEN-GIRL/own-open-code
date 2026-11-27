// MCP server sign-in: the ONE exception to "own-web never calls an integration connect route" (03 §16.3, §18.14,
// 01 §17.1 #14). Upstream's only way to clear an MCP server's `needs_auth` is `integration.oauth.connect`
// (`packages/app/src/providers/connect/mcp.ts:40-50`, reused here as behaviour, not code). The conditions of the
// exception are enforced in this file and checked by `lint.test.ts`:
// - This is the only file that may name an integration connect call (and only `oauth.connect`: `connect.key` and
//   `command.connect` stay forbidden everywhere, MCP accepts only form-less OAuth like upstream).
// - Right before connecting, `mcp.list` is read again at that location; the target must be an MCP server whose
//   status is `needs_auth` **now**, and its integration id must have the MCP shape `mcp_<16 hex>` (core derives it
//   from sha1(name, url), `packages/core/src/mcp/index.ts:170-176`). Provider integrations (`openai`, `anthropic`,
//   the own slots) can never pass, so the global active-credential switch is never touched.
// No secret passes through here: the attempt holds an authorization URL for the user's browser; the server keeps the
// tokens (loopback callback, `packages/core/src/mcp/oauth.ts`).
import type { OpenCodeClient } from "@opencode/client"

export const MCP_INTEGRATION_ID = /^mcp_[0-9a-f]{16}$/

export type McpSignInFailure = "not_found" | "not_needs_auth" | "not_mcp_integration" | "no_oauth_method" | "not_auto"

export class McpSignInError extends Error {
  override readonly name = "McpSignInError"
  constructor(readonly reason: McpSignInFailure) {
    super(`MCP sign-in refused: ${reason}`)
  }
}

export type McpSignInStatus =
  | { readonly status: "pending" }
  | { readonly status: "complete" }
  | { readonly status: "expired" }
  | { readonly status: "failed"; readonly message: string }

export interface McpSignIn {
  readonly server: string
  readonly integrationID: string
  readonly attemptID: string
  /** Authorization page to open in the user's browser. */
  readonly url: string
  /** Epoch ms after which the attempt is dead. */
  readonly expires: number
  status(): Promise<McpSignInStatus>
  cancel(): Promise<void>
}

export async function beginMcpSignIn(input: {
  readonly client: OpenCodeClient
  /** The Location whose MCP server this is (MCP servers run per Location). */
  readonly directory: string
  readonly server: string
}): Promise<McpSignIn> {
  const location = { directory: input.directory }
  const listed = await input.client.mcp.list({ location })
  const server = listed.data.find((item) => item.name === input.server)
  if (!server) throw new McpSignInError("not_found")
  if (server.status.status !== "needs_auth") throw new McpSignInError("not_needs_auth")
  const integrationID = server.integrationID
  if (!integrationID || !MCP_INTEGRATION_ID.test(integrationID)) throw new McpSignInError("not_mcp_integration")
  const integration = await input.client.integration.get({ integrationID, location })
  const method = integration.data.methods.find((item) => item.type === "oauth" && !item.form?.length)
  if (!method || method.type !== "oauth") throw new McpSignInError("no_oauth_method")
  const attempt = (await input.client.integration.oauth.connect({ integrationID, methodID: method.id, location })).data
  const target = { integrationID, attemptID: attempt.attemptID, location }
  const cancel = () => input.client.integration.oauth.cancel(target).then(() => undefined)
  // Core's MCP authorize always answers `auto` (loopback callback). A code-paste flow would need a form: refuse it.
  if (attempt.mode !== "auto") {
    await cancel().catch(() => undefined)
    throw new McpSignInError("not_auto")
  }
  return {
    server: input.server,
    integrationID,
    attemptID: attempt.attemptID,
    url: attempt.url,
    expires: attempt.time.expires,
    cancel,
    async status() {
      const result = (await input.client.integration.oauth.status(target)).data
      if (result.status === "failed") return { status: "failed", message: result.message }
      return { status: result.status }
    },
  }
}

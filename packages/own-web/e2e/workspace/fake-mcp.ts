// Fake remote MCP servers + a fake OAuth authorization server for the workspace e2e suite (03 §18.14). One Bun.serve
// on a random loopback port:
//   /open/mcp, /direct/mcp, /off/mcp   MCP over Streamable HTTP (JSON responses), no auth
//   /secure/mcp                       same, but 401 + `WWW-Authenticate: Bearer resource_metadata=…` without a token
//   /.well-known/oauth-protected-resource[/secure/mcp], /.well-known/oauth-authorization-server
//   /register (DCR), /authorize (auto-approves: 302 to the redirect_uri with a code), /token
// Enough of MCP for core's client (`packages/core/src/mcp/client.ts`): initialize, notifications, tools/list, ping.
// Fake credentials only (fixed test strings); nothing leaves 127.0.0.1.

const ACCESS_TOKEN = "own-e2e-fake-access-token"
const REFRESH_TOKEN = "own-e2e-fake-refresh-token"
const PROTOCOL = "2025-06-18"

export interface FakeMcp {
  readonly url: string
  /** OAuth progress, for assertions. */
  readonly oauth: { registered: number; authorized: number; tokens: number; unauthorized: number }
  stop(): void
}

export function startFakeMcp(
  extra?: (request: Request, url: URL) => Response | Promise<Response> | undefined,
): FakeMcp {
  const oauth = { registered: 0, authorized: 0, tokens: 0, unauthorized: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const origin = url.origin
      const custom = await extra?.(request, url)
      if (custom) return custom
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return json({
          resource: `${origin}/secure/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        })
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration"
      )
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      if (url.pathname === "/register" && request.method === "POST") {
        oauth.registered++
        const body = (await request.json()) as Record<string, unknown>
        return json({ ...body, client_id: "own-e2e-client", client_id_issued_at: Math.floor(Date.now() / 1000) }, 201)
      }
      if (url.pathname === "/authorize") {
        oauth.authorized++
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "")
        redirect.searchParams.set("code", "own-e2e-code")
        const state = url.searchParams.get("state")
        if (state) redirect.searchParams.set("state", state)
        return new Response(null, { status: 302, headers: { location: redirect.toString() } })
      }
      if (url.pathname === "/token" && request.method === "POST") {
        oauth.tokens++
        return json({
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: REFRESH_TOKEN,
        })
      }
      const mcp = /^\/(open|direct|off|secure)\/mcp$/.exec(url.pathname)?.[1]
      if (!mcp) return new Response("not found", { status: 404 })
      if (mcp === "secure" && request.headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
        oauth.unauthorized++
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/secure/mcp"`,
          },
        })
      }
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
      return rpc(mcp, await request.json())
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, oauth, stop: () => void server.stop(true) }
}

function rpc(server: string, message: unknown) {
  const request = message as { id?: string | number; method?: string; params?: { protocolVersion?: string } }
  if (request.id === undefined) return new Response(null, { status: 202 })
  if (request.method === "initialize")
    return json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: `own-e2e-${server}`, version: "1.0.0" },
      },
    })
  if (request.method === "tools/list")
    return json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: `${server}_lookup`,
            description: `Looks something up (fake ${server} MCP server).`,
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      },
    })
  if (request.method === "ping") return json({ jsonrpc: "2.0", id: request.id, result: {} })
  return json({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: `Method not found: ${request.method}` },
  })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

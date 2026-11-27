// A fake MCP Registry for own's `찾아서 설치` (03 §18.14, SM): `GET /v0.1/servers` with `search` (part of a name, any
// case), `limit`, `cursor` and `version=latest`, answering made-up `server.json` entries in the registry's shape, and a
// tiny Streamable HTTP MCP server at `/<workspace>/mcp` that one entry's remote points at (`initialize`, `tools/list`,
// notifications; anything else "method not found"), so an entry can be filled in, saved and connected without the
// real registry or the network. Every listener binds 127.0.0.1. Made-up data only.

export interface FakeMcpRegistry {
  /** The registry root (`endpoints.mcpRegistry`). */
  readonly url: string
  /** Every registry request's query, newest last. */
  readonly searches: ReadonlyArray<Readonly<Record<string, string>>>
  stop(): void
}

/** The made-up entries; the remote addresses are under `origin` (the fake's own address unless given another). */
export function demoServers(origin: string) {
  const official = (status = "active") => ({
    "io.modelcontextprotocol.registry/official": {
      status,
      publishedAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      isLatest: true,
    },
  })
  return [
    {
      server: {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.github.demo-org/notes",
        title: "Demo Notes",
        description: "Finds and writes notes in a demo workspace.",
        version: "2.1.0",
        repository: { url: "https://github.com/demo-org/notes-mcp", source: "github" },
        websiteUrl: "https://demo-org.example.com/notes",
        packages: [
          {
            registryType: "npm",
            registryBaseUrl: "https://registry.npmjs.org",
            identifier: "@demo-org/notes-mcp",
            version: "2.1.0",
            transport: { type: "stdio" },
            packageArguments: [{ type: "positional", valueHint: "workspace", isRequired: true }],
            environmentVariables: [
              { name: "NOTES_TOKEN", description: "Token of your notes account", isRequired: true, isSecret: true },
              { name: "NOTES_REGION", description: "Where your notes live", default: "eu" },
            ],
          },
          {
            registryType: "pypi",
            identifier: "demo-notes-mcp",
            version: "2.1.0",
            runtimeHint: "uvx",
            transport: { type: "stdio" },
          },
        ],
        remotes: [
          {
            type: "streamable-http",
            url: `${origin}/{workspace}/mcp`,
            variables: { workspace: { description: "Your workspace", isRequired: true } },
            headers: [{ name: "X-Notes-Key", description: "Key of your notes account", isSecret: true }],
          },
        ],
      },
      _meta: official(),
    },
    {
      server: {
        name: "io.github.demo-org/weather",
        title: "Demo Weather",
        description: "Weather forecasts for demo cities.",
        version: "0.9.3",
        packages: [
          {
            registryType: "oci",
            identifier: "docker.io/demo-org/weather-mcp",
            version: "0.9.3",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "WEATHER_KEY", isRequired: true, isSecret: true }],
          },
        ],
      },
      _meta: official(),
    },
    {
      server: {
        name: "io.github.demo-org/old-notes",
        description: "The old notes server.",
        version: "1.0.0",
        remotes: [{ type: "sse", url: `${origin}/sse` }],
      },
      _meta: official("deprecated"),
    },
  ]
}

export function startFakeMcpRegistry(
  options: {
    readonly tools?: ReadonlyArray<string>
    /** Where the entries' remote addresses point (the manual's pictures: a made-up host); default the fake itself. */
    readonly remote?: string
  } = {},
): FakeMcpRegistry {
  const searches: Record<string, string>[] = []
  const tools = (options.tools ?? ["find_note", "write_note"]).map((name) => ({
    name,
    description: `Demo ${name} tool.`,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  }))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/v0.1/servers") {
        const query = Object.fromEntries(url.searchParams)
        searches.push(query)
        const all = demoServers(options.remote ?? url.origin).filter((item) =>
          item.server.name.toLowerCase().includes((query.search ?? "").toLowerCase()),
        )
        const start = Number(query.cursor ?? 0)
        const limit = Number(query.limit ?? 30)
        const page = all.slice(start, start + limit)
        const next = start + limit < all.length ? String(start + limit) : undefined
        return Response.json({ servers: page, metadata: { count: page.length, ...(next ? { nextCursor: next } : {}) } })
      }
      if (/^\/[^/]+\/mcp$/.test(url.pathname)) return mcp(request, tools)
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, searches, stop: () => void server.stop(true) }
}

/** Enough of Streamable HTTP for core's client and own's connection test: JSON answers, no server-sent stream. */
async function mcp(request: Request, tools: ReadonlyArray<unknown>) {
  if (request.method === "DELETE") return new Response(null, { status: 204 })
  if (request.method !== "POST") return new Response(null, { status: 405 })
  const message = (await request.json()) as { id?: unknown; method?: string; params?: { protocolVersion?: string } }
  if (message.id === undefined) return new Response(null, { status: 202 })
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "demo-notes", version: "2.1.0" },
        }
      : message.method === "tools/list"
        ? { tools }
        : message.method === "ping"
          ? {}
          : undefined
  const body =
    result === undefined
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }
      : { jsonrpc: "2.0", id: message.id, result }
  return Response.json(body, { headers: { "mcp-session-id": "demo-session" } })
}

if (import.meta.main) {
  const fake = startFakeMcpRegistry()
  console.log(`fake MCP Registry at ${fake.url}`)
}

// Fake upstream web search services for own's keyed variants (02 §9.2, SK 2026-10-23): Exa, Firecrawl, Parallel and
// TinyFish as MCP servers (`POST …/mcp`, JSON-RPC `tools/call`, answered as an event stream or as JSON the way the
// live servers do) and Tavily's Search API (`POST /search`), each in the shape core's plugin reads
// (packages/core/src/plugin/websearch/*.ts and its test). A request without the service's key, placed where core
// places it (Exa: `?exaApiKey=`; Firecrawl, Parallel, Tavily: `Authorization: Bearer`; TinyFish: `X-API-Key`), gets
// 401. TinyFish, like the live server since core's v2.0.32 (86755e1cea), answers a keyed search only within an MCP
// session: `initialize` answers an `Mcp-Session-Id`, `notifications/initialized` with it gets 202, and a `tools/call`
// without an initialized session gets 400. Like every fake here it records the key only as `hashSecret(value)`; each
// answer has a page of its own and one page every service finds (`SHARED_PAGE`). 127.0.0.1 only.
import { hashSecret, isRecord } from "./shared"

export type SearchService = "exa" | "firecrawl" | "parallel" | "tavily" | "tinyfish"

/** A step of TinyFish's MCP session, before its search. */
export type SessionStep = "initialize" | "notifications/initialized"

export const SEARCH_SERVICES: readonly SearchService[] = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]

/** The page every service finds, so a merged search shows it once with every service. */
export const SHARED_PAGE = "https://docs.example.test/search/shared"

export interface SearchCall {
  readonly service: SearchService
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  /** `hashSecret` of the key found where the service takes it, or undefined. */
  readonly key?: string
  readonly userAgent: string | null
  readonly clientName: string | null
  readonly accept: string | null
  /** The `Mcp-Session-Id` header, or null. */
  readonly session: string | null
  /** TinyFish's session step this request was; absent for a search. */
  readonly step?: SessionStep
  /** The parsed JSON body (a JSON-RPC call for the MCP services). */
  readonly body: unknown
}

export interface FakeSearchServices {
  readonly url: string
  /** own-accounts' `endpoints` for the five services (whole URLs, as core's). */
  readonly endpoints: Readonly<Record<SearchService, string>>
  readonly calls: readonly SearchCall[]
  /**
   * The next answer of one service's search instead of its usual one (any key check still applies first); with
   * `step`, the answer of that step of TinyFish's session instead.
   */
  next(service: SearchService, reply: () => Response, step?: SessionStep): void
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

const PATHS: Readonly<Record<string, SearchService>> = {
  "/exa/mcp": "exa",
  "/firecrawl/v2/mcp": "firecrawl",
  "/parallel/mcp": "parallel",
  "/tavily/search": "tavily",
  "/tinyfish/mcp": "tinyfish",
}

/** The pages each service answers: its own (`https://<service>.example.test/page`) and {@link SHARED_PAGE}. */
export function pageOf(service: SearchService) {
  return `https://${service}.example.test/page`
}

export function startFakeSearchServices(keys: Readonly<Partial<Record<SearchService, string>>>): FakeSearchServices {
  const calls: SearchCall[] = []
  const replies = new Map<SearchService, { readonly reply: () => Response; readonly step?: SessionStep }>()
  /** TinyFish's sessions: answered by `initialize`, then initialized. */
  const sessions = new Map<string, { initialized: boolean }>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const service = PATHS[url.pathname]
      if (!service || request.method !== "POST") return new Response("not found", { status: 404 })
      const found = keyOf(service, request, url)
      const body: unknown = await request.json().catch(() => undefined)
      const step = service === "tinyfish" ? stepOf(body) : undefined
      const session = request.headers.get("mcp-session-id")
      calls.push({
        service,
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...(found ? { key: hashSecret(found) } : {}),
        userAgent: request.headers.get("user-agent"),
        clientName: request.headers.get("x-client-name"),
        accept: request.headers.get("accept"),
        session,
        ...(step ? { step } : {}),
        body,
      })
      if (!found || found !== keys[service]) return Response.json({ error: "invalid key" }, { status: 401 })
      const pending = replies.get(service)
      if (pending && pending.step === step) {
        replies.delete(service)
        return pending.reply()
      }
      if (service !== "tinyfish") return answer(service)
      if (step === "initialize") {
        const id = `fake-tinyfish-session-${sessions.size + 1}`
        sessions.set(id, { initialized: false })
        return Response.json(
          {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-tinyfish", version: "1.0" },
            },
          },
          { headers: { "mcp-session-id": id } },
        )
      }
      const open = session === null ? undefined : sessions.get(session)
      if (step === "notifications/initialized" && open) {
        open.initialized = true
        return new Response(null, { status: 202 })
      }
      if (!open?.initialized)
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } },
          { status: 400 },
        )
      return answer(service)
    },
  })
  const url = `http://${server.hostname}:${server.port}`
  const stop = () => server.stop(true)
  return {
    url,
    endpoints: Object.fromEntries(
      Object.entries(PATHS).map(([pathname, service]) => [service, `${url}${pathname}`]),
    ) as Record<SearchService, string>,
    calls,
    next: (service, reply, step) => void replies.set(service, { reply, ...(step ? { step } : {}) }),
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

/** The key a request carries where `service` takes it. */
function keyOf(service: SearchService, request: Request, url: URL) {
  if (service === "exa") return url.searchParams.get("exaApiKey") ?? undefined
  if (service === "tinyfish") return request.headers.get("x-api-key") ?? undefined
  return request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1]
}

/** TinyFish's session step a JSON-RPC body is, or undefined for anything else. */
function stepOf(body: unknown): SessionStep | undefined {
  const method = isRecord(body) ? body.method : undefined
  return method === "initialize" || method === "notifications/initialized" ? method : undefined
}

/** The searches among `calls` (no session step). */
export function searchesOf(calls: readonly SearchCall[]) {
  return calls.filter((call) => call.step === undefined)
}

/** The query of a call (Parallel's `objective`). */
export function queryOf(call: SearchCall) {
  const body = isRecord(call.body) ? call.body : {}
  const args = isRecord(body.params) && isRecord(body.params.arguments) ? body.params.arguments : body
  return String(args.query ?? args.objective ?? "")
}

/** A JSON-RPC result as a one-event stream (`event: message`), the way Exa's and Firecrawl's servers answer. */
export function mcpStream(result: unknown) {
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

/** A JSON-RPC result as plain JSON, the way Parallel's and TinyFish's servers answer here. */
export function mcpJson(result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: 1, result })
}

function answer(service: SearchService): Response {
  const own = pageOf(service)
  if (service === "exa")
    return mcpStream({
      content: [
        {
          type: "text",
          text: [
            `Title: Exa page\nURL: ${own}\nPublished: 2026-08-20T09:00:00.000Z\nAuthor: N/A\nHighlights:\nExa found this.`,
            `Title: Shared page\nURL: ${SHARED_PAGE}\nPublished: N/A\nAuthor: N/A\nText: Everyone found this.`,
          ].join("\n\n---\n\n"),
        },
      ],
    })
  if (service === "parallel")
    return mcpJson({
      content: [{ type: "text", text: "search results" }],
      structuredContent: {
        search_id: "search_fake",
        results: [
          { url: own, title: "Parallel page", publish_date: "2026-09-01", excerpts: ["Parallel found this."] },
          { url: SHARED_PAGE, title: "Shared page", publish_date: null, excerpts: [] },
        ],
        warnings: null,
        usage: [{ name: "sku_search", count: 1 }],
        session_id: "session_fake",
      },
    })
  if (service === "firecrawl")
    return mcpStream({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            data: {
              web: [
                { url: own, title: "Firecrawl page", description: "Firecrawl found this." },
                { url: SHARED_PAGE, title: "Shared page", description: null },
              ],
            },
          }),
        },
      ],
    })
  if (service === "tinyfish")
    return mcpJson({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { url: own, title: "TinyFish page", snippet: "TinyFish found this." },
              { url: SHARED_PAGE, title: "Shared page", snippet: "" },
            ],
          }),
        },
      ],
    })
  return Response.json({
    query: "q",
    results: [
      { title: "Tavily page", url: own, content: "Tavily found this.", score: 0.9 },
      { title: "Shared page", url: SHARED_PAGE, content: "", score: 0.5 },
    ],
    response_time: 0.4,
  })
}

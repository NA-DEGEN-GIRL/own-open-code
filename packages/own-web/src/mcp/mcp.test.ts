import { describe, expect, test } from "bun:test"
import { OpenCode, type ConfigEntry } from "@opencode/client"
import { codeModeOf, sameLocation, summarize, switchedOn, toRows } from "./model"
import { beginMcpSignIn, MCP_INTEGRATION_ID, McpSignInError } from "./oauth"
import { mcpListText } from "./list-strings"

describe("MCP rows (03 §18.14)", () => {
  test("rows are sorted by name, carry the server's error and the Code Mode flag", () => {
    const rows = toRows(
      [
        { name: "zeta", status: { status: "failed", error: "ECONNREFUSED" } },
        { name: "alpha", status: { status: "needs_auth", error: "401" }, integrationID: "mcp_0123456789abcdef" },
        { name: "Beta2", status: { status: "connected" } },
        { name: "beta10", status: { status: "disabled" } },
      ],
      { beta10: false },
    )
    expect(rows.map((row) => row.name)).toEqual(["alpha", "Beta2", "beta10", "zeta"])
    expect(rows[0]).toMatchObject({ status: "needs_auth", error: "401", codemode: true })
    expect(rows[2]!.codemode).toBe(false)
    expect(rows[3]!.error).toBe("ECONNREFUSED")
    expect(summarize(rows)).toEqual({ total: 4, connected: 1, needsAuth: 1, failed: 1 })
    expect(
      ["connected", "pending", "failed", "needs_auth", "disabled"].map((status) => switchedOn(status as never)),
    ).toEqual([true, true, true, true, false])
  })

  test("codemode comes from the config documents (last value wins) and core's built-in defaults", () => {
    const document = (servers: Record<string, unknown>): ConfigEntry =>
      ({ type: "document", info: { mcp: { servers } } }) as ConfigEntry
    expect(
      codeModeOf([
        document({ a: { type: "remote", url: "https://x.test/mcp", codemode: false } }),
        document({
          a: { type: "remote", url: "https://x.test/mcp", codemode: true },
          b: { type: "local", command: ["x"] },
        }),
        document({ exec: { type: "remote", url: "https://executor.sh/me/mcp/" } }),
        document({ execLocal: { type: "local", command: ["executor", "mcp"] } }),
        document({ pinned: { type: "local", command: ["executor", "mcp"], codemode: true } }),
      ]),
    ).toEqual({ a: true, exec: false, execLocal: false, pinned: true })
  })

  test("events without a location apply everywhere; located ones only to their folder", () => {
    expect(sameLocation({}, "D:\\p")).toBe(true)
    expect(sameLocation({ location: { directory: "d:/P" } }, "D:\\p")).toBe(true)
    expect(sameLocation({ location: { directory: "D:\\q" } }, "D:\\p")).toBe(false)
  })

  test("summary strings", () => {
    expect(mcpListText("ko", "own.mcp.summaryAuth", { n: 1 })).toBe("로그인 필요 1")
    expect(mcpListText("en", "own.mcp.count", { connected: 2, total: 3 })).toBe("2 connected · 3 total")
  })
})

describe("MCP sign-in exception (03 §16.3)", () => {
  const MCP_ID = "mcp_0123456789abcdef"

  function server(input: {
    readonly servers: readonly Record<string, unknown>[]
    readonly methods?: readonly Record<string, unknown>[]
    readonly mode?: "auto" | "code"
  }) {
    const calls: string[] = []
    const client = OpenCode.make({
      baseUrl: "http://127.0.0.1:9",
      fetch: Object.assign(
        async (request: URL | RequestInfo, init?: RequestInit) => {
          const url = new URL(request instanceof Request ? request.url : String(request))
          const method = init?.method ?? (request instanceof Request ? request.method : "GET")
          calls.push(`${method} ${url.pathname}`)
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
          const location = { directory: url.searchParams.get("location[directory]") }
          const time = { created: 1, expires: Date.now() + 60_000 }
          if (url.pathname === "/api/mcp") return json({ location, data: input.servers })
          if (url.pathname.endsWith("/connect/oauth"))
            return json({
              location,
              data: {
                attemptID: "con_1",
                url: "http://127.0.0.1:9/authorize?x=1",
                instructions: "",
                mode: input.mode ?? "auto",
                time,
              },
            })
          if (url.pathname.includes("/connect/oauth/") && method === "DELETE")
            return new Response(null, { status: 204 })
          if (url.pathname.includes("/connect/oauth/")) return json({ location, data: { status: "complete", time } })
          if (url.pathname.startsWith("/api/integration/"))
            return json({
              location,
              data: {
                id: decodeURIComponent(url.pathname.split("/")[3]!),
                name: "docs",
                methods: input.methods ?? [{ id: MCP_ID, type: "oauth", label: "docs" }],
                connections: [],
              },
            })
          return new Response("not found", { status: 404 })
        },
        { preconnect: () => {} },
      ),
    })
    return { client, calls }
  }

  const refused = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: unknown) => (error instanceof McpSignInError ? error.reason : String(error)),
    )

  test("the MCP integration id shape", () => {
    expect(MCP_INTEGRATION_ID.test(MCP_ID)).toBe(true)
    for (const id of [
      "openai",
      "anthropic",
      "mcp_0123",
      "mcp_0123456789ABCDEF",
      "xmcp_0123456789abcdef",
      "mcp_0123456789abcdef0",
    ])
      expect(MCP_INTEGRATION_ID.test(id)).toBe(false)
  })

  test("a server that is not needs_auth right now is refused before any connect call", async () => {
    const fake = server({ servers: [{ name: "docs", status: { status: "connected" }, integrationID: MCP_ID }] })
    expect(await refused(beginMcpSignIn({ client: fake.client, directory: "D:\\p", server: "docs" }))).toBe(
      "not_needs_auth",
    )
    expect(fake.calls).toEqual(["GET /api/mcp"])
  })

  test("a provider integration id can never be connected, even if a server claims it", async () => {
    for (const integrationID of ["openai", "anthropic", undefined]) {
      const fake = server({
        servers: [{ name: "docs", status: { status: "needs_auth", error: "401" }, integrationID }],
      })
      expect(await refused(beginMcpSignIn({ client: fake.client, directory: "D:\\p", server: "docs" }))).toBe(
        "not_mcp_integration",
      )
      expect(fake.calls.some((call) => call.includes("/connect/"))).toBe(false)
    }
  })

  test("only a form-less OAuth method is used; unknown servers are refused", async () => {
    const withForm = server({
      servers: [{ name: "docs", status: { status: "needs_auth", error: "401" }, integrationID: MCP_ID }],
      methods: [{ id: MCP_ID, type: "oauth", label: "docs", form: [{ key: "tenant", type: "text", label: "Tenant" }] }],
    })
    expect(await refused(beginMcpSignIn({ client: withForm.client, directory: "D:\\p", server: "docs" }))).toBe(
      "no_oauth_method",
    )
    expect(withForm.calls.some((call) => call.includes("/connect/"))).toBe(false)
    const missing = server({ servers: [] })
    expect(await refused(beginMcpSignIn({ client: missing.client, directory: "D:\\p", server: "docs" }))).toBe(
      "not_found",
    )
  })

  test("a needs_auth MCP server gets one oauth.connect at its Location; status and cancel use the attempt", async () => {
    const fake = server({
      servers: [{ name: "docs", status: { status: "needs_auth", error: "401" }, integrationID: MCP_ID }],
    })
    const attempt = await beginMcpSignIn({ client: fake.client, directory: "D:\\#p", server: "docs" })
    expect(attempt.url).toBe("http://127.0.0.1:9/authorize?x=1")
    expect(await attempt.status()).toEqual({ status: "complete" })
    await attempt.cancel()
    expect(fake.calls).toEqual([
      "GET /api/mcp",
      `GET /api/integration/${MCP_ID}`,
      `POST /api/integration/${MCP_ID}/connect/oauth`,
      `GET /api/integration/${MCP_ID}/connect/oauth/con_1`,
      `DELETE /api/integration/${MCP_ID}/connect/oauth/con_1`,
    ])
  })

  test("a code-paste attempt is cancelled and refused (MCP accepts only the automatic flow)", async () => {
    const fake = server({
      servers: [{ name: "docs", status: { status: "needs_auth", error: "401" }, integrationID: MCP_ID }],
      mode: "code",
    })
    expect(await refused(beginMcpSignIn({ client: fake.client, directory: "D:\\p", server: "docs" }))).toBe("not_auto")
    expect(fake.calls.at(-1)).toBe(`DELETE /api/integration/${MCP_ID}/connect/oauth/con_1`)
  })
})

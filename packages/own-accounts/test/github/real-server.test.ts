// GitHub's real MCP server program (`github-mcp-server stdio`, 16 §5.1) under own's client, opt-in: set
// `OWN_GITHUB_MCP_BIN` to a downloaded, checksum-verified binary. Only `initialize` and `tools/list` run, with a fake
// fine-grained token (so the server checks no classic scopes at start) and every proxy variable pointed at a closed
// local port: nothing reaches GitHub. It shows own's stdio session, the toolsets and read-only mode as the program
// takes them, and that own's reads (`GitHubReads`, GH-15) are the program's read-only tools.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { GitHubMcp } from "../../src/github/mcp.js"
import { GitHubReads } from "../../src/github/reads.js"

setDefaultTimeout(60_000)

const BIN = process.env.OWN_GITHUB_MCP_BIN
const FAKE = "github_pat_11FAKEREAL0000_fakeRealServerToken00000000000000000Zz9"
const PROXIES = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY"]
const saved = new Map<string, string | undefined>()

// Any request the program would make goes to a closed port; the variables are this file's only while it runs.
beforeAll(() => {
  for (const name of PROXIES) saved.set(name, process.env[name])
  for (const name of PROXIES) process.env[name] = name === "NO_PROXY" ? "" : "http://127.0.0.1:9"
})

afterAll(async () => {
  await GitHubMcp.dropAll()
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const target = (readOnly: boolean): GitHubMcp.Target => ({
  account: "gh_00000000000000000000REALSV",
  server: { type: "local", command: BIN ?? "github-mcp-server", args: ["stdio"] },
  site: "https://github.com",
  token: FAKE,
  toolsets: ["context", "repos", "issues", "pull_requests"],
  readOnly,
})

describe.skipIf(!BIN)("github-mcp-server stdio under own's client", () => {
  test("lists its tools with read-only marks; read-only mode lists reads only", async () => {
    const full = await GitHubMcp.session(target(false))
    expect(full.server).toContain("github-mcp-server")
    const tools = await full.list()
    const names = tools.map((tool) => tool.name)
    for (const name of [
      "get_me",
      "get_file_contents",
      "list_pull_requests",
      "create_pull_request",
      "add_issue_comment",
    ])
      expect(names).toContain(name)
    expect(tools.find((tool) => tool.name === "get_file_contents")?.readOnlyHint).toBe(true)
    expect(tools.find((tool) => tool.name === "create_pull_request")?.readOnlyHint).toBe(false)
    // own counts as reads exactly the program's read-only tools.
    for (const tool of tools)
      expect(`${tool.name} ${GitHubReads.isRead(tool.name, tool.readOnlyHint, full.server)}`).toBe(
        `${tool.name} ${tool.readOnlyHint}`,
      )
    // A toolset left out is not listed.
    expect(names.some((name) => name.startsWith("list_workflow"))).toBe(false)
    const readOnly = await (await GitHubMcp.session(target(true))).list()
    expect(readOnly.length).toBeGreaterThan(0)
    expect(readOnly.every((tool) => tool.readOnlyHint)).toBe(true)
    expect(readOnly.some((tool) => tool.name === "create_pull_request")).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import TOOLS from "../../../codex-data/tools.win32.json" with { type: "json" }
import { CodexAgentsV1 } from "../../../src/codex/agents/v1.js"
import { Bm25 } from "../../../src/codex/bm25/index.js"
import { EnglishStemmer } from "../../../src/codex/bm25/stemmer.js"
import { ToolSearch } from "../../../src/codex/tool-search.js"

const index = new ToolSearch.Index(CodexAgentsV1.searchEntries())

function names(query: string, limit = ToolSearch.DEFAULT_LIMIT) {
  return index.rank(query, limit).map((entry) => entry.tool.name)
}

describe("tool_search definition", () => {
  test("matches what Codex sends gpt-5.5 with the deferred V1 tools (no source list since 0.167.0)", () => {
    const captured = (TOOLS.tools as ReadonlyArray<{ readonly type: string }>).find(
      (tool) => tool.type === "tool_search",
    )
    expect(JSON.stringify(ToolSearch.definition(index.sources(), "omit"))).toBe(JSON.stringify(captured))
  })

  test("lists sources once each, sorted, keeping the first description (Codex's spec test)", () => {
    const description = ToolSearch.description([
      {
        name: "Google Drive",
        description: "Use Google Drive as the single entrypoint for Drive, Docs, Sheets, and Slides work.",
      },
      { name: "Google Drive" },
      { name: "docs" },
    ])
    expect(description).toBe(
      "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nYou have access to tools from the following sources:\n- Google Drive: Use Google Drive as the single entrypoint for Drive, Docs, Sheets, and Slides work.\n- docs\nSome of the tools may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools. For MCP tool discovery, always use `tool_search` instead of `list_mcp_resources` or `list_mcp_resource_templates`.",
    )
  })

  test("omits the source list, or says none are enabled", () => {
    const omitted = ToolSearch.description([{ name: "Google Drive", description: "Search files." }], "omit")
    expect(omitted).not.toContain("You have access to tools from the following sources")
    expect(omitted).toContain("for the next model call.\n\nSome of the tools")
    expect(ToolSearch.description([])).toContain("following sources:\nNone currently enabled.\nSome of the tools")
  })

  test("bounds the source descriptions to 512 KiB while keeping every name", () => {
    const long = "🦀".repeat(20_000)
    const sources = Array.from({ length: 8 }, (_, index) => ({ name: `source-0${index}`, description: long }))
    const listed = ToolSearch.description(sources).split("following sources:\n")[1]!.split("\nSome of the tools")[0]!
    expect(new TextEncoder().encode(listed).length).toBeLessThanOrEqual(512 * 1024)
    expect(listed.startsWith("- source-00: 🦀")).toBe(true)
    expect(listed).toContain(long)
    expect(listed.split("\n").map((line) => line.slice(2).split(": ")[0])).toEqual(sources.map((source) => source.name))
  })
})

describe("BM25", () => {
  test("hashes tokens with fxhash32 (bm25 crate test vectors)", () => {
    expect(["space", "station", "Cup", "of", "tea"].map(Bm25.hash32)).toEqual([
      866767497, 666609503, 3568447556, 3221979461, 415655421,
    ])
  })

  test("tokenizes like the bm25 default English tokenizer", () => {
    expect(Bm25.tokenize("SPACE STATION")).toEqual(["space", "station"])
    expect(Bm25.tokenize("\tspace\r\nstation\n space       station")).toEqual(["space", "station", "space", "station"])
    expect(Bm25.tokenize("i me my myself we our ours ourselves you you're you've you'll you'd")).toEqual([])
    expect(Bm25.tokenize("42 1337 3.14")).toEqual(["42", "1337", "3.14"])
    expect(Bm25.tokenize("space, station! space,station")).toEqual(["space", "station", "space", "station"])
    expect(Bm25.tokenize("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")).toEqual([])
    expect(Bm25.tokenize("connection connections connective connected connecting connect")).toEqual(
      Array.from({ length: 6 }, () => "connect"),
    )
    expect(Bm25.tokenize("Café “résumé”")).toEqual(["cafe", "resum"])
  })

  test("splits words on UAX #29 boundaries", () => {
    expect(Bm25.words("can't 3.14 a.b a..b spawn_agent no-apps [?] x:y 1,000 _ __a")).toEqual([
      "can't",
      "3.14",
      "a.b",
      "a",
      "b",
      "spawn_agent",
      "no",
      "apps",
      "x:y",
      "1,000",
      "__a",
    ])
  })

  test("stems with the Snowball English stemmer (rust-stemmers vocabulary samples)", () => {
    const samples = {
      generous: "generous",
      communication: "communic",
      arsenal: "arsenal",
      skies: "sky",
      dying: "die",
      cries: "cri",
      ties: "tie",
      gaps: "gap",
      gas: "gas",
      hopping: "hop",
      hoping: "hope",
      agreed: "agre",
      proceed: "proceed",
      relational: "relat",
      delegation: "deleg",
      reasoning: "reason",
      yelling: "yell",
      "'apostrophe's": "apostroph",
    }
    expect(Object.fromEntries(Object.keys(samples).map((word) => [word, EnglishStemmer.stem(word)]))).toEqual(samples)
  })

  test("scores with f32 BM25 (k1 = 1.2, b = 0.75)", () => {
    // One token per document: value 1 and idf ln(1 + 1.5/1.5) = ln 2, the bm25 crate's 0.6931472.
    expect(new Bm25.Index(["space", "station"]).matches("space")).toEqual([{ id: 0, score: Math.fround(Math.LN2) }])
    // avgdl 3: `station` occurs twice, value 2·2.2/(2 + 1.2) = 1.375.
    const [match] = new Bm25.Index(["space station station"]).matches("station")
    expect(match!.score).toBe(Math.fround(Math.fround(Math.log(Math.fround(1 + Math.fround(0.5 / 1.5)))) * 1.375))
  })
})

describe("ranking the V1 tools", () => {
  test("indexes the search texts in registration order", () => {
    expect(index.entries.map((entry) => entry.tool.name)).toEqual([
      "spawn_agent",
      "send_input",
      "resume_agent",
      "wait_agent",
      "close_agent",
    ])
    expect(CodexAgentsV1.searchEntries().map((entry) => Bm25.tokenize(entry.searchText).join(" "))).toEqual([
      "spawn_ag spawn agent subag sub agent deleg deleg parallel work worker explor app fork model reason",
      "send_input send messag exist agent subag follow interrupt redirect queue target",
      "resume_ag resum reopen close agent subag thread id target",
      "wait_ag wait agent subag status final result complet timeout target",
      "close_ag close shutdown stop agent subag thread status target",
    ])
  })

  test("finds spawn_agent first for `spawn agent` (Codex's search_tool test, limit 1)", () => {
    expect(names("spawn agent", 1)).toEqual(["spawn_agent"])
  })

  test("orders representative queries", () => {
    expect(names("send message and wait")).toEqual(["send_input", "wait_agent"])
    expect(names("resume a closed agent")).toEqual([
      "resume_agent",
      "close_agent",
      "spawn_agent",
      "wait_agent",
      "send_input",
    ])
    expect(names("fork a worker with a different model")).toEqual(["spawn_agent"])
    expect(names("Spawning sub-agents for parallel work", 2)[0]).toBe("spawn_agent")
    expect(names("interrupt and redirect")).toEqual(["send_input"])
    expect(names("timeout")).toEqual(["wait_agent"])
    expect(names("status")).toEqual(["close_agent", "wait_agent"])
    expect(names("stop the worker")).toEqual(["close_agent", "spawn_agent"])
    expect(names("deploy to production")).toEqual([])
  })

  test("keeps registration order among equal scores (Codex's order there is random per process)", () => {
    // resume_agent and close_agent have the same length and share `close`, `thread`, `target`, `agent`, `subagent`.
    expect(names("thread")).toEqual(["resume_agent", "close_agent"])
    const [resume, close] = new Bm25.Index(index.entries.map((entry) => entry.searchText)).matches("thread")
    expect(resume!.score).toBe(close!.score)
  })
})

describe("tool_search calls", () => {
  test("answers the matched tools in their namespace with defer_loading", () => {
    const outcome = ToolSearch.handle(index, { query: "shutdown" })
    expect(outcome.kind).toBe("output")
    if (outcome.kind !== "output") return
    expect(JSON.stringify(outcome.tools)).toBe(
      '[{"type":"namespace","name":"multi_agent_v1","description":"Tools for spawning and managing sub-agents.","tools":[{"type":"function","name":"close_agent","description":"Close an agent and any open descendants when they are no longer needed, and return the target agent\'s previous status before shutdown was requested. Completed agents remain open and count toward the concurrency limit until closed. Don\'t keep agents open for too long if they are not needed anymore.","strict":false,"defer_loading":true,"parameters":{"type":"object","properties":{"target":{"type":"string","description":"Agent id to close (from spawn_agent)."}},"required":["target"],"additionalProperties":false}}]}]',
    )
  })

  test("merges every match into one namespace entry, in rank order", () => {
    const outcome = ToolSearch.handle(index, { query: "spawn agent" })
    if (outcome.kind !== "output") throw new Error("expected tools")
    expect(outcome.tools.map((namespace) => namespace.name)).toEqual(["multi_agent_v1"])
    const tools = outcome.tools[0]!.tools
    expect(tools.map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "resume_agent",
      "close_agent",
      "wait_agent",
      "send_input",
    ])
    tools.forEach((tool) => {
      expect(Object.keys(tool)).toEqual(["type", "name", "description", "strict", "defer_loading", "parameters"])
      const { defer_loading, ...definition } = tool
      expect(defer_loading).toBe(true)
      expect(definition).toEqual(CodexAgentsV1.DEFINITION.tools.find((candidate) => candidate.name === tool.name)!)
    })
    expect(tools[0]!.description).toContain("### When to delegate vs. do the subtask yourself")
  })

  test("wraps the output as a completed client tool_search_output", () => {
    expect(ToolSearch.outputItem("call-1", [])).toEqual({
      type: "tool_search_output",
      call_id: "call-1",
      status: "completed",
      execution: "client",
      tools: [],
    })
  })

  test("answers no tools for a blank query or a zero limit", () => {
    expect(ToolSearch.handle(index, { query: " \n" })).toEqual({
      kind: "output",
      tools: [],
      error: "query must not be empty",
    })
    expect(ToolSearch.handle(index, { query: "spawn", limit: 0 })).toEqual({
      kind: "output",
      tools: [],
      error: "limit must be greater than zero",
    })
    expect(ToolSearch.handle(new ToolSearch.Index([]), { query: "spawn" })).toEqual({ kind: "output", tools: [] })
  })

  test("applies the limit before merging", () => {
    const outcome = ToolSearch.handle(index, { query: "agent", limit: 2, other: true })
    if (outcome.kind !== "output") throw new Error("expected tools")
    expect(outcome.tools[0]!.tools.map((tool) => tool.name)).toEqual(["spawn_agent", "resume_agent"])
  })

  test("reports argument decoding failures with serde_json's texts", () => {
    const invalid = (args: unknown) => {
      const outcome = ToolSearch.handle(index, args)
      return outcome.kind === "invalid" ? outcome.text : undefined
    }
    expect(invalid({})).toBe("failed to parse tool_search arguments: missing field `query`")
    expect(invalid({ query: 5 })).toBe(
      "failed to parse tool_search arguments: invalid type: integer `5`, expected a string",
    )
    expect(invalid({ query: "x", limit: -1 })).toBe(
      "failed to parse tool_search arguments: invalid value: integer `-1`, expected usize",
    )
    expect(invalid({ query: "x", limit: 1.5 })).toBe(
      "failed to parse tool_search arguments: invalid type: floating point `1.5`, expected usize",
    )
    expect(invalid({ limit: "3", query: "x" })).toBe(
      'failed to parse tool_search arguments: invalid type: string "3", expected usize',
    )
    expect(invalid("spawn")).toBe(
      'failed to parse tool_search arguments: invalid type: string "spawn", expected struct SearchToolCallParams',
    )
    expect(invalid(null)).toBe(
      "failed to parse tool_search arguments: invalid type: null, expected struct SearchToolCallParams",
    )
    expect(invalid([])).toBe(
      "failed to parse tool_search arguments: invalid length 0, expected struct SearchToolCallParams with 2 elements",
    )
    expect(invalid(["a", 1, 2])).toBe(
      "failed to parse tool_search arguments: invalid length 3, expected fewer elements in array",
    )
    expect(ToolSearch.handle(index, ["spawn", 1]).kind).toBe("output")
    expect(ToolSearch.handle(index, { query: "spawn", limit: null }).kind).toBe("output")
  })
})

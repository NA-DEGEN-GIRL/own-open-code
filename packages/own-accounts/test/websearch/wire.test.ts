// own's ChatGPT web search, the pure part (`SearchWire`): the `/responses` body, the model choice and the reading of
// an answer. The fixtures are streams in the Codex backend's recorded shape (Responses events with a hosted
// `web_search_call`), every page and id made up.

import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { CodexModels } from "@own/protocol"
import { SearchWire } from "../../src/websearch/wire.js"

const fixture = (name: string) => Bun.file(path.join(import.meta.dir, "fixture", name)).text()

const BUN = "https://bun.example.test/blog/bun-v1.4"
const RELEASE = "https://github.example.test/oven-sh/bun/releases/tag/bun-v1.4.0"
const NEWS = "https://news.example.test/bun-1-4"

function list(models: ReadonlyArray<CodexModels.Model>): CodexModels.Snapshot {
  return { source: "backend", fetchedAt: 1, clientVersion: "0.157.0", models }
}

describe("SearchWire.body", () => {
  test("one streamed, unstored request with Codex's hosted web_search and a strict JSON answer", () => {
    const body = SearchWire.body({ model: "gpt-5.6-luna", effort: "low", query: "bun 1.4 release notes" })
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      instructions: SearchWire.INSTRUCTIONS,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "bun 1.4 release notes" }] }],
      tools: [{ type: "web_search", external_web_access: true }],
      tool_choice: "auto",
      reasoning: { effort: "low" },
      store: false,
      stream: true,
      include: ["web_search_call.action.sources"],
      text: { format: { type: "json_schema", name: "web_search_results", strict: true } },
    })
    // Strict structured output: every property required, nothing else allowed, at every level.
    const schema = body.text.format.schema
    expect(schema.required).toEqual(["results"])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.results.items.required).toEqual(["url", "title", "content"])
    expect(schema.properties.results.items.additionalProperties).toBe(false)
  })
})

describe("SearchWire.choose", () => {
  const row = (slug: string, extra: Partial<CodexModels.Model> = {}): CodexModels.Model => ({ slug, ...extra })

  test("the first preferred model the account's own list offers, else the shared list's", () => {
    const account = list([row("gpt-6-sol"), row("gpt-6-luna"), row("gpt-5.5")])
    const shared = list([row("gpt-5.6-luna"), row("gpt-6-luna")])
    expect(SearchWire.choose([account, shared]).model).toBe("gpt-6-luna")
    expect(SearchWire.choose([undefined, shared]).model).toBe("gpt-5.6-luna")
    expect(SearchWire.choose([list([]), shared]).model).toBe("gpt-5.6-luna")
  })

  test("a list without any preferred model takes its first model by Codex priority; no list takes gpt-5.6-luna", () => {
    const other = list([row("gpt-7-sol", { priority: 2 }), row("gpt-7-astra", { priority: 1 }), row("gpt-7-x")])
    expect(SearchWire.choose([other]).model).toBe("gpt-7-astra")
    expect(SearchWire.choose([undefined, undefined])).toEqual({ model: "gpt-5.6-luna", effort: "low" })
  })

  test("effort low when listed or nothing is listed, else the lowest level that can search", () => {
    const levels = (...efforts: string[]) => efforts.map((effort) => ({ effort }))
    const effort = (model: CodexModels.Model) => SearchWire.choose([list([model])]).effort
    expect(effort(row("gpt-5.6-luna", { supported_reasoning_levels: levels("low", "medium", "high") }))).toBe("low")
    expect(effort(row("gpt-5.6-luna"))).toBe("low")
    expect(effort(row("gpt-5.6-luna", { supported_reasoning_levels: levels("minimal", "medium", "high") }))).toBe(
      "medium",
    )
  })
})

describe("SearchWire.read and results", () => {
  test("the structured answer: its results in order, each page once, http(s) only", async () => {
    const read = SearchWire.read(await fixture("answer-json.sse"))
    expect(read.end).toBe("completed")
    expect(read.items.map((item) => item.type)).toEqual(["reasoning", "web_search_call", "web_search_call", "message"])
    expect(SearchWire.results(read.items)).toEqual([
      {
        url: BUN,
        title: "Bun v1.4",
        content: "Bun 1.4 adds a built-in SQL client and speeds up bun install by 30% on Windows.",
        time: {},
      },
      {
        url: RELEASE,
        title: "Release bun-v1.4.0 · oven-sh/bun",
        content: "The 1.4.0 release lists 212 fixes, including Windows path handling in bun test.",
        time: {},
      },
    ])
  })

  test("prose with url_citation annotations: cited pages (title, cited line), then the pages the searches read", async () => {
    const read = SearchWire.read(await fixture("answer-cited.sse"))
    expect(read.end).toBe("completed")
    // OpenAI's `utm_source=openai` tag is dropped, so a cited page and the same page from the sources are one result.
    expect(SearchWire.results(read.items)).toEqual([
      { url: BUN, title: "Bun v1.4", content: "Bun 1.4 adds a built-in SQL client.", time: {} },
      { url: RELEASE, title: "Release bun-v1.4.0", content: "Its release notes list 212 fixes.", time: {} },
      { url: NEWS, time: {} },
    ])
  })

  test("an empty structured answer falls back to the pages the searches read", () => {
    const items = [
      {
        type: "web_search_call",
        action: { type: "search", sources: [{ url: NEWS }, { url: "ftp://files.example.test/" }] },
      },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [] }), annotations: [] }] },
    ]
    expect(SearchWire.results(items)).toEqual([{ url: NEWS, time: {} }])
  })

  test("at most LIMIT results", () => {
    const results = Array.from({ length: 14 }, (_, index) => ({
      url: `https://page${index}.example.test/`,
      title: `page ${index}`,
      content: "x",
    }))
    const items = [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ results }) }] }]
    expect(SearchWire.results(items)).toHaveLength(SearchWire.LIMIT)
  })

  test("output items from the terminal event when no output_item.done came; a cut stream keeps what arrived", async () => {
    const text = await fixture("answer-json.sse")
    const blocks = text.split("\n\n").filter((block) => block !== "")
    const completedOnly = blocks.filter((block) => !block.startsWith("event: response.output_item.done")).join("\n\n")
    const fromTerminal = SearchWire.read(completedOnly)
    expect(fromTerminal.end).toBe("completed")
    expect(SearchWire.results(fromTerminal.items).map((result) => result.url)).toEqual([BUN, RELEASE])
    const cut = SearchWire.read(blocks.filter((block) => !block.startsWith("event: response.completed")).join("\n\n"))
    expect(cut.end).toBe("cut")
    expect(SearchWire.results(cut.items).map((result) => result.url)).toEqual([BUN, RELEASE])
  })

  test("a failed response names its error code; malformed events are skipped", () => {
    const failed = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_x","status":"in_progress","output":[]}}',
      "",
      "data: { not json",
      "",
      "event: response.failed",
      'data: {"type":"response.failed","response":{"id":"resp_x","status":"failed","error":{"code":"server_error","message":"secret-free"}}}',
      "",
    ].join("\n")
    expect(SearchWire.read(failed)).toEqual({ items: [], end: "failed", code: "server_error" })
    expect(SearchWire.read('data: {"type":"error","code":"usage_limit_reached"}\n\n')).toEqual({
      items: [],
      end: "failed",
      code: "usage_limit_reached",
    })
    expect(SearchWire.read("")).toEqual({ items: [], end: "cut" })
  })
})

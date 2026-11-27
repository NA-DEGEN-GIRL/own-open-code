// Live check of own-accounts' ChatGPT web search request (src/websearch/wire.ts) against the real Codex backend through
// the local forwarder: whether the backend takes the request shape per model, how long a search takes, what comes
// back, and whether the answer carries x-codex-* usage headers. Prints no credential.
//
//   bun script/live/websearch.ts [--alias 01] [--models gpt-5.6-luna,gpt-6-luna,gpt-5.5] [--query "..."]
import os from "node:os"
import path from "node:path"
import { SearchWire } from "../../../own-accounts/src/websearch/wire.js"
import { startForwarder } from "./forwarder.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const alias = option("alias") ?? "01"
const models = (option("models") ?? SearchWire.MODELS.join(",")).split(",")
const query = option("query") ?? "Bun 1.4 release notes zstd compression support"

const forwarder = startForwarder(path.join(os.tmpdir(), "own-live-websearch.jsonl"))
try {
  for (const model of models) {
    const started = Date.now()
    const response = await fetch(`${forwarder.url}/chatgpt/${alias}/responses`, {
      method: "POST",
      headers: { originator: "opencode", "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(SearchWire.body({ model, effort: "low", query })),
    })
    const text = await response.text()
    const read = SearchWire.read(text)
    const results = SearchWire.results(read.items)
    console.log(
      JSON.stringify({
        model,
        status: response.status,
        seconds: (Date.now() - started) / 1000,
        end: read.end,
        code: read.code,
        usageHeaders: [...response.headers.keys()].filter((name) => name.startsWith("x-codex-")).length,
        searches: read.items.filter((item) => item.type === "web_search_call").length,
        results: results.map((result) => ({ url: result.url, title: result.title, content: result.content?.slice(0, 120) })),
        ...(response.ok ? {} : { error: text.slice(0, 300) }),
      }),
    )
  }
} finally {
  await forwarder.stop()
}

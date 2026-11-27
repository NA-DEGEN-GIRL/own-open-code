// 설정 > 웹 검색 e2e backend (03 §18.2, WM 2026-10-19): the real server from source with own.accounts through own-team's
// e2e harness without own.team (three linked ChatGPT accounts on one fake Codex backend, DeepSeek and Anthropic API
// accounts), core's config watcher on (a `websearch.set` reaches core as in an installed service), and the e2e kit's
// search service `fake-search` and its memory stand-in for core's keyless `parallel` (option `parallel`, same id and
// name, so the free-service hint can be shown without the network). The DeepSeek model calls `websearch` on
// `[websearch] <query>`; the fake Codex backend answers ChatGPT's search requests (the hosted `web_search` tool) with
// own-accounts' recorded stream. Core's other keyless services (Exa, Firecrawl, Tavily, TinyFish) are listed but never
// chosen here, so no query leaves this PC. own's keyed variants of those five (`own-exa` …, SK 2026-10-23) ask the e2e
// kit's fakes of the five services (`startFakeSearchServices`), which take the fake keys in the state file. Vite dev serves
// own-web (proxy with server-side Basic auth, like e2e/backend.ts). Fake credentials only, 127.0.0.1 only; the temp
// root is removed on exit. Run by this suite's Playwright webServer or by hand: `bun e2e/websearch/backend.ts`.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { afterToolResult, lastUserText, WEBSEARCH_FIXTURE_PLUGIN } from "../../../own-accounts/test/e2e-kit"
import { startFakeAnthropic } from "../../../own-accounts/test/e2e-kit/fakes/anthropic"
import { startFakeCodex } from "../../../own-accounts/test/e2e-kit/fakes/codex"
import { startFakeOpenAIChat } from "../../../own-accounts/test/e2e-kit/fakes/openai-chat"
import { startFakeSearchServices } from "../../../own-accounts/test/e2e-kit/fakes/search-services"
import { isRecord, parseSse, type RecordedRequest, type Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { REPO_ROOT } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { CHATGPT, MODEL, startTeamServer } from "../../../own-team/test/e2e/harness"

export const WEBSEARCH_PORT = Number(process.env.OWN_WEB_WEBSEARCH_E2E_PORT ?? 6791)
export const WEBSEARCH_TMP = process.env.OWN_WEB_WEBSEARCH_E2E_TMP ?? path.join(os.tmpdir(), "own-web-websearch")
export const STATE_FILE = path.join(WEBSEARCH_TMP, "backend.json")

const ANSWER = parseSse(
  await Bun.file(path.join(REPO_ROOT, "packages/own-accounts/test/websearch/fixture/answer-json.sse")).text(),
).map((event) => event.data as Record<string, unknown>)

/** The scripted models: a tool result gets a short text; `[websearch] <query>` calls the websearch tool. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "검색 결과를 읽었어요." }
  const directive = lastUserText(request).match(/\[websearch\] (.+)/)
  if (directive) return { type: "tool-call", name: "websearch", input: { query: directive[1]!.trim() } }
  return { type: "text", text: "답변" }
}

const cache = { minTokens: 0, blockTokens: 32 }
const codex = startFakeCodex({
  cache,
  responder: reply,
  events: (body) =>
    Array.isArray(body.tools) && body.tools.some((tool) => isRecord(tool) && tool.type === "web_search")
      ? ANSWER
      : undefined,
  usagePerRequest: { primary: 0, secondary: 0 },
})
const deepseek = startFakeOpenAIChat({ cache, responder: reply })
const anthropic = startFakeAnthropic({ cache, responder: reply })
/** Fake keys of the five services (the page types them in); the fakes answer only these. */
const searchKeys = {
  exa: "fake-exa-web-e2e-Wb3x",
  firecrawl: "fc-fake-web-e2e-Fw4y",
  parallel: "fake-parallel-web-e2e-Pw5z",
  tavily: "tvly-fake-web-e2e-Tw6a",
  tinyfish: "fake-tinyfish-web-e2e-Tw7b",
}
const search = startFakeSearchServices(searchKeys)
const fakes = {
  codex,
  deepseek,
  anthropic,
  tokens: {
    "01": codex.login(CHATGPT["01"]),
    "02": codex.login(CHATGPT["02"]),
    "03": codex.login(CHATGPT["03"]),
  },
  stop: async () => {
    await Promise.all([codex.stop(), deepseek.stop(), anthropic.stop(), search.stop()])
  },
}

const team = await startTeamServer({
  name: "websearch-menu",
  team: false,
  fakes,
  project: "none",
  watchConfig: true,
  // `parallel: true`: the kit's plugin also stands in for core's keyless Parallel (same id, from memory).
  plugins: [{ package: WEBSEARCH_FIXTURE_PLUGIN, options: { parallel: true } }],
  accountsOptions: { ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json") },
  accountsEndpoints: search.endpoints,
})
const session = await team.createSession({ model: MODEL.deepseek, title: "웹 검색 시험" })

const password = atob(team.server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: team.server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: team.control,
})
const dev = await startViteDev({ port: WEBSEARCH_PORT, hmr: false })

const state = {
  dev: `http://127.0.0.1:${WEBSEARCH_PORT}`,
  control: team.control,
  config: team.configFile,
  session: { id: session, title: "웹 검색 시험" },
  searchKeys,
}
await fs.mkdir(WEBSEARCH_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_WEBSEARCH_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await team.stop()
  await fakes.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

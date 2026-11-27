// Session-UX e2e backend (03 §19.10 notes, 19.11 pin/archive/ID search/date groups, 19.14 timeline presets; the find
// suite runs on fixtures without it). Run by Playwright's webServer (playwright.config.ts) or by hand:
// `bun e2e/session-ux/backend.ts`.
//
// The real upstream server from source with own.accounts + own.telemetry (packages/own-accounts/test/e2e-kit), a fake
// OpenAI Responses provider that answers every prompt with a short text, and one API-key account made through RPC.
// Four sessions are seeded with last-activity times of now, yesterday, three days ago and forty days ago (written into
// the temp database, since the API always stamps "now") for the date groups. A small JSON endpoint on 127.0.0.1 lets
// the tests read the model requests the fake received (prefix checks for model-visible notes). Fake credentials only;
// everything lives under a temp root that is removed on exit.
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { isRecord, type RecordedRequest, type Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"

export const UX_PORT = Number(process.env.OWN_WEB_SESSION_UX_PORT ?? 5733)
export const UX_TMP = process.env.OWN_WEB_SESSION_UX_TMP ?? path.join(os.tmpdir(), "own-web-session-ux")
export const STATE_FILE = path.join(UX_TMP, "backend.json")

const MODEL = "gpt-5.5"
// Fake credential only.
const KEY = "sk-proj-ownSessionUxFakeKey00000000000001"
const DAY = 24 * 60 * 60_000

const responses = startFakeOpenAIResponses({ models: [MODEL], responder: reply })
const server = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-web-ux-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
    }),
})

const control = path.join(server.paths.ownHome, "control")
await fs.mkdir(control, { recursive: true })

async function rpc(method: string, input: unknown, directory: string) {
  const response = await server.request("POST", `/api/rpc/own.accounts/${method}`, {
    body: { input },
    query: { "location[directory]": directory },
    directory,
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

const added = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: KEY }, control)
const account = added.account as { id: string; providerID: string }
await server.waitForModels([{ providerID: account.providerID, id: MODEL }])

// Date-group seeds (19.11): created through the API, then their last activity moved back in the temp database.
const now = Date.now()
const seeds = [
  { title: "오늘 세션", updated: now - 60_000 },
  { title: "어제 세션", updated: startOfDay(now) - DAY / 2 },
  { title: "사흘 전 세션", updated: startOfDay(now) - 3 * DAY + DAY / 2 },
  { title: "오래된 세션", updated: now - 40 * DAY },
]
const seeded = []
for (const seed of seeds) {
  const session = await server.createSession({
    title: seed.title,
    model: { providerID: account.providerID, id: MODEL },
  })
  seeded.push({ id: session.id, title: seed.title, updated: seed.updated })
}
const db = new Database(server.paths.database)
db.exec("PRAGMA busy_timeout = 5000")
const age = db.prepare("UPDATE session_v2 SET time_updated = ?, time_created = ? WHERE id = ?")
for (const seed of seeded) age.run(seed.updated, seed.updated, seed.id)
db.close()

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: UX_PORT })

// Model requests the fake received: `GET /requests` → [{ seq, instructions, input }] (tests compare prefixes).
const inspect = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/requests") return new Response("not found", { status: 404 })
    return Response.json(responses.requests.filter(isModelRequest).map(summary))
  },
})

const state = {
  dev: `http://127.0.0.1:${UX_PORT}`,
  inspect: `http://127.0.0.1:${inspect.port}`,
  control,
  workspace: server.paths.workspace,
  model: MODEL,
  account: { id: account.id, providerID: account.providerID, label: "Alpha" },
  seeded,
}
await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_SESSION_UX_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  inspect.stop(true)
  await dev.close().catch(() => undefined)
  await server.stop()
  await responses.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

// ---------------------------------------------------------------------------------------------------------------

/** Every prompt gets a short answer; titles and summaries fixed ones. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "작업 세션" }
  if (request.body.includes("You MUST use this format for your response"))
    return { type: "text", text: "## Objective\n- 테스트" }
  const input = isRecord(request.json) && Array.isArray(request.json.input) ? request.json.input : []
  return { type: "text", text: `답변 ${input.length}` }
}

function isModelRequest(request: RecordedRequest) {
  return (
    request.path.startsWith("/v1/responses") &&
    !request.body.includes("You name conversations so the user can find them later") &&
    !request.body.includes("You MUST use this format for your response")
  )
}

function summary(request: RecordedRequest) {
  const json = isRecord(request.json) ? request.json : {}
  return {
    seq: request.seq,
    instructions: json.instructions ?? null,
    input: Array.isArray(json.input) ? json.input : [],
  }
}

function startOfDay(at: number) {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

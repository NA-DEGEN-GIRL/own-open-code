// 설정 > 에이전트 방식 e2e backend (10 §3.11): the real server from source with own.accounts and own.harness (the plugin
// as the release loads it, options at their defaults: Codex 방식, 개선판), a fake OpenAI Responses provider behind one
// API-key account, and one conversation so the sidebar has a project. Vite dev serves own-web (proxy with server-side
// Basic auth, like e2e/backend.ts). A small control server beside it answers `GET /requests` with the request bodies
// the fake received, so the spec can check what a conversation on 내 지시문 really sent. Fake credentials only,
// 127.0.0.1 only; the temp root is removed on exit. Run by this suite's Playwright webServer or by hand:
// `bun e2e/prompts/backend.ts` (from packages/own-web).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"

export const PROMPTS_PORT = Number(process.env.OWN_WEB_PROMPTS_E2E_PORT ?? 6761)
export const PROMPTS_TMP = process.env.OWN_WEB_PROMPTS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-prompts")
export const STATE_FILE = path.join(PROMPTS_TMP, "backend.json")

const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownWebPromptsE2eFakeKey00000001"

const responses = startFakeOpenAIResponses({ models: [MODEL] })
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
            buildId: `own-web-prompts-e2e-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        // own-harness, then own-omo last, as the installer lists them (own-accounts `plugins/inventory.ts`). own-omo
        // needs its runtime built (`bun script/bundle.ts` in packages/own-omo, or OWN_OMO_RUNTIME).
        { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
        { package: path.join(REPO_ROOT, "packages/own-omo"), options: {} },
      ],
    }),
})

const control = path.join(server.paths.ownHome, "control")
await fs.mkdir(control, { recursive: true })

async function rpc(id: string, method: string, input: unknown, directory: string) {
  const response = await server.request("POST", `/api/rpc/${id}/${method}`, {
    body: { input },
    query: { "location[directory]": directory },
    directory,
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`${id} ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

const added = await rpc("own.accounts", "accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY }, control)
const account = added.account as { id: string; providerID: string }
await server.waitForModels([{ providerID: account.providerID, id: MODEL }])
// own.harness answers at the control location once its plugin is active.
for (let attempt = 0; ; attempt++) {
  const ready = await rpc("own.harness", "list", {}, control).then(
    () => true,
    () => false,
  )
  if (ready) break
  if (attempt === 100) throw new Error("own.harness never answered")
  await Bun.sleep(200)
}
const session = await server.createSession({
  title: "지시문 시험",
  model: { providerID: account.providerID, id: MODEL },
})

const requests = Bun.serve({
  hostname: "127.0.0.1",
  port: PROMPTS_PORT + 1,
  fetch: (request) =>
    new URL(request.url).pathname === "/requests"
      ? Response.json(responses.requests.flatMap((entry) => (entry.method === "POST" ? [entry.json] : [])))
      : new Response("not found", { status: 404 }),
})

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: PROMPTS_PORT, hmr: false })

const state = {
  dev: `http://127.0.0.1:${PROMPTS_PORT}`,
  requests: `http://127.0.0.1:${PROMPTS_PORT + 1}/requests`,
  control,
  workspace: server.paths.workspace,
  account: { id: account.id, providerID: account.providerID },
  model: MODEL,
  session: { id: session.id, title: "지시문 시험" },
}
await fs.mkdir(PROMPTS_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_PROMPTS_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  void requests.stop(true)
  await server.stop()
  await responses.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

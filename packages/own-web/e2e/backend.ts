// E2E backend (run by Playwright's webServer, or by hand: `bun e2e/backend.ts`): boots the real upstream server
// from source with own.accounts + own.telemetry (packages/own-accounts/test/e2e-kit), a fake OpenAI provider, one
// API-key account created through RPC and a few sessions, then serves own-web through Vite dev (proxy with
// server-side Basic auth, the dev path of 03 §16.2) and through `vite preview` of the production build (CSP).
// Fake credentials only; everything lives in a temp directory that is removed on exit.
import fs from "node:fs/promises"
import path from "node:path"
import { preview } from "vite"
import { startViteDev } from "./vite-dev"
import { opencodeConfig } from "../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeOpenAIResponses } from "../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { checkoutTmp } from "./gateway/support"

export const DEV_PORT = Number(process.env.OWN_WEB_E2E_DEV_PORT ?? 5199)
export const PREVIEW_PORT = Number(process.env.OWN_WEB_E2E_PREVIEW_PORT ?? 5198)
export const STATE_FILE = path.join(checkoutTmp("own-web-e2e"), "backend.json")

const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownWebE2eFakeKey0000000000000001"
const PACKAGE = path.join(REPO_ROOT, "packages/own-web")

// A conversation whose messages hold `[slow <ms>]` waits that long for each answer, so its turn stays running (shell.spec:
// the 에이전트 방식 menu of a running conversation). One holding `[summary ok]` gets a template summary when core asks
// for one, so its compaction completes (context-reset.spec). Every other request gets the fake's default answer, which
// fails a compaction (transcript.spec). A side question (03 §4.4.2) gets `곁질문 답` after 1.5 s, or the follow-up's answer.
// (side-question.spec).
const responses = startFakeOpenAIResponses({
  models: [MODEL],
  responder: (request) => {
    if (request.body.includes("[summary ok]") && request.body.includes("structured summary"))
      return { type: "text", text: "## Objective\n- e2e summary" }
    if (request.body.includes("<side-question>"))
      return {
        type: "text",
        text: request.body.includes("이어서 묻기") ? "이어진 곁질문 답이에요." : "곁질문 답이에요: **재시도는 세 번**이에요.",
        delayMs: 1_500,
      }
    const slow = /\[slow (\d+)\]/.exec(request.body)
    return slow ? { type: "text", text: "천천히 답했어요.", delayMs: Number(slow[1]) } : undefined
  },
})
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
            buildId: `own-web-e2e-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            // Old-app import root (02 §3.2a): an empty directory in the temp root, never the real codex-multi-provider
            // control center that own.accounts reads by default. dev/service.ts has fake profiles for import flows.
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

const added = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY }, control)
const account = added.account as { id: string; providerID: string }
await server.waitForModels([{ providerID: account.providerID, id: MODEL }])
const titles = ["계정 라우터 RPC 설계", "결제 웹훅 재시도", "own-web 뼈대"]
const sessions = []
for (const title of titles)
  sessions.push(await server.createSession({ title, model: { providerID: account.providerID, id: MODEL } }))

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: DEV_PORT })
const built = await Bun.file(path.join(PACKAGE, "dist/index.html")).exists()
// test:e2e:all built dist/ before any suite (OWN_WEB_DIST_BUILT=1): a missing one there fails instead of skipping PF1.
if (!built && process.env.OWN_WEB_DIST_BUILT === "1") throw new Error("OWN_WEB_DIST_BUILT=1 but dist/ has no build")
const previewServer = built
  ? await preview({
      configFile: path.join(PACKAGE, "vite.config.ts"),
      root: PACKAGE,
      preview: { port: PREVIEW_PORT, strictPort: true, host: "127.0.0.1" },
      logLevel: "warn",
    })
  : undefined

const state = {
  dev: `http://127.0.0.1:${DEV_PORT}`,
  preview: previewServer ? `http://127.0.0.1:${PREVIEW_PORT}` : null,
  control,
  workspace: server.paths.workspace,
  account: { id: account.id, providerID: account.providerID, label: "Alpha" },
  model: MODEL,
  sessions: sessions.map((session, index) => ({ id: session.id, title: titles[index] })),
}
await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_E2E_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await Promise.allSettled([dev.close(), previewServer?.close()])
  await server.stop()
  await responses.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

// Palette + shell settings e2e backend (03 §3 명령 팔레트, §10 단축키, §19.8 셸 선택), run by this suite's Playwright
// webServer (or by hand: `bun e2e/palette-shell/backend.ts`). Fake credentials only; one temp root removed on exit.
//   - the real server from source with own.accounts + own.telemetry and a fake OpenAI Responses provider whose
//     requests the spec reads back (`/__e2e/model-requests` on a loopback helper: the shell tool's description),
//   - two API-key accounts (Alpha, Bravo) for the palette's "계정으로 전환…" rows,
//   - two project folders; named sessions plus 120 filler sessions (the palette list must stay windowed),
//   - the global config lives in the temp root (OPENCODE_CONFIG_DIR), so `PATCH /api/experimental/config {shell}` never
//     touches the developer's real config; Vite dev on its own port.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"

export const PORT = Number(process.env.OWN_WEB_PALETTE_E2E_PORT ?? 5377)
export const TMP = process.env.OWN_WEB_PALETTE_E2E_TMP ?? path.join(os.tmpdir(), "own-web-palette-shell-e2e")
export const STATE_FILE = path.join(TMP, "backend.json")

const MODEL = "gpt-5.5"
const KEYS = {
  alpha: "sk-proj-ownPaletteAlphaFakeKey000000000001",
  bravo: "sk-proj-ownPaletteBravoFakeKey000000000002",
}
const FILLER = 120

const responses = startFakeOpenAIResponses({ models: [MODEL] })
const helper = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/__e2e/model-requests") return new Response("not found", { status: 404 })
    return Response.json(
      responses.requests.map((item) => ({ path: item.path, json: item.json })),
      {
        headers: { "access-control-allow-origin": "*" },
      },
    )
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
            buildId: `own-web-palette-e2e-${process.pid}`,
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
const projects = path.join(server.paths.root, "projects")
const folders = { alpha: path.join(projects, "alpha app"), beta: path.join(projects, "베타 프로젝트") }
await Promise.all([control, ...Object.values(folders)].map((directory) => fs.mkdir(directory, { recursive: true })))

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
const account = async (label: string, key: string) => {
  const added = await rpc("accounts.add.key", { kind: "oai", label, key }, control)
  const value = added.account as { id: string; providerID: string }
  return { id: value.id, providerID: value.providerID, label }
}
const alpha = await account("Alpha", KEYS.alpha)
const bravo = await account("Bravo", KEYS.bravo)
await server.waitForModels([alpha, bravo].map((item) => ({ providerID: item.providerID, id: MODEL })))
const model = { providerID: alpha.providerID, id: MODEL }

// Filler first (oldest), then the named sessions, so the named ones head the list.
for (let index = 0; index < FILLER; index++)
  await server.createSession({
    title: `더미 세션 ${String(index + 1).padStart(3, "0")}`,
    model,
    directory: folders.beta,
  })
const sessions = {
  fix: await server.createSession({ title: "터미널 고치기", model, directory: folders.beta }),
  search: await server.createSession({ title: "세션 검색 테스트", model, directory: folders.alpha }),
  alpha: await server.createSession({ title: "알파 작업", model, directory: folders.alpha }),
}

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: PORT })

const state = {
  dev: `http://127.0.0.1:${PORT}`,
  helper: `http://127.0.0.1:${helper.port}`,
  control,
  configDir: server.paths.config,
  folders,
  accounts: { alpha, bravo },
  sessions: { fix: sessions.fix.id, search: sessions.search.id, alpha: sessions.alpha.id },
}
await fs.mkdir(TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_PALETTE_E2E_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await server.stop()
  await responses.stop()
  helper.stop(true)
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

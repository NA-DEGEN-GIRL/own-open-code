// Server sections e2e backend (03 §4.3), run by this suite's Playwright webServer (or by hand:
// `bun e2e/sections/backend.ts`). Fake credentials only; every temp root is removed on exit.
//   - two real servers from source with own.accounts: this PC's, and one the harness lists as an SSH host
//     (harness.tsx answers own.remote itself, so nothing here speaks SSH),
//   - a loopback front for the second one, which adds the CORS headers own-remote's tunnel has and can answer
//     `projectList.*` like an older service (`/__e2e/old?on=1`),
//   - projects with conversations on both; a filler project so the list is long.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"

export const PORT = Number(process.env.OWN_WEB_SECTIONS_E2E_PORT ?? 5419)
export const TMP = process.env.OWN_WEB_SECTIONS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-sections-e2e")
export const STATE_FILE = path.join(TMP, "backend.json")

const MODEL = "gpt-5.5"
const responses = startFakeOpenAIResponses({ models: [MODEL] })

const LOCAL = {
  "own-open-code": ["계정 라우터 RPC 설계", "사이드바 정리", "릴리스 점검"],
  "demo-game": ["던전 생성기 시드 고정", "세이브 파일 v3"],
  "결제 웹훅": ["재시도 간격 정하기"],
  "notes-app": ["오프라인 동기화", "검색 색인"],
  "긴 이름을 가진 프로젝트 폴더 아주 길게": ["긴 이름 확인"],
}
const HOST = {
  test001: ["Test message"],
  "example-game": ["빌드 스크립트 정리", "에셋 파이프라인"],
  "api-server": ["로그 줄이기"],
}

async function boot(name: string, projects: Readonly<Record<string, readonly string[]>>, filler: number) {
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
              buildId: `own-web-sections-${name}-${process.pid}`,
              vault: "memory",
              ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
              endpoints: { openai: responses.baseURL },
              codexImportRoot: path.join(paths.root, "legacy-control-center"),
              conversationFolder: path.join(paths.root, "chats"),
            },
          },
        ],
      }),
  })
  const control = path.join(server.paths.ownHome, "control")
  await fs.mkdir(control, { recursive: true })
  async function rpc(method: string, input: unknown) {
    const response = await server.request("POST", `/api/rpc/own.accounts/${method}`, {
      body: { input },
      query: { "location[directory]": control },
      directory: control,
    })
    const body = (await response.json()) as { output?: Record<string, unknown> }
    if (!response.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
    return body.output ?? {}
  }
  const added = await rpc("accounts.add.key", {
    kind: "oai",
    label: "개인 Pro",
    key: "sk-proj-ownSectionsFakeKey00000000000001",
  })
  const account = added.account as { id: string; providerID: string }
  await server.waitForModels([{ providerID: account.providerID, id: MODEL }])
  const model = { providerID: account.providerID, id: MODEL }
  const folder = (project: string) => path.join(server.paths.root, "projects", project)
  const sessions: Record<string, string> = {}
  const create = async (project: string, title: string, directory: string) => {
    await fs.mkdir(directory, { recursive: true })
    sessions[`${project}/${title}`] = (await server.createSession({ title, model, directory })).id
  }
  for (let index = 0; index < filler; index++)
    await create("filler", `더미 ${String(index + 1).padStart(3, "0")}`, folder("filler"))
  // The last project made is the newest, so the list shows them in the order written here.
  for (const [project, titles] of Object.entries(projects).toReversed())
    for (const title of titles.toReversed()) await create(project, title, folder(project))
  if (name === "local") await create("chats", "Quick test", path.join(server.paths.root, "chats"))
  const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
  return { server, control, sessions, password, folder }
}

const local = await boot("local", LOCAL, 40)
const host = await boot("host", HOST, 0)

const mode = { old: false }
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-expose-headers": "*",
}
const front = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/__e2e/old") {
      mode.old = url.searchParams.get("on") === "1"
      return new Response("ok", { headers: CORS })
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("origin")
    const old = mode.old && url.pathname.includes("/projectList.")
    const target = old ? url.pathname.replace("/projectList.", "/noSuchMethod.") : url.pathname
    const response = await fetch(`${host.server.url}${target}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
    })
    const answer = new Headers(response.headers)
    for (const [name, value] of Object.entries(CORS)) answer.set(name, value)
    answer.delete("content-encoding")
    answer.delete("content-length")
    return new Response(response.body, { status: response.status, headers: answer })
  },
})

Object.assign(process.env, {
  OWN_WEB_API_URL: local.server.url,
  OWN_WEB_API_PASSWORD: local.password,
  OWN_WEB_CONTROL_DIR: local.control,
})
const dev = await startViteDev({ port: PORT })

const state = {
  dev: `http://127.0.0.1:${PORT}`,
  front: `http://127.0.0.1:${front.port}`,
  hostToken: host.password,
  hostControl: host.control,
  local: { sessions: local.sessions, control: local.control },
  host: { sessions: host.sessions },
}
await fs.mkdir(TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_SECTIONS_E2E_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await Promise.all([local.server.stop(), host.server.stop()])
  await responses.stop()
  front.stop(true)
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

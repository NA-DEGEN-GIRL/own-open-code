// Workspace e2e backend (project open 03 §18.3, MCP 03 §18.14, browser tool policy 01 §10.1), run by this suite's
// Playwright webServer: the real server from source with own.accounts + own.telemetry, a fake OpenAI provider and an
// API-key account made through RPC (like e2e/backend.ts), plus
// - project folders with a Git repository, a `#`/`%`/space/Hangul name and 500 subfolders (fs.list windowing),
// - five MCP servers in the global config: Code Mode (`docs`), direct tools (`direct`), OAuth (`secure`, needs_auth
//   until the e2e signs in through the fake authorization server), unreachable (`broken`) and disabled (`off`),
// then Vite dev on its own port. Fake credentials only; everything lives in temp directories removed on exit.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { startFakeMcp } from "./fake-mcp"

export const DEV_PORT = Number(process.env.OWN_WEB_WORKSPACE_E2E_PORT ?? 5231)
export const STATE_FILE = path.join(os.tmpdir(), "own-web-workspace-e2e", "backend.json")

const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownWebWorkspaceFakeKey000000000001"
const HASH_FOLDER = "#1 한글 프로젝트 100%"

const responses = startFakeOpenAIResponses({ models: [MODEL] })
// The test side reads what the model was sent (Code Mode catalog with or without browser tools) through this route.
const mcp = startFakeMcp((request, url) => {
  if (url.pathname !== "/__e2e/model-requests") return undefined
  return Response.json(responses.requests.map((item) => ({ path: item.path, body: item.body })))
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
            buildId: `own-web-workspace-e2e-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
      extra: {
        mcp: {
          timeout: { startup: 5_000 },
          servers: {
            docs: { type: "remote", url: `${mcp.url}/open/mcp`, oauth: false },
            direct: { type: "remote", url: `${mcp.url}/direct/mcp`, oauth: false, codemode: false },
            secure: { type: "remote", url: `${mcp.url}/secure/mcp` },
            broken: { type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false },
            off: { type: "remote", url: `${mcp.url}/off/mcp`, oauth: false, disabled: true },
          },
        },
      },
    }),
})

const control = path.join(server.paths.ownHome, "control")
const projects = path.join(server.paths.root, "projects")
const folders = {
  alpha: path.join(projects, "alpha app"),
  hash: path.join(projects, HASH_FOLDER),
  many: path.join(projects, "many"),
  empty: path.join(projects, "empty"),
}
await Promise.all([control, ...Object.values(folders)].map((directory) => fs.mkdir(directory, { recursive: true })))
await Promise.all(
  Array.from({ length: 500 }, (_, index) =>
    fs.mkdir(path.join(folders.many, `d${String(index + 1).padStart(4, "0")}`), { recursive: true }),
  ),
)
await git(folders.alpha, ["init", "-b", "main"])
await git(folders.alpha, [
  "-c",
  "user.email=e2e@example.test",
  "-c",
  "user.name=e2e",
  "commit",
  "--allow-empty",
  "-m",
  "init",
])

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
const model = { providerID: account.providerID, id: MODEL }
// Oldest first: the hash folder holds the newest session, so it heads the recent list.
const sessions = {
  alpha: await server.createSession({ title: "알파 작업", model, directory: folders.alpha }),
  hash: await server.createSession({ title: "해시 폴더 작업", model, directory: folders.hash }),
}

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: DEV_PORT })

const state = {
  dev: `http://127.0.0.1:${DEV_PORT}`,
  control,
  projects,
  folders,
  mcp: mcp.url,
  model,
  sessions: { alpha: sessions.alpha.id, hash: sessions.hash.id },
}
await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_WORKSPACE_E2E_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await server.stop()
  await responses.stop()
  mcp.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", windowsHide: true })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
}

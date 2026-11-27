// Backend of the composer-ext suite (mentions + slash commands, 03 §18.12–18.13). Like e2e/backend.ts: the real server
// from source with own.accounts + own.telemetry, a fake OpenAI provider and an API-key account made through RPC; plus
// what the lists need: a workspace with files (a Korean name, a `#` folder, ~3,000 generated files for the large-repo
// numbers), a user command, a skill, a reference, a fake MCP server (prompt + resources), and a session with one
// finished turn. Vite dev serves the harness page. Own ports and temp directory: other suites may run at the same
// time. Fake credentials only; the temp root is removed on exit.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import type { RecordedRequest, Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"

export const DEV_PORT = Number(process.env.OWN_WEB_COMPOSER_EXT_PORT ?? 5263)
export const TMP = process.env.OWN_WEB_COMPOSER_EXT_TMP ?? path.join(os.tmpdir(), "own-web-composer-ext")
export const STATE_FILE = path.join(TMP, "backend.json")

const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownWebComposerExtFakeKey0000001"
/** Generated files for the large-repo numbers (fs.find ranks over the whole index). */
const BIG = { packages: 50, modules: 60 }

const router = Array.from({ length: 60 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join("\n")
const files: Record<string, string> = {
  "src/router.ts": `${router}\n`,
  "src/routes/index.ts": "export const routes = []\n",
  "src/라우터.ts": "export const 한글 = true\n",
  "src/composer/input.ts": "export const input = 1\n",
  "#notes/plan.md": "# 계획\n",
  "docs/guide.md": "# Guide\n",
  "skills/review-guide/SKILL.md": [
    "---",
    "name: Review guide",
    "description: 리뷰 체크리스트",
    "---",
    "Check tests, names and error paths.",
  ].join("\n"),
  ...Object.fromEntries(
    Array.from({ length: BIG.packages * BIG.modules }, (_, index) => [
      `big/pkg${Math.floor(index / BIG.modules)}/mod${index % BIG.modules}.ts`,
      `export const value = ${index}\n`,
    ]),
  ),
}

const responses = startFakeOpenAIResponses({ models: [MODEL], responder: reply })
const server = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  workspaceFiles: files,
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-web-composer-ext-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
      extra: {
        commands: {
          hello: { template: "Say hello to $ARGUMENTS", description: "say hello <name>" },
        },
        skills: [path.join(paths.workspace, "skills")],
        references: { handbook: { path: path.join(paths.workspace, "docs"), description: "제품 문서" } },
        mcp: {
          servers: {
            docs: { type: "local", command: [process.execPath, path.join(import.meta.dir, "fake-mcp.ts")] },
          },
        },
      },
    }),
})

const control = path.join(server.paths.ownHome, "control")
await fs.mkdir(control, { recursive: true })
const added = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY }, control)
const account = added.account as { id: string; providerID: string }
await server.waitForModels([{ providerID: account.providerID, id: MODEL }])
const session = await server.createSession({ title: "멘션 e2e", model: { providerID: account.providerID, id: MODEL } })
await server.prompt(session.id, "첫 질문입니다")
await server.waitIdle(session.id)

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
  workspace: server.paths.workspace,
  account: { id: account.id, providerID: account.providerID, label: "Alpha" },
  model: MODEL,
  session: session.id,
  bigFiles: BIG.packages * BIG.modules,
}
await fs.mkdir(TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_COMPOSER_EXT_READY ${JSON.stringify(state)}`)

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

/** Titles, compaction summaries (core wants the template headings), otherwise a short answer. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "멘션 세션" }
  if (request.body.includes("You MUST use this format for your response"))
    return {
      type: "text",
      text: "## Objective\n- e2e\n\n## Decisions\n- none\n\n## Work State\n### Completed\n- x\n\n### Active\n- y\n\n## Next Move\n1. z",
    }
  return { type: "text", text: "확인했습니다." }
}

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
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

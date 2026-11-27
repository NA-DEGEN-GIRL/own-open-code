// Backend of the composer-plus suite (03 §19.6 skills, §19.9 history/drafts/`!` shell, §19.12 fork and manual compact).
// Like e2e/composer-ext/backend.ts: the real server from source with own.accounts + own.telemetry, a fake OpenAI
// provider and an API-key account made through RPC, plus a workspace with a project skill. The fake refuses the
// compaction of any history that contains FAIL_MARK (the failure banner test); everything else answers at once.
// Vite dev serves the harness page. Own port and temp directory (other suites may run at the same time); fake
// credentials only; bound to 127.0.0.1; the temp root is removed on exit.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import type { RecordedRequest, Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"

export const DEV_PORT = Number(process.env.OWN_WEB_COMPOSER_PLUS_PORT ?? 5287)
export const TMP = process.env.OWN_WEB_COMPOSER_PLUS_TMP ?? path.join(os.tmpdir(), "own-web-composer-plus")
export const STATE_FILE = path.join(TMP, "backend.json")
/** A history containing this text makes the fake refuse its compaction. */
export const FAIL_MARK = "COMPACTION-FAIL-MARK"

const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownWebComposerPlusFakeKey000001"

const files: Record<string, string> = {
  "README.md": "# composer-plus e2e\n",
  "skills/review-guide/SKILL.md": [
    "---",
    "name: Review guide",
    "description: 리뷰 체크리스트",
    "---",
    "Check tests, names and error paths.",
  ].join("\n"),
  "skills/release-notes/SKILL.md": [
    "---",
    "name: Release notes",
    "description: 릴리스 노트 작성법",
    "---",
    "Write short release notes.",
  ].join("\n"),
}

// Playwright ends the web server without a signal on Windows, so the previous run's roots (temp home, database,
// workspace) may still be in this suite's own temp directory; remove them first.
await fs.mkdir(TMP, { recursive: true })
for (const entry of await fs.readdir(TMP))
  if (entry.startsWith("own-e2e-"))
    await fs.rm(path.join(TMP, entry), { recursive: true, force: true }).catch(() => undefined)

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
            buildId: `own-web-composer-plus-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
      extra: { skills: [path.join(paths.workspace, "skills")] },
    }),
})

const control = path.join(server.paths.ownHome, "control")
await fs.mkdir(control, { recursive: true })
const added = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY }, control)
const account = added.account as { id: string; providerID: string }
await server.waitForModels([{ providerID: account.providerID, id: MODEL }])

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
  failMark: FAIL_MARK,
}
await fs.mkdir(TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_COMPOSER_PLUS_READY ${JSON.stringify(state)}`)

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

/** Titles, compaction summaries (core wants the template headings; refused with FAIL_MARK), otherwise a short answer. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "컴포저 세션" }
  if (request.body.includes("You MUST use this format for your response")) {
    if (request.body.includes(FAIL_MARK))
      return {
        type: "error",
        status: 400,
        body: {
          error: { message: "fake: compaction refused", type: "invalid_request_error", code: "invalid_request" },
        },
      }
    // Slow enough for the `압축 중…` chip to be seen.
    return {
      type: "text",
      delayMs: 1_500,
      text: "## Objective\n- e2e\n\n## Decisions\n- none\n\n## Work State\n### Completed\n- x\n\n### Active\n- y\n\n## Next Move\n1. z",
    }
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

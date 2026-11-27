// Review tab e2e backend (03 §18.5): the real server from source with a fake OpenAI Responses provider, a git
// workspace with committed, branch and uncommitted changes, a plain (non-git) folder, and sessions:
//   ses git   "리뷰 세션"   one finished turn whose model wrote `src/turn.ts` through the real `write` tool
//   ses fresh "빈 세션"     no turns yet (last turn is empty)
//   ses plain "일반 폴더"   a folder without git (only the last turn is available)
// Then Vite dev serves own-web (proxy with server-side Basic auth, like e2e/backend.ts). Fake credentials only; the
// temp root is removed on exit. The state file is `<tmp>/own-web-review-e2e/backend.json` (tmp = $TEMP of this run).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig, openAIResponsesProvider } from "../../../own-accounts/test/e2e-kit/harness/config"
import { startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import type { RecordedRequest, Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"

export const REVIEW_DEV_PORT = Number(process.env.OWN_WEB_REVIEW_E2E_PORT ?? 5179)
export const REVIEW_STATE_FILE = path.join(os.tmpdir(), "own-web-review-e2e", "backend.json")

// Not a "gpt-" id: core swaps write/edit for the patch tool on GPT models (core/src/tool/plugin/patch.ts).
const MODEL = { providerID: "fake-review", id: "review-model" }
const FAKE_KEY = "sk-proj-ownWebReviewFakeKey000000000000001"
/** Lines of `big/large.ts`: its full-context patch is far above the worker threshold (prepare.ts). */
const LARGE_LINES = 6_000

// Playwright may end this process without the graceful stop on Windows: remove roots earlier runs left behind (one run
// at a time, the fixed port guarantees it).
for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }))
  if (entry.isDirectory() && /^own-web-review-(?!e2e$)/.test(entry.name))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-web-review-")))
const workspace = path.join(root, "workspace")
const inferred = path.join(root, "inferred-worktree")
const plain = path.join(root, "plain-folder")
await seedRepository(workspace, inferred)
await fs.mkdir(plain, { recursive: true })
await Bun.write(path.join(plain, "notes.txt"), "git이 없는 폴더\n")

const responses = startFakeOpenAIResponses({ models: [MODEL.id], responder: reply })
const server = await startOpencodeServer({
  root,
  env: { OWN_OPEN_CODE: "1" },
  config: opencodeConfig({
    providers: { [MODEL.providerID]: openAIResponsesProvider(responses, { apiKey: FAKE_KEY, models: [MODEL.id] }) },
    model: `${MODEL.providerID}/${MODEL.id}`,
  }),
})
await server.waitForModels([MODEL])

const allowEdits = [{ action: "edit", resource: "*", effect: "allow" }]
async function createSession(title: string, directory: string) {
  const created = (await server.call("POST", "/api/session", {
    body: { title, model: MODEL, location: { directory }, permissions: allowEdits },
    directory,
  })) as { data: { id: string } }
  return created.data.id
}
const gitSession = await createSession("리뷰 세션", workspace)
const fresh = await createSession("빈 세션", workspace)
const plainSession = await createSession("일반 폴더", plain)
const inferredSession = await createSession("추정 base", inferred)
await server.prompt(gitSession, "REVIEW_WRITE:src/turn.ts 파일을 만들어 주세요")
await server.waitIdle(gitSession)

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, { OWN_WEB_API_URL: server.url, OWN_WEB_API_PASSWORD: password })
const dev = await startViteDev({ port: REVIEW_DEV_PORT })

const state = {
  dev: `http://127.0.0.1:${REVIEW_DEV_PORT}`,
  workspace,
  inferred,
  plain,
  model: MODEL,
  sessions: { git: gitSession, fresh, plain: plainSession, inferred: inferredSession },
}
await fs.mkdir(path.dirname(REVIEW_STATE_FILE), { recursive: true })
await Bun.write(REVIEW_STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_REVIEW_E2E_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await server.stop()
  await responses.stop()
  await fs.rm(REVIEW_STATE_FILE, { force: true })
  await removeTree(root).catch(() => undefined)
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

/**
 * Model replies: a user text `REVIEW_WRITE:<path>` makes the model call the real `write` tool for that path; the
 * follow-up request (its last input item is the tool result) and every other request get a short text answer.
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "리뷰 세션" }
  const input = (request.json as { input?: unknown[] } | undefined)?.input ?? []
  const last = input.at(-1) as { type?: string } | undefined
  if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") return { type: "text", text: "파일을 썼습니다." }
  const target = /REVIEW_WRITE:([\w./-]+)/.exec(JSON.stringify(last ?? ""))?.[1]
  if (!target) return { type: "text", text: "알겠습니다." }
  return {
    type: "tool-call",
    name: "write",
    input: {
      path: target,
      content: `// ${target}: written by the review e2e turn\nexport const turn = ${JSON.stringify(target)}\n`,
    },
  }
}

/**
 * main: base files. feature/review (`checkout -b`, so its reflog says "Created from HEAD" and core cannot infer a
 * base: the UI must ask): one commit, then uncommitted edits, a new and a deleted file. A second worktree on
 * feature/inferred (created from `main` by name, so `vcs.base` infers main) with one commit.
 */
async function seedRepository(directory: string, worktree: string) {
  await fs.mkdir(directory, { recursive: true })
  const run = (...args: string[]) => git(directory, args)
  const write = (file: string, content: string) => Bun.write(path.join(directory, file), content)
  const router = Array.from({ length: 40 }, (_, index) => `export const route${index} = ${index}\n`).join("")
  const large = Array.from({ length: LARGE_LINES }, (_, index) => `export const value${index} = "${"x".repeat(24)}"\n`)
  await run("init", "--initial-branch=main")
  await run("config", "user.name", "own review e2e")
  await run("config", "user.email", "review-e2e@example.test")
  await run("config", "core.autocrlf", "false")
  await write("README.md", "# review e2e\n")
  await write("src/router.ts", router)
  await write("src/util.ts", "export const util = 1\n")
  await write("test/router.test.ts", "import { route0 } from '../src/router'\nconsole.log(route0)\n")
  await write("big/large.ts", large.join(""))
  await run("add", "-A")
  await run("commit", "-m", "base")
  await run("checkout", "-b", "feature/review")
  await write("src/util.ts", "export const util = 2\nexport const feature = true\n")
  await write("src/feature.ts", "export const feature = 'branch'\n")
  await run("add", "-A")
  await run("commit", "-m", "feature work")
  await write("src/router.ts", `import { estimate } from "./estimate"\n${router}export const cost = estimate()\n`)
  await write("src/estimate.ts", "export function estimate() {\n  return 42\n}\n")
  await fs.rm(path.join(directory, "test/router.test.ts"))
  const edited = [...large]
  for (const index of [10, 3_000, 5_990]) edited[index] = `export const value${index} = "changed"\n`
  await write("big/large.ts", edited.join(""))
  await run("worktree", "add", "-b", "feature/inferred", worktree, "main")
  await Bun.write(path.join(worktree, "src/inferred.ts"), "export const inferred = true\n")
  await git(worktree, ["add", "-A"])
  await git(worktree, ["commit", "-m", "inferred base work"])
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
}

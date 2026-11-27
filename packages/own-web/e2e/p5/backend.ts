// P5 acceptance backend (integrator): the whole own-web app (index.html through Vite dev) against the real server from
// source with own.accounts + own.telemetry, for the Edge walkthrough of items 1–15 of 03 §18 (e2e/p5/acceptance.p5.ts).
// Run by this suite's Playwright webServer, or by hand: `bun e2e/p5/backend.ts`.
//
// What it sets up (fake credentials only; one temp root removed on exit):
//   - a fake OpenAI Responses provider with a scripted model and two API-key accounts made through RPC ("Alpha",
//     "Bravo": a pending switch needs two). Directives in the last user text:
//       [shell <cmd>]  → `shell` tool (asks for approval under `묻기`)
//       [write <path>] → adds the file with `patch` (GPT models get patch, not write/edit)
//       [question]     → `question` tool (a form dock)
//       [websearch]    → `websearch` tool (the first-use consent form)
//       [subagent]     → `subagent` (agent "general") whose prompt is "[child-ask] …"; [child-ask] → shell in the child
//       [slow <sec>]   → answers after <sec> seconds (a busy session for steer/queue)
//   - the workspace is a Git repository (main + a committed feature branch + uncommitted changes) with files for `@`,
//     a user command, a skill and a reference for `/`; a second folder without Git; a folder with `#` and Hangul;
//   - MCP servers: `docs` (Code Mode), `direct` (direct tools), `secure` (OAuth; needs_auth until signed in), from the
//     workspace suite's fake MCP / OAuth server;
//   - one session with a finished turn; Vite dev on its own port.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { isRecord, type RecordedRequest, type Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeMcp } from "../workspace/fake-mcp"

export const P5_PORT = Number(process.env.OWN_WEB_P5_PORT ?? 5511)
export const P5_TMP = process.env.OWN_WEB_P5_TMP ?? path.join(os.tmpdir(), "own-web-p5")
export const STATE_FILE = path.join(P5_TMP, "backend.json")

const MODEL = "gpt-5.5"
// Fake credentials only.
const KEYS = {
  alpha: "sk-proj-ownP5AlphaFakeKey00000000000000001",
  bravo: "sk-proj-ownP5BravoFakeKey00000000000000002",
}
const router = Array.from({ length: 60 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join("\n")
const files: Record<string, string> = {
  "README.md": "# p5 acceptance\n",
  "src/router.ts": `${router}\n`,
  "src/라우터.ts": "export const 한글 = true\n",
  "src/estimate.ts": "export const estimate = 1\n",
  "docs/guide.md": "# Guide\n",
  "skills/review-guide/SKILL.md": [
    "---",
    "name: Review guide",
    "description: 리뷰 체크리스트",
    "---",
    "Check tests, names and error paths.",
  ].join("\n"),
}

const responses = startFakeOpenAIResponses({ models: [MODEL], responder: reply })
const mcp = startFakeMcp()
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
            buildId: `own-web-p5-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
      extra: {
        commands: { hello: { template: "Say hello to $ARGUMENTS", description: "say hello <name>" } },
        skills: [path.join(paths.workspace, "skills")],
        references: { handbook: { path: path.join(paths.workspace, "docs"), description: "제품 문서" } },
        mcp: {
          timeout: { startup: 5_000 },
          servers: {
            docs: { type: "remote", url: `${mcp.url}/open/mcp`, oauth: false },
            direct: { type: "remote", url: `${mcp.url}/direct/mcp`, oauth: false, codemode: false },
            secure: { type: "remote", url: `${mcp.url}/secure/mcp` },
          },
        },
      },
    }),
})

const workspace = server.paths.workspace
const control = path.join(server.paths.ownHome, "control")
const projects = path.join(server.paths.root, "projects")
const folders = { plain: path.join(projects, "plain folder"), hash: path.join(projects, "#2 한글 폴더") }
await Promise.all([control, ...Object.values(folders)].map((directory) => fs.mkdir(directory, { recursive: true })))
await Bun.write(path.join(folders.plain, "notes.txt"), "no git here\n")

// Review (18.5): main, a feature branch with a commit, then uncommitted changes on the feature branch.
const identity = ["-c", "user.email=p5@example.test", "-c", "user.name=p5"]
await git(workspace, ["init", "-q", "-b", "main"])
await git(workspace, ["add", "-A"])
await git(workspace, [...identity, "commit", "-q", "-m", "init"])
await git(workspace, ["checkout", "-q", "-b", "feature"])
await Bun.write(path.join(workspace, "src/estimate.ts"), "export const estimate = 2\nexport const cost = 3\n")
await git(workspace, ["add", "-A"])
await git(workspace, [...identity, "commit", "-q", "-m", "feature: estimate"])
await Bun.write(path.join(workspace, "src/router.ts"), `${router}\nexport const extra = true\n`)

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
const session = await server.createSession({
  title: "P5 수용 시험",
  model: { providerID: alpha.providerID, id: MODEL },
})
await rpc("session.approval.set", { sessionID: session.id, mode: "ask" }, workspace)
await server.prompt(session.id, "첫 질문입니다")
await server.waitIdle(session.id)

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: P5_PORT })

const state = {
  dev: `http://127.0.0.1:${P5_PORT}`,
  control,
  workspace,
  folders,
  mcp: mcp.url,
  model: MODEL,
  accounts: { alpha, bravo },
  session: session.id,
}
await fs.mkdir(P5_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_P5_READY ${JSON.stringify(state)}`)

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

// ---------------------------------------------------------------------------------------------------------------

/** The scripted model (see the header). Titles and compaction summaries get fixed answers. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "작업 세션" }
  if (request.body.includes("You MUST use this format for your response"))
    return {
      type: "text",
      text: "## Objective\n- p5\n\n## Decisions\n- none\n\n## Work State\n### Completed\n- x\n\n### Active\n- y\n\n## Next Move\n1. z",
    }
  const input = isRecord(request.json) && Array.isArray(request.json.input) ? request.json.input : []
  const last = input.at(-1)
  // A freeform tool's result (`patch` on a model that takes freeform input, upstream #61703) is a custom_tool_call_output.
  if (isRecord(last) && (last.type === "function_call_output" || last.type === "custom_tool_call_output")) return { type: "text", text: "도구 실행을 마쳤습니다." }
  const text = lastUserText(input)
  const write = text.match(/\[write ([^\]]+)\]/)
  if (write)
    return {
      type: "tool-call",
      name: "patch",
      input: { patchText: `*** Begin Patch\n*** Add File: ${write[1]}\n+hello from ${write[1]}\n*** End Patch` },
    }
  const shell = text.match(/\[shell ([^\]]+)\]/)
  if (shell) return { type: "tool-call", name: "shell", input: { command: shell[1] } }
  if (text.includes("[question]"))
    return {
      type: "tool-call",
      name: "question",
      input: {
        questions: [
          {
            question: "어느 데이터베이스를 쓸까요?",
            header: "DB",
            options: [
              { label: "Postgres", description: "관계형" },
              { label: "SQLite", description: "파일 하나" },
            ],
          },
        ],
      },
    }
  if (text.includes("[websearch]")) return { type: "tool-call", name: "websearch", input: { query: "own open code" } }
  const slow = text.match(/\[slow (\d+)\]/)
  if (slow) return { type: "text", text: "천천히 답합니다.", delayMs: Number(slow[1]) * 1000 }
  if (text.includes("[child-ask]")) return { type: "tool-call", name: "shell", input: { command: "echo own-child" } }
  if (text.includes("[subagent]"))
    return {
      type: "tool-call",
      name: "subagent",
      input: { agent: "general", description: "라우터 조사", prompt: "[child-ask] 라우터 설정을 확인해 줘" },
    }
  return { type: "text", text: `답변: ${text.slice(0, 40)}` }
}

function lastUserText(input: readonly unknown[]) {
  for (const item of [...input].reverse()) {
    if (!isRecord(item) || item.role !== "user") continue
    const content = item.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) continue
    return content
      .flatMap((part: unknown) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
      .join("\n")
  }
  return ""
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", windowsHide: true })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
}

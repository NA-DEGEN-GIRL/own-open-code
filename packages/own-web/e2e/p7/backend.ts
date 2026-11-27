// P7 acceptance backend (integrator): the whole own-web app (index.html through Vite dev) against the real server from
// source with own.accounts + own.telemetry, for the Edge walkthrough of items 17–32 of 03 §19 (e2e/p7/acceptance.p7.ts).
// Run by this suite's Playwright webServer, or by hand: `bun e2e/p7/backend.ts`.
//
// What it sets up (fake credentials only; one short temp root, removed on exit and before the next run):
//   - a fake OpenAI Responses provider with a scripted model and one API-key account made through RPC ("Alpha").
//     Directives in the last user text:
//       [bg-long]   → `shell` tool, foreground, prints `tick n` once a second for ~40 s (Alt+B, the list, 종료)
//       [bg-quick]  → `shell` tool with `background: true`, ~3 s (the finish toast)
//       [link]      → an answer with a markdown link `src/router.ts:12` (opens in the files tab)
//       [slow <s>]  → answers after <s> seconds
//   - the workspace is a Git repository: `main`, a committed `feature` branch that is checked out, uncommitted changes
//     (a modified `src/router.ts`, a new `notes/todo.md`), a bare `origin` remote next to it, a skill, markdown docs;
//   - a fake `gh` first on the server's PATH (version + a made-up PR URL; nothing reaches GitHub);
//   - one seeded session with two finished turns (the second answer has a file link); Vite dev on its own port
//     without HMR (edits elsewhere must not reload a page under a test);
//   - `GET <inspect>/requests`: the model requests the fake received (instructions + input), for the notes prefix check.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { isRecord, type RecordedRequest, type Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"

export const P7_PORT = Number(process.env.OWN_WEB_P7_PORT ?? 5711)
export const P7_TMP = process.env.OWN_WEB_P7_TMP ?? path.join(os.tmpdir(), "own-web-p7")
export const STATE_FILE = path.join(P7_TMP, "backend.json")

const MODEL = "gpt-5.5"
// Fake credential only.
const KEY = "sk-proj-ownP7AlphaFakeKey000000000000000001"
const router = Array.from({ length: 60 }, (_, index) => `export const line${index + 1} = ${index + 1}`).join("\n")
/** ASCII only and the same in pwsh, cmd and bash (worktree-bg backend): `tick n` once a second. */
const ticker = (seconds: number) =>
  `bun -e "let i=0; while (i++ - ${seconds}) { console.log('tick ' + i); await Bun.sleep(1000) }"`
const COMMANDS = { long: ticker(40), quick: ticker(3) }

// Playwright may end this process without the graceful stop on Windows: remove what an earlier run left behind.
for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []))
  if (entry.isDirectory() && /^own-p7-/.test(entry.name))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)
// Short on purpose: core's snapshot repositories nest deep under the root (Windows MAX_PATH).
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-p7-")))
const bin = path.join(root, "bin")
await fakeGh()

const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
const responses = startFakeOpenAIResponses({ models: [MODEL], responder: reply })
const server = await startOpencodeServer({
  root,
  env: { OWN_OPEN_CODE: "1", [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ""}` },
  workspaceFiles: {
    "README.md": "# p7 acceptance\n\n- [가이드](docs/guide.md)\n",
    "src/router.ts": `${router}\n`,
    "src/util.ts": "export const util = 1\n",
    "docs/guide.md": "# 가이드\n\n```mermaid\ngraph TD; A-->B\n```\n",
    "skills/review-guide/SKILL.md": [
      "---",
      "name: Review guide",
      "description: 리뷰 체크리스트",
      "---",
      "Check tests, names and error paths.",
    ].join("\n"),
  },
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-web-p7-${process.pid}`,
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

const workspace = server.paths.workspace
const control = path.join(server.paths.ownHome, "control")
const remote = path.join(root, "origin.git")
await fs.mkdir(control, { recursive: true })

// 19.2/19.15: main, then a checked-out `feature` branch with a commit and an upstream, then uncommitted changes.
const identity = ["-c", "user.email=p7@example.test", "-c", "user.name=p7"]
await git(root, ["init", "-q", "--bare", "-b", "main", remote])
await git(workspace, ["init", "-q", "-b", "main"])
await git(workspace, ["config", "user.email", "p7@example.test"])
await git(workspace, ["config", "user.name", "p7"])
await git(workspace, ["add", "-A"])
await git(workspace, [...identity, "commit", "-q", "-m", "init"])
await git(workspace, ["remote", "add", "origin", remote])
await git(workspace, ["push", "-q", "-u", "origin", "main"])
await git(workspace, ["checkout", "-q", "-b", "feature"])
await Bun.write(path.join(workspace, "src/util.ts"), "export const util = 2\nexport const extra = 3\n")
await git(workspace, ["add", "-A"])
await git(workspace, [...identity, "commit", "-q", "-m", "feature: util"])
await git(workspace, ["push", "-q", "-u", "origin", "feature"])
await Bun.write(
  path.join(workspace, "src/router.ts"),
  `${router.replace("line3 = 3", "line3 = 33")}\nexport const extra = true\n`,
)
await Bun.write(path.join(workspace, "notes/todo.md"), "# 할 일\n")

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
const session = await server.createSession({
  title: "P7 수용 시험",
  model: { providerID: account.providerID, id: MODEL },
})
await rpc("session.approval.set", { sessionID: session.id, mode: "full" }, workspace)
await server.prompt(session.id, "첫 질문입니다")
await server.waitIdle(session.id)
await server.prompt(session.id, "라우터 파일을 알려 줘 [link]")
await server.waitIdle(session.id)

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: P7_PORT, hmr: false })

const inspect = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/requests") return new Response("not found", { status: 404 })
    return Response.json(
      responses.requests
        .filter((item) => isRecord(item.json) && Array.isArray(item.json.input))
        .map((item) => {
          const json = item.json as { instructions?: unknown; input: unknown[] }
          return { seq: item.seq, instructions: json.instructions ?? null, input: json.input }
        }),
    )
  },
})

const state = {
  dev: `http://127.0.0.1:${P7_PORT}`,
  inspect: `http://127.0.0.1:${inspect.port}`,
  root,
  control,
  workspace,
  remote,
  configDir: server.paths.config,
  model: MODEL,
  account: { id: account.id, providerID: account.providerID, label: "Alpha" },
  session: session.id,
  commands: COMMANDS,
}
await fs.mkdir(P7_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_P7_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  inspect.stop(true)
  await dev.close().catch(() => undefined)
  await server.stop()
  await responses.stop()
  await fs.rm(STATE_FILE, { force: true })
  await removeTree(root).catch(() => undefined)
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
      text: "## Objective\n- p7\n\n## Decisions\n- none\n\n## Work State\n### Completed\n- x\n\n### Active\n- y\n\n## Next Move\n1. z",
    }
  const input = isRecord(request.json) && Array.isArray(request.json.input) ? request.json.input : []
  const last = input.at(-1)
  // A freeform tool's result (`patch` on a model that takes freeform input, upstream #61703) is a custom_tool_call_output.
  if (isRecord(last) && (last.type === "function_call_output" || last.type === "custom_tool_call_output")) return { type: "text", text: "도구 실행을 마쳤습니다." }
  const text = lastUserText(input)
  if (text.includes("<shell id=")) return { type: "text", text: "백그라운드 작업 결과를 확인했습니다." }
  if (text.includes("[bg-long]"))
    return { type: "tool-call", name: "shell", input: { command: COMMANDS.long, description: "긴 작업" } }
  if (text.includes("[bg-quick]"))
    return {
      type: "tool-call",
      name: "shell",
      input: { command: COMMANDS.quick, description: "짧은 작업", background: true },
    }
  if (text.includes("[link]"))
    return { type: "text", text: "라우터는 [src/router.ts 12줄](src/router.ts:12)에 있습니다. 찾을 단어: 오렌지." }
  const slow = text.match(/\[slow (\d+)\]/)
  if (slow) return { type: "text", text: "천천히 답합니다.", delayMs: Number(slow[1]) * 1000 }
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

/** A `gh` that never talks to GitHub: `--version` and `pr create` answer locally (review-git backend). */
async function fakeGh() {
  await fs.mkdir(bin, { recursive: true })
  await Bun.write(
    path.join(bin, "gh.cmd"),
    [
      "@echo off",
      'if "%1"=="--version" (echo gh version 2.99.0 own-e2e fake & exit /b 0)',
      'if "%1"=="pr" (echo Creating pull request for feature into main & echo https://github.example.test/own/p7/pull/7 & exit /b 0)',
      "echo unsupported fake gh call 1>&2",
      "exit /b 1",
      "",
    ].join("\r\n"),
  )
  const script = path.join(bin, "gh")
  await Bun.write(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "gh version 2.99.0 own-e2e fake"; exit 0; fi',
      'if [ "$1" = "pr" ]; then echo "Creating pull request for feature into main"; echo "https://github.example.test/own/p7/pull/7"; exit 0; fi',
      'echo "unsupported fake gh call" >&2',
      "exit 1",
      "",
    ].join("\n"),
  )
  await fs.chmod(script, 0o755)
}

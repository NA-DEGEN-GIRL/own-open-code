// Worktree + background jobs e2e backend (03 §19.3, §19.7). Run by Playwright's webServer (playwright.config.ts) or
// by hand: `bun e2e/worktree-bg/backend.ts`.
//
// The real upstream server from source with own.accounts + own.telemetry (packages/own-accounts/test/e2e-kit), a fake
// OpenAI Responses provider with a scripted model, one API-key account made through RPC, a Git project with a seed
// session (so the project is resolved and its root is in the worktree table, the source of `worktree.create`), three
// linked worktrees for the cleanup guard (TG13: nested worktree, team-mode lock, ignored files), then Vite dev for the
// harness. The scripted model reads directives in the last user text:
//   [bg-long]   → `shell` tool, foreground, a command that prints a line a second for ~40 s (to send to the
//                 background with Alt+B and to stop from the list)
//   [bg-quick]  → `shell` tool with `background: true`, ~3 s (finishes in the background: the finish toast)
//   [bg-agent]  → `subagent` tool (agent "general") whose child answers after 8 s (`[slow-child]`), to background it
//   [preset-reject] → `subagent` tool with a `model` on another account (`REJECTED_MODEL`): the own-accounts preset
//                 gate refuses it (07 §5.4), core answers `Unknown agent: own-preset: …`, the chip shows (PG1)
// Fake credentials only; everything lives under a temp root that is removed on exit. Servers bind 127.0.0.1.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { isRecord, type RecordedRequest, type Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"

export const WT_PORT = Number(process.env.OWN_WEB_WTBG_PORT ?? 5347)
export const WT_TMP = process.env.OWN_WEB_WTBG_TMP ?? path.join(os.tmpdir(), "own-web-worktree-bg")
export const STATE_FILE = path.join(WT_TMP, "backend.json")

const MODEL = "gpt-5.5"
// Fake credential only.
const KEY = "sk-proj-ownWorktreeBgFakeKey00000000000001"
/**
 * Prints `tick n` once a second, ASCII only, and quotes the same in pwsh, cmd and bash (no `$`, `<`, `>`, `!`), so it
 * runs in whatever shell the server picks. `ping` would do too, but prints in the console code page (cp949 on Korean
 * Windows), which the capture shows as replacement characters.
 */
const ticker = (seconds: number) =>
  `bun -e "let i=0; while (i++ - ${seconds}) { console.log('tick ' + i); await Bun.sleep(1000) }"`
const COMMANDS = { long: ticker(40), quick: ticker(3) }
/** Another subscription account's model, as an LLM might write it; never on the session's account (07 §5.4). */
const REJECTED_MODEL = "own-codex-zz02/gpt-6-sol"

const responses = startFakeOpenAIResponses({ models: [MODEL], responder: reply })
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
            buildId: `own-web-wtbg-${process.pid}`,
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
await fs.mkdir(control, { recursive: true })
const gitProject = path.join(server.paths.root, "projects", "wt-repo")
await fs.mkdir(gitProject, { recursive: true })
await Bun.write(path.join(gitProject, "README.md"), "# worktree test\n")
const identity = ["-c", "user.email=wt@example.test", "-c", "user.name=wt"]
const gitIn = (cwd: string, ...args: string[]) => {
  if (Bun.spawnSync(["git", ...args], { cwd }).exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
}
const git = (...args: string[]) => gitIn(gitProject, ...args)
git("init", "-q", "-b", "main")
git("add", "README.md")
git(...identity, "commit", "-q", "-m", "init")
// `feature-x` has one more file, so a worktree made from it is recognizable.
git("checkout", "-q", "-b", "feature-x")
await Bun.write(path.join(gitProject, "FEATURE.md"), "feature x\n")
git("add", "FEATURE.md")
git(...identity, "commit", "-q", "-m", "feature")
git("checkout", "-q", "main")
// A Hangul branch name for the IME test of the base search.
git("branch", "기능-한글")

// Cleanup guard fixtures (06 §10.4 #5, TG13), linked worktrees next to the project made with plain git (the
// `worktree.refresh` after the seed session discovers them like any worktree made outside the app):
//   wt-ignored  branch `guard`, which commits a .gitignore; ignored `build/app.bin` (2 MB) and `debug.log` (0.5 MB)
//   wt-nested   another linked worktree inside, in its ignored `.worktrees/inner` (like this user's home)
//   wt-locked   locked by team mode: `own.team area:ar_x`
const guard = {
  ignored: path.join(path.dirname(gitProject), "wt-ignored"),
  nested: path.join(path.dirname(gitProject), "wt-nested"),
  locked: path.join(path.dirname(gitProject), "wt-locked"),
}
git("worktree", "add", "-q", "-b", "guard", guard.ignored, "main")
await Bun.write(path.join(guard.ignored, ".gitignore"), ".worktrees/\nbuild/\n*.log\n")
gitIn(guard.ignored, "add", ".gitignore")
gitIn(guard.ignored, ...identity, "commit", "-q", "-m", "ignore build output")
await fs.mkdir(path.join(guard.ignored, "build"), { recursive: true })
await Bun.write(path.join(guard.ignored, "build", "app.bin"), "x".repeat(2_000_000))
await Bun.write(path.join(guard.ignored, "debug.log"), "x".repeat(500_000))
git("worktree", "add", "-q", "--detach", guard.nested, "guard")
git("worktree", "add", "-q", "--detach", path.join(guard.nested, ".worktrees", "inner"), "guard")
git("worktree", "add", "-q", "--detach", "--lock", "--reason", "own.team area:ar_x", guard.locked, "guard")

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

// A seed session resolves the Git project (its root lands in the worktree table: `worktree.create{from}` needs it).
const seed = await server.request("POST", "/api/session", {
  body: {
    title: "기존 세션",
    model: { providerID: account.providerID, id: MODEL },
    location: { directory: gitProject },
  },
  directory: gitProject,
})
if (!seed.ok) throw new Error(`seed session: ${seed.status} ${await seed.text()}`)
const seedInfo = ((await seed.json()) as { data: { id: string; projectID: string; location: { directory: string } } })
  .data
const refreshed = await server.request("POST", "/api/worktree/refresh", {
  body: { projectID: seedInfo.projectID },
  directory: gitProject,
})
if (!refreshed.ok) throw new Error(`worktree refresh: ${refreshed.status} ${await refreshed.text()}`)

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: WT_PORT })

const state = {
  dev: `http://127.0.0.1:${WT_PORT}`,
  control,
  gitProject: seedInfo.location.directory,
  projectID: seedInfo.projectID,
  seedSession: seedInfo.id,
  model: MODEL,
  providerID: account.providerID,
  commands: COMMANDS,
  rejectedModel: REJECTED_MODEL,
}
await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_WTBG_READY ${JSON.stringify(state)}`)

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

// ---------------------------------------------------------------------------------------------------------------

/** The scripted model (see the header). Titles get a fixed answer; tool results and notices a short text. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "작업 세션" }
  const input = isRecord(request.json) && Array.isArray(request.json.input) ? request.json.input : []
  const last = input.at(-1)
  // A freeform tool's result (`patch` on a model that takes freeform input, upstream #61703) is a custom_tool_call_output.
  if (isRecord(last) && (last.type === "function_call_output" || last.type === "custom_tool_call_output")) return { type: "text", text: "도구 실행을 마쳤습니다." }
  const text = lastUserText(input)
  // Background completion notices (`<shell id=… state=…>`) come back as input; answer them plainly.
  if (text.includes("<shell id=")) return { type: "text", text: "백그라운드 작업 결과를 확인했습니다." }
  if (text.includes("[slow-child]")) return { type: "text", text: "조사를 마쳤습니다.", delayMs: 8_000 }
  if (text.includes("[bg-agent]"))
    return {
      type: "tool-call",
      name: "subagent",
      input: { agent: "general", description: "느린 조사", prompt: "[slow-child] 저장소를 살펴봐 줘" },
    }
  if (text.includes("[preset-reject]"))
    return {
      type: "tool-call",
      name: "subagent",
      input: { agent: "general", description: "다른 계정 리뷰", prompt: "변경을 검토해 줘", model: REJECTED_MODEL },
    }
  if (text.includes("[bg-long]"))
    return { type: "tool-call", name: "shell", input: { command: COMMANDS.long, description: "긴 작업" } }
  if (text.includes("[bg-quick]"))
    return {
      type: "tool-call",
      name: "shell",
      input: { command: COMMANDS.quick, description: "짧은 작업", background: true },
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

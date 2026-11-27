// Review line comments + Git actions e2e backend (03 §19.1, §19.2, §19.15): the real server from source with a fake
// OpenAI Responses provider, a Git workspace and a bare `origin` remote in the temp root, a fake `gh` first on the
// server's PATH (prints a version and a made-up PR URL; nothing reaches GitHub), one session in the workspace, then
// Vite dev (proxy with server-side Basic auth). Fake credentials only; the temp root is removed on exit.
//
//   workspace (feature/git, tracking origin/feature/git):
//     src/router.ts   modified in two places far apart (two hunks)
//     src/한 글.ts    modified (Hangul and a space in the name)
//     src/it's.ts     modified (a quote in the name)
//     notes/new.md    untracked
//     README.md       committed, unchanged
//
// The state file is `<tmp>/own-web-review-git-e2e/backend.json` (tmp = $TEMP of this run).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig, openAIResponsesProvider } from "../../../own-accounts/test/e2e-kit/harness/config"
import { startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import type { RecordedRequest, Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"

export const REVIEW_GIT_PORT = Number(process.env.OWN_WEB_REVIEW_GIT_E2E_PORT ?? 5621)
export const REVIEW_GIT_STATE_FILE = path.join(os.tmpdir(), "own-web-review-git-e2e", "backend.json")

const MODEL = { providerID: "fake-review-git", id: "review-git-model" }
const FAKE_KEY = "sk-proj-ownWebReviewGitFakeKey0000000000001"
const ROUTER = Array.from({ length: 40 }, (_, index) => `export const route${index} = ${index}\n`)

// Playwright may end this process without the graceful stop on Windows: remove roots earlier runs left behind.
for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }))
  if (entry.isDirectory() && /^own-web-rg-/.test(entry.name))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-web-rg-")))
const workspace = path.join(root, "workspace")
const remote = path.join(root, "origin.git")
const bin = path.join(root, "bin")
await seed()
await fakeGh()

const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
const responses = startFakeOpenAIResponses({ models: [MODEL.id], responder: reply })
const server = await startOpencodeServer({
  root,
  env: { OWN_OPEN_CODE: "1", [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ""}` },
  config: opencodeConfig({
    providers: { [MODEL.providerID]: openAIResponsesProvider(responses, { apiKey: FAKE_KEY, models: [MODEL.id] }) },
    model: `${MODEL.providerID}/${MODEL.id}`,
  }),
})
await server.waitForModels([MODEL])

const created = (await server.call("POST", "/api/session", {
  body: { title: "Git 동작", model: MODEL, location: { directory: workspace } },
  directory: workspace,
})) as { data: { id: string } }
// The shell the server runs `shell.create` with, and whether the fake gh wins on its PATH (the PR test needs it).
const probe = (await server.call("POST", "/api/shell", {
  body: { command: "gh --version" },
  query: { "location[directory]": workspace },
  directory: workspace,
})) as { data: { id: string; shell: string } }
const ghOutput = await shellOutput(probe.data.id)

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, { OWN_WEB_API_URL: server.url, OWN_WEB_API_PASSWORD: password })
// No HMR: files edited elsewhere while the suite runs must not reload the page under a test.
const dev = await startViteDev({ port: REVIEW_GIT_PORT, hmr: false })

const state = {
  dev: `http://127.0.0.1:${REVIEW_GIT_PORT}`,
  workspace,
  remote,
  session: created.data.id,
  shell: probe.data.shell,
  fakeGh: ghOutput.includes("own-e2e"),
}
await fs.mkdir(path.dirname(REVIEW_GIT_STATE_FILE), { recursive: true })
await Bun.write(REVIEW_GIT_STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_REVIEW_GIT_E2E_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await server.stop()
  await responses.stop()
  await fs.rm(REVIEW_GIT_STATE_FILE, { force: true })
  await removeTree(root).catch(() => undefined)
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

/** The model answers every prompt with a short text (the tests read the stored user message). */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "Git 동작" }
  return { type: "text", text: "코멘트를 읽었습니다." }
}

async function shellOutput(id: string) {
  const query = { "location[directory]": workspace }
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = (await server.call("GET", `/api/shell/${id}`, { query, directory: workspace })) as {
      data: { status: string }
    }
    if (info.data.status !== "running") break
    await Bun.sleep(100)
  }
  const output = (await server.call("GET", `/api/shell/${id}/output`, { query, directory: workspace })) as {
    data: { output: string }
  }
  return output.data.output
}

async function seed() {
  await fs.mkdir(workspace, { recursive: true })
  const run = (...args: string[]) => git(workspace, args)
  const write = (file: string, content: string) => Bun.write(path.join(workspace, file), content)
  await git(root, ["init", "-q", "--bare", "--initial-branch=main", remote])
  await run("init", "-q", "--initial-branch=main")
  await run("config", "user.name", "own review-git e2e")
  await run("config", "user.email", "review-git-e2e@example.test")
  await run("config", "core.autocrlf", "false")
  await write("README.md", "# review git e2e\n")
  await write("src/router.ts", ROUTER.join(""))
  await write("src/한 글.ts", "export const 한글 = 1\n")
  await write("src/it's.ts", "export const quote = 1\n")
  await run("add", "-A")
  await run("commit", "-q", "-m", "base")
  await run("remote", "add", "origin", remote)
  await run("push", "-q", "-u", "origin", "main")
  await run("checkout", "-q", "-b", "feature/git")
  await run("push", "-q", "-u", "origin", "feature/git")
  const router = [...ROUTER]
  router[2] = "export const route2 = 'changed near the top'\n"
  router[36] = "export const route36 = 'changed near the end'\n"
  await write("src/router.ts", router.join(""))
  await write("src/한 글.ts", "export const 한글 = 2\n")
  await write("src/it's.ts", "export const quote = 2\n")
  await write("notes/new.md", "# 새 메모\n")
}

/** A `gh` that never talks to GitHub: `--version` and `pr create` answer locally. */
async function fakeGh() {
  await fs.mkdir(bin, { recursive: true })
  await Bun.write(
    path.join(bin, "gh.cmd"),
    [
      "@echo off",
      'if "%1"=="--version" (echo gh version 2.99.0 own-e2e fake & exit /b 0)',
      'if "%1"=="pr" (echo Creating pull request for feature/git into main & echo https://github.example.test/own/e2e/pull/7 & exit /b 0)',
      "echo unsupported fake gh call 1>&2",
      "exit /b 1",
      "",
    ].join("\r\n"),
  )
  // Both forms: Git Bash and POSIX shells run the extension-less script, PowerShell and cmd find `gh.cmd` first.
  const script = path.join(bin, "gh")
  await Bun.write(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "gh version 2.99.0 own-e2e fake"; exit 0; fi',
      'if [ "$1" = "pr" ]; then echo "Creating pull request for feature/git into main"; echo "https://github.example.test/own/e2e/pull/7"; exit 0; fi',
      'echo "unsupported fake gh call" >&2',
      "exit 1",
      "",
    ].join("\n"),
  )
  await fs.chmod(script, 0o755)
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
}

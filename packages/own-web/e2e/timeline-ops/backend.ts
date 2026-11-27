// Timeline-ops e2e backend (revert, queue/steer, attachments, subagent; 03 §18.7, 18.9, 18.10, 18.11). Run by
// Playwright's webServer (playwright.config.ts) or by hand: `bun e2e/timeline-ops/backend.ts`.
//
// The real upstream server from source with own.accounts + own.telemetry (packages/own-accounts/test/e2e-kit), a fake
// OpenAI Responses provider with a scripted model, and two API-key accounts made through RPC ("Alpha", "Bravo" — two
// accounts so a pending switch (WAIT_SAFE) can be set up). The scripted model reads directives in the last user text:
//   [write <path>]  → adds the file with the `patch` tool (GPT models get patch, not write), then answers
//   [slow <sec>]    → waits <sec> seconds before the first byte (keeps the session busy: steer/queue, interrupt)
//   [subagent]      → calls the `subagent` tool (agent "general") whose prompt is "[child-ask] …"
//   [child-ask]     → (inside the child) calls the `shell` tool, which asks for approval: a pending child request
//   [fail-400]      → refuses the request (400 with a JSON error body): a failed turn with `error.response.body`
//   [fail-own-old]  → 400 with an older SSH host's bare sink body `{"error":"own_broker_unavailable"}` (SLM)
//   [fail-own-local] → 400 with a refusal of this PC's local model relay (`own_local_relay`, `host_scope`, SLM)
// Vite dev serves the harness at /e2e/timeline-ops/harness.html. Fake credentials only; everything lives under a temp
// root that is removed on exit.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { isRecord, type RecordedRequest, type Reply } from "../../../own-accounts/test/e2e-kit/fakes/shared"

export const OPS_PORT = Number(process.env.OWN_WEB_OPS_PORT ?? 5321)
export const OPS_TMP = process.env.OWN_WEB_OPS_TMP ?? path.join(os.tmpdir(), "own-web-timeline-ops")
export const STATE_FILE = path.join(OPS_TMP, "backend.json")

const MODEL = "gpt-5.5"
// Fake credentials only.
const KEYS = {
  alpha: "sk-proj-ownOpsAlphaFakeKey0000000000000001",
  bravo: "sk-proj-ownOpsBravoFakeKey0000000000000002",
}

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
            buildId: `own-web-ops-${process.pid}`,
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
// File revert needs snapshots, and core takes them only in git locations (core/src/snapshot.ts `enabled`).
const gitProject = path.join(server.paths.root, "projects", "revert-repo")
await fs.mkdir(gitProject, { recursive: true })
await Bun.write(path.join(gitProject, "README.md"), "# revert test\n")
for (const args of [
  ["init", "-q"],
  ["add", "README.md"],
  ["-c", "user.email=ops@example.test", "-c", "user.name=ops", "commit", "-q", "-m", "init"],
])
  if (Bun.spawnSync(["git", ...args], { cwd: gitProject }).exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed`)

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

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: OPS_PORT })

const state = {
  dev: `http://127.0.0.1:${OPS_PORT}`,
  control,
  workspace: server.paths.workspace,
  gitProject,
  model: MODEL,
  accounts: { alpha, bravo },
}
await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_OPS_READY ${JSON.stringify(state)}`)

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

/** The scripted model (see the header). Titles and compaction summaries get fixed answers. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "작업 세션" }
  if (request.body.includes("You MUST use this format for your response"))
    return { type: "text", text: "## Objective\n- 테스트\n\n## Next Move\n1. 계속" }
  const input = isRecord(request.json) && Array.isArray(request.json.input) ? request.json.input : []
  const last = input.at(-1)
  // A freeform tool's result (`patch` on a model that takes freeform input, upstream #61703) is a custom_tool_call_output.
  if (isRecord(last) && (last.type === "function_call_output" || last.type === "custom_tool_call_output")) return { type: "text", text: "도구 실행을 마쳤습니다." }
  const text = lastUserText(input)
  const write = text.match(/\[write ([^\]]+)\]/)
  // GPT models get `patch` instead of `write`/`edit` (core/src/tool/plugin/patch.ts hook).
  if (write)
    return {
      type: "tool-call",
      name: "patch",
      input: { patchText: `*** Begin Patch\n*** Add File: ${write[1]}\n+hello from ${write[1]}\n*** End Patch` },
    }
  const slow = text.match(/\[slow (\d+)\]/)
  if (slow) return { type: "text", text: "천천히 답합니다.", delayMs: Number(slow[1]) * 1000 }
  // A provider refusal with a JSON body: the turn fails and core keeps the body as `error.response.body`.
  if (text.includes("[fail-400]"))
    return {
      type: "error",
      status: 400,
      body: { error: { message: "The request was refused", type: "invalid_request_error", code: "own_e2e_refused" } },
    }
  // How own stops a turn on an SSH host (04 §8.14.5): only the body matters to the transcript, so a 400 (a 401 would
  // mark the account here).
  if (text.includes("[fail-own-old]"))
    return { type: "error", status: 400, body: { error: "own_broker_unavailable" } }
  if (text.includes("[fail-own-local]"))
    return {
      type: "error",
      status: 400,
      body: {
        error: {
          type: "own_local_relay",
          code: "host_scope",
          message: "이 로컬 모델은 이 SSH 서버에서 쓰지 않게 되어 있어요. PC의 설정 > SSH 원격 호스트에서 이 호스트의 계정 범위에 넣거나 다른 모델을 고르세요.",
        },
      },
    }
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

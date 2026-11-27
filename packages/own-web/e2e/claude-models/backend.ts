// The model @ account sheet's Claude rows (decisions CAM, 2.2.6-own.20) e2e backend. Run by this suite's Playwright
// webServer (playwright.config.ts) or by hand: `bun e2e/claude-models/backend.ts`.
//
// The real upstream server from source with own-accounts only, booted by own-team's e2e harness (read-only, `team:
// false`) with the Claude subscription slot (a fake of the bundled claude-auth on the fake Anthropic) and a Claude Agent
// account whose fake `claude` (own-team's `fake-claude.ts`) lists its models as Claude Code 2.1.329 does on this PC:
// the aliases `opus`, `fable`, `sonnet`, `haiku` labelled "Opus"…, the model each runs (`resolvedModel`), a 1M window
// for each (`get_context_usage` and the turns' `modelUsage`) and Fast on Opus and Fable. Conversations: one on Claude
// Agent `opus`, one on the Claude slot, one on the Anthropic API key. Fake credentials only; every listener binds
// 127.0.0.1; the temp root is removed on exit. Run from a path without '#'.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { CLAUDE, CLAUDE_AGENT, MODEL, startTeamFakes, startTeamServer } from "../../../own-team/test/e2e/harness"
import { responder } from "../../../own-team/test/e2e/directives"

export const CLAUDE_MODELS_PORT = Number(process.env.OWN_WEB_CLAUDE_MODELS_E2E_PORT ?? 5793)
export const CLAUDE_MODELS_TMP =
  process.env.OWN_WEB_CLAUDE_MODELS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-claude-models")
export const STATE_FILE = path.join(CLAUDE_MODELS_TMP, "backend.json")

/** Claude Code 2.1.329's list without a login, as `own/scripts/claude-agent/live-models.ts` read it on 2026-11-22. */
export const AGENT_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportsFastMode: true },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsFastMode: true,
    contextWindow: 1_000_000,
  },
  {
    value: "fable",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable",
    description: "Fable 5.2 · Most capable for your hardest and longest-running tasks",
    supportsFastMode: true,
    contextWindow: 1_000_000,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
    contextWindow: 1_000_000,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku",
    description: "Haiku 5.5 · Fastest for quick answers",
    contextWindow: 1_000_000,
  },
]

const NAME = "web-claude-models"
for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []))
  if (entry.isDirectory() && entry.name.startsWith(`own-team-e2e-${NAME}-`))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)

const fakes = startTeamFakes({ responder: responder() })
const team = await startTeamServer({
  name: NAME,
  fakes,
  team: false,
  project: "none",
  claude: true,
  claudeAgent: true,
  claudeAgentModels: AGENT_MODELS,
})
const workspace = team.server.paths.workspace
const sessions = {
  agent: await team.createSession({
    title: "Claude Agent 대화",
    model: { providerID: CLAUDE_AGENT.model.providerID, id: "opus" },
    directory: workspace,
  }),
  claude: await team.createSession({ title: "Claude 구독 대화", model: CLAUDE.model, directory: workspace }),
  key: await team.createSession({ title: "API 키 대화", model: MODEL.anthropic, directory: workspace }),
}

const password = atob(team.server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: team.server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: team.control,
})
const dev = await startViteDev({ port: CLAUDE_MODELS_PORT, hmr: false })

const state = {
  dev: `http://127.0.0.1:${CLAUDE_MODELS_PORT}`,
  control: team.control,
  ownHome: team.ownHome,
  workspace,
  sessions,
  accounts: { agent: CLAUDE_AGENT.accountID, claude: CLAUDE.accountID, key: "acc_tman" },
}
await fs.mkdir(CLAUDE_MODELS_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_CLAUDE_MODELS_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await team.stop()
  await fakes.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())

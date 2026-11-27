// Preset screens e2e backend (07 §7, §8.4 PG1/PG11 UI). Run by this suite's Playwright webServer
// (playwright.config.ts) or by hand: `bun e2e/presets/backend.ts`.
//
// The real upstream server from source with own-accounts only (no team), booted by own-team's e2e harness
// (packages/own-team/test/e2e/harness.ts, read-only, `team: false`): one fake Codex backend with ChatGPT 01, 02 and
// 03, a fake DeepSeek and a fake Anthropic (both metered API keys). Models answer through own-team's directive
// responder (packages/own-team/test/e2e/directives.ts, read-only: `[subagent <agent> <prompt>]` calls core's
// `subagent`), with these in front of it:
//   - `[sub-model <provider/model>]`: a `subagent` call that names a model, as an LLM might (the gate's `model` refusal);
//   - after a call the gate refused, a short answer; after a cap refusal it waits 25 s, so the turn still runs while
//     the chip offers `이번 메시지만 늘리기`;
//   - a subagent whose prompt holds `<<big>>` reports 2M output tokens: on DeepSeek one call spends past a $1 budget.
// Seeds (07 §8.1 `presets.set`, and one preset written into presets.json by hand, as a user may):
//   - `한 번만` (ChatGPT group): every role like the main, at most one new subagent per message;
//   - `Claude 리뷰` (ChatGPT group, by hand): the review role pinned to a Claude subscription that is not installed,
//     then to DeepSeek, so a review waits for the user's consent before it may cost money (07 §5.4 step 4);
//   - conversations on ChatGPT 01: `프리셋 단추` (GPT-5.6 Sol, no per-message effort updates: ultra changes the main and
//     asks), `울트라 Sol` (GPT-6 Sol · 높음, effort updates: ultra applies at once), `상한` (bound to `한 번만`),
//     `프리셋 밖` (`평소대로`), `동의` (bound to `Claude 리뷰`), and `예산` and `모델 묶음` (the spec binds them to the
//     presets it saves); on the Anthropic key, `울트라 Claude` (Claude Sonnet 4.5 · high, levels high and max).
// The model pool case (T4) writes `presets.json` and `codex-meta.json` under `ownHome` itself, as a user or another
// process may, once the earlier cases no longer read the ChatGPT group's list.
// own-web through Vite dev (no HMR), `/api` proxied with server-side Basic auth. Fake credentials only; every listener
// binds 127.0.0.1; the temp root is removed on exit (and an earlier run's leftovers at start). Run from a path
// without '#'.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Preset } from "@own/protocol"
import { startViteDev } from "../vite-dev"
import type { RecordedRequest, Reply } from "../../../own-accounts/test/e2e-kit"
import { responder, turn } from "../../../own-team/test/e2e/directives"
import { MODEL, startTeamFakes, startTeamServer } from "../../../own-team/test/e2e/harness"

export const PRESETS_PORT = Number(process.env.OWN_WEB_PRESETS_E2E_PORT ?? 5771)
export const PRESETS_TMP = process.env.OWN_WEB_PRESETS_E2E_TMP ?? path.join(os.tmpdir(), "own-web-presets")
export const STATE_FILE = path.join(PRESETS_TMP, "backend.json")

const NAME = "web-presets"
const BIG = "<<big>>"
/** 2M output tokens × $0.6/M on deepseek-flash: past a $1 budget in one call. */
const BIG_OUTPUT = 2_000_000
/** The Claude subscription slot `Claude 리뷰` pins; no such account exists here, so that target cannot run. */
const CLAUDE_PIN = { pin: { account: "acc_claude_slot", model: "claude-opus-5-5" } }
const SOL = { providerID: MODEL["01"].providerID, id: "gpt-6-sol", variant: "high" }

for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []))
  if (entry.isDirectory() && entry.name.startsWith(`own-team-e2e-${NAME}-`))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)

const fakes = startTeamFakes({ responder: responder({ before }) })
const team = await startTeamServer({ name: NAME, fakes, team: false, project: "none" })
const workspace = team.server.paths.workspace

// The ChatGPT group's default model as the user picks it: this backend has no Codex model list, so the price rule
// (07 §2.2 codex ③) would choose GPT-6 Astra (the priciest general model; never GPT-5.6 Cyber since MR8-16), and the
// suite's conversations run GPT-5.6 Sol.
await accounts("presets.defaults.set", { group: "codex", defaultModel: { id: MODEL["01"].id } })
const once = await savePreset({
  name: "한 번만",
  group: "codex",
  workers: { mode: "same", roles: {} },
  delegation: "on-request",
  caps: { concurrent: 3, perMessage: 1, perSession: null },
  ultraCaps: null,
})
const consent = await handWrite("Claude 리뷰", [CLAUDE_PIN, { pin: { account: "acc_tmds", model: MODEL.deepseek.id } }])

const sessions = {
  button: await team.createSession({ title: "프리셋 단추", model: MODEL["01"], directory: workspace }),
  sol: await team.createSession({ title: "울트라 Sol", model: SOL, directory: workspace }),
  caps: await bound("상한", once),
  model: await team.createSession({ title: "프리셋 밖", model: MODEL["01"], directory: workspace }),
  consent: await bound("동의", consent),
  budget: await team.createSession({ title: "예산", model: MODEL["01"], directory: workspace }),
  pool: await team.createSession({ title: "모델 묶음", model: MODEL["01"], directory: workspace }),
  // UC 2026-10-18: a Claude-group main (the Anthropic API key, `anth`) for the `켤 때 강도도 xhigh로` box.
  claude: await team.createSession({
    title: "울트라 Claude",
    model: { ...MODEL.anthropic, variant: "high" },
    directory: workspace,
  }),
}

const password = atob(team.server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: team.server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: team.control,
})
const dev = await startViteDev({ port: PRESETS_PORT, hmr: false })

const state = {
  dev: `http://127.0.0.1:${PRESETS_PORT}`,
  control: team.control,
  ownHome: team.ownHome,
  workspace,
  sessions,
  presets: { once, consent },
  accounts: { "01": "acc_tm01", "02": "acc_tm02", deepseek: "acc_tmds", anthropic: "acc_tman" },
  models: { ...MODEL, sol: SOL },
}
await fs.mkdir(PRESETS_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_PRESETS_READY ${JSON.stringify(state)}`)

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
process.stdin.resume()

// ---------------------------------------------------------------------------------------------------------------

/** The cases in front of the directive responder (see the file header); `undefined` lets it answer. */
function before(request: RecordedRequest): Reply | undefined {
  const current = turn(request)
  const refused = current.results.find((result) => result.includes("own-preset:"))
  if (refused !== undefined)
    return refused.includes("subagent cap reached")
      ? { type: "text", text: "하위 에이전트를 기다립니다.", delayMs: 25_000 }
      : { type: "text", text: "사용자에게 물어보겠습니다." }
  if (current.user.includes(BIG) && !current.user.includes("[subagent"))
    return { type: "text", text: "자식 작업을 마쳤습니다.", outputTokens: BIG_OUTPUT }
  const model = /\[sub-model (\S+)\]/.exec(current.user)?.[1]
  if (model === undefined || current.done > 0) return undefined
  return {
    type: "tool-call",
    name: "subagent",
    input: { agent: "general", description: "e2e 하위 작업", prompt: "자식 작업", model },
  }
}

async function accounts(method: string, input: unknown, directory?: string) {
  const result = await team.rpc("own.accounts", method, input, directory)
  if (result.status !== 200)
    throw new Error(`own.accounts ${method}: ${result.status} ${result.type} ${result.message}`)
  return result.output as Record<string, unknown>
}

/** `presets.set`; returns the saved preset's id. */
async function savePreset(preset: Readonly<Record<string, unknown>>) {
  const saved = await accounts("presets.set", { preset })
  const info = saved.preset as { readonly id?: unknown } | undefined
  if (typeof info?.id !== "string") throw new Error(`presets.set returned no id: ${JSON.stringify(saved)}`)
  return info.id
}

/**
 * Adds a ChatGPT-group preset whose review role has `targets` to presets.json by hand (`presets.set` refuses a target
 * that cannot run), once the service wrote the group's default model; waits until the service loaded it. The service
 * writes the file too (each group's default model as it first needs one) and does not take this writer's lock, so a
 * write of its that read the file just before this one replaces it: the preset is written again until it is loaded.
 */
async function handWrite(name: string, targets: ReadonlyArray<unknown>) {
  const file = path.join(team.ownHome, "presets.json")
  const read = async () =>
    (await Bun.file(file)
      .json()
      .catch(() => undefined)) as { readonly groups?: Record<string, { readonly presets?: unknown[] }> } | undefined
  await until(async () => {
    const json = await read()
    return json && JSON.stringify(json).includes('"defaultModel"') ? json : undefined
  }, "the service never wrote the ChatGPT group's default model")
  const id = Preset.ID.create()
  const preset = {
    id,
    name,
    group: "codex",
    workers: { mode: "by-role", roles: { "own-review": { targets, effort: "inherit" } } },
    delegation: "on-request",
    caps: Preset.CAPS,
    ultraCaps: null,
    revision: 1,
  }
  await until(async () => {
    const current = (await read()) ?? {}
    if (!JSON.stringify(current).includes(id)) {
      const codex = current.groups?.codex ?? {}
      const groups = { ...current.groups, codex: { ...codex, presets: [...(codex.presets ?? []), preset] } }
      // Written next to it and renamed, so the service's watcher never reads half a file.
      const temp = `${file}.e2e-${process.pid}`
      await Bun.write(temp, JSON.stringify({ ...current, groups }, null, 2))
      await fs.rename(temp, file)
    }
    return JSON.stringify(await accounts("presets.list", { group: "codex" })).includes(id) || undefined
  }, `${name} was never loaded`)
  return id
}

/** A conversation on ChatGPT 01 bound to `presetID` (own-web's order: create, then apply). */
async function bound(title: string, presetID: string) {
  const sessionID = await team.createSession({ title, model: MODEL["01"], directory: workspace })
  await accounts("session.preset.apply", { sessionID, presetID }, workspace)
  return sessionID
}

async function until<T>(probe: () => Promise<T | undefined>, message: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await Bun.sleep(200)
  }
  throw new Error(message)
}

// 설정 > 확장 e2e backend (17 §8.1): the real server from source with own.accounts, own.harness and own.creator (as the
// release lists them), a fake OpenAI Responses provider behind one API-key account, one conversation so the sidebar has
// a project, and four extensions in the store: `house-rules` with two versions (a fragment, a Code Mode tool and a skill),
// `loose-fetch` with an allow rule that waits for approval, `word-tools` (a generated MCP server, C2, staged as creator
// mode stages it) and `pirate` (a code plugin, C3, staged while the switch was on; the switch is off again). Vite dev serves own-web. Fake credentials only, 127.0.0.1
// only; the temp root is removed on exit. Run by this suite's Playwright webServer or by hand:
// `bun e2e/creator/backend.ts` (from packages/own-web).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { Staging } from "../../../own-creator/src/staging"
import { CreatorStore } from "../../../own-creator/src/store"

export const CREATOR_PORT = Number(process.env.OWN_WEB_CREATOR_E2E_PORT ?? 6871)
export const CREATOR_TMP = process.env.OWN_WEB_CREATOR_E2E_TMP ?? path.join(os.tmpdir(), "own-web-creator")
export const STATE_FILE = path.join(CREATOR_TMP, "backend.json")

const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownWebCreatorE2eFakeKey00000001"

const responses = startFakeOpenAIResponses({ models: [MODEL] })
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
            buildId: `own-web-creator-e2e-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
        { package: path.join(REPO_ROOT, "packages/own-creator"), options: { home: paths.ownHome } },
      ],
    }),
})

const control = path.join(server.paths.ownHome, "control")
await fs.mkdir(control, { recursive: true })

async function rpc(id: string, method: string, input: unknown, directory: string) {
  const response = await server.request("POST", `/api/rpc/${id}/${method}`, {
    body: { input },
    query: { "location[directory]": directory },
    directory,
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`${id} ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

const added = await rpc("own.accounts", "accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY }, control)
const account = added.account as { id: string; providerID: string }
await server.waitForModels([{ providerID: account.providerID, id: MODEL }])
for (let attempt = 0; ; attempt++) {
  const ready = await rpc("own.creator", "list", {}, control).then(
    () => true,
    () => false,
  )
  if (ready) break
  if (attempt === 150) throw new Error("own.creator never answered")
  await Bun.sleep(200)
}

// The store, as creator mode would have left it (written from here: the service's folder watch picks it up).
const store = new CreatorStore.Store(server.paths.ownHome, { app: "local" })
const rules = (text: string) => ({
  format: "own.ext/1",
  id: "house-rules",
  title: "House rules",
  description: "How this project's answers look.",
  items: [
    { type: "prompt.fragment", id: "style", text },
    {
      type: "tool.command",
      name: "say",
      description: "Says a word back.",
      command: "echo {{word}}",
      params: { word: { type: "string", description: "The word" } },
    },
    // A skill creator mode made, listed in 설정 > 스킬 beside own's imagegen (MR14).
    {
      type: "skill",
      name: "house-style",
      description: "How this project's answers are written.",
      content: "Write short answers.",
    },
  ],
})
const seeded = [
  await store.create(rules("Answer in one sentence."), "model", {}, "first"),
  await store.update(rules("Answer in two sentences."), "model", {}, "longer answers"),
  await store.create(
    {
      format: "own.ext/1",
      id: "loose-fetch",
      title: "Loose fetch",
      items: [
        {
          type: "tool.rule",
          rules: [{ permission: "webfetch", pattern: "https://docs.example.com/*", effect: "allow" }],
        },
      ],
    },
    "model",
  ),
]
if (seeded.some((outcome) => !outcome.ok)) throw new Error(`seeding failed: ${JSON.stringify(seeded)}`)

// Code extensions, staged first like creator mode does (typecheck, smoke, e2e) and written with their staged folders.
async function staged(manifest: unknown) {
  const checked = CreatorStore.checkManifest(manifest)
  if (!checked.ok) throw new Error(`invalid seed: ${JSON.stringify(checked.problems)}`)
  const result = await Staging.run(store, checked.extension, { bun: process.execPath })
  if (!result.ok) throw new Error(`staging failed: ${JSON.stringify(result.checks)}`)
  const created = await store.create(manifest, "model", {}, "first", result.staged)
  if (!created.ok) throw new Error(`seeding failed: ${JSON.stringify(created)}`)
}
await staged({
  format: "own.ext/1",
  id: "word-tools",
  title: "Word tools",
  kind: "mcp",
  items: [
    {
      type: "mcp.server",
      name: "words",
      files: {
        "server.ts": `import { serve } from "./own-mcp.ts"\nserve({ name: "words", tools: { count_words: { description: "Counts words.", input: { type: "object", properties: { text: { type: "string" } } }, run: (args) => \`words: \${String(args.text).split(" ").length}\` } } })\n`,
      },
      smoke: [{ tool: "count_words", arguments: { text: "a b" }, expect: "words: 2" }],
    },
  ],
})
await store.settings({ plugins: true })
await staged({
  format: "own.ext/1",
  id: "pirate",
  title: "Pirate replies",
  kind: "plugin",
  items: [
    {
      type: "plugin.code",
      hooks: ["context"],
      files: {
        "plugin.ts": `import { definePlugin } from "./own-plugin.ts"\nexport default definePlugin({ hooks: { context: (request) => { request.messages.push({ role: "user", content: "arr" }) } } })\n`,
      },
    },
  ],
})
await store.settings({ plugins: false })
const project = path.join(server.paths.root, "project-a")
await fs.mkdir(project, { recursive: true })

const session = await server.createSession({ title: "확장 시험", model: { providerID: account.providerID, id: MODEL } })

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
const dev = await startViteDev({ port: CREATOR_PORT, hmr: false })

const state = {
  dev: `http://127.0.0.1:${CREATOR_PORT}`,
  control,
  home: server.paths.ownHome,
  project,
  session: { id: session.id },
}
await fs.mkdir(CREATOR_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_CREATOR_READY ${JSON.stringify(state)}`)

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

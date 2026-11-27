// What each harness sends a model (own/docs/10 §3.3, 12): boots a source server with own.harness and fake OpenAI
// Responses, DeepSeek and Anthropic providers, sends one "hi" per harness × model, and writes every request body to
// `<out>/<harness>.<model>.json`. Nothing reaches a real provider. Every session runs the plugin's default prompt
// variant (own's revision, 10 §3.9) unless `--prompt reference` or `--prompt own` names one.
//
//   bun script/prompt-capture.ts [--out <dir>] [--prompt reference|own]
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Schema } from "effect"
import { Options } from "../src/options.js"
import {
  REPO_ROOT,
  anthropicProvider,
  deepseekProvider,
  openAIResponsesProvider,
  opencodeConfig,
  startFakeAnthropic,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  startOpencodeServer,
} from "../../own-accounts/test/e2e-kit"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-prompts"))
const PROMPT =
  OwnHarness.PROMPTS.find((id) => id === option("prompt")) ?? Schema.decodeUnknownSync(Options.Info)({}).prompt
const HARNESSES = ["opencode", "codex", "pi"] as const
const MODELS = [
  { providerID: "fake-openai", id: "gpt-6-astra" },
  { providerID: "fake-openai", id: "gpt-5.5" },
  { providerID: "fake-deepseek", id: "deepseek-v4-pro" },
  { providerID: "fake-anthropic", id: "claude-opus-5-5" },
  { providerID: "fake-anthropic", id: "claude-sonnet-5-5" },
] as const

const openai = startFakeOpenAIResponses({ models: ["gpt-6-astra", "gpt-5.5"] })
const deepseek = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
const anthropic = startFakeAnthropic({ models: ["claude-opus-5-5", "claude-sonnet-5-5"] })
const fakes = { "fake-openai": openai, "fake-deepseek": deepseek, "fake-anthropic": anthropic } as const
fs.mkdirSync(OUT, { recursive: true })
const server = await startOpencodeServer({
  startupTimeoutMs: 170_000,
  projectConfig: true,
  env: { OWN_OPEN_CODE: "1" },
  config: (paths) => {
    fs.mkdirSync(paths.workspace, { recursive: true })
    fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "(Project instructions from AGENTS.md go here.)\n")
    Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
    return opencodeConfig({
      providers: {
        "fake-openai": { ...openAIResponsesProvider(openai, { apiKey: "fake-key", models: ["gpt-6-astra", "gpt-5.5"] }), canonical: "openai" },
        "fake-deepseek": { ...deepseekProvider(deepseek, { apiKey: "fake-key", models: ["deepseek-v4-pro"] }), canonical: "deepseek" },
        "fake-anthropic": { ...anthropicProvider(anthropic, { apiKey: "fake-key", models: ["claude-opus-5-5", "claude-sonnet-5-5"] }), canonical: "anthropic" },
      },
      plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
    })
  },
})
try {
  // A cold start can take longer than core's 5 s plugin activation wait; the next poll finds them active.
  for (let attempt = 1; ; attempt++) {
    const ready = await server.waitForModels([...MODELS], 60_000).then(() => true, () => false)
    if (ready) break
    if (attempt === 5) throw new Error("models never listed")
  }
  for (const harness of HARNESSES)
    for (const model of MODELS) {
      const fake = fakes[model.providerID]
      const created = (await server.call("POST", "/api/session", {
        body: {
          title: `${harness} ${model.id}`,
          model,
          location: { directory: server.paths.workspace },
          metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness, PROMPT) },
        },
      })) as { data: { id: string } }
      // Let the plugin write the harness's tool gate before the first request.
      await Bun.sleep(1_500)
      const before = fake.requests.length
      fake.enqueue({ type: "text", text: "ok" })
      await server.prompt(created.data.id, "hi")
      await server.waitIdle(created.data.id)
      const bodies = fake.requests.slice(before).flatMap((request) => (request.method === "POST" ? [request.json] : []))
      fs.writeFileSync(path.join(OUT, `${harness}.${model.id}.json`), JSON.stringify(bodies.at(-1), null, 2))
      console.log(harness, model.id, bodies.length, "request(s)")
    }
} finally {
  await server.stop()
  await Promise.all(Object.values(fakes).map((fake) => fake.stop()))
}

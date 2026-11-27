// Live check of Codex rust-v0.165.0's incremental tools windows through the `codex` harness (own/docs/10 §6.10,
// incremental.ts): a real ChatGPT account behind the local forwarder (credentials.ts, the server holds placeholders
// only), the bodies the forwarder saw (`OWN_LIVE_BODIES`). One short session, two requests: account 01 on gpt-6.1-sol,
// then the same session on gpt-6.1-terra. It prints each request's status, model, the base instructions' first line,
// the developer texts right before the newest user message and whether the second request extends the first, and
// writes them to <out>/incremental.json.
//
//   OWN_LIVE_BODIES=<out>/bodies bun script/live/incremental.ts --out <out>
//
// Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { REPO_ROOT, opencodeConfig, startOpencodeServer } from "../../../own-accounts/test/e2e-kit"
import { startForwarder } from "./forwarder.js"

const at = process.argv.indexOf("--out")
const OUT = path.resolve(
  at >= 0 ? process.argv[at + 1]! : path.join(process.env.TEMP ?? "/tmp", "own-live-incremental"),
)
const BODIES = process.env.OWN_LIVE_BODIES
if (BODIES === undefined) throw new Error("set OWN_LIVE_BODIES so the forwarder writes the request bodies")
const MODELS = ["gpt-6.1-sol", "gpt-6.1-terra"]
const PROMPTS = ["Reply with the single word one.", "Reply with the single word two."]
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

fs.mkdirSync(BODIES, { recursive: true })
const forwarder = startForwarder(path.join(OUT, "forwarder.jsonl"))
const server = await startOpencodeServer({
  startupTimeoutMs: 480_000,
  projectConfig: true,
  env: { OWN_OPEN_CODE: "1" },
  config: () =>
    opencodeConfig({
      providers: {
        "chatgpt-01": {
          name: "ChatGPT 01",
          canonical: "openai",
          package: "@opencode/ai/providers/openai",
          settings: {
            baseURL: `${forwarder.url}/chatgpt/01`,
            apiKey: "forwarded",
            transport: "http",
            encoding: "zstd",
          },
          headers: { originator: "opencode", "x-codex-beta-features": "remote_compaction_v2" },
          models: Object.fromEntries(
            MODELS.map((id) => [id, { name: id, limit: { context: 400_000, input: 272_000, output: 128_000 } }]),
          ),
        },
      },
      plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
    }),
})
try {
  await server.waitForModels(
    MODELS.map((id) => ({ providerID: "chatgpt-01", id })),
    300_000,
  )
  const directory = path.join(server.paths.root, "incremental")
  fs.mkdirSync(directory, { recursive: true })
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: "incremental",
      model: { providerID: "chatgpt-01", id: MODELS[0] },
      location: { directory },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: { id: "codex", v: 1 } },
    },
    directory,
  })) as { data: { id: string } }
  for (const [index, prompt] of PROMPTS.entries()) {
    if (index > 0) await server.switchModel(created.data.id, { providerID: "chatgpt-01", id: MODELS[index]! })
    await server.prompt(created.data.id, prompt)
    await server.waitIdle(created.data.id)
  }
  const report = requests()
  fs.writeFileSync(path.join(OUT, "incremental.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await server.stop()
  await forwarder.stop()
}

/** Each model request the forwarder saw, in order, and whether each extends the one before it. */
function requests() {
  const log = fs
    .readFileSync(path.join(OUT, "forwarder.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => typeof line.path === "string" && line.path.endsWith("/responses"))
  const bodies = fs
    .readdirSync(BODIES!)
    .toSorted()
    .map((name) => JSON.parse(fs.readFileSync(path.join(BODIES!, name), "utf8")) as Record<string, any>)
    .filter((body) => Array.isArray(body.input))
  const text = (item: Record<string, any> | undefined) =>
    Array.isArray(item?.content) ? item.content.map((part: Record<string, any>) => String(part.text)) : []
  return bodies.map((body, index) => {
    const input = body.input as Array<Record<string, any>>
    const user = input.findLastIndex(
      (item) => item.role === "user" && PROMPTS.some((prompt) => text(item).includes(prompt)),
    )
    const previous = bodies[index - 1]?.input as Array<Record<string, any>> | undefined
    const plain = (item: Record<string, any>) =>
      JSON.stringify(item.role === "assistant" ? { ...item, id: undefined } : item)
    return {
      status: log[index]?.status,
      model: body.model,
      base: text(input[1])[0]?.split("\n")[0],
      before: input
        .slice(input.slice(0, user).findLastIndex((item) => item.role !== "developer") + 1, user)
        .map((item) => text(item).map((part: string) => part.slice(0, 120))),
      extendsPrevious:
        previous === undefined
          ? undefined
          : JSON.stringify(input.slice(0, previous.length).map(plain)) === JSON.stringify(previous.map(plain)),
      items: input.length,
    }
  })
}

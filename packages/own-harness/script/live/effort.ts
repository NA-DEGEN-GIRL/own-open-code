// Live check of Codex rust-v0.165.0's reasoning-effort updates through the `codex` harness (own/docs/10 §6.10): real
// ChatGPT accounts behind the local forwarder (credentials.ts, the server holds placeholders only), the bodies the
// forwarder saw (`OWN_LIVE_BODIES`). Two short sessions, about four requests:
// - account 01, gpt-6.1-terra at its default effort: one task that creates a scratch file with apply_patch;
// - account 03, gpt-6.1-sol: a turn at high, then a turn at low.
// It prints each request's status, top-level effort and `configuration_update` items (with the user text before each)
// and writes them to <out>/effort.json.
//
//   OWN_LIVE_BODIES=<out>/bodies bun script/live/effort.ts --out <out>
//
// Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { REPO_ROOT, opencodeConfig, startOpencodeServer, type OpencodeServer } from "../../../own-accounts/test/e2e-kit"
import { startForwarder } from "./forwarder.js"

const at = process.argv.indexOf("--out")
const OUT = path.resolve(at >= 0 ? process.argv[at + 1]! : path.join(process.env.TEMP ?? "/tmp", "own-live-effort"))
const BODIES = process.env.OWN_LIVE_BODIES
if (BODIES === undefined) throw new Error("set OWN_LIVE_BODIES so the forwarder writes the request bodies")
const MODELS = ["gpt-6.1-terra", "gpt-6.1-sol"]
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
      providers: Object.fromEntries(
        ["01", "03"].map((alias) => [
          `chatgpt-${alias}`,
          {
            name: `ChatGPT ${alias}`,
            canonical: "openai",
            package: "@opencode/ai/providers/openai",
            settings: {
              baseURL: `${forwarder.url}/chatgpt/${alias}`,
              apiKey: "forwarded",
              transport: "http",
              encoding: "zstd",
            },
            headers: { originator: "opencode", "x-codex-beta-features": "remote_compaction_v2" },
            models: Object.fromEntries(
              MODELS.map((id) => [id, { name: id, limit: { context: 400_000, input: 272_000, output: 128_000 } }]),
            ),
          },
        ]),
      ),
      plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
    }),
})
try {
  await server.waitForModels(
    [
      { providerID: "chatgpt-01", id: "gpt-6.1-terra" },
      { providerID: "chatgpt-03", id: "gpt-6.1-sol" },
    ],
    300_000,
  )
  const terra = await session(server, "terra", { providerID: "chatgpt-01", id: "gpt-6.1-terra" })
  await turn(
    server,
    terra,
    "Use apply_patch to create the file note.txt containing the single line `terra ok`. Then reply with the single word done.",
  )
  const file = path.join(terra.directory, "note.txt")
  const sol = await session(server, "sol", { providerID: "chatgpt-03", id: "gpt-6.1-sol", variant: "high" })
  await turn(server, sol, "Reply with the single word one.")
  await server.switchModel(sol.id, { providerID: "chatgpt-03", id: "gpt-6.1-sol", variant: "low" })
  await turn(server, sol, "Reply with the single word two.")
  const report = {
    note: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined,
    requests: requests(),
  }
  fs.writeFileSync(path.join(OUT, "effort.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await server.stop()
  await forwarder.stop()
}

async function session(
  server: OpencodeServer,
  name: string,
  model: { providerID: string; id: string; variant?: string },
) {
  const directory = path.join(server.paths.root, `effort-${name}`)
  fs.mkdirSync(directory, { recursive: true })
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `effort ${name}`,
      model,
      location: { directory },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: { id: "codex", v: 1 } },
    },
    directory,
  })) as { data: { id: string } }
  return { id: created.data.id, directory }
}

async function turn(server: OpencodeServer, target: { id: string; directory: string }, text: string) {
  await server.prompt(target.id, text)
  await server.waitIdle(target.id)
  // The session goes idle between steps too; settle on a still history.
  await Bun.sleep(5_000)
  await server.waitIdle(target.id)
}

/** Each model request the forwarder saw, in order: route, status, effort, and its updates with the user text before. */
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
    .map((name) => ({
      name,
      body: JSON.parse(fs.readFileSync(path.join(BODIES!, name), "utf8")) as Record<string, any>,
    }))
    .filter((entry) => Array.isArray(entry.body.input))
  return bodies.map((entry, index) => {
    const input = entry.body.input as Array<Record<string, any>>
    return {
      file: entry.name,
      status: log[index]?.status,
      model: entry.body.model,
      reasoning: entry.body.reasoning,
      first: input[0]?.type,
      updates: input.flatMap((item, position) => {
        if (item.type !== "configuration_update") return []
        const before = input[position - 1]
        return [
          {
            position,
            effort: item.reasoning?.effort,
            after: before?.role === "user" ? before.content?.[0]?.text : before?.type,
          },
        ]
      }),
      items: input.length,
    }
  })
}

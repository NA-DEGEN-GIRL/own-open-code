// Live check of full-history forks keeping the parent's prefix (own/docs/10 §6.11, Codex 0.164.0 #55548): ChatGPT
// account 01, gpt-6.1-sol at low effort, the codex harness. The root is asked to spawn one sub-agent with the full
// history for a one-word job and to end its turn without waiting. The forwarder's meter lets three model requests out
// (the root's spawn, the child's first request, the root's closing answer) and refuses any further one. The check: the
// child's first request starts with the root's first request byte for byte, and its usage shows cached input.
//
//   bun script/live/fork-prefix.ts [--out <dir>]
//
// Credentials stay in the forwarder process (script/live/credentials.ts); the server's config holds placeholders.
// Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { REPO_ROOT, opencodeConfig, startOpencodeServer } from "../../../own-accounts/test/e2e-kit"
import type { Usage } from "./forwarder.js"

const args = process.argv.slice(2)
const at = args.indexOf("--out")
const OUT = path.resolve(at >= 0 ? args[at + 1]! : path.join(process.env.TEMP ?? "/tmp", "own-live-fork"))
const BODIES = path.join(OUT, "bodies")
fs.mkdirSync(BODIES, { recursive: true })
// The forwarder reads this when it loads: the request bodies (no credential in them) are what the check compares.
process.env.OWN_LIVE_BODIES = BODIES
const { startForwarder } = await import("./forwarder.js")

const MAX_REQUESTS = 3
const MODEL = { providerID: "chatgpt-01", id: "gpt-6.1-sol", variant: "low" }
const TASK =
  'Call spawn_agent exactly once with task_name "echo", fork_turns "all" and the message "Reply with the single word pong.". Do not call wait_agent or any other tool. After the spawn_agent call returns, end your turn by replying with the single word done.'
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

type Item = Record<string, unknown>
const usages: Array<{ readonly at: string; readonly usage: Usage }> = []
let sent = 0
const forwarder = startForwarder(path.join(OUT, "forwarder.jsonl"), {}, 0, {
  allow: () => sent++ < MAX_REQUESTS,
  record: (entry) => void usages.push({ at: entry.at, usage: entry.usage }),
})
const server = await startOpencodeServer({
  startupTimeoutMs: 480_000,
  projectConfig: true,
  keepTemp: true,
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
          models: {
            "gpt-6.1-sol": { name: "gpt-6.1-sol", limit: { context: 400_000, input: 272_000, output: 128_000 } },
          },
        },
      },
      plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
    }),
})
console.log(`server ${server.url} root ${server.paths.root}`)
try {
  for (
    let attempt = 1;
    !(await server.waitForModels([MODEL], 60_000).then(
      () => true,
      () => false,
    ));
    attempt++
  )
    if (attempt === 10) throw new Error("models never listed")
  const directory = path.join(server.paths.root, "fork")
  fs.mkdirSync(directory, { recursive: true })
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: "live fork prefix",
      model: MODEL,
      location: { directory },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: { id: "codex", v: 1 } },
    },
    directory,
  })) as { data: { id: string } }
  const root = created.data.id
  await server.prompt(root, TASK)
  // The root's turn ends on its own; the child runs alongside. Wait until three requests went out and answered.
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline && (sent < MAX_REQUESTS || usages.length < Math.min(sent, MAX_REQUESTS)))
    await Bun.sleep(1_000)
  await Bun.sleep(5_000)
  const children = (
    (await server.call("GET", "/api/session", { query: { parentID: root, limit: "10" }, directory })) as {
      data: Array<{ id: string }>
    }
  ).data.map((child) => child.id)
  // Stop anything still running so no further request is even tried.
  for (const id of [root, ...children])
    await server.call("POST", `/api/session/${id}/interrupt`, { directory }).catch(() => undefined)

  const bodies = fs
    .readdirSync(BODIES)
    .filter((name) => name.endsWith("-chatgpt-01.json"))
    .sort()
    .map((name) => ({
      at: new Date(Number(name.split("-")[0])).toISOString(),
      body: JSON.parse(fs.readFileSync(path.join(BODIES, name), "utf8")) as { input: Array<Item> },
    }))
  const isChild = (body: { input: Array<Item> }) => JSON.stringify(body.input).includes("Task name: /root/echo")
  const parent = bodies.find((entry) => !isChild(entry.body))
  const child = bodies.find((entry) => isChild(entry.body))
  const prefix = parent === undefined ? 0 : parent.body.input.length
  const same =
    parent !== undefined &&
    child !== undefined &&
    JSON.stringify(child.body.input.slice(0, prefix)) === JSON.stringify(parent.body.input)
  const usageAt = (entry: { at: string } | undefined) => usages.find((line) => line.at === entry?.at)?.usage
  const result = {
    requests: bodies.length,
    refused: Math.max(0, sent - MAX_REQUESTS),
    children: children.length,
    parentItems: prefix,
    childItems: child?.body.input.length,
    childStartsWithParent: same,
    added: child?.body.input
      .slice(prefix)
      .map((item) => `${String(item.type)}${item.role ? `/${String(item.role)}` : ""}`),
    parentUsage: usageAt(parent),
    childUsage: usageAt(child),
    usages,
  }
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  fs.writeFileSync(path.join(OUT, "server.log"), server.logs())
  await server.stop()
  await forwarder.stop()
}

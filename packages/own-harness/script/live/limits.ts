// Live check of Codex plan limits and speed tiers on the app's own path (02 §7.1, §4.8): a source-booted server with
// own.accounts (and own.harness), one ChatGPT login imported as a linked `codex` account whose endpoint is the local
// forwarder (the account's tokens in the server are fake; the forwarder swaps in the real ones and forwards to
// chatgpt.com only, the Responses WebSocket included), then one short prompt per harness on the slot's default
// transport. Prints what the forwarder saw (plan-limit header names, WebSocket frame types), the windows own stored
// (`quota.snapshot`, asked on the control Location as the app does), the `quota.updated` events, and, with `--speed`,
// the session's speed view after each prompt (a tier own judged ignored or refused falls back there).
//
//   bun script/live/limits.ts [--alias 01] [--model gpt-5.6-luna] [--harness codex,opencode] [--speed ultrafast]
//                             [--prompts 1] [--compact] [--idle <seconds>] [--release <build dir>]
//
// `--release` runs a release build instead of the source (`<dir>\app\opencode.exe` with `<dir>\plugins\own-accounts`,
// e.g. `D:\own-integration\own\.out\build\2.0.24-own.3`); builds before 2.0.28 have no own.harness, so their sessions
// run plain.
//
// `--idle` waits that long after the import before any prompt and prints the windows then: the leader's `wham/usage`
// poll (02 §7.1) fills an account no conversation used, about a minute after the start.
//
// Real requests: one per prompt (plus core's title request), one more with `--compact`, one usage read with `--idle`. Run from a path without '#'.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  REPO_ROOT,
  chatGPTAccount,
  mintChatGPTTokens,
  opencodeConfig,
  recordServerEvents,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { startForwarder } from "./forwarder.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const ALIAS = option("alias") ?? "01"
const MODEL = option("model") ?? "gpt-5.6-luna"
const HARNESSES = (option("harness") ?? "codex,opencode").split(",")
const SPEED = option("speed")
const PROMPTS = Number(option("prompts") ?? "1")
const COMPACT = args.includes("--compact")
const IDLE = Number(option("idle") ?? "0")
const OUT = path.resolve(option("out") ?? path.join(os.tmpdir(), "own-live-limits"))
const RELEASE = option("release")

type Json = Record<string, unknown>

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const log = path.join(OUT, "forwarder.jsonl")
  await fs.rm(log, { force: true })
  const forwarder = startForwarder(log)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-live-limits-")))
  // Fake tokens: the server never holds a real credential. A long expiry keeps own from refreshing them.
  const tokens = mintChatGPTTokens(chatGPTAccount({ accountID: "acct-live-limits" }), Date.now(), 12 * 3_600_000)
  await writeCodexMultiProviderProfiles(root, [{ id: ALIAS, alias: `live ${ALIAS}`, tokens }])
  const blocked = `${forwarder.url}/blocked`
  const harness = RELEASE ? path.join(RELEASE, "plugins", "own-harness") : path.join(REPO_ROOT, "packages/own-harness")
  const plain = !(await fs.stat(harness).then(
    () => true,
    () => false,
  ))
  const server = await startOpencodeServer({
    startupTimeoutMs: 480_000,
    env: { OWN_OPEN_CODE: "1" },
    ...(RELEASE ? { command: [path.join(RELEASE, "app", "opencode.exe")] } : {}),
    config: (paths) =>
      opencodeConfig({
        providers: {},
        plugins: [
          {
            package: RELEASE
              ? path.join(RELEASE, "plugins", "own-accounts")
              : path.join(REPO_ROOT, "packages/own-accounts"),
            options: {
              home: paths.ownHome,
              buildId: `live-limits-${process.pid}`,
              vault: "memory",
              // The ChatGPT backend through the forwarder; nothing else may reach a real ChatGPT endpoint.
              endpoints: {
                codex: `${forwarder.url}/chatgpt/${ALIAS}`,
                oauthIssuer: blocked,
                chatgpt: `${forwarder.url}/chatgpt-backend/${ALIAS}`,
              },
              codexImportRoot: root,
              ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            },
          },
          ...(plain ? [] : [{ package: harness, options: {} }]),
        ],
      }),
  })
  const control = path.join(server.paths.ownHome, "control")
  await fs.mkdir(control, { recursive: true })
  const rpc = async (method: string, input: unknown = {}) => {
    const located = Object.entries(OwnAccounts.MethodLocation).some(([name, at]) => name === method && at === "control")
    const directory = located ? control : server.paths.workspace
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const body = (await response.json()) as { readonly output?: Json }
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body)}`)
    return body.output ?? {}
  }
  try {
    // The control Location boots first, so it leads the runtime as in the app.
    await rpc("health")
    const events = await recordServerEvents(server)
    const planned = await rpc("accounts.import.codex.plan", { profileID: ALIAS })
    const executed = await rpc("accounts.import.codex.execute", { nonce: planned.nonce })
    const account = executed.account as { readonly id: string; readonly providerID: string }
    await server.waitForModels([{ providerID: account.providerID, id: MODEL }], 120_000)
    console.log(`account ${account.id} slot ${account.providerID} model ${MODEL}`)
    if (IDLE > 0) {
      await Bun.sleep(IDLE * 1000)
      const idle = await rpc("quota.snapshot", { accountIDs: [account.id] })
      console.log(JSON.stringify({ idle: IDLE, windows: windowsOf(idle.windows) }, null, 1))
    }
    for (const harness of HARNESSES) await run(server, rpc, account, harness)
    const quota = events.own("quota.updated").map((event) => windowsOf(event.data.windows))
    console.log(JSON.stringify({ quotaUpdated: quota }, null, 1))
    await events.close()
  } finally {
    await fs.writeFile(path.join(OUT, "server.log"), server.logs())
    await server.stop()
    await forwarder.stop()
    await fs.rm(root, { recursive: true, force: true })
    console.log(`forwarder log ${log}`)
    console.log((await fs.readFile(log, "utf8").catch(() => "")).trim())
  }
}

async function run(
  server: OpencodeServer,
  rpc: (method: string, input?: unknown) => Promise<Json>,
  account: { readonly id: string; readonly providerID: string },
  harness: string,
) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `limits ${harness}`,
      model: { providerID: account.providerID, id: MODEL },
      location: { directory: server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: { id: harness, v: 1 } },
    },
    directory: server.paths.workspace,
  })) as { readonly data: { readonly id: string } }
  const sessionID = created.data.id
  if (SPEED) console.log(JSON.stringify({ harness, set: await rpc("session.speed.set", { sessionID, speed: SPEED }) }))
  const started = Date.now()
  for (const index of Array.from({ length: PROMPTS }, (_, at) => at)) {
    await server.prompt(sessionID, `Reply with the single word ok. (${index + 1})`)
    await server.waitIdle(sessionID)
    if (SPEED) {
      const view = await rpc("session.speed.get", { sessionID })
      console.log(
        JSON.stringify({
          harness,
          prompt: index + 1,
          effective: view.effective,
          tier: view.tier,
          served: view.served,
          offers: view.offers,
        }),
      )
    }
  }
  if (COMPACT) {
    await server.request("POST", `/api/session/${sessionID}/compact`, { body: {} })
    await server.waitIdle(sessionID)
  }
  // `quota.updated` is sent at most every 5 s per account; the snapshot answers at once.
  await Bun.sleep(1_500)
  const snapshot = await rpc("quota.snapshot", { accountIDs: [account.id] })
  const windows = windowsOf(snapshot.windows).filter((window) => Number(window.observedAt) >= started - 1_000)
  console.log(JSON.stringify({ harness, sessionID, windows }, null, 1))
}

function windowsOf(value: unknown) {
  return (Array.isArray(value) ? value : []).map((window: Json) => ({
    id: window.id,
    source: window.source,
    label: window.label,
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes,
    resetAt: window.resetAt,
    remaining: window.remaining,
    status: window.status,
    observedAt: window.observedAt,
  }))
}

await main()

// Live check of own's image tool's Codex fallback (02 §9.6, decisions IM): one small image through a real ChatGPT
// subscription (accounts 01 and 03 only), with no OpenAI API key configured.
//
// A source server runs own-accounts (own-accounts' e2e kit, a fresh temp root) with two linked ChatGPT accounts whose
// tokens are fake. Their Codex requests go to the live forwarder's `/chatgpt-team` route, which picks the real login 01
// or 03 by the fake `chatgpt-account-id` and puts in its credential; their plan-usage polls (`wham/usage`) go to a small
// local proxy that sends each to the forwarder's `/chatgpt-backend/<alias>/wham/usage`. Everything else (token refresh)
// stays on a local fake. The conversation's model is a local fake that calls `image_generate` once; only the image
// request reaches ChatGPT. The forwarder writes the request bodies (`OWN_LIVE_BODIES`) so one can be checked for
// personal data; the run checks the image body holds the prompt and the image settings only.
//
//   bun script/live/image.ts --out C:/t/im1/live [--keep] [--only 01]
//
// Prints the remaining limit of each account before and after, the account and model the result card names, the
// saved image and the time. Spends one image of one subscription's Codex usage.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnImage } from "@own/protocol"
import {
  openAIResponsesProvider,
  startFakeCodex,
  startFakeOpenAIResponses,
  startPresetRig,
  toolParts,
  waitUntil,
  type RecordedRequest,
  type Reply,
} from "../../../own-accounts/test/e2e-kit"

const args = process.argv.slice(2)
const out = path.resolve(args[args.indexOf("--out") + 1] ?? "C:/t/im1/live")
const keep = args.includes("--keep")
// `--only 01`: the other account is switched off in the chain (`codexOff`), so only that login is asked.
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined
fs.mkdirSync(out, { recursive: true })
const bodies = path.join(out, "bodies")
fs.mkdirSync(bodies, { recursive: true })
process.env.OWN_LIVE_BODIES = bodies
// The forwarder reads OWN_LIVE_BODIES when it loads.
const { startForwarder } = await import("./forwarder.js")

const ONE = { accountID: "acct-live-image-01", email: "one@example.test", plan: "plus" }
const THREE = { accountID: "acct-live-image-03", email: "three@example.test", plan: "plus" }
const ALIAS: Readonly<Record<string, string>> = { [ONE.accountID]: "01", [THREE.accountID]: "03" }
const CHAT = { providerID: "fake-chat", id: "gpt-fake" }
const PROMPT = "A small flat icon of a red cube on a plain white background."

const note = (entry: Record<string, unknown>) => {
  const line = { at: new Date().toISOString(), ...entry }
  fs.appendFileSync(path.join(out, "run.jsonl"), `${JSON.stringify(line)}\n`)
  console.log(JSON.stringify(line))
}

const forwarder = startForwarder(path.join(out, "forwarder.jsonl"), ALIAS)
// own-accounts' `wham/usage` poll names the account in `chatgpt-account-id`; the forwarder's usage route is per alias.
const usage = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const alias = ALIAS[request.headers.get("chatgpt-account-id") ?? ""]
    if (request.method !== "GET" || url.pathname !== "/backend-api/wham/usage" || alias === undefined)
      return new Response("not served", { status: 404 })
    return fetch(`${forwarder.url}/chatgpt-backend/${alias}/wham/usage`)
  },
})
const codex = startFakeCodex()
const calls = { count: 0 }
const chat = startFakeOpenAIResponses({ models: [CHAT.id], responder: reply })

function reply(request: RecordedRequest): Reply {
  calls.count++
  const json = request.json as { tools?: unknown[] } | undefined
  // The title request has no tools.
  if (!Array.isArray(json?.tools) || json.tools.length === 0) return { type: "text", text: "빨간 큐브" }
  const answered = JSON.stringify(json).includes("function_call_output")
  return answered
    ? { type: "text", text: "만들었어요." }
    : { type: "tool-call", name: "image_generate", input: { prompt: PROMPT, model: OwnImage.FLARE } }
}

const real = async (alias: string) => {
  const response = await fetch(`${forwarder.url}/chatgpt-backend/${alias}/wham/usage`)
  const body = (await response.json().catch(() => ({}))) as {
    rate_limit?: { primary_window?: { used_percent?: number }; secondary_window?: { used_percent?: number } }
  }
  return {
    alias,
    status: response.status,
    primary: body.rate_limit?.primary_window?.used_percent,
    secondary: body.rate_limit?.secondary_window?.used_percent,
  }
}

const started = Date.now()
const rig = await startPresetRig({
  name: "live-image",
  codex,
  chatgpt: [
    { id: "01", tokens: codex.login(ONE) },
    { id: "03", tokens: codex.login(THREE) },
  ],
  endpoints: { codex: `${forwarder.url}/chatgpt-team`, chatgpt: `${usage.url.origin}/backend-api` },
  config: { providers: { [CHAT.providerID]: openAIResponsesProvider(chat, { apiKey: "fake-chat-key", models: [CHAT.id] }) } },
  models: [CHAT],
}).catch(async (error: unknown) => {
  await Promise.all([forwarder.stop(), usage.stop(true), codex.stop(), chat.stop()])
  throw error
})
try {
  note({ step: "server", ms: Date.now() - started, home: rig.home })
  note({ step: "limits-before", accounts: await Promise.all(["01", "03"].map(real)) })
  await rig.call("policy.set", { patch: { imageGenerate: true, image: { quality: "low", size: "1024x1024" } } })
  // own's poll learns both accounts' limits (once a minute for an account nothing has observed).
  await waitUntil(
    async () => {
      const view = await rig.call("image.get", {})
      const rows = view.codex as Array<{ label: string; usedPercent?: number }>
      return rows.length === 2 && rows.every((row) => row.usedPercent !== undefined) ? rows : false
    },
    "own never learned both accounts' limits",
    180_000,
  )
  if (only !== undefined) {
    const rows = (await rig.call("image.get", {})).codex as Array<{ accountID: string; label: string }>
    const off = rows.filter((row) => !row.label.includes(only)).map((row) => row.accountID)
    if (off.length !== rows.length - 1) throw new Error(`--only ${only}: no single account labelled so`)
    await rig.call("policy.set", { patch: { image: { codexOff: off } } })
  }
  const before = await rig.call("image.get", {})
  note({ step: "own-order", keys: before.keys, codex: before.codex })

  const session = await rig.server.createSession({ model: CHAT, title: "live image" })
  // The image call's approval (`image_generate`), answered once like a user would.
  const answered = new Set<unknown>()
  const approve = setInterval(() => {
    for (const event of rig.events.events) {
      if (event.type !== "permission.asked" || event.data.sessionID !== session.id || answered.has(event)) continue
      answered.add(event)
      note({ step: "approve", action: event.data.action })
      void rig.server
        .call("POST", `/api/session/${session.id}/permission/${String(event.data.id)}/reply`, { body: { decision: "once" } })
        .catch(() => undefined)
    }
  }, 100)
  const begin = Date.now()
  await rig.server.prompt(session.id, "빨간 큐브 아이콘을 하나 만들어 주세요.")
  await rig.server.waitIdle(session.id)
  clearInterval(approve)
  const ms = Date.now() - begin
  const parts = await toolParts(rig.server, session.id, "image_generate")
  const state = parts[0]?.state as { status?: string; metadata?: Record<string, unknown>; error?: unknown } | undefined
  const card = state?.metadata?.[OwnImage.CARD_KEY] as OwnImage.CardData | undefined
  const saved = card?.path && fs.existsSync(card.path) ? fs.statSync(card.path).size : undefined
  if (card?.path && saved !== undefined) fs.copyFileSync(card.path, path.join(out, path.basename(card.path)))
  note({ step: "image", ms, status: state?.status, card, savedBytes: saved, error: state?.error })
  note({ step: "limits-after", accounts: await Promise.all(["01", "03"].map(real)) })

  // The image request's body: the prompt and the image settings, nothing else.
  const sent = fs
    .readdirSync(bodies)
    .map((name) => fs.readFileSync(path.join(bodies, name), "utf8"))
    .filter((text) => text.startsWith("{") && "prompt" in (JSON.parse(text) as Record<string, unknown>))
  const files = sent.length
  const keys = sent.map((text) => Object.keys(JSON.parse(text) as Record<string, unknown>).sort())
  const user = os.userInfo().username.toLowerCase()
  const personal = sent.some((text) => /@|kor\b/i.test(text) || text.toLowerCase().includes(user))
  note({ step: "bodies", files, keys, personal })
  if (personal) throw new Error("an image request body held something personal")
} finally {
  if (!keep) await rig.stop()
  await Promise.all([forwarder.stop(), usage.stop(true), codex.stop(), chat.stop()])
  note({ step: "done", ms: Date.now() - started })
}

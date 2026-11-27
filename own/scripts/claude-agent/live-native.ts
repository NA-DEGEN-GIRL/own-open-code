// Live check of own's Claude Agent route, phase 3 (02 §8.10.11–12, core P-043 and P-044), through the product path: a
// source-booted own server (own.accounts with a Claude Agent account under OWN_HOME, own.harness) runs the Agent SDK's
// bundled claude.exe on the live kit's Anthropic API key, and ChatGPT 01 through the live kit, both held only by own's
// forwarder (packages/own-harness/script/live/forwarder.ts). Never a Claude subscription, never the user's ~/.claude,
// never the user's live service.
//
//   OWN_CA_ROOT=C:/t/cdN bun own/scripts/claude-agent/live-native.ts           (the scratch folder: new and empty)
//
// Isolation as live-accounts.ts: the server's TEMP, USERPROFILE, HOME, APPDATA and LOCALAPPDATA under OWN_CA_ROOT, a
// PATH of system folders, Git and Bun only, no CLAUDE_* or ANTHROPIC_*; claude gets P-042's allow-list of that. Order:
//   1. Privacy capture: a local gate in front of the forwarder records the first Anthropic and the first ChatGPT body
//      and refuses them; each is searched for e-mail addresses, this Windows user's name, the computer name and user
//      profile paths outside OWN_CA_ROOT. Only clean bodies open the gate.
//   2. A ChatGPT 01 turn (codex harness) reads a file with a tool; the conversation moves to Claude Agent (sonnet) and
//      asks about it: the Anthropic request must carry the earlier turn as tool_use and tool_result blocks, with no
//      `<conversation-checkpoint>` text (P-043).
//   3. A context reset and its undo on that conversation: the undo resumes the Claude conversation from before the reset.
//   4. Ten conversations at once on a cap of four (haiku): all answer, never more than four claude processes at once,
//      and the rest waited for a slot (P-044).
//   5. Every forwarded body is checked like the capture; the spend is computed from the usage the responses reported.
// Prints results only: no body, key or personal value is ever printed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = process.env.OWN_CA_ROOT
if (!ROOT || !fs.existsSync(ROOT) || fs.readdirSync(ROOT).length > 0)
  throw new Error("OWN_CA_ROOT must name an existing, empty scratch folder")
const REPO = path.resolve(import.meta.dirname, "../../..")
const at = {
  tmp: path.join(ROOT, "tmp"),
  home: path.join(ROOT, "home"),
  bodies: path.join(ROOT, "bodies"),
  log: path.join(ROOT, "log"),
}
for (const dir of Object.values(at)) fs.mkdirSync(dir, { recursive: true })
process.env.TEMP = at.tmp
process.env.TMP = at.tmp
process.env.OWN_LIVE_BODIES = at.bodies
for (const name of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC_)/i.test(name)) delete process.env[name]

const system = process.env.SystemRoot ?? "C:\\Windows"
const git = ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\usr\\bin"].filter((dir) => fs.existsSync(dir))
const isolation = {
  USERPROFILE: at.home,
  HOME: at.home,
  HOMEDRIVE: path.parse(at.home).root.replace(/\\$/, ""),
  HOMEPATH: at.home.slice(path.parse(at.home).root.length - 1),
  TEMP: at.tmp,
  TMP: at.tmp,
  APPDATA: path.join(at.home, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(at.home, "AppData", "Local"),
  PATH: [path.dirname(process.execPath), ...git, path.join(system, "System32"), system].join(path.delimiter),
  USERNAME: undefined,
  USERDOMAIN: undefined,
  COMPUTERNAME: undefined,
  LOGONSERVER: undefined,
  ONEDRIVE: undefined,
  OneDrive: undefined,
}
for (const dir of [isolation.APPDATA, isolation.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true })
const SDK_CLAUDE = path.join(
  REPO,
  "node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
)
const CLAUDE = { providerID: "claude-agent", id: "sonnet" }
const CLAUDE_SMALL = { providerID: "claude-agent", id: "haiku" }
/** At most this many Anthropic model requests go out (the meter refuses more). */
const CAP = 80
const CODE_WORD = "AMBER-FALCON-7"

const { OwnHarness } = await import(path.join(REPO, "packages/own-protocol/src/rpc-harness.ts"))
const harness = await import(path.join(REPO, "packages/own-team/test/e2e/harness.ts"))
const { startForwarder } = await import(path.join(REPO, "packages/own-harness/script/live/forwarder.ts"))
const { hasAnthropic } = await import(path.join(REPO, "packages/own-harness/script/live/credentials.ts"))
const { kv } = await import(path.join(REPO, "packages/own-team/test/e2e/inspect.ts"))
if (!hasAnthropic()) throw new Error("No Anthropic key: run packages/own-harness/script/live/set-key.ps1 first")
const GPT = { providerID: harness.SLOT["01"], id: "gpt-6-astra", variant: "low" }

const results: Record<string, unknown> = {}
const print = (key: string, value: unknown) => {
  results[key] = value
  console.log(key, JSON.stringify(value))
  fs.writeFileSync(path.join(at.log, "results.json"), JSON.stringify(results, null, 2))
}

/** What a request body must not hold: e-mail addresses, this user's name, the computer's name, other user paths. */
function privacy(body: string) {
  const user = os.userInfo().username
  const computer = os.hostname()
  const emails = [...body.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
    .map((match) => match[0].toLowerCase())
    .filter((email) => email !== "noreply@anthropic.com")
  const lower = body.toLowerCase()
  const root = ROOT!.replaceAll("/", "\\").toLowerCase()
  const paths = [
    ...new Set([...body.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\/)[^"\s,;)`'<>]+/g)].map((match) => match[0])),
  ]
  const normal = (item: string) => item.replaceAll("\\\\", "\\").replaceAll("/", "\\").toLowerCase()
  // Codex's prompt (the codex harness hands it to Claude as the role) shows file references with this made-up path.
  const outside = paths.filter(
    (item) =>
      !normal(item).startsWith(root) &&
      !normal(item).startsWith(REPO.replaceAll("/", "\\").toLowerCase()) &&
      !normal(item).startsWith(system.toLowerCase()) &&
      !normal(item).startsWith("c:\\repo\\project\\"),
  )
  const findings = [
    ...(emails.length > 0 ? [`email(${[...new Set(emails.map((email) => email.split("@")[1]))].join(",")})`] : []),
    ...(user.length > 2 && lower.includes(user.toLowerCase()) ? ["user-name"] : []),
    ...(computer.length > 2 && lower.includes(computer.toLowerCase()) ? ["computer-name"] : []),
    ...(lower.includes(os.homedir().toLowerCase()) || lower.includes(os.homedir().replaceAll("\\", "\\\\").toLowerCase())
      ? ["home"]
      : []),
    ...(outside.some((item) => /\\users\\/i.test(normal(item))) ? ["user-profile-path"] : []),
  ]
  return { clean: findings.length === 0 && outside.length === 0, findings, paths: paths.length, outside: outside.length }
}

const decode = (body: ArrayBuffer, encoding: string | null) =>
  encoding === "zstd"
    ? new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(body)))
    : new TextDecoder().decode(body)

// The gate in front of the forwarder: closed, it records the model request bodies and refuses (the privacy capture).
const gate = { open: false, forward: "", captured: [] as Array<{ route: string; body: string }> }
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const route = url.pathname.startsWith("/anthropic") ? "anthropic" : "chatgpt"
    const model = /\/(messages|responses)$/.test(url.pathname)
    if (!gate.open && model) {
      if (body) {
        const text = decode(body, request.headers.get("content-encoding"))
        gate.captured.push({ route, body: text })
        fs.writeFileSync(path.join(at.log, `capture-${gate.captured.length}-${route}.json`), text)
      }
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "own live check: capture only" } },
        { status: 400 },
      )
    }
    const headers = new Headers([...request.headers].filter(([name]) => !/^(host|content-length|connection)$/i.test(name)))
    return fetch(`${gate.forward}${url.pathname}${url.search}`, { method: request.method, headers, body })
  },
})

const usage = { requests: 0, input: 0, read: 0, write: 0, output: 0, chatgpt: 0 }
const forwarder = startForwarder(
  path.join(at.log, "forwarder.jsonl"),
  { [harness.CHATGPT["01"].accountID]: "01" },
  0,
  {
    allow: (route: string) => (route === "anthropic" ? ++usage.requests <= CAP : (usage.chatgpt++, true)),
    record: (line: { route: string; usage: { input: number; read: number; write: number; output: number } }) => {
      if (line.route !== "anthropic") return
      usage.input += line.usage.input
      usage.read += line.usage.read
      usage.write += line.usage.write
      usage.output += line.usage.output
    },
  },
)
gate.forward = forwarder.url

const fakes = harness.startTeamFakes()
const server = await harness.startTeamServer({
  name: "cd-live",
  team: false,
  claudeAgent: true,
  fakes,
  codexTransport: "http",
  accountsOptions: {
    endpoints: {
      codex: `http://127.0.0.1:${proxy.port}/chatgpt-team`,
      oauthIssuer: fakes.codex.url,
      chatgpt: `${fakes.codex.url}/backend-api`,
      openai: `${fakes.codex.url}/v1`,
    },
  },
  plugins: [{ package: path.join(REPO, "packages/own-harness"), options: {} }],
  env: { ...isolation, OPENCODE_CLAUDE_PATH: SDK_CLAUDE },
  config: {
    providers: {
      "claude-agent": {
        settings: { baseURL: `http://127.0.0.1:${proxy.port}/anthropic`, authToken: "forwarded-by-own-live" },
      },
    },
  },
})
print("server", { root: path.relative(ROOT, server.root), claude: path.basename(SDK_CLAUDE) })
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
  { action: "read", resource: "**", effect: "allow" },
]

const session = async (title: string, harnessID: string, model: Record<string, string>, directory: string) => {
  const created = (await server.server.call("POST", "/api/session", {
    body: { title, model, location: { directory }, permissions: FULL, metadata: { [OwnHarness.META_KEY]: { id: harnessID, v: 1 } } },
    directory,
  })) as { data: { id: string } }
  return created.data.id
}

const workspace = (name: string) => {
  const directory = path.join(server.root, name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "note.txt"), `The code word is ${CODE_WORD}.\n`)
  return directory
}

const record = (sessionID: string) =>
  (kv(server.server.paths.database, "opencode.provider.claude-agent")[`sessions/${sessionID}`] ?? {}) as {
    claudeSessionID?: string
    previous?: Array<{ claudeSessionID: string }>
  }

const lastReply = async (sessionID: string) => {
  const messages = (await server.server.messages(sessionID)) as Array<Record<string, unknown>>
  const assistant = messages.find((message) => message.type === "assistant")
  const text = JSON.stringify(assistant ?? {})
  return { error: /"error"/.test(text), text }
}

/** The Anthropic bodies the forwarder wrote since `count` bodies existed. */
const bodiesSince = (count: number) => {
  const files = fs
    .readdirSync(at.bodies)
    .sort()
    .map((name) => path.join(at.bodies, name))
  return files.slice(count).map((file) => fs.readFileSync(file, "utf8"))
}
const bodyCount = () => fs.readdirSync(at.bodies).length

/** What the last Anthropic body of a turn carried: tool_use and tool_result blocks, checkpoint text, a needle. */
function shape(bodies: string[], needle: string) {
  const anthropic = bodies.filter((body) => body.includes('"messages"') && body.includes('"system"'))
  const last = anthropic.at(-1)
  if (!last) return { found: false }
  const json = JSON.parse(last) as { messages: Array<{ role: string; content: unknown }> }
  const blocks = json.messages.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as Array<{ type: string; name?: string }>) : [],
  )
  return {
    found: true,
    messages: json.messages.length,
    toolUse: blocks.filter((block) => block.type === "tool_use").map((block) => block.name),
    toolResults: blocks.filter((block) => block.type === "tool_result").length,
    checkpointText: last.includes("conversation-checkpoint"),
    needle: last.includes(needle),
  }
}

try {
  // 1. Privacy capture (the gate refuses; nothing leaves this PC).
  const capture = workspace("ws-capture")
  const claudeProbe = await session("capture claude", "claude-code", CLAUDE, capture)
  await server.turn(claudeProbe, "Reply with the word OK.")
  const gptProbe = await session("capture gpt", "codex", GPT, capture)
  await server.turn(gptProbe, "Reply with the word OK.")
  const checks = gate.captured.map((item) => ({ route: item.route, ...privacy(item.body) }))
  const check = {
    bodies: gate.captured.map((item) => item.route),
    prompted: gate.captured.filter((item) => item.body.includes("Reply with the word OK.")).length,
    clean: checks.length >= 2 && checks.every((item) => item.clean),
    findings: [...new Set(checks.flatMap((item) => item.findings))],
    paths: checks.reduce((sum, item) => sum + item.paths, 0),
    outside: checks.reduce((sum, item) => sum + item.outside, 0),
  }
  print("privacy-capture", check)
  if (!check.clean || !gate.captured.some((item) => item.route === "anthropic") || !gate.captured.some((item) => item.route === "chatgpt"))
    throw new Error("privacy check failed or incomplete: the live part does not run")
  gate.open = true

  // 2. A ChatGPT turn with a tool call, then a move to Claude Agent.
  const directory = workspace("ws-move")
  const moved = await session("move", "codex", GPT, directory)
  await server.turn(moved, "Read the file note.txt in the working directory with a tool and tell me the code word in it.")
  const gptReply = await lastReply(moved)
  print("gpt-turn", { error: gptReply.error, codeWord: gptReply.text.includes(CODE_WORD) })
  await server.server.call("POST", `/api/session/${moved}/model`, { body: { model: CLAUDE }, directory })
  const before = bodyCount()
  await server.turn(moved, "Which code word did you find a moment ago, and with which tool? Answer in one short line.")
  const claudeReply = await lastReply(moved)
  const first = record(moved).claudeSessionID
  print("move-to-claude", {
    reply: { error: claudeReply.error, codeWord: claudeReply.text.includes(CODE_WORD) },
    conversation: first !== undefined,
    request: shape(bodiesSince(before), CODE_WORD),
  })

  // 3. A context reset and its undo.
  const created = (await server.server.call("POST", `/api/session/${moved}/reset`, { body: {}, directory })) as {
    data: { id: string }
  }
  await server.turn(moved, "Reply with the word RESET-OK only.")
  const reset = record(moved).claudeSessionID
  const undone = await server.server.request("DELETE", `/api/session/${moved}/reset/${created.data.id}`, { directory })
  const beforeUndo = bodyCount()
  await server.turn(moved, "The earlier conversation is back. Repeat the code word only.")
  const undoReply = await lastReply(moved)
  const restored = record(moved)
  print("reset-undo", {
    undone: undone.status,
    resetConversationNew: reset !== undefined && reset !== first,
    undoResumedOld: restored.claudeSessionID === first,
    keptReset: (restored.previous ?? []).some((item) => item.claudeSessionID === reset),
    reply: { error: undoReply.error, codeWord: undoReply.text.includes(CODE_WORD) },
    request: shape(bodiesSince(beforeUndo), CODE_WORD),
  })

  // 4. Ten conversations at once on a cap of four.
  await server.accounts("claudeAgent.pool.set", { processes: 4 })
  const pool = { peak: 0, waitedMax: 0, polls: 0 }
  let polling = true
  const poll = (async () => {
    while (polling) {
      const status = (await server.accounts("claudeAgent.status", {}).catch(() => undefined)) as
        | { pool?: { live: number; waiting: unknown[]; over: number } }
        | undefined
      if (status?.pool) {
        pool.polls++
        pool.peak = Math.max(pool.peak, status.pool.live)
        pool.waitedMax = Math.max(pool.waitedMax, status.pool.waiting.length)
      }
      await Bun.sleep(150)
    }
  })()
  const parallel = workspace("ws-parallel")
  const ids = await Promise.all(
    Array.from({ length: 10 }, (_, index) => session(`parallel ${index}`, "claude-code", CLAUDE_SMALL, parallel)),
  )
  const started = Date.now()
  await Promise.all(ids.map((id, index) => server.turn(id, `Reply with the word PONG-${index} only.`)))
  polling = false
  await poll
  const replies = await Promise.all(ids.map(async (id, index) => (await lastReply(id)).text.includes(`PONG-${index}`)))
  print("parallel-10-cap-4", {
    seconds: Math.round((Date.now() - started) / 1000),
    answered: replies.filter(Boolean).length,
    peakLive: pool.peak,
    maxWaiting: pool.waitedMax,
    polls: pool.polls,
  })
} finally {
  print("usage", usage)
  // Anthropic list prices (USD per million tokens): Sonnet input 3, cache write 3.75 (5 min), cache read 0.3, output 15;
  // the haiku requests are priced as Sonnet here, so the figure is an upper bound.
  const spend = (usage.input * 3 + usage.write * 3.75 + usage.read * 0.3 + usage.output * 15) / 1_000_000
  print("spend-usd-upper-bound", Math.round(spend * 1000) / 1000)
  await server.stop().catch(() => undefined)
  await fakes.stop()
  await forwarder.stop()
  proxy.stop(true)
  const bodies = fs.readdirSync(at.bodies).map((name) => path.join(at.bodies, name))
  const checks = bodies.map((file) => privacy(fs.readFileSync(file, "utf8")))
  print("privacy-live", {
    bodies: bodies.length,
    clean: checks.every((item) => item.clean),
    findings: [...new Set(checks.flatMap((item) => item.findings))],
    outside: checks.reduce((sum, item) => sum + item.outside, 0),
  })
}

// Live check of own's Claude Agent route through the product path (02 §8.10 phase 2, decisions CAG): a source-booted
// own server (own.accounts with a Claude Agent account under OWN_HOME, own.harness) runs the real `claude` (the Agent
// SDK's bundled claude.exe, OPENCODE_CLAUDE_PATH) on an Anthropic API key that only own's live forwarder holds
// (packages/own-harness/script/live/forwarder.ts, the key from set-key.ps1). Never a Claude subscription, never the
// user's ~/.claude, never the user's live service.
//
//   OWN_CA_ROOT=C:/t/ccN bun own/scripts/claude-agent/live-accounts.ts           (the scratch folder: new and empty)
//
// Isolation: this process's TEMP (and so the server's whole temp root: OWN_HOME, the account folder, the workspaces) is
// under OWN_CA_ROOT, the server gets USERPROFILE, HOME, HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA and TEMP there and a
// PATH of system folders, Git and Bun only, and no CLAUDE_* or ANTHROPIC_* variable. claude gets P-042's allow-list
// of that. Order:
//   1. Privacy capture: the provider's base URL is a local gate that first records the request body and refuses it; the
//      body is searched for e-mail addresses, this Windows user's name, the computer name and user profile paths
//      outside OWN_CA_ROOT. Only a clean body opens the gate to the forwarder.
//   2. A short bugfix (three seeded bugs, `bun test` decides) on Claude Agent with the claude-code harness, and one with
//      the pi harness handing its prompt over. A request meter caps the Anthropic requests.
//   3. A resume after a forced process restart: the server is killed (its claude with it) and booted again; the next
//      turn resumes the same Claude conversation from the shared transcript folder.
//   4. Every forwarded body is checked like the capture; the spend is computed from the usage the responses reported.
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
// Before anything reads it: the harness's temp root (os.tmpdir()) and the forwarder's body folder.
process.env.TEMP = at.tmp
process.env.TMP = at.tmp
process.env.OWN_LIVE_BODIES = at.bodies
for (const name of Object.keys(process.env))
  if (/^(CLAUDE|ANTHROPIC_)/i.test(name)) delete process.env[name]

const system = process.env.SystemRoot ?? "C:\\Windows"
const git = ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\usr\\bin"].filter((dir) => fs.existsSync(dir))
const isolation = {
  USERPROFILE: at.home,
  HOME: at.home,
  HOMEDRIVE: path.parse(at.home).root.replace(/\\$/, ""),
  HOMEPATH: at.home.slice(path.parse(at.home).root.length - 1),
  TEMP: at.tmp,
  TMP: at.tmp,
  PATH: [path.dirname(process.execPath), ...git, path.join(system, "System32"), system].join(path.delimiter),
  USERNAME: undefined,
  USERDOMAIN: undefined,
  COMPUTERNAME: undefined,
  LOGONSERVER: undefined,
  ONEDRIVE: undefined,
  OneDrive: undefined,
}
// OWN_CA_CLAUDE runs another claude binary (a copy of an older Claude Code under the scratch folder, CAG-49).
const SDK_CLAUDE =
  process.env.OWN_CA_CLAUDE ||
  path.join(
    REPO,
    "node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
  )
// OWN_CA_QUICK=1 stops after the privacy capture and one short turn (a few requests: the binary runs a conversation).
const QUICK = process.env.OWN_CA_QUICK === "1"
const MODEL = { providerID: "claude-agent", id: "sonnet" }
/** At most this many Anthropic model requests go out (the meter refuses more). */
const CAP = 100

const { OwnHarness } = await import(path.join(REPO, "packages/own-protocol/src/rpc-harness.ts"))
const harness = await import(path.join(REPO, "packages/own-team/test/e2e/harness.ts"))
const { startForwarder } = await import(path.join(REPO, "packages/own-harness/script/live/forwarder.ts"))
const { TASKS } = await import(path.join(REPO, "packages/own-harness/script/live/tasks.ts"))
const { kv } = await import(path.join(REPO, "packages/own-team/test/e2e/inspect.ts"))
const FIXTURE = path.join(REPO, "packages/own-harness/script/live/fixtures/bugfix")

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
  // A drive letter after a non-word character, then a JSON-escaped backslash or a slash: `o:\n1.` (a word before a
  // newline escape) is no path.
  const paths = [
    ...new Set([...body.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\/)[^"\s,;)`'<>]+/g)].map((match) => match[0])),
  ]
  const normal = (item: string) => item.replaceAll("\\\\", "\\").replaceAll("/", "\\").toLowerCase()
  // Paths outside the scratch folder are allowed only for the repository's own binary and the system folder.
  const outside = paths.filter(
    (item) =>
      !normal(item).startsWith(root) &&
      !normal(item).startsWith(REPO.replaceAll("/", "\\").toLowerCase()) &&
      !normal(item).startsWith(system.toLowerCase()),
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

// The gate in front of the forwarder: closed, it records the body and refuses (the privacy capture).
const gate = { open: false, forward: "", captured: [] as string[] }
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    if (!gate.open) {
      if (body && url.pathname.endsWith("/messages")) {
        const text = new TextDecoder().decode(body)
        gate.captured.push(text)
        // Kept in the scratch folder for a look by hand; never printed.
        fs.writeFileSync(path.join(at.log, `capture-${gate.captured.length}.json`), text)
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

const usage = { requests: 0, input: 0, read: 0, write: 0, output: 0 }
const forwarder = startForwarder(path.join(at.log, "forwarder.jsonl"), {}, 0, {
  allow: (route: string) => route === "anthropic" && ++usage.requests <= CAP,
  record: (line: { usage: { input: number; read: number; write: number; output: number } }) => {
    usage.input += line.usage.input
    usage.read += line.usage.read
    usage.write += line.usage.write
    usage.output += line.usage.output
  },
})
gate.forward = `${forwarder.url}/anthropic`

const server = await harness.startTeamServer({
  name: "ca-live",
  team: false,
  claudeAgent: true,
  plugins: [{ package: path.join(REPO, "packages/own-harness"), options: {} }],
  env: { ...isolation, OPENCODE_CLAUDE_PATH: SDK_CLAUDE },
  config: {
    providers: {
      "claude-agent": { settings: { baseURL: `http://127.0.0.1:${proxy.port}`, authToken: "forwarded-by-own-live" } },
    },
  },
})
print("server", { root: path.relative(ROOT, server.root), claude: path.basename(SDK_CLAUDE) })
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

const session = async (title: string, id: string, directory: string) => {
  const created = (await server.server.call("POST", "/api/session", {
    body: {
      title,
      model: MODEL,
      location: { directory },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: { id, v: 1 } },
    },
    directory,
  })) as { data: { id: string } }
  return created.data.id
}

const workspace = (name: string) => {
  const directory = path.join(server.root, name)
  fs.mkdirSync(directory, { recursive: true })
  fs.cpSync(FIXTURE, directory, { recursive: true })
  for (const file of fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((item) => item.endsWith(".txt")))
    fs.renameSync(path.join(directory, file), path.join(directory, file.slice(0, -".txt".length)))
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "bugfix", type: "module" }, null, 2))
  return directory
}

const tests = (directory: string) => {
  const run = Bun.spawnSync([process.execPath, "test"], { cwd: directory, env: { ...process.env, ...isolation } })
  const text = `${run.stdout.toString()}\n${run.stderr.toString()}`
  const pass = Number(/(\d+) pass/.exec(text)?.[1] ?? 0)
  const fail = Number(/(\d+) fail/.exec(text)?.[1] ?? 0)
  return { pass, fail, ok: run.exitCode === 0 && fail === 0 && pass > 0 }
}

const conversation = (sessionID: string) => {
  const saved = kv(server.server.paths.database, "opencode.provider.claude-agent")[`sessions/${sessionID}`] as
    | { claudeSessionID?: string }
    | undefined
  return saved?.claudeSessionID
}

const replyOf = async (sessionID: string) => {
  const messages = await server.server.messages(sessionID)
  const text = JSON.stringify(messages.at(0) ?? {})
  return { error: /"error"/.test(text), chars: text.length }
}

try {
  // 1. Privacy capture (the gate refuses; nothing leaves this PC).
  const capture = workspace("ws-capture")
  const probe = await session("capture", "claude-code", capture)
  await server.turn(probe, "Reply with the word OK.")
  const checks = gate.captured.map(privacy)
  const prompted = gate.captured.some((body) => body.includes("Reply with the word OK."))
  const check = {
    requests: gate.captured.length,
    prompted,
    clean: prompted && checks.every((item) => item.clean),
    findings: [...new Set(checks.flatMap((item) => item.findings))],
    paths: checks.reduce((sum, item) => sum + item.paths, 0),
    outside: checks.reduce((sum, item) => sum + item.outside, 0),
  }
  print("privacy-capture", check)
  if (!check.clean) throw new Error("privacy check failed: the live part does not run")
  gate.open = true

  if (QUICK) {
    const quick = await session("quick", "claude-code", workspace("ws-quick"))
    await server.turn(quick, "Reply with the word PINEAPPLE and nothing else.")
    const messages = JSON.stringify(await server.server.messages(quick))
    print("quick-turn", {
      replied: messages.includes("PINEAPPLE"),
      versionError: /did not report its version|너무 오래돼서/.test(messages),
      reply: await replyOf(quick),
    })
    throw new Error("quick mode: done")
  }

  // 2. A short bugfix with the claude-code harness, then with pi handing its prompt over.
  const runs: Record<string, string> = {}
  for (const id of ["claude-code", "pi"]) {
    const directory = workspace(`ws-${id}`)
    const before = fs.readFileSync(path.join(directory, "test", "lib.test.ts"), "utf8")
    const sessionID = await session(`bugfix ${id}`, id, directory)
    runs[id] = sessionID
    const started = Date.now()
    await server.server.prompt(sessionID, TASKS.bugfix)
    await server.server.waitIdle(sessionID).catch(() => server.server.waitIdle(sessionID))
    print(`bugfix-${id}`, {
      seconds: Math.round((Date.now() - started) / 1000),
      tests: tests(directory),
      testsTouched: fs.readFileSync(path.join(directory, "test", "lib.test.ts"), "utf8") !== before,
      conversation: conversation(sessionID) !== undefined,
      reply: await replyOf(sessionID),
    })
  }

  // 3. A forced process restart: the server (and its claude) killed, booted again on the same root.
  const resumed = runs["claude-code"]!
  const before = conversation(resumed)
  const transcript = () =>
    fs
      .readdirSync(path.join(harness.claudeAgentTranscripts(server.ownHome)), { recursive: true, encoding: "utf8" })
      .filter((name) => before !== undefined && name.endsWith(`${before}.jsonl`))
      .map((name) => fs.statSync(path.join(harness.claudeAgentTranscripts(server.ownHome), name)).size)[0] ?? 0
  const size = transcript()
  await server.restart({ kill: true })
  await server.turn(resumed, "Which files under src/ did you change? Reply with their paths only, one per line.")
  print("resume-after-kill", {
    sameConversation: before !== undefined && conversation(resumed) === before,
    transcriptGrew: transcript() > size,
    reply: await replyOf(resumed),
  })
} finally {
  print("usage", usage)
  // Anthropic list prices for Sonnet (USD per million tokens): input 3, cache write 3.75 (5 min) / 6 (1 h), cache read
  // 0.3, output 15. Claude Code writes one-hour cache entries on a plan and five-minute ones on an API key.
  const spend = (usage.input * 3 + usage.write * 3.75 + usage.read * 0.3 + usage.output * 15) / 1_000_000
  print("spend-usd", Math.round(spend * 1000) / 1000)
  await server.stop().catch(() => undefined)
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

// Live check of the Claude Agent route on an SSH host (02 §8.10.13, decisions CAG-R): the host is own-remote's fake-SSH
// harness (Git Bash plays it; a real OpenCode server from source in mode "remote"), the PC is a source-booted own
// server whose provider runs the real `claude` (the Agent SDK's bundled claude.exe, OPENCODE_CLAUDE_PATH) on an
// Anthropic API key that only own's live forwarder holds (packages/own-harness/script/live/forwarder.ts, the key from
// set-key.ps1). Never a Claude subscription, never the user's ~/.claude, never the user's live service, no real SSH.
//
//   OWN_CA_ROOT=C:/t/crN bun own/scripts/claude-agent/live-remote.ts           (the scratch folder: new and empty)
//
// Isolation: this process's TEMP (the harness's and both servers' temp roots) is under OWN_CA_ROOT; HOME, USERPROFILE,
// APPDATA, LOCALAPPDATA and TEMP point there, PATH holds system folders, Git and Bun only, and no CLAUDE_* or
// ANTHROPIC_* variable is left. The PC's claude gets P-042's allow-list of that. Order:
//   1. Privacy capture: the PC provider's base URL is a local gate that records a request body and refuses it; the body
//      is searched for e-mail addresses, this Windows user's name, the computer name and user profile paths outside
//      OWN_CA_ROOT. Only a clean body opens the gate to the forwarder.
//   2. A host conversation on `claude-agent/sonnet` asks Claude to read a file that exists only in the host's workspace
//      with the read tool and to answer its marker: the tool runs on the host, the model call leaves from the PC.
//   3. A disconnect and a reconnect, then one more turn: the same Claude conversation resumes.
//   4. Every forwarded body is checked like the capture; the host's files and the outputs hold no key or e-mail.
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
const system = process.env.SystemRoot ?? "C:\\Windows"
const git = ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\usr\\bin"].filter((dir) => fs.existsSync(dir))
// The forwarder's key is unsealed with this user's DPAPI (its profile and PowerShell) before the environment below
// moves the profile into the scratch folder; it stays in this process's memory and is never printed.
const credentials = await import(path.join(REPO, "packages/own-harness/script/live/credentials.ts"))
await credentials.anthropic()
// Before anything else reads them: every server and helper this script starts inherits this environment.
for (const name of Object.keys(process.env))
  if (/^(CLAUDE|ANTHROPIC_|OPENCODE_)/i.test(name) || /^(USERNAME|USERDOMAIN|COMPUTERNAME|LOGONSERVER|ONEDRIVE)$/i.test(name))
    delete process.env[name]
Object.assign(process.env, {
  TEMP: at.tmp,
  TMP: at.tmp,
  OWN_LIVE_BODIES: at.bodies,
  USERPROFILE: at.home,
  HOME: at.home,
  APPDATA: path.join(at.home, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(at.home, "AppData", "Local"),
  PATH: [path.dirname(process.execPath), ...git, path.join(system, "System32"), system].join(path.delimiter),
})
const SDK_CLAUDE = path.join(
  REPO,
  "node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
)
const MODEL = { providerID: "claude-agent", id: "sonnet" }
const MARKER = "HOST-ONLY-MARKER-5530-QUINCE"
/** At most this many Anthropic model requests go out (the meter refuses more). */
const CAP = 40
const VERSION = "2.0.18-own.9"

const Harness = await import(path.join(REPO, "packages/own-remote/test/harness/remote.ts"))
const kit = await import(path.join(REPO, "packages/own-accounts/test/e2e-kit/index.ts"))
const { startForwarder } = await import(path.join(REPO, "packages/own-harness/script/live/forwarder.ts"))

const results: Record<string, unknown> = {}
const print = (key: string, value: unknown) => {
  results[key] = value
  console.log(key, JSON.stringify(value))
  fs.writeFileSync(path.join(at.log, "results.json"), JSON.stringify(results, null, 2))
}

const user = os.userInfo().username
const computer = os.hostname()
const realHome = os.userInfo().homedir
/** What a request body must not hold: e-mail addresses, this user's name, the computer's name, other user paths. */
function privacy(body: string) {
  const emails = [...body.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
    .map((match) => match[0].toLowerCase())
    .filter((email) => email !== "noreply@anthropic.com")
  const lower = body.toLowerCase()
  const root = ROOT!.replaceAll("/", "\\").toLowerCase()
  const paths = [
    ...new Set([...body.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\/)[^"\s,;)`'<>]+/g)].map((match) => match[0])),
  ]
  const normal = (item: string) => item.replaceAll("\\\\", "\\").replaceAll("/", "\\").toLowerCase()
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
    ...(lower.includes(realHome.toLowerCase()) || lower.includes(realHome.replaceAll("\\", "\\\\").toLowerCase())
      ? ["home"]
      : []),
    ...(outside.some((item) => /\\users\\/i.test(normal(item))) ? ["user-profile-path"] : []),
  ]
  return { clean: findings.length === 0 && outside.length === 0, findings, paths: paths.length, outside: outside.length }
}

// The gate in front of the forwarder: closed, it records the body and refuses (the privacy capture).
const gate = { open: false, forward: "", captured: [] as string[], forwarded: [] as string[] }
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const text = body ? new TextDecoder().decode(body) : ""
    if (!gate.open) {
      if (body && url.pathname.endsWith("/messages")) {
        gate.captured.push(text)
        fs.writeFileSync(path.join(at.log, `capture-${gate.captured.length}.json`), text)
      }
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "own live check: capture only" } },
        { status: 400 },
      )
    }
    if (body && url.pathname.endsWith("/messages")) gate.forwarded.push(text)
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

const buildId = `live-claude-agent-remote-${process.pid}`
const configFile = path.join(at.log, "e2e-config.json")
const harness = Harness.create({
  version: VERSION,
  hosts: {
    live: {
      env: {
        OWN_FAKE_SERVICE: Harness.toPosix(path.join(REPO, "packages/own-accounts/test/remote/e2e/real-service.ts")),
        OWN_E2E_CONFIG: Harness.toPosix(configFile),
      },
    },
  },
})
fs.writeFileSync(
  configFile,
  JSON.stringify({
    repo: REPO,
    buildId,
    endpoints: {},
    logs: path.join(harness.testRoot, "e2e-logs"),
    transpilerCache: kit.E2E_TRANSPILER_CACHE,
  }),
)
const local = await kit.startOpencodeServer({
  env: { OWN_OPEN_CODE: "1", OPENCODE_CLAUDE_PATH: SDK_CLAUDE },
  config: (paths: { ownHome: string }) =>
    kit.opencodeConfig({
      // The PC provider's connection: the gate, with a placeholder the forwarder replaces by the key.
      providers: {
        "claude-agent": { settings: { baseURL: `http://127.0.0.1:${proxy.port}`, authToken: "forwarded-by-own-live" } },
      },
      plugins: [
        {
          package: path.join(REPO, "packages/own-accounts"),
          options: { home: paths.ownHome, buildId, vault: "memory", broker: { brokerWaitMs: 1_500 } },
        },
        {
          package: path.join(REPO, "packages/own-remote"),
          options: {
            home: paths.ownHome,
            buildId,
            version: VERSION,
            sshCommand: harness.sshCommand,
            askpassHelper: harness.askpassHelper,
            remoteBundles: harness.bundles,
            sshDir: harness.sshDir,
            keepIntervalSeconds: 1,
            readyTimeoutMs: 120_000,
            backoffMs: [60_000],
            lingerSeconds: 0,
          },
        },
      ],
    }),
})
const control = path.join(local.paths.ownHome, "control")
fs.mkdirSync(control, { recursive: true })

type Json = Record<string, any>
const localOk = async (id: string, method: string, input: unknown = {}) => {
  const response = await local.request("POST", `/api/rpc/${id}/${method}`, {
    body: { input },
    query: { "location[directory]": control },
    directory: control,
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${id}/${method}: ${response.status}`)
  return (JSON.parse(text) as Json).output as Json
}
const until = async <T>(read: () => Promise<T | undefined>, ms: number) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error("timeout")
    await Bun.sleep(500)
  }
}
const outputs: string[] = []
const state = { hostId: "", url: "", token: "", workspace: "" }
const remote = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(new URL(route, state.url), {
    method,
    headers: {
      authorization: `Basic ${btoa(`opencode:${state.token}`)}`,
      "x-opencode-directory": encodeURIComponent(state.workspace),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  outputs.push(text)
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Json }
}
const connect = async () => {
  await localOk("own.remote", "connect", { hostId: state.hostId, clientId: "live" })
  return until(async () => {
    const view = ((await localOk("own.remote", "hosts.list")).hosts as Json[]).find((item) => item.id === state.hostId)!
    return view.stage === "ready" || view.stage === "needs_install" ? view : undefined
  }, 240_000)
}
const resolve = async () => {
  const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
  state.url = resolved.url
  state.token = resolved.token
}
const served = () =>
  until(async () => {
    const listed = await remote("GET", "/api/model")
    return ((listed.body?.data ?? []) as Json[]).some((model) => model.providerID === MODEL.providerID && model.id === MODEL.id)
      ? true
      : undefined
  }, 180_000)
const turn = async (sessionID: string, text: string) => {
  await remote("POST", `/api/session/${sessionID}/prompt`, { text })
  await remote("POST", `/api/experimental/session/${sessionID}/wait`)
  return JSON.stringify((await remote("GET", `/api/session/${sessionID}/message`)).body?.data ?? [])
}

try {
  await localOk("own.accounts", "claudeAgent.setup", {})
  const added = await localOk("own.remote", "hosts.add", { alias: "live" })
  state.hostId = added.host.id
  if ((await connect()).stage === "needs_install") {
    const plan = await localOk("own.remote", "prepare.plan", { hostId: state.hostId })
    await localOk("own.remote", "prepare.execute", { nonce: plan.nonce })
    await connect()
  }
  await resolve()
  state.workspace = path.join(harness.hostHome("live"), "work")
  fs.mkdirSync(state.workspace, { recursive: true })
  fs.writeFileSync(path.join(state.workspace, "host-only.txt"), `${MARKER}\n`)
  print("host", { ready: true })

  // 1. Privacy capture: the host's turn reaches the PC's claude, whose first request the gate records and refuses.
  await served()
  const probe = (await remote("POST", "/api/session", { title: "capture", model: MODEL, location: { directory: state.workspace } })).body
    .data.id as string
  await turn(probe, "Reply with the word OK.")
  const checks = gate.captured.map(privacy)
  const prompted = gate.captured.some((body) => body.includes("Reply with the word OK."))
  const check = {
    requests: gate.captured.length,
    prompted,
    clean: prompted && checks.every((item) => item.clean),
    findings: [...new Set(checks.flatMap((item) => item.findings))],
    outside: checks.reduce((sum, item) => sum + item.outside, 0),
  }
  print("privacy-capture", check)
  if (!check.clean) throw new Error("privacy check failed: the live part does not run")
  gate.open = true

  // 2. The read tool on the host, the model call from the PC.
  const sessionID = (await remote("POST", "/api/session", { title: "live", model: MODEL, location: { directory: state.workspace } })).body
    .data.id as string
  const file = path.join(state.workspace, "host-only.txt")
  const first = await turn(
    sessionID,
    `Use the read tool to read the file ${file} and reply with only the marker word that is in it.`,
  )
  const accounts = (await localOk("own.accounts", "claudeAgent.status")).accounts as Json[]
  const folder = accounts[0]!.folder as string
  print("tool-turn", {
    replied: first.includes(MARKER),
    readTool: /"tool":"read"|"name":"read"/.test(first),
  })

  // 3. Reconnect, then the same Claude conversation resumes.
  await localOk("own.remote", "disconnect", { hostId: state.hostId })
  await until(
    async () =>
      ((await localOk("own.remote", "hosts.list")).hosts as Json[]).find((item) => item.id === state.hostId)!.stage === "disconnected"
        ? true
        : undefined,
    60_000,
  )
  await connect()
  await resolve()
  await served()
  const second = await turn(sessionID, "What was the marker word? Reply with only that word.")
  const projects = path.join(path.dirname(path.dirname(folder)), "projects")
  print("resume", { replied: second.includes(MARKER), transcripts: fs.existsSync(projects) ? fs.readdirSync(projects).length : 0 })

  // 4. Every forwarded body, the host's files and the outputs.
  const forwarded = gate.forwarded.map(privacy)
  print("privacy-forwarded", {
    bodies: forwarded.length,
    clean: forwarded.every((item) => item.clean),
    findings: [...new Set(forwarded.flatMap((item) => item.findings))],
  })
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile() && (entry.name === ".credentials.json" || fs.readFileSync(target).includes("forwarded-by-own-live")))
        hits.push(path.relative(ROOT!, target))
    }
  }
  walk(harness.hostHome("live"))
  print("host-hygiene", { hits: hits.length, outputs: outputs.filter((text) => /sk-ant-/.test(text)).length })
  print("usage", usage)
} catch (error) {
  print("error", error instanceof Error ? error.message : String(error))
  // Kept in the scratch folder for a look by hand; never printed.
  fs.writeFileSync(path.join(at.log, "local-server.log"), local.logs())
  const logs = path.join(harness.testRoot, "e2e-logs")
  if (fs.existsSync(logs)) fs.cpSync(logs, path.join(at.log, "remote"), { recursive: true })
} finally {
  await local.stop().catch(() => undefined)
  await harness.cleanup().catch(() => undefined)
  proxy.stop(true)
  await forwarder.stop().catch(() => undefined)
}

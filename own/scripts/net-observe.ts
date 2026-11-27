// Network observation of an isolated own install (telemetry audit, decisions TLM): which remote hosts the service, its
// child processes, the web UI and (with --desktop) the desktop shell contact while idle and through a fake-model
// conversation. Nothing reaches the user's own install: the build is installed into a temp OWN_HOME by its launcher
// (as release-smoke.ts does), OWN_CONFIG_DIR and XDG_* point into the temp root, the service and the gateway get free
// loopback ports, and the model is a local fake.
//
// Three records, joined in the evidence file:
//   - proxy: the service runs with HTTP(S)_PROXY on a local recording proxy that refuses every remote request
//     (nothing leaves through it); each CONNECT or absolute-form request is a host the service or a child asked for
//   - connections: once a second, every established or opening TCP connection to a non-loopback address owned by a
//     process whose executable or command line names the temp root, its descendants, or the desktop shell's tree;
//     names come from the DNS client cache at the end (traffic that ignores the proxy, such as Chromium's)
//   - page: every non-loopback request the web UI made in a headless Edge (Playwright, as own-web's suites) showing
//     the conversation; each is refused at the page
//   - dictionaries: the spellcheck files the desktop shell downloaded into its test profile (--desktop)
//
//   bun own/scripts/net-observe.ts --out <build> [--root <new folder>] [--idle 6] [--after 6] [--desktop]
//                                  [--launcher own/launcher/own.ps1] [--web packages/own-web/dist] [--keep]
// --launcher and --web replace the installed launcher and web UI after the install, to observe a change without a
// release build. Prints a JSON summary as the last line; the evidence is <root>-evidence.json.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { parseArgs } from "node:util"
import type { BrowserType } from "@playwright/test"
import { startFakeOpenAIChat } from "../../packages/own-accounts/test/e2e-kit/fakes/openai-chat"

const REPO = path.resolve(import.meta.dir, "..", "..")
// Playwright is own-web's test dependency, not the root's.
const chromium = (createRequire(path.join(REPO, "packages", "own-web", "package.json"))("@playwright/test") as {
  chromium: BrowserType
}).chromium
const args = parseArgs({
  options: {
    out: { type: "string" },
    root: { type: "string" },
    idle: { type: "string", default: "6" },
    after: { type: "string", default: "6" },
    desktop: { type: "boolean", default: false },
    launcher: { type: "string" },
    web: { type: "string" },
    keep: { type: "boolean", default: false },
  },
}).values
if (!args.out) throw new Error("--out <build>: the build folder to observe, e.g. own/.out/build/2.4.0-own.0")
const build = path.resolve(args.out)
const version = (JSON.parse(fs.readFileSync(path.join(build, "app", "manifest.json"), "utf8").replace(/^﻿/, "")) as {
  version: string
}).version
const root = path.resolve(args.root ?? path.join(os.tmpdir(), `own-observe-${randomBytes(3).toString("hex")}`))
if (fs.existsSync(root)) throw new Error(`${root} exists`)
fs.mkdirSync(root, { recursive: true })
const tag = path.basename(root)
const own = path.join(root, "own")
const started = Date.now()
const at = () => Math.round((Date.now() - started) / 1000)
const log = (line: string) => console.log(`[${String(at()).padStart(5)} s] ${line}`)

// ---------------------------------------------------------------------------------------------- the recording proxy
const proxied: { t: number; phase: string; kind: string; target: string; agent?: string }[] = []
const state = { phase: "install" }
const proxy = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, chunk) {
      const head = Buffer.from(chunk).toString("latin1")
      const line = head.split("\r\n")[0] ?? ""
      const [method, target] = line.split(" ")
      const agent = /\r\nuser-agent:\s*([^\r\n]*)/i.exec(head)?.[1]
      if (method && target) {
        const entry = { t: at(), phase: state.phase, kind: method.slice(0, 16), target: target.slice(0, 300), agent }
        proxied.push(entry)
        fs.appendFileSync(path.join(root, "proxy.jsonl"), `${JSON.stringify(entry)}\n`)
      }
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      socket.end()
    },
  },
})
const proxyURL = `http://127.0.0.1:${proxy.port}`

// ---------------------------------------------------------------------------------------------- the connection poller
// This script and the shells that started it name the temp root on their command lines too: they are never observed
// or stopped, and neither are their other children (Playwright's Edge is not own's).
const ANCESTORS = `
$mine = @()
$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
$cursor = ${process.pid}
while ($cursor -and -not ($mine -contains $cursor)) { $mine += $cursor; $cursor = [int](($all | Where-Object { $_.ProcessId -eq $cursor }).ParentProcessId) }
`
const pidsFile = path.join(root, "pids.txt")
const connsFile = path.join(root, "conns.jsonl")
fs.writeFileSync(pidsFile, "")
const poller = spawn(
  "powershell",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `
$ErrorActionPreference = 'SilentlyContinue'
$tag = '${tag}'
${ANCESTORS}
while ($true) {
  $extra = @(Get-Content -LiteralPath '${pidsFile}' | Where-Object { $_ } | ForEach-Object { [int]$_ })
  $procs = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CommandLine,Name)
  $set = @{}
  foreach ($p in $procs) {
    if ($p.ProcessId -eq $PID -or $mine -contains [int]$p.ProcessId) { continue }
    if (($p.ExecutablePath -and $p.ExecutablePath.Contains($tag)) -or ($p.CommandLine -and $p.CommandLine.Contains($tag)) -or ($extra -contains [int]$p.ProcessId)) { $set[[int]$p.ProcessId] = $p.Name }
  }
  do {
    $added = $false
    foreach ($p in $procs) { if (-not $set.ContainsKey([int]$p.ProcessId) -and $set.ContainsKey([int]$p.ParentProcessId) -and $p.ProcessId -ne $PID -and -not ($mine -contains [int]$p.ProcessId)) { $set[[int]$p.ProcessId] = $p.Name; $added = $true } }
  } while ($added)
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($c in @(Get-NetTCPConnection -State Established,SynSent)) {
    $owner = [int]$c.OwningProcess
    if (-not $set.ContainsKey($owner)) { continue }
    $remote = [string]$c.RemoteAddress
    if ($remote -match '^(127\\.|::1$|0\\.0\\.0\\.0$|::$|::ffff:127\\.)') { continue }
    [Console]::Out.WriteLine((@{ ms = $now; pid = $owner; name = $set[$owner]; remote = $remote; port = [int]$c.RemotePort; state = [string]$c.State } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 800
}
`,
  ],
  { stdio: ["ignore", fs.openSync(connsFile, "a"), "ignore"], windowsHide: true },
)

// ---------------------------------------------------------------------------------------------- the isolated install
const env: Record<string, string> = {
  OWN_HOME: own,
  OWN_CONFIG_DIR: path.join(root, "config"),
  XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
  XDG_STATE_HOME: path.join(root, "xdg", "state"),
  XDG_DATA_HOME: path.join(root, "xdg", "data"),
  XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
}
for (const dir of Object.values(env)) fs.mkdirSync(dir, { recursive: true })
const proxyEnv = {
  HTTP_PROXY: proxyURL,
  HTTPS_PROXY: proxyURL,
  http_proxy: proxyURL,
  https_proxy: proxyURL,
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
}
const workspace = path.join(root, "project")
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, "README.md"), "# net observe\n")
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
fs.writeFileSync(
  path.join(env.OWN_CONFIG_DIR!, "service-own.json"),
  JSON.stringify({ hostname: "127.0.0.1", port: await freePort(), password: randomBytes(24).toString("base64url") }),
)
// An agent session's own variables (a Claude Code terminal's e-mail, account ids, messaging socket) never reach the
// instance, the desktop shell included (the launcher drops them for the service only).
const base = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC_|OPENAI_|OPENCODE_|OTEL_)/i.test(name)),
)
const childEnv = { ...base, ...env, ...proxyEnv }
const installed = spawnSync(
  "cmd",
  ["/c", path.join(build, "bin", "own.cmd"), "install", "--from", build, "--no-path", "--no-prompt", "--json"],
  { env: childEnv, encoding: "utf8", windowsHide: true },
)
if (installed.status !== 0) throw new Error(`own install: ${installed.stderr.slice(-400)}`)
if (args.launcher) fs.copyFileSync(path.resolve(args.launcher), path.join(own, "bin", "own.ps1"))
if (args.web) {
  const web = path.join(own, "app", version, "web")
  fs.rmSync(web, { recursive: true, force: true })
  fs.cpSync(path.resolve(args.web), web, { recursive: true })
}
const ownCmd = (...command: string[]) => {
  const result = spawnSync("cmd", ["/c", path.join(own, "bin", "own.cmd"), ...command], {
    env: childEnv,
    encoding: "utf8",
    windowsHide: true,
  })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

const fake = startFakeOpenAIChat({ models: ["fake-model"] })
const KEY = `sk-fake-net-observe-${randomBytes(6).toString("hex")}`
const page: { t: number; url: string; type: string }[] = []
const report: Record<string, unknown> = { build, version, root, launcher: args.launcher ?? null, web: args.web ?? null }
const desktop = { pid: 0 }
try {
  state.phase = "start"
  const start = ownCmd("start")
  if (start.code !== 0) throw new Error(`own start: ${start.stderr || start.stdout}`)
  log("service started")
  report.envShown = ownCmd("env").stdout.split(/\r?\n/)
  const registration = JSON.parse(
    fs.readFileSync(path.join(env.XDG_STATE_HOME!, "opencode", "service-own.json"), "utf8"),
  ) as { url: string; password: string }
  const authorization = `Basic ${btoa(`opencode:${registration.password}`)}`
  const control = path.join(own, "control")
  const http = async (method: string, route: string, body?: unknown, directory = workspace) => {
    const response = await fetch(new URL(route, registration.url), {
      method,
      headers: {
        authorization,
        "x-opencode-directory": encodeURIComponent(directory),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
  const rpc = async (plugin: string, method: string, input: unknown, directory = control) => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const result = await http(
        "POST",
        `/api/rpc/${plugin}/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
        { input },
        directory,
      )
      if (result.body?.type !== "rpc.unavailable" || Date.now() > deadline) {
        if (result.status !== 200) throw new Error(`${plugin}.${method}: ${result.status} ${JSON.stringify(result.body)}`)
        return result.body.output
      }
      await Bun.sleep(250)
    }
  }
  await rpc("own.accounts", "health", {})

  if (args.desktop) {
    const exe = path.join(build, "desktop", "win-unpacked", "own-desktop.exe")
    const child = spawn(exe, [], {
      env: { ...childEnv, OPENCODE_DESKTOP_TEST_ROOT: path.join(root, "desktop-root") },
      stdio: "ignore",
      detached: false,
    })
    desktop.pid = child.pid ?? 0
    fs.writeFileSync(pidsFile, `${desktop.pid}\n`)
    log(`desktop shell started (pid ${desktop.pid})`)
  }

  state.phase = "idle"
  log(`idle ${args.idle} min`)
  await Bun.sleep(Number(args.idle) * 60_000)

  state.phase = "conversation"
  const added = await rpc("own.accounts", "accounts.add.key", {
    kind: "compat",
    label: "Net observe",
    key: KEY,
    options: { baseURL: `${fake.url}/v1`, models: [{ id: "fake-model", contextLimit: 128000, cost: { input: 1, output: 2 } }] },
  })
  const model = { providerID: added.account.providerID, id: "fake-model" }
  const deadline = Date.now() + 60_000
  for (;;) {
    const listed = ((await http("GET", "/api/model")).body?.data ?? []) as { providerID: string; id: string }[]
    if (listed.some((item) => item.providerID === model.providerID && item.id === model.id)) break
    if (Date.now() > deadline) throw new Error("model never listed")
    await Bun.sleep(500)
  }
  const created = await http("POST", "/api/session", { title: "net observe", model, location: { directory: workspace } })
  const sessionID = created.body?.data?.id as string
  fake.enqueue({
    type: "text",
    text: [
      "문서는 [OpenCode docs](https://opencode.ai/docs)와 [Example](https://example.org/guide)에 있어요.",
      "",
      "![diagram](https://example.net/diagram.png)",
    ].join("\n"),
  })
  await http("POST", `/api/session/${sessionID}/prompt`, { text: "문서 링크를 알려 줘" })
  await http("POST", `/api/experimental/session/${sessionID}/wait`)
  log("conversation answered")

  const link = ownCmd("pair").stdout.split(/\r?\n/).find((line) => line.includes("/auth/connect/"))
  if (!link) throw new Error("own pair printed no link")
  // The installed Edge, as own-web's Playwright suites use it; every page request to another host is recorded and
  // refused, so nothing leaves (the browser's own background traffic is not the page's and is not recorded).
  const browser = await chromium.launch({ headless: true, channel: "msedge" })
  try {
    const context = await browser.newContext()
    await context.route(
      (url) => /^(https?|wss?):$/.test(url.protocol) && !/^(127\.|localhost$|\[::1\]$)/.test(url.hostname),
      (route) => {
        page.push({ t: at(), url: route.request().url().slice(0, 300), type: route.request().resourceType() })
        return route.abort()
      },
    )
    // --web: the service serves the web UI built into opencode.exe (P-001), so the page takes the given build's files
    // instead (built as the release builds it: OPENCODE_CHANNEL=own, VITE_OPENCODE_SERVER_MODE=origin); the API stays
    // the service's.
    if (args.web) {
      const dist = path.resolve(args.web)
      const origin = new URL(registration.url).origin
      await context.route(
        (url) => url.origin === origin,
        (route) => {
          const url = new URL(route.request().url())
          const file = path.join(dist, decodeURIComponent(url.pathname))
          if (url.pathname !== "/" && fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file })
          if (route.request().resourceType() === "document" && !url.pathname.startsWith("/auth/"))
            return route.fulfill({ path: path.join(dist, "index.html") })
          return route.fallback()
        },
      )
    }
    const view = await context.newPage()
    await view.goto(link)
    await view.goto(new URL(`/srv/local/s/${sessionID}`, registration.url).toString())
    await view.getByText("Example").first().waitFor({ timeout: 60_000 })
    await Bun.sleep(15_000)
    report.pageShown = await view.locator("body").innerText().then((text) => text.includes("OpenCode docs"))
  } finally {
    await browser.close()
  }
  log("web UI showed the conversation")

  state.phase = "after"
  log(`idle ${args.after} min`)
  await Bun.sleep(Number(args.after) * 60_000)
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  log(`error: ${report.error}`)
} finally {
  state.phase = "stop"
  if (desktop.pid) spawnSync("taskkill", ["/PID", String(desktop.pid), "/T", "/F"], { windowsHide: true })
  ownCmd("stop", "--force")
  await fake.stop()
  await Bun.sleep(2_000)
  poller.kill()
  proxy.stop(true)
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `${ANCESTORS}\nGet-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and -not ($mine -contains [int]$_.ProcessId) -and ($_.CommandLine -like '*${tag}*' -or $_.ExecutablePath -like '*${tag}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true },
  )
}

// ---------------------------------------------------------------------------------------------- the evidence
const conns = fs
  .readFileSync(connsFile, "utf8")
  .split(/\r?\n/)
  .flatMap((line) => (line.startsWith("{") && line.endsWith("}") ? [JSON.parse(line)] : []))
  .map((item) => item as { ms: number; pid: number; name: string; remote: string; port: number })
const cache = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    "Get-DnsClientCache | Where-Object { $_.Type -in 1,28 } | ForEach-Object { '{0} {1}' -f $_.Data, $_.Entry }",
  ],
  { encoding: "utf8", windowsHide: true },
)
const names = new Map<string, Set<string>>()
for (const line of cache.stdout.split(/\r?\n/)) {
  const [address, name] = line.trim().split(" ")
  if (address && name) names.set(address, (names.get(address) ?? new Set()).add(name))
}
const group = <T,>(items: T[], key: (item: T) => string) =>
  [...Map.groupBy(items, key).entries()].map(([name, list]) => ({ name, count: list.length, items: list }))
const summary = {
  proxy: group(
    proxied,
    (item) =>
      `${item.kind} ${item.kind === "CONNECT" || !URL.canParse(item.target) ? item.target : new URL(item.target).host}`,
  ).map(
    (entry) => ({
      request: entry.name,
      count: entry.count,
      phases: [...new Set(entry.items.map((item) => item.phase))],
      seconds: entry.items.map((item) => item.t),
      agent: entry.items[0]?.agent,
    }),
  ),
  connections: group(conns, (item) => `${item.name} ${item.remote}:${item.port}`).map((entry) => ({
    connection: entry.name,
    names: [...(names.get(entry.items[0]!.remote) ?? [])],
    samples: entry.count,
    firstSecond: Math.round((entry.items[0]!.ms - started) / 1000),
  })),
  page: group(page, (item) => new URL(item.url).host).map((entry) => ({
    host: entry.name,
    count: entry.count,
    urls: [...new Set(entry.items.map((item) => item.url))].slice(0, 5),
  })),
}
const dictionaries = path.join(root, "desktop-root", "session", "Dictionaries")
const evidence = {
  ...report,
  startedAt: new Date(started).toISOString(),
  seconds: at(),
  summary,
  dictionaries: fs.existsSync(dictionaries)
    ? fs.readdirSync(dictionaries).map((name) => ({ name, bytes: fs.statSync(path.join(dictionaries, name)).size }))
    : [],
  proxied,
  page,
}
fs.writeFileSync(`${root}-evidence.json`, JSON.stringify(evidence, null, 2))
if (!args.keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
console.log(JSON.stringify({ evidence: `${root}-evidence.json`, error: report.error ?? null, summary }))
process.exit(report.error ? 1 : 0)

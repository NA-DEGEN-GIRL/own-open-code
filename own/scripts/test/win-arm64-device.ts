// Device run of the Windows ARM64 원격 PC 전용 build (own/reports/win-arm64-2026-11-06.md §4) on the user's ARM64 PC over
// Tailscale + OpenSSH, driven from this x64 PC. Never run by a release or by CI: it needs that device, a dedicated test
// user there and the user's go-ahead. Nothing on this PC's live service (127.0.0.1:28538) or its app listener (28540) is
// used: the PC side is the own-web gateway e2e backend from source (fake provider, memory vault, temp roots), with its
// app listener on a separate test port.
//
//   PC (this x64)                                              device (Windows ARM64, test user, logged on)
//   ─────────────                                              ──────────────────────────────────────────────
//   gateway e2e backend (source)  ◀── route ──────────────────  own-desktop.exe (client build, portable or installed)
//     app listener 127.0.0.1:<app>    tailnet: tailscale serve      started by a scheduled task in the user's
//     fake OpenAI (slow stream)        --tcp=<app> (this PC)        interactive session, OPENCODE_DESKTOP_TEST_ROOT
//   this script ── ssh -L <cdp> ─────────────────────────────▶   --remote-debugging-port=<cdp> (127.0.0.1 only)
//                                    ssh: ssh -R <app> instead
//
// Steps (each logged, evidence in own/.out/test/win-arm64-device/<run>/): preflight (device is ARM64, the test user is
// logged on interactively, nothing of ours is left from before, live ports refused) → backend + app listener → route →
// pairing link (the loopback link with its route replaced) → copy the build (zip of win-arm64-unpacked, or the
// installer) → install into the test folder (portable: unzip; installer: /S /D=) → launch through a scheduled task →
// CDP over ssh -L → the client page → paste the link → read the confirmation number → approve it on the PC
// (devices.pair.approve with that number) → the PC is listed → open its window → the PC's own-web lists the session →
// a prompt whose answer streams in ten deltas (seen partly done at least once) → reconnect: the route goes away for
// 20 s and comes back; the window recovers and a second prompt is answered → Code Integrity events naming the test
// folder → cleanup (app closed through CDP, task removed, uninstall in installer mode, test folder removed; route,
// tunnels and backend stopped here). --keep leaves the device folder and this PC's evidence for a look.
//
//   bun own/scripts/test/heavy.ts bun own/scripts/test/win-arm64-device.ts --host <tailnet name> --user <test user> \
//     [--identity <key>] [--known-hosts <file>] [--build <...\desktop-client-arm64>] [--version <ver>] \
//     [--mode portable|installer] [--route tailnet|ssh] [--app-port 28640] [--cdp-port 9333] [--keep] [--dry-run]
// --dry-run checks the arguments and the build and prints the plan; it starts nothing and contacts no host.
// Exit: 0 passed, 1 a step failed (cleanup still runs), 64 usage error.
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { parseArgs } from "node:util"
import { rawCdp, type RawCdp } from "../../../packages/own-desktop/scripts/cdp-raw"
import { STATE_FILE, type GatewayBackendState } from "../../../packages/own-web/e2e/gateway/support"
import { peMachine } from "../lib/pe"

const REPO = path.resolve(import.meta.dir, "..", "..", "..")
const USAGE =
  "usage: bun own/scripts/test/win-arm64-device.ts --host <name> --user <test user> [--identity <key>] [--known-hosts <file>] " +
  "[--build <dir>] [--version <ver>] [--mode portable|installer] [--route tailnet|ssh] [--app-port <n>] [--cdp-port <n>] [--keep] [--dry-run]"
/** This PC's live service, its gateway, app listener and DDNS portproxy (08 §3.7): never used by a test. */
const LIVE_PORTS = new Set([28538, 28539, 28540, 28541])
/** The words the backend's slow stream sends one delta at a time (packages/own-web/e2e/gateway/backend.ts). */
const SLOW_WORDS = ["하나", "둘", "셋", "넷", "다섯", "여섯", "일곱", "여덟", "아홉", "열"]
const ANSWER_MARK = "계정으로 온 답"

const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        host: { type: "string" },
        user: { type: "string" },
        identity: { type: "string" },
        "known-hosts": { type: "string" },
        build: { type: "string" },
        version: { type: "string" },
        mode: { type: "string", default: "portable" },
        route: { type: "string", default: "tailnet" },
        "app-port": { type: "string", default: "28640" },
        "cdp-port": { type: "string", default: "9333" },
        keep: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
    }).values,
).catch((error: unknown) => usage(error instanceof Error ? error.message : String(error)))

const appPort = Number(args["app-port"])
const cdpPort = Number(args["cdp-port"])
if (!args.host || !args.user) usage("--host and --user are required")
if (!/^[A-Za-z0-9._-]+$/.test(args.host!) || !/^[A-Za-z0-9._-]+$/.test(args.user!))
  usage("--host and --user: letters, digits, . _ - only")
if (args.mode !== "portable" && args.mode !== "installer") usage("--mode is portable or installer")
if (args.route !== "tailnet" && args.route !== "ssh") usage("--route is tailnet or ssh")
for (const port of [appPort, cdpPort])
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || LIVE_PORTS.has(port))
    usage(`port ${port}: 1024-65535 and not ${[...LIVE_PORTS].join("/")}`)

const build = locateBuild()
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")
const evidence = path.join(REPO, "own", ".out", "test", "win-arm64-device", runId)
const remoteRel = `own-arm64-test\\${runId}`
const task = `OwnArm64Test-${runId}`
const report: Record<string, unknown> = {
  run: runId,
  host: args.host,
  user: args.user,
  mode: args.mode,
  route: args.route,
  appPort,
  cdpPort,
  build,
}
const steps: { name: string; ok: boolean; ms: number; detail?: unknown }[] = []

if (args["dry-run"]) {
  console.log(JSON.stringify({ plan: planText(), ...report }, null, 2))
  process.exit(0)
}

fs.mkdirSync(evidence, { recursive: true })
const children: ChildProcess[] = []
const undo: { label: string; run: () => Promise<unknown> | unknown }[] = []
/** Set by openRoute: takes the device's route to the app listener away and back (the reconnect step). */
let route_ = { down: async () => {}, up: async () => {} }
let failed = false
try {
  await main()
} catch (error) {
  failed = true
  record("aborted", false, error instanceof Error ? error.message : String(error))
} finally {
  for (const item of undo.reverse()) {
    const ok = await Promise.try(item.run).then(
      () => true,
      (error: unknown) => (console.error(`cleanup ${item.label}: ${String(error)}`), false),
    )
    record(`cleanup: ${item.label}`, ok)
  }
  for (const child of children) if (child.exitCode === null) child.kill()
  report.steps = steps
  report.passed = !failed && steps.every((step) => step.ok)
  fs.writeFileSync(path.join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ passed: report.passed, evidence }))
  process.exit(report.passed ? 0 : 1)
}

async function main() {
  // ---- preflight (device)
  const device = await step("preflight: device reachable, ARM64, test user logged on interactively", async () => {
    const info = ps(`
      $owner = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User })
      [pscustomobject]@{
        arch = $env:PROCESSOR_ARCHITECTURE; user = $env:USERNAME; domain = $env:USERDOMAIN; profile = $env:USERPROFILE
        interactive = $owner -contains $env:USERNAME
        build = [Environment]::OSVersion.Version.ToString()
        leftover = Test-Path (Join-Path $env:USERPROFILE 'own-arm64-test')
        installed = Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\\own-desktop\\own-desktop.exe')
        sac = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
      } | ConvertTo-Json -Compress`)
    const value = JSON.parse(info) as {
      arch: string
      interactive: boolean
      leftover: boolean
      installed: boolean
      profile: string
      user: string
      domain: string
      sac?: number
    }
    if (value.arch !== "ARM64") throw new Error(`device is ${value.arch}, not ARM64`)
    if (!value.interactive)
      throw new Error(`${value.user} has no interactive session (log on at the device or over RDP, then rerun)`)
    if (value.leftover)
      throw new Error(`${value.profile}\\own-arm64-test exists from an earlier run: look at it, remove it, rerun`)
    if (args.mode === "installer" && value.installed)
      throw new Error("Own OpenCode is installed for this user already: installer mode would replace it")
    return value
  })
  report.device = device

  // ---- this PC: backend, app listener, route, link
  const state = await step("PC: gateway e2e backend from source (fake provider, slow stream)", startBackend)
  const app = await step(`PC: gateway on, app listener on 127.0.0.1:${appPort}`, () => appListener(state))
  const route = await step(`PC: route (${args.route})`, () => openRoute())
  const pairing = await step("PC: pairing link with the device's route", async () => {
    const started = await rpc(state, "devices.pair.start", {
      name: "ARM64 시험 기기",
      scopes: ["read", "prompt", "switch"],
      servers: { mode: "all" },
      expiresDays: 1,
      appRoute: "loopback",
    })
    const link = new URL(String(started.appLink))
    link.searchParams.delete("r")
    link.searchParams.append("r", route)
    return { link: link.toString(), pairingId: String(started.pairingId), pcKey: link.searchParams.get("k")! }
  })
  report.pcKey = pairing.pcKey

  // ---- device: copy, install, launch
  const remoteExe = await step(`device: copy and ${args.mode === "portable" ? "unpack" : "install"} the build`, () =>
    install(),
  )
  await step("device: launch in the interactive session (scheduled task), CDP tunnel", () => launch(remoteExe))
  const client = await step("device: the remote-client page", async () => {
    const cdp = await pageTarget((url) => url.startsWith("oc://renderer"), 90_000)
    await waitFor(cdp, `!!document.querySelector('[data-testid="own-client"]')`, 30_000)
    await shot(cdp, "01-client")
    return cdp
  })

  // ---- pairing
  const sas = await step("pairing: paste the link, the confirmation number shows", async () => {
    await client.evaluate(`(() => {
      const box = document.querySelector('[data-testid="client-link"]')
      box.value = ${JSON.stringify(pairing.link)}
      box.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-testid="client-connect"]').click()
    })()`)
    const value = await waitFor<string>(
      client,
      `document.querySelector('[data-testid="client-sas"]')?.textContent?.trim() || ""`,
      60_000,
    )
    await shot(client, "02-sas")
    if (!/^\d{4}$/.test(value)) throw new Error(`confirmation number ${JSON.stringify(value)}`)
    return value
  })
  await step("pairing: approved on the PC with the device's number; the PC is listed and connected", async () => {
    await rpc(state, "devices.pair.approve", { pairingId: pairing.pairingId, sas })
    await waitFor(
      client,
      `document.querySelector('[data-testid="client-status"]')?.textContent?.includes('추가했어요') || ""`,
      60_000,
    )
    await waitFor(
      client,
      `document.querySelector('[data-testid="pc-${pairing.pcKey}"]')?.dataset.state === 'connected' || ""`,
      60_000,
    )
    await shot(client, "03-paired")
  })

  // ---- the PC's own-web in its pinned window
  const remote = await step("window: the PC's own-web lists its session", async () => {
    await client.evaluate(`document.querySelector('[data-testid="open-${pairing.pcKey}"]').click()`)
    const cdp = await pageTarget((url) => url.startsWith(`https://${pairing.pcKey}.ownpc.internal`), 60_000)
    await waitFor(
      cdp,
      `document.querySelector('[data-testid="session-list"]')?.textContent?.includes(${JSON.stringify(state.localSession.title)}) || ""`,
      90_000,
    )
    await shot(cdp, "04-remote-list")
    return cdp
  })
  await step("conversation: a prompt from the device, the answer streams in", async () => {
    await openSession(remote, state.localSession.title)
    const samples = await promptAndWatch(remote, "ARM64 기기에서 안녕")
    report.stream = samples
    await shot(remote, "05-answer")
    if (!samples.some((sample) => sample.words > 0 && sample.words < SLOW_WORDS.length))
      throw new Error(`no partial answer seen: ${JSON.stringify(samples)}`)
    return samples.length
  })

  // ---- reconnect
  await step("reconnect: the route is gone for 20 s, then back; the window recovers and answers again", async () => {
    // A fresh request from the PC's page shows whether the route is really gone (open streams may outlive it).
    const reach = `fetch(location.origin + '/', { cache: 'no-store' }).then(() => 'up', () => 'down')`
    await route_.down()
    await Bun.sleep(20_000)
    const down = await remote.evaluate<string>(reach)
    await shot(remote, "06-route-down")
    if (down !== "down") throw new Error("the PC still answered with the route taken down")
    await route_.up()
    await waitFor(remote, `${reach}.then((state) => state === 'up' ? 'up' : '')`, 60_000)
    const samples = await promptAndWatch(remote, "다시 연결된 뒤의 질문", 120_000)
    await shot(remote, "07-after-reconnect")
    return samples.length
  })

  // ---- Smart App Control and Code Integrity on the device
  await step("device: no Code Integrity event names the test folder", async () => {
    const out = ps(`
      $root = Join-Path $env:USERPROFILE '${remoteRel}'
      $events = @(try { Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = (Get-Date).AddHours(-2) } -ErrorAction Stop | Where-Object { $_.Message -like "*own-arm64-test*" } | ForEach-Object { @{ id = $_.Id; message = $_.Message.Substring(0, [Math]::Min(300, $_.Message.Length)) } } } catch { })
      ConvertTo-Json -InputObject $events -Compress`)
    const events = JSON.parse(out || "[]") as unknown[]
    report.codeIntegrity = events
    if (events.length > 0) throw new Error(`Code Integrity: ${JSON.stringify(events).slice(0, 600)}`)
  })
}

// ---------------------------------------------------------------------------------------------------------------- PC side

async function startBackend() {
  fs.rmSync(STATE_FILE, { force: true })
  const child = spawn(process.execPath, ["e2e/gateway/backend.ts"], {
    cwd: path.join(REPO, "packages", "own-web"),
    env: scrubbed({
      OWN_WEB_E2E_GATEWAY_REMOTE: "0",
      OWN_WEB_E2E_GATEWAY_PORT: String(await freePort()),
      OWN_WEB_E2E_GATEWAY_SLOW_STREAM: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  children.push(child)
  const log = fs.createWriteStream(path.join(evidence, "backend.log"))
  child.stdout!.pipe(log)
  child.stderr!.pipe(log)
  undo.push({ label: "backend stopped", run: () => stopChild(child) })
  const deadline = Date.now() + 600_000
  while (!fs.existsSync(STATE_FILE)) {
    if (child.exitCode !== null) throw new Error(`backend exited ${child.exitCode} (backend.log)`)
    if (Date.now() > deadline) throw new Error("backend not ready in 10 min (backend.log)")
    await Bun.sleep(1_000)
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as GatewayBackendState
}

async function appListener(state: GatewayBackendState) {
  const status = async () =>
    (await rpc(state, "gateway.status", {})) as {
      state: string
      app?: { state: string; port?: number; pcKey?: string }
    }
  const configure = async (input: Record<string, unknown>) => {
    const plan = await rpc(state, "gateway.configure.plan", input)
    await rpc(state, "gateway.configure.execute", { nonce: plan.nonce })
  }
  if ((await status()).state !== "listening") await configure({ port: state.gatewayPort })
  await configure({ app: { enabled: true, port: appPort } })
  const app = (await status()).app
  if (app?.state !== "listening" || app.port !== appPort) throw new Error(`app listener: ${JSON.stringify(app)}`)
  return app
}

/** The tailnet route (tailscale serve --tcp on this PC) or an ssh -R tunnel; `route_` takes it down and up again. */
async function openRoute() {
  if (args.route === "ssh") {
    let tunnel: ChildProcess | undefined
    const up = async () => {
      tunnel = sshForward(["-R", `127.0.0.1:${appPort}:127.0.0.1:${appPort}`])
      await Bun.sleep(3_000)
      if (tunnel.exitCode !== null) throw new Error("ssh -R exited (port taken on the device?)")
    }
    const down = async () => void (tunnel && (await stopChild(tunnel)))
    await up()
    route_ = { up, down }
    undo.push({ label: "ssh -R tunnel closed", run: down })
    return `127.0.0.1:${appPort}`
  }
  const status = JSON.parse(run("tailscale", ["status", "--json"]).stdout) as { Self?: { DNSName?: string } }
  const name = status.Self?.DNSName?.replace(/\.$/, "")
  if (!name) throw new Error("tailscale status has no Self.DNSName (is Tailscale up on this PC?)")
  const served = run("tailscale", ["serve", "status", "--json"]).stdout
  if (served.includes(`"${appPort}"`))
    throw new Error(`tailscale serve already has TCP ${appPort}: not ours, nothing changed`)
  const up = async () => {
    const result = run("tailscale", ["serve", "--bg", `--tcp=${appPort}`, `tcp://localhost:${appPort}`])
    if (result.code !== 0) throw new Error(`tailscale serve: ${result.stderr}`)
  }
  const down = async () => void run("tailscale", ["serve", `--tcp=${appPort}`, "off"])
  await up()
  route_ = { up, down }
  undo.push({ label: `tailscale serve --tcp=${appPort} off`, run: down })
  return `${name}:${appPort}`
}

async function rpc(state: GatewayBackendState, method: string, input: unknown) {
  const response = await fetch(
    `${state.serverUrl}/api/rpc/own.remote/${method}?location[directory]=${encodeURIComponent(state.control)}`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`opencode:${state.localPassword}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input }),
    },
  )
  const body = (await response.json().catch(() => ({}))) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`own.remote ${method}: ${response.status} ${JSON.stringify(body).slice(0, 400)}`)
  return body.output ?? {}
}

// ---------------------------------------------------------------------------------------------------------------- device side

async function install() {
  const version =
    args.version ??
    /own-desktop-client-(.+)-win-arm64\.exe$/.exec(
      fs.readdirSync(build).find((name) => name.endsWith("-win-arm64.exe")) ?? "",
    )?.[1]
  if (!version) throw new Error(`no own-desktop-client-<version>-win-arm64.exe in ${build}`)
  ps(`New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '${remoteRel}') | Out-Null`)
  undo.push({
    label: "device test folder removed",
    run: () => {
      if (args.keep) return
      ps(
        `$root = Join-Path $env:USERPROFILE 'own-arm64-test'; Remove-Item -LiteralPath (Join-Path $root '${runId}') -Recurse -Force; if (-not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -Force }`,
      )
    },
  })
  if (args.mode === "portable") {
    const zip = path.join(evidence, "own-desktop-client-arm64.zip")
    const made = run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), [
      "-a",
      "-cf",
      zip,
      "-C",
      path.join(build, "win-arm64-unpacked"),
      ".",
    ])
    if (made.code !== 0) throw new Error(`zip: ${made.stderr}`)
    scp(zip, `${remoteRel.replaceAll("\\", "/")}/app.zip`)
    ps(
      `$root = Join-Path $env:USERPROFILE '${remoteRel}'; New-Item -ItemType Directory -Force (Join-Path $root 'app') | Out-Null; tar -xf (Join-Path $root 'app.zip') -C (Join-Path $root 'app'); if ($LASTEXITCODE) { throw 'tar failed' }; Remove-Item (Join-Path $root 'app.zip')`,
    )
    return `${remoteRel}\\app\\own-desktop.exe`
  }
  const installer = `own-desktop-client-${version}-win-arm64.exe`
  scp(path.join(build, installer), `${remoteRel.replaceAll("\\", "/")}/${installer}`)
  // Per-user oneClick NSIS: /S silent, /D= the install folder (last argument, unquoted, as NSIS wants it).
  ps(
    `$root = Join-Path $env:USERPROFILE '${remoteRel}'; $p = Start-Process -FilePath (Join-Path $root '${installer}') -ArgumentList @('/S', "/D=$root\\app") -Wait -PassThru; if ($p.ExitCode) { throw "installer exit $($p.ExitCode)" }`,
  )
  undo.push({
    label: "uninstalled (installer mode)",
    run: () =>
      ps(
        `$root = Join-Path $env:USERPROFILE '${remoteRel}'; $u = Get-ChildItem -LiteralPath (Join-Path $root 'app') -Filter 'Uninstall*.exe' | Select-Object -First 1; if ($u) { $p = Start-Process -FilePath $u.FullName -ArgumentList '/S' -Wait -PassThru; if ($p.ExitCode) { throw "uninstaller exit $($p.ExitCode)" } }`,
      ),
  })
  const found = ps(`Test-Path (Join-Path $env:USERPROFILE '${remoteRel}\\app\\own-desktop.exe')`).trim()
  if (found !== "True")
    throw new Error(
      "the installer did not install into the test folder (/D= ignored?); see %TEMP%\\own-installer.log on the device",
    )
  return `${remoteRel}\\app\\own-desktop.exe`
}

/**
 * A process started over SSH lives in the SSH logon session, which has no desktop the user sees: Electron starts
 * but its windows are not on any screen the user has, and some GPU paths fail. A scheduled task with an Interactive
 * principal runs in the test user's logged-on session instead (console or RDP), like a normal start.
 */
async function launch(remoteExe: string) {
  ps(`
    $root = Join-Path $env:USERPROFILE '${remoteRel}'
    $exe = Join-Path $env:USERPROFILE '${remoteExe}'
    $cmd = Join-Path $root 'launch.cmd'
    Set-Content -LiteralPath $cmd -Encoding ASCII -Value @(
      '@echo off',
      "set OPENCODE_DESKTOP_TEST_ROOT=$root\\profile",
      ('"' + $exe + '" --remote-debugging-port=${cdpPort} > "' + $root + '\\app.log" 2>&1')
    )
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $cmd + '"')
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName '${task}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName '${task}'`)
  undo.push({
    label: `scheduled task ${task} removed`,
    run: () => ps(`Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false`),
  })
  undo.push({ label: "app closed (CDP Browser.close, then only processes under the test folder)", run: closeApp })
  const tunnel = sshForward(["-L", `127.0.0.1:${cdpPort}:127.0.0.1:${cdpPort}`])
  undo.push({ label: "CDP tunnel closed", run: () => stopChild(tunnel) })
  const deadline = Date.now() + 90_000
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(
      (response) => response.ok,
      () => false,
    )
    if (ok) break
    if (Date.now() > deadline)
      throw new Error(
        "no CDP endpoint in 90 s (app.log on the device; Smart App Control may have blocked own-desktop.exe)",
      )
    await Bun.sleep(1_000)
  }
  const running = ps(
    `@(Get-Process own-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -like (Join-Path $env:USERPROFILE '${remoteRel}\\*') } | ForEach-Object { $_.SessionId }) -join ','`,
  ).trim()
  report.appSessions = running
  if (!running || running.split(",").includes("0"))
    throw new Error(`own-desktop session ids ${JSON.stringify(running)} (expected the interactive session, not 0)`)
}

async function closeApp() {
  const version = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(
    (response) => response.json() as Promise<{ webSocketDebuggerUrl: string }>,
    () => undefined,
  )
  if (version) {
    const browser = await rawCdp(version.webSocketDebuggerUrl).catch(() => undefined)
    await browser?.send("Browser.close").catch(() => undefined)
    browser?.close()
    await Bun.sleep(3_000)
  }
  ps(
    `Get-Process own-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -like (Join-Path $env:USERPROFILE '${remoteRel}\\*') } | Stop-Process -Force`,
  )
}

async function pageTarget(match: (url: string) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(
      (response) => response.json() as Promise<{ type: string; url: string; webSocketDebuggerUrl: string }[]>,
      () => [],
    )
    const target = list.find((item) => item.type === "page" && match(item.url))
    if (target) return rawCdp(target.webSocketDebuggerUrl)
    if (Date.now() > deadline) throw new Error(`no page target: ${JSON.stringify(list.map((item) => item.url))}`)
    await Bun.sleep(1_000)
  }
}

async function waitFor<T = unknown>(cdp: RawCdp, expression: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await cdp.evaluate<T>(expression).catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${expression.slice(0, 160)}`)
    await Bun.sleep(250)
  }
}

async function openSession(cdp: RawCdp, title: string) {
  await cdp.evaluate(`(() => {
    const list = document.querySelector('[data-testid="session-list"]')
    const hit = [...list.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(title)})
    hit.click()
  })()`)
  await waitFor(cdp, `!!document.querySelector('#own-composer-input')`, 30_000)
}

/** Sends a prompt (Ctrl+Enter, as the composer takes it) and samples how many of the slow words the newest answer has. */
async function promptAndWatch(cdp: RawCdp, text: string, timeoutMs = 90_000) {
  const before = await cdp.evaluate<number>(`document.body.innerText.split(${JSON.stringify(ANSWER_MARK)}).length - 1`)
  await cdp.evaluate(`document.querySelector('#own-composer-input').focus()`)
  await cdp.send("Input.insertText", { text })
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 2,
    })
  const samples: { ms: number; words: number }[] = []
  const started = Date.now()
  for (;;) {
    const words = await cdp.evaluate<number>(`(() => {
      const body = document.body.innerText
      if (body.split(${JSON.stringify(ANSWER_MARK)}).length - 1 <= ${before}) return -1
      const tail = body.slice(body.lastIndexOf(${JSON.stringify(ANSWER_MARK)}))
      return ${JSON.stringify(SLOW_WORDS)}.filter((word) => tail.includes(' ' + word)).length
    })()`)
    samples.push({ ms: Date.now() - started, words })
    if (words === SLOW_WORDS.length) return samples
    if (Date.now() - started > timeoutMs)
      throw new Error(`answer incomplete after ${timeoutMs} ms: ${JSON.stringify(samples.slice(-5))}`)
    await Bun.sleep(150)
  }
}

async function shot(cdp: RawCdp, name: string) {
  const image = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }).catch(() => undefined)
  if (image) fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(image.data, "base64"))
}

// ---------------------------------------------------------------------------------------------------------------- plumbing

/** ssh and scp options; the user goes as -l (ssh) or -o User= (scp). */
function sshOptions() {
  const known = args["known-hosts"] ? path.resolve(args["known-hosts"]) : path.join(evidence, "known_hosts")
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    `UserKnownHostsFile=${known}`,
    // A given known_hosts must already name the device; without one the first key is taken and recorded in the run.
    "-o",
    `StrictHostKeyChecking=${args["known-hosts"] ? "yes" : "accept-new"}`,
    ...(args.identity ? ["-i", path.resolve(args.identity), "-o", "IdentitiesOnly=yes"] : []),
    "-o",
    `User=${args.user}`,
  ]
}

/** A PowerShell script on the device (Windows OpenSSH's default shell is cmd.exe; -EncodedCommand avoids quoting). */
function ps(script: string) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64")
  const result = run("ssh", [
    ...sshOptions(),
    args.host!,
    `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  ])
  if (result.code !== 0) throw new Error(`device: ${result.stderr.trim().slice(-600) || `exit ${result.code}`}`)
  return result.stdout.trim()
}

function scp(local: string, remote: string) {
  const result = run("scp", [...sshOptions(), local, `${args.host}:${remote}`])
  if (result.code !== 0) throw new Error(`scp ${path.basename(local)}: ${result.stderr.trim().slice(-400)}`)
}

function sshForward(forward: string[]) {
  const child = spawn("ssh", [...sshOptions(), "-N", "-o", "ExitOnForwardFailure=yes", ...forward, args.host!], {
    env: scrubbed({}),
    stdio: "ignore",
    windowsHide: true,
  })
  children.push(child)
  return child
}

function run(command: string, argv: string[]) {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    windowsHide: true,
    env: scrubbed({}),
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error?.message ?? ""}`,
  }
}

/** An allow-list environment for every child: nothing of the agent session or the user's tokens reaches them. */
function scrubbed(extra: Record<string, string>) {
  const keep = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    // Without it some Windows components write under a literal %SystemDrive% folder in the working directory.
    "SystemDrive",
    "ALLUSERSPROFILE",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "USERNAME",
    "COMPUTERNAME",
  ]
  return {
    ...Object.fromEntries(keep.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]))),
    ...extra,
  }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return
  child.kill()
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  if (child.exitCode === null) child.kill("SIGKILL")
}

async function step<T>(name: string, body: () => Promise<T> | T): Promise<T> {
  const started = Date.now()
  console.log(`==> ${name}`)
  try {
    const value = await body()
    record(name, true, typeof value === "object" ? undefined : value, Date.now() - started)
    return value
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error), Date.now() - started)
    throw error
  }
}

function record(name: string, ok: boolean, detail?: unknown, ms = 0) {
  steps.push({ name, ok, ms, detail })
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 300)}`}`,
  )
}

function freePort() {
  return new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

function locateBuild() {
  const given = args.build ? path.resolve(args.build) : newestClientBuild()
  const exe = path.join(given, "win-arm64-unpacked", "own-desktop.exe")
  if (!fs.existsSync(exe)) usage(`no win-arm64-unpacked\\own-desktop.exe in ${given} (build-desktop-client.ps1 first)`)
  if (peMachine(exe) !== "arm64") usage(`${exe} is ${peMachine(exe)}, not arm64`)
  const check = path.join(given, "client-check.json")
  if (!fs.existsSync(check) || !(JSON.parse(fs.readFileSync(check, "utf8")) as { passed: boolean }).passed)
    usage(
      `${given}: client-check.json missing or failed (bun own/scripts/client-check.ts --dir ${given} --version <ver>)`,
    )
  return given
}

function newestClientBuild() {
  const root = path.join(REPO, "own", ".out", "build")
  const found = fs
    .readdirSync(root)
    .map((name) => path.join(root, name, "desktop-client-arm64"))
    .filter((dir) => fs.existsSync(path.join(dir, "win-arm64-unpacked", "own-desktop.exe")))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  if (!found[0]) usage(`no desktop-client-arm64 build under ${root}`)
  return found[0]!
}

function planText() {
  return [
    `preflight over ssh ${args.user}@${args.host}: ARM64, interactive session, no leftover %USERPROFILE%\\own-arm64-test`,
    "PC: packages/own-web e2e/gateway/backend.ts (OWN_WEB_E2E_GATEWAY_REMOTE=0, OWN_WEB_E2E_GATEWAY_SLOW_STREAM=1)",
    `PC: gateway on, app listener 127.0.0.1:${appPort}`,
    args.route === "tailnet"
      ? `PC: tailscale serve --bg --tcp=${appPort} tcp://localhost:${appPort} (removed at the end; refused when that port is served already)`
      : `ssh -R 127.0.0.1:${appPort}:127.0.0.1:${appPort} (the device's loopback reaches this PC's app listener)`,
    `copy: ${args.mode === "portable" ? "zip of win-arm64-unpacked, unpacked with tar" : "the installer, /S /D=<test folder>\\app"} into %USERPROFILE%\\${remoteRel}`,
    `launch: scheduled task ${task} (Interactive principal) running launch.cmd: OPENCODE_DESKTOP_TEST_ROOT, --remote-debugging-port=${cdpPort}`,
    `CDP: ssh -L 127.0.0.1:${cdpPort}:127.0.0.1:${cdpPort}; client page, pairing, approve, window, stream, reconnect, screenshots`,
    `evidence: ${evidence}`,
    `cleanup: Browser.close, task removed, ${args.mode === "installer" ? "uninstall /S, " : ""}${args.keep ? "folder kept (--keep)" : "folder removed"}, route and tunnels closed, backend stopped`,
  ]
}

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(64)
}

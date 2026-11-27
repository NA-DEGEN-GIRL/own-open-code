// Windows-only checks of own/launcher/own.ps1: generated config vs the example, port rule, secret hygiene of
// `own env`, and the stop/restart decisions against a fake service (a local HTTP server registered like the real one,
// and a fake opencode.cmd that only answers --version): exit code 4 when sessions run (05 §5.7) and the Claude
// account source (02 §8.7, `--claude-config-dir`). The fast paths: a stale registration (dead pid) is not probed,
// desktop runs skip the gateway wake, the installed exe's --version answer is cached, and open/start reuse a healthy
// service without the packaged-app probe. The real start/stop lifecycle needs the built binary and is run by hand with
// OWN_OPENCODE_EXE, OWN_HOME, OWN_CONFIG_DIR and XDG_* pointing into a temp directory.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const own = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const windows = process.platform === "win32"

function launcher(args, env) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(own, "launcher", "own.ps1"), ...args],
    { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true },
  )
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** An installed version as own install lays it out: app\<ver>\{manifest.json, plugins\<name>} and app\current.json. */
function installLayout(home, version, names) {
  const app = path.join(home, "app", version)
  for (const name of names) mkdirSync(path.join(app, "plugins", name), { recursive: true })
  mkdirSync(app, { recursive: true })
  writeFileSync(path.join(app, "manifest.json"), JSON.stringify({ version, channel: "own" }))
  writeFileSync(
    path.join(home, "app", "current.json"),
    JSON.stringify({ schema: 1, version, path: app, previous: null, updatedAt: new Date().toISOString() }),
  )
  return app
}

function isolatedEnv(t) {
  const root = mkdtempSync(path.join(tmpdir(), "own-launcher-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    OWN_HOME: path.join(root, "home"),
    OWN_CONFIG_DIR: path.join(root, "config"),
    OWN_OPENCODE_EXE: path.join(root, "missing", "opencode.exe"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
  }
}

// Strip // and /* */ comments outside strings (enough for the example file).
function parseJsonc(text) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++
      out += text.slice(start, i + 1)
      continue
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1
      continue
    }
    out += char
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, "$1"))
}

test("generated config matches own/config/opencode.jsonc.example", { skip: !windows }, (t) => {
  const result = launcher(["config", "print"], isolatedEnv(t))
  assert.equal(result.code, 0, result.stderr)
  const generated = JSON.parse(result.stdout)
  const example = parseJsonc(readFileSync(path.join(own, "config", "opencode.jsonc.example"), "utf8"))
  assert.equal(generated.update, "disable")
  assert.equal(generated.share, "disabled")
  assert.deepEqual(generated.permissions, example.permissions)
  assert.equal(example.update, "disable")
  assert.equal(example.share, "disabled")
  assert.deepEqual(example.plugins, [
    "<OWN_HOME>/app/<version>/plugins/own-accounts",
    "<OWN_HOME>/app/<version>/plugins/own-remote",
    "<OWN_HOME>/app/<version>/plugins/own-team",
    "<OWN_HOME>/app/<version>/plugins/claude-auth",
    "<OWN_HOME>/app/<version>/plugins/own-telemetry",
    "<OWN_HOME>/app/<version>/plugins/own-computer-use",
    "<OWN_HOME>/app/<version>/plugins/own-import",
    "<OWN_HOME>/app/<version>/plugins/own-harness",
    "<OWN_HOME>/app/<version>/plugins/own-omo",
    "<OWN_HOME>/app/<version>/plugins/own-creator",
  ])
  // The order comment names the ten places (06 §2.6, 09 §5.1, 10 H0, 15, 17): own.team third, the Claude plugin fourth,
  // computer use sixth, own.import seventh, own.harness eighth, own.omo ninth, own.creator last.
  const text = readFileSync(path.join(own, "config", "opencode.jsonc.example"), "utf8")
  const order = text.slice(text.indexOf("[own.accounts"), text.indexOf("]", text.indexOf("[own.accounts")) + 1)
  assert.deepEqual(
    [...order.matchAll(/(own\.[a-z-]+|heymaaz\.claude-auth-v2)/g)].map((match) => match[1]),
    [
      "own.accounts",
      "own.remote",
      "own.team",
      "heymaaz.claude-auth-v2",
      "own.telemetry",
      "own.computer-use",
      "own.import",
      "own.harness",
      "own.omo",
      "own.creator",
    ],
  )
  // No plugin bundles installed in the temp OWN_HOME, so none are listed.
  assert.deepEqual(generated.plugins ?? [], [])
})

test("generated config lists the installed version's plugin bundles in activation order", { skip: !windows }, (t) => {
  const env = isolatedEnv(t)
  installLayout(env.OWN_HOME, "2.0.18-own.0", [
    "own-harness",
    "own-import",
    "own-computer-use",
    "own-telemetry",
    "claude-auth",
    "own-team",
    "own-remote",
    "own-accounts",
  ])
  const result = launcher(["config", "print"], env)
  assert.equal(result.code, 0, result.stderr)
  const home = env.OWN_HOME.replaceAll("\\", "/")
  assert.deepEqual(JSON.parse(result.stdout).plugins, [
    `${home}/app/2.0.18-own.0/plugins/own-accounts`,
    `${home}/app/2.0.18-own.0/plugins/own-remote`,
    `${home}/app/2.0.18-own.0/plugins/own-team`,
    `${home}/app/2.0.18-own.0/plugins/claude-auth`,
    `${home}/app/2.0.18-own.0/plugins/own-telemetry`,
    `${home}/app/2.0.18-own.0/plugins/own-computer-use`,
    `${home}/app/2.0.18-own.0/plugins/own-import`,
    `${home}/app/2.0.18-own.0/plugins/own-harness`,
  ])
  const status = launcher(["status", "--json"], env)
  assert.equal(status.code, 3)
  assert.deepEqual(JSON.parse(status.stdout).plugins, {
    "own.accounts": true,
    "own.remote": true,
    "own.team": true,
    "claude-auth": true,
    "own.telemetry": true,
    "own.computer-use": true,
    "own.import": true,
    "own.harness": true,
    "own.omo": false,
    "own.creator": false,
  })
  // A version without own-team (2.0.18-own.5 and earlier), own-import or own-harness shows them as absent.
  const older = isolatedEnv(t)
  installLayout(older.OWN_HOME, "2.0.18-own.0", ["own-accounts", "own-remote", "own-telemetry", "own-computer-use"])
  assert.deepEqual(JSON.parse(launcher(["status", "--json"], older).stdout).plugins, {
    "own.accounts": true,
    "own.remote": true,
    "own.team": false,
    "claude-auth": false,
    "own.telemetry": true,
    "own.computer-use": true,
    "own.import": false,
    "own.harness": false,
    "own.omo": false,
    "own.creator": false,
  })
  // A config generated for that version lists only what it has, still in activation order.
  assert.deepEqual(
    JSON.parse(launcher(["config", "print"], older).stdout).plugins.map((entry) => entry.split("/").at(-1)),
    ["own-accounts", "own-remote", "own-telemetry", "own-computer-use"],
  )
})

test("default port follows upstream's channel hash and env never prints values", { skip: !windows }, (t) => {
  const hash = createHash("sha1").update("own").digest("hex")
  const port = 10_000 + (Number.parseInt(hash.slice(0, 8), 16) % 50_000)
  const secret = "sk-test-fake-value-0000000000"
  const result = launcher(["env"], { ...isolatedEnv(t), OPENAI_API_KEY: secret, OPENCODE_DB: "C:/elsewhere.db" })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`default_port\\s+${port}\\b`))
  assert.match(result.stdout, /would be removed \(values not shown\):.*OPENAI_API_KEY/)
  assert.match(result.stdout, /OPENCODE_DB/)
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret))
})

// Decisions TLM: no telemetry exporter inherited from the user's environment, upstream's update check and signed-out
// OpenCode models off in every service the launcher starts (the process env) and in the service config's env bridge.
test("env drops OTEL_* and sets the telemetry-off switches", { skip: !windows }, (t) => {
  const endpoint = "http://collector.invalid:4318"
  const result = launcher(["env"], {
    ...isolatedEnv(t),
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    otel_resource_attributes: "user=someone",
  })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /would be removed \(values not shown\):.*OTEL_EXPORTER_OTLP_ENDPOINT/)
  assert.match(result.stdout, /would be removed \(values not shown\):.*otel_resource_attributes/i)
  for (const name of ["OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_FREE_MODELS", "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"])
    assert.match(result.stdout, new RegExp(`^${name}\\s+1\\s*$`, "m"))
  assert.ok(!result.stdout.includes(endpoint))
  const source = readFileSync(path.join(own, "launcher", "own.ps1"), "utf8")
  const bridge = /function Get-BridgeEnv[\s\S]*?\n\}/.exec(source)?.[0] ?? ""
  const process = /function Set-OwnEnvironment[\s\S]*?\n\}/.exec(source)?.[0] ?? ""
  for (const name of ["OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_FREE_MODELS"]) {
    assert.match(bridge, new RegExp(`\\b${name} = '1'`))
    assert.match(process, new RegExp(`\\$env:${name} = '1'`))
  }
})

test("missing binary and stubs fail with clear messages", { skip: !windows }, (t) => {
  const env = isolatedEnv(t)
  const start = launcher(["start"], env)
  assert.equal(start.code, 1)
  assert.match(start.stderr, /opencode\.exe not found/)
  assert.match(start.stderr, /build-own\.ps1/)
  // Nothing installed and no override: named after the missing version pointer.
  const bare = launcher(["start"], { ...env, OWN_OPENCODE_EXE: "" })
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /not installed \(no version pointer .*app\\current\.json\)/)
  const status = launcher(["status", "--json"], env)
  assert.equal(status.code, 3)
  assert.equal(JSON.parse(status.stdout).state, "stopped")
  // own install needs a payload (install.test.mjs covers the lifecycle); logon is still a stub.
  const install = launcher(["install"], env)
  assert.equal(install.code, 64)
  assert.match(install.stderr, /needs --from/)
  assert.equal(launcher(["logon"], env).code, 2)
  assert.equal(launcher(["nope"], env).code, 64)
})

// ---------------------------------------------------------------- fake service

/** The launcher asynchronously (the fake service answers from this process, so spawnSync would deadlock). */
function launcherAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(own, "launcher", "own.ps1"), ...args],
      { env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    // A closed stdin, like the desktop shell's launcher runs (05 §5.3): the launcher cannot ask.
    child.stdin.end()
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * A registered "own service": the launcher finds it through XDG_STATE_HOME\opencode\service-own.json, checks the pid
 * with GET /api/info and counts GET /api/session/active. opencode.cmd answers `--version` with an own build and
 * accepts `service stop|start` without doing anything, so the service stays up and `restart` completes. With
 * OWN_FAKE_ENV_LOG set, `service start` appends the OWN_LAUNCHER_CLIENT the service would inherit; with
 * OWN_FAKE_MODULE_LOG set, the PSModulePath it would inherit. `wakeMs`: how long an RPC (the gateway wake) takes to
 * answer.
 */
async function fakeService(t, { sessions = 0, wakeMs = 0 } = {}) {
  const env = isolatedEnv(t)
  const exe = path.join(path.dirname(env.OWN_HOME), "bin", "opencode.cmd")
  mkdirSync(path.dirname(exe), { recursive: true })
  writeFileSync(
    exe,
    [
      "@echo off",
      'if "%~1"=="--version" (',
      "  echo opencode 2.0.18-own.0",
      "  exit /b 0",
      ")",
      'if "%~1 %~2"=="service start" if defined OWN_FAKE_ENV_LOG echo client=%OWN_LAUNCHER_CLIENT%>>"%OWN_FAKE_ENV_LOG%"',
      'if "%~1 %~2"=="service start" if defined OWN_FAKE_MODULE_LOG echo %PSModulePath%>>"%OWN_FAKE_MODULE_LOG%"',
      "exit /b 0",
      "",
    ].join("\r\n"),
  )
  const state = { sessions, rpc: [] }
  const server = createServer((request, response) => {
    const send = (body) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.method === "POST" && request.url.startsWith("/api/rpc/")) {
      let body = ""
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        state.rpc.push({ url: request.url, body, auth: request.headers.authorization })
        setTimeout(
          () => send({ output: { enabled: true, state: "listening", problem: null, url: "http://127.0.0.1:28539" } }),
          wakeMs,
        )
      })
      return
    }
    if (request.url === "/api/info") return send({ pid: process.pid, version: "2.0.18-own.0" })
    if (request.url === "/api/session/active")
      return send({ data: Object.fromEntries(Array.from({ length: state.sessions }, (_, i) => [`ses_${i}`, {}])) })
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const registration = path.join(env.XDG_STATE_HOME, "opencode", "service-own.json")
  mkdirSync(path.dirname(registration), { recursive: true })
  writeFileSync(
    registration,
    JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, password: "fake-password", pid: process.pid }),
  )
  return { env: { ...env, OWN_OPENCODE_EXE: exe }, state, registration }
}

test(
  "running sessions without --force: exit 4 for stop and restart, nothing stopped",
  { skip: !windows },
  async (t) => {
    const service = await fakeService(t, { sessions: 2 })
    for (const command of [["restart"], ["stop"]]) {
      const result = await launcherAsync(command, service.env)
      assert.equal(result.code, 4, `${command}: ${result.stderr}`)
      assert.match(result.stderr, /2 session\(s\) are running; re-run with --force/)
    }
    // --claude-config-dir is not written when the restart is refused.
    const claude = mkdtempSync(path.join(tmpdir(), "own-claude-"))
    t.after(() => rmSync(claude, { recursive: true, force: true }))
    const refused = await launcherAsync(["restart", "--claude-config-dir", claude], service.env)
    assert.equal(refused.code, 4, refused.stderr)
    assert.equal(existsSync(path.join(service.env.OWN_HOME, "claude-auth.json")), false)
  },
)

test(
  "restart --claude-config-dir: stored in claude-auth.json, the only CLAUDE_* in the service env",
  { skip: !windows },
  async (t) => {
    const service = await fakeService(t)
    const claude = mkdtempSync(path.join(tmpdir(), "own-claude-"))
    t.after(() => rmSync(claude, { recursive: true, force: true }))
    const inherited = { CLAUDE_CONFIG_DIR: "C:\\inherited\\claude", CLAUDE_CODE_OAUTH_TOKEN: "fake-token-value-0000" }
    const bridge = () => JSON.parse(readFileSync(path.join(service.env.OWN_CONFIG_DIR, "service-own.json"), "utf8")).env

    const bad = await launcherAsync(["restart", "--claude-config-dir", "relative\\dir"], {
      ...service.env,
      ...inherited,
    })
    assert.equal(bad.code, 64, bad.stderr)
    assert.match(bad.stderr, /--claude-config-dir: not an absolute path/)
    assert.equal(await launcherAsync(["restart", "--claude-config-dir"], service.env).then((r) => r.code), 64)

    const set = await launcherAsync(["restart", "--claude-config-dir", claude], { ...service.env, ...inherited })
    assert.equal(set.code, 0, set.stderr)
    const stored = JSON.parse(readFileSync(path.join(service.env.OWN_HOME, "claude-auth.json"), "utf8"))
    assert.equal(stored.configDir, claude)
    assert.match(stored.setAt, /^\d{4}-\d\d-\d\dT/)
    assert.equal(bridge().CLAUDE_CONFIG_DIR, claude)
    assert.deepEqual(
      Object.keys(bridge()).filter((name) => name.startsWith("CLAUDE_")),
      ["CLAUDE_CONFIG_DIR"],
    )
    assert.ok(
      !set.stdout.includes(inherited.CLAUDE_CODE_OAUTH_TOKEN) &&
        !set.stderr.includes(inherited.CLAUDE_CODE_OAUTH_TOKEN),
    )

    // Later starts keep it (own start, the shell), and `own env` says where it comes from.
    const start = await launcherAsync(["start"], service.env)
    assert.equal(start.code, 0, start.stderr)
    assert.equal(bridge().CLAUDE_CONFIG_DIR, claude)
    const shown = await launcherAsync(["env"], service.env)
    assert.match(
      shown.stdout,
      new RegExp(`CLAUDE_CONFIG_DIR\\s+${claude.replaceAll("\\", "\\\\")} \\(from .*claude-auth\\.json\\)`),
    )

    // `default` removes it; a stale file (directory gone) is ignored with a warning.
    const reset = await launcherAsync(["restart", "--claude-config-dir", "default"], service.env)
    assert.equal(reset.code, 0, reset.stderr)
    assert.equal(existsSync(path.join(service.env.OWN_HOME, "claude-auth.json")), false)
    assert.equal(bridge().CLAUDE_CONFIG_DIR, undefined)
    writeFileSync(
      path.join(service.env.OWN_HOME, "claude-auth.json"),
      JSON.stringify({ configDir: "C:\\gone\\claude" }),
    )
    const stale = await launcherAsync(["start"], service.env)
    assert.equal(stale.code, 0, stale.stderr)
    assert.match(stale.stderr, /ignoring .*claude-auth\.json: configDir is not an existing directory/)
    assert.equal(bridge().CLAUDE_CONFIG_DIR, undefined)
  },
)

test(
  "restart --claude-config-dir refuses own's login folders like changeSource: by path, any case, through a junction",
  { skip: !windows },
  async (t) => {
    const service = await fakeService(t)
    const logins = path.join(service.env.OWN_HOME, "claude-accounts")
    const own = path.join(logins, "acc_01J9OWNLOGIN0000000000000")
    mkdirSync(own, { recursive: true })
    const junction = path.join(path.dirname(service.env.OWN_HOME), "to-own-login")
    symlinkSync(own, junction, "junction")
    for (const dir of [own, logins, own.replace("claude-accounts", "CLAUDE-ACCOUNTS"), junction]) {
      const refused = await launcherAsync(["restart", "--claude-config-dir", dir], service.env)
      assert.equal(refused.code, 64, `${dir}: ${refused.stderr}`)
      assert.match(refused.stderr, /--claude-config-dir: one of own's login folders/)
    }
    assert.equal(existsSync(path.join(service.env.OWN_HOME, "claude-auth.json")), false)
    // A folder beside them is still a usable source.
    const beside = path.join(service.env.OWN_HOME, "claude-accounts-not")
    mkdirSync(beside)
    const set = await launcherAsync(["restart", "--claude-config-dir", beside], service.env)
    assert.equal(set.code, 0, set.stderr)
    assert.equal(JSON.parse(readFileSync(path.join(service.env.OWN_HOME, "claude-auth.json"), "utf8")).configDir, beside)
  },
)

test("start wakes the remote access gateway at the control location only when gateway.json has it on", { skip: !windows }, async (t) => {
  const service = await fakeService(t)
  installLayout(service.env.OWN_HOME, "2.0.18-own.0", ["own-remote"])
  const off = await launcherAsync(["start"], service.env)
  assert.equal(off.code, 0, off.stderr)
  assert.equal(service.state.rpc.length, 0)

  writeFileSync(
    path.join(service.env.OWN_HOME, "gateway.json"),
    JSON.stringify({ version: 1, enabled: true, bind: "127.0.0.1", port: 28539, publicOrigin: null, updatedAt: 0 }),
  )
  const on = await launcherAsync(["start"], service.env)
  assert.equal(on.code, 0, on.stderr)
  assert.equal(service.state.rpc.length, 1)
  const call = new URL(service.state.rpc[0].url, "http://127.0.0.1")
  assert.equal(call.pathname, "/api/rpc/own.remote/gateway.status")
  assert.equal(call.searchParams.get("location[directory]"), path.join(service.env.OWN_HOME, "control"))
  assert.deepEqual(JSON.parse(service.state.rpc[0].body), { input: {} })
  assert.equal(service.state.rpc[0].auth, "Basic " + Buffer.from("opencode:fake-password").toString("base64"))
  assert.ok(on.stderr.includes("remote access gateway listening on http://127.0.0.1:28539"), on.stderr)
})

// RH-50: the wake's call loads every plugin of the control Location first. On a loaded PC that outlasted the former
// 60 s, `own restart` said the gateway would start with the app, and the release smoke found no listener.
test(
  "start waits for a gateway wake that answers after more than a minute",
  { skip: !windows, timeout: 240_000 },
  async (t) => {
    const service = await fakeService(t, { wakeMs: 75_000 })
    installLayout(service.env.OWN_HOME, "2.0.18-own.0", ["own-remote"])
    writeFileSync(
      path.join(service.env.OWN_HOME, "gateway.json"),
      JSON.stringify({ version: 1, enabled: true, bind: "127.0.0.1", port: 28539, publicOrigin: null, updatedAt: 0 }),
    )
    const on = await launcherAsync(["start"], service.env)
    assert.equal(on.code, 0, on.stderr)
    assert.equal(service.state.rpc.length, 1)
    assert.ok(on.stderr.includes("remote access gateway listening on http://127.0.0.1:28539"), on.stderr)
  },
)

test(
  "own open --browser is accepted (the browser fallback the desktop mismatch screen runs)",
  { skip: !windows },
  () => {
    const help = launcher(["help"], {})
    assert.equal(help.code, 0)
    assert.match(help.stdout, /own open \[--browser\]/)
    assert.match(help.stdout, /--claude-config-dir <dir>\|default/)
    assert.match(help.stdout, /4 sessions running/)
    assert.match(help.stdout, /own install\|update \[--from <payload>\]/)
    assert.match(help.stdout, /own rollback \[--to <version>\]/)
    assert.match(help.stdout, /own uninstall \[--remove-data\]/)
  },
)

// ---------------------------------------------------------------- fast paths

/** A port nothing listens on (a service that is gone). */
const closedPort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })

/** Writes XDG_STATE_HOME\opencode\service-own.json. */
function register(env, registration) {
  const file = path.join(env.XDG_STATE_HOME, "opencode", "service-own.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ password: "fake-password", ...registration }))
  return file
}

test(
  "a registration whose pid is gone is stale without asking the service; a live pid is still checked",
  { skip: !windows },
  async (t) => {
    const env = isolatedEnv(t)
    // A process that has exited: what a registration names after a reboot, crash or kill.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid
    // Answers like the service registered with that pid, so only a probe could take it for running.
    const requests = []
    const server = createServer((request, response) => {
      requests.push(request.url)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ pid: dead, version: "2.0.18-own.0" }))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(() => server.close())
    const url = `http://127.0.0.1:${server.address().port}`

    register(env, { url, pid: dead })
    const stale = await launcherAsync(["status", "--json"], env)
    assert.equal(stale.code, 3, stale.stderr)
    assert.equal(JSON.parse(stale.stdout).state, "stale-registration")
    assert.deepEqual(requests, [], "a dead pid is never probed")

    // A live pid the service does not report (reused by another process): asked, and stale as before.
    register(env, { url, pid: process.pid })
    const reused = await launcherAsync(["status", "--json"], env)
    assert.equal(reused.code, 3, reused.stderr)
    assert.equal(JSON.parse(reused.stdout).state, "stale-registration")
    assert.deepEqual(requests, ["/api/info"])

    // The case that cost about 2 s per launcher run in Windows PowerShell: a dead pid and a closed port.
    register(env, { url: `http://127.0.0.1:${await closedPort()}`, pid: dead })
    const started = performance.now()
    const closed = await launcherAsync(["status", "--json"], env)
    t.diagnostic(`own status, stale registration (dead pid, closed port): ${Math.round(performance.now() - started)} ms`)
    assert.equal(closed.code, 3, closed.stderr)
    assert.equal(JSON.parse(closed.stdout).state, "stale-registration")
  },
)

test(
  "desktop runs (OWN_LAUNCHER_CLIENT=desktop) skip the gateway wake and do not pass the marker on; CLI runs wake it",
  { skip: !windows },
  async (t) => {
    const service = await fakeService(t)
    installLayout(service.env.OWN_HOME, "2.0.18-own.0", ["own-remote"])
    writeFileSync(
      path.join(service.env.OWN_HOME, "gateway.json"),
      JSON.stringify({ version: 1, enabled: true, bind: "127.0.0.1", port: 28539, publicOrigin: null, updatedAt: 0 }),
    )
    const envLog = path.join(path.dirname(service.env.OWN_HOME), "service-env.log")
    const env = { ...service.env, OWN_FAKE_ENV_LOG: envLog }

    const desktop = await launcherAsync(["start"], { ...env, OWN_LAUNCHER_CLIENT: "desktop" })
    assert.equal(desktop.code, 0, desktop.stderr)
    assert.equal(service.state.rpc.length, 0, "no gateway.status from a desktop run")
    assert.doesNotMatch(desktop.stderr, /remote access gateway/)
    // `service start` (and so the service) runs without the marker.
    assert.deepEqual(readFileSync(envLog, "utf8").trim().split(/\r?\n/), ["client="])

    const cli = await launcherAsync(["start"], env)
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(service.state.rpc.length, 1)
    assert.equal(new URL(service.state.rpc[0].url, "http://127.0.0.1").pathname, "/api/rpc/own.remote/gateway.status")
    assert.match(cli.stderr, /remote access gateway listening on http:\/\/127\.0\.0\.1:28539/)
  },
)

test(
  "from a PowerShell 7 shell, through own.cmd or straight to own.ps1: 5.1 and the service get 5.1's own module path",
  { skip: !windows },
  async (t) => {
    const service = await fakeService(t)
    const root = path.dirname(service.env.OWN_HOME)
    // What a pwsh 7 window passes to its children: its own module folders ahead of Windows PowerShell's. 5.1 then
    // loads 7's Microsoft.PowerShell.Utility and Get-FileHash fails. own.cmd clears the variable; own.ps1, which the
    // installer and the desktop shell start directly, sets 5.1's default itself.
    const pwsh7 = [
      path.join(root, "Documents", "PowerShell", "Modules"),
      "C:\\Program Files\\PowerShell\\Modules",
      "c:\\program files\\powershell\\7\\Modules",
      "C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
    ].join(";")
    const ways = {
      "own.cmd": ["cmd.exe", ["/d", "/c", path.join(own, "launcher", "own.cmd"), "start"]],
      "own.ps1": [
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(own, "launcher", "own.ps1"), "start"],
      ],
    }
    const inherited = {}
    for (const [way, [command, args]] of Object.entries(ways)) {
      const moduleLog = path.join(root, `service-modules-${way}.log`)
      const result = await new Promise((resolve) => {
        const child = spawn(command, args, {
          env: { ...process.env, ...service.env, PSModulePath: pwsh7, OWN_FAKE_MODULE_LOG: moduleLog },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
        child.stdin.end()
        let stderr = ""
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
        child.on("close", (code) => resolve({ code, stderr }))
      })
      assert.equal(result.code, 0, `${way}: ${result.stderr}`)
      const entries = readFileSync(moduleLog, "utf8").trim().split(";").filter(Boolean)
      t.diagnostic(`${way}: service PSModulePath: ${entries.join(";")}`)
      assert.ok(
        entries.some((item) => /\\WindowsPowerShell\\v1\.0\\Modules\\?$/i.test(item)),
        `${way}: 5.1's own modules are on the path`,
      )
      assert.ok(
        !entries.some((item) => /\\PowerShell\\(7\\)?Modules\\?$/i.test(item)),
        `${way}: none of PowerShell 7's module folders`,
      )
      assert.ok(!entries.some((item) => item.startsWith(root)), `${way}: nothing of the calling shell's own path`)
      inherited[way] = entries
    }
    assert.deepEqual(inherited["own.ps1"], inherited["own.cmd"], "the same value either way")
  },
)

test(
  "inside a packaged app, start reuses a healthy service without the write probe; with none it refuses (exit 5)",
  { skip: !windows },
  async (t) => {
    const service = await fakeService(t)
    const inside = { ...service.env, OWN_TEST_VIRTUALIZED_FAMILY: "Claude_pzs8sxrjxfjjc" }
    const registration = readFileSync(service.registration, "utf8")

    // No service: starting one would write accounts, vault and ledger into the app's private copy.
    rmSync(service.registration)
    const refused = await launcherAsync(["start"], inside)
    assert.equal(refused.code, 5, refused.stderr)
    assert.match(refused.stderr, /inside the packaged app Claude_pzs8sxrjxfjjc/)
    assert.equal(existsSync(service.env.OWN_HOME), false, "nothing written under OWN_HOME")

    // A healthy service: reused, nothing started.
    writeFileSync(service.registration, registration)
    const reused = await launcherAsync(["start"], inside)
    assert.equal(reused.code, 0, reused.stderr)
    assert.match(reused.stdout, /^http:\/\/127\.0\.0\.1:\d+\/\s*$/)
    // restart stops it first: still checked before anything happens.
    const restart = await launcherAsync(["restart"], inside)
    assert.equal(restart.code, 5, restart.stderr)
  },
)

let compiledExe
/**
 * opencode.exe for an installed layout (compiled once with Windows PowerShell's Add-Type): answers --version from
 * fake-version.txt next to it, logs every call to OWN_FAKE_LOG, and on `service start` registers the fake service
 * (copies OWN_FAKE_REGISTRATION_SOURCE to OWN_FAKE_REGISTRATION).
 */
function fakeExe() {
  if (compiledExe) return compiledExe
  const dir = mkdtempSync(path.join(tmpdir(), "own-launcher-exe-"))
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, "fake.cs")
  const out = path.join(dir, "opencode.exe")
  writeFileSync(
    source,
    String.raw`
using System;
using System.IO;
public static class FakeOpencode {
  public static int Main(string[] args) {
    string version = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fake-version.txt")).Trim();
    string joined = string.Join(" ", args);
    string log = Environment.GetEnvironmentVariable("OWN_FAKE_LOG");
    if (!string.IsNullOrEmpty(log)) File.AppendAllText(log, version + ": " + joined + "\n");
    if (joined == "--version") { Console.WriteLine("opencode " + version); return 0; }
    string source = Environment.GetEnvironmentVariable("OWN_FAKE_REGISTRATION_SOURCE");
    if (joined == "service start" && !string.IsNullOrEmpty(source) && File.Exists(source))
      File.Copy(source, Environment.GetEnvironmentVariable("OWN_FAKE_REGISTRATION"), true);
    return 0;
  }
}
`,
  )
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${source}') -OutputAssembly '${out}' -OutputType ConsoleApplication`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
  if (result.status !== 0 || !existsSync(out)) throw new Error(`could not compile the fake opencode.exe: ${result.stderr}`)
  compiledExe = out
  return out
}

test(
  "the installed exe's --version answer is cached by path, length and write time; OWN_OPENCODE_EXE is always asked",
  { skip: !windows },
  async (t) => {
    const env = { ...isolatedEnv(t), OWN_OPENCODE_EXE: "" }
    const root = path.dirname(env.OWN_HOME)
    const app = installLayout(env.OWN_HOME, "2.0.18-own.0", [])
    const exe = path.join(app, "opencode.exe")
    copyFileSync(fakeExe(), exe)
    writeFileSync(path.join(app, "fake-version.txt"), "2.0.18-own.0")
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ pid: process.pid, version: "2.0.18-own.0" }))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(() => server.close())
    const registration = register(env, { url: `http://127.0.0.1:${server.address().port}`, pid: process.pid })
    Object.assign(env, {
      OWN_FAKE_LOG: path.join(root, "fake.log"),
      OWN_FAKE_REGISTRATION: registration,
      OWN_FAKE_REGISTRATION_SOURCE: path.join(root, "registration-source.json"),
    })
    copyFileSync(registration, env.OWN_FAKE_REGISTRATION_SOURCE)
    rmSync(registration)
    const asked = () =>
      existsSync(env.OWN_FAKE_LOG)
        ? readFileSync(env.OWN_FAKE_LOG, "utf8").split("\n").filter((line) => line.endsWith(": --version")).length
        : 0
    const cacheFile = path.join(env.OWN_HOME, "state", "exe-version.json")
    const cache = () => JSON.parse(readFileSync(cacheFile, "utf8"))
    const start = async (extra = {}) => {
      const result = await launcherAsync(["start"], { ...env, ...extra })
      assert.equal(result.code, 0, result.stderr)
    }

    // Miss: a fresh start asks the exe and keeps the answer.
    await start()
    assert.equal(asked(), 1)
    assert.equal(cache().version, "2.0.18-own.0")
    assert.ok(cache().key.toLowerCase().startsWith(`${exe}|`.toLowerCase()), cache().key)
    // Hit: the next starts (the service is running now) do not spawn it.
    await start()
    await start()
    assert.equal(asked(), 1)

    // A replaced exe (other length, new write time) is asked again on the next start.
    const before = cache().key
    appendFileSync(exe, Buffer.alloc(512))
    rmSync(registration)
    await start()
    assert.equal(asked(), 2)
    assert.notEqual(cache().key, before)
    await start()
    assert.equal(asked(), 2)

    // A start that reuses the running service writes nothing under OWN_HOME (the packaged-app probe did not run), so
    // a miss there is asked without being kept; the next fresh start keeps it again.
    rmSync(cacheFile)
    await start()
    assert.equal(asked(), 3)
    assert.equal(existsSync(cacheFile), false)
    rmSync(registration)
    await start()
    assert.equal(asked(), 4)
    assert.equal(existsSync(cacheFile), true)

    // OWN_OPENCODE_EXE (a dev build, rebuilt in place) is asked every time and leaves the cache alone.
    const kept = readFileSync(cacheFile, "utf8")
    await start({ OWN_OPENCODE_EXE: exe })
    await start({ OWN_OPENCODE_EXE: exe })
    assert.equal(asked(), 6)
    assert.equal(readFileSync(cacheFile, "utf8"), kept)

    // Only an own verdict counts: anything else stored for this exe is a miss, never a refusal.
    writeFileSync(cacheFile, JSON.stringify({ key: cache().key, version: "2.0.18" }))
    rmSync(registration)
    await start()
    assert.equal(asked(), 7)
    assert.equal(cache().version, "2.0.18-own.0")
  },
)

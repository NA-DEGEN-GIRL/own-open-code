// Windows-only checks of the install lifecycle in own/launcher/own.ps1 (own install|update|rollback|uninstall, 01 §5.5,
// 05 §10.4): everything runs in a temp root with OWN_HOME, OWN_CONFIG_DIR and XDG_* overridden, and the user PATH is
// the text file OWN_USER_PATH_FILE, so neither the real profile nor the registry is touched. opencode.exe is a tiny
// console program compiled here (Add-Type) that answers --version from a fake-version.txt next to it and fakes
// `service stop|start` on the registration file of a fake service (a local HTTP server, 127.0.0.1 only).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const own = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const windows = process.platform === "win32"
const launcherFile = path.join(own, "launcher", "own.ps1")
const V1 = "2.0.18-own.1"
const V2 = "2.0.18-own.2"
const V3 = "2.0.18-own.3"
const V4 = "2.0.18-own.4"

// ---------------------------------------------------------------- fixtures

const fakeSource = String.raw`
using System;
using System.IO;
public static class FakeOpencode {
  public static int Main(string[] args) {
    string version = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fake-version.txt")).Trim();
    string joined = string.Join(" ", args);
    string log = Environment.GetEnvironmentVariable("OWN_FAKE_LOG");
    if (!string.IsNullOrEmpty(log)) File.AppendAllText(log, version + ": " + joined + "\n");
    if (joined == "--version") { Console.WriteLine("opencode " + version); return 0; }
    string registration = Environment.GetEnvironmentVariable("OWN_FAKE_REGISTRATION");
    if (joined == "service stop") {
      if (!string.IsNullOrEmpty(registration) && File.Exists(registration)) File.Delete(registration);
      return 0;
    }
    if (joined == "service start") {
      if (version == Environment.GetEnvironmentVariable("OWN_FAKE_FAIL_START")) {
        string db = Environment.GetEnvironmentVariable("OWN_FAKE_DB");
        if (!string.IsNullOrEmpty(db)) File.AppendAllText(db, "migrated by " + version + "\n");
        return 1;
      }
      string source = Environment.GetEnvironmentVariable("OWN_FAKE_REGISTRATION_SOURCE");
      if (!string.IsNullOrEmpty(source) && File.Exists(source)) File.Copy(source, registration, true);
      return 0;
    }
    return 0;
  }
}
`

/** The fake opencode.exe, compiled once per run (Windows PowerShell's Add-Type, .NET Framework csc). */
const fakeExe = (() => {
  if (!windows) return undefined
  const dir = mkdtempSync(path.join(tmpdir(), "own-fake-exe-"))
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, "opencode.exe")
  writeFileSync(path.join(dir, "fake.cs"), fakeSource)
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${path.join(dir, "fake.cs")}') -OutputAssembly '${out}' -OutputType ConsoleApplication`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
  if (result.status !== 0 || !existsSync(out))
    throw new Error(`could not compile the fake opencode.exe: ${result.stderr}`)
  return out
})()

const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const fileSha = (file) => "sha256:" + sha256(readFileSync(file))

/** own/scripts/build-desktop.ps1 Get-TreeHash. */
function treeHash(dir) {
  const files = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel)
      else files.push(rel)
    }
  }
  walk(dir, "")
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const text = files.map((rel) => `${rel}\n${sha256(readFileSync(path.join(dir, rel)))}\n`).join("")
  return "sha256-tree:" + sha256(Buffer.from(text, "utf8"))
}

/**
 * The plugin folders of a release payload, in activation order (build-desktop.ps1 $pluginNames, with the bundled Claude
 * plugin fourth, 02 §8.2); own-harness last. own-omo (15), newer than all of them, comes after own-harness where a test
 * brings it (WITH_OMO).
 */
const PLUGINS = [
  "own-accounts",
  "own-remote",
  "own-team",
  "claude-auth",
  "own-telemetry",
  "own-computer-use",
  "own-import",
  "own-harness",
]

/** A payload like own\.out\build\<ver>: app\ (the app\<ver> layout with manifest.json) and bin\ (the launcher). */
function makePayload(
  root,
  version,
  {
    buildId = `b${version.replace(/\D/g, "").padStart(11, "0")}`,
    launcher,
    legacy = false,
    plugins = PLUGINS,
  } = {},
) {
  const app = path.join(root, "app")
  const file = (rel, content) => {
    mkdirSync(path.dirname(path.join(app, rel)), { recursive: true })
    writeFileSync(path.join(app, rel), content)
  }
  mkdirSync(app, { recursive: true })
  copyFileSync(fakeExe, path.join(app, "opencode.exe"))
  file("fake-version.txt", version)
  file("web/index.html", `<!doctype html><title>${version}</title>`)
  file("web/assets/app.js", `console.log(${JSON.stringify(version)})`)
  for (const name of plugins) file(`plugins/${name}/index.js`, `// ${name} ${version}`)
  file("own-vault.exe", `vault ${version}`)
  file("templates/ratecards.default.json", "{}")
  const artifacts = {
    "opencode.exe": fileSha(path.join(app, "opencode.exe")),
    "web/": treeHash(path.join(app, "web")),
    ...Object.fromEntries(
      plugins.map((name) => [
        `plugins/${name}/index.js`,
        fileSha(path.join(app, "plugins", name, "index.js")),
      ]),
    ),
    "own-vault.exe": fileSha(path.join(app, "own-vault.exe")),
    "templates/ratecards.default.json": fileSha(path.join(app, "templates", "ratecards.default.json")),
  }
  // install_layout "pointer": its plugins read app\current.json (build-desktop.ps1 writes it from 2.0.18-own.3 on);
  // `legacy` stands for 2.0.18-own.2 and earlier, whose plugins find their files only through app\current.
  const layout = legacy ? {} : { install_layout: "pointer" }
  file("manifest.json", JSON.stringify({ version, channel: "own", build_id: buildId, ...layout, artifacts }, null, 2))
  const bin = path.join(root, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "own.ps1"), launcher ?? readFileSync(launcherFile))
  copyFileSync(path.join(own, "launcher", "own.cmd"), path.join(bin, "own.cmd"))
  return root
}

/** A root under %LOCALAPPDATA% (not Temp): where junctions could not be traversed on the reporting PC (26200). */
const localAppData = () => mkdtempSync(path.join(process.env.LOCALAPPDATA ?? tmpdir(), "own-open-code-verify-"))

function sandbox(t, root = mkdtempSync(path.join(tmpdir(), "own-install-test-"))) {
  // rmdir /s never follows junctions (app\current points into the same root anyway).
  t.after(() => spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", root], { windowsHide: true }))
  const env = {
    OWN_HOME: path.join(root, "home"),
    OWN_CONFIG_DIR: path.join(root, "config"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    OWN_USER_PATH_FILE: path.join(root, "user-path.txt"),
    OWN_FAKE_LOG: path.join(root, "fake.log"),
    OWN_FAKE_REGISTRATION: path.join(root, "xdg-state", "opencode", "service-own.json"),
    OWN_FAKE_REGISTRATION_SOURCE: path.join(root, "registration-source.json"),
    OWN_FAKE_DB: path.join(root, "xdg-data", "opencode", "opencode-own.db"),
  }
  writeFileSync(env.OWN_USER_PATH_FILE, "C:\\Windows\\system32;%USERPROFILE%\\tools")
  const home = env.OWN_HOME
  return {
    root,
    env,
    home,
    app: (...parts) => path.join(home, "app", ...parts),
    payload: (version, options) =>
      makePayload(path.join(root, `payload-${version}-${Math.random().toString(36).slice(2)}`), version, options),
    run: (args, extra) => launcherAsync(args, { ...env, ...extra }),
    state: () => JSON.parse(readFileSync(path.join(home, "install.json"), "utf8")),
    fakeLog: () => (existsSync(env.OWN_FAKE_LOG) ? readFileSync(env.OWN_FAKE_LOG, "utf8") : ""),
    userPath: () => readFileSync(env.OWN_USER_PATH_FILE, "utf8"),
    db: (content) => {
      if (content !== undefined) {
        mkdirSync(path.dirname(env.OWN_FAKE_DB), { recursive: true })
        writeFileSync(env.OWN_FAKE_DB, content)
      }
      return readFileSync(env.OWN_FAKE_DB, "utf8")
    },
  }
}

/** Where a junction points (read from the link, never followed), or undefined. */
function junctionTarget(link) {
  try {
    if (!lstatSync(link).isSymbolicLink()) return "not-a-junction"
    return path.resolve(readlinkSync(link))
  } catch {
    return undefined
  }
}

/** The version folder app\current.json names (app\<version> next to the file), or undefined. */
function pointerTarget(home) {
  const file = path.join(home, "app", "current.json")
  if (!existsSync(file)) return undefined
  return path.join(home, "app", JSON.parse(readFileSync(file, "utf8")).version)
}

/** The own plugin entries the launcher writes for a version (forward slashes). */
/** A release with own-omo after own-harness (build-desktop.ps1 since 2026-10-28, 15). */
const WITH_OMO = [...PLUGINS, "own-omo"]
/** A release with own-creator after own-omo (build-desktop.ps1 since 2026-11-04, 17). */
const WITH_CREATOR = [...WITH_OMO, "own-creator"]

/** The folders of a release from before the bundled Claude plugin (2.0.24-own.3 and earlier). */
const BEFORE_CLAUDE = PLUGINS.filter((name) => name !== "claude-auth")

const ownEntries = (home, version, names = PLUGINS) =>
  names.map((n) => `${home.replaceAll("\\", "/")}/app/${version}/plugins/${n}`)

const configFile = (box) => path.join(box.env.OWN_CONFIG_DIR, "opencode.jsonc")
const configPlugins = (box) => JSON.parse(readFileSync(configFile(box), "utf8")).plugins

/** The launcher with a closed stdin, like the installer runs it (spawnSync would deadlock the fake service). */
function launcherAsync(args, env, file = launcherFile) {
  return new Promise((resolve) => {
    const base = { ...process.env }
    delete base.OWN_OPENCODE_EXE
    delete base.OWN_LAUNCHER_HANDOVER
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
      { env: { ...base, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    child.stdin.end()
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * A registered own service: GET /api/info (pid, version) and /api/session/active (state.sessions). The fake
 * opencode.exe removes the registration on `service stop` and copies it back from OWN_FAKE_REGISTRATION_SOURCE on
 * `service start`, so the launcher sees the service go down and come back.
 */
async function fakeService(t, box, { sessions = 0 } = {}) {
  const state = { sessions }
  const server = createServer((request, response) => {
    const send = (body) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.url === "/api/info") return send({ pid: process.pid, version: "fake" })
    if (request.url === "/api/session/active")
      return send({ data: Object.fromEntries(Array.from({ length: state.sessions }, (_, i) => [`ses_${i}`, {}])) })
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  const registration = JSON.stringify({
    url: `http://127.0.0.1:${server.address().port}`,
    password: "fake-password",
    pid: process.pid,
  })
  writeFileSync(box.env.OWN_FAKE_REGISTRATION_SOURCE, registration)
  mkdirSync(path.dirname(box.env.OWN_FAKE_REGISTRATION), { recursive: true })
  writeFileSync(box.env.OWN_FAKE_REGISTRATION, registration)
  return { state, running: () => existsSync(box.env.OWN_FAKE_REGISTRATION) }
}

const pathEntries = (value) => value.split(";").filter(Boolean)

// ---------------------------------------------------------------- tests

test(
  "fresh install: app\\<ver>, app\\current.json (no junction), launcher, user PATH, config and install.json",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    const payload = box.payload(V1)
    const result = await box.run(["install", "--from", payload, "--no-prompt"])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`installed ${V1.replaceAll(".", "\\.")}`))
    assert.match(result.stdout, /added to the user PATH/)

    assert.equal(pointerTarget(box.home), box.app(V1))
    const pointer = JSON.parse(readFileSync(box.app("current.json"), "utf8"))
    assert.equal(pointer.schema, 1)
    assert.equal(pointer.version, V1)
    assert.equal(pointer.path, box.app(V1))
    assert.equal(pointer.previous, null)
    assert.match(pointer.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    assert.equal(existsSync(box.app("current")), false, "no app\\current junction or folder")
    assert.deepEqual(readdirSync(box.app()).sort(), [V1, "current.json"].sort(), "no temp files left")
    assert.ok(existsSync(box.app(V1, "opencode.exe")))
    assert.ok(existsSync(box.app(V1, "web", "index.html")))
    for (const name of ["own.ps1", "own.cmd"])
      assert.deepEqual(readFileSync(path.join(box.home, "bin", name)), readFileSync(path.join(payload, "bin", name)))
    // Copy mode leaves the payload where it was.
    assert.ok(existsSync(path.join(payload, "app", "opencode.exe")))

    // PATH: appended once, the other entries (one unexpanded) untouched.
    assert.deepEqual(pathEntries(box.userPath()), [
      "C:\\Windows\\system32",
      "%USERPROFILE%\\tools",
      path.join(box.home, "bin"),
    ])

    // Config written (the installed version's bundles, update disabled); the default dark theme is the app's, nothing
    // here sets one.
    const config = JSON.parse(readFileSync(configFile(box), "utf8"))
    assert.deepEqual(config.plugins, ownEntries(box.home, V1))
    assert.equal(config.update, "disable")
    assert.equal(config.theme, undefined)

    const state = box.state()
    assert.equal(state.current, V1)
    assert.equal(state.previous, null)
    assert.equal(state.history.length, 1)
    assert.equal(state.history[0].action, "install")
    assert.equal(state.history[0].backup, null)
    assert.match(readFileSync(path.join(box.home, "install.log"), "utf8"), /own install 2\.0\.18-own\.1 from/)
    // The service was not running and is not started by an install.
    assert.equal(box.fakeLog().includes("service start"), false)

    // Again: nothing to do, PATH unchanged, status reports the installed version.
    const again = await box.run(["install", "--from", payload, "--no-prompt", "--json"])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(JSON.parse(again.stdout).action, "unchanged")
    assert.equal(pathEntries(box.userPath()).length, 3)
    const status = await box.run(["status", "--json"])
    assert.equal(status.code, 3)
    const shown = JSON.parse(status.stdout)
    assert.equal(shown.installed, V1)
    assert.equal(shown.app, box.app(V1))
    assert.equal(shown.app_source, "pointer")
    assert.equal(shown.exe, box.app(V1, "opencode.exe"))
    assert.equal(shown.exe_present, true)
  },
)

test(
  "update with running sessions: refused (exit 4, nothing changed) until --force; then DB backup, switch, restart, rollback",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    box.db("v1 data\n")
    writeFileSync(`${box.env.OWN_FAKE_DB}-wal`, "v1 wal\n")
    const service = await fakeService(t, box, { sessions: 2 })

    // The installer's first question (NSIS customInit): same version → nothing to ask; another one → exit 4.
    const same = await box.run(["install", "--preflight", "--version", V1])
    assert.equal(same.code, 0, same.stderr)
    const other = await box.run(["install", "--preflight", "--version", V2])
    assert.equal(other.code, 4, other.stderr)
    assert.equal(other.stdout, "2")

    const payload = box.payload(V2)
    const refused = await box.run(["install", "--from", payload, "--move", "--no-prompt"])
    assert.equal(refused.code, 4, refused.stderr)
    assert.match(refused.stderr, /2 session\(s\) are running; re-run with --force to update anyway/)
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.ok(existsSync(path.join(payload, "app", "opencode.exe")), "the payload stays where it was")
    assert.deepEqual(readdirSync(box.app()).sort(), [V1, "current.json"].sort())
    assert.ok(service.running())
    assert.equal(box.fakeLog().includes("service stop"), false)

    const forced = await box.run(["install", "--from", payload, "--move", "--no-prompt", "--force"])
    assert.equal(forced.code, 0, forced.stderr)
    assert.match(forced.stdout, /updated to 2\.0\.18-own\.2/)
    assert.match(forced.stdout, /previous version 2\.0\.18-own\.1 kept for 'own rollback'/)
    assert.match(forced.stdout, /service running at http:\/\/127\.0\.0\.1:\d+\//)
    assert.equal(pointerTarget(box.home), box.app(V2))
    assert.ok(existsSync(box.app(V1, "opencode.exe")), "the previous version is kept")
    assert.equal(existsSync(path.join(payload, "app")), false, "--move consumed the payload")
    assert.ok(service.running())
    // The service (stopped before the switch) starts on the new version: the pointer and the plugin entries name it.
    assert.equal(JSON.parse(readFileSync(box.app("current.json"), "utf8")).previous, V1)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V2))
    assert.match(box.fakeLog(), new RegExp(`${V1}: service stop[\\s\\S]*${V2}: service start`))

    const state = box.state()
    assert.equal(state.current, V2)
    assert.equal(state.previous, V1)
    const update = state.history.at(-1)
    assert.equal(update.action, "update")
    assert.equal(update.from, V1)
    assert.equal(update.to, V2)
    assert.match(path.basename(update.backup), /^opencode-own\.2\.0\.18-own\.1\.\d{8}-\d{6}-\d{3}\.db$/)
    assert.equal(path.dirname(update.backup), path.join(box.home, "backup"))
    assert.equal(readFileSync(update.backup, "utf8"), "v1 data\n")
    assert.equal(readFileSync(`${update.backup}-wal`, "utf8"), "v1 wal\n")

    // Rollback asks like the update does, then switches back and restarts the old build.
    const rollbackRefused = await box.run(["rollback", "--no-prompt"])
    assert.equal(rollbackRefused.code, 4, rollbackRefused.stderr)
    assert.equal(pointerTarget(box.home), box.app(V2))
    service.state.sessions = 0
    const rollback = await box.run(["rollback", "--no-prompt"])
    assert.equal(rollback.code, 0, rollback.stderr)
    assert.match(rollback.stdout, /rolled back to 2\.0\.18-own\.1/)
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(box.state().current, V1)
    assert.equal(box.state().previous, V2)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V1))
    assert.match(box.fakeLog(), new RegExp(`${V2}: service stop[\\s\\S]*${V1}: service start`))
    assert.equal(box.db(), "v1 data\n", "the database is kept unless --restore-db")

    // Forward again (rollback toggles), v2 writes, then back with the database of the last switch v1 -> v2 restored.
    box.db("v1 data\nwritten by v1 after the rollback\n")
    const forward = await box.run(["rollback", "--no-prompt"])
    assert.equal(forward.code, 0, forward.stderr)
    assert.equal(pointerTarget(box.home), box.app(V2))
    box.db("v1 data\nwritten by v1 after the rollback\nmigrated and written by v2\n")
    rmSync(`${box.env.OWN_FAKE_DB}-wal`)
    const restore = await box.run(["rollback", "--no-prompt", "--restore-db"])
    assert.equal(restore.code, 0, restore.stderr)
    assert.match(restore.stdout, /session database restored from/)
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(box.db(), "v1 data\nwritten by v1 after the rollback\n", "--restore-db drops what v2 wrote")
    assert.equal(
      readFileSync(`${box.env.OWN_FAKE_DB}-wal`, "utf8"),
      "v1 wal\n",
      "and brings the -wal of the backup back",
    )
    // What v2 wrote is itself backed up before the restore.
    const safety = box.state().history.at(-1).backup
    assert.equal(
      readFileSync(safety, "utf8"),
      "v1 data\nwritten by v1 after the rollback\nmigrated and written by v2\n",
    )

    // A third version: the one before the previous is removed, current and previous stay.
    const third = await box.run(["install", "--from", box.payload(V3), "--no-prompt"])
    assert.equal(third.code, 0, third.stderr)
    assert.deepEqual(readdirSync(box.app()).sort(), [V1, V3, "current.json"].sort())
    assert.equal(box.state().previous, V1)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V3))
  },
)

test(
  "a failed start after the switch rolls back the pointer, the plugin entries, the folder and the database",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    const before = readFileSync(path.join(box.home, "install.json"), "utf8")
    const pointerBefore = readFileSync(box.app("current.json"), "utf8")
    const configBefore = readFileSync(configFile(box), "utf8")
    box.db("v1 data\n")
    const service = await fakeService(t, box)
    const failed = await box.run(["install", "--from", box.payload(V2), "--no-prompt"], { OWN_FAKE_FAIL_START: V2 })
    assert.equal(failed.code, 1, failed.stderr)
    assert.match(
      failed.stderr,
      /install 2\.0\.18-own\.2 failed: opencode service start failed .*\(rolled back to 2\.0\.18-own\.1\)/,
    )
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(readFileSync(box.app("current.json"), "utf8"), pointerBefore, "the pointer as it was")
    assert.equal(readFileSync(configFile(box), "utf8"), configBefore, "the plugin entries as they were")
    assert.deepEqual(readdirSync(box.app()).sort(), [V1, "current.json"].sort(), "no new version folder and no leftovers")
    assert.equal(box.db(), "v1 data\n", "what the new build wrote is gone")
    assert.equal(readFileSync(path.join(box.home, "install.json"), "utf8"), before)
    assert.ok(service.running(), "the previous version runs again")
    assert.match(box.fakeLog(), new RegExp(`${V2}: service start[\\s\\S]*${V1}: service start`))
    assert.match(readFileSync(path.join(box.home, "install.log"), "utf8"), /failed \(exit 1\)/)
  },
)

test("a damaged or foreign payload is refused before anything changes", { skip: !windows }, async (t) => {
  const box = sandbox(t)
  const payload = box.payload(V1)
  appendFileSync(path.join(payload, "app", "web", "assets", "app.js"), "// tampered")
  const damaged = await box.run(["install", "--from", payload, "--no-prompt"])
  assert.equal(damaged.code, 1)
  assert.match(damaged.stderr, /web\/ does not match manifest\.json/)
  assert.equal(pointerTarget(box.home), undefined)
  assert.equal(existsSync(path.join(box.home, "bin")), false)
  assert.deepEqual(pathEntries(box.userPath()), ["C:\\Windows\\system32", "%USERPROFILE%\\tools"])
  // The installer shows no console: the refusal is in install.log from the first step on.
  assert.match(
    readFileSync(path.join(box.home, "install.log"), "utf8"),
    /==== own install --from .* \(launcher [\d.]+,[\s\S]*failed \(exit 1\): the payload .* is incomplete or damaged/,
  )

  const upstream = box.payload(V1)
  const manifest = JSON.parse(readFileSync(path.join(upstream, "app", "manifest.json"), "utf8"))
  writeFileSync(path.join(upstream, "app", "manifest.json"), JSON.stringify({ ...manifest, version: "2.0.18" }))
  const foreign = await box.run(["install", "--from", upstream, "--no-prompt"])
  assert.equal(foreign.code, 1)
  assert.match(foreign.stderr, /not an own release/)

  const missing = await box.run(["install", "--no-prompt"])
  assert.equal(missing.code, 64)
  assert.match(missing.stderr, /needs --from/)
  const gone = await box.run(["install", "--from", path.join(box.root, "no-such-payload"), "--no-prompt"])
  assert.equal(gone.code, 64)
  assert.match(readFileSync(path.join(box.home, "install.log"), "utf8"), /failed \(exit 64\): --from: .*no-such-payload does not exist/)
})

test(
  "inside a packaged app that virtualizes %LOCALAPPDATA%, install and the installer's preflight refuse (exit 5)",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    // The seam stands in for the probe folder landing in %LOCALAPPDATA%\Packages\<family>\LocalCache (the real check
    // runs under OWN_REAL_LOCALAPPDATA=1 below).
    const inside = { OWN_TEST_VIRTUALIZED_FAMILY: "Claude_pzs8sxrjxfjjc" }
    const refused = await box.run(["install", "--from", box.payload(V1), "--no-prompt"], inside)
    assert.equal(refused.code, 5, refused.stderr)
    assert.match(refused.stderr, /inside the packaged app Claude_pzs8sxrjxfjjc, which redirects new files/)
    assert.match(refused.stderr, /Run the installer from Explorer/)
    assert.equal(existsSync(box.home), false, "not even install.log: it would land in the private copy")
    const preflight = await box.run(["install", "--preflight", "--version", V1], inside)
    assert.equal(preflight.code, 5, preflight.stderr)
    const status = JSON.parse((await box.run(["status", "--json"], inside)).stdout)
    assert.equal(status.virtualized, "Claude_pzs8sxrjxfjjc")
    // --allow-virtualized (tests inside such an app) goes on.
    const allowed = await box.run(["install", "--from", box.payload(V1), "--no-prompt", "--allow-virtualized"], inside)
    assert.equal(allowed.code, 0, allowed.stderr)
    assert.equal(pointerTarget(box.home), box.app(V1))
    // A temp root is never virtualized: the probe itself finds nothing there.
    assert.equal(JSON.parse((await box.run(["status", "--json"])).stdout).virtualized, null)
  },
)

test(
  "uninstall keeps the user data; --remove-data removes only own's files and never follows a junction",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    const put = (file, content = "x") => {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    const data = {
      accounts: path.join(box.home, "accounts.json"),
      vault: path.join(box.home, "vault", "acc_1.dpapi"),
      ledger: path.join(box.home, "ledger", "usage-2026-09.jsonl"),
      backup: path.join(box.home, "backup", "opencode-own.2.0.18-own.0.20260101-000000-000.db"),
      bridge: path.join(box.env.XDG_CONFIG_HOME, "opencode", "service-own.json"),
      db: box.env.OWN_FAKE_DB,
    }
    const upstream = {
      config: path.join(box.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
      db: path.join(box.env.XDG_DATA_HOME, "opencode", "opencode.db"),
      outside: path.join(box.root, "outside", "keep.txt"),
    }
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    for (const file of [...Object.values(data), ...Object.values(upstream), `${data.db}-wal`]) put(file)

    // Sessions running: refused before anything is removed (the uninstaller asks first, then passes --force).
    const service = await fakeService(t, box, { sessions: 1 })
    const check = await box.run(["uninstall", "--check"])
    assert.equal(check.code, 4)
    const refused = await box.run(["uninstall", "--no-prompt"])
    assert.equal(refused.code, 4, refused.stderr)
    assert.ok(existsSync(box.app(V1, "opencode.exe")))
    assert.equal(pointerTarget(box.home), box.app(V1))

    const kept = await box.run(["uninstall", "--no-prompt", "--force"])
    assert.equal(kept.code, 0, kept.stderr)
    assert.match(kept.stdout, /user data kept/)
    assert.equal(service.running(), false)
    assert.equal(existsSync(box.app()), false)
    assert.equal(existsSync(path.join(box.home, "bin")), false)
    assert.equal(existsSync(path.join(box.home, "install.json")), false)
    assert.deepEqual(pathEntries(box.userPath()), ["C:\\Windows\\system32", "%USERPROFILE%\\tools"])
    for (const file of [...Object.values(data), `${data.db}-wal`, ...Object.values(upstream)])
      assert.ok(existsSync(file), file)
    assert.ok(existsSync(path.join(box.env.OWN_CONFIG_DIR, "opencode.jsonc")))

    // Installed again over the kept data, then everything of own's goes.
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    mkdirSync(path.join(box.home, "thirdparty"), { recursive: true })
    spawnSync(
      "cmd.exe",
      ["/d", "/c", "mklink", "/J", path.join(box.home, "thirdparty", "link"), path.dirname(upstream.outside)],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    )
    assert.equal(junctionTarget(path.join(box.home, "thirdparty", "link")), path.dirname(upstream.outside))
    const removed = await box.run(["uninstall", "--no-prompt", "--remove-data"])
    assert.equal(removed.code, 0, removed.stderr)
    assert.match(removed.stdout, /removed its data/)
    assert.equal(existsSync(box.home), false)
    assert.equal(existsSync(box.env.OWN_CONFIG_DIR), false)
    for (const file of [data.bridge, data.db, `${data.db}-wal`]) assert.equal(existsSync(file), false, file)
    for (const file of Object.values(upstream)) assert.ok(existsSync(file), `${file} is not own's`)
    assert.deepEqual(pathEntries(box.userPath()), ["C:\\Windows\\system32", "%USERPROFILE%\\tools"])
  },
)

test(
  "uninstall run through bin\\own.cmd removes own.cmd after the batch file has exited",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    const cmdFile = path.join(box.home, "bin", "own.cmd")
    const result = await new Promise((resolve) => {
      const base = { ...process.env }
      delete base.OWN_OPENCODE_EXE
      const child = spawn("cmd.exe", ["/d", "/c", cmdFile, "uninstall", "--no-prompt"], {
        env: { ...base, ...box.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      child.stdin.end()
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /uninstalled own-open-code/)
    // cmd.exe did not have to look for a deleted batch file (its message would be the last stderr line).
    assert.match(result.stderr.trim().split(/\r?\n/).at(-1), /^own: /)
    for (let i = 0; i < 40 && existsSync(cmdFile); i++) await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(existsSync(cmdFile), false)
    assert.equal(existsSync(path.join(box.home, "bin")), false)
  },
)

test(
  "an update that brings a new bundle adds its entry after the one before it; an entry the user removed stays removed",
  { skip: !windows },
  async (t) => {
    const before = PLUGINS.filter((name) => name !== "own-computer-use")
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1, { plugins: before }), "--no-prompt"])).code, 0)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V1, before))
    const update = await box.run(["install", "--from", box.payload(V2), "--no-prompt"])
    assert.equal(update.code, 0, update.stderr)
    assert.match(update.stderr, /added own-computer-use to the plugins of .*\(new in 2\.0\.18-own\.2\)/)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V2))
    // The user takes it out; the next update (whose predecessor had the bundle) leaves the config without it.
    const removed = JSON.parse(readFileSync(configFile(box), "utf8"))
    removed.plugins = removed.plugins.filter((entry) => !entry.endsWith("/own-computer-use"))
    writeFileSync(configFile(box), JSON.stringify(removed, null, 2))
    const next = await box.run(["install", "--from", box.payload(V3), "--no-prompt"])
    assert.equal(next.code, 0, next.stderr)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V3, before))
    assert.match(next.stderr, /does not load own-computer-use; run 'own config init --force'/)

    // Next to an object entry nothing is inserted (the file stays valid); the missing bundle is only reported.
    const other = sandbox(t)
    assert.equal((await other.run(["install", "--from", other.payload(V1, { plugins: before }), "--no-prompt"])).code, 0)
    const home = other.home.replaceAll("\\", "/")
    const custom = [
      "{",
      '  "plugins": [',
      `    "${home}/app/${V1}/plugins/own-accounts",`,
      `    "${home}/app/${V1}/plugins/own-remote",`,
      `    "${home}/app/${V1}/plugins/own-team",`,
      `    { "package": "${home}/app/${V1}/plugins/own-telemetry", "options": {} }`,
      "  ]",
      "}",
      "",
    ].join("\n")
    writeFileSync(configFile(other), custom)
    const kept = await other.run(["install", "--from", other.payload(V2), "--no-prompt"])
    assert.equal(kept.code, 0, kept.stderr)
    assert.equal(readFileSync(configFile(other), "utf8"), custom.replaceAll(`/app/${V1}/`, `/app/${V2}/`))
    assert.match(kept.stderr, /does not load (claude-auth, )?own-computer-use/)
  },
)

test(
  "a fresh install writes own-team third; an update that brings it inserts it after own-remote, before the Claude slot",
  { skip: !windows },
  async (t) => {
    const fresh = sandbox(t)
    assert.equal((await fresh.run(["install", "--from", fresh.payload(V1), "--no-prompt"])).code, 0)
    assert.deepEqual(configPlugins(fresh), ownEntries(fresh.home, V1))
    assert.deepEqual(
      configPlugins(fresh).map((entry) => entry.split("/").at(-1)),
      [
        "own-accounts",
        "own-remote",
        "own-team",
        "claude-auth",
        "own-telemetry",
        "own-computer-use",
        "own-import",
        "own-harness",
      ],
    )
    const shown = await fresh.run(["status", "--json"])
    assert.equal(JSON.parse(shown.stdout).plugins["own.team"], true)

    // An install from before own-team (2.0.18-own.5, so before own-import, own-harness and the bundled Claude plugin
    // too) whose config has the former Claude install's line where own.accounts put it. The update brings them all:
    // own-team goes after own-remote, the Claude line points at the bundle in place, own-import after
    // own-computer-use, own-harness after own-import.
    const box = sandbox(t)
    const without = BEFORE_CLAUDE.filter((name) => name !== "own-team" && name !== "own-import" && name !== "own-harness")
    assert.equal((await box.run(["install", "--from", box.payload(V1, { plugins: without }), "--no-prompt"])).code, 0)
    const home = box.home.replaceAll("\\", "/")
    const config = [
      "{",
      '  "update": "disable",',
      '  "plugins": [',
      `    "${home}/app/${V1}/plugins/own-accounts",`,
      `    "${home}/app/${V1}/plugins/own-remote",`,
      `    "${home}/thirdparty/claude-auth",`,
      `    "${home}/app/${V1}/plugins/own-telemetry",`,
      `    "${home}/app/${V1}/plugins/own-computer-use"`,
      "  ]",
      "}",
      "",
    ].join("\r\n")
    writeFileSync(configFile(box), config)
    const update = await box.run(["install", "--from", box.payload(V2), "--no-prompt"])
    assert.equal(update.code, 0, update.stderr)
    assert.match(update.stderr, /added own-team, own-import, own-harness to the plugins of .*\(new in 2\.0\.18-own\.2\)/)
    assert.doesNotMatch(update.stderr, /does not load own-/)
    const expected = config
      .replaceAll(`/app/${V1}/`, `/app/${V2}/`)
      .replace(`"${home}/thirdparty/claude-auth"`, `"${home}/app/${V2}/plugins/claude-auth"`)
      .replace(
        `    "${home}/app/${V2}/plugins/own-remote",\r\n`,
        `    "${home}/app/${V2}/plugins/own-remote",\r\n    "${home}/app/${V2}/plugins/own-team",\r\n`,
      )
      .replace(
        `    "${home}/app/${V2}/plugins/own-computer-use"\r\n`,
        `    "${home}/app/${V2}/plugins/own-computer-use",\r\n    "${home}/app/${V2}/plugins/own-import",\r\n` +
          `    "${home}/app/${V2}/plugins/own-harness"\r\n`,
      )
    assert.equal(readFileSync(configFile(box), "utf8"), expected)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V2))
    const status = JSON.parse((await box.run(["status", "--json"])).stdout)
    assert.deepEqual(Object.keys(status.plugins), [
      "own.accounts",
      "own.remote",
      "own.team",
      "claude-auth",
      "own.telemetry",
      "own.computer-use",
      "own.import",
      "own.harness",
      "own.omo",
      "own.creator",
    ])
    assert.equal(status.plugins["own.team"], true)

    // Rollback to the version without the bundles leaves their entries (reported, not removed), and the next update
    // keeps them once: never a second own-team, claude-auth, own-import or own-harness line.
    const rollback = await box.run(["rollback", "--no-prompt"])
    assert.equal(rollback.code, 0, rollback.stderr)
    assert.match(
      rollback.stderr,
      /loads own-team, claude-auth, own-import, own-harness, which 2\.0\.18-own\.1 does not have; left as it was/,
    )
    const again = await box.run(["install", "--from", box.payload(V3), "--no-prompt"])
    assert.equal(again.code, 0, again.stderr)
    assert.deepEqual(
      configPlugins(box).map((entry) => entry.split("/").at(-1)),
      [
        "own-accounts",
        "own-remote",
        "own-team",
        "claude-auth",
        "own-telemetry",
        "own-computer-use",
        "own-import",
        "own-harness",
      ],
    )
  },
)

test(
  "own-import and own-harness are the last lines: an update inserts them after own-computer-use; a removed line stays out, other lines stay",
  { skip: !windows },
  async (t) => {
    const fresh = sandbox(t)
    assert.equal((await fresh.run(["install", "--from", fresh.payload(V1), "--no-prompt"])).code, 0)
    assert.deepEqual(configPlugins(fresh).slice(-2), ownEntries(fresh.home, V1, ["own-import", "own-harness"]))
    const freshStatus = JSON.parse((await fresh.run(["status", "--json"])).stdout)
    assert.equal(freshStatus.plugins["own.import"], true)
    assert.equal(freshStatus.plugins["own.harness"], true)

    // An install from before own-import (so before own-harness too) whose config the user edited: a comment, the
    // Claude slot and a plugin of their own after computer use (LF line ends). Only the own entries move and one line
    // per new bundle is added (09 §5.1; 10 H0: own-harness after own-import).
    const box = sandbox(t)
    const without = PLUGINS.filter((name) => name !== "own-import" && name !== "own-harness")
    assert.equal((await box.run(["install", "--from", box.payload(V1, { plugins: without }), "--no-prompt"])).code, 0)
    const home = box.home.replaceAll("\\", "/")
    // The Claude line is still the former install's (a config an older launcher kept): it moves to the bundle.
    const config = [
      "{",
      "  // my plugins",
      '  "plugins": [',
      `    "${home}/app/${V1}/plugins/own-accounts",`,
      `    "${home}/app/${V1}/plugins/own-remote",`,
      `    "${home}/app/${V1}/plugins/own-team",`,
      `    "${home}/thirdparty/claude-auth",`,
      `    "${home}/app/${V1}/plugins/own-telemetry",`,
      `    "${home}/app/${V1}/plugins/own-computer-use",`,
      '    "C:/tools/my-plugin"',
      "  ],",
      '  "update": "disable"',
      "}",
      "",
    ].join("\n")
    writeFileSync(configFile(box), config)
    const update = await box.run(["install", "--from", box.payload(V2), "--no-prompt"])
    assert.equal(update.code, 0, update.stderr)
    assert.match(update.stderr, /added own-import, own-harness to the plugins of .*\(new in 2\.0\.18-own\.2\)/)
    assert.doesNotMatch(update.stderr, /does not load own-/)
    const updated = config
      .replaceAll(`/app/${V1}/`, `/app/${V2}/`)
      .replace(`"${home}/thirdparty/claude-auth"`, `"${home}/app/${V2}/plugins/claude-auth"`)
      .replace(
        `    "${home}/app/${V2}/plugins/own-computer-use",\n`,
        `    "${home}/app/${V2}/plugins/own-computer-use",\n    "${home}/app/${V2}/plugins/own-import",\n` +
          `    "${home}/app/${V2}/plugins/own-harness",\n`,
      )
    assert.equal(readFileSync(configFile(box), "utf8"), updated)
    assert.equal(JSON.parse((await box.run(["status", "--json"])).stdout).plugins["own.import"], true)

    // Rollback to the version without them: their lines stay as they were, with the existing warning.
    const rollback = await box.run(["rollback", "--no-prompt"])
    assert.equal(rollback.code, 0, rollback.stderr)
    assert.match(rollback.stderr, /loads own-import, own-harness, which 2\.0\.18-own\.1 does not have; left as it was/)
    assert.equal(
      readFileSync(configFile(box), "utf8"),
      updated
        .replaceAll(`/app/${V2}/`, `/app/${V1}/`)
        .replace(`/app/${V1}/plugins/own-import"`, `/app/${V2}/plugins/own-import"`)
        .replace(`/app/${V1}/plugins/own-harness"`, `/app/${V2}/plugins/own-harness"`),
    )
    assert.equal(JSON.parse((await box.run(["status", "--json"])).stdout).plugins["own.import"], false)

    // The next update keeps those lines once (never a second own-import or own-harness line).
    const again = await box.run(["install", "--from", box.payload(V3), "--no-prompt"])
    assert.equal(again.code, 0, again.stderr)
    assert.doesNotMatch(again.stderr, /added own-/)
    assert.equal(readFileSync(configFile(box), "utf8"), updated.replaceAll(`/app/${V2}/`, `/app/${V3}/`))

    // The user takes it out; an update whose predecessor had the bundle does not add it back and only warns.
    const removed = updated
      .replaceAll(`/app/${V2}/`, `/app/${V3}/`)
      .replace(`    "${home}/app/${V3}/plugins/own-import",\n`, "")
    writeFileSync(configFile(box), removed)
    const next = await box.run(["install", "--from", box.payload(V4), "--no-prompt"])
    assert.equal(next.code, 0, next.stderr)
    assert.doesNotMatch(next.stderr, /added own-import/)
    assert.match(next.stderr, /does not load own-import; run 'own config init --force'/)
    assert.equal(readFileSync(configFile(box), "utf8"), removed.replaceAll(`/app/${V3}/`, `/app/${V4}/`))
  },
)

test(
  "own-omo comes after own-harness: a fresh install lists it last, an update that brings it inserts it there (15)",
  { skip: !windows },
  async (t) => {
    const fresh = sandbox(t)
    assert.equal((await fresh.run(["install", "--from", fresh.payload(V1, { plugins: WITH_OMO }), "--no-prompt"])).code, 0)
    assert.deepEqual(configPlugins(fresh), ownEntries(fresh.home, V1, WITH_OMO))
    assert.equal(JSON.parse((await fresh.run(["status", "--json"])).stdout).plugins["own.omo"], true)

    // An install from before own-omo: the update that brings it adds its line after own-harness, once.
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    assert.equal(JSON.parse((await box.run(["status", "--json"])).stdout).plugins["own.omo"], false)
    const update = await box.run(["install", "--from", box.payload(V2, { plugins: WITH_OMO }), "--no-prompt"])
    assert.equal(update.code, 0, update.stderr)
    assert.match(update.stderr, /added own-omo to the plugins of .*\(new in 2\.0\.18-own\.2\)/)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V2, WITH_OMO))
    const again = await box.run(["install", "--from", box.payload(V3, { plugins: WITH_OMO }), "--no-prompt"])
    assert.equal(again.code, 0, again.stderr)
    assert.doesNotMatch(again.stderr, /added own-/)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V3, WITH_OMO))
  },
)

test(
  "own-creator comes after own-omo: a fresh install lists it last, an update that brings it inserts it there (17)",
  { skip: !windows },
  async (t) => {
    const fresh = sandbox(t)
    assert.equal(
      (await fresh.run(["install", "--from", fresh.payload(V1, { plugins: WITH_CREATOR }), "--no-prompt"])).code,
      0,
    )
    assert.deepEqual(configPlugins(fresh), ownEntries(fresh.home, V1, WITH_CREATOR))
    assert.equal(JSON.parse((await fresh.run(["status", "--json"])).stdout).plugins["own.creator"], true)

    // An install from before own-creator: the update that brings it adds its line after own-omo, once.
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1, { plugins: WITH_OMO }), "--no-prompt"])).code, 0)
    assert.equal(JSON.parse((await box.run(["status", "--json"])).stdout).plugins["own.creator"], false)
    const update = await box.run(["install", "--from", box.payload(V2, { plugins: WITH_CREATOR }), "--no-prompt"])
    assert.equal(update.code, 0, update.stderr)
    assert.match(update.stderr, /added own-creator to the plugins of .*\(new in 2\.0\.18-own\.2\)/)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V2, WITH_CREATOR))
    const again = await box.run(["install", "--from", box.payload(V3, { plugins: WITH_CREATOR }), "--no-prompt"])
    assert.equal(again.code, 0, again.stderr)
    assert.doesNotMatch(again.stderr, /added own-/)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V3, WITH_CREATOR))
  },
)

test(
  "own-creator's code plugin entries stay at the end of plugins: an update syncs around them, config init --force keeps them (17)",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1, { plugins: WITH_CREATOR }), "--no-prompt"])).code, 0)
    const home = box.home.replaceAll("\\", "/")
    // What own-creator appends for an approved code plugin (17 sec. 12.4): its version folder and the shim's options.
    const entry = {
      package: `${home}/creator/ext/brief/v2`,
      options: { entry: "plugin.ts", version: 2, log: `${home}/creator/logs/brief.log`, crashes: `${home}/creator/run/crashes.jsonl`, hookMs: 2000 },
    }
    const plain = `${home}/creator/ext/other/v1`
    const config = JSON.parse(readFileSync(configFile(box), "utf8"))
    config.plugins.push(plain, entry)
    writeFileSync(configFile(box), `${JSON.stringify(config, null, 2)}
`)

    const update = await box.run(["install", "--from", box.payload(V2, { plugins: WITH_CREATOR }), "--no-prompt"])
    assert.equal(update.code, 0, update.stderr)
    assert.deepEqual(configPlugins(box), [...ownEntries(box.home, V2, WITH_CREATOR), plain, entry])

    const init = await box.run(["config", "init", "--force"])
    assert.equal(init.code, 0, init.stderr)
    assert.match(init.stderr + init.stdout, /kept 2 creator plugin entries at the end of plugins/)
    assert.deepEqual(configPlugins(box), [...ownEntries(box.home, V2, WITH_CREATOR), plain, entry])
  },
)

test(
  "the former Claude install: its config line points at the bundle, its files go after the update, its account list and login state stay",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1, { plugins: BEFORE_CLAUDE }), "--no-prompt"])).code, 0)
    const home = box.home.replaceAll("\\", "/")
    // What the in-app install of 2.0.24-own.3 and earlier left (fake files; no real package).
    const legacy = path.join(box.home, "thirdparty", "claude-auth")
    const file = (rel, text = "x") => {
      mkdirSync(path.dirname(path.join(legacy, rel)), { recursive: true })
      writeFileSync(path.join(legacy, rel), text)
    }
    file("node_modules/opencode-claude-auth-v2/dist/index.js", "// fake")
    file("node_modules/@aws-sdk/client/index.js", "// fake")
    file("node_modules/.package-lock.json", "{}")
    file("own-patch-original/dist/keychain.js", "// fake")
    for (const name of ["package.json", "package-lock.json", "server.js", "own-patch.json"]) file(name, "{}")
    file("claude-accounts.json", '{"version":1,"default":null,"accounts":[]}')
    file("claude-auth-state/claude-account-source.txt", "c:\\users\\someone\\.claude")
    file("claude-auth-state/claude-auth-refresh-0123456789abcdef.lock", "")
    file("my-notes.txt", "kept")
    const config = JSON.stringify(
      {
        plugins: [
          `${home}/app/${V1}/plugins/own-accounts`,
          `${home}/app/${V1}/plugins/own-remote`,
          `${home}/app/${V1}/plugins/own-team`,
          `${home}/thirdparty/claude-auth`,
          `${home}/app/${V1}/plugins/own-telemetry`,
        ],
      },
      null,
      2,
    )
    writeFileSync(configFile(box), config)
    // While the installed version is from before the bundle, nothing moves and nothing is removed.
    assert.equal((await box.run(["install", "--from", box.payload(V1, { plugins: BEFORE_CLAUDE }), "--no-prompt"])).code, 0)
    assert.ok(existsSync(path.join(legacy, "node_modules")))
    assert.equal(configPlugins(box)[3], `${home}/thirdparty/claude-auth`)

    const update = await box.run(["install", "--from", box.payload(V2), "--no-prompt"])
    assert.equal(update.code, 0, update.stderr)
    assert.equal(configPlugins(box)[3], `${home}/app/${V2}/plugins/claude-auth`)
    assert.doesNotMatch(update.stderr, /added claude-auth/)
    assert.match(update.stderr, /removed the former Claude plugin install from .*claude-auth \(node_modules, own-patch-original, package\.json, package-lock\.json, server\.js, own-patch\.json\)/)
    assert.deepEqual(readdirSync(legacy).sort(), ["claude-accounts.json", "claude-auth-state", "my-notes.txt"])
    assert.deepEqual(readdirSync(path.join(legacy, "claude-auth-state")).sort(), [
      "claude-account-source.txt",
      "claude-auth-refresh-0123456789abcdef.lock",
    ])

    // An install whose config never had the former line gets the bundle's line after own-team.
    const other = sandbox(t)
    assert.equal((await other.run(["install", "--from", other.payload(V1, { plugins: BEFORE_CLAUDE }), "--no-prompt"])).code, 0)
    assert.deepEqual(configPlugins(other), ownEntries(other.home, V1, BEFORE_CLAUDE))
    const added = await other.run(["install", "--from", other.payload(V2), "--no-prompt"])
    assert.equal(added.code, 0, added.stderr)
    assert.match(added.stderr, /added claude-auth to the plugins of .*\(new in 2\.0\.18-own\.2\)/)
    assert.deepEqual(configPlugins(other), ownEntries(other.home, V2))
  },
)

// ---------------------------------------------------------------- migration from launcher 0.3.0 (app\current junction)

/** mklink /J (a directory junction, no privilege needed); returns whether it exists afterwards. */
function makeJunction(link, target) {
  spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", link, target], { windowsHide: true, stdio: "ignore" })
  return junctionTarget(link) === path.resolve(target)
}

/**
 * What launcher 0.3.0 left: no pointer, app\current a junction, the config's own entries on app/current (here with a
 * BOM, comments, a user plugin, the Claude shim, an object entry with backslashes and a file:/// URL).
 */
function legacyConfig(box) {
  const home = box.home.replaceAll("\\", "/")
  const backslashed = box.home.replaceAll("\\", "\\\\")
  return [
    "\ufeff// my notes: the own bundles live under <OWN_HOME>/app/current/plugins/own-accounts",
    "{",
    '  "update": "disable",',
    '  "plugins": [',
    `    "${home}/app/current/plugins/own-accounts", // own.accounts`,
    `    { "package": "${backslashed}\\\\app\\\\current\\\\plugins\\\\own-remote", "options": { "logLevel": "debug" } },`,
    `    "${home}/thirdparty/claude-auth",`,
    '    /* "C:/elsewhere/app/current/plugins/own-telemetry", */',
    '    "C:/tools/my-plugin",',
    `    "file:///${home}/app/current/plugins/own-telemetry"`,
    "  ]",
    "}",
    "",
  ].join("\r\n")
}

test(
  "an older launcher's app\\current junction is read as a link, replaced by the pointer, and only the own entries move",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    // Back to the 0.3.0 layout.
    rmSync(box.app("current.json"))
    assert.ok(makeJunction(box.app("current"), box.app(V1)))
    const legacy = legacyConfig(box)
    writeFileSync(configFile(box), legacy)

    // Readers use the folder the link names, not the link.
    const status = await box.run(["status", "--json"])
    const shown = JSON.parse(status.stdout)
    assert.equal(shown.installed, V1)
    assert.equal(shown.app_source, "junction")
    assert.equal(shown.app, box.app(V1))
    assert.equal(shown.exe, box.app(V1, "opencode.exe"))

    const update = await box.run(["install", "--from", box.payload(V2), "--no-prompt", "--json"])
    assert.equal(update.code, 0, update.stderr)
    assert.equal(JSON.parse(update.stdout).action, "update")
    assert.equal(JSON.parse(update.stdout).previous, V1)
    assert.match(update.stderr, /removed the app\\current junction of the older launcher/)
    assert.equal(pointerTarget(box.home), box.app(V2))
    assert.equal(existsSync(box.app("current")), false, "the junction is gone")
    assert.ok(existsSync(box.app(V1, "opencode.exe")), "the version it named is kept for rollback")
    assert.deepEqual(readdirSync(box.app()).sort(), [V1, V2, "current.json"].sort())

    // Only the own entries changed (the former Claude install's line points at the bundle): the BOM, comments, the
    // user plugin and the options stay.
    const home = box.home.replaceAll("\\", "/")
    const expected = legacy
      .replace(`"${home}/app/current/plugins/own-accounts"`, `"${home}/app/${V2}/plugins/own-accounts"`)
      .replace(`"${home}/thirdparty/claude-auth"`, `"${home}/app/${V2}/plugins/claude-auth"`)
      .replace(
        `"${box.home.replaceAll("\\", "\\\\")}\\\\app\\\\current\\\\plugins\\\\own-remote"`,
        `"${home}/app/${V2}/plugins/own-remote"`,
      )
      .replace(`"file:///${home}/app/current/plugins/own-telemetry"`, `"file:///${home}/app/${V2}/plugins/own-telemetry"`)
    assert.notEqual(expected, legacy)
    assert.equal(readFileSync(configFile(box), "utf8"), expected)

    // Rollback returns to the version the junction named, without making a junction again.
    const rollback = await box.run(["rollback", "--no-prompt"])
    assert.equal(rollback.code, 0, rollback.stderr)
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(existsSync(box.app("current")), false)
    assert.match(readFileSync(configFile(box), "utf8"), new RegExp(`"${home}/app/${V1.replaceAll(".", "\\.")}/plugins/own-accounts"`))
  },
)

test(
  "the same version on an older launcher's junction is migrated in place (no copy), the service restarted on it",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    const payload = box.payload(V1)
    assert.equal((await box.run(["install", "--from", payload, "--no-prompt"])).code, 0)
    rmSync(box.app("current.json"))
    assert.ok(makeJunction(box.app("current"), box.app(V1)))
    const service = await fakeService(t, box)
    const again = await box.run(["install", "--from", payload, "--no-prompt", "--json"])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(JSON.parse(again.stdout).action, "migrate")
    assert.equal(JSON.parse(again.stdout).service, "restarted")
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(existsSync(box.app("current")), false)
    assert.ok(service.running())
    assert.match(box.fakeLog(), new RegExp(`${V1}: service stop[\\s\\S]*${V1}: service start`))
    assert.equal(box.state().history.at(-1).action, "migrate")
  },
)

test(
  "a junction that cannot be followed (its target is gone) never blocks: readers skip it, install and uninstall remove it",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    mkdirSync(box.app("gone"), { recursive: true })
    assert.ok(makeJunction(box.app("current"), box.app("gone")))
    rmSync(box.app("gone"), { recursive: true })
    assert.equal(existsSync(box.app("current", "manifest.json")), false, "the link cannot be traversed")
    mkdirSync(box.env.OWN_CONFIG_DIR, { recursive: true })
    writeFileSync(configFile(box), legacyConfig(box))

    const status = await box.run(["status", "--json"])
    assert.equal(status.code, 3)
    assert.equal(JSON.parse(status.stdout).installed, null)
    const start = await box.run(["start"])
    assert.equal(start.code, 1)
    assert.match(start.stderr, /not installed/)

    const install = await box.run(["install", "--from", box.payload(V1), "--no-prompt", "--json"])
    assert.equal(install.code, 0, install.stderr)
    assert.equal(JSON.parse(install.stdout).action, "install")
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(junctionTarget(box.app("current")), undefined, "the broken link is removed")
    assert.match(readFileSync(configFile(box), "utf8"), new RegExp(`/app/${V1.replaceAll(".", "\\.")}/plugins/own-accounts"`))
    assert.doesNotMatch(readFileSync(configFile(box), "utf8"), /"[^"]*\/app\/current\/plugins\/own-accounts"/)

    // A link left by hand is removed by uninstall (never followed: what it names stays).
    mkdirSync(path.join(box.root, "outside"), { recursive: true })
    writeFileSync(path.join(box.root, "outside", "keep.txt"), "x")
    assert.ok(makeJunction(box.app("current"), path.join(box.root, "outside")))
    const removed = await box.run(["uninstall", "--no-prompt"])
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(existsSync(box.app()), false)
    assert.ok(existsSync(path.join(box.root, "outside", "keep.txt")), "the junction was not followed")
  },
)

test(
  "a version before the pointer (2.0.18-own.2) gets its app\\current junction back on rollback; the next switch removes it",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    // Its plugins find own-vault.exe, templates and their own folder only through app\current.
    const old = await box.run(["install", "--from", box.payload(V1, { legacy: true }), "--no-prompt"])
    assert.equal(old.code, 0, old.stderr)
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(junctionTarget(box.app("current")), box.app(V1))
    assert.match(old.stderr, /2\.0\.18-own\.1 predates the version pointer/)
    // Nothing to migrate for it: the same installer again changes nothing.
    const again = await box.run(["install", "--from", box.payload(V1, { legacy: true }), "--no-prompt", "--json"])
    assert.equal(JSON.parse(again.stdout).action, "unchanged")

    assert.equal((await box.run(["install", "--from", box.payload(V2), "--no-prompt"])).code, 0)
    assert.equal(pointerTarget(box.home), box.app(V2))
    assert.equal(junctionTarget(box.app("current")), undefined, "a version that reads the pointer needs no junction")
    assert.ok(existsSync(box.app(V1, "manifest.json")), "the version the junction named is untouched")

    assert.equal((await box.run(["rollback", "--no-prompt"])).code, 0)
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.equal(junctionTarget(box.app("current")), box.app(V1))
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V1))
    assert.equal((await box.run(["rollback", "--no-prompt"])).code, 0)
    assert.equal(junctionTarget(box.app("current")), undefined)
    assert.deepEqual(configPlugins(box), ownEntries(box.home, V2))
  },
)

// ---------------------------------------------------------------- installer.nsh macros, driven for real

/** makensis from electron-builder's cache (the one that compiles the installer), or undefined. */
function findMakensis() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache")
  if (!existsSync(cache)) return undefined
  for (const entry of readdirSync(cache).filter((name) => name.startsWith("nsis-3"))) {
    for (const sub of readdirSync(path.join(cache, entry), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const exe = path.join(cache, entry, sub.name, "makensis.exe")
      if (existsSync(exe)) return exe
    }
  }
  return undefined
}
const makensis = windows ? findMakensis() : undefined
const repo = path.resolve(own, "..")

/**
 * A small NSIS program (not the installer) that runs installer.nsh's customInit + customInstall (mode install) or
 * customUnInit (mode uninit) exactly as electron-builder inserts them, with $INSTDIR in the sandbox. customUnInstall
 * is left out: it deletes the real app's HKCU toast keys. APP_INSTALLER_STORE_FILE names a file that does not exist.
 */
function compileHarness(box, payloadRoot, version, name = "harness") {
  const instdir = path.join(box.root, `${name}-instdir`)
  const script = path.join(box.root, `${name}.nsi`)
  const report = path.join(box.root, "uninit.txt")
  writeFileSync(
    script,
    [
      "Unicode true",
      'Name "own installer.nsh harness"',
      `OutFile "${path.join(box.root, `${name}.exe`)}"`,
      "RequestExecutionLevel user",
      "SilentInstall silent",
      `!define VERSION "${version}"`,
      `!define APP_INSTALLER_STORE_FILE "own-nsis-harness-${Math.random().toString(36).slice(2)}\\none.exe"`,
      "!include LogicLib.nsh",
      "!include FileFunc.nsh",
      "!macro _isUpdated _a _b _t _f",
      "  StrCmp '' '' `${_f}` `${_t}`",
      "!macroend",
      '!define isUpdated `"" isUpdated ""`',
      `!include "${path.join(repo, "packages", "own-desktop", "build", "installer.nsh")}"`,
      "Var mode",
      "Function .onInit",
      "  ${GetParameters} $0",
      '  ${GetOptions} $0 "--mode=" $mode',
      '  ${If} $mode == "install"',
      "    !insertmacro customInit",
      "  ${EndIf}",
      "FunctionEnd",
      "Section",
      `  StrCpy $INSTDIR "${instdir}"`,
      '  ${If} $mode == "install"',
      "    !insertmacro customInstall",
      "  ${Else}",
      "    !insertmacro customUnInit",
      `    FileOpen $1 "${report}" w`,
      '    FileWrite $1 "service=$ownUnService data=$ownUnData force=$ownUnForce launcher=$ownUnLauncher"',
      "    FileClose $1",
      "  ${EndIf}",
      "SectionEnd",
      "",
    ].join("\r\n"),
  )
  // -WX like electron-builder (warningsAsErrors): an unreferenced function or variable would fail the real build.
  const compiled = spawnSync(makensis, ["-V2", "-WX", "-INPUTCHARSET", "UTF8", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, OWN_DESKTOP_PAYLOAD: payloadRoot },
  })
  if (compiled.status !== 0) throw new Error(`makensis failed: ${compiled.stdout}\n${compiled.stderr}`)
  // Like electron-builder's extraction: the payload next to the shell in $INSTDIR\resources\own-payload.
  rmSync(instdir, { recursive: true, force: true })
  mkdirSync(path.join(instdir, "resources"), { recursive: true })
  cpSync(payloadRoot, path.join(instdir, "resources", "own-payload"), { recursive: true })
  // The installer's %TEMP% (its log, $PLUGINSDIR) inside the sandbox.
  const temp = path.join(box.root, "installer-temp")
  mkdirSync(temp, { recursive: true })
  return {
    instdir,
    report,
    /** %TEMP%\own-installer.log (UTF-16LE with BOM), or "". */
    log: () => {
      const file = path.join(temp, "own-installer.log")
      if (!existsSync(file)) return ""
      const bytes = readFileSync(file)
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "UTF-16LE BOM")
      return bytes.subarray(2).toString("utf16le")
    },
    run: (args, extra = {}) =>
      new Promise((resolve) => {
        const base = { ...process.env }
        delete base.OWN_OPENCODE_EXE
        const child = spawn(path.join(box.root, `${name}.exe`), args, {
          env: { ...base, ...box.env, TEMP: temp, TMP: temp, ...extra },
          windowsHide: true,
        })
        child.on("close", (code) => resolve(code))
      }),
  }
}

test(
  "installer.nsh: customInit asks via --preflight, customInstall installs from resources\\own-payload, customUnInit decides",
  { skip: !windows || !makensis },
  async (t) => {
    const box = sandbox(t)
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    const service = await fakeService(t, box, { sessions: 1 })
    const harness = compileHarness(box, box.payload(V2), V2)

    // Silent and sessions running: refused before anything changed (exit 4), the payload still in $INSTDIR.
    assert.equal(await harness.run(["/S", "--mode=install"]), 4)
    assert.equal(pointerTarget(box.home), box.app(V1))
    assert.ok(existsSync(path.join(harness.instdir, "resources", "own-payload", "app", "opencode.exe")))
    assert.match(harness.log(), /==== installer 2\.0\.18-own\.2 \(own-desktop, harness\.exe \/S --mode=install\)/)
    assert.match(harness.log(), /preflight: ".*powershell\.exe" -NoLogo .* install --preflight --version "2\.0\.18-own\.2"/)
    assert.match(harness.log(), /preflight: exit 4\r\n.*sessions are running and the update was declined/)

    // --own-force: customInstall runs the payload's launcher with --move --force; then upstream's grant runs.
    assert.equal(await harness.run(["/S", "--mode=install", "--own-force"]), 0)
    assert.equal(pointerTarget(box.home), box.app(V2))
    assert.equal(box.state().previous, V1)
    assert.equal(
      existsSync(path.join(harness.instdir, "resources", "own-payload", "app")),
      false,
      "the payload was moved",
    )
    assert.ok(existsSync(path.join(harness.instdir, "resources", "own-payload", "bin", "own.ps1")))
    assert.ok(service.running(), "restarted")
    const installLog = readFileSync(path.join(box.home, "install.log"), "utf8")
    assert.match(installLog, /own install 2\.0\.18-own\.2 from .*instdir\\resources\\own-payload/)
    // The installer's side of the run: the exact command and its exit code, in both logs.
    assert.match(
      harness.log(),
      /install: ".*powershell\.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*instdir\\resources\\own-payload\\bin\\own\.ps1" install --from ".*instdir\\resources\\own-payload" --move --no-prompt --force \(OWN_HOME .*\)\r\n\S+ \S+ install: exit 0\r\n/,
    )
    assert.match(installLog, /installer 2\.0\.18-own\.2: own\.ps1 install exited 0 \(details: %TEMP%\\own-installer\.log\)/)

    // Started inside a packaged app that virtualizes %LOCALAPPDATA%: told and ended in customInit, before extraction.
    const inside = compileHarness(box, box.payload(V3), V3, "inside")
    assert.equal(await inside.run(["/S", "--mode=install", "--own-force"], { OWN_TEST_VIRTUALIZED_FAMILY: "Claude_pzs8sxrjxfjjc" }), 5)
    assert.equal(pointerTarget(box.home), box.app(V2), "nothing switched")
    assert.ok(existsSync(path.join(inside.instdir, "resources", "own-payload", "app", "opencode.exe")), "payload untouched")
    assert.match(inside.log(), /preflight: exit 5\r\n.*refused: %LOCALAPPDATA% is virtualized for this process \(packaged app\); nothing changed, exit 5/)

    // A silent install whose service part fails ends with the launcher's exit code (the shell part is done).
    const broken = compileHarness(box, box.payload(V3), V3, "broken")
    appendFileSync(path.join(broken.instdir, "resources", "own-payload", "app", "web", "index.html"), "<!-- tampered -->")
    assert.equal(await broken.run(["/S", "--mode=install", "--own-force"]), 1)
    assert.equal(pointerTarget(box.home), box.app(V2), "nothing switched")
    assert.match(broken.log(), /install: exit 1\r\n.*silent install ends with exit 1/)
    assert.match(readFileSync(path.join(box.home, "install.log"), "utf8"), /installer 2\.0\.18-own\.3: own\.ps1 install exited 1/)

    // Uninstall decisions: silent = remove the service, keep the data; sessions → refused (4) unless --own-force.
    // Inside a virtualizing packaged app: told, nothing removed (5).
    assert.equal(await harness.run(["/S", "--mode=uninit"], { OWN_TEST_VIRTUALIZED_FAMILY: "Claude_pzs8sxrjxfjjc" }), 5)
    assert.equal(await harness.run(["/S", "--mode=uninit"]), 4)
    service.state.sessions = 0
    assert.equal(await harness.run(["/S", "--mode=uninit"]), 0)
    assert.equal(readFileSync(harness.report, "utf8").includes("service=1 data= force="), true)
    assert.equal(await harness.run(["/S", "--mode=uninit", "--own-remove-data", "--own-keep-service"]), 0)
    const decided = readFileSync(harness.report, "utf8")
    assert.match(decided, /service=0 data=--remove-data/)
    assert.match(decided, new RegExp(`launcher=${path.join(box.home, "bin", "own.ps1").replaceAll("\\", "\\\\")}`))
    // An update run of the old uninstaller (/KEEP_APP_DATA, as electron-builder passes it) decides nothing.
    assert.equal(await harness.run(["/S", "--mode=uninit", "/KEEP_APP_DATA", "--updated"]), 0)
    assert.match(readFileSync(harness.report, "utf8"), /service=0 data= force= launcher=$/)
  },
)

test("the payload's own launcher does the work when it differs from the running one", { skip: !windows }, async (t) => {
  const box = sandbox(t)
  const newer = readFileSync(launcherFile, "utf8").replace(
    /\$script:LauncherVersion = '[^']+'/,
    "$script:LauncherVersion = '9.9.9'",
  )
  const payload = box.payload(V1, { launcher: newer })
  const result = await box.run(["install", "--from", payload, "--no-prompt"])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /handing over to the payload's launcher/)
  assert.equal(box.state().launcher, "9.9.9")
  assert.equal(readFileSync(path.join(box.home, "bin", "own.ps1"), "utf8"), newer)
})

test(
  "started straight from a PowerShell 7 process (the installer's powershell.exe -File own.ps1), the hashes still work",
  { skip: !windows },
  async (t) => {
    const box = sandbox(t)
    // What a pwsh 7 window passes to its children: its own module folders ahead of Windows PowerShell's. 5.1's
    // auto-loading then takes 7's Microsoft.PowerShell.Utility, which 5.1 sees as this stand-in: 5.1's own manifest
    // (same name, GUID and commands) whose cmdlets come from the dll alone, without the script module that defines
    // 5.1's Get-FileHash.
    const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules")
    const utility = path.join("Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1")
    const modules = path.join(box.root, "pwsh7-modules")
    mkdirSync(path.dirname(path.join(modules, utility)), { recursive: true })
    const manifest = readFileSync(path.join(system, utility), "latin1")
      .replace(/# SIG # Begin[\s\S]*$/, "")
      .replace(/,\s*"Microsoft\.PowerShell\.Utility\.psm1"/, "")
    assert.doesNotMatch(manifest, /\.psm1/, "the stand-in has no script module")
    writeFileSync(path.join(modules, utility), manifest, "latin1")
    const pwsh7 = { PSModulePath: [modules, system].join(";") }

    // The payload check hashes files and trees.
    const damaged = box.payload(V1)
    appendFileSync(path.join(damaged, "app", "web", "assets", "app.js"), "// tampered")
    appendFileSync(path.join(damaged, "app", "own-vault.exe"), "tampered")
    const refused = await box.run(["install", "--from", damaged, "--no-prompt"], pwsh7)
    assert.equal(refused.code, 1, refused.stderr)
    assert.match(refused.stderr, /web\/ does not match manifest\.json/)
    assert.match(refused.stderr, /own-vault\.exe does not match manifest\.json/)
    assert.equal(pointerTarget(box.home), undefined)

    const installed = await box.run(["install", "--from", box.payload(V1), "--no-prompt"], pwsh7)
    assert.equal(installed.code, 0, installed.stderr)
    assert.equal(pointerTarget(box.home), box.app(V1))

    // The running launcher compares itself with the payload's and hands over; that one replaces bin\own.ps1.
    const newer = readFileSync(launcherFile, "utf8").replace(
      /\$script:LauncherVersion = '[^']+'/,
      "$script:LauncherVersion = '9.9.9'",
    )
    const updated = await box.run(["update", "--from", box.payload(V2, { launcher: newer }), "--no-prompt"], pwsh7)
    assert.equal(updated.code, 0, updated.stderr)
    assert.match(updated.stderr, /handing over to the payload's launcher/)
    assert.equal(pointerTarget(box.home), box.app(V2))
    assert.equal(readFileSync(path.join(box.home, "bin", "own.ps1"), "utf8"), newer)
  },
)

// ---------------------------------------------------------------- opt-in: OWN_HOME under %LOCALAPPDATA% (real paths)
//
// OWN_REAL_LOCALAPPDATA=1 runs the lifecycle in %LOCALAPPDATA%\own-open-code-verify-<random> (never the real
// %LOCALAPPDATA%\own-open-code), where a junction's files could not be opened on the reporting PC (Windows 11 26200)
// although every temp-root test passed. With OWN_REAL_PAYLOADS="<older build>;<newer build>" (build-desktop.ps1
// outputs, e.g. own\.out\build\2.0.18-own.2;own\.out\verify\2.0.18-own.3) it also installs the older release with its
// own launcher (0.3.0: the junction), updates to the newer one with the new launcher, and runs the real opencode.exe
// service (own start, status, own.accounts health, rollback both ways, uninstall --remove-data); OWN_REAL_SHELL=1
// adds the development shell on that install (packages/own-desktop/scripts/verify-installed.ts).
//
// Where that failure came from: a process started from inside a packaged app with file system write virtualization
// (the Claude desktop app: its terminal, its agents) writes new files under %LOCALAPPDATA% into
// %LOCALAPPDATA%\Packages\<family>\LocalCache\Local, and a junction made there names a path that exists nowhere. Run
// from such a process, these tests first check that install/update refuse (exit 5, nothing created), then go on with
// --allow-virtualized; run from a normal process (Explorer, a terminal not started from that app), nothing is
// virtualized and the lifecycle runs as a user's would.

const realLocal = windows && process.env.OWN_REAL_LOCALAPPDATA === "1"
const realPayloads = (process.env.OWN_REAL_PAYLOADS ?? "")
  .split(";")
  .filter(Boolean)
  .map((dir) => path.resolve(dir))

/** The packaged app whose LocalCache receives this process's new folders under %LOCALAPPDATA%, or undefined. */
function virtualizedFamily() {
  const local = process.env.LOCALAPPDATA
  if (!local) return undefined
  const name = `.own-test-probe-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  mkdirSync(path.join(local, name))
  try {
    const packages = path.join(local, "Packages")
    if (!existsSync(packages)) return undefined
    return readdirSync(packages).find((family) => existsSync(path.join(packages, family, "LocalCache", "Local", name)))
  } finally {
    rmSync(path.join(local, name), { recursive: true, force: true })
  }
}
const virtualized = realLocal ? virtualizedFamily() : undefined

/** Whether this process (node, like Electron, Bun and cmd.exe; not PowerShell) can open a file (through a junction). */
function openable(file) {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

test(
  "OWN_REAL_LOCALAPPDATA: under %LOCALAPPDATA% an older launcher's junction is migrated and nothing is read through it",
  { skip: !realLocal },
  async (t) => {
    const box = sandbox(t, localAppData())
    assert.ok(box.root.toLowerCase().startsWith(String(process.env.LOCALAPPDATA).toLowerCase()))
    assert.ok(!box.root.toLowerCase().startsWith(tmpdir().toLowerCase()), "not under %TEMP%")
    t.diagnostic(`this process's writes under %LOCALAPPDATA%: ${virtualized ? `virtualized into the package ${virtualized}` : "real (not virtualized)"}`)
    if (virtualized) {
      // Inside a virtualizing packaged app: install refuses before creating anything (exit 5).
      const refused = await box.run(["install", "--from", box.payload(V1), "--no-prompt"])
      assert.equal(refused.code, 5, refused.stderr)
      assert.match(refused.stderr, new RegExp(`inside the packaged app ${virtualized}`))
      assert.equal(existsSync(box.home), false, "nothing created")
      const status = JSON.parse((await box.run(["status", "--json"])).stdout)
      assert.equal(status.virtualized, virtualized)
    }
    // Inside such an app: the rest of the lifecycle with the override (everything then lives in its private copy).
    if (virtualized) box.env.OWN_ALLOW_VIRTUALIZED = "1"
    assert.equal((await box.run(["install", "--from", box.payload(V1), "--no-prompt"])).code, 0)
    rmSync(box.app("current.json"))
    assert.ok(makeJunction(box.app("current"), box.app(V1)))
    writeFileSync(configFile(box), legacyConfig(box))
    const through = openable(box.app("current", "manifest.json"))
    t.diagnostic(`a file opened through the junction under %LOCALAPPDATA%: ${through ? "works on this PC" : "FAILS on this PC (the reported bug)"}`)

    const legacy = JSON.parse((await box.run(["status", "--json"])).stdout)
    assert.equal(legacy.installed, V1)
    assert.equal(legacy.app, box.app(V1), "the link's target, not the link")
    const service = await fakeService(t, box)
    const update = await box.run(["install", "--from", box.payload(V2), "--no-prompt", "--force", "--json"])
    assert.equal(update.code, 0, update.stderr)
    assert.equal(JSON.parse(update.stdout).service, "restarted")
    assert.equal(pointerTarget(box.home), box.app(V2))
    assert.equal(existsSync(box.app("current")), false)
    assert.match(readFileSync(configFile(box), "utf8"), new RegExp(`/app/${V2.replaceAll(".", "\\.")}/plugins/own-accounts"`))
    assert.match(box.fakeLog(), new RegExp(`${V1}: service stop[\\s\\S]*${V2}: service start`))
    assert.ok(service.running())
    const status = JSON.parse((await box.run(["status", "--json"])).stdout)
    assert.equal(status.state, "running")
    assert.equal(status.app_source, "pointer")
    assert.equal(status.exe, box.app(V2, "opencode.exe"))
    assert.ok(openable(status.exe), "the exe the launcher starts opens directly")

    const rollback = await box.run(["rollback", "--no-prompt", "--force"])
    assert.equal(rollback.code, 0, rollback.stderr)
    assert.equal(pointerTarget(box.home), box.app(V1))
    const removed = await box.run(["uninstall", "--remove-data", "--no-prompt", "--force"])
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(existsSync(box.home), false)
  },
)

test(
  "OWN_REAL_LOCALAPPDATA + OWN_REAL_PAYLOADS: the real service across update (0.3.0 junction → pointer), rollback, uninstall",
  { skip: !realLocal || realPayloads.length !== 2, timeout: 20 * 60_000 },
  async (t) => {
    const [older, newer] = realPayloads
    const versionOf = (dir) =>
      JSON.parse(readFileSync(path.join(dir, "app", "manifest.json"), "utf8").replace(/^\uFEFF/, "")).version
    const [OLD, NEW] = [versionOf(older), versionOf(newer)]
    const root = localAppData()
    const own = path.join(root, "own")
    const env = {
      OWN_HOME: own,
      OWN_CONFIG_DIR: path.join(root, "config"),
      XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
      XDG_STATE_HOME: path.join(root, "xdg", "state"),
      XDG_DATA_HOME: path.join(root, "xdg", "data"),
      XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    }
    for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
    env.OWN_USER_PATH_FILE = path.join(root, "user-path.txt")
    // Inside a virtualizing packaged app the lifecycle runs in its private copy (the refusal itself is checked above).
    if (virtualized) env.OWN_ALLOW_VIRTUALIZED = "1"
    writeFileSync(env.OWN_USER_PATH_FILE, "C:\\Windows\\system32")
    const port = await new Promise((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const value = server.address().port
        server.close(() => resolve(value))
      })
    })
    // A free port: the real own channel port (and a service the user may run) stays untouched.
    writeFileSync(
      path.join(env.OWN_CONFIG_DIR, "service-own.json"),
      JSON.stringify({ hostname: "127.0.0.1", port, password: createHash("sha256").update(root).digest("base64url") }),
    )
    // Every opencode.exe under the root is ours: stopped at the end whatever happened, then the root goes.
    const killOurs = () =>
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.ExecutablePath -like '${root}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        ],
        { windowsHide: true },
      )
    t.after(async () => {
      killOurs()
      // A service that was just killed may hold its files for a moment.
      for (let attempt = 0; attempt < 10 && existsSync(root); attempt++) {
        spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", root], { windowsHide: true })
        if (existsSync(root)) await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    })
    const cmd = (file, args) =>
      new Promise((resolve) => {
        const base = { ...process.env }
        delete base.OWN_OPENCODE_EXE
        delete base.OWN_LAUNCHER_HANDOVER
        const child = spawn("cmd.exe", ["/d", "/c", file, ...args], {
          env: { ...base, ...env },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
        child.stdin.end()
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
        child.on("close", (code) => resolve({ code, stdout, stderr }))
      })
    const ownCmd = (...args) => cmd(path.join(own, "bin", "own.cmd"), args)
    const registration = () =>
      JSON.parse(readFileSync(path.join(env.XDG_STATE_HOME, "opencode", "service-own.json"), "utf8"))
    const processPath = (pid) =>
      spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`], {
        encoding: "utf8",
        windowsHide: true,
      }).stdout.trim()
    const rpc = async (plugin, method) => {
      const { url, password } = registration()
      const control = path.join(own, "control")
      const response = await fetch(
        `${url}/api/rpc/${plugin}/${method}?location%5Bdirectory%5D=${encodeURIComponent(control)}`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`opencode:${password}`)}`,
            "content-type": "application/json",
            "x-opencode-directory": encodeURIComponent(control),
          },
          body: JSON.stringify({ input: {} }),
        },
      )
      return (await response.json()).output
    }
    const runningOn = async (expected, { plugins = true } = {}) => {
      const status = JSON.parse((await ownCmd("status", "--json")).stdout)
      assert.equal(status.state, "running", JSON.stringify(status))
      assert.equal(status.version, expected)
      assert.equal(status.installed, expected)
      assert.equal(status.app_source, "pointer")
      const exe = path.join(own, "app", expected, "opencode.exe")
      // Inside a virtualizing packaged app the process reports the private copy of the same path.
      const copies = [exe, ...(virtualized ? [path.join(process.env.LOCALAPPDATA, "Packages", virtualized, "LocalCache", "Local", path.relative(process.env.LOCALAPPDATA, exe))] : [])]
      const running = processPath(registration().pid).toLowerCase()
      assert.ok(copies.some((copy) => copy.toLowerCase() === running), `the service runs the version folder's exe: ${running}`)
      const config = readFileSync(path.join(env.OWN_CONFIG_DIR, "opencode.jsonc"), "utf8")
      assert.ok(config.includes(`/app/${expected}/plugins/own-accounts`) && !config.includes("/app/current/"), config)
      if (!plugins) {
        const health = await rpc("own.accounts", "health").catch((error) => ({ error: String(error) }))
        t.diagnostic(`service ${expected} (a version before the pointer, inside the container): health ${JSON.stringify(health).slice(0, 200)}`)
        return
      }
      const health = await rpc("own.accounts", "health")
      assert.equal(health.guard, "ok", JSON.stringify(health).slice(0, 400))
      assert.equal(health.version, expected)
      const trust = await rpc("own.accounts", "plugin.trust.list")
      assert.ok(trust.locations.every((item) => item.status === "ok"), JSON.stringify(trust.locations))
      t.diagnostic(`service ${expected} pid ${registration().pid} runs ${exe}: health guard ok, allowlist ok`)
    }

    t.diagnostic(`this process's writes under %LOCALAPPDATA%: ${virtualized ? `virtualized into the package ${virtualized}` : "real (not virtualized)"}`)
    // 1. The older release with its own launcher (0.3.0): the app\current junction under %LOCALAPPDATA%.
    const first = await cmd(path.join(older, "bin", "own.cmd"), ["install", "--from", older, "--no-prompt", "--no-path"])
    assert.equal(first.code, 0, first.stderr)
    const legacy = junctionTarget(path.join(own, "app", "current"))
    const through = openable(path.join(own, "app", "current", "manifest.json"))
    t.diagnostic(`older launcher: app\\current ${legacy ? `junction -> ${legacy}` : "not a junction"}; a file through it ${through ? "opens" : "does NOT open (the bug)"}`)
    if (legacy) {
      const broken = await cmd(path.join(own, "bin", "own.cmd"), ["start"])
      t.diagnostic(`older launcher 'own start' through the junction: exit ${broken.code} ${broken.stderr.trim().split(/\r?\n/).at(-1) ?? ""}`)
      killOurs()
    }

    // 2. Update with the new launcher: pointer, junction removed, plugin entries on the new version.
    const update = await cmd(path.join(newer, "bin", "own.cmd"), [
      "update",
      "--from",
      newer,
      "--no-prompt",
      "--no-path",
      "--force",
      "--json",
    ])
    assert.equal(update.code, 0, update.stderr)
    assert.equal(JSON.parse(update.stdout).previous, OLD)
    assert.equal(pointerTarget(own), path.join(own, "app", NEW))
    assert.equal(junctionTarget(path.join(own, "app", "current")), undefined)
    assert.equal(existsSync(path.join(own, "app", "current")), false)

    // 3. The real service on the new version.
    const start = await ownCmd("start")
    assert.equal(start.code, 0, start.stderr)
    await runningOn(NEW)

    // 4. The development shell on this install (renderer from the pointer, follows rollback twice).
    if (process.env.OWN_REAL_SHELL === "1") {
      // bun may be a .cmd shim (npm global install): through cmd.exe.
      const shell = spawnSync(
        "cmd.exe",
        ["/d", "/c", "bun", path.join(repo, "packages", "own-desktop", "scripts", "verify-installed.ts"), "--root", root, "--rollback"],
        { encoding: "utf8", windowsHide: true, timeout: 10 * 60_000, env: { ...process.env, ...env } },
      )
      t.diagnostic(`shell: ${shell.stdout.trim().split(/\r?\n/).at(-1)}`)
      assert.equal(shell.status, 0, `${shell.stdout}\n${shell.stderr}`)
      await runningOn(NEW)
    }

    // 5. Rollback and forward again: the service restarted on each version, the entries follow.
    const back = await ownCmd("rollback", "--no-prompt", "--force")
    assert.equal(back.code, 0, back.stderr)
    // The older release reads app\current: own rollback gives it that junction again (Sync-CompatJunction).
    assert.equal(junctionTarget(path.join(own, "app", "current")), path.join(own, "app", OLD))
    await runningOn(OLD, { plugins: !virtualized })
    const forward = await ownCmd("rollback", "--no-prompt", "--force")
    assert.equal(forward.code, 0, forward.stderr)
    await runningOn(NEW)
    assert.equal(junctionTarget(path.join(own, "app", "current")), undefined, "gone again for the newer release")

    // 6. Uninstall with the data: the service stops, nothing of own's stays.
    const pid = registration().pid
    const removed = await ownCmd("uninstall", "--remove-data", "--no-prompt", "--force")
    assert.equal(removed.code, 0, removed.stderr)
    // Run through own.cmd, the last of OWN_HOME (bin\own.cmd) goes a moment after the batch file has exited.
    for (let i = 0; i < 40 && existsSync(own); i++) await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(existsSync(own), false)
    assert.equal(processPath(pid), "", "the service is gone")
  },
)

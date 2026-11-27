// Release smoke of the installed layout (FORK §8.2 step 7): the build's `app\` and `bin\` are installed into a temp
// OWN_HOME by the build's own launcher (`bin\own.cmd install --from <build> --no-path`, what the desktop installer
// runs, USER-GUIDE 2.6), the service is started with the launcher, and over HTTP:
//   - the layout: app\<ver>\ named by app\current.json, no app\current junction, the config's plugin entries on
//     app\<ver>\plugins in activation order [own-accounts, own-remote, own-team, claude-auth, own-telemetry,
//     own-computer-use, own-import, own-harness, own-omo, own-creator] (06 §2.6, 09 §5.1, 10 H0, 02 §8.2, 15 §1, 17),
//     the nine own bundles each stamped
//     with the manifest's build id, and the bundled claude-auth's `own-bundle.json` naming that build id with every
//     file's hash matching
//   - the SSH remote artifacts in app\<ver>\remote (04 §5.2, 06 §4.13, §8.11.14; packages/own-remote/script/bundle.ts
//     inspectRemote): every target archive matches its hash and carries own-accounts, own-remote, own-team,
//     own-telemetry and own-harness (10 §6.1), never own-computer-use or own-import (PC-only), and no third-party
//     claude-auth marker in any file; tools git-lfs per target lies beside the archives (not inside) with the
//     manifest's hash and size and its license
//   - own.accounts `health`: guard ok, release version, build id = manifest (the plugin bundles inside opencode.exe)
//   - own.team `health` (06 TG1): guard ok, build id = manifest, the output passes the RPC schema (no
//     `rpc.invalid_output`); own.computer `status` reports the same build id
//   - own.import `health` (09 §5.2): the release version and the output schema, its scan Worker not started. It is the
//     only own.import method called: `sources.list` and `sessions.*` would scan this PC's Codex and Claude Code
//     stores, which a release check never reads
//   - the Location allowlist lets the own bundles of app\<ver>\plugins through (`plugin.trust.list`: no
//     `blocked_by_plugin`)
//   - the bundled Claude plugin (02 §8.2, always on, no consent): own.accounts sees it loaded in order, patched,
//     verified and loaded with its multi-account exports, `bundle.buildId` = manifest; `health` names its version and
//     has no `claude_auth_*` warning; no Claude account is connected in the temp OWN_HOME (nothing is sent), own.team
//     keeps answering and no Location is blocked
//   - an OpenAI-compatible API-key account against a local fake (the real own-vault.exe, DPAPI, in the temp OWN_HOME)
//   - a session prompt answered through that account; the fake saw that key; the ledger has the step
//   - creator C2 in the installed binary (17 §11.4): a creator-mode turn stages a generated MCP server through the
//     service's executable as Bun (`bun check`, its test in the QuickJS sandbox, the smoke call through the sandbox host
//     with the bundled engine and .wasm) and the extension becomes active
//   - own.remote `hosts.list` / `gateway.status`
//   - own.accounts `diagnostics.selfTest` carries `agentModels` (07 §5.4) and passes the output schema (no
//     `rpc.invalid_output`)
//   - own.accounts `codexModels.get` (07 §4.5, CA) passes the output schema and shows this build's Codex version with
//     no release read: the temp OWN_HOME has no ChatGPT account, so the service never asks registry.npmjs.org
//   - own.accounts `worktree.inspect` (06 §10.4 #5) on a temp repository the server knows as a project: a linked
//     worktree with a nested linked worktree is reported; the main worktree and a folder outside the project's
//     worktree table are refused (`not_found`)
//   - the web fallback: `own pair` link → session cookie → own-web's index (P-001)
//   - remote access: `gateway.json` on, `own restart` wakes the gateway (05 §13.4), it listens on 127.0.0.1 only,
//     serves the device page, answers 401 without a device, and LAN addresses of this PC get no connection
//   - the fake key in plaintext nowhere under the temp root; real user paths untouched; no process left: neither the
//     service's opencode.exe nor any other process whose command line names the temp root (P1-14a)
//   - the Smart App Control canary (P1-15): no Microsoft-Windows-CodeIntegrity/Operational event since the start names a
//     file under the temp root. Detection only: a hit fails the run with the list; nothing is retried, allowed or changed
//   - the Windows ARM64 client-only installer, when the build has desktop-client-arm64 (build-desktop-client.ps1,
//     own/reports/win-arm64-2026-11-06.md): static checks only on this x64 PC (lib/client-build.ts: layout, ARM64 PE
//     machine of the shell and its natives, the client page and switch in app.asar, no payload, the installer's archive)
// Nothing is installed for the user: OWN_HOME, OWN_CONFIG_DIR and XDG_* point into the temp root, the service and the
// gateway get free loopback ports. Fake key only. Prints a JSON report as the last line; exit 1 on a failed check.
//
//   bun own/scripts/release-smoke.ts [--out own/.out/build/<version>] [--keep]
import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { startFakeOpenAIChat } from "../../packages/own-accounts/test/e2e-kit/fakes/openai-chat"
import { hashSecret } from "../../packages/own-accounts/test/e2e-kit/fakes/shared"
import { Plugin } from "../../packages/own-protocol/src/plugin"
import { OwnHarness } from "../../packages/own-protocol/src/rpc-harness"
import { inspectRemote, REMOTE_PLUGINS } from "../../packages/own-remote/script/bundle"
import { clientFolder, inspectClientBuild } from "./lib/client-build"

const REPO = path.resolve(import.meta.dir, "..", "..")
/**
 * The release's plugins in activation order (06 §2.6, 09 §5.1, 10 H0: own-harness after the others; 15 §1: own-omo
 * after own-harness; 17: own-creator last; 02 §8.2: the bundled claude-auth after own-team, before own-telemetry;
 * packages/own-remote/script/bundle.ts DESKTOP_PLUGINS).
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
  "own-omo",
  "own-creator",
]
/** The own bundles (one `index.js` each, stamped with the build id); claude-auth carries `own-bundle.json` instead. */
const OWN_BUNDLES = PLUGINS.filter((name) => name !== "claude-auth")
/** A C2 extension (17 §11.3): one server, its tools in another file, a test of its own and a smoke call. */
const CREATOR_SERVER = {
  format: "own.ext/1",
  id: "release-words",
  title: "Release words",
  kind: "mcp",
  items: [
    {
      type: "mcp.server",
      name: "words",
      files: {
        "tools.ts": [
          `import type { ServerDefinition } from "./own-mcp"`,
          ``,
          `export const definition: ServerDefinition = {`,
          `  name: "words",`,
          `  tools: {`,
          `    count_words: {`,
          `      description: "Counts the words of a text.",`,
          `      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },`,
          `      run: (args) => \`words: \${String(args.text).split(" ").filter(Boolean).length}\`,`,
          `    },`,
          `  },`,
          `}`,
          ``,
        ].join("\n"),
        "server.ts": `import { serve } from "./own-mcp"\nimport { definition } from "./tools"\n\nserve(definition)\n`,
        "tools.test.ts": [
          `import { expect, test, callTool } from "./own-mcp"`,
          `import { definition } from "./tools"`,
          ``,
          `test("counts words", async () => {`,
          `  const result = await callTool(definition, "count_words", { text: "a b c" })`,
          `  expect(JSON.stringify(result)).toContain("words: 3")`,
          `})`,
          ``,
        ].join("\n"),
      },
      smoke: [{ tool: "count_words", arguments: { text: "one two" }, expect: "words: 2" }],
    },
  ],
}
const args = parseArgs({ options: { out: { type: "string" }, keep: { type: "boolean", default: false } } }).values
const build = path.resolve(args.out ?? newestBuild())
const manifest = JSON.parse(fs.readFileSync(path.join(build, "app", "manifest.json"), "utf8").replace(/^﻿/, "")) as {
  version: string
  build_id: string
}
const version = manifest.version

const report: Record<string, unknown> = { build, version, build_id: manifest.build_id }
const checks: Record<string, boolean> = {}
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks[name] = ok
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 300)}`}`)
}

function newestBuild() {
  const root = path.join(REPO, "own", ".out", "build")
  const dirs = fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, "app", "manifest.json")))
    .map((name) => ({ name, at: fs.statSync(path.join(root, name, "app", "manifest.json")).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  if (!dirs[0]) throw new Error(`no build with app\\manifest.json under ${root} (build-desktop.ps1 first)`)
  return path.join(root, dirs[0].name)
}

/**
 * The objects a Windows PowerShell script outputs, as an array, or the tail of its error. They come back as UTF-8 JSON
 * on the raw standard output, so localized event text survives the console code page. PSModulePath is left out:
 * Windows PowerShell started from a PowerShell 7 session inherits 7's module path and cannot load some of its own
 * modules, and without the variable it uses its default path.
 */
function powershell<T>(script: string) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        `$rows = @(& { ${script} })`,
        "$bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $rows -Compress))",
        "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH")),
    },
  )
  if (result.status === 0) return { rows: JSON.parse(result.stdout) as T[], error: undefined }
  return { rows: undefined, error: `${result.error?.message ?? ""} ${result.stderr ?? ""}`.trim().slice(-400) }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })

// The ARM64 client is never run here: its checks read the files only.
const clientDir = clientFolder(build, "arm64")
if (fs.existsSync(clientDir))
  for (const item of inspectClientBuild({ dir: clientDir, version, arch: "arm64" }).checks) check(item.name, item.ok, item.detail)

// The Code Integrity canary reads the events from here on.
const startedAt = Date.now()
const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-release-smoke-"))
// The root's unique folder name finds it in process command lines and Code Integrity messages: those name files by
// device path (\Device\HarddiskVolumeN\…), and TEMP may be an 8.3 short path, so the drive path itself may be absent.
const tag = path.basename(root)
const own = path.join(root, "own")
const env: Record<string, string> = {
  OWN_HOME: own,
  OWN_CONFIG_DIR: path.join(root, "config"),
  XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
  XDG_STATE_HOME: path.join(root, "xdg", "state"),
  XDG_DATA_HOME: path.join(root, "xdg", "data"),
  XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
}
for (const dir of Object.values(env)) fs.mkdirSync(dir, { recursive: true })
const workspace = path.join(root, "project")
fs.mkdirSync(workspace, { recursive: true })
fs.writeFileSync(path.join(workspace, "README.md"), "# release smoke\n")
const real = [
  path.join(process.env.LOCALAPPDATA ?? "", "own-open-code"),
  path.join(os.homedir(), ".config", "own-open-code"),
  path.join(os.homedir(), ".config", "opencode", "service-own.json"),
  path.join(os.homedir(), ".local", "state", "opencode", "service-own.json"),
  path.join(os.homedir(), ".local", "share", "opencode", "opencode-own.db"),
]
const realBefore = real.map((file) => fs.existsSync(file))

fs.writeFileSync(
  path.join(env.OWN_CONFIG_DIR!, "service-own.json"),
  JSON.stringify({ hostname: "127.0.0.1", port: await freePort(), password: randomBytes(24).toString("base64url") }),
)
// The payload's launcher installs it into the temp OWN_HOME (a copy: the build output stays; no PATH change).
const installed = spawnSync(
  "cmd",
  ["/c", path.join(build, "bin", "own.cmd"), "install", "--from", build, "--no-path", "--no-prompt", "--json"],
  { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true },
)
check("own install from the build", installed.status === 0, installed.status === 0 ? JSON.parse(installed.stdout).action : installed.stderr.slice(-400))
const pointer = JSON.parse(fs.readFileSync(path.join(own, "app", "current.json"), "utf8")) as { version: string }
check("app\\current.json names the version, no app\\current junction", pointer.version === version && !fs.existsSync(path.join(own, "app", "current")), pointer)
const ownCmd = (...command: string[]) => {
  const result = spawnSync("cmd", ["/c", path.join(own, "bin", "own.cmd"), ...command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  })
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

const KEY = `sk-fake-release-smoke-${randomBytes(6).toString("hex")}`
const fake = startFakeOpenAIChat({ models: ["fake-model"] })
let started = false
try {
  const versionOut = ownCmd("version")
  check("launcher version", versionOut.code === 0 && versionOut.stdout.includes(`opencode ${version}`), versionOut.stdout.split(/\r?\n/))
  const config = JSON.parse(ownCmd("config", "print").stdout) as { plugins: string[] }
  check(
    `config plugins ${PLUGINS.join(", ")} of app\\<ver>\\plugins`,
    config.plugins.map((item) => item.split("/").at(-1)).join(",") === PLUGINS.join(",") &&
      config.plugins.every((item) => item.includes(`/app/${version}/plugins/`)),
    config.plugins,
  )
  const configFile = path.join(env.OWN_CONFIG_DIR!, "opencode.jsonc")
  const written = fs.readFileSync(configFile, "utf8")
  check("opencode.jsonc loads the version folder's bundles", written.includes(`/app/${version}/plugins/own-accounts`) && !written.includes("/app/current/"))
  // FORK §8.2 step 3: every bundle carries the one build id of the release as a string literal.
  const bundles = path.join(own, "app", version, "plugins")
  const installedPlugins = fs.readdirSync(bundles).sort()
  const unstamped = OWN_BUNDLES.filter((name) => {
    const file = path.join(bundles, name, "index.js")
    return !fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes(JSON.stringify(manifest.build_id))
  })
  check(
    `app\\<ver>\\plugins holds the ${PLUGINS.length} plugins, the own bundles with the manifest's build id`,
    installedPlugins.join(",") === [...PLUGINS].sort().join(",") && unstamped.length === 0,
    { installed: installedPlugins, unstamped },
  )
  // 02 §8.2: the bundled claude-auth's record names this release's build id and every file's sha256.
  const claudeDir = path.join(bundles, "claude-auth")
  const claudeRecord = JSON.parse(fs.readFileSync(path.join(claudeDir, "own-bundle.json"), "utf8")) as {
    package: string
    version: string
    integrity: string
    buildId: string | null
    files: Record<string, string>
  }
  const claudeFiles = Object.entries(claudeRecord.files)
  const changed = claudeFiles.flatMap(([file, sha]) => {
    const full = path.join(claudeDir, ...file.split("/"))
    return fs.existsSync(full) && createHash("sha256").update(fs.readFileSync(full)).digest("hex") === sha ? [] : [file]
  })
  report.claudeBundle = { version: claudeRecord.version, buildId: claudeRecord.buildId, files: claudeFiles.length }
  check(
    "app\\<ver>\\plugins\\claude-auth: own-bundle.json names the manifest's build id, every file matches its hash",
    claudeRecord.package === Plugin.CLAUDE_AUTH_PACKAGE &&
      claudeRecord.buildId === manifest.build_id &&
      claudeRecord.files[`node_modules/${Plugin.CLAUDE_AUTH_PACKAGE}/dist/index.js`] !== undefined &&
      changed.length === 0,
    { record: report.claudeBundle, changed },
  )
  // SSH remote artifacts (04 §5.2, 06 §4.13): own-team joins the remote plugins, git-lfs ships per target beside them,
  // and own-telemetry runs fourth for the Claude slot this PC relays (04 §8.11.14). own-import reads this PC's stores
  // only (09 §7.1: a remote own.import is I3), so no archive carries it, and claude-auth never leaves this PC.
  // own-harness runs on hosts too, as on this PC (10 §6.1), then own-omo with its runtime, license and notices
  // (15 §1; inspectRemote names an own-omo without them), and own-creator last with own's WebAssembly engine for a
  // host's C2 sandbox (17 §10; inspectRemote names an own-creator without it).
  const remote = inspectRemote(path.join(own, "app", version, "remote"))
  report.remote = remote
  check(
    `app\\<ver>\\remote: every target carries ${REMOTE_PLUGINS.join(", ")}, never own-computer-use or own-import`,
    Object.keys(remote.plugins).length > 0 &&
      remote.problems.plugins.length === 0 &&
      Object.values(remote.plugins).every(
        (names) =>
          !names.includes("own-import") &&
          names.includes("own-harness") &&
          names.includes("own-omo") &&
          names.includes("own-creator"),
      ),
    remote.problems.plugins.length === 0 ? remote.plugins : remote.problems.plugins,
  )
  check(
    "app\\<ver>\\remote: no third-party claude-auth marker (billing header, salt) in any target archive",
    Object.keys(remote.plugins).length > 0 && remote.problems.markers.length === 0,
    remote.problems.markers,
  )
  check(
    "app\\<ver>\\remote: tools git-lfs per target (file, sha256, size, license), not inside the archive",
    remote.lfs !== undefined && remote.problems.lfs.length === 0,
    remote.problems.lfs.length === 0 ? remote.lfs : remote.problems.lfs,
  )
  const start = ownCmd("start")
  started = start.code === 0
  check("own start", started, start.stdout)
  if (!started) throw new Error(start.stderr)
  const registration = JSON.parse(fs.readFileSync(path.join(env.XDG_STATE_HOME!, "opencode", "service-own.json"), "utf8")) as {
    url: string
    password: string
  }
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
  /** One RPC as the server answered it: `body.output`, or a failure `body.type` such as `rpc.invalid_output`. */
  const callOnce = (plugin: string, method: string, input: unknown, directory: string) =>
    http("POST", `/api/rpc/${plugin}/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, { input }, directory)
  // Plugins load in the background since upstream v2.4.0 (#63814): a Location answers `rpc.unavailable` until its
  // plugin registered, so a call is asked again for up to 120 s, as own-web does at start.
  const call = async (plugin: string, method: string, input: unknown, directory = control) => {
    const deadline = Date.now() + 120_000
    const first = await callOnce(plugin, method, input, directory)
    if (first.body?.type !== "rpc.unavailable") return first
    while (Date.now() < deadline) {
      await Bun.sleep(250)
      const next = await callOnce(plugin, method, input, directory)
      if (next.body?.type !== "rpc.unavailable") return next
    }
    return first
  }
  const rpc = async (plugin: string, method: string, input: unknown, directory = control) => {
    const result = await call(plugin, method, input, directory)
    if (result.status !== 200) throw new Error(`${plugin}.${method}: ${result.status} ${JSON.stringify(result.body)}`)
    return result.body.output
  }

  const health = await rpc("own.accounts", "health", {})
  check("health guard ok, version, build id = manifest, vault ok", health.guard === "ok" && health.version === version && health.buildId === manifest.build_id && health.vault === "ok", {
    guard: health.guard,
    version: health.version,
    buildId: health.buildId,
    vault: health.vault,
  })
  // own.team (06 TG1): the bundled output passes the RPC output schema; guard and build id match the release.
  const teamHealth = async () => {
    const result = await call("own.team", "health", {})
    const output = result.body?.output
    return {
      ok:
        result.status === 200 &&
        output?.guard === "ok" &&
        output?.version === version &&
        output?.buildId === manifest.build_id &&
        Array.isArray(output?.features),
      detail:
        result.status === 200
          ? { guard: output.guard, buildId: output.buildId, git: output.git, leader: output.leader }
          : { status: result.status, type: result.body?.type },
    }
  }
  const team = await teamHealth()
  check(
    "own.team health round trip: guard ok, version, build id = manifest (no rpc.invalid_output)",
    team.ok,
    team.detail,
  )
  const computer = await call("own.computer", "status", {})
  check(
    "own.computer status: build id = manifest",
    computer.status === 200 &&
      computer.body?.output?.buildId === manifest.build_id &&
      computer.body?.output?.version === version,
    computer.status === 200
      ? { buildId: computer.body.output.buildId, available: computer.body.output.available }
      : { status: computer.status, type: computer.body?.type },
  )
  // own.import (09 §5.2): health answers from memory and starts no scan Worker. Never `sources.list` or `sessions.*`:
  // they would read this PC's Codex and Claude Code stores. Its build id is the bundle stamp checked above.
  const importer = await call("own.import", "health", {})
  const importHealth = importer.body?.output
  check(
    "own.import health: release version, features, scan Worker not started (no rpc.invalid_output)",
    importer.status === 200 &&
      importHealth?.version === version &&
      Array.isArray(importHealth?.features) &&
      importHealth?.workerReady === false,
    importer.status === 200 ? importHealth : { status: importer.status, type: importer.body?.type },
  )
  const added = await rpc("own.accounts", "accounts.add.key", {
    kind: "compat",
    label: "Release smoke",
    key: KEY,
    options: { baseURL: `${fake.url}/v1`, models: [{ id: "fake-model", contextLimit: 128000, cost: { input: 1, output: 2 } }] },
  })
  check("accounts.add.key (compat, vault)", added.account?.status === "ready" && added.test?.ok === true, added.account)

  const model = { providerID: added.account.providerID, id: "fake-model" }
  const deadline = Date.now() + 60_000
  for (;;) {
    const listed = ((await http("GET", "/api/model")).body?.data ?? []) as { providerID: string; id: string }[]
    if (listed.some((item) => item.providerID === model.providerID && item.id === model.id)) break
    if (Date.now() > deadline) throw new Error(`model ${model.providerID}/${model.id} never listed`)
    await Bun.sleep(500)
  }
  const created = await http("POST", "/api/session", { title: "release smoke", model, location: { directory: workspace } })
  const sessionID = created.body?.data?.id as string
  await http("POST", `/api/session/${sessionID}/prompt`, { text: "릴리스 스모크: 한 줄로 답해 줘" })
  await http("POST", `/api/experimental/session/${sessionID}/wait`)
  const messages = ((await http("GET", `/api/session/${sessionID}/message`)).body?.data ?? []) as {
    type: string
    content?: { type: string; text?: string }[]
    error?: unknown
  }[]
  const assistant = messages.filter((message) => message.type === "assistant")
  const answer = assistant.flatMap((message) => message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("")
  check("turn answered through the account", answer.length > 0 && assistant.every((message) => !message.error), {
    answer: answer.slice(0, 60),
    errors: assistant.map((message) => message.error).filter(Boolean),
  })
  const calls = fake.requests.filter((request) => request.path.startsWith("/v1/chat/completions"))
  check("provider saw the account key", calls.length > 0 && calls.every((request) => request.identity === hashSecret(KEY)), { calls: calls.length })
  const trustStates = async () =>
    (
      (await rpc("own.accounts", "plugin.trust.list", {})) as { locations: { directory: string; status: string }[] }
    ).locations.map((item) => item.status)
  const trust = await trustStates()
  check(
    "own bundles allowed: control and project Locations ok, blocked_by_plugin 0",
    trust.length >= 2 && trust.every((status) => status === "ok"),
    trust,
  )
  // The ledger writer appends after the step settles; give it a few seconds.
  const ledgerDir = path.join(own, "ledger")
  const usageLines = () =>
    (fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir) : [])
      .filter((name) => name.startsWith("usage-"))
      .flatMap((name) => fs.readFileSync(path.join(ledgerDir, name), "utf8").trim().split("\n"))
      .filter(Boolean).length
  const ledgerDeadline = Date.now() + 15_000
  while (usageLines() === 0 && Date.now() < ledgerDeadline) await Bun.sleep(250)
  check("ledger usage line", usageLines() >= 1, { lines: usageLines() })

  // Creator C2 in the installed binary (17 §11.2, §11.4): a creator-mode turn creates a generated MCP server, and own's
  // staging runs every step through the service's own executable as Bun (BUN_BE_BUN=1): `bun check` against the
  // bundled types, the extension's test inside own's QuickJS sandbox, and the smoke call through the sandbox host,
  // which loads the bundled engine and its .wasm from app\<ver>\plugins\own-creator\quickjs. No dependencies, so no
  // registry is asked. The approval card is answered once; the fake model plays creator mode.
  const creatorSession = (
    await http("POST", "/api/session", {
      title: "release smoke creator",
      model,
      agent: "creator",
      location: { directory: workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value("opencode") },
      permissions: [
        { action: "edit", resource: "**", effect: "ask" },
        { action: "shell", resource: "**", effect: "ask" },
      ],
    })
  ).body?.data?.id as string
  fake.enqueue(
    { type: "tool-call", name: "creator_manage", input: { action: "create", extension: CREATOR_SERVER } },
    { type: "text", text: "made" },
  )
  const creatorAsked: string[] = []
  const creatorTurn = { done: false }
  const answering = (async () => {
    while (!creatorTurn.done) {
      const pending = ((await http("GET", `/api/session/${creatorSession}/permission`)).body?.data ?? []) as {
        id: string
        action: string
      }[]
      for (const request of pending) {
        creatorAsked.push(request.action)
        await http("POST", `/api/session/${creatorSession}/permission/${request.id}/reply`, { decision: "once" })
      }
      await Bun.sleep(200)
    }
  })()
  const stagedAt = Date.now()
  await http("POST", `/api/session/${creatorSession}/prompt`, { text: "단어 세는 MCP 서버를 만들어 줘" })
  await http("POST", `/api/experimental/session/${creatorSession}/wait`).finally(() => (creatorTurn.done = true))
  await answering
  const creatorList = (await rpc("own.creator", "list", {}, workspace)) as {
    extensions: { id: string; status: string; kind: string; active: number }[]
  }
  const creatorLog = ((await rpc("own.creator", "log.get", { id: "release-words" }, workspace)) as { lines: string[] }).lines
  const stagedWords = creatorList.extensions.find((item) => item.id === "release-words")
  report.creatorC2 = { ms: Date.now() - stagedAt, asked: creatorAsked, extension: stagedWords, log: creatorLog.slice(-12) }
  check(
    "creator C2 in the installed binary: bun check, the extension's test and the smoke call through the QuickJS sandbox host",
    creatorAsked.includes("creator") &&
      stagedWords?.status === "active" &&
      stagedWords.kind === "mcp" &&
      stagedWords.active === 1 &&
      // `stage words: typecheck ok 131 ms`, `stage words: tests: counts words ok 603 ms`, `stage words: smoke ok …`
      ["typecheck", "tests", "smoke"].every((name) =>
        creatorLog.some((line) => line.includes(`stage words: ${name}`) && / ok \d+ ms/.test(line)),
      ) &&
      !creatorLog.some((line) => line.includes("stage words:") && line.includes(" failed ")),
    report.creatorC2,
  )
  const hosts = await rpc("own.remote", "hosts.list", {})
  const gatewayOff = await rpc("own.remote", "gateway.status", {})
  check("own.remote hosts.list and gateway.status", Array.isArray(hosts.hosts) && gatewayOff.state === "off", { gateway: gatewayOff.state })

  // diagnostics.selfTest with the hidden-agent model check (07 §5.4): the bundled output passes the RPC output schema.
  const selfTest = await call("own.accounts", "diagnostics.selfTest", {})
  const agentModels = selfTest.body?.output?.agentModels
  report.agentModels = agentModels
  check(
    "diagnostics.selfTest returns agentModels (no rpc.invalid_output)",
    selfTest.status === 200 && typeof agentModels?.ok === "boolean" && Array.isArray(agentModels?.removed),
    selfTest.status === 200 ? agentModels : { status: selfTest.status, type: selfTest.body?.type },
  )

  // Codex model list version (07 §4.5, CA): the bundled output passes the RPC output schema. The registry is read only
  // while a ChatGPT account exists, and this OWN_HOME has none, so no `latest` and the build's own version.
  const codexModels = await call("own.accounts", "codexModels.get", {})
  const codexView = codexModels.body?.output
  report.codexModels = codexView
  check(
    "codexModels.get answers this build's Codex version with no registry read (no ChatGPT account)",
    codexModels.status === 200 &&
      codexView?.autoVersion === true &&
      codexView?.version === codexView?.build &&
      codexView?.latest === undefined,
    codexModels.status === 200 ? codexView : { status: codexModels.status, type: codexModels.body?.type },
  )

  // worktree.inspect (06 §10.4 #5, TG13): a temp repository whose linked worktree holds another linked worktree in an
  // ignored `.worktrees/`. Identity and signing are passed per git command; no git config is written.
  const repo = path.join(root, "wt-repo")
  const linked = path.join(root, "wt-linked")
  const inner = path.join(linked, ".worktrees", "inner")
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n")
  const git = (...command: string[]) =>
    spawnSync("git", ["-c", "user.email=smoke@example.test", "-c", "user.name=smoke", "-c", "commit.gpgsign=false", ...command], {
      cwd: repo,
      env: { ...process.env, ...env },
      encoding: "utf8",
      windowsHide: true,
    }).status === 0
  const made =
    git("init", "-q", "-b", "main") &&
    git("add", ".gitignore") &&
    git("commit", "-q", "-m", "init") &&
    git("worktree", "add", "-q", "-b", "linked", linked, "main") &&
    git("worktree", "add", "-q", "--detach", inner, "main")
  // The method reads only folders in the project's worktree table: a session in the repository resolves the project
  // (no prompt, no provider call) and a refresh records the linked worktrees made with plain git.
  const repoSession = made
    ? await http("POST", "/api/session", { title: "worktree smoke", model, location: { directory: repo } }, repo)
    : undefined
  const projectID = repoSession?.body?.data?.projectID as string | undefined
  const refreshed = projectID ? await http("POST", "/api/worktree/refresh", { projectID }, repo) : undefined
  const inspect = (directory: string) =>
    projectID ? call("own.accounts", "worktree.inspect", { projectID, root: repo, directory }) : undefined
  const inspected = await inspect(linked)
  const refused = await inspect(repo)
  const outside = await inspect(root)
  const inspection = inspected?.body?.output
  const same = (a: string, b: string) => a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase()
  report.worktreeInspect = inspection
  check(
    "worktree.inspect round trip: nested worktree, no lock, complete scan; the main worktree and a folder outside the project's worktree table are refused",
    inspected?.status === 200 &&
      inspection.scan === "complete" &&
      inspection.lock === null &&
      inspection.ownLock === false &&
      inspection.nested.some(
        (item: { path: string; kind: string }) => item.kind === "worktree" && same(item.path, fs.realpathSync.native(inner)),
      ) &&
      refused?.body?.type === "not_found" &&
      outside?.body?.type === "not_found",
    {
      made,
      projectID,
      refreshed: refreshed?.status,
      status: inspected?.status,
      type: inspected?.body?.type,
      nested: inspection?.nested,
      refused: refused?.body?.type,
      outside: outside?.body?.type,
    },
  )

  // The bundled Claude plugin (02 §8.2, user decision 2026-10-18): always on next to own-team (06 §2.6, TG1), patched
  // at build time and verified by own.accounts; no consent and no Claude account in the temp OWN_HOME, so it sends
  // nothing. own-team stays before it, own-computer-use, own-import and own-harness after it.
  const order = (JSON.parse(fs.readFileSync(configFile, "utf8")) as { plugins: string[] }).plugins.map((item) =>
    item.split(/[\\/]/).at(-1),
  )
  const slot = (await rpc("own.accounts", "plugin.claudeAuth.status", {})) as {
    installed: boolean
    version: string | null
    order: string
    integrityOk: boolean | null
    acknowledged: unknown
    connection: unknown
    warnings: string[]
    patch: { state: string; sha256: string | null; loaded: boolean }
    bundle: { version: string; integrity: string; patchSha256: string; buildId: string | null } | null
  }
  const slotHealth = (await rpc("own.accounts", "health", {})) as {
    pluginVersions: { claudeAuth?: string | null }
    warnings: string[]
  }
  const teamWithSlot = await teamHealth()
  const trustWithSlot = await trustStates()
  check(
    "claude-auth bundled: loaded after own.team, patched and verified, build id = manifest, no consent, no account",
    slot.installed &&
      slot.order === "ok" &&
      slot.integrityOk === true &&
      slot.patch.state === "patched" &&
      slot.patch.loaded &&
      slot.bundle?.buildId === manifest.build_id &&
      slot.bundle?.version === claudeRecord.version &&
      slot.version === claudeRecord.version &&
      slot.acknowledged === null &&
      slot.connection === null &&
      slot.warnings.length === 0 &&
      order.join(",") === PLUGINS.join(",") &&
      teamWithSlot.ok &&
      trustWithSlot.every((status) => status === "ok"),
    { slot, plugins: order, team: teamWithSlot.detail, trust: trustWithSlot },
  )
  check(
    "health names the bundled claude-auth's version, no claude_auth_* warning",
    slotHealth.pluginVersions.claudeAuth === claudeRecord.version &&
      !slotHealth.warnings.some((warning) => warning.startsWith("claude_auth_")),
    { pluginVersions: slotHealth.pluginVersions, warnings: slotHealth.warnings },
  )

  // Web fallback (P-001): the launcher's pairing link sets the session cookie and serves own-web.
  const link = ownCmd("pair").stdout.split(/\r?\n/).find((line) => line.includes("/auth/connect/"))!
  const pairing = await fetch(link, { headers: { accept: "text/html" }, redirect: "manual" })
  const cookie = pairing.headers.get("set-cookie")?.split(";")[0]
  const page = cookie ? await fetch(new URL("/", registration.url), { headers: { cookie, accept: "text/html" } }) : undefined
  const html = page ? await page.text() : ""
  check("web fallback: pairing cookie, own-web index", !!cookie && pairing.status >= 300 && pairing.status < 400 && html.includes("<title>own-open-code</title>"), {
    status: pairing.status,
    cookie: cookie?.split("=")[0],
  })

  // Remote access: gateway.json on, own restart wakes it (05 §13.4 2).
  const gatewayPort = await freePort()
  fs.writeFileSync(
    path.join(own, "gateway.json"),
    JSON.stringify({ version: 1, enabled: true, bind: "127.0.0.1", port: gatewayPort, publicOrigin: null, updatedAt: 0 }),
  )
  // The restart's time and whole output also go to the report (RH-50: own.9's first run failed here unexplained; the
  // wake answers once the control Location has loaded every plugin, the launcher waits up to 300 s for it).
  const restarted = Date.now()
  const restart = ownCmd("restart", "--force")
  report.restart = {
    ms: Date.now() - restarted,
    code: restart.code,
    stdout: restart.stdout.slice(-1500),
    stderr: restart.stderr.slice(-1500),
  }
  check(
    "own restart wakes the gateway",
    restart.code === 0 && restart.stderr.includes(`remote access gateway listening on http://127.0.0.1:${gatewayPort}`),
    report.restart,
  )
  const gatewayPage = await fetch(`http://127.0.0.1:${gatewayPort}/`)
  const device = await fetch(`http://127.0.0.1:${gatewayPort}/own/device`)
  check("gateway serves the device page, 401 without a device", gatewayPage.ok && (await gatewayPage.text()).includes('name="own-gateway"') && device.status === 401)
  // 03 §4.3.1: the user manual is in app\<ver>\web and the gateway serves it before pairing (not a secret), framable by
  // the app's own origin only, with its scripts beside it (same-origin CSP).
  const assets = path.join(own, "app", version, "web", "_assets")
  const manualFile = fs.readdirSync(assets).find((name) => /^manual-[0-9a-f]+\.html$/.test(name))
  const manualPage = manualFile ? await fetch(`http://127.0.0.1:${gatewayPort}/_assets/${manualFile}`) : undefined
  const manualHtml = manualPage?.ok ? await manualPage.text() : ""
  const manualScripts = [...manualHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!)
  const scriptsServed = await Promise.all(
    manualScripts.map((name) => fetch(`http://127.0.0.1:${gatewayPort}/_assets/${name}`).then((response) => response.ok)),
  )
  check(
    "user manual in app\<ver>\web, served by the gateway, framable by the app only, scripts beside it",
    !!manualFile &&
      manualHtml.includes('id="ch17"') &&
      manualPage?.headers.get("content-security-policy")?.includes("frame-ancestors 'self'") === true &&
      manualScripts.length > 0 &&
      scriptsServed.every(Boolean) &&
      !/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/.test(manualHtml),
    { file: manualFile, status: manualPage?.status, scripts: manualScripts.length },
  )
  const listeners = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `@(Get-NetTCPConnection -State Listen -LocalPort ${gatewayPort} -ErrorAction SilentlyContinue | ForEach-Object LocalAddress) -join ','`],
    { encoding: "utf8", windowsHide: true },
  ).stdout.trim()
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((item): item is os.NetworkInterfaceInfo => !!item && item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254."))
    .map((item) => item.address)
  const reached = await Promise.all(
    lan.map(
      (address) =>
        new Promise<boolean>((resolve) => {
          const socket = net.connect({ host: address, port: gatewayPort, timeout: 1500 })
          socket.once("connect", () => (socket.destroy(), resolve(true)))
          socket.once("error", () => resolve(false))
          socket.once("timeout", () => (socket.destroy(), resolve(false)))
        }),
    ),
  )
  check("gateway on 127.0.0.1 only; no connection from LAN addresses", listeners === "127.0.0.1" && reached.every((ok) => !ok), { listeners, lan: lan.length })

  // Secret hygiene (G14 subset): the fake key in plaintext nowhere under the temp root (the app copy excluded).
  const hits: string[] = []
  const scan = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink() || file === path.join(own, "app")) continue
      if (entry.isDirectory()) scan(file)
      else if (entry.isFile() && fs.statSync(file).size < 64 * 1024 * 1024 && fs.readFileSync(file).includes(KEY)) hits.push(path.relative(root, file))
    }
  }
  scan(root)
  check("fake key never in plaintext", hits.length === 0, hits)
} catch (error) {
  check("walkthrough completed", false, error instanceof Error ? error.message : String(error))
} finally {
  if (started) ownCmd("stop", "--force")
  await fake.stop()
  // Every process still pointing into the temp root by command line or executable: the service's opencode.exe and
  // whatever it or the launcher left behind (a shell, git, ssh, an MCP or LSP server). They are stopped so the root can
  // go. The query's own PowerShell names the root too and is left out.
  const left = powershell<{ pid: number; name: string; commandLine: string | null }>(
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*${tag}*' -or $_.ExecutablePath -like '*${tag}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; @{ pid = $_.ProcessId; name = $_.Name; commandLine = $_.CommandLine } }`,
  )
  check(
    "no process left after own stop",
    left.rows?.every((item) => item.name.toLowerCase() !== "opencode.exe") === true,
    left.error,
  )
  check("no process left whose command line names the temp root", left.rows?.length === 0, left.rows ?? left.error)
  // Smart App Control canary (P1-15): a Code Integrity event since the start that names a file under the temp root means
  // a fresh unsigned PE of this build (opencode.exe, own-vault.exe, a native module they load) was blocked or flagged
  // when it ran from the installed layout. The log is only read, and any event id counts (the set SAC writes, such as
  // 3033 or 3077, is not pinned down).
  const integrity = powershell<{ id: number; time: string; message: string }>(
    `try { Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = [DateTimeOffset]::FromUnixTimeMilliseconds(${startedAt}).LocalDateTime } | Where-Object { $_.Message -like '*${tag}*' } | ForEach-Object { @{ id = $_.Id; time = $_.TimeCreated.ToUniversalTime().ToString('o'); message = $_.Message } } } catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }`,
  )
  report.codeIntegrity = integrity.rows ?? integrity.error
  check(
    "no Code Integrity event about a file under the temp root since the start",
    integrity.rows?.length === 0,
    integrity.rows ?? integrity.error,
  )
  check("real user paths unchanged", real.every((file, index) => fs.existsSync(file) === realBefore[index]))
  if (!args.keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  else report.root = root
}
report.checks = checks
const passed = Object.values(checks).every(Boolean)
report.passed = passed
console.log(JSON.stringify(report))
process.exit(passed ? 0 : 1)

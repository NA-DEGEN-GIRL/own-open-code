// Shared pieces of the packaged-shell runs (smoke.ts, browser-agent.ts): machine snapshot for the G-D1/G-D2 "must not
// change" checks, the isolated environment, the installed-UI layout, window capture, log collection and process
// cleanup. Every run starts the win-unpacked exe (never an installed copy) with temp OWN_HOME / OWN_CONFIG_DIR /
// XDG_* and kills every process it started.
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"

export const PACKAGE = path.resolve(import.meta.dir, "..")
export const REPO = path.resolve(PACKAGE, "../..")

export function packagedExe(explicit?: string) {
  const exe =
    explicit ??
    path.join(process.env.OWN_DESKTOP_OUT ?? path.join(REPO, "own/.out/desktop"), "win-unpacked", "own-desktop.exe")
  if (!existsSync(exe)) throw new Error(`packaged shell not found: ${exe} (bun run build && bun run package)`)
  return exe
}

export function shellVersion() {
  return JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8")).version as string
}

/** Temp XDG_* dirs under `root`, created. */
export function xdgDirs(root: string) {
  const xdg = {
    XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
  }
  Object.values(xdg).forEach((dir) => mkdirSync(dir, { recursive: true }))
  return xdg
}

/**
 * `<home>\app\<ver>\{web, manifest.json}` and the version pointer `app\current.json`, as own.ps1 install lays them out
 * (01 §5.1, 05 §5.5; no junction). `hash` is written as `desktop.rpc_hash` (05 §5.5; FORK §8.3's camelCase is read too).
 */
export function installUi(
  home: string,
  input: { readonly version: string; readonly web?: string; readonly hash: string },
) {
  const release = path.join(home, "app", input.version)
  mkdirSync(release, { recursive: true })
  if (input.web) cpSync(input.web, path.join(release, "web"), { recursive: true })
  writeFileSync(
    path.join(release, "manifest.json"),
    JSON.stringify(
      { version: input.version, channel: "own", desktop: { version: input.version, rpc_hash: input.hash } },
      null,
      2,
    ),
  )
  pointAt(home, input.version)
}

/** Writes `app\current.json` for `version` (temp + rename like own.ps1's Write-VersionPointer). */
export function pointAt(home: string, version: string, previous: string | null = null) {
  const file = path.join(home, "app", "current.json")
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(
    temp,
    JSON.stringify(
      {
        schema: 1,
        version,
        path: path.join(home, "app", version),
        previous,
        updatedAt: new Date().toISOString(),
        launcher: "test",
      },
      null,
      2,
    ) + "\n",
  )
  renameSync(temp, file)
}

/** The packaged app's userData (a packaged exe cannot move it; runs remove it again when they created it). */
export function appDataDir() {
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "dev.own.opencode.desktop")
}

const AUMID = "dev.own.opencode.desktop"
const START_MENU_SHORTCUT = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Own OpenCode.lnk",
)

/**
 * What Electron and Windows register on the shell's first toast even for the unpacked exe (seen with Electron 44,
 * gates.ts G-D4): a Start-menu shortcut "Own OpenCode.lnk" carrying the AUMID and a ToastActivatorCLSID, the COM
 * activator `HKCU\Software\Classes\CLSID\{…}` ("Electron Notification Activator", LocalServer32 = the exe), and
 * Windows' `…\Notifications\Settings\<AUMID>`. Runs record them before and remove the ones they created.
 * The CLSID is fixed since 05 §7.4 (src/shared/identity.ts), so an installed shell and a test run share the key: its
 * LocalServer32 is recorded too, and a run that pointed it at its own exe puts the installed one back.
 */
export function osArtifacts() {
  const script =
    `$ids = @(Get-ChildItem 'HKCU:\\Software\\Classes\\CLSID' -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `$d = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).'(default)'; ` +
    `if ($d -eq 'Electron Notification Activator') { $ls = (Get-ItemProperty "$($_.PSPath)\\LocalServer32" -ErrorAction SilentlyContinue).'(default)'; ` +
    `if ($ls -match 'own-desktop\\.exe') { [pscustomobject]@{ id = $_.PSChildName; server = [string]$ls } } } }); ConvertTo-Json -Compress @($ids)`
  const run = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let clsids: string[] = []
  const toastActivatorServers: Record<string, string> = {}
  try {
    type Row = { id: string; server: string }
    const parsed = JSON.parse(run.stdout.toString().trim() || "[]") as Row[] | Row
    for (const row of (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item?.id))
      toastActivatorServers[row.id] = row.server
    clsids = Object.keys(toastActivatorServers).sort()
  } catch {}
  const key = (name: string) =>
    Bun.spawnSync(["reg", "query", name], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode === 0
  return {
    startMenuShortcut: existsSync(START_MENU_SHORTCUT),
    toastActivatorClsids: clsids,
    toastActivatorServers,
    notificationSettings: key(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${AUMID}`),
  }
}

export type OsArtifacts = ReturnType<typeof osArtifacts>

/** Removes what the run's shell registered (see osArtifacts) and was not there before. Returns what it removed. */
export function removeNewOsArtifacts(before: OsArtifacts) {
  const now = osArtifacts()
  const removed: string[] = []
  if (now.startMenuShortcut && !before.startMenuShortcut) {
    rmSync(START_MENU_SHORTCUT, { force: true })
    removed.push(START_MENU_SHORTCUT)
  }
  for (const clsid of now.toastActivatorClsids.filter((id) => !before.toastActivatorClsids.includes(id))) {
    const name = `HKCU\\Software\\Classes\\CLSID\\${clsid}`
    Bun.spawnSync(["reg", "delete", name, "/f"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    removed.push(name)
  }
  // A key that was there before but now points at this run's exe (the fixed CLSID): the previous server goes back.
  for (const [clsid, server] of Object.entries(before.toastActivatorServers ?? {})) {
    if (!server || now.toastActivatorServers?.[clsid] === undefined || now.toastActivatorServers[clsid] === server)
      continue
    const name = `HKCU\\Software\\Classes\\CLSID\\${clsid}\\LocalServer32`
    Bun.spawnSync(["reg", "add", name, "/ve", "/d", server, "/f"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })
    removed.push(`${name} (restored)`)
  }
  if (now.notificationSettings && !before.notificationSettings) {
    const name = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${AUMID}`
    Bun.spawnSync(["reg", "delete", name, "/f"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    removed.push(name)
  }
  return { created: removed, after: osArtifacts() }
}

/** What a run must leave as it was: upstream's service registration, protocol keys, the own real registration. */
export function snapshotMachine() {
  const home = os.homedir()
  const file = (target: string) =>
    existsSync(target)
      ? { exists: true, sha256: createHash("sha256").update(readFileSync(target)).digest("hex").slice(0, 16) }
      : { exists: false }
  const key = (name: string) =>
    Bun.spawnSync(["reg", "query", `HKCU\\Software\\Classes\\${name}`], { stdout: "ignore", stderr: "ignore" })
      .exitCode === 0
  return {
    upstreamServiceJson: file(path.join(home, ".local", "state", "opencode", "service.json")),
    ownServiceJson: file(path.join(home, ".local", "state", "opencode", "service-own.json")),
    hkcuOpencode: key("opencode"),
    hkcuOwn: key("own"),
    os: osArtifacts(),
  }
}

export type MachineSnapshot = ReturnType<typeof snapshotMachine>

export function sameMachine(before: MachineSnapshot, after: MachineSnapshot) {
  return JSON.stringify(before) === JSON.stringify(after)
}

/** Parent env minus developer settings that would leak into the shell (like upstream's bench-startup.ts). */
export function cleanEnv(add: Record<string, string>) {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^(OPENCODE_|OTEL_|OWN_|XDG_|ELECTRON_)/.test(name)) continue
    env[name] = value
  }
  return { ...env, ...add }
}

/** The whole window as Windows draws it: WCO buttons and native browser views included (capture-window.ps1). */
export function windowShot(pid: number, out: string) {
  mkdirSync(path.dirname(out), { recursive: true })
  const run = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, "capture-window.ps1"),
      "-ProcessId",
      String(pid),
      "-Out",
      out,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  return run.exitCode === 0 ? out : `failed: ${run.stderr.toString().trim().slice(0, 300)}`
}

/** One pixel of a PNG as [r, g, b] (System.Drawing), e.g. to tell whether a native view is on a window capture. */
export function pixelAt(file: string, x: number, y: number): [number, number, number] | undefined {
  const script =
    "Add-Type -AssemblyName System.Drawing; " +
    `$b = [System.Drawing.Bitmap]::FromFile('${file.replaceAll("'", "''")}'); ` +
    `$c = $b.GetPixel(${Math.max(0, Math.floor(x))}, ${Math.max(0, Math.floor(y))}); $b.Dispose(); ` +
    'Write-Output "$($c.R),$($c.G),$($c.B)"'
  const run = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const match = /(\d+),(\d+),(\d+)/.exec(run.stdout.toString())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** Copies the shell's logs next to the screenshots and counts the launcher/service lines of main.log and own.log. */
export function collectLogs(target: string | undefined) {
  const logs = path.join(appDataDir(), "logs")
  if (!existsSync(logs)) return undefined
  if (target) {
    rmSync(target, { recursive: true, force: true })
    cpSync(logs, target, { recursive: true })
  }
  const text = [...new Bun.Glob("**/{main,own}.log").scanSync({ cwd: logs })]
    .map((file) => readFileSync(path.join(logs, file), "utf8"))
    .join("\n")
  return {
    copiedTo: target,
    text,
    launcherStarts: (text.match(/own: starting the service through the launcher/g) ?? []).length,
    serviceReady: (text.match(/own: service ready/g) ?? []).length,
    reconnects: (text.match(/own: service ready \{\s*mode: 'reconnect'/g) ?? []).length,
    launcherRestarts: (text.match(/launcher restart \{/g) ?? []).length,
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const ICON_SETTINGS = "HKCU:\\Control Panel\\NotifyIconSettings"

/**
 * The NotifyIconSettings entries Windows keeps for the tray icons (05 §7.3) of electron.exe files in `dist`, one per
 * icon id. Windows records the exe's real path, and a workspace's node_modules/electron is a link into bun's store, so
 * `dist` is resolved first.
 */
export function trayIconSettings(dist: string) {
  const prefix = realpathSync(dist).replaceAll("'", "''")
  const run = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `@(Get-ChildItem '${ICON_SETTINGS}' -ErrorAction SilentlyContinue | Where-Object { $p = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ExecutablePath; $p -and $p.StartsWith('${prefix}', 'OrdinalIgnoreCase') } | ForEach-Object { $_.PSChildName }) -join ','`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  )
  return run.stdout.toString().trim().split(",").filter(Boolean)
}

/** Removes the tray icon entries of `dist` a run created (not in `before`); returns their ids. */
export function removeNewTrayIconSettings(dist: string, before: ReadonlySet<string>) {
  const created = trayIconSettings(dist).filter((key) => !before.has(key))
  for (const key of created)
    Bun.spawnSync(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Remove-Item -LiteralPath '${ICON_SETTINGS}\\${key}' -Recurse`,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    )
  return created
}

export function killTree(pid: number) {
  Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
}

export async function freePort() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const value = server.port
  server.stop(true)
  return value
}

/**
 * Ends a shell the app's way (05 §7.3 앱 종료): its window's X, and `window.close()`, only hide the last window to the
 * tray now. A shell without `window.own.app` (built before it) still closes its window. The page goes with the shell,
 * so nothing is awaited from it.
 */
export async function quitShell(page: Page) {
  await page
    .evaluate(() => {
      const app = (window as unknown as { own?: { app?: { quit(mode: string): Promise<boolean> } } }).own?.app
      if (app) void app.quit("app")
      else window.close()
    })
    .catch(() => undefined)
}

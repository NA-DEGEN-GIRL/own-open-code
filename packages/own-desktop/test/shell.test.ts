// Shell-side contracts without Electron: paths from the env snapshot (05 §5.2), renderer choice and manifest keys
// (5.5), launcher invocation and restart results (5.3, 5.6), rpcHash (5.5), and the builder overrides (4.5).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { installedApp, pointerFile } from "../src/main/install-pointer"
import { parseManifest } from "../src/main/manifest"
import { envSnapshot, ownPaths } from "../src/main/own-env"
import { movedRoot, selectRenderer } from "../src/main/renderer-root"
import {
  EXIT_SESSION_RUNNING,
  exclusive,
  launcherCommand,
  openInBrowserResult,
  powershellPath,
  restartArgs,
  restartResult,
  runLauncher,
  type LauncherResult,
} from "../src/main/service/launcher"
import { rasterSwitches } from "../src/main/raster"
import { AUMID, PRODUCT_NAME, TOAST_ACTIVATOR_CLSID, TOAST_ACTIVATOR_CLSID_LOCAL } from "../src/shared/identity"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { committedRpcHash, rpcHash, rpcHashInputs } from "../scripts/rpc-hash.mjs"

describe("paths from the env snapshot (05 §5.2)", () => {
  test("own channel: XDG_STATE_HOME and OWN_HOME decide, like own.ps1 Get-OwnPaths", () => {
    const paths = ownPaths({ USERPROFILE: "C:\\Users\\u", XDG_STATE_HOME: "D:\\t\\state", OWN_HOME: "D:\\t\\own" })
    expect(paths.channel).toBe("own")
    expect(paths.registration).toBe(path.join("D:\\t\\state", "opencode", "service-own.json"))
    expect(paths.launcher).toBe(path.join("D:\\t\\own", "bin", "own.ps1"))
    expect(paths.manifest).toBe(path.join("D:\\t\\own", "app", "current", "manifest.json"))
    expect(paths.web).toBe(path.join("D:\\t\\own", "app", "current", "web"))
    expect(paths.control).toBe(path.join("D:\\t\\own", "control"))
  })

  test("defaults: ~/.local/state and %LOCALAPPDATA%\\own-open-code; never upstream's service.json", () => {
    const paths = ownPaths({ USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" })
    expect(paths.registration).toBe(path.join("C:\\Users\\u", ".local", "state", "opencode", "service-own.json"))
    expect(paths.ownHome).toBe(path.join("C:\\Users\\u\\AppData\\Local", "own-open-code"))
    expect(path.basename(paths.registration)).not.toBe("service.json")
  })

  test("dev channel looks for the local-channel registration", () => {
    const paths = ownPaths({ USERPROFILE: "C:\\Users\\u", OWN_DESKTOP_CHANNEL: "local", XDG_STATE_HOME: "D:\\s" })
    expect(paths.channel).toBe("local")
    expect(paths.registration).toBe(path.join("D:\\s", "opencode", "service-local.json"))
  })
})

describe("installed release from app\\current.json, never through a junction (01 §5.1)", () => {
  const roots: string[] = []
  const home = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "own-shell-home-"))
    roots.push(root)
    return root
  }
  const version = (root: string, name: string, web = true) => {
    const dir = path.join(root, "app", name)
    mkdirSync(path.join(dir, "web"), { recursive: true })
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: name, desktop: { rpc_hash: RPC_HASH } }))
    if (web) writeFileSync(path.join(dir, "web", "index.html"), "<!doctype html>")
    return dir
  }
  const pointer = (root: string, name: string) =>
    writeFileSync(pointerFile(root), JSON.stringify({ schema: 1, version: name, path: "X:\\elsewhere", previous: null }))
  afterAll(() => {
    for (const root of roots) {
      const link = path.join(root, "app", "current")
      if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the pointer names app\\<version> next to it; manifest, web and exe come from that folder", () => {
    const root = home()
    const dir = version(root, "2.0.18-own.3")
    pointer(root, "2.0.18-own.3")
    const paths = ownPaths({ USERPROFILE: "C:\\Users\\u", OWN_HOME: root })
    expect(paths.installed).toEqual({ version: "2.0.18-own.3", dir, source: "pointer" })
    expect(paths.app).toBe(dir)
    expect(paths.manifest).toBe(path.join(dir, "manifest.json"))
    expect(paths.web).toBe(path.join(dir, "web"))
    expect(paths.exe).toBe(path.join(dir, "opencode.exe"))
    expect(paths.pointer).toBe(path.join(root, "app", "current.json"))
  })

  test("an older launcher's junction: its target is used, not the link; a broken one reads as not installed", () => {
    const root = home()
    const dir = version(root, "2.0.18-own.2")
    symlinkSync(dir, path.join(root, "app", "current"), "junction")
    expect(installedApp(root)).toEqual({ version: "2.0.18-own.2", dir, source: "junction" })
    expect(ownPaths({ OWN_HOME: root }).web).toBe(path.join(dir, "web"))
    // The pointer wins once the launcher wrote it.
    const next = version(root, "2.0.18-own.3")
    pointer(root, "2.0.18-own.3")
    expect(ownPaths({ OWN_HOME: root }).app).toBe(next)

    const broken = home()
    const gone = path.join(broken, "app", "gone")
    mkdirSync(gone, { recursive: true })
    symlinkSync(gone, path.join(broken, "app", "current"), "junction")
    rmSync(gone, { recursive: true })
    expect(installedApp(broken)).toBeUndefined()
    expect(ownPaths({ OWN_HOME: broken }).manifest).toBe(path.join(broken, "app", "current", "manifest.json"))
  })

  test("a pointer to a missing or unsafe folder is ignored", () => {
    const root = home()
    mkdirSync(path.join(root, "app"), { recursive: true })
    for (const bad of ["2.0.18-own.9", "..", "..\\..", "current"]) {
      pointer(root, bad)
      expect(installedApp(root)).toBeUndefined()
    }
  })

  test("the installed UI's root follows the pointer on a page load; the fallback page and dev URL stay", () => {
    const has = (dirs: string[]) => (dir: string) => dirs.includes(dir)
    const installed = { source: "installed" as const, root: "A\\web", uiVersion: "1" }
    expect(movedRoot({ source: installed, current: "A\\web", installedWeb: "B\\web", webIndexExists: has(["B\\web"]) })).toBe(
      "B\\web",
    )
    // Same folder (case-insensitive on Windows), or a new version without its web: stays.
    expect(
      movedRoot({ source: installed, current: "A\\web", installedWeb: "a\\WEB", webIndexExists: has(["a\\WEB"]), platform: "win32" }),
    ).toBeUndefined()
    expect(movedRoot({ source: installed, current: "A\\web", installedWeb: "B\\web", webIndexExists: has([]) })).toBeUndefined()
    expect(
      movedRoot({ source: { source: "fallback", reason: "skew" }, current: "F", installedWeb: "B\\web", webIndexExists: has(["B\\web"]) }),
    ).toBeUndefined()
    expect(
      movedRoot({ source: { source: "dev", url: "http://x" }, current: "F", installedWeb: "B\\web", webIndexExists: has(["B\\web"]) }),
    ).toBeUndefined()
  })
})

describe("renderer location (05 §5.5)", () => {
  const base = { webRoot: "W", fallbackRoot: "F", rpcHash: "aaaaaaaaaaaaaaaa" }
  test("installed UI with the shell's hash", () => {
    const choice = selectRenderer({
      ...base,
      webIndexExists: true,
      manifest: { version: "2.0.18-own.1", rpcHash: "aaaaaaaaaaaaaaaa" },
    })
    expect(choice).toEqual({ root: "W", source: { source: "installed", root: "W", uiVersion: "2.0.18-own.1" } })
  })
  test("another hash: fallback page, reason skew", () => {
    const choice = selectRenderer({ ...base, webIndexExists: true, manifest: { version: "x", rpcHash: "bbbb" } })
    expect(choice.root).toBe("F")
    expect(choice.source).toMatchObject({ source: "fallback", reason: "skew", uiRpcHash: "bbbb" })
  })
  test("no manifest or no web\\index.html: fallback page, reason missing", () => {
    expect(selectRenderer({ ...base, webIndexExists: true }).source).toMatchObject({ reason: "missing" })
    expect(
      selectRenderer({ ...base, webIndexExists: false, manifest: { rpcHash: "aaaaaaaaaaaaaaaa" } }).source,
    ).toMatchObject({ reason: "missing" })
  })
  test("a dev renderer URL wins", () => {
    expect(selectRenderer({ ...base, devUrl: "http://127.0.0.1:5173", webIndexExists: false }).source).toEqual({
      source: "dev",
      url: "http://127.0.0.1:5173",
    })
  })
  test("manifest: 05's desktop.rpc_hash and FORK's desktop.rpcHash both read", () => {
    expect(parseManifest('{"version":"v","desktop":{"rpc_hash":"h1"}}')).toEqual({ version: "v", rpcHash: "h1" })
    expect(parseManifest('{"version":"v","desktop":{"rpcHash":"h2"}}')).toEqual({ version: "v", rpcHash: "h2" })
    expect(parseManifest("not json")).toBeUndefined()
  })
})

describe("launcher (05 §5.3, §5.6)", () => {
  test("powershell.exe from SystemRoot with own.cmd's flags, never a shell string", () => {
    const command = launcherCommand({ launcher: "D:\\own\\bin\\own.ps1" }, "start", [], { SystemRoot: "C:\\Windows" })
    expect(command.file).toBe(path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
    expect(command.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "D:\\own\\bin\\own.ps1",
      "start",
    ])
    expect(powershellPath({})).toContain("powershell.exe")
  })

  test("restart arguments: --force and a checked --claude-config-dir", () => {
    const yes = () => true
    expect(restartArgs({ force: false }, yes)).toEqual({ ok: true, args: [] })
    expect(restartArgs({ force: true, claudeConfigDir: "C:\\claude" }, yes)).toEqual({
      ok: true,
      args: ["--force", "--claude-config-dir", "C:\\claude"],
    })
    expect(restartArgs({ force: false, claudeConfigDir: "relative\\dir" }, yes).ok).toBe(false)
    expect(restartArgs({ force: false, claudeConfigDir: "C:\\bad\nname" }, yes).ok).toBe(false)
    expect(restartArgs({ force: false, claudeConfigDir: `C:\\${"a".repeat(1100)}` }, yes).ok).toBe(false)
    expect(restartArgs({ force: false, claudeConfigDir: "C:\\missing" }, () => false).ok).toBe(false)
  })

  test("one launcher run at a time: a start queued behind a restart runs after it", async () => {
    const order: string[] = []
    const restart = exclusive(async () => {
      order.push("restart:begin")
      await Bun.sleep(30)
      order.push("restart:end")
      throw new Error("launcher failed")
    })
    const start = exclusive(async () => {
      order.push("start")
      return "started"
    })
    await expect(restart).rejects.toThrow("launcher failed")
    expect(await start).toBe("started")
    expect(order).toEqual(["restart:begin", "restart:end", "start"])
  })

  test("launcher runs get the env snapshot plus OWN_LAUNCHER_CLIENT=desktop (own.ps1 skips the gateway wake)", async () => {
    const result = await runLauncher(
      {
        file: process.execPath,
        args: ["-e", "process.stdout.write(`${process.env.OWN_LAUNCHER_CLIENT}|${process.env.OWN_TEST_MARK}`)"],
      },
      { timeoutMs: 30_000, env: { ...envSnapshot, OWN_TEST_MARK: "kept" } },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("desktop|kept")
  })

  test("restart results: 0 ok, exit 4 or the v0 refusal text → session_running, else launcher_failed", () => {
    const result = (code: number | null, stderr = "", timedOut = false): LauncherResult => ({
      code,
      stderr,
      stdout: "",
      timedOut,
    })
    expect(restartResult(result(0))).toEqual({ ok: true })
    expect(restartResult(result(EXIT_SESSION_RUNNING))).toEqual({ ok: false, refused: "session_running" })
    expect(
      restartResult(result(1, "own: 2 session(s) are running; re-run with --force to restart anyway.")),
    ).toEqual({ ok: false, refused: "session_running" })
    expect(restartResult(result(1, "own: opencode.exe not found"))).toMatchObject({
      ok: false,
      refused: "launcher_failed",
      detail: expect.stringContaining("opencode.exe not found"),
    })
    expect(restartResult(result(null, "", true))).toMatchObject({ refused: "launcher_failed" })
  })
})

describe("rpcHash (05 §5.5)", () => {
  test("the committed constant is the hash of the current contract", () => {
    expect(RPC_HASH).toMatch(/^[0-9a-f]{16}$/)
    expect(committedRpcHash()).toBe(RPC_HASH)
    expect(rpcHash()).toBe(RPC_HASH)
    expect(() => rpcHash({ expect: "0000000000000000" })).toThrow("rpcHash mismatch")
  })

  test("inputs: upstream IPC contract files, the browser pane's plugin Ipc and window.own's contract, sorted", () => {
    const inputs: string[] = rpcHashInputs()
    expect(inputs).toContain("packages/desktop/src/shared/ipc-rpc.ts")
    expect(inputs).toContain("packages/desktop/src/shared/ipc-rpc/app.ts")
    expect(inputs).toContain("packages/desktop/src/shared/ipc-rpc/plugins.ts")
    expect(inputs).toContain("packages/gui-plugins/src/browser/ipc.ts")
    expect(inputs).toContain("packages/desktop/src/shared/ipc-transport.ts")
    expect(inputs).toContain("packages/desktop/src/shared/window-bootstrap.ts")
    expect(inputs).toContain("packages/own-desktop/src/preload/own-api.ts")
    expect(inputs).toEqual([...inputs].sort())
  })

  test("pure: any contract change moves the hash, line endings do not", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "own-rpc-hash-"))
    const inputs: string[] = rpcHashInputs()
    for (const file of inputs) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      writeFileSync(path.join(repo, file), `// ${file}\nexport const x = 1\n`)
    }
    const first = rpcHash({ repo })
    writeFileSync(path.join(repo, inputs[0]!), `// ${inputs[0]}\r\nexport const x = 1\r\n`)
    expect(rpcHash({ repo })).toBe(first)
    writeFileSync(path.join(repo, "packages/own-desktop/src/preload/own-api.ts"), "export const x = 2\n")
    expect(rpcHash({ repo })).not.toBe(first)
    rmSync(repo, { recursive: true, force: true })
  })
})

describe("packaging overrides (05 §4.5)", () => {
  // The first import of the builder config loads electron-builder's whole module graph: about 1 s, but 22 s and 31 s
  // in two chained runs started right after a shell build (2026-11-21), past a test's 5 s. It is loaded once here.
  beforeAll(() => import("../electron-builder.config"), 120_000)

  test("the build toolchain is upstream's, but for Electron, which runs ahead for its security backports", async () => {
    type Manifest = { readonly devDependencies: Readonly<Record<string, string>> }
    const ours = ((await Bun.file(path.join(import.meta.dir, "../package.json")).json()) as Manifest).devDependencies
    const upstream = (
      (await Bun.file(path.join(import.meta.dir, "../../desktop/package.json")).json()) as Manifest
    ).devDependencies
    // htmlparser2 left upstream's toolchain with the beta notes (6eac53772b); own-desktop's copy is unused.
    const names = ["electron-vite", "electron-builder", "app-builder-lib", "vite", "magic-string"]
    for (const name of names) expect({ name, version: ours[name] }).toEqual({ name, version: upstream[name] })
    // own-desktop takes Electron 44.10.2 before upstream (Chromium/V8/PDFium backports and Node 24.22.2 for the
    // browser pane, decisions EL-1). Remove this exception when upstream pins 44.10.2 or later: this line fails then.
    expect({ ours: ours.electron, upstream: upstream.electron }).toEqual({ ours: "44.10.2", upstream: "44.9.1" })
  })

  test("own identity, no protocol, no publish, no bundled CLI, no-op afterPack, no renderer sourcemaps", async () => {
    const { ownBuilderConfig } = await import("../electron-builder.config")
    const config = ownBuilderConfig({})
    expect(config.appId).toBe("dev.own.opencode.desktop")
    expect(config.productName).toBe("Own OpenCode")
    expect(config.executableName).toBe("own-desktop")
    expect(config.protocols).toEqual([])
    expect(config.publish).toBeNull()
    // Without a staged payload: a shell-only installer.
    expect(config.extraResources).toEqual([])
    expect(await (config.afterPack as () => Promise<void>)()).toBeUndefined()
    expect(config.files).toContain("!out/renderer/**/*.map")
    expect((config.win as { target: unknown }).target).toEqual(["nsis"])
    expect(JSON.stringify(config)).not.toContain("ai.opencode.desktop")
  })

  test("one-step installer: the staged payload rides along as resources\\own-payload, solid, .gz stored", async () => {
    const { ownBuilderConfig, PAYLOAD_RESOURCE, payloadRoot } = await import("../electron-builder.config")
    const root = mkdtempSync(path.join(os.tmpdir(), "own-payload-config-"))
    try {
      expect(() => payloadRoot({ OWN_DESKTOP_PAYLOAD: root })).toThrow("app\\manifest.json")
      mkdirSync(path.join(root, "app"), { recursive: true })
      mkdirSync(path.join(root, "bin"), { recursive: true })
      writeFileSync(path.join(root, "app", "manifest.json"), "{}")
      writeFileSync(path.join(root, "bin", "own.ps1"), "")
      const config = ownBuilderConfig({ OWN_DESKTOP_PAYLOAD: root })
      expect(PAYLOAD_RESOURCE).toBe("own-payload")
      expect(config.extraResources).toEqual([
        { from: path.join(root, "app"), to: "own-payload/app" },
        { from: path.join(root, "bin"), to: "own-payload/bin" },
      ])
      const nsis = config.nsis as {
        differentialPackage?: boolean
        preCompressedFileExtensions?: string[]
        oneClick?: boolean
        perMachine?: boolean
      }
      expect(nsis.oneClick).toBe(true)
      expect(nsis.perMachine).toBe(false)
      // No updater reads a blockmap, so the archive is solid; electron-builder's defaults stay pre-compressed.
      expect(nsis.differentialPackage).toBe(false)
      expect(nsis.preCompressedFileExtensions).toEqual(expect.arrayContaining([".gz", ".mp4", ".webm", ".vmdk"]))
      // Upstream's signing hook still runs for the shell, never for the payload hashed into app\manifest.json.
      const signed: string[] = []
      const { payloadSafeSign, isPayloadPath } = await import("../electron-builder.config")
      const options = payloadSafeSign({
        sign: async (configuration: { path: string }) => void signed.push(configuration.path),
      })
      const sign = (options as { sign: (configuration: { path: string }) => Promise<unknown> }).sign
      await sign({ path: "C:\\out\\win-unpacked\\own-desktop.exe" })
      await sign({ path: "C:\\out\\win-unpacked\\resources\\own-payload\\app\\opencode.exe" })
      expect(signed).toEqual(["C:\\out\\win-unpacked\\own-desktop.exe"])
      expect(isPayloadPath("C:/out/win-unpacked/resources/own-payload/app/own-vault.exe")).toBe(true)
      expect(isPayloadPath("C:\\out\\win-unpacked\\resources\\elevate.exe")).toBe(false)
      // Upstream's config no longer signs (v2.2 signs outside electron-builder); a hook it adds again is wrapped.
      const upstreamWin = (await import("../../desktop/electron-builder.config")).default.win as {
        signtoolOptions?: { sign?: unknown }
      }
      expect(typeof (config.win as { signtoolOptions?: { sign?: unknown } }).signtoolOptions?.sign).toBe(
        typeof upstreamWin.signtoolOptions?.sign,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("built bundle (G-D2 string checks; runs after `bun run build`)", async () => {
  const out = path.resolve(import.meta.dir, "../out")
  const files = await Array.fromAsync(new Bun.Glob("**/*.{js,cjs,html}").scan({ cwd: out })).catch(() => [])
  test.skipIf(files.length === 0)("no protocol claim, no upstream app id, the rpcHash stamped in main and preload", async () => {
    const texts = await Promise.all(files.map((file) => Bun.file(path.join(out, file)).text()))
    const all = texts.join("\n")
    expect(all).not.toMatch(/setAsDefaultProtocolClient/)
    expect(all).not.toContain("ai.opencode.desktop")
    // 05 §8.1: the browser pane is the one GUI plugin in the bundle; no updater, SSH or WSL code at all.
    expect(all).toContain("browser.pane")
    expect(all).not.toMatch(/electron-updater|quitAndInstall|autoUpdater/)
    // Literals of the SSH, WSL and pairing (keep-screen-awake) main entries.
    expect(all).not.toMatch(/ServerAliveInterval=15|spawning wsl sidecar|prevent-display-sleep/)
    const main = await Bun.file(path.join(out, "main/index.js")).text()
    const preload = await Bun.file(path.join(out, "preload/index.cjs")).text()
    expect(main).toContain(RPC_HASH)
    expect(preload).toContain(RPC_HASH)
  })})

describe("toast activator and uninstall cleanup (05 §7.4, §10.4)", () => {
  const nsh = Bun.file(path.join(import.meta.dir, "../build/installer.nsh")).text()
  const define = async (name: string) => new RegExp(`^!define ${name} "([^"]+)"`, "m").exec(await nsh)?.[1]

  test("fixed GUIDs, one for the packaged shell and another for the development shell", () => {
    const guid = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/
    expect(TOAST_ACTIVATOR_CLSID).toMatch(guid)
    expect(TOAST_ACTIVATOR_CLSID_LOCAL).toMatch(guid)
    expect(TOAST_ACTIVATOR_CLSID_LOCAL).not.toBe(TOAST_ACTIVATOR_CLSID)
  })

  test("installer.nsh removes exactly the identity's CLSID, AUMID settings and shortcut, never on an update", async () => {
    expect(await define("OWN_TOAST_ACTIVATOR_CLSID")).toBe(TOAST_ACTIVATOR_CLSID)
    expect(await define("OWN_AUMID")).toBe(AUMID)
    expect(await define("OWN_SHORTCUT_NAME")).toBe(PRODUCT_NAME)
    const text = await nsh
    const macro = /!macro customUnInstall([\s\S]*?)!macroend/.exec(text)?.[1] ?? ""
    expect(macro).toContain("${ifNot} ${isUpdated}")
    expect(macro).toContain(String.raw`DeleteRegKey HKCU "Software\Classes\CLSID\${OWN_TOAST_ACTIVATOR_CLSID}"`)
    expect(macro).toContain(String.raw`Delete "$SMPROGRAMS\${OWN_SHORTCUT_NAME}.lnk"`)
    // Only HKCU and the user's Start menu: a per-user install touches nothing machine-wide.
    expect(macro).not.toMatch(/HKLM|SHELL_CONTEXT/)
  })

  test("upstream's include is left out (its macros clash since v2.2); its sandbox icacls grant is repeated verbatim", async () => {
    const text = await nsh
    // Upstream's v2.2 include defines customInit (another install folder), customUnInstall and the updater's macros:
    // NSIS refuses a second macro of one name, and own has no updater, so own's include no longer pulls it in.
    const upstream = await Bun.file(path.resolve(import.meta.dir, "../../desktop/resources/windows/installer.nsh")).text()
    for (const name of ["customInit", "customInstall", "customUnInstall"]) expect(upstream).toContain(`!macro ${name}`)
    expect(text).not.toMatch(/^!include .*installer\.nsh"?$/m)
    expect(text).not.toContain("!macroundef")
    const upstreamMacro = /!macro customInstall([\s\S]*?)!macroend/.exec(upstream)?.[1] ?? ""
    const instructions = upstreamMacro
      .split(/\r?\n/)
      .map((line) => line.trim())
      // `leaveSharedInstall` moves files out of a folder all upstream channels once shared; own never had one.
      .filter((line) => line && !line.startsWith(";") && line !== "!insertmacro leaveSharedInstall")
    expect(instructions).toContain(String.raw`nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"'`)
    const ours = /^!macro customInstall([\s\S]*?)!macroend/m.exec(text)?.[1] ?? ""
    for (const line of instructions) expect(ours).toContain(line)
  })

  test("builder config and the substituted constants use the same identity", async () => {
    const { default: config } = await import("../electron-builder.config")
    expect(config.appId).toBe(AUMID)
    expect(config.productName).toBe(PRODUCT_NAME)
    expect((config.nsis as { include?: string }).include).toBe(path.resolve(import.meta.dir, "../build/installer.nsh"))
    const constants = await Bun.file(path.join(import.meta.dir, "../src/overrides/constants.ts")).text()
    expect(constants).toContain(`app.isPackaged ? "${AUMID}" : "${AUMID}.local"`)
  })
})

describe("one-step service install and removal in the installer (USER-GUIDE §2, 01 §5.5)", () => {
  const nsh = Bun.file(path.join(import.meta.dir, "../build/installer.nsh")).text()
  const macro = async (name: string) => new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(await nsh)?.[1] ?? ""
  const code = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(";"))
      .join("\n")

  test("the payload is compiled in only when build-desktop.ps1 staged it, at the resource path the config uses", async () => {
    const text = await nsh
    expect(text).toContain('!if /FileExists "$%OWN_DESKTOP_PAYLOAD%\\bin\\own.ps1"')
    expect(text).toContain('!define OWN_PAYLOAD_DIR "$INSTDIR\\resources\\own-payload"')
    const { PAYLOAD_RESOURCE } = await import("../electron-builder.config")
    expect(text).toContain(`$INSTDIR\\resources\\${PAYLOAD_RESOURCE}"`)
  })

  test("customInit asks before anything is extracted: exit 4 of the preflight, no → quit with 4, silent → no", async () => {
    const init = code(await macro("customInit"))
    expect(init).toContain('File "/oname=$PLUGINSDIR\\own-preflight.ps1" "${OWN_PAYLOAD}\\bin\\own.ps1"')
    expect(init).toContain('install --preflight --version "${VERSION}"')
    expect(init).toMatch(
      /\$\{If\} \$R0 == 4[\s\S]*MessageBox MB_YESNO[^\n]*\/SD IDNO IDYES own_preflight_agreed\n!insertmacro ownLog [^\n]*\nSetErrorLevel 4\nQuit/,
    )
    expect(init).toContain('${GetOptions} $R0 "--own-force" $R1')
  })

  test("every launcher run is logged with its command and exit code; a silent install keeps a failure's exit code", async () => {
    const text = await nsh
    expect(text).toContain('!define OWN_INSTALLER_LOG "$TEMP\\own-installer.log"')
    // UTF-16LE with a BOM (NSIS cannot write UTF-8; paths may hold any character).
    expect(code(await macro("ownLog"))).toContain("FileWriteWord $3 0xFEFF")
    expect(code(await macro("ownLog"))).toContain('FileWriteUTF16LE $3 "$2-$1-$0 $4:$5:$6 $7$\\r$\\n"')
    const init = code(await macro("customInit"))
    expect(init).toMatch(/!insertmacro ownLog 'preflight: [^\n]*install --preflight[^\n]*'\nnsExec::Exec [^\n]*\nPop \$R0\n!insertmacro ownLog "preflight: exit \$R0"/)
    const service = code(await macro("ownInstallService"))
    expect(service).toMatch(/!insertmacro ownLog 'install: [^\n]*'\nnsExec::ExecToLog [^\n]*\nPop \$R0\n!insertmacro ownLog "install: exit \$R0"\n!insertmacro ownHomeLog \$R2 /)
    // A payload that is not where the shell was extracted is reported instead of skipped silently.
    expect(service).toMatch(/\$\{Else\}\n!insertmacro ownLog "install: \$\{OWN_PAYLOAD_DIR\}\\bin\\own\.ps1 is missing/)
    const silent = code(await macro("ownSilentExit"))
    expect(silent).toContain("SetErrorLevel $ownServiceExit")
    // Last in customInstall: electron-builder's quitSuccess (SetErrorLevel 0) follows it.
    const install = code(await macro("customInstall"))
    expect(install.lastIndexOf("!insertmacro ownSilentExit")).toBeGreaterThan(install.indexOf("icacls.exe"))
    const uninstall = code(await macro("customUnInstall"))
    expect(uninstall).toMatch(/Pop \$R0\n!insertmacro ownLog "uninstall: exit \$R0"/)
  })

  test("customInstall runs the payload's launcher on the payload, moves it, never prompts, then upstream's grant", async () => {
    const service = code(await macro("ownInstallService"))
    expect(service).toContain(
      'nsExec::ExecToLog \'"$ownPowerShell" ${OWN_PS_ARGS} "${OWN_PAYLOAD_DIR}\\bin\\own.ps1" install --from "${OWN_PAYLOAD_DIR}" --move --no-prompt $R1\'',
    )
    // Sessions that started during extraction: asked again, "no" postpones the service (shown), failures shown.
    expect(service).toMatch(/\/SD IDNO IDYES own_install_agreed/)
    expect(service).toContain('MessageBox MB_OK|MB_ICONINFORMATION "${OWN_MSG_POSTPONED}" /SD IDOK')
    expect(service).toContain('MessageBox MB_OK|MB_ICONSTOP "${OWN_MSG_INSTALL_FAILED}" /SD IDOK')
    const install = code(await macro("customInstall"))
    expect(install.indexOf("!insertmacro ownInstallService")).toBeLessThan(install.indexOf("icacls.exe"))
    expect(install).toContain('Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"')
    expect((await nsh).match(/-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File/g)?.length).toBe(1)
  })

  test("customUnInit: never on an update run, asks service (yes) then data (no), checks sessions before removing", async () => {
    const init = code(await macro("customUnInit"))
    expect(init).toContain('${GetOptions} $R0 "/KEEP_APP_DATA" $R1')
    expect(init).toContain("${AndIfNot} ${isUpdated}")
    expect(init).toContain('${AndIf} $EXEFILE != "old-uninstaller.exe"')
    expect(init).toContain('MessageBox MB_YESNO|MB_ICONQUESTION "${OWN_MSG_REMOVE_SERVICE}" IDNO own_uninstall_asked')
    // Deleting data needs an explicit yes (default button no) or --own-remove-data when silent.
    expect(init).toContain(
      'MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "${OWN_MSG_REMOVE_DATA}" IDNO own_uninstall_asked',
    )
    expect(init.match(/StrCpy \$ownUnData "--remove-data"/g)?.length).toBe(2)
    expect(init).toContain('${GetOptions} $R0 "--own-remove-data" $R1')
    expect(init).toMatch(
      /uninstall --check'\nPop \$R1\n!insertmacro ownLog "uninstall --check: exit \$R1"\n\$\{If\} \$R1 == 5\nMessageBox[^\n]*OWN_MSG_VIRTUALIZED_UNINSTALL[^\n]*\nSetErrorLevel 5\nQuit\n\$\{EndIf\}\n\$\{If\} \$R1 == 4\nMessageBox[^\n]*\/SD IDNO IDYES own_uninstall_agreed\nSetErrorLevel 4\nQuit/,
    )
  })

  test("customUnInstall: the launcher's uninstall with the chosen flags; the shell's data only with the user data", async () => {
    const uninstall = code(await macro("customUnInstall"))
    expect(uninstall.indexOf("${ifNot} ${isUpdated}")).toBe(0)
    expect(uninstall).toContain(
      'nsExec::ExecToLog \'"$ownUnPowerShell" ${OWN_PS_ARGS} "$ownUnLauncher" uninstall --no-prompt $ownUnData $R1\'',
    )
    expect(uninstall).toMatch(/\$\{If\} \$ownUnData != ""\nRMDir \/r "\$APPDATA\\\$\{OWN_AUMID\}"/)
    expect(uninstall).not.toMatch(/HKLM|SHELL_CONTEXT/)
  })
})

describe("raster switches (05 §9.2 R-D13, PF1)", () => {
  test("CPU raster with four threads by default; OWN_DESKTOP_GPU_RASTER=1 keeps Chromium's GPU raster", () => {
    expect(rasterSwitches({})).toEqual([["disable-gpu-rasterization"], ["num-raster-threads", "4"]])
    expect(rasterSwitches({ OWN_DESKTOP_GPU_RASTER: "1" })).toEqual([])
  })
})

describe("mismatch screen support (05 §5.5)", () => {
  const result = (code: number | null, stderr = "", timedOut = false): LauncherResult => ({
    code,
    stderr,
    stdout: "",
    timedOut,
  })
  test("[브라우저로 열기] is `own open --browser` through powershell.exe", () => {
    const command = launcherCommand({ launcher: "D:\own\bin\own.ps1" }, "open", ["--browser"], {
      SystemRoot: "C:\Windows",
    })
    expect(command.args.slice(-3)).toEqual(["D:\own\bin\own.ps1", "open", "--browser"])
  })
  test("its results: ok, a service of another version with sessions (exit 4), other failures with stderr", () => {
    expect(openInBrowserResult(result(0))).toEqual({ ok: true })
    expect(openInBrowserResult(result(EXIT_SESSION_RUNNING))).toMatchObject({
      ok: false,
      detail: expect.stringContaining("own restart"),
    })
    expect(openInBrowserResult(result(1, "own: opencode.exe not found"))).toMatchObject({
      ok: false,
      detail: expect.stringContaining("opencode.exe not found"),
    })
    expect(openInBrowserResult(result(null, "", true))).toMatchObject({
      ok: false,
      detail: "런처가 시간 안에 끝나지 않았어요",
    })
  })
  test("window.own carries the two calls on their own channels", async () => {
    const { OwnIpc } = await import("../src/preload/own-api")
    expect(OwnIpc.openLogs).toBe("own:support.open-logs")
    expect(OwnIpc.openInBrowser).toBe("own:support.open-in-browser")
    const preload = await Bun.file(path.join(import.meta.dir, "../src/preload/index.ts")).text()
    expect(preload).toMatch(/support: \{\s*openLogs: \(\) => ipcRenderer\.invoke\(OwnIpc\.openLogs\)/)
  })
})

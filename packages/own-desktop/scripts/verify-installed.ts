// The development shell (electron-vite `out/`, unpackaged Electron, so userData is a temp folder and never the user's
// %APPDATA%\dev.own.opencode.desktop) against an install made by own.ps1 (01 §5.1): the renderer must come from the
// version folder app\current.json names (never through a junction), its UI must load, and after `own rollback` twice
// (the service stopped and started on the other version) a window reload must follow the pointer (01 §5.5 step 7).
// Used by own/scripts/test/install.test.mjs (OWN_REAL_LOCALAPPDATA=1 with real payloads) on an OWN_HOME under
// %LOCALAPPDATA%, where junctions cannot be traversed on some Windows 11 builds.
//
//   bun scripts/verify-installed.ts --root <dir with own\, config\, xdg\{config,state,data,cache}> [--rollback]
//
// Needs `bun run build` with OWN_RPC_HASH/OWN_VERSION (build-desktop.ps1 does it) so out/ carries the installed UI's
// rpcHash. Prints a JSON report as the last line; exit 1 on a failed check. Kills the Electron tree it started.
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { connect } from "./probe"
import { cleanEnv, freePort, killTree, PACKAGE, quitShell } from "./run-kit"

const args = parseArgs({ options: { root: { type: "string" }, rollback: { type: "boolean", default: false } } }).values
if (!args.root) throw new Error("--root <verify root> is required")
const root = path.resolve(args.root)
const ownHome = path.join(root, "own")
const env: Record<string, string> = {
  OWN_HOME: ownHome,
  OWN_CONFIG_DIR: path.join(root, "config"),
  XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
  XDG_STATE_HOME: path.join(root, "xdg", "state"),
  XDG_DATA_HOME: path.join(root, "xdg", "data"),
  XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
  // A run inside a packaged app that virtualizes %LOCALAPPDATA% (own.ps1 exit 5 otherwise): the caller decided.
  ...(process.env.OWN_ALLOW_VIRTUALIZED === "1" ? { OWN_ALLOW_VIRTUALIZED: "1" } : {}),
}
const electron = path.join(PACKAGE, "node_modules", "electron", "dist", "electron.exe")
if (!existsSync(electron)) throw new Error(`${electron} is missing (bun run electron:install)`)
if (!existsSync(path.join(PACKAGE, "out", "main", "index.js"))) throw new Error("out/ is missing (bun run build)")

const checks: Record<string, boolean> = {}
const report: Record<string, unknown> = { root }
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks[name] = ok
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`)
}
const pointed = () => {
  const pointer = JSON.parse(readFileSync(path.join(ownHome, "app", "current.json"), "utf8")) as { version: string }
  return { version: pointer.version, web: path.join(ownHome, "app", pointer.version, "web") }
}
const own = (...command: string[]) => {
  const run = Bun.spawnSync(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ownHome, "bin", "own.ps1"), ...command],
    { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  return { code: run.exitCode, stdout: run.stdout.toString().trim(), stderr: run.stderr.toString().trim() }
}

const userData = path.join(root, "desktop-test-root")
mkdirSync(userData, { recursive: true })
const cdp = await freePort()
const shell = Bun.spawn([electron, PACKAGE], {
  env: cleanEnv({ ...env, OPENCODE_DESKTOP_TEST_ROOT: userData, OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdp) }),
  stdout: "ignore",
  stderr: "ignore",
})
report.shell = { pid: shell.pid, cdp, userData }

type Renderer = { source: string; root?: string; uiVersion?: string; reason?: string }
try {
  const { browser, page } = await connect(`http://127.0.0.1:${cdp}`, 120_000)
  try {
    const look = async (label: string) => {
      const app = await page
        .waitForSelector('[data-testid="app"]', { timeout: 90_000 })
        .then(() => true)
        .catch(() => false)
      const renderer = (await page.evaluate(
        () => (window as unknown as { own: { shell: { renderer: Promise<unknown> } } }).own.shell.renderer,
      )) as Renderer
      const expected = pointed()
      report[label] = { url: page.url(), renderer, pointer: expected }
      check(`${label}: own-web loaded (data-testid=app)`, app)
      check(
        `${label}: renderer is the installed web of app\\current.json (${expected.version})`,
        renderer.source === "installed" && renderer.root?.toLowerCase() === expected.web.toLowerCase(),
        renderer,
      )
      return renderer
    }
    await look("start")
    if (args.rollback) {
      for (const step of ["rollback", "forward"]) {
        const result = own("rollback", "--no-prompt", "--force")
        check(`${step}: own rollback`, result.code === 0, result.code === 0 ? result.stdout.split(/\r?\n/)[0] : result.stderr.slice(-400))
        await page.reload()
        await look(step)
      }
    }
  } finally {
    await quitShell(page)
    await browser.close().catch(() => undefined)
  }
} catch (error) {
  check("walkthrough completed", false, error instanceof Error ? error.message : String(error))
} finally {
  const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited) killTree(shell.pid)
  report.shellExit = exited ? "window closed" : "killed"
}
report.checks = checks
const passed = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean)
report.passed = passed
console.log(JSON.stringify(report))
process.exit(passed ? 0 : 1)

// Real-host phase I (04 §13 "MCP", MH 2026-11-26): own.accounts' host-side MCP code on the real Linux host, in an
// isolated test root. Opt-in: OWN_REAL_HOST=build-host (light; lab too). Self-contained: it does not need phase A's
// install and never touches the host's own install, service or config, the user's ssh files or their processes.
//
// - The root is `/tmp/own-<uid>-rh-mcp-<rand>` (z-cleanup's namespace); HOME, XDG_* and TMPDIR point inside it.
// - Uploaded: the release's Linux service program (`opencode` of `linux-x64-baseline.tar.gz`), the driver
//   (mcp-driver.ts bundled for bun) and the tiny fake MCP server shipped in the repo (own-accounts' e2e kit). The
//   program runs both as bun (`BUN_BE_BUN=1`): the driver and the server it installs.
// - Checks: the probe in the login environment (runtimes, docker without sudo, the program as bun), the analysis
//   against it, `~/…` made absolute, the server off without its value and listing its tools with it, the fold's config,
//   no value in the host's file, no fixture process left. Nothing is downloaded (the pre-fetch plans are only read).
// - afterAll removes the root and checks it is gone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ALIAS = process.env.OWN_REAL_HOST ?? ""
const enabled = process.platform === "win32" && ["build-host", "dev-host", "lab"].includes(ALIAS)
const run = enabled ? describe : describe.skip
const SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
/** Windows' own bsdtar (an MSYS tar on PATH would read `D:` as a remote host). */
const TAR = "C:\\Windows\\System32\\tar.exe"
const REPO = path.resolve(import.meta.dir, "../../../..")
const RELEASE = process.env.OWN_REAL_HOST_MCP_RELEASE ?? "D:\\own-integration\\own\\.out\\build\\2.4.1-own.2"
const FIXTURE = path.join(REPO, "packages/own-accounts/test/e2e-kit/fakes/mcp-stdio.ts")
const LOCAL = path.join(os.tmpdir(), "own-real-host-mcp")
const EVIDENCE = path.join(LOCAL, "evidence")

type Json = Record<string, any>

/** One POSIX script on the host through the user's own ssh setup (BatchMode: never a prompt), stdin optional. */
function host(script: string, input?: Buffer, timeoutMs = 300_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(SSH, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ClearAllForwardings=yes", "-T", ALIAS, script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text))
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input ?? Buffer.alloc(0))
  })
}

function results(output: string) {
  return Object.fromEntries(
    output
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^MCPH_([A-Z]+)=(.*)$/.exec(line)
        return match ? [[match[1]!, JSON.parse(match[2]!) as unknown]] : []
      }),
  ) as Json
}

run(`real host ${ALIAS}: MCP servers of this PC on the host (phase I, isolated)`, () => {
  const state = {} as { root: string; out: Json; raw: string }

  beforeAll(async () => {
    fs.rmSync(LOCAL, { recursive: true, force: true })
    fs.mkdirSync(path.join(LOCAL, "upload", "home", "fixture"), { recursive: true })
    fs.mkdirSync(EVIDENCE, { recursive: true })
    const upload = path.join(LOCAL, "upload")
    // The driver, bundled for bun from this checkout's sources.
    const built = spawnSync(
      process.execPath,
      ["build", path.join(import.meta.dir, "mcp-driver.ts"), "--target", "bun", "--outfile", path.join(upload, "driver.js")],
      { encoding: "utf8", windowsHide: true, cwd: REPO },
    )
    if (built.status !== 0) throw new Error(`driver bundle failed: ${built.stderr}`)
    fs.copyFileSync(FIXTURE, path.join(upload, "home", "fixture", "mcp-stdio.ts"))
    // The release's Linux program only (no plugin, no manifest: nothing here is an install).
    const tarball = path.join(RELEASE, "app", "remote", "linux-x64-baseline.tar.gz")
    const extracted = spawnSync(TAR, ["-xzf", tarball, "-C", upload, "opencode"], { windowsHide: true, encoding: "utf8" })
    if (extracted.status !== 0) throw new Error(`extract failed: ${extracted.stderr}`)
    const packed = spawnSync(TAR, ["-czf", path.join(LOCAL, "upload.tgz"), "-C", upload, "opencode", "driver.js", "home"], {
      windowsHide: true,
      encoding: "utf8",
    })
    if (packed.status !== 0) throw new Error(`pack failed: ${packed.stderr}`)
    const made = await host(
      'set -eu; root=$(mktemp -d "/tmp/own-$(id -u)-rh-mcp-XXXXXX"); chmod 700 "$root"; tar -xzf - -C "$root"; chmod 755 "$root/opencode"; mkdir -p "$root/xdg/config" "$root/xdg/data" "$root/xdg/state" "$root/xdg/cache" "$root/tmp"; echo "ROOT=$root"',
      fs.readFileSync(path.join(LOCAL, "upload.tgz")),
    )
    const root = /ROOT=(\S+)/.exec(made.stdout)?.[1]
    if (made.code !== 0 || !root) throw new Error(`upload failed: ${made.stderr}`)
    state.root = root
    // The login environment's PATH (what the host service starts MCP servers with), everything else inside the root.
    const ran = await host(
      [
        "set -u",
        `root='${root}'`,
        'PATH=$(sh -lc \'printf %s "$PATH"\' 2>/dev/null </dev/null || printf %s "$PATH")',
        'env -i PATH="$PATH" HOME="$root/home" XDG_CONFIG_HOME="$root/xdg/config" XDG_DATA_HOME="$root/xdg/data" XDG_STATE_HOME="$root/xdg/state" XDG_CACHE_HOME="$root/xdg/cache" TMPDIR="$root/tmp" BUN_BE_BUN=1 "$root/opencode" "$root/driver.js" "$root/home/fixture/mcp-stdio.ts" 2>"$root/driver.err"',
        'echo "EXIT=$?"',
        'tail -c 2000 "$root/driver.err" | sed "s/^/ERR: /"',
      ].join("\n"),
    )
    state.raw = ran.stdout
    state.out = results(ran.stdout)
    fs.writeFileSync(path.join(EVIDENCE, "driver.txt"), ran.stdout.replaceAll(root, "<root>"))
  }, 600_000)

  afterAll(async () => {
    if (!state.root) return
    const removed = await host(`root='${state.root}'; case "$root" in /tmp/own-"$(id -u)"-rh-mcp-*) rm -rf "$root";; esac; [ -e "$root" ] && echo LEFT || echo GONE`)
    expect(removed.stdout).toContain("GONE")
    fs.rmSync(path.join(LOCAL, "upload"), { recursive: true, force: true })
    fs.rmSync(path.join(LOCAL, "upload.tgz"), { force: true })
  }, 120_000)

  test("the driver ran to its end", () => {
    expect(state.raw).toContain("EXIT=0")
  })

  test("the probe reads the host's login environment: OS, architecture, runtimes, docker access, the program as bun", () => {
    const probe = state.out.PROBE as Json
    expect(probe.os).toStartWith("linux")
    expect(["x64", "arm64"]).toContain(probe.arch)
    expect(probe.home).toBe(`${state.root}/home`)
    expect(probe.ownBun?.command).toBe(`${state.root}/opencode`)
    expect(probe.binaries).toMatchObject({ "surely-not-installed-xyz": false })
    // docker either answers without sudo or is denied; never asked with sudo.
    if (probe.runtimes.docker) expect(["ok", "denied"]).toContain(probe.containers?.docker)
    evidenceProbe(probe)
  })

  test("the analysis against the real probe: Windows stays on the PC, a mapped folder, bunx via the program as bun", () => {
    const rows = state.out.ANALYSIS as Json[]
    const by = (name: string) => rows.find((row) => row.name === name)!
    expect(by("win").result).toBe("pc-only")
    expect(by("files").host?.args?.[2]).toBe("~/projects")
    const probe = state.out.PROBE as Json
    expect(by("memory").result).toBe(probe.runtimes.npx ? "ready" : "prepare")
    // `uv tool run` stands in for uvx on a host with uv alone.
    expect(by("fetch").result).toBe(probe.runtimes.uvx || probe.runtimes.uv ? "ready" : "prepare")
    if (!probe.runtimes.bun) expect(by("bunx").host).toMatchObject({ command: `${state.root}/opencode`, fixed: { BUN_BE_BUN: "1" } })
    expect(by("gh").result).toBe(probe.binaries["github-mcp-server"] ? "ready" : "assist")
  })

  test("installed with `~/…`: off without its value, its tools with it; no value in the host's file; nothing left", () => {
    expect(state.out.SAVED.args[0]).toBe(`${state.root}/home/fixture/mcp-stdio.ts`)
    expect(state.out.SAVED.values).toBe("missing")
    expect(state.out.MISSING).toMatchObject({ ok: false, failure: "exited" })
    expect(state.out.SENT).toMatchObject({ ok: true, tools: [{ name: "lookup" }, { name: "summarize" }] })
    expect(state.out.VIEW).toEqual({ values: "ready", check: true })
    expect(state.out.FOLD).toEqual({
      command: [`${state.root}/opencode`, `${state.root}/home/fixture/mcp-stdio.ts`, "lookup", "summarize"],
      env: ["API_KEY", "BUN_BE_BUN", "FAKE_MCP_REQUIRE"],
      valueInFile: false,
    })
    expect(state.out.PREFETCH.npx.kind).toBe("npm")
    expect(state.out.LEFT).toBe(0)
  })
})

/** The probe's runtimes and versions as evidence (no path of the user's home: the root's paths are replaced). */
function evidenceProbe(probe: Json) {
  fs.writeFileSync(path.join(EVIDENCE, "probe.json"), JSON.stringify(probe, null, 2))
}

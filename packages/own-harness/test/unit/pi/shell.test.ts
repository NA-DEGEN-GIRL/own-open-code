// Pi 1.4.0's shell fixes in src/pi/shell.ts. Cases follow packages/coding-agent/test/shell-path-exists.test.ts,
// windows-shell-config.test.ts and shell-kill-process-tree.test.ts, but on the real file system and real processes
// instead of Pi's module mocks: a Store alias where this PC has one, Git Bash found through ProgramFiles, the legacy
// WSL launcher under %SystemRoot%, and a cancelled `a; b` that never starts b (#11252).
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PiShell } from "../../../src/pi/shell.js"

const NAMES = ["PATH", "ProgramFiles", "ProgramFiles(x86)", "SystemRoot"] as const
const state = { dir: "", saved: {} as Partial<Record<(typeof NAMES)[number], string | undefined>> }

beforeEach(() => {
  state.dir = path.join(tmpdir(), `own-pi-shell-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(state.dir, { recursive: true })
  state.saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))
})

afterEach(() => {
  NAMES.forEach((name) => setEnv(name, state.saved[name]))
  rmSync(state.dir, { recursive: true, force: true })
})

/** Windows Store app execution aliases of this PC (reparse points `existsSync` can reject in Node). */
const APPS = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps")
const ALIASES =
  process.platform === "win32" && existsSync(APPS)
    ? readdirSync(APPS)
        .filter((name) => name.toLowerCase().endsWith(".exe"))
        .map((name) => path.join(APPS, name))
    : []
const BASH_ALIAS = ALIASES.find((alias) => path.basename(alias).toLowerCase() === "bash.exe")

describe("shell existence checks", () => {
  test("a file and a folder exist; a missing path does not", () => {
    writeFileSync(path.join(state.dir, "bash.exe"), "")
    expect(PiShell.pathExists(path.join(state.dir, "bash.exe"))).toBe(true)
    expect(PiShell.pathExists(state.dir)).toBe(true)
    expect(PiShell.pathExists(path.join(state.dir, "missing.exe"))).toBe(false)
  })

  test.skipIf(ALIASES.length === 0)("a Windows Store alias is accepted", () => {
    expect(ALIASES.every((alias) => PiShell.pathExists(alias))).toBe(true)
  })

  test.skipIf(BASH_ALIAS === undefined)("bash.exe found on PATH as a Store alias is the shell", () => {
    setEnv("ProgramFiles", path.join(state.dir, "none"))
    setEnv("ProgramFiles(x86)", undefined)
    setEnv("PATH", [APPS, path.join(state.saved.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter))
    expect(PiShell.bashConfig()).toEqual({ shell: BASH_ALIAS!, args: ["-c"], stdin: false })
  })

  test.skipIf(process.platform !== "win32")("Git Bash under ProgramFiles, then ProgramFiles(x86)", () => {
    const install = (root: string) => {
      mkdirSync(path.join(state.dir, root, "Git", "bin"), { recursive: true })
      writeFileSync(path.join(state.dir, root, "Git", "bin", "bash.exe"), "")
      return path.join(state.dir, root, "Git", "bin", "bash.exe")
    }
    const x86 = install("x86")
    setEnv("ProgramFiles", path.join(state.dir, "none"))
    setEnv("ProgramFiles(x86)", path.join(state.dir, "x86"))
    expect(PiShell.bashConfig()).toEqual({ shell: x86, args: ["-c"], stdin: false })
    const main = install("main")
    setEnv("ProgramFiles", path.join(state.dir, "main"))
    expect(PiShell.bashConfig().shell).toBe(main)
  })
})

// #9490: the legacy WSL launcher is identified under the actual Windows folder.
describe("legacy WSL bash detection", () => {
  test.each([
    ["D:\\WinNT\\", "d:/WINNT/System32/BASH.EXE", true],
    ["D:\\WinNT", "D:\\WinNT\\Sysnative\\bash.exe", true],
    [undefined, "E:\\Windows\\System32\\bash.exe", true],
    ["D:\\WinNT", "D:\\Git\\bin\\bash.exe", false],
    ["D:\\WinNT", "E:\\Windows\\System32\\bash.exe", false],
    ["WinNT", "C:\\Windows\\System32\\bash.exe", false],
  ] as const)("SystemRoot %j: %j reads stdin = %j", (root, shell, stdin) => {
    setEnv("SystemRoot", root)
    expect(PiShell.config(shell)).toEqual(
      stdin ? { shell, args: ["-s"], stdin: true } : { shell, args: ["-c"], stdin: false },
    )
  })
})

describe("windowsGuidelines (own's <rules> line, 12 §3.6)", () => {
  const found =
    (shell: string, stdin = false) =>
    () => ({ shell, args: stdin ? ["-s"] : ["-c"], stdin })

  test("names Git Bash, the WSL launcher or the bash found; nothing elsewhere or without a bash", () => {
    expect(PiShell.windowsGuidelines("win32", found("C:\\Program Files\\Git\\bin\\bash.exe"))).toEqual([
      "On Windows the bash tool runs Git Bash, not PowerShell: use bash syntax and POSIX commands (ls, cat, rg); PowerShell cmdlets such as Get-ChildItem do not work in it",
    ])
    expect(PiShell.windowsGuidelines("win32", found("D:/tools/git/usr/bin/bash.exe"))[0]).toContain("runs Git Bash,")
    expect(PiShell.windowsGuidelines("win32", found("C:\\Windows\\System32\\bash.exe", true))[0]).toContain(
      "runs WSL's bash,",
    )
    expect(PiShell.windowsGuidelines("win32", found("C:\\msys64\\usr\\bin\\bash.exe"))[0]).toContain(
      "runs bash (C:\\msys64\\usr\\bin\\bash.exe),",
    )
    expect(PiShell.windowsGuidelines("linux", found("/bin/bash"))).toEqual([])
    expect(
      PiShell.windowsGuidelines("win32", () => {
        throw new Error("No bash shell found.")
      }),
    ).toEqual([])
  })

  test.skipIf(process.platform !== "win32")("this PC's own lookup gives the line Pi requests carry", () => {
    expect(PiShell.windowsGuidelines()).toEqual(PiShell.windowsGuidelines("win32", PiShell.bashConfig))
  })
})

describe("killProcessTree", () => {
  test("a cancelled `a; b` never starts b", async () => {
    await expect(
      PiShell.run("sleep 2; echo after > after.txt", state.dir, { onData: () => {}, timeout: 0.3 }),
    ).rejects.toThrow("timeout:0.3")
    await Bun.sleep(2500)
    expect(existsSync(path.join(state.dir, "after.txt"))).toBe(false)
  }, 30_000)
})

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

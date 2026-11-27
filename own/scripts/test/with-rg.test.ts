// with-rg.ts on temp folders: OWN_RG_DIR, then rg on PATH, then VS Code's bundled copy; none is undefined and stops
// the run, and a found folder leads the command's PATH. Run from own/scripts/test: `bun test ./with-rg.test.ts`.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { rgDir } from "./with-rg"

const EXE = process.platform === "win32" ? "rg.exe" : "rg"
const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-with-rg-"))
setDefaultTimeout(60_000)
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const rg = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, EXE), "")
  fs.chmodSync(path.join(dir, EXE), 0o755)
  return dir
}

test("OWN_RG_DIR first, then VS Code's copy in a system or user install; nothing found is undefined", () => {
  const own = rg(path.join(root, "own"))
  const empty = path.join(root, "empty")
  fs.mkdirSync(empty, { recursive: true })
  expect(rgDir({ OWN_RG_DIR: own, PATH: empty })).toBe(own)

  const system = path.join(root, "pf")
  const bundled = rg(
    path.join(
      system,
      "Microsoft VS Code",
      "7debcd0e2a",
      "resources",
      "app",
      "node_modules.asar.unpacked",
      "@vscode",
      "ripgrep-universal",
      "bin",
      "win32-x64",
    ),
  )
  expect(rgDir({ ProgramFiles: system, PATH: empty })).toBe(bundled)

  const user = path.join(root, "local")
  const flat = rg(
    path.join(
      user,
      "Programs",
      "Microsoft VS Code",
      "resources",
      "app",
      "node_modules.asar.unpacked",
      "@vscode",
      "ripgrep",
      "bin",
    ),
  )
  expect(rgDir({ LOCALAPPDATA: user, PATH: empty })).toBe(flat)
  expect(rgDir({ PATH: empty, ProgramFiles: empty, LOCALAPPDATA: empty })).toBeUndefined()
})

test("the command runs with the folder first on PATH; with none it stops before running anything", async () => {
  const own = rg(path.join(root, "run"))
  const probe = path.join(root, "probe.ts")
  fs.writeFileSync(probe, "console.log(process.env.PATH)\n")
  const script = path.join(import.meta.dir, "with-rg.ts")
  const ran = Bun.spawnSync([process.execPath, script, "bun", probe], {
    env: { ...process.env, OWN_RG_DIR: own },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(ran.exitCode).toBe(0)
  expect(ran.stdout.toString().trim().split(path.delimiter)[0]).toBe(own)

  const empty = path.join(root, "none")
  fs.mkdirSync(empty, { recursive: true })
  const stopped = Bun.spawnSync([process.execPath, script, "bun", probe], {
    env: { PATH: empty, ProgramFiles: empty, LOCALAPPDATA: empty, SystemRoot: process.env.SystemRoot ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(stopped.exitCode).toBe(3)
  expect(stopped.stdout.toString()).toBe("")
})

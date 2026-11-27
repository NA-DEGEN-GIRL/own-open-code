// ProcessTree (P1-14a): an abort or the time limit ends a child together with everything it started, and the result
// says which of the two ended it. The tree is a shell (`cmd.exe` on Windows, `sh` elsewhere) running a Bun script that
// writes its pid to a file and keeps running. A shell, not Bun, sits in the middle: Bun ends its own children when it
// dies, which would hide a missed grandchild. On Windows also the acceptance case `cmd /d /s /c "ping -n 30
// 127.0.0.1"`, its ping found through Win32_Process.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ProcessTree } from "../src/index.js"
import { removeTree } from "./fixture.js"

const SLOW = 30_000

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-process-tree-")))
afterAll(() => removeTree(root))

/** `<pid file>`: writes its pid there and keeps running for a minute. */
const SLEEPER = path.join(root, "sleeper.js")
fs.writeFileSync(
  SLEEPER,
  [
    `const fs = require("node:fs")`,
    `const file = process.argv[2]`,
    `fs.writeFileSync(file + ".tmp", String(process.pid))`,
    `fs.renameSync(file + ".tmp", file)`,
    `setTimeout(() => process.exit(0), 60_000)`,
  ].join("\n"),
)

const quiet = { stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const

/** A shell running the sleeper, and the sleeper's pid once it runs. */
function tree(name: string) {
  const file = path.join(root, `${name}.pid`)
  const child =
    process.platform === "win32"
      ? Bun.spawn(
          [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `""${process.execPath}" "${SLEEPER}" "${file}""`],
          { ...ProcessTree.SPAWN, ...quiet, windowsVerbatimArguments: true },
        )
      : Bun.spawn(["sh", "-c", `"$0" "$1" "$2" & wait`, process.execPath, SLEEPER, file], {
          ...ProcessTree.SPAWN,
          ...quiet,
        })
  return {
    child,
    grandchild: () => until(() => (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : undefined)),
  }
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  deadline = Date.now() + 15_000,
): Promise<T> {
  const value = await read()
  if (value !== undefined) return value
  if (Date.now() > deadline) throw new Error("not seen in time")
  await Bun.sleep(50)
  return until(read, deadline)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A killed process can linger a moment (a POSIX zombie until it is reaped). */
const gone = (pid: number) => until(() => (alive(pid) ? undefined : true), Date.now() + 5_000)

describe("ProcessTree", () => {
  test(
    "an abort ends the child and its descendants; the result names the signal",
    async () => {
      const started = tree("abort")
      const grandchild = await started.grandchild()
      const stop = new AbortController()
      const ended = ProcessTree.exited(started.child, { signal: stop.signal, timeoutMs: 60_000 })
      stop.abort()
      const result = await ended
      expect(result.stop).toBe("signal")
      expect(result.code).not.toBe(0)
      expect(await gone(grandchild)).toBe(true)
    },
    SLOW,
  )

  test(
    "the time limit ends the tree and says so",
    async () => {
      const started = tree("timeout")
      const grandchild = await started.grandchild()
      const result = await ProcessTree.exited(started.child, { timeoutMs: 200 })
      expect(result.stop).toBe("timeout")
      expect(result.code).not.toBe(0)
      expect(await gone(grandchild)).toBe(true)
    },
    SLOW,
  )

  test(
    "a signal that already aborted ends the child at once",
    async () => {
      const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
        ...ProcessTree.SPAWN,
        ...quiet,
      })
      expect(await ProcessTree.exited(child, { signal: AbortSignal.abort(), timeoutMs: 60_000 })).toMatchObject({
        stop: "signal",
      })
    },
    SLOW,
  )

  test(
    "a child that ends by itself keeps its code and no stop; killing it afterwards does nothing",
    async () => {
      const child = Bun.spawn([process.execPath, "-e", "process.exit(3)"], { ...ProcessTree.SPAWN, ...quiet })
      const stop = new AbortController()
      const result = await ProcessTree.exited(child, { signal: stop.signal, timeoutMs: 60_000 })
      expect(result).toEqual({ code: 3, stop: undefined })
      stop.abort()
      await ProcessTree.kill(child)
      expect(child.exitCode).toBe(3)
    },
    SLOW,
  )

  test(
    "control: killing only the direct child leaves the grandchild running",
    async () => {
      const started = tree("direct")
      const grandchild = await started.grandchild()
      started.child.kill("SIGKILL")
      await started.child.exited
      await Bun.sleep(300)
      expect(alive(grandchild)).toBe(true)
      process.kill(grandchild, "SIGKILL")
      expect(await gone(grandchild)).toBe(true)
    },
    SLOW,
  )

  test.skipIf(process.platform !== "win32")(
    'Windows: an abort of cmd /d /s /c "ping -n 30 127.0.0.1" leaves no ping process',
    async () => {
      const child = Bun.spawn([process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", '"ping -n 30 127.0.0.1"'], {
        ...ProcessTree.SPAWN,
        ...quiet,
        windowsVerbatimArguments: true,
      })
      const ping = await until(() => pingOf(child.pid))
      const stop = new AbortController()
      const ended = ProcessTree.exited(child, { signal: stop.signal, timeoutMs: 60_000 })
      stop.abort()
      expect((await ended).stop).toBe("signal")
      expect(await gone(ping)).toBe(true)
      expect(await pingOf(child.pid)).toBeUndefined()
    },
    SLOW,
  )
})

/** The pid of the `PING.EXE` whose parent is `parent`, through Windows PowerShell's Win32_Process. */
async function pingOf(parent: number) {
  const shell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const query = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='PING.EXE'" | ForEach-Object { $_.ProcessId }`
  const proc = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-Command", query], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  const pid = Number((await new Response(proc.stdout).text()).trim().split(/\s+/)[0])
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

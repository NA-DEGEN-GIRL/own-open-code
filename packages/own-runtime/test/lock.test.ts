import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Lock } from "../src/index.js"
import { tmpdir } from "./fixture.js"

// Windows PowerShell can take seconds to start on a loaded machine.
const SLOW = 30_000

// On Windows, a lease removed while another process still has it open stays delete-pending, and an exclusive
// create of the same name fails with EPERM until that handle closes. The reader handle held here plays that process.
describe.skipIf(process.platform !== "win32")("Lock with a delete-pending lease file (Windows)", () => {
  test(
    "acquire waits out the pending delete instead of throwing EPERM",
    async () => {
      await using dir = await tmpdir()
      const file = path.join(dir.path, "registry.lock")
      await using reader = await deletePending(file)
      setTimeout(() => void reader.close(), 150)
      const lease = await Lock.acquire(file, { timeoutMs: 5_000 })
      expect(lease.pid).toBe(process.pid)
      expect(await Lock.release(file, lease)).toBe(true)
      expect(await fs.readdir(dir.path)).toEqual([])
    },
    SLOW,
  )

  test(
    "a lease that stays delete-pending still ends at the deadline",
    async () => {
      await using dir = await tmpdir()
      const file = path.join(dir.path, "registry.lock")
      await using reader = await deletePending(file)
      await expect(Lock.acquire(file, { timeoutMs: 100 })).rejects.toBeInstanceOf(Lock.TimeoutError)
      await reader.close()
      await Lock.release(file, await Lock.acquire(file, { timeoutMs: 100 }))
    },
    SLOW,
  )

  test(
    "a delete-pending breaker delays breaking a stale lease instead of failing it",
    async () => {
      await using dir = await tmpdir()
      const file = path.join(dir.path, "registry.lock")
      const now = Date.now()
      await fs.writeFile(
        file,
        JSON.stringify({ pid: process.pid, startedAt: now - 120_000, until: now - 60_000, token: "expired" }),
      )
      await using reader = await deletePending(`${file}.breaker`)
      setTimeout(() => void reader.close(), 150)
      const lease = await Lock.acquire(file, { timeoutMs: 5_000 })
      expect(JSON.parse(await fs.readFile(file, "utf8")).token).toBe(lease.token)
      expect(await fs.readdir(dir.path)).toEqual(["registry.lock"])
      await Lock.release(file, lease)
    },
    SLOW,
  )
})

/**
 * Writes a live lease to `file` and leaves it delete-pending: Windows PowerShell opens it delete-on-close and closes
 * it while the returned handle stays open. Closing that handle completes the delete.
 */
async function deletePending(file: string) {
  const now = Date.now()
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: now, until: now + 60_000, token: "other" }))
  const reader = await fs.open(file, "r")
  const shell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  // Every argument is typed: with plain strings PowerShell picks the `bool useAsync` overload and nothing is deleted.
  const script = `[IO.FileStream]::new('${file.replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete', 1, [IO.FileOptions]::DeleteOnClose).Dispose()`
  const run = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true })
  if (run.exitCode !== 0) throw new Error(`powershell failed: ${run.stderr.toString()}`)
  // The race state itself: the name is still listed, yet an exclusive create is refused.
  expect(await fs.readdir(path.dirname(file))).toContain(path.basename(file))
  await expect(fs.open(file, "wx")).rejects.toMatchObject({ code: "EPERM" })
  return reader
}

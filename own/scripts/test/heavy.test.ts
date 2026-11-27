// heavy.ts on a temp lock file: the command runs under the lock with its arguments intact, a dead holder's lock is
// taken over, and a live holder is waited for. Run from own/scripts/test: `bun test ./heavy.test.ts`.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HEAVY = path.join(import.meta.dir, "heavy.ts")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-heavy-"))
const lock = path.join(root, "heavy.lock")
const probe = path.join(root, "probe.ts")
fs.writeFileSync(
  probe,
  `import fs from "node:fs"
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  exec: process.execPath,
  held: process.env.OWN_HEAVY_LOCK_HELD,
  lock: JSON.parse(fs.readFileSync(${JSON.stringify(lock)}, "utf8")),
}))
`,
)
// Each test starts heavy.ts and a bun child; a cold transpiler cache alone took seconds.
setDefaultTimeout(60_000)
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

test("a leading bun runs as heavy's own bun under the lock, a name filter with a space and a | intact", async () => {
  const result = await heavy(["bun", probe, "-t", "refs to|kill"])
  // Through `bun` on PATH (WinGet's bun.cmd on this PC) Bun refused the `|` for a .cmd: ERR_INVALID_ARG_VALUE.
  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  const seen = JSON.parse(result.stdout)
  expect(seen.argv).toEqual(["-t", "refs to|kill"])
  expect(seen.exec).toBe(process.execPath)
  expect(seen.lock.pid).toBe(Number(seen.held))
  expect(seen.lock.label).toContain("refs to|kill")
  expect(fs.existsSync(lock)).toBe(false)
})

test("the lock of a holder that is gone is taken over", async () => {
  const gone = Bun.spawn([process.execPath, "-e", "0"])
  await gone.exited
  fs.writeFileSync(lock, JSON.stringify({ pid: gone.pid, started: Date.now(), label: "a run that died" }))
  const result = await heavy(["bun", "-e", "0"])
  expect(result.code).toBe(0)
  expect(result.stderr).toContain(`taking over the lock of pid ${gone.pid}, which is gone (a run that died)`)
  expect(fs.existsSync(lock)).toBe(false)
})

test("a live holder is waited for, then the lock is taken", async () => {
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: Date.now(), label: "this test" }))
  // The lock goes once heavy.ts reports waiting for it, not after a fixed time: on a cold transpiler cache heavy.ts took
  // seconds to reach its wait loop, and a lock removed before that is simply claimed. It then sleeps 2 s before trying
  // again, so the claim that follows is always over a second after the first try.
  const waiting = `waiting for ${lock}, held by pid ${process.pid}`
  const result = await heavy(["bun", "-e", "0"], { text: waiting, then: () => fs.rmSync(lock) })
  expect(result.code).toBe(0)
  expect(result.stderr).toContain(waiting)
  expect(result.stderr).not.toContain("taking over")
  expect(result.stderr).toMatch(/lock taken after \d+ s/)
  expect(fs.existsSync(lock)).toBe(false)
})

/** Runs heavy.ts on the temp lock; `seen.then` runs once, as soon as its stderr holds `seen.text`. */
async function heavy(command: string[], seen?: { text: string; then: () => void }) {
  const env: Record<string, string | undefined> = { ...process.env, OWN_HEAVY_LOCK: lock }
  delete env.OWN_HEAVY_LOCK_HELD
  const child = Bun.spawn([process.execPath, HEAVY, ...command], { env, stdout: "pipe", stderr: "pipe" })
  const decoder = new TextDecoder()
  const errors: string[] = []
  const reading = (async () => {
    for await (const chunk of child.stderr) {
      const before = errors.join("")
      errors.push(decoder.decode(chunk, { stream: true }))
      if (seen && !before.includes(seen.text) && errors.join("").includes(seen.text)) seen.then()
    }
  })()
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited, reading])
  return { code, stdout, stderr: errors.join("") }
}

test("waiters take the lock in arrival order; a run started later queues behind them", async () => {
  const order = path.join(root, "order.txt")
  fs.rmSync(order, { force: true })
  const step = (name: string) => [
    "bun",
    "-e",
    `require("node:fs").appendFileSync(${JSON.stringify(order)}, "${name} "); await Bun.sleep(1500)`,
  ]
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: Date.now(), label: "this test" }))
  const first = heavy(step("first"))
  await until(() => tickets() === 1)
  const second = heavy(step("second"))
  await until(() => tickets() === 2)
  fs.rmSync(lock)
  // Like a session that runs its next suite as soon as one ends: it arrives while `first` runs, after `second`.
  await until(() => fs.existsSync(order))
  const late = heavy(step("late"))
  const results = await Promise.all([first, second, late])
  expect(results.map((result) => result.code)).toEqual([0, 0, 0])
  expect(fs.readFileSync(order, "utf8").trim()).toBe("first second late")
  expect(tickets()).toBe(0)
  expect(fs.existsSync(lock)).toBe(false)
})

test("a holder from an older heavy.ts (no ticket) is waited for, never shared, and a dead or stale ticket is skipped", async () => {
  // A ticket ahead whose process is gone, and one of a live process that stopped touching it 31 s ago.
  const gone = Bun.spawn([process.execPath, "-e", "0"])
  await gone.exited
  fs.mkdirSync(`${lock}.queue`, { recursive: true })
  fs.writeFileSync(path.join(`${lock}.queue`, `000000000000001-${gone.pid}.ticket`), "{}")
  const stale = path.join(`${lock}.queue`, `000000000000002-${process.pid}.ticket`)
  fs.writeFileSync(stale, "{}")
  const old = new Date(Date.now() - 31_000)
  fs.utimesSync(stale, old, old)
  // An older heavy.ts's run holds the lock file; this one waits at the head of the queue and claims after it.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: Date.now(), label: "an older heavy.ts" }))
  const waiting = `waiting for ${lock}, held by pid ${process.pid}`
  const result = await heavy(["bun", probe], { text: waiting, then: () => fs.rmSync(lock) })
  expect(result.code).toBe(0)
  expect(result.stderr).toContain(`${waiting} for 0 min (an older heavy.ts); next`)
  const seen = JSON.parse(result.stdout)
  expect(seen.lock.pid).toBe(Number(seen.held))
  expect(tickets()).toBe(0)
})

function tickets() {
  try {
    return fs.readdirSync(`${lock}.queue`).filter((name) => name.endsWith(".ticket")).length
  } catch {
    return 0
  }
}

async function until(probe: () => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(50)
  }
}
// Runs one heavy test command (a full unit run, an e2e tier, a Playwright pass) under a machine-wide lock, so two
// heavy suites never share this PC's CPU. Stacked suites turned load into false timeouts and 40–190 min reruns
// (2026-10-29, test-speed). Usage, from a package directory (as the package scripts start it):
//
//   "$npm_execpath" ../../own/scripts/test/heavy.ts bun test --parallel=3 test/e2e
//
// A leading `bun` runs as this process's own executable, and the package scripts start bun as `"$npm_execpath"` (the bun
// that runs `bun run`), never by name: on this PC `bun` on PATH is the WinGet Node folder's `bun.cmd`. Bun refuses to
// hand a .cmd an argument with a cmd.exe special character (`-t "enable|split"`: ERR_INVALID_ARG_VALUE), and `bun run`'s
// shell sent it one with a space through cmd.exe, which failed (`-t "refs to"`: 'C:\Program' is not recognized).
//
// Waiters print who holds the lock once a minute. A lock whose holder process is gone is taken over. The lock is a
// file (`C:/t/locks/heavy-test.lock`, or `OWN_HEAVY_LOCK`), created exclusively and removed on exit. Nested calls
// (the child of a heavy run starting another one) pass through, and `OWN_HEAVY_LOCK=off` skips the lock entirely.
//
// Waiters take turns in arrival order (2026-11-23): each one leaves a ticket in `<lock>.queue/` and tries the lock only
// while its ticket is the oldest live one, so a session that runs suites back to back can no longer take the lock again
// ahead of a waiter that has been there for an hour (its next run queues behind). A ticket is live while its process is
// and it was touched in the last 30 s (every waiter touches its own each round), so a crashed or stuck waiter cannot
// block the queue. The lock file itself is unchanged: it alone decides who holds the lock (`wx`), so a waiter of an older
// heavy.ts, which knows no queue, can still take a free lock between two queued runs, but two never hold it at once and
// nobody waits on a ticket forever.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const command = process.argv.slice(2)
if (command.length === 0) {
  console.error("usage: bun own/scripts/test/heavy.ts <command> [args...]")
  process.exit(2)
}

/** A ticket untouched for longer than this belongs to a waiter that stopped waiting. */
const TICKET_STALE_MS = 30_000

const setting = process.env.OWN_HEAVY_LOCK
const file =
  setting && setting !== "off"
    ? setting
    : process.platform === "win32"
      ? "C:/t/locks/heavy-test.lock"
      : path.join(os.tmpdir(), "own-locks", "heavy-test.lock")
const queue = `${file}.queue`
const nested = setting === "off" || process.env.OWN_HEAVY_LOCK_HELD !== undefined
const label = `${path.basename(process.cwd())}: ${command.join(" ")}`

if (!nested) await acquire()
const started = Date.now()
const child = Bun.spawn({
  cmd: command[0] === "bun" ? [process.execPath, ...command.slice(1)] : command,
  env: { ...process.env, OWN_HEAVY_LOCK_HELD: String(process.pid) },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const interrupt = () => child.kill("SIGINT")
const terminate = () => child.kill("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)
const code = await child.exited
if (!nested) release()
console.error(`heavy: ${label} exited ${code} after ${Math.round((Date.now() - started) / 1000)} s`)
process.exit(code)

async function acquire() {
  fs.mkdirSync(queue, { recursive: true })
  const ticket = path.join(queue, `${String(Date.now()).padStart(15, "0")}-${process.pid}.ticket`)
  fs.writeFileSync(ticket, JSON.stringify({ pid: process.pid, started: Date.now(), label }))
  // A waiter stopped by Ctrl+C or a kill of its parent leaves no ticket behind (a hard kill's is skipped once stale).
  const drop = () => fs.rmSync(ticket, { force: true })
  process.once("exit", drop)
  const since = Date.now()
  const report = { at: 0, waited: false }
  while (true) {
    touch(ticket)
    const ahead = waitersAhead(ticket)
    if (ahead.length === 0) {
      if (claim()) {
        drop()
        if (report.waited) console.error(`heavy: lock taken after ${Math.round((Date.now() - since) / 1000)} s`)
        return
      }
      const holder = readHolder()
      if (holder && !alive(holder.pid)) {
        console.error(`heavy: taking over the lock of pid ${holder.pid}, which is gone (${holder.label})`)
        fs.rmSync(file, { force: true })
        continue
      }
    }
    report.waited = true
    if (Date.now() - report.at >= 60_000) {
      report.at = Date.now()
      const holder = readHolder()
      const age = holder ? `${Math.round((Date.now() - holder.started) / 60_000)} min` : "?"
      const place = ahead.length === 0 ? "next" : `${ahead.length} ahead in the queue`
      console.error(
        `heavy: waiting for ${file}, held by pid ${holder?.pid ?? "?"} for ${age} (${holder?.label ?? "?"}); ${place}`,
      )
    }
    // The head of the queue looks often, so a free lock goes to it before a waiter of an older heavy.ts sees it.
    await Bun.sleep(ahead.length === 0 ? 100 : 1000)
  }
}

/** The live tickets older than `ticket`; dead or stale ones are removed on the way. */
function waitersAhead(ticket: string) {
  const mine = path.basename(ticket)
  const names = (() => {
    try {
      return fs.readdirSync(queue).filter((name) => name.endsWith(".ticket"))
    } catch {
      return []
    }
  })()
  return names
    .toSorted()
    .filter((name) => name < mine)
    .filter((name) => {
      const full = path.join(queue, name)
      const pid = Number(name.slice(name.indexOf("-") + 1, -".ticket".length))
      const fresh = (() => {
        try {
          return Date.now() - fs.statSync(full).mtimeMs < TICKET_STALE_MS
        } catch {
          return false
        }
      })()
      if (fresh && alive(pid)) return true
      fs.rmSync(full, { force: true })
      return false
    })
}

function touch(ticket: string) {
  const now = new Date()
  try {
    fs.utimesSync(ticket, now, now)
  } catch {
    // Removed as stale by another waiter after a long pause of this one: written again under its old name, so it keeps
    // its place.
    fs.writeFileSync(ticket, JSON.stringify({ pid: process.pid, started: Date.now(), label }))
  }
}

function claim() {
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: Date.now(), label }), { flag: "wx" })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

function readHolder() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; started: number; label: string }
  } catch {
    // Removed between the claim and the read, or half written: the next round decides.
    return undefined
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function release() {
  if (readHolder()?.pid === process.pid) fs.rmSync(file, { force: true })
}

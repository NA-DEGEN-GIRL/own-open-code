// A stand-in for Claude Code's native updater (UCP 2026-11-08), never the real one: `--version` prints the version it
// last "installed"; `update` prints what 2.1.282's `claude update` printed, then downloads nothing but writes
// `<version>.tmp.<pid>.<ms>.0` in `~/.local/share/claude/versions` (beside the empty `<version>` the real updater
// leaves first) in two parts, waiting for `fake-claude-continue` in its home between them, renames it to `<version>`
// and exits 0. Its home is the USERPROFILE/HOME the test gives the update's environment.
import fs from "node:fs/promises"
import path from "node:path"

const FROM = "2.1.282"
const TO = "2.1.319"
/** The first part, then the rest: 1 MiB and 3 MiB in all. */
const PART = 1024 * 1024
const WAIT_MS = 30_000

const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
const marker = path.join(home, "fake-claude-version.txt")
const installed = await Bun.file(marker)
  .text()
  .catch(() => FROM)

if (process.argv[2] === "--version") {
  console.log(`${installed.trim()} (Claude Code)`)
  process.exit(0)
}
if (process.argv[2] !== "update") process.exit(2)

console.log(`Current version: ${installed.trim()}`)
console.log("Checking for updates to latest version...")
console.log(`Updating to ${TO}...`)
const versions = path.join(home, ".local", "share", "claude", "versions")
await fs.mkdir(versions, { recursive: true })
await Bun.write(path.join(versions, TO), "")
const temporary = path.join(versions, `${TO}.tmp.${process.pid}.${Date.now()}.0`)
await fs.writeFile(temporary, new Uint8Array(PART))
const deadline = Date.now() + WAIT_MS
while (!(await Bun.file(path.join(home, "fake-claude-continue")).exists())) {
  if (Date.now() > deadline) process.exit(7)
  await Bun.sleep(20)
}
await fs.appendFile(temporary, new Uint8Array(2 * PART))
await fs.rename(temporary, path.join(versions, TO))
await Bun.write(marker, TO)
console.log(`Successfully updated from ${FROM} to version ${TO}`)
process.exit(0)

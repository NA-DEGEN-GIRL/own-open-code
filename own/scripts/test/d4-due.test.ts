// d4-due.ts on a temp repository: due with no record, after a week, and after a relay, egress, broker or P-018 change;
// not due after a change elsewhere or to a P-018 test. Run from own/scripts/test: `bun test ./d4-due.test.ts`.
import "./git-env.ts"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SCRIPT = path.join(import.meta.dir, "d4-due.ts")
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "own-d4-due-"))
const record = path.join(repo, "own", ".out", "test", "d4-full.pass")
// Each test runs the script several times, a second or more each under load.
setDefaultTimeout(60_000)
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

git("init", "-q", "-b", "main")
write({
  ".gitignore": "own/.out/\n",
  "own/ledger/core-patches.yaml": [
    "- id: P-017",
    "  files:",
    "    - path: packages/core/src/other.ts",
    "- id: P-018",
    "  files:",
    "    - path: packages/ai/src/route/client.ts",
    "    - path: packages/ai/test/stream-progress.test.ts",
    "",
  ].join("\n"),
  "packages/own-accounts/src/broker/egress.ts": "export const egress = 1\n",
  "packages/own-remote/src/ssh/tunnel.ts": "export const tunnel = 1\n",
  "packages/ai/src/route/client.ts": "export const client = 1\n",
  "packages/ai/test/stream-progress.test.ts": "export const progress = 1\n",
  "packages/core/src/other.ts": "export const other = 1\n",
  "packages/own-web/src/app.ts": "export const app = 1\n",
})
commit("base")

test("due with no full pass on record, not due right after one is recorded", () => {
  expect(run()).toContain("due (no full pass on record in own/.out/test/d4-full.pass)")
  expect(run("--ms").trim()).toBe("1200000")
  expect(run("--record")).toContain(`recorded a full D4 pass at ${git("rev-parse", "HEAD").trim()}`)
  expect(run()).toContain("d4-due: not due (the last full pass at")
  expect(run("--ms").trim()).toBe("360000")
})

test("a change elsewhere, to another patch or to a P-018 test keeps it not due", () => {
  run("--record")
  write({
    "packages/own-web/src/app.ts": "export const app = 2\n",
    "packages/core/src/other.ts": "export const other = 2\n",
    "packages/ai/test/stream-progress.test.ts": "export const progress = 2\n",
  })
  commit("elsewhere")
  expect(run("--ms").trim()).toBe("360000")
})

test.each([
  ["the egress relay", "packages/own-accounts/src/broker/egress.ts"],
  ["the SSH tunnel", "packages/own-remote/src/ssh/tunnel.ts"],
  ["a P-018 source file", "packages/ai/src/route/client.ts"],
])("a commit to %s since the last full pass makes it due", (_name, file) => {
  run("--record")
  write({ [file]: `export const changed = ${Date.now()}\n` })
  commit(file)
  expect(run()).toContain(`changed since ${git("rev-parse", "HEAD~1").trim().slice(0, 10)}: ${file}`)
  expect(run("--ms").trim()).toBe("1200000")
})

test("a full pass 7 days old is due, 6 days old is not", () => {
  const head = git("rev-parse", "HEAD").trim()
  fs.writeFileSync(record, `${head} ${new Date(Date.now() - 7 * 24 * 60 * 60_000 - 60_000).toISOString()}\n`)
  expect(run()).toContain("due (the last full pass is 7 days old)")
  fs.writeFileSync(record, `${head} ${new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString()}\n`)
  expect(run("--ms").trim()).toBe("360000")
})

test("--record refuses an uncommitted change on the watched paths and keeps the old record", () => {
  run("--record")
  const before = fs.readFileSync(record, "utf8")
  write({ "packages/own-accounts/src/broker/egress.ts": "export const egress = 3\n" })
  const result = spawn("--record")
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("only a commit's pass counts")
  expect(fs.readFileSync(record, "utf8")).toBe(before)
  // The uncommitted change itself makes the full run due.
  expect(run()).toContain("packages/own-accounts/src/broker/egress.ts")
  git("checkout", "--", ".")
})

function run(...args: string[]) {
  const result = spawn(...args)
  if (result.code !== 0) throw new Error(`d4-due ${args.join(" ")} exited ${result.code}: ${result.stderr}`)
  return result.stdout
}

function spawn(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function commit(message: string) {
  git("add", "-A")
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  )
}

function write(files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), content)
  }
}

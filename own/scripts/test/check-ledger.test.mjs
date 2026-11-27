import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { checkLedger, isAllowedPath, listFiles, markerSpans } from "../check-ledger.mjs"

// A throwaway repo: `upstream-v2` holds two upstream files, `main` adds our ledger on top.
function fixture(patches, cherryPicks = "[]\n") {
  const repo = mkdtempSync(path.join(tmpdir(), "own-ledger-"))
  const run = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim()
  run("init", "-q", "-b", "upstream-v2")
  run("config", "user.email", "test@example.invalid")
  run("config", "user.name", "test")
  run("config", "core.autocrlf", "false")
  write(repo, "packages/core/a.ts", "export const a = 1\n")
  write(repo, "packages/core/b.ts", "export const b = 2\n")
  run("add", "-A")
  run("commit", "-q", "-m", "upstream")
  run("switch", "-q", "-c", "main")
  write(repo, "own/ledger/core-patches.yaml", patches)
  write(repo, "own/ledger/cherry-picks.yaml", cherryPicks)
  write(repo, "packages/own-runtime/src/index.ts", "export {}\n")
  write(repo, "bun.lock", "{}\n")
  run("add", "-A")
  run("commit", "-q", "-m", "own")
  const commit = (message) => {
    run("add", "-A")
    run("commit", "-q", "-m", message)
    return run("rev-parse", "HEAD")
  }
  return { repo, run, commit, cleanup: () => rmSync(repo, { recursive: true, force: true }) }
}

function write(repo, file, text) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  writeFileSync(path.join(repo, file), text)
}

const planned = `
- id: P-001
  title: "patch a"
  status: planned
  files:
    - path: packages/core/a.ts
      anchor: "export const a = 1"
  verify: ["check a"]
  remove_when: "upstream"
`

const active = (maxLines = 30) => `
- id: P-001
  title: "patch a"
  status: active
  files:
    - path: packages/core/a.ts
      max_lines: ${maxLines}
  verify: ["check a"]
  remove_when: "upstream"
`

const patched = "export const a = 1\n// OWN-PATCH(P-001) begin\nexport const extra = 1\nexport const more = 2\n// OWN-PATCH(P-001) end\n"

test("allowed paths", () => {
  assert.ok(isAllowedPath("own/ledger/core-patches.yaml"))
  assert.ok(isAllowedPath("packages/own-web/src/index.tsx"))
  assert.ok(isAllowedPath("bun.lock"))
  assert.ok(!isAllowedPath("packages/owner/src/x.ts"))
  assert.ok(!isAllowedPath("packages/core/src/own-thing.ts"))
})

test("marker spans", () => {
  assert.deepEqual(markerSpans(patched, "P-001"), { lines: [2] })
  assert.deepEqual(markerSpans(patched.replaceAll("\n", "\r\n"), "P-001"), { lines: [2] })
  assert.match(markerSpans("x\n", "P-001").error, /missing/)
  assert.match(markerSpans("// OWN-PATCH(P-001) begin\n", "P-001").error, /no end marker/)
  assert.match(markerSpans("// OWN-PATCH(P-001) end\n", "P-001").error, /without begin/)
})

test("clean fork: only own paths differ", (t) => {
  const repo = fixture(planned)
  t.after(repo.cleanup)
  const result = checkLedger({ repo: repo.repo })
  assert.equal(result.ok, true, result.errors.join("\n"))
  assert.equal(result.upstreamChanges.length, 0)
  assert.equal(result.ignored, 4)
  assert.deepEqual(result.planned, ["P-001"])
  assert.deepEqual(result.warnings, [])
})

test("unledgered upstream change fails", (t) => {
  const repo = fixture(planned)
  t.after(repo.cleanup)
  write(repo.repo, "packages/core/b.ts", "export const b = 3\n")
  repo.commit("touch b")
  const result = checkLedger({ repo: repo.repo })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /packages\/core\/b\.ts: differs from upstream and is not in/)
})

test("planned patch with a diff must become active", (t) => {
  const repo = fixture(planned)
  t.after(repo.cleanup)
  write(repo.repo, "packages/core/a.ts", patched)
  repo.commit("apply without ledger update")
  const result = checkLedger({ repo: repo.repo })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /P-001 is planned — set status: active/)
})

test("active patch with markers passes; oversize and stale fail", (t) => {
  const ok = fixture(active())
  t.after(ok.cleanup)
  write(ok.repo, "packages/core/a.ts", patched)
  ok.commit("own-patch(P-001)")
  assert.equal(checkLedger({ repo: ok.repo }).ok, true)

  const big = fixture(active(1))
  t.after(big.cleanup)
  write(big.repo, "packages/core/a.ts", patched)
  big.commit("own-patch(P-001)")
  assert.match(checkLedger({ repo: big.repo }).errors.join("\n"), /2 lines between markers exceed max_lines 1/)

  const stale = fixture(active())
  t.after(stale.cleanup)
  assert.match(checkLedger({ repo: stale.repo }).errors.join("\n"), /active but has no diff/)

  const unmarked = fixture(active())
  t.after(unmarked.cleanup)
  write(unmarked.repo, "packages/core/a.ts", "export const a = 99\n")
  unmarked.commit("no markers")
  assert.match(checkLedger({ repo: unmarked.repo }).errors.join("\n"), /missing .*OWN-PATCH\(P-001\) begin/)
})

test("a generated file needs a diff but no markers", (t) => {
  const ledger = (flag) => `
- id: P-001
  title: "patch a, with generated b"
  status: active
  files:
    - path: packages/core/a.ts
    - path: packages/core/b.ts
      ${flag}
  verify: ["bun run generate leaves no diff"]
  remove_when: "upstream"
`
  const ok = fixture(ledger("generated: true"))
  t.after(ok.cleanup)
  write(ok.repo, "packages/core/a.ts", patched)
  write(ok.repo, "packages/core/b.ts", "export const b = 3\n")
  ok.commit("own-patch(P-001) with generated output")
  const passed = checkLedger({ repo: ok.repo })
  assert.equal(passed.ok, true, passed.errors.join("\n"))

  const plain = fixture(ledger("churn_30d: 0"))
  t.after(plain.cleanup)
  write(plain.repo, "packages/core/a.ts", patched)
  write(plain.repo, "packages/core/b.ts", "export const b = 3\n")
  plain.commit("own-patch(P-001)")
  assert.match(checkLedger({ repo: plain.repo }).errors.join("\n"), /b\.ts: missing .*OWN-PATCH\(P-001\) begin/)

  const stale = fixture(ledger("generated: true"))
  t.after(stale.cleanup)
  write(stale.repo, "packages/core/a.ts", patched)
  stale.commit("generated output unchanged")
  assert.match(checkLedger({ repo: stale.repo }).errors.join("\n"), /b\.ts is active but has no diff/)

  const invalid = fixture(ledger('generated: "yes"'))
  t.after(invalid.cleanup)
  assert.match(checkLedger({ repo: invalid.repo }).errors.join("\n"), /generated must be true or false/)

  const capped = fixture(ledger("generated: true\n      max_lines: 40"))
  t.after(capped.cleanup)
  assert.match(checkLedger({ repo: capped.repo }).errors.join("\n"), /is generated \(no markers\)/)
})

test("an unmarked file (LICENSE) needs a diff but no markers", (t) => {
  const ledger = (flag) => `
- id: P-001
  title: "licence line"
  status: active
  files:
    - path: packages/core/a.ts
    - path: packages/core/b.ts
      ${flag}
  verify: ["read the file"]
  remove_when: "never"
`
  const ok = fixture(ledger("unmarked: true"))
  t.after(ok.cleanup)
  write(ok.repo, "packages/core/a.ts", patched)
  write(ok.repo, "packages/core/b.ts", "export const b = 3\n")
  ok.commit("own-patch(P-001) with an unmarked file")
  const passed = checkLedger({ repo: ok.repo })
  assert.equal(passed.ok, true, passed.errors.join("\n"))

  const invalid = fixture(ledger('unmarked: "yes"'))
  t.after(invalid.cleanup)
  assert.match(checkLedger({ repo: invalid.repo }).errors.join("\n"), /unmarked must be true or false/)

  const capped = fixture(ledger("unmarked: true\n      max_lines: 4"))
  t.after(capped.cleanup)
  assert.match(checkLedger({ repo: capped.repo }).errors.join("\n"), /is unmarked, so marker and max_lines do not apply/)
})

test("a removed file must stay removed", (t) => {
  const ledger = (flag) => `
- id: P-001
  title: "patch a, without b"
  status: active
  files:
    - path: packages/core/a.ts
    - path: packages/core/b.ts
      ${flag}
  verify: ["node own/scripts/check-ledger.mjs"]
  remove_when: "never"
`
  const ok = fixture(ledger("removed: true"))
  t.after(ok.cleanup)
  write(ok.repo, "packages/core/a.ts", patched)
  rmSync(path.join(ok.repo, "packages/core/b.ts"))
  ok.commit("own-patch(P-001) without b")
  const passed = checkLedger({ repo: ok.repo })
  assert.equal(passed.ok, true, passed.errors.join("\n"))

  const back = fixture(ledger("removed: true"))
  t.after(back.cleanup)
  write(back.repo, "packages/core/a.ts", patched)
  write(back.repo, "packages/core/b.ts", "export const b = 3\n")
  back.commit("b is back")
  assert.match(checkLedger({ repo: back.repo }).errors.join("\n"), /b\.ts is back/)

  const both = fixture(ledger("removed: true\n      generated: true"))
  t.after(both.cleanup)
  assert.match(checkLedger({ repo: both.repo }).errors.join("\n"), /is removed, so max_lines and generated do not apply/)
})

test("worktree mode sees uncommitted and untracked upstream edits", (t) => {
  const repo = fixture(planned)
  t.after(repo.cleanup)
  write(repo.repo, "packages/core/new.ts", "export {}\n")
  assert.equal(checkLedger({ repo: repo.repo }).ok, true)
  const result = checkLedger({ repo: repo.repo, worktree: true })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /packages\/core\/new\.ts/)
})

test("worktree mode skips the copied target of a skip-worktree directory symlink, and only that", (t) => {
  const repo = fixture(planned)
  t.after(repo.cleanup)
  // Upstream tracks `packages/core/assets` as a symlink to a directory; a Windows checkout without symlink support
  // gets the target copied in place and the entry marked skip-worktree (own/FORK.md).
  const blob = execFileSync("git", ["-C", repo.repo, "hash-object", "-w", "--stdin"], {
    input: "../shared/assets",
    encoding: "utf8",
  }).trim()
  repo.run("switch", "-q", "upstream-v2")
  repo.run("update-index", "--add", "--cacheinfo", `120000,${blob},packages/core/assets`)
  repo.run("commit", "-q", "-m", "upstream link")
  repo.run("switch", "-q", "main")
  repo.run("merge", "-q", "--no-edit", "upstream-v2")
  rmSync(path.join(repo.repo, "packages/core/assets"), { force: true })
  write(repo.repo, "packages/core/assets/logo.png", "png")
  repo.run("update-index", "--skip-worktree", "packages/core/assets")
  const result = checkLedger({ repo: repo.repo, worktree: true })
  assert.equal(result.ok, true, result.errors.join("\n"))
  assert.match(
    result.warnings.join("\n"),
    /1 untracked file\(s\) inside skip-worktree symlink entries ignored \(packages\/core\/assets\)/,
  )
  // Without the skip-worktree mark it is an ordinary upstream edit again.
  repo.run("update-index", "--no-skip-worktree", "packages/core/assets")
  const unmarked = checkLedger({ repo: repo.repo, worktree: true })
  assert.equal(unmarked.ok, false)
  assert.match(unmarked.errors.join("\n"), /packages\/core\/assets/)
})

test("pending cherry-picks are allowed, absorbed ones warn", (t) => {
  const repo = fixture(planned)
  t.after(repo.cleanup)
  // An upstream fix lands on upstream-v2 after the fork point and is cherry-picked to main.
  repo.run("switch", "-q", "upstream-v2")
  write(repo.repo, "packages/core/b.ts", "export const b = 20\n")
  const upstreamSha = repo.commit("upstream fix")
  repo.run("switch", "-q", "main")
  repo.run("cherry-pick", "-x", upstreamSha)
  write(
    repo.repo,
    "own/ledger/cherry-picks.yaml",
    `- upstream_sha: ${upstreamSha}\n  picked_as: HEAD\n  files: [packages/core/b.ts]\n  reason: "fix"\n  date: 2026-10-01\n`,
  )
  repo.commit("record cherry-pick")
  const pending = checkLedger({ repo: repo.repo })
  assert.equal(pending.ok, true, pending.errors.join("\n"))
  assert.deepEqual(pending.cherryPicked, ["packages/core/b.ts"])
  assert.deepEqual(listFiles({ repo: repo.repo }), ["packages/core/a.ts", "packages/core/b.ts"])

  repo.run("merge", "-q", "--no-edit", "-X", "theirs", "upstream-v2")
  const absorbed = checkLedger({ repo: repo.repo })
  assert.equal(absorbed.ok, true, absorbed.errors.join("\n"))
  assert.match(absorbed.warnings.join("\n"), /absorbed by the merge-base — remove the entry/)
  assert.deepEqual(listFiles({ repo: repo.repo }), ["packages/core/a.ts"])
})

test("anchor drift and ledger format errors", (t) => {
  const drift = fixture(planned.replace("export const a = 1", "export const a = 42"))
  t.after(drift.cleanup)
  assert.match(checkLedger({ repo: drift.repo }).warnings.join("\n"), /anchor not found in packages\/core\/a\.ts/)

  const bad = fixture("- id: X-1\n  status: maybe\n  files: []\n")
  t.after(bad.cleanup)
  const result = checkLedger({ repo: bad.repo })
  assert.equal(result.fatal, true)
  assert.match(result.errors.join("\n"), /id must look like P-001/)
  assert.match(result.errors.join("\n"), /status must be one of/)
})

test("a file may carry a pending cherry-pick and an active patch", (t) => {
  const repo = fixture(active())
  t.after(repo.cleanup)
  repo.run("switch", "-q", "upstream-v2")
  write(repo.repo, "packages/core/a.ts", "export const a = 10\n")
  const upstreamSha = repo.commit("upstream fix")
  repo.run("switch", "-q", "main")
  repo.run("cherry-pick", "-x", upstreamSha)
  write(
    repo.repo,
    "own/ledger/cherry-picks.yaml",
    `- upstream_sha: ${upstreamSha}\n  picked_as: HEAD\n  files: [packages/core/a.ts]\n  reason: "fix"\n  date: 2026-10-01\n`,
  )
  repo.commit("record cherry-pick")
  // The picked file alone needs no patch markers ...
  const picked = checkLedger({ repo: repo.repo })
  assert.match(picked.errors.join("\n"), /missing .*OWN-PATCH\(P-001\) begin/)
  // ... and once the patch adds its own change there, its markers are checked as usual.
  write(repo.repo, "packages/core/a.ts", patched.replace("export const a = 1", "export const a = 10"))
  repo.commit("own-patch(P-001)")
  const both = checkLedger({ repo: repo.repo })
  assert.equal(both.ok, true, both.errors.join("\n"))
  assert.deepEqual(both.cherryPicked, ["packages/core/a.ts"])
})

test("over_budget patches need the user's exception_approval and leave the budget count", (t) => {
  const many = Array.from({ length: 7 }, (_, index) => {
    const id = `P-00${index + 1}`
    return `
- id: ${id}
  title: "patch ${index}"
  status: active
  ${index === 6 ? "over_budget: true\n  exception_approval: \"Approved by the user\"\n  " : ""}files:
    - path: packages/core/p${index}.ts
  verify: ["check"]
  remove_when: "upstream"
`
  }).join("")
  const repo = fixture(many)
  t.after(repo.cleanup)
  for (let index = 0; index < 7; index++)
    write(repo.repo, `packages/core/p${index}.ts`, `// OWN-PATCH(P-00${index + 1}) begin\nx\n// OWN-PATCH(P-00${index + 1}) end\n`)
  repo.commit("seven patches")
  const approved = checkLedger({ repo: repo.repo })
  assert.equal(approved.ok, true, approved.errors.join("\n"))
  assert.match(approved.warnings.join("\n"), /P-007 active over the budget of 6 by user exception/)

  write(repo.repo, "own/ledger/core-patches.yaml", many.replace('  exception_approval: "Approved by the user"\n', ""))
  repo.commit("drop approval")
  assert.match(checkLedger({ repo: repo.repo }).errors.join("\n"), /P-007: over_budget patches must record/)

  write(repo.repo, "own/ledger/core-patches.yaml", many.replace("over_budget: true\n  ", ""))
  repo.commit("no exception")
  assert.match(checkLedger({ repo: repo.repo }).errors.join("\n"), /7 active patches exceed the budget of 6/)
})

test("a patch awaiting the user's approval fails unless --allow-pending (branch-local runs only)", (t) => {
  const awaiting = active().replace("  status: active\n", "  status: active\n  awaiting_approval: true\n")
  const repo = fixture(awaiting)
  t.after(repo.cleanup)
  write(repo.repo, "packages/core/a.ts", patched)
  repo.commit("own-patch(P-001)")
  const blocked = checkLedger({ repo: repo.repo })
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.pending, ["P-001"])
  assert.match(blocked.errors.join("\n"), /P-001: awaiting_approval: true/)
  const allowed = checkLedger({ repo: repo.repo, allowPending: true })
  assert.equal(allowed.ok, true, allowed.errors.join("\n"))
  assert.match(allowed.warnings.join("\n"), /P-001: awaiting the user's approval \(allowed by --allow-pending/)

  // The command line: exit 1 by default, 0 with the flag.
  const script = path.join(import.meta.dirname, "..", "check-ledger.mjs")
  const run = (...args) =>
    spawnSync(process.execPath, [script, "--repo", repo.repo, ...args], { encoding: "utf8", windowsHide: true })
  const failed = run()
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  assert.match(failed.stdout, /awaiting approval: P-001/)
  assert.equal(run("--allow-pending").status, 0)

  // Once the user approved it (the field gone), the default check passes.
  write(repo.repo, "own/ledger/core-patches.yaml", active())
  repo.commit("approved")
  assert.equal(checkLedger({ repo: repo.repo }).ok, true)
})

test("no release step passes --allow-pending", () => {
  const root = path.join(import.meta.dirname, "..", "..", "..")
  const files = execFileSync("git", ["-C", root, "ls-files", "own", ".husky", "package.json", "script"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(?:mjs|js|ts|ps1|json|sh|cmd|bat)$/.test(file) || file.startsWith(".husky/"))
    .filter((file) => !file.startsWith("own/scripts/test/") && file !== "own/scripts/check-ledger.mjs")
  const using = files.filter((file) => readFileSync(path.join(root, file), "utf8").includes("--allow-pending"))
  assert.deepEqual(using, [])
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkEntry, checkSurface, extractRegion, hashSource, loadSurface, updateSurface } from "../check-surface.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

const source = `import x from "y"

export function target(a: string) {
  const re = /[{"'(]/g // brackets inside a regex and a comment {
  const s = "}"
  if (a) {
    return \`\${a}}\`
  }
  return a
}

const after = 1
`

test("extractRegion modes", () => {
  assert.equal(extractRegion(source, { from: "export function target", block: true }).text.split("\n").length, 8)
  assert.deepEqual(extractRegion(source, { from: "const s =", to: "return a" }).text.split("\n").length, 5)
  assert.equal(extractRegion(source, { from: "const re", lines: 2 }).text, `  const re = /[{"'(]/g // brackets inside a regex and a comment {\n  const s = "}"`)
  assert.equal(extractRegion(source, { from: "const after" }).text, "const after = 1")
  assert.match(extractRegion(source, { from: "missing" }).error, /not found/)
  assert.match(extractRegion(source, { from: "const s", to: "nope" }).error, /end not found/)
  assert.equal(extractRegion(source.replaceAll("\n", "\r\n"), "file").text, extractRegion(source, "file").text)
})

test("hashes ignore CRLF and trailing whitespace but not content", () => {
  assert.equal(hashSource("a  \r\nb\r\n"), hashSource("a\nb\n"))
  assert.notEqual(hashSource("a\nb\n"), hashSource("a\nc\n"))
})

test("entry statuses: ok, changed, broken, absent", (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "own-surface-"))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(path.join(repo, "src"))
  writeFileSync(path.join(repo, "src", "a.ts"), source)
  const entry = { id: "t", file: "src/a.ts", require: ["export function target"], regions: [{ from: "export function target", block: true }] }
  const first = checkEntry(repo, entry)
  assert.equal(first.status, "changed")
  assert.match(first.changes[0], /not recorded/)
  assert.equal(checkEntry(repo, { ...entry, sha256: first.hash }).status, "ok")

  writeFileSync(path.join(repo, "src", "a.ts"), source.replace("return a\n}", "return a + 1\n}"))
  assert.equal(checkEntry(repo, { ...entry, sha256: first.hash }).status, "changed")
  assert.equal(checkEntry(repo, { ...entry, sha256: first.hash, absent: ["return a + 1"] }).changes.length, 2)

  writeFileSync(path.join(repo, "src", "a.ts"), "export const other = 1\n")
  const broken = checkEntry(repo, { ...entry, sha256: first.hash })
  assert.equal(broken.status, "broken")
  assert.equal(broken.problems.length, 2)
  assert.equal(checkEntry(repo, { ...entry, file: "src/missing.ts" }).status, "broken")
})

test("update records hashes and skips broken entries; vendored drift is a warning", (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "own-surface-"))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  mkdirSync(path.join(repo, "src"))
  mkdirSync(path.join(repo, "own", "ledger"), { recursive: true })
  writeFileSync(path.join(repo, "src", "a.ts"), source)
  writeFileSync(
    path.join(repo, "own", "ledger", "vendored.yaml"),
    `- dest: own-copy.ts\n  source: src/a.ts\n  upstream_commit: abc1234\n  source_sha256: "${"0".repeat(64)}"\n` +
      `- dest: gone.ts\n  source: src/gone.ts\n  upstream_commit: abc1234\n  source_sha256: "${"0".repeat(64)}"\n` +
      `- dest: kept.ts\n  source: src/gone.ts\n  upstream_commit: abc1234\n  source_sha256: "${"0".repeat(64)}"\n  removed_upstream: def5678\n`,
  )
  const surfaceFile = path.join(repo, "surface.json")
  writeFileSync(
    surfaceFile,
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        { id: "good", file: "src/a.ts", regions: ["file"], sha256: null },
        { id: "gone", file: "src/a.ts", require: ["nope"], regions: [{ from: "nope" }], sha256: null },
      ],
    }),
  )
  const before = checkSurface({ repo, surfaceFile })
  assert.equal(before.exitCode, 1)
  assert.equal(before.vendored[0].status, "drift")
  // A removed source drifts until the entry records the upstream removal it was reviewed against.
  assert.deepEqual(
    before.vendored.slice(1).map((item) => [item.dest, item.status]),
    [
      ["gone.ts", "drift"],
      ["kept.ts", "ok"],
    ],
  )

  const result = updateSurface({ repo, surfaceFile })
  assert.deepEqual(result.updated, ["good"])
  assert.deepEqual(result.broken.map((item) => item.id), ["gone"])
  const saved = JSON.parse(readFileSync(surfaceFile, "utf8"))
  // A single "file" region hashes to the normalized file hash.
  assert.equal(saved.entries[0].sha256, hashSource(source))
  assert.equal(saved.entries[1].sha256, null)
  assert.equal(checkSurface({ repo, surfaceFile, only: ["good"] }).exitCode, 0)
})

test("the committed surface list matches this checkout", () => {
  const surfaceFile = path.join(repoRoot, "own", "upstream-surface.json")
  const surface = loadSurface(surfaceFile)
  assert.ok(surface.entries.length >= 40)
  const report = checkSurface({ repo: repoRoot, surfaceFile })
  const failing = report.results.filter((result) => result.status !== "ok")
  assert.deepEqual(
    failing.map((result) => `${result.id}: ${[...result.problems, ...result.changes].join("; ")}`),
    [],
  )
})

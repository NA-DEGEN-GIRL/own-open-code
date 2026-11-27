import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseYaml, YamlError } from "../lib/yaml-lite.mjs"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const ledger = path.join(repo, "own", "ledger")

test("empty documents and flow empties", () => {
  assert.equal(parseYaml(""), null)
  assert.equal(parseYaml("# only a comment\n\n"), null)
  assert.deepEqual(parseYaml("# header\n[]\n"), [])
  assert.deepEqual(parseYaml("---\n{}\n"), {})
})

test("block sequence of mappings with nested sequences", () => {
  const value = parseYaml(`
- id: P-001   # trailing comment
  status: planned
  files:
    - path: packages/cli/script/app-assets.ts
      anchor: 'const root = path.resolve(import.meta.dirname, "../../app")'
      churn_30d: 2
  commits: []
  upstream: { issue: null, pr: null, target_branch: v2 }
  verify:
  - "OPENCODE_WEB_APP=own-web bun run build # not a comment"
  added: 2026-09-26
- id: P-002
  status: active
`)
  assert.deepEqual(value, [
    {
      id: "P-001",
      status: "planned",
      files: [
        {
          path: "packages/cli/script/app-assets.ts",
          anchor: 'const root = path.resolve(import.meta.dirname, "../../app")',
          churn_30d: 2,
        },
      ],
      commits: [],
      upstream: { issue: null, pr: null, target_branch: "v2" },
      verify: ["OPENCODE_WEB_APP=own-web bun run build # not a comment"],
      added: "2026-09-26",
    },
    { id: "P-002", status: "active" },
  ])
})

test("scalars", () => {
  assert.deepEqual(
    parseYaml(`
a: ~
b: true
c: False
d: -12
e: 1.5
f: 0123abc
g: "tab\\tquote\\" \\u00e9"
h: 'it''s'
i: don't # comment after apostrophe
j: http://example.com/a#frag
k: [1, "two, three", {x: y}, [nested]]
`),
    {
      a: null,
      b: true,
      c: false,
      d: -12,
      e: 1.5,
      f: "0123abc",
      g: 'tab\tquote" é',
      h: "it's",
      i: "don't",
      j: "http://example.com/a#frag",
      k: [1, "two, three", { x: "y" }, ["nested"]],
    },
  )
})

test("multi-line flow collections and block scalars", () => {
  assert.deepEqual(
    parseYaml(`
files: [a.ts,
  b.ts]
note: |
  line one
    indented
  line three
folded: >-
  one
  two
after: x
`),
    { files: ["a.ts", "b.ts"], note: "line one\n  indented\nline three\n", folded: "one two", after: "x" },
  )
})

test("errors carry line numbers", () => {
  assert.throws(() => parseYaml("a: 1\na: 2\n"), (error) => error instanceof YamlError && error.line === 2)
  assert.throws(() => parseYaml("a:\n\t- x\n"), YamlError)
  assert.throws(() => parseYaml("a: [1, 2\n"), /unterminated flow/)
  assert.throws(() => parseYaml("a: &anchor 1\n"), /anchors/)
  assert.throws(() => parseYaml("- a\nb: c\n"), YamlError)
})

test("the committed ledgers parse", () => {
  const patches = parseYaml(readFileSync(path.join(ledger, "core-patches.yaml"), "utf8"))
  assert.ok(Array.isArray(patches) && patches.length >= 13)
  // Ids are in file order from P-001 without repeats. Parallel branches take the next ids (P-035 on one, P-036 on
  // another), so a branch may lack an id its sibling holds until both are merged: a gap is allowed, not a step back.
  const numbers = patches.map((patch) => Number(/^P-(\d{3})$/.exec(patch.id)?.[1]))
  assert.equal(numbers[0], 1)
  numbers.forEach((number, index) => assert.ok(index === 0 || number > numbers[index - 1], `${patches[index].id}`))
  // Upstream code used unchanged (FORK §7): one entry per (dest, source), every field of the documented shape, both
  // files present in this checkout. check-surface.mjs owns the hash drift check; this only guards the format.
  const vendored = parseYaml(readFileSync(path.join(ledger, "vendored.yaml"), "utf8"))
  assert.ok(Array.isArray(vendored) && vendored.length > 0, "vendored.yaml lists the vendored upstream files")
  const pairs = new Set()
  for (const entry of vendored) {
    const where = `${entry?.dest} <- ${entry?.source}`
    assert.equal(typeof entry.dest, "string", where)
    assert.equal(typeof entry.source, "string", where)
    assert.ok(entry.dest.startsWith("packages/") || entry.dest.startsWith("own/"), `${where}: dest outside our paths`)
    assert.ok(entry.source.startsWith("packages/"), `${where}: source is not an upstream package file`)
    assert.ok(["vendor", "substitute", "deep-import"].includes(entry.kind), `${where}: kind ${entry.kind}`)
    assert.match(String(entry.upstream_commit), /^[0-9a-f]{7,40}$/, where)
    assert.match(String(entry.source_sha256), /^[0-9a-f]{64}$/, where)
    assert.ok(typeof entry.local_changes === "string" && entry.local_changes.length > 0, `${where}: local_changes`)
    assert.match(String(entry.license), /MIT/, where)
    assert.ok(existsSync(path.join(repo, entry.dest)), `${where}: dest missing`)
    // A source upstream deleted with no successor stays named, with the commit that removed it.
    if (entry.removed_upstream === undefined) assert.ok(existsSync(path.join(repo, entry.source)), `${where}: source missing`)
    else assert.match(String(entry.removed_upstream), /^[0-9a-f]{7,40}$/, `${where}: removed_upstream`)
    const pair = `${entry.dest}\n${entry.source}`
    assert.ok(!pairs.has(pair), `${where}: listed twice`)
    pairs.add(pair)
  }
  const cherryPicks = parseYaml(readFileSync(path.join(ledger, "cherry-picks.yaml"), "utf8"))
  assert.ok(Array.isArray(cherryPicks), "cherry-picks.yaml is a list (empty until the first cherry-pick)")
})

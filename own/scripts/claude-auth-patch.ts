// Builds the claude-auth patch manifest (02 §8.2; applied at build time by claude-auth-bundle.ts) from a pristine copy
// of the pinned package and an edited copy:
// `bun own/scripts/claude-auth-patch.ts <pristine package dir> <edited package dir> <out.json>`.
//
// Each changed file becomes `{file, preSha256, postSha256, edits: [{find, replace}]}`; an edit is one changed region
// with enough unchanged lines around it that its `find` occurs exactly once in the file as the edits before it left
// it. The script applies the result to the pristine copy and fails unless every file then equals the edited copy.
// It only reads both directories and writes the manifest.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const [pristine, edited, out] = process.argv.slice(2)
if (!pristine || !edited || !out) {
  console.error("usage: bun own/scripts/claude-auth-patch.ts <pristine package dir> <edited package dir> <out.json>")
  process.exit(2)
}

const pkg = JSON.parse(fs.readFileSync(path.join(pristine, "package.json"), "utf8")) as {
  name: string
  version: string
}
const files = walk(edited)
  .filter((file) => file.endsWith(".js"))
  .flatMap((file) => {
    const before = fs.readFileSync(path.join(pristine, file), "utf8")
    const after = fs.readFileSync(path.join(edited, file), "utf8")
    if (before === after) return []
    const edits = editsOf(before, after)
    const applied = edits.reduce((text, edit) => {
      if (text.split(edit.find).length !== 2) throw new Error(`${file}: an edit is not unique`)
      return text.replace(edit.find, () => edit.replace)
    }, before)
    if (applied !== after) throw new Error(`${file}: the edits do not reproduce the edited file`)
    return [{ file, preSha256: sha256(before), postSha256: sha256(after), edits }]
  })

const lock = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "..", "vendor", "claude-auth", "package-lock.json"), "utf8"),
) as { packages: Record<string, { version?: string; integrity?: string }> }
const pinned = lock.packages[`node_modules/${pkg.name}`]
if (pinned?.version !== pkg.version || !pinned.integrity) throw new Error("the template lock pins another version")
const manifest = {
  schema: 1,
  package: pkg.name,
  version: pkg.version,
  integrity: pinned.integrity,
  marker: "OWN_MULTI_ACCOUNT",
  files,
}
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${out}: ${files.length} files, ${files.reduce((sum, file) => sum + file.edits.length, 0)} edits`)

function walk(root: string, dir = ""): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(root, rel)
    return [rel]
  })
}

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Changed regions of `before` → `after` as unique find/replace pairs, in file order. */
function editsOf(before: string, after: string) {
  const a = lines(before)
  const b = lines(after)
  const hunks = diff(a, b)
  const edits: Array<{ find: string; replace: string }> = []
  const state = { text: before, consumed: 0 }
  for (const hunk of hunks) {
    // Grow the context until the find is unique in what is left to edit.
    for (let context = 1; ; context++) {
      const start = Math.max(hunk.aStart - context, state.consumed)
      const end = Math.min(hunk.aEnd + context, a.length)
      const find = a.slice(start, end).join("")
      const replace = [
        ...a.slice(start, hunk.aStart),
        ...b.slice(hunk.bStart, hunk.bEnd),
        ...a.slice(hunk.aEnd, end),
      ].join("")
      if (find !== "" && state.text.split(find).length === 2) {
        edits.push({ find, replace })
        state.text = state.text.replace(find, () => replace)
        state.consumed = end
        break
      }
      if (start === state.consumed && end === a.length) throw new Error("no unique context")
    }
  }
  return edits
}

/** Lines with their line breaks, so joining them gives the text back. */
function lines(text: string) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Changed line ranges (LCS), adjacent changes within 2 lines merged. */
function diff(a: string[], b: string[]) {
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const hunks: Array<{ aStart: number; aEnd: number; bStart: number; bEnd: number }> = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++
      j++
      continue
    }
    const aStart = i
    const bStart = j
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) j++
      else i++
    }
    const last = hunks.at(-1)
    if (last && aStart - last.aEnd <= 2) {
      last.aEnd = i
      last.bEnd = j
      continue
    }
    hunks.push({ aStart, aEnd: i, bStart, bEnd: j })
  }
  return hunks
}

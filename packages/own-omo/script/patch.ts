export * as OmoPatch from "./patch"

// own's patch of the vendored oh-my-opencode sources (own/vendor/oh-my-opencode/patches/<tag>.json), the format of
// own/scripts/claude-auth-patch.ts: per file `{file, patch, preSha256, postSha256, edits: [{find, replace}]}`. Every
// file must still have its `preSha256`, every `find` must occur exactly once in what the edits before it left, and
// every result must have its `postSha256`. `file` is relative to the vendored `src/` (e.g.
// `packages/utils/src/xdg-data-dir.ts`); `patch` is the change's id in MODIFICATIONS.md (OMO-P1…).
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface Edit {
  readonly find: string
  readonly replace: string
}

export interface FilePatch {
  readonly file: string
  readonly patch: string
  readonly preSha256: string
  readonly postSha256: string
  readonly edits: ReadonlyArray<Edit>
}

export interface Manifest {
  readonly schema: 1
  readonly package: "oh-my-opencode"
  readonly tag: string
  readonly files: ReadonlyArray<FilePatch>
}

export function read(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest
}

export function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Applies `edits` to `text`; undefined names the first edit whose `find` does not occur exactly once. */
export function edit(text: string, edits: ReadonlyArray<Edit>): { text: string } | { failed: number } {
  let current = text
  for (const [index, change] of edits.entries()) {
    if (current.split(change.find).length !== 2) return { failed: index }
    current = current.replace(change.find, () => change.replace)
  }
  return { text: current }
}

/** Applies the manifest to the tree at `root` in place, checking every hash. */
export function apply(manifest: Manifest, root: string) {
  for (const entry of manifest.files) {
    const target = path.join(root, entry.file)
    const before = fs.readFileSync(target, "utf8")
    if (sha256(before) !== entry.preSha256) throw new Error(`${entry.file}: not the file ${entry.patch} was made for`)
    const result = edit(before, entry.edits)
    if ("failed" in result) throw new Error(`${entry.file}: edit ${result.failed + 1} of ${entry.patch} is not unique`)
    if (sha256(result.text) !== entry.postSha256) throw new Error(`${entry.file}: ${entry.patch} gave other bytes`)
    fs.writeFileSync(target, result.text)
  }
}

/**
 * The manifest that turns `pristine` into `edited` (every file of `edited` that differs). Ids come from `ids` by file;
 * a file without one gets `OMO-P?` for the author to fill in.
 */
export function make(input: {
  readonly pristine: string
  readonly edited: string
  readonly tag: string
  readonly ids: ReadonlyMap<string, string>
}): Manifest {
  const files = walk(input.edited).flatMap((file) => {
    const before = fs.readFileSync(path.join(input.pristine, file), "utf8")
    const after = fs.readFileSync(path.join(input.edited, file), "utf8")
    if (before === after) return []
    const edits = editsOf(before, after)
    const applied = edit(before, edits)
    if ("failed" in applied || applied.text !== after) throw new Error(`${file}: the edits do not reproduce the edited file`)
    return [
      {
        file,
        patch: input.ids.get(file) ?? "OMO-P?",
        preSha256: sha256(before),
        postSha256: sha256(after),
        edits,
      },
    ]
  })
  return { schema: 1, package: "oh-my-opencode", tag: input.tag, files }
}

/**
 * The manifest for another tag: every edit applied again to that tag's pristine file. A file whose edit no longer
 * applies is listed in `failed` and left out; re-make it from an edited copy (`make`).
 */
export function rebase(manifest: Manifest, pristine: string, tag: string) {
  const failed: Array<{ file: string; patch: string; reason: string }> = []
  const files = manifest.files.flatMap((entry) => {
    const target = path.join(pristine, entry.file)
    if (!fs.existsSync(target)) {
      failed.push({ file: entry.file, patch: entry.patch, reason: "the file is gone" })
      return []
    }
    const before = fs.readFileSync(target, "utf8")
    const result = edit(before, entry.edits)
    if ("failed" in result) {
      failed.push({ file: entry.file, patch: entry.patch, reason: `edit ${result.failed + 1} does not occur exactly once` })
      return []
    }
    return [{ ...entry, preSha256: sha256(before), postSha256: sha256(result.text) }]
  })
  return { manifest: { ...manifest, tag, files } satisfies Manifest, failed }
}

export function write(file: string, manifest: Manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

function walk(root: string, dir = ""): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(root, rel)
    return [rel]
  })
}

/** Changed regions of `before` → `after` as unique find/replace pairs, in file order (claude-auth-patch.ts). */
function editsOf(before: string, after: string) {
  const a = lines(before)
  const b = lines(after)
  const edits: Edit[] = []
  const state = { text: before, consumed: 0 }
  for (const hunk of diff(a, b)) {
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

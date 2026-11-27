// Ports codex-rs/apply-patch/src/lib.rs (apply_hunks_to_files, print_summary, write retry, error texts) and the
// verification half of codex-rs/apply-patch/src/invocation.rs (try_verify_apply_patch_args), as
// codex-rs/core/src/tools/handlers/apply_patch.rs uses them: verify every hunk up front, then apply.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as PatchApply from "./apply.js"

import path from "node:path"
import { FileUpdate } from "./file-update.js"
import { PatchIo } from "./io.js"
import { PatchParser } from "./parser.js"

export interface Summary {
  added: Array<string>
  modified: Array<string>
  deleted: Array<string>
}

/** One file's verified change. Paths are absolute (resolved against the cwd). */
export type DerivedChange =
  | { path: string; kind: "add"; newContent: string }
  | { path: string; kind: "delete"; oldContent: string }
  | { path: string; kind: "update"; movePath?: string; oldContent: string; newContent: string }

/**
 * A rejected or failed patch. `verification` errors are found before anything is written; Codex reports them to the
 * model as `apply_patch verification failed: <message>`. `apply` errors happen while writing; Codex reports `<message>`
 * as the tool's stderr line, and changes before the failing hunk stay applied (`partial`).
 */
export class ApplyPatchError extends Error {
  readonly kind: "verification" | "apply"
  readonly partial: Summary

  constructor(kind: "verification" | "apply", message: string, partial: Summary = emptySummary()) {
    super(message)
    this.name = "ApplyPatchError"
    this.kind = kind
    this.partial = partial
  }
}

/**
 * Codex's verification: resolves each hunk against `cwd` (absolute patch paths stand as they are), rejects two hunks on
 * one path, reads every deleted file, and computes every update's new contents, all against the current files and
 * without writing. For `cd <dir> && apply_patch <<EOF` invocations pass `path.resolve(cwd, dir)` as `cwd`.
 */
export async function derivePatch(
  patch: PatchParser.Patch | string,
  cwd: string,
  fs: PatchIo.PatchFs = PatchIo.nodeFs,
) {
  const parsed = parse(patch)
  const changes: Array<DerivedChange> = []
  const seen = new Set<string>()
  for (const hunk of parsed.hunks) {
    // Codex keys changes by the source path; a move destination is not part of the check.
    const target = path.resolve(cwd, hunk.path)
    if (seen.has(target))
      throw new ApplyPatchError(
        "verification",
        PatchParser.PatchParseError.invalidPatch(`multiple operations target ${target}`).message,
      )
    seen.add(target)
    changes.push(await deriveChange(hunk, target, cwd, fs))
  }
  return changes
}

async function deriveChange(
  hunk: PatchParser.Hunk,
  target: string,
  cwd: string,
  fs: PatchIo.PatchFs,
): Promise<DerivedChange> {
  if (hunk.type === "add") return { path: target, kind: "add", newContent: hunk.contents }
  if (hunk.type === "delete") {
    const oldContent = await PatchIo.readText(fs, target).catch((error: unknown) => {
      throw new ApplyPatchError("verification", `Failed to read ${target}: ${PatchIo.describeIoError(error)}`)
    })
    return { path: target, kind: "delete", oldContent }
  }
  const contents = await FileUpdate.deriveNewContents(target, hunk.chunks, fs).catch((error: unknown) => {
    throw new ApplyPatchError("verification", error instanceof Error ? error.message : String(error))
  })
  return {
    path: target,
    kind: "update",
    ...(hunk.movePath === undefined ? {} : { movePath: path.resolve(cwd, hunk.movePath) }),
    oldContent: contents.originalContents,
    newContent: contents.newContents,
  }
}

/**
 * Applies a patch the way Codex's apply_patch tool does: verification (see `derivePatch`) first, then the hunks in
 * order against the files as they are at that point. `verify: false` applies without verification, like the
 * standalone `apply_patch` executable (Codex's scenario fixtures describe that mode).
 *
 * Returns the summary and its text, `Success. Updated the following files:` followed by `A`/`M`/`D` lines with the
 * paths as the patch spells them (a move reports `M <destination>`), each line newline-terminated.
 */
export async function applyPatch(
  patch: PatchParser.Patch | string,
  cwd: string,
  fs: PatchIo.PatchFs = PatchIo.nodeFs,
  options: { verify?: boolean } = {},
) {
  const parsed = parse(patch)
  if (options.verify !== false) await derivePatch(parsed, cwd, fs)
  const summary = await applyHunks(parsed.hunks, cwd, fs)
  return { summary, text: summaryText(summary) }
}

/** Codex's `print_summary` output. */
export function summaryText(summary: Summary) {
  return [
    "Success. Updated the following files:\n",
    ...summary.added.map((file) => `A ${file}\n`),
    ...summary.modified.map((file) => `M ${file}\n`),
    ...summary.deleted.map((file) => `D ${file}\n`),
  ].join("")
}

/** Codex reports a patch that does not parse as a verification failure with the parse error's text. */
function parse(patch: PatchParser.Patch | string) {
  if (typeof patch !== "string") return patch
  try {
    return PatchParser.parsePatch(patch)
  } catch (error) {
    if (error instanceof PatchParser.PatchParseError) throw new ApplyPatchError("verification", error.message)
    throw error
  }
}

async function applyHunks(hunks: ReadonlyArray<PatchParser.Hunk>, cwd: string, fs: PatchIo.PatchFs) {
  if (hunks.length === 0) throw new ApplyPatchError("apply", "No files were modified.")
  const summary = emptySummary()
  for (const hunk of hunks) {
    await applyHunk(hunk, cwd, fs, summary).catch((error: unknown) => {
      throw new ApplyPatchError("apply", error instanceof Error ? error.message : String(error), summary)
    })
  }
  return summary
}

async function applyHunk(hunk: PatchParser.Hunk, cwd: string, fs: PatchIo.PatchFs, summary: Summary) {
  const target = path.resolve(cwd, hunk.path)
  if (hunk.type === "add") {
    await writeWithParentRetry(fs, target, hunk.contents)
    summary.added.push(hunk.path)
    return
  }
  if (hunk.type === "delete") {
    await removeFile(fs, target, `Failed to delete file ${target}`)
    summary.deleted.push(hunk.path)
    return
  }
  const contents = await FileUpdate.deriveNewContents(target, hunk.chunks, fs)
  if (hunk.movePath !== undefined) {
    await writeWithParentRetry(fs, path.resolve(cwd, hunk.movePath), contents.newContents)
    await removeFile(fs, target, `Failed to remove original ${target}`)
    summary.modified.push(hunk.movePath)
    return
  }
  await fs.writeFile(target, ENCODER.encode(contents.newContents)).catch(() => {
    throw new Error(`Failed to write file ${target}`)
  })
  summary.modified.push(hunk.path)
}

const ENCODER = new TextEncoder()

/** Writes, creating missing parent directories once when the first write reports a missing path. */
async function writeWithParentRetry(fs: PatchIo.PatchFs, target: string, contents: string) {
  const bytes = ENCODER.encode(contents)
  const first = await fs.writeFile(target, bytes).then(
    () => undefined,
    (error: unknown) => error,
  )
  if (first === undefined) return
  if (!PatchIo.isNotFound(first)) throw new Error(`Failed to write file ${target}`)
  await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {
    throw new Error(`Failed to create parent directories for ${target}`)
  })
  await fs.writeFile(target, bytes).catch(() => {
    throw new Error(`Failed to write file ${target}`)
  })
}

/**
 * Removes a file, refusing directories. Codex attaches `context` with anyhow, whose display drops the cause, so the
 * message is the context alone.
 */
async function removeFile(fs: PatchIo.PatchFs, target: string, context: string) {
  const metadata = await fs.stat(target).catch(() => {
    throw new Error(context)
  })
  if (metadata.isDirectory()) throw new Error(context)
  await fs.unlink(target).catch(() => {
    throw new Error(context)
  })
}

function emptySummary(): Summary {
  return { added: [], modified: [], deleted: [] }
}

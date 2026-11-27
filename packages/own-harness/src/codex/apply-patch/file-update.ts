// Ports codex-rs/apply-patch/src/file_update.rs: applying an Update File hunk's chunks to the current contents.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as FileUpdate from "./file-update.js"

import { PatchIo } from "./io.js"
import type { PatchParser } from "./parser.js"
import { SeekSequence } from "./seek-sequence.js"
import { TextFile } from "./text-file.js"

/** A failure Codex reports with its own text (`ApplyPatchError::IoError` / `ComputeReplacements`). */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UpdateError"
  }
}

/**
 * Reads `path` (absolute) and returns its contents before and after `chunks`. Errors name `path`:
 * `Failed to read file to update <path>: <io error>`, `Failed to find context '<ctx>' in <path>`, and
 * `Failed to find expected lines in <path>:\n<old lines>`.
 */
export async function deriveNewContents(
  path: string,
  chunks: ReadonlyArray<PatchParser.UpdateFileChunk>,
  fs: PatchIo.PatchFs,
) {
  const originalContents = await PatchIo.readText(fs, path).catch((error: unknown) => {
    throw new UpdateError(`Failed to read file to update ${path}: ${PatchIo.describeIoError(error)}`)
  })
  return { originalContents, newContents: applyChunks(originalContents, path, chunks) }
}

/** The new contents of a file whose current contents are `contents`; `path` only names it in errors. */
export function applyChunks(contents: string, path: string, chunks: ReadonlyArray<PatchParser.UpdateFileChunk>) {
  const file = TextFile.parse(contents)
  return TextFile.applyReplacements(file, computeReplacements(TextFile.lineTexts(file), path, chunks))
}

function computeReplacements(
  originalLines: ReadonlyArray<string>,
  path: string,
  chunks: ReadonlyArray<PatchParser.UpdateFileChunk>,
) {
  const replacements: Array<TextFile.Replacement> = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const index = SeekSequence.seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
      if (index === undefined) throw new UpdateError(`Failed to find context '${chunk.changeContext}' in ${path}`)
      lineIndex = index + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([originalLines.length, 0, chunk.newLines])
      continue
    }
    const match = locate(originalLines, chunk, lineIndex)
    if (match === undefined)
      throw new UpdateError(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`)
    replacements.push(...contextPreservingReplacements(chunk, match))
    lineIndex = match.start + match.pattern.length
  }
  // Stable, like Rust's `sort_by_key`.
  return replacements.sort((left, right) => left[0] - right[0])
}

/**
 * Finds the chunk's old lines. A trailing empty old line usually stands for the file's final newline, which the parsed
 * lines do not contain, so a failed search retries without it (and without a trailing empty new line).
 */
function locate(originalLines: ReadonlyArray<string>, chunk: PatchParser.UpdateFileChunk, lineIndex: number) {
  const start = SeekSequence.seekSequence(originalLines, chunk.oldLines, lineIndex, chunk.isEndOfFile)
  if (start !== undefined) return { start, pattern: chunk.oldLines, newSlice: chunk.newLines }
  if (chunk.oldLines.at(-1) !== "") return undefined
  const pattern = chunk.oldLines.slice(0, -1)
  const newSlice = chunk.newLines.at(-1) === "" ? chunk.newLines.slice(0, -1) : chunk.newLines
  const retried = SeekSequence.seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
  return retried === undefined ? undefined : { start: retried, pattern, newSlice }
}

/**
 * Context lines appear on both sides of a chunk; their original lines stay in place so their exact text and endings
 * survive (mixed line endings), and only the spans between them are replaced.
 */
function contextPreservingReplacements(
  chunk: PatchParser.UpdateFileChunk,
  match: { start: number; pattern: ReadonlyArray<string>; newSlice: ReadonlyArray<string> },
) {
  const replacements: Array<TextFile.Replacement> = []
  let oldStart = 0
  let newStart = 0
  for (const [oldContext, newContext] of chunk.contextLineIndices) {
    // A trailing empty context line may have been dropped from the pattern as the final newline.
    if (oldContext >= match.pattern.length || newContext >= match.newSlice.length) break
    if (oldStart !== oldContext || newStart !== newContext)
      replacements.push([match.start + oldStart, oldContext - oldStart, match.newSlice.slice(newStart, newContext)])
    oldStart = oldContext + 1
    newStart = newContext + 1
  }
  if (oldStart !== match.pattern.length || newStart !== match.newSlice.length)
    replacements.push([match.start + oldStart, match.pattern.length - oldStart, match.newSlice.slice(newStart)])
  return replacements
}

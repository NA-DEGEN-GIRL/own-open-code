// Ports codex-rs/apply-patch/src/parser.rs and codex-rs/apply-patch/src/streaming_parser.rs: the apply_patch grammar,
// lenient heredoc unwrapping, and the exact parse error texts.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as PatchParser from "./parser.js"

import { RustStr } from "./rust-str.js"

export const BEGIN_PATCH_MARKER = "*** Begin Patch"
export const END_PATCH_MARKER = "*** End Patch"
export const ADD_FILE_MARKER = "*** Add File: "
export const DELETE_FILE_MARKER = "*** Delete File: "
export const UPDATE_FILE_MARKER = "*** Update File: "
export const MOVE_TO_MARKER = "*** Move to: "
export const EOF_MARKER = "*** End of File"
export const CHANGE_CONTEXT_MARKER = "@@ "
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@"
const ENVIRONMENT_ID_MARKER = "*** Environment ID:"

export interface UpdateFileChunk {
  /** A single line of context used to narrow down the position of the chunk (usually a class or function line). */
  changeContext: string | undefined
  /** A contiguous block of lines that should be replaced with `newLines`; must occur after `changeContext`. */
  oldLines: Array<string>
  newLines: Array<string>
  /** Pairs of indices into `oldLines` and `newLines` of lines parsed as context rather than equal by content. */
  contextLineIndices: Array<[number, number]>
  /** `oldLines` must occur at the end of the source file. */
  isEndOfFile: boolean
}

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | {
      type: "update"
      path: string
      movePath: string | undefined
      /** In file order: each chunk's context occurs later in the file than the previous chunk. */
      chunks: Array<UpdateFileChunk>
    }

export interface Patch {
  hunks: Array<Hunk>
  /** The patch text without a heredoc wrapper, as Codex re-applies it after verification. */
  patch: string
  environmentId: string | undefined
}

/** Codex's `ParseError`; `message` is its display (`invalid patch: …` / `invalid hunk at line N, …`). */
export class PatchParseError extends Error {
  readonly kind: "invalid_patch" | "invalid_hunk"
  readonly detail: string
  readonly lineNumber: number | undefined

  private constructor(kind: "invalid_patch" | "invalid_hunk", detail: string, lineNumber: number | undefined) {
    super(kind === "invalid_patch" ? `invalid patch: ${detail}` : `invalid hunk at line ${lineNumber}, ${detail}`)
    this.name = "PatchParseError"
    this.kind = kind
    this.detail = detail
    this.lineNumber = lineNumber
  }

  static invalidPatch(detail: string) {
    return new PatchParseError("invalid_patch", detail, undefined)
  }

  static invalidHunk(detail: string, lineNumber: number) {
    return new PatchParseError("invalid_hunk", detail, lineNumber)
  }
}

/** Path the hunk affects, using the move destination for rename hunks (Codex `Hunk::path`). */
export function hunkPath(hunk: Hunk) {
  return hunk.type === "update" && hunk.movePath !== undefined ? hunk.movePath : hunk.path
}

/**
 * Parses an apply_patch body. Codex always parses leniently: a body wrapped in `<<EOF` / `<<'EOF'` / `<<"EOF"` and a
 * final `…EOF` line (as gpt-4.1 sends through `local_shell`) is unwrapped first. `strict` exists for Codex's tests.
 */
export function parsePatch(text: string, mode: "lenient" | "strict" = "lenient"): Patch {
  const lines = RustStr.lines(RustStr.trim(text))
  const patchLines = mode === "strict" ? checkBoundariesStrict(lines) : checkBoundariesLenient(lines)
  const patch = patchLines.join("\n")
  const parser = new StreamingPatchParser()
  parser.pushDelta(patch)
  return { hunks: parser.finish(), patch, environmentId: parser.environmentId() }
}

function checkBoundariesStrict(lines: Array<string>) {
  const error = boundaryError(lines)
  if (error !== undefined) throw error
  return lines
}

function checkBoundariesLenient(lines: Array<string>) {
  const error = boundaryError(lines)
  if (error === undefined) return lines
  const first = lines[0]
  const heredoc =
    lines.length >= 4 &&
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    lines.at(-1)!.endsWith("EOF")
  if (!heredoc) throw error
  return checkBoundariesStrict(lines.slice(1, -1))
}

function boundaryError(lines: Array<string>) {
  const first = lines.length === 0 ? undefined : RustStr.trim(lines[0]!)
  const last = lines.length === 0 ? undefined : RustStr.trim(lines.at(-1)!)
  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return undefined
  if (first !== undefined && first !== BEGIN_PATCH_MARKER)
    return PatchParseError.invalidPatch("The first line of the patch must be '*** Begin Patch'")
  return PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'")
}

type Mode =
  | { type: "not-started" }
  | { type: "started" }
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; hunkLineNumber: number }
  | { type: "ended" }

/** Incremental parser for streamed tool-call arguments: complete lines become hunks before `*** End Patch` arrives. */
export class StreamingPatchParser {
  private lineBuffer = ""
  private lineNumber = 0
  private mode: Mode = { type: "not-started" }
  private hunks: Array<Hunk> = []
  private envID: string | undefined = undefined

  environmentId() {
    return this.envID
  }

  /** Feeds more text; returns the hunks parsed from complete lines so far. */
  pushDelta(delta: string): Array<Hunk> {
    const parts = delta.split("\n")
    parts.slice(0, -1).forEach((part) => {
      const line = this.lineBuffer + part
      this.lineBuffer = ""
      this.lineNumber += 1
      this.processLine(line.endsWith("\r") ? line.slice(0, -1) : line)
    })
    this.lineBuffer += parts.at(-1)!
    return structuredClone(this.hunks)
  }

  /** Processes a final unterminated line and requires the patch to have ended. */
  finish(): Array<Hunk> {
    if (this.lineBuffer !== "") this.finishLine()
    if (this.mode.type !== "ended")
      throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'")
    return structuredClone(this.hunks)
  }

  private finishLine() {
    const line = this.lineBuffer
    this.lineBuffer = ""
    this.lineNumber += 1
    if (RustStr.trim(line) !== END_PATCH_MARKER) return this.processLine(line)
    this.ensureUpdateHunkIsNotEmpty(END_PATCH_MARKER)
    this.mode = { type: "ended" }
  }

  private ensureUpdateHunkIsNotEmpty(line: string) {
    const last = this.hunks.at(-1)
    if (last?.type !== "update") return
    if (last.chunks.length === 0 && this.mode.type === "update")
      throw PatchParseError.invalidHunk(`Update file hunk for path '${last.path}' is empty`, this.mode.hunkLineNumber)
    const chunk = last.chunks.at(-1)
    if (chunk === undefined || chunk.oldLines.length > 0 || chunk.newLines.length > 0) return
    if (line === END_PATCH_MARKER)
      throw PatchParseError.invalidHunk("Update hunk does not contain any lines", this.lineNumber)
    throw PatchParseError.invalidHunk(unexpectedLine(line), this.lineNumber)
  }

  private handleHunkHeadersAndEndPatch(trimmed: string) {
    if (this.mode.type === "started" && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (this.envID !== undefined)
        throw PatchParseError.invalidPatch("apply_patch environment_id cannot be specified more than once")
      const environmentID = RustStr.trim(trimmed.slice(ENVIRONMENT_ID_MARKER.length))
      if (environmentID === "") throw PatchParseError.invalidPatch("apply_patch environment_id cannot be empty")
      this.envID = environmentID
      return true
    }
    if (trimmed === END_PATCH_MARKER) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.mode = { type: "ended" }
      return true
    }
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.hunks.push({ type: "add", path: trimmed.slice(ADD_FILE_MARKER.length), contents: "" })
      this.mode = { type: "add" }
      return true
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.hunks.push({ type: "delete", path: trimmed.slice(DELETE_FILE_MARKER.length) })
      this.mode = { type: "delete" }
      return true
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed)
      this.hunks.push({
        type: "update",
        path: trimmed.slice(UPDATE_FILE_MARKER.length),
        movePath: undefined,
        chunks: [],
      })
      this.mode = { type: "update", hunkLineNumber: this.lineNumber }
      return true
    }
    return false
  }

  private processLine(line: string) {
    const trimmed = RustStr.trim(line)
    const mode = this.mode
    if (mode.type === "not-started") {
      if (trimmed === BEGIN_PATCH_MARKER) {
        this.mode = { type: "started" }
        return
      }
      throw PatchParseError.invalidPatch("The first line of the patch must be '*** Begin Patch'")
    }
    if (mode.type === "ended") {
      if (trimmed === "") return
      throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'")
    }
    if (mode.type === "update") return this.processUpdateLine(line)
    if (this.handleHunkHeadersAndEndPatch(trimmed)) return
    const last = this.hunks.at(-1)
    if (mode.type === "add" && line.startsWith("+") && last?.type === "add") {
      last.contents += `${line.slice(1)}\n`
      return
    }
    throw PatchParseError.invalidHunk(
      `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
      this.lineNumber,
    )
  }

  private processUpdateLine(line: string) {
    const updateLine = RustStr.trimEnd(line)
    if (this.handleHunkHeadersAndEndPatch(updateLine)) return
    const hunk = this.hunks.at(-1)
    if (hunk?.type !== "update") throw PatchParseError.invalidHunk(unexpectedLine(line), this.lineNumber)
    const chunks = hunk.chunks
    const isContextMarker = updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)
    const lastChunk = chunks.at(-1)
    const lastChunkEmpty = lastChunk !== undefined && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0

    if (lastChunk?.isEndOfFile === true) {
      if (updateLine === "") return
      if (!isContextMarker)
        throw PatchParseError.invalidHunk(
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          this.lineNumber,
        )
    }
    if (chunks.length === 0 && hunk.movePath === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
      hunk.movePath = updateLine.slice(MOVE_TO_MARKER.length)
      return
    }
    if (isContextMarker && lastChunkEmpty) throw PatchParseError.invalidHunk(unexpectedLine(line), this.lineNumber)
    if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
      chunks.push(emptyChunk(undefined))
      return
    }
    if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
      chunks.push(emptyChunk(updateLine.slice(CHANGE_CONTEXT_MARKER.length)))
      return
    }
    if (updateLine === EOF_MARKER) {
      if (lastChunkEmpty) throw PatchParseError.invalidHunk("Update hunk does not contain any lines", this.lineNumber)
      if (lastChunk !== undefined) lastChunk.isEndOfFile = true
      return
    }
    if (line === "" || line.startsWith(" ")) {
      const chunk = currentChunk(chunks)
      const text = line.slice(1)
      chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length])
      chunk.oldLines.push(text)
      chunk.newLines.push(text)
      return
    }
    if (line.startsWith("+")) {
      currentChunk(chunks).newLines.push(line.slice(1))
      return
    }
    if (line.startsWith("-")) {
      currentChunk(chunks).oldLines.push(line.slice(1))
      return
    }
    if (lastChunk !== undefined && !lastChunkEmpty)
      throw PatchParseError.invalidHunk(
        `Expected update hunk to start with a @@ context marker, got: '${line}'`,
        this.lineNumber,
      )
    throw PatchParseError.invalidHunk(unexpectedLine(line), this.lineNumber)
  }
}

function unexpectedLine(line: string) {
  return `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`
}

function emptyChunk(changeContext: string | undefined): UpdateFileChunk {
  return { changeContext, oldLines: [], newLines: [], contextLineIndices: [], isEndOfFile: false }
}

/** The chunk a change line belongs to; a hunk without `@@` starts an implicit chunk. */
function currentChunk(chunks: Array<UpdateFileChunk>) {
  if (chunks.length === 0) chunks.push(emptyChunk(undefined))
  return chunks.at(-1)!
}

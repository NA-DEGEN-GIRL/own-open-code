// Ports dsh's file tools over its local filesystem: packages/fs/tool-fs/src/{read,read-render,write,edit,error}.ts and
// packages/fs/fs-local/src/{index,fsio}.ts. `read` answers a line-numbered window (`N: text`, 2000 lines, 2000
// characters a line, 50 KiB) in dsh's `<path>`/`<type>`/`<content>` envelope with a continuation footer; `write`
// creates or replaces a file and `edit` replaces literal text (unique unless `replace_all`) with the file's line endings
// kept. Both refuse a file the session has not read, or one that changed since (observe.ts), with dsh's remedy. Paths
// resolve against the session's directory, a leading `~` against the home folder; a file's identity is its real path,
// or its nearest existing ancestor's plus the missing rest. own's approvals are asked by tools.ts, as for core's tools.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86, with the home prefix of
// upstream f3803c9697 (fs-local `expandHomePrefix`, ae0dfd1003 and 32004176bf) and the write-failure texts of upstream
// 66491b05e3 (fsio `writeIoError`, 9b154c04a6 and 8f798da97d); see dsh-data/NOTICE.
export * as DshFs from "./fs.js"

import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { DshArgs } from "./args.js"
import { DshObserve } from "./observe.js"

export const READ_LIMIT = 2000
export const READ_MAX_LINE_LENGTH = 2000
export const READ_MAX_BYTES = 50 * 1024
const BINARY_SAMPLE_BYTES = 8192

export const READ_DESCRIPTION = "Read a UTF-8 text file and return line-numbered content."
export const WRITE_DESCRIPTION = "Create or fully replace a UTF-8 text file."
export const EDIT_DESCRIPTION = "Edit an existing UTF-8 text file by replacing literal text."

export const READ_SCHEMA: DshArgs.ObjectSchema = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path to read, resolved by the filesystem backend." },
    offset: { type: "number", description: "1-based first line to return. Defaults to 1." },
    limit: { type: "number", description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` },
  },
  required: ["file_path"],
}

export const WRITE_SCHEMA: DshArgs.ObjectSchema = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      description:
        "Path to write, resolved by the filesystem backend. Provide `file_path` before `content` in the arguments.",
    },
    content: { type: "string", description: "Full UTF-8 text content to write." },
  },
  required: ["file_path", "content"],
}

export const EDIT_SCHEMA: DshArgs.ObjectSchema = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      description:
        "Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments.",
    },
    old_string: { type: "string", description: "Literal text to replace." },
    new_string: {
      type: "string",
      description: "Literal replacement text. Use an empty string to delete the match.",
    },
    replace_all: {
      type: "boolean",
      description: "Replace all matches. Defaults to false; when false, old_string must appear exactly once.",
    },
  },
  required: ["file_path", "old_string", "new_string"],
}

/** The tools' system-prompt sections (`tool:read`, `tool:write`, `tool:edit`). */
export const READ_SECTION =
  "Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files."
export const writeSection = (edit: boolean) =>
  "Read an existing file before overwriting it with write (the default fs-observation-policy requires it)" +
  (edit ? " and prefer edit for targeted changes" : "") +
  "."
export const EDIT_SECTION =
  "Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session."

export interface ReadInput {
  readonly file_path: string
  readonly offset?: number
  readonly limit?: number
}

export interface WriteInput {
  readonly file_path: string
  readonly content: string
}

export interface EditInput {
  readonly file_path: string
  readonly old_string: string
  readonly new_string: string
  readonly replace_all?: boolean
}

export interface Target {
  /** The absolute path the model's path resolved to, which dsh's results show. */
  readonly displayPath: string
  /** The file's identity: its real path, or its nearest existing ancestor's plus the missing rest. */
  readonly key: string
}

/** `resolveLocalTarget`: the display path and identity of a model-written path. */
export async function resolve(file: string, cwd: string): Promise<Target> {
  if (file.trim().length === 0) throw new DshObserve.FsError("file_path must be a non-empty string", "FS_NOT_FOUND")
  const displayPath = path.resolve(cwd, expandHomePrefix(file))
  const real = await realpath(displayPath).catch(() => undefined)
  if (real !== undefined) return { displayPath, key: real }
  return { displayPath, key: await ancestorKey(displayPath) }
}

/**
 * `expandHomePrefix` (upstream f3803c9697): a leading `~` or `~/` (and `~\` on Windows only) is the home folder, not a
 * child of the session's directory. `~user` and a later `~` segment stay literal, and the rest of the spelling is kept.
 * Only a path the model wrote goes through it, never a directory entry name.
 */
function expandHomePrefix(file: string) {
  if (file === "~" || file.startsWith("~/") || (process.platform === "win32" && file.startsWith("~\\")))
    return `${os.homedir()}${file.slice(1)}`
  return file
}

/** `parseReadArgs`: offset and limit are positive integers, limit at most {@link READ_LIMIT}. */
export function readArgs(input: ReadInput) {
  if (input.file_path.trim().length === 0)
    return { ok: false as const, message: "file_path must be a non-empty string" }
  const positive = (value: number | undefined, name: string) =>
    value === undefined || (Number.isFinite(value) && Number.isInteger(value) && value >= 1)
      ? undefined
      : `${name} must be a positive integer`
  const bad = positive(input.offset, "offset") ?? positive(input.limit, "limit")
  if (bad !== undefined) return { ok: false as const, message: bad }
  const limit = input.limit ?? READ_LIMIT
  if (limit > READ_LIMIT) return { ok: false as const, message: `limit must be less than or equal to ${READ_LIMIT}` }
  return { ok: true as const, offset: input.offset ?? 1, limit }
}

/** Reads `target` as dsh's `read`: the envelope, and the version it read for the observation. */
export async function read(target: Target, window: { readonly offset: number; readonly limit: number }) {
  const info = await DshObserve.probe(target.key)
  if (info === undefined)
    return { observation: { kind: "absent" as const }, error: `cannot read "${target.displayPath}": not found` }
  if (!info.file) return { error: `cannot read "${target.displayPath}": not a regular file` }
  const raw = await readFile(target.key)
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0))
    return { error: `cannot read "${target.displayPath}": binary file` }
  const text = decode(raw)
  if (text === undefined) return { error: `cannot read "${target.displayPath}": invalid UTF-8 text` }
  const built = buildWindow(text, window)
  if (built.outOfRange)
    return {
      observation: { kind: "present" as const, version: info.version },
      error: `offset ${window.offset} is out of range for "${target.displayPath}" (${built.totalLines} lines)`,
    }
  const endLine = built.lines.at(-1)?.number ?? Math.max(0, window.offset - 1)
  return {
    observation: { kind: "present" as const, version: info.version },
    text: formatRead(target.displayPath, {
      offset: window.offset,
      lines: built.lines,
      totalLines: built.totalLines,
      truncatedByBytes: built.lines.length < window.limit && endLine < built.totalLines,
    }),
    lines: built.lines.length,
    totalLines: built.totalLines,
  }
}

/** `buildWindow`: numbered lines from `offset`, each cut at 2000 characters, stopping at the byte cap. */
export function buildWindow(text: string, window: { readonly offset: number; readonly limit: number }) {
  const raw = text.split("\n")
  // A trailing newline ends the last line rather than starting another (the stream scan flushes only non-empty rest).
  const all = raw.at(-1) === "" ? raw.slice(0, -1) : raw
  const scan = all.reduce(
    (state, line, index) => {
      const number = index + 1
      if (state.truncatedByBytes || number < window.offset || state.lines.length >= window.limit) return state
      const body = line.endsWith("\r") ? line.slice(0, -1) : line
      const cut =
        body.length > READ_MAX_LINE_LENGTH
          ? `${body.substring(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
          : body
      const bytes = Buffer.byteLength(cut, "utf8") + (state.lines.length > 0 ? 1 : 0)
      if (state.bytes + bytes > READ_MAX_BYTES) return { ...state, truncatedByBytes: true }
      state.lines.push({ number, text: cut })
      return { ...state, bytes: state.bytes + bytes }
    },
    { lines: [] as Array<{ number: number; text: string }>, bytes: 0, truncatedByBytes: false },
  )
  const outOfRange = !scan.truncatedByBytes && window.offset > all.length && !(all.length === 0 && window.offset === 1)
  return { lines: scan.lines, totalLines: all.length, truncatedByBytes: scan.truncatedByBytes, outOfRange }
}

/** `formatReadOutput`. */
export function formatRead(
  displayPath: string,
  outcome: {
    readonly offset: number
    readonly lines: ReadonlyArray<{ readonly number: number; readonly text: string }>
    readonly totalLines: number
    readonly truncatedByBytes?: boolean
  },
) {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  const footer = outcome.truncatedByBytes
    ? `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
    : endLine < outcome.totalLines
      ? `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
      : `(End of file - total ${outcome.totalLines} lines)`
  const body =
    outcome.lines.length > 0
      ? `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`
      : footer
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

/**
 * The write's plan: whether the file exists and what it holds now (for own's approval card). Fails with dsh's guard
 * texts: a file seen at a version is replaced only at that version, and one not read is never overwritten.
 */
export async function planWrite(target: Target, intent: ReturnType<DshObserve.State["writeIntent"]>) {
  const existing = await DshObserve.probe(target.key)
  if (existing !== undefined && !existing.file)
    throw new DshObserve.FsError(`cannot write "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE")
  if (intent.kind === "replaceIfVersion") {
    if (existing === undefined)
      throw new DshObserve.FsError(`cannot write "${target.displayPath}": file no longer exists`, "FS_STALE_VERSION")
    if (existing.version !== intent.version)
      throw new DshObserve.FsError(
        `cannot write "${target.displayPath}": file changed since it was read`,
        "FS_STALE_VERSION",
      )
  }
  if (intent.kind === "createIfAbsent" && existing !== undefined)
    throw new DshObserve.FsError(
      `cannot overwrite existing "${target.displayPath}" without reading it first`,
      "FS_NOT_OBSERVED",
    )
  const before = existing === undefined ? undefined : decode(await readFile(target.key))
  return { existed: existing !== undefined, version: existing?.version, before }
}

/** Writes the content (parents made) and answers dsh's envelope and the new version. */
export async function write(
  target: Target,
  content: string,
  plan: { readonly existed: boolean; readonly version?: string },
) {
  const now = await DshObserve.probe(target.key)
  if ((now?.version ?? undefined) !== plan.version)
    throw new DshObserve.FsError(
      `cannot write "${target.displayPath}": file changed since it was read`,
      "FS_STALE_VERSION",
    )
  await writeAtomic(target.displayPath, content)
  const after = await DshObserve.probe(target.key)
  const verb = plan.existed ? "Updated" : "Created"
  return {
    text: `<path>${target.displayPath}</path>\n<type>file</type>\n<content>\n${verb} file\n</content>`,
    version: after?.version ?? `missing:${target.key}`,
  }
}

/** `parseEditArgs`. */
export function editArgs(input: EditInput) {
  if (input.file_path.trim().length === 0) return "file_path must be a non-empty string"
  if (input.old_string.length === 0) return "old_string must be a non-empty string"
  if (input.old_string === input.new_string) return "old_string and new_string must differ"
  return undefined
}

/** Plans an edit at the observed `version`: the LF-normalized text before and after, and the bytes to write. */
export async function planEdit(target: Target, input: EditInput, version: string) {
  const existing = await DshObserve.probe(target.key)
  if (existing === undefined)
    throw new DshObserve.FsError(
      `cannot edit "${target.displayPath}": file changed since it was read`,
      "FS_STALE_VERSION",
    )
  if (!existing.file)
    throw new DshObserve.FsError(`cannot edit "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE")
  if (existing.version !== version)
    throw new DshObserve.FsError(
      `cannot edit "${target.displayPath}": file changed since it was read`,
      "FS_STALE_VERSION",
    )
  const raw = await readFile(target.key)
  if (raw.includes(0)) throw new DshObserve.FsError(`cannot edit "${target.displayPath}": binary file`, "FS_NOT_TEXT")
  const text = decode(raw)
  if (text === undefined)
    throw new DshObserve.FsError(`cannot edit "${target.displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT")
  const before = normalize(text)
  const edited = applyLiteralEdit(
    before,
    input.old_string,
    input.new_string,
    input.replace_all ?? false,
    target.displayPath,
  )
  return {
    before,
    after: edited.content,
    bytes: lineEndings(text) === "CRLF" ? normalize(edited.content).split("\n").join("\r\n") : edited.content,
    version,
  }
}

/** Writes a planned edit and answers dsh's sentence and the new version. */
export async function edit(
  target: Target,
  planned: { readonly bytes: string; readonly version: string },
  replaceAll: boolean,
) {
  const now = await DshObserve.probe(target.key)
  if (now?.version !== planned.version)
    throw new DshObserve.FsError(
      `cannot edit "${target.displayPath}": file changed since it was read`,
      "FS_STALE_VERSION",
    )
  await writeAtomic(target.displayPath, planned.bytes)
  const after = await DshObserve.probe(target.key)
  return {
    text: replaceAll
      ? `The file ${target.displayPath} has been updated. All occurrences were successfully replaced.`
      : `The file ${target.displayPath} has been updated successfully.`,
    version: after?.version ?? `missing:${target.key}`,
  }
}

/** `applyLiteralEdit` on LF-normalized content. */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
) {
  const oldNorm = normalize(oldString)
  if (oldNorm.length === 0) throw new DshObserve.FsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND")
  const newNorm = normalize(newString)
  const replacements = content.split(oldNorm).length - 1
  if (replacements === 0)
    throw new DshObserve.FsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND")
  if (!replaceAll && replacements > 1)
    throw new DshObserve.FsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      "FS_AMBIGUOUS_EDIT",
    )
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

function normalize(text: string) {
  return text.replaceAll("\r\n", "\n")
}

/** `detectLineEndings`: CRLF when the first 4096 characters hold more CRLF than bare LF. */
function lineEndings(raw: string) {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split("\r\n").length - 1
  const lf = sample.split("\n").length - 1 - crlf
  return crlf > lf ? "CRLF" : "LF"
}

/** `decodeUtf8` (fatal): undefined for invalid UTF-8; a leading BOM is dropped, as TextDecoder does. */
function decode(raw: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw)
  } catch {
    return undefined
  }
}

/**
 * A replacement that never leaves a half-written file: a private staging folder, then a rename over the target. A
 * failure the OS reports reads as dsh's text (upstream 66491b05e3 fsio `writeIoError`): a refusal is `permission
 * denied` with no staging path, any other failure carries Node's message, which can name the staging folder, as
 * upstream's does. Removing the staging folder is best effort, as upstream's: a write whose rename committed is never
 * reported as failed, and a failed rename keeps its own error.
 */
async function writeAtomic(file: string, content: string) {
  const directory = path.dirname(file)
  const replace = async () => {
    await mkdir(directory, { recursive: true })
    const mode = await stat(file).then(
      (info) => info.mode & 0o777,
      () => undefined,
    )
    const staging = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmpdir`)
    await mkdir(staging, { mode: 0o700 })
    const temp = path.join(staging, `${path.basename(file)}.tmp`)
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" })
    if (mode !== undefined) await chmod(temp, mode).catch(() => undefined)
    await rename(temp, file).finally(() => rm(staging, { recursive: true, force: true }).catch(() => undefined))
  }
  await replace().catch((error: unknown) => {
    throw writeIoError(file, error)
  })
}

/**
 * fsio `writeIoError`: a refusal (EACCES, or EPERM, which Windows gives for a read-only file) is `FS_PERMISSION_DENIED`,
 * any other Node failure `FS_IO_ERROR` with the OS's message; a value without an error code passes through unchanged.
 */
function writeIoError(file: string, error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return error
  if (error.code === "EACCES" || error.code === "EPERM")
    return new DshObserve.FsError(`cannot write "${file}": permission denied`, "FS_PERMISSION_DENIED", { cause: error })
  return new DshObserve.FsError(`cannot write "${file}": ${error.message}`, "FS_IO_ERROR", { cause: error })
}

async function ancestorKey(displayPath: string): Promise<string> {
  const missing = [path.basename(displayPath)]
  const walk = async (ancestor: string): Promise<string> => {
    const real = await realpath(ancestor).catch(() => undefined)
    if (real !== undefined) return path.join(real, ...missing.toReversed())
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return path.join(ancestor, ...missing.toReversed())
    missing.push(path.basename(ancestor))
    return walk(parent)
  }
  return walk(path.dirname(displayPath))
}

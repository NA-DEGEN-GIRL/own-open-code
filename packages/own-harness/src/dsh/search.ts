// Ports dsh's search tools: packages/fs/tool-fs-search/src/{glob,grep,search-core}.ts. Both run ripgrep with a plain
// argv (`--no-config` first, so no ripgrep config can inject a preprocessor) in the session's directory and give up
// after 30 s. `glob` lists files (`--files --sort=modified --no-ignore --hidden`, VCS folders left out) up to 100
// paths; `grep` reads `rg --json` matches grouped by file as `Line N: text`, up to 250, each line cut at 2000 bytes. A
// larger result keeps the inline page and saves the complete formatted result to a private file the footer names
// (packages/spill/spill-local: `<tmp>/dsh-spill-*/<session>/<random>-<name>`). dsh ships its own ripgrep; own runs the
// ripgrep on PATH, or the copy core keeps in opencode's cache folder (core/src/ripgrep/binary.ts).
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86, with two fixes of
// upstream f3803c9697: `glob` prunes unrelated folders for a plain folder prefix (ef284800b9, e8bdbbe823, b1c8c9bbbc,
// f9ef03834a) and `grep` takes an empty `include` as none (080a2c60b3, 4e4badb8f3); see dsh-data/NOTICE.
export * as DshSearch from "./search.js"

import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { DshArgs } from "./args.js"
import { DshShell } from "./shell.js"

export const GLOB_MAX_RESULTS = 100
export const GREP_MAX_MATCHES = 250
export const GREP_MAX_LINE_BYTES = 2000
export const RAW_OUTPUT_MAX_BYTES = 20_000_000
export const SEARCH_TIMEOUT_MS = 30_000
const STDERR_MAX_BYTES = 64 * 1024
export const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]
/** The argv bytes `glob`'s folder pruning may add (two arguments and their separators). */
const GLOB_PRUNE_MAX_BYTES = 8 * 1024
export const RETRIEVAL_HINT = "Use read with offset/limit, or grep this path to search within it."

export const GLOB_DESCRIPTION =
  "Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. " +
  `Returns up to ${GLOB_MAX_RESULTS} paths in modification-time order; a larger result keeps the first paths ` +
  "and reports where the complete list was saved."

export const GREP_DESCRIPTION =
  "Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. " +
  `Returns up to ${GREP_MAX_MATCHES} matches; a larger result reports where the complete match list was saved.`

export const GLOB_SCHEMA: DshArgs.ObjectSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). ' +
        'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
    },
    path: {
      type: "string",
      description: "Directory to search in. Defaults to the session workspace; a relative path resolves against it.",
    },
  },
  required: ["pattern"],
}

export const GREP_SCHEMA: DshArgs.ObjectSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regular expression to search for (ripgrep syntax)." },
    path: {
      type: "string",
      description:
        "File or directory to search. Defaults to the session workspace; a relative path resolves against it.",
    },
    include: {
      type: "string",
      description:
        'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
    },
  },
  required: ["pattern"],
}

export const GLOB_SECTION = "Use the glob tool — not shell find — to discover files by path pattern."
export const grepSection = (read: boolean) =>
  "Use the grep tool — not shell grep or rg — to search file contents." +
  (read ? " Use read on a matched file when you need surrounding context." : "")

export interface GlobInput {
  readonly pattern: string
  readonly path?: string
}

export interface GrepInput {
  readonly pattern: string
  readonly path?: string
  readonly include?: string
}

export interface Match {
  readonly path: string
  readonly lineNumber: number
  readonly line: string
}

/** `parseGlobArgs`. */
export function globArgs(input: GlobInput) {
  if (input.pattern.trim().length === 0) return "pattern must be a non-empty string"
  if (input.path !== undefined && input.path.trim().length === 0) return "path must be a non-empty string when given"
  return undefined
}

/**
 * `parseGrepArgs`: a non-empty pattern (whitespace is a legitimate regex) and one positive `include` glob. An exact empty
 * `include` is no filter (upstream f3803c9697, {@link grepCommand} leaves it out); whitespace alone still fails.
 */
export function grepArgs(input: GrepInput) {
  if (input.pattern.length === 0) return "pattern must be a non-empty string"
  if (input.path !== undefined && input.path.trim().length === 0) return "path must be a non-empty string when given"
  if (input.include === undefined || input.include === "") return undefined
  if (input.include.trim().length === 0) return "include must be a non-empty glob when given"
  if (input.include.startsWith("!"))
    return 'include must be a positive glob filter; negated patterns ("!…") are not supported'
  const depth = [...input.include].reduce(
    (state, char) =>
      state.list
        ? state
        : char === "{"
          ? { ...state, depth: state.depth + 1 }
          : char === "}"
            ? { ...state, depth: Math.max(0, state.depth - 1) }
            : char === "," && state.depth === 0
              ? { ...state, list: true }
              : state,
    { depth: 0, list: false },
  )
  return depth.list ? "include must be one glob, not a comma-separated list (use {a,b} alternation instead)" : undefined
}

/**
 * `buildGlobCommand`. Without `path`, a pattern whose folders are all plain names (upstream f3803c9697) lets ripgrep
 * skip every other folder: `!**` drops everything, `{dirs}/` takes folders of those names back (directories only,
 * at any depth) and the pattern itself, last, takes the files; the last matching glob wins, so the result is the same.
 * The two added arguments stay within 8 KiB, or the search walks the whole tree as before.
 */
export function globCommand(input: GlobInput) {
  const folders = input.pattern.split("/").slice(0, -1)
  const plain =
    input.path === undefined &&
    folders.length > 0 &&
    folders.every(
      (part) => /^[\w .-]+$/.test(part) && part !== "." && part !== ".." && !GLOB_VCS_EXCLUDES.includes(part),
    )
  const prune = `--glob={${[...new Set(folders)].join(",")}}/`
  return [
    "--files",
    ...(plain && prune.length + "--glob=!**".length + 2 <= GLOB_PRUNE_MAX_BYTES ? ["--glob=!**", prune] : []),
    `--glob=${input.pattern}`,
    "--sort=modified",
    "--no-ignore",
    "--hidden",
    ...GLOB_VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
    ...(input.path === undefined ? [] : ["--", input.path]),
  ]
}

/** `buildGrepCommand`. */
export function grepCommand(input: GrepInput) {
  return [
    "--json",
    `--regexp=${input.pattern}`,
    ...(input.include === undefined || input.include === "" ? [] : [`--glob=${input.include}`]),
    ...(input.path === undefined ? [] : ["--", input.path]),
  ]
}

/** The ripgrep to run: on PATH (as it is now), else the copy core downloads into opencode's cache (`Global.Path.bin`). */
export function ripgrep() {
  const name = process.platform === "win32" ? "rg.exe" : "rg"
  const onPath = Bun.which("rg", { PATH: process.env.PATH ?? "" })
  if (onPath !== null) return onPath
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  const cached = path.join(cache, "opencode", "bin", name)
  return existsSync(cached) ? cached : undefined
}

/** `runRipgrep`: complete stdout, whether ripgrep found nothing (exit 1), or dsh's failure text. */
export async function run(tool: "glob" | "grep", args: ReadonlyArray<string>, cwd: string, signal?: AbortSignal) {
  const aborted = `${tool} was aborted before completion (tool timeout or caller cancellation)`
  if (signal?.aborted) return { ok: false as const, message: aborted }
  const binary = ripgrep()
  if (binary === undefined)
    return { ok: false as const, message: `${tool} could not start its search command (ripgrep launch failed)` }
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const child = spawn(binary, ["--no-config", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  const kill = () => {
    if (child.pid !== undefined) DshShell.killTree(child.pid)
  }
  combined.addEventListener("abort", kill, { once: true })
  const stdout: Array<Buffer> = []
  const stderr: Array<Buffer> = []
  const sizes = { stdout: 0, stderr: 0 }
  child.stdout.on("data", (chunk: Buffer) => {
    sizes.stdout += chunk.length
    if (sizes.stdout <= RAW_OUTPUT_MAX_BYTES + 1) stdout.push(chunk)
  })
  child.stderr.on("data", (chunk: Buffer) => {
    sizes.stderr += chunk.length
    if (sizes.stderr <= STDERR_MAX_BYTES) stderr.push(chunk)
  })
  const exit = await new Promise<{ code: number | null; signal: string | null } | Error>((resolve) => {
    child.once("error", (error) => resolve(error))
    child.once("close", (code, signal) => resolve({ code, signal }))
  }).finally(() => combined.removeEventListener("abort", kill))
  if (combined.aborted) return { ok: false as const, message: aborted }
  if (exit instanceof Error)
    return { ok: false as const, message: `${tool} could not start its search command (ripgrep launch failed)` }
  if (exit.signal !== null || exit.code === null)
    return { ok: false as const, message: `${tool} search command was killed by signal ${exit.signal ?? "(unknown)"}` }
  if (exit.code !== 0 && exit.code !== 1) {
    const text = Buffer.concat(stderr).toString("utf8").trim()
    const excerpt = text.length === 0 ? "" : sizes.stderr > STDERR_MAX_BYTES ? `${text} [stderr truncated]` : text
    if (/regex parse error|error parsing glob/i.test(excerpt))
      return { ok: false as const, message: `${tool} pattern rejected by ripgrep: ${excerpt}` }
    return {
      ok: false as const,
      message: `${tool} search failed (exit ${exit.code})${excerpt.length > 0 ? `: ${excerpt}` : ""}`,
    }
  }
  if (sizes.stdout > RAW_OUTPUT_MAX_BYTES)
    return {
      ok: false as const,
      message: `${tool} produced ${sizes.stdout} bytes of raw output, over the ${RAW_OUTPUT_MAX_BYTES}-byte cap; narrow pattern, path, or include and retry`,
    }
  return { ok: true as const, stdout: Buffer.concat(stdout).toString("utf8"), noMatches: exit.code === 1 }
}

/** `toWorkdirRelative`: a path inside the directory relative to it, any other as ripgrep printed it. */
export function relative(file: string, cwd: string) {
  if (!path.isAbsolute(file)) return file
  const rel = path.relative(cwd, file)
  if (rel.length === 0) return "."
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return file
  return rel
}

/** Paths from `rg --files` output. */
export function globPaths(stdout: string, cwd: string) {
  return stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map((line) => relative(line, cwd))
}

/** `renderGlobPaths` without sampling (the standard preset's `sampleOverCapGlobResults: false`). */
export function renderGlob(paths: ReadonlyArray<string>, spill: string | undefined) {
  if (paths.length === 0) return "No files found"
  if (paths.length <= GLOB_MAX_RESULTS) return paths.join("\n")
  const recovery =
    spill === undefined
      ? "The complete result could not be saved; narrow pattern or path to see more."
      : `Full sorted result stored at: ${spill}. ${RETRIEVAL_HINT}`
  return `${paths.slice(0, GLOB_MAX_RESULTS).join("\n")}\n\n(Showing ${GLOB_MAX_RESULTS} of ${paths.length} paths. ${recovery})`
}

/** `parseGrepMatches`: the `match` records of `rg --json`, or dsh's malformed-output failure. */
export function grepMatches(stdout: string, cwd: string) {
  const malformed = (detail: string) => ({
    ok: false as const,
    message: `grep received malformed ripgrep --json output (${detail})`,
  })
  const lines = stdout.split("\n").filter((line) => line.length > 0)
  const matches: Array<Match> = []
  for (const line of lines) {
    const parsed = json(line)
    if (parsed === undefined || typeof parsed !== "object" || parsed === null)
      return malformed(parsed === undefined ? "a line is not JSON" : "a record is not an object")
    const record = parsed as { type?: unknown; data?: Record<string, unknown> }
    if (record.type !== "match") continue
    const data = record.data
    if (typeof data !== "object" || data === null) return malformed("a match record has no data")
    const pathText = (data.path as { text?: unknown } | undefined)?.text
    if (typeof pathText !== "string") return malformed("a match record has no path text")
    if (typeof data.line_number !== "number") return malformed("a match record has no line number")
    const content = data.lines as { text?: unknown; bytes?: unknown } | undefined
    if (typeof content !== "object" || content === null) return malformed("a match record has no line content")
    const text =
      typeof content.text === "string"
        ? content.text.replace(/\r?\n$/, "")
        : typeof content.bytes === "string"
          ? "(line is not valid UTF-8)"
          : undefined
    if (text === undefined) return malformed("a match record has neither line text nor bytes")
    matches.push({ path: relative(pathText, cwd), lineNumber: data.line_number, line: text })
  }
  return { ok: true as const, matches }
}

/** `previewLine`: the head within `maxBytes` on a UTF-8 boundary, marked when cut. */
export function previewLine(line: string, maxBytes = GREP_MAX_LINE_BYTES) {
  const bytes = Buffer.from(line, "utf8")
  if (bytes.length <= maxBytes) return line
  const start = [...Array(4).keys()]
    .map((back) => maxBytes - back)
    .find((end) => end <= 0 || (bytes[end]! & 0xc0) !== 0x80)
  return `${bytes.subarray(0, Math.max(0, start ?? maxBytes)).toString("utf8")} (line truncated)`
}

/** `formatGrepMatches`: each file's path, then one `Line N: text` row per match, files in first-seen order. */
export function formatMatches(matches: ReadonlyArray<Match>) {
  const files = matches.reduce((all, match) => {
    const group = all.get(match.path)
    if (group === undefined) return all.set(match.path, [match])
    group.push(match)
    return all
  }, new Map<string, Array<Match>>())
  return [...files]
    .map(([file, group]) => `${file}\n${group.map((match) => `Line ${match.lineNumber}: ${match.line}`).join("\n")}`)
    .join("\n\n")
}

/** `formatRetainedGrep` with the 250-match page and the spill footer. */
export function renderGrep(matches: ReadonlyArray<Match>, spill: string | undefined) {
  if (matches.length === 0) return "No matches found"
  const kept = matches.slice(0, GREP_MAX_MATCHES).map((match) => ({ ...match, line: previewLine(match.line) }))
  const truncated = matches.length > GREP_MAX_MATCHES
  const header = truncated
    ? `Found ${kept.length} of ${matches.length} matches`
    : `Found ${matches.length} ${noun(matches.length)}`
  if (!truncated) return `${header}\n\n${formatMatches(kept)}`
  const recovery =
    spill === undefined
      ? "The complete result could not be saved; narrow pattern, path, or include to see more."
      : `Full grep result stored at: ${spill}. ${RETRIEVAL_HINT}`
  return `${header}\n\n${formatMatches(kept)}\n\n(${recovery})`
}

/** The complete grep result dsh saves for a capped search. */
export function grepComplete(matches: ReadonlyArray<Match>) {
  const all = matches.map((match) => ({ ...match, line: previewLine(match.line) }))
  return `Found ${matches.length} ${noun(matches.length)}\n\n${formatMatches(all)}`
}

const spillRoot = { dir: undefined as string | undefined }

/** `saveTextFile`: the complete result in a private file of the session's folder, or undefined when it fails. */
export async function save(sessionID: string, name: string, content: string) {
  spillRoot.dir ??= mkdtempSync(path.join(os.tmpdir(), "dsh-spill-"))
  const dir = path.join(spillRoot.dir, sessionID.replace(/[^\w.-]/g, "_"))
  const file = path.join(dir, `${randomBytes(6).toString("hex")}-${name}`)
  return mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => writeFile(file, content, { flag: "wx", mode: 0o600 }))
    .then(
      () => file,
      () => undefined,
    )
}

function noun(count: number) {
  return count === 1 ? "match" : "matches"
}

function json(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

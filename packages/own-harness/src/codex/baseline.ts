export * as Baseline from "./baseline.js"

import path from "node:path"

/**
 * Reads back core's instruction baseline, the last system part of a session request (packages/core/src/instructions:
 * `renderInitial` joins the rendered sources with "\n\n" in source order: Code Mode catalog, MCP guidance, project
 * references, skills, AGENTS.md discovery, `core/date`, `core/environment`, then `api/*` context entries sorted by
 * key). Core gives a hook only the joined text, so the sections are found by their fixed openings (surface
 * `session-instruction-order`, `env-builtin`). A section the parser does not recognise stays in `rest`, so nothing the
 * session carries is dropped.
 */
export interface Parsed {
  readonly codemode?: string
  readonly mcp?: string
  readonly references?: string
  readonly skills?: string
  /**
   * Instruction files as core lists them: the global AGENTS.md first, then the project's nearest to farthest, then the
   * files and URLs of config `instructions` ({@link sources} tells them apart).
   */
  readonly instructions: ReadonlyArray<File>
  /** `Today's date: …` as written (`Date.toDateString()`). */
  readonly date?: string
  readonly environment?: Environment
  /** `api/<key>` entries (own's preset guidance, team roles, …) in baseline order. */
  readonly contexts: ReadonlyArray<{ readonly key: string; readonly value: string }>
  /** Text no known section accounts for. */
  readonly rest: ReadonlyArray<string>
}

export interface File {
  /** An absolute path, or the URL of a configured remote instruction. */
  readonly path: string
  readonly content: string
}

export interface Environment {
  readonly workingDirectory: string
  readonly workspaceRoot?: string
  readonly git?: boolean
  readonly platform?: string
}

const DATE = "Today's date: "
const ENVIRONMENT = "Here is some useful information about the environment you are running in:\n<env>\n"

/** Section openings before the date, in baseline order. */
const OPENINGS = [
  { key: "codemode", starts: ["# Code Mode\n", "No Code Mode tools are currently available."] },
  { key: "mcp", starts: ["<mcp_instructions>"] },
  { key: "references", starts: ["Project references provide additional directories"] },
  { key: "skills", starts: ["Skills provide specialized instructions and workflows"] },
  { key: "instructions", starts: ["Instructions from: "] },
] as const

/** Whether a system part is core's instruction baseline (it always carries the date and the environment). */
export function isBaseline(text: string) {
  return (text.startsWith(DATE) || text.includes(`\n\n${DATE}`)) && text.includes(ENVIRONMENT)
}

export function parse(baseline: string): Parsed {
  const at = baseline.startsWith(DATE) ? 0 : baseline.lastIndexOf(`\n\n${DATE}`)
  const head = at < 0 ? baseline : baseline.slice(0, at)
  const tail = at < 0 ? "" : baseline.slice(at === 0 ? 0 : at + 2)
  const sections = split(head)
  const dated = readTail(tail)
  return {
    codemode: sections.codemode,
    mcp: sections.mcp,
    references: sections.references,
    skills: sections.skills,
    instructions: sections.instructions === undefined ? [] : files(sections.instructions),
    date: dated.date,
    environment: dated.environment,
    contexts: dated.contexts,
    rest: [...(sections.rest === undefined ? [] : [sections.rest]), ...dated.rest],
  }
}

/**
 * Core's instruction files by where they came from (core/src/config/plugin/instruction.ts, surface
 * `config-instruction-files`): the global AGENTS.md, the project's AGENTS.md files from the working directory up, then
 * the matches of config `instructions` globs and the bodies of its http(s) URLs (upstream 1e63a3bb73). The baseline
 * names only the path, so the AGENTS.md run is read by shape: an AGENTS.md first outside the working directory's
 * folders is the global file, then AGENTS.md files in those folders; the first entry that is neither, and everything
 * after it, is configured.
 *
 * `realCwd` is the working directory resolved the way core resolves the folders it walks and the files it finds
 * (`fs.resolve`, a realpath): through a junction or a symbolic link the Location's spelling is not the path core walked.
 *
 * What the shape cannot tell apart, since the baseline names no source:
 * - With no global or project AGENTS.md before it, a configured AGENTS.md outside those folders reads as the global
 *   file.
 * - A configured AGENTS.md in the working directory or a folder above it that core's walk did not list (above the
 *   project root or the home folder the walk stops at, or with project discovery off), right after the global and
 *   project files, reads as a project file.
 * - The global AGENTS.md reads as a project file when the working directory lies under the global config folder.
 * - A project AGENTS.md that is itself a symbolic link is listed by its target. A target outside those folders reads as
 *   the global file when it comes first; otherwise, or under another name (AGENTS.md → CLAUDE.md), it and every file
 *   after it read as configured.
 */
export function sources(instructions: ReadonlyArray<File>, realCwd: string) {
  const head = instructions[0]
  const global = head !== undefined && agentsMd(head.path) && !projectFile(head.path, realCwd) ? [head] : []
  const rest = instructions.slice(global.length)
  const end = rest.findIndex((file) => !agentsMd(file.path) || !projectFile(file.path, realCwd))
  return {
    global,
    /** From the project root down to the working directory, the order Codex, Pi and dsh read them in. */
    project: (end < 0 ? rest : rest.slice(0, end)).toReversed(),
    /** In config order. */
    configured: end < 0 ? [] : rest.slice(end),
  }
}

/** `YYYY-MM-DD` of a `Date.toDateString()` text, as Codex's `<current_date>`. */
export function isoDate(text: string) {
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return undefined
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
}

function split(head: string) {
  const found = OPENINGS.flatMap((opening) => {
    const index = opening.starts
      .map((start) => locate(head, start))
      .filter((value) => value !== undefined)
      .sort((a, b) => a - b)[0]
    return index === undefined ? [] : [{ key: opening.key, index }]
  })
  // Keep baseline order; a later opening found before an earlier one belongs to that earlier section's text.
  const ordered = found.filter((entry, at) => found.slice(0, at).every((before) => before.index < entry.index))
  const prefix = ordered.length === 0 ? head : head.slice(0, ordered[0]!.index)
  const sections: Record<string, string> = {}
  ordered.forEach((entry, at) => {
    const end = ordered[at + 1]?.index
    sections[entry.key] = trimSeparator(head.slice(entry.index, end))
  })
  return {
    codemode: sections.codemode,
    mcp: sections.mcp,
    references: sections.references,
    skills: sections.skills,
    instructions: sections.instructions,
    rest: trimSeparator(prefix) === "" ? undefined : trimSeparator(prefix),
  }
}

/** Where a section opening starts: at the beginning or right after a "\n\n" separator. */
function locate(head: string, start: string) {
  if (head.startsWith(start)) return 0
  const at = head.indexOf(`\n\n${start}`)
  return at < 0 ? undefined : at + 2
}

function files(text: string) {
  return text.split(/\n\n(?=Instructions from: )/).map((entry) => {
    const body = entry.slice("Instructions from: ".length)
    const newline = body.indexOf("\n")
    return newline < 0
      ? { path: body, content: "" }
      : { path: body.slice(0, newline), content: body.slice(newline + 1) }
  })
}

// Core joins the name "AGENTS.md" onto each folder, but resolves real paths, which carry the name's case on disk.
function agentsMd(file: string) {
  return path.isAbsolute(file) && path.basename(file).toLowerCase() === "agents.md"
}

/** A file in the working directory or a folder above it. */
function projectFile(file: string, cwd: string) {
  const relative = path.relative(path.dirname(file), cwd)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function readTail(tail: string) {
  if (tail === "") return { contexts: [], rest: [] as Array<string> }
  const dateEnd = tail.indexOf("\n")
  const date = (dateEnd < 0 ? tail : tail.slice(0, dateEnd)).slice(DATE.length)
  const after = dateEnd < 0 ? "" : tail.slice(dateEnd + 1).replace(/^\n/, "")
  const envEnd = after.startsWith(ENVIRONMENT) ? after.indexOf("\n</env>") : -1
  const environment = envEnd < 0 ? undefined : readEnvironment(after.slice(ENVIRONMENT.length, envEnd))
  const remainder = envEnd < 0 ? after : after.slice(envEnd + "\n</env>".length).replace(/^\n\n/, "")
  const blocks = [...remainder.matchAll(/<context key="([^"]+)">\n([\s\S]*?)\n<\/context>/g)]
  const contexts = blocks.map((match) => ({ key: match[1]!, value: match[2]! }))
  const leftover = blocks.reduce((text, match) => text.replace(match[0], ""), remainder).trim()
  return { date, environment, contexts, rest: leftover === "" ? [] : [leftover] }
}

function readEnvironment(body: string): Environment | undefined {
  const field = (name: string) =>
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2)
  const workingDirectory = field("Working directory")
  if (workingDirectory === undefined) return undefined
  const git = field("Is directory a git repo")
  return {
    workingDirectory,
    workspaceRoot: field("Workspace root folder"),
    git: git === undefined ? undefined : git === "yes",
    platform: field("Platform"),
  }
}

function trimSeparator(text: string) {
  return text.replace(/\n\n$/, "")
}

// Reads in a read-only or ask codex session (own/docs/10-codex-harness.md §3.10). own has no OS sandbox, so its
// read-only approval mode refuses every command and ask asks before each, and Codex's models read files only through
// exec_command (`Get-Content`, `cat`, `rg`). In these modes exec_command answers a few simple read commands itself, with
// no process and no approval card: `parse` recognizes them and fails closed on anything else (which goes on to the
// shell approval: refused in read-only, asked in ask), and `run` reads what they name under own's `read` rules. The
// safety does not rest on the parser. Nothing is started but core's fixed-argument ripgrep inside core `grep` and
// `glob`, and every file whose content is returned is asserted `read` at its lexical and at its real path, so protected
// paths stay denied (through links and short names too) and `.env` files ask. A search checks its operand the same way
// first and searches folders only inside the project. A parser mistake costs fidelity only.
// The same answers serve the `explore` role in every mode, whose shell own-accounts always denies (`answers`), and Pi's
// `bash`, which is the pi harness's only way to list or search (12 §3.5, decisions SA-1).
export * as CodexReadOnly from "./read-only.js"

import type { Stats } from "node:fs"
import { readdir, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Permission } from "@opencode/schema/permission"
import { Tool } from "@opencode/schema/tool"
import { Preset } from "@own/protocol/preset"
import { Effect, Schema } from "effect"
import { HarnessPermission } from "../permission.js"
import { CoreTool } from "./core-tool.js"
import type { ExecManager } from "./exec/manager.js"
import { Wildcard } from "./wildcard.js"

export type Dialect = "powershell" | "posix"

/** A selection of lines, applied in pipeline order. */
export type Step =
  | { readonly kind: "first" | "last" | "skip"; readonly count: number }
  | { readonly kind: "lines"; readonly from: number; readonly to?: number }

export type Intent =
  | {
      readonly kind: "read"
      readonly dialect: Dialect
      /** The command's name in its error texts. */
      readonly command: string
      readonly file: string
      /** The text as it is (`Get-Content -Raw`, `cat`), not as lines. */
      readonly raw: boolean
      readonly steps: ReadonlyArray<Step>
    }
  | {
      readonly kind: "list"
      readonly dialect: Dialect
      readonly dir: string
      readonly dotfiles: boolean
      readonly filesOnly: boolean
    }
  | {
      readonly kind: "files"
      readonly dialect: Dialect
      readonly dir?: string
      readonly glob?: string
      readonly hidden: boolean
      /** Get-ChildItem's full paths, `-Name`'s relative ones, or `rg --files`' paths under the folder as given. */
      readonly show: "absolute" | "relative" | "rg"
    }
  | {
      readonly kind: "search"
      readonly dialect: Dialect
      readonly style: "rg" | "select-string"
      readonly pattern: string
      readonly path?: string
      readonly glob?: string
      readonly literal: boolean
      readonly caseSensitive: boolean
      readonly filesOnly: boolean
      readonly lineNumbers: boolean
    }

type Read = Extract<Intent, { kind: "read" }>
type List = Extract<Intent, { kind: "list" }>
type Files = Extract<Intent, { kind: "files" }>
type Search = Extract<Intent, { kind: "search" }>

/**
 * Whether exec_command answers reads in this session: own's read-only or ask bundle, its last `{shell, **}` rule a deny
 * or an ask, with own's protected-path denies after it (at least one absolute `{read, …, deny}`) and no later rule
 * whose action matches `shell` (such as a user's `{shell, Get-Content *, deny}`). Full access runs the commands
 * themselves. Rules without the protected denies, with a later shell rule (custom sets) or without a `{shell, **}` rule
 * answer nothing: read-only refuses every command and ask asks for each. Other later rules, such as the harness's tool
 * gate or the browser plugin's attachment allow, change nothing here.
 */
export function serves(rules: ReadonlyArray<Permission.Rule> | undefined) {
  const list = rules ?? []
  const shell = list.findLastIndex((rule) => rule.action === "shell" && rule.resource === "**")
  const tail = list.slice(shell + 1)
  return (
    (list[shell]?.effect === "deny" || list[shell]?.effect === "ask") &&
    !tail.some((rule) => Wildcard.match("shell", rule.action)) &&
    tail.some((rule) => rule.action === "read" && rule.effect === "deny" && path.isAbsolute(rule.resource))
  )
}

/**
 * Whether a session's shell tool answers reads itself: {@link serves} its rules, or its agent is a role own runs no
 * command for in any mode (`Preset.NO_SHELL_ROLES`, `explore`; own-accounts denies its `shell`). Such a role's model
 * reads, lists and searches through these answers alone in a harness without core's file tools (decisions SA-1).
 */
export function answers(rules: ReadonlyArray<Permission.Rule> | undefined, agent: string | undefined) {
  return Preset.noShell(agent) || serves(rules)
}

/** exec_command's answer for a command a read-only session or role refused; `reason` is the permission error. */
export function refused(reason: string, agent?: string) {
  return `${lead("exec_command", reason, agent)} one file or part of it (\`Get-Content\` or \`cat\` in PowerShell; \`cat\`, \`head\`, \`tail\` or \`sed -n\` in bash, zsh or sh), a folder listing (\`ls\`, or \`Get-ChildItem\` in PowerShell), a recursive file list (\`rg --files\`, or \`Get-ChildItem -Recurse -File\` in PowerShell) or a search (\`rg\`, or \`Select-String\` in PowerShell). Use one such command per call with literal paths, and \`workdir\` instead of \`cd\`.`
}

/**
 * Pi's bash answer for a refused command: bash's shapes only (Pi's bash is bash everywhere, Git Bash on Windows), and
 * no `workdir`, which Pi's bash does not have.
 */
export function refusedBash(reason: string, agent?: string) {
  return `${lead("bash", reason, agent)} one file or part of it (\`cat\`, \`head\`, \`tail\` or \`sed -n\`), a folder listing (\`ls\`), a recursive file list (\`rg --files\`) or a search (\`rg\`). Use one such command per call with literal paths and no \`cd\`.`
}

/**
 * The refusal's opening. A no-shell role gets its own reason in place of own-accounts' message, which names core's
 * read, grep and glob tools, absent from these harnesses.
 */
function lead(tool: string, reason: string, agent: string | undefined) {
  if (Preset.noShell(agent))
    return `${tool} was refused (this subagent role is read-only and may not run commands). For this role own runs no commands; it answers simple reads itself instead:`
  return `${tool} was refused (${reason}). In read-only approval mode own runs no commands; it answers simple reads itself instead:`
}

/** A rule denied the command: core's `Permission.BlockedError`, which P-019 keeps as the ToolFailure's `error`. */
export function blocked(error: Tool.Error) {
  const cause = error.error
  return typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Permission.BlockedError"
}

// Parsing ----------------------------------------------------------------------------------------------------------

/** The read a command asks for, or undefined for anything else (fails closed). */
export function parse(command: string, shell: ExecManager.ShellType): Intent | undefined {
  if (shell === "cmd") return undefined
  const dialect: Dialect = shell === "powershell" ? "powershell" : "posix"
  const stages = tokenize(command.trim(), dialect)
  if (stages === undefined || stages.length > 2 || stages.some((stage) => stage.length === 0)) return undefined
  const head = stages[0]!
  const next = stages[1]
  // A quoted first word is a string expression in PowerShell, not a command.
  if (dialect === "powershell" && !head[0]!.bare) return undefined
  const name = dialect === "powershell" ? head[0]!.text.toLowerCase() : head[0]!.text
  const args = head.slice(1)
  const texts = args.map((word) => word.text)
  if (name === "rg") return next === undefined ? ripgrep(texts, dialect) : undefined
  if (dialect === "posix") return next === undefined ? posix(name, texts) : undefined
  if (["get-content", "gc", "cat", "type"].includes(name)) return getContent(args, next)
  if (next !== undefined) return undefined
  if (["get-childitem", "gci", "ls", "dir"].includes(name)) return getChildItem(args)
  if (["select-string", "sls"].includes(name)) return selectString(args)
  return undefined
}

interface Word {
  readonly text: string
  /** The word starts outside quotes: only such a `-Name` is a PowerShell parameter. */
  readonly bare: boolean
}

/** Unicode quotes and dashes PowerShell reads as `'`, `"` and `-`. */
const LOOKALIKES = /[\u2018\u2019\u201c\u201d\u2013\u2014\u2015]/
/** Characters that expand, redirect, chain or group outside quotes. */
const SPECIAL: Readonly<Record<Dialect, string>> = { powershell: "`$;&<>(){}[],@#", posix: "$`\\;&<>(){}#" }

/** The words of each `|` stage; undefined for anything a shell would expand, redirect or run on its own. */
function tokenize(command: string, dialect: Dialect) {
  if (/[\r\n\0]/.test(command) || LOOKALIKES.test(command)) return undefined
  if (dialect === "powershell" && command.includes("--%")) return undefined
  const stages: Word[][] = [[]]
  let word: Word | undefined
  let index = 0
  const end = () => {
    if (word !== undefined) stages.at(-1)!.push(word)
    word = undefined
  }
  while (index < command.length) {
    const char = command[index]!
    if (char === " " || char === "\t" || char === "|") {
      end()
      if (char === "|") stages.push([])
      index++
      continue
    }
    if (char === "'" || char === '"') {
      const quoted = quote(command, index, dialect)
      if (quoted === undefined) return undefined
      word = { text: (word?.text ?? "") + quoted.text, bare: word?.bare ?? false }
      index = quoted.next
      continue
    }
    if (SPECIAL[dialect].includes(char)) return undefined
    word = { text: (word?.text ?? "") + char, bare: word?.bare ?? true }
    index++
  }
  end()
  return stages
}

/** The quoted part at `start`: `'…'` literal (PowerShell doubles a quote inside), `"…"` only when nothing expands. */
function quote(command: string, start: number, dialect: Dialect) {
  const mark = command[start]!
  let text = ""
  let index = start + 1
  while (index < command.length) {
    const char = command[index]!
    if (char === mark && dialect === "powershell" && command[index + 1] === mark) {
      text += mark
      index += 2
      continue
    }
    if (char === mark) return { text, next: index + 1 }
    if (mark === '"' && (char === "`" || char === "$" || (dialect === "posix" && char === "\\"))) return undefined
    text += char
    index++
  }
  return undefined
}

interface Parameters {
  /** Lowercase names and aliases → the parameter they bind. */
  readonly names: Readonly<Record<string, string>>
  readonly switches: ReadonlyArray<string>
  readonly positional: ReadonlyArray<string>
}

/** PowerShell's binding for the listed names and aliases only (no abbreviations); undefined on anything else. */
function bind(args: ReadonlyArray<Word>, spec: Parameters) {
  const bound = new Map<string, string | true>()
  const positional: string[] = []
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    const parameter = word.bare ? /^-([A-Za-z][\w-]*)(?::(.*))?$/s.exec(word.text) : null
    index++
    if (parameter === null) {
      positional.push(word.text)
      continue
    }
    const key = spec.names[parameter[1]!.toLowerCase()]
    if (key === undefined || bound.has(key)) return undefined
    if (spec.switches.includes(key)) {
      if (parameter[2] !== undefined) return undefined
      bound.set(key, true)
      continue
    }
    const following = args[index]
    const value = parameter[2] ?? (following?.bare && following.text.startsWith("-") ? undefined : following?.text)
    if (value === undefined || value === "") return undefined
    bound.set(key, value)
    if (parameter[2] === undefined) index++
  }
  const open = spec.positional.filter((key) => !bound.has(key))
  if (positional.length > open.length) return undefined
  positional.forEach((value, at) => bound.set(open[at]!, value))
  return bound
}

const CONTENT: Parameters = {
  names: {
    path: "path",
    literalpath: "path",
    raw: "raw",
    totalcount: "first",
    head: "first",
    first: "first",
    tail: "last",
    last: "last",
  },
  switches: ["raw"],
  positional: ["path"],
}

/** `Get-Content <file> [-TotalCount n | -Tail n | -Raw]`, optionally piped to `Select-Object [-Skip k] [-First n]`. */
function getContent(args: ReadonlyArray<Word>, next: ReadonlyArray<Word> | undefined): Intent | undefined {
  const bound = bind(args, CONTENT)
  const file = operand(bound?.get("path"))
  if (bound === undefined || file === undefined) return undefined
  const raw = bound.has("raw")
  const own = counts(bound, ["first", "last"])
  const piped = next === undefined ? [] : selectObject(next)
  if (own === undefined || piped === undefined || own.length > 1) return undefined
  if (raw && (own.length > 0 || next !== undefined)) return undefined
  return { kind: "read", dialect: "powershell", command: "Get-Content", file, raw, steps: [...own, ...piped] }
}

/** `Select-Object -Skip k -First n` (either or both); Select-Object skips before it takes. */
function selectObject(words: ReadonlyArray<Word>) {
  const name = words[0]!.text.toLowerCase()
  if (!words[0]!.bare || (name !== "select-object" && name !== "select")) return undefined
  const bound = bind(words.slice(1), { names: { skip: "skip", first: "first" }, switches: [], positional: [] })
  return bound === undefined || bound.size === 0 ? undefined : counts(bound, ["skip", "first"])
}

/** The bound line counts as steps in `kinds` order; undefined when one is not a count. */
function counts(bound: ReadonlyMap<string, string | true>, kinds: ReadonlyArray<"first" | "last" | "skip">) {
  const found = kinds.filter((kind) => bound.has(kind)).map((kind) => ({ kind, count: count(bound.get(kind)) }))
  const valid = found.filter(
    (step): step is { kind: (typeof kinds)[number]; count: number } => step.count !== undefined,
  )
  return valid.length === found.length ? valid : undefined
}

const CHILD_ITEM: Parameters = {
  names: {
    path: "path",
    literalpath: "path",
    filter: "filter",
    recurse: "recurse",
    file: "file",
    force: "force",
    name: "name",
  },
  switches: ["recurse", "file", "force", "name"],
  positional: ["path", "filter"],
}

/** `Get-ChildItem [dir] [-File] [-Force] [-Name]`, or recursive files only: `-Recurse -File [-Filter f]`. */
function getChildItem(args: ReadonlyArray<Word>): Intent | undefined {
  const bound = bind(args, CHILD_ITEM)
  if (bound === undefined) return undefined
  const filter = bound.get("filter")
  if (!bound.has("recurse")) {
    const dir = bound.has("path") ? operand(bound.get("path")) : "."
    if (dir === undefined || filter !== undefined) return undefined
    return { kind: "list", dialect: "powershell", dir, dotfiles: true, filesOnly: bound.has("file") }
  }
  const dir = bound.has("path") ? searchable(bound.get("path")) : "."
  if (dir === undefined || !bound.has("file")) return undefined
  return {
    kind: "files",
    dialect: "powershell",
    dir,
    glob: typeof filter === "string" ? filter : undefined,
    hidden: bound.has("force"),
    show: bound.has("name") ? "relative" : "absolute",
  }
}

const SELECT_STRING: Parameters = {
  names: {
    pattern: "pattern",
    path: "path",
    literalpath: "path",
    simplematch: "simplematch",
    casesensitive: "casesensitive",
  },
  switches: ["simplematch", "casesensitive"],
  positional: ["pattern", "path"],
}

/** `Select-String [-Pattern] p [-Path] file [-SimpleMatch] [-CaseSensitive]`. */
function selectString(args: ReadonlyArray<Word>): Intent | undefined {
  const bound = bind(args, SELECT_STRING)
  const pattern = bound?.get("pattern")
  const file = searchable(bound?.get("path"))
  if (bound === undefined || typeof pattern !== "string" || file === undefined) return undefined
  return {
    kind: "search",
    dialect: "powershell",
    style: "select-string",
    pattern,
    path: file,
    literal: bound.has("simplematch"),
    caseSensitive: bound.has("casesensitive"),
    filesOnly: false,
    lineNumbers: true,
  }
}

const RG_FLAGS: Readonly<Record<string, string>> = {
  "-n": "n",
  "--line-number": "n",
  "-i": "i",
  "--ignore-case": "i",
  "-F": "F",
  "--fixed-strings": "F",
  "-l": "l",
  "--files-with-matches": "l",
  "--files": "files",
  "--hidden": "hidden",
}
const RG_VALUES: Readonly<Record<string, string>> = {
  "-g": "glob",
  "--glob": "glob",
  "-e": "regexp",
  "--regexp": "regexp",
}

/** `rg [-n] [-i] [-F] [-l] [-g glob] pattern [path]` and `rg --files [--hidden] [-g glob] [dir]`. */
function ripgrep(args: ReadonlyArray<string>, dialect: Dialect): Intent | undefined {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const operands: string[] = []
  let options = true
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    index++
    if (!options || !arg.startsWith("-") || arg === "-") {
      operands.push(arg)
      continue
    }
    if (arg === "--") {
      options = false
      continue
    }
    const inline = /^(--glob|--regexp)=(.*)$/s.exec(arg)
    const key = RG_VALUES[inline?.[1] ?? arg]
    if (key !== undefined) {
      const value = inline?.[2] ?? args[index]
      if (value === undefined || value === "" || values.has(key)) return undefined
      values.set(key, value)
      if (inline === null) index++
      continue
    }
    const names = (/^-[niFl]+$/.test(arg) ? [...arg.slice(1)].map((flag) => `-${flag}`) : [arg]).map(
      (flag) => RG_FLAGS[flag],
    )
    if (names.some((name) => name === undefined)) return undefined
    names.forEach((name) => flags.add(name!))
  }
  if (flags.has("files")) {
    const dir = operands[0]
    if (["n", "i", "F", "l"].some((flag) => flags.has(flag)) || values.has("regexp") || operands.length > 1)
      return undefined
    if (dir !== undefined && searchable(dir) === undefined) return undefined
    return { kind: "files", dialect, dir, glob: values.get("glob"), hidden: flags.has("hidden"), show: "rg" }
  }
  const regexp = values.get("regexp")
  const [pattern, ...paths] = regexp === undefined ? operands : [regexp, ...operands]
  const where = paths[0]
  if (pattern === undefined || pattern === "" || paths.length > 1) return undefined
  if (where !== undefined && searchable(where) === undefined) return undefined
  return {
    kind: "search",
    dialect,
    style: "rg",
    pattern,
    path: where,
    glob: values.get("glob"),
    literal: flags.has("F"),
    caseSensitive: !flags.has("i"),
    filesOnly: flags.has("l"),
    lineNumbers: flags.has("n"),
  }
}

/** `cat f`, `head|tail [-n N | -N] f`, `sed -n 'A,Bp' f` and `ls [-1aAlFh] [dir]`. */
function posix(name: string, args: ReadonlyArray<string>): Intent | undefined {
  const read = (file: string | undefined, raw: boolean, steps: ReadonlyArray<Step>): Intent | undefined => {
    const checked = file?.startsWith("-") ? undefined : operand(file)
    return checked === undefined
      ? undefined
      : { kind: "read", dialect: "posix", command: name, file: checked, raw, steps }
  }
  if (name === "cat") return args.length === 1 ? read(args[0], true, []) : undefined
  if (name === "head" || name === "tail") {
    const lines = count(lineCount(args))
    if (lines === undefined) return undefined
    return read(args.at(-1), false, [{ kind: name === "head" ? "first" : "last", count: lines }])
  }
  if (name === "sed") {
    const range = args.length === 3 && args[0] === "-n" ? /^(\d+)(?:,(\d+|\$))?p$/.exec(args[1]!) : null
    const from = count(range?.[1])
    const to = range?.[2] === undefined ? from : range[2] === "$" ? undefined : count(range[2])
    if (range === null || from === undefined || from === 0 || (range[2] !== "$" && to === undefined)) return undefined
    return read(args[2], false, [{ kind: "lines", from, to }])
  }
  if (name !== "ls") return undefined
  const flags = args.filter((arg) => arg.startsWith("-"))
  const dirs = args.filter((arg) => !arg.startsWith("-"))
  const dir = dirs.length === 0 ? "." : operand(dirs[0])
  if (flags.some((flag) => !/^-[1aAlFh]+$/.test(flag)) || dirs.length > 1 || dir === undefined) return undefined
  return { kind: "list", dialect: "posix", dir, dotfiles: flags.some((flag) => /[aA]/.test(flag)), filesOnly: false }
}

/** `head`/`tail`'s line count: `-n N f`, `-N f` or `-nN f`, 10 for `f` alone. */
function lineCount(args: ReadonlyArray<string>) {
  if (args.length === 3 && args[0] === "-n") return args[1]
  if (args.length === 2) return /^-n?(\d+)$/.exec(args[0]!)?.[1]
  if (args.length === 1) return "10"
  return undefined
}

/** A literal path: no wildcard, UNC path, stream or provider (`Env:`, `HKCU:`); `~` only as the home folder. */
function operand(value: string | true | undefined) {
  if (typeof value !== "string" || value === "" || /[*?[\]]/.test(value) || /^[\\/]{2}/.test(value)) return undefined
  if (value.slice(/^[A-Za-z]:/.test(value) ? 2 : 0).includes(":")) return undefined
  if (value.startsWith("~") && !/^~(?:$|[\\/])/.test(value)) return undefined
  return value
}

/** A folder or file for core grep and glob, which resolve against the Location: a literal path without `~`. */
function searchable(value: string | true | undefined) {
  const checked = operand(value)
  return checked?.startsWith("~") ? undefined : checked
}

function count(value: string | true | undefined) {
  if (typeof value !== "string" || !/^\d{1,8}$/.test(value)) return undefined
  const number = Number(value)
  return number <= 10_000_000 ? number : undefined
}

// Running ----------------------------------------------------------------------------------------------------------

/** What a served command answers: its output and the exit code the command would have given. */
export interface Done {
  readonly output: string
  readonly exitCode: number
}

type Ctx = Pick<Context, "permission" | "tool" | "location">

/** Files larger than this are not read (the read tool's own limits are smaller; exec output is truncated anyway). */
const MAX_FILE_BYTES = 16 * 1024 * 1024
const FILE_LIMIT = 2_000
const MATCH_LIMIT = 500

/**
 * Answers a parsed read without starting a process. Undefined when core's `grep` or `glob` is not registered, so the
 * command goes on to the shell approval.
 */
export function run(ctx: Ctx, intent: Intent, input: { readonly cwd: string; readonly tool: Tool.Context }) {
  return Effect.gen(function* () {
    const needs = intent.kind === "files" ? "glob" : intent.kind === "search" ? "grep" : undefined
    if (needs !== undefined && !(yield* ctx.tool.list()).some((entry) => entry.id === needs)) return undefined
    // The same working-folder check the shell approval makes.
    const [where] = yield* ctx.permission.paths({ paths: [input.cwd], kind: "directory" }, input.tool)
    const cwd = where!.absolute
    if (intent.kind === "read") return yield* read(ctx, intent, cwd, input.tool)
    if (intent.kind === "list") return yield* list(ctx, intent, cwd, input.tool)
    if (intent.kind === "files") return yield* files(ctx, intent, cwd, input.tool)
    return yield* search(ctx, intent, cwd, input.tool)
  })
}

function read(ctx: Ctx, intent: Read, cwd: string, tool: Tool.Context) {
  return Effect.gen(function* () {
    const [file] = yield* readable(ctx, [locate(cwd, intent.file)], "file", tool)
    const powershell = intent.dialect === "powershell"
    const shown = powershell ? file!.absolute : intent.file
    const real = file!.real
    const info = real === undefined ? undefined : yield* Effect.promise(() => stat(real).catch(() => undefined))
    if (real === undefined || info === undefined)
      return failed(
        powershell
          ? `Get-Content: Cannot find path '${shown}' because it does not exist.`
          : `${intent.command}: ${shown}: No such file or directory`,
      )
    if (info.isDirectory())
      return failed(
        powershell
          ? `Get-Content: Unable to get content because it is a directory: '${shown}'. Please use 'Get-ChildItem' instead.`
          : `${intent.command}: ${shown}: Is a directory`,
      )
    if (!info.isFile()) return failed(`${intent.command}: ${shown}: not a regular file`)
    if (info.size > MAX_FILE_BYTES)
      return failed(`${intent.command}: ${shown}: own answers this command itself and reads files of up to 16 MiB`)
    const bytes = yield* Effect.promise(() =>
      Bun.file(real)
        .bytes()
        .catch(() => undefined),
    )
    if (bytes === undefined) return failed(`${intent.command}: ${shown}: cannot read the file`)
    // UTF-8 (its BOM dropped), or UTF-16LE by its BOM as Windows PowerShell writes it.
    const text = new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8").decode(bytes)
    if (text.slice(0, 8_192).includes("\0"))
      return failed(
        `${intent.command}: ${shown}: binary file; own answers this command itself and reads text files only`,
      )
    return { output: content(intent, text), exitCode: 0 }
  })
}

function content(intent: Read, text: string) {
  const eol = intent.dialect === "powershell" ? os.EOL : "\n"
  if (intent.raw) return intent.dialect === "powershell" && text !== "" && !text.endsWith("\n") ? `${text}${eol}` : text
  const lines = text.split(/\r?\n/)
  const selected = intent.steps.reduce(select, lines.at(-1) === "" ? lines.slice(0, -1) : lines)
  return selected.map((line) => `${line}${eol}`).join("")
}

function select(lines: ReadonlyArray<string>, step: Step) {
  if (step.kind === "lines")
    return lines.slice(step.from - 1, step.to === undefined ? undefined : Math.max(step.from, step.to))
  if (step.kind === "first") return lines.slice(0, step.count)
  if (step.kind === "last") return step.count === 0 ? [] : lines.slice(-step.count)
  return lines.slice(step.count)
}

/** One folder level: names, folders ending in the separator (PowerShell lists folders first). */
function list(ctx: Ctx, intent: List, cwd: string, tool: Tool.Context) {
  return Effect.gen(function* () {
    const [dir] = yield* readable(ctx, [locate(cwd, intent.dir)], "directory", tool)
    const powershell = intent.dialect === "powershell"
    const shown = powershell ? dir!.absolute : intent.dir
    const real = dir!.real
    const info = real === undefined ? undefined : yield* Effect.promise(() => stat(real).catch(() => undefined))
    if (real === undefined || info === undefined)
      return powershell
        ? failed(`Get-ChildItem: Cannot find path '${shown}' because it does not exist.`)
        : failed(`ls: cannot access '${shown}': No such file or directory`, 2)
    if (!info.isDirectory()) return { output: `${shown}\n`, exitCode: 0 }
    const entries = yield* Effect.promise(() => readdir(real, { withFileTypes: true }).catch(() => undefined))
    if (entries === undefined) return failed(`${powershell ? "Get-ChildItem" : "ls"}: ${shown}: cannot read the folder`)
    const separator = powershell ? path.sep : "/"
    const order = (name: string) => (powershell ? name.toLowerCase() : name)
    const output = entries
      .filter((entry) => intent.dotfiles || !entry.name.startsWith("."))
      .filter((entry) => !intent.filesOnly || !entry.isDirectory())
      .toSorted((left, right) => {
        if (powershell && left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
        if (order(left.name) === order(right.name)) return 0
        return order(left.name) < order(right.name) ? -1 : 1
      })
      .map((entry) => `${entry.name}${entry.isDirectory() ? separator : ""}\n`)
      .join("")
    return { output, exitCode: 0 }
  })
}

const Entries = Schema.Array(Schema.Struct({ path: Schema.String }))

/** Every file under a folder, through core `glob` (file names only, as the glob tool lists them). */
function files(ctx: Ctx, intent: Files, cwd: string, tool: Tool.Context) {
  return Effect.gen(function* () {
    const dir = path.resolve(cwd, intent.dir ?? ".")
    const done = yield* core(
      ctx,
      "glob",
      { pattern: intent.glob ?? "*", path: dir, hidden: intent.hidden, limit: FILE_LIMIT },
      Entries,
      tool,
    )
    const shown = done.output.map((entry) => {
      const absolute = path.resolve(ctx.location.directory, entry.path)
      if (intent.show === "absolute") return absolute
      const relative = path.relative(dir, absolute)
      return intent.show === "rg" && intent.dir !== undefined ? path.join(intent.dir, relative) : relative
    })
    const notice = done.metadata?.truncated === true ? [`(own lists at most ${FILE_LIMIT} files here)`] : []
    return {
      output: [...shown, ...notice].map((line) => `${line}\n`).join(""),
      exitCode: intent.show === "rg" && shown.length === 0 ? 1 : 0,
    }
  })
}

const Matches = Schema.Array(
  Schema.Struct({ entry: Schema.Struct({ path: Schema.String }), line: Schema.Number, text: Schema.String }),
)

/**
 * A content search through core `grep` (which asks `grep` and searches hidden files too). The operand is checked
 * first, like a file read, so a protected file is denied whatever the pattern. A folder is searched only inside the
 * project: own's protected denies are absolute paths and match nothing there, so a pattern that finds nothing tells
 * nothing about a protected file. No line is answered before every matched file passed the `read` check at its
 * lexical and real path; a deny fails the whole call.
 */
function search(ctx: Ctx, intent: Search, cwd: string, tool: Tool.Context) {
  return Effect.gen(function* () {
    const root = path.resolve(cwd, intent.path ?? ".")
    const [checked] = yield* readable(ctx, [root], "file", tool)
    const real = checked!.real
    const info = real === undefined ? undefined : yield* Effect.promise(() => stat(real).catch(() => undefined))
    const refusal = refuse(intent, root, info, checked!.external)
    if (refusal !== undefined) return refusal
    const done = yield* core(
      ctx,
      "grep",
      {
        pattern: intent.pattern,
        path: real,
        ...(intent.glob === undefined ? {} : { include: intent.glob }),
        literal: intent.literal,
        caseSensitive: intent.caseSensitive,
        limit: MATCH_LIMIT,
      },
      Matches,
      tool,
    )
    const matches = done.output
    const absolute = (match: (typeof matches)[number]) => path.resolve(ctx.location.directory, match.entry.path)
    const matched = [...new Set(matches.map(absolute))]
    const found = matched.length === 0 ? [] : yield* readable(ctx, matched, "file", tool)
    if (
      found.length !== matched.length ||
      found.some((file, index) => file.real === undefined || !samePath(file.absolute, matched[index]!))
    )
      return yield* Effect.fail(new Tool.Error({ message: "own could not check the read permission of every match" }))
    const display = (file: string) => path.relative(cwd, file) || path.basename(file)
    const single = info!.isFile()
    const lines = intent.filesOnly
      ? matched.map(display)
      : matches.map((match) => {
          const text = match.text.replace(/\r?\n$/, "")
          const file = display(absolute(match))
          if (intent.style === "select-string") return `${file}:${match.line}:${text}`
          return `${single ? "" : `${file}:`}${intent.lineNumbers ? `${match.line}:` : ""}${text}`
        })
    const notice = done.metadata?.truncated === true ? [`(own shows at most ${MATCH_LIMIT} matching lines here)`] : []
    return {
      output: [...lines, ...notice].map((line) => `${line}\n`).join(""),
      exitCode: intent.style === "rg" && matches.length === 0 ? 1 : 0,
    }
  })
}

/** Why a checked search operand is not searched: missing, a folder for Select-String, or a folder outside the project. */
function refuse(intent: Search, root: string, info: Stats | undefined, external: boolean): Done | undefined {
  const shown = intent.path ?? "."
  if (info === undefined)
    return intent.style === "rg"
      ? failed(`rg: ${shown}: No such file or directory (os error 2)`, 2)
      : failed(`Select-String: Cannot find path '${root}' because it does not exist.`)
  if (info.isFile()) return undefined
  if (intent.style === "select-string")
    return failed(
      `Select-String: own answers Select-String itself for one file, and '${root}' is a folder; use rg for folders`,
    )
  if (!external) return undefined
  return failed(
    `rg: own answers rg itself and searches folders only inside the project, and '${shown}' is outside it; search one file there by its path`,
    2,
  )
}

/**
 * `permission.paths` and one `read` assert for what a command reads, at the lexical paths and, where it differs, at
 * the real paths (links, junctions, short names), so a protected deny cannot be stepped around. `real` is undefined
 * when nothing exists there; `external` says whether the path read (the real one when it exists) is outside the
 * project. view_image checks its file the same way in every mode.
 */
export function readable(
  ctx: Pick<Context, "permission">,
  paths: ReadonlyArray<string>,
  kind: "file" | "directory",
  tool: Tool.Context,
) {
  return Effect.gen(function* () {
    const lexical = yield* ctx.permission.paths({ paths, kind }, tool)
    const reals = yield* Effect.promise(() =>
      Promise.all(lexical.map((target) => realpath(target.absolute).catch(() => undefined))),
    )
    const moved = reals.filter(
      (real, index): real is string => real !== undefined && !samePath(real, lexical[index]!.absolute),
    )
    const resolved = moved.length === 0 ? [] : yield* ctx.permission.paths({ paths: moved, kind }, tool)
    yield* HarnessPermission.assert(
      ctx,
      {
        action: "read",
        resources: [...new Set([...lexical, ...resolved].map((target) => target.resource))],
        save: ["*"],
      },
      tool,
    )
    return lexical.map((target, index) => {
      const real = reals[index]
      const at = real === undefined ? undefined : resolved.find((entry) => samePath(entry.absolute, real))
      return { absolute: target.absolute, real, external: (at ?? target).external }
    })
  })
}

/**
 * A core tool's result with its output decoded by `output`; its failures, a `grep` or `glob` deny included, answer
 * the model as core's do.
 */
function core<S extends Schema.Top>(ctx: Ctx, id: string, input: object, output: S, tool: Tool.Context) {
  return Effect.gen(function* () {
    const done = yield* CoreTool.call(ctx, id, input, tool)
    return { output: yield* Schema.decodeUnknownEffect(output)(done.output ?? []), metadata: done.metadata }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof Tool.Error ? error : new Tool.Error({ message: error.message, error }),
    ),
  )
}

/** Relative operands from the command's folder; `~` and absolute paths as core resolves them. */
function locate(cwd: string, operand: string) {
  return operand.startsWith("~") || path.isAbsolute(operand) ? operand : path.resolve(cwd, operand)
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function failed(text: string, exitCode = 1): Done {
  return { output: `${text}\n`, exitCode }
}

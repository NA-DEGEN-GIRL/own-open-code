export * as SkillFormat from "./format.js"

import { createHash } from "node:crypto"
import matter from "gray-matter"
import { OwnImport } from "@own/protocol/rpc-import"
import { Option, Schema } from "effect"

/**
 * How a skill's format fits own (09 §9.3), pure. Core reads a `SKILL.md` with gray-matter (retrying with unquoted
 * colons turned into block scalars, `packages/core/src/config/markdown.ts`) and takes only `name`, `description`,
 * `metadata` (`opencode/autoinvoke`) and `disable-model-invocation` from its frontmatter
 * (`packages/core/src/config/plugin/skill-file.ts`); the body reaches the model as it is. So a skill is `incompatible`
 * when it relies on something Claude Code does around it that own would silently skip (hooks, a forked sub-agent,
 * commands run into the body, its variables, `$ARGUMENTS`); a field that only changes permissions or display is a
 * note. A Codex skill whose `agents/openai.yaml` turns implicit use off is `converted`: its copy says the same with
 * `disable-model-invocation: true`, the one conversion that loses nothing.
 */

export interface Analysis {
  readonly format: OwnImport.SkillFormat
  readonly name?: string
  readonly description?: string
  /** Frontmatter `version`, else `metadata.version` (SK2: shown to tell copies apart). */
  readonly version?: string
}

export interface Options {
  /**
   * A Codex skill (SK2, 2026-10-24): Codex leaves Claude Code's syntax (`` !`…` ``, `$ARGUMENTS`, `${CLAUDE_…}`, hooks, a
   * forked context) as text, as own does, so it is the note `claude_only` and not a problem.
   */
  readonly codex?: boolean
}

/** The keys core reads, and the harmless ones of the Agent Skills format that change nothing in own. */
const READ = new Set(["name", "description", "metadata", "disable-model-invocation"])
const HARMLESS = new Set(["license", "version", "compatibility", "author"])
const NOTES: Readonly<Record<string, OwnImport.SkillNote>> = {
  "allowed-tools": "allowed_tools",
  tools: "allowed_tools",
  "user-invocable": "user_invocable",
  "argument-hint": "argument_hint",
  model: "model",
  when_to_use: "when_to_use",
  "when-to-use": "when_to_use",
}

/** Claude Code runs `` !`command` `` and puts its output into the body before the model reads it. */
const DYNAMIC = /(?:^|[^\\\w`])!`[^`\n]+`/m
const VARIABLES = /\$\{CLAUDE_(?:SKILL_DIR|PLUGIN_ROOT|PLUGIN_DATA|SESSION_ID)\}/
const ARGUMENTS = /\$ARGUMENTS\b/

const Frontmatter = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

/**
 * The format of one skill from its `SKILL.md` (`undefined`: the folder has none) and, for a Codex skill, its
 * `agents/openai.yaml`. File-level problems (links, secrets, size) are added with {@link withProblems}. The body is
 * checked without its fenced code blocks (SK2): a block that shows `$ARGUMENTS` or `` !`git status` `` is an example,
 * not something the skill relies on; a fence opened with `!` is Claude Code's multi-line command, which it runs.
 */
export function analyze(skillMd: string | undefined, openaiYaml?: string, options: Options = {}): Analysis {
  if (skillMd === undefined) return { format: incompatible(["no_skill_md"]) }
  if (foreign(skillMd)) return { format: incompatible(["frontmatter_language"]) }
  const parsed = parse(skillMd)
  const front = parsed === undefined ? Option.none() : decodeFrontmatter(parsed.data)
  if (parsed === undefined || Option.isNone(front)) return { format: incompatible(["frontmatter"]) }
  const data = parsed.data
  const keys = Object.keys(data)
  const body = prose(parsed.content)
  const claude: OwnImport.SkillProblem[] = [
    ...(keys.includes("hooks") ? (["hooks"] as const) : []),
    ...(data.context === "fork" ? (["context_fork"] as const) : []),
    ...(body.bang || DYNAMIC.test(body.text) ? (["dynamic_context"] as const) : []),
    ...(VARIABLES.test(body.text) ? (["skill_variables"] as const) : []),
    ...(ARGUMENTS.test(body.text) ? (["arguments"] as const) : []),
  ]
  const problems = options.codex ? [] : claude
  const ignored = keys.filter(
    (key) =>
      !READ.has(key) &&
      !HARMLESS.has(key) &&
      NOTES[key] === undefined &&
      key !== "hooks" &&
      !(key === "context" && data.context === "fork") &&
      !(key === "agent" && data.context === "fork"),
  )
  const codex = openaiYaml === undefined ? undefined : codexMetadata(openaiYaml)
  const notes = unique([
    ...keys.flatMap((key) => (NOTES[key] === undefined ? [] : [NOTES[key]])),
    ...(codex?.interface ? (["codex_interface"] as const) : []),
    ...(codex?.dependencies ? (["codex_dependencies"] as const) : []),
    ...(ignored.length > 0 ? (["unknown_fields"] as const) : []),
    ...(options.codex && claude.length > 0 ? (["claude_only"] as const) : []),
  ])
  const version = versionOf(data)
  const converts =
    codex?.implicit === false && !keys.includes("disable-model-invocation") && autoinvoke(data.metadata) === undefined
  return {
    format: {
      status: problems.length > 0 ? "incompatible" : converts ? "converted" : "ok",
      problems,
      notes,
      ignored: ignored.slice(0, 20),
    },
    ...(front.value.name === undefined ? {} : { name: front.value.name }),
    ...(front.value.description === undefined ? {} : { description: front.value.description }),
    ...(version === undefined ? {} : { version }),
  }
}

/** `version`, else `metadata.version`, as text (a YAML number such as `2.0` too). */
function versionOf(data: Record<string, unknown>) {
  const value = data.version ?? record(data.metadata)?.version
  if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 64)
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * The body without fenced code blocks (CommonMark: three or more backticks or tildes, closed by a run as long), and
 * whether a fence opened with `!` (Claude Code's multi-line `` !`…` ``). An unclosed fence runs to the end.
 */
function prose(body: string) {
  const state: { fence?: { readonly char: string; readonly length: number }; bang: boolean; kept: string[] } = {
    bang: false,
    kept: [],
  }
  for (const line of body.split(/\r?\n/)) {
    if (state.fence !== undefined) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === state.fence.char && close[1].length >= state.fence.length) state.fence = undefined
      continue
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    // A backtick fence's info string has no backtick (CommonMark); such a line is inline code, not a fence.
    if (open === null || (open[1][0] === "`" && open[2].includes("`"))) {
      state.kept.push(line)
      continue
    }
    state.fence = { char: open[1][0], length: open[1].length }
    if (open[2].trim().startsWith("!")) state.bang = true
  }
  return { text: state.kept.join("\n"), bang: state.bang }
}

/** One frontmatter key of `상세 보기` (`OwnImport.SkillDetail.frontmatter`). */
export interface Entry {
  readonly key: string
  readonly value: string
  readonly omitted?: "aliases" | "budget"
}

/**
 * The frontmatter and body of a `SKILL.md` for `상세 보기` (SK2): every key in file order with its value as text
 * (a list of plain values joined with `, `, anything else as JSON), at most {@link MAX_KEYS} keys of
 * {@link MAX_VALUE} characters (a longer one ends in `…`); the body after the frontmatter as core reads it.
 *
 * YAML aliases (`&a` … `*a`) make one parsed value appear many times. js-yaml (gray-matter's, as core's) has no alias
 * limit of its own (`maxAliasCount` is the `yaml` package's), but its parse stays linear: an alias is a reference to
 * the anchored value. Writing it out expands every use, and eight levels of nine aliases took a minute and 1.9 GB as
 * JSON (SK2, 2026-10-25). So each value's expansion is measured first with every shared value counted once
 * ({@link aliased}): past {@link MAX_EXPANDED} values, or a loop, it is `omitted: "aliases"`. The text comes from a
 * writer that stops at {@link MAX_VALUE} characters, and the whole call stops at `budget` (default {@link BUDGET_MS}
 * and {@link BUDGET_CHARS}): later keys are `omitted: "budget"`. It runs on own-import's service thread, so nothing in
 * it may grow with what the file asks for.
 */
export function frontmatter(skillMd: string, budget: Budget = { ms: BUDGET_MS, chars: BUDGET_CHARS }) {
  const parsed = parse(skillMd)
  if (parsed === undefined) return { entries: [], body: skillMd }
  const until = performance.now() + budget.ms
  const state = { chars: 0 }
  const entries = Object.entries(parsed.data)
    .slice(0, MAX_KEYS)
    .map(([key, value]): Entry => {
      if (performance.now() > until || state.chars >= budget.chars) return { key, value: "", omitted: "budget" }
      if (aliased(value)) return { key, value: "", omitted: "aliases" }
      const text = shown(value)
      state.chars += text.length
      return { key, value: text }
    })
  return { entries, body: parsed.content }
}

/** What one `frontmatter` call may spend: milliseconds and characters of values. */
export interface Budget {
  readonly ms: number
  readonly chars: number
}

const MAX_KEYS = 50
const MAX_VALUE = 2_000
/** Values a frontmatter value may reach through its aliases (one without aliases is only cut). */
const MAX_EXPANDED = 10_000
/** Nesting the writer follows; deeper parts are written as `…`. */
const MAX_DEPTH = 32
const BUDGET_MS = 250
const BUDGET_CHARS = 64 * 1024

/**
 * Whether `value` reaches past {@link MAX_EXPANDED} values once its aliases are expanded, or loops (`&a [*a]`). Each
 * shared object is counted once by memo, so a YAML alias bomb is measured in the time of its file, not of its
 * expansion. A value that is only large (no object reached twice) is not: the writer cuts it.
 */
function aliased(value: unknown) {
  const memo = new Map<object, number>()
  const open = new Set<object>()
  const state = { shared: false }
  const size = (item: unknown, depth: number): number => {
    if (typeof item !== "object" || item === null || item instanceof Date) return 1
    const known = memo.get(item)
    if (known !== undefined) {
      state.shared = true
      return known
    }
    if (open.has(item)) return Number.POSITIVE_INFINITY
    // The writer writes `…` past this depth: nothing deeper is expanded.
    if (depth > MAX_DEPTH) return 1
    open.add(item)
    const total = Object.values(item).reduce((sum: number, child) => sum + size(child, depth + 1), 1)
    open.delete(item)
    memo.set(item, total)
    return total
  }
  const total = size(value, 0)
  return total === Number.POSITIVE_INFINITY || (state.shared && total > MAX_EXPANDED)
}

/** A value as text: a plain value as it is, a list of plain values joined with `, `, anything else as bounded JSON. */
function shown(value: unknown): string {
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item === "object" && item !== null && !(item instanceof Date))
    )
      return cut(json(value))
    // Joined only while there is room: a list of 100,000 values stops after its first few.
    const out: string[] = []
    const state = { length: 0 }
    for (const item of value) {
      if (state.length > MAX_VALUE) break
      const text = plain(item)
      out.push(text)
      state.length += text.length + 2
    }
    return cut(out.join(", "))
  }
  return cut(plain(value))
}

function plain(value: unknown) {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function cut(text: string) {
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text
}

/** JSON of a parsed YAML value that stops writing once it passed {@link MAX_VALUE} characters. */
function json(value: object) {
  const parts: string[] = []
  const state = { length: 0 }
  const push = (text: string) => {
    parts.push(text)
    state.length += text.length
  }
  const write = (item: unknown, depth: number): void => {
    if (state.length > MAX_VALUE) return
    if (typeof item !== "object" || item === null) return push(JSON.stringify(item ?? null) ?? "null")
    if (item instanceof Date) return push(JSON.stringify(item.toISOString()))
    if (depth > MAX_DEPTH) return push('"…"')
    const list = Array.isArray(item)
    // SAFETY: a parsed YAML mapping is a plain object with string keys.
    const record = item as Record<string, unknown>
    const keys = list ? [] : Object.keys(record)
    const count = list ? item.length : keys.length
    push(list ? "[" : "{")
    for (let index = 0; index < count && state.length <= MAX_VALUE; index += 1) {
      if (index > 0) push(",")
      if (!list) push(`${JSON.stringify(keys[index])}:`)
      write(list ? item[index] : record[keys[index] ?? ""], depth + 1)
    }
    push(list ? "]" : "}")
  }
  write(value, 0)
  return parts.join("")
}

/** The format with file-level problems added: any problem makes it `incompatible`. */
export function withProblems(
  format: OwnImport.SkillFormat,
  problems: ReadonlyArray<OwnImport.SkillProblem>,
): OwnImport.SkillFormat {
  const all = unique([...format.problems, ...problems])
  return all.length === 0 ? format : { ...format, status: "incompatible", problems: all }
}

/** The format with more notes (SK2: folders left out, links copied); the status stays. */
export function withNotes(format: OwnImport.SkillFormat, notes: ReadonlyArray<OwnImport.SkillNote>) {
  const all = unique([...format.notes, ...notes])
  return all.length === format.notes.length ? format : { ...format, notes: all }
}

function incompatible(problems: ReadonlyArray<OwnImport.SkillProblem>): OwnImport.SkillFormat {
  return { status: "incompatible", problems: [...problems], notes: [], ignored: [] }
}

/**
 * `SKILL.md` of a `converted` skill: `disable-model-invocation: true` added as the first frontmatter key under the
 * opening line as written (`---`, `---yaml`; a new frontmatter when there is none), line ends kept. Nothing else of
 * the file changes.
 */
export function convert(skillMd: string) {
  const eol = skillMd.includes("\r\n") ? "\r\n" : "\n"
  const bom = skillMd.startsWith("﻿") ? "﻿" : ""
  const body = skillMd.slice(bom.length)
  const line = `disable-model-invocation: true${eol}`
  const opening = /^---(?!-)[^\n]*\n/.exec(body)?.[0]
  if (opening !== undefined) return `${bom}${opening}${line}${body.slice(opening.length)}`
  return `${bom}---${eol}${line}---${eol}${body}`
}

/**
 * Frontmatter and body as core reads them: gray-matter, retried once with unquoted colons as block scalars. Only YAML
 * (09 §9.12): gray-matter takes the rest of the opening `---` line as the frontmatter's language and, for `---js` or
 * `---javascript`, runs the block with `eval` in this process (`---coffee` and `---cson` too once a CoffeeScript engine
 * is registered). A skill is read here before anyone chose to use it (`skills.list` over the other tools' folders and
 * marketplace clones, `skills.detail`, `skills.preview` of a repository not installed yet), so a language other than
 * YAML ({@link foreign}) is refused before gray-matter sees the text, and {@link ENGINES} refuses those languages
 * should one get through.
 */
function parse(content: string) {
  if (foreign(content)) return undefined
  const attempt = (text: string) => {
    // gray-matter throws on YAML it cannot read; that is the answer here, not an error. The options object turns off
    // its cache by content, which keeps a failed parse's empty result for the same text.
    try {
      const result = matter(text, { engines: ENGINES })
      return { data: record(result.data) ?? {}, content: result.content }
    } catch {
      return undefined
    }
  }
  const sanitized = sanitize(content)
  // Core retries the same text once more and then takes the empty result gray-matter cached, which would show the
  // model the raw frontmatter without a description: own does not import that (`frontmatter`).
  return attempt(content) ?? (sanitized === content ? undefined : attempt(sanitized))
}

/**
 * Whether the opening `---` names a language other than YAML (09 §9.12): any token but `yaml` and `yml` in any case,
 * the rule of core's `ConfigMarkdown.parse` (P-036), which reads gray-matter's `file.language` the same way. gray-matter
 * maps `yaml`, `YAML`, `yml` and `Yml` to its YAML engine; `json`, `js`, `coffee` and every other token are refused.
 */
function foreign(content: string) {
  return !["", "yaml", "yml"].includes(language(content).toLowerCase())
}

/**
 * The language gray-matter 4.0.3 would read after the opening `---` (`---js`, `--- coffee`, `---yaml`), "" when there
 * is none or no frontmatter: the same steps as its `parseMatter` and `matter.language` (a BOM dropped, `---` at the
 * very start and no fourth `-`, the rest of the line up to the first `\n` or `\r\n`, trimmed).
 */
function language(content: string) {
  const text = content.startsWith("﻿") ? content.slice(1) : content
  if (!text.startsWith("---") || text.charAt(3) === "-") return ""
  const rest = text.slice(3)
  const end = rest.search(/\r?\n/)
  return (end === -1 ? rest : rest.slice(0, end)).trim()
}

/** Every language gray-matter maps to code (`js`, `javascript` run `eval`; the CoffeeScript names alike), refused. */
const refuse = () => {
  throw new Error("only YAML frontmatter is read")
}
const ENGINES = { javascript: refuse, js: refuse, coffee: refuse, coffeescript: refuse, cson: refuse }

/** Core's `ConfigMarkdown.sanitize`: a plain `key: value` whose value holds a colon becomes a block scalar. */
function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}

/** `metadata["opencode/autoinvoke"]` when it is set. */
function autoinvoke(metadata: unknown) {
  return record(metadata)?.["opencode/autoinvoke"]
}

/** What own reads of Codex's `agents/openai.yaml`: its UI block, its MCP dependencies and its implicit-use policy. */
function codexMetadata(yaml: string) {
  const data = parse(`---\n${yaml}\n---\n`)?.data
  if (data === undefined) return { interface: true, dependencies: false, implicit: undefined }
  const policy = record(data.policy)
  return {
    interface: data.interface !== undefined,
    dependencies: data.dependencies !== undefined,
    implicit: typeof policy?.allow_implicit_invocation === "boolean" ? policy.allow_implicit_invocation : undefined,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  // SAFETY: a non-null, non-array object parsed from YAML has string keys.
  return value as Record<string, unknown>
}

function unique<T>(items: ReadonlyArray<T>) {
  return [...new Set(items)]
}

// ---------------------------------------------------------------------------------------------------------------
// Files

/** Executable-looking files: scripts and programs by extension, or anything in a `scripts`/`bin` folder. */
const SCRIPT =
  /\.(?:py|pyw|sh|bash|zsh|fish|js|mjs|cjs|ts|mts|cts|tsx|ps1|psm1|bat|cmd|exe|dll|so|dylib|rb|pl|php|lua|jar|vbs|wsf|com|msi|scr)$/i

export function isScript(relative: string, executable = false) {
  const parts = relative.split("/")
  return (
    executable || SCRIPT.test(relative) || (parts.length > 1 && ["scripts", "bin"].includes(parts[0].toLowerCase()))
  )
}

/** Environment templates a skill ships to show its settings (SK2): never values, so not `secret_file`. */
const EXAMPLE_ENV = new Set([".env.example", ".env.sample", ".env.template"])

/** A file named like a login, a key or an environment file: such a skill is not imported (`secret_file`). */
export function isSecret(relative: string) {
  const name = (relative.split("/").at(-1) ?? "").toLowerCase()
  return (
    ["auth.json", ".credentials.json", "credentials.json", "id_rsa", "id_ed25519", "id_ecdsa"].includes(name) ||
    name === ".env" ||
    (name.startsWith(".env.") && !EXAMPLE_ENV.has(name)) ||
    /\.(?:key|pem|p12|pfx)$/.test(name)
  )
}

/** The most a skill may hold (09 §9.3 `too_large`). */
export const MAX_FILES = 500
export const MAX_BYTES = 20 * 1024 * 1024
/** `SKILL.md` and `agents/openai.yaml` are read whole only up to these sizes. */
export const MAX_SKILL_MD = 1024 * 1024
export const MAX_OPENAI_YAML = 64 * 1024

/**
 * The content hash of a skill (09 §9.4): sha256 over its files sorted by relative path (`/`-separated), each as path,
 * size and bytes. A local source and a git checkout of the same files hash the same.
 */
export function digest(files: ReadonlyArray<{ readonly relative: string; readonly bytes: Uint8Array }>) {
  const hash = createHash("sha256")
  for (const file of [...files].sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)))
    hash.update(`${file.relative}\0${file.bytes.length}\0`).update(file.bytes)
  return hash.digest("hex")
}

/** A path-free key for a found or previewed skill. */
export function key(...parts: ReadonlyArray<string>) {
  return Schema.decodeSync(OwnImport.SkillKey)(
    `sk-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20)}`,
  )
}

const decodeID = Schema.decodeUnknownOption(OwnImport.SkillID)

/** A valid {@link OwnImport.SkillID} from a folder name: other characters become `-`, `skill` when nothing is left. */
export function cleanID(name: string): OwnImport.SkillID {
  const exact = decodeID(name)
  if (Option.isSome(exact)) return exact.value
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[.]+$/, "")
  return Option.getOrElse(decodeID(cleaned), () => Schema.decodeSync(OwnImport.SkillID)("skill"))
}

/** Whether a string is a valid {@link OwnImport.SkillID}. */
export function validID(id: string) {
  return Option.isSome(decodeID(id))
}

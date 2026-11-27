// Ports the context fragments Codex puts at the start of a thread: `<permissions instructions>`
// (codex-rs/prompts/src/permissions_instructions.rs), `<collaboration_mode>` (core/src/context/world_state/
// collaboration_mode.rs), `<skills_instructions>` (ext/skills/src/catalog_prompt.rs, render.rs), the AGENTS.md
// fragment (core/src/agents_md.rs, core/src/context/user_instructions.rs), `<environment_context>`
// (core/src/context/world_state/environment.rs, core/src/context/environment_context.rs) and `<tools>`
// (core/src/context/world_state/tools.rs, tools_budget.rs).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1; `<tools>` @ rust-v0.167.0.
export * as Fragments from "./fragments.js"

import path from "node:path"
import type { Permission } from "@opencode/schema/permission"
import { Preset } from "@own/protocol/preset"
import COLLABORATION_DEFAULT from "../../codex-data/collaboration-default.md" with { type: "text" }
import COLLABORATION_PLAN from "../../codex-data/collaboration-plan.md" with { type: "text" }
import APPROVAL_NEVER from "../../codex-data/permissions/approval-never.md" with { type: "text" }
import APPROVAL_ON_REQUEST from "../../codex-data/permissions/approval-on-request.md" with { type: "text" }
import SANDBOX_DANGER from "../../codex-data/permissions/sandbox-danger-full-access.md" with { type: "text" }
import SANDBOX_READ_ONLY from "../../codex-data/permissions/sandbox-read-only.md" with { type: "text" }
import SANDBOX_WORKSPACE from "../../codex-data/permissions/sandbox-workspace-write.md" with { type: "text" }
import { RustStr } from "./apply-patch/rust-str.js"
import { Catalog } from "./catalog.js"
import { ToolSearch } from "./tool-search.js"

/**
 * What own's approval mode means in Codex's terms (10 §3.3). own has no OS sandbox: `full` runs everything without
 * asking (danger-full-access, never); `ask` asks before shell commands and edits, which Codex expresses as
 * workspace-write with on-request approvals; `read-only` refuses shell and patches (read-only, never). In `read-only`
 * and `ask` exec_command answers simple reads itself without asking (read-only.ts).
 */
export type Mode = "read-only" | "ask" | "full"

/**
 * own's approval mode from the session's own bundle rules (own-accounts `switching/approval.ts`); none → ask. It picks
 * the permissions text; whether exec_command answers reads is a stricter check (CodexReadOnly.answers). A role own runs
 * no command for (`Preset.NO_SHELL_ROLES`, `explore`) works as `read-only` whatever its parent's mode: it may neither
 * edit nor run commands (07 §2.4), and its reads are answered.
 */
export function mode(rules: ReadonlyArray<Permission.Rule> | undefined, agent?: string): Mode {
  if (Preset.noShell(agent)) return "read-only"
  const shell = (rules ?? []).findLast((rule) => rule.action === "shell" && rule.resource === "**")
  if (shell?.effect === "allow") return "full"
  if (shell?.effect === "deny") return "read-only"
  return "ask"
}

const SANDBOX = { "read-only": SANDBOX_READ_ONLY, ask: SANDBOX_WORKSPACE, full: SANDBOX_DANGER } as const

export function permissions(mode: Mode, cwd: string) {
  const sandbox = RustStr.trimEnd(SANDBOX[mode]).replace(
    "{{ network_access }}",
    mode === "read-only" ? "restricted" : "enabled",
  )
  const approval = mode === "ask" ? APPROVAL_ON_REQUEST : APPROVAL_NEVER
  const sections = [sandbox, approval, ...(mode === "ask" ? [` The writable root is \`${cwd}\`.`] : [])]
  const body = sections.reduce((text, section) => `${text.endsWith("\n") ? text : `${text}\n`}${section}`, "")
  return `<permissions instructions>${body.endsWith("\n") ? body : `${body}\n`}</permissions instructions>`
}

/**
 * `<collaboration_mode>` of an interactive thread: Default, or Plan for own's plan agent, from the model's catalog
 * override (`model_messages.collaboration_modes`) when it has one; checklist text removed.
 */
export function collaboration(plan: boolean, model?: Catalog.Model) {
  const modes = model?.model_messages?.collaboration_modes as Record<string, string | null> | null | undefined
  const text = modes?.[plan ? "plan" : "default"] ?? (plan ? COLLABORATION_PLAN : COLLABORATION_DEFAULT)
  return `<collaboration_mode>${Catalog.withoutUpdatePlan(text)}</collaboration_mode>`
}

export interface Skill {
  readonly name: string
  readonly description?: string
  /** The skill's `SKILL.md`. */
  readonly path: string
}

const SKILLS_INTRO =
  "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table."

const DESCRIPTION_MAX_CHARS = 1_024

/**
 * `<skills_instructions>` with host aliases: a roots table (`r0`, `r1`, … for the folders that hold skill folders, in
 * first-seen order) and one line per skill pointing at `rN/<folder>/SKILL.md`. The how-to-use block is added only for
 * models whose catalog entry asks for it.
 */
export function skills(list: ReadonlyArray<Skill>, howToUse: string | undefined) {
  if (list.length === 0) return undefined
  const roots = [...new Set(list.map((skill) => path.dirname(path.dirname(skill.path))))]
  const slash = (value: string) => value.replaceAll("\\", "/")
  const lines = [
    "## Skills",
    SKILLS_INTRO,
    "### Skill roots",
    ...roots.map((root, index) => `- \`r${index}\` = \`${slash(root)}\``),
    "### Available skills",
    ...list.map((skill) => {
      const root = roots.indexOf(path.dirname(path.dirname(skill.path)))
      const locator = `r${root}/${slash(path.relative(roots[root]!, skill.path))}`
      const description = truncateDescription(skill.description ?? "")
      return description === ""
        ? `- ${skill.name}: (file: ${locator})`
        : `- ${skill.name}: ${description} (file: ${locator})`
    }),
    ...(howToUse === undefined ? [] : ["### How to use skills", howToUse]),
  ]
  return `<skills_instructions>\n${lines.join("\n")}\n</skills_instructions>`
}

function truncateDescription(text: string) {
  const chars = [...text]
  return chars.length <= DESCRIPTION_MAX_CHARS ? text : `${chars.slice(0, DESCRIPTION_MAX_CHARS - 3).join("")}...`
}

/** A deferred tool namespace by name, with its description (`ToolRegistry::deferred_tool_namespaces`). */
export type Namespaces = ReadonlyMap<string, string>

const TOOLS_OPEN = "<tools>"
const TOOLS_CLOSE = "</tools>"
const TOOLS_FRAGMENT_BYTES = 4 * 1024
const NAMESPACE_DESCRIPTION_CHARS = 250
const OMITTED_LINE_RESERVE_BYTES = 64
const TRUNCATION_SUFFIX = "..."

/**
 * `<tools>`, the deferred tool namespaces as Codex's world state shows them (core/src/context/world_state/tools.rs and
 * tools_budget.rs, `deferred_tool_world_state`, on by default since rust-v0.167.0, 0e31c29e25 #58410). Without
 * `previous` (or with it empty, which Codex does not persist) it lists `current` in full; otherwise it renders what was
 * added (or whose description changed) and removed since, and that none remain when `current` is empty. Undefined when
 * there is nothing to say. Descriptions keep their first line, trimmed and cut to 250 characters; names go in UTF-8
 * byte order, and the whole fragment stays within 4 KiB, every name kept before descriptions are shared out.
 */
export function deferredTools(current: Namespaces, previous: Namespaces = new Map()) {
  const now = normalized(current)
  const before = normalized(previous)
  if (before.size === 0 && now.size === 0) return undefined
  if (before.size === now.size && [...now].every(([name, description]) => before.get(name) === description))
    return undefined
  const groups: ReadonlyArray<readonly [string, Namespaces]> =
    before.size === 0
      ? [["Deferred tool namespaces", now]]
      : [
          ["Added deferred tool namespaces", new Map([...now].filter(([name, text]) => before.get(name) !== text))],
          ["Removed deferred tool namespaces", new Map([...before].filter(([name]) => !now.has(name)))],
        ]
  return `${TOOLS_OPEN}${namespaceGroups(groups, now.size === 0)}${TOOLS_CLOSE}`
}

/** `ToolsState::new`: each description's first line, trimmed and cut to 250 characters; names in byte order. */
function normalized(namespaces: Namespaces): Namespaces {
  return new Map(
    [...namespaces]
      .map(([name, text]) => {
        const chars = Array.from(RustStr.trim(RustStr.lines(text)[0] ?? ""))
        const cut = chars.length <= NAMESPACE_DESCRIPTION_CHARS
        const kept = cut ? chars : chars.slice(0, NAMESPACE_DESCRIPTION_CHARS - TRUNCATION_SUFFIX.length)
        return [name, `${kept.join("")}${cut ? "" : TRUNCATION_SUFFIX}`] as const
      })
      .toSorted(([left], [right]) => ToolSearch.compareUtf8(left, right)),
  )
}

/** `render_namespace_groups`: the fragment's body between its tags. */
function namespaceGroups(groups: ReadonlyArray<readonly [string, Namespaces]>, currentIsEmpty: boolean) {
  const filled = groups.filter(([, namespaces]) => namespaces.size > 0)
  const empty = currentIsEmpty ? "No deferred tool namespaces remain.\n" : ""
  const fixed = 1 + filled.reduce((sum, [label]) => sum + utf8(label) + 2, 0) + utf8(empty)
  const budget = Math.max(TOOLS_FRAGMENT_BYTES - utf8(TOOLS_OPEN) - utf8(TOOLS_CLOSE) - fixed, 0)
  const rows = namespaceRows(groups, budget, filled.length * OMITTED_LINE_RESERVE_BYTES)
  const rendered = filled.reduce(
    (state, [label, namespaces]) => {
      const own = rows.slice(state.at, state.at + namespaces.size)
      const omitted = own.filter((row) => row === undefined).length
      const kept = own.filter((row) => row !== undefined).join("")
      const notice = omitted > 0 ? `... ${omitted} additional namespaces omitted.\n` : ""
      return { text: `${state.text}${label}:\n${kept}${notice}`, at: state.at + namespaces.size }
    },
    { text: "\n", at: 0 },
  )
  return `${rendered.text}${empty}`
}

/**
 * `truncate_namespace_rows`: one `- name: description` row per namespace in group order, undefined for an omitted one.
 * Every name is kept before descriptions share what is left, one character per row in turn; a description that is cut
 * keeps room for `...`. When the names alone do not fit, rows keep their names only and the omission notices get room.
 */
export function namespaceRows(
  groups: ReadonlyArray<readonly [string, Namespaces]>,
  budget: number,
  omissionReserve: number,
): ReadonlyArray<string | undefined> {
  const entries = groups.flatMap(([, namespaces]) => [...namespaces])
  const retained = retainedBytes(entries, budget, omissionReserve)
  return entries.map(([name, description], index) => {
    const bytes = retained[index]
    if (bytes === undefined) return undefined
    if (bytes === 0) return `- ${name}\n`
    if (bytes === utf8(description)) return `- ${name}: ${description}\n`
    if (bytes < TRUNCATION_SUFFIX.length) return `- ${name}\n`
    return `- ${name}: ${utf8Prefix(description, bytes - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}\n`
  })
}

/** `calculate_namespace_row_truncation`: undefined omits a row, 0 keeps its name, n keeps n description bytes. */
function retainedBytes(entries: ReadonlyArray<readonly [string, string]>, budget: number, omissionReserve: number) {
  const names = entries.reduce((sum, [name]) => sum + nameRow(name), 0)
  if (names > budget) {
    const left = { bytes: Math.max(budget - omissionReserve, 0) }
    return entries.map(([name]) => {
      if (nameRow(name) > left.bytes) return undefined
      left.bytes -= nameRow(name)
      return 0
    })
  }
  const remaining = budget - names
  const descriptions = entries.reduce((sum, [, text]) => sum + (text === "" ? 0 : 2 + utf8(text)), 0)
  if (descriptions <= remaining) return entries.map(([, text]) => utf8(text))
  const retained: Array<number | undefined> = entries.map(() => 0)
  // Each turn takes one character of one row; a row whose next character does not fit leaves the queue for good,
  // because the budget only shrinks.
  const queue = entries.flatMap(([, text], row) => (text === "" ? [] : [{ row, chars: Array.from(text), next: 0 }]))
  const left = { bytes: remaining }
  while (queue.length > 0 && left.bytes > 0) {
    const entry = queue.shift()!
    const char = entry.chars[entry.next]
    if (char === undefined) continue
    const extra = utf8(char) + (entry.next === 0 ? 2 : 0)
    if (extra > left.bytes) continue
    left.bytes -= extra
    retained[entry.row] = (retained[entry.row] ?? 0) + utf8(char)
    queue.push({ ...entry, next: entry.next + 1 })
  }
  return retained
}

function nameRow(name: string) {
  return 2 + utf8(name) + 1
}

const ENCODER = new TextEncoder()

function utf8(text: string) {
  return ENCODER.encode(text).length
}

/** `floor_char_boundary`: the longest prefix of at most `limit` UTF-8 bytes that ends on a character. */
function utf8Prefix(text: string, limit: number) {
  return Array.from(text).reduce(
    (state, char) =>
      state.full || state.bytes + utf8(char) > limit
        ? { ...state, full: true }
        : { text: state.text + char, bytes: state.bytes + utf8(char), full: false },
    { text: "", bytes: 0, full: false },
  ).text
}

const PROJECT_DOC_SEPARATOR = "\n\n--- project-doc ---\n\n"

/**
 * The AGENTS.md fragment: user (global) instructions trimmed, then project files from the project root down to the
 * working directory, the first project file after user text preceded by Codex's project-doc marker.
 */
export function agentsMd(input: {
  readonly user?: string
  readonly project: ReadonlyArray<string>
  readonly cwd: string
}) {
  const user = input.user === undefined ? undefined : RustStr.trim(input.user)
  const project = input.project.filter((text) => RustStr.trim(text) !== "")
  const head = user === undefined || user === "" ? undefined : user
  if (head === undefined && project.length === 0) return undefined
  const text =
    head === undefined
      ? project.join("\n\n")
      : project.length === 0
        ? head
        : `${head}${PROJECT_DOC_SEPARATOR}${project.join("\n\n")}`
  const directory = project.length === 0 ? "" : ` for ${input.cwd}`
  return `# AGENTS.md instructions${directory}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`
}

/** `<environment_context>` of a single local environment, with own's approval mode as Codex's permission profile. */
export function environment(input: {
  readonly cwd: string
  readonly shell: string
  readonly date?: string
  readonly timezone?: string
  readonly mode: Mode
  /**
   * The read-only `.git`, `.agents` and `.codex` entries Codex's sandbox keeps inside a writable workspace. own enforces
   * none of them, so own's revision (10 §3.9), whose permissions text says there is no sandbox, leaves them out.
   */
  readonly carveOuts: boolean
}) {
  const lines = [
    `  <cwd>${xml(input.cwd)}</cwd>`,
    `  <shell>${xml(input.shell)}</shell>`,
    ...(input.date === undefined ? [] : [`  <current_date>${xml(input.date)}</current_date>`]),
    ...(input.timezone === undefined ? [] : [`  <timezone>${xml(input.timezone)}</timezone>`]),
    `  ${filesystem(input.cwd, input.mode, input.carveOuts)}`,
  ]
  return `<environment_context>\n${lines.join("\n")}\n</environment_context>`
}

function filesystem(cwd: string, mode: Mode, carveOuts: boolean) {
  const roots = `<workspace_roots><root>${xml(cwd)}</root></workspace_roots>`
  if (mode === "full")
    return `<filesystem>${roots}<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>`
  const read = `<entry access="read"><special>:root</special></entry>`
  const entries =
    mode === "read-only"
      ? read
      : [
          read,
          `<entry access="write"><path>${xml(cwd)}</path></entry>`,
          ...(carveOuts
            ? [".git", ".agents", ".codex"].map(
                (name) => `<entry access="read"><path>${xml(path.join(cwd, name))}</path></entry>`,
              )
            : []),
        ].join("")
  return `<filesystem>${roots}<permission_profile type="managed"><file_system type="restricted">${entries}</file_system></permission_profile></filesystem>`
}

function xml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

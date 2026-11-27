// Ports the history messages dsh adds around a user's request (session facts after the reusable instructions):
// - the runtime-context snapshot (packages/core/agent-loop/src/runtime-context.ts, core/system-prompt
//   `joinContextSections`): the working directory (session/working-directory), the file policy
//   (sandbox/sandbox-policy) and the approval policy (interaction/user-approval), one user message, sent again only
//   when it changes;
// - the workspace instructions (context/agent-instructions/src/render.ts): the AGENTS.md files in a
//   `<system-reminder>` frame within a 65,536-byte budget, broadest first;
// - the skill catalog (skill/tool-skill): a `<system-reminder>` with one line per skill;
// - the time reading (context/time-context): when a step is prepared and how long since the last model-visible
//   message, at most every 10 minutes.
// Each is a pure function of its inputs, so a request built again from the same history has the same bytes.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshContext from "./context.js"

import { Buffer } from "node:buffer"

/** own's approval mode (Fragments.mode). */
export type Mode = "read-only" | "ask" | "full"

const SNAPSHOT_HEAD = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."

/** `joinContextSections`. */
export function snapshot(sections: ReadonlyArray<string>) {
  const body = sections.filter((text) => text.length > 0).join("\n\n")
  return body.length === 0 ? "" : `${SNAPSHOT_HEAD}\n\n${body}`
}

/** `working-directory:current`. */
export function workingDirectory(cwd: string) {
  return `Current working directory: ${JSON.stringify(cwd)}.`
}

/**
 * dsh's file policy and approval policy for own's approval mode, as dsh's permission presets pair them: `full` is
 * danger-full-access with approvals never asked, `ask` is workspace-write with approvals asked, `read-only` is read-only
 * with approvals asked.
 */
export function policy(mode: Mode, cwd: string) {
  const sandbox =
    mode === "read-only"
      ? "Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns."
      : mode === "ask"
        ? `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(cwd)}. Some platform temporary areas may also be writable.`
        : "Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations."
  const approval =
    mode === "full"
      ? "Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`)."
      : "Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed."
  return [sandbox, approval]
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>"
const SYSTEM_REMINDER_CLOSE = "</system-reminder>"
const INSTRUCTIONS_INTRO =
  "The following workspace instructions may be relevant to your work. " +
  "Use them as guidance when applicable. More specific instructions take precedence over broader ones. " +
  "They do not override system, developer, or direct user instructions."
const COMPACT_INTRO = "Workspace instructions were omitted or truncated to fit the configured byte budget."

/** The standard preset's `agent-instructions` budget. */
export const INSTRUCTIONS_MAX_BYTES = 65_536

export interface InstructionFile {
  readonly displayPath: string
  readonly content: string
}

/**
 * `renderAgentInstructions`: the files (broadest first) in one `<system-reminder>` within `maxBytes`; when they do not
 * fit, the broadest go first, then the most specific is cut, with dsh's budget notice. Empty when there are none.
 */
export function instructions(files: ReadonlyArray<InstructionFile>, maxBytes = INSTRUCTIONS_MAX_BYTES) {
  if (files.length === 0) return ""
  const full = frame(files, maxBytes, [], [], INSTRUCTIONS_INTRO)
  if (bytes(full) <= maxBytes) return full
  const suffix = files
    .map((_, start) => start)
    .slice(1)
    .map((start) => frame(files.slice(start), maxBytes, files.slice(0, start), [], INSTRUCTIONS_INTRO))
    .find((text) => bytes(text) <= maxBytes)
  if (suffix !== undefined) return suffix
  const specific = files.at(-1)!
  const omitted = files.slice(0, -1)
  const fitted = [INSTRUCTIONS_INTRO, COMPACT_INTRO]
    .map((intro) => {
      const kept = fit(specific, omitted, maxBytes, intro)
      const text = frame([kept], maxBytes, omitted, [{ file: specific, included: bytes(kept.content) }], intro)
      return bytes(text) <= maxBytes ? text : undefined
    })
    .find((text) => text !== undefined)
  if (fitted !== undefined) return fitted
  const notice = escape(marker(maxBytes, omitted, [{ file: specific, included: 0 }]))
  const heading = escape([notice, section({ ...specific, content: "" })].join("\n\n"))
  if (bytes(heading) <= maxBytes) return heading
  return bytes(notice) <= maxBytes ? notice : cut(notice, maxBytes)
}

function frame(
  files: ReadonlyArray<InstructionFile>,
  maxBytes: number,
  omitted: ReadonlyArray<InstructionFile>,
  truncated: ReadonlyArray<{ readonly file: InstructionFile; readonly included: number }>,
  intro: string,
) {
  const body = [marker(maxBytes, omitted, truncated), intro, ...files.map(section)].filter((block) => block.length > 0)
  return [SYSTEM_REMINDER_OPEN, escape(body.join("\n\n")), SYSTEM_REMINDER_CLOSE].join("\n")
}

function section(file: InstructionFile) {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

function marker(
  maxBytes: number,
  omitted: ReadonlyArray<InstructionFile>,
  truncated: ReadonlyArray<{ readonly file: InstructionFile; readonly included: number }>,
) {
  if (omitted.length === 0 && truncated.length === 0) return ""
  const parts = [
    ...(omitted.length > 0 ? [`omitted ${omitted.map((file) => file.displayPath).join(", ")}`] : []),
    ...(truncated.length > 0
      ? [
          `truncated ${truncated
            .map((item) => `${item.file.displayPath} from ${bytes(item.file.content)} to ${item.included} bytes`)
            .join(", ")}`,
        ]
      : []),
  ]
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join("; ")}`
}

/** `truncateToFit`: the most specific file cut by binary search to the longest content that fits. */
function fit(file: InstructionFile, omitted: ReadonlyArray<InstructionFile>, maxBytes: number, intro: string) {
  const search = (low: number, high: number, best: InstructionFile): InstructionFile => {
    if (low > high) return best
    const middle = Math.floor((low + high) / 2)
    const candidate = { ...file, content: cut(file.content, middle) }
    const text = frame([candidate], maxBytes, omitted, [{ file, included: bytes(candidate.content) }], intro)
    return bytes(text) <= maxBytes ? search(middle + 1, high, candidate) : search(low, middle - 1, best)
  }
  return search(0, bytes(file.content), { ...file, content: "" })
}

function escape(body: string) {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, "<\\/system-reminder>")
}

function bytes(text: string) {
  return Buffer.byteLength(text, "utf8")
}

/** `truncateUtf8`: at most `maxBytes`, never through a code point. */
function cut(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, "utf8")
  if (buffer.length <= maxBytes) return text
  const end = [...Array(4).keys()]
    .map((back) => Math.max(0, Math.trunc(maxBytes)) - back)
    .find((at) => at <= 0 || (buffer[at]! & 0xc0) !== 0x80)
  return buffer.subarray(0, Math.max(0, end ?? 0)).toString("utf8")
}

/** The standard preset's catalog description limit (`catalogDescriptionMaxLength`). */
const CATALOG_DESCRIPTION_MAX = 500

/** `renderCatalogMessage`: the skills the model may load with the `skill` tool. Empty when there are none. */
export function skills(entries: ReadonlyArray<{ readonly name: string; readonly description: string }>) {
  if (entries.length === 0) return ""
  const lines = entries
    .map((entry) => ({ name: entry.name, description: catalogDescription(entry.description) }))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
  return [
    "<system-reminder>",
    "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "",
    "<available_skills>",
    ...lines,
    "</available_skills>",
    "",
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    "A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.",
    "</system-reminder>",
  ].join("\n")
}

function catalogDescription(value: string) {
  const normalized = value.replaceAll(/\s+/g, " ").trim()
  return normalized.length <= CATALOG_DESCRIPTION_MAX
    ? normalized
    : `${normalized.slice(0, CATALOG_DESCRIPTION_MAX - 3)}...`
}

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** The standard preset's `refreshIntervalMs` default: at most one reading every 10 minutes. */
export const TIME_REFRESH_MS = 600_000

/** `renderText`: the reading for a step, sampled at `now` in `timeZone`. */
export function time(input: {
  readonly now: number
  readonly turn: number
  readonly step: number
  readonly previous?: number
  readonly timeZone: string
  /** The browser zone line: dsh's `missing` form (no zone reported) unless own's revision names the service's zone. */
  readonly zone?: string
}) {
  const elapsed = input.previous === undefined ? "unavailable" : duration(input.now - input.previous)
  const baseline = input.step === 1 ? "model-visible message" : "step context"
  const zone =
    input.zone === undefined
      ? "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times."
      : input.zone
  return (
    `Time sampled while preparing turn ${input.turn}, step ${input.step}: ${timestamp(input.now, input.timeZone)}\n` +
    `${zone}\n` +
    `Elapsed since the preceding ${baseline}: ${elapsed}.`
  )
}

/** `formatTimestamp`: `YYYY-MM-DDTHH:MM:SS+HH:MM[Zone]`. */
export function timestamp(now: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  )
  const offset = String(parts.timeZoneName).replace(/^GMT$/, "GMT+00:00").slice(3)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${timeZone}]`
}

/** `formatDuration`: `1d 2h 3m 4s`, leading zero units left out. */
export function duration(elapsedMs: number) {
  const total = Math.floor(Math.max(0, elapsedMs) / 1000)
  const units = [
    [Math.floor(total / 86_400), "d"],
    [Math.floor((total % 86_400) / 3600), "h"],
    [Math.floor((total % 3600) / 60), "m"],
  ] as const
  return [...units.filter(([value]) => value > 0).map(([value, unit]) => `${value}${unit}`), `${total % 60}s`].join(" ")
}

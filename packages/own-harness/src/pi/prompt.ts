// Ports Pi's structured system prompt: packages/coding-agent/src/core/system-prompt.ts (`buildSystemPromptSections`,
// rendered as `getSystemMessageText` from packages/ai/src/utils/text.ts joins it), skills.ts `formatSkillsForPrompt`
// and the built-in tools' prompt contributions (core/tools/{read,bash,edit,write}.ts). Pi's `docs` section, about pi's
// own documentation files, is left out: it does not apply here. Everything else is Pi's text and order: preamble,
// <tools>, <rules>, <addendum>, <project_context>, <skills>, <cwd>.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiPrompt from "./prompt.js"

export const PREAMBLE =
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code."

/** Pi's default tools, in Pi's order. */
export const DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as const

/** Each built-in tool's one-line snippet and guideline bullets (`<tool>ToolSystemPromptContribution`). */
export const CONTRIBUTIONS: Readonly<
  Record<string, { readonly snippet: string; readonly guidelines: ReadonlyArray<string> }>
> = {
  read: {
    snippet: "Read file contents",
    guidelines: ["Use read to examine files instead of cat or sed."],
  },
  bash: {
    snippet: "Execute bash commands (ls, grep, find, etc.)",
    guidelines: ["You can inspect PI_* environment variables for current model and session details."],
  },
  edit: {
    snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    guidelines: [
      "Use edit for targeted changes. Batch changes to one file in a single call.",
      "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
    ],
  },
  write: {
    snippet: "Create or overwrite files",
    guidelines: ["Use write only for new files or complete rewrites."],
  },
}

export interface Skill {
  readonly name: string
  readonly description: string
  /** The skill's SKILL.md. */
  readonly filePath: string
  readonly disableModelInvocation?: boolean
}

export interface Options {
  /** Replaces the preamble and drops <tools> and <rules> (Pi's SYSTEM.md / `customPrompt`). */
  readonly customPrompt?: string
  /**
   * own's 내 지시문 (10 §3.11): replaces only the preamble, so <tools> and <rules> stay; `customPrompt` still wins.
   * Not Pi's: own's addition.
   */
  readonly preamble?: string
  /** Default: Pi's four tools. */
  readonly selectedTools?: ReadonlyArray<string>
  /** Selected tools whose declarations requests leave out. */
  readonly hiddenTools?: ReadonlyArray<string>
  readonly toolSnippets?: Readonly<Record<string, string>>
  readonly toolGuidelines?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly promptGuidelines?: ReadonlyArray<string>
  /** Pi's APPEND_SYSTEM.md: the <addendum> section. */
  readonly appendSystemPrompt?: string
  readonly cwd: string
  readonly contextFiles?: ReadonlyArray<{ readonly path: string; readonly content: string }>
  readonly skills?: ReadonlyArray<Skill>
}

/** `buildSystemPromptSections` without `docs`: the preamble untagged, every other section in a tag of its name. */
export function sections(options: Options): Record<string, string> {
  const selected = [...(options.selectedTools ?? DEFAULT_TOOLS)]
  const hidden = options.hiddenTools ?? []
  const declared = selected.filter((name) => !hidden.includes(name))
  const snippets = options.toolSnippets ?? {}
  const custom = options.customPrompt ? options.customPrompt : undefined
  const listed = declared.filter((name) => !!snippets[name])
  const tools = listed.length > 0 ? listed.map((name) => `- ${name}: ${snippets[name]}`).join("\n") : "(none)"
  // A hidden reader is still reachable through another tool, so skills stay but the hint names no tool.
  const reader =
    (["read", "bash"] as const).find((tool) => declared.includes(tool)) ??
    ((["read", "bash"] as const).some((tool) => selected.includes(tool)) ? "indirect" : undefined)
  const skills = reader === undefined ? "" : formatSkills(options.skills ?? [], reader).trim()
  const contextFiles = options.contextFiles ?? []
  const body: ReadonlyArray<readonly [string, string | undefined]> = [
    ["tools", custom === undefined ? `${tools}\n\nAdditional tools may be available.` : undefined],
    [
      "rules",
      custom === undefined ? rules(declared, options.toolGuidelines ?? {}, options.promptGuidelines ?? []) : undefined,
    ],
    ["addendum", options.appendSystemPrompt || undefined],
    ["project_context", contextFiles.length > 0 ? projectContext(contextFiles) : undefined],
    ["skills", skills || undefined],
    ["cwd", options.cwd.replace(/\\/g, "/")],
  ]
  return Object.fromEntries([
    ["preamble", custom ?? options.preamble ?? PREAMBLE],
    ...body.flatMap(([name, content]) => (content === undefined ? [] : [[name, `<${name}>\n${content}\n</${name}>`]])),
  ])
}

/** The whole prompt as Pi sends it (`getSystemMessageText`): the sections joined by a blank line. */
export function render(options: Options) {
  return join(sections(options))
}

/** Sections as {@link sections} names them, joined as Pi joins them. */
export function join(parts: Readonly<Record<string, string>>) {
  return Object.values(parts)
    .filter((part) => part.length > 0)
    .join("\n\n")
}

/** Pi's prompt for its own tools: their snippets and guidelines, other tools listed only when they bring a snippet. */
export function build(options: Omit<Options, "toolSnippets" | "toolGuidelines">) {
  return render(contributed(options))
}

/** {@link build}'s sections by name (own's prompt page shows them one by one). */
export function buildSections(options: Omit<Options, "toolSnippets" | "toolGuidelines">) {
  return sections(contributed(options))
}

function contributed(options: Omit<Options, "toolSnippets" | "toolGuidelines">): Options {
  return {
    ...options,
    toolSnippets: Object.fromEntries(Object.entries(CONTRIBUTIONS).map(([name, entry]) => [name, entry.snippet])),
    toolGuidelines: Object.fromEntries(Object.entries(CONTRIBUTIONS).map(([name, entry]) => [name, entry.guidelines])),
  }
}

/** `formatSkillsForPrompt`: the skills the model may load, with how to load them. */
export function formatSkills(skills: ReadonlyArray<Skill>, reader: "read" | "bash" | "indirect" = "read") {
  const visible = skills.filter((skill) => !skill.disableModelInvocation)
  if (visible.length === 0) return ""
  return [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    reader === "read"
      ? "Use the read tool to load a skill's file when the task matches its description."
      : reader === "bash"
        ? "Use bash to load a skill's file when the task matches its description."
        : "Load a skill's file when the task matches its description.",
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n")
}

function projectContext(files: ReadonlyArray<{ readonly path: string; readonly content: string }>) {
  return [
    "Project-specific instructions and guidelines:",
    ...files.map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`),
  ].join("\n\n")
}

/** `buildRules`: the shell hint when no search tools are selected, tool guidelines, extra guidelines, Pi's two rules. */
function rules(
  selected: ReadonlyArray<string>,
  toolGuidelines: Readonly<Record<string, ReadonlyArray<string>>>,
  promptGuidelines: ReadonlyArray<string>,
) {
  const bash = selected.includes("bash")
  const powershell = selected.includes("powershell")
  const search = ["grep", "find", "ls"].some((name) => selected.includes(name))
  const shell =
    (bash || powershell) && !search
      ? bash && powershell
        ? ["Use bash or PowerShell for file operations like listing, searching, and finding files"]
        : powershell
          ? ["Use PowerShell for file operations like listing, searching, and finding files"]
          : ["Use bash for file operations like ls, rg, find"]
      : []
  const all = [
    ...shell,
    ...selected.flatMap((name) => toolGuidelines[name] ?? []),
    ...promptGuidelines,
    "Be concise in your responses",
    "Show file paths clearly when working with files",
  ]
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0)
  return [...new Set(all)].map((rule) => `- ${rule}`).join("\n")
}

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

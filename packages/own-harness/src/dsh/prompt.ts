// Ports dsh's system prompt assembly: packages/core/system-prompt/src/index.ts (sections at centrally allocated orders,
// sorted by order then name, empty ones dropped, joined by a blank line; `{{model}}` and `{{provider}}` from
// core/agent-loop), the fixed harness identity, the web app's standard agent preset persona
// (packages/bundle/web-app/presets/standard.patch.yml) and the guidance sections of the tools own ports, each only when
// its tool is listed, as dsh's tools register them. Sections of tools own does not port (jobs, web, goals, workflow,
// sub-agents, present, file references, plan mode) are left out for the same reason. own's guidance that core and other
// plugins add goes where dsh puts the same kind of text: MCP guidance at `MCP_SERVERS`, the Code Mode catalog and project
// references at `TOOLS_SDK`, own's context entries and other plugins' system parts before the local facts. Everything
// that changes per conversation goes into history messages instead (context.ts), as dsh does.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshPrompt from "./prompt.js"

import { DshFs } from "./fs.js"
import { DshSearch } from "./search.js"
import { DshShellTool } from "./shell-tool.js"

/** `SECTION_ORDERS` entries the ported sections use. */
export const ORDERS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000,
  /** own's: its context entries and other plugins' system parts, after dsh's guidance and before local facts. */
  OWN_CONTEXT: 9500,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
} as const

/** `harness:identity`. */
export const IDENTITY = "You are an AI agent powered by DeepSeek Harness."

/** The standard agent preset's persona prefix. */
export const PERSONA = "You are a coding agent powered by the {{model}} model."

export interface Section {
  readonly name: string
  readonly order: number
  readonly text: string
}

export interface Options {
  readonly model: string
  readonly provider: string
  /** The tools the request lists, by dsh name. */
  readonly tools: ReadonlyArray<string>
  /**
   * Replaces the persona prefix: a config agent's own system prompt (as a dsh agent preset's persona row shadows the
   * deployment persona) or the user's 내 지시문 (10 §3.11).
   */
  readonly persona?: string
  /** own's guidance in dsh's slots. */
  readonly mcp?: string
  readonly sdk?: ReadonlyArray<string>
  readonly context?: ReadonlyArray<string>
}

/** The sections in dsh's order. */
export function sections(options: Options): ReadonlyArray<Section> {
  const has = (tool: string) => options.tools.includes(tool)
  const entries: ReadonlyArray<Section> = [
    { name: "harness:identity", order: ORDERS.HARNESS_IDENTITY, text: IDENTITY },
    {
      name: "deployment:persona-prefix",
      order: ORDERS.DEPLOYMENT_PERSONA_PREFIX,
      text: interpolate(options.persona ?? PERSONA, { model: options.model, provider: options.provider }),
    },
    { name: "tool:bash", order: ORDERS.TOOL_BASH, text: has("bash") ? DshShellTool.BASH_SECTION : "" },
    { name: "tool:pwsh", order: ORDERS.TOOL_PWSH, text: has("pwsh") ? DshShellTool.PWSH_SECTION : "" },
    { name: "tool:read", order: ORDERS.TOOL_READ, text: has("read") ? DshFs.READ_SECTION : "" },
    { name: "tool:write", order: ORDERS.TOOL_WRITE, text: has("write") ? DshFs.writeSection(has("edit")) : "" },
    { name: "tool:edit", order: ORDERS.TOOL_EDIT, text: has("edit") ? DshFs.EDIT_SECTION : "" },
    { name: "tool:glob", order: ORDERS.TOOL_GLOB, text: has("glob") ? DshSearch.GLOB_SECTION : "" },
    { name: "tool:grep", order: ORDERS.TOOL_GREP, text: has("grep") ? DshSearch.grepSection(has("read")) : "" },
    { name: "mcp:servers", order: ORDERS.MCP_SERVERS, text: options.mcp ?? "" },
    { name: "tools:sdk", order: ORDERS.TOOLS_SDK, text: (options.sdk ?? []).join("\n\n") },
    { name: "own:context", order: ORDERS.OWN_CONTEXT, text: (options.context ?? []).join("\n\n") },
    { name: "deployment:persona-suffix", order: ORDERS.DEPLOYMENT_PERSONA_SUFFIX, text: "" },
  ]
  return entries.toSorted((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** `renderPrompt`: the non-empty sections joined by a blank line. */
export function render(parts: ReadonlyArray<Section>) {
  return parts
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n\n")
}

/**
 * dsh's strict `{{name}}` interpolation for the variables it registers (`model`, `provider`). dsh rejects an unknown
 * name; own leaves it as written, since the persona can be the user's own text (내 지시문).
 */
export function interpolate(text: string, variables: Readonly<Record<string, string>>) {
  return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (match, name: string) =>
    Object.hasOwn(variables, name) ? variables[name]! : match,
  )
}

export * as Names from "./names.js"

/**
 * The names omo sees (OpenCode 1) and the ones OpenCode 2 runs (15 §3). Agents: core `build` runs as omo's Sisyphus in
 * omo sessions, omo's subagents are registered as `omo-<config key>`, core `explore` is shown as `explore (core)` so it
 * does not collide with omo's explore, and any other agent keeps its name. Tools: omo's tools are registered as
 * `omo_<name>` and listed under `<name>`; core's tools keep their OpenCode 2 names and inputs for the model, and omo's
 * hooks see them as OpenCode 1 named them (`bash`, `apply_patch`, `filePath`).
 */

/** omo's display name of Sisyphus (omo `AGENT_DISPLAY_NAMES.sisyphus`). */
export const SISYPHUS = "Sisyphus - ultraworker"
export const CORE_EXPLORE = "explore (core)"
/** The prefix of omo's tools and agents in OpenCode 2. */
export const TOOL_PREFIX = "omo_"
export const AGENT_PREFIX = "omo-"

export interface Agents {
  /** The OpenCode 1 name of an OpenCode 2 agent. */
  readonly toV1: (agent: string) => string
  /** The OpenCode 2 agent omo means by an OpenCode 1 name (a display name or a config key); unknown names pass through. */
  readonly toV2: (agent: string) => string
}

/**
 * The agent names of a started runtime. `registered` maps each registered omo agent's config key to its display name
 * (`explore` → `explore`, `sisyphus-junior` → `Sisyphus-Junior`); `keyOf` is omo's `getAgentConfigKey`.
 */
export function agents(input: {
  readonly registered: ReadonlyMap<string, string>
  readonly keyOf: (name: string) => string
}): Agents {
  const v1 = new Map([...input.registered].map(([key, display]) => [`${AGENT_PREFIX}${key}`, display]))
  return {
    toV1: (agent) => {
      if (agent === "build") return SISYPHUS
      if (agent === "explore") return CORE_EXPLORE
      return v1.get(agent) ?? agent
    },
    toV2: (agent) => {
      const name = agent.trim()
      if (name === CORE_EXPLORE) return "explore"
      const key = input.keyOf(name)
      if (key === "sisyphus") return "build"
      if (input.registered.has(key)) return `${AGENT_PREFIX}${key}`
      return name
    },
  }
}

/** The OpenCode 1 tool and input omo's hooks see for an OpenCode 2 call (`registered` is the tool the call runs). */
export function toolToV1(tool: string, input: unknown, registered?: string) {
  const name = registered ?? tool
  const args = record(input)
  if (name.startsWith(TOOL_PREFIX)) return { tool: name.slice(TOOL_PREFIX.length), args }
  if (name === "shell") return { tool: "bash", args }
  if (name === "patch") return { tool: "apply_patch", args }
  if (name === "read" || name === "write" || name === "edit") return { tool: name, args: rename(args, "path", "filePath") }
  return { tool: name, args }
}

/** An OpenCode 1 input back in the shape of the OpenCode 2 tool `tool` (the inverse of {@link toolToV1}). */
export function argsToV2(tool: string, args: Record<string, unknown>) {
  if (tool === "read" || tool === "write" || tool === "edit") return rename(args, "filePath", "path")
  return args
}

/** The OpenCode 2 tool a request lists for an OpenCode 1 tool name (session overlays and agent restrictions). */
export function toolToV2(tool: string) {
  if (tool === "bash") return "shell"
  if (tool === "apply_patch") return "patch"
  return tool
}

function rename(args: Record<string, unknown>, from: string, to: string) {
  if (!(from in args)) return args
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key === from ? to : key, value]))
}

function record(input: unknown): Record<string, unknown> {
  // SAFETY: tool inputs are JSON objects (core validates them against the tool's schema before the hooks run).
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

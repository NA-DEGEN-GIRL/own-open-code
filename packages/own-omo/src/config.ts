export * as OmoConfig from "./config.js"

import type { OmoRuntime } from "./omo-runtime.js"

/**
 * omo's internal hooks the MVP runs (15 §5). Every other hook omo knows is in `disabled_hooks`, so a re-pin that adds a
 * hook keeps it off until it is reviewed.
 */
export const ENABLED_HOOKS = [
  "keyword-detector",
  "todo-continuation-enforcer",
  "stop-continuation-guard",
  "background-notification",
  "agent-usage-reminder",
  "delegate-task-retry",
  "empty-task-response-detector",
  "task-resume-info",
  "todo-description-override",
  "tasks-todowrite-disabler",
  "write-existing-file-guard",
  "edit-error-recovery",
] as const

/** The omo agents own registers (as `omo-<key>`): Sisyphus runs as core `build` instead (15 §4.5). */
export const AGENTS = ["explore", "librarian", "oracle", "sisyphus-junior"] as const

/** omo's built-in task categories; with policy `inherit` they all run on own's model. */
export const CATEGORIES = [
  "visual-engineering",
  "artistry",
  "ultrabrain",
  "deep",
  "deep-low",
  "deep-high",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
] as const

const DISABLED_AGENTS = [
  "hephaestus",
  "prometheus",
  "atlas",
  "metis",
  "momus",
  "multimodal-looker",
  "athena",
  "athena-junior",
  "council-member",
]

const DISABLED_TOOLS = [
  "grep",
  "glob",
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "look_at",
  "skill",
  "skill_mcp",
  "interactive_bash",
]

const DISABLED_SKILLS = [
  "debugging",
  "dev-browser",
  "frontend",
  "git-master",
  "init-deep",
  "playwright",
  "remove-ai-slops",
  "review-work",
  "security-research",
  "security-review",
  "team-mode",
  "visual-qa",
]

/**
 * own's omo config (15 §4.8): telemetry, updates, fallbacks and every feature outside the MVP off, MCPs and the Claude
 * Code loaders off, and every agent and category on `model` (own's default model when omo starts; with policy `inherit`
 * the host runs them on the parent session's model anyway).
 */
export function baseline(model: string, hooks: ReadonlyArray<string>) {
  return {
    telemetry: false,
    auto_update: false,
    model_fallback: false,
    runtime_fallback: false,
    hashline_edit: false,
    new_task_system_enabled: false,
    team_mode: { enabled: false },
    tmux: { enabled: false },
    monitor: { enabled: false },
    goal: { enabled: false },
    tui: { sidebar: { enabled: false } },
    claude_code: { mcp: false, commands: false, skills: false, agents: false, hooks: false, plugins: false },
    disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
    disabled_agents: DISABLED_AGENTS,
    disabled_commands: ["goal", "refactor", "ulw-execute", "remove-ai-slops", "hyperplan"],
    disabled_tools: DISABLED_TOOLS,
    disabled_skills: DISABLED_SKILLS,
    disabled_hooks: hooks.filter((hook) => !(ENABLED_HOOKS as ReadonlyArray<string>).includes(hook)),
    keyword_detector: { disabled_keywords: ["team", "hyperplan", "hyperplan-ultrawork"] },
    agents: Object.fromEntries(["sisyphus", ...AGENTS].map((agent) => [agent, { model }])),
    categories: Object.fromEntries(CATEGORIES.map((category) => [category, { model }])),
  }
}

/** Keys own decides whatever the user's config says (15 §4.8): its policies are not configurable. */
const ENFORCED = [
  "telemetry",
  "auto_update",
  "team_mode",
  "tmux",
  "claude_code",
  "disabled_mcps",
  "disabled_agents",
  "disabled_tools",
  "disabled_hooks",
] as const

/**
 * The config omo starts with: the user's `config` option merged over the baseline (objects deeply, arrays and values
 * replaced), then own's enforced keys and the model policy put back, validated with omo's schema.
 */
export function resolve(
  runtime: Pick<OmoRuntime, "OhMyOpenCodeConfigSchema" | "HookNameSchema">,
  input: { readonly model: string; readonly user?: unknown },
) {
  const base = baseline(input.model, runtime.HookNameSchema.options)
  const merged = merge(base, isRecord(input.user) ? input.user : {})
  const enforced = {
    ...merged,
    ...Object.fromEntries(ENFORCED.map((key) => [key, base[key]])),
    agents: withModels(merged.agents, base.agents),
    categories: withModels(merged.categories, base.categories),
  }
  const parsed = runtime.OhMyOpenCodeConfigSchema.safeParse(enforced)
  if (!parsed.success) throw new Error(`own-omo config is not valid for omo: ${parsed.error.message}`)
  return parsed.data
}

function withModels(merged: unknown, base: Record<string, { readonly model: string }>) {
  const current = isRecord(merged) ? merged : {}
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(base).map(([key, value]) => [key, { ...(isRecord(current[key]) ? current[key] : {}), model: value.model }]),
    ),
  }
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(over)])].map((key) => {
      const left = base[key]
      const right = over[key]
      if (right === undefined) return [key, left]
      if (isRecord(left) && isRecord(right)) return [key, merge(left, right)]
      return [key, right]
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

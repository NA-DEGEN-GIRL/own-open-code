export * as OwnHarnessRouting from "./rpc-harness-routing.js"

// Plain metadata of `own.harness` (10 §3.2): own-web reads a session's harness from its metadata for the label without
// evaluating the RPC schema graph, so this file has no runtime imports.

export const ID = "own.harness"

/**
 * Session metadata key own.harness writes; its value is `{id, v}`, plus `prompt` when the session runs a variant other
 * than {@link PROMPT_FALLBACK}. Children inherit it with the rest of the metadata.
 */
export const META_KEY = "own.harness"

/**
 * The harnesses this build knows (10 §0 H-D2): `opencode` is upstream's request as it is, `codex` follows Codex CLI,
 * `pi` follows the Pi coding agent (12), `dsh` follows DeepSeek's deepseek-harness (13, 2026-10-19), `omo` runs the real
 * oh-my-opencode through own-omo (15, 2026-10-28; offered only while own-omo is loaded), `claude-code` is `opencode` with
 * the Claude Agent provider's Claude Code prompt in front (2026-10-31; the default on {@link CLAUDE_AGENT}, `opencode`
 * on every other provider). A build that does not know an id reads such a session as {@link FALLBACK} (`bound` answers
 * undefined), so an `omo` session runs as `opencode` there.
 */
export const IDS = ["opencode", "codex", "pi", "dsh", "omo", "claude-code"] as const
export type HarnessID = (typeof IDS)[number]

/**
 * Upstream's Claude Agent provider (core `Provider.ID.claudeAgent`), which runs Claude Code through the Agent SDK. A new
 * top-level session on it that names no harness runs `claude-code`.
 */
export const CLAUDE_AGENT = "claude-agent"

/**
 * The provider options that provider's model reads its system prompt from (core `ClaudeSystemPrompt.AGENT_OPTION` and
 * `INSTRUCTIONS_OPTION`): Claude Code's prompt, then the agent role, then the instructions. Its own request hooks fill
 * them from core's system before own's run, so a harness that rebuilds the system writes its text here (`codex`, `pi`,
 * `dsh` in own-harness, `omo` in own-omo).
 */
export const CLAUDE_AGENT_ROLE = "claudeCodeAgent"
export const CLAUDE_AGENT_INSTRUCTIONS = "claudeCodeInstructions"

/** Version of the `{id, v}` value. */
export const VERSION = 1

/** A session without the key (made before own.harness, or by a client that set none) runs the `opencode` harness. */
export const FALLBACK: HarnessID = "opencode"

/**
 * Base system prompt variants (10 §3.9): `reference` is the harness's original (Codex CLI's, Pi's, dsh's, OpenCode's), `own`
 * is own's revision of it for the app, `custom` (내 지시문, 10 §3.11, 2026-10-18) is own's revision with the user's text
 * in its editable part, saved per harness on the service. A harness without a revision runs its original under every
 * variant; `custom` without a saved text runs `own`. Builds before 2026-10-18 know only the first two: their
 * {@link promptOf} reads `custom` as `reference`, and their services refuse it as input.
 */
export const PROMPTS = ["reference", "own", "custom"] as const
export type PromptID = (typeof PROMPTS)[number]

/**
 * The harnesses with an editable prompt part (내 지시문): Codex's base instructions, Pi's opening paragraph, dsh's
 * persona line.
 */
export const CUSTOM_HARNESSES = ["codex", "pi", "dsh"] as const
export type CustomHarnessID = (typeof CUSTOM_HARNESSES)[number]

/** The harnesses `prompt.preview` shows: those with 내 지시문, and `claude-code`, which has no variant to edit. */
export const PREVIEW_HARNESSES = [...CUSTOM_HARNESSES, "claude-code"] as const
export type PreviewHarnessID = (typeof PREVIEW_HARNESSES)[number]

/** A session whose metadata names no variant runs the original. */
export const PROMPT_FALLBACK: PromptID = "reference"

/** The harness a session's metadata names, or undefined when it names none this build knows. */
export function bound(metadata: Readonly<Record<string, unknown>> | undefined): HarnessID | undefined {
  const value = metadata?.[META_KEY]
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined
  return IDS.find((id) => id === value.id)
}

/** The harness a session runs: the one its metadata names, else {@link FALLBACK}. */
export function harnessOf(metadata: Readonly<Record<string, unknown>> | undefined): HarnessID {
  return bound(metadata) ?? FALLBACK
}

/** The prompt variant a session runs: the one its metadata names, else {@link PROMPT_FALLBACK}. */
export function promptOf(metadata: Readonly<Record<string, unknown>> | undefined): PromptID {
  const value = metadata?.[META_KEY]
  if (typeof value !== "object" || value === null || !("prompt" in value)) return PROMPT_FALLBACK
  return PROMPTS.find((id) => id === value.prompt) ?? PROMPT_FALLBACK
}

/** The metadata value for `id` and `prompt`; the original variant is left out, so such values stay `{id, v}`. */
export function value(
  id: HarnessID,
  prompt: PromptID = PROMPT_FALLBACK,
): { id: HarnessID; v: number; prompt?: PromptID } {
  return prompt === PROMPT_FALLBACK ? { id, v: VERSION } : { id, v: VERSION, prompt }
}

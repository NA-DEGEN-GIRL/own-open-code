// 설정 > 에이전트 방식 `하위 에이전트` (10 §3.11, prompt-page.tsx): what the part says for a 에이전트 방식, from the
// service's view of how it hands work to a child (`prompt.preview`'s `subagent`, `prompt.subagent` for OpenCode 기본)
// and, for Codex, which spawn_agent text the previewed model gets. Pure, so tests read the words without a browser.
import type { OwnHarness } from "@own/protocol/rpc-harness"
import type { HarnessID } from "@own/protocol/rpc-harness-routing"
import type { FeatureText } from "@/queue/text"
import type { PromptsKey } from "./prompt-strings"

export interface SubagentView {
  /** The delegation tool as the model gets it, with what to know about it. */
  readonly tool?: { readonly name: string; readonly description: string; readonly notes: ReadonlyArray<string> }
  /** A new child's first message: the harness's opening, then where the parent's text goes. */
  readonly first: { readonly text: string; readonly note: string }
  readonly sends: ReadonlyArray<string>
  /** Text the harness gives every child besides its task (Codex v2's role). */
  readonly role?: string
  readonly returns: ReadonlyArray<string>
}

/** The `subagent` tool's list core appends (core/src/tool/plugin/subagent.ts). */
const LIST = "Available subagents:"

export function subagentView(
  input: {
    readonly harness: HarnessID
    readonly subagent: OwnHarness.PromptSubagent
    /** Codex: the previewed model's tier and the variant that runs, which pick its spawn_agent text. */
    readonly codex?: { readonly tier?: "catalog" | "lean" | "fallback"; readonly applied: OwnHarness.PromptID }
  },
  t: FeatureText<PromptsKey>,
): SubagentView {
  const subagent = input.subagent
  const core = subagent.kind === "core"
  const tool = subagent.tool
  const agent = subagent.agent
  const notes = tool && [
    // Codex in Code Mode on a v1 model keeps core's subagent (own-harness `CodexRequest.codeMode`).
    ...(core && input.harness === "codex" ? [t("own.prompts.subagent.codemode")] : []),
    ...(core ? [] : [t(`own.prompts.subagent.ask.${codexAsk(subagent.kind, input.codex)}`)]),
    ...(agent !== undefined && tool.description.includes(LIST) ? [t("own.prompts.subagent.agents", { agent })] : []),
    // Over the Claude Agent provider the tool is an MCP tool under Claude Code's name.
    ...(core && tool.name !== "subagent" ? [t("own.prompts.subagent.mcp", { name: tool.name })] : []),
  ]
  return {
    ...(tool && notes ? { tool: { name: tool.name, description: tool.description, notes } } : {}),
    first: {
      text: `${subagent.opening}${t("own.prompts.subagent.parentText", { field: core ? "prompt" : "message" })}`,
      note: t(`own.prompts.subagent.first.${subagent.kind}`),
    },
    sends: [
      t(subagent.kind === "codex-v2" ? "own.prompts.subagent.extra.codex-v2" : "own.prompts.subagent.extra.none"),
      ...(core ? [t(`own.prompts.subagent.role.${roleOf(input.harness)}`)] : []),
      t("own.prompts.subagent.preset"),
    ],
    ...(subagent.guidance === "" ? {} : { role: subagent.guidance }),
    returns: [
      t(`own.prompts.subagent.return.${subagent.kind}`),
      ...(subagent.cut === undefined
        ? []
        : [
            t("own.prompts.subagent.cut", {
              lines: subagent.cut.lines.toLocaleString("en-US"),
              size: `${Math.round(subagent.cut.bytes / 1024).toLocaleString("en-US")} KiB`,
            }),
          ]),
      ...(core ? [t("own.prompts.subagent.background"), t("own.prompts.subagent.notice")] : []),
    ],
  }
}

/**
 * What Codex's spawn_agent asks of a child for the previewed model: v2's collaboration text, Codex's own text (catalog
 * GPT models, and 원본 for every model), or 개선판's for a model outside the catalog, lean or fallback (variant.ts).
 */
function codexAsk(
  kind: OwnHarness.PromptSubagent["kind"],
  codex: { readonly tier?: "catalog" | "lean" | "fallback"; readonly applied: OwnHarness.PromptID } | undefined,
) {
  if (kind === "codex-v2") return "v2"
  if (codex === undefined || codex.applied === "reference" || codex.tier === "catalog") return "original"
  return codex.tier === "lean" ? "lean" : "fallback"
}

/** Where a role's own instructions go: per 에이전트 방식; anything else runs like OpenCode 기본. */
function roleOf(harness: HarnessID) {
  return harness === "pi" || harness === "dsh" || harness === "claude-code" || harness === "codex"
    ? harness
    : "opencode"
}

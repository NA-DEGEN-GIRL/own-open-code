// Builds a pi session's request from core's (12 §3): Pi's structured system prompt (prompt.ts) in place of core's
// system parts, Pi's tools under Pi's names in place of core's file and shell tools, and the history in Pi's tool
// names with own's checkpoints rendered (common compaction, 11). Core's instruction baseline supplies Pi's project
// context (the AGENTS.md files core loaded), the skills and the working directory; config `instructions`, own's
// context entries and the guidance core and plugins add (Code Mode catalog, MCP, references) go into Pi's <addendum>.
// A pure function of the request and the stored session state, so the same history gives the same bytes (02 §4.3 D1).
export * as PiRequest from "./request.js"

import { Message, SystemPart } from "@opencode/ai/effect"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { Baseline } from "../codex/baseline.js"
import { CodexCompaction } from "../codex/compaction.js"
import { History } from "../history.js"
import { Registry } from "../registry.js"
import { PiPrompt } from "./prompt.js"
import { PiTools } from "./tools.js"
import { PiVariant } from "./variant.js"

/** Core tools Pi's own replace: its file and shell tools. Other tools stay as Pi's "other custom tools". */
export const REPLACED = ["shell", "patch", "edit", "write", "read", "glob", "grep"]

export interface Draft {
  system: Array<SystemPart>
  messages: Array<Message>
  tools?: Record<string, { description: string; input: unknown }>
}

export interface Session {
  /** The Location's directory: Pi's cwd. */
  readonly cwd: string
  /** Core's checkpoint metadata by message id (`CodexCompaction.checkpoints`); absent renders checkpoints as core wrote them. */
  readonly checkpoints?: CodexCompaction.Checkpoints
  /** `cwd` resolved as core resolves the folders it walks for AGENTS.md (Baseline.sources); `cwd` when absent. */
  readonly realCwd?: string
  /** The provider speaks OpenAI Responses: Pi sends its prompt as the leading developer message there. */
  readonly responses: boolean
  /** A config agent's own system prompt, which Pi takes as a custom prompt (its SYSTEM.md). */
  readonly agentInstructions?: string
  /** own's skills with their files, for the skills the baseline lists. */
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly path: string }>
  /** The session's base prompt variant (10 §3.9); `own` and `custom` shorten core's Code Mode catalog (variant.ts). */
  readonly prompt?: OwnHarness.PromptID
  /** The user's opening paragraph (내 지시문, 10 §3.11) under `custom`; without it `custom` runs `own`. */
  readonly custom?: string
  /** own's extra <rules> lines, as a Pi extension adds them: on Windows, which shell `bash` runs (PiShell). */
  readonly guidelines?: ReadonlyArray<string>
}

export function build(draft: Draft, session: Session) {
  const texts = draft.system.map((part) => part.text)
  const at = texts.findIndex(Baseline.isBaseline)
  const baseline = at < 0 ? undefined : Baseline.parse(texts[at]!)
  // Core's system: [agent prompt, `# Your Model` identity, baseline, parts plugins appended]. Pi's prompt replaces
  // the agent prompt and the identity block; the baseline is read back; the other parts join the addendum.
  const appended = texts.filter((text, index) => index !== 0 && index !== at && !IDENTITY.test(text))
  const codemode =
    PiVariant.revised(session.prompt) && baseline?.codemode !== undefined
      ? PiVariant.codemode(baseline.codemode)
      : baseline?.codemode
  const files = Baseline.sources(baseline?.instructions ?? [], session.realCwd ?? session.cwd)
  // Config `instructions` (files and URLs) are Pi's appended system prompt (`--append-system-prompt`, APPEND_SYSTEM.md):
  // their contents open the addendum, joined with a blank line as Pi joins its append sources. An empty one adds
  // nothing, as Pi drops an empty `--append-system-prompt` and Codex an empty `developer_instructions`.
  const addendum = [
    ...files.configured.map((file) => file.content).filter((text) => text !== ""),
    ...[codemode, baseline?.mcp, baseline?.references].filter((text) => text !== undefined),
    ...(baseline?.rest ?? []),
    ...(baseline?.contexts ?? []).map((entry) => `<context key="${entry.key}">\n${entry.value}\n</context>`),
    ...appended,
  ]
  // Pi loads the global AGENTS.md first, then the project's from the root down.
  const contextFiles = [...files.global, ...files.project]
  const tools = draft.tools === undefined ? undefined : piTools(draft.tools)
  const sections = PiPrompt.buildSections({
    customPrompt: session.agentInstructions,
    preamble: session.prompt === "custom" ? session.custom : undefined,
    selectedTools: PiPrompt.DEFAULT_TOOLS.filter((name) => tools?.[name] !== undefined),
    promptGuidelines: session.guidelines,
    appendSystemPrompt: addendum.join("\n\n"),
    cwd: session.cwd,
    contextFiles,
    skills: session.skills.map((skill) => ({
      name: skill.name,
      description: skill.description ?? "",
      filePath: skill.path,
    })),
  })
  const prompt = PiPrompt.join(sections)
  const history = History.translate(draft.messages, Registry.pi).flatMap((entry) =>
    CodexCompaction.render(entry, session.checkpoints),
  )
  draft.system = session.responses ? [] : [SystemPart.make(prompt)]
  draft.messages = session.responses ? [Message.make({ role: "system", content: prompt }), ...history] : history
  if (tools !== undefined) draft.tools = tools
  return { history, prompt, sections }
}

/** Pi's tools first under Pi's names (the same definition objects, so core runs the registered tool), then the rest. */
function piTools(current: NonNullable<Draft["tools"]>) {
  const internal = new Set(Object.values(PiTools.INTERNAL))
  const pi = PiPrompt.DEFAULT_TOOLS.flatMap((name) => {
    const entry = current[PiTools.INTERNAL[name]!]
    return entry === undefined ? [] : [[name, entry] as const]
  })
  const kept = Object.entries(current).filter(([name]) => !REPLACED.includes(name) && !internal.has(name))
  return Object.fromEntries([...pi, ...kept])
}

/** Core's `# Your Model` block (core/src/plugin/identity.ts). */
const IDENTITY = /^# Your Model\n- Name: .*\n- Provider ID: .*\n- Model ID: .*$/

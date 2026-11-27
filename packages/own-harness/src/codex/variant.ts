// own's revision of Codex's request for models outside Codex's catalog (10 §3.9), the `own` prompt variant. Codex's
// own models (the catalog) keep Codex's text under either variant: OpenAI wrote each template for its model, and the
// golden tests hold own to it. Other models (DeepSeek, Claude, ...) run Codex's fallback prompt, which describes the
// Codex CLI in a terminal with an OS sandbox. The revision describes own instead: the app, own's approval modes, the
// patch shape own intercepts and own's models. Frontier Claude models (Claude Code's lean tier: Opus 4.8 and later,
// Fable, Mythos) get own's short base text (`variant-base.md`) in place of the fallback prompt; the others keep Codex's
// text with the lines in REPLACEMENTS rewritten.
// The `custom` variant (내 지시문, 10 §3.11) is the revision with the user's text as the base instructions, for every
// model: the permissions text, the tools and everything else stay what `own` sends that model. Each change carries a
// Korean title and reason for 설정 > 에이전트 방식 (prompts.ts lists them with their before and after texts).
export * as CodexVariant from "./variant.js"

import type { OwnHarness } from "@own/protocol/rpc-harness"
import LEAN_BASE from "./variant-base.md" with { type: "text" }
import { Catalog } from "./catalog.js"
import type { Fragments } from "./fragments.js"

/**
 * A span of Codex's text and own's text for it, with why (Korean, shown in 설정 > 에이전트 방식). `id` names it for
 * good: the change's id in `prompt.preview` (`codex.base.<id>`, `codex.spawn.<id>`) and its manual anchor (10.13,
 * script/prompt-manual.ts) come from it, so adding or moving one leaves the others' links alone.
 */
export interface Replacement {
  readonly id: string
  readonly title: string
  readonly why: string
  readonly from: string
  readonly to: string
}

/**
 * Codex's base instructions for `model` under `prompt`; under `custom` the user's text (`custom`) with own's patch
 * section in place of {@link PATCH_SLOT}, or own's revision while no text is saved. With `jsonPatch` (apply_patch is a
 * JSON tool, request.ts) own's patch text describes that tool ({@link PATCH_TOOL}) instead of exec_command's heredoc.
 */
export function instructions(
  model: Catalog.Model,
  prompt: OwnHarness.PromptID | undefined,
  custom?: string,
  jsonPatch = false,
) {
  const patch = jsonPatch ? PATCH_TOOL : PATCH
  if (prompt === "custom" && custom !== undefined) return custom.replaceAll(PATCH_SLOT, patch)
  if (lean(model, prompt)) return jsonPatch ? LEAN_BASE.replace(PATCH_SLOT, PATCH_TOOL) : LEAN
  const base = Catalog.instructions(model)
  if (!revised(model, prompt)) return base
  return REPLACEMENTS.reduce((text, item) => text.replace(item.from, jsonPatch ? jsonPatchText(item) : item.to), base)
}

/** A replacement's text where apply_patch is a JSON tool: Codex's line about re-reading after `apply_patch` holds again. */
function jsonPatchText(item: Replacement) {
  if (item.id === "patch") return `- ${PATCH_TOOL}`
  if (item.id === "reread") return item.from
  return item.to
}

/**
 * The editable text 내 지시문 starts from: the base instructions `model` gets under `prompt`, with own's patch section
 * (which tells the model the patch shape own intercepts) left as {@link PATCH_SLOT} so it stays generated.
 */
export function start(model: Catalog.Model, prompt: "reference" | "own") {
  return instructions(model, prompt).replaceAll(PATCH, PATCH_SLOT)
}

/** Where 내 지시문 takes own's patch section ({@link PATCH}). */
export const PATCH_SLOT = "{{patch}}"

/**
 * Whether `model` runs own's revision (also under `custom`, which only replaces the base text). The revision also
 * keeps core's `# Your Model` block, which Codex's request otherwise drops: Codex's templates name the GPT model, the
 * fallback prompt names none.
 */
export function revised(model: Catalog.Model, prompt: OwnHarness.PromptID | undefined) {
  return (prompt === "own" || prompt === "custom") && !model.known
}

/**
 * Whether the revision sends own's lean base text: Claude Opus 4.8 and later, Fable and Mythos, by model id, the
 * models Claude Code 2.1.154 gave its lean prompt, and Claude Code's own aliases for them (`opus`, `fable`, with or
 * without `[1m]`), the model ids of the Claude Agent route (02 §8.10). Sonnet, Haiku, Opus 4.7 and earlier, DeepSeek
 * and other models keep the fallback prompt with the replacements.
 */
export function lean(model: Catalog.Model, prompt: OwnHarness.PromptID | undefined) {
  return revised(model, prompt) && frontier(model.slug.toLowerCase())
}

function frontier(id: string) {
  if (/claude-(fable|mythos)|claude-opus-latest/.test(id)) return true
  // Claude Code's aliases name its newest Opus and Fable, so `opus` is Opus 4.8 or later.
  if (/^(opus|fable|mythos)(\[1m\])?$/.test(id)) return true
  // `claude-opus-4-8`, `anthropic/claude-opus-5.5`, `claude-opus-5-fast`; a dated `claude-opus-4-20250514` is 4.0.
  const opus = /claude-opus-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(id)
  if (opus === null) return false
  const major = Number(opus[1])
  return major > 4 || (major === 4 && Number(opus[2] ?? 0) >= 8)
}

/** The patch grammar's file sections, in own's words. */
const SECTIONS = `File sections:
- \`*** Add File: <path>\`, then every line of the new file prefixed with \`+\`.
- \`*** Delete File: <path>\`.
- \`*** Update File: <path>\`, optionally \`*** Move to: <new path>\`, then hunks. A hunk starts with \`@@\`, or \`@@ <a nearby line such as a function signature>\` when the context alone is ambiguous, followed by lines prefixed with \` \` (unchanged), \`-\` (removed) or \`+\` (added). Give about three unchanged lines around each change; unchanged and removed lines must match the file.`

/**
 * How to edit files in own, in both revised texts: the patch shape own intercepts in `exec_command` (tools.ts
 * `runExec`, on every shell) and the patch grammar. The lean text gives it as its `# Editing files` section.
 */
export const PATCH = `Edit files with a patch: call \`exec_command\` with a \`cmd\` of this shape and nothing before or after it. own applies the patch itself on every shell, shows the user the diff, and returns whether it applied.

\`\`\`
apply_patch <<'EOF'
*** Begin Patch
<file sections>
*** End Patch
EOF
\`\`\`

${SECTIONS}

Paths are relative to the working directory, or absolute; to patch relative to another directory, set the call's \`workdir\`. Formatters, code generators and bulk renames can run as ordinary commands; write hand edits as patches.`

/**
 * {@link PATCH} where apply_patch is a JSON function tool (request.ts `jsonPatch`, the Claude Agent provider): the same
 * patch shape and grammar, sent as that tool's `input`.
 */
export const PATCH_TOOL = `Edit files with the \`apply_patch\` tool. Its \`input\` is the whole patch, of this shape and nothing before or after it. own applies the patch itself, shows the user the diff, and returns whether it applied.

\`\`\`
*** Begin Patch
<file sections>
*** End Patch
\`\`\`

${SECTIONS}

Paths are relative to the working directory, or absolute. Formatters, code generators and bulk renames can run as ordinary commands through \`exec_command\`; write hand edits as patches.`

/** The JSON apply_patch tool's description: what its `input` holds, for any base text (Codex's own names the tool). */
export const PATCH_TOOL_DESCRIPTION = `Edits files with a patch. \`input\` is the whole patch, from \`*** Begin Patch\` to \`*** End Patch\` with nothing before or after it; own applies it and returns whether it applied.

${SECTIONS}

Paths are relative to the working directory, or absolute.`

/** own's short base text for the lean tier, with its patch section. */
export const LEAN = LEAN_BASE.replace(PATCH_SLOT, PATCH)

/**
 * Codex's fallback-prompt spans and own's text for them (test/unit/codex/variant.test.ts checks every one applies),
 * each with a short Korean title and why own changed it.
 */
export const REPLACEMENTS: ReadonlyArray<Replacement> = [
  {
    id: "where",
    title: "어디서 일하는지",
    why: "Codex CLI(터미널 도구)가 아니라 이 앱에서 일한다고 알려요. 사용자는 데스크톱 창, 브라우저, 휴대폰에서 봐요.",
    from: "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.",
    to: "You are a coding agent running in own, a coding app the user opens in a desktop window, a browser or on a phone. You are expected to be precise, safe, and helpful.",
  },
  // own has no sandbox to escalate out of; `<permissions instructions>` describes own's approval mode.
  {
    id: "approval-request",
    title: "권한 상승 요청",
    why: "이 앱에는 벗어날 샌드박스가 없어서, 권한 상승을 요청하라는 문장 대신 승인 모드 설명을 보라고 해요. 언제 사용자에게 먼저 묻는지는 그 설명이 알려요.",
    from: 'Depending on how this specific run is configured, you can request that these function calls be escalated to the user for approval before running. More on this in the "Sandbox and approvals" section.',
    to: "`<permissions instructions>` says when own asks the user first.",
  },
  {
    id: "codex-name",
    title: "Codex 이름 설명",
    why: "Codex라는 이름이 무엇을 가리키는지 풀이하는 문장은 이 앱과 상관없어서 뺐어요.",
    from: "\n\nWithin this context, Codex refers to the open-source agentic coding interface (not the old Codex language model built by OpenAI).",
    to: "",
  },
  // Codex's call form is its `shell` tool's; own intercepts the heredoc in `exec_command` (tools.ts `runExec`). These
  // models get Codex's worked example after the grammar; the lean text keeps to the grammar. On 2026-10-16 DeepSeek
  // still called an `apply_patch` tool with exec_command's arguments once, which core refuses as unavailable.
  {
    id: "patch",
    title: "파일 고치는 방법",
    why: "이 앱에는 Codex의 apply_patch 도구가 없어서, exec_command로 보내는 패치 모양과 문법을 알려요. 이 줄이 없을 때(2026-10-14) DeepSeek은 파일을 통째로 다시 썼어요.",
    from: '- Use the `apply_patch` tool to edit files (NEVER try `applypatch` or `apply-patch`, only `apply_patch`): {"command":["apply_patch","*** Begin Patch\\\\n*** Update File: path/to/file.py\\\\n@@ def example():\\\\n- pass\\\\n+ return 123\\\\n*** End Patch"]}',
    to: `- ${PATCH}\n\nThere is no \`apply_patch\` tool: \`apply_patch\` is how the \`cmd\` you give \`exec_command\` starts. For example:\n\n\`\`\`\napply_patch <<'EOF'\n*** Begin Patch\n*** Update File: path/to/file.py\n@@ def example():\n- pass\n+ return 123\n*** End Patch\nEOF\n\`\`\``,
  },
  {
    id: "reread",
    title: "패치 뒤 다시 읽기",
    why: "apply_patch 도구를 부른다는 말 때문에 DeepSeek이 없는 도구를 불러서(2026-10-16), 패치가 됐는지는 exec_command 결과가 알려 준다고 고쳤어요.",
    from: "- Do not waste tokens by re-reading files after calling `apply_patch` on them. The tool call will fail if it didn't work.",
    to: "- Do not waste tokens by re-reading files after patching them. The `exec_command` result says whether the patch applied.",
  },
  {
    id: "user-view",
    title: "사용자가 보는 곳",
    why: "사용자는 같은 컴퓨터 앞이 아니라 앱에서, 때로는 다른 기기에서 봐요.",
    from: "The user is working on the same computer as you, and has access to your work.",
    to: "The user sees your work in the app, sometimes from another device, and has access to the files you change.",
  },
  // Codex's approval policy names; own's modes are full, ask and read-only.
  {
    id: "mode-full",
    title: "승인 모드 이름: 전체 허용",
    why: "이 앱에는 Codex 승인 정책(never)이 없어서 이 앱의 모드 이름을 써요.",
    from: "the non-interactive approval mode **never**",
    to: "approval mode **full**",
  },
  {
    id: "mode-ask",
    title: "승인 모드 이름: 묻기",
    why: "이 앱에는 Codex 승인 정책(untrusted, on-request)이 없어서 이 앱의 모드 이름을 써요.",
    from: "interactive approval modes like **untrusted**, or **on-request**",
    to: "approval mode **ask**",
  },
  {
    id: "format",
    title: "답의 형식",
    why: "답은 CLI가 꾸밀 평문이 아니라 앱이 그려 주는 Markdown이에요.",
    from: "You are producing plain text that will later be styled by the CLI.",
    to: "You are producing Markdown that the app renders.",
  },
  {
    id: "ansi",
    title: "ANSI 색 코드",
    why: "앱은 터미널 꾸밈이 아니라 Markdown을 그려요.",
    from: "\n- Don’t output ANSI escape codes directly — the CLI renderer applies them.",
    to: "\n- Don’t output ANSI escape codes; the app renders Markdown, not terminal styling.",
  },
]

/**
 * own's other changes in the revision, by id, with their Korean titles and reasons: the lean base text, the
 * permissions and environment texts, the tools and core's blocks own keeps or shortens. prompts.ts lists them with the
 * texts before and after.
 */
export const NOTES = {
  lean: {
    title: "짧은 기본 지시문",
    why: "Claude Opus 4.8 이후, Fable, Mythos에는 Claude Code처럼 짧은 지시문이 맞아요. 규칙 대신 판단, 예시 대신 형식으로 이 앱에 맞게 새로 썼어요. 첫 요청이 절반 가까이 줄어요.",
  },
  permissions: {
    title: "승인 모드 설명",
    why: "이 앱에는 OS 샌드박스가 없어서, Codex의 샌드박스 설명 대신 전체 허용, 묻기, 읽기 전용이 실제로 하는 일과 묻지 않고 이 앱이 직접 답하는 읽기를 알려요. 폴더 경로를 넣지 않아서 다른 폴더의 대화도 이 부분을 캐시에서 읽어요.",
  },
  environment: {
    title: "작업 환경의 읽기 전용 폴더",
    why: "이 앱은 .git, .agents, .codex를 막지 않아서, Codex 샌드박스가 지키는 이 읽기 전용 항목을 뺐어요. 남겨 두면 모델이 커밋을 못 한다고 여길 수 있어요.",
  },
  escalation: {
    title: "exec_command의 권한 상승 인자",
    why: "Codex 샌드박스를 벗어나려고 쓰는 인자(sandbox_permissions, justification, prefix_rule)를 이 앱은 쓰지 않아서 도구 정의에서 뺐어요.",
  },
  identity: {
    title: "모델 이름 블록",
    why: "대체 지시문에는 모델 이름이 없어서, Codex가 빼는 OpenCode의 모델 이름 블록(# Your Model)을 남겨요. GPT 템플릿에는 모델 이름이 들어 있어요.",
  },
  catalog: {
    title: "Code Mode 도구 목록",
    why: "OpenCode의 Code Mode 목록은 도구마다 입력과 출력 타입을 모두 적어 길어서(도구 8개에 약 5,000자), 도구마다 인자 이름과 설명 한 줄로 줄여요. 목록은 대화마다 달라 여기서는 설명만 보여요.",
  },
  spawnLean: {
    title: "하위 에이전트 설명(spawn_agent)",
    why: "짧은 기본 지시문에 맞춰 spawn_agent 설명도 짧게 새로 썼어요. 하위 에이전트는 같은 폴더의 같은 파일에서 일하고, 위임은 사용자나 프리셋의 위임 모드가 시킬 때만 해요.",
  },
  spawnModels: {
    title: "하위 에이전트의 모델 목록",
    why: "이 앱의 하위 에이전트는 부모 대화와 같은 회사의 모델로 돌아서, Codex 설명에 든 Codex 계정의 GPT 모델 목록을 뺐어요. 계정이 바뀔 때마다 캐시 맨 앞의 도구 글이 바뀌지 않게 다른 목록도 넣지 않아요.",
  },
  reasoningEffort: {
    title: "spawn_agent의 추론 강도 인자",
    why: "이 앱의 하위 에이전트는 reasoning_effort를 쓰지 않아 도구 정의에서 뺐어요.",
  },
} as const satisfies Readonly<Record<string, { readonly title: string; readonly why: string }>>

/**
 * `<permissions instructions>` for the revision: own's approval mode as it works (own-accounts switching/approval.ts,
 * core permission.ts and file-access.ts), in place of Codex's sandbox and escalation text. own has no OS sandbox; `ask`
 * asks before every command and patch (an "always allow" answer saves a rule for the project), and patches to the
 * protected paths are refused in every mode. Access outside the working directory is not asked about in any mode
 * (upstream since v2.0.28, kept by the user on 2026-10-17, FT-Q1). Under own's read-only and ask bundles
 * exec_command answers the simple reads itself without asking (read-only.ts, 10 §3.10), and both texts name them;
 * ask also says that `.env` reads still ask and that the reads own refuses itself (size, binary, Select-String on a
 * folder, RO-R2) are no dead end there: another command for the same need is asked about. Under rules it answers no
 * reads under (`reads` false, CodexReadOnly.serves) read-only says every command fails and ask leaves the reads out.
 * The text names no path: `<environment_context>` gives the working directory, and the same
 * bytes in every folder let sessions in other folders, team-mode worktrees included, read this block from the prompt
 * cache.
 */
export function permissions(mode: Fragments.Mode, reads: boolean) {
  return `<permissions instructions>\n${text(mode, reads)} ${MODES}\n</permissions instructions>`
}

function text(mode: Fragments.Mode, reads: boolean) {
  if (mode === "full") return FULL
  if (mode === "ask") return reads ? `${ASK} ${ASK_READS} ${ASK_RUNS}` : `${ASK} ${ASK_RUNS}`
  return reads ? READ_ONLY : REFUSING
}

/** The reads exec_command answers itself (read-only.ts `parse`), by command name. */
const READS =
  "one file or part of it (`Get-Content` or `cat` in PowerShell; `cat`, `head`, `tail` or `sed -n` in bash, zsh or sh), a folder listing (`ls`, `rg --files`, or `Get-ChildItem` in PowerShell) or a search of file contents (`rg`, or `Select-String` in PowerShell)"

const FULL =
  "Approval mode: full. own runs your commands and patches without asking the user; only patches to a few protected files (credentials, own's settings) are refused. Commands run for real on the machine that holds the working directory, with no sandbox and with network access, so take care with commands that delete or overwrite what the task does not need changed."

const ASK = `Approval mode: ask. Before a command runs or a patch is applied, own shows it to the user and waits for an answer, unless an earlier "always allow" covers it; patches to a few protected files (credentials, own's settings) are always refused.`

const ASK_READS = `Simple reads run without asking: \`exec_command\` answers them by reading the files itself: ${READS}. Write one such command per call with literal paths, and set \`workdir\` instead of using \`cd\`; reading a \`.env\` file still asks, and the protected files cannot be read even so. When own cannot answer such a read itself (a file over 16 MiB or not text, \`Select-String\` on a folder, a folder search outside the project), the result says so, and a different command for the same need is asked about like any other.`

const ASK_RUNS = `Commands run for real on the machine that holds the working directory, with no sandbox and with network access. Call tools as usual: there is nothing to request in advance, and the user sees only the command or the diff. If the user declines with a note, the tool result carries the note; follow it, and do not repeat the declined call unchanged. If the user declines without a note, your turn ends.`

const READ_ONLY = `Approval mode: read-only. own runs none of your commands and applies no patches in this session, but \`exec_command\` still answers simple reads by reading the files itself: ${READS}. Write one such command per call with literal paths, and set \`workdir\` instead of using \`cd\`. Any other command is refused, and a few protected files (credentials, own's settings) cannot be read even so. When the task needs more, tell the user what you would run or change.`

/** Read-only rules exec_command answers no reads under (a custom set without own's protected denies). */
const REFUSING =
  "Approval mode: read-only. own refuses shell commands and patches in this session, so `exec_command` calls fail with a permission error. Answer from what you already know and from the tools that still work, and tell the user what you would run or change."

/**
 * The app's names for the modes in its Korean and English UI, so the model can point the user at the right control.
 * They mirror own-web's `own.approval.full|ask|readOnly` in ko.ts and en.ts and must change with them.
 */
export const MODES =
  "The user sees the approval modes as `전체 허용` / Full access (full), `묻기` / Ask (ask) and `읽기 전용` / Read only (read-only) and switches them with the mode button in the conversation header."

/** The `exec_command` arguments of Codex's sandbox escalation, which own has no use for (tools.ts `runExec`). */
export const ESCALATION_FIELDS = ["sandbox_permissions", "justification", "prefix_rule"]

/**
 * `spawn_agent`'s description for the revision. Codex's lists the Codex account's GPT models and says a sub-agent
 * edits a forked workspace; own's sub-agents run on the caller's provider in the caller's directory (collab-v1.ts).
 * The lean tier gets own's short text; the others keep Codex's rules without the model list, with the lines in
 * SPAWN_AGENT_REPLACEMENTS rewritten.
 */
export function spawnAgent(description: string, short: boolean) {
  if (short) return SPAWN_AGENT_LEAN
  return SPAWN_AGENT_REPLACEMENTS.reduce(
    (text, item) => text.replace(item.from, item.to),
    description.slice(description.indexOf(SPAWN_AGENT_START)),
  )
}

/** Where Codex's description starts after its account's model list. */
export const SPAWN_AGENT_START = "Spawn a sub-agent for a well-scoped task."

/**
 * What of own's preset (07) applies to spawn_agent. The `own.preset` context sets how readily to delegate; its roles,
 * `background`, effort levels and model pool are written for core's `subagent` tool, which the codex harness replaces
 * with spawn_agent (10 §8 Q3). A pool name passed as `model` would make an invalid id on the caller's provider.
 */
const PRESET =
  "Only that context's delegation mode applies to spawn_agent: its roles, `agent`, `background`, effort levels and model names are not spawn_agent arguments."

/**
 * Codex's spawn_agent spans and own's text for them (variant.test.ts checks each against the golden definition), each
 * with a short Korean title and why own changed it.
 */
export const SPAWN_AGENT_REPLACEMENTS: ReadonlyArray<Replacement> = [
  {
    id: "model-arg",
    title: "하위 에이전트의 model 인자",
    why: "model에는 부모 대화와 같은 회사의 모델 ID만 쓸 수 있어서, # Your Model의 Model ID처럼 쓰라고 알려요.",
    from: "set `model` only when an explicit override is needed.",
    to: "set `model` only when an explicit override is needed. It is only ever a model id of your own provider, written like the `Model ID` under `# Your Model`.",
  },
  {
    id: "when",
    title: "위임해도 될 때",
    why: "이 앱에서는 프리셋의 위임 모드도 위임을 시킬 수 있어서, 위임해도 될 때에 그 경우를 더했어요. 프리셋의 역할, 추론 강도, 모델 묶음 이름은 spawn_agent 인자가 아니라고 함께 알려요. 묶음 이름을 model로 넘기면 하위 에이전트가 첫 요청에서 실패했어요.",
    from: "Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.",
    to: `Do not spawn sub-agents unless the user, applicable AGENTS.md/skill instructions or the delegation mode in the \`own.preset\` context explicitly ask for sub-agents, delegation, or parallel agent work. ${PRESET}`,
  },
  {
    id: "folder",
    title: "하위 에이전트의 작업 폴더",
    why: "Codex의 하위 에이전트는 따로 떼어 낸 작업 공간에서 고치지만, 이 앱의 하위 에이전트는 같은 폴더의 같은 파일을 고쳐요.",
    from: "- When delegating coding work, instruct the submodel to edit files directly in its forked workspace and list the file paths it changed in the final answer.",
    to: "- When delegating coding work, tell the sub-agent which files it may change and to list the file paths it changed in its final answer. Sub-agents work in your working directory, not in a copy.",
  },
  {
    id: "review",
    title: "하위 에이전트의 결과 검토",
    why: "이 앱에는 올려 보낸 변경이 따로 없어서, 하위 에이전트가 고친 파일을 보라고 알려요.",
    from: "- When a delegated coding task returns, quickly review the uploaded changes, then integrate or refine them.",
    to: "- When a delegated coding task returns, quickly review the files it changed, then integrate or refine them.",
  },
]

export const SPAWN_AGENT_LEAN = `Start a sub-agent on a well-scoped task. It works in the background in your working directory, on the same files rather than a copy, and you get its id and nickname back. When it finishes, its final message reaches you in a \`<subagent_notification>\`; \`wait_agent\` waits for it.

Spawn sub-agents only when the user, an AGENTS.md file, a skill or the delegation mode in the \`own.preset\` context asks for sub-agents, delegation or parallel work. Asking for depth or thoroughness is not such a request. ${PRESET}

Give each sub-agent a self-contained task: the context it needs, the files it may change, and the result you want back. Keep the step you need next yourself and do other work while sub-agents run. Agents that edit in parallel need disjoint files.

\`model\`: omit it to run on your model. Set it only when the user asks for another model; it is only ever a model id of your provider, written like the \`Model ID\` under \`# Your Model\`.`

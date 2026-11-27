// Builds a dsh session's request from core's (13 §2): dsh's system prompt (prompt.ts) in place of core's system parts,
// dsh's tools under dsh's names in place of core's file and shell tools, every tool in dsh's code-unit name order
// (system-prompt `orderTools` without a configured order), and the history in dsh's tool names with own's checkpoints
// rendered (common compaction, 11). Around the history go the messages dsh adds: after the first user message the
// workspace instructions, the runtime context and the skill catalog; at every step a time reading when 10 minutes have
// passed since the last; after a step's tool results the repeat-call reminders; and a new runtime-context snapshot
// where the snapshot changed. Core's instruction baseline supplies AGENTS.md and config `instructions`, the skills and
// own's guidance; core's date, environment and `# Your Model` blocks go (dsh has none). A pure function of the request
// and the stored session state, so the same history gives the same bytes (02 §4.3 D1).
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshRequest from "./request.js"

import path from "node:path"
import { Message, SystemPart } from "@opencode/ai/effect"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { Baseline } from "../codex/baseline.js"
import { CodexCompaction } from "../codex/compaction.js"
import { History } from "../history.js"
import { PiVariant } from "../pi/variant.js"
import { Registry } from "../registry.js"
import { DshContext } from "./context.js"
import { DshPrompt } from "./prompt.js"
import { DshReminder } from "./reminder.js"
import { DshTools } from "./tools.js"
import { DshVariant } from "./variant.js"

/** Core tools dsh's own replace: its file, search and shell tools. Other tools stay as they are. */
export const REPLACED = ["shell", "patch", "edit", "write", "read", "glob", "grep"]

export interface Draft {
  system: Array<SystemPart>
  messages: Array<Message>
  tools?: Record<string, { description: string; input: unknown }>
}

/** What core's history says about a message (hooks.ts reads it from the session): its kind and its times. */
export interface Fact {
  /** `user` for the user's own messages, which start a turn. */
  readonly kind: "user" | "assistant" | "other"
  readonly created: number
  /** For an assistant message: when its step settled (its tools finished), else when it was made. */
  readonly settled?: number
}

/** A runtime-context snapshot placed after the message `after` (plugin storage keeps them, hooks.ts). */
export interface Snapshot {
  readonly after: string
  readonly text: string
}

export interface Session {
  /** The Location's directory: dsh's session working directory. */
  readonly cwd: string
  /** Core's checkpoint metadata by message id (`CodexCompaction.checkpoints`); absent renders checkpoints as core wrote them. */
  readonly checkpoints?: CodexCompaction.Checkpoints
  /** `cwd` resolved as core resolves the folders it walks for AGENTS.md (Baseline.sources); `cwd` when absent. */
  readonly realCwd?: string
  readonly model: { readonly id: string; readonly providerID: string }
  /** The provider speaks OpenAI Responses: the prompt goes as the leading developer message there. */
  readonly responses: boolean
  /** A config agent's own system prompt, which takes the persona's place (a dsh agent preset's persona row). */
  readonly agentInstructions?: string
  /** own's skills for the skills the baseline lists; `name` is what own's `skill` tool takes. */
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description?: string }>
  readonly prompt?: OwnHarness.PromptID
  /** The user's persona line (내 지시문, 10 §3.11) under `custom`; without it `custom` runs `own`. */
  readonly custom?: string
  readonly mode: DshContext.Mode
  /** The service's time zone, which dsh's time readings use when no browser zone is reported. */
  readonly timeZone: string
  /** The user's home folder, shown as `~` in the global AGENTS.md path. */
  readonly home?: string
  readonly facts?: ReadonlyMap<string, Fact>
  /** Snapshots placed by earlier requests, oldest first. */
  readonly snapshots?: ReadonlyArray<Snapshot>
}

export function build(draft: Draft, session: Session) {
  const texts = draft.system.map((part) => part.text)
  const at = texts.findIndex(Baseline.isBaseline)
  const baseline = at < 0 ? undefined : Baseline.parse(texts[at]!)
  const revised = DshVariant.revised(session.prompt)
  // Core's system: [agent prompt, `# Your Model` identity, baseline, parts plugins appended].
  const appended = texts.filter((text, index) => index !== 0 && index !== at && !IDENTITY.test(text))
  const codemode =
    revised && baseline?.codemode !== undefined ? PiVariant.codemode(baseline.codemode) : baseline?.codemode
  const tools = draft.tools === undefined ? undefined : dshTools(draft.tools, revised)
  const names = Object.keys(tools ?? {}).filter((name) => DshTools.INTERNAL[name] !== undefined)
  const sections = DshPrompt.sections({
    model: session.model.id,
    provider: session.model.providerID,
    tools: names,
    persona: session.agentInstructions ?? (session.prompt === "custom" ? session.custom : undefined),
    mcp: baseline?.mcp,
    sdk: [codemode, baseline?.references].filter((text) => text !== undefined),
    context: [
      ...(baseline?.rest ?? []),
      ...(baseline?.contexts ?? []).map((entry) => `<context key="${entry.key}">\n${entry.value}\n</context>`),
      ...appended,
    ],
  })
  const prompt = DshPrompt.render(sections)
  const history = History.translate(draft.messages, Registry.dsh).flatMap((entry) =>
    CodexCompaction.render(entry, session.checkpoints),
  )
  const context = contexts(session, baseline)
  const placed = inject(history, session, context)
  draft.system = session.responses || prompt.length === 0 ? [] : [SystemPart.make(prompt)]
  draft.messages =
    session.responses && prompt.length > 0
      ? [Message.make({ role: "system", content: prompt }), ...placed.messages]
      : placed.messages
  if (tools !== undefined) draft.tools = tools
  return { history, prompt, sections, context, recorded: placed.recorded }
}

/** The texts of the messages dsh adds after the first user message, for this session. */
export function contexts(session: Session, baseline: Baseline.Parsed | undefined) {
  const root = baseline?.environment?.workspaceRoot ?? session.cwd
  const files = Baseline.sources(baseline?.instructions ?? [], session.realCwd ?? session.cwd)
  // dsh reads the user-global file first, then the project's from its root down, broadest to most specific. dsh has no
  // other instruction files, so config `instructions` (files and URLs) join the same frame between the two: like the
  // global file they come from config, not from a folder on the way to the working directory, so they are broader
  // than every project AGENTS.md. dsh's budget drops the broadest first and cuts the most specific last, so a large
  // configured entry goes before any project file and the working directory's own AGENTS.md is kept longest.
  const ordered = [...files.global, ...files.configured, ...files.project]
  return {
    instructions: DshContext.instructions(
      ordered.map((file) => ({ displayPath: display(file.path, root, session.home), content: file.content })),
    ),
    runtime: DshContext.snapshot([
      DshContext.workingDirectory(session.cwd),
      ...(DshVariant.revised(session.prompt)
        ? DshVariant.policy(session.mode)
        : DshContext.policy(session.mode, session.cwd)),
    ]),
    skills: DshContext.skills(
      session.skills.map((skill) => ({ name: skill.name, description: skill.description ?? "" })),
    ),
  }
}

/**
 * dsh's tools first under dsh's names (the same definition objects, so core runs the registered tool), in dsh's
 * code-unit name order, then own's other tools in core's order. Sorted in among dsh's, Code Mode's `execute` came
 * second, and every model in the live runs called it once for nothing (own/reports/harness-live-2026-10-19.md).
 */
function dshTools(current: NonNullable<Draft["tools"]>, revised: boolean) {
  const internal = new Map(Object.entries(DshTools.INTERNAL).map(([name, id]) => [id, name] as const))
  const named = Object.entries(current).flatMap(([name, entry]) => {
    const dsh = internal.get(name)
    return dsh === undefined ? [] : [[dsh, entry] as const]
  })
  const rest = Object.entries(current).filter(([name]) => !internal.has(name) && !REPLACED.includes(name))
  const entries = [...named.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), ...rest]
  // own's revision drops the sandbox sentence; the definition object stays the one core registered (it maps calls back by
  // identity), and core builds it for each request, so changing it touches nothing else.
  if (revised)
    entries
      .filter(([name]) => name === "pwsh" || name === "bash")
      .forEach(([, entry]) => {
        entry.description = DshVariant.shellDescription(entry.description)
      })
  return Object.fromEntries(entries)
}

/**
 * The history with dsh's added messages in place. A block goes at a step start: before an assistant message, or at the
 * end when the history ends in the user's message or tool results. Returns the snapshot to keep when this request
 * placed a new one.
 */
function inject(history: ReadonlyArray<Message>, session: Session, context: ReturnType<typeof contexts>) {
  const facts = session.facts ?? new Map<string, Fact>()
  const isUser = (message: Message) => message.id !== undefined && facts.get(message.id)?.kind === "user"
  const reminders = DshReminder.reminders(history, isUser)
  const first = history.findIndex((message) => message.role === "user" && message.id !== undefined)
  const ids = new Set(history.flatMap((message) => (message.id === undefined ? [] : [message.id])))
  const visible = (session.snapshots ?? []).filter((snapshot) => ids.has(snapshot.after))
  const latest = visible.at(-1)
  const last = history.findLast((message) => message.id !== undefined)
  const recorded =
    context.runtime.length === 0 || first < 0
      ? undefined
      : latest === undefined
        ? { after: history[first]!.id!, text: context.runtime }
        : latest.text !== context.runtime && last?.id !== undefined
          ? { after: last.id, text: context.runtime }
          : undefined
  const pending = [...visible, ...(recorded === undefined ? [] : [recorded])].map((snapshot) => ({
    snapshot,
    anchor: history.findIndex((message) => message.id === snapshot.after),
  }))
  const state = {
    turn: 0,
    step: 0,
    lastInjection: undefined as number | undefined,
    lastTurnInjection: undefined as number | undefined,
    /** The newest model-visible time so far, and the one before the current turn's user message. */
    lastVisible: undefined as number | undefined,
    beforeTurn: undefined as number | undefined,
    reminders: [] as Array<string>,
    opened: false,
    placed: 0,
  }
  const user = (text: string) => Message.make({ role: "user", content: text })
  /** dsh's time reading at the step that starts before `index`, or undefined within 10 minutes of the last. */
  const reading = (index: number) => {
    const owner = history.slice(0, index).findLast((message) => message.role !== "tool")
    const fact = owner?.id === undefined ? undefined : facts.get(owner.id)
    const now = owner?.role === "assistant" ? (fact?.settled ?? fact?.created) : fact?.created
    if (now === undefined) return undefined
    const step = state.step + 1
    if (
      state.lastInjection !== undefined &&
      now >= state.lastInjection &&
      now - state.lastInjection < DshContext.TIME_REFRESH_MS
    )
      return undefined
    const previous = step === 1 ? state.beforeTurn : state.lastTurnInjection
    state.lastInjection = now
    state.lastTurnInjection = now
    return DshContext.time({
      now,
      turn: Math.max(1, state.turn),
      step,
      ...(previous === undefined ? {} : { previous }),
      timeZone: session.timeZone,
      ...(DshVariant.revised(session.prompt) ? { zone: DshVariant.zone(session.timeZone) } : {}),
    })
  }
  /** The messages dsh adds when the step before `index` starts: the opening block, new snapshots, the time reading. */
  const block = (index: number) => {
    const opening = !state.opened && first >= 0 && index > first
    if (opening) state.opened = true
    const due = pending.filter((entry) => entry.anchor >= 0 && entry.anchor < index).slice(state.placed)
    state.placed += due.length
    const time = reading(index)
    return [
      ...(opening && context.instructions.length > 0 ? [context.instructions] : []),
      ...due.map((entry) => entry.snapshot.text),
      ...(opening && context.skills.length > 0 ? [context.skills] : []),
      ...(time === undefined ? [] : [time]),
    ].map(user)
  }
  const output = history.flatMap((message, index) => {
    const before =
      message.role === "assistant" && index > 0 && history[index - 1]?.role !== "assistant" ? block(index) : []
    if (isUser(message)) {
      state.turn += 1
      state.step = 0
      state.lastTurnInjection = undefined
      state.beforeTurn = state.lastVisible
    }
    if (message.role === "assistant") state.step += 1
    const fact = message.id === undefined ? undefined : facts.get(message.id)
    if (fact !== undefined) state.lastVisible = fact.settled ?? fact.created
    state.reminders.push(...(reminders.get(index) ?? []))
    // A step's reminders go right after its tool results (dsh's `additionalContexts` on the result batch).
    const after = history[index + 1]?.role === "tool" ? [] : state.reminders.splice(0).map(user)
    return [...before, message, ...after]
  })
  const tail = history.at(-1)
  return {
    messages: tail !== undefined && tail.role !== "assistant" ? [...output, ...block(history.length)] : output,
    recorded,
  }
}

/** Core's `# Your Model` block (core/src/plugin/identity.ts). */
const IDENTITY = /^# Your Model\n- Name: .*\n- Provider ID: .*\n- Model ID: .*$/

/** dsh's display of an instruction file: project-relative, or under `~`; a configured URL as it is. */
function display(file: string, root: string, home: string | undefined) {
  if (!path.isAbsolute(file)) return file
  const relative = path.relative(root, file)
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative
  if (home === undefined) return file
  const fromHome = path.relative(home, file)
  if (fromHome.startsWith("..") || path.isAbsolute(fromHome)) return file
  return `~/${fromHome.split(path.sep).join("/")}`
}

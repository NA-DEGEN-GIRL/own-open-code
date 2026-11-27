export * as Authored from "./authored.js"

import fs from "node:fs/promises"
import path from "node:path"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { CommandEditor } from "@opencode/plugin/effect/command"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SkillEditor } from "@opencode/plugin/effect/skill"
import { Agent } from "@opencode/schema/agent"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Fsx } from "@own/runtime"
import { Effect, Exit, Schema, Scope, Semaphore, Stream } from "effect"
import { Match } from "./match.js"
import type { CreatorState } from "./state.js"
import CODE_SKILL from "./text/skill-code.md" with { type: "text" }
import EXTENSIONS_SKILL from "./text/skill-extensions.md" with { type: "text" }
import MARKDOWN_SKILL from "./text/skill-markdown.md" with { type: "text" }

/**
 * Creator mode (17 §6) and the C0 items of the extensions in force: agents, slash commands and skills, registered
 * through core's transforms (so they follow an extension's project folders and versions), never written into the
 * config folder.
 *
 * Creator mode is the primary agent `creator`. Its tools carry the permission action {@link GATE} and its two skills
 * the ids `own-creator-*`; every other agent denies both with resource `*`, so neither the tools nor the skills are
 * listed anywhere else and no other session's request changes. The agent transform is registered again after every
 * `plugin.updated` of this Location, so it runs after the config plugins core applies after the configured ones
 * (own-harness `Gate`'s pattern) and reaches config agents too.
 */

export const AGENT = "creator"
export const GATE = "own_creator"
export const SKILL_PREFIX = "own-creator-"

const DENY = [
  { action: GATE, resource: "*", effect: "deny" as const },
  { action: "skill", resource: `${SKILL_PREFIX}*`, effect: "deny" as const },
]
const ALLOW = [
  { action: GATE, resource: "*", effect: "allow" as const },
  { action: "skill", resource: `${SKILL_PREFIX}*`, effect: "allow" as const },
]

const BUILTIN = [
  {
    id: `${SKILL_PREFIX}extensions`,
    description:
      "Use in creator mode to write an own extension: the own.ext/1 format, every item type with a template, the cache and safety rules.",
    content: EXTENSIONS_SKILL,
  },
  {
    id: `${SKILL_PREFIX}markdown`,
    description:
      "Use in creator mode to add an agent, a slash command, a skill or a harness's 내 지시문 as an own extension.",
    content: MARKDOWN_SKILL,
  },
  {
    id: `${SKILL_PREFIX}code`,
    description:
      "Use in creator mode when a tool needs real code (a generated MCP server) or a request or compaction hook needs a code plugin: the formats, own's helpers, the checks and the rules.",
    content: CODE_SKILL,
  },
] as const

type Ctx = Pick<Context, "agent" | "skill" | "command" | "session" | "event" | "location">

const decodeAgentExtras = Schema.decodeUnknownSync(
  Schema.Struct({ model: Agent.Info.fields.model, steps: Agent.Info.fields.steps }),
)

/**
 * `creator`: creator mode exists here (this PC). An SSH host's mirror (17 §10) registers only the extensions' agents,
 * commands and skills: no creator agent and no creator skills, since only the PC makes extensions.
 */
export const register = (ctx: Ctx, state: CreatorState.State, creator = true) =>
  Effect.gen(function* () {
    const skills = creator ? yield* Effect.promise(() => materialize(state.store.root)) : []
    yield* last(ctx, () => ctx.agent.transform((editor) => agents(editor, state, creator)))
    yield* ctx.skill.transform((editor) => skillsOf(editor, state, skills))
    yield* ctx.command.transform((editor) => commands(editor, state, ctx))
  })

function agents(editor: AgentEditor, state: CreatorState.State, creator: boolean) {
  Match.items(state.list, "agent")
    .filter((entry) => editor.get(entry.item.name) === undefined)
    .forEach((entry) =>
      editor.update(entry.item.name, (agent) => {
        const extras = decodeAgentExtras({
          ...(entry.item.model === undefined ? {} : { model: modelRef(entry.item.model) }),
          ...(entry.item.steps === undefined ? {} : { steps: entry.item.steps }),
        })
        agent.name = Agent.Name.make(entry.item.name)
        agent.description = entry.item.description
        agent.mode = entry.item.mode
        agent.system = entry.item.prompt
        agent.hidden = entry.item.hidden ?? false
        if (extras.model !== undefined) agent.model = { ...extras.model }
        if (extras.steps !== undefined) agent.steps = extras.steps
      }),
    )
  editor.list().forEach((agent) => editor.update(agent.id, (item) => void item.permissions.push(...DENY)))
  if (!creator) return
  editor.update(AGENT, (agent) => {
    agent.name = Agent.Name.make(AGENT)
    agent.description = "확장 만들기: own에 지시문, 도구, 규칙, 에이전트, 명령, 스킬을 더하고 고쳐요 (creator mode)"
    agent.mode = "primary"
    agent.permissions.push(...ALLOW)
  })
}

function skillsOf(editor: SkillEditor, state: CreatorState.State, builtin: ReadonlyArray<Skill.Info>) {
  builtin.forEach((skill) => editor.add(skill))
  Match.items(state.list, "skill")
    .filter((entry) => editor.get(entry.item.name) === undefined)
    .forEach((entry) =>
      editor.add({
        id: Skill.ID.make(entry.item.name),
        name: Skill.Name.make(entry.item.name),
        description: entry.item.description,
        path: AbsolutePath.make(path.join(entry.owner.loaded.dir, "skills", entry.item.name, "SKILL.md")),
        content: entry.item.content,
      }),
    )
}

function commands(editor: CommandEditor, state: CreatorState.State, ctx: Pick<Context, "session">) {
  Match.items(state.list, "command").forEach((entry) =>
    editor.add({
      name: entry.item.name,
      ...(entry.item.description === undefined ? {} : { description: entry.item.description }),
      execute: (input) =>
        ctx.session
          .prompt({
            ...input.prompt,
            sessionID: input.sessionID,
            text: expand(entry.item.template, input.prompt.text),
            delivery: input.delivery,
          })
          .pipe(Effect.asVoid),
    }),
  )
}

/** A command's template with `$ARGUMENTS` and `$1`…`$9` filled, as core fills a markdown command (no shell runs). */
export function expand(template: string, input: string) {
  const words = (input.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ""))
  const positions = [...template.matchAll(/\$([1-9])/g)].map((match) => Number(match[1]))
  const last = Math.max(0, ...positions)
  const filled = template.replaceAll(/\$(?:ARGUMENTS|([1-9]))/g, (match, index: string | undefined) => {
    if (match === "$ARGUMENTS") return input
    const position = Number(index)
    if (position > words.length) return ""
    if (position === last) return words.slice(position - 1).join(" ")
    return words[position - 1]!
  })
  if (positions.length === 0 && !template.includes("$ARGUMENTS") && input.trim() !== "")
    return `${filled}\n\n${input}`.trim()
  return filled.trim()
}

function modelRef(text: string) {
  const at = text.indexOf("/")
  return { providerID: text.slice(0, at), id: text.slice(at + 1) }
}

/**
 * Creator mode's skills as files under `creator\skills\<id>\SKILL.md`, which a harness that lists skill paths (Codex's)
 * may open; written again only when their text changed.
 */
async function materialize(root: string): Promise<ReadonlyArray<Skill.Info>> {
  return Promise.all(
    BUILTIN.map(async (skill) => {
      const file = path.join(root, "skills", skill.id, "SKILL.md")
      const text = `---\nname: ${skill.id}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}`
      const current = await Fsx.readText(file).catch(() => undefined)
      if (current !== text) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Fsx.writeAtomic(file, text)
      }
      return {
        id: Skill.ID.make(skill.id),
        name: Skill.Name.make(skill.id),
        description: skill.description,
        path: AbsolutePath.make(file),
        content: skill.content,
      }
    }),
  )
}

/** Registers `transform` now and again after every `plugin.updated` of this Location, keeping one registration. */
function last(ctx: Pick<Context, "event" | "location">, transform: () => Effect.Effect<unknown, never, Scope.Scope>) {
  return Effect.gen(function* () {
    const plugin = yield* Effect.scope
    const lock = yield* Semaphore.make(1)
    const current: { scope?: Scope.Closeable } = {}
    const move = lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = current.scope
        const next = yield* Scope.fork(plugin)
        yield* transform().pipe(Scope.provide(next))
        current.scope = next
        if (previous !== undefined) yield* Scope.close(previous, Exit.void)
      }),
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "plugin.updated" && event.location?.directory === ctx.location.directory),
      Stream.runForEach(() => move),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* move
  })
}

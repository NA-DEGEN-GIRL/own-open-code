export * as Agents from "./agents.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import { Effect } from "effect"
import { OwnGitHub } from "@own/protocol"
import { OmoConfig } from "../config.js"
import type { AgentInfo } from "./client.js"
import { Names } from "./names.js"

/**
 * own-harness's tool gates of the other harnesses (own-harness `gate.ts`): an agent added after its transform ran must
 * deny them itself, or a child omo starts would list Codex's, Pi's or dsh's tools.
 */
const OTHER_GATES = ["own_harness_codex", "own_harness_pi", "own_harness_dsh"]

/** An omo agent as OpenCode 2 registers it (15 §4.5). */
export interface Registered {
  /** OpenCode 2 id: `omo-<config key>`. */
  readonly id: string
  readonly key: string
  /** omo's display name, the name omo prompts it by. */
  readonly display: string
  readonly system: string
  readonly description?: string
  readonly color?: string
  readonly steps?: number
  /** OpenCode 1 tools omo turns off for it (`getAgentToolRestrictions`). */
  readonly restrictions: Readonly<Record<string, boolean>>
}

/**
 * The agents to register from omo's config result (`config.agent`, keyed by display name): the subagents of
 * {@link OmoConfig.AGENTS}, not their hidden config-key aliases. Sisyphus is not registered: core `build` runs as it.
 */
export function translate(
  agents: Readonly<Record<string, unknown>>,
  runtime: {
    readonly keyOf: (name: string) => string
    readonly restrictions: (name: string) => Record<string, boolean>
  },
): Array<Registered> {
  return Object.entries(agents).flatMap(([display, value]): Array<Registered> => {
    if (!isRecord(value) || value.hidden === true || typeof value.prompt !== "string") return []
    const key = runtime.keyOf(display)
    if (!(OmoConfig.AGENTS as ReadonlyArray<string>).includes(key)) return []
    return [
      {
        id: `${Names.AGENT_PREFIX}${key}`,
        key,
        display,
        system: value.prompt,
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        ...(typeof value.color === "string" ? { color: value.color } : {}),
        ...(typeof value.steps === "number" && value.steps > 0 ? { steps: Math.floor(value.steps) } : {}),
        restrictions: runtime.restrictions(key),
      },
    ]
  })
}

/**
 * An agent's OpenCode 2 rules: the default, the other harnesses' gates, no edits when omo turns writing off, and a
 * GitHub write asks (own.accounts' rule, 16 §5.4: these rules replace an agent's whole list after own.accounts' agent
 * transform ran, GH-13).
 */
export function permissions(agent: Pick<Registered, "id" | "restrictions">): Array<Permission.Rule> {
  const readOnly = agent.restrictions.write === false || agent.restrictions.edit === false
  return [
    ...Agent.Info.default(Agent.ID.make(agent.id)).permissions,
    ...OTHER_GATES.map((action): Permission.Rule => ({ action, resource: "*", effect: "deny" })),
    ...(readOnly ? [{ action: "edit", resource: "*", effect: "deny" } satisfies Permission.Rule] : []),
    { action: OwnGitHub.WRITE_ACTION, resource: "*", effect: "ask" },
  ]
}

/** Registers the agents (hidden subagents), once per runtime start, in the plugin's scope. */
export const register = (ctx: Pick<Context, "agent">, agents: ReadonlyArray<Registered>) =>
  Effect.gen(function* () {
    yield* ctx.agent.transform((editor) =>
      agents.forEach((agent) =>
        editor.update(agent.id, (info) => {
          info.name = Agent.Name.make(agent.display)
          info.system = agent.system
          if (agent.description !== undefined) info.description = agent.description
          if (agent.color !== undefined) info.color = agent.color
          if (agent.steps !== undefined) info.steps = agent.steps
          info.mode = "subagent"
          info.hidden = true
          info.permissions = permissions(agent)
        }),
      ),
    )
    yield* ctx.agent.reload()
  })

/**
 * `client.app.agents()` (15 §4.5): the agents of omo's config result as OpenCode 1 listed them (visible, so omo's task
 * tool can call them), then OpenCode 2's other agents under their OpenCode 1 names.
 */
export function list(
  config: Readonly<Record<string, unknown>>,
  core: ReadonlyArray<Agent.Info>,
  names: Names.Agents,
): Array<AgentInfo> {
  const omo = Object.entries(config).flatMap(([name, value]): Array<AgentInfo> => {
    if (!isRecord(value)) return []
    const mode = value.mode === "primary" || value.mode === "all" ? value.mode : "subagent"
    return [
      {
        name,
        mode,
        ...(value.hidden === true ? { hidden: true } : {}),
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        ...(typeof value.model === "string" ? { model: value.model } : {}),
      },
    ]
  })
  const known = new Set(omo.map((agent) => agent.name.toLowerCase()))
  const others = core.flatMap((agent): Array<AgentInfo> => {
    if (agent.id.startsWith(Names.AGENT_PREFIX)) return []
    const name = names.toV1(agent.id)
    if (known.has(name.toLowerCase())) return []
    return [
      {
        name,
        mode: agent.mode,
        ...(agent.hidden ? { hidden: true } : {}),
        ...(agent.description === undefined ? {} : { description: agent.description }),
      },
    ]
  })
  return [...omo, ...others]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

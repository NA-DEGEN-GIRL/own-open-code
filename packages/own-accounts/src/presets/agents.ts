export * as Agents from "./agents.js"

import { Option, Schema } from "effect"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import { optional } from "@opencode/schema/schema"
import { Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import type { Module } from "../module.js"
import { Access } from "./access.js"

/** A hidden agent's configured model that was removed (07 §5.4 "내장 에이전트의 모델"). */
export interface Removal {
  readonly agent: string
  readonly model: Model.Ref
}

/**
 * The agent fields the check reads. The editor hands out deep-mutable records whose branded ids the type system no
 * longer sees as strings; decoding gives typed values (and a copy of the model).
 */
const decodeAgent = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.String, hidden: Schema.Boolean, mode: Schema.String, model: optional(Model.Ref) }),
)

/** An own role agent (07 §2.4): its fixed name and description, and the rules added to core's defaults. */
interface RoleAgent {
  readonly name: string
  readonly description: string
  readonly permissions: ReadonlyArray<Permission.Rule>
}

/** Like core's `general`: no questions to the user, no nested subagents (depth 1, 07 §2.8). */
const SUBAGENT: ReadonlyArray<Permission.Rule> = [
  { action: "question", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
]

/** The read-only roles ask before a web request (`Preset.ROLE_WEB_ASK`, decisions MR10-3, MR11). */
const WEB_ASK: ReadonlyArray<Permission.Rule> = Preset.ROLE_WEB_ASK.map((rule) => ({ ...rule }))

/**
 * The own role agents (07 §2.4): `own-review` (read-only review; the `evaluate` hook of `ReadOnly` keeps its edits
 * denied against a parent's session rules), `own-quick` and `own-deep` (`general`'s rights). No `system`: one would
 * turn off core's GPT and Claude prompts (`packages/core/src/plugin/optimize.ts`). No model: the gate maps each role
 * to its target per call.
 */
export const ROLE_AGENTS: Readonly<Record<"own-review" | "own-quick" | "own-deep", RoleAgent>> = {
  "own-review": {
    name: "Review",
    description:
      "Read-only reviewer for an independent second look at code, plans or results. Reports findings; does not edit files.",
    permissions: [...SUBAGENT, { action: "edit", resource: "*", effect: "deny" }, ...WEB_ASK],
  },
  "own-quick": {
    name: "Quick",
    description: "Quick, simple tasks: small lookups, mechanical edits and short checks.",
    permissions: SUBAGENT,
  },
  "own-deep": {
    name: "Deep",
    description: "Hard problems that need deeper reasoning.",
    permissions: SUBAGENT,
  },
}

export interface Api extends Module.Lifecycle {
  /**
   * The fold of the setup registration (`hooks.ts`): defines the own role agents, then checks hidden agents' models.
   * No I/O: it reads the slot registry in memory.
   */
  transform(editor: AgentEditor): void
  /**
   * What the latest folds removed in every live own-accounts instance of this process
   * (`diagnostics.selfTest.agentModels`): a project config's `agents.<id>.model` is folded only in that project's
   * Location, while selfTest answers in the control location.
   */
  removed(): ReadonlyArray<Removal>
  /** The fold's inputs may have changed (the Claude slot's detection): folds again when a judgement differs. */
  recheck(): void
}

/**
 * Hidden agents (title, compaction, summary) run outside the subagent tool, in every session, on their configured
 * model (`agents.title.model`, formerly `small_model`). That setting is global, so it cannot be judged per session:
 * when it names an own subscription slot (another ChatGPT account, the Claude slot) the transform removes it, the agent
 * runs on the session's account, and `internal_agent_model_removed{agent, model}` is raised once per agent and model.
 * Metered and local models are the user's explicit choice and stay. Subagent-mode agents are left to the gate.
 *
 * Core applies the config's agents in a builtin plugin that activates after every configured plugin (`post`,
 * `packages/core/src/plugin/internal.ts`), so a transform registered in setup never sees `agents.<id>.model`
 * (verified on a source-booted server). A second registration made after this Location's plugins activated
 * (`plugin.updated`) runs after it; it is made again after every activation so it stays last.
 *
 * Core folds agents only when a registration changes or on `ctx.agent.reload()`, while the judgement also depends on
 * the Claude slot's detection and the registry's accounts. Each fold records how it judged every provider it saw; a
 * provider reload of this Location (accounts added or removed) and a changed Claude slot (`plugins` `setSlot`) compare
 * that with the current answer and reload the agents when it differs.
 *
 * The setup fold also defines the own role agents ({@link ROLE_AGENTS}, 07 §2.4): `mode:"subagent"`, `hidden`, a
 * fixed description, no `system`, no model. They are defined in setup and never only in the late registration, so the
 * transforms of later plugins (own.computer-use's agent-wide `computer` deny) reach them like any other agent. Hidden
 * agents stay out of the subagent tool's `Available subagents` list (`packages/core/src/tool/plugin/subagent.ts`), so
 * the tool description's bytes do not change; they can still be called by id. An agent an earlier registration
 * already defined under one of these ids is left as it is.
 */
export function create(deps: Deps, peers: Module.Peers, access: Access.Api): Api {
  const log = deps.log.child("presets.agents")
  const hook = Hooks.guard(deps.log.child("hooks"))
  const state = {
    removed: new Map<"setup" | "late", ReadonlyArray<Removal>>(),
    /** Each provider a hidden agent's model named in a fold, and whether it counted as a subscription slot then. */
    judged: new Map<string, boolean>(),
    alerted: new Set<string>(),
    late: undefined as Registration | undefined,
    moving: Promise.resolve(),
    stops: [] as Array<() => void>,
  }

  const fold = (name: "setup" | "late", editor: AgentEditor) => {
    const removed = editor.list().flatMap((item): Removal[] => {
      const agent = Option.getOrUndefined(decodeAgent(item))
      const model = agent?.model
      if (!agent?.hidden || agent.mode === "subagent" || !model) return []
      const subscription = access.subscription(model.providerID)
      state.judged.set(model.providerID, subscription)
      if (!subscription) return []
      editor.update(agent.id, (entry) => {
        delete entry.model
      })
      return [{ agent: agent.id, model }]
    })
    state.removed.set(name, removed)
    const fresh = removed.filter((removal) => !state.alerted.has(key(removal)))
    if (fresh.length === 0) return
    fresh.forEach((removal) => state.alerted.add(key(removal)))
    // Alerts write the ledger and emit an RPC event: after the fold, never inside it (02 §4.1).
    deps.clock.schedule(0, () => fresh.forEach(alert))
  }

  const alert = (removal: Removal) => {
    const model = Access.text(removal.model)
    log.warn("internal_agent_model_removed", { agent: removal.agent, model })
    peers().telemetry.alert({
      code: "internal_agent_model_removed",
      severity: "warning",
      subject: key(removal),
      message: `내장 에이전트 ${removal.agent}의 모델 ${model}은(는) own 구독 계정이라 지웠습니다. 이 에이전트는 세션의 계정으로 실행됩니다.`,
    })
  }

  /** Registration work runs one at a time, in order. */
  const serial = (failure: string, work: () => Promise<void>) => {
    state.moving = state.moving.then(work).catch((error: unknown) => log.error(failure, { error }))
  }

  /** Registers the late transform again (now last) and drops the previous one. */
  const relocate = async () => {
    const previous = state.late
    state.late = await deps.ctx.agent.transform((editor) =>
      hook.sync("agent.transform:late", () => fold("late", editor)),
    )
    await previous?.dispose()
  }

  const recheck = () => {
    const changed = [...state.judged].filter(([providerID, was]) => access.subscription(providerID) !== was)
    if (changed.length === 0) return
    // Recorded now, so a second check before the reload's fold does not ask again.
    changed.forEach(([providerID, was]) => state.judged.set(providerID, !was))
    serial("agent_reload_failed", () => deps.ctx.agent.reload())
  }

  const local = () => [...state.removed.values()].flat()

  return {
    transform: (editor) => {
      define(editor)
      tightenExplore(editor)
      fold("setup", editor)
    },
    removed: () => {
      const all = new Map(local().map((removal) => [key(removal), removal]))
      deps.runtime.broadcast.emit("agents.removed.query", {
        reply: (removed) => removed.forEach((removal) => all.set(key(removal), removal)),
      })
      return [...all.values()]
    },
    recheck,
    start: async () => {
      state.stops.push(deps.runtime.broadcast.on("agents.removed.query", (query) => query.reply(local())))
    },
    onEvent: (event, meta) => {
      if (!meta.local) return
      if (event.type === "plugin.updated") serial("agent_transform_register_failed", relocate)
      if (event.type === "provider.updated") recheck()
    },
    stop: async () => {
      for (const stop of state.stops.splice(0)) stop()
      await state.moving
      await state.late?.dispose().catch((error: unknown) => log.debug("agent_transform_dispose_failed", { error }))
      state.late = undefined
    },
  }
}

function key(removal: Removal) {
  return `${removal.agent}|${Access.text(removal.model)}`
}

/**
 * Upstream 7725ac81eb gave core's `explore` `{shell,*,allow}` and a prompt that asks for read-only commands; own keeps
 * explore without a shell (07 §2.4, `ReadOnly.DENIED`). The rule goes last, so core leaves the shell tool out of
 * explore's tools again (a tool whose last matching rule denies `*` is wholly disabled) instead of offering a tool
 * the `evaluate` hook refuses on every call. A parent's session `shell` rule (ask or full approval) still comes after
 * it and shows the tool, where the hook keeps refusing it as before. Core's explore allows `webfetch` and `websearch`;
 * as a read-only role it asks instead ({@link WEB_ASK}, after core's allows).
 */
function tightenExplore(editor: AgentEditor) {
  if (editor.get("explore") === undefined) return
  editor.update("explore", (agent) => {
    agent.permissions.push(
      { action: "shell", resource: "*", effect: "deny" },
      ...WEB_ASK.map((rule) => ({ ...rule })),
    )
  })
}

/** Adds the own role agents the fold does not have yet; core's `update` creates one with its default rules. */
function define(editor: AgentEditor) {
  Object.entries(ROLE_AGENTS)
    .filter(([id]) => editor.get(id) === undefined)
    .forEach(([id, role]) =>
      editor.update(id, (agent) => {
        agent.name = Agent.Name.make(role.name)
        agent.description = role.description
        agent.mode = "subagent"
        agent.hidden = true
        agent.permissions.push(...role.permissions)
      }),
    )
}

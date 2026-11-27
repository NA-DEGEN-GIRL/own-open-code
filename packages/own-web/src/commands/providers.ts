// `/` providers (03 §18.13, lazy chunk with the suggestion engine): server commands first (built-ins `/init`,
// `/review`, user commands, MCP prompts `server:prompt`, with their argument hint), then the client commands; after
// `/agent ` the primary agents, after `/skills ` the skills, after a server command with `[…]` its hint.
import { resetText } from "@/context-reset/strings"
import { sideText } from "@/side/strings"
import { storedLocale, type Locale } from "@/i18n"
import { OwnHarnessRouting } from "@own/protocol/rpc-harness-routing"
import { chordLabel, DEFAULT_KEYMAP } from "@/keyboard"
import type { SuggestContext, SuggestItem, SuggestProvider } from "@/mentions/types"
import type { CommandActions, CommandContext } from "./actions"
import {
  argumentHint,
  CLIENT_COMMANDS,
  clientCommand,
  RESET_ALIASES,
  SERVER_FIRST,
  serverCommands,
  type ClientCommand,
} from "./catalog"
import { runClientCommand } from "./run"
import type { CommandText } from "./strings"

/** Built-ins of the `opencode.command` plugin (core plugin/command.ts); every other name is a user command. */
const BUILTIN = new Set(["init", "review"])

export function createCommandProviders(input: {
  readonly text: CommandText
  readonly actions: CommandActions
  /** For the words of `/reset-context`, which live in its own chunk (03 §18.18). */
  readonly locale?: () => Locale
}): SuggestProvider[] {
  const text = input.text
  const clients = new WeakMap<SuggestItem, ClientCommand>()
  const agentIDs = new WeakMap<SuggestItem, string>()
  const skillIDs = new WeakMap<SuggestItem, { id: string; name: string }>()

  const server: SuggestProvider = {
    id: "server",
    trigger: "command",
    limit: 50,
    label: () => text("own.command.group.server"),
    prepare: (context) => sync(context),
    local: (context) =>
      (serverCommands(context.runtime, context.directory) ?? [])
        .filter((command) => {
          const client = clientCommand(command.name)
          return !client || SERVER_FIRST.has(client.id)
        })
        .toSorted((a, b) => Number(BUILTIN.has(b.name)) - Number(BUILTIN.has(a.name)))
        .map((command) => ({
          id: `server:${command.name}`,
          group: "server",
          label: `/${command.name}`,
          detail: describe(command.name, command.description, text, context),
          hint: hintFor(command.name, command.description),
          badge: command.name.includes(":")
            ? text("own.command.badge.mcp")
            : BUILTIN.has(command.name)
              ? undefined
              : text("own.command.badge.custom"),
          icon: "/",
        })),
    keys: (item) => [item.label.slice(1)],
    select: (item) => ({ text: `${item.label} ` }),
  }

  const client: SuggestProvider = {
    id: "client",
    trigger: "command",
    limit: CLIENT_COMMANDS.length,
    label: () => text("own.command.group.client"),
    local: (context) => {
      const known = serverCommands(context.runtime, context.directory)
      const revert = context.sessionID ? !!context.runtime.data.session.get(context.sessionID)?.revert : false
      return CLIENT_COMMANDS.filter((command) => {
        if (command.session && !context.sessionID) return false
        if (command.id === "redo" && !revert) return false
        // The server `/review` entry covers it (then opens the tab).
        if (SERVER_FIRST.has(command.id) && known?.some((item) => item.name === command.id)) return false
        return true
      }).map((command) => {
        const item: SuggestItem = {
          id: `client:${command.id}`,
          group: "client",
          label: `/${command.id}`,
          detail:
            command.description === "own.reset.command"
              ? resetText.text(input.locale?.() ?? "ko", command.description)
              : command.description === "own.side.command"
                ? sideText.text(input.locale?.() ?? "ko", command.description)
                : text(command.description),
          badge: command.shortcut ? chordLabel(DEFAULT_KEYMAP[command.shortcut].chords[0]) : undefined,
          icon: "›",
        }
        clients.set(item, command)
        return item
      })
    },
    keys: (item) => [item.label.slice(1), ...(clients.get(item)?.id === "reset-context" ? RESET_ALIASES : [])],
    select: (item, context) => {
      const command = clients.get(item)
      if (!command) return undefined
      if (command.arguments) return { text: `/${command.id} ` }
      return {
        text: "",
        run: () => void runClientCommand({ command, args: "" }, commandContext(context), input.actions),
      }
    },
  }

  const agents: SuggestProvider = {
    id: "agent-arguments",
    trigger: "argument",
    accepts: (command) => command === "agent",
    limit: 20,
    label: () => text("own.command.group.agents"),
    note: () => text("own.command.agentNote"),
    prepare: (context) => {
      if (context.directory) void context.runtime.data.location.agent.sync({ directory: context.directory }).catch(log)
    },
    local: (context) => {
      const current = context.sessionID ? context.runtime.data.session.get(context.sessionID)?.agent : undefined
      const list = context.directory
        ? (context.runtime.data.location.agent.list({ directory: context.directory }) ?? [])
        : []
      return list
        .filter((agent) => !agent.hidden && agent.mode !== "subagent")
        .map((agent) => {
          const item: SuggestItem = {
            id: `agent:${agent.id}`,
            group: "agent-arguments",
            label: agent.id,
            detail: agent.description ?? (agent.name !== agent.id ? agent.name : undefined),
            badge: agent.id === current ? text("own.command.agentCurrent") : undefined,
            icon: "◎",
          }
          agentIDs.set(item, agent.id)
          return item
        })
    },
    keys: (item) => [item.label],
    select: (item, context) => {
      const agent = agentIDs.get(item)
      if (!agent) return undefined
      return { text: "", run: () => input.actions.switchAgent(commandContext(context), agent) }
    },
  }

  const skills: SuggestProvider = {
    id: "skill-arguments",
    trigger: "argument",
    accepts: (command) => command === "skills",
    limit: 50,
    label: () => text("own.command.group.skills"),
    prepare: (context) => {
      if (context.directory) void context.runtime.data.location.skill.sync({ directory: context.directory }).catch(log)
    },
    local: (context) =>
      (context.directory ? (context.runtime.data.location.skill.list({ directory: context.directory }) ?? []) : []).map(
        (skill) => {
          const item: SuggestItem = {
            id: `skill:${skill.id}`,
            group: "skill-arguments",
            label: `@${skill.id}`,
            detail: skill.description ?? (skill.name !== skill.id ? skill.name : undefined),
            icon: "✦",
          }
          skillIDs.set(item, { id: skill.id, name: skill.name })
          return item
        },
      ),
    keys: (item) => [item.label.slice(1)],
    select: (item) => {
      const skill = skillIDs.get(item)
      return skill ? { text: "", chip: { kind: "skill", id: skill.id, name: skill.name } } : undefined
    },
  }

  // A server command with an argument hint: no list, the hint line only (Enter sends).
  const hint: SuggestProvider = {
    id: "argument-hint",
    trigger: "argument",
    accepts: (command, context) => !!hintOf(command, context),
    limit: 0,
    label: (trigger) => (trigger.kind === "argument" ? `/${trigger.command}` : ""),
    note: (context, trigger) => {
      const value = trigger.kind === "argument" ? hintOf(trigger.command, context) : undefined
      return value ? text("own.command.hint", { hint: value }) : undefined
    },
    select: () => undefined,
  }

  return [server, client, agents, skills, hint]
}

function hintOf(command: string, context: SuggestContext) {
  const client = clientCommand(command)
  if (client && !SERVER_FIRST.has(client.id)) return undefined
  const found = serverCommands(context.runtime, context.directory)?.find((item) => item.name === command)
  if (!found) return undefined
  return hintFor(command, found.description)
}

const REVIEW_HINT = "[commit|branch|pr]"
/** `/goal` takes an objective or a control word, in core's loop and in Codex's alike (MR8-15). */
const GOAL_HINT = { ko: "<목표> | pause | resume | clear", en: "<goal> | pause | resume | clear" } as const

function hintFor(name: string, description: string | undefined) {
  if (name === "review") return REVIEW_HINT
  if (name === "goal") return GOAL_HINT[storedLocale()]
  return argumentHint(description)
}

function commandContext(context: SuggestContext): CommandContext {
  return {
    runtime: context.runtime,
    serverKey: context.serverKey,
    sessionID: context.sessionID,
    directory: context.directory,
  }
}

/**
 * Own words for the built-ins. `/goal` is Codex's own goal in a codex session (own-harness wraps core's command,
 * MR8-15) and core's goal loop in the others, so its line names which one the session gets.
 */
function describe(name: string, description: string | undefined, text: CommandText, context: SuggestContext) {
  if (name === "init") return text("own.command.init")
  if (name === "review") return text("own.command.reviewServer")
  if (name === "goal") return text(codexSession(context) ? "own.command.goalCodex" : "own.command.goal")
  return description
}

function codexSession(context: SuggestContext) {
  if (!context.sessionID) return false
  return OwnHarnessRouting.harnessOf(context.runtime.data.session.get(context.sessionID)?.metadata) === "codex"
}

function sync(context: SuggestContext) {
  if (!context.directory || context.runtime.connection.status() !== "connected") return
  void context.runtime.data.location.command.sync({ directory: context.directory }).catch(log)
}

function log(error: unknown) {
  console.error("[own-web] command catalog", error)
}

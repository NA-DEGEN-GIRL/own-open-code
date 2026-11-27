// Slash command catalog (03 §18.13). Two groups: server commands (`GET /api/command`: `/init`, `/review`, commands
// from config and `.opencode/command/*.md`, MCP prompts as `server:prompt`) run with `POST /api/session/:id/command`;
// client commands are handled here. This file is small and synchronous (first chunk): the composer resolves a typed
// `/name` at send time without loading the list.
import type { ServerRuntime } from "@/data"
import type { ShortcutID } from "@/keyboard"
import type { CommandKey } from "./strings"

export type ClientCommandID =
  | "new"
  | "compact"
  | "fork"
  | "undo"
  | "redo"
  | "export"
  | "model"
  | "agent"
  | "skills"
  | "terminal"
  | "review"
  | "reset-context"
  | "btw"

export interface ClientCommand {
  readonly id: ClientCommandID
  /** `/reset-context`'s and `/btw`'s are in their lazy chunks (context-reset/strings.ts, side/strings.ts, PF5). */
  readonly description: CommandKey | "own.reset.command" | "own.side.command"
  /** Needs an open (top-level) session. */
  readonly session: boolean
  /** Argument list shown after `/name ` (03 §18.13 `/agent`, 19.6 `/skills`); `question`: free text (`/btw`). */
  readonly arguments?: "agents" | "skills" | "question"
  readonly shortcut?: ShortcutID
}

/** Order of the client group when nothing is typed. */
export const CLIENT_COMMANDS: readonly ClientCommand[] = [
  { id: "new", description: "own.command.new", session: false, shortcut: "session.new" },
  { id: "model", description: "own.command.model", session: false, shortcut: "switcher.open" },
  { id: "agent", description: "own.command.agent", session: true, arguments: "agents" },
  { id: "btw", description: "own.side.command", session: true, arguments: "question" },
  { id: "compact", description: "own.command.compact", session: true },
  { id: "reset-context", description: "own.reset.command", session: true },
  { id: "fork", description: "own.command.fork", session: true },
  { id: "undo", description: "own.command.undo", session: true },
  { id: "redo", description: "own.command.redo", session: true },
  { id: "export", description: "own.command.export", session: true },
  { id: "skills", description: "own.command.skills", session: false, arguments: "skills" },
  { id: "terminal", description: "own.command.terminal", session: false, shortcut: "panel.terminal" },
  { id: "review", description: "own.command.review", session: false, shortcut: "panel.review" },
]

/** Korean names of `/reset-context` (03 §18.13). */
export const RESET_ALIASES = ["문맥비우기", "맥락비우기"]

const BY_NAME = new Map<string, ClientCommand>(
  CLIENT_COMMANDS.flatMap((command) => [
    [command.id, command] as const,
    ...(command.id === "reset-context" ? RESET_ALIASES.map((alias) => [alias, command] as const) : []),
    ...(command.id === "btw" ? [["곁질문", command] as const] : []),
  ]),
)

export function clientCommand(name: string) {
  return BY_NAME.get(name)
}

/**
 * `/review` is both: the server command (when the server has it) and then the review tab (18.13 "`/review`는 서버
 * 명령 뒤에 리뷰 탭을 연다"). Other client names shadow a server command of the same name.
 */
export const SERVER_FIRST: ReadonlySet<ClientCommandID> = new Set(["review"])

export function parseSlash(text: string): { readonly name: string; readonly args: string } | undefined {
  if (!text.startsWith("/")) return undefined
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd())
  if (!match) return undefined
  return { name: match[1]!, args: (match[2] ?? "").trim() }
}

/** `[commit|branch|pr]`, `<topic>` in a server command description (the API has no argument field). */
export function argumentHint(description: string | undefined) {
  const parts = description?.match(/\[[^\]\n]{1,60}\]|<[^>\n]{1,40}>/g)
  return parts?.length ? parts.join(" ") : undefined
}

/** Server commands of a location, from the data layer's store (no request; `undefined` until loaded). */
export function serverCommands(runtime: ServerRuntime, directory: string | undefined) {
  return directory ? runtime.data.location.command.list({ directory }) : undefined
}

/** Whether `/name ` opens an argument list or hint: `/agent`, `/skills`, server commands with `[…]`. */
export function hasArguments(runtime: ServerRuntime | undefined, directory: string | undefined, name: string) {
  const client = clientCommand(name)
  if (client?.arguments) return true
  if (client && !SERVER_FIRST.has(client.id)) return false
  if (!runtime) return false
  const server = serverCommands(runtime, directory)?.find((command) => command.name === name)
  return !!server && (name === "review" || !!argumentHint(server.description))
}

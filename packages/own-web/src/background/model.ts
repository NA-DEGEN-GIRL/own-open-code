// Background jobs (03 §19.7, [gap] 23), pure part: which shells and subagents of a session run in the background,
// which foreground tool the next `session.background` would move, labels, and the "끝났습니다" decision. Follows
// upstream `packages/app/src/session/requests/background.ts` (createSessionBackground) without its reactive wrapper
// so it can be unit-tested; src/background/data.ts feeds it from createData.
import type { SessionMessageInfo } from "@opencode/client"
import { perSettledMessage } from "@/data/settled"

export type TaskKind = "shell" | "subagent"

export interface BackgroundTask {
  /** Shell id (`sh_…`) or the child session id. */
  readonly id: string
  readonly kind: TaskKind
  /** Command (shell) or task description (subagent). */
  readonly label: string
  readonly agent?: string
  /** Start time (ms) when the shell list knows it. */
  readonly started?: number
}

/** A shell or subagent tool of the running step: what `session.background` (Alt+B) would move. */
export interface BlockingTool {
  readonly kind: TaskKind
  readonly partID: string
  readonly id?: string
  readonly label?: string
}

export interface History {
  /** Tools whose result said "moved to the background" and whose completion notice has not arrived yet. */
  readonly shells: readonly BackgroundTask[]
  readonly subagents: readonly BackgroundTask[]
  readonly blocking: readonly BlockingTool[]
}

/** The fields of a shell (`Shell.Info`) this module reads. */
export interface ShellView {
  readonly id: string
  readonly status: string
  readonly command: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly time: { readonly started: number }
}

export interface ChildView {
  readonly id: string
  readonly title?: string
  readonly agent?: string
  readonly running: boolean
}

const EMPTY: History = { shells: [], subagents: [], blocking: [] }

/**
 * One pass over the loaded history. Reads only message types, tool names, tool states and the metadata of synthetic
 * notices, so a streaming text delta does not re-run a memo built on it (R1/PF4). A settled message's share is kept
 * (data/settled.ts): paging up a long session reruns this per page.
 */
export function scanHistory(messages: readonly SessionMessageInfo[]): History {
  if (!messages.length) return EMPTY
  const shares = messages.map(shareOf)
  const completed = new Set(shares.flatMap((share) => share.completed))
  const subagents = shares.flatMap((share) => share.subagents)
  const shells = shares.flatMap((share) => share.shells)
  const last = shares.findLastIndex((share) => share.running)
  const running = last < 0 ? undefined : messages[last]
  const blocking =
    (running?.type === "assistant" ? running.content : undefined)?.flatMap((part): BlockingTool[] => {
      if (part.type !== "tool" || part.state.status !== "running") return []
      if (part.name !== "shell" && part.name !== "subagent") return []
      const meta = part.state.metadata
      const input = part.state.input
      const id = part.name === "shell" ? meta.shellID : meta.sessionID
      const label = part.name === "shell" ? input.command : input.description
      return [
        {
          kind: part.name,
          partID: part.id,
          id: typeof id === "string" ? id : undefined,
          label: typeof label === "string" ? label : undefined,
        },
      ]
    }) ?? []
  return {
    subagents: subagents.filter((task) => !completed.has(task.id)),
    // Completion notices name the shell or its job (the tool call).
    shells: shells
      .filter((item) => !completed.has(item.partID) && !completed.has(item.task.id))
      .map((item) => item.task),
    blocking,
  }
}

const NO_SHARE = { completed: [], subagents: [], shells: [], running: false }

/** One message's share of the scan: completion notices, backgrounded tools, whether it is a step still running. */
const shareOf = perSettledMessage((message) => {
  if (message.type === "synthetic") {
    const meta = message.metadata
    const ids =
      meta?.source === "subagent"
        ? [meta.childID]
        : meta?.source === "shell"
          ? [meta.shellID, meta.jobID]
          : []
    return { ...NO_SHARE, completed: ids.filter((id): id is string => typeof id === "string") }
  }
  if (message.type !== "assistant") return NO_SHARE
  const subagents: BackgroundTask[] = []
  const shells: { partID: string; task: BackgroundTask }[] = []
  for (const part of message.content) {
    if (part.type !== "tool" || (part.name !== "subagent" && part.name !== "shell")) continue
    if (part.state.status !== "completed" || part.state.metadata?.status !== "running") continue
    const input = part.state.input
    const meta = part.state.metadata
    if (part.name === "subagent") {
      if (typeof meta.sessionID !== "string") continue
      subagents.push({
        id: meta.sessionID,
        kind: "subagent",
        label: typeof input.description === "string" ? input.description : meta.sessionID,
        agent: typeof input.agent === "string" ? input.agent : undefined,
      })
      continue
    }
    shells.push({
      partID: part.id,
      task: {
        id: typeof meta.shellID === "string" ? meta.shellID : part.id,
        kind: "shell",
        label: typeof input.command === "string" ? input.command : part.id,
      },
    })
  }
  return { completed: [], subagents, shells, running: message.time.completed === undefined }
})

/**
 * Own modules that run fixed commands through `shell.create` (git writes, 19.2) tag them with `metadata.source`; those
 * are not the session's background jobs. Tool shells carry `{sessionID, shellID}`, user `!` shells `{sessionID,
 * background: true}` (core session/shell.ts).
 */
export function isSessionShell(shell: Pick<ShellView, "metadata">, sessionID: string) {
  return shell.metadata.sessionID === sessionID && shell.metadata.source === undefined
}

/**
 * Background tasks of a session: backgrounded tool results, running children and running shells that are not the
 * blocking tool of the current step. `shellRunning(id)` answers from the synced shell list (`undefined`: not synced
 * yet); a backgrounded shell the list no longer has exited and only waits for its completion notice.
 */
export function collectTasks(input: {
  readonly sessionID: string
  readonly history: History
  readonly children: readonly ChildView[]
  readonly shells: readonly ShellView[]
  readonly shellRunning?: (id: string) => boolean | undefined
}): BackgroundTask[] {
  const blocking = input.history.blocking
  const blocks = (kind: TaskKind, id: string, label: string | undefined) =>
    blocking.some((item) => item.kind === kind && (item.id === id || (!!item.label && item.label === label)))
  const children = input.children.flatMap((child): BackgroundTask[] =>
    child.running && !blocks("subagent", child.id, child.title)
      ? [{ id: child.id, kind: "subagent", label: child.title ?? child.id, agent: child.agent }]
      : [],
  )
  const shells = input.shells.flatMap((shell): BackgroundTask[] =>
    shell.status === "running" && isSessionShell(shell, input.sessionID) && !blocks("shell", shell.id, shell.command)
      ? [{ id: shell.id, kind: "shell", label: shell.command, started: shell.time.started }]
      : [],
  )
  const started = new Map(shells.map((task) => [task.id, task.started]))
  const history = input.history.shells.filter((task) => input.shellRunning?.(task.id) !== false)
  const merged = new Map<string, BackgroundTask>()
  for (const task of [...input.history.subagents, ...children, ...history, ...shells])
    merged.set(task.id, merged.get(task.id) ?? { ...task, started: task.started ?? started.get(task.id) })
  return [...merged.values()]
}

/** True when the loaded history says this tool call went to the background (result `status: "running"`). */
export function backgroundedInHistory(messages: readonly SessionMessageInfo[], kind: TaskKind, id: string) {
  return messages.some(
    (message) =>
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" &&
          part.name === kind &&
          part.state.status === "completed" &&
          part.state.metadata?.status === "running" &&
          part.state.metadata[kind === "shell" ? "shellID" : "sessionID"] === id,
      ),
  )
}

/**
 * Whether an exiting shell was a background job (toast "끝났습니다", 03 §9). Foreground tool shells end inside a
 * running step and report through their tool card; a shell whose session is idle, a user `!` shell, one the dock has
 * listed, or one the history marks as backgrounded is background work.
 */
export function wasBackground(input: {
  readonly metadata: Readonly<Record<string, unknown>>
  readonly listed: boolean
  readonly inHistory: boolean
  readonly sessionIdle: boolean
}) {
  if (input.metadata.source !== undefined) return false
  if (typeof input.metadata.sessionID !== "string") return false
  return input.listed || input.metadata.background === true || input.inHistory || input.sessionIdle
}

export type DoneKey =
  | "own.background.done.shell"
  | "own.background.done.shellNoCode"
  | "own.background.done.killed"
  | "own.background.done.timeout"

export function shellDone(status: string, exit: number | undefined): { key: DoneKey; tone: "neutral" | "danger" } {
  if (status === "killed") return { key: "own.background.done.killed", tone: "neutral" }
  if (status === "timeout") return { key: "own.background.done.timeout", tone: "danger" }
  if (exit === undefined || !Number.isFinite(exit)) return { key: "own.background.done.shellNoCode", tone: "neutral" }
  return { key: "own.background.done.shell", tone: exit === 0 ? "neutral" : "danger" }
}

/** One line, collapsed whitespace, at most `max` characters (dock row, toasts). */
export function shortLabel(label: string, max = 48) {
  const line = label.trim().split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ")
  const suffix = label.trim().includes("\n") ? " …" : ""
  if (line.length + suffix.length <= max) return line + suffix
  return `${line.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** Minutes since `started` for the dock list (the minute clock drives it, R9). */
export function elapsedMinutes(started: number | undefined, now: number) {
  if (started === undefined) return undefined
  return Math.max(0, Math.floor((now - started) / 60_000))
}

/** One row of the session header's running menu (upstream 3a861ff8b0, b9db2f6915). */
export interface RunningItem {
  readonly key: string
  readonly kind: TaskKind
  readonly label?: string
  readonly agent?: string
  /** The child session of a subagent, once it exists. */
  readonly sessionID?: string
  /** The background shell, or the tool part of a subagent still starting. */
  readonly target: string
}

/**
 * The work the header lists: the running step's subagents, the subagents in the background, then the background
 * shells. A foreground shell stays out (its tool card shows it at the bottom of the transcript); `tasks` already
 * leaves out what `blocking` has (collectTasks).
 */
export function runningItems(
  blocking: readonly BlockingTool[],
  tasks: readonly BackgroundTask[],
  agentOf: (sessionID: string | undefined) => string | undefined,
): RunningItem[] {
  return [
    ...blocking.flatMap((tool): RunningItem[] =>
      tool.kind === "subagent"
        ? [
            {
              key: tool.id ?? tool.partID,
              kind: "subagent",
              label: tool.label,
              agent: agentOf(tool.id),
              sessionID: tool.id,
              target: tool.partID,
            },
          ]
        : [],
    ),
    ...tasks.flatMap((task): RunningItem[] =>
      task.kind === "subagent"
        ? [
            {
              key: task.id,
              kind: "subagent",
              label: task.label,
              agent: task.agent ?? agentOf(task.id),
              sessionID: task.id,
              target: task.id,
            },
          ]
        : [],
    ),
    ...tasks.flatMap((task): RunningItem[] =>
      task.kind === "shell" ? [{ key: task.id, kind: "shell", label: task.label, target: task.id }] : [],
    ),
  ]
}

/**
 * The trigger's label key and count. In a subagent the list is its parent's work and the count leaves the viewed
 * session out (`그 밖에 …`); nothing to show is `undefined`. Any shell makes it `실행 중`, subagents alone `작업 중`.
 */
export function runningLabel(items: readonly RunningItem[], viewing: string | undefined, child: boolean) {
  const count = child ? items.filter((item) => !item.sessionID || item.sessionID !== viewing).length : items.length
  if (count === 0) return undefined
  const shell = items.some((item) => item.kind === "shell")
  const key = child
    ? shell
      ? "own.background.running.moreRunning"
      : "own.background.running.moreWorking"
    : shell
      ? "own.background.running.running"
      : "own.background.running.working"
  return { key, count } as const
}

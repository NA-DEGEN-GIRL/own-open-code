// Background jobs of one session on top of createData (03 §19.7): the shell list of the session's location (kept
// current by `shell.created/exited/deleted`), the loaded history and the known children. `send` is
// `POST /api/session/:id/background` (moves the running step's shell/subagent tools out of the way); `stop` is
// `DELETE /api/shell/:id` at the shell's own location for a shell, `session.interrupt` for a subagent.
//
// Location rule (01 §15, §17.1 #19): a shell lives in the Location that created it. After `session.move` the session
// answers from its new directory, but its running shells stay where they started, so shell calls use the shell's
// recorded location and fall back to the session's current directory only for shells the list does not know.
import { createEffect, createMemo, createSignal, on, untrack } from "solid-js"
import type { ServerKey, ServerRuntime } from "@/data"
import { collectTasks, scanHistory, type BackgroundTask, type ChildView } from "./model"

export interface ListedTask {
  readonly kind: BackgroundTask["kind"]
  readonly label: string
  readonly sessionID: string
}

/** Jobs a dock has listed (per `serverKey:id`), so the finish toast knows them after the shell left the store. */
const listed = new Map<string, ListedTask>()
/** Shells this window stopped: their exit is the user's own action, no "끝났습니다" toast. */
const stopped = new Set<string>()
const LISTED_LIMIT = 200
const SEND_ATTEMPTS = 4
/** Time for the tool result ("moved to the background") to arrive before asking again. */
const SEND_SETTLE_MS = 400

export function rememberListed(serverKey: ServerKey, task: BackgroundTask, sessionID: string) {
  const key = `${serverKey}:${task.id}`
  if (listed.has(key)) return
  listed.set(key, { kind: task.kind, label: task.label, sessionID })
  if (listed.size > LISTED_LIMIT) listed.delete(listed.keys().next().value!)
}

export function takeListed(serverKey: ServerKey, id: string) {
  const key = `${serverKey}:${id}`
  const found = listed.get(key)
  listed.delete(key)
  return found
}

export function takeStopped(serverKey: ServerKey, id: string) {
  return stopped.delete(`${serverKey}:${id}`)
}

/** `DELETE /api/shell/:id` at the shell's location; its exit then is the user's own action (no finish toast). */
export async function stopShell(runtime: ServerRuntime, serverKey: ServerKey, id: string, directory: string) {
  const key = `${serverKey}:${id}`
  stopped.add(key)
  await runtime
    .client()
    .shell.remove({ id, location: { directory } })
    .catch((error: unknown) => {
      stopped.delete(key)
      throw error
    })
}

/**
 * `POST /api/session/:id/background`. The tool card shows a tool as running a moment before core registers it as a
 * blocking job, and a request in that gap is a server no-op; so while `stillBlocking()` holds, the request goes again
 * (a few times, user-triggered, then it stops).
 */
export async function requestBackground(runtime: ServerRuntime, sessionID: string, stillBlocking: () => boolean) {
  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
    await runtime.client().session.background({ sessionID })
    await new Promise((resolve) => setTimeout(resolve, SEND_SETTLE_MS))
    if (!stillBlocking()) return
  }
}

export function sessionDirectory(runtime: ServerRuntime, sessionID: string) {
  return runtime.data.session.get(sessionID)?.location.directory ?? runtime.sessions.directory(sessionID)
}

/** Where a shell lives: its recorded location, else the session's current directory. */
export function shellDirectory(runtime: ServerRuntime, shellID: string, sessionID?: string) {
  return runtime.data.shell.get(shellID)?.location.directory ?? (sessionID ? sessionDirectory(runtime, sessionID) : "")
}

export function isChild(runtime: ServerRuntime, sessionID: string) {
  return !!(runtime.data.session.get(sessionID)?.parentID ?? runtime.sessions.state.sessions[sessionID]?.parentID)
}

export function childViews(runtime: ServerRuntime, sessionID: string): ChildView[] {
  return runtime.data.session.family(sessionID).flatMap((id) => {
    const info = runtime.data.session.get(id)
    if (info?.parentID !== sessionID) return []
    return [{ id, title: info.title, agent: info.agent, running: runtime.data.session.status(id) === "running" }]
  })
}

/**
 * Background work for the sidebar's `⧗` (7.6: "백그라운드 작업만 도는 중, 턴은 끝남"): running shells of the session
 * and running children, without the history scan (rows must stay cheap). Returns 0 while the turn itself runs.
 */
export function backgroundCount(runtime: ServerRuntime, sessionID: string) {
  if (runtime.data.session.status(sessionID) === "running") return 0
  const shells = runtime.data.shell
    .listBySession(sessionID)
    .filter((shell) => shell.status === "running" && shell.metadata.source === undefined).length
  return shells + childViews(runtime, sessionID).filter((child) => child.running).length
}

export function createBackground(input: {
  readonly runtime: () => ServerRuntime | undefined
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  // Root sessions only: a child's work is its parent's (upstream `primary`).
  const target = createMemo(() => {
    const runtime = input.runtime()
    const id = input.sessionID()
    if (!runtime || !id || isChild(runtime, id)) return undefined
    return { runtime, id }
  })
  const directory = () => {
    const current = target()
    return current ? sessionDirectory(current.runtime, current.id) : undefined
  }
  const [synced, setSynced] = createSignal<string>()

  // The shell list of the session's location, once per connection and after a move (createData dedups the GET).
  createEffect(
    on(
      () => [target(), directory(), target()?.runtime.connection.status()] as const,
      ([current, dir, status]) => {
        setSynced(undefined)
        if (!current || !dir || status !== "connected") return
        untrack(() => {
          void current.runtime.data.shell
            .sync({ directory: dir })
            .then(() => setSynced(dir))
            .catch(() => undefined)
        })
      },
    ),
  )

  const history = createMemo(() => {
    const current = target()
    return scanHistory(current ? current.runtime.data.session.message.list(current.id) : [])
  })

  const running = () => {
    const current = target()
    return !!current && current.runtime.data.session.status(current.id) === "running"
  }

  /** The step's shell/subagent tools that `session.background` would move (only while the session runs). */
  const blocking = createMemo(() => (running() ? history().blocking : []))

  // Unchanged tasks keep their object, so the open list keeps its rows (and the focused button) across updates.
  const tasks = createMemo<BackgroundTask[]>((previous) => {
    const current = target()
    if (!current) return []
    const data = current.runtime.data
    const dir = directory()
    const next = collectTasks({
      sessionID: current.id,
      history: history(),
      children: childViews(current.runtime, current.id),
      shells: data.shell.listBySession(current.id),
      shellRunning: (id) => (data.shell.get(id) ? true : synced() && synced() === dir ? false : undefined),
    })
    const kept = new Map(previous.map((task) => [task.id, task]))
    const merged = next.map((task) => {
      const old = kept.get(task.id)
      return old && sameTask(old, task) ? old : task
    })
    return merged.length === previous.length && merged.every((task, index) => task === previous[index])
      ? previous
      : merged
  }, [])

  // Only jobs that are surely in the background are remembered for the finish toast: shells (a foreground tool shell
  // is excluded by `collectTasks`) and subagents whose tool result said so. A running child can be foreground for a
  // moment before its tool part carries the child id.
  createEffect(() => {
    const current = target()
    if (!current) return
    const backgrounded = new Set(history().subagents.map((task) => task.id))
    for (const task of tasks())
      if (task.kind === "shell" || backgrounded.has(task.id)) rememberListed(input.serverKey(), task, current.id)
  })

  const canAct = () => target()?.runtime.rpc.can("prompt") ?? false

  return {
    target,
    tasks,
    blocking,
    running,
    canAct,
    /** Moves the running step's shell/subagent tools to the background (`requestBackground`). */
    async send() {
      const current = target()
      if (!current) return
      const parts = new Set(blocking().map((item) => item.partID))
      await requestBackground(current.runtime, current.id, () => blocking().some((item) => parts.has(item.partID)))
    },
    async stop(task: BackgroundTask) {
      const current = target()
      if (!current) return
      if (task.kind === "subagent")
        return void (await current.runtime.client().session.interrupt({ sessionID: task.id }))
      await stopShell(current.runtime, input.serverKey(), task.id, shellDirectory(current.runtime, task.id, current.id))
    },
  }
}

export type Background = ReturnType<typeof createBackground>

function sameTask(a: BackgroundTask, b: BackgroundTask) {
  return a.kind === b.kind && a.label === b.label && a.agent === b.agent && a.started === b.started
}

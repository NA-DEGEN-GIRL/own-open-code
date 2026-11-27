// Reactive reads for the subagent views (03 §18.11) on top of createData: the session family (root + every known
// descendant), permission requests and forms per session (kept current by `permission.asked/replied` and
// `form.created/replied/cancelled` events), and the execution status. The first read of a parent loads its children
// and the requests of the unfinished ones (a child's request that nobody sees stops the turn, 03 §18.1 [gap] 1).
import type { Ledger } from "@own/protocol"
import { createEffect, createSignal, on, onCleanup, untrack } from "solid-js"
import type { ServerRuntime } from "@/data"
import { ancestry, childRows, childState, agentOf, taskTitle, type ChildRow } from "./model"

/** Children whose requests are loaded when a parent opens; the rest arrive through events. */
const SYNC_LIMIT = 12

export function facts(runtime: ServerRuntime, id: string) {
  const info = runtime.data.session.get(id)
  const row = runtime.sessions.state.sessions[id]
  if (!info && !row) return undefined
  return {
    id,
    parentID: info?.parentID ?? row?.parentID,
    title: info?.title ?? row?.title,
    agent: info?.agent,
    outcome: info?.outcome,
    created: info?.time.created ?? 0,
  }
}

export function ownRequests(runtime: ServerRuntime, sessionID: string) {
  return (
    (runtime.data.session.permission.list(sessionID)?.length ?? 0) +
    (runtime.data.session.form.list(sessionID)?.length ?? 0)
  )
}

/** Requests of a session and all its known descendants. */
export function familyRequests(runtime: ServerRuntime, sessionID: string) {
  const members = runtime.data.session.family(sessionID)
  const get = (id: string) => facts(runtime, id)
  return members.reduce((total, id) => {
    if (id === sessionID) return total + ownRequests(runtime, id)
    const chain = ancestry(get, id)
    return chain.some((item) => item.id === sessionID) ? total + ownRequests(runtime, id) : total
  }, 0)
}

export function childIDs(runtime: ServerRuntime, parentID: string) {
  return runtime.data.session.family(parentID).filter((id) => runtime.data.session.get(id)?.parentID === parentID)
}

export function childRowsOf(runtime: ServerRuntime, parentID: string) {
  return childRows(
    childIDs(runtime, parentID).map((id): ChildRow => {
      const info = facts(runtime, id)
      return {
        id,
        agent: agentOf(info),
        task: taskTitle(info?.title),
        state: childState(info, runtime.data.session.status(id) === "running"),
        requests: familyRequests(runtime, id),
        created: info?.created ?? 0,
      }
    }),
  )
}

/**
 * Loads a parent's children (once per connection) and the pending requests of its unfinished children, and a child's
 * ancestors (the breadcrumb needs their titles).
 */
export function watchFamily(runtime: () => ServerRuntime | undefined, sessionID: () => string | undefined) {
  createEffect(
    on(
      () => [runtime(), sessionID(), runtime()?.connection.status()] as const,
      ([current, id, status]) => {
        if (!current || !id || status !== "connected") return
        untrack(() => {
          const data = current.data
          void data.session.sync(id, { children: true }).then(
            () => {
              const open = childIDs(current, id)
                .filter((child) => data.session.status(child) === "running" || !data.session.get(child)?.outcome)
                .slice(0, SYNC_LIMIT)
              for (const child of open) {
                void data.session.permission.sync(child).catch(() => undefined)
                void data.session.form.sync(child).catch(() => undefined)
              }
            },
            () => undefined,
          )
          const parent = data.session.get(id)?.parentID
          if (parent && !data.session.get(parent)) void data.session.sync(parent).catch(() => undefined)
        })
      },
    ),
  )
}

/** Ledger lines read for a child's latest step: enough to pass the compaction and title lines after it. */
const LATEST_PAGE = 20

/**
 * The ledger line of a session's latest step (02 §9.2 `ledger.session`, §9.3 `ledger.step`): the account that signed
 * it (SL-8). One small page once the router is ready (again after a reconnect), then every `ledger.step` of the
 * session; `undefined` while none is known.
 */
export function latestLine(runtime: () => ServerRuntime | undefined, sessionID: () => string | undefined) {
  const [line, setLine] = createSignal<Ledger.Line>()
  // Only the open child's lines: a late `ledger.session` answer for the child shown before never lands on this one.
  const take = (item: Ledger.Line | undefined) => {
    const current = line()
    if (item?.kind === "primary" && item.sessionID === sessionID() && (!current || item.ts >= current.ts)) setLine(item)
  }
  createEffect(
    on([runtime, sessionID], ([current, id]) => {
      setLine(undefined)
      if (!current || !id) return
      onCleanup(current.own.on("ledger.step", (event) => take(event.data.line)))
      createEffect(() => {
        if (current.own.state.status !== "ready") return
        void current.own.rpc
          .call("ledger.session", { sessionID: id, limit: LATEST_PAGE })
          .then((output) => take(output.steps.findLast((item) => item.kind === "primary")))
          .catch(() => undefined)
      })
    }),
  )
  return line
}

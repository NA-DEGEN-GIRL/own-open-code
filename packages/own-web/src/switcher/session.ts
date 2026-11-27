// Facts about a session every switcher surface reads the same way: the Ref it runs on now, and the children that keep
// their own account when the parent switches (03 §5.2.1).
import type { ServerRuntime } from "@/data"
import type { TargetRef } from "./cost"

/** The session's current Ref: the router binding, else the session info. `null` for an unpinned session. */
export function currentRef(runtime: ServerRuntime, sessionID: string): TargetRef | null {
  const bound = runtime.own.state.binding[sessionID]
  if (bound) return bound.model
  return runtime.data.session.get(sessionID)?.model ?? null
}

/** Children that still run or will be continued keep their account (03 §5.2.1, §6.3 "하위 에이전트 {n}개"). */
export function continuingChildren(runtime: ServerRuntime, sessionID: string) {
  return runtime.data.session.family(sessionID).filter((id) => {
    const info = runtime.data.session.get(id)
    if (!info || info.parentID !== sessionID) return false
    return runtime.data.session.status(id) === "running" || !info.outcome
  }).length
}

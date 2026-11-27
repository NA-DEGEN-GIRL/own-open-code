// Child (subagent) session breadcrumb (03 §18.11, 15.3 ChildSessionBreadcrumb):
//   계정 라우터 RPC 설계 › 하위 에이전트 explore
// The parent title navigates to the parent. `SessionTitle` is the header title slot: the plain title for a root
// session, the breadcrumb for a child. STUB scope: the header (shell/header.tsx, lead) still renders the plain title;
// the transcript shows the breadcrumb at its top for child sessions until the header mounts `SessionTitle`.
import { createEffect, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { teamTitle } from "@/team/title"
import { splitAt } from "./format"

export interface SessionTitleProps {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}

export function SessionTitle(props: SessionTitleProps) {
  const child = useChildSession(props)
  const i18n = useI18n()
  return (
    <Show
      when={child.parentID()}
      fallback={<span class="own-title-text">{child.title() || i18n.t("own.shell.untitled")}</span>}
    >
      <ChildSessionBreadcrumb serverKey={props.serverKey} sessionID={props.sessionID} />
    </Show>
  )
}

export function ChildSessionBreadcrumb(props: SessionTitleProps) {
  const i18n = useI18n()
  const router = useRouter()
  const child = useChildSession(props)
  const parts = () => splitAt(i18n.t("own.child.breadcrumb", { agent: child.agent() }), "{parent}")
  return (
    <Show when={child.parentID()}>
      {(parentID) => (
        <nav class="own-breadcrumb" aria-label={i18n.t("own.child.backToParent")} data-testid="child-breadcrumb">
          {parts()[0]}
          <button
            type="button"
            class="own-breadcrumb-parent"
            onClick={() => router.navigate({ name: "session", serverKey: props.serverKey(), sessionID: parentID() })}
          >
            {child.parentTitle() || i18n.t("own.shell.untitled")}
          </button>
          {parts()[1]}
        </nav>
      )}
    </Show>
  )
}

function useChildSession(props: SessionTitleProps) {
  const data = useData()
  const i18n = useI18n()
  const runtime = () => data.get(props.serverKey())
  const info = () => {
    const id = props.sessionID()
    return id ? runtime()?.data.session.get(id) : undefined
  }
  const row = () => {
    const id = props.sessionID()
    return id ? runtime()?.sessions.state.sessions[id] : undefined
  }
  const parentID = () => info()?.parentID ?? row()?.parentID
  const parentTitle = () => {
    const id = parentID()
    if (!id) return undefined
    return runtime()?.data.session.get(id)?.title ?? runtime()?.sessions.state.sessions[id]?.title
  }
  // The parent's title may not be loaded yet (the sidebar only lists roots): fetch it once connected.
  createEffect(() => {
    const current = runtime()
    const id = parentID()
    if (!current || !id || parentTitle() || current.connection.status() !== "connected") return
    void current.data.session.sync(id).catch(() => undefined)
  })
  const shown = (id: string | undefined, title: string | undefined) =>
    teamTitle(title, id ? runtime()?.team.placeOf(id)?.role : undefined, i18n.locale())
  const title = () => shown(props.sessionID(), info()?.title ?? row()?.title)
  // Core titles child sessions "<task> (@<agent> subagent)"; the session's own agent wins when set.
  const agent = () =>
    info()?.agent ?? title()?.match(/\(@([^)\s]+) subagent\)\s*$/)?.[1] ?? i18n.t("own.child.agentFallback")
  return { parentID, parentTitle: () => shown(parentID(), parentTitle()), title, agent }
}

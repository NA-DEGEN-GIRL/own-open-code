// Server marks (04 §12.5, §10): the session header's server badge (`lab`, hover `사용자@호스트:경로`) and the small server
// tag of ledger/usage rows. Both render nothing for the local server.
import { createSignal, Show } from "solid-js"
import { LOCAL, useData, type DataLayer, type ServerKey } from "@/data"
import { useRouter } from "@/routing/router"
import { targetFor } from "@/sidebar/target"
import { remoteStore } from "./active"
import { destinationHost } from "./state"
import { useServersText } from "./strings"

export function ServerBadge(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const router = useRouter()
  const text = useServersText()
  const host = () => remoteStore()?.state.hosts[props.serverKey()]
  const [destination, setDestination] = createSignal<{ key: string; value: string }>()
  const directory = () => {
    const runtime = remoteStore()?.runtime(props.serverKey()) ?? data.get(props.serverKey())
    if (!runtime) return undefined
    const sessionID = props.sessionID()
    if (sessionID)
      return runtime.data.session.get(sessionID)?.location.directory ?? runtime.sessions.directory(sessionID)
    const route = router.route()
    if (route.name !== "project") return undefined
    return (
      targetFor(route.serverKey, route.projectID)?.directory ??
      runtime.sessions.state.projects[route.projectID]?.directory
    )
  }
  /** `hosts.detail` only when the user looks (04 §7.5 "열 때만"); memory only. */
  const load = () => {
    const key = props.serverKey()
    const store = remoteStore()
    if (!store || destination()?.key === key) return
    void store.detail(key).then((detail) => {
      const value = destinationHost(detail?.destination)
      if (value && props.serverKey() === key) setDestination({ key, value })
    })
  }
  const title = () => {
    const view = host()
    if (!view) return undefined
    const where = destination()?.key === props.serverKey() ? destination()!.value : view.name
    const path = directory()
    return path ? `${where}:${path}` : where
  }
  return (
    <Show when={host()}>
      {(view) => (
        <span
          tabindex="0"
          class="inline-flex h-5 max-w-[16ch] flex-none items-center truncate rounded-md border border-own-border bg-own-subtle px-1.5 text-[11.5px] font-medium text-own-muted"
          data-testid="server-badge"
          data-host={view().id}
          title={title()}
          aria-label={text("own.remote.badge.label", { name: view().name })}
          onMouseEnter={load}
          onFocus={load}
        >
          {view().name}
        </span>
      )}
    </Show>
  )
}

/** Which server a session belongs to: a remote host whose list or data has it, else the local server. */
export function serverOfSession(data: Pick<DataLayer, "get">, sessionID: string): ServerKey {
  const store = remoteStore()
  if (!store) return LOCAL
  for (const hostId of store.state.order) {
    const runtime = store.runtime(hostId) ?? data.get(hostId)
    if (runtime && (runtime.sessions.state.sessions[sessionID] || runtime.data.session.get(sessionID))) return hostId
  }
  return LOCAL
}

/** Small tag for rows that aggregate several servers (usage, ledger): the host name, nothing for `local`. */
export function ServerTag(props: { readonly serverKey: ServerKey }) {
  const text = useServersText()
  const name = () => remoteStore()?.state.hosts[props.serverKey]?.name
  return (
    <Show when={props.serverKey !== LOCAL && name()}>
      {(value) => (
        <span
          class="inline-flex h-[18px] flex-none items-center rounded border border-own-border px-1 text-[11px] text-own-muted"
          data-testid="server-tag"
          data-host={props.serverKey}
          title={text("own.remote.tag.title", { name: value() })}
        >
          {value()}
        </span>
      )}
    </Show>
  )
}

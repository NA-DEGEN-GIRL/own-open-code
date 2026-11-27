// One server's web search state, shared by 설정 > 웹 검색, the search cards and the one-time hint (03 §18.2, WM
// 2026-10-19): own's choice and which listed services use the user's own key (own.accounts `websearch.get`), and the
// services core lists at a location (`GET /api/websearch/provider` through the client's location store, which follows
// `websearch.updated`). Loaded on first use, once per server; `websearch.get` again after a save here, a config change
// (`config.updated`: another window saved, or the file was edited) and a reconnect.
import type { Approval } from "@own/protocol"
import { createEffect, createResource, createRoot, on, onCleanup } from "solid-js"
import type { ServerRuntime } from "@/data"
import type { Listed } from "./services"

export interface WebSearchInfo {
  /** `websearch.get`; `undefined` while it loads, fails or this connection may not read it. */
  readonly state: () => Approval.WebSearchState | undefined
  readonly loading: () => boolean
  readonly error: () => unknown
  /** The services listed at `directory` (asks once per directory); `undefined` until they arrive. */
  readonly listed: (directory: string | undefined) => readonly Listed[] | undefined
  /** `websearch.set`; the answer replaces the state. */
  readonly set: (choice: Approval.WebSearchSetChoice) => Promise<Approval.WebSearchState>
  /** Lists the services at `directory` again (after `unknown_service`). */
  readonly reload: (directory: string | undefined) => void
}

const infos = new WeakMap<ServerRuntime, WebSearchInfo>()

export function webSearchInfo(runtime: ServerRuntime): WebSearchInfo {
  const known = infos.get(runtime)
  if (known) return known
  const made = createRoot(() => create(runtime))
  infos.set(runtime, made)
  return made
}

function create(runtime: ServerRuntime): WebSearchInfo {
  const connected = () => runtime.connection.status() === "connected"
  const [state, { mutate, refetch }] = createResource(
    () => connected() && runtime.rpc.allowed("websearch.get"),
    () => runtime.rpc.call("websearch.get", {}),
  )
  createEffect(() => onCleanup(runtime.bus.on("config.updated", () => void refetch())))
  const asked = new Set<string>()
  // A reconnect may follow a service restart with another list: ask again on the next read.
  createEffect(on(connected, (online) => (online ? undefined : asked.clear()), { defer: true }))
  const ask = (directory: string) => {
    asked.add(directory)
    void runtime.data.location.websearch.refresh({ directory }).catch(() => asked.delete(directory))
  }
  return {
    state: () => (state.error ? undefined : state()),
    loading: () => state.loading,
    error: () => state.error,
    listed: (directory) => {
      if (!directory || !connected()) return undefined
      if (!asked.has(directory)) ask(directory)
      return runtime.data.location.websearch.list({ directory })
    },
    set: async (choice) => {
      const result = await runtime.rpc.call("websearch.set", { choice })
      mutate(result)
      return result
    },
    reload: (directory) => {
      if (directory && connected()) ask(directory)
    },
  }
}

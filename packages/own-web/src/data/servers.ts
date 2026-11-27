// Server registry (04 §12.1, §21 seam 1): the data layer is built for a list of servers from day one, even while
// only `local` exists. Every session is addressed as (serverKey, sessionID), in routes, drafts and notifications.
import { createStore, produce } from "solid-js/store"
import type { HostConnection } from "@/host"

export type ServerKey = string
export const LOCAL: ServerKey = "local"

export interface ServerEntry {
  readonly key: ServerKey
  readonly kind: "local" | "ssh"
  /** Sidebar label: `이 PC` for local, the host name for SSH. */
  readonly label: string
  /** Absolute; may carry a path prefix (`/srv/<serverKey>` behind the gateway, 04 §12.1). */
  readonly baseUrl: string
  readonly auth: HostConnection["auth"]
  readonly controlDir?: string
  readonly scopes?: HostConnection["scopes"]
  /** A gateway device's: the name of the PC the service runs on (06 §9.8 view-only notices). */
  readonly pc?: string
  /**
   * Remote servers only: the short-lived `own.remote.resolve` token as a Basic header, kept in tab memory only
   * (04 §12.1). The local server never has one: desktop main or the pairing cookie authenticates it.
   */
  readonly headers?: () => Readonly<Record<string, string>>
}

export function createServerRegistry() {
  const [state, setState] = createStore<{ servers: ServerEntry[] }>({ servers: [] })
  return {
    list: () => state.servers,
    get: (key: ServerKey) => state.servers.find((server) => server.key === key),
    /** Adds or replaces by key (an SSH endpoint change bumps its epoch and replaces the entry, 04 §12.1). */
    upsert(entry: ServerEntry) {
      setState(
        "servers",
        produce((servers) => {
          const index = servers.findIndex((server) => server.key === entry.key)
          if (index >= 0) servers[index] = entry
          else servers.push(entry)
        }),
      )
    },
    remove(key: ServerKey) {
      setState("servers", (servers) => servers.filter((server) => server.key !== key))
    },
  }
}

export type ServerRegistry = ReturnType<typeof createServerRegistry>

export function localEntry(connection: HostConnection): ServerEntry {
  return {
    key: LOCAL,
    kind: "local",
    label: "local",
    baseUrl: connection.baseUrl,
    auth: connection.auth,
    controlDir: connection.controlDir,
    scopes: connection.scopes,
    ...(connection.pc === undefined ? {} : { pc: connection.pc }),
  }
}

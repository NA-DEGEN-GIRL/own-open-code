// Terminal tabs of one location (03 §18.6 "터미널은 프로젝트(location)에 묶인다"): switching sessions inside a project
// keeps the same terminals, and the server is the source of truth for which PTYs exist (`pty.list` + `pty.*` events),
// so a reload or a second window shows the same tabs. Only the tab order and the active id are remembered locally
// (no output: the server retains up to 2 MB per PTY and replays it on connect, core/pty.ts).
// Exited PTYs stay as tabs with `종료됨 (exit n)` and `다시 시작` until closed (upstream removes them at once); a PTY
// that vanished (service restart) keeps its tab and scrollback, marked `gone`, until it is restarted or closed.
import { batch, createMemo, createRoot } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { EventOf } from "@/data/events"
import type { PtyApi, PtyInfo } from "./api"

/** Server info plus `gone`: the tab was open here but the server no longer knows the PTY (no `pty.deleted` seen). */
export type TerminalItem = PtyInfo & { readonly gone?: boolean }

type PtyEvent = EventOf<"pty.created" | "pty.updated" | "pty.exited" | "pty.deleted">

export interface TerminalEvents {
  on<Type extends PtyEvent["type"] | "server.connected">(
    type: Type,
    handler: (event: EventOf<Type>) => void,
  ): () => void
}

export interface TerminalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface State {
  status: "idle" | "loading" | "ready" | "error"
  error?: string
  order: string[]
  items: Record<string, TerminalItem>
  active?: string
  /** A tab asked for keyboard focus (new terminal, tab click); the view consumes it once mounted. */
  focus?: string
  /** A create is in flight: the panel shows it instead of auto-creating a second one. */
  creating: boolean
}

export type TerminalStore = ReturnType<typeof createTerminalStore>

export function createTerminalStore(input: {
  readonly api: PtyApi
  readonly events: TerminalEvents
  /** Remembers order and active id; omitted in tests. */
  readonly storage?: TerminalStorage
  readonly storageKey?: string
}) {
  return createRoot((dispose) => {
    const [state, setState] = createStore<State>({ status: "idle", order: [], items: {}, creating: false })
    const directory = input.api.directory
    const mine = (event: { readonly location?: { readonly directory: string } }) =>
      !!event.location && sameDirectory(event.location.directory, directory)

    const remembered = readRemembered(input.storage, input.storageKey)
    const remember = () => {
      if (!input.storage || !input.storageKey) return
      try {
        input.storage.setItem(input.storageKey, JSON.stringify({ order: state.order, active: state.active }))
      } catch {}
    }

    function adopt(info: PtyInfo, at?: number) {
      batch(() => {
        setState("items", info.id, reconcile(info))
        if (state.order.includes(info.id)) {
          if (at === undefined) return
          setState("order", (order) =>
            insertAt(
              order.filter((id) => id !== info.id),
              info.id,
              at,
            ),
          )
          return
        }
        setState("order", (order) => (at === undefined ? [...order, info.id] : insertAt(order, info.id, at)))
      })
    }

    function drop(id: string) {
      const index = state.order.indexOf(id)
      if (index === -1) return
      batch(() => {
        if (state.active === id) setState("active", state.order[index + 1] ?? state.order[index - 1])
        setState("order", (order) => order.filter((item) => item !== id))
        setState(
          "items",
          produce((items) => {
            delete items[id]
          }),
        )
        if (state.focus === id) setState("focus", undefined)
      })
      remember()
    }

    const loading = { current: false }
    async function load() {
      if (loading.current) return
      loading.current = true
      // A refresh after reconnecting keeps the tabs on screen; only the first load shows the loading state.
      if (state.status !== "ready") setState("status", "loading")
      const listed = await input.api.list().catch((error: unknown) => {
        if (state.status !== "ready") setState({ status: "error", error: message(error) })
        return undefined
      })
      loading.current = false
      if (!listed) return
      const byId = new Map<string, TerminalItem>(listed.map((info) => [info.id, info]))
      const current = [...state.order]
      const restored = remembered.order.filter((id) => byId.has(id) && !current.includes(id))
      const fresh = listed.map((info) => info.id).filter((id) => !current.includes(id) && !restored.includes(id))
      for (const id of current) {
        const item = state.items[id]
        if (!byId.has(id) && item) byId.set(id, { ...item, status: "exited", gone: true })
      }
      const order = [...current, ...restored, ...fresh]
      const preferred = [state.active, remembered.active].find((id) => id && byId.has(id))
      batch(() => {
        setState("items", reconcile(Object.fromEntries(byId)))
        setState("order", order)
        setState("active", preferred ?? order[0])
        setState({ status: "ready", error: undefined })
      })
      remember()
    }

    async function create(options: { readonly command?: string } = {}) {
      setState("creating", true)
      const created = await input.api.create({ command: options.command }).catch((error: unknown) => {
        setState("error", message(error))
        return undefined
      })
      setState("creating", false)
      if (!created) return undefined
      batch(() => {
        adopt(created)
        setState({ active: created.id, focus: created.id, error: undefined })
      })
      remember()
      return created
    }

    const unsubscribe = [
      input.events.on("pty.created", (event) => {
        if (mine(event) && state.status === "ready") adopt(event.data.info)
      }),
      input.events.on("pty.updated", (event) => {
        if (mine(event) && state.items[event.data.info.id])
          setState("items", event.data.info.id, reconcile(event.data.info))
      }),
      input.events.on("pty.exited", (event) => {
        if (!mine(event) || !state.items[event.data.id]) return
        setState("items", event.data.id, { status: "exited", exitCode: event.data.exitCode })
      }),
      input.events.on("pty.deleted", (event) => {
        if (mine(event)) drop(event.data.id)
      }),
      // The event stream came back (service restart, network): PTYs may be gone or new; the list is the truth.
      input.events.on("server.connected", () => {
        if (state.status === "ready" || state.status === "error") void load()
      }),
    ]

    const running = createMemo(() => state.order.filter((id) => state.items[id]?.status === "running").length)

    function select(id: string) {
      if (!state.items[id]) return
      setState({ active: id, focus: id })
      remember()
    }

    return {
      directory,
      api: input.api,
      events: input.events,
      state,
      running,
      load,
      create,
      select,
      /** The view took focus; later mounts do not steal it again. */
      focused(id: string) {
        if (state.focus === id) setState("focus", undefined)
      },
      requestFocus(id: string) {
        setState("focus", id)
      },
      async close(id: string) {
        drop(id)
        await input.api.remove(id).catch(() => undefined)
      },
      /** `다시 시작`: a new PTY with the same shell takes the tab's place; the exited one is removed. */
      async restart(id: string) {
        const previous = state.items[id]
        if (!previous) return undefined
        const at = state.order.indexOf(id)
        setState("creating", true)
        const created = await input.api.create({ command: previous.command }).catch((error: unknown) => {
          setState("error", message(error))
          return undefined
        })
        setState("creating", false)
        if (!created) return undefined
        batch(() => {
          adopt(created, at)
          setState({ active: created.id, focus: created.id, error: undefined })
        })
        drop(id)
        await input.api.remove(id).catch(() => undefined)
        return created
      },
      /** The view learned the PTY state from the server: exited (close after exit) or gone (404 on reconnect). */
      exited(id: string, exitCode: number | undefined) {
        if (!state.items[id]) return
        setState("items", id, { status: "exited", exitCode })
      },
      gone(id: string) {
        if (!state.items[id]) return
        setState("items", id, { status: "exited", gone: true })
      },
      step(delta: number) {
        const index = state.order.indexOf(state.active ?? "")
        if (index === -1 || state.order.length < 2) return
        const next = state.order[(index + delta + state.order.length) % state.order.length]
        if (next) select(next)
      },
      dismissError() {
        setState("error", undefined)
      },
      dispose() {
        unsubscribe.forEach((off) => off())
        dispose()
      },
    }
  })
}

/** Server directories come back as the server spelled them; Windows paths compare case- and slash-insensitively. */
export function sameDirectory(a: string, b: string) {
  if (a === b) return true
  if (!/^[a-z]:[\\/]/i.test(a) || !/^[a-z]:[\\/]/i.test(b)) return false
  const norm = (value: string) => value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase()
  return norm(a) === norm(b)
}

function insertAt(order: readonly string[], id: string, at: number) {
  const next = [...order]
  next.splice(Math.min(Math.max(at, 0), next.length), 0, id)
  return next
}

function readRemembered(storage: TerminalStorage | undefined, key: string | undefined) {
  const empty = { order: [] as string[], active: undefined as string | undefined }
  if (!storage || !key) return empty
  try {
    const raw: unknown = JSON.parse(storage.getItem(key) ?? "null")
    if (!raw || typeof raw !== "object") return empty
    const order = "order" in raw && Array.isArray(raw.order) ? raw.order.filter((id) => typeof id === "string") : []
    const active = "active" in raw && typeof raw.active === "string" ? raw.active : undefined
    return { order, active }
  } catch {
    return empty
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

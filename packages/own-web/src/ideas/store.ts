// Idea notes (03 §4.4.1 아이디어 노트): the board's ideas, kept by this PC's service (own.accounts `ideas.*`, 02 §9.2), so
// the desktop app, a phone through the gateway and another PC's window show the same board.
// - Every write names the revision it started from. When another device saved first the service answers the stored
//   idea (`idea_conflict`): a color or pin change goes out again on top of it (it never touches the text), a text edit
//   comes back to the user with the newer text, never overwriting it.
// - `ideas.changed` from another client and a reconnect read the list again; an echo of this window's own save does not.
// - One store per runtime for the whole window: the quick capture and the board share it.
import { batch, createEffect, createRoot, on } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { OwnRpcError, type ServerRuntime } from "@/data"
import type { Idea } from "./model"

export interface IdeaPut {
  readonly id: string
  readonly text?: string
  readonly color?: Idea["color"]
  readonly pinned?: boolean
  readonly createdAt?: number
  readonly baseRev: number
}

export type PutResult =
  | { readonly type: "ok"; readonly idea: Idea }
  | { readonly type: "conflict"; readonly current: Idea | null }
  | { readonly type: "limit"; readonly max: number }

export type RemoveResult = { readonly type: "ok" } | { readonly type: "conflict"; readonly current: Idea | null }

export interface IdeaChange {
  readonly id: string
  /** `null`: removed. */
  readonly rev: number | null
}

/** This PC's ideas as one client sees them. */
export interface IdeasTransport {
  /** Calls can go out now (the PC's connection is up); reactive. */
  readonly ready: () => boolean
  /** This connection may write (a gateway device needs the `prompt` scope); reactive. */
  readonly writable: () => boolean
  list(): Promise<readonly Idea[]>
  put(input: IdeaPut): Promise<PutResult>
  remove(id: string, baseRev: number): Promise<RemoveResult>
  /** `changed` gets an idea another client saved or removed. */
  watch(changed: (change: IdeaChange) => void): () => void
}

/** What a write did, for the screen: `error` keeps the user's input where it is. */
export type WriteOutcome =
  | { readonly type: "ok"; readonly idea: Idea }
  | { readonly type: "conflict"; readonly current: Idea | null }
  | { readonly type: "limit"; readonly max: number }
  | { readonly type: "error"; readonly message: string }

export type RemoveOutcome =
  | { readonly type: "ok"; readonly removed: Idea }
  | { readonly type: "conflict"; readonly current: Idea | null }
  | { readonly type: "error"; readonly message: string }

export type IdeasStore = ReturnType<typeof createIdeas>

export function createIdeas(transport: IdeasTransport) {
  const [state, setState] = createStore({
    status: "loading" as "loading" | "ready" | "error",
    error: undefined as string | undefined,
    ideas: [] as Idea[],
  })
  let loading: Promise<void> | undefined

  /** The PC's list again (first use, another client's change, a reconnect). */
  function load() {
    loading ??= transport
      .list()
      .then(
        (ideas) =>
          batch(() => {
            setState("ideas", reconcile([...ideas], { key: "id" }))
            setState({ status: "ready", error: undefined })
          }),
        (error: unknown) => {
          // A failed refresh keeps the board it has; only a first load shows the error.
          if (state.status !== "ready") setState({ status: "error", error: message(error) })
        },
      )
      .finally(() => (loading = undefined))
    return loading
  }

  function known(id: string) {
    return state.ideas.find((idea) => idea.id === id)
  }

  /** The stored idea replaces this window's copy (`null`: it is gone). */
  function settle(id: string, idea: Idea | null) {
    if (idea === null) return setState("ideas", (ideas) => ideas.filter((item) => item.id !== id))
    if (known(id)) return setState("ideas", (item) => item.id === id, reconcile(idea))
    setState("ideas", (ideas) => [...ideas, idea])
  }

  async function write(input: IdeaPut): Promise<WriteOutcome> {
    const result = await transport
      .put(input)
      .catch((error: unknown) => ({ type: "error" as const, message: message(error) }))
    if (result.type === "ok") settle(result.idea.id, result.idea)
    if (result.type === "conflict") settle(input.id, result.current)
    return result
  }

  return {
    state,
    writable: transport.writable,
    load,
    /** Reads the list unless it is there already. */
    ensure() {
      if (state.status !== "ready" && transport.ready()) void load()
    },
    /** A new idea (yellow unless `color`), on top of the board. */
    add(text: string, color?: Idea["color"]) {
      return write({ id: crypto.randomUUID(), text, ...(color ? { color } : {}), baseRev: 0 })
    },
    /**
     * Saves a change. A color or pin change that finds a newer idea goes out once more on top of it; a text edit
     * returns the conflict with the newer idea for the user to decide.
     */
    async edit(
      id: string,
      patch: { readonly text?: string; readonly color?: Idea["color"]; readonly pinned?: boolean },
      baseRev?: number,
    ) {
      const rev = baseRev ?? known(id)?.rev
      if (rev === undefined) return { type: "conflict", current: null } satisfies WriteOutcome
      const result = await write({ id, ...patch, baseRev: rev })
      if (result.type !== "conflict" || patch.text !== undefined || result.current === null) return result
      return write({ id, ...patch, baseRev: result.current.rev })
    },
    async remove(id: string): Promise<RemoveOutcome> {
      const idea = known(id)
      if (!idea) return { type: "conflict", current: null }
      const removed = { ...idea }
      const result = await transport
        .remove(id, idea.rev)
        .catch((error: unknown) => ({ type: "error" as const, message: message(error) }))
      if (result.type === "error") return result
      if (result.type === "conflict") {
        settle(id, result.current)
        return result
      }
      settle(id, null)
      return { type: "ok", removed }
    },
    /** `되돌리기` of a removal: the same idea again, in its old place on the board. */
    restore(idea: Idea) {
      return write({
        id: idea.id,
        text: idea.text,
        color: idea.color,
        pinned: idea.pinned,
        createdAt: idea.createdAt,
        baseRev: 0,
      })
    },
    /** Starts watching; returns the stop. */
    watch() {
      const unwatch = transport.watch((change) => {
        if (state.status !== "ready") return
        const rev = known(change.id)?.rev
        // An echo of this window's own write, or a removal of an idea it does not have.
        if (change.rev !== null && rev !== undefined && change.rev <= rev) return
        if (change.rev === null && rev === undefined) return
        void load()
      })
      const stop = createRoot((dispose) => {
        createEffect(
          on(transport.ready, (ready, was) => {
            if (!ready) return
            if (state.status !== "ready") return void load()
            // Back after a drop: what changed meanwhile.
            if (was === false) void load()
          }),
        )
        return dispose
      })
      return () => {
        unwatch()
        stop()
      }
    },
  }
}

/** own.accounts `ideas.*` of this PC (02 §9.2) through the local runtime; writing needs the `prompt` scope. */
export function serviceTransport(runtime: Pick<ServerRuntime, "rpc" | "own" | "connection">): IdeasTransport {
  return {
    ready: () => runtime.connection.status() === "connected",
    writable: () => runtime.rpc.allowed("ideas.put"),
    list: () => runtime.rpc.call("ideas.list", {}).then((result) => result.ideas),
    put: (input) =>
      runtime.rpc.call("ideas.put", input).then(
        (idea): PutResult => ({ type: "ok", idea }),
        (error: unknown) => refused(error),
      ),
    remove: (id, baseRev) =>
      runtime.rpc.call("ideas.remove", { id, baseRev }).then(
        (): RemoveResult => ({ type: "ok" }),
        (error: unknown) => {
          const result = refused(error)
          if (result.type === "conflict") return result
          throw error
        },
      ),
    watch: (changed) => runtime.own.on("ideas.changed", (event) => changed({ id: event.data.id, rev: event.data.rev })),
  }
}

/** The declared refusals of a write; anything else (the connection, the scope) stays an error. */
function refused(error: unknown): Exclude<PutResult, { type: "ok" }> {
  if (!(error instanceof OwnRpcError)) throw error
  // SAFETY: own.accounts declares these errors' data (`{current: Idea | null}`, `{max}`) and encodes it with that schema.
  if (error.type === "idea_conflict")
    return { type: "conflict", current: (error.data as { current: Idea | null }).current }
  if (error.type === "ideas_limit") return { type: "limit", max: (error.data as { max: number }).max }
  throw error
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const stores = new Map<ServerRuntime, IdeasStore>()

/** The window's store of this runtime's ideas, created and watched on first use, kept for the window's life. */
export function ideasOf(runtime: ServerRuntime) {
  const existing = stores.get(runtime)
  if (existing) return existing
  const store = createRoot(() => createIdeas(serviceTransport(runtime)))
  store.watch()
  stores.set(runtime, store)
  return store
}

// MCP servers of one Location (03 §18.14). MCP servers run per Location (`packages/core/src/mcp/index.ts`), so
// everything here is keyed by a project directory — never the control location, which would start a second copy of
// every global MCP server (01 §20 Q9).
// The list is createData's per-Location resource (`data.location.mcp.server`, reused as is): it already refetches
// once per burst of `mcp.status.changed` (150 ms settle), so the settings page, the Ctrl+; dialog and the server
// panel share one request and nothing polls (R9). `data.location.config` gives each server's `codemode`.
// Sign-in progress follows `mcp.status.changed` / `integration.updated` events and window focus, plus one timer for
// the attempt's expiry. The error text of own's servers (SM-22) is never core's own, which may quote a stored value:
// the caller gives own.accounts' masked text (`mcp.list` with the project's folder, read again when `failures`
// changes), and an own server's text it does not give is not shown.
import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import type { OwnHost } from "@/host"
import { withOwnErrors, type OwnErrors } from "./manage-model"
import { codeModeOf, sameLocation, toRows, type McpRow } from "./model"
import { beginMcpSignIn, McpSignInError, type McpSignIn, type McpSignInFailure } from "./oauth"

export type SignInPhase = "starting" | "waiting" | "done" | "failed" | "expired"

export interface SignInState {
  readonly server: string
  readonly phase: SignInPhase
  /** The authorization page (a link in case the browser did not open); cleared once the attempt ends. */
  readonly url?: string
  readonly refused?: McpSignInFailure
  readonly message?: string
}

export interface McpState {
  loading: boolean
  error?: string
  /** Servers with a connect/disconnect in flight. */
  busy: Record<string, boolean>
  /** Last toggle failure, per server. */
  failure: Record<string, string | undefined>
  signIn?: SignInState
}

export function createMcpServers(input: {
  readonly runtime: () => ServerRuntime | undefined
  /** The project Location; `undefined` shows the "open a project" state. */
  readonly directory: () => string | undefined
  readonly host: Pick<OwnHost, "openExternal">
  /** `codemode` of servers no config file names (own's, 설정 > MCP 서버), over the config files' own. */
  readonly codemode?: () => Readonly<Record<string, boolean>>
  /** own's servers in this project and own.accounts' masked error text of them (`mcp.list` `errors`). */
  readonly own?: () => OwnErrors | undefined
}) {
  const [state, setState] = createStore<McpState>({ loading: false, busy: {}, failure: {} })
  let token = 0
  let attempt: McpSignIn | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined

  const location = () => {
    const directory = input.directory()
    return directory ? { directory } : undefined
  }
  const listed = createMemo(() => {
    const runtime = input.runtime()
    const ref = location()
    return runtime && ref ? runtime.data.location.mcp.server.list(ref) : undefined
  })
  // Reconciled by name: a status change updates its row in place, so rows (and a focused switch) are not recreated.
  const [rows, setRows] = createStore<McpRow[]>([])
  createEffect(() => {
    const runtime = input.runtime()
    const ref = location()
    const next =
      runtime && ref
        ? toRows(listed() ?? [], {
            ...codeModeOf(runtime.data.location.config.list(ref) ?? []),
            ...input.codemode?.(),
          })
        : []
    const own = input.own?.()
    setRows(reconcile(own ? withOwnErrors(next, own) : next, { key: "name" }))
  })

  async function load(fresh = false) {
    const runtime = input.runtime()
    const ref = location()
    if (!runtime || !ref) return
    const current = ++token
    if (fresh) runtime.data.location.mcp.server.invalidate(ref)
    setState({ loading: true, error: undefined })
    const config = runtime.data.location.config.sync(ref).catch(() => undefined)
    try {
      await runtime.data.location.mcp.server.sync(ref)
      await config
      if (current === token) setState("loading", false)
    } catch (error) {
      if (current === token) setState({ loading: false, error: message(error) })
    }
  }

  createEffect(
    on([input.runtime, input.directory], ([runtime, directory]) => {
      token++
      clearSignIn()
      setState({ loading: false, error: undefined, busy: {}, failure: {} })
      if (!runtime || !directory) return
      void load()
      const stops = [
        runtime.bus.on("mcp.status.changed", (event) => {
          if (sameLocation(event, directory) && attempt?.server === event.data.server) void check()
        }),
        runtime.bus.on("integration.updated", (event) => {
          if (sameLocation(event, directory) && attempt) void check()
        }),
        // After a reconnect the cached list may be stale (statuses changed while the stream was down).
        runtime.bus.on("server.connected", () => void load(true)),
      ]
      onCleanup(() => stops.forEach((stop) => stop()))
    }),
  )

  async function setEnabled(name: string, enabled: boolean) {
    const runtime = input.runtime()
    const ref = location()
    if (!runtime || !ref || state.busy[name]) return
    setState("busy", name, true)
    setState("failure", name, undefined)
    try {
      // This PC's service keeps the switch per project (own.accounts `mcp.enable`, SM): it survives a restart. An SSH
      // host, or a connection without the scope, switches the running server only (core, until restart).
      if (keeps(runtime)) await runtime.rpc.call("mcp.enable", { directory: ref.directory, name, enabled })
      else if (enabled) await runtime.client().mcp.connect({ server: name, location: ref })
      else await runtime.client().mcp.disconnect({ server: name, location: ref })
    } catch (error) {
      setState("failure", name, message(error))
    } finally {
      setState("busy", name, false)
      void load(true)
    }
  }

  /** `되돌리기` of a row's tag (SG): deletes the kept switch at `directory` (the global one without it). */
  async function reset(name: string, directory: string | undefined) {
    const runtime = input.runtime()
    if (!runtime || state.busy[name] || !keeps(runtime)) return
    setState("busy", name, true)
    setState("failure", name, undefined)
    try {
      await runtime.rpc.call("mcp.enable", { ...(directory === undefined ? {} : { directory }), name, enabled: null })
    } catch (error) {
      setState("failure", name, message(error))
    } finally {
      setState("busy", name, false)
      void load(true)
    }
  }

  async function signIn(name: string) {
    const runtime = input.runtime()
    const directory = input.directory()
    if (!runtime || !directory) return
    clearSignIn()
    setState("signIn", { server: name, phase: "starting" })
    try {
      const started = await beginMcpSignIn({ client: runtime.client(), directory, server: name })
      if (state.signIn?.server !== name || state.signIn.phase !== "starting")
        return void started.cancel().catch(() => undefined)
      attempt = started
      setState("signIn", { server: name, phase: "waiting", url: started.url })
      input.host.openExternal(started.url)
      expiry = setTimeout(() => void check(), Math.max(0, started.expires - Date.now()) + 1_000)
    } catch (error) {
      if (state.signIn?.server !== name) return
      setState("signIn", {
        server: name,
        phase: "failed",
        refused: error instanceof McpSignInError ? error.reason : undefined,
        message: error instanceof McpSignInError ? undefined : message(error),
      })
      void load(true)
    }
  }

  async function check() {
    const current = attempt
    if (!current) return
    const result = await current.status().catch(() => undefined)
    if (!result || attempt !== current || result.status === "pending") return
    attempt = undefined
    clearTimeout(expiry)
    const server = current.server
    if (result.status === "complete") setState("signIn", { server, phase: "done" })
    else if (result.status === "expired") setState("signIn", { server, phase: "expired" })
    else setState("signIn", { server, phase: "failed", message: result.message })
    void load(true)
  }

  function clearSignIn() {
    const current = attempt
    attempt = undefined
    clearTimeout(expiry)
    if (current) void current.cancel().catch(() => undefined)
    setState("signIn", undefined)
  }

  // Coming back from the browser: look once (no polling).
  const onFocus = () => {
    if (attempt) void check()
  }
  window.addEventListener("focus", onFocus)
  onCleanup(() => {
    window.removeEventListener("focus", onFocus)
    token++
    clearSignIn()
  })

  return {
    state,
    rows: () => rows,
    /**
     * Which servers failed with which of core's texts: what own.accounts' masked text is read again on. Compared
     * only, never shown.
     */
    failures: () =>
      (listed() ?? [])
        .flatMap((server) => ("error" in server.status ? [JSON.stringify([server.name, server.status.error])] : []))
        .join("\n"),
    directory: input.directory,
    /** The list has been fetched for this Location (possibly empty). */
    loaded: () => listed() !== undefined,
    refresh: () => void load(true),
    setEnabled: (name: string, enabled: boolean) => void setEnabled(name, enabled),
    reset: (name: string, directory: string | undefined) => void reset(name, directory),
    signIn: (name: string) => void signIn(name),
    checkSignIn: () => void check(),
    /** Closes the sign-in dialog; a pending attempt is cancelled on the server. */
    closeSignIn: clearSignIn,
  }
}

export type McpServers = ReturnType<typeof createMcpServers>

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Whether the list's switch is kept across restarts on this server (03 §18.14, SM): this PC's service with the scope. */
export function keeps(runtime: Pick<ServerRuntime, "kind" | "rpc">) {
  return runtime.kind !== "ssh" && runtime.rpc.allowed("mcp.enable")
}

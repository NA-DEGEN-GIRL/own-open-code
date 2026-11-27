// Computer use state in own-web (01 §10.2, 03 §5.7 실험, §4.4):
// - ComputerStore: the window's one adapter of `own.computer` (like RemoteStore for `own.remote`). `status` is asked
//   only once something needs it (`ensure`: the session `⋯` opens, a session whose rules turn computer use on is shown,
//   a settings page), then again on every local `server.connected`; `status` events keep it current and `action`
//   events drive the header's activity indicator (no polling). Not asking at startup matters: a service without the
//   plugin answers 400 (`rpc.unavailable`), which the browser logs as a failed resource in every window. Every
//   Location's plugin instance republishes the same notice, so `status` replaces and `action` is keyed by (session,
//   tool, time). Stop, reset, helper restart, grant revoke and the audit list are calls.
// - `computerUseOf(rules)`: the per-session switch's state (switch.ts) read from the session's rules in createData,
//   so the header and menu follow `session.permissions` without a request.
// - `sessionVision(runtime, sessionID)`: whether the session's model reads images (computer use needs one, the plugin
//   refuses every call on a text-only model with `no_vision`), from the model catalog.
import type { PermissionRule } from "@opencode/client"
import type { Approval } from "@own/protocol"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { modelInput } from "@/attachments/model"
import type {
  ComputerAction,
  ComputerEvent,
  ComputerInput,
  ComputerMethod,
  ComputerRpc,
  ComputerStatus,
  ServerRuntime,
} from "@/data"
import { computerEvent } from "@/data/computer-rpc"
import type { EventBus } from "@/data/events"
import { wildcardMatch } from "@/policy/browser"
import { modelInfo } from "@/switcher/labels"

/** How long the header shows "PC 조작 중" after the session's last action. */
export const ACTIVE_MS = 8_000
const SEEN_LIMIT = 256

/** The consent rule own.accounts writes (`SessionApproval.COMPUTER_ALLOW`). */
export const COMPUTER_ALLOW: PermissionRule = { action: "computer", resource: "*", effect: "allow" }

/** own.accounts `computerUseOf`: `on` only when the last rule whose action matches `computer` is exactly the allow. */
export function computerUseOf(rules: readonly PermissionRule[] | undefined): Approval.ComputerUse {
  const last = (rules ?? []).findLast((rule) => wildcardMatch("computer", rule.action))
  return last?.action === COMPUTER_ALLOW.action && last.resource === "*" && last.effect === "allow" ? "on" : "off"
}

/**
 * Whether the session's model reads images (`capabilities.input`): the own binding's model, else the session's, looked
 * up in the model catalog. `undefined` while the model or the catalog is not known.
 */
export function sessionVision(runtime: ServerRuntime, sessionID: string) {
  const session = runtime.data.session.get(sessionID)
  const ref = runtime.own.state.binding[sessionID]?.model ?? session?.model
  const info = ref ? modelInfo(runtime, ref, session?.location.directory) : undefined
  return info ? modelInput(info.capabilities).image : undefined
}

/**
 * - `idle`: not asked yet (nothing needed it); `loading`: the first `status` is on its way;
 * - `ready`: `status` answered (it may still say `available: false` with a reason);
 * - `missing`: the RPC is not there or not reachable (no plugin in the config, an older service, a gateway device).
 */
export type ComputerLoad = "idle" | "loading" | "ready" | "missing"

export interface ComputerState {
  load: ComputerLoad
  status: ComputerStatus | undefined
  /** The error type of the last failed `status` (`missing`). */
  error: string | undefined
  /** Last action per session. */
  last: Record<string, ComputerAction | undefined>
  /** Sessions that acted within {@link ACTIVE_MS}. */
  active: Record<string, boolean | undefined>
}

export interface ComputerStoreInput {
  readonly data: {
    readonly computer: ComputerRpc
    local(): { readonly bus: Pick<EventBus, "listen">; readonly connection: { status(): string } }
  }
  /** Tests shorten the activity window. */
  readonly activeMs?: number
}

export function createComputerStore(input: ComputerStoreInput) {
  const rpc = input.data.computer
  const local = input.data.local()
  const activeMs = input.activeMs ?? ACTIVE_MS
  const [state, setState] = createStore<ComputerState>({
    load: "idle",
    status: undefined,
    error: undefined,
    last: {},
    active: {},
  })
  const seen = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<(action: ComputerAction) => void>()
  // A `status` event is newer than a `status` call still on its way.
  let token = 0
  // Something asked for `status`: every later `server.connected` asks again.
  let wanted = false

  async function load() {
    wanted = true
    const mine = ++token
    if (state.load !== "ready") setState("load", "loading")
    try {
      const status = await rpc.call("status", {})
      if (mine === token) setState({ load: "ready", status, error: undefined })
    } catch (error) {
      if (mine === token) setState({ load: "missing", status: undefined, error: errorType(error) })
    }
  }

  function apply(event: ComputerEvent) {
    if (event.name === "status") {
      wanted = true
      token++
      setState({ load: "ready", status: event.data, error: undefined })
      return
    }
    const action = event.data
    const key = `${action.sessionID}\u0000${action.tool}\u0000${action.at}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!)
    setState("last", action.sessionID, action)
    setState("active", action.sessionID, true)
    clearTimeout(timers.get(action.sessionID))
    timers.set(
      action.sessionID,
      setTimeout(() => {
        timers.delete(action.sessionID)
        setState("active", action.sessionID, false)
      }, activeMs),
    )
    listeners.forEach((listener) => listener(action))
  }

  /** Asks `status` now if the local stream is up, else when it connects. */
  function refresh() {
    wanted = true
    if (local.connection.status() === "connected") void load()
  }

  const patch = (fields: Partial<ComputerStatus>) => {
    if (state.status?.available) setState("status", { ...state.status, ...fields })
  }

  const stop = local.bus.listen((raw) => {
    if (raw.type === "server.connected") {
      if (wanted) void load()
      return
    }
    // Plugins load in the background since upstream v2.4.0 (#63814): own.computer may register after the first read.
    if (raw.type === "plugin.updated") {
      if (wanted && state.load === "missing") void load()
      return
    }
    const event = computerEvent(raw)
    if (event) apply(event)
  })

  return {
    state,
    /** `status` said the plugin can drive this desktop. Everything in the session UI is gated on it. */
    available: () => state.status?.available === true,
    allowed: (method: ComputerMethod) => rpc.allowed(method),
    refresh,
    /** {@link refresh} once, when nothing has asked yet. */
    ensure() {
      if (state.load === "idle") refresh()
    },
    async engage() {
      patch({ killSwitch: await rpc.call("killswitch.engage", {}) })
    },
    async reset() {
      patch({ killSwitch: await rpc.call("killswitch.reset", {}) })
    },
    async restartHelper() {
      patch({ helper: await rpc.call("helper.restart", {}) })
    },
    /** Removes `apps` (default: all) from the apps a session approved (`question` mode). */
    async revoke(sessionID: ComputerInput<"session.grants.revoke">["sessionID"], apps?: readonly string[]) {
      const result = await rpc.call("session.grants.revoke", { sessionID, ...(apps ? { apps: [...apps] } : {}) })
      const others = (state.status?.grants ?? []).filter((grant) => grant.sessionID !== sessionID)
      patch({ grants: result.apps.length ? [...others, result] : others })
    },
    async audit(query: ComputerInput<"audit.list">) {
      return (await rpc.call("audit.list", query)).entries
    },
    /** `action` events after de-duplication (the panel refreshes its audit list). */
    onAction(listener: (action: ComputerAction) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    dispose() {
      stop()
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
      listeners.clear()
    },
  }
}

export type ComputerStore = ReturnType<typeof createComputerStore>

function errorType(error: unknown) {
  if (typeof error === "object" && error !== null && "type" in error && typeof error.type === "string")
    return error.type
  return error instanceof Error ? error.name : "unknown"
}

// ---- The window's store and the dialog request, without a shared provider (like src/servers/active.ts). ----

export interface ComputerDialogRequest {
  readonly sessionID: string
}

const registry = createRoot(() => {
  const [store, setStore] = createSignal<ComputerStore>()
  const [dialog, setDialog] = createSignal<ComputerDialogRequest>()
  return { store, setStore, dialog, setDialog }
})

/** The ComputerStore of this window, once `<ComputerLayer />` created it (`undefined` in tests and other windows). */
export const computerStore = registry.store

export function registerComputerStore(store: ComputerStore) {
  registry.setStore(() => store)
  return () => {
    if (registry.store() === store) registry.setStore(undefined)
  }
}

export const computerDialog = registry.dialog

export function openComputerDialog(request: ComputerDialogRequest) {
  registry.setDialog(request)
}

export function closeComputerDialog() {
  registry.setDialog(undefined)
}

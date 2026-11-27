// Per-thread approval mode (03 §18.8, 4.4 알약, 5.1). own.accounts is the only writer of session rules: it builds the
// rule bundles (`resource:"**"` deny/ask/allow + protected-path denies, never `resource:"*"`, so tools stay listed and
// the cached prefix survives, 01 §17.1 #9) and PATCHes the parent and its unfinished children. own-web only calls
// `session.approval.get/set` and shows the result; it never writes `permissions` itself (boundaries.test.ts).
import type { Approval } from "@own/protocol"
import { createEffect, createRoot, createSignal, on, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { BROWSER_ATTACH_ALLOW, sameRule } from "@/policy/browser"

export type SetMode = Approval.SetMode

export const MODES: readonly SetMode[] = ["read-only", "ask", "full"]

export type ApprovalView =
  | { readonly status: "idle" | "loading" }
  /**
   * `mode: custom` with no rules runs on the agent's default rules: for build nothing asks but `.env` reads, and the
   * protected paths are not denied (03 §5.1 `기본 규칙`).
   */
  | { readonly status: "ready"; readonly mode: Approval.Mode; readonly rules: number; readonly children: number }
  /** The router did not answer: the session runs on core's default rules (03 §5.1). */
  | { readonly status: "unavailable" }

export type ModeLabel = SetMode | "default" | "custom"

export function modeLabel(view: ApprovalView): ModeLabel | undefined {
  if (view.status === "unavailable") return "default"
  if (view.status !== "ready") return undefined
  if (view.mode !== "custom") return view.mode
  return view.rules === 0 ? "default" : "custom"
}

/**
 * How many of the session's rules someone chose. The browser plugin's attachment allow (upstream 82bb5ff88a) is not
 * one: a session with only it still runs on core's default rules.
 */
export function chosenRules(rules: Approval.State["rules"]) {
  return rules.filter((rule) => !sameRule(rule, BROWSER_ATTACH_ALLOW)).length
}

/** Shared catalog keys of 03 §14 for the three modes. */
export const MODE_KEY = {
  "read-only": "own.approval.readOnly",
  ask: "own.approval.ask",
  full: "own.approval.full",
} as const satisfies Record<SetMode, string>

export function createApprovalState(input: {
  readonly runtime: () => ServerRuntime | undefined
  readonly sessionID: () => string | undefined
}) {
  const [view, setView] = createSignal<ApprovalView>({ status: "idle" })
  const [pending, setPending] = createSignal<SetMode>()
  const directory = () => {
    const runtime = input.runtime()
    const id = input.sessionID()
    if (!runtime || !id) return undefined
    return runtime.data.session.get(id)?.location.directory ?? runtime.sessions.directory(id)
  }
  const connected = () => input.runtime()?.connection.status() === "connected"
  let token = 0

  async function load() {
    const runtime = input.runtime()
    const sessionID = input.sessionID()
    const location = directory()
    if (!runtime || !sessionID || location === undefined || !connected()) return
    // A session this window is creating: the router answers once it exists (`session.created` below; the creator
    // writes the mode right after, which also sends `approval.changed`).
    if (runtime.data.session.creating(sessionID)) return
    const mine = ++token
    if (untrack(view).status !== "ready") setView({ status: "loading" })
    try {
      const state = await runtime.rpc.call("session.approval.get", { sessionID }, { directory: location })
      if (mine !== token) return
      setView({ status: "ready", mode: state.mode, rules: chosenRules(state.rules), children: state.children.open })
    } catch (error) {
      if (mine !== token) return
      console.error("[own-web] session.approval.get failed", error)
      setView({ status: "unavailable" })
    }
  }

  createEffect(
    on([input.sessionID, () => directory() !== undefined, connected], () => {
      token++
      setView({ status: "idle" })
      void load()
    }),
  )
  createEffect(() => {
    const runtime = input.runtime()
    if (!runtime) return
    // Another window (or this one) set the mode: take it from the event, then re-read the child count.
    onCleanup(
      runtime.own.on("approval.changed", (event) => {
        const id = untrack(input.sessionID)
        if (!id || (event.data.sessionID !== id && !event.data.patched.some((patched) => patched === id))) return
        void load()
      }),
    )
    // Someone else changed the session's rules (another client, a plugin): the mode may now read `custom`.
    onCleanup(
      runtime.bus.on("session.permissions", (event) => {
        if (event.data.sessionID === untrack(input.sessionID)) void load()
      }),
    )
    onCleanup(
      runtime.bus.on("session.created", (event) => {
        if (event.data.sessionID === untrack(input.sessionID)) void load()
      }),
    )
  })

  return {
    view,
    label: () => modeLabel(view()),
    /** The mode being written, for the menu's busy state. */
    pending,
    reload: load,
    /**
     * `admin` scope (02 §9.1): gateway devices without it see the mode but cannot change it. With a mode, whether this
     * connection may pick that one: `prompt` devices pick every mode (MUX-15, OwnRouting.scopeOf).
     */
    allowed: (mode?: SetMode) =>
      input.runtime()?.rpc.allowed("session.approval.set", mode && { sessionID: input.sessionID() ?? "", mode }) ??
      false,
    async set(mode: SetMode) {
      const runtime = input.runtime()
      const sessionID = input.sessionID()
      const location = directory()
      if (!runtime || !sessionID || location === undefined) throw new Error("no session")
      setPending(mode)
      try {
        const result = await runtime.rpc.call("session.approval.set", { sessionID, mode }, { directory: location })
        token++
        setView((current) => ({
          status: "ready",
          mode: result.mode,
          rules: current.status === "ready" ? Math.max(current.rules, 1) : 1,
          children: Math.max(0, result.patched.length - 1),
        }))
        return { mode: result.mode, children: Math.max(0, result.patched.length - 1) }
      } finally {
        setPending(undefined)
      }
    },
  }
}

export type ApprovalState = ReturnType<typeof createApprovalState>

const NEW_SESSION_KEY = "own.web.approval.newSession"

/**
 * 설정 > 승인·권한 "새 세션의 기본 승인 모드" (03 §5.7, §5.1): per window (localStorage), `묻기` when unset or
 * unreadable. The composer writes it with `session.approval.set` before the first prompt of a session it creates.
 */
export const newSessionApproval = createRoot(() => {
  const [value, setValue] = createSignal<SetMode>(readNewSession())
  return {
    value,
    set(next: SetMode) {
      setValue(next)
      try {
        localStorage.setItem(NEW_SESSION_KEY, next)
      } catch {}
    },
  }
})

function readNewSession(): SetMode {
  try {
    const stored = localStorage.getItem(NEW_SESSION_KEY)
    return stored === "read-only" || stored === "full" ? stored : "ask"
  } catch {
    return "ask"
  }
}

/** Menu/confirm flow shared by the pill and the settings page: `전체 허용` needs one confirmation (03 §18.8). */
export function createModeChoice(apply: (mode: SetMode) => Promise<unknown> | void) {
  const [state, setState] = createStore({ confirming: false })
  return {
    confirming: () => state.confirming,
    choose(mode: SetMode) {
      if (mode === "full") return void setState("confirming", true)
      setState("confirming", false)
      return apply(mode)
    },
    confirm() {
      setState("confirming", false)
      return apply("full")
    },
    cancel: () => setState("confirming", false),
  }
}

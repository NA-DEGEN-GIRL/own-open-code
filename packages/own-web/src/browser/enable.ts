// Rule 3 of the browser tool policy (03 §18.15, 05 §8.7, 01 §10.1): a session created without the browser tools (rule
// 1, the `{action:"browser", resource:"*", effect:"deny"}` a pane-less window adds at creation) gets them back only
// through an explicit per-session action, never because it was opened in the desktop app (rule 2: no silent flip).
//
// Who writes: 03 §16.3 makes the router the only writer of session rules and own-web may not PATCH `permissions`
// (boundaries.test.ts). The write is own.accounts `session.approval.set{sessionID, mode:<current mode>,
// browserTool:"on"}` (v0.5): read-merge-write that removes only the creation deny, for the session and its unfinished
// children, and keeps every other rule in order (approval bundle, "항상 허용" answers, a `browser` deny someone wrote
// on purpose, protected paths). Its `browserTool` is the state after the write. `session.approval.get` reports the
// mode `set` needs and `browserTool` (absent before v0.5). The effect on the prompt cache is one catalog replacement
// appended after the session's history (core session/instruction-state.ts); the earlier prefix stays.
//
// The pane (index.tsx `Removed`) and the conversation's notice (policy/notice.tsx) offer "이 대화에서 켜기" only when a
// writer is registered for the server (attach.tsx, hosts with the pane) and the router can do it for this session.
// Otherwise — mode `custom` (`mode` is required), a service before v0.5, a connection without the `prompt` scope, no
// router answer, no writer — both say why in the same words (`reason`, policy `enableReasonKey`).
import type { PermissionRule } from "@opencode/client"
import type { Approval } from "@own/protocol"
import { createEffect, createMemo, createSignal } from "solid-js"
import type { EventBus } from "@/data/events"
import type { OwnStore } from "@/data/own-store"
import type { OwnRpc } from "@/data/rpc"
import { BROWSER_DENY, browserRemoved, sameRule } from "@/policy/browser"

/** A session's `permissions` as the data layer holds them. */
export type SessionRules = readonly PermissionRule[] | undefined

export type BrowserEnablePlan =
  | { readonly ok: true; readonly rules: PermissionRule[]; readonly removed: number }
  | { readonly ok: false; readonly reason: "not-removed" | "other-rule" }

const isCreationDeny = (rule: PermissionRule) => sameRule(rule, BROWSER_DENY)

/**
 * What the router's `browserTool:"on"` does to the session's rules (own.accounts `withBrowserTool`), locally: the
 * creation deny removed. `other-rule`: something else still removes the tool (a `brow*` or `*` deny someone wrote on
 * purpose), which the router never overrides, so the pane says so instead of offering the switch.
 */
export function planBrowserEnable(rules: SessionRules): BrowserEnablePlan {
  const current = [...(rules ?? [])]
  if (!browserRemoved(current)) return { ok: false, reason: "not-removed" }
  const next = current.filter((rule) => !isCreationDeny(rule))
  if (browserRemoved(next)) return { ok: false, reason: "other-rule" }
  return { ok: true, rules: next, removed: current.length - next.length }
}

/**
 * Why the router cannot switch this session's browser tools on (the pane and the notice say so instead):
 * - `custom`: the session's rules are not an own bundle, and `session.approval.set` needs a mode;
 * - `unsupported`: the service predates v0.5 (`session.approval.get` has no `browserTool`);
 * - `scope`: this connection may not turn the tool on with `session.approval.set` (`prompt` since MBR, 02 §9.1);
 * - `unavailable`: not connected, or the router did not answer.
 */
export type BrowserEnableBlock = "custom" | "unsupported" | "scope" | "unavailable"

export type BrowserEnableCheck =
  | { readonly ok: true; readonly mode: Approval.SetMode }
  | { readonly ok: false; readonly reason: BrowserEnableBlock }

export class BrowserEnableError extends Error {
  override readonly name = "BrowserEnableError"
  constructor(readonly reason: BrowserEnableBlock) {
    super(`browser tools cannot be switched on here: ${reason}`)
  }
}

export interface BrowserEnableWriter {
  /** Changes whenever the answer of `check` may have (router events, the connection): read it where `check` runs. */
  revision(): unknown
  /** Whether rule 3 can be applied to the session now. */
  check(sessionID: string): Promise<BrowserEnableCheck>
  /**
   * Applies rule 3 to the session (and its unfinished children) and resolves with its browser tools after the write:
   * `off` when another rule still removes them. Rejects with `BrowserEnableError` when `check` would say no.
   */
  enable(sessionID: string): Promise<Approval.BrowserTool>
}

/** The parts of a server runtime (src/data `ServerRuntime`) the router writer uses. */
export interface BrowserEnableRuntime {
  readonly rpc: Pick<OwnRpc, "call" | "allowed">
  readonly own: Pick<OwnStore, "on">
  readonly bus: Pick<EventBus, "on">
  readonly connection: { status(): string }
  readonly data: {
    readonly session: { invalidate(sessionID: string): void; sync(sessionID: string): Promise<unknown> }
  }
}

function verdict(state: Approval.State | undefined): BrowserEnableCheck {
  if (!state) return { ok: false, reason: "unavailable" }
  if (state.browserTool === undefined) return { ok: false, reason: "unsupported" }
  if (state.mode === "custom") return { ok: false, reason: "custom" }
  return { ok: true, mode: state.mode }
}

/** The writer over own.accounts `session.approval.get/set` of one server (03 §18.15 rule 3, §16.3). */
export function createRouterBrowserEnableWriter(runtime: BrowserEnableRuntime): BrowserEnableWriter & {
  dispose(): void
} {
  const [events, setEvents] = createSignal(0)
  const bump = () => setEvents((value) => value + 1)
  // A mode written from the pill or another window, or rules changed by another client: `custom` may have ended.
  const stops = [runtime.own.on("approval.changed", bump), runtime.bus.on("session.permissions", bump)]
  // With the input: turning the browser tool on needs `prompt`, where the bare method reads `admin` (MBR).
  const allowed = () => runtime.rpc.allowed("session.approval.set", { sessionID: "", mode: "ask", browserTool: "on" })
  const read = (sessionID: string) => runtime.rpc.call("session.approval.get", { sessionID })
  return {
    revision: () => `${runtime.connection.status()}:${events()}`,
    async check(sessionID) {
      if (!allowed()) return { ok: false, reason: "scope" }
      if (runtime.connection.status() !== "connected") return { ok: false, reason: "unavailable" }
      return verdict(await read(sessionID).catch(() => undefined))
    },
    async enable(sessionID) {
      if (!allowed()) throw new BrowserEnableError("scope")
      // The mode is read right before the write: `set` rewrites the bundle with it, so it must be the current one.
      const state = await read(sessionID)
      const answer = verdict(state)
      if (!answer.ok) throw new BrowserEnableError(answer.reason)
      const after =
        state.browserTool === "on"
          ? "on"
          : (await runtime.rpc.call("session.approval.set", { sessionID, mode: answer.mode, browserTool: "on" }))
              .browserTool
      if (!after) throw new BrowserEnableError("unsupported")
      if (after === "on") {
        // The router's PATCH arrives as `session.permissions`; reading the session again covers a missed event.
        runtime.data.session.invalidate(sessionID)
        void runtime.data.session.sync(sessionID).catch(() => undefined)
      }
      return after
    },
    dispose: () => stops.forEach((stop) => stop()),
  }
}

const [writers, setWriters] = createSignal<ReadonlyMap<string, BrowserEnableWriter>>(new Map())

/** The writer for a server's sessions; attach.tsx registers the router writer on hosts with the pane. */
export function setBrowserEnableWriter(serverKey: string, writer: BrowserEnableWriter | undefined) {
  const map = new Map(writers())
  if (writer) map.set(serverKey, writer)
  else map.delete(serverKey)
  setWriters(map)
}

export function browserEnableWriter(serverKey: string): BrowserEnableWriter | undefined {
  return writers().get(serverKey)
}

/**
 * What the pane shows under "이 세션은 브라우저 도구 없이 시작했습니다":
 * - `new-session`: no switch here (`reason` says why);
 * - `checking`: asking the router (nothing yet, so the note does not flash before the button);
 * - `offer` → `confirm` (the cache note, 03 §18.15) → `busy` → `done` (the pane replaces this once the rules land);
 * - `blocked`: another rule keeps the tools off ("다른 규칙이 … 막고 있습니다"), before or after the write.
 */
export type BrowserEnableView = "new-session" | "checking" | "offer" | "confirm" | "busy" | "blocked" | "done"

/**
 * Why the switch is not offered, said the same way by the pane and the conversation's notice: the router's
 * `BrowserEnableBlock`, `elsewhere` (no writer serves this server: an SSH host, a window without the pane) or `blocked`
 * (another rule keeps the tools off).
 */
export type BrowserEnableReason = BrowserEnableBlock | "elsewhere" | "blocked"

type Step = "idle" | "confirm" | "busy" | "blocked" | "done"

export function createBrowserEnable(input: {
  readonly writer: () => BrowserEnableWriter | undefined
  readonly sessionID: () => string
  readonly rules: () => SessionRules
}) {
  const [step, setStep] = createSignal<Step>("idle")
  const [failed, setFailed] = createSignal(false)
  const [answer, setAnswer] = createSignal<BrowserEnableCheck>()
  let token = 0
  let shown: string | undefined
  createEffect(() => {
    const writer = input.writer()
    const sessionID = input.sessionID()
    writer?.revision()
    if (sessionID !== shown) {
      shown = sessionID
      setAnswer(undefined)
      setStep("idle")
      setFailed(false)
    }
    const mine = ++token
    if (!writer) return
    void writer.check(sessionID).then(
      (result) => mine === token && setAnswer(result),
      () => mine === token && setAnswer({ ok: false, reason: "unavailable" }),
    )
  })
  const planned = createMemo(() => planBrowserEnable(input.rules()))
  const view = createMemo<BrowserEnableView>(() => {
    if (!input.writer()) return "new-session"
    const current = step()
    if (current === "done" || current === "blocked") return current
    const plan = planned()
    if (!plan.ok && plan.reason === "other-rule") return "blocked"
    const known = answer()
    if (!known) return "checking"
    if (!known.ok) return "new-session"
    return current === "idle" ? "offer" : current
  })
  const reason = createMemo<BrowserEnableReason | undefined>(() => {
    const current = view()
    if (current === "blocked") return "blocked"
    if (current !== "new-session") return undefined
    if (!input.writer()) return "elsewhere"
    const known = answer()
    return known && !known.ok ? known.reason : "unavailable"
  })
  return {
    view,
    /** With `new-session` or `blocked`: why (`BrowserEnableReason`). */
    reason,
    /** The last write failed (network, router error); the confirmation stays open for another try. */
    failed,
    ask() {
      if (view() !== "offer") return
      setFailed(false)
      setStep("confirm")
    },
    cancel() {
      if (step() === "confirm") setStep("idle")
    },
    async apply() {
      const writer = input.writer()
      if (!writer || view() !== "confirm") return
      const sessionID = input.sessionID()
      setStep("busy")
      setFailed(false)
      try {
        const after = await writer.enable(sessionID)
        if (sessionID === input.sessionID()) setStep(after === "on" ? "done" : "blocked")
      } catch (error) {
        if (sessionID !== input.sessionID()) return
        if (error instanceof BrowserEnableError) {
          // The session changed under the confirmation (e.g. its mode became `custom`): no switch any more.
          setAnswer({ ok: false, reason: error.reason })
          setStep("idle")
          return
        }
        setFailed(true)
        setStep("confirm")
      }
    },
  }
}

export type BrowserEnable = ReturnType<typeof createBrowserEnable>

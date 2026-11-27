// The per-session switch "이 세션에서 컴퓨터 사용" (01 §10.2, 03 §4.4; the dialog's chunk only). The write is own.accounts
// `session.approval.set{sessionID, mode:<current mode>, computerUse}`: session rules are written only by the router
// (03 §16.3). `on` puts `{computer, *, allow}` before the own bundle and is the consent the plugin re-checks on every
// call; the agent-wide `{computer, *, deny}` keeps the tools out of every other session's catalog. `mode` is required,
// so a `custom` session cannot be switched here (like the browser tool, src/browser/enable.ts).
import type { PermissionRule } from "@opencode/client"
import type { Approval } from "@own/protocol"
import { createEffect, createMemo, createSignal } from "solid-js"
import type { OwnRpc } from "@/data/rpc"
import { computerUseOf } from "./state"

/**
 * Why the switch cannot be used for this session:
 * - `custom`: its rules are not an own bundle, and `session.approval.set` needs a mode;
 * - `unsupported`: the service's own.accounts predates computer use (`session.approval.get` has no `computerUse`);
 * - `scope`: this connection may not call `session.approval.set` (`admin`, 02 §9.1);
 * - `unavailable`: not connected, or the router did not answer;
 * - `vision`: the session's model cannot see images (a text-only local model), so computer use cannot work; the plugin
 *   would refuse every call (`no_vision`). Only turning on is blocked: a session that has it on can still turn it off.
 */
export type ComputerSwitchBlock = "custom" | "unsupported" | "scope" | "unavailable" | "vision"

export type ComputerSwitchCheck =
  | { readonly ok: true; readonly mode: Approval.SetMode }
  | { readonly ok: false; readonly reason: ComputerSwitchBlock }

export class ComputerSwitchError extends Error {
  override readonly name = "ComputerSwitchError"
  constructor(readonly reason: ComputerSwitchBlock) {
    super(`computer use cannot be switched here: ${reason}`)
  }
}

/** The parts of a server runtime (src/data `ServerRuntime`) the switch uses. */
export interface ComputerSwitchRuntime {
  readonly rpc: Pick<OwnRpc, "call" | "allowed">
  readonly connection: { status(): string }
  readonly data: {
    readonly session: { invalidate(sessionID: string): void; sync(sessionID: string): Promise<unknown> }
  }
}

function verdict(state: Approval.State | undefined): ComputerSwitchCheck {
  if (!state) return { ok: false, reason: "unavailable" }
  if (state.computerUse === undefined) return { ok: false, reason: "unsupported" }
  if (state.mode === "custom") return { ok: false, reason: "custom" }
  return { ok: true, mode: state.mode }
}

/** The writer over own.accounts `session.approval.get/set{computerUse}` of the local server. */
export function createComputerSwitch(runtime: ComputerSwitchRuntime) {
  const allowed = () => runtime.rpc.allowed("session.approval.set")
  const read = (sessionID: string) => runtime.rpc.call("session.approval.get", { sessionID })
  return {
    async check(sessionID: string): Promise<ComputerSwitchCheck> {
      if (!allowed()) return { ok: false, reason: "scope" }
      if (runtime.connection.status() !== "connected") return { ok: false, reason: "unavailable" }
      return verdict(await read(sessionID).catch(() => undefined))
    },
    /**
     * Writes the switch for the session (and its unfinished children) and resolves with the session's state after
     * the write. Rejects with {@link ComputerSwitchError} when `check` would say no.
     */
    async set(sessionID: string, use: Approval.ComputerUse): Promise<Approval.ComputerUse> {
      if (!allowed()) throw new ComputerSwitchError("scope")
      // The mode is read right before the write: `set` rewrites the bundle with it, so it must be the current one.
      const state = await read(sessionID)
      const answer = verdict(state)
      if (!answer.ok) throw new ComputerSwitchError(answer.reason)
      const after =
        state.computerUse === use
          ? use
          : (await runtime.rpc.call("session.approval.set", { sessionID, mode: answer.mode, computerUse: use }))
              .computerUse
      if (!after) throw new ComputerSwitchError("unsupported")
      // The router's PATCH arrives as `session.permissions`; reading the session again covers a missed event.
      runtime.data.session.invalidate(sessionID)
      void runtime.data.session.sync(sessionID).catch(() => undefined)
      return after
    },
  }
}

export type ComputerSwitch = ReturnType<typeof createComputerSwitch>

/**
 * The dialog's switch:
 * - `checking`: asking the router whether the session can be switched;
 * - `blocked`: it cannot (`reason()`), the dialog explains why;
 * - `off` → `confirm` (consent text) → `busy` → `on`; `on` → `busy` → `off` (turning off needs no confirmation).
 * The state is the session's rules (`computerUseOf`), so another window's change shows at once; a finished write shows
 * its result until the rules catch up.
 */
export type ComputerToggleView = "checking" | "blocked" | "off" | "confirm" | "busy" | "on"

export function createComputerToggle(input: {
  readonly writer: () => ComputerSwitch | undefined
  readonly sessionID: () => string
  readonly rules: () => readonly PermissionRule[] | undefined
  /** Whether the session's model reads images (`sessionVision`); `undefined` while unknown, which blocks nothing. */
  readonly vision?: () => boolean | undefined
}) {
  const [answer, setAnswer] = createSignal<ComputerSwitchCheck>()
  const [step, setStep] = createSignal<"idle" | "confirm" | "busy">("idle")
  const [failed, setFailed] = createSignal(false)
  const [written, setWritten] = createSignal<Approval.ComputerUse>()
  let token = 0
  let shown: { readonly writer: ComputerSwitch | undefined; readonly sessionID: string } | undefined
  createEffect(() => {
    const writer = input.writer()
    const sessionID = input.sessionID()
    const mine = ++token
    // `check` reads the connection's status and scopes (the server entry), so a reconnect or a refreshed entry asks
    // again. Only another session or writer starts the dialog over: a re-check right after the page loaded closed the
    // open confirmation under the user's click (team.spec.ts, 2026-11-15).
    if (!shown || shown.writer !== writer || shown.sessionID !== sessionID) {
      setAnswer(undefined)
      setStep("idle")
      setFailed(false)
      setWritten(undefined)
    }
    shown = { writer, sessionID }
    if (!writer) return setAnswer({ ok: false, reason: "unavailable" })
    void writer.check(sessionID).then(
      (result) => mine === token && setAnswer(result),
      () => mine === token && setAnswer({ ok: false, reason: "unavailable" }),
    )
  })
  const current = createMemo(() => computerUseOf(input.rules()))
  createEffect(() => {
    if (written() === current()) setWritten(undefined)
  })
  const use = () => written() ?? current()
  const blind = () => use() === "off" && input.vision?.() === false
  const view = createMemo<ComputerToggleView>(() => {
    if (step() === "busy") return "busy"
    const known = answer()
    if (!known) return "checking"
    if (!known.ok || blind()) return "blocked"
    if (step() === "confirm") return "confirm"
    return use()
  })

  async function write(next: Approval.ComputerUse) {
    const writer = input.writer()
    if (!writer) return
    const sessionID = input.sessionID()
    setStep("busy")
    setFailed(false)
    try {
      const after = await writer.set(sessionID, next)
      if (sessionID !== input.sessionID()) return
      setWritten(after)
      setStep("idle")
    } catch (error) {
      if (sessionID !== input.sessionID()) return
      if (error instanceof ComputerSwitchError) {
        // The session changed under the dialog (e.g. its mode became `custom`).
        setAnswer({ ok: false, reason: error.reason })
        setStep("idle")
        return
      }
      setFailed(true)
      setStep(next === "on" ? "confirm" : "idle")
    }
  }

  return {
    view,
    /** The session's computer use as shown (the write's result until the rules land). */
    use,
    reason: (): ComputerSwitchBlock | undefined => {
      const known = answer()
      if (known && !known.ok) return known.reason
      return known && blind() ? "vision" : undefined
    },
    /** Computer use is on, but the session's model cannot see images: it does nothing until the model changes. */
    blind: () => use() === "on" && input.vision?.() === false,
    /** The last write failed (network, router error); the confirmation stays open for another try. */
    failed,
    /** The switch was flipped: `off` asks for consent first, `on` turns off at once. */
    flip() {
      if (view() === "on") return write("off")
      if (view() !== "off") return Promise.resolve()
      setFailed(false)
      setStep("confirm")
      return Promise.resolve()
    },
    cancel() {
      if (step() === "confirm") setStep("idle")
    },
    confirm() {
      return view() === "confirm" ? write("on") : Promise.resolve()
    },
  }
}

export type ComputerToggle = ReturnType<typeof createComputerToggle>

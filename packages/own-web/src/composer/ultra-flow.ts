// How an ultra change runs (07 §2.9), shared by the composer's `울트라 ○` switch and the effort menu's ultra row
// (2026-10-10: ultra is a mode, not an effort level, but users coming from Codex look for it among the levels). Every
// change asks `session.ultra.set{dryRun}` first and applies at once when the effort stays or changes on the
// effort-update path; otherwise the cost dialog shows the effort change and its cost first. The dialog renders in the
// ultra switch of the session it belongs to (`ask.sessionID`). Claude's `켤 때 강도도 xhigh로` tick is kept per
// conversation in this browser (UC 2026-10-18), so a reload does not drop it.
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { OwnRpcError, type ServerRuntime } from "@/data"
import type { OwnInput, OwnOutput } from "@/data/rpc"
import type { I18n } from "@/i18n"
import { ultraNeedsDialog } from "@/presets/session-view"
import type { useSubagentText } from "@/subagent/strings"
import { showToast } from "@/switcher/toast"

export interface UltraEnv {
  readonly runtime: ServerRuntime
  readonly i18n: I18n
  readonly text: ReturnType<typeof useSubagentText>
}

/** A dry run's answer waiting on the cost dialog, with the call that applies it. */
export interface UltraAsk {
  readonly sessionID: string
  readonly input: OwnInput<"session.ultra.set">
  readonly result: OwnOutput<"session.ultra.set">
  /** The main moved and ultra's effort for it waited for this dialog (`ultra.pending`). */
  readonly retuning: boolean
}

/** Where the ticked conversations are kept (localStorage, per viewer), the newest last. */
export const ULTRA_RAISE_KEY = "own.web.ultra.raise"

/** At most this many ticked conversations are kept; the oldest go first. */
const RAISE_MAX = 200

const flow = createRoot(() => {
  const [state, setState] = createStore({
    ask: undefined as UltraAsk | undefined,
    busy: {} as Record<string, boolean | undefined>,
    /**
     * Claude: `켤 때 강도도 xhigh로` ticked for a conversation, for whichever control turns ultra on (the switch, the
     * effort menu's row). Mirrors the session's `raiseClaude` while ultra is on and takes it back when it goes off.
     */
    raise: Object.fromEntries(readRaise().map((id) => [id, true])) as Record<string, boolean | undefined>,
  })
  return { state, setState }
})

export const ultraFlow = flow.state

export function setUltraRaise(sessionID: string, raise: boolean) {
  if (!!flow.state.raise[sessionID] === raise) return
  flow.setState("raise", sessionID, raise)
  const kept = readRaise().filter((id) => id !== sessionID)
  writeRaise(raise ? [...kept, sessionID] : kept)
}

function readRaise(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ULTRA_RAISE_KEY) ?? "[]")
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []
  } catch {
    return []
  }
}

function writeRaise(ids: ReadonlyArray<string>) {
  try {
    localStorage.setItem(ULTRA_RAISE_KEY, JSON.stringify(ids.slice(-RAISE_MAX)))
  } catch {}
}

export function closeUltraAsk() {
  flow.setState("ask", undefined)
}

/** Turns ultra on or off for a session: a dry run, then the cost dialog or the change. */
export async function requestUltra(
  env: UltraEnv,
  input: {
    readonly sessionID: string
    readonly on: boolean
    /** Claude groups only: also raise the effort to `xhigh`. */
    readonly raiseClaude?: boolean
    readonly retuning: boolean
  },
) {
  const sessionID = input.sessionID
  if (flow.state.busy[sessionID]) return
  const call = {
    sessionID,
    on: input.on,
    ...(input.raiseClaude === undefined ? {} : { raiseClaude: input.raiseClaude }),
  }
  flow.setState("busy", sessionID, true)
  try {
    const result = await env.runtime.rpc.call("session.ultra.set", { ...call, dryRun: true })
    if (ultraNeedsDialog(result))
      return void flow.setState("ask", { sessionID, input: call, result, retuning: input.retuning })
    await apply(env, call, input.retuning)
  } catch (error) {
    failed(env, error)
  } finally {
    flow.setState("busy", sessionID, undefined)
  }
}

export async function confirmUltra(env: UltraEnv, ask: UltraAsk) {
  flow.setState("ask", undefined)
  flow.setState("busy", ask.sessionID, true)
  await apply(env, ask.input, ask.retuning)
    .catch((error: unknown) => failed(env, error))
    .finally(() => flow.setState("busy", ask.sessionID, undefined))
}

async function apply(env: UltraEnv, input: OwnInput<"session.ultra.set">, retuning: boolean) {
  await env.runtime.rpc.call("session.ultra.set", input)
  showToast({
    message: env.text(
      input.on && retuning
        ? "own.subagent.ultra.retuned"
        : input.on
          ? "own.subagent.ultra.turnedOn"
          : "own.subagent.ultra.turnedOff",
    ),
  })
}

function failed(env: UltraEnv, error: unknown) {
  const reason =
    error instanceof OwnRpcError && error.type === "session_busy"
      ? env.i18n.t("own.acct.err.busy")
      : error instanceof Error
        ? error.message
        : String(error)
  showToast({ message: env.text("own.subagent.ultra.failed", { reason }), tone: "danger" })
}

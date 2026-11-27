// How a speed change runs (02 §4.8, 03 §4.6), shared by the composer's 속도 button and the switcher's 속도 row
// (2026-10-10). A session's change asks `session.speed.set{dryRun}` first: a faster speed whose cost or cache is not
// settled opens the cost dialog, Fast on the Claude subscription slot its one-time usage-credit consent, back to
// Standard applies at once. A new conversation keeps a pending choice per server (Standard unless the user picks
// another), applied with `session.speed.set` once its create settles and before its first prompt; nothing is cached
// yet, so only the Claude consent asks first. A switcher apply that changes the model and the speed together switches
// first and sets the speed once the session runs on the new main (`afterSwitch`). The dialogs render in the 속도 button
// of the conversation they belong to (`ask.key`).
import { createEffect, createMemo, createRoot, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Speed } from "@own/protocol/speed"
import { OwnRpcError, type ServerKey, type ServerRuntime } from "@/data"
import { speedOffersKey, type OwnStore } from "@/data/own-store"
import type { I18n } from "@/i18n"
import { showToast } from "@/switcher/toast"
import type { TargetRef } from "@/switcher/cost"
import { consentRequired, needsConsent, needsDialog, pendingView, setSpeed, speedName, type Shown } from "./speed"

export interface SpeedEnv {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly i18n: I18n
  /** This PC's `plugin.claudeAuth.fastAck` (04 §8.11.9). */
  readonly fastAck: () => Promise<unknown>
}

/** A change waiting on the cost dialog or the consent card. */
export interface SpeedAsk {
  /** The session, or {@link newKey} for a new conversation's choice. */
  readonly key: string
  readonly to: Speed.Choice
  readonly change: Speed.Change | null
  readonly consent: boolean
  /** The consent is recorded on this PC, not on the session's server (a remote session, 04 §8.11.9). */
  readonly local: boolean
  readonly offer?: Speed.Offer
}

/** A new conversation's speed, until its first message. */
export interface Pending {
  readonly choice: Speed.Choice
  /** The Claude consent card was accepted for it. */
  readonly consent: boolean
}

/** A speed to set once the session runs on `target` (a switcher apply that also changed the model). */
interface After {
  readonly target: TargetRef
  readonly choice: Speed.Choice
  readonly at: number
}

/** How long a speed waits for its switch to land (a cancelled cost dialog leaves it behind). */
export const AFTER_SWITCH_MS = 10 * 60_000

const flow = createRoot(() => {
  const [state, setState] = createStore({
    ask: undefined as SpeedAsk | undefined,
    busy: {} as Record<string, boolean | undefined>,
    pending: {} as Record<ServerKey, Pending | undefined>,
    after: {} as Record<string, After | undefined>,
  })
  return { state, setState }
})

export const speedFlow = flow.state

/** The `ask.key` and `busy` key of a server's new conversation. */
export function newKey(serverKey: ServerKey) {
  return `new:${serverKey}`
}

/** A new conversation's pending choice on this server (Standard unless the user picked another). */
export function pendingChoice(serverKey: ServerKey): Pending {
  return flow.state.pending[serverKey] ?? { choice: "standard", consent: false }
}

/** A main as the new-conversation composer and the switcher name it. */
interface Main {
  readonly providerID: string
  readonly id: string
}

/**
 * Keeps `target()`'s offers read while it is on screen: the new-conversation composer and the switcher's 속도 row.
 * Every account or model change watches the new main and releases the old one, so the control follows at once (the
 * user's 2026-10-10 report: starting on DeepSeek and moving to ChatGPT left no speed before the first message).
 */
export function watchTargetOffers(own: Pick<OwnStore, "watchSpeedOffers">, target: () => Main | undefined) {
  // The same main in a new object (a recomputed target) keeps its watch: releasing it would drop the offers until the
  // next read and send `speed.offers` again.
  const main = createMemo(target, undefined, {
    equals: (previous, next) => previous?.providerID === next?.providerID && previous?.id === next?.id,
  })
  createEffect(() => {
    const watched = main()
    if (watched) onCleanup(own.watchSpeedOffers(watched.providerID, watched.id))
  })
}

/** What the control shows for a main without a session: `choice` on its offers; `undefined` until they are read. */
export function targetView(
  own: Pick<OwnStore, "state">,
  target: Main | undefined,
  choice: Speed.Choice,
  consented: boolean,
): Shown | undefined {
  const offers = target && own.state.speedOffers[speedOffersKey(target.providerID, target.id)]
  return offers ? pendingView(offers, choice, consented) : undefined
}

export function closeAsk() {
  flow.setState("ask", undefined)
}

/** The user picked `to`. `view` is what the control shows now: the session's view, or a new conversation's `pendingView`. */
export async function requestSpeed(
  env: SpeedEnv,
  input: {
    readonly sessionID: string | undefined
    readonly to: Speed.Choice
    readonly view: Shown
    readonly offer?: Speed.Offer
  },
) {
  const remote = env.runtime.kind === "ssh"
  const offer = input.offer ? { offer: input.offer } : {}
  const sessionID = input.sessionID
  if (!sessionID) {
    const key = newKey(env.serverKey)
    if (needsConsent(input.view, input.to))
      return void flow.setState("ask", { key, to: input.to, change: null, consent: true, local: remote, ...offer })
    return void flow.setState("pending", env.serverKey, { choice: input.to, consent: false })
  }
  if (input.to === input.view.choice || flow.state.busy[sessionID]) return
  flow.setState("busy", sessionID, true)
  try {
    const dry = await env.runtime.rpc.call("session.speed.set", { sessionID, speed: input.to, dryRun: true })
    const consent = needsConsent(input.view, input.to)
    if (consent || needsDialog(dry.change, input.to))
      return void flow.setState("ask", {
        key: sessionID,
        to: input.to,
        change: dry.change,
        consent,
        local: remote,
        ...offer,
      })
    await apply(env, sessionID, input.to, false, remote)
  } catch (error) {
    // The service asks for the consent itself; a remote one records it on this PC (04 §8.11.9).
    const where = consentRequired(error)
    if (!where) return failed(env.i18n, error)
    flow.setState("ask", {
      key: sessionID,
      to: input.to,
      change: null,
      consent: true,
      local: where === "local" || remote,
      ...offer,
    })
  } finally {
    flow.setState("busy", sessionID, undefined)
  }
}

/** The dialog's confirm: a new conversation keeps the accepted choice, a session applies it. */
export async function confirmSpeed(env: SpeedEnv, ask: SpeedAsk) {
  flow.setState("ask", undefined)
  if (ask.key === newKey(env.serverKey))
    return void flow.setState("pending", env.serverKey, { choice: ask.to, consent: ask.consent })
  flow.setState("busy", ask.key, true)
  await apply(env, ask.key, ask.to, ask.consent, ask.local)
    .catch((error: unknown) => failed(env.i18n, error))
    .finally(() => flow.setState("busy", ask.key, undefined))
}

/**
 * A new conversation's speed as its create starts (03 §5.1): its pending choice resolved on what `target` offers. Read
 * before the composer leaves the new-conversation screen, which releases the target's offers. The next new
 * conversation starts at Standard again. The Claude slot without an accepted consent resolves to Standard
 * (`pendingView`).
 */
export function takeNewSpeed(own: Pick<OwnStore, "state">, serverKey: ServerKey, target: Main): Pending {
  const pending = pendingChoice(serverKey)
  flow.setState("pending", serverKey, undefined)
  const offers = own.state.speedOffers[speedOffersKey(target.providerID, target.id)]
  return {
    choice: offers ? pendingView(offers, pending.choice, pending.consent).effective : "standard",
    consent: pending.consent,
  }
}

/**
 * A new conversation's first moment (03 §5.1, after its create settled and before its first prompt): the speed
 * `takeNewSpeed` resolved, else a fresh read of the view (the early one did not know the session). A failure is a
 * toast; the prompt still goes.
 */
export async function startSpeed(env: SpeedEnv, sessionID: string, speed: Pending) {
  if (speed.choice === "standard" || !env.runtime.rpc.allowed("session.speed.set"))
    return env.runtime.own.refreshSpeed(sessionID).catch(report)
  await apply(env, sessionID, speed.choice, speed.consent, env.runtime.kind === "ssh").catch((error: unknown) => {
    failed(env.i18n, error)
    return env.runtime.own.refreshSpeed(sessionID).catch(report)
  })
}

/** Remembers a speed for once the session runs on `target` (the switch may wait for a dialog or a safe point). */
export function afterSwitch(sessionID: string, target: TargetRef, choice: Speed.Choice) {
  flow.setState("after", sessionID, { target: { ...target }, choice, at: Date.now() })
}

export function dropAfterSwitch(sessionID: string) {
  flow.setState(
    "after",
    produce((after) => {
      delete after[sessionID]
    }),
  )
}

/**
 * The session now runs on `model`: a remembered speed for that main is taken and asked for with a fresh view (the
 * cached one may still be the old main's). Expired ones are dropped; another main leaves it waiting.
 */
export async function landAfterSwitch(env: SpeedEnv, sessionID: string, model: { providerID: string; id: string }) {
  const after = flow.state.after[sessionID]
  if (!after) return
  if (Date.now() - after.at > AFTER_SWITCH_MS) return dropAfterSwitch(sessionID)
  if (after.target.providerID !== model.providerID || after.target.id !== model.id) return
  dropAfterSwitch(sessionID)
  const view = await env.runtime.rpc.call("session.speed.get", { sessionID })
  env.runtime.own.setSpeed(view)
  const offer = view.offers.find((item) => item.choice === after.choice && Speed.usable(item))
  if (after.choice !== "standard" && !offer)
    return showToast({
      message: env.i18n.t("own.speed.afterSwitchMissing", { speed: speedName(env.i18n, after.choice) }),
    })
  await requestSpeed(env, { sessionID, to: after.choice, view, ...(offer ? { offer } : {}) })
}

async function apply(env: SpeedEnv, sessionID: string, to: Speed.Choice, accepted: boolean, local: boolean) {
  const result = await setSpeed(
    {
      set: (consent) =>
        env.runtime.rpc.call("session.speed.set", {
          sessionID,
          speed: to,
          ...(consent ? { consent: true } : {}),
        }),
      fastAck: env.fastAck,
    },
    { consent: accepted, local },
  )
  env.runtime.own.setSpeed(result.view)
  showToast({ message: env.i18n.t("own.speed.toast.set", { speed: speedName(env.i18n, result.view.effective) }) })
}

function failed(i18n: I18n, error: unknown) {
  const reason =
    error instanceof OwnRpcError && error.type === "session_busy"
      ? i18n.t("own.acct.err.busy")
      : error instanceof Error
        ? error.message
        : String(error)
  showToast({ message: i18n.t("own.speed.failed", { reason }), tone: "danger" })
}

function report(error: unknown) {
  console.error("[own-web] speed", error)
}

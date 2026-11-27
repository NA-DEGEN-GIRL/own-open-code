export * as Lease from "./lease.js"

import { Clock, Effect, Ref } from "effect"

/**
 * One physical desktop, many sessions: a session holds the desktop lease while it acts, and another session gets
 * `busy` until the holder releases it or stays idle for `idleMs`. Times come from the Effect `Clock`, so tests drive
 * expiry with `TestClock`.
 */
export interface State {
  readonly holder?: string
  readonly lastActionAt: number
}

export const initial: State = { lastActionAt: 0 }

export type Acquire =
  | { readonly _tag: "Granted"; readonly state: State }
  | { readonly _tag: "Busy"; readonly holder: string; readonly retryAfterMs: number }

export function acquire(state: State, sessionID: string, now: number, idleMs: number): Acquire {
  if (state.holder === undefined || state.holder === sessionID || now - state.lastActionAt >= idleMs)
    return { _tag: "Granted", state: { holder: sessionID, lastActionAt: now } }
  return { _tag: "Busy", holder: state.holder, retryAfterMs: idleMs - (now - state.lastActionAt) }
}

export function release(state: State, sessionID: string): State {
  return state.holder === sessionID ? initial : state
}

/** The holder, or `undefined` once it has been idle for `idleMs`. */
export function holder(state: State, now: number, idleMs: number) {
  return state.holder !== undefined && now - state.lastActionAt < idleMs ? state.holder : undefined
}

export interface Lease {
  readonly acquire: (sessionID: string) => Effect.Effect<Acquire>
  readonly release: (sessionID: string) => Effect.Effect<void>
  readonly holder: Effect.Effect<string | undefined>
}

/** `idleMs` is read on every call, so a changed `leaseIdleSeconds` applies to the next action. */
export const make = (idleMs: () => number) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial)
    return {
      acquire: (sessionID) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.modify(ref, (state) => {
            const result = acquire(state, sessionID, now, idleMs())
            return [result, result._tag === "Granted" ? result.state : state]
          }),
        ),
      release: (sessionID) => Ref.update(ref, (state) => release(state, sessionID)),
      holder: Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.map(Ref.get(ref), (state) => holder(state, now, idleMs())),
      ),
    } satisfies Lease
  })

export * as Wait from "./wait.js"

import type { OwnTeam } from "@own/protocol"
import type { Hub } from "../hub.js"
import type { Steps } from "./steps.js"

/**
 * A step that waits (RH-20, 06 §8.5): every wait inside an op goes through {@link until}, so none holds the team's one
 * op slot unseen or for good.
 *
 * - It asks `check` now, after every core event `wakes` accepts and every `recheckMs` (own work on a folder and a git
 *   operation end without an event); one check runs at a time.
 * - What `check` reports is the step's `wait` (`Input.waiting`): written on the step when it changes, announced with
 *   `op.progress`, shown by the card and `team_status`; `since` is when this wait began, kept across a restart when
 *   the step still waits for the same `why`.
 * - `op.cancel` ends it (the signal aborts); `op.force` runs `force` (`force`: the step's fallback now; `stop-shell`:
 *   the commands that hold the folder end, and it looks again).
 * - A `deadline` ends it with the step's fallback once `ms` passed since it began.
 * - After {@link STALLED_MS} it is a kept `op.stalled` notice (closed when it ends) and a log warning; the log has a
 *   `wait_still` line every {@link STILL_MS}.
 * - With the `debug` log level every check is a `wait_check` line: which look it was, how long it took, whether it
 *   answered and whether an event asked for another look meanwhile. It tells a slow check from a look that came late
 *   (live check 2, 2026-11-13: a wait that ended 9 s and 20 s after the turn it waited for).
 * - `undefined` when the signal aborts: the controller closes (the op resumes later) or the user cancelled.
 */

/** How often a wait looks again without an event. */
export const RECHECK_MS = 30_000
/** A wait this long is a kept `op.stalled` notice for the user. */
export const STALLED_MS = 5 * 60_000
/** How often a long wait says in the log that it still waits (a warning after {@link STALLED_MS} × 3). */
export const STILL_MS = 5 * 60_000

/** Why it waits now, as `check` reports it (the record adds `why` and `since`). */
export type Reason = Omit<OwnTeam.StepWait, "why" | "since">

export interface Options<T> {
  /** Names the wait (`StepWait.why`: `safe-point`, `handoff`, `turn`, `main-idle`, `account`, `undo`). */
  readonly why: string
  /** What the step says before the first check reports. */
  readonly text: string
  /**
   * What the user can do until a check reports a reason with its own list (default: every action this wait has). A
   * safe-point wait starts with `["cancel"]` (RH-41): only a check names the commands that 바로 진행 may go past.
   */
  readonly actions?: ReadonlyArray<OwnTeam.WaitAction>
  /** `undefined` waits on; `report` says why it waits now; `since` is when the wait began. */
  readonly check: (report: (reason: Reason) => void, since: number) => Promise<T | undefined>
  readonly wakes: (event: Hub.Incoming) => boolean
  readonly recheckMs?: number
  /** Ends the wait with `answer` once `ms` passed since it began (`timeout` in the log). */
  readonly deadline?: { readonly ms: number; readonly answer: () => Promise<T> }
  /** What `op.force` may do: `force` ends the wait with its answer; `stopShell` ends the commands it names. */
  readonly force?: {
    readonly answer?: () => Promise<T>
    readonly stopShell?: (shells: ReadonlyArray<NonNullable<Reason["shells"]>[number]>) => Promise<void>
  }
  /** `false`: no `op.stalled` notice (a wait whose own notice tells, such as `account.waiting`). */
  readonly stalled?: boolean
}

export function until<T>(input: Steps.Input, options: Options<T>): Promise<T | undefined> {
  const services = input.services
  const signal = input.signal
  const log = services.log
  if (signal.aborted) return Promise.resolve(undefined)
  const now = services.clock.now()
  const kept = input.step.wait
  const since = kept?.why === options.why ? kept.since : now
  const fields = { teamID: input.op.teamID, opID: input.op.id, stepID: input.step.id, why: options.why }
  const result = Promise.withResolvers<T | undefined>()
  const state: {
    checking: boolean
    again: boolean
    done: boolean
    ending: boolean
    reason: Reason
    key: string
    stalled: boolean
    checks: number
    timers: Array<() => void>
  } = {
    checking: false,
    again: false,
    done: false,
    ending: false,
    reason: { text: options.text, ...(options.actions === undefined ? {} : { actions: options.actions }) },
    key: "",
    stalled: false,
    checks: 0,
    timers: [],
  }

  /** What the user can do now: the reason's own list (or every action this wait has), only what this wait can do. */
  const actions = (reason: Reason): ReadonlyArray<OwnTeam.WaitAction> =>
    (reason.actions ?? ["cancel", "force", "stop-shell"]).filter(
      (action) =>
        action === "cancel" ||
        (action === "force" && options.force?.answer !== undefined) ||
        (action === "stop-shell" && options.force?.stopShell !== undefined && (reason.shells?.length ?? 0) > 0),
    )
  const publish = () =>
    input.waiting({
      ...state.reason,
      why: options.why,
      since,
      actions: actions(state.reason),
      force: (action) => {
        if (state.done) return
        if (action === "force" && options.force?.answer) return end(options.force.answer, "forced")
        const shells = state.reason.shells ?? []
        if (action === "stop-shell" && options.force?.stopShell && shells.length > 0)
          void options.force
            .stopShell(shells)
            .catch((error: unknown) => log.warn("wait_stop_shell_failed", { ...fields, error }))
            .then(look)
      },
    })
  const report = (reason: Reason) => {
    if (state.done) return
    const key = JSON.stringify(reason)
    if (key === state.key) return
    const first = state.key === ""
    state.key = key
    state.reason = reason
    log.info(first ? "wait_begin" : "wait_changed", {
      ...fields,
      detail: reason.detail,
      sessionIDs: reason.sessionIDs,
      shells: reason.shells?.map((shell) => shell.command),
    })
    publish()
    if (state.stalled) stalled()
  }

  const finish = (value: T | undefined, outcome: string) => {
    if (state.done) return
    state.done = true
    state.timers.forEach((cancel) => cancel())
    stop()
    signal.removeEventListener("abort", aborted)
    log.info("wait_end", { ...fields, outcome, ms: services.clock.now() - since })
    input.waiting(undefined)
    if (state.stalled)
      void services.notices
        .keep(input.op.teamID, "op.stalled", [])
        .catch((error: unknown) => log.warn("wait_stalled_close_failed", { ...fields, error }))
    result.resolve(value)
  }
  /** Ends the wait with a fallback's answer; nothing else looks meanwhile. */
  const end = (answer: () => Promise<T>, outcome: "timeout" | "forced") => {
    if (state.done || state.ending) return
    state.ending = true
    log[outcome === "timeout" ? "warn" : "info"](outcome === "timeout" ? "wait_timeout" : "wait_forced", {
      ...fields,
      detail: state.reason.detail,
      ms: services.clock.now() - since,
    })
    void answer().then(
      (value) => finish(value, outcome),
      (error: unknown) => {
        log.warn("wait_fallback_failed", { ...fields, error })
        finish(undefined, "failed")
      },
    )
  }

  const look = (): void => {
    if (state.done || state.ending) return
    if (state.checking) {
      state.again = true
      return
    }
    state.checking = true
    state.again = false
    state.checks += 1
    const check = state.checks
    const began = services.clock.now()
    void options
      .check(report, since)
      .catch((error: unknown) => {
        log.warn("wait_check_failed", { ...fields, error })
        return undefined
      })
      .then((answer) => {
        log.debug("wait_check", {
          ...fields,
          check,
          ms: services.clock.now() - began,
          answered: answer !== undefined,
          again: state.again,
        })
        if (state.done || state.ending) return
        state.checking = false
        if (answer !== undefined) return finish(answer, "answered")
        if (state.again) look()
      })
  }
  const schedule = (ms: number, run: () => void) => {
    state.timers.push(services.clock.schedule(Math.max(0, ms), run))
  }
  const tick = (): void =>
    schedule(options.recheckMs ?? RECHECK_MS, () => {
      look()
      tick()
    })
  const still = (): void =>
    schedule(STILL_MS, () => {
      if (state.done) return
      const ms = services.clock.now() - since
      log[ms >= STALLED_MS * 3 ? "warn" : "info"]("wait_still", { ...fields, detail: state.reason.detail, ms })
      still()
    })
  /** The kept `op.stalled` notice, written again when the reason changes. */
  const stalled = () => {
    if (options.stalled === false || state.done) return
    state.stalled = true
    const shell = state.reason.shells?.[0]
    const notice = {
      teamID: input.op.teamID,
      ...(input.op.areaID === undefined ? {} : { areaID: input.op.areaID }),
      kind: "op.stalled" as const,
      text: state.reason.text,
      data: {
        opID: input.op.id,
        stepID: input.step.id,
        why: options.why,
        since,
        ...(state.reason.detail === undefined ? {} : { detail: state.reason.detail }),
        ...(shell ? { command: shell.command, shellID: shell.id } : {}),
      },
    }
    services.notices.publish(notice)
    void services.notices
      .keep(input.op.teamID, "op.stalled", [
        { id: `stalled:${input.op.id}:${input.step.id}`, at: services.clock.now(), ...notice },
      ])
      .catch((error: unknown) => log.warn("wait_stalled_keep_failed", { ...fields, error }))
    log.warn("wait_stalled", { ...fields, detail: state.reason.detail, ms: services.clock.now() - since })
  }

  const aborted = () => finish(undefined, input.cancelled() ? "cancelled" : "stopped")
  const stop = services.hub.on((event) => {
    if (options.wakes(event)) look()
  })
  signal.addEventListener("abort", aborted, { once: true })
  publish()
  tick()
  still()
  schedule(since + STALLED_MS - now, stalled)
  const deadline = options.deadline
  if (deadline) schedule(since + deadline.ms - now, () => end(deadline.answer, "timeout"))
  look()
  return result.promise
}

/** `n분째` of a wait that began at `since` (at least 1). */
export function minutes(since: number, now: number) {
  return Math.max(1, Math.floor((now - since) / 60_000))
}

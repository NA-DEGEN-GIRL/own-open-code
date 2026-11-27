export * as Runner from "./runner.js"

import { OwnTeam } from "@own/protocol"
import type { Hub } from "../hub.js"
import type { Log } from "../log.js"
import { Services } from "../services.js"
import { Confirm } from "./confirm.js"
import { Journal } from "./journal.js"
import type { Steps } from "./steps.js"

/**
 * Runs ops (06 §3.6, §8.5). A team has one active op at a time (`busy`). The runner walks the steps in order: an
 * `auto` step is observed, acted on and verified through its kind's handler (`ops/steps.ts`); a `confirm` step gets a
 * 10-minute nonce and waits (`needs_confirm`, event `op.confirm`) while the later auto steps go on, unless its kind
 * holds them back (`Steps.Kind.holds`: they run after `do`, in the background). When the auto steps end the op is
 * `done`, or `waiting` while confirms remain (`op.done{pending}`). A failed step stops the walk; the op stays `waiting`
 * while other confirms of it remain to be answered (a bundled removal, 06 §8.6), and ends `failed` once none is left.
 * A reorganization is undoable when one of its done steps is of a kind `op.undo` reverses (`Steps.Kind.reverses`).
 *
 * Every state change is written to the journal before the next step starts, so a restart (or the last instance going
 * away) leaves a `running` op that `resume()` continues by observing its current step again (TI-11). A confirm
 * answered while the controller closes records nothing: the step keeps its confirm.
 *
 * RH-20, so that no op holds the team's one slot for good:
 * - `cancel` (op.cancel): an op that waits (a step inside `ops/wait.ts`, or only the user's confirms) ends `cancelled`,
 *   its remaining steps skipped; the kinds' `cancel` hooks take back what waits for them first. A step that acts is
 *   never stopped half way (`busy`).
 * - `force` (op.force): the waiting step's fallback now, as its wait offers it.
 * - An answer to a confirm while the op runs another step is recorded on the step (`answer`) and applied after it, so
 *   the answer returns at once and survives a restart.
 * - A confirm of a `yields` kind that nobody answered within its 10 minutes gives way (두기) to the next op.
 * - A run that throws (KV without an instance, a bug) is tried again after 30 s, then up to every 5 minutes.
 * - Each step records when it began (`startedAt`) and why it waits (`wait`); the log names every phase.
 */

/** The first retry of a run that threw; it doubles up to {@link RETRY_MAX_MS}. */
export const RETRY_MS = 30_000
export const RETRY_MAX_MS = 5 * 60_000

/** The note of the steps a cancel skipped. */
export const CANCELLED = "사용자가 취소했어요"

/** The note of a confirm that gave way to the next op unanswered (RH-20). */
export const UNANSWERED = "확인이 없어 하지 않았어요"

export interface StartInput {
  readonly teamID: OwnTeam.TeamID
  readonly kind: OwnTeam.OpKind
  readonly by: OwnTeam.Op["by"]
  readonly areaID?: OwnTeam.AreaID
  readonly steps: ReadonlyArray<Steps.Spec>
  readonly summary?: OwnTeam.Summary
  /** `available`: `op.undo` can reverse it (06 §9.3); `of`: the op an `undo` op reverses. */
  readonly undo?: { readonly available: boolean; readonly of?: OwnTeam.OpID }
  /** An id the feature chose ahead (for example to name a hold ref, 06 §8.7). */
  readonly id?: OwnTeam.OpID
}

export type Started =
  | { readonly ok: true; readonly op: OwnTeam.Op }
  | { readonly ok: false; readonly error: "busy"; readonly op: OwnTeam.Op }

export interface ConfirmInput {
  readonly opID: string
  readonly stepID: string
  readonly choice: "do" | "skip"
  readonly nonce: string
}

export interface Deps {
  readonly journal: Journal.Store
  readonly steps: Steps.Registry
  readonly hub: Hub.Bus
  readonly clock: Services.Clock
  readonly log: Log.Logger
  readonly write: Services.Base["write"]
  readonly failed: Services.Base["failed"]
  readonly services: () => Services.Context
}

type StepResult = { readonly state: "done" | "skipped" | "failed"; readonly note?: string }

/** The step a run executes now, and its wait when it waits (`Input.waiting`). */
interface Current {
  readonly stepID: string
  wait?: Steps.Waiting
}

export class Engine {
  readonly #deps: Deps
  /** The run or confirm in progress per op, so one op never runs twice at once. */
  readonly #runs = new Map<string, Promise<unknown>>()
  readonly #abort = new AbortController()
  /** Per op: aborted by `cancel` (RH-20). */
  readonly #controllers = new Map<string, AbortController>()
  readonly #current = new Map<string, Current>()
  readonly #cancelling = new Set<string>()
  readonly #teams = new Map<string, string>()
  readonly #retries = new Map<string, { readonly tries: number; readonly cancel: () => void }>()

  constructor(deps: Deps) {
    this.#deps = deps
  }

  /** Creates the op and starts it in the background, unless the team already has an active op (`busy`). */
  async start(input: StartInput, gaveWay = false): Promise<Started> {
    const started = await this.#deps.write(input.teamID, async (): Promise<Started> => {
      const active = await this.#deps.journal.active(input.teamID)
      if (active) return { ok: false, error: "busy", op: active }
      const op: OwnTeam.Op = {
        id: input.id ?? OwnTeam.OpID.create(),
        teamID: input.teamID,
        kind: input.kind,
        by: input.by,
        state: "running",
        ...(input.areaID === undefined ? {} : { areaID: input.areaID }),
        createdAt: this.#deps.clock.now(),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.undo === undefined ? {} : { undo: input.undo }),
        steps: input.steps.map((spec, index) => ({
          id: spec.id ?? `s${index + 1}`,
          kind: spec.kind,
          args: { ...spec.args },
          mode: spec.mode ?? "auto",
          state: "pending",
        })),
      }
      await this.#deps.journal.put(op)
      return { ok: true, op }
    })
    if (!started.ok) {
      // RH-20: confirms nobody answered in time give way to this op instead of holding the slot.
      if (!gaveWay && (await this.#yield(started.op))) return this.start(input, true)
      this.#deps.log.info("op_busy", {
        teamID: input.teamID,
        wanted: input.kind,
        opID: started.op.id,
        kind: started.op.kind,
        state: started.op.state,
        ageMs: this.#deps.clock.now() - started.op.createdAt,
      })
      return started
    }
    this.#teams.set(started.op.id, started.op.teamID)
    this.#deps.log.info("op_start", {
      teamID: started.op.teamID,
      opID: started.op.id,
      kind: started.op.kind,
      by: started.op.by,
      areaID: started.op.areaID,
      steps: started.op.steps.map((step) => step.kind),
    })
    void this.#serial(started.op.id, () => this.#run(started.op.teamID, started.op.id)).catch(() => undefined)
    return started
  }

  /**
   * Continues every `running` op of every team (controller start, a new instance, 06 §8.5), and applies the answers
   * recorded while an op was busy. The runs are not awaited: a step may wait a long time (a safe point, a handoff
   * turn, a setup run), and the features' resumes that follow (catch-up, timers, waiting requests) must not wait for
   * it. `settled` waits for one op.
   */
  async resume() {
    const ops = await this.#deps.journal.open()
    this.#deps.log.info("op_resume", { running: ops.filter((op) => op.state === "running").length, open: ops.length })
    ops.forEach((op) => {
      this.#teams.set(op.id, op.teamID)
      if (op.state === "running") void this.#serial(op.id, () => this.#run(op.teamID, op.id)).catch(() => undefined)
      if (op.steps.some((step) => step.state === "needs_confirm" && step.answer !== undefined))
        void this.#serial(op.id, () => this.#answer(op.teamID, op.id)).catch(() => undefined)
    })
  }

  /** Resolves when the op's current run or confirm has ended. */
  async settled(opID: string) {
    await this.#runs.get(opID)
  }

  /**
   * Answers a confirm step (`op.confirm`, 06 §8.5). `team_off` is the caller's check. While the op runs another step
   * the answer is recorded on the step and applied after it (RH-20): the result then still shows `needs_confirm`, with
   * the step's `answer`.
   */
  async confirm(input: ConfirmInput): Promise<Services.Result<{ readonly op: OwnTeam.Op }>> {
    if (!this.#runs.has(input.opID)) return this.#serial(input.opID, () => this.#confirm(input))
    const op = await this.#deps.journal.find(input.opID)
    if (!op) return Services.failure("not_found", "op not found", { what: "op", id: input.opID })
    const step = op.steps.find((item) => item.id === input.stepID)
    if (!step || step.state !== "needs_confirm" || !Journal.ACTIVE.has(op.state))
      return Services.failure("nonce_invalid", "this step does not wait for a confirm", {})
    const checked = Confirm.check(step.confirm, input.nonce, this.#deps.clock.now())
    if (checked === "mismatch") return Services.failure("nonce_invalid", "nonce does not match", {})
    // Expired: asked again with a new nonce once the current step ended.
    if (checked === "expired") {
      void this.#serial(input.opID, () => this.#confirm(input)).catch(() => undefined)
      return Services.failure("nonce_invalid", "nonce expired; a new confirm will be issued", {})
    }
    const answered = await this.#update(op.teamID, op.id, (current) => ({
      ...current,
      steps: current.steps.map((item) =>
        item.id === step.id && item.state === "needs_confirm"
          ? { ...item, answer: { choice: input.choice, at: this.#deps.clock.now() } }
          : item,
      ),
    }))
    this.#deps.log.info("op_confirm_queued", { teamID: op.teamID, opID: op.id, stepID: step.id, choice: input.choice })
    void this.#serial(op.id, () => this.#answer(op.teamID, op.id)).catch(() => undefined)
    return { ok: true, op: answered }
  }

  /**
   * 취소 (`op.cancel`, RH-20): an op whose current step waits, or that waits only for confirms, ends `cancelled`.
   * `busy` while a step acts: nothing is stopped half way.
   */
  async cancel(opID: string): Promise<Services.Result<{ readonly op: OwnTeam.Op }>> {
    const op = await this.#deps.journal.find(opID)
    if (!op || !Journal.ACTIVE.has(op.state))
      return Services.failure("not_found", "no running or waiting op with this id", { what: "op", id: opID })
    const current = this.#current.get(opID)
    if (this.#runs.has(opID) && current !== undefined && current.wait === undefined)
      return Services.failure(
        "busy",
        "지금 단계는 하는 중이라 취소할 수 없어요. 단계가 끝나거나 기다리기 시작하면 다시 취소하세요",
        Journal.busy(op),
      )
    this.#cancelling.add(opID)
    this.#controllers.get(opID)?.abort()
    this.#deps.log.info("op_cancel", { teamID: op.teamID, opID, kind: op.kind, stepID: current?.stepID })
    const cancelled = await this.#serial(opID, () => this.#cancelNow(op.teamID, opID))
    return cancelled
      ? { ok: true, op: cancelled }
      : Services.failure("not_found", "op not found", { what: "op", id: opID })
  }

  /** 바로 진행 (`op.force`, RH-20): what the waiting step offers (`wait.actions`), now. */
  async force(opID: string, action: "force" | "stop-shell"): Promise<Services.Result<{ readonly op: OwnTeam.Op }>> {
    const op = await this.#deps.journal.find(opID)
    if (!op || !Journal.ACTIVE.has(op.state))
      return Services.failure("not_found", "no running or waiting op with this id", { what: "op", id: opID })
    const wait = this.#current.get(opID)?.wait
    if (!wait?.force || !wait.actions?.includes(action)) return Services.unsupported("op.force")
    this.#deps.log.info("op_force", { teamID: op.teamID, opID, action, why: wait.why, detail: wait.detail })
    wait.force(action)
    return { ok: true, op }
  }

  /** Stops running steps (controller close); their ops stay `running` and resume later. */
  close() {
    this.#abort.abort()
    this.#retries.forEach((retry) => retry.cancel())
    this.#retries.clear()
  }

  async #confirm(
    input: ConfirmInput & { readonly at?: number },
  ): Promise<Services.Result<{ readonly op: OwnTeam.Op }>> {
    const op = await this.#deps.journal.find(input.opID)
    if (!op) return Services.failure("not_found", "op not found", { what: "op", id: input.opID })
    const step = op.steps.find((item) => item.id === input.stepID)
    if (!step || step.state !== "needs_confirm" || !Journal.ACTIVE.has(op.state))
      return Services.failure("nonce_invalid", "this step does not wait for a confirm", {})
    const checked = Confirm.check(step.confirm, input.nonce, input.at ?? this.#deps.clock.now())
    if (checked === "mismatch") return Services.failure("nonce_invalid", "nonce does not match", {})
    if (checked === "expired") {
      this.#deps.log.info("op_confirm_expired", { teamID: op.teamID, opID: op.id, stepID: step.id })
      // 06 §8.5: an expired confirm is shown again with a new nonce.
      await this.#reask(op, step)
      return Services.failure("nonce_invalid", "nonce expired; a new confirm was issued", {})
    }
    this.#deps.log.info("op_confirm_answered", {
      teamID: op.teamID,
      opID: op.id,
      stepID: step.id,
      choice: input.choice,
    })
    const handler = this.#deps.steps.get(step.kind)
    if (input.choice === "skip") {
      const skipped = await this.#record(op.teamID, op.id, step.id, {
        state: "skipped",
        note: "두기를 골라 하지 않았어요",
      })
      // 두기 on a step that holds the later ones back takes the pending steps of its area with it.
      const declined = handler?.holds ? await this.#decline(skipped, step) : skipped
      return { ok: true, op: await this.#continue(declined) }
    }
    if (handler?.prepare && step.confirm?.manifest !== undefined) {
      // 06 §8.6 step 3: the list is read again right before the step; a different list is asked again.
      const prepared = await handler.prepare(this.#input(op, step, false, () => {})).catch(() => undefined)
      if (prepared?.manifest !== step.confirm.manifest) {
        await this.#reask(op, step, prepared)
        return Services.failure("nonce_invalid", "the list changed; a new confirm was issued", {})
      }
    }
    // A cancel came while the list was read again: the step is skipped with the op, never run.
    if (this.#cancelling.has(op.id)) return Services.failure("nonce_invalid", "the op was cancelled", {})
    const lines: OwnTeam.SummaryLine[] = []
    const result = await this.#execute(op, step, true, (line) => lines.push(line))
    // Closing: nothing is recorded, the step keeps its confirm and the same answer runs it again (observe first).
    if (this.#abort.signal.aborted)
      return Services.failure("nonce_invalid", "the step stopped with the controller; answer again", {})
    const recorded = await this.#record(op.teamID, op.id, step.id, result, lines, step.confirm)
    return { ok: true, op: await this.#continue(recorded) }
  }

  /** Applies the answers recorded on the op's confirm steps (RH-20), oldest step first. */
  async #answer(teamID: string, opID: string): Promise<void> {
    const op = await this.#deps.journal.get(teamID, opID)
    const step = op?.steps.find((item) => item.state === "needs_confirm" && item.answer !== undefined)
    if (!op || !step?.answer || !step.confirm || !Journal.ACTIVE.has(op.state)) return
    await this.#confirm({
      opID,
      stepID: step.id,
      choice: step.answer.choice,
      nonce: step.confirm.nonce,
      at: step.answer.at,
    })
    // Another step answered meanwhile goes next.
    const after = await this.#deps.journal.get(teamID, opID)
    if (after?.steps.some((item) => item.state === "needs_confirm" && item.answer !== undefined && item.id !== step.id))
      return this.#answer(teamID, opID)
  }

  async #run(teamID: string, opID: string) {
    this.#teams.set(opID, teamID)
    const initial = await this.#deps.journal.get(teamID, opID)
    if (!initial || initial.state !== "running") return initial
    const walk = async (op: OwnTeam.Op, index: number): Promise<OwnTeam.Op | undefined> => {
      // Aborted (controller close): the op stays `running` and is resumed by the next controller. Cancelled: the
      // cancel records the steps.
      if (this.#abort.signal.aborted || this.#cancelling.has(opID)) return op
      const step = op.steps[index]
      if (!step) return this.#finish(op)
      if (step.state !== "pending") return walk(op, index + 1)
      if (step.mode === "confirm") {
        const asked = await this.#ask(op, step)
        if (this.#abort.signal.aborted || this.#cancelling.has(opID)) return asked
        const state = asked.steps[index]?.state
        if (state === "failed") return this.#finish(asked)
        // A step that holds the later ones back ends the walk; `do` continues it.
        if (state === "needs_confirm" && this.#deps.steps.get(step.kind)?.holds) return this.#finish(asked)
        return walk(asked, index + 1)
      }
      const begun = await this.#begin(op, step)
      if (this.#abort.signal.aborted || this.#cancelling.has(opID)) return begun
      const lines: OwnTeam.SummaryLine[] = []
      const result = await this.#execute(begun, step, false, (line) => lines.push(line))
      if (this.#abort.signal.aborted || this.#cancelling.has(opID)) return op
      const recorded = await this.#record(teamID, opID, step.id, result, lines)
      if (result.state === "failed") return this.#finish(recorded)
      return walk(recorded, index + 1)
    }
    return walk(initial, 0)
  }

  /** Records when the step began (`startedAt`, RH-20). */
  #begin(op: OwnTeam.Op, step: OwnTeam.Step) {
    const at = this.#deps.clock.now()
    return this.#update(op.teamID, op.id, (current) => ({
      ...current,
      steps: current.steps.map((item) => (item.id === step.id ? { ...item, startedAt: at } : item)),
    }))
  }

  /** After an answer: the op's new state, and the walk continued in the background when steps were held back. */
  async #continue(op: OwnTeam.Op) {
    const final = await this.#finish(op)
    if (final.state === "running" && !this.#abort.signal.aborted)
      void this.#serial(final.id, () => this.#run(final.teamID, final.id)).catch(() => undefined)
    return final
  }

  /** 두기 on a holding confirm: the later pending steps of its area are skipped with it. */
  async #decline(op: OwnTeam.Op, step: OwnTeam.Step) {
    const at = op.steps.findIndex((item) => item.id === step.id)
    const held = op.steps.filter(
      (item, index) => index > at && item.state === "pending" && item.args.areaID === step.args.areaID,
    )
    return held.reduce<Promise<OwnTeam.Op>>(
      (previous, item) =>
        previous.then(() =>
          this.#record(op.teamID, op.id, item.id, { state: "skipped", note: "앞 단계에서 두기를 골라 하지 않았어요" }),
        ),
      Promise.resolve(op),
    )
  }

  /**
   * RH-20: a `waiting` op whose confirms are all of `yields` kinds and all expired unanswered gives way: each is
   * skipped (and its kind tells whom it concerns), so the op ends and the slot is free. `true` when it gave way.
   */
  async #yield(op: OwnTeam.Op) {
    if (
      op.state !== "waiting" ||
      this.#runs.has(op.id) ||
      unanswered(op, this.#deps.steps, this.#deps.clock.now()).length === 0
    )
      return false
    const ended = await this.#serial(op.id, async () => {
      const current = await this.#deps.journal.get(op.teamID, op.id)
      const asked = current ? unanswered(current, this.#deps.steps, this.#deps.clock.now()) : []
      if (!current || current.state !== "waiting" || asked.length === 0) return current
      const skipped = await asked.reduce<Promise<OwnTeam.Op>>(
        (previous, step) =>
          previous.then(async () => {
            this.#deps.log.info("op_confirm_yielded", { teamID: op.teamID, opID: op.id, stepID: step.id })
            const handler = this.#deps.steps.get(step.kind)
            await handler
              ?.yielded?.(this.#input(current, step, false, () => {}))
              .catch((error: unknown) =>
                this.#deps.log.warn("op_yield_notice_failed", { teamID: op.teamID, opID: op.id, error }),
              )
            return this.#record(op.teamID, op.id, step.id, { state: "skipped", note: UNANSWERED })
          }),
        Promise.resolve(current),
      )
      return this.#finish(skipped)
    })
    return ended !== undefined && !Journal.ACTIVE.has(ended.state)
  }

  /**
   * Asks again (an expired nonce, a changed list); a step whose confirm turned into an auto run (`Prepared.auto`) is
   * recorded, and the op goes on.
   */
  async #reask(op: OwnTeam.Op, step: OwnTeam.Step, ready?: Steps.Prepared) {
    const asked = await this.#ask(op, step, ready)
    if (asked.steps.find((item) => item.id === step.id)?.state !== "needs_confirm") await this.#continue(asked)
  }

  /**
   * observe → act → verify (TI-11). A thrown error fails the step with its message. A failed step's note is shown as
   * it is (03 §14.1), so one without Korean (an unexpected error, git's own output) gets a Korean lead.
   */
  async #execute(
    op: OwnTeam.Op,
    step: OwnTeam.Step,
    confirmed: boolean,
    summary: (line: OwnTeam.SummaryLine) => void,
  ): Promise<StepResult> {
    const handler = this.#deps.steps.get(step.kind)
    if (!handler) return { state: "failed", note: `모르는 단계 종류예요: ${step.kind}` }
    this.#current.set(op.id, { stepID: step.id })
    const input = this.#input(op, step, confirmed, summary)
    const thrown = (error: unknown) => {
      this.#deps.log.warn("op_step_threw", { teamID: op.teamID, opID: op.id, stepID: step.id, kind: step.kind, error })
      return message(error)
    }
    const phase = async <T>(name: "observe" | "act" | "verify", run: () => Promise<T>, word: (value: T) => string) => {
      const begun = this.#deps.clock.now()
      const value = await run()
      this.#deps.log.info("op_step", {
        teamID: op.teamID,
        opID: op.id,
        stepID: step.id,
        kind: step.kind,
        phase: name,
        result: word(value),
        ms: this.#deps.clock.now() - begun,
      })
      return value
    }
    try {
      const observed = await phase(
        "observe",
        () =>
          handler.observe(input).catch((error: unknown): Steps.Observed => ({ state: "failed", note: thrown(error) })),
        (value) => value.state,
      )
      if (observed.state === "satisfied") return { state: "done", ...(observed.note ? { note: observed.note } : {}) }
      if (observed.state === "skip") return { state: "skipped", note: observed.note }
      if (observed.state === "failed") return { state: "failed", note: korean(observed.note) }
      const acted = await phase(
        "act",
        () => handler.act(input).catch((error: unknown): Steps.Outcome => ({ ok: false, note: thrown(error) })),
        (value) => (value.ok ? "ok" : "failed"),
      )
      if (!acted.ok) return { state: "failed", note: korean(acted.note) }
      const verified = await phase(
        "verify",
        () => handler.verify(input).catch((error: unknown): Steps.Outcome => ({ ok: false, note: thrown(error) })),
        (value) => (value.ok ? "ok" : "failed"),
      )
      if (!verified.ok) return { state: "failed", note: korean(verified.note) }
      const note = verified.note ?? acted.note
      return { state: "done", ...(note ? { note } : {}) }
    } finally {
      this.#current.delete(op.id)
    }
  }

  #input(
    op: OwnTeam.Op,
    step: OwnTeam.Step,
    confirmed: boolean,
    summary: (line: OwnTeam.SummaryLine) => void,
    signal?: AbortSignal,
  ): Steps.Input {
    return {
      services: this.#deps.services(),
      op,
      step,
      confirmed,
      signal: signal ?? AbortSignal.any([this.#abort.signal, this.#controller(op.id).signal]),
      summary,
      cancelled: () => this.#cancelling.has(op.id),
      waiting: (wait) => this.#waiting(op, step, wait),
    }
  }

  #controller(opID: string) {
    const known = this.#controllers.get(opID)
    if (known) return known
    const created = new AbortController()
    this.#controllers.set(opID, created)
    return created
  }

  /**
   * `Input.waiting` (RH-20): kept for `cancel` and `force`, written on the step when the reason changed (only while the
   * step is still pending) and announced with `op.progress`.
   */
  #waiting(op: OwnTeam.Op, step: OwnTeam.Step, wait: Steps.Waiting | undefined) {
    const current = this.#current.get(op.id)
    if (current?.stepID === step.id) current.wait = wait
    const stored = wait === undefined ? undefined : record(wait)
    void this.#update(op.teamID, op.id, (latest) => ({
      ...latest,
      steps: latest.steps.map((item) => {
        if (item.id !== step.id || item.state !== "pending") return item
        if (JSON.stringify(item.wait) === JSON.stringify(stored)) return item
        const { wait: _old, ...rest } = item
        return stored === undefined ? rest : { ...rest, wait: stored }
      }),
    }))
      .then((updated) => {
        const latest = updated.steps.find((item) => item.id === step.id)
        if (latest?.state !== "pending") return
        this.#deps.hub.publish({
          name: "op.progress",
          data: {
            teamID: op.teamID,
            opID: op.id,
            stepID: step.id,
            state: "pending",
            text: stored?.text ?? latest.note ?? latest.kind,
            ...(stored === undefined ? {} : { wait: stored }),
          },
        })
      })
      .catch((error: unknown) =>
        this.#deps.log.warn("op_wait_record_failed", { teamID: op.teamID, opID: op.id, stepID: step.id, error }),
      )
  }

  /**
   * Puts a confirm step into `needs_confirm` with a new nonce and announces it; a confirm with nothing to ask
   * (`Prepared.auto`) runs as an auto step instead (unconfirmed: its observe decides what happens).
   */
  async #ask(op: OwnTeam.Op, step: OwnTeam.Step, ready?: Steps.Prepared) {
    const handler = this.#deps.steps.get(step.kind)
    if (!handler)
      return this.#record(op.teamID, op.id, step.id, { state: "failed", note: `모르는 단계 종류예요: ${step.kind}` })
    const prepared =
      ready ??
      (handler.prepare
        ? await handler.prepare(this.#input(op, step, false, () => {})).catch(() => undefined)
        : { text: step.kind })
    if (!prepared)
      return this.#record(op.teamID, op.id, step.id, { state: "failed", note: "확인할 내용을 준비하지 못했어요" })
    if (prepared.auto) {
      if (this.#cancelling.has(op.id)) return op
      const lines: OwnTeam.SummaryLine[] = []
      const result = await this.#execute(op, step, false, (line) => lines.push(line))
      if (this.#abort.signal.aborted) return op
      return this.#record(op.teamID, op.id, step.id, result, lines)
    }
    const confirm = Confirm.issue(prepared, this.#deps.clock.now())
    const updated = await this.#update(op.teamID, op.id, (current) => ({
      ...current,
      steps: current.steps.map((item) => {
        if (item.id !== step.id) return item
        const { answer: _answered, ...rest } = item
        return { ...rest, state: "needs_confirm" as const, confirm }
      }),
    }))
    const asked = updated.steps.find((item) => item.id === step.id) ?? step
    this.#deps.log.info("op_confirm_asked", { teamID: op.teamID, opID: op.id, stepID: step.id, kind: step.kind })
    this.#publishProgress(updated, asked)
    this.#deps.hub.publish({ name: "op.confirm", data: Confirm.of(updated, asked, confirm) })
    return updated
  }

  /**
   * Writes a step's result (and the summary lines it added) and announces it. A confirmed step that is done keeps the
   * confirm it was answered with (`confirmed`): a later step of the op reads the list the user agreed to there.
   */
  async #record(
    teamID: string,
    opID: string,
    stepID: string,
    result: StepResult,
    lines: ReadonlyArray<OwnTeam.SummaryLine> = [],
    confirmed?: OwnTeam.StepConfirm,
  ) {
    const updated = await this.#update(teamID, opID, (current) => ({
      ...current,
      ...(lines.length === 0 ? {} : { summary: { lines: [...(current.summary?.lines ?? []), ...lines] } }),
      steps: current.steps.map((item) =>
        item.id === stepID
          ? {
              id: item.id,
              kind: item.kind,
              args: item.args,
              mode: item.mode,
              state: result.state,
              ...(result.note === undefined ? {} : { note: result.note }),
              ...(confirmed === undefined || result.state !== "done" ? {} : { confirm: confirmed }),
            }
          : item,
      ),
    }))
    const step = updated.steps.find((item) => item.id === stepID)
    if (step) this.#publishProgress(updated, step)
    if (result.state === "failed")
      this.#deps.failed(teamID, {
        at: this.#deps.clock.now(),
        opID: updated.id,
        stepID,
        message: result.note ?? "단계가 실패했어요",
      })
    return updated
  }

  /**
   * Ends the walk: after a failed step `waiting` while confirms remain, else `failed`; otherwise `running` while steps
   * are left that no unanswered holding confirm holds back (the caller walks on), `waiting` while confirms remain,
   * else `done` (event `op.done`). A reorganization's `undo.available` is what its done steps can be reversed by
   * (`Steps.Kind.reverses`).
   */
  async #finish(op: OwnTeam.Op) {
    const ended = { before: false }
    const final = await this.#update(op.teamID, op.id, (current) => {
      // A cancel ended it meanwhile: that cancel announced it.
      if (!Journal.ACTIVE.has(current.state)) {
        ended.before = true
        return current
      }
      const waiting = current.steps.some((step) => step.state === "needs_confirm")
      const hold = current.steps.findIndex(
        (step) => step.state === "needs_confirm" && this.#deps.steps.get(step.kind)?.holds === true,
      )
      const free = current.steps.some((step, index) => step.state === "pending" && (hold < 0 || index < hold))
      const next: OwnTeam.OpState = current.steps.some(isFailed)
        ? waiting
          ? "waiting"
          : "failed"
        : free
          ? "running"
          : waiting
            ? "waiting"
            : "done"
      const reversible = current.steps.some(
        (step) => step.state === "done" && this.#deps.steps.get(step.kind)?.reverses === true,
      )
      const undo =
        current.kind === "reorg" && current.undo !== undefined && current.undo.by === undefined
          ? { ...current.undo, available: reversible }
          : current.undo
      return { ...current, state: next, ...(undo === undefined ? {} : { undo }) }
    })
    if (final.state !== "running" && !ended.before) this.#done(final)
    return final
  }

  /** `op.done` and the log line of an op that stopped running. */
  #done(op: OwnTeam.Op) {
    this.#deps.log.info("op_done", {
      teamID: op.teamID,
      opID: op.id,
      kind: op.kind,
      state: op.state,
      ms: this.#deps.clock.now() - op.createdAt,
    })
    if (!Journal.ACTIVE.has(op.state)) this.#forget(op.id)
    this.#deps.hub.publish({
      name: "op.done",
      data: {
        teamID: op.teamID,
        opID: op.id,
        state: op.state,
        summary: op.summary ?? null,
        undoable: op.undo?.available ?? false,
        pending: Confirm.pending(op).length,
      },
    })
  }

  /** Ends a cancelled op (RH-20): the kinds' `cancel` hooks, then every remaining step skipped and the op `cancelled`. */
  async #cancelNow(teamID: string, opID: string) {
    const op = await this.#deps.journal.get(teamID, opID)
    if (!op || !Journal.ACTIVE.has(op.state)) {
      this.#cancelling.delete(opID)
      return op
    }
    await op.steps.reduce<Promise<void>>(
      (previous, step) =>
        previous.then(async () => {
          const handler = this.#deps.steps.get(step.kind)
          if (!handler?.cancel) return
          await handler
            .cancel(this.#input(op, step, false, () => {}, this.#abort.signal))
            .catch((error: unknown) =>
              this.#deps.log.warn("op_cancel_hook_failed", { teamID, opID, stepID: step.id, error }),
            )
        }),
      Promise.resolve(),
    )
    const cancelled = await this.#update(teamID, opID, (current) => ({
      ...current,
      state: "cancelled",
      steps: current.steps.map((item) =>
        item.state === "pending" || item.state === "needs_confirm"
          ? {
              id: item.id,
              kind: item.kind,
              args: item.args,
              mode: item.mode,
              state: "skipped" as const,
              note: CANCELLED,
            }
          : item,
      ),
    }))
    this.#cancelling.delete(opID)
    cancelled.steps.filter((step) => step.note === CANCELLED).forEach((step) => this.#publishProgress(cancelled, step))
    this.#done(cancelled)
    return cancelled
  }

  /** Drops what this engine keeps for an op that ended. */
  #forget(opID: string) {
    this.#controllers.delete(opID)
    this.#teams.delete(opID)
    this.#retries.get(opID)?.cancel()
    this.#retries.delete(opID)
  }

  /** Read-modify-write of one op inside its team's mutex. */
  #update(teamID: string, opID: string, change: (op: OwnTeam.Op) => OwnTeam.Op) {
    return this.#deps.write(teamID, async () => {
      const current = await this.#deps.journal.get(teamID, opID)
      if (!current) throw new Error(`own.team: op ${opID} disappeared`)
      const next = change(current)
      if (next === current) return current
      await this.#deps.journal.put(next)
      return next
    })
  }

  #publishProgress(op: OwnTeam.Op, step: OwnTeam.Step) {
    this.#deps.hub.publish({
      name: "op.progress",
      data: { teamID: op.teamID, opID: op.id, stepID: step.id, state: step.state, text: step.note ?? step.kind },
    })
  }

  /**
   * Runs `work` after the op's current run or confirm, and records it as the current one. A run that throws is tried
   * again later (RH-20: KV without a live instance, a disposed context, a bug), so the op never stays `running` with
   * nothing driving it until the next resume.
   */
  #serial<T>(opID: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#runs.get(opID) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tracked = next.then(
      () => {
        const retry = this.#retries.get(opID)
        if (retry) {
          retry.cancel()
          this.#retries.delete(opID)
        }
      },
      (error: unknown) => this.#rescue(opID, error),
    )
    this.#runs.set(opID, tracked)
    void tracked.then(() => {
      if (this.#runs.get(opID) === tracked) this.#runs.delete(opID)
    })
    return next
  }

  /** A run or confirm threw: recorded for diagnostics, and the op's run tried again with a growing delay. */
  #rescue(opID: string, error: unknown) {
    this.#deps.log.warn("op_run_stopped", { teamID: this.#teams.get(opID), opID, error })
    if (this.#abort.signal.aborted) return
    const teamID = this.#teams.get(opID)
    if (teamID !== undefined)
      this.#deps.failed(teamID, {
        at: this.#deps.clock.now(),
        opID: OwnTeam.OpID.make(opID),
        message: `작업이 멈춰 다시 해 볼게요: ${message(error)}`,
      })
    const tries = (this.#retries.get(opID)?.tries ?? 0) + 1
    this.#retries.get(opID)?.cancel()
    const delay = Math.min(RETRY_MS * 2 ** (tries - 1), RETRY_MAX_MS)
    const cancel = this.#deps.clock.schedule(delay, () => {
      if (this.#abort.signal.aborted) return
      void this.#serial(opID, () => this.#rerun(opID)).catch(() => undefined)
    })
    this.#retries.set(opID, { tries, cancel })
  }

  async #rerun(opID: string) {
    const op = await this.#deps.journal.find(opID)
    if (!op || !Journal.ACTIVE.has(op.state)) return this.#forget(opID)
    if (op.state === "running") await this.#run(op.teamID, op.id)
    if (op.steps.some((step) => step.state === "needs_confirm" && step.answer !== undefined))
      await this.#answer(op.teamID, op.id)
  }
}

/**
 * The confirms of a `waiting` op that give way (RH-20): every confirm it waits for is of a `yields` kind, unanswered and
 * expired; none when one of them does not.
 */
function unanswered(op: OwnTeam.Op, steps: Steps.Registry, now: number) {
  const asked = op.steps.filter((step) => step.state === "needs_confirm")
  const gives = asked.every(
    (step) =>
      step.answer === undefined &&
      step.confirm !== undefined &&
      now >= step.confirm.expiresAt &&
      steps.get(step.kind)?.yields === true,
  )
  return gives ? asked : []
}

/** The part of a wait the op record keeps (the force callback is this process's). */
function record(wait: Steps.Waiting): OwnTeam.StepWait {
  return {
    why: wait.why,
    ...(wait.detail === undefined ? {} : { detail: wait.detail }),
    text: wait.text,
    since: wait.since,
    ...(wait.sessionIDs === undefined || wait.sessionIDs.length === 0 ? {} : { sessionIDs: wait.sessionIDs }),
    ...(wait.shells === undefined || wait.shells.length === 0 ? {} : { shells: wait.shells }),
    ...(wait.actions === undefined || wait.actions.length === 0 ? {} : { actions: wait.actions }),
  }
}

function isFailed(step: OwnTeam.Step) {
  return step.state === "failed"
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function korean(note: string) {
  return /[가-힣]/.test(note) ? note : `예상하지 못한 문제로 이 단계를 마치지 못했어요: ${note}`
}

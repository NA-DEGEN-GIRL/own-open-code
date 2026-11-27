export * as Steps from "./steps.js"

import { Option, Schema } from "effect"
import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"

/**
 * The step-kind registry (06 §3.6, §8.5). An op is an ordered list of steps `{id, kind, args, mode, state}`; the kind
 * names a handler that a feature module registers here (`keep-ref`, `worktree-create`, `session-create`,
 * `retire-remove`, …). The runner drives every step as observe → act → verify (TI-11): observe first, and after a
 * restart trust nothing but what it observes, so a step whose effect is already there is `done` without acting.
 */

/** A step as a feature plans it; the runner adds the id (`s1`, `s2`, … unless given) and `state: "pending"`. */
export interface Spec {
  readonly id?: string
  readonly kind: string
  readonly args?: Readonly<Record<string, unknown>>
  /** `confirm`: destructive or expensive; the step waits for `op.confirm` (06 §0.3). Default `auto`. */
  readonly mode?: OwnTeam.StepMode
}

/** What observing found. `satisfied`: the effect is already there (resume); `pending`: act now. */
export type Observed =
  | { readonly state: "satisfied"; readonly note?: string }
  | { readonly state: "pending" }
  | { readonly state: "skip"; readonly note: string }
  | { readonly state: "failed"; readonly note: string }

export type Outcome = { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly note: string }

/**
 * What a confirm step shows (06 §8.6): the nonce is bound to `manifest`, the hash of the listed files. A removal marks
 * the files that cannot be made again (`irreplaceable`: too large to keep in the team records, 8.6 step 2).
 */
export interface Prepared {
  readonly text: string
  readonly bytes?: number
  readonly files?: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly irreplaceable?: boolean }>
  readonly manifest?: string
  /**
   * Nothing to ask now: the step runs as an auto step instead and its observe says what happens (a removal whose
   * folder stays for a reason records that reason, 8.6 "계획 때 정함").
   */
  readonly auto?: true
}

export interface Input {
  readonly services: Services.Context
  readonly op: OwnTeam.Op
  readonly step: OwnTeam.Step
  /** The user answered `do` to this confirm step, its nonce matched and its list was unchanged. */
  readonly confirmed: boolean
  /** Aborts when the controller closes (the op resumes later) or the user cancels the op (`op.cancel`, RH-20). */
  readonly signal: AbortSignal
  /** Adds a line to the op's result card (06 §9.3). */
  readonly summary: (line: OwnTeam.SummaryLine) => void
  /** The user cancelled the op (RH-20): a wait that ends now ends for that, not because the controller closes. */
  readonly cancelled: () => boolean
  /**
   * The step waits for `wait` (RH-20, `ops/wait.ts`): recorded on the step when it changes, announced with
   * `op.progress`, and what `op.cancel` and `op.force` may act on; `undefined` when the step no longer waits.
   */
  readonly waiting: (wait: Waiting | undefined) => void
}

/**
 * A step's wait as `Input.waiting` takes it: the record's {@link OwnTeam.StepWait} and what `op.force` does, which only
 * this process can run (a restart offers it again once the step waits again).
 */
export interface Waiting extends OwnTeam.StepWait {
  readonly force?: (action: "force" | "stop-shell") => void
}

/**
 * A step kind. Handlers decode their own `args` (they come back from KV) and never throw on purpose: a thrown error
 * fails the step with its message.
 */
export interface Kind {
  readonly kind: string
  observe(input: Input): Promise<Observed>
  act(input: Input): Promise<Outcome>
  verify(input: Input): Promise<Outcome>
  /** Confirm steps: the dialog's facts, made again right before the step runs (06 §8.6 step 3). */
  prepare?(input: Input): Promise<Prepared>
  /**
   * A confirm step of this kind holds back the steps after it: they run only after `do`, and `두기` skips the later
   * pending steps of its area (`args.areaID`). A plain confirm does not hold back the auto steps after it.
   */
  readonly holds?: true
  /** A done step of this kind is something `op.undo` reverses: a reorganization that did one shows 되돌리기 (9.3). */
  readonly reverses?: true
  /**
   * RH-20: a confirm of this kind that nobody answered within its 10 minutes gives way to the next op the team starts
   * (두기), instead of holding the team's one op slot; `yielded` tells whom it concerns.
   */
  readonly yields?: true
  yielded?(input: Input): Promise<void>
  /**
   * RH-20: the user cancelled the op (`op.cancel`). Called for every step of the op whose kind has it, in order and
   * whatever its state, before the op ends `cancelled`, so a kind can take back what waits for it (a request it put
   * in a queue, the `fresh` mark of the main request a rotation was for). Best effort; never throws on purpose.
   */
  cancel?(input: Input): Promise<void>
}

/** The phases of a kind made with {@link define}, called with the decoded `args`. */
export interface Handler<A> {
  observe(args: A, input: Input): Promise<Observed>
  act(args: A, input: Input): Promise<Outcome>
  verify(args: A, input: Input): Promise<Outcome>
}

/** A step kind whose `args` (read back from KV) are decoded in every phase; invalid args fail the step. */
export function define<S extends Schema.ConstraintDecoder<unknown>>(
  kind: string,
  schema: S,
  handler: Handler<S["Type"]>,
): Kind {
  const decode = Schema.decodeUnknownOption(schema)
  const invalid = `단계 정보가 맞지 않아요(${kind})`
  return {
    kind,
    observe: (input) =>
      Option.match(decode(input.step.args), {
        onNone: async (): Promise<Observed> => ({ state: "failed", note: invalid }),
        onSome: (args) => handler.observe(args, input),
      }),
    act: (input) =>
      Option.match(decode(input.step.args), {
        onNone: async (): Promise<Outcome> => ({ ok: false, note: invalid }),
        onSome: (args) => handler.act(args, input),
      }),
    verify: (input) =>
      Option.match(decode(input.step.args), {
        onNone: async (): Promise<Outcome> => ({ ok: false, note: invalid }),
        onSome: (args) => handler.verify(args, input),
      }),
  }
}

export class Registry {
  readonly #kinds = new Map<string, Kind>()

  /** Registers a kind; returns the function that removes it. A kind can be registered once. */
  register(kind: Kind) {
    if (this.#kinds.has(kind.kind)) throw new Error(`own.team: step kind ${kind.kind} is registered twice`)
    this.#kinds.set(kind.kind, kind)
    return () => {
      if (this.#kinds.get(kind.kind) === kind) this.#kinds.delete(kind.kind)
    }
  }

  get(kind: string) {
    return this.#kinds.get(kind)
  }

  kinds() {
    return [...this.#kinds.keys()]
  }
}

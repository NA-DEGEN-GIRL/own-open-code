export * as Confirm from "./confirm.js"

import { OwnID, type OwnTeam } from "@own/protocol"
import { Hash } from "@own/runtime"
import type { Steps } from "./steps.js"

/**
 * Confirm nonces of op steps (06 §8.5–8.6): a step that needs the user's yes stops at `needs_confirm` with a nonce
 * that lives 10 minutes. An expired nonce is answered with `nonce_invalid` and a new one is shown; a removal's nonce is
 * bound to the list the dialog showed (`manifest`), and a list that changed before the step runs is asked again.
 */

export const TTL_MS = 10 * 60 * 1000

export function issue(prepared: Steps.Prepared, now: number): OwnTeam.StepConfirm {
  return {
    nonce: OwnID.Nonce.create(),
    expiresAt: now + TTL_MS,
    text: prepared.text,
    ...(prepared.bytes === undefined ? {} : { bytes: prepared.bytes }),
    ...(prepared.files === undefined ? {} : { files: prepared.files }),
    ...(prepared.manifest === undefined ? {} : { manifest: prepared.manifest }),
  }
}

export type Checked = "ok" | "expired" | "mismatch"

export function check(confirm: OwnTeam.StepConfirm | undefined, nonce: string, now: number): Checked {
  if (!confirm || confirm.nonce !== nonce) return "mismatch"
  if (now >= confirm.expiresAt) return "expired"
  return "ok"
}

/** The list a removal shows, as one hash (paths, sizes and modification times, 06 §8.6 step 2). */
export function manifest(
  files: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly mtime?: number }>,
) {
  return Hash.stable([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
}

/** The confirms an op waits for, as `team.get` lists them and `op.confirm` announces them. */
export function pending(op: OwnTeam.Op): ReadonlyArray<OwnTeam.Confirm> {
  return op.steps.flatMap((step) =>
    step.state === "needs_confirm" && step.confirm ? [of(op, step, step.confirm)] : [],
  )
}

export function of(op: OwnTeam.Op, step: OwnTeam.Step, confirm: OwnTeam.StepConfirm): OwnTeam.Confirm {
  return {
    teamID: op.teamID,
    opID: op.id,
    stepID: step.id,
    kind: step.kind,
    ...(op.areaID === undefined ? {} : { areaID: op.areaID }),
    ...confirm,
  }
}

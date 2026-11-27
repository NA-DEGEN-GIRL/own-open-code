// The account that signed a step or a compaction (02 §8.7 G4, SL 2026-10-26). Several Claude accounts share the
// `anthropic` provider, so the provider names only the first of them: the turn footer showed AC-01 on the steps AC-02
// and AC-03 had signed. The router's ledger line of the step or compaction names the account that signed it. Until
// that line arrives (a step still running, a page not read yet, a compaction recorded before SL) the session's own
// account for the provider stands in. A line naming an account that is no longer listed says `뺀 계정`.
import type { Ledger } from "@own/protocol"
import { builtinDisplay, ownDisplay, type AccountDisplay, type DisplayInput } from "./chip"
import { markerText } from "./marker-strings"
import type { SwitchMarker } from "./markers"

export interface Signer {
  /** The account's id, or the provider's for a built-in one: steps of different keys share no cache. */
  readonly key: string
  readonly display: AccountDisplay
  /** Named by the step's own ledger line, not the stand-in. */
  readonly recorded: boolean
}

export function signerOf(
  input: DisplayInput,
  step: { readonly sessionID: string; readonly providerID: string; readonly line: Ledger.Line | undefined },
): Signer {
  // The line of another provider (a stand-in model wrote the compaction) does not name this provider's account.
  const line = step.line?.providerID === step.providerID ? step.line : undefined
  const listed = line?.accountID ? input.own.state.accounts[line.accountID] : undefined
  if (listed) return { key: listed.id, display: ownDisplay(listed), recorded: true }
  // Before the first account list arrives, an unknown account is not yet a removed one.
  if (line?.accountID && input.own.state.status === "ready")
    return {
      key: line.accountID,
      display: {
        label: markerText.text(input.i18n.locale(), "own.marker.removedAccount"),
        color: undefined,
        kind: undefined,
        builtin: false,
        thirdParty: false,
      },
      recorded: true,
    }
  const provider = { key: `provider:${step.providerID}`, display: builtinDisplay(input, step.providerID) }
  // No own account signed it: a built-in provider with global credentials.
  if (line && line.accountID === null) return { ...provider, recorded: true }
  const account = input.own.accountOfSession(step.sessionID, step.providerID)
  if (account) return { key: account.id, display: ownDisplay(account), recorded: false }
  return { ...provider, recorded: false }
}

/**
 * The two sides of a switch marker (SL-8): the account the conversation left, from the line of the step before the
 * switch, and the one it runs on, from the line of the first step after it (before that step, the bound account).
 * `kind`: a Claude model or effort switch keeps `anthropic`, so it is an account switch only when both lines name
 * different accounts; a stand-in from the binding never decides it, like the footer's cold-step tag.
 */
export function switchSigners(
  input: DisplayInput,
  sessionID: string,
  marker: Pick<SwitchMarker, "kind" | "from" | "to" | "beforeStepID" | "firstStepID">,
  lineOf: (messageID: string) => Ledger.Line | undefined,
) {
  const side = (providerID: string, stepID: string | undefined) =>
    signerOf(input, { sessionID, providerID, line: stepID === undefined ? undefined : lineOf(stepID) })
  const from = side(marker.from.providerID, marker.beforeStepID)
  const to = side(marker.to.providerID, marker.firstStepID)
  const moved = from.recorded && to.recorded && from.key !== to.key
  return { from, to, kind: moved ? ("account" as const) : marker.kind }
}

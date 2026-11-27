// Review finding 5 (2026-10-11): Claude is judged per Claude account (02 §8.7), not by account 1's exhaustion alone.
import { expect, test } from "bun:test"
import { Account, type Limit } from "@own/protocol"
import { Planner } from "../../src/switching/planner.js"

const SLOT = Account.ID.claudeSlot
const TWO = Account.ID.make("acc_01J9CLAUDETWO0000000000000")

function limits(exhausted: Record<string, number>) {
  return {
    exhaustion: (accountID: string): Limit.Exhaustion | undefined =>
      exhausted[accountID] === undefined
        ? undefined
        : { accountID: accountID as Account.ID, windowId: "claude.5h", until: exhausted[accountID]!, class: "hard" },
  }
}

test("a tree's own Claude account decides; without a tree, any usable Claude account keeps Claude usable", () => {
  const one = limits({ [SLOT]: 2_000 })
  // The tree moved to account 2: account 1's exhaustion is not its.
  expect(Planner.usability(one, undefined, "anthropic", [TWO])).toEqual({ usable: true })
  expect(Planner.usability(one, undefined, "anthropic", [SLOT])).toMatchObject({ usable: false, until: 2_000 })
  // A new conversation: Claude stays usable while account 2 is.
  expect(Planner.usability(one, undefined, "anthropic", [SLOT, TWO])).toEqual({ usable: true })
  // Every account ran out: the first reset answers.
  const both = limits({ [SLOT]: 2_000, [TWO]: 1_000 })
  expect(Planner.usability(both, undefined, "anthropic", [SLOT, TWO])).toMatchObject({
    usable: false,
    reason: "exhausted",
    until: 1_000,
  })
  // Without a list: account 1, as before several accounts.
  expect(Planner.usability(one, undefined, "anthropic")).toMatchObject({ usable: false })
})

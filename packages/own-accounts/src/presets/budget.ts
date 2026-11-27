export * as PresetBudget from "./budget.js"

import { Option, Schema } from "effect"
import { Account, Kv, Preset, type Broker } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"

/**
 * Money on subagent targets (07 §5.4 step 4, PG11). A paid target (an own metered or prepaid account) runs only
 * within its monthly budget, and a role reaches one through a fallback only after the user allowed it for this
 * conversation (`session.preset.consent`, KV `presetConsent`). Nothing here ever moves work onto a paid account.
 * A remote service has neither budgets nor the ledger of record, so it goes by what the local PC mirrored (T3, 07 §8.1
 * 원격).
 */

/** An own account that costs money per use; a local model (02 §3.3a) never does. */
export function paid(account: Pick<Account.Info, "kind" | "billing" | "compat">) {
  const charge = Account.chargeOf(account)
  return charge === "metered" || charge === "prepaid"
}

/**
 * Whether a paid account's monthly budget is used up. On this PC: {@link spent}; throws when the ledger cannot be read
 * (the caller fails closed). On a remote service: the local PC's verdict from the mirror (`MirrorView.presetsBudget`);
 * an account the mirror does not name, or no mirrored state yet, counts as used up (fail closed).
 */
export async function exhausted(peers: Module.Peers, account: Account.Info) {
  const mirrored = peers().presets.budgets()
  return mirrored ? (mirrored[account.id]?.exhausted ?? true) : spent(peers, account)
}

/**
 * This PC's verdict: `quota.snapshot`'s budget window (02 §7.5, this month's ledger spend). An account without a
 * budget has no cap. Throws when the ledger cannot be read.
 */
export async function spent(peers: Module.Peers, account: Account.Info) {
  if (!account.budget?.monthlyUSD) return false
  const snapshot = await peers().telemetry.quotaSnapshot({ accountIDs: [account.id] }, IN_PROCESS)
  return (
    "windows" in snapshot &&
    snapshot.windows.some((window) => window.kind === "budget" && window.status === "exhausted")
  )
}

/**
 * `MirrorView.presetsBudget` for a host (T3): {@link spent} for each of the paid accounts it may use. A ledger that
 * cannot be read counts as used up, like the gate here.
 */
export async function mirror(
  peers: Module.Peers,
  accounts: ReadonlyArray<Account.Info>,
): Promise<Record<string, Broker.PresetBudget>> {
  const verdicts = await Promise.all(
    accounts.map(
      async (account) => [account.id, { exhausted: await spent(peers, account).catch(() => true) }] as const,
    ),
  )
  return Object.fromEntries(verdicts)
}

/**
 * The user's answers for this conversation (KV `presetConsent` of the root): `true` = run the role on that paid
 * account, `false` = never (the role goes on to its next target), absent = not asked yet. A value this build cannot
 * read is no answer.
 */
export async function consent(deps: Deps, root: string): Promise<ReadonlyMap<string, boolean>> {
  const stored = Option.getOrUndefined(decodeConsent(await deps.ctx.storage.get(Kv.presetConsent(root))))
  return new Map(Object.entries(stored?.accounts ?? {}).flatMap(([id, answer]) => (answer ? [[id, answer.allow]] : [])))
}

const decodeConsent = Schema.decodeUnknownOption(Preset.Consent)

/**
 * Context of an in-process `quota.snapshot` call. The method declares no error of its own and never reports one, so
 * the error factory is never called.
 */
const IN_PROCESS: RpcTypes.Context<"quota.snapshot"> = {
  signal: new AbortController().signal,
  error: () => {
    throw new Error("quota.snapshot reported an error in process")
  },
}

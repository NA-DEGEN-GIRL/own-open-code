export * as Fallback from "./fallback.js"

import type { Account, Preset } from "@own/protocol"
import type { Variant } from "../switching/variant.js"

/**
 * Where a role runs when its first target cannot (07 §1.2, §4.2, §5.4 step 4): the next target of its list, and at
 * the end of the list like the main, with a sentence for the LLM in the call's result. Nothing outside the list is
 * ever picked. A paid target (metered or prepaid) is reached through a fallback only with the user's answer for this
 * conversation: no answer declines the call (`consent`, 0 paid requests), `false` goes on to the next target. A paid
 * target whose monthly budget is used up declines the call (`budget`).
 */
export type Pick =
  | { readonly type: "use"; readonly ref: Variant.Ref; readonly notice?: string }
  | { readonly type: "reject"; readonly reason: "consent" | "budget"; readonly accountID: Account.ID }

/** What the walk asks about money (`PresetBudget`). */
export interface Money {
  /** The own paid account a provider belongs to; `undefined` for a subscription, the Claude slot or a local provider. */
  paid(providerID: string): Account.Info | undefined
  /** The user's answer for this conversation; `undefined` = not asked. */
  consent(accountID: Account.ID): boolean | undefined
  exhausted(account: Account.Info): Promise<boolean>
}

/**
 * Walks one role's resolved targets in order (`Preset.resolve` already skipped the unusable ones: gone, exhausted,
 * failing auth, a local server off, outside R4 with the binding's team). `main` is what the role falls back to.
 */
export async function pick(
  role: Preset.Role,
  resolution: Preset.RoleResolution,
  main: Variant.Ref,
  money: Money,
): Promise<Pick> {
  const walk = async (index: number): Promise<Pick> => {
    const item = resolution.targets[index]
    if (!item) return { type: "use", ref: main, notice: notice(role, "main") }
    const ref = item.ref
    if (!ref) return walk(index + 1)
    const account = money.paid(ref.providerID)
    if (account && index > 0) {
      const answer = money.consent(account.id)
      if (answer === undefined) return { type: "reject", reason: "consent", accountID: account.id }
      if (!answer) return walk(index + 1)
    }
    if (account && (await money.exhausted(account))) return { type: "reject", reason: "budget", accountID: account.id }
    return index === 0 ? { type: "use", ref } : { type: "use", ref, notice: notice(role, "next") }
  }
  return walk(0)
}

/**
 * The sentence the LLM reads with a model pool call that ran elsewhere (07 §5.4 2단계 모델 묶음): the entry it named,
 * or the default rule's usual pick, cannot run now (gone, waiting for a limit, a local server off, the team's R4, or
 * its monthly budget used up), so the call ran on another entry or on the main. Pool names only, never a provider id.
 */
export function poolNotice(key: string, to: string | undefined, budget: boolean) {
  return `Note: model ${key} is not available now${budget ? " (its monthly budget is used up)" : ""}, so this subagent ran on ${to === undefined ? "your own model" : `model ${to}`}.`
}

/**
 * The sentence the LLM reads with a fallback call's result (07 §3.3: a temporary fallback never changes the guidance
 * cards). Roles only: no model, account or provider names.
 */
export function notice(role: Preset.Role, to: "next" | "main") {
  return to === "next"
    ? `Note: the ${role} role's first target is not available now, so this subagent ran on the role's next target.`
    : `Note: no target of the ${role} role is available now, so this subagent ran on your own model.`
}

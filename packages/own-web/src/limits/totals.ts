// Ledger totals of one session (03 §4.7.1 "세션 누계"): the per-account totals of `ledger.session` merged, then
// advanced line by line from `ledger.step`. Pure.
import type { Ledger } from "@own/protocol"

export function merge(list: readonly Ledger.Totals[]): Ledger.Totals {
  const empty: Ledger.Totals = {
    requests: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    cost: [],
    hitRate: null,
  }
  return list.reduce(
    (sum, item) => ({
      requests: sum.requests + item.requests,
      tokens: {
        input: sum.tokens.input + item.tokens.input,
        cacheRead: sum.tokens.cacheRead + item.tokens.cacheRead,
        cacheWrite: sum.tokens.cacheWrite + item.tokens.cacheWrite,
        output: sum.tokens.output + item.tokens.output,
        reasoning: sum.tokens.reasoning + item.tokens.reasoning,
      },
      cost: addCost(sum.cost, item.cost),
      hitRate: null,
    }),
    empty,
  )
}

export function add(totals: Ledger.Totals, line: Ledger.Line): Ledger.Totals {
  const tokensOf = line.tokens
  return {
    requests: totals.requests + 1,
    tokens: tokensOf
      ? {
          input: totals.tokens.input + tokensOf.input,
          cacheRead: totals.tokens.cacheRead + tokensOf.cacheRead,
          cacheWrite: totals.tokens.cacheWrite + tokensOf.cacheWrite,
          output: totals.tokens.output + tokensOf.output,
          reasoning: totals.tokens.reasoning + tokensOf.reasoning,
        }
      : totals.tokens,
    cost: line.cost ? addCost(totals.cost, [{ unit: line.cost.unit, amount: line.cost.amount }]) : totals.cost,
    hitRate: null,
  }
}

function addCost(a: readonly Ledger.Amount[], b: readonly Ledger.Amount[]) {
  const sums = new Map(a.map((item) => [item.unit, item.amount]))
  for (const item of b) sums.set(item.unit, (sums.get(item.unit) ?? 0) + item.amount)
  return [...sums.entries()].map(([unit, value]) => ({ unit, amount: value }))
}

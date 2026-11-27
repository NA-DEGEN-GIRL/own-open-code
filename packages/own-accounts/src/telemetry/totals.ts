export * as Totals from "./totals.js"

import { Ledger } from "@own/protocol"

/** Aggregates of usage lines for `ledger.session` and `accounts.usage` (02 §7.5 "집계", §9.2). Pure. */

/** `P = input + cacheRead + cacheWrite` of a line with tokens (02 §6.1). */
export function inputOf(tokens: Ledger.Tokens) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite
}

export function of(lines: ReadonlyArray<Ledger.Line>): Ledger.Totals {
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  const cost = new Map<Ledger.Amount["unit"], number>()
  const state = { P: 0 }
  for (const line of lines) {
    if (line.tokens) {
      tokens.input += line.tokens.input
      tokens.cacheRead += line.tokens.cacheRead
      tokens.cacheWrite += line.tokens.cacheWrite
      tokens.output += line.tokens.output
      tokens.reasoning += line.tokens.reasoning
      state.P += inputOf(line.tokens)
    }
    if (line.cost) cost.set(line.cost.unit, (cost.get(line.cost.unit) ?? 0) + line.cost.amount)
  }
  return {
    requests: lines.length,
    tokens,
    cost: [...cost.entries()]
      .toSorted((a, b) => a[0].localeCompare(b[0]))
      .map((entry) => ({ unit: entry[0], amount: round(entry[1]) })),
    hitRate: state.P > 0 ? tokens.cacheRead / state.P : null,
  }
}

/** Totals per account; lines without an own account are keyed by provider id. */
export function byAccount(lines: ReadonlyArray<Ledger.Line>): Record<string, Ledger.Totals> {
  const groups = group(lines, (line) => line.accountID ?? line.providerID)
  return Object.fromEntries([...groups.entries()].map((entry) => [entry[0], of(entry[1])]))
}

/** Hour bucket key: the UTC hour start in ISO form. */
export function hourKey(ts: number) {
  return new Date(Math.floor(ts / 3_600_000) * 3_600_000).toISOString()
}

/** Day bucket key: UTC calendar date `YYYY-MM-DD`. */
export function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}

export interface RowMeta {
  /** Project of a session, when an event told us (`session.created`). */
  readonly projectOf: (sessionID: string) => string | null
}

/** `accounts.usage` rows for one `groupBy` (02 §9.2). */
export function rows(lines: ReadonlyArray<Ledger.Line>, groupBy: Ledger.GroupBy, meta: RowMeta): Ledger.UsageRow[] {
  const key = (line: Ledger.Line) =>
    groupBy === "hour"
      ? hourKey(line.ts)
      : groupBy === "day"
        ? dayKey(line.ts)
        : groupBy === "session"
          ? line.sessionID
          : groupBy === "server"
            ? Ledger.serverOf(line)
            : line.modelID
  const result = [...group(lines, key).entries()].map(([name, items]): Ledger.UsageRow => {
    const accountIDs = [...new Set(items.flatMap((line) => (line.accountID ? [line.accountID] : [])))]
    const modelIDs = [...new Set(items.map((line) => line.modelID))]
    const servers = [...new Set(items.map((line) => Ledger.serverOf(line)))].toSorted()
    const lastActivityAt = Math.max(...items.map((line) => line.ts))
    return {
      key: name,
      ...of(items),
      accountIDs,
      modelIDs,
      // 04 §16.5: only when a remote server is involved, so local-only rows keep their v1 shape.
      ...(servers.some((server) => server !== Ledger.LOCAL_SERVER) ? { servers } : {}),
      lastActivityAt,
      ...(groupBy === "session"
        ? {
            projectID: meta.projectOf(name),
            switchCount: Math.max(0, ...items.map((line) => line.switchEpoch)),
          }
        : {}),
    }
  })
  if (groupBy === "session") return result.toSorted((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  return result.toSorted((a, b) => a.key.localeCompare(b.key))
}

function group<K>(lines: ReadonlyArray<Ledger.Line>, key: (line: Ledger.Line) => K) {
  const groups = new Map<K, Ledger.Line[]>()
  for (const line of lines) {
    const name = key(line)
    const list = groups.get(name) ?? []
    list.push(line)
    groups.set(name, list)
  }
  return groups
}

function round(value: number) {
  return Math.round(value * 1e6) / 1e6
}

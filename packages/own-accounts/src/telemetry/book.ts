export * as Book from "./book.js"

import { Home, LedgerWriter } from "@own/runtime"

/**
 * Read side of the usage ledger for the RPCs (02 §7.5, §9.2). Month files are read through the runtime writer (plain
 * and gzipped, de-duplicated by `eid`), which keeps the most recent months decoded once per process and current on
 * every append, so repeated `ledger.session` / `accounts.usage` calls from any Location do not re-read the disk.
 */

/** Months a session lookup walks back at most (the ledger keeps 12, 01 §5.1). */
export const MAX_MONTHS = 13

export class Reader {
  readonly #ledger: LedgerWriter.Writer
  readonly #now: () => number

  constructor(options: { readonly ledger: LedgerWriter.Writer; readonly now: () => number }) {
    this.#ledger = options.ledger
    this.#now = options.now
  }

  /** Lines of one month, oldest first. */
  month(yearMonth: string): Promise<ReadonlyArray<LedgerWriter.UsageEntry>> {
    return this.#ledger.usageSorted(yearMonth)
  }

  /**
   * Every line of a session, oldest first. Walks back from the current month and stops at the first month without
   * lines of the session once some were found (sessions are contiguous in time), or after two empty recent months.
   */
  async session(sessionID: string): Promise<LedgerWriter.UsageEntry[]> {
    const found: LedgerWriter.UsageEntry[][] = []
    for (const [index, yearMonth] of months(this.#now(), MAX_MONTHS).entries()) {
      const lines = (await this.month(yearMonth)).filter((entry) => entry.line.sessionID === sessionID)
      if (lines.length === 0 && (found.length > 0 || index >= LedgerWriter.RECENT_MONTHS - 1)) break
      if (lines.length > 0) found.push(lines)
    }
    return found.reverse().flat()
  }

  /** Lines with `from ≤ ts < to`, oldest first. */
  async range(from: number, to: number): Promise<LedgerWriter.UsageEntry[]> {
    const wanted = months(to - 1, MAX_MONTHS).filter((yearMonth) => yearMonth >= Home.month(from))
    const all = await Promise.all(wanted.reverse().map((yearMonth) => this.month(yearMonth)))
    return all.flat().filter((entry) => entry.line.ts >= from && entry.line.ts < to)
  }
}

/** `YYYY-MM` of `ts` and the `count - 1` months before it, newest first (UTC, like the ledger files). */
export function months(ts: number, count: number) {
  const date = new Date(ts)
  return Array.from({ length: count }, (_, index) =>
    Home.month(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1)),
  )
}

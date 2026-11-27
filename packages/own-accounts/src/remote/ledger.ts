export * as RemoteLedger from "./ledger.js"

import type { Ledger } from "@own/protocol"
import { LedgerWriter, Redact } from "@own/runtime"

/**
 * The ledger of a remote service (04 §10.1): every line the unchanged telemetry/switching code writes still goes to
 * the remote's own ledger files (the session's estimator and `ledger.session` of the remote instance read them), and a
 * line that was new is also handed to the spool for the local broker, which is the ledger writer of record. The
 * wrapper delegates to the runtime's single writer, so its de-duplication by `eid` decides what "new" means and a
 * line seen by several Location instances is spooled once.
 */
export class Writer extends LedgerWriter.Writer {
  readonly #inner: LedgerWriter.Writer
  readonly #now: () => number
  readonly #onUsage: (eid: string, line: Ledger.Line) => void
  readonly #onEvent: (event: LedgerWriter.Event) => void

  constructor(input: {
    readonly inner: LedgerWriter.Writer
    readonly dir: string
    readonly now: () => number
    readonly onUsage: (eid: string, line: Ledger.Line) => void
    readonly onEvent: (event: LedgerWriter.Event) => void
  }) {
    super({ dir: input.dir, now: input.now })
    this.#inner = input.inner
    this.#now = input.now
    this.#onUsage = input.onUsage
    this.#onEvent = input.onEvent
  }

  override file(kind: LedgerWriter.Kind, yearMonth: string) {
    return this.#inner.file(kind, yearMonth)
  }

  override async usage(eid: string, line: Ledger.Line) {
    const outcome = await this.#inner.usage(eid, line)
    if (outcome === "written") this.#onUsage(eid, line)
    return outcome
  }

  override async event(input: LedgerWriter.EventInput) {
    const ts = input.ts ?? this.#now()
    const outcome = await this.#inner.event({ ...input, ts })
    if (outcome === "written")
      this.#onEvent({
        v: 1,
        eid: input.eid,
        ts,
        type: input.type,
        ...(input.accountID === undefined ? {} : { accountID: input.accountID }),
        ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        ...(input.data === undefined ? {} : { data: Redact.record(input.data) }),
      })
    return outcome
  }

  override flush() {
    return this.#inner.flush()
  }

  override usageOf(yearMonth: string) {
    return this.#inner.usageOf(yearMonth)
  }

  override eventsOf(yearMonth: string) {
    return this.#inner.eventsOf(yearMonth)
  }

  override usageSorted(yearMonth: string) {
    return this.#inner.usageSorted(yearMonth)
  }

  override maintain() {
    return this.#inner.maintain()
  }
}

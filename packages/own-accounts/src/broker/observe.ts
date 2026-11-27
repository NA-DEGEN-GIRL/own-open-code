export * as Observe from "./observe.js"

import { Option, Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import { Account, Broker, Ledger, Limit, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"

/**
 * `observe.push` on the local side (04 §10): a host's observations become local ledger lines (`server = hostId`),
 * limit windows (`origin = hostId`), events-ledger lines and auth-failure reports. Remote data is trusted less
 * (04 §10.5): times are normalized by the measured clock skew first, every item is validated, `accountID` is
 * recomputed from the provider id, and anything out of range is dropped and counted. Items at or below the persisted
 * `ackThrough` are skipped, and an item of an unknown schema version stops the batch without acknowledging it (it
 * stays in the remote spool until an updated build can read it, 04 §5.7).
 */

export interface Sink {
  readonly now: () => number
  readonly registry: () => Promise<Registry.File>
  /**
   * 04 §8.11.10: the account of the host's `anthropic` ledger lines and events (this PC has the slot and the host is
   * switched on): the Claude account the host's item names when it is one of this PC's (02 §8.7), else
   * `acc_claude_slot`; `null` otherwise (no account).
   */
  readonly claude: (hostId: string, accountID: string | null) => Account.ID | null
  /** `runtime.ledger.usage` + `ledger.line` broadcast; resolves whether it was new. */
  readonly usage: (eid: string, line: Ledger.Line) => Promise<boolean>
  readonly event: (input: {
    readonly eid: string
    readonly ts: number
    readonly type: string
    readonly accountID?: string | null
    readonly providerID?: string | null
    readonly sessionID?: string | null
    readonly data?: Record<string, unknown>
  }) => Promise<void>
  /**
   * Merges windows into the local limit store and announces the significant ones; forgets `dropped` (a verified Ultra
   * account's `claude.5h`, 02 §7.1.2) and announces those it had.
   */
  readonly limits: (
    windows: ReadonlyArray<Limit.Window>,
    dropped?: ReadonlyArray<Pick<Limit.Window, "accountID" | "id">>,
  ) => void
  readonly authFailure: (hostId: string, payload: Broker.AuthFailurePayload) => void
  readonly gap: (hostId: string, payload: Broker.GapPayload) => void
}

export interface Result {
  readonly ackThrough: number
  readonly accepted: number
  readonly rejected: number
  readonly gaps: number
  /** Stopped at an item of a schema version this build cannot read. */
  readonly blocked: boolean
}

const decodeItem = Schema.decodeUnknownOption(Broker.Item)
const decodeLedger = Schema.decodeUnknownOption(Broker.LedgerPayload)
const decodeLimits = Schema.decodeUnknownOption(Broker.LimitsPayload)
const decodeEvent = Schema.decodeUnknownOption(Broker.EventPayload)
const decodeAuth = Schema.decodeUnknownOption(Broker.AuthFailurePayload)
const decodeGap = Schema.decodeUnknownOption(Broker.GapPayload)

/** Upper bound of `usedPercent` accepted from a host: 0–100, with Codex's over-100 reports when exhausted. */
export const MAX_USED_PERCENT = 150

/**
 * Remote clock → local clock (04 §10.5): subtract the skew measured by `ping`; with no measurement or a skew beyond
 * 10 minutes the value is not trusted and the receive time is used.
 */
export function normalize(remoteAt: number, skewMs: number | null, receivedAt: number) {
  if (skewMs === null || Math.abs(skewMs) > Broker.CLOCK_SKEW_UNTRUSTED_MS) return receivedAt
  return remoteAt - skewMs
}

export async function ingest(input: {
  readonly hostId: string
  readonly sink: Sink
  readonly ackThrough: number
  readonly skewMs: number | null
  readonly items: ReadonlyArray<unknown>
}): Promise<Result> {
  const { sink, hostId } = input
  let ackThrough = input.ackThrough
  let accepted = 0
  let rejected = 0
  let gaps = 0
  let registry: Registry.File | undefined
  const accountOf = async (providerID: string, claimed: string | null = null) => {
    if (providerID === Provider.ID.anthropic) return sink.claude(hostId, claimed)
    registry ??= await sink.registry()
    return Store.accountFor(registry, providerID)?.id ?? null
  }
  const items = input.items
    .map((raw) => ({ raw, item: Option.getOrUndefined(decodeItem(raw)) }))
    .toSorted((a, b) => (a.item?.seq ?? 0) - (b.item?.seq ?? 0))
  for (const { item } of items) {
    if (!item) {
      rejected++
      continue
    }
    if (item.seq <= ackThrough) continue
    if (item.schemaVersion > Broker.ITEM_SCHEMA_VERSION) return { ackThrough, accepted, rejected, gaps, blocked: true }
    const now = sink.now()
    const ok = await apply(item, now).catch(() => false)
    if (ok) accepted++
    else rejected++
    ackThrough = item.seq
  }
  return { ackThrough, accepted, rejected, gaps, blocked: false }

  async function apply(item: Broker.Item, now: number): Promise<boolean> {
    const future = now + Broker.FUTURE_TOLERANCE_MS
    switch (item.type) {
      case "ledger": {
        const payload = Option.getOrUndefined(decodeLedger(item.payload))
        if (!payload) return false
        const line = payload.line
        const ts = normalize(line.ts, input.skewMs, now)
        if (ts > future || !validTokens(line)) return false
        const next: Ledger.Line = {
          ...line,
          ts,
          accountID: await accountOf(line.providerID, line.accountID),
          server: hostId,
          remoteAt: line.ts,
        }
        await sink.usage(payload.eid, next)
        return true
      }
      case "limits": {
        const payload = Option.getOrUndefined(decodeLimits(item.payload))
        if (!payload) return false
        const windows: Limit.Window[] = []
        for (const window of payload.windows) {
          // The Claude slot's windows are this PC's relay observations alone (04 §8.11.10).
          if (window.providerID === Provider.ID.anthropic) return false
          const observedAt = normalize(window.observedAt, input.skewMs, now)
          if (observedAt > future) return false
          if (window.usedPercent !== undefined && window.usedPercent > MAX_USED_PERCENT) return false
          const accountID = await accountOf(window.providerID)
          if (!accountID || accountID !== window.accountID) return false
          windows.push({ ...window, observedAt, origin: hostId })
        }
        if (windows.length > 0) sink.limits(windows)
        return true
      }
      case "event": {
        const payload = Option.getOrUndefined(decodeEvent(item.payload))
        if (!payload) return false
        const ts = normalize(payload.ts, input.skewMs, now)
        if (ts > future) return false
        const accountID =
          payload.providerID === undefined || payload.providerID === null
            ? null
            : await accountOf(payload.providerID, payload.accountID ?? null)
        await sink.event({
          eid: payload.eid,
          ts,
          type: payload.type,
          accountID,
          providerID: payload.providerID ?? null,
          sessionID: payload.sessionID ?? null,
          data: { ...payload.data, server: hostId, remoteAt: payload.ts },
        })
        return true
      }
      case "authFailure": {
        const payload = Option.getOrUndefined(decodeAuth(item.payload))
        if (!payload) return false
        sink.authFailure(hostId, payload)
        return true
      }
      case "gap": {
        const payload = Option.getOrUndefined(decodeGap(item.payload))
        if (!payload || payload.toSeq < payload.fromSeq) return false
        gaps++
        sink.gap(hostId, payload)
        return true
      }
      default:
        return false
    }
  }
}

function validTokens(line: Ledger.Line) {
  if (line.P !== null && line.P < 0) return false
  if (line.hit !== null && (line.hit < 0 || line.hit > 1)) return false
  return true
}

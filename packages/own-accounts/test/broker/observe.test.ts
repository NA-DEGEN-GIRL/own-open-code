// Local ingestion of remote observations (04 §10.3, §10.5): ack de-duplication, clock normalization, validation,
// `accountID` recomputed locally, `server`/`origin` tags, gaps, and a stop at an unreadable item version.
import { describe, expect, test } from "bun:test"
import { Account, Broker, type Ledger, type Limit } from "@own/protocol"
import { Observe } from "../../src/broker/observe.js"
import { registryWith } from "../slots/support.js"

const NOW = Date.UTC(2026, 8, 27, 3, 0, 0)

/** Hosts switched on for the Claude slot on this PC (04 §8.11.10). */
const CLAUDE_HOSTS = new Set(["h-obs001"])

async function setup() {
  const registry = await registryWith([{ kind: "oai", label: "Key", slug: "keya" }])
  const account = registry.accounts[0]!
  const written: Array<{ eid: string; line: Ledger.Line }> = []
  const events: Array<Record<string, unknown>> = []
  const windows: Limit.Window[] = []
  const failures: Array<{ hostId: string; payload: Broker.AuthFailurePayload }> = []
  const gaps: Broker.GapPayload[] = []
  const sink: Observe.Sink = {
    now: () => NOW,
    registry: async () => registry,
    claude: (hostId, accountID) =>
      CLAUDE_HOSTS.has(hostId) ? Account.ID.make(accountID === "acc_01CLAUDE2" ? accountID : "acc_claude_slot") : null,
    usage: async (eid, line) => {
      if (written.some((entry) => entry.eid === eid)) return false
      written.push({ eid, line })
      return true
    },
    event: async (input) => void events.push(input),
    limits: (items) => void windows.push(...items),
    authFailure: (hostId, payload) => void failures.push({ hostId, payload }),
    gap: (_hostId, payload) => void gaps.push(payload),
  }
  return { registry, account, sink, written, events, windows, failures, gaps }
}

function line(providerID: string, ts: number, extra: Partial<Ledger.Line> = {}): Ledger.Line {
  return {
    v: 1,
    ts,
    sessionID: "ses_remote01" as Ledger.Line["sessionID"],
    messageID: "msg_1",
    kind: "primary",
    accountID: "acc_forged" as Ledger.Line["accountID"],
    providerID: providerID as Ledger.Line["providerID"],
    modelID: "gpt-5.5" as Ledger.Line["modelID"],
    variant: null,
    credentialRef: null,
    transport: null,
    switchEpoch: 0,
    compactionEpoch: 0,
    tokens: { input: 100, cacheRead: 50, cacheWrite: 0, cacheWrite1h: null, output: 20, reasoning: 0 },
    P: 150,
    hit: 0.33,
    cost: null,
    costUSDOpenCode: null,
    coldExpected: null,
    usageSource: "event",
    ...extra,
  }
}

function item(seq: number, type: string, payload: unknown, extra: Partial<Broker.Item> = {}): Broker.Item {
  return { seq, eventId: `01J${String(seq).padStart(23, "0")}`, schemaVersion: 1, at: NOW, type, payload, ...extra }
}

describe("Observe.ingest", () => {
  test("ledger lines get server = hostId, a local accountID and a normalized ts; remoteAt keeps the original", async () => {
    const { account, sink, written } = await setup()
    const skew = 90_000
    const result = await Observe.ingest({
      hostId: "h-obs001",
      sink,
      ackThrough: 0,
      skewMs: skew,
      items: [item(1, "ledger", { eid: "st_1", line: line(account.providerID, NOW - 10_000 + skew) })],
    })
    expect(result).toEqual({ ackThrough: 1, accepted: 1, rejected: 0, gaps: 0, blocked: false })
    expect(written).toHaveLength(1)
    expect(written[0]!.line).toMatchObject({
      server: "h-obs001",
      accountID: account.id,
      ts: NOW - 10_000,
      remoteAt: NOW - 10_000 + skew,
    })
  })

  test("items at or below ackThrough are skipped (a resend after a local restart writes nothing twice)", async () => {
    const { account, sink, written } = await setup()
    const items = [1, 2, 3].map((seq) => item(seq, "ledger", { eid: `st_${seq}`, line: line(account.providerID, NOW) }))
    const first = await Observe.ingest({ hostId: "h-obs001", sink, ackThrough: 0, skewMs: 0, items: items.slice(0, 2) })
    expect(first.ackThrough).toBe(2)
    const second = await Observe.ingest({ hostId: "h-obs001", sink, ackThrough: 2, skewMs: 0, items })
    expect(second).toMatchObject({ ackThrough: 3, accepted: 1 })
    expect(written.map((entry) => entry.eid)).toEqual(["st_1", "st_2", "st_3"])
  })

  test("validation: future times, bad ranges and unknown types are dropped and counted, still acknowledged", async () => {
    const { account, sink, written, windows } = await setup()
    const window: Limit.Window = {
      id: "oai.requests",
      accountID: account.id,
      providerID: account.providerID,
      scope: "account",
      kind: "rate",
      label: "요청",
      status: "ok",
      confidence: "live",
      source: "header",
      observedAt: NOW,
      usedPercent: 40,
    }
    const result = await Observe.ingest({
      hostId: "h-obs001",
      sink,
      ackThrough: 0,
      skewMs: 0,
      items: [
        item(1, "ledger", { eid: "st_future", line: line(account.providerID, NOW + 10 * 60_000) }),
        item(2, "ledger", { eid: "st_neg", line: { ...line(account.providerID, NOW), tokens: { input: -1 } } }),
        item(3, "limits", { windows: [{ ...window, usedPercent: 400 }] }),
        item(4, "limits", { windows: [{ ...window, accountID: "acc_someone_else" }] }),
        item(5, "limits", { windows: [window] }),
        item(6, "mystery", {}),
        { garbage: true },
      ],
    })
    expect(result).toMatchObject({ ackThrough: 6, accepted: 1, rejected: 6, blocked: false })
    expect(written).toEqual([])
    expect(windows).toEqual([{ ...window, origin: "h-obs001" }])
  })

  test("a skew over 10 minutes is not trusted: the receive time is used", async () => {
    const { account, sink, written } = await setup()
    await Observe.ingest({
      hostId: "h-obs001",
      sink,
      ackThrough: 0,
      skewMs: 20 * 60_000,
      items: [item(1, "ledger", { eid: "st_1", line: line(account.providerID, NOW - 3_600_000) })],
    })
    expect(written[0]!.line.ts).toBe(NOW)
    expect(Observe.normalize(1_000, null, 5)).toBe(5)
    expect(Observe.normalize(1_000, 400, 5)).toBe(600)
  })

  test("an item of a newer schema version stops the batch without acknowledging it", async () => {
    const { account, sink, written } = await setup()
    const result = await Observe.ingest({
      hostId: "h-obs001",
      sink,
      ackThrough: 0,
      skewMs: 0,
      items: [
        item(1, "ledger", { eid: "st_1", line: line(account.providerID, NOW) }),
        item(2, "ledger", { eid: "st_2", line: line(account.providerID, NOW) }, { schemaVersion: Broker.ITEM_SCHEMA_VERSION + 1 }),
        item(3, "ledger", { eid: "st_3", line: line(account.providerID, NOW) }),
      ],
    })
    expect(result).toMatchObject({ ackThrough: 1, blocked: true })
    expect(written.map((entry) => entry.eid)).toEqual(["st_1"])
  })

  test("events, auth failures and gaps go to their sinks with the host tag", async () => {
    const { account, sink, events, failures, gaps } = await setup()
    const result = await Observe.ingest({
      hostId: "h-obs001",
      sink,
      ackThrough: 0,
      skewMs: 0,
      items: [
        item(1, "event", { eid: "sw_1", ts: NOW, type: "switch", providerID: account.providerID, sessionID: "ses_1", data: { from: "a" } }),
        item(2, "authFailure", { providerID: account.providerID, authHash8: "abcd1234", status: 401 }),
        item(3, "gap", { fromSeq: 10, toSeq: 19, count: 10 }),
      ],
    })
    expect(result).toMatchObject({ ackThrough: 3, accepted: 3, gaps: 1 })
    expect(events[0]).toMatchObject({ eid: "sw_1", type: "switch", accountID: account.id, data: { from: "a", server: "h-obs001" } })
    expect(failures).toEqual([{ hostId: "h-obs001", payload: { providerID: account.providerID, authHash8: "abcd1234", status: 401 } }])
    expect(gaps).toEqual([{ fromSeq: 10, toSeq: 19, count: 10 }])
  })

  test("04 §8.11.10: a switched-on host's anthropic lines and events are the Claude slot's; its windows are refused", async () => {
    const { sink, written, events, windows } = await setup()
    const anthropic = (eid: string) => item(Number(eid.slice(3)), "ledger", { eid, line: line("anthropic", NOW) })
    const allowed = await Observe.ingest({ hostId: "h-obs001", sink, ackThrough: 0, skewMs: 0, items: [anthropic("st_1")] })
    expect(allowed).toMatchObject({ accepted: 1, rejected: 0 })
    expect(written[0]!.line).toMatchObject({ accountID: "acc_claude_slot", server: "h-obs001", providerID: "anthropic" })
    // A host not switched on: the line is kept for the totals but belongs to no account.
    await Observe.ingest({ hostId: "h-other1", sink, ackThrough: 0, skewMs: 0, items: [anthropic("st_2")] })
    expect(written[1]!.line).toMatchObject({ accountID: null, server: "h-other1" })
    // The relay on this PC is the only observer of the slot's windows: a host's `claude.*` windows are dropped.
    const claudeWindow: Limit.Window = {
      id: "claude.5h",
      accountID: "acc_claude_slot" as Limit.Window["accountID"],
      providerID: "anthropic" as Limit.Window["providerID"],
      scope: "account",
      kind: "rolling_quota",
      label: "5시간",
      windowMinutes: 300,
      usedPercent: 10,
      status: "ok",
      confidence: "live",
      source: "header",
      observedAt: NOW,
    }
    const refused = await Observe.ingest({
      hostId: "h-obs001",
      sink,
      ackThrough: 0,
      skewMs: 0,
      items: [item(1, "limits", { windows: [claudeWindow] })],
    })
    expect(refused).toMatchObject({ accepted: 0, rejected: 1 })
    expect(windows).toEqual([])
    // own-telemetry's exhaustion on the host arrives as an event of the slot.
    await Observe.ingest({
      hostId: "h-obs001",
      sink,
      ackThrough: 0,
      skewMs: 0,
      items: [
        item(1, "event", {
          eid: "exh_1",
          ts: NOW,
          type: "exhaustion",
          accountID: "acc_claude_slot",
          providerID: "anthropic",
          sessionID: "ses_1",
          data: { class: "hard", windowId: "claude.5h" },
        }),
      ],
    })
    expect(events[0]).toMatchObject({
      eid: "exh_1",
      type: "exhaustion",
      accountID: "acc_claude_slot",
      providerID: "anthropic",
      data: { class: "hard", windowId: "claude.5h", server: "h-obs001" },
    })
  })
})

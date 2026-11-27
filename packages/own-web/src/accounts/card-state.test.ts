// The 계정 card's state tag follows the screen's windows (03 §5.4, LV 2026-10-25): a spend moves an API key's monthly
// budget with a `quota.updated` and no `accounts.changed`, so `accounts.list` (its `limitsSummary.worst`) is not read
// again. The real own store over the event bus, with own-accounts' budget windows as `quota.snapshot` and
// `quota.updated` carry them ($15 and then $23 of a $25 budget).
import { expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import { createI18n } from "@/i18n"
import { cardLead, statusText, statusTone } from "./account-card"

const NOW = Date.UTC(2026, 9, 25, 3, 0, 0)
const ID = "acc_anb1"

const budget = (spent: number) => ({
  id: "api.budget_month",
  accountID: ID,
  providerID: "own-anth-anb1",
  scope: "account",
  kind: "budget",
  label: "이번 달 예산",
  usedPercent: (100 * spent) / 25,
  remaining: 25 - spent,
  limit: 25,
  unit: "USD",
  resetAt: Date.UTC(2026, 10, 1),
  status: spent / 25 >= 0.8 ? "warning" : "ok",
  confidence: "live",
  source: "ledger",
  observedAt: NOW - 5_000,
})

const account = {
  id: ID,
  kind: "anth",
  label: "Anthropic API",
  shortLabel: "A",
  color: "indigo",
  providerID: "own-anth-anb1",
  billing: "metered",
  status: "ready",
  autoSwitch: true,
  thirdParty: false,
  readOnly: false,
  identity: {},
  connection: { type: "key", method: "api-key" },
  // `Views.summary` when the list was read: the budget at 60 %.
  limitsSummary: { worst: { id: "api.budget_month", usedPercent: 60, resetAt: Date.UTC(2026, 10, 1), status: "ok" } },
  budget: { monthlyUSD: 25 },
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 80))

test("a quota.updated that moves the budget to 92 % turns the tag to 주의 · 이번 달 예산 남음 8% without a list reload", async () => {
  const calls: string[] = []
  const answers: Record<string, unknown> = {
    health: { version: "local", buildId: "b", guard: "ok", controlDir: "C:\\ctl" },
    "accounts.list": { revision: 1, accounts: [account] },
    "quota.snapshot": { windows: [budget(15)], exhausted: [] },
    "presets.list": { groups: [] },
    "policy.get": { policy: { defaults: { byKind: {} } } },
  }
  const client = {
    rpc: {
      call: async (input: { method: string }) => {
        calls.push(input.method)
        return { output: answers[input.method] ?? {} }
      },
    },
    session: { get: async () => ({}), list: async () => ({ data: [], cursor: {} }), compact: async () => ({}) },
    project: { list: async () => [] },
  }
  const i18n = createI18n("ko")
  await createRoot(async (dispose) => {
    const bus = createEventBus()
    const rpc = createOwnRpc({
      // SAFETY: the store only reaches the members defined above.
      client: () => client as unknown as OpenCodeClient,
      routing: { control: async () => "C:\\ctl", sessionDirectory: () => "D:\\p" },
      scopes: () => ALL_SCOPES,
    })
    const own = createOwnStore({
      rpc,
      bus,
      client: () => client as unknown as OpenCodeClient,
      sessionDirectory: () => "D:\\p",
    })
    const tag = () => {
      const item = own.state.accounts[ID]!
      const lead = cardLead(item, own.state.quota[ID] ?? (own.state.quotaLoaded ? [] : undefined), NOW)
      return [statusTone(item, lead), statusText(i18n, item, lead)]
    }
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.state.quotaLoaded).toBe(true)
    expect(tag()).toEqual(["ok", "정상"])
    // The spend's `quota.updated` (own-accounts' relay: the account's windows, no `accounts.changed`).
    bus.publish({
      id: "evt_q1",
      created: NOW,
      type: "rpc.own.accounts.quota.updated",
      location: { directory: "C:\\ctl" },
      data: { eventId: "q1", origin: "global", accountID: ID, windows: [budget(23)] },
    } as OpenCodeEvent)
    bus.flush()
    own.flush()
    expect(tag()).toEqual(["warn", "주의 · 이번 달 예산 남음 8%"])
    // The list still says 60 %: it was read once.
    expect(own.state.accounts[ID]?.limitsSummary?.worst?.usedPercent).toBe(60)
    expect(calls.filter((method) => method === "accounts.list")).toHaveLength(1)
    dispose()
  })
})

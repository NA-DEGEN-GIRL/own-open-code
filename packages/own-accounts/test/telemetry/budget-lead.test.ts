// The monthly budget as a first-class limit window (LV 2026-10-25, the third limits review's finding 1): through the
// real slots, telemetry, relay and runtime store, a DeepSeek and an API-key account whose budget is 92 % spent lead
// with the budget on the server (`accounts.list` `limitsSummary.worst`, the card's state) and on the screen (own-web
// keeps `quota.snapshot`'s windows per account and replaces them with each `quota.updated`, then leads with
// `LimitRank.ranked(…)[0]`), before and after a `quota.updated`. Fake credentials and a local fake DeepSeek only.
import { describe, expect, test } from "bun:test"
import { Account, LimitRank, type Limit } from "@own/protocol"
import { Poller } from "../../src/telemetry/poller.js"
import { hashSecret, startFakeOpenAIChat } from "../e2e-kit"
import { testDeps } from "../support/deps.js"
import { failure, registryWith, rpcContext } from "../slots/support.js"
import {
  fakeLogins,
  fakePlugins,
  httpEvent,
  memoryStorage,
  ok,
  recordEvents,
  step,
  type LoginCalls,
} from "./support.js"

const DS = Account.ID.make("acc_dsb1")
const KEY = Account.ID.make("acc_anb1")
const BUDGET = 25
const MODEL = "budget-test-model"

async function world(endpoint: string) {
  const registry = await registryWith([
    { kind: "ds", label: "DeepSeek", slug: "dsb1" },
    { kind: "anth", label: "Anthropic API", slug: "anb1" },
  ])
  const t = await testDeps({
    ctx: {
      storage: memoryStorage(),
      provider: { reload: async () => {}, list: async () => [] },
    },
    options: { endpoints: { deepseek: endpoint } },
  })
  await t.deps.runtime.registry.write({
    ...registry,
    accounts: registry.accounts.map((account) => ({
      ...account,
      budget: { monthlyUSD: BUDGET },
      ...(account.kind === "ds" ? { pollBalance: true } : {}),
    })),
  })
  const calls: LoginCalls = { unauthorized: [], headers: [], rejected: [] }
  const modules = t.modules({ logins: fakeLogins(calls), plugins: fakePlugins(false) })
  const events = recordEvents(t.deps.emitter)
  await modules.slots.start()
  await modules.telemetry.start()
  const providerOf = (accountID: string) => modules.slots.account(accountID)?.providerID ?? ""
  /** What own-web holds per account: the snapshot's windows, each replaced by a later `quota.updated`. */
  const screen = new Map<string, readonly Limit.Window[]>()
  return {
    ...t,
    modules,
    providerOf,
    screen,
    /** One step that cost `usd` on the account, through the real event stream into the ledger. */
    async spend(accountID: string, usd: number, messageID: string) {
      for (const item of step({
        providerID: providerOf(accountID),
        modelID: MODEL,
        messageID,
        at: t.clock.now(),
        directory: t.deps.location.directory,
        usage: { input: 10 },
        cost: usd,
      }))
        await modules.telemetry.onEvent?.(item, { local: true })
      await modules.telemetry.flush()
    },
    /** The server's lead (`accounts.list`, the card's state). */
    async serverLead(accountID: string) {
      const result = await modules.slots.list({}, rpcContext<"accounts.list">())
      if (failure(result) || !("accounts" in result)) throw new Error("accounts.list failed")
      return result.accounts.find((account) => account.id === accountID)?.limitsSummary?.worst
    },
    async snapshot() {
      const windows = (await ok(modules.telemetry.quotaSnapshot, {})).windows
      screen.clear()
      for (const window of windows) screen.set(window.accountID, [...(screen.get(window.accountID) ?? []), window])
    },
    /** Applies the `quota.updated` events since `from` as own-web's store does, returns how many there were. */
    updates(from: number) {
      const updates = events.filter((event) => event.name === "quota.updated").slice(from)
      for (const update of updates)
        screen.set(String(update.data.accountID), update.data.windows as readonly Limit.Window[])
      return updates
    },
    quotaUpdates: () => events.filter((event) => event.name === "quota.updated").length,
    screenLead: (accountID: string) => LimitRank.ranked(screen.get(accountID) ?? [], t.clock.now())[0],
    async [Symbol.asyncDispose]() {
      await modules.telemetry.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

describe("the monthly budget is a limit window like the others (LV, review 3 finding 1)", () => {
  test("a 92 %-spent budget leads a DeepSeek and an API-key account on the server and on screen, before and after a quota.updated", async () => {
    const chat = startFakeOpenAIChat()
    chat.setBalance(hashSecret("fake-key"), { available: true, currency: "USD", total: "7.42" })
    try {
      await using w = await world(chat.baseURL)
      // DeepSeek's balance (an amount, which led its card) and the key's request window (2 % used).
      w.clock.advance(Poller.TICK_MS)
      await w.modules.telemetry.flush()
      await w.modules.telemetry.onHttpResponse(
        httpEvent({
          providerID: w.providerOf(KEY),
          response: new Response("", {
            headers: {
              "anthropic-ratelimit-requests-limit": "50",
              "anthropic-ratelimit-requests-remaining": "49",
              "anthropic-ratelimit-requests-reset": new Date(w.clock.now() + 60_000).toISOString(),
            },
          }),
        }),
      )
      await w.spend(DS, 23, "msg_ds_1")
      await w.spend(KEY, 23, "msg_key_1")
      w.clock.advance(5_000)

      await w.snapshot()
      for (const accountID of [DS, KEY]) {
        expect(await w.serverLead(accountID)).toMatchObject({ id: "api.budget_month", usedPercent: 92 })
        expect(w.screenLead(accountID)?.id).toBe("api.budget_month")
      }

      // A later quota.updated of each account (the balance polled again, another response's request window).
      const before = w.quotaUpdates()
      chat.setBalance(hashSecret("fake-key"), { available: true, currency: "USD", total: "7.40" })
      w.clock.advance(Poller.INTERVAL_MS)
      await w.modules.telemetry.flush()
      await w.modules.telemetry.onHttpResponse(
        httpEvent({
          providerID: w.providerOf(KEY),
          response: new Response("", {
            headers: {
              "anthropic-ratelimit-requests-limit": "50",
              "anthropic-ratelimit-requests-remaining": "40",
              "anthropic-ratelimit-requests-reset": new Date(w.clock.now() + 60_000).toISOString(),
            },
          }),
        }),
      )
      w.clock.advance(5_000)
      const updates = w.updates(before)
      expect(new Set(updates.map((update) => update.data.accountID))).toEqual(new Set([DS, KEY]))
      for (const accountID of [DS, KEY]) {
        expect(w.screen.get(accountID)?.map((window) => window.id)).toContain("api.budget_month")
        expect(w.screenLead(accountID)?.id).toBe("api.budget_month")
        expect((await w.serverLead(accountID))?.id).toBe("api.budget_month")
      }
    } finally {
      await chat.stop()
    }
  })

  test("each spend reaches the screen as a quota.updated; a removed budget leaves the store and the screen", async () => {
    const chat = startFakeOpenAIChat()
    try {
      await using w = await world(chat.baseURL)
      await w.snapshot()
      const before = w.quotaUpdates()
      await w.spend(KEY, 10, "msg_key_1")
      w.clock.advance(5_000)
      w.updates(before)
      expect(w.screen.get(KEY)?.find((window) => window.id === "api.budget_month")).toMatchObject({ usedPercent: 40 })

      const removed = w.quotaUpdates()
      // What the broker relays to connected hosts (test/remote/broker.test.ts): the window this PC forgot.
      const dropped: Array<Pick<Limit.Window, "accountID" | "id">> = []
      const stop = w.deps.runtime.broadcast.on("limits.updated", (change) => dropped.push(...(change.dropped ?? [])))
      await w.deps.runtime.registry.update((current) => ({
        ...current,
        revision: current.revision + 1,
        accounts: current.accounts.map((account) => (account.id === KEY ? { ...account, budget: null } : account)),
      }))
      w.deps.runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local" })
      await w.modules.telemetry.flush()
      w.clock.advance(5_000)
      w.updates(removed)
      expect(w.deps.runtime.limits.list({ accountID: KEY })).toEqual([])
      expect(w.screen.get(KEY)).toEqual([])
      expect(await w.serverLead(KEY)).toBeNull()
      expect(dropped).toEqual([{ accountID: KEY, id: "api.budget_month" }])
      stop()
    } finally {
      await chat.stop()
    }
  })
})

// Claude Agent accounts in the per-account compaction settings and the other generic account surfaces (02 §8.10.5,
// decisions CAG-50, CAG-53): `accounts.list` shows each account's setting over the route's models (the windows Claude
// Code reported, `claude-agent` in the fold), `accounts.update{compaction}` checks, previews and stores it per account,
// `policy.set` takes a kind default for the route, the threshold a conversation gets follows its tree's account, and the
// account RPCs that are not the route's answer what to use instead of "not found". Real modules on a temp OWN_HOME.
import { describe, expect, test } from "bun:test"
import { Account, Compaction, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { Modules } from "../../src/modules.js"
import { testDeps } from "../support/deps.js"
import { catalogModel, failure, fakeEditor, memoryStorage, rpcContext } from "../slots/support.js"

const A = Account.ID.make("acc_ca_a")
const B = Account.ID.make("acc_ca_b")
const WINDOW = 200_000

function agentAccount(accountID: Account.ID, shortLabel: string): Registry.ClaudeAgentAccount {
  return {
    accountID,
    configDir: `C:/own/claude-agent/accounts/${accountID}`,
    label: null,
    shortLabel,
    color: "orange",
    addedAt: "2026-11-03T00:00:00.000Z",
  }
}

async function setup() {
  const t = await testDeps({
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      storage: memoryStorage().storage,
    },
  })
  await t.deps.runtime.registry.write({
    ...Store.emptyRegistry(),
    claudeAgents: [agentAccount(A, "CA"), agentAccount(B, "CA2")],
  })
  const modules = t.modules()
  await modules.slots.start()
  // The route's models as the fold sees them: the windows Claude Code reported.
  const models = ["haiku", "sonnet"].map((id) =>
    catalogModel("claude-agent", id, { limit: { context: WINDOW, output: 0 } }),
  )
  modules.slots.transformProviders(fakeEditor({ "claude-agent": { models } }).editor)
  return {
    t,
    modules,
    async view(accountID: string) {
      const listed = await modules.slots.list({}, rpcContext<"accounts.list">())
      if (failure(listed) || !("accounts" in listed)) throw new Error("list failed")
      const found = listed.accounts.find((item) => item.id === accountID)
      if (!found) throw new Error(`no ${accountID}`)
      return found
    },
    async [Symbol.asyncDispose]() {
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

describe("Claude Agent compaction per account (CAG-50)", () => {
  test("the list shows each account's setting over the route's windows; an update previews, checks and stores it", async () => {
    await using s = await setup()
    const before = await s.view(A)
    expect<unknown>(before.compaction).toEqual({
      setting: null,
      effective: [
        { modelID: "haiku", windowTokens: WINDOW, triggerTokens: Compaction.ceiling(WINDOW), source: "v2" },
        { modelID: "sonnet", windowTokens: WINDOW, triggerTokens: Compaction.ceiling(WINDOW), source: "v2" },
      ],
    })

    // A conversation on A (the default account) at 100k: a 40 % setting would compact it at its next step.
    s.t.deps.runtime.sessions.update("ses_on_a", { providerID: "claude-agent", modelID: "haiku", P: 100_000 })
    const dry = await s.modules.slots.update(
      { accountID: A, compaction: { triggerPercent: 40 }, dryRun: true },
      rpcContext<"accounts.update">(),
    )
    if (failure(dry) || !("account" in dry)) throw new Error("dry run failed")
    expect(dry.compactionImpact?.sessions.map((item) => [String(item.sessionID), item.triggerTokens])).toEqual([
      ["ses_on_a", 80_000],
    ])
    expect(dry.account.compaction?.setting).toBeNull()

    const saved = await s.modules.slots.update(
      { accountID: A, compaction: { triggerPercent: 40 } },
      rpcContext<"accounts.update">(),
    )
    if (failure(saved) || !("account" in saved)) throw new Error("update failed")
    expect(saved.account.compaction?.setting).toEqual({ triggerPercent: 40 })
    expect(saved.account.compaction?.effective[0]).toMatchObject({ triggerTokens: 80_000, source: "account" })
    expect(s.modules.slots.snapshot().claudeAgents?.find((item) => item.accountID === A)?.compaction).toEqual({
      triggerPercent: 40,
    })
    // B keeps the kind default; a conversation's threshold follows its tree's account (the default, A, here).
    expect((await s.view(B)).compaction?.setting).toBeNull()
    expect(s.modules.slots.compaction("claude-agent", "haiku", undefined, "ses_on_a")?.triggerTokens).toBe(80_000)

    // Out of range is refused with the range; another field next to it is refused by name.
    const low = await s.modules.slots.update(
      { accountID: A, compaction: { triggerPercent: 5 } },
      rpcContext<"accounts.update">(),
    )
    expect(failure(low)?.type).toBe("setting_out_of_range")
    const mixed = await s.modules.slots.update(
      { accountID: A, compaction: { triggerPercent: 50 }, label: "다른 이름" },
      rpcContext<"accounts.update">(),
    )
    expect(failure(mixed)).toMatchObject({ type: "policy_denied", data: { field: "label" } })

    // `null` goes back to the kind default.
    const cleared = await s.modules.slots.update({ accountID: A, compaction: null }, rpcContext<"accounts.update">())
    if (failure(cleared) || !("account" in cleared)) throw new Error("clear failed")
    expect(cleared.account.compaction?.setting).toBeNull()
    expect(s.modules.slots.snapshot().claudeAgents?.find((item) => item.accountID === A)?.compaction).toBeUndefined()
  })

  test("a kind default for the route applies to every account without its own setting", async () => {
    await using s = await setup()
    expect(s.modules.slots.windows("claude-agent")).toEqual(
      new Map([
        ["haiku", WINDOW],
        ["sonnet", WINDOW],
      ]),
    )
    s.t.deps.runtime.sessions.update("ses_on_a", { providerID: "claude-agent", modelID: "sonnet", P: 150_000 })
    const impact = s.modules.slots.impact({
      providerIDs: ["claude-agent"],
      policy: { "claude-agent": { triggerPercent: 60 } },
    })
    expect(impact.sessions.map((item) => [String(item.sessionID), item.triggerTokens])).toEqual([["ses_on_a", 120_000]])
  })
})

describe("Claude Agent ids on the generic account RPCs (CAG-53)", () => {
  test("removal points to the route's own RPC instead of saying the account is gone", async () => {
    await using s = await setup()
    const plan = await s.modules.slots.removePlan(
      { accountID: A, mode: "disable" },
      rpcContext<"accounts.remove.plan">(),
    )
    expect(failure(plan)).toMatchObject({ type: "policy_denied", data: { field: "accountID" } })
    expect(failure(plan)?.message).toContain("claudeAgent.remove")
  })

  test("the account view carries its last step in this process", async () => {
    await using s = await setup()
    expect((await s.view(A)).lastUsedAt).toBeNull()
  })
})

// CAM-2: the rows of the model @ account sheet are `accounts.list`'s, which clients read again only on
// `accounts.changed`. The route's list changes without a registry write (the login check's windows after the saved ones,
// an alias a Claude Code update adds, a turn's window); before, nothing announced it and the rows kept 200k and no
// Fable while the switch estimate already said 1M.
describe("the route's models announce themselves (CAM-2)", () => {
  test("a fold whose models or windows changed sends accounts.changed once; the list then has them all", async () => {
    await using s = await setup()
    const events: string[] = []
    // SAFETY: the fake implements the only member the emitter uses, `events.emit`.
    const registration = { events: { emit: async (name: string) => void events.push(name) } }
    s.t.deps.emitter.bind(registration as unknown as Parameters<typeof s.t.deps.emitter.bind>[0])
    const fold = (windows: Record<string, number>) =>
      s.modules.slots.transformProviders(
        fakeEditor({
          "claude-agent": {
            models: Object.entries(windows).map(([id, context]) =>
              catalogModel("claude-agent", id, { limit: { context, output: 0 } }),
            ),
          },
        }).editor,
      )
    fold({ haiku: 1_000_000, sonnet: 1_000_000, fable: 1_000_000 })
    await Bun.sleep(0)
    expect(events.filter((name) => name === "accounts.changed")).toHaveLength(1)
    expect((await s.view(A)).compaction?.effective.map((item) => [String(item.modelID), item.windowTokens])).toEqual([
      ["haiku", 1_000_000],
      ["sonnet", 1_000_000],
      ["fable", 1_000_000],
    ])
    // The same list again (another Location's fold): nothing new to say.
    fold({ haiku: 1_000_000, sonnet: 1_000_000, fable: 1_000_000 })
    await Bun.sleep(0)
    expect(events.filter((name) => name === "accounts.changed")).toHaveLength(1)
  })
})

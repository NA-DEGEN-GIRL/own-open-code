// 09 §5.6 `estimate.request`: own.import's price of requests on a slot no session runs on yet, through the real
// switching module and the `src/rpc/estimate.ts` group on the switching harness (fake session core, temp OWN_HOME,
// the development rate cards, fake credentials only). Outputs are checked against the protocol schema too.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Account, Limit, OwnAccounts } from "@own/protocol"
import { OwnImport } from "@own/protocol/rpc-import"
import type { Modules } from "../../src/modules.js"
import { EstimateRpc } from "../../src/rpc/estimate.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { Tracker } from "../../src/switching/tracker.js"
import { machine, type MachineInput } from "./harness.js"
import { PROVIDERS, partial, registry } from "./support.js"

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const OA = { providerID: PROVIDERS.oaiA, id: "gpt-5.5", variant: "high" }

/** Built-in and local providers as the model catalog lists them (`ctx.model.list`): no own account. */
const DEEPSEEK = {
  providerID: "deepseek",
  id: "deepseek-v4-pro",
  limit: { context: 128_000 },
  cost: [{ input: 0.435, output: 0.87 }],
  capabilities: { tools: true },
}
const OLLAMA = {
  providerID: "ollama",
  id: "qwen3:8b",
  limit: { context: 40_960 },
  cost: [],
  capabilities: { tools: true },
}
const CLAUDE = {
  providerID: "anthropic",
  id: "claude-opus-5-5",
  limit: { context: 200_000 },
  cost: [{ input: 5, output: 25 }],
  capabilities: { tools: true },
}

const decodeResult = Schema.decodeUnknownSync(OwnAccounts.EstimateRequestResult)
const decodeWindow = Schema.decodeUnknownSync(Limit.Window)

type Machine = Awaited<ReturnType<typeof machine>>

/** Calls `estimate.request` with its input decoded by the protocol schema; a declared error comes back as `{error}`. */
async function estimate(m: Machine, value: unknown) {
  const handlers = EstimateRpc.handlers(partial<Modules.All>("modules", { switching: m.switching }))
  const schema = OwnAccounts.Definition.methods["estimate.request"].input as unknown as Schema.Codec<
    RpcTypes.Input<"estimate.request">,
    unknown
  >
  const context = {
    signal: new AbortController().signal,
    error: (type: string, message: string, data: unknown) => ({ error: { type, message, data } }),
  }
  // SAFETY: the fake context mirrors `RpcCallContext` (`signal`, `error` returning a plain failure record).
  const result: unknown = await handlers["estimate.request"](Schema.decodeUnknownSync(schema)(value), context as never)
  if (typeof result === "object" && result !== null && "error" in result) return result
  return decodeResult(result)
}

function setup(input: MachineInput = {}) {
  return machine({ available: [DEEPSEEK, OLLAMA, CLAUDE], ...input })
}

/** A plan window of an account as the limit store keeps it (02 §7.3). */
function window(input: {
  readonly id: string
  readonly accountID: string
  readonly providerID: string
  readonly minutes?: number
  readonly used?: number
  readonly kind?: Limit.WindowKind
}) {
  return decodeWindow({
    id: input.id,
    accountID: input.accountID,
    providerID: input.providerID,
    scope: "account",
    kind: input.kind ?? "rolling_quota",
    label: input.id,
    ...(input.minutes === undefined ? {} : { windowMinutes: input.minutes }),
    ...(input.used === undefined ? {} : { usedPercent: input.used }),
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: Date.UTC(2026, 8, 27, 2, 59),
  })
}

describe("a subscription slot (09 §5.6)", () => {
  test("unmeasured: the default Z and exchange, the registered window and its ceiling, credits from the card", async () => {
    await using m = await setup()
    expect(await estimate(m, { target: A, requests: [{ prompt: 100_000, output: 0 }] })).toEqual({
      unit: "credits",
      // gpt-5.6-sol: 100 credits per 1M cold input tokens (02 §6.2).
      delta: { lo: 10, hi: 10, unit: "credits" },
      quota: { window: "codex.primary", percent: null, state: "calibrating" },
      remaining: { fiveHour: null, weekly: null },
      Z: Tracker.DEFAULTS.Z,
      zSource: "default",
      exchange: Tracker.DEFAULTS.delta,
      // gpt-5.6-sol registers its Codex window (`Templates.codexLimit`); core's ceiling keeps 10% of it free.
      window: 872_000,
      ceiling: 741_200,
    })
  })

  test("a summary request and a request read from the cache: r_cold, r_read and r_out of the card", async () => {
    await using m = await setup()
    const summary = await estimate(m, { target: A, requests: [{ prompt: 100_000, output: 8_000 }] })
    // 100k cold × 100 + 8k out × 500 per 1M.
    expect(summary).toMatchObject({ delta: { lo: 14, hi: 14, unit: "credits" } })
    const next = await estimate(m, { target: A, requests: [{ prompt: 100_000, output: 0, cachedPrefix: 90_000 }] })
    // 90k read × 10 + 10k cold × 100 per 1M; codex keeps its cache for 5 minutes, so no range.
    expect(next).toMatchObject({ delta: { lo: 1.9, hi: 1.9, unit: "credits" } })
    const together = await estimate(m, {
      target: A,
      requests: [
        { prompt: 100_000, output: 8_000 },
        { prompt: 100_000, output: 0, cachedPrefix: 90_000 },
      ],
    })
    expect(together).toMatchObject({ delta: { lo: 15.9, hi: 15.9, unit: "credits" } })
    expect(await estimate(m, { target: A, requests: [] })).toMatchObject({ delta: { lo: 0, hi: 0 } })
  })

  test("Z and exchange: medians of the slot's recent root sessions, never an own.import session or a subagent", async () => {
    await using m = await setup()
    const sessions = [
      { sessionID: "ses_r1", first: 20_000, next: 2_000 },
      { sessionID: "ses_r2", first: 30_000, next: 6_000 },
      { sessionID: "ses_r3", first: 25_000, next: 5_000 },
    ]
    for (const session of sessions) {
      await m.send("session.created", created(session.sessionID))
      await m.prompt(session.sessionID, "x".repeat(4_000))
      await m.turn(session.sessionID, A, { input: session.first })
      await m.turn(session.sessionID, A, { input: session.next, read: session.first })
    }
    // A helper and an imported conversation start with the imported history; a subagent with another agent's tools.
    const helper = { [OwnImport.META_KEY]: { v: 1, helper: true, jobID: "job_01TESTJOB00000000000000000" } }
    await m.send("session.created", { ...created("ses_helper"), metadata: helper })
    await m.turn("ses_helper", A, { input: 200_000 })
    await m.turn("ses_helper", A, { input: 40_000, read: 200_000 })
    await m.send("session.created", { ...created("ses_child"), parentID: "ses_r1" })
    await m.turn("ses_child", A, { input: 4_000 })
    await m.turn("ses_child", A, { input: 900, read: 4_000 })

    const result = await estimate(m, { target: A, requests: [] })
    // First steps 20k, 30k, 25k less the 1k first prompt each; continuing steps 2k, 6k, 5k.
    expect(result).toMatchObject({ Z: 24_000, zSource: "measured", exchange: 5_000 })
    // Another slot measured nothing.
    expect(await estimate(m, { target: OA, requests: [] })).toMatchObject({
      Z: Tracker.DEFAULTS.Z,
      zSource: "default",
      exchange: Tracker.DEFAULTS.delta,
    })
  })

  test("remaining: the tightest 5-hour and weekly windows of the account", async () => {
    await using m = await setup()
    const own = { accountID: "acc_codexA", providerID: PROVIDERS.codexA }
    m.deps.runtime.limits.upsert([
      window({ ...own, id: "codex.primary", minutes: 300, used: 30 }),
      window({ ...own, id: "codex.gpt-5.6-sol.primary", minutes: 300, used: 55 }),
      window({ ...own, id: "codex.secondary", minutes: 10_080, used: 80 }),
      window({ ...own, id: "codex.credits", kind: "balance" }),
      window({ accountID: "acc_codexB", providerID: PROVIDERS.codexB, id: "codex.primary", minutes: 300, used: 99 }),
    ])
    expect(await estimate(m, { target: A, requests: [] })).toMatchObject({ remaining: { fiveHour: 45, weekly: 20 } })
  })
})

describe("metered, built-in and local targets (09 §4.6)", () => {
  test("an API key slot: USD from the catalog with the card's multipliers, no quota window", async () => {
    await using m = await setup()
    // gpt-5.5 at 1.25 USD in, read 0.1× and cold 1× of it, 10 USD out: 80k × 0.125 + 20k × 1.25 + 1k × 10 per 1M.
    expect(
      await estimate(m, { target: OA, requests: [{ prompt: 100_000, output: 1_000, cachedPrefix: 80_000 }] }),
    ).toEqual({
      unit: "USD",
      delta: { lo: 0.045, hi: 0.045, unit: "USD" },
      quota: null,
      remaining: { fiveHour: null, weekly: null },
      Z: Tracker.DEFAULTS.Z,
      zSource: "default",
      exchange: Tracker.DEFAULTS.delta,
      // The fixture API template's 272k (`test/switching/support.ts`).
      window: 272_000,
      ceiling: 231_200,
    })
  })

  test("a kind whose cache is never sure to be warm prices the cached prefix as a range (02 §6.3 ⑫)", async () => {
    await using m = await setup()
    // The DeepSeek card at the manual clock's Sunday 03:00 UTC, off-peak (×0.5): 0.66 in, 0.022 read per 1M.
    expect(
      await estimate(m, {
        target: { providerID: DEEPSEEK.providerID, id: DEEPSEEK.id },
        requests: [{ prompt: 100_000, output: 0, cachedPrefix: 90_000 }],
      }),
    ).toEqual({
      unit: "USD",
      delta: { lo: 0.00858, hi: 0.066, unit: "USD" },
      quota: null,
      remaining: null,
      Z: Tracker.DEFAULTS.Z,
      zSource: "default",
      exchange: Tracker.DEFAULTS.delta,
      // 128k less its 16k least reserve.
      window: 128_000,
      ceiling: 108_800,
    })
  })

  test("a local model without a price: no delta, the catalog window", async () => {
    await using m = await setup()
    expect(
      await estimate(m, {
        target: { providerID: OLLAMA.providerID, id: OLLAMA.id },
        requests: [{ prompt: 20_000, output: 1_000 }],
      }),
    ).toMatchObject({ unit: "USD", delta: null, quota: null, remaining: null, window: 40_960, ceiling: 24_960 })
  })

  test("the Claude slot: limit percent without a price, the 5-hour window and what its windows have left", async () => {
    await using m = await setup({ claude: { detected: true, version: "1.0.0", integrity: null, verified: true } })
    const slot = { accountID: Account.ID.claudeSlot, providerID: "anthropic" }
    m.deps.runtime.limits.upsert([
      window({ ...slot, id: "claude.5h", minutes: 300, used: 40 }),
      window({ ...slot, id: "claude.7d", minutes: 10_080, used: 75 }),
    ])
    expect(
      await estimate(m, {
        target: { providerID: CLAUDE.providerID, id: CLAUDE.id },
        requests: [{ prompt: 50_000, output: 0 }],
      }),
    ).toMatchObject({
      unit: "percent",
      delta: null,
      quota: { window: "claude.5h", percent: null, state: "calibrating" },
      remaining: { fiveHour: 60, weekly: 25 },
      window: 200_000,
      ceiling: 170_000,
    })
  })

  test("own.import's picked account: a second Claude account's windows, never the slot's; another account is ignored", async () => {
    // The fifth limits review: every Claude account serves `anthropic`, so the plan of Claude 2 read Claude 1's quota.
    const two = "acc_claude_two"
    await using m = await setup({
      claude: { detected: true, version: "1.0.0", integrity: null, verified: true },
      claudeAccounts: {
        entry: (accountID) => (accountID === two || accountID === Account.ID.claudeSlot ? ({} as never) : undefined),
      },
    })
    const slot = { accountID: Account.ID.claudeSlot, providerID: "anthropic" }
    m.deps.runtime.limits.upsert([
      window({ ...slot, id: "claude.5h", minutes: 300, used: 40 }),
      window({ ...slot, id: "claude.7d", minutes: 10_080, used: 75 }),
      window({ accountID: two, providerID: "anthropic", id: "claude.5h", minutes: 300, used: 10 }),
      window({ accountID: two, providerID: "anthropic", id: "claude.7d", minutes: 10_080, used: 20 }),
    ])
    const ask = (target: { readonly providerID: string; readonly id: string }, accountID?: string) =>
      estimate(m, { target, requests: [{ prompt: 50_000, output: 0 }], ...(accountID ? { accountID } : {}) })
    const claude = { providerID: CLAUDE.providerID, id: CLAUDE.id }
    expect(await ask(claude, two)).toMatchObject({ remaining: { fiveHour: 90, weekly: 80 } })
    // Absent, or an account that is not a Claude account: the slot's, as before.
    expect(await ask(claude)).toMatchObject({ remaining: { fiveHour: 60, weekly: 25 } })
    expect(await ask(claude, "acc_codexA")).toMatchObject({ remaining: { fiveHour: 60, weekly: 25 } })
    // Another provider's target prices on its own account only.
    m.deps.runtime.limits.upsert([
      window({ accountID: "acc_codexA", providerID: PROVIDERS.codexA, id: "codex.primary", minutes: 300, used: 30 }),
      window({ accountID: "acc_codexB", providerID: PROVIDERS.codexB, id: "codex.primary", minutes: 300, used: 99 }),
    ])
    expect(await ask(A, "acc_codexB")).toMatchObject({ remaining: { fiveHour: 70 } })
  })
})

describe("errors (09 §5.6, 02 §9.4)", () => {
  test("account_not_found and slot_misconfigured", async () => {
    const file = registry()
    const accounts = file.accounts.map((account) =>
      account.providerID === PROVIDERS.oaiB ? { ...account, status: "misconfigured" as const } : account,
    )
    await using m = await setup({ registry: { ...file, accounts } })
    expect(
      await estimate(m, { target: { providerID: "own-codex-zzzz", id: "gpt-5.6-sol" }, requests: [] }),
    ).toMatchObject({ error: { type: "account_not_found", data: { accountID: "own-codex-zzzz" } } })
    expect(await estimate(m, { target: { ...A, id: "gpt-9" }, requests: [] })).toMatchObject({
      error: { type: "slot_misconfigured", data: { providerID: PROVIDERS.codexA, problems: ["model_not_found"] } },
    })
    expect(await estimate(m, { target: { providerID: PROVIDERS.oaiB, id: "gpt-5.5" }, requests: [] })).toMatchObject({
      error: { type: "slot_misconfigured", data: { providerID: PROVIDERS.oaiB, problems: ["misconfigured"] } },
    })
  })

  test("an unexpected failure answers internal_error and never throws", async () => {
    await using m = await setup()
    const context = {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ error: { type, message, data } }),
    }
    // SAFETY: an input the host's schema would refuse, to make the handler fail inside.
    const result: unknown = await m.switching.estimateRequest(
      { target: undefined, requests: [] } as never,
      context as never,
    )
    expect(result).toEqual({ error: { type: "internal_error", message: "unexpected", data: {} } })
  })
})

/** `session.created` of a root session on {@link A}, as the harness's fake core publishes it. */
function created(sessionID: string) {
  return { sessionID, model: A, projectID: "p", slug: "s", version: "2", location: {} }
}

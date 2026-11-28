// ChatGPT usage-limit reset credits (02 §7.1.1 리셋권) against the fake Codex backend: the count the poller and the
// exhaustion hook read, `quota.resetCredits.list`, and the two-step redeem with its nonce, its single request id and
// every answer. Fake tokens and fake endpoints only; nothing here reaches chatgpt.com.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Account } from "@own/protocol"
import { Register } from "../../src/rpc/register.js"
import { LimitReset } from "../../src/telemetry/limit-reset.js"
import { Poller } from "../../src/telemetry/poller.js"
import { Relay } from "../../src/telemetry/relay.js"
import {
  chatGPTAccount,
  mintChatGPTTokens,
  startFakeCodex,
  writeCodexMultiProviderProfiles,
  type FakeCodex,
  type FakeResetCredit,
} from "../e2e-kit"
import {
  ANTH_ACCOUNT,
  CODEX,
  CODEX_ACCOUNT,
  DEFAULT_SEEDS,
  SIWC,
  SIWC_ACCOUNT,
  call,
  fakeLogins,
  ok,
  registry,
  retryEvent,
  setup,
  wsEvent,
  type AccountSeed,
} from "./support"

const CHATGPT = "acct-reset-credits"
const GRANTED = "2026-10-01T00:00:00Z"
const CREDITS: FakeResetCredit[] = [
  { id: "credit-late", granted_at: GRANTED, expires_at: "2026-12-01T00:00:00Z", title: "Full reset (Weekly + 5 hr)" },
  { id: "credit-soon", granted_at: GRANTED, expires_at: "2026-11-03T08:00:00Z" },
]

const SEEDS: ReadonlyArray<AccountSeed> = [
  ...DEFAULT_SEEDS.map((seed) => (seed.id === CODEX_ACCOUNT ? { ...seed, chatgptAccountId: CHATGPT } : seed)),
  { id: SIWC_ACCOUNT, kind: "siwc", providerID: SIWC },
]

/**
 * A codex account with a stored login (`expiresInMs` left; none with `login: false`) on the fake backend, which holds
 * two credits.
 */
async function rig(
  input: { readonly expiresInMs?: number; readonly seeds?: ReadonlyArray<AccountSeed>; readonly login?: false } = {},
) {
  const codex = startFakeCodex()
  const tokens = codex.login({ accountID: CHATGPT, plan: "pro" })
  codex.setResetCredits(CHATGPT, CREDITS, 0)
  codex.setUsage(CHATGPT, { primary: 100, secondary: 40 })
  const calls = { unauthorized: [], headers: [], rejected: [], accepted: [], refused: [] }
  // The poller's headers (`logins.headers`) are this login's; the reset credit requests read the stored login itself.
  const auth = { authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": CHATGPT }
  const t = await setup({
    options: { endpoints: { chatgpt: `${codex.url}/backend-api` } },
    registry: registry(input.seeds ?? SEEDS),
    peers: { logins: fakeLogins(calls, auth) },
  })
  if (input.login !== false)
    await t.deps.runtime.credentials.store(CODEX_ACCOUNT, {
      type: "oauth",
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: t.clock.now() + (input.expiresInMs ?? 3_600_000),
    })
  return {
    codex,
    t,
    /** The exhaustion hook's and the list's `wham/usage` reads: every read but the poller's (`logins.headers`). */
    ownReads: () => codex.usagePolls.length - calls.headers.length,
    async [Symbol.asyncDispose]() {
      await t[Symbol.asyncDispose]()
      await codex.stop()
    },
  }
}

/** A temp directory of the test's own (the old app's control center of a linked login), removed on dispose. */
async function scratch(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return { root, [Symbol.asyncDispose]: () => fs.rm(root, { recursive: true, force: true }) }
}

/** Every upstream request the fake saw, model requests and the unrecorded reads alike. */
function upstream(codex: FakeCodex) {
  return codex.requests.length + codex.usagePolls.length + codex.resetCreditReads.length + codex.consumes.length
}

describe("the count (02 §7.1.1)", () => {
  test("the poller publishes it with the windows it already reads; quota.snapshot and quota.updated carry it", async () => {
    await using r = await rig()
    r.t.clock.advance(Poller.TICK_MS)
    await r.t.telemetry.flush()
    expect(r.codex.usagePolls).toEqual([CHATGPT])
    // Background reads never list the credits themselves.
    expect(r.codex.resetCreditReads).toEqual([])
    const snapshot = await ok(r.t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })
    expect(snapshot.resetCredits).toEqual([
      expect.objectContaining({ accountID: CODEX_ACCOUNT, availableCount: 2, applicableCount: 0, source: "poll" }),
    ])
    // Not a window: the windows are the plan's only.
    expect(snapshot.windows.map((window) => window.id)).toEqual(["codex.primary", "codex.secondary", "codex.credits"])
    r.t.clock.advance(Relay.QUOTA_INTERVAL_MS)
    // The Anthropic account's budget window may go out in the same tick, after the Codex one (seen under load).
    const codex = r.t.emitted("quota.updated").findLast((event) => event.data.accountID === CODEX_ACCOUNT)
    expect(codex?.data).toMatchObject({ accountID: CODEX_ACCOUNT, resetCredits: { availableCount: 2 } })
    // Saved with the windows, so the screen has it (and its age) after a restart.
    await r.t.deps.runtime.limits.save()
    const file = JSON.parse(await Bun.file(r.t.deps.runtime.layout.limits).text())
    expect(file.resetCredits).toEqual([expect.objectContaining({ accountID: CODEX_ACCOUNT, availableCount: 2 })])
  })

  test("a hard exhaustion reads a stale count once; a fresh count or another one within 15 minutes reads nothing", async () => {
    await using r = await rig()
    const exhaust = async () => {
      r.t.telemetry.onWsReceive(
        wsEvent({
          providerID: CODEX,
          frame: JSON.stringify({
            type: "error",
            status: 429,
            error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 600 },
          }),
        }),
      )
      expect((await r.t.telemetry.onRetry(retryEvent({ providerID: CODEX, status: 429 }))).class).toBe("hard")
      await r.t.telemetry.flush()
    }
    await exhaust()
    expect(r.ownReads()).toBe(1)
    expect(r.t.deps.runtime.limits.credits({ accountID: CODEX_ACCOUNT })).toEqual([
      expect.objectContaining({ availableCount: 2 }),
    ])
    // Fresh now: the next exhaustion asks nothing.
    r.t.clock.advance(60_000)
    await r.t.telemetry.flush()
    await exhaust()
    expect(r.ownReads()).toBe(1)
    // The count gets old (the poller is off while the requests report windows, here a frame every 5 minutes).
    for (const minutes of [5, 10, 15]) {
      r.t.clock.advance(5 * 60_000)
      r.t.telemetry.onWsReceive(
        wsEvent({
          providerID: CODEX,
          frame: JSON.stringify({
            type: "codex.rate_limits",
            rate_limits: { primary: { used_percent: 99, window_minutes: 300, reset_at: 1792876670 }, secondary: null },
          }),
        }),
      )
      await r.t.telemetry.flush()
      expect([minutes, r.codex.usagePolls.length]).toEqual([minutes, 1])
    }
    // Stale after 15 minutes: one more read.
    await exhaust()
    expect(r.ownReads()).toBe(2)
    expect(r.codex.resetCreditReads).toEqual([])
    expect(r.codex.consumes).toEqual([])
  })

  test("an exhaustion, the switching verdict and hours of poll ticks never redeem a credit", async () => {
    await using r = await rig()
    r.t.telemetry.onWsReceive(
      wsEvent({
        providerID: CODEX,
        frame: JSON.stringify({
          type: "error",
          status: 429,
          error: { type: "usage_limit_reached", resets_in_seconds: 60 },
        }),
      }),
    )
    const retry = retryEvent({ providerID: CODEX, status: 429 })
    expect((await r.t.telemetry.onRetry(retry)).class).toBe("hard")
    await r.t.telemetry.flush()
    // The reset passes and the poller reads the account again and again; none of it redeems.
    r.t.clock.advance(3 * Poller.INTERVAL_MS)
    await r.t.telemetry.flush()
    expect(r.codex.usagePolls.length).toBeGreaterThanOrEqual(2)
    expect(r.codex.consumes).toEqual([])
    expect(r.codex.resetCredits(CHATGPT)?.map((credit) => credit.status ?? "available")).toEqual([
      "available",
      "available",
    ])
  })
})

describe("quota.resetCredits.list", () => {
  test("lists the credits and the count, publishes the windows it read, and asks at most every 2 minutes", async () => {
    await using r = await rig()
    const listed = await ok(r.t.telemetry.resetCreditsList, { accountID: CODEX_ACCOUNT })
    expect(listed.resetCredits).toMatchObject({
      accountID: CODEX_ACCOUNT,
      availableCount: 2,
      applicableCount: 0,
      credits: [
        {
          id: "credit-late",
          type: "codex_rate_limits",
          status: "available",
          expiresAt: Date.parse("2026-12-01T00:00:00Z"),
          title: "Full reset (Weekly + 5 hr)",
        },
        { id: "credit-soon", expiresAt: Date.parse("2026-11-03T08:00:00Z") },
      ],
    })
    expect([r.codex.resetCreditReads, r.codex.usagePolls]).toEqual([[CHATGPT], [CHATGPT]])
    expect(r.t.deps.runtime.limits.list({ accountID: CODEX_ACCOUNT }).map((window) => window.usedPercent)).toEqual([
      100,
      40,
      undefined,
    ])
    r.t.clock.advance(LimitReset.LIST_MIN_MS - 1_000)
    expect((await ok(r.t.telemetry.resetCreditsList, { accountID: CODEX_ACCOUNT })).resetCredits.availableCount).toBe(2)
    expect(r.codex.resetCreditReads).toEqual([CHATGPT])
    r.t.clock.advance(2_000)
    await ok(r.t.telemetry.resetCreditsList, { accountID: CODEX_ACCOUNT })
    expect(r.codex.resetCreditReads).toEqual([CHATGPT, CHATGPT])
  })

  test("Sign in with ChatGPT, API key and Claude accounts are not_supported, with no upstream request", async () => {
    await using r = await rig()
    for (const [accountID, kind] of [
      [SIWC_ACCOUNT, "siwc"],
      [ANTH_ACCOUNT, "anth"],
      [Account.ID.claudeSlot, "claude-sub"],
    ] as const) {
      expect(await call(r.t.telemetry.resetCreditsList, { accountID })).toMatchObject({
        ok: false,
        type: "not_supported",
        data: { kind },
      })
      expect(await call(r.t.telemetry.resetCreditsPlan, { accountID })).toMatchObject({
        ok: false,
        type: "not_supported",
        data: { kind },
      })
    }
    expect(await call(r.t.telemetry.resetCreditsList, { accountID: "acc_01NOSUCHACCOUNT00000000000" })).toMatchObject({
      ok: false,
      type: "account_not_found",
    })
    expect(upstream(r.codex)).toBe(0)
  })

  test("a login with 10 minutes or less left: credential_not_ready, no request and no refresh", async () => {
    await using r = await rig({ expiresInMs: Poller.FRESH_MS - 1_000 })
    expect(await call(r.t.telemetry.resetCreditsList, { accountID: CODEX_ACCOUNT })).toMatchObject({
      ok: false,
      type: "credential_not_ready",
      data: { accountID: CODEX_ACCOUNT, cause: "expiring" },
    })
    expect(await call(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT })).toMatchObject({
      ok: false,
      type: "credential_not_ready",
      data: { cause: "expiring" },
    })
    expect(upstream(r.codex)).toBe(0)
    expect(r.codex.refreshCount(CHATGPT)).toBe(0)
  })

  test("credential_not_ready names why: sign in again, no login stored, a linked login the old app left stale", async () => {
    await using profiles = await scratch("own-rc-linked-")
    const authPath = path.join(profiles.root, "profiles", "07", "codex", "auth.json")
    const codexSeed = (patch: Partial<AccountSeed>) =>
      SEEDS.map((seed) => (seed.id === CODEX_ACCOUNT ? { ...seed, ...patch } : seed))
    const linked = {
      type: "linked-codex-source",
      source: { app: "codex-multi-provider", profileID: "07", alias: "work", authPath },
      linkedAt: "2026-10-01T00:00:00Z",
    }
    for (const [input, cause] of [
      [{ seeds: codexSeed({ status: "needs_reauth" }) }, "needs_reauth"],
      [{ login: false }, "missing"],
      [{ seeds: codexSeed({ credential: linked }), login: false }, "source_stale"],
    ] as const) {
      await using r = await rig(input)
      // The old app's login expired an hour ago and was not refreshed since.
      await writeCodexMultiProviderProfiles(profiles.root, [
        {
          id: "07",
          alias: "work",
          tokens: mintChatGPTTokens(chatGPTAccount({ accountID: CHATGPT }), r.t.clock.now() - 7_200_000, 3_600_000),
        },
      ])
      const refused = { ok: false, type: "credential_not_ready", data: { accountID: CODEX_ACCOUNT, cause } }
      expect([cause, await call(r.t.telemetry.resetCreditsList, { accountID: CODEX_ACCOUNT })]).toMatchObject([
        cause,
        refused,
      ])
      expect([cause, await call(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT })]).toMatchObject([
        cause,
        refused,
      ])
      expect(upstream(r.codex)).toBe(0)
    }
  })

  test("ChatGPT answering errors: limit_reset_failed, and the next list asks again", async () => {
    await using r = await rig()
    await r.codex.stop()
    expect(await call(r.t.telemetry.resetCreditsList, { accountID: CODEX_ACCOUNT })).toMatchObject({
      ok: false,
      type: "limit_reset_failed",
      data: { reason: "network", retryable: true },
    })
  })
})

describe("quota.resetCredits.redeem", () => {
  const consumeBodies = (codex: FakeCodex) => codex.consumes.map((consume) => consume.body)

  test("plan then execute: one request id, the picked credit, the headers; then the windows, the count and ready", async () => {
    await using r = await rig()
    await ok(r.t.telemetry.resetCreditsList, { accountID: CODEX_ACCOUNT })
    // The account ran into its 5 hours: exhausted, announced.
    r.t.telemetry.onWsReceive(
      wsEvent({
        providerID: CODEX,
        frame: JSON.stringify({
          type: "error",
          status: 429,
          error: { type: "usage_limit_reached", resets_in_seconds: 600 },
        }),
      }),
    )
    await r.t.telemetry.onRetry(retryEvent({ providerID: CODEX, status: 429 }))
    expect(r.t.emitted("account.status").at(-1)?.data).toMatchObject({ accountID: CODEX_ACCOUNT, status: "exhausted" })

    const plan = await ok(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT, creditID: "credit-soon" })
    expect(plan).toMatchObject({
      account: { id: CODEX_ACCOUNT, label: "codex test" },
      credit: { id: "credit-soon", expiresAt: Date.parse("2026-11-03T08:00:00Z") },
      expiresAt: r.t.clock.now() + LimitReset.NONCE_TTL_MS,
    })
    expect(plan.windows.map((window) => window.id)).toContain("codex.primary")
    // Planning sends nothing.
    expect(r.codex.consumes).toEqual([])

    const done = await ok(r.t.telemetry.resetCreditsExecute, { nonce: plan.nonce })
    expect(done).toMatchObject({ outcome: "reset", windowsReset: 2, resetCredits: { availableCount: 1 } })
    expect(done.resetCredits?.credits?.map((credit) => credit.id)).toEqual(["credit-late"])
    expect(done.windows?.filter((window) => window.id !== "codex.credits").map((window) => window.usedPercent)).toEqual(
      [0, 0],
    )
    const consume = r.codex.consumes[0]
    expect(consume?.body).toEqual({ redeem_request_id: expect.any(String), credit_id: "credit-soon" })
    expect(String((consume?.body as { redeem_request_id: string }).redeem_request_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(consume?.headers).toMatchObject({
      "content-type": "application/json",
      "chatgpt-account-id": CHATGPT,
      authorization: expect.any(String),
    })
    expect(Object.keys(consume?.headers ?? {})).not.toContain("x-openai-codex-luna-reserve")
    // The exhaustion ended: the leader announces the account ready, and quota.updated carries the new count.
    expect(r.t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)).toBeUndefined()
    expect(r.t.emitted("account.status").at(-1)?.data).toMatchObject({ accountID: CODEX_ACCOUNT, status: "ready" })
    r.t.clock.advance(Relay.QUOTA_INTERVAL_MS)
    expect(r.t.emitted("quota.updated").at(-1)?.data).toMatchObject({
      accountID: CODEX_ACCOUNT,
      resetCredits: { availableCount: 1 },
      windows: expect.arrayContaining([expect.objectContaining({ id: "codex.primary", usedPercent: 0, status: "ok" })]),
    })
    // The nonce is used up.
    expect(await call(r.t.telemetry.resetCreditsExecute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "nonce_invalid",
    })
    expect(r.codex.consumes).toHaveLength(1)
    expect(r.codex.refreshCount(CHATGPT)).toBe(0)
  })

  test("a nonce expires after 10 minutes and sends nothing", async () => {
    await using r = await rig()
    const plan = await ok(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT })
    r.t.clock.advance(LimitReset.NONCE_TTL_MS)
    expect(await call(r.t.telemetry.resetCreditsExecute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "nonce_invalid",
    })
    expect(r.codex.consumes).toEqual([])
  })

  test("nothing_to_reset and no_credit use the nonce up; no_credit without a pick means none is left", async () => {
    await using r = await rig()
    r.codex.scriptConsume(CHATGPT, "nothing_to_reset", "no_credit", "no_credit")
    const first = await ok(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT })
    expect(await ok(r.t.telemetry.resetCreditsExecute, { nonce: first.nonce })).toEqual({ outcome: "nothing_to_reset" })
    expect(await call(r.t.telemetry.resetCreditsExecute, { nonce: first.nonce })).toMatchObject({
      type: "nonce_invalid",
    })
    const picked = await ok(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT, creditID: "credit-late" })
    expect(await ok(r.t.telemetry.resetCreditsExecute, { nonce: picked.nonce })).toEqual({ outcome: "no_credit" })
    const any = await ok(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT })
    expect(await ok(r.t.telemetry.resetCreditsExecute, { nonce: any.nonce })).toEqual({ outcome: "no_credit" })
    expect(r.t.deps.runtime.limits.credits({ accountID: CODEX_ACCOUNT })).toEqual([
      expect.objectContaining({ availableCount: 0 }),
    ])
    expect(consumeBodies(r.codex)).toEqual([
      { redeem_request_id: expect.any(String) },
      { redeem_request_id: expect.any(String), credit_id: "credit-late" },
      { redeem_request_id: expect.any(String) },
    ])
    // No usage read after an answer that reset nothing.
    expect(r.codex.usagePolls).toEqual([])
  })

  test("a 500 keeps the nonce; the retry sends the same request id and redeems", async () => {
    await using r = await rig()
    r.codex.scriptConsume(CHATGPT, "error")
    const plan = await ok(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT })
    expect(await call(r.t.telemetry.resetCreditsExecute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "limit_reset_failed",
      data: { reason: "status", status: 500, retryable: true },
    })
    expect(await ok(r.t.telemetry.resetCreditsExecute, { nonce: plan.nonce })).toMatchObject({ outcome: "reset" })
    const ids = consumeBodies(r.codex).map((body) => (body as { redeem_request_id: string }).redeem_request_id)
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0]!)
  })

  test("a timeout keeps the nonce; the retry resends the same id, which ChatGPT already redeemed", async () => {
    await using r = await rig()
    // Telemetry's own instance waits 10 s; this one gives up after 300 ms, the same code path.
    const published: unknown[] = []
    const reset = LimitReset.create(r.t.deps, () => r.t.modules, {
      publish: (windows, credits) => {
        r.t.deps.runtime.limits.upsert(windows)
        if (credits) r.t.deps.runtime.limits.upsertCredits(credits)
        published.push({ windows, credits })
      },
      fetcher: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(300) }),
    })
    r.codex.scriptConsume(CHATGPT, { delayMs: 1_500 })
    const plan = await ok(reset.plan, { accountID: CODEX_ACCOUNT })
    expect(await call(reset.execute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "limit_reset_failed",
      data: { reason: "timeout", retryable: true },
    })
    await Bun.sleep(1_500)
    expect(await ok(reset.execute, { nonce: plan.nonce })).toMatchObject({
      outcome: "already_redeemed",
      resetCredits: { availableCount: 1 },
    })
    const ids = consumeBodies(r.codex).map((body) => (body as { redeem_request_id: string }).redeem_request_id)
    expect(ids).toEqual([ids[0]!, ids[0]!])
    // One credit redeemed, once.
    expect(r.codex.resetCredits(CHATGPT)?.filter((credit) => credit.status === "redeemed")).toHaveLength(1)
    expect(published).toHaveLength(1)
    expect(await call(reset.execute, { nonce: plan.nonce })).toMatchObject({ type: "nonce_invalid" })
  })

  test("an answer lost after the redeem went through: reopened within 2 minutes, the list asks ChatGPT again", async () => {
    await using r = await rig()
    const reset = LimitReset.create(r.t.deps, () => r.t.modules, {
      publish: (windows, credits) => {
        r.t.deps.runtime.limits.upsert(windows)
        if (credits) r.t.deps.runtime.limits.upsertCredits(credits)
      },
      // Every request of this test goes through it, the plain 500 and the list reads too: 300 ms timed those out
      // under the parallel unit run (MR13); only the redeem below answers later than this.
      fetcher: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(1_500) }),
    })
    expect((await ok(reset.list, { accountID: CODEX_ACCOUNT })).resetCredits.availableCount).toBe(2)
    // ChatGPT redeems, but its answer comes after the request gave up.
    r.codex.scriptConsume(CHATGPT, { delayMs: 4_000 })
    const plan = await ok(reset.plan, { accountID: CODEX_ACCOUNT })
    expect(await call(reset.execute, { nonce: plan.nonce })).toMatchObject({
      type: "limit_reset_failed",
      data: { reason: "timeout" },
    })
    // The dialog opens again at once: the list from before the redeem would offer a credit that is gone, and a new
    // confirmation (a new request id) could spend a second one.
    r.t.clock.advance(1_000)
    const reopened = await ok(reset.list, { accountID: CODEX_ACCOUNT })
    expect(r.codex.resetCreditReads).toEqual([CHATGPT, CHATGPT])
    expect(reopened.resetCredits.availableCount).toBe(1)
    expect(reopened.resetCredits.credits?.map((credit) => credit.id)).toEqual(["credit-soon"])
    // A 500 (nothing redeemed) reads again as well: no outcome is known until ChatGPT answers one.
    r.codex.scriptConsume(CHATGPT, "error")
    const next = await ok(reset.plan, { accountID: CODEX_ACCOUNT })
    expect(await call(reset.execute, { nonce: next.nonce })).toMatchObject({ data: { status: 500 } })
    await ok(reset.list, { accountID: CODEX_ACCOUNT })
    expect(r.codex.resetCreditReads).toHaveLength(3)
  })

  test("a reset whose read after it names no count, or fails, leaves the count unknown rather than the old one", async () => {
    await using r = await rig()
    const usageDown = { value: false }
    /** The stored count each publication saw: the real one's `quota.updated` carries it (small fix of MR7). */
    const published: Array<ReadonlyArray<unknown>> = []
    const reset = LimitReset.create(r.t.deps, () => r.t.modules, {
      publish: (windows, credits) => {
        published.push(counted())
        r.t.deps.runtime.limits.upsert(windows)
        if (credits) r.t.deps.runtime.limits.upsertCredits(credits)
      },
      fetcher: (url, init) =>
        usageDown.value && url.endsWith("/wham/usage") ? Promise.reject(new TypeError("offline")) : fetch(url, init),
    })
    const counted = () => r.t.deps.runtime.limits.credits({ accountID: CODEX_ACCOUNT })
    for (const read of ["no count", "failed"] as const) {
      await ok(reset.list, { accountID: CODEX_ACCOUNT })
      expect([read, counted()]).toMatchObject([read, [{ availableCount: 2 }]])
      // `wham/usage` stops naming the count, or stops answering; the redeem itself goes through.
      if (read === "no count") r.codex.setResetCredits(CHATGPT, null)
      if (read === "failed") usageDown.value = true
      r.codex.scriptConsume(CHATGPT, "reset")
      const plan = await ok(reset.plan, { accountID: CODEX_ACCOUNT })
      published.length = 0
      const done = await ok(reset.execute, { nonce: plan.nonce })
      expect([read, done.outcome, done.resetCredits]).toEqual([read, "reset", undefined])
      // The windows the read after the redeem saw are published with the old count already gone.
      expect([read, published]).toEqual([read, read === "no count" ? [[]] : []])
      // Not the 2 from before the redeem: unknown, in the store, on screen (`quota.updated`) and in limits.json.
      expect([read, counted()]).toEqual([read, []])
      r.t.clock.advance(Relay.QUOTA_INTERVAL_MS)
      expect([read, r.t.emitted("quota.updated").at(-1)?.data]).toMatchObject([
        read,
        { accountID: CODEX_ACCOUNT, resetCredits: null },
      ])
      await r.t.deps.runtime.limits.save()
      expect(JSON.parse(await Bun.file(r.t.deps.runtime.layout.limits).text()).resetCredits).toBeUndefined()
      // Back for the next round: two credits again.
      r.codex.setResetCredits(CHATGPT, CREDITS, 0)
      usageDown.value = false
    }
    expect(r.codex.consumes).toHaveLength(2)
  })

  test("a login that went stale between plan and execute: credential_not_ready, nothing sent, the nonce kept", async () => {
    await using r = await rig({ expiresInMs: Poller.FRESH_MS + 60_000 })
    const plan = await ok(r.t.telemetry.resetCreditsPlan, { accountID: CODEX_ACCOUNT })
    r.t.clock.advance(2 * 60_000)
    expect(await call(r.t.telemetry.resetCreditsExecute, { nonce: plan.nonce })).toMatchObject({
      type: "credential_not_ready",
    })
    expect(r.codex.consumes).toEqual([])
    expect(r.codex.refreshCount(CHATGPT)).toBe(0)
    // Kept: a new login (or a conversation's refresh) makes the same confirmation work again.
    await r.t.deps.runtime.credentials.store(CODEX_ACCOUNT, {
      type: "oauth",
      access: r.codex.login({ accountID: CHATGPT }).accessToken,
      refresh: "fake-refresh",
      expiresAt: r.t.clock.now() + 3_600_000,
    })
    expect(await ok(r.t.telemetry.resetCreditsExecute, { nonce: plan.nonce })).toMatchObject({ outcome: "reset" })
  })
})

describe("remote services", () => {
  test("an SSH host answers remote_managed: it neither reads nor redeems reset credits", () => {
    for (const method of [
      "quota.resetCredits.list",
      "quota.resetCredits.redeem.plan",
      "quota.resetCredits.redeem.execute",
    ])
      expect<ReadonlyArray<string>>(Register.REMOTE_MANAGED).toContain(method)
  })
})

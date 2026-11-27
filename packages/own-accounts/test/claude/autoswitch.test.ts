// Claude↔Claude automatic switching (02 §8.8, user decision C-D3 2026-10-10): the trigger, the target, the breaker,
// and the claude module moving a whole tree and retrying at once. Off unless the user turns it on (CAG-5 2026-10-31), so
// the switching tests start from a policy that says `auto`. Fakes only.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Account, Kv, type Limit } from "@own/protocol"
import { ClaudeSwitch } from "../../src/claude/autoswitch.js"
import { ClaudeLogin } from "../../src/claude/login.js"
import { request, world } from "./support.js"

const SLOT = Account.ID.claudeSlot
const TWO = Account.ID.make("acc_01J9CLAUDETWO0000000000000")
const THREE = Account.ID.make("acc_01J9CLAUDETHREE00000000000")
const NOW = Date.UTC(2026, 9, 10, 3, 0, 0)

/** A world whose policy turns Claude-to-Claude switching on, as the user does in 설정 > 자동 전환. */
async function autoWorld(options?: Parameters<typeof world>[0]) {
  const w = await world(options)
  await w.deps.runtime.policy.update((current) => ({
    ...current,
    autoSwitch: { ...current.autoSwitch, claudeToClaude: "auto" },
  }))
  return w
}

function window(
  accountID: string,
  id: string,
  usedPercent: number | undefined,
  status: Limit.Status = "ok",
  observedAt = NOW,
): Limit.Window {
  return {
    accountID: accountID as Account.ID,
    providerID: "anthropic" as Limit.Window["providerID"],
    id,
    kind: "rolling_quota",
    label: id,
    scope: "account",
    confidence: "live",
    source: "header",
    observedAt,
    usedPercent,
    status,
  } as Limit.Window
}

describe("the trigger", () => {
  test("a rejected unified status or a long retry-after, not a short burst", () => {
    const rejected = new Headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(NOW / 1000 + 3600),
    })
    expect(ClaudeSwitch.signal(rejected, 429, NOW)).toEqual({
      windowId: "claude.5h",
      reason: "5h_rejected",
      until: NOW + 3_600_000,
    })
    expect(ClaudeSwitch.signal(new Headers({ "anthropic-ratelimit-unified-7d-status": "rejected" }), 400, NOW)).toEqual(
      {
        windowId: "claude.7d",
        reason: "7d_rejected",
      },
    )
    expect(ClaudeSwitch.signal(new Headers({ "retry-after": "600" }), 429, NOW)).toEqual({
      windowId: null,
      reason: "long_retry_after",
      until: NOW + 600_000,
    })
    expect(ClaudeSwitch.signal(new Headers({ "retry-after": "20" }), 429, NOW)).toBeUndefined()
    expect(
      ClaudeSwitch.signal(new Headers({ "anthropic-ratelimit-unified-status": "allowed" }), 500, NOW),
    ).toBeUndefined()
  })
})

describe("the trigger names the refused model week (LV)", () => {
  test("the Fable week by its own status, the Opus and Sonnet weeks by the claim with the top-level reset", () => {
    expect(
      ClaudeSwitch.signal(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
          "anthropic-ratelimit-unified-7d_oi-status": "rejected",
          "anthropic-ratelimit-unified-7d_oi-utilization": "1.02",
        }),
        429,
        NOW,
      ),
    ).toEqual({ windowId: "claude.7d_oi", reason: "7d_oi_rejected" })
    expect(
      ClaudeSwitch.signal(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(NOW / 1000 + 5 * 86_400),
          "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
        }),
        429,
        NOW,
      ),
    ).toEqual({ windowId: "claude.7d_opus", reason: "7d_opus_rejected", until: NOW + 5 * 86_400_000 })
  })
})

describe("the target", () => {
  const candidates = [SLOT, TWO, THREE].map((accountID) => ({ accountID, loaded: true }))
  const windows: Record<string, Limit.Window[]> = {
    [SLOT]: [window(SLOT, "claude.5h", 100, "exhausted")],
    [TWO]: [window(TWO, "claude.5h", 60)],
    [THREE]: [window(THREE, "claude.5h", 20), window(THREE, "claude.7d", 90)],
  }
  const base = {
    from: SLOT,
    candidates,
    now: NOW,
    model: "claude-opus-5-5",
    windows: (accountID: string) => windows[accountID] ?? [],
    exhausted: () => false,
    departed: () => undefined,
  }

  test("the lowest 5-hour use; unknown last; never the one it leaves", () => {
    expect(ClaudeSwitch.choose(base)).toBe(THREE)
    expect(ClaudeSwitch.choose({ ...base, windows: (accountID) => (accountID === TWO ? windows[TWO]! : []) })).toBe(TWO)
  })

  test("an account without a five-hour window (verified Ultra, 02 §7.1.2) ranks by its week, not last", () => {
    // THREE has the week only: it is no longer an unknown five hours behind TWO's 60 %.
    const ultra = { ...windows, [THREE]: [window(THREE, "claude.7d", 30)] }
    expect(ClaudeSwitch.choose({ ...base, windows: (id) => ultra[id] ?? [] })).toBe(THREE)
    const full = { ...windows, [THREE]: [window(THREE, "claude.7d", 70)] }
    expect(ClaudeSwitch.choose({ ...base, windows: (id) => full[id] ?? [] })).toBe(TWO)
    // Two such accounts: the lower week first.
    const both = { ...windows, [TWO]: [window(TWO, "claude.7d", 50)], [THREE]: [window(THREE, "claude.7d", 40)] }
    expect(ClaudeSwitch.choose({ ...base, windows: (id) => both[id] ?? [] })).toBe(THREE)
    // An account without any window yet stays last, as before.
    const none = { ...windows, [THREE]: [] }
    expect(ClaudeSwitch.choose({ ...base, windows: (id) => none[id] ?? [] })).toBe(TWO)
  })

  test("not an exhausted account, one without a login, or one the tree left before its reset", () => {
    expect(ClaudeSwitch.choose({ ...base, exhausted: (accountID) => accountID === THREE })).toBe(TWO)
    expect(
      ClaudeSwitch.choose({
        ...base,
        candidates: candidates.map((item) => ({ ...item, loaded: item.accountID !== THREE })),
      }),
    ).toBe(TWO)
    expect(ClaudeSwitch.choose({ ...base, departed: (accountID) => (accountID === THREE ? NOW + 1 : undefined) })).toBe(
      TWO,
    )
    expect(ClaudeSwitch.choose({ ...base, departed: (accountID) => (accountID === THREE ? NOW : undefined) })).toBe(
      THREE,
    )
    expect(ClaudeSwitch.choose({ ...base, candidates: [{ accountID: SLOT, loaded: true }] })).toBeUndefined()
  })

  test("a model weekly bucket blocks only its own model family (LV)", () => {
    // B: little used but its Fable week ran out (#5920's 7d_oi at 102 %, rejected); C: nearly out everywhere.
    const sets: Record<string, Limit.Window[]> = {
      [TWO]: [
        window(TWO, "claude.5h", 10),
        window(TWO, "claude.7d", 20),
        window(TWO, "claude.7d_oi", 102, "exhausted"),
      ],
      [THREE]: [window(THREE, "claude.5h", 90), window(THREE, "claude.7d", 95)],
    }
    const input = { ...base, windows: (accountID: string) => sets[accountID] ?? [] }
    expect(ClaudeSwitch.choose({ ...input, model: "claude-sonnet-4-5" })).toBe(TWO)
    expect(ClaudeSwitch.choose({ ...input, model: "claude-fable-5-1" })).toBe(THREE)
    // A claimed Opus week (state and reset only) holds back Opus, not Sonnet; an account-wide window holds back both.
    const opus = {
      ...sets,
      [TWO]: [window(TWO, "claude.5h", 10), window(TWO, "claude.7d_opus", undefined, "exhausted")],
    }
    expect(ClaudeSwitch.choose({ ...input, windows: (id) => opus[id] ?? [], model: "claude-opus-5-5" })).toBe(THREE)
    expect(ClaudeSwitch.choose({ ...input, windows: (id) => opus[id] ?? [], model: "claude-sonnet-4-5" })).toBe(TWO)
    const weekly = { ...sets, [TWO]: [window(TWO, "claude.5h", 10), window(TWO, "claude.7d", 100, "exhausted")] }
    expect(ClaudeSwitch.choose({ ...input, windows: (id) => weekly[id] ?? [], model: "claude-sonnet-4-5" })).toBe(THREE)
  })

  test("extra usage refused or used up never rules an account out alone (LV)", () => {
    const sets: Record<string, Limit.Window[]> = {
      [TWO]: [window(TWO, "claude.5h", 10), window(TWO, "claude.overage", undefined, "exhausted")],
      [THREE]: [window(THREE, "claude.5h", 90)],
    }
    expect(ClaudeSwitch.choose({ ...base, windows: (id) => sets[id] ?? [] })).toBe(TWO)
  })

  test("the breaker: at most the policy's automatic switches per hour", () => {
    expect(ClaudeSwitch.allowed([], NOW, 2)).toBe(true)
    expect(ClaudeSwitch.allowed([NOW - 10_000], NOW, 2)).toBe(true)
    expect(ClaudeSwitch.allowed([NOW - 10_000, NOW - 5_000], NOW, 2)).toBe(false)
    expect(ClaudeSwitch.allowed([NOW - 3_700_000, NOW - 5_000], NOW, 2)).toBe(true)
  })
})

describe("switching a tree", () => {
  async function exhaust(
    w: Awaited<ReturnType<typeof world>>,
    sessionID: string,
    accountID: string,
    model = "claude-fake",
    headers: Readonly<Record<string, string>> = {
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(w.deps.clock.now() / 1000) + 3600),
    },
  ) {
    w.deps.runtime.claude.remember(sessionID, accountID)
    w.deps.runtime.lastResponse.record(sessionID, { providerID: "anthropic", status: 429, headers })
    const event = {
      sessionID,
      agent: "build",
      model: { providerID: "anthropic", id: model },
      error: { type: "api", message: "rate limited", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 60_000 } as { retry: boolean; delay?: number },
    }
    await w.claude.onRetry(event as never)
    return event
  }

  test("CAG-5: a fresh install's policy, or an older one without the field, does not switch on a limit hit", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    w.deps.runtime.limits.upsert([window(TWO, "claude.5h", 10)])
    // No policy.json yet: the built-in defaults.
    expect((await w.deps.runtime.policy.read()).autoSwitch.claudeToClaude).toBe("off")
    expect(await w.claude.onHttpRequest(request("ses_fresh"))).toBe(SLOT)
    expect((await exhaust(w, "ses_fresh", SLOT)).decision).toEqual({ retry: true, delay: 60_000 })
    expect(await w.claude.onHttpRequest(request("ses_fresh"))).toBe(SLOT)
    // A policy.json an older build wrote before the field existed.
    await w.deps.runtime.policy.update((current) => {
      const { claudeToClaude: _absent, ...older } = current.autoSwitch
      return { ...current, autoSwitch: older }
    })
    expect(w.deps.runtime.policy.cached()?.autoSwitch.claudeToClaude).toBeUndefined()
    expect(await w.claude.onHttpRequest(request("ses_older"))).toBe(SLOT)
    expect((await exhaust(w, "ses_older", SLOT)).decision).toEqual({ retry: true, delay: 60_000 })
    expect(await w.claude.onHttpRequest(request("ses_older"))).toBe(SLOT)
    expect(w.alerts.filter((alert) => alert.code === "claude_account_switched")).toHaveLength(0)
    // The same refusal moves the tree once the user picks `자동`.
    await w.deps.runtime.policy.update((current) => ({
      ...current,
      autoSwitch: { ...current.autoSwitch, claudeToClaude: "auto" },
    }))
    expect(await w.claude.onHttpRequest(request("ses_on"))).toBe(SLOT)
    expect((await exhaust(w, "ses_on", SLOT)).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_on"))).toBe(TWO)
  })

  test("moves the whole tree to the roomiest account, retries at once, records it and tells the user", async () => {
    await using w = await autoWorld()
    await w.add(TWO, path.join(w.home, "two"), { label: "업무" })
    await w.add(THREE, path.join(w.home, "three"))
    w.fake.accounts[ClaudeLogin.key(path.join(w.home, ".claude"))] = "tok-1"
    await w.claude.start()
    w.deps.runtime.limits.upsert([window(TWO, "claude.5h", 10), window(THREE, "claude.5h", 70)])
    expect(await w.send("ses_root")).toBe(SLOT)
    w.deps.runtime.sessions.update("ses_kid", { parentID: "ses_root" })
    const event = await exhaust(w, "ses_kid", SLOT)
    expect(event.decision).toEqual({ retry: true, delay: 0 })
    expect(w.deps.runtime.claude.takeSwitched("ses_kid")).toBe(true)
    // R4: the root and every subagent move together.
    expect(w.storage.get(Kv.claudeSession("ses_root"))).toMatchObject({ accountID: TWO })
    expect(await w.send("ses_kid")).toBe(TWO)
    expect(await w.send("ses_root")).toBe(TWO)
    // Account 2's first request is the retry on it (02 §8.9): its notice comes once, after the switch.
    expect(w.alerts.map((alert) => [alert.code, alert.accountID])).toEqual([
      ["claude_first_request", SLOT],
      ["claude_account_switched", TWO],
      ["claude_first_request", TWO],
    ])
    expect(w.alerts[1]?.message).toBe("Claude 한도 소진 — Claude에서 업무로 바꿨습니다 (캐시 새로 쌓임)")
  })

  test("the refused model decides: a Sonnet tree goes to the account whose Fable week ran out, a Fable tree not (LV)", async () => {
    await using w = await autoWorld()
    await w.add(TWO, path.join(w.home, "two"))
    await w.add(THREE, path.join(w.home, "three"))
    await w.claude.start()
    const at = w.deps.clock.now()
    w.deps.runtime.limits.upsert([
      window(TWO, "claude.5h", 10, "ok", at),
      window(TWO, "claude.7d", 20, "ok", at),
      window(TWO, "claude.7d_oi", 102, "exhausted", at),
      window(THREE, "claude.5h", 90, "ok", at),
      window(THREE, "claude.7d", 95, "ok", at),
    ])
    expect(await w.claude.onHttpRequest(request("ses_sonnet"))).toBe(SLOT)
    expect((await exhaust(w, "ses_sonnet", SLOT, "claude-sonnet-4-5")).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_sonnet"))).toBe(TWO)
    expect(await w.claude.onHttpRequest(request("ses_fable"))).toBe(SLOT)
    expect((await exhaust(w, "ses_fable", SLOT, "claude-fable-5-1")).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_fable"))).toBe(THREE)
    // The bucket came without a reset: once its observation is stale it no longer blocks (LimitModel.lapsed).
    w.clock.advance(16 * 60_000)
    expect(await w.claude.onHttpRequest(request("ses_later"))).toBe(SLOT)
    expect((await exhaust(w, "ses_later", SLOT, "claude-fable-5-1")).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_later"))).toBe(TWO)
  })

  test("another account's used-up Opus week, recorded for Opus only, keeps a Sonnet tree's way open (LV)", async () => {
    await using w = await autoWorld()
    await w.add(TWO, path.join(w.home, "two"))
    await w.add(THREE, path.join(w.home, "three"))
    await w.claude.start()
    const at = w.deps.clock.now()
    w.deps.runtime.limits.upsert([window(TWO, "claude.5h", 10, "ok", at), window(THREE, "claude.5h", 70, "ok", at)])
    w.deps.runtime.limits.exhaust({
      accountID: TWO,
      windowId: "claude.7d_opus",
      until: at + 5 * 86_400_000,
      class: "hard",
    })
    expect(await w.claude.onHttpRequest(request("ses_sonnet"))).toBe(SLOT)
    expect((await exhaust(w, "ses_sonnet", SLOT, "claude-sonnet-4-5")).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_sonnet"))).toBe(TWO)
    expect(await w.claude.onHttpRequest(request("ses_opus"))).toBe(SLOT)
    expect((await exhaust(w, "ses_opus", SLOT, "claude-opus-5-5")).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_opus"))).toBe(THREE)
  })

  test("a used-up Opus week keeps the tree off that account for Opus only: a Sonnet refusal goes back to it (LV)", async () => {
    // The third limits review's replay: an Opus tree SLOT → TWO on SLOT's Opus week, then Sonnet refused on TWO's 5 h.
    await using w = await autoWorld()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    const opusWeek = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
      "anthropic-ratelimit-unified-reset": String(Math.floor(w.deps.clock.now() / 1000) + 5 * 86_400),
    }
    expect(await w.claude.onHttpRequest(request("ses_tree"))).toBe(SLOT)
    expect((await exhaust(w, "ses_tree", SLOT, "claude-opus-5-5", opusWeek)).decision).toEqual({
      retry: true,
      delay: 0,
    })
    expect(await w.claude.onHttpRequest(request("ses_tree"))).toBe(TWO)
    // The refused family keeps its protection: an Opus refusal on TWO does not bring the tree back to SLOT's used-up
    // Opus week.
    w.clock.advance(60_000)
    expect((await exhaust(w, "ses_tree", TWO, "claude-opus-5-5")).decision).toEqual({ retry: true, delay: 60_000 })
    expect(await w.claude.onHttpRequest(request("ses_tree"))).toBe(TWO)
    // Sonnet is not held back by an Opus week: the tree returns to SLOT.
    w.clock.advance(60_000)
    expect((await exhaust(w, "ses_tree", TWO, "claude-sonnet-4-5")).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_tree"))).toBe(SLOT)
  })

  test("a Sonnet subagent's refusal does not take an Opus main back to the account whose Opus week ran out (LV)", async () => {
    // The fourth limits review: the whole tree moves with one refusal, so a model-scoped departure let a Sonnet refusal
    // rebind an Opus main to the account where Opus is held.
    await using w = await autoWorld()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    const opusWeek = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
      "anthropic-ratelimit-unified-reset": String(Math.floor(w.deps.clock.now() / 1000) + 5 * 86_400),
    }
    // The main runs Opus and its subagent Sonnet (the session index, as `model.selected` writes it).
    w.deps.runtime.sessions.update("ses_main", { providerID: "anthropic", modelID: "claude-opus-5-5" })
    w.deps.runtime.sessions.update("ses_sub", {
      parentID: "ses_main",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    expect(await w.claude.onHttpRequest(request("ses_main"))).toBe(SLOT)
    expect((await exhaust(w, "ses_main", SLOT, "claude-opus-5-5", opusWeek)).decision).toEqual({
      retry: true,
      delay: 0,
    })
    expect(await w.claude.onHttpRequest(request("ses_sub"))).toBe(TWO)
    // SLOT is open to Sonnet, but going back would take the Opus main to SLOT's used-up Opus week: the tree stays.
    w.clock.advance(60_000)
    expect((await exhaust(w, "ses_sub", TWO, "claude-sonnet-4-5")).decision).toEqual({ retry: true, delay: 60_000 })
    expect(await w.claude.onHttpRequest(request("ses_main"))).toBe(TWO)
    // Once the main runs Sonnet too, nothing holds the tree on TWO.
    w.deps.runtime.sessions.update("ses_main", { modelID: "claude-sonnet-4-5" })
    w.clock.advance(60_000)
    expect((await exhaust(w, "ses_sub", TWO, "claude-sonnet-4-5")).decision).toEqual({ retry: true, delay: 0 })
    expect(await w.claude.onHttpRequest(request("ses_main"))).toBe(SLOT)
  })

  test("the target is open to every model the tree's mains run: a window, a record or a departure of any rules it out", () => {
    const input = {
      from: SLOT,
      candidates: [TWO, THREE].map((accountID) => ({ accountID, loaded: true })),
      now: NOW,
      model: "claude-sonnet-4-5",
      windows: (accountID: string) => [window(accountID, "claude.5h", accountID === TWO ? 10 : 50)],
      exhausted: () => false,
      departed: () => undefined,
    }
    expect(ClaudeSwitch.choose(input)).toBe(TWO)
    const opusOnTwo = (accountID: string) => [
      window(accountID, "claude.5h", accountID === TWO ? 10 : 50),
      ...(accountID === TWO ? [window(TWO, "claude.7d_opus", undefined, "exhausted")] : []),
    ]
    expect(ClaudeSwitch.choose({ ...input, windows: opusOnTwo })).toBe(TWO)
    expect(ClaudeSwitch.choose({ ...input, windows: opusOnTwo, kept: ["claude-opus-5-5"] })).toBe(THREE)
    const opusRecord = (accountID: string, model: string | undefined) =>
      accountID === TWO && model === "claude-opus-5-5"
    expect(ClaudeSwitch.choose({ ...input, exhausted: opusRecord, kept: ["claude-opus-5-5"] })).toBe(THREE)
    const left = (accountID: string, model: string | undefined) =>
      accountID === TWO && model === "claude-opus-5-5" ? NOW + 1 : undefined
    expect(ClaudeSwitch.choose({ ...input, departed: left })).toBe(TWO)
    expect(ClaudeSwitch.choose({ ...input, departed: left, kept: ["claude-opus-5-5"] })).toBe(THREE)
  })

  test("policy off, another company, no room left, or the breaker: the tree stays", async () => {
    await using w = await autoWorld()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    // Only the account it is on: nowhere to go.
    w.fake.accounts = {}
    w.fake.accounts[ClaudeLogin.key(path.join(w.home, ".claude"))] = "tok-1"
    expect((await exhaust(w, "ses_alone", SLOT)).decision).toEqual({ retry: true, delay: 60_000 })
    w.fake.accounts[ClaudeLogin.key(path.join(w.home, "two"))] = "tok-2"
    await w.deps.runtime.policy.update((current) => ({
      ...current,
      autoSwitch: { ...current.autoSwitch, claudeToClaude: "off" },
    }))
    expect((await exhaust(w, "ses_off", SLOT)).decision).toEqual({ retry: true, delay: 60_000 })
    await w.deps.runtime.policy.update((current) => ({
      ...current,
      autoSwitch: { ...current.autoSwitch, claudeToClaude: "auto" },
    }))
    // Two switches in an hour, then the breaker holds (and the tree never goes back before the reset).
    await w.deps.runtime.policy.update((current) => ({
      ...current,
      hysteresis: { ...current.hysteresis, breakerAutoPerHour: 1 },
    }))
    expect((await exhaust(w, "ses_flap", SLOT)).decision).toEqual({ retry: true, delay: 0 })
    expect((await exhaust(w, "ses_flap", TWO)).decision).toEqual({ retry: true, delay: 60_000 })
    expect(w.alerts.filter((alert) => alert.code === "claude_account_switched")).toHaveLength(1)
  })
})

// Regressions of the review of 2026-10-11 (the finding numbers of that review).
describe("switching a tree once", () => {
  function retry(w: Awaited<ReturnType<typeof world>>, sessionID: string) {
    const event = {
      sessionID,
      agent: "build",
      model: { providerID: "anthropic", id: "claude-fake" },
      error: { type: "api", message: "rate limited", status: 429 },
      attempt: 2,
      decision: { retry: true, delay: 60_000 } as { retry: boolean; delay?: number },
    }
    return w.claude.onRetry(event as never).then(() => event)
  }

  function refuse(w: Awaited<ReturnType<typeof world>>, sessionID: string, accountID: string) {
    w.deps.runtime.claude.remember(sessionID, accountID)
    w.deps.runtime.lastResponse.record(sessionID, {
      providerID: "anthropic",
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": String(Math.floor(w.deps.clock.now() / 1000) + 3600),
      },
    })
    return retry(w, sessionID)
  }

  test("finding 8: siblings refused together move the tree once, and each is sent again at once", async () => {
    await using w = await autoWorld()
    await w.add(TWO, path.join(w.home, "two"))
    await w.add(THREE, path.join(w.home, "three"))
    await w.claude.start()
    w.deps.runtime.limits.upsert([window(TWO, "claude.5h", 10), window(THREE, "claude.5h", 70)])
    expect(await w.claude.onHttpRequest(request("ses_parent"))).toBe(SLOT)
    const kids = ["ses_k1", "ses_k2", "ses_k3"]
    for (const kid of kids) w.deps.runtime.sessions.update(kid, { parentID: "ses_parent" })
    const events = await Promise.all(kids.map((kid) => refuse(w, kid, SLOT)))
    expect(events.map((event) => event.decision)).toEqual(kids.map(() => ({ retry: true, delay: 0 })))
    expect(kids.map((kid) => w.deps.runtime.claude.takeSwitched(kid))).toEqual([true, true, true])
    expect(w.storage.get(Kv.claudeSession("ses_parent"))).toMatchObject({ accountID: TWO })
    // One switch: one notice, and the breaker (2 an hour) still has room.
    expect(w.alerts.filter((alert) => alert.code === "claude_account_switched")).toHaveLength(1)
    // The retry on account 2 fails before any answer: the same refusal again is not another switch.
    expect((await retry(w, "ses_k1")).decision).toEqual({ retry: true, delay: 60_000 })
    expect(w.storage.get(Kv.claudeSession("ses_parent"))).toMatchObject({ accountID: TWO })
    // Account 2 runs out later: the tree still may move once more.
    expect((await refuse(w, "ses_k2", TWO)).decision).toEqual({ retry: true, delay: 0 })
    expect(w.storage.get(Kv.claudeSession("ses_parent"))).toMatchObject({ accountID: THREE })
    expect(w.alerts.filter((alert) => alert.code === "claude_account_switched")).toHaveLength(2)
  })

  test("finding 11: a remote service moves only to an account the PC says it can sign with", async () => {
    const view = {
      state: "enabled",
      fast: false,
      display: { label: null, shortLabel: "C", color: "orange" },
      accounts: [
        { accountID: SLOT, label: null, shortLabel: "C", color: "orange", default: true, usable: true },
        { accountID: TWO, label: null, shortLabel: "C2", color: "amber", default: false, usable: false },
      ] as Array<Record<string, unknown>>,
    }
    await using w = await autoWorld({ remote: { claude: () => view, claudeSigner: () => undefined } })
    await w.claude.start()
    expect(await w.claude.onHttpRequest(request("ses_far"))).toBe(SLOT)
    expect((await refuse(w, "ses_far", SLOT)).decision).toEqual({ retry: true, delay: 60_000 })
    // An older PC that does not say: unknown, never chosen.
    view.accounts = view.accounts.map(({ usable: _usable, ...item }) => item)
    expect((await refuse(w, "ses_far", SLOT)).decision).toEqual({ retry: true, delay: 60_000 })
    view.accounts = view.accounts.map((item) => ({ ...item, usable: true }))
    expect((await refuse(w, "ses_far", SLOT)).decision).toEqual({ retry: true, delay: 0 })
    expect(w.storage.get(Kv.claudeSession("ses_far"))).toMatchObject({ accountID: TWO })
  })
})

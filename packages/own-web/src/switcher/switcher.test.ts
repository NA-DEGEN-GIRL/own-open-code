// Switcher logic (03 §5.2, §6.2, §6.3, §7.2, §7.5): cost formats, when to ask, which dialog options show and which is
// preselected, the estimate cache and debounce, the picker model (grouping, search, keyboard, keep-same-model), and the
// model list's catalog marks (07 §4.3, §7.3: `새` and a dim retirement date, never a notice).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import type { Account, Estimate, Limit, Policy } from "@own/protocol"
import type { ServerRuntime } from "@/data"
import { createI18n } from "@/i18n"
import { foldedParts } from "@/limits/summary-model"
import { presetsText } from "@/presets/strings"
import { coldTokens, decide, dialogPlan, dontAskTokens, shrinkFactor } from "./cost"
import { costText, footerCost, quotaText, tokenText, warningNotes } from "./describe"
import { createEstimator, type EstimateState } from "./estimate"
import { formatDelta, formatMoney, formatRange, formatTokens } from "./format"
import { modelName, namedVariant, runningOnParts, variantName } from "./labels"
import {
  filterModels,
  groupAccounts,
  keepVariant,
  matchesQuery,
  modelForAccount,
  modelMarks,
  NEW_TAG_DAYS,
  recommendedAccount,
  recommendedAccounts,
  rowModel,
  rowSelection,
  step,
  unusable,
  type Picked,
} from "./picker"

const i18n = createI18n("ko")
const confirm: Policy.Confirm = {
  silentBelowTokens: 20_000,
  dialogAtTokens: 100_000,
  dialogAtQuotaPercent: 5,
  dialogAtUSD: 0.5,
}

type Options = Partial<Estimate.Option>

function option(strategy: Estimate.Strategy, extra: Options = {}): Estimate.Option {
  return { strategy, available: true, display: strategy === "fork" ? "secondary" : "primary", ...extra }
}

function estimate(
  overrides: Partial<Omit<Estimate.Result, "context" | "inputs">> & {
    readonly P?: number
    readonly W?: readonly [number, number]
    readonly units?: { source: Estimate.Unit; target: Estimate.Unit }
  } = {},
): Estimate.Result {
  const [W_lo, W_hi] = overrides.W ?? [0, 0]
  // SAFETY: fixture shaped like `switch.estimate`; branded ids are plain strings at runtime.
  return {
    estimateID: "est_1",
    expiresAt: Date.now() + 300_000,
    context: { P: overrides.P ?? 118_000, Z: 12_000, units: overrides.units ?? { source: "USD", target: "USD" } },
    target: { providerID: "own-anth-k1", id: "claude-opus-5-5", fits: true },
    options: [option("now", { delta: { lo: 0.6, hi: 0.6, unit: "USD" } })],
    variantOnly: null,
    confidence: { steps: 14, recentError: 0.08 },
    inputs: { W_lo, W_hi, rates: {}, ttl: { lo: 300, hi: 300 } },
    ...overrides,
  } as Estimate.Result
}

const current = { providerID: "own-codex-p1q2", id: "gpt-5.5" }
const target = { providerID: "own-anth-k1", id: "claude-opus-5-5" }

describe("formats (03 §7.5)", () => {
  test("tokens in 1k units, 1.2M from a million", () => {
    expect(formatTokens(118_400)).toBe("118k")
    expect(formatTokens(1_200_000)).toBe("1.2M")
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(999_600)).toBe("1M")
    expect(formatTokens(800)).toBe("1k")
    expect(formatTokens(1)).toBe("<1k")
    expect(formatTokens(0)).toBe("0")
  })

  test("money: two decimals under $1, one from $1", () => {
    expect(formatMoney(0.6)).toBe("$0.60")
    expect(formatMoney(23.14)).toBe("$23.1")
    expect(formatMoney(-0.2)).toBe("−$0.20")
  })

  test("deltas: sign, unit, ranges; credits always carry ≈", () => {
    expect(formatDelta(i18n, { lo: 0.72, hi: 0.72, unit: "USD" })).toBe("+$0.72")
    expect(formatDelta(i18n, { lo: 13.5, hi: 13.5, unit: "credits" })).toBe("+≈13.5 cr")
    expect(formatDelta(i18n, { lo: 0, hi: 1.1, unit: "credits" })).toBe("+≈0.0~1.1 cr")
    expect(formatDelta(i18n, { lo: 0.12, hi: 0.4, unit: "USD" })).toBe("+$0.12~$0.40")
    expect(formatDelta(i18n, { lo: -0.2, hi: -0.2, unit: "USD" })).toBe("−$0.20")
    expect(formatRange(i18n, { lo: 0.6, hi: 0.6, unit: "USD" })).toBe("$0.60")
  })
})

describe("decide (03 §6.2)", () => {
  const run = (result: Estimate.Result, extra: Partial<Parameters<typeof decide>[0]> = {}) =>
    decide({ estimate: result, current, target, confirm, ...extra }).level

  test("same Ref → same; variant only with preservesCache → free", () => {
    expect(run(estimate(), { target: current })).toBe("same")
    expect(
      run(estimate({ variantOnly: { preservesCache: true, reason: "message_effort_update" } }), {
        target: { ...current, variant: "high" },
      }),
    ).toBe("free")
  })

  test("a session without turns applies at once", () => {
    expect(decide({ estimate: estimate({ P: 0 }), current, target, confirm })).toMatchObject({
      level: "free",
      note: "new",
    })
  })

  test("< 20k rewrite → immediate; 20k–100k → inline; ≥ 100k → dialog", () => {
    const cheap = { options: [option("now", { delta: { lo: 0.05, hi: 0.05, unit: "USD" } })] }
    expect(run(estimate({ ...cheap, P: 118_000, W: [100_000, 100_000] }))).toBe("immediate")
    expect(run(estimate({ ...cheap, P: 60_000 }))).toBe("inline")
    expect(run(estimate({ ...cheap, P: 118_000 }))).toBe("dialog")
  })

  test("the upper bound decides when the target cache is uncertain", () => {
    const cheap = { options: [option("now", { delta: { lo: 0.05, hi: 0.05, unit: "USD" } })] }
    // cold = 118k − W: 4k … 66k → the upper bound 66k is inline, not immediate.
    expect(run(estimate({ ...cheap, P: 118_000, W: [52_000, 114_000] }))).toBe("inline")
    expect(coldTokens(estimate({ P: 118_000, W: [52_000, 114_000] }))).toEqual({ lo: 4_000, hi: 66_000 })
  })

  test("money or calibrated quota % over the thresholds opens the dialog even for a small rewrite", () => {
    const usd = { options: [option("now", { delta: { lo: 0.5, hi: 0.5, unit: "USD" } })] }
    expect(run(estimate({ ...usd, P: 10_000 }))).toBe("dialog")
    const quota = (state: Estimate.CalibrationState) => ({
      options: [
        option("now", {
          delta: { lo: 1, hi: 1, unit: "credits" },
          quota: { window: "codex.primary", percent: { lo: 0, hi: 6 }, state },
        }),
      ],
    })
    expect(run(estimate({ ...quota("partial"), P: 10_000 }))).toBe("dialog")
    // Calibrating: the % is not used (03 §6.2 "보정 전이면 토큰과 credits·$ 기준만").
    expect(run(estimate({ ...quota("calibrating"), P: 10_000 }))).toBe("immediate")
  })

  test("target too small or `now` unavailable → dialog", () => {
    expect(run(estimate({ target: { ...estimate().target, fits: false } }))).toBe("dialog")
    expect(run(estimate({ options: [option("now", { available: false, reason: "target_context_too_small" })] }))).toBe(
      "dialog",
    )
  })

  test("current cache already cold: apply at once (unless money says otherwise)", () => {
    const cheap = { options: [option("now", { delta: { lo: 0.05, hi: 0.05, unit: "USD" } })] }
    expect(
      decide({ estimate: estimate({ ...cheap, P: 150_000 }), current, target, confirm, currentCold: true }),
    ).toMatchObject({
      level: "immediate",
      note: "currentCold",
    })
    const pricey = { options: [option("now", { delta: { lo: 0.9, hi: 0.9, unit: "USD" } })] }
    expect(run(estimate({ ...pricey, P: 150_000 }), { currentCold: true })).toBe("dialog")
  })

  test("the session override replaces dialogAtTokens only", () => {
    const cheap = { options: [option("now", { delta: { lo: 0.05, hi: 0.05, unit: "USD" } })] }
    expect(run(estimate({ ...cheap, P: 118_000 }), { dialogAtTokens: 150_000 })).toBe("inline")
    expect(dontAskTokens(118_000, 100_000)).toBe(150_000)
    expect(dontAskTokens(20_000, 100_000)).toBe(100_000)
  })
})

describe("dialogPlan (03 §6.3)", () => {
  const all = [
    option("now", { delta: { lo: 13.5, hi: 13.5, unit: "credits" }, perRequestAfter: 1.83 }),
    option("compact-then-switch", {
      delta: { lo: 7.3, hi: 7.3, unit: "credits" },
      perRequestAfter: 0.67,
      recommended: true,
    }),
    option("switch-then-compact", { available: false, reason: "source_available" }),
    option("cold-point", {
      trigger: "either",
      idleMinutes: 60,
      uncertain: true,
      delta: { lo: 0, hi: 1.1, unit: "credits" },
    }),
    option("new-session", { delta: { lo: 5, hi: 5, unit: "credits" }, contextLoss: true }),
    option("fork", { delta: { lo: 13.5, hi: 13.5, unit: "credits" } }),
  ]

  test("table order, switch-then-compact hidden when the source can compact, fork under 더 보기", () => {
    const plan = dialogPlan({ options: all })
    expect(plan.primary.map((item) => item.strategy)).toEqual([
      "now",
      "compact-then-switch",
      "cold-point",
      "new-session",
    ])
    expect(plan.secondary.map((item) => item.strategy)).toEqual(["fork"])
    expect(plan.choice).toBe("compact-then-switch")
    expect(plan.expandMore).toBe(false)
    expect(plan.cantCompact).toBe(false)
  })

  test("source exhausted: switch-then-compact replaces compact-then-switch with the note", () => {
    const plan = dialogPlan({
      options: [
        option("now"),
        option("compact-then-switch", { available: false, reason: "source_exhausted" }),
        option("switch-then-compact"),
        option("fork"),
      ],
    })
    expect(plan.primary.map((item) => item.strategy)).toEqual(["now", "switch-then-compact"])
    expect(plan.cantCompact).toBe(true)
  })

  test("no recommendation → now; now blocked → first available; a recommended secondary opens 더 보기", () => {
    expect(dialogPlan({ options: [option("now"), option("new-session")] }).choice).toBe("now")
    const blocked = dialogPlan({
      options: [
        option("now", { available: false, reason: "target_context_too_small" }),
        option("compact-then-switch", { recommended: true }),
      ],
    })
    expect(blocked.choice).toBe("compact-then-switch")
    expect(blocked.primary[0]).toMatchObject({ strategy: "now", available: false })
    const secondary = dialogPlan({ options: [option("now"), option("fork", { recommended: true })] })
    expect(secondary.choice).toBe("fork")
    expect(secondary.expandMore).toBe(true)
  })

  test("unavailable options other than the exclusive pair stay visible (dimmed with the reason)", () => {
    const plan = dialogPlan({
      options: [option("now"), option("cold-point", { available: false, reason: "ttl_too_long" })],
    })
    expect(plan.primary.map((item) => [item.strategy, item.available])).toEqual([
      ["now", true],
      ["cold-point", false],
    ])
  })

  test("shrink factor for `이후 요청도 작아집니다 (약 1/N)`", () => {
    expect(shrinkFactor({ options: all }, all[1]!)).toBe(3)
    expect(shrinkFactor({ options: all }, all[4]!)).toBeUndefined()
  })
})

describe("describe (03 §7.5)", () => {
  test("footer line: tokens and Δ; range when the target cache is uncertain", () => {
    const result = estimate({ P: 118_000, W: [0, 0] })
    expect(footerCost({ i18n, estimate: result }, undefined)).toBe("전환 비용 ≈ 캐시 재작성 118k · +$0.60")
    expect(tokenText(estimate({ P: 118_000, W: [52_000, 114_000] }))).toBe("4k–66k")
  })

  test("different units: the target's first request only; Claude slot: cost unknown", () => {
    const cross = estimate({ units: { source: "credits", target: "USD" } })
    expect(costText({ i18n, estimate: cross }, cross.options[0])).toBe("첫 요청 약 $0.60")
    expect(costText({ i18n, estimate: cross, targetIsClaudeSlot: true }, cross.options[0])).toContain("비용 알 수 없음")
    expect(costText({ i18n, estimate: cross }, option("now", { delta: null }))).toBe("비용 알 수 없음")
  })

  test("a Claude Agent target is a plan: its limit impact, else that it uses the plan, never 'unknown' (CAM-7)", () => {
    const plan = estimate({})
    const quota = { window: "claude.5h", percent: { lo: 0, hi: 2 }, state: "partial" } as const
    expect(
      costText({ i18n, estimate: plan, planText: "토큰 요금 없이 구독 한도에서 써요" }, option("now", { delta: null })),
    ).toBe("토큰 요금 없이 구독 한도에서 써요")
    expect(
      costText(
        { i18n, estimate: plan, planText: "토큰 요금 없이 구독 한도에서 써요" },
        option("now", { delta: null, quota }),
      ),
    ).toBe("5시간 남은 한도 −0–2%")
    const unknown = { ...plan, warnings: ["rate_unknown" as const] }
    const from = { account: "CA-01", cacheState: "" }
    expect(warningNotes(i18n, unknown, from).map((note) => note.text)).toContain(
      "요율을 몰라 일부 비용을 계산하지 못했어요",
    )
  })

  test("quota impact: range, point, or 보정 중; remaining mode (the default) counts it off what is left", () => {
    const range = { window: "codex.primary", percent: { lo: 0, hi: 8.5 }, state: "partial" } as const
    const point = { window: "codex.secondary", percent: { lo: 1, hi: 3, point: 2 }, state: "calibrated" } as const
    expect(quotaText(i18n, range, "used")).toBe("5시간 한도 +0–8.5%")
    expect(quotaText(i18n, point, "used")).toBe("주간 한도 +2%")
    expect(quotaText(i18n, range, "remaining")).toBe("5시간 남은 한도 −0–8.5%")
    expect(quotaText(i18n, point, "remaining")).toBe("주간 남은 한도 −2%")
    expect(quotaText(i18n, range)).toBe("5시간 남은 한도 −0–8.5%")
    expect(quotaText(i18n, { window: "codex.primary", percent: null, state: "calibrating" })).toBe("보정 중")
  })

  test("warnings become notes, warnings first", () => {
    const notes = warningNotes(
      i18n,
      estimate({ warnings: ["cross_provider_reasoning_loss", "target_compacts_soon"] }),
      { account: "개인 Pro", cacheState: "따뜻함 · 약 4분" },
    )
    expect(notes[0]).toEqual({ tone: "warn", text: "대상에서 곧 자동 압축돼요" })
    expect(notes[1]?.text).toContain("돌아올 때 개인 Pro 캐시가 살아 있으면 다시 쓸 수 있어요 (따뜻함 · 약 4분).")
  })
})

describe("estimator (03 §16.4)", () => {
  test("debounces 150 ms, the latest selection wins, results are cached", async () => {
    const calls: string[] = []
    const estimator = createEstimator({
      call: async (sessionID, ref) => {
        calls.push(`${sessionID}:${ref.id}`)
        return estimate()
      },
      debounceMs: 20,
    })
    const states: EstimateState[] = []
    estimator.schedule("ses_1", { providerID: "p", id: "a" }, (state) => states.push(state))
    estimator.schedule("ses_1", { providerID: "p", id: "b" }, (state) => states.push(state))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(calls).toEqual(["ses_1:b"])
    expect(states.map((state) => state.status)).toEqual(["loading", "loading", "ready"])
    estimator.schedule("ses_1", { providerID: "p", id: "b" }, (state) => states.push(state))
    expect(states.at(-1)?.status).toBe("ready")
    expect(calls.length).toBe(1)
  })

  test("the cache expires after 30 s or at expiresAt, and a switch invalidates the session", async () => {
    let now = 1_000
    let calls = 0
    const estimator = createEstimator({
      call: async () => {
        calls++
        return estimate({ expiresAt: 100_000 })
      },
      now: () => now,
    })
    await estimator.fetch("ses_1", target)
    await estimator.fetch("ses_1", target)
    expect(calls).toBe(1)
    now += 31_000
    await estimator.fetch("ses_1", target)
    expect(calls).toBe(2)
    now = 100_000
    expect(estimator.peek("ses_1", target)).toBeUndefined()
    await estimator.fetch("ses_1", target)
    now = 100_500
    estimator.invalidate("ses_1")
    expect(estimator.peek("ses_1", target)).toBeUndefined()
  })
})

function account(id: string, kind: Account.View["kind"], extra: Partial<Account.View> = {}): Account.View {
  // SAFETY: fixture shaped like `accounts.list[]`.
  return {
    id,
    kind,
    label: id,
    shortLabel: id,
    color: "indigo",
    providerID: `own-${kind}-${id}`,
    billing: kind === "codex" ? "subscription" : "metered",
    status: "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: "key" },
    ...extra,
  } as Account.View
}

function window(id: string, usedPercent: number | undefined, extra: Partial<Limit.Window> = {}): Limit.Window {
  // SAFETY: fixture shaped like `quota.snapshot` windows.
  return {
    id,
    accountID: "a",
    providerID: "p",
    scope: "account",
    kind: "rolling_quota",
    label: id,
    usedPercent,
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: 0,
    ...extra,
  } as Limit.Window
}

describe("picker (03 §5.2, §7.2)", () => {
  test("groups by kind in the drawing's order, hides disabled and retired, candidates first", () => {
    const groups = groupAccounts(
      [
        account("api", "oai"),
        account("work", "codex"),
        account("home", "codex"),
        account("off", "codex", { status: "disabled" }),
        account("slot", "claude-sub"),
        account("plan", "siwc"),
      ],
      ["own-codex-home"],
    )
    expect(groups.map((group) => [group.kind, group.accounts.map((item): string => item.id)])).toEqual([
      ["codex", ["home", "work"]],
      ["siwc", ["plan"]],
      ["oai", ["api"]],
      ["claude-sub", ["slot"]],
    ])
  })

  test("search over account, provider kind and model names (Korean included)", () => {
    const pro = account("개인 Pro", "codex")
    expect(matchesQuery("개인", pro, "ChatGPT 구독", [])).toBe(true)
    expect(matchesQuery("chatgpt", pro, "ChatGPT 구독", [])).toBe(true)
    expect(matchesQuery("sol", pro, "ChatGPT 구독", ["GPT-5.6 Sol"])).toBe(true)
    expect(matchesQuery("claude", pro, "ChatGPT 구독", ["GPT-5.6 Sol"])).toBe(false)
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", variants: [] },
      { id: "gpt-6-sol", name: "GPT-6 Sol", variants: [] },
    ]
    expect(filterModels("sol", false, models).map((model) => model.id)).toEqual(["gpt-6-sol"])
    expect(filterModels("sol", true, models)).toHaveLength(2)
  })

  test("keyboard steps wrap inside a column", () => {
    expect(step(["a", "b", "c"], "c", 1)).toBe("a")
    expect(step(["a", "b", "c"], "a", -1)).toBe("c")
    expect(step(["a", "b"], undefined, 1)).toBe("a")
    expect(step([], "a", 1)).toBeUndefined()
  })

  test("changing the account keeps the model (by id, then by name) and the variant when offered", () => {
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", variants: ["low", "high"] },
      { id: "gpt-6", name: "GPT-6", variants: [] },
    ]
    const pick = (...input: Parameters<typeof modelForAccount>) => {
      const chosen = modelForAccount(...input)
      return chosen && { id: chosen.model.id, variant: chosen.variant }
    }
    expect(pick({ id: "gpt-6", variant: "high" }, models)).toEqual({ id: "gpt-6", variant: undefined })
    expect(pick({ id: "openai/gpt-5.5", name: "GPT-5.5", variant: "high" }, models)).toEqual({
      id: "gpt-5.5",
      variant: "high",
    })
    expect(pick({ id: "claude" }, models)).toEqual({ id: "gpt-5.5", variant: undefined })
    expect(pick(undefined, [])).toBeUndefined()
    expect(keepVariant("high", models[0])).toBe("high")
    expect(keepVariant("high", models[1])).toBeUndefined()
  })

  test("another provider group's account starts on that group's default with its effort (07 §2.2, PG12 (e))", () => {
    // ChatGPT 01 on GPT-6 Astra · high → DeepSeek, which has no Astra: its group default, not its first model.
    const deepseek = [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", variants: ["low", "high", "max"] },
      { id: "deepseek-flash", name: "DeepSeek Flash", variants: ["high"] },
    ]
    const current = { id: "gpt-6-astra", name: "GPT-6 Astra", variant: "high" }
    expect(modelForAccount(current, deepseek, { id: "deepseek-flash", variant: "high" })).toEqual({
      model: deepseek[1],
      variant: "high",
    })
    // An effort the default's model does not offer is dropped (the model default).
    expect(modelForAccount(current, deepseek, { id: "deepseek-flash", variant: "xhigh" })?.variant).toBeUndefined()
    // A group default this account lacks (another compat server) leaves the first model.
    expect(modelForAccount(current, deepseek, { id: "deepseek-chat" })?.model.id).toBe("deepseek-v4-pro")
    // The same model on the new account still wins over the group default.
    expect(modelForAccount({ id: "deepseek-v4-pro", variant: "max" }, deepseek, { id: "deepseek-flash" })).toEqual({
      model: deepseek[0],
      variant: "max",
    })
  })

  test("unusable reasons and the soonest reset of an exhausted account", () => {
    expect(unusable(account("a", "codex", { status: "needs_reauth" }))).toEqual({ reason: "auth" })
    expect(
      unusable(account("a", "codex", { status: "exhausted" }), [
        window("5h", 100, { status: "exhausted", resetAt: 2_000 }),
        window("week", 100, { status: "exhausted", resetAt: 1_000 }),
      ]),
    ).toEqual({ reason: "exhausted", resetAt: 1_000 })
    expect(
      unusable(account("s", "claude-sub", { plugin: { installed: false, acknowledged: false, version: null } })),
    ).toEqual({ reason: "plugin" })
    expect(unusable(account("a", "oai"))).toBeUndefined()
    // 02 §8.7 (CS): Claude Code's own login that expired waits for Claude Code; no `다시 로그인` hint.
    const shared = (stale: boolean) =>
      account("s", "claude-sub", {
        status: stale ? "needs_reauth" : "ready",
        claude: { managed: false, default: true, folder: "C:\\u\\.claude", loaded: true, shared: true, stale },
      })
    expect(unusable(shared(true))).toEqual({ reason: "shared" })
    expect(unusable(shared(false))).toBeUndefined()
  })

  test("추천: the account with the most headroom, only among two or more", () => {
    const quota = { a: [window("5h", 80)], b: [window("5h", 20)] }
    const best: string | undefined = recommendedAccount(
      [account("a", "codex"), account("b", "codex")],
      quota,
      1,
      () => undefined,
    )
    expect(best).toBe("b")
    expect(recommendedAccount([account("a", "codex")], quota, 1, () => undefined)).toBeUndefined()
  })

  test("추천 ranks each account with the model it would run: never one whose week of that model is used up (LV)", () => {
    // B is barely used but its Opus week ran out; C is fuller everywhere.
    const quota = {
      b: [
        window("claude.5h", 10),
        window("claude.7d", 20),
        window("claude.7d_opus", undefined, { status: "exhausted", resetAt: 5 * 86_400_000 }),
      ],
      c: [window("claude.5h", 60), window("claude.7d", 70)],
    }
    const accounts = [account("b", "claude-sub"), account("c", "claude-sub")]
    const pick = (model: string | undefined): string | undefined => recommendedAccount(accounts, quota, 1, () => model)
    expect(pick("claude-opus-5-5")).toBe("c")
    expect(pick("claude-sonnet-4-5")).toBe("b")
    // The server's model-less state would have said B; the row's model decides.
    expect(pick(undefined)).toBe("b")
  })

  // The third limits review (2026-10-25): every row ranks with what selecting it would choose, so no row flips when the
  // selection moves, and 추천 reads every row the same way.
  const CLAUDE = [
    { id: "claude-sonnet-4-5", name: "Sonnet 4.5", variants: [] },
    { id: "claude-opus-5-5", name: "Opus 5.5", variants: [] },
  ]
  const GPT = [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", variants: [] },
    { id: "gpt-5.5", name: "GPT-5.5", variants: [] },
  ]
  const CLAUDE_DEFAULT = { id: "claude-sonnet-4-5" }
  const GPT_DEFAULT = { id: "gpt-5.5" }
  const OPUS = { id: "claude-opus-5-5", name: "Opus 5.5" }
  /** Selecting a row (the popover's `selectAccount`): the model `modelForAccount` keeps of the picked one. */
  const selected = (
    picked: { readonly id: string; readonly name?: string },
    models: typeof CLAUDE,
    groupDefault: { readonly id: string },
  ) => {
    const model = modelForAccount(picked, models, groupDefault)!.model
    return { id: model.id, name: model.name }
  }

  test("a row's model: the picked model where the account offers it, else its default; selecting it chooses it (LV)", () => {
    // Claude 1 is selected with the conversation's Opus: Claude 2 offers Opus, a ChatGPT account its default.
    expect(rowModel(OPUS, CLAUDE, CLAUDE_DEFAULT)).toBe("claude-opus-5-5")
    expect(rowModel(OPUS, GPT, GPT_DEFAULT)).toBe("gpt-5.5")
    expect(rowModel(OPUS, GPT)).toBe("gpt-5.6-sol")
    // While the account's models are not known yet: the picked model.
    expect(rowModel(OPUS, [])).toBe("claude-opus-5-5")
    expect(rowModel(undefined, [])).toBeUndefined()
  })

  test("Claude 1 → ChatGPT → Claude 2 → ChatGPT 2 → Claude 1: no row's model, line or 추천 moves with the cursor; Claude 1 selects Opus again (LV)", () => {
    // The fourth limits review: the rows followed the selected row's model, so the walk read Claude 2 as Sonnet and came
    // back to Claude 1 on Sonnet. Claude 2's Opus week ran out, so its line differs between the two models. The fifth:
    // 추천 counted only the selected row's group, so on a ChatGPT row Claude 1 lost its badge.
    const models: Record<string, typeof CLAUDE> = { one: CLAUDE, gpt: GPT, gpt2: GPT, two: CLAUDE }
    const defaults: Record<string, { readonly id: string }> = {
      one: CLAUDE_DEFAULT,
      gpt: GPT_DEFAULT,
      gpt2: GPT_DEFAULT,
      two: CLAUDE_DEFAULT,
    }
    const label = (id: string, text: string, used: number | undefined, extra: Partial<Limit.Window> = {}) =>
      window(id, used, { label: text, ...extra })
    const quota: Record<string, Limit.Window[]> = {
      one: [label("claude.5h", "5시간", 40), label("claude.7d", "주간", 30)],
      gpt: [label("codex.primary", "5시간", 55), label("codex.secondary", "주간", 20)],
      gpt2: [label("codex.primary", "5시간", 25), label("codex.secondary", "주간", 10)],
      two: [
        label("claude.5h", "5시간", 10),
        label("claude.7d", "주간", 20),
        label("claude.7d_opus", "주간 · Opus", undefined, { status: "exhausted", resetAt: 5 * 86_400_000 }),
      ],
    }
    const accounts = [
      account("one", "claude-sub"),
      account("gpt", "codex"),
      account("gpt2", "codex"),
      account("two", "claude-sub"),
    ]
    // The popover as it opens on a conversation running Opus on Claude 1: Opus is picked.
    let selection: { accountID: string; modelID?: string; variant?: string; picked?: Picked } = {
      accountID: "one",
      modelID: OPUS.id,
      picked: OPUS,
    }
    /** Every row as the popover draws it, in a new conversation (`turns: false`) or in one with turns. */
    const rows = (turns: boolean) => {
      const model = (item: Account.View) => rowModel(selection.picked, models[item.id]!, defaults[item.id])
      const badges = recommendedAccounts(accounts, quota, 1, model, turns)
      return accounts.map((item) => ({
        id: item.id,
        model: model(item),
        line: foldedParts(i18n, quota[item.id]!, 1, 2, undefined, model(item)).map((part) => part.text),
        recommended: badges.has(item.id),
      }))
    }
    const opened = rows(false)
    const withTurns = rows(true)
    expect(opened.map((row) => row.model)).toEqual(["claude-opus-5-5", "gpt-5.5", "gpt-5.5", "claude-opus-5-5"])
    expect(opened[3]!.line[0]).toBe("주간 · Opus 차단")
    // One 추천 in each group with several accounts: Claude 1 (Claude 2's Opus week is used up) and ChatGPT 2.
    expect(opened.filter((row) => row.recommended).map((row): string => row.id)).toEqual(["one", "gpt2"])
    // A conversation with turns has none (03 §5.1), and its rows read the same otherwise.
    expect(withTurns.filter((row) => row.recommended)).toEqual([])
    expect(withTurns.map((row) => ({ ...row, recommended: true }))).toEqual(
      opened.map((row) => ({ ...row, recommended: true })),
    )
    const chosen = ["gpt", "two", "gpt2", "one"].map((id) => {
      selection = { ...selection, ...rowSelection(selection.picked, id, models[id]!, defaults[id]) }
      // Every row, its badge included, at every step.
      expect(rows(false)).toEqual(opened)
      expect(rows(true)).toEqual(withTurns)
      // Selecting a row chooses exactly the model it ranked with.
      expect(selection.modelID).toBe(opened.find((row) => row.id === id)!.model!)
      return selection.modelID
    })
    expect(chosen).toEqual(["gpt-5.5", "claude-opus-5-5", "gpt-5.5", "claude-opus-5-5"])
    expect(selection.picked).toBe(OPUS)
  })

  test("Sonnet picked on Claude 1 → Claude 2: the row reads Sonnet before and after it is selected (LV)", () => {
    const sonnet = { id: "claude-sonnet-4-5", name: "Sonnet 4.5" }
    const claude2 = rowModel(sonnet, CLAUDE, CLAUDE_DEFAULT)
    expect(claude2).toBe("claude-sonnet-4-5")
    expect(selected(sonnet, CLAUDE, CLAUDE_DEFAULT).id).toBe(claude2!)
    // 추천 ranks every row with it: Claude 2's used-up Opus week does not count against a row that runs Sonnet.
    const quota = {
      one: [window("claude.5h", 70), window("claude.7d", 60)],
      two: [
        window("claude.5h", 10),
        window("claude.7d", 20),
        window("claude.7d_opus", undefined, { status: "exhausted", resetAt: 5 * 86_400_000 }),
      ],
    }
    const accounts = [account("one", "claude-sub"), account("two", "claude-sub")]
    const best: string | undefined = recommendedAccount(accounts, quota, 1, () =>
      rowModel(sonnet, CLAUDE, CLAUDE_DEFAULT),
    )
    expect(best).toBe("two")
    const onOpus: string | undefined = recommendedAccount(accounts, quota, 1, () =>
      rowModel(OPUS, CLAUDE, CLAUDE_DEFAULT),
    )
    expect(onOpus).toBe("one")
  })
})

describe("catalog marks of the model list (07 §4.3, §7.3)", () => {
  const NOW = Date.parse("2026-10-02T12:00:00Z")
  const DAY = 24 * 3_600_000
  const iso = (at: number) => new Date(at).toISOString()
  const marks = [
    { id: Model.ID.make("gpt-6.1-sol"), addedAt: iso(NOW - 2 * DAY) },
    { id: Model.ID.make("gpt-6-sol"), addedAt: iso(NOW - (NEW_TAG_DAYS + 1) * DAY) },
    { id: Model.ID.make("gpt-5.5"), upstream: "missing" as const },
  ]
  const retirements = { "gpt-5.5": Date.parse("2026-10-14T00:00:00Z") }
  const of = (modelID: string) => modelMarks({ marks, retirements, modelID, now: NOW })

  test("새 only for a model the pinned template gained, while the display window lasts", () => {
    expect(of("gpt-6.1-sol").fresh).toBe(true)
    expect(of("gpt-6-sol").fresh).toBe(false)
    // A template model without `addedAt` (captured with the template) and an unknown model are never new.
    expect(of("gpt-5.5").fresh).toBe(false)
    expect(of("gpt-6-astra").fresh).toBe(false)
    expect(modelMarks({ marks: undefined, retirements: undefined, modelID: "gpt-6.1-sol", now: NOW })).toEqual({
      fresh: false,
      retires: undefined,
    })
  })

  test("a retirement is a date only: no successor, no 새", () => {
    expect(of("gpt-5.5")).toEqual({ fresh: false, retires: Date.parse("2026-10-14T00:00:00Z") })
    expect(of("gpt-6.1-sol").retires).toBeUndefined()
    expect(presetsText("ko", "own.preset.newTag")).toBe("새")
    expect(presetsText("ko", "own.preset.retirement", { date: "10-14" })).toBe("10-14 은퇴 예정(Codex)")
  })

  test("the popover shows both in the row, dimmed for the date, and announces neither", async () => {
    const source = (await Bun.file(path.join(import.meta.dir, "popover.tsx")).text())
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "")
    expect(source).toContain('presets("own.preset.newTag")')
    expect(source).toMatch(/class="own-sw-faint" data-testid="switcher-model-retirement"/)
    expect(source).not.toMatch(/showToast|alert\(/)
    expect(source).not.toMatch(/successor/)
  })
})

describe("effort names (03 §4.6: the provider's level names, never translated)", () => {
  test("every level reads as the provider names it in both locales; the model's default is 기본/Default", () => {
    const en = createI18n("en")
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(variantName(i18n, level)).toBe(level)
      expect(variantName(en, level)).toBe(level)
      expect(namedVariant(level)).toBe(level)
    }
    expect(variantName(i18n, "ultra-think")).toBe("ultra-think")
    expect(variantName(i18n, undefined)).toBe("기본")
    expect(variantName(en, undefined)).toBe("Default")
    expect(variantName(i18n, "")).toBe("기본")
    // own-web creates sessions with variant `default` and presets store it: it reads like a missing one, not `default▾`.
    expect(variantName(i18n, "default")).toBe("기본")
    expect(variantName(en, "default")).toBe("Default")
    expect(namedVariant("default")).toBeUndefined()
    expect(namedVariant(undefined)).toBeUndefined()
  })
  test("the switcher's footer leaves the default effort out, whether missing or `default`", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "popover.tsx")).text()
    expect(source).toContain('(namedVariant(ref().variant) ? ` · ${variantName(i18n, ref().variant)}` : "")')
  })
})

describe("names and the cache in the switcher and the pills (03 §4.4, §7.4, UX 2026-10-26)", () => {
  test("a model the catalog does not name reads as words, never its raw id (`claude-opus-5-5`)", () => {
    // A server whose catalog is not loaded yet: no Location lists a model.
    const runtime = { key: "names", data: { location: { model: { list: () => undefined } } } }
    const name = (id: string) => modelName(runtime as unknown as ServerRuntime, { providerID: "own-x", id })
    expect(name("claude-opus-5-5")).toBe("Claude Opus 5.5")
    expect(name("gpt-5.5")).toBe("GPT-5.5")
    // A catalog that names a model by its id (the Claude slot's) reads as words too; a real name stays.
    const models = [
      { providerID: "own-x", id: "claude-opus-5-5", name: "claude-opus-5-5" },
      { providerID: "own-x", id: "gpt-6-astra", name: "GPT-6 Astra" },
    ]
    const listed = { key: "listed", data: { location: { model: { list: () => models } } } }
    const named = (id: string) => modelName(listed as unknown as ServerRuntime, { providerID: "own-x", id })
    expect(named("claude-opus-5-5")).toBe("Claude Opus 5.5")
    expect(named("gpt-6-astra")).toBe("GPT-6 Astra")
  })

  test("`모델 @ 계정` in parts, so the pills let the model give way first; joined, the translated string", () => {
    const en = createI18n("en")
    for (const locale of [i18n, en]) {
      const parts = runningOnParts(locale, "GPT-5.5", "ChatGPT 01")
      expect(parts.map((part) => part.part)).toEqual(["model", undefined, "account"])
      expect(parts.map((part) => part.text).join("")).toBe(
        locale.t("own.session.runningOn", { model: "GPT-5.5", account: "ChatGPT 01" }),
      )
    }
  })

  test("a row names its cache only where it helps (its own, warm or cooling), and 닫기 stands alone", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "popover.tsx")).text()
    expect(source).toContain('<Show when={props.current || state().state === "warm" || state().state === "cooling"}>')
    expect(source).toContain('i18n.t("own.pill.cache", { state: state().text })')
    expect(source).not.toContain("state().symbol")
    expect(source).toContain('<Show when={applyLabel() !== i18n.t("own.switcher.close")}>')
  })
})

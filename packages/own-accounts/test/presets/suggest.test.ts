// presets.suggest and the starters (07 §3.4, PG11): suggestions come from the live accounts and catalog of the day,
// never name a paid account, never a same-company subscription, and a local model only once its running window is
// verified. Fake accounts, fake limit windows, a fake local model list.

import { describe, expect, test } from "bun:test"
import { Provider } from "@opencode/schema/provider"
import { Preset, type Limit } from "@own/protocol"
import { PresetSuggest } from "../../src/presets/suggest.js"
import { rpcContext } from "../slots/support.js"
import {
  CHATGPT_01,
  CHATGPT_02,
  CLAUDE,
  CLAUDE_OFF,
  CODEX_A,
  CODEX_B,
  DEEPSEEK_KEY,
  OLLAMA,
  OPENAI_KEY,
  harness,
  type Harness,
} from "./fixtures/catalog-2026-10-01.js"

async function suggest(h: Harness, group: Preset.Group, template?: Preset.Starter) {
  const out = await h.presets.suggest(template ? { group, template } : { group }, rpcContext())
  if (!("draft" in out)) throw new Error(`suggest failed: ${JSON.stringify(out)}`)
  return out
}

/** Every pinned account a suggestion names: its rows and its draft. */
function pinned(suggestion: Preset.Suggestion) {
  const targets = [
    ...Object.values(suggestion.rows).flatMap((row) => row?.targets ?? []),
    ...Object.values(suggestion.draft.workers.roles).flatMap((entry) => entry?.targets ?? []),
    ...(suggestion.draft.workers.single ? [suggestion.draft.workers.single] : []),
  ]
  return [...new Set(targets.flatMap((target) => ("pin" in target ? [target.pin.account] : [])))]
}

function used(h: Harness, accountID: Limit.Window["accountID"], providerID: string, percent: number): Limit.Window {
  return {
    id: "codex.5h",
    accountID,
    providerID: Provider.ID.make(providerID),
    scope: "account",
    kind: "rolling_quota",
    label: "5시간",
    usedPercent: percent,
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: h.t.clock.now(),
  }
}

const LIGHTER = { targets: [{ rel: "lighter" }], fill: "lighter" }
const MAIN = { targets: [{ rel: "main" }], fill: "main" }

describe("presets.suggest (07 §3.4)", () => {
  test("a ChatGPT group: relative targets, review on another company's subscription, no paid or same-company account", async () => {
    await using h = await harness()
    const out = await suggest(h, "codex")
    expect<unknown>(out.rows).toEqual({
      explore: LIGHTER,
      general: MAIN,
      // The strongest by input price (07 §3.4 says it ranks by price and shows that it does).
      "own-review": { targets: [{ pin: { account: CLAUDE, model: "claude-fable-5-1" } }], fill: "other-company" },
      "own-quick": LIGHTER,
      "own-deep": MAIN,
    })
    // Without a starter the draft is a new preset: like the main, the model's own delegation.
    expect<unknown>(out.draft).toEqual({
      name: "",
      group: "codex",
      workers: { mode: "same", roles: {} },
      delegation: "model",
      caps: Preset.CAPS,
      ultraCaps: null,
    })
    expect<unknown>(out.starters).toEqual([
      { template: "light-split", name: "가볍게 나눠 쓰기", available: true },
      { template: "cross-review", name: "다른 회사 리뷰", available: true },
      { template: "local-explore", name: "로컬로 탐색", available: false, problem: "no-local" },
    ])
  })

  test("a Claude group: review on the roomiest ChatGPT login; a starter fills the draft (도움될 때)", async () => {
    await using h = await harness()
    h.deps.runtime.limits.upsert([used(h, CHATGPT_01, CODEX_A, 80), used(h, CHATGPT_02, CODEX_B, 20)])
    const out = await suggest(h, "claude-sub", "cross-review")
    expect<unknown>(out.rows["own-review"]).toEqual({
      targets: [{ pin: { account: CHATGPT_02, model: "gpt-6-astra" } }],
      fill: "other-company",
    })
    expect<unknown>(out.draft).toEqual({
      name: "다른 회사 리뷰",
      group: "claude-sub",
      workers: {
        mode: "by-role",
        roles: {
          "own-review": { targets: [{ pin: { account: CHATGPT_02, model: "gpt-6-astra" } }], effort: "inherit" },
        },
      },
      delegation: "when-useful",
      caps: Preset.CAPS,
      ultraCaps: null,
    })
    // The suggested draft saves as it is (R4 at save time holds).
    const saved = await h.presets.set({ preset: { ...out.draft, name: out.draft.name } }, rpcContext())
    expect("preset" in saved).toBe(true)
  })

  test("PG11: no suggestion, starter or draft of any group names a metered or prepaid account", async () => {
    await using h = await harness({ listed: [OLLAMA], resolver: { localVerified: () => true } })
    const groups: ReadonlyArray<Preset.Group> = ["codex", "siwc", "claude-sub", "oai", "ds", "local:ollama"]
    for (const group of groups)
      for (const template of [undefined, ...Preset.Starter.literals]) {
        const accounts = pinned(await suggest(h, group, template))
        expect(accounts).not.toContain(OPENAI_KEY)
        expect(accounts).not.toContain(DEEPSEEK_KEY)
      }
    // Paid groups get only relative, local or other-company subscription targets as well.
    expect(pinned(await suggest(h, "oai", "cross-review"))).toEqual(["local:ollama", CLAUDE])
  })

  test("the Claude slot counts only once acknowledged: until then review runs like the main", async () => {
    await using h = await harness({ claude: { ...CLAUDE_OFF, detected: true } })
    const out = await suggest(h, "codex", "cross-review")
    expect<unknown>(out.rows["own-review"]).toEqual(MAIN)
    // A starter that cannot be filled leaves the draft new and says why.
    expect(out.draft.workers.mode).toBe("same")
    expect(out.starters.find((starter) => starter.template === "cross-review")).toEqual({
      template: "cross-review",
      name: "다른 회사 리뷰",
      available: false,
      problem: "no-other-subscription",
    })
  })

  test("a local model is suggested only with a verified running window (PG9)", async () => {
    {
      await using h = await harness({ listed: [OLLAMA] })
      const out = await suggest(h, "codex", "local-explore")
      expect<unknown>(out.rows.explore).toEqual(LIGHTER)
      expect(out.draft.workers.mode).toBe("same")
      expect(out.starters.find((starter) => starter.template === "local-explore")?.problem).toBe("no-local")
    }
    await using h = await harness({
      listed: [OLLAMA],
      resolver: { localVerified: (_provider, model) => model === OLLAMA.id },
    })
    const out = await suggest(h, "codex", "local-explore")
    const local = { pin: { account: "local:ollama", model: OLLAMA.id } }
    expect<unknown>(out.rows.explore).toEqual({ targets: [local], fill: "local" })
    expect<unknown>(out.draft.workers).toEqual({
      mode: "by-role",
      roles: { explore: { targets: [local], effort: "inherit" } },
    })
    expect(out.starters.every((starter) => starter.available)).toBe(true)
  })

  test("a local group has no lighter pair: 가볍게 나눠 쓰기 is greyed and its roles run like the main", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const out = await suggest(h, "local:ollama", "light-split")
    expect<unknown>(out.rows.explore).toEqual(MAIN)
    expect(out.starters.find((starter) => starter.template === "light-split")).toMatchObject({
      available: false,
      problem: "local-group",
    })
    // A local group has no company of its own: any subscription may review, never a paid key.
    expect(out.rows["own-review"]?.fill).toBe("other-company")
    expect(pinned(out)).not.toContain(OPENAI_KEY)
  })

  test("a starter's draft is named apart from the group's presets", async () => {
    await using h = await harness()
    const first = await suggest(h, "codex", "light-split")
    expect(first.draft.name).toBe("가볍게 나눠 쓰기")
    await h.presets.set({ preset: first.draft }, rpcContext())
    expect((await suggest(h, "codex", "light-split")).draft.name).toBe("가볍게 나눠 쓰기 2")
    await h.presets.set({ preset: { ...first.draft, name: "가볍게 나눠 쓰기 2" } }, rpcContext())
    expect((await suggest(h, "codex", "light-split")).draft.name).toBe("가볍게 나눠 쓰기 3")
    // The fresh draft has no name to keep apart.
    expect((await suggest(h, "codex")).draft.name).toBe("")
  })
})

describe("Codex priority ahead of price (07 §3.4, §4.5)", () => {
  /** This PC's Codex cache with the newer bundle's order: gpt-6.1-sol first, Astra second. */
  const PRIORITIES = JSON.stringify({
    models: [
      { slug: "gpt-6.1-sol", priority: 1 },
      { slug: "gpt-6-astra", priority: 2 },
      { slug: "gpt-6-sol", priority: 3 },
    ],
  })

  test("another company's strongest ChatGPT model is Codex's priority 1, on the roomiest login", async () => {
    await using h = await harness({ codex: { "models_cache.json": PRIORITIES } })
    expect<unknown>((await suggest(h, "claude-sub")).rows["own-review"]).toEqual({
      targets: [{ pin: { account: CHATGPT_01, model: "gpt-6.1-sol" } }],
      fill: "other-company",
    })
    h.deps.runtime.limits.upsert([used(h, CHATGPT_01, CODEX_A, 80), used(h, CHATGPT_02, CODEX_B, 20)])
    expect<unknown>((await suggest(h, "claude-sub")).rows["own-review"]).toEqual({
      targets: [{ pin: { account: CHATGPT_02, model: "gpt-6.1-sol" } }],
      fill: "other-company",
    })
    // The ChatGPT group still compares other companies by price (Claude's strongest by price).
    expect<unknown>((await suggest(h, "codex")).rows["own-review"]?.targets).toEqual([
      { pin: { account: CLAUDE, model: "claude-fable-5-1" } },
    ])
  })

  test("byPriority: the account's prices in priority order; nothing changes without priorities", () => {
    const candidate = (id: string, price?: number): Preset.Candidate => ({
      id,
      released: 0,
      variants: [],
      ...(price === undefined ? {} : { price }),
    })
    const models = [candidate("astra", 10), candidate("sol", 2), candidate("next", 2), candidate("free")]
    expect(PresetSuggest.byPriority(models, undefined)).toBe(models)
    const ranked = PresetSuggest.byPriority(models, {
      source: "backend",
      fetchedAt: 0,
      models: [
        { slug: "next", priority: 1 },
        { slug: "astra", priority: 2 },
      ],
    })
    expect(ranked.map((model) => model.id)).toEqual(["next", "astra", "sol", "free"])
    // The top keeps the account's highest price exactly; the next ones rank a hair below the price they take.
    expect(ranked[0]?.price).toBe(10)
    expect(ranked[1]?.price).toBeLessThan(2)
    expect(ranked[1]?.price).toBeGreaterThan(1.99)
    expect(ranked[2]?.price).toBeLessThan(ranked[1]?.price ?? 0)
    expect(ranked[3]?.price).toBeUndefined()
  })
})

describe("presets.suggest pool (07 §3.4 모델 묶음, T4)", () => {
  const CODEX_CACHE = JSON.stringify({
    fetched_at: "2026-10-01T00:00:00Z",
    client_version: "0.157.0",
    // Codex's priority puts Astra first; the pool's prices never follow it.
    models: [
      { slug: "gpt-6-astra", priority: 1, description: "Made-up text for the strongest." },
      { slug: "gpt-6-luna", priority: 2 },
    ],
  })

  test("candidates: the group's models on the main account, other-company subscriptions, locals, paid accounts", async () => {
    await using h = await harness({
      listed: [OLLAMA],
      resolver: { localVerified: () => true },
      codex: { "models_cache.json": CODEX_CACHE },
    })
    const pool = (await suggest(h, "codex")).pool
    if (!pool) throw new Error("no pool offer")
    const rows = pool.candidates.map((item) => [item.key, item.account ?? "main", item.runs])
    // ChatGPT accounts no longer run gpt-5.5 (upstream v2.1).
    expect(rows.filter((row) => row[1] === "main").map((row) => row[0])).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-6.1-sol",
    ])
    // No other ChatGPT subscription and no Sign in with ChatGPT login: R4. Paid keys are offered, marked paid.
    const accounts = [...new Set(pool.candidates.flatMap((item) => (item.account ? [item.account] : [])))]
    expect(accounts).toEqual([CLAUDE, "local:ollama", OPENAI_KEY, DEEPSEEK_KEY])
    expect(accounts).not.toContain(CHATGPT_02)
    expect(pool.candidates.find((item) => item.account === OPENAI_KEY)).toMatchObject({ runs: "paid" })
    expect(pool.candidates.find((item) => item.account === "local:ollama")).toMatchObject({
      runs: "local",
      card: { windowVerified: true },
    })
    // Raw prices and frozen cards: Astra keeps its catalog price, the Codex description is on its card.
    const astra = pool.candidates.find((item) => item.key === "gpt-6-astra")
    expect(astra).toMatchObject({ price: 10, company: "openai", card: { summary: "Made-up text for the strongest." } })
    expect(pool.candidates.find((item) => item.key === "gpt-6-luna")?.price).toBe(0.1)
    // Another company's key for the same model id takes the paid tail.
    expect(pool.candidates.find((item) => item.account === OPENAI_KEY && item.model === "gpt-6-sol")?.key).toBe(
      "gpt-6-sol-api",
    )
    // 추천 묶음: the newest per family of the main account, Claude and the verified local model; never a paid key.
    const paid = new Set(pool.candidates.filter((item) => item.runs === "paid").map((item) => item.key))
    expect(pool.recommended.some((key) => paid.has(key))).toBe(false)
    expect(pool.recommended).toContain("gpt-6.1-sol")
    expect(pool.recommended).not.toContain("gpt-6-sol")
    expect(pool.recommended).toContain("claude-opus-5-5")
    expect(pool.recommended).toContain(pool.candidates.find((item) => item.account === "local:ollama")?.key ?? "none")
    expect(pool.recommended.length).toBeLessThanOrEqual(Preset.POOL_MAX)
  })

  test("a metered group: its own models cost money and are never recommended; an unverified local is not either", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const pool = (await suggest(h, "ds")).pool
    if (!pool) throw new Error("no pool offer")
    const own = pool.candidates.filter((item) => item.account === undefined)
    expect(own.map((item) => [item.key, item.runs])).toEqual([
      ["deepseek-v4-pro", "main-paid"],
      ["deepseek-flash", "main-paid"],
    ])
    expect(pool.recommended.some((key) => own.some((item) => item.key === key))).toBe(false)
    const local = pool.candidates.find((item) => item.account === "local:ollama")
    expect(local?.card?.windowVerified).toBe(false)
    expect(pool.recommended).not.toContain(local?.key)
    // Every subscription company once: ChatGPT accounts share their model keys.
    const sol = pool.candidates.filter((item) => item.model === "gpt-6-sol" && item.runs === "subscription")
    expect(new Set(sol.map((item) => item.key)).size).toBe(1)
  })
})

// The editor's 모델 묶음 choice (07 §8.1 ①, pool design P10): the third radio only when `presets.suggest` offers a pool,
// checking and unchecking from the candidates, one account per other company (switching moves the checks), the metered
// group's `메인 계정 · 종량제 · 돈이 들어요` rows, the paid rows behind their budget, `추천 묶음` (never a paid model) and
// the card facts in Korean. The checklist's logic is model.ts (pure) and the row text pool-list.tsx's exported helpers;
// the components are checked through their source where only wiring is left. Every account and model is fake.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import type { I18nParams } from "@/i18n"
import {
  draftMode,
  draftOf,
  poolAccountOf,
  poolSections,
  WORKER_MODES,
  withMode,
  withoutPoolEntry,
  withPoolAccount,
  withPoolEntry,
  withRecommended,
} from "./model"
import { cardFacts, runsBadge } from "./pool-list"
import { presetsText, type PresetsKey } from "./strings"

const read = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()
/** Source without comments, so spec examples in comments are not taken for code. */
const code = (source: string) => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")
const text = (key: PresetsKey, params?: I18nParams) => presetsText("ko", key, params)

const CLAUDE_01 = Account.ID.make("acc_claude01")
const CLAUDE_02 = Account.ID.make("acc_claude02")
const OPENAI_KEY = Account.ID.make("acc_openaikey")

const card = (name: string, extra: Partial<Preset.PoolCard> = {}): Preset.PoolCard => ({ name, at: 1, ...extra })
const model = (id: string, price: number | undefined, family = id, released = 0): Preset.PoolModel => ({
  id,
  family,
  released,
  ...(price === undefined ? {} : { price }),
  card: card(id.toUpperCase()),
})

/**
 * A metered DeepSeek group (D9): its own models cost money (`main-paid`); two Claude subscriptions of another company
 * (the roomiest first), a verified local model and an OpenAI API key.
 */
const METERED = Preset.poolOffer([
  { runs: "main-paid", company: "deepseek", models: [model("deepseek-v4-pro", 2), model("deepseek-v4-flash", 0.3)] },
  {
    runs: "subscription",
    account: CLAUDE_02,
    company: "anthropic",
    models: [model("claude-opus-5-5", 15, "opus", 2), model("claude-haiku-4-5", 1, "haiku", 1)],
  },
  { runs: "subscription", account: CLAUDE_01, company: "anthropic", models: [model("claude-opus-5-5", 15, "opus", 2)] },
  {
    runs: "local",
    account: "local:ollama",
    models: [{ ...model("qwen3", undefined), card: card("Qwen3", { window: 32_768, windowVerified: true }) }],
  },
  { runs: "paid", account: OPENAI_KEY, company: "openai", models: [model("gpt-6-luna", 0.1)] },
])
const pick = (key: string, account?: string) =>
  METERED.candidates.find((item) => item.key === key && item.account === account)!

describe("the ① radio (07 §8.1)", () => {
  test("모델 묶음에서 알아서 is the third choice, shown only when presets.suggest offers a pool or the draft is one", async () => {
    expect(WORKER_MODES.map((mode) => text(`own.preset.workers.${mode === "by-role" ? "byRole" : mode}`))).toEqual([
      "메인과 같은 모델로",
      "다른 모델 하나로",
      "모델 묶음에서 알아서",
      "일마다 정하기",
    ])
    const editor = code(await read("editor.tsx"))
    expect(editor).toMatch(
      /WORKER_MODES\.filter\(\(mode\) => mode !== "pool" \|\| suggestion\(\)\?\.pool !== undefined \|\| draftMode\(draft\(\)\) === "pool"\)/,
    )
    expect(editor).toContain("checked={draftMode(draft()) === mode}")
    // Leaving the pool and coming back restores the checked list (kept while the editor is open).
    expect(editor).toContain("onChange={() => update(withMode(draft(), mode, kept()))}")
    expect(editor).toMatch(/if \(pool\?\.length && !next\.workers\.pool\) setKept\(pool\)/)
    expect(editor).toContain('<Show when={mode === "pool" && draftMode(draft()) === "pool"}>')
    const kept = withPoolEntry(withMode({ ...draftOf("ds"), name: "x" }, "pool"), pick("deepseek-v4-flash"))
    const back = withMode(withMode(kept, "by-role"), "pool", kept.workers.pool)
    expect(back.workers.pool).toEqual(kept.workers.pool)
    expect(draftMode(back)).toBe("pool")
  })

  test("UC 2026-10-18: every radio has its one-line hint under it; 다른 모델 하나로's picker leaves out 메인과 같게", async () => {
    expect(WORKER_MODES.map((mode) => text(`own.preset.workers.${mode === "by-role" ? "byRole" : mode}Hint`))).toEqual([
      "지금 대화의 계정·모델·추론 강도를 그대로 씀",
      "모든 하위 에이전트를 고른 모델 하나로 · 예: 더 가벼운 모델, Claude 구독, 로컬 LLM",
      "쓸 모델만 고르면 LLM이 일마다 골라 씀",
      "역할(탐색·일반·리뷰…)마다 대상을 정하면 LLM이 일에 맞는 역할을 고름",
    ])
    const editor = code(await read("editor.tsx"))
    // The name is the label alone; the hint is its description, on its own line.
    expect(editor).toContain("aria-labelledby={`${uid}-${mode}`}")
    expect(editor).toContain("aria-describedby={`${uid}-${mode}-hint`}")
    expect(editor).toContain("{text(MODE_HINT[mode])}")
    expect(editor).toContain('text("own.preset.editor.singleNone")')
    const picker = code(await read("target-picker.tsx"))
    expect(picker).toMatch(/<Show\s+when=\{props\.place !== "single"\}[\s\S]*?testid="preset-target-main"/)
    expect(picker).toContain('text("own.preset.picker.singleNote")')
    expect(text("own.preset.picker.singleNote")).toBe(
      "지금 대화와 같은 모델로 돌리려면 ①에서 '메인과 같은 모델로'를 고르세요.",
    )
  })

  test("save sends the pool through presets.set (mode same with the pool); an empty pool waits", async () => {
    const editor = code(await read("editor.tsx"))
    expect(editor).toContain('.call("presets.set", { preset: toSave(draft()) })')
    expect(code(await read("pool-list.tsx"))).toContain('text("own.preset.pool.empty")')
  })
})

describe("the checklist (07 §8.1)", () => {
  test("check and uncheck rows; a full pool takes no more", async () => {
    const draft = withPoolEntry(withMode(draftOf("ds"), "pool"), pick("claude-opus-5-5", CLAUDE_02))
    expect(draft.workers.pool?.map((entry) => entry.account)).toEqual([CLAUDE_02])
    expect(withoutPoolEntry(draft, "claude-opus-5-5").workers.pool).toEqual([])
    const list = code(await read("pool-list.tsx"))
    expect(list).toContain("props.update(withPoolEntry(props.draft, candidate))")
    expect(list).toContain("props.update(withoutPoolEntry(props.draft, current.key))")
    expect(list).toContain("disabled={rowProps.locked || (entry() === undefined && full())}")
    expect(list).toContain("pool().length >= Preset.POOL_MAX")
  })

  test("one account per company: a select per company, the roomiest first; switching moves the checks", async () => {
    const company = poolSections(METERED.candidates).companies[0]!
    expect(company.company).toBe("anthropic")
    expect<unknown>(company.accounts.map((item) => item.account)).toEqual([CLAUDE_02, CLAUDE_01])
    const draft = [pick("claude-opus-5-5", CLAUDE_02), pick("claude-haiku-4-5", CLAUDE_02)].reduce(
      withPoolEntry,
      withMode(draftOf("ds"), "pool"),
    )
    const moved = withPoolAccount(draft, company.accounts, CLAUDE_01)
    expect<unknown>(moved.workers.pool?.map((entry) => [entry.key, entry.account])).toEqual([
      ["claude-opus-5-5", CLAUDE_01],
    ])
    expect(poolAccountOf(moved, company.accounts)).toBe(CLAUDE_01)
    const list = code(await read("pool-list.tsx"))
    expect(list).toContain('data-testid="preset-pool-account"')
    expect(list).toContain("props.update(withPoolAccount(props.draft, section, account))")
  })

  test("a metered group's main-account rows say they cost money; paid rows wait for a budget", async () => {
    expect(poolSections(METERED.candidates).main.map((item) => item.runs)).toEqual(["main-paid", "main-paid"])
    expect(runsBadge("main-paid")).toBe("own.preset.pool.mainPaid")
    expect(text(runsBadge("main-paid")!)).toBe("메인 계정 · 종량제 · 돈이 들어요")
    expect(runsBadge("main")).toBe("own.preset.badge.mainAccount")
    expect(runsBadge("subscription")).toBe("own.preset.badge.subscription")
    expect(runsBadge("local")).toBe("own.preset.badge.local")
    expect(runsBadge("paid", "metered")).toBe("own.preset.badge.metered")
    expect(runsBadge("paid", "prepaid")).toBe("own.preset.badge.prepaid")
    expect(runsBadge(undefined)).toBeUndefined()
    const list = code(await read("pool-list.tsx"))
    expect(list).toContain("<PaidAccount")
    expect(list).toMatch(/locked=\{\s*!account\(\)\.budget &&\s*own\.rpc\.allowed\("accounts\.update"\) &&/)
    expect(list).toContain('text("own.preset.pool.paidCard")')
    expect(list).toContain('text("own.preset.pool.sameCompanyHidden"')
  })

  test("추천 묶음: the recommended pool on the company's chosen account, never a paid or main-paid model", async () => {
    expect(METERED.recommended).toEqual(["claude-opus-5-5", "claude-haiku-4-5", "qwen3"])
    const filled = withRecommended(withMode(draftOf("ds"), "pool"), METERED, () => CLAUDE_01)
    expect<unknown>(filled.workers.pool?.map((entry) => [entry.key, entry.account])).toEqual([
      ["claude-opus-5-5", CLAUDE_01],
      ["qwen3", "local:ollama"],
    ])
    expect(filled.workers.pool?.some((entry) => entry.account === undefined || entry.account === OPENAI_KEY)).toBe(
      false,
    )
    const list = code(await read("pool-list.tsx"))
    expect(list).toContain("props.update(withRecommended(props.draft, props.offer, used))")
    expect([...list.matchAll(/data-testid="preset-pool-recommended"/g)]).toHaveLength(1)
  })

  test("a row's card facts in Korean: window, running window, price band, levels, images, Codex's words", () => {
    const astra = card("GPT-6 Astra", {
      window: 872_000,
      reasoning: true,
      image: true,
      summary: 'Fast "and"\naffordable',
    })
    expect(cardFacts(text, astra, false, "low")).toEqual([
      "창 872k",
      "가격 낮음",
      "추론 강도 단계",
      "이미지",
      "Fast 'and' affordable",
    ])
    expect(cardFacts(text, card("Qwen3", { window: 32_768, windowVerified: true }), true)).toEqual(["실행 창 33k"])
    expect(cardFacts(text, card("Qwen3", { window: 32_768, windowVerified: false }), true)).toEqual(["창 확인 안 됨"])
    expect(cardFacts(text, undefined, false)).toEqual([])
  })
})

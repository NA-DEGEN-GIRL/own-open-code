// Context meter model (03 §4.4, §5.8.3): fill from the original window, the auto-compaction tick(s), tones, the
// fallback without the router, the tokens beside the ring, and the texts; plus the session compaction input rules
// (5.8.5).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { Compaction } from "@own/protocol"
import { createI18n } from "@/i18n"
import { formatTokens } from "@/switcher/format"
import { createDrafts } from "./drafts"
import { meterModel, meterSpeech, meterTitle } from "./meter"
import { parseTokens, rangeProblem } from "./session-compaction"

const i18n = createI18n("ko")

function view(overrides: Partial<Compaction.View> = {}): Compaction.View {
  // SAFETY: test fixture shaped like `cache.state.compaction`; branded ids are plain strings at runtime.
  return {
    providerID: "own-codex-p1q2",
    modelID: "gpt-5.5",
    windowTokens: 272_000,
    triggerTokens: 244_800,
    slotTriggerTokens: 244_800,
    source: "v2",
    sessionTriggerTokens: null,
    floorTokens: 63_000,
    keepTokens: 15_000,
    auto: true,
    P: 118_000,
    remainingTokens: 126_800,
    cycle: { Z: 12_000, delta: 3_000, summary: 8_000 },
    pendingDue: null,
    ...overrides,
  } as Compaction.View
}

describe("meterModel", () => {
  test("fill is P over the original window; one strong tick at the effective point", () => {
    const model = meterModel(view())!
    expect(model.mode).toBe("router")
    expect(model.fill).toBeCloseTo(118_000 / 272_000)
    expect(model.marks).toEqual([{ at: 244_800 / 272_000, strong: true }])
    expect(model.tone).toBe("neutral")
  })

  test("caution color from 85 % of the point, `over` at or past it", () => {
    expect(meterModel(view({ P: 0.85 * 244_800 }))!.tone).toBe("warn")
    expect(meterModel(view({ P: 244_799 }))!.tone).toBe("warn")
    expect(meterModel(view({ P: 244_800 }))!.tone).toBe("over")
    expect(meterModel(view({ P: 300_000 }))!.fill).toBe(1)
  })

  test("a session value draws two ticks: the slot point faint, the earlier session point strong", () => {
    const model = meterModel(view({ sessionTriggerTokens: 200_000, triggerTokens: 200_000, source: "session" }))!
    expect(model.marks).toEqual([
      { at: 244_800 / 272_000, strong: false },
      { at: 200_000 / 272_000, strong: true },
    ])
    expect(model.sessionTrigger).toBe(200_000)
  })

  test("before the first step P is null: empty ring, neutral", () => {
    const model = meterModel(view({ P: null, remainingTokens: null }))!
    expect(model.fill).toBe(0)
    expect(model.tone).toBe("neutral")
  })

  test("without router data the registered limit draws the ring at core's ceiling of the limit", () => {
    const model = meterModel(undefined, { input: 200_000, context: 400_000 })!
    expect(model.mode).toBe("fallback")
    expect(model.window).toBe(200_000)
    expect(model.trigger).toBe(170_000)
    expect(model.marks).toEqual([{ at: 0.85, strong: true }])
    // Core keeps 15% free since upstream v2.1 (at least 16k from a 32k window).
    expect(meterModel(undefined, { context: 128_000 })!.trigger).toBe(108_800)
    // A compat slot's `limit.input` above its window (Compaction.ceilingOf): the real window, core's trigger at 90%.
    const compat = meterModel(undefined, { input: 45_491, context: 32_768 })!
    expect(compat.window).toBe(32_768)
    expect(compat.trigger).toBe(29_491)
    expect(meterModel(undefined, undefined)).toBeUndefined()
  })

  test("titles and speech follow 03 §4.4 and §5.8.3", () => {
    const model = meterModel(view())!
    expect(meterTitle(i18n, model)).toBe("문맥 118k / 272k · 자동 압축 245k (모델 한도) · 다음 압축까지 약 127k")
    expect(meterSpeech(i18n, model)).toBe("문맥 118k, 창 272k 중 43%. 자동 압축은 245k에서, 남은 양 127k.")
    const session = meterModel(view({ sessionTriggerTokens: 200_000, triggerTokens: 200_000, source: "session" }))!
    expect(meterTitle(i18n, session)).toContain("이 대화: 200k에서 압축")
    const fallback = meterModel(undefined, { context: 128_000 })!
    expect(meterTitle(i18n, fallback)).toContain("계정 정보를 받지 못해 모델에 적힌 한도로 보여 줘요")
  })
})

describe("the tokens beside the ring (03 §4.4, UX 2026-10-26)", () => {
  const code = (file: string) => Bun.file(path.join(import.meta.dir, "..", file)).text()

  test("the ring writes P as the 이 대화 card's `{used} / {window}` does, and nothing while P is unknown", async () => {
    expect(meterModel(view({ P: 6_000 }))!.used).toBe(6_000)
    expect(formatTokens(6_000)).toBe("6k")
    expect(meterModel(view({ P: null }))!.used).toBeNull()
    expect(meterModel(undefined, { context: 128_000 })!.used).toBeNull()
    const ring = await code("composer/context-meter.tsx")
    expect(ring).toContain("<Show when={meter().used !== null}>")
    expect(ring).toContain("formatTokens(meter().used ?? 0)")
    // The card's bar uses the same formatter for the same number.
    expect(await code("limits/meter.tsx")).toContain("formatTokens(used())")
  })

  test("no ring is dashed; the number is muted, in the caution color from `warn`, and folds below 720 px or for room", async () => {
    const css = await code("composer/composer.css")
    const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)))
    expect(css).not.toContain("stroke-dasharray")
    // A meter token, not the faint text colour (UX 2026-10-27), defined once for both schemes over the text colour.
    expect(rule('.own-cp-meter[data-mode="fallback"] .own-cp-ring-track')).toContain(
      "stroke: var(--own-meter-unknown);",
    )
    expect(await code("styles/tokens.css")).toContain(
      "--own-meter-unknown: color-mix(in srgb, var(--own-text) 28%, transparent);",
    )
    expect(rule(".own-cp-meter-num")).toContain("color: var(--own-text-muted);")
    expect(rule('.own-cp-meter[data-tone="over"] .own-cp-meter-num')).toContain("color: var(--own-warn);")
    expect(css).toContain('.own-cp-meter[data-tone="warn"] .own-cp-meter-num,')
    const narrow = css.slice(css.indexOf("@container own-cp (max-width: 719px)"))
    expect(narrow.slice(0, narrow.indexOf("}"))).toContain(".own-cp-meter-num")
    // ./limit-fit.ts step 2 on: the number gives its room to the limit.
    expect(css).toContain('.own-cp-bar:is([data-fold="2"], [data-fold="3"]) .own-cp-meter-num,')
  })

  test("no composer width hides the limit in `모델 @ 계정`: it folds by room to the ring, which always stays", async () => {
    const css = (await code("composer/composer.css")).replace(/\/\*[^]*?\*\//g, "")
    // UX 2026-10-27: a 720–799 px band hid it at 1024 px and at 1440 px with the work panel closed.
    const hides = css
      .split("}")
      .filter((rule) => /\.own-glance(?![-\w])/.test(rule.split("{").at(-2) ?? "") && /display:\s*none/.test(rule))
    expect(hides).toEqual([])
    // The ring alone at the last step: only a value that follows a ring is hidden (a balance keeps its amount).
    expect(css).toContain('.own-cp-bar[data-fold="3"] .own-cp-switch .own-glance-ring + .own-glance-value')
    const fit = await code("composer/limit-fit.ts")
    expect(fit).toContain("apply(twoRows(bar) ? 0 :")
    expect(await code("composer/binding-button.tsx")).toContain(
      'density={props.fold || limitDensity("lists") === "minimal" ? "minimal" : "simple"}',
    )
  })
})

describe("session compaction input (03 §5.8.5)", () => {
  test("accepts thousands separators, rejects anything else", () => {
    expect(parseTokens("200,000")).toBe(200_000)
    expect(parseTokens(" 200 000 ")).toBe(200_000)
    expect(parseTokens("200000")).toBe(200_000)
    expect(parseTokens("2e5")).toBeUndefined()
    expect(parseTokens("")).toBeUndefined()
    expect(parseTokens("이십만")).toBeUndefined()
  })

  test("range is [floorTokens, slotTriggerTokens)", () => {
    const range = { floorTokens: 63_000, slotTriggerTokens: 244_800 }
    expect(rangeProblem(63_000, range)).toBeUndefined()
    expect(rangeProblem(244_799, range)).toBeUndefined()
    expect(rangeProblem(244_800, range)).toBe("above")
    expect(rangeProblem(62_999, range)).toBe("below")
  })
})

describe("drafts", () => {
  test("per-session text, persisted after the debounce, never an empty entry", async () => {
    const saved: Record<string, string> = {}
    const storage = {
      getItem: (key: string) => saved[key] ?? null,
      setItem: (key: string, value: string) => void (saved[key] = value),
    }
    const drafts = createDrafts(storage)
    drafts.set("local/ses_a", "초안 A")
    drafts.set("local/home", "")
    expect(drafts.get("local/ses_a")).toBe("초안 A")
    expect(drafts.get("local/ses_b")).toBe("")
    drafts.flush()
    expect(JSON.parse(saved["own.web.composer.drafts"]!)).toEqual({ "local/ses_a": "초안 A" })
    drafts.delete("local/ses_a")
    drafts.flush()
    expect(JSON.parse(saved["own.web.composer.drafts"]!)).toEqual({})
    const restored = createDrafts({ getItem: () => JSON.stringify({ "local/x": "다시" }), setItem: () => {} })
    expect(restored.get("local/x")).toBe("다시")
  })
})

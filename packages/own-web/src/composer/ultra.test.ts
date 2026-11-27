// Ultra in the composer (07 §2.9, 2026-10-10): a mode beside the effort, not an effort level. The shared flow (a dry
// run, the cost dialog only off the effort-update path, the apply), the effort menu's ultra row and the
// switch running that same flow, the grey switch with its reason on the new-conversation screen, and the `ⓘ` card's
// link to 설정 > 프리셋 > 울트라 상한. Solid components do not render under `bun test`, so the components' wiring is
// checked in their source. Every account and model is made up.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createRoot } from "solid-js"
import type { ServerRuntime } from "@/data"
import type { OwnInput } from "@/data/rpc"
import { createI18n } from "@/i18n"
import { clearUltraCapsFocus, focusUltraCaps, ultraCapsFocus } from "@/settings/focus"
import type { FeatureText } from "@/queue/text"
import { subagentText, type SubagentKey } from "@/subagent/strings"
import { closeUltraAsk, confirmUltra, requestUltra, setUltraRaise, ULTRA_RAISE_KEY, ultraFlow } from "./ultra-flow"

const i18n = createI18n("ko")
const text: FeatureText<SubagentKey> = (key, params) => subagentText.text("ko", key, params)

/** A runtime whose `session.ultra.set` answers from `answer`; every call is recorded. */
function runtimeWith(answer: (input: OwnInput<"session.ultra.set">) => unknown) {
  const calls: Array<OwnInput<"session.ultra.set">> = []
  const runtime = {
    rpc: {
      call: async (method: string, input: OwnInput<"session.ultra.set">) => {
        if (method !== "session.ultra.set") throw new Error(`unexpected ${method}`)
        calls.push(input)
        return answer(input)
      },
    },
  }
  // SAFETY: the ultra flow reaches only `rpc.call("session.ultra.set")`.
  return { calls, runtime: runtime as unknown as ServerRuntime }
}

const estimate = {
  estimateID: "est_1",
  variantOnly: { preservesCache: false },
}

describe("the ultra flow (07 §2.9)", () => {
  test("a dry run first; off the effort-update path the cost dialog waits, and confirming applies it", async () => {
    closeUltraAsk()
    const { calls, runtime } = runtimeWith((input) => ({
      variant: { from: null, to: "xhigh" },
      estimate: input.dryRun ? estimate : null,
    }))
    await requestUltra({ runtime, i18n, text }, { sessionID: "ses_u", on: true, retuning: false })
    expect(calls).toEqual([{ sessionID: "ses_u", on: true, dryRun: true }])
    expect(ultraFlow.ask).toMatchObject({
      sessionID: "ses_u",
      input: { sessionID: "ses_u", on: true },
      retuning: false,
    })
    await confirmUltra({ runtime, i18n, text }, ultraFlow.ask!)
    expect(calls.at(-1)).toEqual({ sessionID: "ses_u", on: true })
    expect(ultraFlow.ask).toBeUndefined()
    expect(ultraFlow.busy.ses_u).toBeUndefined()
  })

  test("on the effort-update path (or without an effort change) it applies at once; Claude passes its raise", async () => {
    closeUltraAsk()
    const { calls, runtime } = runtimeWith(() => ({ variant: { from: "high", to: "high" }, estimate: null }))
    await requestUltra({ runtime, i18n, text }, { sessionID: "ses_c", on: true, raiseClaude: true, retuning: false })
    expect(calls).toEqual([
      { sessionID: "ses_c", on: true, raiseClaude: true, dryRun: true },
      { sessionID: "ses_c", on: true, raiseClaude: true },
    ])
    expect(ultraFlow.ask).toBeUndefined()
  })

  test("a refusal asks nothing and leaves the session free again", async () => {
    closeUltraAsk()
    const { calls, runtime } = runtimeWith(() => {
      throw new Error("nope")
    })
    await requestUltra({ runtime, i18n, text }, { sessionID: "ses_f", on: false, retuning: false })
    expect(calls).toHaveLength(1)
    expect(ultraFlow.ask).toBeUndefined()
    expect(ultraFlow.busy.ses_f).toBeUndefined()
  })

  test("the ⓘ card's link asks 설정 > 프리셋 to scroll to 울트라 상한 once", () => {
    createRoot((dispose) => {
      expect(ultraCapsFocus()).toBe(false)
      focusUltraCaps()
      expect(ultraCapsFocus()).toBe(true)
      clearUltraCapsFocus()
      expect(ultraCapsFocus()).toBe(false)
      dispose()
    })
  })
})

describe("the composer's ultra wiring (checked in source)", () => {
  const strip = (source: string) => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")
  const read = async (file: string) => strip(await Bun.file(path.join(import.meta.dir, file)).text())

  test("the effort menu ends with an ultra row, apart from the levels, running the same flow as the switch", async () => {
    const source = await read("binding-button.tsx")
    const variant = source.slice(
      source.indexOf("export function VariantButton"),
      source.indexOf("function useUltraState"),
    )
    const levels = variant.lastIndexOf('role="menuitemradio"')
    const row = variant.lastIndexOf('role="menuitemcheckbox"')
    expect(levels).toBeGreaterThan(0)
    expect(row).toBeGreaterThan(levels)
    expect(variant.slice(levels, row)).toContain('class="own-cp-menu-sep"')
    expect(variant).toContain('data-testid="composer-variant-ultra"')
    expect(variant).toContain(
      'text(ultra.claude() ? "own.subagent.ultra.menuNoteClaude" : "own.subagent.ultra.menuNote")',
    )
    // UC 2026-10-18: every main once own.accounts answers, greyed with the switch's reason as its note.
    expect(variant).toContain("<Show when={ultra.ready()}>")
    expect(variant).toContain("{ultra.reason() ??")
    expect(variant).toContain("void requestUltra(")
    const ultra = source.slice(
      source.indexOf("export function UltraSwitch"),
      source.indexOf("export function RunningBadge"),
    )
    expect(ultra).toContain("void requestUltra(env(), {")
    // Never an effort level: the levels come from the model, and `ultra` is not added to them.
    expect(variant).toContain("modelInfo(props.runtime, ref)?.variants.map((variant) => variant.id)")
  })

  test("Claude: the menu's ultra row honours `켤 때 강도도 xhigh로` ticked beside the switch while ultra is off", async () => {
    const source = await read("binding-button.tsx")
    const variant = source.slice(
      source.indexOf("export function VariantButton"),
      source.indexOf("function useUltraState"),
    )
    const ultra = source.slice(
      source.indexOf("export function UltraSwitch"),
      source.indexOf("export function RunningBadge"),
    )
    // Both controls read the one tick kept per session in the flow store, not a signal of the switch's own.
    expect(variant).toContain("raiseClaude: ultra.raised()")
    expect(ultra).toContain("setUltraRaise(sessionID, value)")
    expect(ultra).not.toMatch(/const \[raise, setRaise\]/)
    createRoot((dispose) => {
      setUltraRaise("ses_tick", true)
      expect(ultraFlow.raise.ses_tick).toBe(true)
      setUltraRaise("ses_tick", false)
      expect(ultraFlow.raise.ses_tick).toBe(false)
      dispose()
    })
  })

  test("the switch shows on the new-conversation screen, grey with the reason; ⓘ links to the caps", async () => {
    const source = await read("binding-button.tsx")
    const state = source.slice(source.indexOf("function useUltraState"), source.indexOf("export function UltraSwitch"))
    // On screen whenever own.accounts answers and the main is known, a session or not.
    const ready = state.slice(state.indexOf("const ready = () =>"), state.indexOf("const state = () =>"))
    expect(ready).toContain("!!props.view?.ref")
    expect(ready).not.toContain("sessionID")
    expect(state).toContain('text("own.subagent.ultra.newSession")')
    expect(state).toContain('"own.subagent.ultra.unavailable"')
    const ultra = source.slice(
      source.indexOf("export function UltraSwitch"),
      source.indexOf("export function RunningBadge"),
    )
    expect(ultra).toContain("disabled={props.disabled || ultra.busy() || !!ultra.reason()}")
    expect(ultra).toContain('data-testid="composer-ultra-info"')
    expect(ultra).toContain("focusUltraCaps()")
    expect(ultra).toContain('router.navigate({ name: "settings", section: "presets" })')
    const settings = strip(await Bun.file(path.join(import.meta.dir, "../settings/presets.tsx")).text())
    expect(settings).toContain("ultraCapsFocus()")
    expect(settings).toContain('[data-testid="presets-ultra"]')
  })

  test("UC 2026-10-18: Claude's box sits with the switch, says what it raises and when, and is in the effort menu too", async () => {
    const source = await read("binding-button.tsx")
    const variant = source.slice(
      source.indexOf("export function VariantButton"),
      source.indexOf("function useUltraState"),
    )
    const ultra = source.slice(
      source.indexOf("export function UltraSwitch"),
      source.indexOf("export function RunningBadge"),
    )
    // Grouped with the switch, described, with the dry run's change; off where the effort is already xhigh or above.
    const group = ultra.slice(
      ultra.indexOf('class="own-cp-ultra-group"'),
      ultra.indexOf('data-testid="composer-ultra-info"'),
    )
    expect(group).toContain('data-testid="composer-ultra"')
    expect(group).toContain('data-testid="composer-ultra-raise"')
    expect(group).toContain("aria-describedby={raiseHint}")
    expect(group).toContain("title={ultra.raiseNote()}")
    expect(group).toContain("!ultra.canRaise()")
    expect(group).toContain('data-testid="composer-ultra-raise-preview"')
    // The switch's title and the card are Claude's own.
    expect(ultra).toContain('text(ultra.claude() ? "own.subagent.ultra.titleClaude" : "own.subagent.ultra.title")')
    expect(ultra).toContain('text("own.subagent.ultra.infoClaude")')
    // The tick follows the session: set in both branches, taken back when ultra goes off.
    expect(ultra).toContain("setUltraRaise(sessionID, was.raiseClaude ?? false)")
    // A narrow composer folds the switch away; the effort menu has the box too.
    expect(variant).toContain('data-testid="composer-variant-ultra-raise"')
    expect(variant).toContain("aria-checked={ultra.raised()}")
    expect(variant).toContain("setUltraRaise(sessionID, next)")
    const state = source.slice(source.indexOf("function useUltraState"), source.indexOf("export function UltraSwitch"))
    expect(state).toContain("Preset.raisesClaude(baseline())")
    expect(state).toContain('"own.subagent.ultra.claudeMissing"')
    expect(text("own.subagent.ultra.raiseHint")).toBe(
      "Claude는 울트라를 켜도 추론 강도를 그대로 둬요. 체크하면 켤 때 메인 강도를 xhigh로 올리고, 끄면 원래 강도로 돌아가요.",
    )
    expect(text("own.subagent.ultra.raiseNow")).toBe("울트라가 켜져 있어서 바꾸면 바로 적용돼요.")
    expect(text("own.subagent.ultra.raisePreview", { from: "high", to: "xhigh" })).toBe("(high → xhigh)")
    expect(text("own.subagent.ultra.infoClaude")).toBe("Claude는 강도를 바꿔도 울트라가 켜진 채예요.")
    expect(text("own.subagent.ultra.claudeMissing")).toBe(
      "Claude 플러그인이 이 위치에서 로드되지 않았어요 (설정 > 계정에서 확인)",
    )
    expect(text("own.subagent.ultra.menuNoteClaude")).not.toContain("강도를 올리고")
    expect(text("own.subagent.ultra.titleClaude")).not.toContain("추론 강도를 올리고")
  })

  test("UC 2026-10-18: the tick is kept per conversation in this browser, the newest last", () => {
    createRoot((dispose) => {
      setUltraRaise("ses_keep_a", true)
      setUltraRaise("ses_keep_b", true)
      setUltraRaise("ses_keep_a", true)
      expect(JSON.parse(localStorage.getItem(ULTRA_RAISE_KEY) ?? "[]").slice(-2)).toEqual(["ses_keep_a", "ses_keep_b"])
      setUltraRaise("ses_keep_a", false)
      expect(JSON.parse(localStorage.getItem(ULTRA_RAISE_KEY) ?? "[]")).not.toContain("ses_keep_a")
      expect(ultraFlow.raise.ses_keep_b).toBe(true)
      setUltraRaise("ses_keep_b", false)
      dispose()
    })
  })

  test("strings: the card says ultra is a mode, names the caps and where to change them", () => {
    expect(text("own.subagent.ultra.menuNote")).toContain("강도 단계가 아닌 모드")
    expect(text("own.subagent.ultra.infoCaps", { level: "추천", numbers: "동시 5" })).toBe("울트라 상한: 추천 · 동시 5")
    expect(text("own.subagent.ultra.capsLink")).toBe("상한 바꾸기 (설정 > 프리셋 > 울트라 상한)")
    expect(subagentText.text("en", "own.subagent.ultra.capsLink")).toBe(
      "Change the caps (Settings > Presets > Ultra caps)",
    )
  })
})

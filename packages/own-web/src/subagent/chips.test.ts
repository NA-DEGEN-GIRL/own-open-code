// Neutral refusal chips (07 §5.4 거절 경로, §7.3 거절 안내, §2.6; PG1 UI part, PG11 consent): a refusal is recognised by
// the failure text only (`Unknown agent: own-preset: …`) and read back with `Preset.parse`, never from the LLM's tool
// input; each gate rejection becomes its chip kind; `[하위 에이전트에 추가…]` fills the asked-for model on its own account
// and never offers another subscription of the main's company; a model pool's chip (`이 모델 묶음에 없어요`) offers
// `[묶음에 추가…]` with the main account's model for one the main slot offers, a pin for another company, a paid account or
// a local provider, and nothing for another subscription of the main's company (07 §8.3 모델 묶음); consent and budget
// chips name the paid account and the subscription the role waits on; the chip lines in both languages. Every account
// and model is fake.
import { describe, expect, test } from "bun:test"
import type { JsonValue, SessionMessageAssistantTool } from "@opencode/client/promise"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { Schema } from "effect"
import { chipOf, type ChipContext } from "@/presets/chips"
import { presetsText } from "@/presets/strings"
import { gateText, presetRejection, type PresetRejection } from "./model"
import { subagentText } from "./strings"

const CHATGPT_01 = Account.ID.make("acc_chatgpt01")
const CHATGPT_02 = Account.ID.make("acc_chatgpt02")
const SIWC_01 = Account.ID.make("acc_siwc01")
const CLAUDE = Account.ID.claudeSlot
const DEEPSEEK = Account.ID.make("acc_deepseek")

function account(id: Account.ID, kind: Account.View["kind"], providerID: string): Account.View {
  return {
    id,
    kind,
    label: id.slice(4),
    shortLabel: id.slice(4, 6),
    color: "indigo",
    providerID: Provider.ID.make(providerID),
    billing: kind === "ds" ? "prepaid" : "subscription",
    status: "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: kind === "ds" ? "key" : "oauth" },
  }
}

const ACCOUNTS = [
  account(CHATGPT_01, "codex", "own-codex-aaaa"),
  account(CHATGPT_02, "codex", "own-codex-bbbb"),
  account(SIWC_01, "siwc", "own-siwc-cccc"),
  account(CLAUDE, "claude-sub", "anthropic"),
  account(DEEPSEEK, "ds", "own-ds-eeee"),
]
const BY_ID = Object.fromEntries(ACCOUNTS.map((item) => [item.id, item]))
const pin = (account: string, model: string) => Schema.decodeUnknownSync(Preset.Target)({ pin: { account, model } })

const REVIEW_TO_PAID: Pick<Preset.Info, "workers"> = {
  workers: {
    mode: "by-role",
    roles: {
      "own-review": { targets: [pin(CLAUDE, "claude-opus-5-5"), pin(DEEPSEEK, "deepseek-flash")], effort: "inherit" },
    },
  },
}

const MAIN_REF = { providerID: Provider.ID.make("own-codex-aaaa"), id: Model.ID.make("gpt-6-astra") }

const CONTEXT: ChipContext = {
  group: "codex",
  preset: REVIEW_TO_PAID,
  resolution: {
    main: MAIN_REF,
    roles: {
      "own-review": {
        targets: [
          { target: pin(CLAUDE, "claude-opus-5-5"), skip: "unavailable" },
          {
            target: pin(DEEPSEEK, "deepseek-flash"),
            ref: { providerID: Provider.ID.make("own-ds-eeee"), id: Model.ID.make("deepseek-flash") },
          },
        ],
        use: MAIN_REF,
        fallback: true,
      },
    },
  },
  accountOf: (providerID) => ACCOUNTS.find((item) => item.providerID === providerID),
  lookup: (id) => BY_ID[id],
}

/** A refused `subagent` call as the transcript stores it: the LLM's input and core's failure text. */
function refused(rejection: Preset.Rejection, input: Record<string, JsonValue> = { agent: "own-review" }) {
  const content = {
    type: "tool",
    id: "call_1",
    name: "subagent",
    state: {
      status: "error",
      input: { description: "리뷰", prompt: "변경을 검토", ...input },
      error: { type: "ToolFailure", message: `Unknown agent: ${Preset.rejection(rejection)}` },
    },
    time: { created: 1 },
  } satisfies SessionMessageAssistantTool
  return presetRejection(content)!
}

describe("recognised by the failure text and parsed back (07 §5.4 화면)", () => {
  const kinds: Preset.Rejection[] = [
    { reason: "model", roles: [] },
    { reason: "model", roles: ["explore", "own-review"] },
    { reason: "budget", roles: ["explore"] },
    { reason: "consent", roles: ["general"] },
    { reason: "off" },
    { reason: "caps", cap: "concurrent", max: 3 },
    { reason: "caps", cap: "perMessage", max: 6 },
    { reason: "caps", cap: "perSession", max: 100 },
    { reason: "effort" },
    { reason: "effort-cap", max: "high", once: true },
    { reason: "effort-cap", max: "default", once: false },
  ]

  test("the gate's own text comes back from the stored failure for every kind", () => {
    for (const kind of kinds) expect(gateText(refused(kind))).toBe(Preset.rejection(kind))
  })

  test("each kind is its chip; any other gate text keeps the plain chip", () => {
    expect(chipOf(refused(kinds[5]!), CONTEXT)).toEqual({ kind: "caps", cap: "concurrent", max: 3 })
    expect(chipOf(refused(kinds[6]!), CONTEXT)).toEqual({ kind: "caps", cap: "perMessage", max: 6 })
    expect(chipOf(refused(kinds[7]!), CONTEXT)).toEqual({ kind: "caps", cap: "perSession", max: 100 })
    expect(chipOf(refused(kinds[4]!), CONTEXT)).toEqual({ kind: "off" })
    const unknown: PresetRejection = { reason: "something new. Ask the user." }
    expect(chipOf(unknown, CONTEXT)).toEqual({ kind: "unknown" })
  })

  test("the LLM's input never makes a refusal: the same input with a plain failure is no chip", () => {
    const content = {
      type: "tool",
      id: "call_2",
      name: "subagent",
      state: {
        status: "error",
        input: { agent: "own-preset: model not in this preset.", model: "own-ds-eeee/deepseek-flash" },
        error: { type: "ToolFailure", message: "Subagent failed" },
      },
      time: { created: 1 },
    } satisfies SessionMessageAssistantTool
    expect(presetRejection(content)).toBeUndefined()
  })
})

describe("not in the preset: `[하위 에이전트에 추가…] [그대로]` (07 §7.3)", () => {
  const model = (requested: string, agent = "own-review") =>
    chipOf(refused({ reason: "model", roles: ["explore"] }, { agent, model: requested }), CONTEXT)

  test("the asked-for model on its own account, for the role the LLM asked for", () => {
    expect(model("own-ds-eeee/deepseek-flash#high")).toEqual({
      kind: "model",
      add: { role: "own-review", target: pin(DEEPSEEK, "deepseek-flash") },
    })
    // Another company's subscription may be pinned (one per company, R4).
    expect(model("anthropic/claude-opus-5-5", "explore")).toEqual({
      kind: "model",
      add: { role: "explore", target: pin(CLAUDE, "claude-opus-5-5") },
    })
    // A local provider is pinned as `local:<id>`.
    expect(model("ollama/qwen3", "general")).toEqual({
      kind: "model",
      add: { role: "general", target: pin("local:ollama", "qwen3") },
    })
  })

  test("never for another subscription of the main's company, the same login's Sign in with ChatGPT included", () => {
    expect(model("own-codex-bbbb/gpt-6-sol")).toEqual({ kind: "model" })
    expect(model("own-siwc-cccc/gpt-6-sol")).toEqual({ kind: "model" })
  })

  test("none for a model this window cannot place, or while the main's group is not known", () => {
    expect(model("openai/gpt-6-sol")).toEqual({ kind: "model" })
    expect(model("review")).toEqual({ kind: "model" })
    expect(
      chipOf(refused({ reason: "model", roles: [] }, { agent: "explore", model: "own-ds-eeee/deepseek-flash" }), {
        ...CONTEXT,
        group: undefined,
      }),
    ).toEqual({ kind: "model" })
  })

  test("an agent that is none of the roles asks as `general`", () => {
    expect(
      chipOf(refused({ reason: "model", roles: [] }, { agent: "build", model: "own-ds-eeee/deepseek-flash" }), CONTEXT),
    ).toEqual({ kind: "model", add: { role: "general", target: pin(DEEPSEEK, "deepseek-flash") } })
  })
})

describe("not in the model pool: `[묶음에 추가…] [그대로]` (07 §8.3 모델 묶음)", () => {
  const POOL: Preset.Rejection = { reason: "model", models: ["gpt-6-luna", "claude-opus-5-5"] }
  const POOL_CONTEXT: ChipContext = {
    ...CONTEXT,
    preset: { workers: { mode: "same", roles: {}, pool: [{ key: "gpt-6-luna", model: Model.ID.make("gpt-6-luna") }] } },
    resolution: null,
    main: { providerID: "own-codex-aaaa", models: ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"] },
  }
  const chip = (requested: string, context = POOL_CONTEXT) =>
    chipOf(refused(POOL, { agent: "general", model: requested }), context)

  test("the gate's pool text comes back as a pool chip", () => {
    expect(gateText(refused(POOL))).toBe(
      "own-preset: model not in this preset. Allowed models: gpt-6-luna, claude-opus-5-5. Ask the user if another model is needed.",
    )
    expect(chip("nonsense")).toEqual({ kind: "model", pool: true })
  })

  test("a model of the main slot is the main account's entry: its own provider, the canonical id, a bare id", () => {
    const main = { kind: "model", pool: true, add: { pool: { model: "gpt-6-sol" } } }
    expect<unknown>(chip("own-codex-aaaa/gpt-6-sol")).toEqual(main)
    expect<unknown>(chip("openai/gpt-6-sol#high")).toEqual(main)
    expect<unknown>(chip("gpt-6-sol")).toEqual(main)
    expect<unknown>(chip("gpt-6-sol#xhigh")).toEqual(main)
    // A canonical or bare id the main slot does not offer cannot be placed.
    expect(chip("openai/gpt-9")).toEqual({ kind: "model", pool: true })
    expect(chip("gpt-9")).toEqual({ kind: "model", pool: true })
    // Without the main slot's models only its own provider counts.
    const unknown = { ...POOL_CONTEXT, main: { providerID: "own-codex-aaaa", models: [] } }
    expect(chip("gpt-6-sol", unknown)).toEqual({ kind: "model", pool: true })
    expect<unknown>(chip("own-codex-aaaa/gpt-6-sol", unknown)).toEqual(main)
  })

  test("another company, a paid account or a local provider is pinned", () => {
    expect<unknown>(chip("anthropic/claude-haiku-4-5")).toEqual({
      kind: "model",
      pool: true,
      add: { pool: { model: "claude-haiku-4-5", account: CLAUDE } },
    })
    expect<unknown>(chip("own-ds-eeee/deepseek-flash")).toEqual({
      kind: "model",
      pool: true,
      add: { pool: { model: "deepseek-flash", account: DEEPSEEK } },
    })
    expect<unknown>(chip("ollama/qwen3")).toEqual({
      kind: "model",
      pool: true,
      add: { pool: { model: "qwen3", account: "local:ollama" } },
    })
  })

  test("nothing for another subscription of the main's company (R4), the same login's siwc included", () => {
    expect(chip("own-codex-bbbb/gpt-6-sol")).toEqual({ kind: "model", pool: true })
    expect(chip("own-siwc-cccc/gpt-6-sol")).toEqual({ kind: "model", pool: true })
    expect(chip("own-ds-eeee/deepseek-flash", { ...POOL_CONTEXT, group: undefined })).toEqual({
      kind: "model",
      pool: true,
    })
  })

  test("the chip line and the button in both languages", () => {
    expect(subagentText.text("ko", "own.subagent.chip.notInPool", { model: "GPT-6 Astra" })).toBe(
      "하위 에이전트 요청을 막았어요: GPT-6 Astra는 이 모델 묶음에 없어요",
    )
    expect(presetsText("ko", "own.preset.pool.addFromChip")).toBe("묶음에 추가…")
    expect(subagentText.text("en", "own.subagent.chip.notInPool", { model: "GPT-6 Astra" })).toBe(
      "Subagent request blocked: GPT-6 Astra isn't in this model pool",
    )
  })
})

describe("paid targets: consent `[이 대화에서만] [아니오]` and budget (07 §5.4 step 4, PG11)", () => {
  test("consent names the paid account and the subscription the role waits on", () => {
    expect(chipOf(refused({ reason: "consent", roles: ["explore"] }), CONTEXT)).toEqual({
      kind: "consent",
      role: "own-review",
      account: DEEPSEEK,
      blocked: CLAUDE,
    })
  })

  test("without the preset view the chip still asks, naming no account (no answer is sent without one)", () => {
    expect(
      chipOf(refused({ reason: "consent", roles: [] }), { ...CONTEXT, preset: undefined, resolution: undefined }),
    ).toEqual({ kind: "consent", role: "own-review" })
  })

  test("a used-up budget names the role's paid account", () => {
    expect(chipOf(refused({ reason: "budget", roles: [] }), CONTEXT)).toEqual({ kind: "budget", account: DEEPSEEK })
    expect(chipOf(refused({ reason: "budget", roles: [] }, { agent: "explore" }), CONTEXT)).toEqual({ kind: "budget" })
  })

  test("`다른 모델 하나로` sends every role to its one target", () => {
    const single: Pick<Preset.Info, "workers"> = {
      workers: { mode: "single", single: pin(DEEPSEEK, "deepseek-flash"), roles: {} },
    }
    expect(
      chipOf(refused({ reason: "budget", roles: [] }, { agent: "explore" }), { ...CONTEXT, preset: single }),
    ).toEqual({ kind: "budget", account: DEEPSEEK })
  })
})

describe("chip lines (07 §7.3, §2.6)", () => {
  test("Korean, with particles after the names", () => {
    expect(presetsText("ko", "own.preset.waiting", { n: 3 })).toBe("하위 에이전트 대기: 3개 실행 중")
    expect(subagentText.text("ko", "own.subagent.chip.perMessage", { n: 6 })).toBe(
      "하위 에이전트 대기: 메시지 하나당 최대 6개",
    )
    expect(presetsText("ko", "own.preset.caps.raiseOnce")).toBe("이번 메시지만 늘리기")
    expect(subagentText.text("ko", "own.subagent.chip.notInPreset", { model: "DeepSeek" })).toBe(
      "하위 에이전트 요청을 막았어요: DeepSeek는 이 프리셋에 없어요",
    )
    expect(subagentText.text("ko", "own.subagent.chip.add")).toBe("하위 에이전트에 추가…")
    expect(subagentText.text("ko", "own.subagent.chip.keep")).toBe("그대로")
    expect(
      subagentText.text("ko", "own.subagent.chip.consentWaiting", {
        blocked: "Claude 구독",
        role: "리뷰",
        account: "DeepSeek",
      }),
    ).toBe("Claude 구독 한도 대기 · 리뷰를 DeepSeek(종량제)로 돌릴까요?")
    expect(subagentText.text("ko", "own.subagent.chip.allowHere")).toBe("이 대화에서만")
    expect(subagentText.text("ko", "own.subagent.chip.no")).toBe("아니오")
    expect(
      subagentText.text("ko", "own.subagent.role", { role: "리뷰", account: "Claude 구독", model: "Opus 5.5" }),
    ).toBe("리뷰 · Claude 구독 · Opus 5.5")
  })

  test("English", () => {
    expect(subagentText.text("en", "own.subagent.chip.notInPreset", { model: "DeepSeek" })).toBe(
      "Subagent request blocked: DeepSeek isn't in this preset",
    )
    expect(subagentText.text("en", "own.subagent.chip.consent", { role: "Review", account: "DeepSeek" })).toBe(
      "Run Review on DeepSeek (pay per use)?",
    )
    expect(presetsText("en", "own.preset.waiting", { n: 3 })).toBe("Subagents waiting: 3 running")
  })
})

describe("per-call effort (07 §2.3 대화에서 정하는 강도)", () => {
  test("an unknown effort and the ceiling are their own chips; `once` decides `이번 메시지만 허용`", () => {
    expect(chipOf(refused({ reason: "effort" }, { agent: "general", model: "#ultra" }), CONTEXT)).toEqual({
      kind: "effort",
    })
    expect(chipOf(refused({ reason: "effort-cap", max: "high", once: true }), CONTEXT)).toEqual({
      kind: "effortCap",
      max: "high",
      once: true,
    })
    expect(chipOf(refused({ reason: "effort-cap", max: "high", once: false }), CONTEXT)).toEqual({
      kind: "effortCap",
      max: "high",
      once: false,
    })
  })

  test("chip lines name the asked and the allowed level; a paid model stays at the preset's", () => {
    expect(subagentText.text("ko", "own.subagent.chip.effortCap", { effort: "max", max: "high" })).toBe(
      "하위 에이전트 강도 제한: max 요청 · high까지",
    )
    expect(subagentText.text("ko", "own.subagent.chip.effortCapPaid", { max: "high" })).toBe(
      "하위 에이전트 강도 제한: 종량제 모델은 프리셋 강도(high)까지",
    )
    expect(subagentText.text("ko", "own.subagent.chip.effortAllow")).toBe("이번 메시지만 허용")
    expect(subagentText.text("ko", "own.subagent.chip.effort", { effort: "ultra" })).toBe(
      "하위 에이전트 요청을 막았어요: 추론 강도 'ultra'를 알 수 없어요",
    )
    expect(subagentText.text("en", "own.subagent.chip.effortCap", { effort: "max", max: "high" })).toBe(
      "Subagent effort limit: max asked · up to high",
    )
  })

  test("`이번 메시지만 허용` calls raiseOnce with `effort` while the turn runs", async () => {
    const source = await Bun.file(new URL("./rejected.tsx", import.meta.url)).text()
    expect(source).toContain('own.rpc.call("session.preset.raiseOnce", { sessionID, effort: true })')
    expect(source).toMatch(
      /value\.kind === "effortCap" &&\s+value\.once &&\s+done\(\) === undefined &&\s+transcript\.status\(\)\.type === "busy"/,
    )
  })
})

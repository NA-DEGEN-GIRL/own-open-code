// The user's output limit (02 §4.9, OL 2026-10-19): `policy.outputLimit` on main requests, every provider. `cap` sends
// the model's limit fitted to the room (core's `outputCeiling`, P-032) at most the user's number; `omit` sends none,
// except Claude's adapter default (the Messages API requires one) and DeepSeek's thinking-off fill, both fitted the same
// way. The default setting changes nothing; compaction and `generate` never follow it; codex, oai and or slots never
// get a limit; prompt bytes never change. Every credential is fake; nothing reaches a network.

import { describe, expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { OutputLimit, Policy } from "@own/protocol"
import { OutputLimitShape } from "../../src/auth/output-limit.js"
import { PolicyRules } from "../../src/switching/policy.js"
import { registryWith } from "../slots/support.js"
import { failure, machine } from "../switching/harness.js"
import { authSetup, context, message, registeredHooks } from "./support.js"

const SESSION = "ses_output_limit_setting"

function ref(providerID: string, id: string, variant?: string) {
  return Model.Ref.make({
    providerID: Provider.ID.make(providerID),
    id: Model.ID.make(id),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  })
}

const ANTH = ref("own-anth-nnnn", "claude-opus-5-5")
const CLAUDE_SUB = ref("anthropic", "claude-opus-5-5")
const DS = ref("own-ds-dddd", "deepseek-v4-pro", "high")
const DS_OFF = ref("own-ds-dddd", "deepseek-v4-pro", "none")
const CODEX = ref("own-codex-cccc", "gpt-5.5")
const OAI = ref("own-oai-aaaa", "gpt-5.5")
const OR = ref("own-or-rrrr", "anthropic/claude-opus-5-5")
const OTHERS = [ref("deepseek", "deepseek-v4-pro"), ref("google", "gemini-3-pro"), ref("own-xai-xxxx", "grok-5")]

async function setup() {
  const registry = await registryWith([
    { kind: "anth", label: "N", slug: "nnnn" },
    { kind: "ds", label: "D", slug: "dddd" },
    { kind: "codex", label: "C", slug: "cccc" },
    { kind: "oai", label: "A", slug: "aaaa" },
    { kind: "or", label: "R", slug: "rrrr" },
    { kind: "xai", label: "X", slug: "xxxx" },
  ])
  const s = await authSetup({ registry })
  const hooks = await registeredHooks(s)
  const setting = async (value: OutputLimit.Setting | undefined) => {
    await s.t.deps.runtime.policy.update((stored) => PolicyRules.apply(stored, { outputLimit: value ?? null }))
  }
  /** The options a `hook` request of `model` leaves, given core's limit and ceiling. */
  const shaped = async (
    model: Model.Ref,
    core: { readonly maxTokens?: number; readonly ceiling?: number },
    hook = "context",
  ) => {
    const event: SessionContext = {
      ...context(SESSION, model),
      options: { temperature: 0.2, ...(core.maxTokens === undefined ? {} : { maxTokens: core.maxTokens }) },
      ...(core.ceiling === undefined ? {} : { outputCeiling: core.ceiling }),
    }
    await hooks.get(hook)?.(event)
    return event.options.maxTokens
  }
  return { s, setting, shaped, [Symbol.asyncDispose]: () => s[Symbol.asyncDispose]() }
}

/** Core's limit of a model with `output` and a window that leaves `room`: `maxTokens` capped at 256,000. */
const core = (output: number, room = Number.POSITIVE_INFINITY) => {
  const ceiling = Math.min(output, room)
  return { maxTokens: Math.min(ceiling, OutputLimit.CORE_CAP), ceiling }
}

describe("output limit setting: the default", () => {
  test("no setting and the stored default send core's limit; only the own-slot rules apply", async () => {
    await using r = await setup()
    for (const value of [undefined, OutputLimit.DEFAULT]) {
      await r.setting(value)
      expect(await r.shaped(ANTH, core(128_000))).toBe(128_000)
      expect(await r.shaped(CLAUDE_SUB, core(128_000))).toBe(128_000)
      expect(await r.shaped(DS, core(393_216))).toBe(256_000)
      expect(await r.shaped(DS_OFF, core(393_216))).toBe(256_000)
      for (const model of OTHERS) expect(await r.shaped(model, core(393_216, 42_500))).toBe(42_500)
      for (const model of [CODEX, OAI, OR]) expect(await r.shaped(model, core(128_000))).toBeUndefined()
    }
  })
})

describe("output limit setting: 이 값을 넘기지 않기", () => {
  test("a lower number caps every provider, Claude subscription and built-in providers included", async () => {
    await using r = await setup()
    await r.setting({ mode: "cap", maxTokens: 100_000 })
    expect(await r.shaped(ANTH, core(128_000))).toBe(100_000)
    expect(await r.shaped(CLAUDE_SUB, core(128_000))).toBe(100_000)
    expect(await r.shaped(DS, core(393_216))).toBe(100_000)
    for (const model of OTHERS) expect(await r.shaped(model, core(393_216))).toBe(100_000)
    // A model with less output, or a prompt that leaves less room, sends that.
    expect(await r.shaped(ANTH, core(64_000))).toBe(64_000)
    expect(await r.shaped(DS, core(393_216, 42_500))).toBe(42_500)
  })

  test("a number above core's 256,000 lets a model with more output use it, still fitted to the room", async () => {
    await using r = await setup()
    await r.setting({ mode: "cap", maxTokens: 1_000_000 })
    expect(await r.shaped(DS, core(393_216))).toBe(393_216)
    expect(await r.shaped(DS, core(393_216, 288_500))).toBe(288_500)
    expect(await r.shaped(ANTH, core(128_000))).toBe(128_000)
    await r.setting({ mode: "cap", maxTokens: 300_000 })
    expect(await r.shaped(DS, core(393_216))).toBe(300_000)
  })

  test("codex, oai and or slots still get none, and a limit an earlier hook removed stays removed", async () => {
    await using r = await setup()
    await r.setting({ mode: "cap", maxTokens: 50_000 })
    for (const model of [CODEX, OAI, OR]) expect(await r.shaped(model, core(128_000))).toBeUndefined()
    // Upstream's `openai` provider hook removes core's limit before own's plugins run.
    expect(await r.shaped(ref("openai", "gpt-5.5"), { ceiling: 128_000 })).toBeUndefined()
  })
})

describe("output limit setting: 출력 상한 보내지 않기", () => {
  test("no limit, so the provider's default applies", async () => {
    await using r = await setup()
    await r.setting({ mode: "omit", maxTokens: 120_000 })
    expect(await r.shaped(DS, core(393_216))).toBeUndefined()
    for (const model of [...OTHERS, CODEX, OAI, OR]) expect(await r.shaped(model, core(393_216))).toBeUndefined()
  })

  test("Claude gets the adapter's 32,000, never more than its model's limit or the room", async () => {
    await using r = await setup()
    await r.setting({ mode: "omit", maxTokens: 256_000 })
    for (const model of [ANTH, CLAUDE_SUB]) {
      expect(await r.shaped(model, core(128_000))).toBe(OutputLimit.CLAUDE_DEFAULT)
      expect(await r.shaped(model, core(8_192))).toBe(8_192)
      expect(await r.shaped(model, core(128_000, 20_000))).toBe(20_000)
    }
  })

  test("DeepSeek with thinking off gets 65,536 instead of its 8K server default, fitted to the room", async () => {
    await using r = await setup()
    await r.setting({ mode: "omit", maxTokens: 256_000 })
    expect(await r.shaped(DS_OFF, core(393_216))).toBe(OutputLimit.DS_THINKING_OFF)
    expect(await r.shaped(DS_OFF, core(393_216, 30_000))).toBe(30_000)
  })

  test("the prompt bytes are those of the default setting; only the limit differs", async () => {
    await using r = await setup()
    const request = (): SessionContext => ({
      ...context(SESSION, ANTH, {
        system: [{ type: "text", text: "You are OpenCode." }],
        messages: [message({ id: "msg_u1", role: "user", content: [{ type: "text", text: "긴 답을 써 줘" }] })],
      }),
      tools: { write: { description: "Write a file.", input: { type: "object" } } },
      options: { maxTokens: 128_000 },
      outputCeiling: 128_000,
    })
    const hooks = await registeredHooks(r.s)
    const bytes = async (value: OutputLimit.Setting | undefined) => {
      await r.setting(value)
      const event = request()
      await hooks.get("context")?.(event)
      return { prompt: JSON.stringify([event.system, event.messages, event.tools]), limit: event.options.maxTokens }
    }
    const before = await bytes(undefined)
    const omitted = await bytes({ mode: "omit", maxTokens: 256_000 })
    const capped = await bytes({ mode: "cap", maxTokens: 16_000 })
    expect(omitted.prompt).toBe(before.prompt)
    expect(capped.prompt).toBe(before.prompt)
    expect([before.limit, omitted.limit, capped.limit]).toEqual([128_000, 32_000, 16_000])
  })
})

describe("output limit setting: what it never touches", () => {
  test("compaction keeps core's 32,000 summary cap and generate keeps its caller's limit", async () => {
    await using r = await setup()
    for (const value of [
      { mode: "omit", maxTokens: 256_000 },
      { mode: "cap", maxTokens: 8_000 },
    ] as const) {
      await r.setting(value)
      expect(await r.shaped(ANTH, { maxTokens: 32_000, ceiling: 32_000 }, "compaction")).toBe(32_000)
      expect(await r.shaped(CLAUDE_SUB, { maxTokens: 32_000, ceiling: 32_000 }, "compaction")).toBe(32_000)
      expect(await r.shaped(DS, { maxTokens: 4_096 }, "generate")).toBe(4_096)
      expect(await r.shaped(DS, {}, "generate")).toBeUndefined()
    }
  })

  test("a change applies to the next request", async () => {
    await using r = await setup()
    expect(await r.shaped(ANTH, core(128_000))).toBe(128_000)
    await r.setting({ mode: "cap", maxTokens: 20_000 })
    expect(await r.shaped(ANTH, core(128_000))).toBe(20_000)
    await r.setting(undefined)
    expect(await r.shaped(ANTH, core(128_000))).toBe(128_000)
  })

  test("without core's ceiling (an older core) a cap never raises core's limit", () => {
    const event: SessionContext = { ...context(SESSION, DS), options: { maxTokens: 256_000 } }
    OutputLimitShape.apply(event, { mode: "cap", maxTokens: 393_216 }, false)
    expect(event.options.maxTokens).toBe(256_000)
  })
})

describe("output limit setting: policy.set (02 §9.2)", () => {
  test("stores, replaces and clears the setting; numbers outside 4,096..1,000,000 are refused", async () => {
    await using m = await machine()
    for (const maxTokens of [OutputLimit.MIN_TOKENS - 1, OutputLimit.MAX_TOKENS + 1, 0])
      expect(failure(await m.rpc("policy.set", { patch: { outputLimit: { mode: "cap", maxTokens } } }))).toMatchObject({
        type: "setting_out_of_range",
        data: { field: "outputLimit.maxTokens", min: 4_096, max: 1_000_000 },
      })
    expect((await m.deps.runtime.policy.read()).outputLimit).toBeUndefined()

    for (const outputLimit of [
      { mode: "cap", maxTokens: OutputLimit.MIN_TOKENS },
      { mode: "cap", maxTokens: OutputLimit.MAX_TOKENS },
      { mode: "omit", maxTokens: 120_000 },
    ] as const) {
      const set = await m.rpc("policy.set", { patch: { outputLimit } })
      expect(set).toMatchObject({ policy: { outputLimit } })
      expect((await m.deps.runtime.policy.read()).outputLimit).toEqual(outputLimit)
    }
    // Another section's patch keeps it.
    await m.rpc("policy.set", { patch: { autoSwitch: { apiToApi: "ask" } } })
    expect((await m.deps.runtime.policy.read()).outputLimit).toEqual({ mode: "omit", maxTokens: 120_000 })
    const got = await m.rpc("policy.get", {})
    expect(got).toMatchObject({ policy: { outputLimit: { mode: "omit", maxTokens: 120_000 } } })

    const cleared = await m.rpc("policy.set", { patch: { outputLimit: null } })
    if (failure(cleared) || !("policy" in cleared)) throw new Error("policy.set failed")
    expect(cleared.policy.outputLimit).toBeUndefined()
    expect(JSON.stringify(await m.deps.runtime.policy.read())).not.toContain("outputLimit")
  })

  test("PolicyRules.apply replaces the setting whole and leaves it out of other patches", () => {
    const omit = PolicyRules.apply(Policy.defaults, { outputLimit: { mode: "omit", maxTokens: 90_000 } })
    expect(omit.outputLimit).toEqual({ mode: "omit", maxTokens: 90_000 })
    expect(PolicyRules.apply(omit, { horizonRequests: 5 }).outputLimit).toEqual(omit.outputLimit)
    expect("outputLimit" in PolicyRules.apply(omit, { outputLimit: null })).toBe(false)
  })
})

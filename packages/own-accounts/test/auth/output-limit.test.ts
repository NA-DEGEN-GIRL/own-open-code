// DeepSeek output limit with thinking off (external-repos report P0-4, option C): a `ds` slot request on the `none`
// variant gets `maxTokens = 65,536` when nothing set one, because the server default there (8K) ends long answers and
// file writes silently. A limit already set (core's own from upstream d9987ef9c8) wins, thinking variants and other
// providers are untouched, and the prompt bytes stay the same. Like upstream's `omitOutputLimit`, the output limit is
// shaped on `context` and `compaction` only: a `generate` caller's limit, or its absence, stays as it was (codex and oai
// slots included). Every credential is fake; nothing reaches a network.

import { describe, expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Auth } from "../../src/auth/auth.js"
import { registryWith } from "../slots/support.js"
import { authSetup, context, message, registeredHooks } from "./support.js"

const SESSION = "ses_output_limit_test"
const MODELS = ["deepseek-flash", "deepseek-v4-pro"]

function slotRef(providerID: string, id: string, variant?: string) {
  return Model.Ref.make({
    providerID: Provider.ID.make(providerID),
    id: Model.ID.make(id),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  })
}

async function setup() {
  const registry = await registryWith([
    { kind: "ds", label: "D", slug: "dddd" },
    { kind: "oai", label: "A", slug: "aaaa" },
    { kind: "codex", label: "C", slug: "cccc" },
    { kind: "anth", label: "N", slug: "nnnn" },
  ])
  return authSetup({ registry })
}

type Setup = Awaited<ReturnType<typeof setup>>

/** The options after the auth module shaped a request of `model` that came with `options`. */
async function shaped(s: Setup, model: Model.Ref, options: SessionContext["options"] = {}) {
  const event = { ...context(SESSION, model), options: { ...options } }
  await s.auth.onRequestShape(event)
  return event.options
}

describe("DeepSeek output limit with thinking off", () => {
  test("the limit is DeepSeek's thinking-on default", () => {
    expect(Auth.DS_THINKING_OFF_OUTPUT).toBe(65_536)
  })

  test("context and compaction requests of a ds slot on the none variant get it when nothing set a limit", async () => {
    await using s = await setup()
    const hooks = await registeredHooks(s)
    for (const name of ["context", "compaction"])
      for (const id of MODELS) {
        const event: SessionContext = {
          ...context(SESSION, slotRef("own-ds-dddd", id, "none")),
          options: { temperature: 0.2 },
        }
        await hooks.get(name)?.(event)
        expect(event.options).toEqual({ temperature: 0.2, maxTokens: 65_536 })
      }
  })

  test("generate requests keep their caller's limit or none: no DS default, no codex or oai strip", async () => {
    await using s = await setup()
    const hooks = await registeredHooks(s)
    const generate = async (model: Model.Ref, options: SessionContext["options"]) => {
      const event: SessionContext = { ...context(SESSION, model), options: { ...options } }
      await hooks.get("generate")?.(event)
      return event.options
    }
    for (const id of MODELS) expect(await generate(slotRef("own-ds-dddd", id, "none"), {})).toEqual({})
    for (const model of [slotRef("own-oai-aaaa", "gpt-5.5"), slotRef("own-codex-cccc", "gpt-5.5")])
      expect(await generate(model, { maxTokens: 4_096 })).toEqual({ maxTokens: 4_096 })
    // The same request through `context` is shaped.
    const event: SessionContext = {
      ...context(SESSION, slotRef("own-oai-aaaa", "gpt-5.5")),
      options: { maxTokens: 4_096 },
    }
    await hooks.get("context")?.(event)
    expect(event.options).toEqual({})
  })

  test("a limit already set wins, whatever its size", async () => {
    await using s = await setup()
    for (const maxTokens of [4_096, 65_536, 256_000, 393_216])
      for (const id of MODELS)
        expect(await shaped(s, slotRef("own-ds-dddd", id, "none"), { maxTokens })).toEqual({ maxTokens })
  })

  test("thinking variants, the default and an unselected variant get no limit", async () => {
    await using s = await setup()
    for (const variant of ["low", "high", "max", "default", undefined])
      for (const id of MODELS) expect(await shaped(s, slotRef("own-ds-dddd", id, variant))).toEqual({})
  })

  test("other kinds and the built-in deepseek provider are untouched on the none variant", async () => {
    await using s = await setup()
    for (const model of [
      slotRef("deepseek", "deepseek-v4-pro", "none"),
      slotRef("own-oai-aaaa", "gpt-5.5", "none"),
      slotRef("own-codex-cccc", "gpt-5.5", "none"),
      slotRef("own-anth-nnnn", "claude-opus-5-5", "none"),
    ])
      expect(await shaped(s, model)).toEqual({})
  })

  test("the prompt bytes are those of a thinking variant's request; only the limit is added", async () => {
    await using s = await setup()
    const request = (variant: string): SessionContext => ({
      ...context(SESSION, slotRef("own-ds-dddd", "deepseek-v4-pro", variant), {
        system: [
          { type: "text", text: "You are OpenCode." },
          { type: "text", text: "# Your Model\n- Name: DeepSeek V4 Pro\n- Provider ID: own-ds-dddd" },
        ],
        messages: [
          message({ id: "msg_u1", role: "user", content: [{ type: "text", text: "긴 파일을 써 줘" }] }),
          message({ id: "msg_a1", role: "assistant", content: [{ type: "text", text: "ok" }] }),
          message({ id: "msg_u2", role: "user", content: [{ type: "text", text: "next" }] }),
        ],
      }),
      tools: { write: { description: "Write a file.", input: { type: "object" } } },
      options: { temperature: 0.2 },
    })
    const off = request("none")
    const on = request("high")
    await s.auth.onRequestShape(off)
    await s.auth.onRequestShape(on)
    const bytes = (event: SessionContext) => JSON.stringify([event.system, event.messages, event.tools])
    expect(bytes(off)).toBe(bytes(on))
    expect(off.options).toEqual({ ...on.options, maxTokens: 65_536 })
  })
})

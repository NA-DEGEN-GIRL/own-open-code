import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OwnHarness } from "../src/rpc-harness.js"

const Definition = OwnHarness.Definition
const methodNames = Object.keys(Definition.methods) as ReadonlyArray<OwnHarness.MethodName>
const input = (name: OwnHarness.MethodName) => Definition.methods[name].input as Schema.Codec<unknown, unknown>
const output = (name: OwnHarness.MethodName) => Definition.methods[name].output as Schema.Codec<unknown, unknown>

describe("own.harness definition", () => {
  test("every method has a scope; the new-session default is set from this PC only", () => {
    expect(Object.keys(OwnHarness.MethodScope).sort()).toEqual([...methodNames].sort())
    expect(OwnHarness.MethodScope["defaults.set"]).toBe("local")
    expect(OwnHarness.MethodScope["session.set"]).toBe("drive")
  })

  test("defaults.set takes a harness and a prompt variant and answers the list", () => {
    const decode = Schema.decodeUnknownSync(input("defaults.set"))
    expect(decode({ harness: "pi", prompt: "own" })).toEqual({ harness: "pi", prompt: "own" })
    expect(() => decode({ harness: "pi" })).toThrow()
    expect(() => decode({ harness: "claude", prompt: "own" })).toThrow()
    // DeepSeek 방식 (13, 2026-10-19), which has a 내 지시문 too.
    expect(decode({ harness: "dsh", prompt: "custom" })).toEqual({ harness: "dsh", prompt: "custom" })
    expect(OwnHarness.CUSTOM_HARNESSES).toEqual(["codex", "pi", "dsh"])
    const list = {
      harnesses: ["opencode", "codex", "pi"],
      default: "pi",
      prompts: ["reference", "own"],
      defaultPrompt: "own",
      buildId: "b",
      version: "v",
    }
    expect(Schema.decodeUnknownSync(output("defaults.set"))(list)).toEqual(list)
  })

  test("내 지시문: a third variant; an older service's list without `custom` still decodes (10 §3.11)", () => {
    expect(OwnHarness.PROMPTS).toEqual(["reference", "own", "custom"])
    expect(Schema.decodeUnknownSync(input("defaults.set"))({ harness: "codex", prompt: "custom" })).toEqual({
      harness: "codex",
      prompt: "custom",
    })
    const older = {
      harnesses: ["opencode", "codex", "pi"],
      default: "codex",
      prompts: ["reference", "own"],
      defaultPrompt: "own",
      buildId: "b",
      version: "v",
    }
    expect(Schema.decodeUnknownSync(output("list"))(older)).toEqual(older)
    expect(Schema.decodeUnknownSync(output("list"))({ ...older, custom: ["pi"] })).toMatchObject({ custom: ["pi"] })
    // A session written by this build reads as the original in a build that knows two variants only.
    expect(OwnHarness.promptOf({ [OwnHarness.META_KEY]: OwnHarness.value("codex", "custom") })).toBe("custom")
    expect(OwnHarness.value("codex", "custom")).toEqual({ id: "codex", v: 1, prompt: "custom" })
  })

  test("omo (15): a harness without a 내 지시문; a build that does not know it reads such a session as opencode", () => {
    expect(OwnHarness.harnessOf({ [OwnHarness.META_KEY]: OwnHarness.value("omo") })).toBe("omo")
    expect(OwnHarness.CUSTOM_HARNESSES).not.toContain("omo")
    expect(() => Schema.decodeUnknownSync(input("prompt.custom.set"))({ harness: "omo", text: "x" })).toThrow()
    // What a build without `omo` does: `bound` finds no id it knows, so the fallback (opencode) runs.
    const older = ["opencode", "codex", "pi", "dsh"]
    expect(older.find((id) => id === OwnHarness.value("omo").id)).toBeUndefined()
    expect(OwnHarness.harnessOf({ [OwnHarness.META_KEY]: { id: "later", v: 1 } })).toBe(OwnHarness.FALLBACK)
    // A service without own-omo refuses omo as a binding or default.
    expect(Object.keys(OwnHarness.Definition.methods["session.set"].errors)).toContain("harness_unavailable")
    expect(Object.keys(OwnHarness.Definition.methods["defaults.set"].errors)).toContain("harness_unavailable")
  })

  test("prompt.preview reads, prompt.custom.set saves from this PC only and takes null to reset", () => {
    expect(OwnHarness.MethodScope["prompt.preview"]).toBe("read")
    expect(OwnHarness.MethodScope["prompt.custom.set"]).toBe("local")
    const preview = Schema.decodeUnknownSync(input("prompt.preview"))
    expect(
      preview({ harness: "codex", prompt: "own", model: { providerID: "p", modelID: "m" }, mode: "full" }),
    ).toEqual({ harness: "codex", prompt: "own", model: { providerID: "p", modelID: "m" }, mode: "full" })
    // OpenCode 기본 has nothing of its own to show or edit.
    expect(() => preview({ harness: "opencode", prompt: "own" })).toThrow()
    const set = Schema.decodeUnknownSync(input("prompt.custom.set"))
    expect(set({ harness: "pi", text: null })).toEqual({ harness: "pi", text: null })
    expect(set({ harness: "codex", text: "Be brief." })).toEqual({ harness: "codex", text: "Be brief." })
    expect(() => set({ harness: "codex" })).toThrow()
  })

  test("하위 에이전트: prompt.subagent reads core's view; a preview from an older service has none", () => {
    expect(OwnHarness.MethodScope["prompt.subagent"]).toBe("read")
    expect(Schema.decodeUnknownSync(input("prompt.subagent"))({})).toEqual({})
    const core = {
      kind: "core",
      tool: { name: "subagent", description: "Spawns an agent." },
      agent: "build",
      opening: "You are a subagent spawned by another session.\n",
      guidance: "",
      cut: { lines: 2000, bytes: 51200 },
    }
    expect(Schema.decodeUnknownSync(output("prompt.subagent"))(core)).toEqual(core)
    // Codex has no first line, no cut and no default agent; an unregistered tool leaves `tool` out.
    const codex = { kind: "codex-v1" as const, opening: "", guidance: "" }
    expect(Schema.decodeUnknownSync(OwnHarness.PromptSubagent)(codex)).toEqual(codex)
    expect(() => Schema.decodeUnknownSync(OwnHarness.PromptSubagent)({ ...codex, kind: "omo" })).toThrow()
    const preview = {
      harness: "pi",
      prompt: "own",
      applied: "own",
      model: { providerID: "p", modelID: "m", name: "M" },
      responses: false,
      mode: "ask",
      parts: [],
      tools: [],
      changes: [],
      starts: { reference: "", own: "" },
      models: [],
      examples: false,
      limit: 100_000,
    }
    expect(Schema.decodeUnknownSync(output("prompt.preview"))(preview)).toEqual(preview)
    expect(Schema.decodeUnknownSync(output("prompt.preview"))({ ...preview, subagent: core })).toMatchObject({
      subagent: core,
    })
  })
})

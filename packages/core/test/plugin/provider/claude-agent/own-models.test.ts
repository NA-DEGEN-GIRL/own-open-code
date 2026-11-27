// OWN-PATCH(P-060) begin
// own: what each of Claude Code's aliases runs. The list names the concrete model beside the alias ("Opus · Opus 5.5",
// from Claude Code's `resolvedModel`, or the model a turn ran when an older Claude Code names none), hands its facts
// (resolved model, window, Fast) to own-accounts over the observer channel, re-checks a model no full check has asked
// yet once per process, and a turn asks Claude Code's Fast mode when the request says so (decisions CAM).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ClaudeObserver } from "@opencode/core/plugin/provider/claude-agent/claude/observer"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { ClaudeIntegration } from "@opencode/core/plugin/provider/claude-agent/integration"
import { ClaudeProvider } from "@opencode/core/plugin/provider/claude-agent/provider"
import { ClaudeAgentLanguageModel } from "@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind"
import { ID, make } from "@opencode/core/plugin/provider/claude-agent/index"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { KV } from "@opencode/core/kv"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { it, testEffect } from "../../../lib/effect"
import { PluginTestLayer } from "../../fixture"
import { FakeClaude } from "./lib/fake-claude"
import { FakeIO } from "./lib/fake-io"
import { TestSessions } from "./lib/sessions"

describe("P-060: the model each alias runs", () => {
  test("a resolved id reads as the model's name and version", () => {
    expect(ClaudeProvider.versionName("claude-opus-5-5")).toBe("Opus 5.5")
    expect(ClaudeProvider.versionName("claude-fable-5-2[1m]")).toBe("Fable 5.2")
    expect(ClaudeProvider.versionName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5")
    expect(ClaudeProvider.versionName("anthropic.claude-sonnet-5")).toBe("Sonnet 5")
    expect(ClaudeProvider.versionName("claude-opus-4-6@default")).toBe("Opus 4.6")
  })

  test("the alias keeps Claude Code's label and gains the model it runs; a label that names it stays", () => {
    expect(ClaudeProvider.displayName({ name: "Opus", resolvedModel: "claude-opus-5-5" })).toBe("Opus · Opus 5.5")
    expect(ClaudeProvider.displayName({ name: "Fable", resolvedModel: "claude-fable-5-2" })).toBe("Fable · Fable 5.2")
    expect(ClaudeProvider.displayName({ name: "Opus (1M context)", resolvedModel: "claude-opus-5-5[1m]" })).toBe(
      "Opus (1M context) · Opus 5.5",
    )
    expect(ClaudeProvider.displayName({ name: "Sonnet 5.5", resolvedModel: "claude-sonnet-5-5" })).toBe("Sonnet 5.5")
    expect(ClaudeProvider.displayName({ name: "Haiku" })).toBe("Haiku")
  })

  test("a turn names the model of an alias Claude Code listed without one, only from a single usage entry", () => {
    const models = [{ id: "opus", name: "Opus", efforts: [] }]
    expect(
      ClaudeProvider.turnModel(
        { model: "opus", usage: [{ key: "claude-opus-5-5", contextWindow: 1_000_000 }] },
        models,
      ),
    ).toEqual({ model: "opus", resolvedModel: "claude-opus-5-5" })
    const two = [
      { key: "claude-opus-5-5", contextWindow: 1_000_000 },
      { key: "claude-haiku-5-5", contextWindow: 1_000_000 },
    ]
    expect(ClaudeProvider.turnModel({ model: "opus", usage: two }, models)).toBeUndefined()
    expect(
      ClaudeProvider.turnModel({ model: "opus", usage: [two[0]!] }, [
        { ...models[0]!, resolvedModel: "claude-opus-5" },
      ]),
    ).toBeUndefined()
  })
})

describe("P-060: the provider's list", () => {
  const plugin = testEffect(PluginTestLayer)
  const listed = Effect.fn(function* (id: string) {
    const models = yield* Model.Service
    return (yield* models.all()).find((model) => model.providerID === ClaudeProvider.ID && model.id === id)
  })
  const start = Effect.fn(function* (
    saved: {
      models: Array<{
        id: string
        name: string
        efforts: string[]
        contextWindow?: number
        resolvedModel?: string
        supportsFastMode?: boolean
      }>
      checked?: string[]
    },
    claude: FakeClaude.Fake,
  ) {
    const store = PluginHost.storage(yield* KV.Service, ID)
    yield* store.set("models", saved)
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID: Integration.ID.make(ClaudeProvider.ID),
      value: Credential.External.make({
        type: "external",
        methodID: Integration.MethodID.make(ClaudeIntegration.METHOD_ID),
      }),
    })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const host = yield* PluginHost.make(yield* Plugin.Service, ID)
    yield* make(FakeIO.make({ claude }), registry).effect(host)
    return store
  })

  plugin.live(
    "a list saved before `checked` with a model without a window is checked once; names carry the version",
    () =>
      Effect.gen(function* () {
        const seen: ClaudeObserver.Observation[] = []
        const listen = (observation: ClaudeObserver.Observation) => void seen.push(observation)
        ClaudeObserver.channel().listeners.add(listen)
        yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.channel().listeners.delete(listen)))
        const claude = FakeClaude.make(FakeClaude.replay("startup"))
        const store = yield* start(
          {
            models: [
              { id: "opus", name: "Opus", efforts: [], contextWindow: 1_000_000 },
              { id: "sonnet", name: "Sonnet", efforts: [] },
            ],
          },
          claude,
        )
        const deadline = Date.now() + 20_000
        while ((yield* listed("sonnet"))?.limit.context !== 1_000_000 && Date.now() < deadline)
          yield* Effect.promise(() => Bun.sleep(20))
        expect((yield* listed("sonnet"))?.limit.context).toBe(1_000_000)
        expect(claude.runs).toHaveLength(1)
        // The recording's Claude Code lists `fable` as Fable 5.1 and Opus with Fast (its labels name the version).
        expect((yield* listed("opus"))?.name).toContain("Opus 5.5")
        expect((yield* listed("fable"))?.name).toContain("Fable 5.1")
        expect((yield* listed("fable"))?.limit.context).toBe(1_000_000)
        const saved = (yield* store.get("models")) as { checked?: string[] }
        expect(saved.checked).toEqual(expect.arrayContaining(["opus", "fable", "sonnet", "haiku"]))
        const facts = seen.flatMap((item) => (item.models ? [item.models] : [])).at(-1)
        expect(facts?.find((model) => model.id === "opus")).toMatchObject({
          resolvedModel: "claude-opus-5-5",
          contextWindow: 1_000_000,
          supportsFastMode: true,
        })
        expect(ClaudeObserver.models()?.find((model) => model.id === "fable")?.supportsFastMode).toBeUndefined()
      }),
  )

  plugin.live("a model a check already asked starts no other check, and its facts are on the channel at once", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([])
      yield* start(
        {
          models: [
            { id: "fable", name: "Fable", efforts: [], resolvedModel: "claude-fable-5-2", supportsFastMode: true },
            { id: "haiku", name: "Haiku", efforts: [], contextWindow: 1_000_000 },
          ],
          checked: ["fable", "haiku"],
        },
        claude,
      )
      yield* Effect.promise(() => Bun.sleep(200))
      expect(claude.runs).toHaveLength(0)
      expect((yield* listed("fable"))?.name).toBe("Fable · Fable 5.2")
      expect(ClaudeObserver.models()?.find((model) => model.id === "fable")).toEqual({
        id: "fable",
        name: "Fable · Fable 5.2",
        resolvedModel: "claude-fable-5-2",
        supportsFastMode: true,
      })
    }),
  )
})

describe("P-060: Fast mode", () => {
  it.effect("a turn that asks Fast turns Claude Code's fastMode on before its input, and off again after", () =>
    Effect.gen(function* () {
      const seen: ClaudeObserver.Observation[] = []
      const listen = (observation: ClaudeObserver.Observation) => void seen.push(observation)
      ClaudeObserver.channel().listeners.add(listen)
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.channel().listeners.delete(listen)))
      const apply = () =>
        FakeClaude.replay("controls").find(
          (step) => step.type === "exchange" && step.input.request?.subtype === "apply_flag_settings",
        )!
      const recorded = (index: number) => FakeClaude.expectTurn({ recording: "controls", index })
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        apply(),
        recorded(0),
        apply(),
        recorded(1),
        recorded(2),
        FakeClaude.expectInterrupt(),
      ])
      const test = yield* TestSessions.start(claude)
      const prompt = TestSessions.prompt("Remember CONTROL-OTTER. Reply only CONTROL-OTTER.")
      for (const fast of [true, false, false]) {
        const model = new ClaudeAgentLanguageModel.Model("haiku", test.model.dependencies)
        const result = yield* Effect.promise(() =>
          model.doStream({
            prompt,
            providerOptions: { "claude-agent": fast ? { fastMode: true } : {} },
            headers: { [RequestKind.HEADER]: "primary", [RequestKind.SESSION_HEADER]: "session-fast" },
          }),
        )
        expect(TestSessions.text(yield* Effect.promise(() => TestSessions.collect(result.stream)))).toBe(
          "CONTROL-OTTER",
        )
        prompt.push(
          { role: "assistant", content: [{ type: "text", text: "CONTROL-OTTER" }] },
          { role: "user", content: [{ type: "text", text: "What was the marker? Reply only with it." }] },
        )
      }
      const requests = claude.runs[0]!.received.map((message) => message.request).filter(Boolean)
      const flags = requests.filter((request) => request.subtype === "apply_flag_settings")
      expect(flags).toEqual([
        { subtype: "apply_flag_settings", settings: { fastMode: true } },
        { subtype: "apply_flag_settings", settings: { fastMode: false } },
      ])
      // Fast goes before the turn's input.
      const order = claude.runs[0]!.received.map((message) =>
        message.type === "user" ? "user" : message.request?.subtype,
      )
      expect(order.indexOf("apply_flag_settings")).toBeLessThan(order.indexOf("user"))
      // Only the turn that asked reports; the recorded Claude Code (no opt-in then) answered Standard and why.
      expect(seen.flatMap((item) => (item.fast ? [item.fast] : []))).toEqual([
        { model: "haiku", requested: true, state: "off", reason: "sdk_opt_in_required" },
      ])
      yield* test.registry.close()
      claude.check()
    }),
  )
})
// OWN-PATCH(P-060) end

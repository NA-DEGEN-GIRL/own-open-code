// OWN-PATCH(P-053) begin
// own: Claude Code reports each model's context window in every turn's result (`modelUsage[*].contextWindow`). A turn
// hands it to the provider over the observer channel, and a model the login check left without a window (core's 200k
// fallback) gets Claude Code's own one; a window the check read, or another model's entry, changes nothing (decisions PE-7).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ClaudeObserver } from "@opencode/core/plugin/provider/claude-agent/claude/observer"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { ClaudeStatus } from "@opencode/core/plugin/provider/claude-agent/claude/status"
import { ClaudeIntegration } from "@opencode/core/plugin/provider/claude-agent/integration"
import { ClaudeProvider } from "@opencode/core/plugin/provider/claude-agent/provider"
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

const OPUS = { id: "opus", name: "Opus", efforts: [], resolvedModel: "claude-opus-5-5" }
const ONE_M = { id: "opus[1m]", name: "Opus 1M", efforts: [], resolvedModel: "claude-opus-5-5[1m]" }

describe("P-053: a turn's context window", () => {
  test("the entry of the model the turn ran, with or without [1m]; never a helper model's, never over a read window", () => {
    const usage = [
      { key: "claude-opus-5-5", canonical: "claude-opus-5-5", contextWindow: 1_000_000 },
      { key: "claude-haiku-5-5", canonical: "claude-haiku-5-5", contextWindow: 200_000 },
    ]
    expect(ClaudeProvider.turnWindow({ model: "opus", usage }, [OPUS])).toEqual({
      model: "opus",
      contextWindow: 1_000_000,
    })
    expect(
      ClaudeProvider.turnWindow(
        { model: "opus[1m]", usage: [{ key: "claude-opus-5-5[1m]", contextWindow: 1_000_000 }] },
        [ONE_M],
      ),
    ).toEqual({ model: "opus[1m]", contextWindow: 1_000_000 })
    // Entries of other models only (no match, more than one): nothing.
    const helpers = [
      { key: "claude-haiku-5-5", contextWindow: 200_000 },
      { key: "claude-sonnet-5-5", contextWindow: 1_000_000 },
    ]
    expect(ClaudeProvider.turnWindow({ model: "opus", usage: helpers }, [OPUS])).toBeUndefined()
    // A window the login check read stays (upstream: a chat keeps saved sizes); a model the list lacks: nothing.
    expect(ClaudeProvider.turnWindow({ model: "opus", usage }, [{ ...OPUS, contextWindow: 1_000_000 }])).toBeUndefined()
    expect(ClaudeProvider.turnWindow({ model: "sonnet", usage }, [OPUS])).toBeUndefined()
  })

  it.effect("a chat turn hands Claude Code's per-model windows to the observer channel", () =>
    Effect.gen(function* () {
      const seen: ClaudeObserver.Observation[] = []
      const listen = (observation: ClaudeObserver.Observation) => void seen.push(observation)
      ClaudeObserver.channel().listeners.add(listen)
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.channel().listeners.delete(listen)))
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectInterrupt(),
      ])
      const io = FakeIO.make({ claude })
      const registry = ClaudeSessions.registry()
      yield* Effect.addFinalizer(() => registry.close())
      const status = yield* ClaudeStatus.make(io, () => Effect.succeed({}))
      const sessions = yield* registry.attach({
        io,
        status,
        storage: TestSessions.storage(),
        directory: "/tmp/opencode",
      })
      const model = yield* TestSessions.model(sessions)
      yield* TestSessions.reply(
        model,
        TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker."),
      )
      const windows = seen.flatMap((item) => (item.windows ? [item.windows] : []))
      expect(windows.length).toBeGreaterThan(0)
      // The recorded turn (Claude Code on Haiku 5.5) reports a 1M window.
      expect(windows.at(-1)?.usage).toContainEqual({
        key: "claude-haiku-5-5",
        canonical: "claude-haiku-5-5",
        contextWindow: 1_000_000,
      })
    }),
  )
})

describe("P-053: the provider's list learns the window", () => {
  const plugin = testEffect(PluginTestLayer)
  const window = Effect.fn(function* (id: string) {
    const models = yield* Model.Service
    return (yield* models.all()).find((model) => model.providerID === ClaudeProvider.ID && model.id === id)?.limit
      .context
  })

  plugin.live("a model without a window takes the one its first turn reports", () =>
    Effect.gen(function* () {
      const store = PluginHost.storage(yield* KV.Service, ID)
      // Haiku has a window, so no login check starts (P-051); Opus keeps the 200k fallback until a turn reports.
      yield* store.set("models", {
        models: [OPUS, { id: "haiku", name: "Haiku", efforts: [], contextWindow: 200_000 }],
      })
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
      yield* make(FakeIO.make({ claude: FakeClaude.make([]) }), registry).effect(host)
      expect(yield* window("opus")).toBe(200_000)

      ClaudeObserver.emit({
        sessionID: "ses_1",
        windows: {
          model: "opus",
          usage: [
            { key: "claude-opus-5-5", canonical: "claude-opus-5-5", contextWindow: 1_000_000 },
            { key: "claude-haiku-5-5", contextWindow: 200_000 },
          ],
        },
      })
      const deadline = Date.now() + 10_000
      while ((yield* window("opus")) !== 1_000_000 && Date.now() < deadline) yield* Effect.promise(() => Bun.sleep(20))
      expect(yield* window("opus")).toBe(1_000_000)
      expect(yield* window("haiku")).toBe(200_000)
      // Saved, so the next start has it without a check.
      const saved = (yield* store.get("models")) as { models: Array<{ id: string; contextWindow?: number }> }
      expect(saved.models.find((model) => model.id === "opus")?.contextWindow).toBe(1_000_000)
    }),
  )
})
// OWN-PATCH(P-053) end

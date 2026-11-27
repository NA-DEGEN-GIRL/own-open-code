// Ultra (07 §2.9): the composer switch as a session state in the binding. The main's effort follows the company's tool
// (Codex's rule with the Codex metadata only for `codex`, Claude unchanged unless raised, `xhigh` intent elsewhere),
// a changed effort goes through the real switching module's estimate and apply (variant only), the variant before is
// restored on off, the user's own effort change turns it off except for Claude, and nothing reaches presets.json.
// Real slots, presets and switching over the 2026-10-01 fixture catalog, a fake session core and a fake own service on
// 127.0.0.1. Every account, login and password is fake; the Codex home is a temp folder.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { CodexModels, OwnAccounts, Preset } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import { PresetBinding } from "../../src/presets/binding.js"
import { Presets } from "../../src/presets/presets.js"
import { PresetUltra } from "../../src/presets/ultra.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import type { Switching } from "../../src/switching/switching.js"
import type { Variant } from "../../src/switching/variant.js"
import { failure, fakeEditor, memoryStorage, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { partial, seedCards } from "../switching/support.js"
import {
  ANTHROPIC,
  CLAUDE_ON,
  CODEX_A,
  DEEPSEEK,
  DS,
  OAI,
  OPENAI,
  SIWC_A,
  registry,
} from "./fixtures/catalog-2026-10-01.js"

// Each test boots real modules on a temp OWN_HOME and a loopback server.
setDefaultTimeout(30_000)

const WORKSPACE = process.platform === "win32" ? "C:\\work\\ultra" : "/work/ultra"

/** This PC's Codex cache as the Codex CLI writes it: Astra carries a multi-agent effort, Sol does not. */
const MODELS_CACHE = JSON.stringify({
  client_version: "0.157.0",
  models: [
    { slug: "gpt-6-astra", priority: 1, default_reasoning_level: "medium", multi_agent_reasoning_effort: "xhigh" },
    { slug: "gpt-6-sol", priority: 2, default_reasoning_level: "medium" },
  ],
})

const stops: Array<() => unknown> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

interface Recorded {
  readonly method: string
  readonly body: string
}

/** Real slots, presets and switching modules, a fake session core and a fake own service. */
async function rig(
  sessions: Record<string, Variant.Ref>,
  options: {
    readonly switching?: Partial<Switching.Api>
    /** A fetched Codex metadata list, stored in `OWN_HOME\codex-meta.json` (it wins over this PC's cache). */
    readonly meta?: CodexModels.File
  } = {},
) {
  const requests: Recorded[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({ method: request.method, body: await request.text() })
      return new Response(null, { status: 204 })
    },
  })
  stops.push(() => server.stop(true))
  const models = new Map(Object.entries(sessions))
  const switched: Array<{ sessionID: string; model: Variant.Ref }> = []
  const holder: { send?: (type: string, data: Record<string, unknown>) => Promise<void> } = {}
  const t = await testDeps({
    directory: WORKSPACE,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }), default: async () => ({ data: null }) },
      storage: memoryStorage().storage,
      // Agents without a configured model, for the subagent gate (07 §2.3 with ultra on).
      agent: {
        get: async (request: { readonly agentID: string }) => ({
          location: { directory: WORKSPACE },
          data: { id: request.agentID },
        }),
      },
      session: {
        get: async (request: { readonly sessionID: string }) => ({
          id: request.sessionID,
          model: models.get(request.sessionID),
          location: { directory: WORKSPACE },
        }),
        wait: async () => {},
        switchModel: async (request: { readonly sessionID: string; readonly model: Variant.Ref }) => {
          switched.push(request)
          const previous = models.get(request.sessionID)
          models.set(request.sessionID, request.model)
          setTimeout(() => {
            void holder.send?.("session.model.selected", {
              sessionID: request.sessionID,
              model: request.model,
              previous,
            })
          }, 0)
        },
      },
    },
  })
  stops.push(() => t[Symbol.asyncDispose]())
  const deps = t.deps
  await Bun.write(path.join(deps.options.codexHome ?? "", "models_cache.json"), MODELS_CACHE)
  if (options.meta) await CodexMeta.file(deps.runtime.layout).write(options.meta)
  await deps.runtime.registry.write(await registry())
  await deps.runtime.ratecards.write(await seedCards())
  const fake = options.switching
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (base, peers) => ({ ...Modules.FACTORIES.telemetry(base, peers), alert: () => {} }),
    presets: (base, peers) =>
      Presets.create(base, peers, {
        service: ServiceTarget.fixed({ url: `http://127.0.0.1:${server.port}`, password: "fake-password" }),
      }),
    ...(fake ? { switching: (base, peers) => ({ ...Modules.FACTORIES.switching(base, peers), ...fake }) } : {}),
  })
  await modules.slots.start()
  await modules.presets.start()
  await modules.switching.start()
  stops.push(async () => {
    await modules.switching.stop()
    await modules.presets.stop()
    await modules.slots.stop()
  })
  modules.slots.transformProviders(
    fakeEditor({ openai: { models: OPENAI }, anthropic: { models: ANTHROPIC }, deepseek: { models: DEEPSEEK } }).editor,
  )
  deps.emitter.bind(partial<RpcRegistration<RpcTypes.Definition>>("registration", { events: { emit: async () => {} } }))
  const send = async (type: string, data: Record<string, unknown>) => {
    // SAFETY: tests build the event envelope by hand; `type` and `data` follow the OpenCode event schema.
    const event = { id: "evt_x", type, location: { directory: WORKSPACE }, data } as unknown as Module.OpenCodeEvent
    await modules.switching.onEvent?.(event, { local: true })
    await modules.presets.onEvent?.(event, { local: true })
  }
  holder.send = send
  /**
   * Lets the fake core publish its `session.model.selected` (a timer), then waits for everything queued on the
   * session's serial runner.
   */
  const flush = async (sessionID: string) => {
    for (const _ of Array.from({ length: 5 })) await new Promise((resolve) => setTimeout(resolve, 0))
    await modules.switching.serial(sessionID, async () => {})
  }
  const ultra = async (value: { sessionID: string; on: boolean; raiseClaude?: boolean; dryRun?: boolean }) => {
    // SAFETY: the method's input schema decodes to the handler's input type.
    const schema = OwnAccounts.Definition.methods["session.ultra.set"].input as unknown as Schema.Codec<
      RpcTypes.Input<"session.ultra.set">,
      unknown
    >
    const result = await modules.presets.ultraSet(Schema.decodeUnknownSync(schema)(value), rpcContext())
    await flush(value.sessionID)
    return result
  }
  return {
    deps,
    models,
    switched,
    requests,
    modules,
    send,
    flush,
    ultra,
    binding: (sessionID: string) => PresetBinding.read(deps, sessionID),
  }
}

const SOL = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const ASTRA = { providerID: CODEX_A, id: "gpt-6-astra", variant: "high" }

describe("ultra on ChatGPT (07 §2.9, Codex's rule)", () => {
  test("dryRun answers the variant-only estimate and changes nothing", async () => {
    const r = await rig({ ses_a: SOL })
    const result = await r.ultra({ sessionID: "ses_a", on: true, dryRun: true })
    expect(result).toMatchObject({ on: true, variant: { from: "high", to: "max" }, dryRun: true })
    expect(result).toMatchObject({ estimate: { variantOnly: { preservesCache: true } } })
    expect(r.switched).toEqual([])
    expect(await r.binding("ses_a")).toBeUndefined()
    expect(r.requests).toEqual([])
  })

  test("on: max through a variant switch, active delegation with the ultra caps; off: the variant before comes back", async () => {
    const r = await rig({ ses_a: SOL })
    const on = await r.ultra({ sessionID: "ses_a", on: true })
    expect(on).toMatchObject({ on: true, variant: { from: "high", to: "max" }, switch: { state: "SWITCHING" } })
    expect(r.switched).toEqual([{ sessionID: "ses_a", model: { ...SOL, variant: "max" } }])
    // The switch's own `session.model.selected` (max is ultra's effort) leaves ultra on.
    expect(await r.binding("ses_a")).toMatchObject({ presetID: "builtin:codex", ultra: { before: "high" } })
    expect(r.requests.map((request) => request.method)).toEqual(["PUT"])
    const text = JSON.parse(r.requests[0]?.body ?? "{}").value as string
    expect(text).toContain("Delegation mode: active.")
    expect(text).toContain("at most 8 subagents running at once, at most 24 per user message")

    const off = await r.ultra({ sessionID: "ses_a", on: false })
    expect(off).toMatchObject({ on: false, variant: { from: "max", to: "high" } })
    expect(r.switched.at(-1)).toEqual({ sessionID: "ses_a", model: SOL })
    expect((await r.binding("ses_a"))?.ultra).toBeUndefined()
    expect(r.requests.map((request) => request.method)).toEqual(["PUT", "DELETE"])
    // Ultra is never saved to presets.json.
    expect(await r.deps.runtime.presets.read()).toEqual({ version: 2, groups: expect.anything() })
    expect(JSON.stringify(await r.deps.runtime.presets.read())).not.toContain("ultra")
  })

  test("the Codex multi-agent effort counts for codex and an OpenAI API key (07 §2.9); Sign in with ChatGPT uses max", async () => {
    const r = await rig({
      ses_codex: ASTRA,
      ses_siwc: { providerID: SIWC_A, id: "gpt-6-astra", variant: "high" },
      ses_oai: { providerID: OAI, id: "gpt-6-astra", variant: "high" },
    })
    expect(await r.ultra({ sessionID: "ses_codex", on: true, dryRun: true })).toMatchObject({
      variant: { to: "xhigh" },
    })
    expect(await r.ultra({ sessionID: "ses_siwc", on: true, dryRun: true })).toMatchObject({ variant: { to: "max" } })
    // The same OpenAI model on an API key follows Codex's rule too, so it does not pay for `max`.
    expect(await r.ultra({ sessionID: "ses_oai", on: true, dryRun: true })).toMatchObject({ variant: { to: "xhigh" } })
  })

  test("the user's own effort change turns ultra off; a model or account change keeps it", async () => {
    const r = await rig({ ses_a: SOL, ses_b: SOL })
    await r.ultra({ sessionID: "ses_a", on: true })
    const medium = { ...SOL, variant: "medium" }
    await r.send("session.model.selected", { sessionID: "ses_a", model: medium, previous: { ...SOL, variant: "max" } })
    await r.flush("ses_a")
    expect((await r.binding("ses_a"))?.ultra).toBeUndefined()
    expect(r.requests.map((request) => request.method)).toEqual(["PUT", "DELETE"])

    await r.ultra({ sessionID: "ses_b", on: true })
    const next = { providerID: CODEX_A, id: "gpt-6.1-sol", variant: "max" }
    await r.send("session.model.selected", { sessionID: "ses_b", model: next, previous: { ...SOL, variant: "max" } })
    await r.flush("ses_b")
    expect<unknown>((await r.binding("ses_b"))?.ultra).toEqual({ before: "high" })
  })
})

describe("ultra with the fetched Codex metadata (07 §2.9, Appendix A)", () => {
  /** The backend list of 07 Appendix A (the newer bundle), as the metadata fetch stores it. */
  async function fetched(): Promise<CodexModels.File> {
    const body: unknown = await Bun.file(
      path.join(import.meta.dir, "..", "slots", "fixture", "codex-models.json"),
    ).json()
    const rows = CodexModels.decode(body)
    if (!rows) throw new Error("fixture without a model list")
    return {
      version: 1,
      kinds: { codex: { source: "backend", fetchedAt: 1, clientVersion: "0.157.0", models: rows.models } },
    }
  }

  test("multi_agent_reasoning_effort when listed, else max, else the highest level: per model, codex only", async () => {
    const at = (id: string, providerID = CODEX_A) => ({ providerID, id, variant: "high" })
    const r = await rig(
      {
        ses_61: at("gpt-6.1-sol"),
        ses_astra: at("gpt-6-astra"),
        ses_sol: at("gpt-6-sol"),
        // ChatGPT accounts no longer run gpt-5.5 (upstream v2.1); an API key still does, under the same rule.
        ses_55: at("gpt-5.5", OAI),
        ses_siwc: at("gpt-6-astra", SIWC_A),
      },
      { meta: await fetched() },
    )
    const to = async (sessionID: string): Promise<string | null | undefined> => {
      const result = await r.ultra({ sessionID, on: true, dryRun: true })
      return "variant" in result ? result.variant.to : undefined
    }
    // 07 Appendix A: gpt-6.1-sol and gpt-6-astra xhigh, gpt-6-sol max, gpt-5.5 xhigh (it has no max).
    expect(await to("ses_61")).toBe("xhigh")
    expect(await to("ses_astra")).toBe("xhigh")
    expect(await to("ses_sol")).toBe("max")
    expect(await to("ses_55")).toBe("xhigh")
    // Sign in with ChatGPT never reads Codex metadata: max.
    expect(await to("ses_siwc")).toBe("max")
  })

  test("the fetched list wins over this PC's cache: gpt-6.1-sol is not in the cache, yet it gets xhigh", async () => {
    const without = await rig({ ses_b: { providerID: CODEX_A, id: "gpt-6.1-sol", variant: "high" } })
    expect(await without.ultra({ sessionID: "ses_b", on: true, dryRun: true })).toMatchObject({
      variant: { to: "max" },
    })
    const fetchedRig = await rig(
      { ses_b: { providerID: CODEX_A, id: "gpt-6.1-sol", variant: "high" } },
      { meta: await fetched() },
    )
    expect(await fetchedRig.ultra({ sessionID: "ses_b", on: true, dryRun: true })).toMatchObject({
      variant: { to: "xhigh" },
    })
  })
})

describe("a new main with ultra on (07 §2.9: the effort is decided again for the new model)", () => {
  /** Waits for work that runs after the session's serial job (the retune and its switch). */
  async function until(check: () => Promise<boolean>, ms = 10_000) {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error("condition not reached")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  test("Claude → gpt-6-sol: the Codex rule's max through a variant switch that keeps the cache", async () => {
    const opus = { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }
    const r = await rig({ ses_m: opus })
    await r.ultra({ sessionID: "ses_m", on: true })
    expect((await r.binding("ses_m"))?.ultra).toEqual({})
    // The switcher moved the main to gpt-6-sol with the effort it had.
    const sol = { ...SOL, variant: "high" }
    r.models.set("ses_m", sol)
    await r.send("session.model.selected", { sessionID: "ses_m", model: sol, previous: opus })
    await until(async () => r.switched.length > 0)
    expect(r.switched).toEqual([{ sessionID: "ses_m", model: { ...SOL, variant: "max" } }])
    await r.flush("ses_m")
    expect<unknown>((await r.binding("ses_m"))?.ultra).toEqual({ before: "high" })
  })

  test("gpt-6-sol → DeepSeek: max waits for the cost dialog as `pending`; confirming applies it", async () => {
    const r = await rig({ ses_d: SOL })
    await r.ultra({ sessionID: "ses_d", on: true })
    expect<unknown>((await r.binding("ses_d"))?.ultra).toEqual({ before: "high" })
    const deepseek = { providerID: DS, id: "deepseek-v4-pro", variant: "high" }
    r.models.set("ses_d", deepseek)
    await r.send("session.model.selected", {
      sessionID: "ses_d",
      model: deepseek,
      previous: { ...SOL, variant: "max" },
    })
    await until(async () => (await r.binding("ses_d"))?.ultra?.pending !== undefined)
    expect<unknown>((await r.binding("ses_d"))?.ultra).toEqual({ before: "high", pending: "max" })
    expect(r.switched).toHaveLength(1)
    // The client's cost dialog, then 켜기: the switch, and nothing pending any more.
    const confirmed = await r.ultra({ sessionID: "ses_d", on: true })
    expect(confirmed).toMatchObject({ on: true, variant: { from: "high", to: "max" } })
    expect(r.switched.at(-1)).toEqual({ sessionID: "ses_d", model: { ...deepseek, variant: "max" } })
    expect<unknown>((await r.binding("ses_d"))?.ultra).toEqual({ before: "high" })
  })

  test("a new model where ultra already runs its effort switches nothing", async () => {
    const r = await rig({ ses_b: SOL })
    await r.ultra({ sessionID: "ses_b", on: true })
    const next = { providerID: CODEX_A, id: "gpt-6.1-sol", variant: "max" }
    r.models.set("ses_b", next)
    await r.send("session.model.selected", { sessionID: "ses_b", model: next, previous: { ...SOL, variant: "max" } })
    await r.flush("ses_b")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.switched).toHaveLength(1)
    expect<unknown>((await r.binding("ses_b"))?.ultra).toEqual({ before: "high" })
  })
})

describe("ultra elsewhere (07 §2.9)", () => {
  test("Claude keeps its effort unless raised to xhigh; any effort change keeps ultra on, the user's from then on", async () => {
    const opus = { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }
    const r = await rig({ ses_c: opus })
    expect(await r.ultra({ sessionID: "ses_c", on: true })).toMatchObject({
      on: true,
      variant: { from: "high", to: "high" },
      estimate: null,
    })
    expect(r.switched).toEqual([])
    expect((await r.binding("ses_c"))?.ultra).toEqual({})
    expect(await r.ultra({ sessionID: "ses_c", on: true, raiseClaude: true })).toMatchObject({
      variant: { from: "high", to: "xhigh" },
    })
    expect<unknown>((await r.binding("ses_c"))?.ultra).toEqual({ raiseClaude: true, before: "high" })
    // ultra's own switch to xhigh (seen again) keeps what it raised.
    await r.send("session.model.selected", {
      sessionID: "ses_c",
      model: { ...opus, variant: "xhigh" },
      previous: { ...opus, variant: "high" },
    })
    await r.flush("ses_c")
    expect<unknown>((await r.binding("ses_c"))?.ultra).toEqual({ raiseClaude: true, before: "high" })
    // UC 2026-10-18: the user's own pick with ultra on stays on, and is the effort turning ultra off keeps.
    r.models.set("ses_c", { ...opus, variant: "low" })
    await r.send("session.model.selected", {
      sessionID: "ses_c",
      model: { ...opus, variant: "low" },
      previous: { ...opus, variant: "xhigh" },
    })
    await r.flush("ses_c")
    expect<unknown>((await r.binding("ses_c"))?.ultra).toEqual({})
    expect(await r.ultra({ sessionID: "ses_c", on: false, dryRun: true })).toMatchObject({
      variant: { from: "low", to: "low" },
      estimate: null,
    })
  })

  test("UC 2026-10-18: Claude's raise never lowers the effort (max stays max)", async () => {
    const opus = { providerID: "anthropic", id: "claude-opus-5-5", variant: "max" }
    const r = await rig({ ses_m: opus })
    expect(await r.ultra({ sessionID: "ses_m", on: true, raiseClaude: true })).toMatchObject({
      on: true,
      variant: { from: "max", to: "max" },
      estimate: null,
    })
    expect(r.switched).toEqual([])
    expect<unknown>((await r.binding("ses_m"))?.ultra).toEqual({ raiseClaude: true })
  })

  test("DeepSeek gets the xhigh intent fitted to its levels: max", async () => {
    const r = await rig({ ses_d: { providerID: DS, id: "deepseek-v4-pro", variant: "high" } })
    expect(await r.ultra({ sessionID: "ses_d", on: true, dryRun: true })).toMatchObject({
      variant: { from: "high", to: "max" },
    })
  })

  test("new sessions start with ultra off, whatever the last session did", async () => {
    const r = await rig({ ses_a: SOL })
    await r.ultra({ sessionID: "ses_a", on: true })
    r.models.set("ses_new", SOL)
    await r.send("session.created", {
      sessionID: "ses_new",
      model: SOL,
      projectID: "p",
      slug: "s",
      version: "2",
      location: { directory: WORKSPACE },
    })
    await r.flush("ses_new")
    expect(await r.binding("ses_new")).toMatchObject({ presetID: "builtin:codex" })
    expect((await r.binding("ses_new"))?.ultra).toBeUndefined()
  })
})

describe("refused switches (07 §2.9)", () => {
  test("switching's declared errors come back as ultra.set's own, and ultra stays off", async () => {
    const declined: Partial<Switching.Api> = {
      estimate: async (_input, context) => context.error("no_eligible_target", "target_unusable", { reasons: ["x"] }),
    }
    const r = await rig({ ses_a: SOL }, { switching: declined })
    expect(failure(await r.ultra({ sessionID: "ses_a", on: true }))).toMatchObject({
      type: "no_eligible_target",
      data: { reasons: ["x"] },
    })
    const team: Partial<Switching.Api> = {
      estimate: async (_input, context) => context.error("team_switch_required", "team", { teamID: "tm_1" }),
    }
    const s = await rig({ ses_a: SOL }, { switching: team })
    expect(failure(await s.ultra({ sessionID: "ses_a", on: true }))).toMatchObject({ type: "internal_error" })
    expect(await r.binding("ses_a")).toBeUndefined()
    expect(await s.binding("ses_a")).toBeUndefined()
  })
})

describe("survives (07 §2.9)", () => {
  test("only an effort change on the same model ends ultra, and never on Claude", () => {
    const max = { ...SOL, variant: "max" }
    expect(PresetUltra.survives("codex", max, { ...SOL, variant: "low" }, "max")).toBe(false)
    expect(PresetUltra.survives("codex", max, max, "max")).toBe(true)
    expect(PresetUltra.survives("codex", max, { ...max, id: "gpt-6.1-sol" }, "max")).toBe(true)
    expect(PresetUltra.survives("claude-sub", max, { ...SOL, variant: "low" }, "max")).toBe(true)
    expect(PresetUltra.survives("ds", undefined, { ...SOL, variant: "low" }, "max")).toBe(true)
    expect(Preset.ultraEffort("codex", ["low", "max", "ultra"]).variant).toBe("max")
  })
})

describe("a per-call effort with ultra on (07 §2.3, §2.9)", () => {
  test("#low beats ultra's effort for that subagent; the main and a plain call keep ultra's max", async () => {
    const r = await rig({ ses_a: SOL })
    await r.ultra({ sessionID: "ses_a", on: true })
    expect(r.models.get("ses_a")).toEqual({ ...SOL, variant: "max" })
    const call = (model?: string) => ({
      tool: "subagent",
      sessionID: "ses_a",
      id: `call_ultra_${model ?? "plain"}`,
      input: { agent: "general", description: "Look", prompt: "Look around", ...(model ? { model } : {}) } as unknown,
    })
    const low = call("#low")
    await r.modules.presets.onToolBefore(low)
    expect(low.input).toMatchObject({ agent: "general", model: `${CODEX_A}/gpt-6-sol#low` })
    // Without an effort the call inherits the parent's Ref (core): ultra's max.
    const plain = call()
    await r.modules.presets.onToolBefore(plain)
    expect(plain.input).not.toHaveProperty("model")
    expect(r.models.get("ses_a")).toEqual({ ...SOL, variant: "max" })
  })
})

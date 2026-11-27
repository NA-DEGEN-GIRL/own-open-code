// The binding and the own.harness handlers over an in-memory fake of `ctx.session` and `ctx.rpc`.
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { SessionID } from "@opencode/schema/session-id"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect, Schema, Scope } from "effect"
import { Custom } from "../../src/custom.js"
import { Defaults } from "../../src/defaults.js"
import { Gate } from "../../src/gate.js"
import { Notice } from "../../src/notice.js"
import { Options } from "../../src/options.js"
import { Prompts } from "../../src/prompts.js"
import { HarnessRpc } from "../../src/rpc.js"
import { Sessions } from "../../src/sessions.js"

type Handler = (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>

const ROOT = SessionID.make("ses_harness_root_aaaaaaaaaaaa")
const CHILD = SessionID.make("ses_harness_child_aaaaaaaaaaa")
const OLD = SessionID.make("ses_harness_old_aaaaaaaaaaaaa")

function fake(initial: Record<string, Record<string, unknown> | undefined>, tools: ReadonlyArray<Record<string, unknown>> = []) {
  const metadata = new Map(Object.entries(initial))
  const synthetic: Array<Record<string, unknown>> = []
  const events: Array<readonly [string, unknown]> = []
  const handlers: Record<string, Handler> = {}
  const stored = new Map<string, unknown>()
  const ctx = {
    model: {
      list: () =>
        Effect.succeed({
          data: [
            { providerID: "own-codex-a", id: "gpt-6-astra", enabled: true },
            { providerID: "own-codex-b", id: "gpt-6-astra", enabled: true },
            { providerID: "own-ds-a", id: "deepseek-v4-pro", enabled: true },
          ],
        }),
    },
    storage: {
      get: (key: string) => Effect.sync(() => stored.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
      remove: (key: string) => Effect.sync(() => void stored.delete(key)),
    },
    session: {
      get: (input: { sessionID: string }) =>
        metadata.has(input.sessionID)
          ? Effect.succeed({ id: input.sessionID, metadata: metadata.get(input.sessionID) })
          : Effect.fail({ _tag: "NotFound" }),
      update: (input: { sessionID: string; metadata: Record<string, unknown> }) =>
        Effect.sync(() => void metadata.set(input.sessionID, input.metadata)),
      synthetic: (input: Record<string, unknown>) => Effect.sync(() => void synthetic.push(input)),
    },
    tool: { list: () => Effect.succeed(tools) },
    agent: { list: () => Effect.succeed({ data: [] }) },
    rpc: {
      register: (_: unknown, registered: Record<string, Handler>) =>
        Effect.sync(() => {
          Object.assign(handlers, registered)
          return {
            dispose: Effect.void,
            events: { emit: (name: string, data: unknown) => Effect.sync(() => void events.push([name, data])) },
          }
        }),
    },
  } as unknown as Pick<Context, "rpc" | "session" | "model" | "storage" | "tool" | "location" | "agent">
  const context = {
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  }
  const call = (method: string, input: unknown) => Effect.runPromise(Effect.flip(handlers[method]!(input, context)))
  const ok = (method: string, input: unknown) => Effect.runPromise(handlers[method]!(input, context))
  return { ctx, metadata, synthetic, events, call, ok }
}

/** The plugin options' defaults, as index.ts hands them to the handlers. */
const OPTIONS = Schema.decodeUnknownSync(Options.Info)({})

async function registered(env: ReturnType<typeof fake>, busy: ReadonlyArray<string> = []) {
  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(
    HarnessRpc.register(env.ctx, {
      defaults: { harness: OPTIONS.default, prompt: OPTIONS.prompt },
      busy: (id) => busy.includes(id),
      compactionFallback: ["gpt-6-astra", "deepseek-v4-pro"],
    }).pipe(Scope.provide(scope)),
  )
  return env
}

describe("Sessions.stamp", () => {
  test("a new top-level session without the key gets the default and keeps other keys", async () => {
    const env = fake({ [ROOT]: { "own.preset": "p1" } })
    await Effect.runPromise(
      Sessions.stamp(env.ctx, { sessionID: ROOT, metadata: { "own.preset": "p1" } }, "codex", "reference"),
    )
    expect(env.metadata.get(ROOT)).toEqual({ "own.preset": "p1", "own.harness": { id: "codex", v: 1 } })
  })

  test("the default prompt variant goes with the default harness; a child inherits its parent's variant", async () => {
    const env = fake({ [ROOT]: {}, [CHILD]: { "own.team": 1 } })
    await Effect.runPromise(Sessions.stamp(env.ctx, { sessionID: ROOT, metadata: {} }, "pi", "own"))
    expect(env.metadata.get(ROOT)).toEqual({ "own.harness": { id: "pi", v: 1, prompt: "own" } })
    await Effect.runPromise(
      Sessions.stamp(env.ctx, { sessionID: CHILD, parentID: ROOT, metadata: {} }, "codex", "reference"),
    )
    expect(env.metadata.get(CHILD)).toEqual({ "own.team": 1, "own.harness": { id: "pi", v: 1, prompt: "own" } })
  })

  test("a child without the key gets its parent's harness, the fallback for a parent made before own.harness", async () => {
    const env = fake({ [OLD]: {}, [CHILD]: { "own.team": 1 } })
    await Effect.runPromise(
      Sessions.stamp(env.ctx, { sessionID: CHILD, parentID: OLD, metadata: {} }, "codex", "reference"),
    )
    expect(env.metadata.get(CHILD)).toEqual({ "own.team": 1, "own.harness": { id: "opencode", v: 1 } })
  })

  test("a session that names a harness is left alone", async () => {
    const env = fake({ [ROOT]: { "own.harness": { id: "opencode", v: 1 } } })
    const created = { sessionID: ROOT, metadata: { "own.harness": { id: "opencode", v: 1 } } }
    await Effect.runPromise(Sessions.stamp(env.ctx, created, "codex", "own"))
    expect(env.metadata.get(ROOT)).toEqual({ "own.harness": { id: "opencode", v: 1 } })
  })
})

describe("own.harness handlers", () => {
  test("list answers the known harnesses and the default", async () => {
    const env = await registered(fake({}))
    expect(await env.ok("list", {})).toEqual({
      // `claude-code` (2026-10-31) is offered everywhere: elsewhere than on Claude Agent it runs as `opencode`.
      harnesses: ["opencode", "codex", "pi", "dsh", "claude-code"],
      default: "codex",
      prompts: ["reference", "own", "custom"],
      // H-D7 (amended 2026-10-17): new top-level sessions start on own's revision.
      defaultPrompt: "own",
      // No 내 지시문 saved yet (10 §3.11).
      custom: [],
      buildId: "dev",
      version: "0.0.0-dev",
    })
  })

  test("omo is offered only where own-omo's gated tools are registered, and refused elsewhere (15 §2.2)", async () => {
    const without = await registered(fake({ [ROOT]: {} }))
    expect(((await without.ok("list", {})) as { harnesses: ReadonlyArray<string> }).harnesses).not.toContain("omo")
    expect(await without.call("session.set", { sessionID: ROOT, harness: "omo" })).toMatchObject({
      type: "harness_unavailable",
      data: { harness: "omo" },
    })
    expect(await without.call("defaults.set", { harness: "omo", prompt: "own" })).toMatchObject({
      type: "harness_unavailable",
    })
    expect(without.metadata.get(ROOT)).toEqual({})
    const omo = await registered(
      fake({ [ROOT]: {} }, [{ id: "omo_todowrite", name: "omo_todowrite", options: { permission: Gate.OMO_ACTION } }]),
    )
    expect(((await omo.ok("list", {})) as { harnesses: ReadonlyArray<string> }).harnesses).toEqual([
      "opencode",
      "codex",
      "pi",
      "dsh",
      "omo",
      "claude-code",
    ])
    await omo.ok("session.set", { sessionID: ROOT, harness: "omo" })
    expect(omo.metadata.get(ROOT)).toEqual({ "own.harness": { id: "omo", v: 1 } })
  })

  test("defaults.set: list answers the stored choice and new top-level sessions get it; children still inherit", async () => {
    const env = await registered(fake({ [ROOT]: {}, [OLD]: { "own.harness": { id: "codex", v: 1 } }, [CHILD]: {} }))
    const options = { harness: OPTIONS.default, prompt: OPTIONS.prompt }
    expect(await Effect.runPromise(Defaults.read(env.ctx, options))).toEqual(options)
    expect(await env.ok("defaults.set", { harness: "pi", prompt: "own" })).toMatchObject({
      default: "pi",
      defaultPrompt: "own",
    })
    expect(await env.ok("list", {})).toMatchObject({ default: "pi", defaultPrompt: "own" })
    // index.ts stamps every session.created with what Defaults.read answers.
    const current = await Effect.runPromise(Defaults.read(env.ctx, options))
    await Effect.runPromise(Sessions.stamp(env.ctx, { sessionID: ROOT, metadata: {} }, current.harness, current.prompt))
    expect(env.metadata.get(ROOT)).toEqual({ "own.harness": { id: "pi", v: 1, prompt: "own" } })
    await Effect.runPromise(
      Sessions.stamp(env.ctx, { sessionID: CHILD, parentID: OLD, metadata: {} }, current.harness, current.prompt),
    )
    expect(env.metadata.get(CHILD)).toEqual({ "own.harness": { id: "codex", v: 1 } })
  })

  test("defaults.set stores only what differs from the plugin options, so the rest follows the plugin's default", async () => {
    const env = await registered(fake({}))
    // Settings' harness row sends the prompt it shows: the plugin's `own`, which is not stored.
    await env.ok("defaults.set", { harness: "pi", prompt: "own" })
    expect(await Effect.runPromise(env.ctx.storage.get("defaults"))).toEqual({ version: 2, harness: "pi" })
    expect(await Effect.runPromise(Defaults.read(env.ctx, { harness: "codex", prompt: "reference" }))).toEqual({
      harness: "pi",
      prompt: "reference",
    })
    // The original picked on purpose stays through a later harness change.
    await env.ok("defaults.set", { harness: "pi", prompt: "reference" })
    await env.ok("defaults.set", { harness: "codex", prompt: "reference" })
    expect(await Effect.runPromise(env.ctx.storage.get("defaults"))).toEqual({ version: 2, prompt: "reference" })
    expect(await env.ok("list", {})).toMatchObject({ default: "codex", defaultPrompt: "reference" })
  })

  test("a record from before 2026-10-17 keeps its harness, and its prompt only when it is own's revision", async () => {
    const env = await registered(fake({}))
    await Effect.runPromise(env.ctx.storage.set("defaults", { harness: "pi", prompt: "reference" }))
    expect(await env.ok("list", {})).toMatchObject({ default: "pi", defaultPrompt: "own" })
    const options = { harness: "codex", prompt: "reference" } as const
    await Effect.runPromise(env.ctx.storage.set("defaults", { harness: "opencode", prompt: "own" }))
    expect(await Effect.runPromise(Defaults.read(env.ctx, options))).toEqual({ harness: "opencode", prompt: "own" })
  })

  test("stored defaults that fail to decode fall back to the plugin options", async () => {
    const env = await registered(fake({}))
    await Effect.runPromise(env.ctx.storage.set("defaults", { harness: "claude", prompt: "own" }))
    expect(await env.ok("list", {})).toMatchObject({ default: "codex", defaultPrompt: "own" })
  })

  test("session.get: a session made before own.harness runs opencode implicitly", async () => {
    const env = await registered(fake({ [OLD]: undefined }))
    expect(await env.ok("session.get", { sessionID: OLD })).toEqual({
      sessionID: OLD,
      harness: "opencode",
      explicit: false,
      prompt: "reference",
    })
    expect(await env.call("session.get", { sessionID: ROOT })).toMatchObject({ type: "session_not_found" })
  })

  test("session.set switches, records one notice that waits for the next prompt, and emits the change", async () => {
    const env = await registered(fake({ [OLD]: { "own.preset": "p1" } }))
    expect(await env.ok("session.set", { sessionID: OLD, harness: "codex" })).toEqual({
      sessionID: OLD,
      harness: "codex",
      explicit: true,
      prompt: "reference",
    })
    expect(env.metadata.get(OLD)).toEqual({ "own.preset": "p1", "own.harness": OwnHarness.value("codex") })
    expect(env.synthetic).toEqual([
      {
        sessionID: OLD,
        text: Notice.text("opencode", "codex"),
        description: "Harness: opencode → codex",
        metadata: { "own.harness": { switch: { from: "opencode", to: "codex" } } },
        delivery: "steer",
        resume: false,
      },
    ])
    expect(env.events).toEqual([
      ["session.changed", { sessionID: OLD, harness: "codex", previous: "opencode", prompt: "reference" }],
    ])
  })

  test("session.set with only another prompt variant rewrites the key without a notice; leaving it out keeps it", async () => {
    const env = await registered(fake({ [ROOT]: { "own.harness": { id: "codex", v: 1 } } }))
    expect(await env.ok("session.set", { sessionID: ROOT, harness: "codex", prompt: "own" })).toEqual({
      sessionID: ROOT,
      harness: "codex",
      explicit: true,
      prompt: "own",
    })
    expect(env.metadata.get(ROOT)).toEqual({ "own.harness": { id: "codex", v: 1, prompt: "own" } })
    expect(env.synthetic).toEqual([])
    expect(env.events).toEqual([
      ["session.changed", { sessionID: ROOT, harness: "codex", previous: "codex", prompt: "own" }],
    ])
    await env.ok("session.set", { sessionID: ROOT, harness: "pi" })
    expect(env.metadata.get(ROOT)).toEqual({ "own.harness": { id: "pi", v: 1, prompt: "own" } })
    await env.ok("session.set", { sessionID: ROOT, harness: "pi", prompt: "reference" })
    expect(env.metadata.get(ROOT)).toEqual({ "own.harness": { id: "pi", v: 1 } })
  })

  test("setting the implicit harness only writes the key; setting it again changes nothing", async () => {
    const env = await registered(fake({ [OLD]: undefined }))
    await env.ok("session.set", { sessionID: OLD, harness: "opencode" })
    expect(env.metadata.get(OLD)).toEqual({ "own.harness": OwnHarness.value("opencode") })
    await env.ok("session.set", { sessionID: OLD, harness: "opencode" })
    expect(env.synthetic).toEqual([])
    expect(env.events).toEqual([])
  })

  test("a running session refuses the switch", async () => {
    const env = await registered(fake({ [ROOT]: {} }), [ROOT])
    expect(await env.call("session.set", { sessionID: ROOT, harness: "opencode" })).toMatchObject({
      type: "session_busy",
    })
    expect(env.metadata.get(ROOT)).toEqual({})
  })
})

describe("compaction fallback (own.harness compaction.get/set)", () => {
  test("automatic until the user chooses; null returns to automatic", async () => {
    const env = await registered(fake({}))
    expect(await env.ok("compaction.get", {})).toEqual({
      automatic: true,
      models: [
        { providerID: "own-codex-a", modelID: "gpt-6-astra" },
        { providerID: "own-codex-b", modelID: "gpt-6-astra" },
        { providerID: "own-ds-a", modelID: "deepseek-v4-pro" },
      ],
    })
    const chosen = [{ providerID: "own-ds-a", modelID: "deepseek-v4-pro" }]
    expect(await env.ok("compaction.set", { models: chosen })).toEqual({ automatic: false, models: chosen })
    expect(await env.ok("compaction.get", {})).toEqual({ automatic: false, models: chosen })
    expect((await env.ok("compaction.set", { models: null })) as { automatic: boolean }).toMatchObject({
      automatic: true,
    })
  })
})

describe("하위 에이전트 (own.harness prompt.subagent, 10 §3.11)", () => {
  test("answers core's view for OpenCode 기본: the registered subagent tool, the first line and the cut", async () => {
    const env = await registered(fake({}, [{ id: "subagent", description: "Spawns an agent." }]))
    expect(await env.ok("prompt.subagent", {})).toEqual({
      kind: "core",
      tool: { name: "subagent", description: "Spawns an agent." },
      opening: Prompts.OPENING,
      guidance: "",
      cut: Prompts.CUT,
    })
  })
})

describe("내 지시문 (own.harness prompt.custom.set, 10 §3.11)", () => {
  test("saving lists the harness; null deletes it; blanks and overlong texts are refused and nothing is stored", async () => {
    const env = await registered(fake({}))
    expect(await env.ok("prompt.custom.set", { harness: "codex", text: "Answer in Korean." })).toMatchObject({
      custom: ["codex"],
    })
    expect(await env.ok("list", {})).toMatchObject({ custom: ["codex"] })
    expect(await env.call("prompt.custom.set", { harness: "pi", text: "  \n" })).toEqual({
      type: "prompt_invalid",
      message: "the 내 지시문 text cannot be saved",
      data: { reason: "empty", limit: Custom.LIMIT },
    })
    expect(await env.call("prompt.custom.set", { harness: "pi", text: "x".repeat(Custom.LIMIT + 1) })).toMatchObject({
      data: { reason: "too_long" },
    })
    expect(await env.ok("list", {})).toMatchObject({ custom: ["codex"] })
    expect(await env.ok("prompt.custom.set", { harness: "codex", text: null })).toMatchObject({ custom: [] })
  })

  test("내 지시문 can be the new-session default, and a session keeps `custom` in its key", async () => {
    const env = await registered(fake({ [ROOT]: {} }))
    expect(await env.ok("defaults.set", { harness: "codex", prompt: "custom" })).toMatchObject({
      defaultPrompt: "custom",
    })
    const current = await Effect.runPromise(
      Defaults.read(env.ctx, { harness: OPTIONS.default, prompt: OPTIONS.prompt }),
    )
    await Effect.runPromise(Sessions.stamp(env.ctx, { sessionID: ROOT, metadata: {} }, current.harness, current.prompt))
    expect(env.metadata.get(ROOT)).toEqual({ "own.harness": { id: "codex", v: 1, prompt: "custom" } })
  })
})

describe("Gate.rules", () => {
  const other = { action: "edit", resource: "**", effect: "allow" as const }

  test("each harness's allow rule, at the end, and no other harness's", () => {
    expect(Gate.rules([other], "codex")).toEqual([other, Gate.ALLOW])
    expect(Gate.rules([other, Gate.ALLOW], "pi")).toEqual([other, Gate.PI_ALLOW])
    expect(Gate.rules([Gate.PI_ALLOW, other], "opencode")).toEqual([other])
    expect(Gate.rules(undefined, "pi")).toEqual([Gate.PI_ALLOW])
  })

  test("omo sessions allow own-omo's tools; switching away drops the allow (15 §2.2)", () => {
    expect(Gate.rules([other], "omo")).toEqual([other, Gate.OMO_ALLOW])
    expect(Gate.rules([other, Gate.OMO_ALLOW], "codex")).toEqual([other, Gate.ALLOW])
    expect(Gate.rules([Gate.OMO_ALLOW, other], "opencode")).toEqual([other])
    expect(Gate.OMO_DENY).toEqual({ action: "own_harness_omo", resource: "*", effect: "deny" })
  })
})

describe("Gate.holds and Sessions.heal (a rule write that lost the gate)", () => {
  const other = { action: "edit", resource: "**", effect: "allow" as const }
  const bound = { [OwnHarness.META_KEY]: OwnHarness.value("codex", "own") }
  const HERE = path.resolve("project-a")

  test("holds: the harness's allow anywhere and no other harness's; a harness without tools holds none", () => {
    expect(Gate.holds([Gate.ALLOW, other], "codex")).toBe(true)
    expect(Gate.holds([other], "codex")).toBe(false)
    expect(Gate.holds([other, Gate.ALLOW, Gate.PI_ALLOW], "codex")).toBe(false)
    expect(Gate.holds([other], "opencode")).toBe(true)
    expect(Gate.holds([Gate.ALLOW], "opencode")).toBe(false)
  })

  function store(metadata: Record<string, unknown> | undefined, permissions: ReadonlyArray<Record<string, unknown>>) {
    const state = { permissions, writes: 0 }
    const ctx = {
      session: {
        get: () => Effect.succeed({ id: ROOT, location: { directory: HERE }, metadata, permissions: state.permissions }),
        update: (input: { permissions: ReadonlyArray<Record<string, unknown>> }) =>
          Effect.sync(() => {
            state.permissions = input.permissions
            state.writes += 1
          }),
      },
    } as unknown as Pick<Context, "session">
    return { ctx, state }
  }

  test("a bound session whose approval write dropped the gate gets it back, and the other rules stay", async () => {
    const env = store(bound, [other])
    expect(await Effect.runPromise(Sessions.heal(env.ctx, ROOT, HERE))).toBe(true)
    expect(env.state.permissions).toEqual([other, Gate.ALLOW])
    expect(await Effect.runPromise(Sessions.heal(env.ctx, ROOT, HERE))).toBe(false)
    expect(env.state.writes).toBe(1)
  })

  test("a gate that is there, wherever it is, and a session bound to no harness are never written", async () => {
    const kept = store(bound, [Gate.ALLOW, other])
    expect(await Effect.runPromise(Sessions.heal(kept.ctx, ROOT, HERE))).toBe(false)
    const unbound = store({}, [other])
    expect(await Effect.runPromise(Sessions.heal(unbound.ctx, ROOT, HERE))).toBe(false)
    expect(kept.state.writes + unbound.state.writes).toBe(0)
  })

  test("only the session's own Location writes: every Location sees the event", async () => {
    const env = store(bound, [other])
    expect(await Effect.runPromise(Sessions.heal(env.ctx, ROOT, path.resolve("project-b")))).toBe(false)
    expect(env.state.writes).toBe(0)
  })
})

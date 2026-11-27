// Subagent caps through the gate (07 §2.6, §2.9, §5.4 steps 5–6): the caps in force (preset, ultra with the global and
// the preset's ultra level), the running count (busy children + reservations in the runtime's map), per user message
// with `raiseOnce`, per conversation in KV `presetUsage`, and N parallel calls of one step. Real slots, presets and
// telemetry modules on a temp OWN_HOME over the 2026-10-01 catalog fixture; sessions and agents are fakes.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Kv, Preset } from "@own/protocol"
import { Modules } from "../../src/modules.js"
import { Gate } from "../../src/presets/gate.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { fakeEditor, memoryStorage } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { ANTHROPIC, CLAUDE_ON, CODEX_A, DEEPSEEK, OPENAI, registry } from "./fixtures/catalog-2026-10-01.js"
import { messagesOver } from "../support/session-messages.js"

const ROOT = "ses_caps_root"
const DIRECTORY = "D:/work"
const MAIN = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const PRESET_ID = "pr_01JB0000000000000000000021"

const decodePreset = Schema.decodeUnknownSync(Preset.Info)

function preset(fields: Partial<Record<"caps" | "ultraCaps" | "delegation", unknown>>): Preset.Info {
  return decodePreset({ ...Preset.builtin("codex"), id: PRESET_ID, name: "많이 맡기기", ...fields })
}

interface Input {
  readonly preset?: Preset.Info
  readonly ultra?: boolean
  /** `presets.json` `ultraCaps`, the global ultra level. */
  readonly level?: Preset.UltraCaps
  /** `presets.json`'s version: 2 (this build's) unless a test writes an older file. */
  readonly version?: 1 | 2
}

async function setup(input: Input = {}) {
  const sessions = new Map<string, Readonly<Record<string, unknown>>>()
  const messages = { value: [{ id: "msg_caps_1", type: "user" }] as Array<{ id: string; type: string }> }
  const kv = memoryStorage()
  const t = await testDeps({
    directory: DIRECTORY,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }) },
      storage: kv.storage,
      session: {
        get: async (request: { readonly sessionID: string }) => {
          const found = sessions.get(request.sessionID)
          if (!found) throw new Error(`session not found: ${request.sessionID}`)
          return { ...found, location: { directory: DIRECTORY } }
        },
        context: async () => messages.value,
        messages: messagesOver(() => messages.value),
      },
      agent: {
        get: async (request: { readonly agentID: string }) => ({
          location: { directory: DIRECTORY },
          data: { id: request.agentID },
        }),
      },
    },
  })
  await t.deps.runtime.registry.write(await registry())
  const stored = input.preset
  // Written as an older build left it: the runtime store reads and writes it through `Preset.upgrade`.
  await Bun.write(
    t.deps.runtime.presets.file,
    JSON.stringify({
      version: input.version ?? 2,
      groups: stored ? { codex: { presets: [Schema.encodeSync(Preset.Info)(stored)] } } : {},
      ...(input.level === undefined ? {} : { ultraCaps: input.level }),
    }),
  )
  const alerts: Telemetry.AlertInput[] = []
  const modules = t.modules({
    plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
  })
  await modules.slots.start()
  await modules.presets.start()
  modules.slots.transformProviders(
    fakeEditor({ openai: { models: OPENAI }, anthropic: { models: ANTHROPIC }, deepseek: { models: DEEPSEEK } }).editor,
  )
  sessions.set(ROOT, { id: ROOT, agent: "build", model: MAIN })
  t.deps.runtime.sessions.update(ROOT, { busy: true })
  await kv.storage.set(Kv.preset(ROOT), {
    presetID: stored?.id ?? Preset.builtinID("codex"),
    group: "codex",
    revision: 0,
    appliedAt: t.clock.now(),
    entryHash: null,
    ...(input.ultra ? { ultra: { before: "high" } } : {}),
  })
  const calls = { next: 0 }
  const after = Gate.after(t.deps)
  return {
    t,
    kv,
    alerts,
    sessions,
    messages,
    /** One subagent call of the root (a new child unless `sessionID` is given). */
    gate: async (call: Readonly<Record<string, unknown>> = {}) => {
      const event = {
        tool: "subagent",
        sessionID: ROOT,
        id: `call_caps_${++calls.next}`,
        input: { agent: "general", description: "Look", prompt: "Find it", ...call } as unknown,
      }
      await modules.presets.onToolBefore(event)
      return event
    },
    /** `execute.after` of a call: completed, or failed before a child ran. */
    after: (event: { readonly id: string }, failed = false) =>
      after(
        failed
          ? { tool: "subagent", sessionID: ROOT, id: event.id, status: "error" }
          : { tool: "subagent", sessionID: ROOT, id: event.id, status: "completed", result: { content: "done" } },
      ),
    /** A child of the root that runs now (core's `session.created` and `session.execution.started`). */
    running: (childID: string) => {
      t.deps.runtime.sessions.update(childID, { parentID: ROOT })
      t.deps.runtime.sessions.update(childID, { busy: true })
    },
    async [Symbol.asyncDispose]() {
      await modules.presets.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

const agentOf = (event: { readonly input: unknown }) => (event.input as { readonly agent: string }).agent
const passed = (events: ReadonlyArray<{ readonly input: unknown }>) =>
  events.filter((event) => !agentOf(event).startsWith(Preset.REJECT_PREFIX)).length

describe("the running cap (07 §2.6)", () => {
  test("N parallel calls of one step never exceed it; the rest are declined at once, never awaited", async () => {
    await using s = await setup()
    const events = await Promise.all(Array.from({ length: 8 }, () => s.gate()))
    expect(passed(events)).toBe(3)
    const declined = Preset.rejection({ reason: "caps", cap: "concurrent", max: 3 })
    expect(events.filter((event) => agentOf(event) === declined)).toHaveLength(5)
    expect(s.alerts.map((alert) => [alert.code, alert.subject])).toEqual(
      Array.from({ length: 5 }, () => ["subagent_rejected", "caps:general"]),
    )
    expect(s.t.deps.runtime.reservations.counts(ROOT)).toMatchObject({ running: 3, message: 3, session: 3 })
  })

  test("busy children count; a child showing up replaces its reservation; a finished call frees its place", async () => {
    await using s = await setup()
    s.running("ses_caps_old_1")
    s.running("ses_caps_old_2")
    const first = await s.gate()
    expect(passed([first, await s.gate()])).toBe(1)
    // The first call's child starts: still three running, and still no room.
    s.running("ses_caps_new")
    expect(passed([await s.gate()])).toBe(0)
    s.t.deps.runtime.sessions.update("ses_caps_old_1", { busy: false })
    await s.after(first)
    expect(passed([await s.gate()])).toBe(1)
  })

  test("a call that failed before its child ran gives its place and its counts back", async () => {
    await using s = await setup()
    const events = await Promise.all([s.gate(), s.gate(), s.gate()])
    await s.after(events[0] ?? { id: "" }, true)
    expect(s.t.deps.runtime.reservations.counts(ROOT)).toMatchObject({ running: 2, message: 2, session: 2 })
    expect(passed([await s.gate()])).toBe(1)
  })

  test("a continued child counts only while it runs: waking an idle one needs room, steering a running one never", async () => {
    await using s = await setup({ preset: preset({ caps: { concurrent: 1, perMessage: 6, perSession: 100 } }) })
    s.sessions.set("ses_caps_idle", { id: "ses_caps_idle", parentID: ROOT, model: MAIN })
    s.t.deps.runtime.sessions.update("ses_caps_idle", { parentID: ROOT })
    s.running("ses_caps_busy")
    s.sessions.set("ses_caps_busy", { id: "ses_caps_busy", parentID: ROOT, model: MAIN })
    expect(agentOf(await s.gate({ sessionID: "ses_caps_idle" }))).toBe(
      Preset.rejection({ reason: "caps", cap: "concurrent", max: 1 }),
    )
    expect(passed([await s.gate({ sessionID: "ses_caps_busy" })])).toBe(1)
    // Continued children are not new subagents.
    expect(s.t.deps.runtime.reservations.counts(ROOT)).toMatchObject({ message: 0, session: 0 })
  })
})

describe("per user message (07 §2.6)", () => {
  const caps = { concurrent: 50, perMessage: 2, perSession: 100 }

  test("counts the root's latest user message; a new one starts over", async () => {
    await using s = await setup({ preset: preset({ caps }) })
    expect(passed([await s.gate(), await s.gate(), await s.gate()])).toBe(2)
    expect(s.alerts.map((alert) => alert.subject)).toEqual(["caps:general"])
    // A synthetic message (a background child's completion) is no user message.
    s.messages.value = [...s.messages.value, { id: "msg_caps_synthetic", type: "synthetic" }]
    expect(passed([await s.gate()])).toBe(0)
    s.messages.value = [...s.messages.value, { id: "msg_caps_2", type: "user" }]
    expect(passed([await s.gate(), await s.gate(), await s.gate()])).toBe(2)
  })

  test("`raiseOnce` (KV presetUsage.raise) lifts the cap for that message only", async () => {
    await using s = await setup({ preset: preset({ caps }) })
    await s.kv.storage.set(Kv.presetUsage(ROOT), { perSession: 0, raise: { messageID: "msg_caps_1", perMessage: 4 } })
    expect(passed(await Promise.all(Array.from({ length: 6 }, () => s.gate())))).toBe(4)
    expect(agentOf(await s.gate())).toBe(Preset.rejection({ reason: "caps", cap: "perMessage", max: 4 }))
    s.messages.value = [{ id: "msg_caps_2", type: "user" }]
    expect(passed(await Promise.all(Array.from({ length: 4 }, () => s.gate())))).toBe(2)
  })

  test("`적극적으로` allows 12 per message when the caps were left as they were", async () => {
    await using s = await setup({ preset: preset({ delegation: "active" }) })
    const events = []
    for (const _ of Array.from({ length: 13 })) {
      const event = await s.gate()
      events.push(event)
      await s.after(event)
    }
    expect(passed(events)).toBe(12)
    expect(agentOf(events[12] ?? { input: {} })).toBe(Preset.rejection({ reason: "caps", cap: "perMessage", max: 12 }))
  })
})

describe("per conversation (07 §2.6, KV presetUsage)", () => {
  test("no cap by default: a stored count far past the old 100 refuses nothing, and the count is still kept", async () => {
    await using s = await setup()
    await s.kv.storage.set(Kv.presetUsage(ROOT), { perSession: 5000 })
    const first = await s.gate()
    expect(passed([first])).toBe(1)
    await s.after(first)
    expect(s.kv.values.get(Kv.presetUsage(ROOT))).toEqual({ perSession: 5001 })
    s.messages.value = [...s.messages.value, { id: "msg_caps_2", type: "user" }]
    expect(passed([await s.gate()])).toBe(1)
  })

  test("a cap the user set: starts from the stored count and is persisted once a call created its child", async () => {
    await using s = await setup({ preset: preset({ caps: { concurrent: 3, perMessage: 6, perSession: 100 } }) })
    await s.kv.storage.set(Kv.presetUsage(ROOT), { perSession: 99, raise: { messageID: "msg_caps_0", perMessage: 9 } })
    const first = await s.gate()
    expect(passed([first])).toBe(1)
    // The gate writes nothing before the call ran.
    expect(s.kv.values.get(Kv.presetUsage(ROOT))).toEqual({
      perSession: 99,
      raise: { messageID: "msg_caps_0", perMessage: 9 },
    })
    expect(agentOf(await s.gate())).toBe(Preset.rejection({ reason: "caps", cap: "perSession", max: 100 }))
    await s.after(first)
    // Read-merge-write: the stored raise stays.
    expect(s.kv.values.get(Kv.presetUsage(ROOT))).toEqual({
      perSession: 100,
      raise: { messageID: "msg_caps_0", perMessage: 9 },
    })
  })

  test("a version 1 presets.json's 100 was the old default: no cap; another number was typed and stays (SC-1)", async () => {
    {
      await using s = await setup({
        version: 1,
        preset: preset({ caps: { concurrent: 3, perMessage: 6, perSession: 100 } }),
      })
      await s.kv.storage.set(Kv.presetUsage(ROOT), { perSession: 100 })
      expect(passed([await s.gate()])).toBe(1)
    }
    await using s = await setup({
      version: 1,
      preset: preset({ caps: { concurrent: 3, perMessage: 6, perSession: 40 } }),
    })
    await s.kv.storage.set(Kv.presetUsage(ROOT), { perSession: 40 })
    expect(agentOf(await s.gate())).toBe(Preset.rejection({ reason: "caps", cap: "perSession", max: 40 }))
  })
})

describe("ultra (07 §2.9, §1.2)", () => {
  const parallel = async (s: Awaited<ReturnType<typeof setup>>, count: number) =>
    passed(await Promise.all(Array.from({ length: count }, () => s.gate())))

  test("on: the larger of the preset's caps and the global level, `추천` (8 · 24, no conversation cap) by default", async () => {
    await using s = await setup({ ultra: true })
    expect(await parallel(s, 10)).toBe(8)
  })

  test("the global level from presets.json (`아껴서` = 3 at once, 12 per message)", async () => {
    await using s = await setup({ ultra: true, level: "save" })
    expect(await parallel(s, 5)).toBe(3)
  })

  test("a preset's own ultra level wins over the global one (`크게` = 64 at once)", async () => {
    await using s = await setup({ ultra: true, level: "save", preset: preset({ ultraCaps: "large" }) })
    expect(await parallel(s, 70)).toBe(64)
  })

  test("off: the preset's caps", async () => {
    await using s = await setup({ level: "large" })
    expect(await parallel(s, 5)).toBe(3)
  })
})

describe("when the gate cannot decide (decision 2026-10-02)", () => {
  test("a plain inherit passes without a reservation; nothing else does", async () => {
    await using s = await setup()
    // The root has no stored model: the main is unknown.
    s.sessions.set(ROOT, { id: ROOT, agent: "build" })
    const events = await Promise.all(Array.from({ length: 5 }, () => s.gate()))
    expect(passed(events)).toBe(5)
    expect(s.t.deps.runtime.reservations.counts(ROOT)).toMatchObject({ running: 0, message: 0, session: 0 })
    expect(agentOf(await s.gate({ model: `${CODEX_A}/gpt-6-luna` }))).toBe(
      Preset.rejection({ reason: "model", roles: [] }),
    )
  })
})

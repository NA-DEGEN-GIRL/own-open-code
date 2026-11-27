// D10 runtime detection (02 §4.3, §7.7): `toolset_changed` from the tool definitions and system texts of own slot
// primary requests after own's shaping, its baselines, and the estimator's `W = 0` for cache entries written before
// the change. Requests go through the real auth module the way core makes them: the shaping hook, then
// `model.request` with the request's kind. Every credential is fake.

import { describe, expect, test } from "bun:test"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { SessionID } from "@opencode/schema/session-id"
import type { SessionContext, SessionModelRequest } from "@opencode/plugin/promise/session"
import { Auth } from "../../src/auth/auth.js"
import { Toolset } from "../../src/auth/toolset.js"
import type { Module } from "../../src/module.js"
import { Estimator } from "../../src/switching/estimator.js"
import { registryWith } from "../slots/support.js"
import { K, NOW, cache, context, seedCards, side } from "../switching/support.js"
import { authSetup, modelRequest, ref, registeredHooks } from "./support.js"

const KEY = "sk-proj-faketoolset0000000000000000000001"
const SESSION = "ses_toolset_test"
const OAI = ref("own-oai-aaaa", "gpt-5.5")
const SYSTEM = [
  "You are OpenCode.",
  "# Your Model\n- Name: GPT-5.5\n- Provider ID: own-oai-aaaa\n- Model ID: gpt-5.5",
  "<instructions>baseline</instructions>",
]
const READ = { description: "Read a file.", input: { type: "object", properties: { path: { type: "string" } } } }
const SUBAGENT = {
  description: "Run a subagent.\n\nAvailable subagents:\n- explore: Explores the code.",
  input: { type: "object", properties: { agent: { type: "string" } } },
}
const TOOLS: SessionContext["tools"] = { read: READ, subagent: SUBAGENT }
/** A custom agent added mid-session: core's subagent hook lists it in the subagent tool description. */
const WITH_PROBE: SessionContext["tools"] = {
  read: READ,
  subagent: { ...SUBAGENT, description: `${SUBAGENT.description}\n- probe: Added mid-session.` },
}

type Setup = Awaited<ReturnType<typeof authSetup>>

async function setup() {
  const registry = await registryWith([{ kind: "oai", label: "A", slug: "aaaa" }])
  const s = await authSetup({ registry })
  await s.t.deps.runtime.credentials.store("acc_aaaa", { type: "key", key: KEY })
  return s
}

function request(
  input: {
    readonly sessionID?: string
    readonly model?: Model.Ref
    readonly agent?: string
    readonly tools?: SessionContext["tools"]
    readonly system?: ReadonlyArray<string>
  } = {},
): SessionContext {
  return {
    // SAFETY: branded ids built from test literals.
    sessionID: (input.sessionID ?? SESSION) as SessionID,
    agent: (input.agent ?? "build") as Agent.ID,
    model: input.model ?? OAI,
    system: (input.system ?? SYSTEM).map((text) => ({ type: "text" as const, text })),
    messages: [],
    options: {},
    tools: structuredClone(input.tools ?? TOOLS),
  }
}

/** One request as core makes it: the shaping hook, then `model.request` with the request's kind. */
async function send(s: Setup, event: SessionContext, kind: SessionModelRequest["kind"] = "primary") {
  await s.auth.onRequestShape(event)
  await requested(s, { ...modelRequest(event.sessionID, event.model), agent: event.agent, kind })
}

/** The auth module's part of `model.request` as `Hooks.register` runs it: the comparisons, then the injection. */
async function requested(s: Setup, event: SessionModelRequest) {
  s.auth.settle(event)
  await s.auth.onModelRequest(event)
}

function toolsetAlerts(s: Setup) {
  return s.alerts.filter((alert) => alert.code === "toolset_changed")
}

function revertCommitted(sessionID: string) {
  // SAFETY: the fields the auth module reads of a `session.revert.committed` event.
  return { type: "session.revert.committed", data: { sessionID, to: "msg_to" } } as unknown as Module.OpenCodeEvent
}

describe("Toolset.fingerprint", () => {
  const system = (texts: ReadonlyArray<string>) => texts.map((text) => ({ type: "text" as const, text }))

  test("tool order and cache hints do not count; a description, an input schema or a system text does", () => {
    const base = Toolset.fingerprint({ tools: TOOLS, system: system(SYSTEM) })
    // SAFETY: structurally a 5-minute `CacheHint`, as `Shape.addHints` places it.
    const hint = { type: "ephemeral" } as NonNullable<SessionContext["system"][number]["cache"]>
    const reordered = Toolset.fingerprint({
      tools: { subagent: SUBAGENT, read: READ },
      system: system(SYSTEM).map((part, index) => (index === 0 ? { ...part, cache: hint } : part)),
    })
    expect(reordered).toEqual(base)

    const schema = { read: { ...READ, input: { type: "object" } }, subagent: SUBAGENT }
    expect(Toolset.changed(base, Toolset.fingerprint({ tools: WITH_PROBE, system: system(SYSTEM) }))).toEqual(["tools"])
    expect(Toolset.changed(base, Toolset.fingerprint({ tools: schema, system: system(SYSTEM) }))).toEqual(["tools"])
    const longer = system([...SYSTEM, "# More"])
    expect(Toolset.changed(base, Toolset.fingerprint({ tools: TOOLS, system: longer }))).toEqual(["system"])
    expect(Toolset.changed(base, Toolset.fingerprint({ tools: schema, system: longer }))).toEqual(["tools", "system"])
  })
})

describe("toolset_changed (02 §4.3 D10, §7.7)", () => {
  test("the first primary request sets the baseline; a changed tool definition raises one info alert", async () => {
    await using s = await setup()
    await send(s, request())
    await send(s, request())
    expect(toolsetAlerts(s)).toEqual([])
    expect(s.auth.toolsetChangedAt(SESSION)).toBeUndefined()

    s.t.clock.advance(1_000)
    await send(s, request({ tools: WITH_PROBE }))
    expect(toolsetAlerts(s)).toEqual([
      expect.objectContaining({
        code: "toolset_changed",
        severity: "info",
        sessionID: SESSION,
        fields: { providerID: OAI.providerID, modelID: OAI.id, agent: "build", changed: "tools" },
      }),
    ])
    expect(toolsetAlerts(s)[0]?.message).toContain("tools changed")
    expect(s.auth.toolsetChangedAt(SESSION)).toBe(s.t.clock.now())
    expect(s.auth.toolsetChangedAt("ses_other")).toBeUndefined()

    // The new definitions are the baseline now: the next request is not a change.
    await send(s, request({ tools: WITH_PROBE }))
    expect(toolsetAlerts(s)).toHaveLength(1)
  })

  test("a system change names the system; another model, agent or session has its own baseline", async () => {
    await using s = await setup()
    await send(s, request())
    await send(s, request({ system: [...SYSTEM, "# More"] }))
    expect(toolsetAlerts(s).map((alert) => alert.fields?.changed)).toEqual(["system"])
    expect(toolsetAlerts(s)[0]?.message).toContain("system changed")

    await send(s, request({ model: ref(OAI.providerID, "gpt-5.4"), tools: WITH_PROBE }))
    await send(s, request({ agent: "plan", tools: WITH_PROBE }))
    await send(s, request({ sessionID: "ses_toolset_other", tools: WITH_PROBE }))
    expect(toolsetAlerts(s)).toHaveLength(1)
  })

  test("own shaping is part of it: the D9 identity line of another slot of the kind does not count", async () => {
    const registry = await registryWith([
      { kind: "oai", label: "A", slug: "aaaa" },
      { kind: "oai", label: "B", slug: "bbbb" },
    ])
    await using s = await authSetup({ registry })
    const other = ref("own-oai-bbbb", OAI.id)
    await send(s, request({ model: other, system: SYSTEM.map((text) => text.replace("own-oai-aaaa", "own-oai-bbbb")) }))
    await send(s, request({ model: other, system: SYSTEM.map((text) => text.replace("own-oai-aaaa", "openai")) }))
    expect(toolsetAlerts(s)).toEqual([])
  })

  test("compaction and generate requests never compare; a compaction request starts a new baseline", async () => {
    await using s = await setup()
    await send(s, request())
    await send(s, request({ tools: WITH_PROBE }), "generate")
    await send(s, request())
    expect(toolsetAlerts(s)).toEqual([])

    // The completed compaction renders another instruction baseline into the system.
    const compacted = [...SYSTEM.slice(0, 2), "<instructions>after compaction</instructions>"]
    await send(s, request({ system: compacted }), "compaction")
    await send(s, request({ system: compacted }))
    await send(s, request({ system: compacted }))
    expect(toolsetAlerts(s)).toEqual([])

    // A compaction on any provider of the session forgets the own baselines too (the session left the own slot).
    await requested(s, { ...modelRequest(SESSION, ref("openai", "gpt-5.5")), kind: "compaction" })
    await send(s, request({ tools: WITH_PROBE }))
    expect(toolsetAlerts(s)).toEqual([])
  })

  test("a committed revert of this Location's session starts a new baseline", async () => {
    await using s = await setup()
    await send(s, request())
    await s.auth.onEvent?.(revertCommitted(SESSION), { local: false })
    await send(s, request({ tools: WITH_PROBE }))
    expect(toolsetAlerts(s)).toHaveLength(1)

    await s.auth.onEvent?.(revertCommitted(SESSION), { local: true })
    await send(s, request())
    await send(s, request())
    expect(toolsetAlerts(s)).toHaveLength(1)
  })

  test("other providers are never compared; a title request in between keeps the shaped request's hashes", async () => {
    await using s = await setup()
    const builtin = ref("openai", "gpt-5.5")
    await send(s, request({ model: builtin }))
    await send(s, request({ model: builtin, tools: WITH_PROBE }))
    expect(toolsetAlerts(s)).toEqual([])

    await send(s, request())
    const changed = request({ tools: WITH_PROBE })
    await s.auth.onRequestShape(changed)
    await requested(s, { ...modelRequest(SESSION, OAI), kind: "title" })
    await requested(s, modelRequest(SESSION, OAI))
    expect(toolsetAlerts(s)).toHaveLength(1)
  })

  test("a failing alert never keeps the credential off the request: the hooks settle in a guard of their own", async () => {
    await using s = await setup()
    const hooks = await registeredHooks(s)
    await send(s, request())
    await hooks.get("context")?.(request({ tools: WITH_PROBE }))
    s.failAlerts.value = true
    const event = modelRequest(SESSION, OAI)
    await hooks.get("model.request")?.(event)
    expect(event.headers).toEqual({ "x-session-affinity": SESSION, authorization: `Bearer ${KEY}` })
    expect(s.logs.some((line) => line.includes("hook_failed") && line.includes("model.request:settle"))).toBe(true)
  })

  test("baselines are bounded like the other per-session memory: the oldest session is forgotten first", async () => {
    await using s = await setup()
    // No credential work: the D10 comparison runs before the injection.
    s.trust.value = "blocked_by_plugin"
    const kept = "ses_bound_kept"
    await send(s, request())
    await send(s, request({ sessionID: kept }))
    for (const index of Array.from({ length: Auth.MEMORY_KEYS - 1 }, (_, at) => at))
      await send(s, request({ sessionID: `ses_bound_${index}` }))
    // `kept` first: the forgotten session's new baseline pushes the next oldest out.
    await send(s, request({ sessionID: kept, tools: WITH_PROBE }))
    await send(s, request({ tools: WITH_PROBE }))
    expect(toolsetAlerts(s).map((alert) => alert.sessionID)).toEqual([kept])
  })

  test("no model-visible bytes change: tools and system leave as they came, but for the D9 identity line", async () => {
    await using s = await setup()
    await send(s, request())
    const event = request({ tools: WITH_PROBE })
    await send(s, event)
    expect(toolsetAlerts(s)).toHaveLength(1)
    expect(event.tools).toEqual(WITH_PROBE)
    expect(event.system).toEqual(
      SYSTEM.map((text) => ({ type: "text", text: text.replace("Provider ID: own-oai-aaaa", "Provider ID: openai") })),
    )
    expect(event.messages).toEqual([])
  })
})

describe("estimator: cache entries written before the change are cold (W = 0)", () => {
  const MODEL = "gpt-5.6-sol"

  test("the target's own cache and the shared prefix of its domain count only when written after the change", async () => {
    const cards = await seedCards()
    const changedAt = NOW - 30_000
    const source = side(cards, {
      providerID: "own-codex-aaaa",
      kind: "codex",
      modelID: MODEL,
      cache: cache({ modelID: MODEL }),
    })
    const target = side(cards, {
      providerID: "own-codex-bbbb",
      kind: "codex",
      modelID: MODEL,
      cache: cache({ modelID: MODEL }),
    })
    expect(Estimator.reuse(target, source, context()).lo).toBe(150 * K)
    expect(Estimator.reuse(target, source, context({ toolsetAt: changedAt }))).toEqual({ lo: 0, hi: 0 })
    const fresh = { ...target, cache: cache({ modelID: MODEL, lastReqAt: NOW - 10_000 }) }
    expect(Estimator.reuse(fresh, source, context({ toolsetAt: changedAt })).lo).toBe(150 * K)

    // Same cache domain, verified pooling: the target reuses the source's Z + u_1 only if the source's entry is newer.
    const pooled = (input: { readonly providerID: string; readonly cache?: Estimator.SlotCache }) =>
      side(cards, { ...input, kind: "codex", modelID: MODEL, cacheDomain: "cd_shared", poolingVerified: true })
    const a = pooled({ providerID: "own-codex-aaaa", cache: cache({ modelID: MODEL }) })
    const b = pooled({ providerID: "own-codex-bbbb" })
    expect(Estimator.reuse(b, a, context()).lo).toBe(14 * K)
    expect(Estimator.reuse(b, a, context({ toolsetAt: changedAt })).lo).toBe(0)
  })
})

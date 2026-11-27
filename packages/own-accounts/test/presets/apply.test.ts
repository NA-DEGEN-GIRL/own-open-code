// Session preset binding (07 §5.1–§5.3, §3.3, §8.1): `session.preset.apply` on the session's serial runner against the
// root `session.created` binding, the `own.preset` guidance entry through a fake own service on 127.0.0.1 (PUT and
// DELETE recorded), `session.preset.get`, presets.json changes and main changes. Real slots, presets and switching
// modules over the 2026-10-01 fixture catalog; every account, login and password is fake.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Schema } from "effect"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { Kv, Ledger, OwnAccounts, Preset } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import { PresetBinding } from "../../src/presets/binding.js"
import { Presets } from "../../src/presets/presets.js"
import { PresetStore } from "../../src/presets/store.js"
import type { RemoteHost } from "../../src/remote/host.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import type { Variant } from "../../src/switching/variant.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { failure, fakeEditor, memoryStorage, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { partial, seedCards } from "../switching/support.js"
import {
  ANTHROPIC,
  CHATGPT_01,
  CHATGPT_02,
  CLAUDE,
  CLAUDE_ON,
  CODEX_A,
  DEEPSEEK,
  DEEPSEEK_KEY,
  DS,
  OLLAMA,
  OPENAI,
  registry,
} from "./fixtures/catalog-2026-10-01.js"

// Each test boots real modules on a temp OWN_HOME and a loopback server.
setDefaultTimeout(30_000)

const WORKSPACE = process.platform === "win32" ? "C:\\work\\presets" : "/work/presets"
const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const PASSWORD = "fake-service-password"

const SOL = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const OPUS = { providerID: "anthropic", id: "claude-opus-5-5" }

/** A stored preset: `by-role` rows, delegation and caps as given. */
function stored(
  input: {
    readonly id: string
    readonly name: string
    readonly group: Preset.Group
    readonly roles?: Partial<Record<Preset.Role, ReadonlyArray<unknown>>>
    readonly delegation?: Preset.Delegation
    readonly caps?: Preset.Caps
  },
  revision = 1,
) {
  return decodeInfo({
    ...Preset.builtin(input.group),
    id: input.id,
    name: input.name,
    workers: {
      mode: input.roles ? "by-role" : "same",
      roles: Object.fromEntries(
        Object.entries(input.roles ?? {}).map(([role, targets]) => [role, { targets, effort: "inherit" }]),
      ),
    },
    delegation: input.delegation ?? "when-useful",
    caps: input.caps ?? Preset.CAPS,
    revision,
  })
}

const REVIEW_ID = Preset.ID.make("pr_01JB0000000000000000000001")
const LIGHT_ID = Preset.ID.make("pr_01JB0000000000000000000002")
const CLAUDE_REVIEW_ID = Preset.ID.make("pr_01JB0000000000000000000003")

/** `ChatGPT · Claude 리뷰`: review on the Claude slot's Opus 5.5. */
const REVIEW = stored({
  id: REVIEW_ID,
  name: "Claude 리뷰",
  group: "codex",
  roles: { "own-review": [{ pin: { account: CLAUDE, model: "claude-opus-5-5" } }] },
})
/** `ChatGPT · 가볍게 나눠 쓰기`: explore on the main account's lighter model. */
const LIGHT = stored({
  id: LIGHT_ID,
  name: "가볍게 나눠 쓰기",
  group: "codex",
  roles: { explore: [{ rel: "lighter" }] },
})
/** `Claude 구독 · Claude 리뷰`: review pinned on ChatGPT 02 (valid without a team, 07 §5.3 step 2's example). */
const CLAUDE_REVIEW = stored({
  id: CLAUDE_REVIEW_ID,
  name: "Claude 리뷰",
  group: "claude-sub",
  roles: { "own-review": [{ pin: { account: CHATGPT_02, model: "gpt-6-sol" } }] },
})

function file(star?: string, extra: ReadonlyArray<Preset.Info> = []): Preset.File {
  return {
    version: 1,
    groups: {
      codex: { presets: [REVIEW, LIGHT, ...extra.filter((p) => p.group === "codex")], ...(star ? { star } : {}) },
      "claude-sub": { presets: [CLAUDE_REVIEW] },
    },
  } as Preset.File
}

interface Recorded {
  readonly method: string
  readonly path: string
  readonly directory: string | null
  readonly authorization: string | null
  readonly body: unknown
}

/** A fake own service on 127.0.0.1 that records instruction-entry requests and answers 204. */
function fakeService() {
  const requests: Recorded[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      requests.push({
        method: request.method,
        path: url.pathname,
        directory: url.searchParams.get("location[directory]"),
        authorization: request.headers.get("authorization"),
        body: text ? JSON.parse(text) : undefined,
      })
      return new Response(null, { status: 204 })
    },
  })
  return {
    requests,
    source: ServiceTarget.fixed({ url: `http://127.0.0.1:${server.port}`, password: PASSWORD }),
    stop: () => server.stop(true),
  }
}

const stops: Array<() => unknown> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

interface Facts {
  model?: Variant.Ref
  parentID?: string
}

/** Real slots, presets and switching modules over the fixture catalog, a fake session core and a fake own service. */
async function rig(
  input: {
    readonly file?: Preset.File
    readonly sessions?: Record<string, Facts>
    /** Bindings stored before the modules start (an earlier run of the service). */
    readonly bindings?: Record<string, Preset.Binding>
  } = {},
) {
  const service = fakeService()
  stops.push(service.stop)
  const kv = memoryStorage()
  const sessions = new Map<string, Facts>(Object.entries(input.sessions ?? {}))
  const holder: { send?: (type: string, data: Record<string, unknown>) => Promise<void> } = {}
  const t = await testDeps({
    directory: WORKSPACE,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }), default: async () => ({ data: null }) },
      storage: kv.storage,
      session: {
        get: async (request: { readonly sessionID: string }) => {
          const facts = sessions.get(request.sessionID)
          if (!facts) throw new Error(`no session ${request.sessionID}`)
          return { id: request.sessionID, ...facts, location: { directory: WORKSPACE } }
        },
        wait: async () => {},
        switchModel: async (request: { readonly sessionID: string; readonly model: Variant.Ref }) => {
          const facts = sessions.get(request.sessionID) ?? {}
          const previous = facts.model
          sessions.set(request.sessionID, { ...facts, model: request.model })
          setTimeout(() => {
            void holder.send?.("session.model.selected", {
              sessionID: request.sessionID,
              model: request.model,
              ...(previous ? { previous } : {}),
            })
          }, 0)
        },
      },
    },
  })
  stops.push(() => t[Symbol.asyncDispose]())
  const deps = t.deps
  await deps.runtime.registry.write(await registry())
  await deps.runtime.ratecards.write(await seedCards())
  if (input.file) await deps.runtime.presets.write(input.file)
  for (const [sessionID, bound] of Object.entries(input.bindings ?? {}))
    await PresetBinding.write(deps, sessionID, bound)
  const alerts: Telemetry.AlertInput[] = []
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (base, peers) => ({ ...Modules.FACTORIES.telemetry(base, peers), alert: (alert) => alerts.push(alert) }),
    presets: (base, peers) => Presets.create(base, peers, { service: service.source }),
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
  const events: Array<{ name: string; payload: Record<string, unknown> }> = []
  deps.emitter.bind(
    partial<RpcRegistration<RpcTypes.Definition>>("registration", {
      events: {
        emit: async (...args) => {
          events.push({ name: args[0], payload: args[1] as Record<string, unknown> })
        },
      },
    }),
  )
  const counter = { id: 0 }
  const send = async (type: string, data: Record<string, unknown>) => {
    // SAFETY: tests build the event envelope by hand; `type` and `data` follow the OpenCode event schema.
    const event = {
      id: `evt_${++counter.id}`,
      created: deps.clock.now(),
      type,
      location: { directory: WORKSPACE },
      data,
    } as unknown as Module.OpenCodeEvent
    await modules.switching.onEvent?.(event, { local: true })
    await modules.presets.onEvent?.(event, { local: true })
  }
  holder.send = send
  const created = (sessionID: string, model?: Variant.Ref, parentID?: string) => {
    sessions.set(sessionID, { ...(model ? { model } : {}), ...(parentID ? { parentID } : {}) })
    return send("session.created", {
      sessionID,
      ...(model ? { model } : {}),
      ...(parentID ? { parentID } : {}),
      projectID: "p",
      slug: "s",
      version: "2",
      location: { directory: WORKSPACE },
    })
  }
  /** Waits for the work queued on a session's serial runner so far (`session.created`, `model.selected`). */
  const settled = (sessionID: string) => modules.switching.serial(sessionID, async () => {})
  /** Waits for work started outside a runner (a presets.json change) to show. */
  const until = async (check: () => Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error("condition not reached")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const apply = (value: {
    readonly sessionID: string
    readonly presetID: string
    readonly team?: unknown
    readonly dryRun?: boolean
  }) => modules.presets.sessionApply(decoded("session.preset.apply", value), rpcContext<"session.preset.apply">())
  const binding = (sessionID: string) => PresetBinding.read(deps, sessionID)
  return { deps, kv, sessions, service, modules, alerts, events, send, created, settled, until, apply, binding }
}

/** A handler's output, failing the test on a declared error. */
function ok<T>(value: T): Exclude<T, { readonly type: string; readonly message: string }> {
  const declared = failure(value)
  if (declared) throw new Error(`${declared.type}: ${declared.message}`)
  // SAFETY: `failure` recognises every declared error of the fake context, so what is left is the output.
  return value as Exclude<T, { readonly type: string; readonly message: string }>
}

/** An RPC input decoded by the protocol schema, as core hands it to the handler. */
function decoded<N extends RpcTypes.MethodName>(name: N, value: unknown): RpcTypes.Input<N> {
  // SAFETY: the method's input schema decodes to the handler's input type.
  const schema = OwnAccounts.Definition.methods[name].input as unknown as Schema.Codec<RpcTypes.Input<N>, unknown>
  return Schema.decodeUnknownSync(schema)(value)
}

const ENTRY = (sessionID: string) => `/api/experimental/session/${sessionID}/instructions/entries/own.preset`

describe("session.preset.apply (07 §5.3, §3.3)", () => {
  test("writes the own.preset entry through the own service before it returns, then binds; the main stays", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    const result = ok(await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID }))
    // The PUT was answered before `apply` returned (07 §8.1 "안내문 PUT을 끝낸 뒤에 돌아온다").
    expect(r.service.requests).toHaveLength(1)
    const put = r.service.requests[0]
    expect(put).toMatchObject({ method: "PUT", path: ENTRY("ses_a"), directory: WORKSPACE })
    expect(put?.authorization).toBe(ServiceTarget.basic(PASSWORD))
    const text = (put?.body as { value: string }).value
    expect(text).toContain("Delegation mode: when useful.")
    expect(text).toContain(
      "- own-review: a model from another company (Anthropic) on the user's subscription, at least as strong as you. Read-only review.",
    )
    expect(text).not.toMatch(/opus|claude-|gpt|acc_|own-codex/i)
    // 07 §2.3: a preset without `subagentEffortMax` lets the conversation raise efforts, so the static line is there.
    expect(text).toContain("Reasoning effort: the user lets you choose a subagent's reasoning effort in this session.")
    expect(result).toMatchObject({ entry: "written", dryRun: false, binding: { presetID: REVIEW_ID, group: "codex" } })
    const binding = await r.binding("ses_a")
    expect(binding?.entryHash).toBe(
      Preset.renderGuidance({
        delegation: "when-useful",
        ultra: false,
        caps: Preset.CAPS,
        cards: { "own-review": { relation: "stronger", runs: "subscription", company: "anthropic" } },
        effort: true,
      })?.hash ?? "",
    )
    expect(binding).toMatchObject({ presetID: REVIEW_ID, group: "codex", revision: 1 })
    expect(r.events.filter((event) => event.name === "session.preset.changed")).toHaveLength(1)
    // The resolution: review on the Claude slot, every other role like the main (no switchModel, PG4).
    expect(result.resolution?.roles["own-review"]?.use).toMatchObject({
      providerID: "anthropic",
      id: "claude-opus-5-5",
    })
    expect(r.sessions.get("ses_a")?.model).toEqual(SOL)
  })

  test("the same preset again, a team-only change and an omitted team never touch the entry; 평소대로 removes it", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID })
    expect(await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID })).toMatchObject({ entry: "unchanged" })
    const team = { teamID: "tm_1", role: "owner", accounts: [CHATGPT_01], pinned: [] }
    expect(await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID, team })).toMatchObject({
      entry: "unchanged",
      binding: { team },
    })
    expect(await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID })).toMatchObject({ binding: { team } })
    const cleared = await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID, team: null })
    expect(cleared).toMatchObject({ entry: "unchanged" })
    expect((await r.binding("ses_a"))?.team).toBeUndefined()
    expect(r.service.requests).toHaveLength(1)

    expect(await r.apply({ sessionID: "ses_a", presetID: "builtin:codex" })).toMatchObject({
      entry: "removed",
      binding: { presetID: "builtin:codex", entryHash: null },
    })
    expect(r.service.requests.at(-1)).toMatchObject({ method: "DELETE", path: ENTRY("ses_a"), directory: WORKSPACE })
    expect(await r.apply({ sessionID: "ses_a", presetID: "builtin:codex" })).toMatchObject({ entry: "unchanged" })
    expect(r.service.requests).toHaveLength(2)
  })

  test("dryRun answers the resolution and what the entry would do, and writes nothing", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    const result = ok(await r.apply({ sessionID: "ses_a", presetID: LIGHT_ID, dryRun: true }))
    expect(result).toMatchObject({ entry: "written", dryRun: true, binding: { presetID: LIGHT_ID } })
    expect(result.resolution?.roles.explore?.use).toMatchObject({ providerID: CODEX_A, id: "gpt-6-luna" })
    expect(r.service.requests).toEqual([])
    expect(r.kv.values.has(Kv.preset("ses_a"))).toBe(false)
    // A dry run decides no lighter pair either (U3: only write paths store one).
    expect((await r.deps.runtime.presets.read()).groups.codex?.lighter).toBeUndefined()
  })

  test("refusals change nothing: another group's preset, an unknown one, and R4 with the binding's team", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL }, ses_c: { model: OPUS } } })
    await r.apply({ sessionID: "ses_c", presetID: "builtin:claude-sub" })
    const before = r.kv.values.get(Kv.preset("ses_c"))
    expect(failure(await r.apply({ sessionID: "ses_a", presetID: CLAUDE_REVIEW_ID }))).toMatchObject({
      type: "preset_wrong_group",
      data: { group: "codex" },
    })
    expect(failure(await r.apply({ sessionID: "ses_a", presetID: "builtin:claude-sub" }))).toMatchObject({
      type: "preset_wrong_group",
    })
    expect(failure(await r.apply({ sessionID: "ses_a", presetID: "pr_01JB000000000000000000000Z" }))).toMatchObject({
      type: "preset_not_found",
    })
    // 07 §5.3 step 2: a Claude-subscription preset reviews on ChatGPT 02 while the team works on ChatGPT 01.
    const team = { teamID: "tm_1", role: "main", accounts: [CHATGPT_01], pinned: [] }
    expect(failure(await r.apply({ sessionID: "ses_c", presetID: CLAUDE_REVIEW_ID, team }))).toMatchObject({
      type: "same_company_subscription",
      data: { accountID: CHATGPT_02 },
    })
    expect(r.kv.values.get(Kv.preset("ses_c"))).toEqual(before)
    expect(r.kv.values.has(Kv.preset("ses_a"))).toBe(false)
    expect(r.service.requests).toEqual([])
    // Without the team the same preset applies (it was checked when saved).
    expect(await r.apply({ sessionID: "ses_c", presetID: CLAUDE_REVIEW_ID })).toMatchObject({ entry: "written" })
  })
})

describe("the root's first binding and apply share one serial runner (07 §3.3 두 경로의 순서)", () => {
  test("session.created first: the ★ and its entry come before the first step; a later apply wins", async () => {
    const r = await rig({ file: file(REVIEW_ID) })
    await r.created("ses_tui", SOL)
    await r.settled("ses_tui")
    expect(await r.binding("ses_tui")).toMatchObject({ presetID: REVIEW_ID, revision: 1 })
    expect(r.service.requests.map((request) => request.method)).toEqual(["PUT"])
    expect((await r.binding("ses_tui"))?.entryHash).toMatch(/^fnv1a64:/)
    expect(await r.apply({ sessionID: "ses_tui", presetID: "builtin:codex" })).toMatchObject({ entry: "removed" })
    expect((await r.binding("ses_tui"))?.presetID).toBe(Preset.builtinID("codex"))
  })

  test("apply first: session.created finds the binding and leaves it, entry included", async () => {
    const r = await rig({ file: file(REVIEW_ID) })
    r.sessions.set("ses_web", { model: SOL })
    await r.apply({ sessionID: "ses_web", presetID: LIGHT_ID })
    await r.created("ses_web", SOL)
    await r.settled("ses_web")
    expect((await r.binding("ses_web"))?.presetID).toBe(LIGHT_ID)
    expect(r.service.requests.map((request) => request.method)).toEqual(["PUT"])
  })

  test("both at once: whichever runs first, the applied preset is the binding and its entry the last written", async () => {
    const r = await rig({ file: file(REVIEW_ID) })
    r.sessions.set("ses_race", { model: SOL })
    const applied = r.apply({ sessionID: "ses_race", presetID: LIGHT_ID })
    const created = r.created("ses_race", SOL)
    await Promise.all([applied, created])
    await r.settled("ses_race")
    const binding = await r.binding("ses_race")
    expect(binding?.presetID).toBe(LIGHT_ID)
    const last = r.service.requests.at(-1)
    expect(last?.method).toBe("PUT")
    expect((last?.body as { value: string }).value).toContain("- explore: a lighter, faster model")
  })

  test("children are never bound and get no entry (07 §2.8)", async () => {
    const r = await rig({ file: file(REVIEW_ID) })
    await r.created("ses_root", SOL)
    await r.created("ses_child", SOL, "ses_root")
    await r.settled("ses_root")
    await r.settled("ses_child")
    expect(r.kv.values.has(Kv.preset("ses_child"))).toBe(false)
    expect(r.service.requests.map((request) => request.path)).toEqual([ENTRY("ses_root")])
  })
})

describe("presets.json changes (07 §5.3 지울 때, §3.3)", () => {
  test("removing a bound preset rebinds to the ★; removing the ★ falls back to 평소대로 and removes the entry", async () => {
    const r = await rig({ file: file(REVIEW_ID), sessions: { ses_1: { model: SOL }, ses_2: { model: SOL } } })
    await r.apply({ sessionID: "ses_1", presetID: LIGHT_ID })
    await r.apply({ sessionID: "ses_2", presetID: REVIEW_ID })
    const context = rpcContext<"presets.remove">()
    await r.modules.presets.remove({ presetID: Preset.ID.make(LIGHT_ID) }, context)
    await r.until(async () => (await r.binding("ses_1"))?.presetID === REVIEW_ID)
    expect(r.service.requests.filter((request) => request.path === ENTRY("ses_1")).map((x) => x.method)).toEqual([
      "PUT",
      "PUT",
    ])
    await r.modules.presets.remove({ presetID: Preset.ID.make(REVIEW_ID) }, context)
    for (const sessionID of ["ses_1", "ses_2"])
      await r.until(async () => (await r.binding(sessionID))?.presetID === Preset.builtinID("codex"))
    for (const sessionID of ["ses_1", "ses_2"]) {
      expect(await r.binding(sessionID)).toMatchObject({ presetID: "builtin:codex", entryHash: null })
      expect(r.service.requests.filter((request) => request.path === ENTRY(sessionID)).at(-1)?.method).toBe("DELETE")
    }
    const changed = () => r.events.filter((event) => event.name === "session.preset.changed")
    await r.until(async () => changed().length === 5)
    expect(changed().map((event) => event.payload.sessionID)).toEqual(["ses_1", "ses_2", "ses_1", "ses_1", "ses_2"])
  })

  test("an edit re-renders the entry only when its card text changes; the binding follows the revision", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID })
    const save = (changes: Partial<Preset.Save>) =>
      r.modules.presets.set(
        {
          preset: {
            id: REVIEW.id,
            name: REVIEW.name,
            group: REVIEW.group,
            workers: REVIEW.workers,
            delegation: REVIEW.delegation,
            caps: REVIEW.caps,
            ultraCaps: REVIEW.ultraCaps,
            ...changes,
          },
        },
        rpcContext<"presets.set">(),
      )
    await save({ name: "리뷰는 Claude로" })
    await r.until(async () => (await r.binding("ses_a"))?.revision === 2)
    expect(r.service.requests).toHaveLength(1)
    await save({ name: "리뷰는 Claude로", caps: { concurrent: 4, perMessage: 6, perSession: 100 } })
    await r.until(async () => (await r.binding("ses_a"))?.revision === 3)
    expect(r.service.requests).toHaveLength(2)
    expect((r.service.requests[1]?.body as { value: string }).value).toContain("at most 4 subagents running at once")
  })

  test("a binding to a preset removed while its Location was not loaded follows the ★ once the module starts", async () => {
    const gone = Preset.ID.make("pr_01JB0000000000000000000009")
    const r = await rig({
      file: file(REVIEW_ID),
      sessions: { ses_old: { model: SOL } },
      bindings: {
        ses_old: { presetID: gone, group: "codex", revision: 4, appliedAt: 1, entryHash: "sha256:old-entry" },
      },
    })
    // In effect at once (the gate and `session.preset.get`), and rebound with its entry rewritten (07 §5.3).
    expect(
      ok(await r.modules.presets.sessionGet(decoded("session.preset.get", { sessionID: "ses_old" }), rpcContext())),
    ).toMatchObject({
      preset: { id: REVIEW_ID },
    })
    await r.until(async () => (await r.binding("ses_old"))?.presetID === REVIEW_ID)
    expect(r.service.requests.filter((request) => request.path === ENTRY("ses_old")).map((x) => x.method)).toEqual([
      "PUT",
    ])
  })

  test("the preset in effect: the binding's while it is loaded in its group, else the ★, else 평소대로", () => {
    const loaded = new Map<string, Preset.Info>([[REVIEW_ID, REVIEW]])
    const presets = (star?: Preset.ID) => ({
      star: () => star,
      preset: (id: Preset.ID, group: Preset.Group) =>
        id === Preset.builtinID(group) ? Preset.builtin(group) : loaded.get(id),
    })
    const gone = Preset.ID.make("pr_01JB0000000000000000000009")
    const bound = (presetID: Preset.ID, group: Preset.Group = "codex"): Preset.Binding => ({
      presetID,
      group,
      revision: 1,
      appliedAt: 1,
      entryHash: null,
    })
    expect(PresetStore.inEffect(presets(REVIEW_ID), bound(REVIEW_ID), "codex").id).toBe(REVIEW_ID)
    expect(PresetStore.inEffect(presets(REVIEW_ID), bound(gone), "codex").id).toBe(REVIEW_ID)
    expect<unknown>(PresetStore.inEffect(presets(), bound(gone), "codex").id).toBe("builtin:codex")
    // A main in another group takes that group's ★ (or 평소대로), whatever the binding names.
    expect<unknown>(PresetStore.inEffect(presets(), bound(REVIEW_ID), "claude-sub").id).toBe("builtin:claude-sub")
    expect(PresetStore.inEffect(presets(REVIEW_ID), undefined, "codex").id).toBe(REVIEW_ID)
  })

  test("a remote service applies only 평소대로; a user preset is preset_not_found (07 §8.1 원격)", async () => {
    const r = await rig({ file: file(REVIEW_ID), sessions: { ses_r: { model: SOL } } })
    const remoteDeps = { ...r.deps, remote: partial<RemoteHost.Api>("remote", { claudeAgent: () => undefined }) }
    const service = fakeService()
    stops.push(service.stop)
    const remote = Presets.create(remoteDeps, () => peers, { service: service.source })
    const peers = partial<Modules.All>("modules", { ...r.modules, presets: remote })
    await remote.start()
    stops.push(() => remote.stop())
    const context = rpcContext<"session.preset.apply">()
    const named = (presetID: string) => decoded("session.preset.apply", { sessionID: "ses_r", presetID })
    expect(failure(await remote.sessionApply(named(REVIEW_ID), context))).toMatchObject({ type: "preset_not_found" })
    expect(await remote.sessionApply(named("builtin:codex"), context)).toMatchObject({ entry: "unchanged" })
    expect(service.requests).toEqual([])
  })
})

describe("session.preset.get (07 §8.1)", () => {
  test("binding with team and ultra, the resolution, subagent counts and this conversation's paid spend", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    const team = { teamID: "tm_1", role: "owner", accounts: [CHATGPT_01], pinned: [] }
    await r.apply({ sessionID: "ses_a", presetID: LIGHT_ID, team })
    // Two subagents, one still running; a DeepSeek child spent $0.25 and the ChatGPT one nothing in USD.
    r.deps.runtime.sessions.update("ses_kid1", { parentID: "ses_a", busy: true })
    r.deps.runtime.sessions.update("ses_kid2", { parentID: "ses_a", busy: false })
    await r.kv.storage.set(Kv.presetUsage("ses_a"), { perSession: 2 })
    const line = (sessionID: string, accountID: string, providerID: string, amount: number) =>
      Schema.decodeUnknownSync(Ledger.Line)({
        v: 1,
        ts: r.deps.clock.now(),
        sessionID,
        messageID: null,
        kind: "primary",
        accountID,
        providerID,
        modelID: "deepseek-flash",
        variant: null,
        credentialRef: null,
        transport: null,
        switchEpoch: 0,
        compactionEpoch: 0,
        tokens: null,
        P: null,
        hit: null,
        cost: { amount, unit: "USD", source: "ratecard" },
        costUSDOpenCode: null,
        coldExpected: null,
      })
    await r.deps.runtime.ledger.usage("eid_1", line("ses_kid2", DEEPSEEK_KEY, DS, 0.25))
    await r.deps.runtime.ledger.usage("eid_2", line("ses_other", DEEPSEEK_KEY, DS, 5))
    const view = ok(
      await r.modules.presets.sessionGet(
        decoded("session.preset.get", { sessionID: "ses_a" }),
        rpcContext<"session.preset.get">(),
      ),
    )
    expect(view.binding).toMatchObject({ presetID: LIGHT_ID, team })
    expect(view.preset?.id).toBe(LIGHT_ID)
    expect(view.resolution?.roles.explore?.use).toMatchObject({ id: "gpt-6-luna" })
    expect(view.caps).toEqual(Preset.CAPS)
    expect(view.counts).toEqual({ running: 1, message: 0, session: 2 })
    expect(view.spend).toBe(0.25)
  })
})

describe("main changes (07 §5.3)", () => {
  test("moving to another group takes the preset of the same name there; the entry follows its cards", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    await r.apply({ sessionID: "ses_a", presetID: REVIEW_ID })
    r.sessions.set("ses_a", { model: OPUS })
    await r.send("session.model.selected", { sessionID: "ses_a", model: OPUS, previous: SOL })
    await r.settled("ses_a")
    expect(await r.binding("ses_a")).toMatchObject({ presetID: CLAUDE_REVIEW_ID, group: "claude-sub" })
    const last = r.service.requests.at(-1)
    expect((last?.body as { value: string }).value).toContain(
      "- own-review: a lighter, faster model from another company (OpenAI) on the user's subscription. Read-only review.",
    )
  })

  test("a model change within the group keeps the preset; a card that does not change writes nothing", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    await r.apply({ sessionID: "ses_a", presetID: LIGHT_ID })
    const next = { providerID: CODEX_A, id: "gpt-6.1-sol", variant: "high" }
    r.sessions.set("ses_a", { model: next })
    await r.send("session.model.selected", { sessionID: "ses_a", model: next, previous: SOL })
    await r.settled("ses_a")
    expect((await r.binding("ses_a"))?.presetID).toBe(LIGHT_ID)
    expect(r.service.requests).toHaveLength(1)
    expect(r.alerts).toEqual([])
  })
})

describe("suggestions read the slots' local window (07 §6.2 #8, T1.07)", () => {
  test("a local model is suggested only while its running window is verified", async () => {
    const status: { value: "verified" | "unverified" } = { value: "unverified" }
    const t = await testDeps({
      ctx: {
        provider: { reload: async () => {}, list: async () => [] },
        model: { list: async () => ({ data: [OLLAMA] }) },
        storage: memoryStorage().storage,
      },
    })
    stops.push(() => t[Symbol.asyncDispose]())
    await t.deps.runtime.registry.write(await registry())
    const modules = Modules.create(t.deps, {
      plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => CLAUDE_ON }),
      slots: (base, peers) => ({
        ...Modules.FACTORIES.slots(base, peers),
        localWindow: (providerID: string, modelID: string) =>
          providerID === "ollama" && modelID === OLLAMA.id
            ? { runtime: 32_768, needed: 30_000, status: status.value }
            : undefined,
      }),
    })
    await modules.slots.start()
    await modules.presets.start()
    stops.push(async () => {
      await modules.presets.stop()
      await modules.slots.stop()
    })
    const suggest = () =>
      modules.presets.suggest(decoded("presets.suggest", { group: "codex", template: "local-explore" }), rpcContext())
    expect(modules.presets.resolver.localVerified("ollama", OLLAMA.id)).toBe(false)
    expect(await suggest()).toMatchObject({
      starters: expect.arrayContaining([
        { template: "local-explore", name: "로컬로 탐색", available: false, problem: "no-local" },
      ]),
    })
    status.value = "verified"
    expect(modules.presets.resolver.localVerified("ollama", OLLAMA.id)).toBe(true)
    expect(await suggest()).toMatchObject({
      draft: { workers: { roles: { explore: { targets: [{ pin: { account: "local:ollama", model: OLLAMA.id } }] } } } },
    })
  })
})

describe("the model pool guidance (07 §3.3 모델 묶음 4.4, T4)", () => {
  const POOL_ID = Preset.ID.make("pr_01JB0000000000000000000009")
  const POOL = decodeInfo({
    ...Preset.builtin("codex"),
    id: POOL_ID,
    name: "모델 묶음",
    workers: {
      mode: "same",
      roles: {},
      pool: [
        { key: "gpt-6-luna", model: "gpt-6-luna", card: { name: "GPT-6 Luna", window: 922_000, at: 1 } },
        { key: "claude-opus-5-5", model: "claude-opus-5-5", account: CLAUDE, card: { name: "Claude Opus 5.5", at: 1 } },
        {
          key: "qwen3-coder",
          model: "qwen3-coder:30b",
          account: "local:ollama",
          card: { windowVerified: true, at: 1 },
        },
        { key: "deepseek-v4-pro", model: "deepseek-v4-pro", account: DEEPSEEK_KEY, card: { at: 1 } },
      ],
    },
    delegation: "when-useful",
    revision: 1,
  })
  const poolFile = (): Preset.File => ({ ...file(), groups: { ...file().groups, codex: { presets: [POOL] } } })
  const text = (request: { readonly body: unknown } | undefined) => (request?.body as { value: string }).value
  const select = async (r: Awaited<ReturnType<typeof rig>>, model: Variant.Ref, previous: Variant.Ref) => {
    r.sessions.set("ses_a", { model })
    await r.send("session.model.selected", { sessionID: "ses_a", model, previous })
    await r.settled("ses_a")
  }

  test("the block is written once; facts that do not move it never rewrite it", async () => {
    const r = await rig({ file: poolFile(), sessions: { ses_a: { model: SOL } } })
    await r.apply({ sessionID: "ses_a", presetID: POOL_ID })
    expect(r.service.requests).toHaveLength(1)
    const first = text(r.service.requests[0])
    expect(first).toContain("- gpt-6-luna: GPT-6 Luna, OpenAI, on your own account and limits. About 920k context.")
    expect(first).toContain("- deepseek-v4-pro: DeepSeek, on a pay-per-use API key: it costs the user money.")
    expect(first).toContain(
      "Compared with you: lighter: gpt-6-luna, deepseek-v4-pro, qwen3-coder; stronger: claude-opus-5-5.",
    )
    expect(first).toContain(
      "Leave `model` empty to let the session choose: explore and own-quick use gpt-6-luna; own-review and own-deep use claude-opus-5-5; general uses your own model.",
    )
    const hash = (await r.binding("ses_a"))?.entryHash
    // A catalog price change (relations hold), then a same-model switch to another ChatGPT account.
    r.modules.slots.transformProviders(
      fakeEditor({
        openai: { models: OPENAI.map((entry) => (entry.id === "gpt-6-luna" ? { ...entry, cost: [] } : entry)) },
        anthropic: { models: ANTHROPIC },
        deepseek: { models: DEEPSEEK },
      }).editor,
    )
    r.modules.slots.transformProviders(
      fakeEditor({ openai: { models: OPENAI }, anthropic: { models: ANTHROPIC }, deepseek: { models: DEEPSEEK } })
        .editor,
    )
    const other = { providerID: "own-codex-bbbb", id: "gpt-6-sol", variant: "high" }
    await select(r, other, SOL)
    // A limit on the Claude slot, the local server gone (its list is empty here): the facts stay.
    r.deps.runtime.limits.exhaust({
      accountID: CLAUDE,
      windowId: null,
      until: r.deps.clock.now() + 60_000,
      class: "hard",
    })
    await select(r, SOL, other)
    // Another main of the same price: every relation and default holds.
    const next = { providerID: CODEX_A, id: "gpt-6.1-sol", variant: "high" }
    await select(r, next, SOL)
    expect(r.service.requests).toHaveLength(1)
    expect((await r.binding("ses_a"))?.entryHash).toBe(hash)
    // A main that moves a relation (Astra costs more than Claude): the block follows once.
    const astra = { providerID: CODEX_A, id: "gpt-6-astra", variant: "high" }
    await select(r, astra, next)
    expect(r.service.requests).toHaveLength(2)
    expect(text(r.service.requests[1])).toContain(
      "Compared with you: lighter: gpt-6-luna, deepseek-v4-pro, claude-opus-5-5, qwen3-coder.",
    )
    expect(text(r.service.requests[1])).toContain("own-review uses claude-opus-5-5")
  })

  test("a pool edit rewrites it; frozen cards change only through 카드 새로 고치기", async () => {
    const r = await rig({ file: file(), sessions: { ses_a: { model: SOL } } })
    const save = (
      pool: ReadonlyArray<unknown>,
      extra: { readonly id?: string; readonly refreshCards?: boolean } = {},
    ) =>
      r.modules.presets.set(
        decoded("presets.set", {
          preset: {
            ...(extra.id ? { id: extra.id } : {}),
            name: "모델 묶음",
            group: "codex",
            workers: { mode: "same", roles: {}, pool },
            delegation: "when-useful",
            caps: Preset.CAPS,
            ultraCaps: null,
          },
          ...(extra.refreshCards ? { refreshCards: true } : {}),
        }),
        rpcContext<"presets.set">(),
      )
    const OPUS_ENTRY = { key: "claude-opus-5-5", model: "claude-opus-5-5", account: CLAUDE }
    const created = ok(await save([{ key: "gpt-6-luna", model: "gpt-6-luna" }, OPUS_ENTRY]))
    const id = created.preset.id
    await r.apply({ sessionID: "ses_a", presetID: id })
    expect(r.service.requests).toHaveLength(1)
    // An edit (a note): rewritten at the next reconcile.
    ok(await save([{ key: "gpt-6-luna", model: "gpt-6-luna", note: "docs only" }, OPUS_ENTRY], { id }))
    await r.until(async () => r.service.requests.length === 2)
    expect(text(r.service.requests[1])).toContain("Note from the user: 'docs only'")
    // The catalog's window changes: the frozen card stays until the user refreshes the cards.
    const wider = ANTHROPIC.map((entry) =>
      entry.id === "claude-opus-5-5" ? { ...entry, limit: { context: 2_000_000, input: 1_500_000, output: 1 } } : entry,
    )
    r.modules.slots.transformProviders(
      fakeEditor({ openai: { models: OPENAI }, anthropic: { models: wider }, deepseek: { models: DEEPSEEK } }).editor,
    )
    ok(await save([{ key: "gpt-6-luna", model: "gpt-6-luna", note: "docs only" }, OPUS_ENTRY], { id }))
    await r.until(async () => (await r.binding("ses_a"))?.revision === 3)
    expect(r.service.requests).toHaveLength(2)
    ok(
      await save([{ key: "gpt-6-luna", model: "gpt-6-luna", note: "docs only" }, OPUS_ENTRY], {
        id,
        refreshCards: true,
      }),
    )
    await r.until(async () => r.service.requests.length === 3)
    expect(text(r.service.requests[2])).toContain("About 1.5M context.")
  })

  test("a metered DeepSeek main: the main account's entries say they cost money like the main", async () => {
    const metered = decodeInfo({
      ...Preset.builtin("ds"),
      id: POOL_ID,
      name: "모델 묶음",
      workers: { mode: "same", roles: {}, pool: [{ key: "deepseek-flash", model: "deepseek-flash" }] },
      delegation: "when-useful",
      revision: 1,
    })
    const r = await rig({
      file: { ...file(), groups: { ...file().groups, ds: { presets: [metered] } } },
      sessions: { ses_d: { model: { providerID: DS, id: "deepseek-v4-pro" } } },
    })
    await r.apply({ sessionID: "ses_d", presetID: POOL_ID })
    expect(text(r.service.requests[0])).toContain(
      "- deepseek-flash: DeepSeek, on your own pay-per-use account, like you: it costs the user money. Use it only when no subscription or local model here can do the task.",
    )
    expect(text(r.service.requests[0])).toContain("explore and own-quick use deepseek-flash;")
  })
})

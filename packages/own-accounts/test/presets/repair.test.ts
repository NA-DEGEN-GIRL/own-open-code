// Repair notices (07 §4.3, §4.2, §2.2, §7.2, PG5's notice items): a catalog change runs through the real fold, the
// pinned-template diff the control Location writes (a gone model stays, marked missing upstream and running as
// `deprecated`) and the presence check that follows `models-dev.refreshed`, a provider refold and a presets.json
// change. Seven ChatGPT accounts share the ChatGPT group's presets, lighter pairs and default model. Nothing is ever
// rewritten by itself.
// Every account, login and Codex file is fake: the Codex home is a temp folder, never this PC's `.codex`.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { Model } from "@opencode/schema/model"
import { Preset } from "@own/protocol"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import { PresetRepair } from "../../src/presets/repair.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { until } from "../plugins/support.js"
import { failure, fakeEditor, memoryStorage, rpcContext, type AccountSeed } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import {
  ANTHROPIC,
  CLAUDE,
  CLAUDE_ON,
  CODEX_A,
  DEEPSEEK,
  DEEPSEEK_KEY,
  DS,
  OPENAI,
  model,
  registry,
} from "./fixtures/catalog-2026-10-01.js"

// Each test boots real slots and presets modules on a temp OWN_HOME.
setDefaultTimeout(30_000)

const WORKSPACE = process.platform === "win32" ? "C:\\work\\repair" : "/work/repair"
const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const decodeSave = Schema.decodeUnknownSync(Preset.Save)
const decodeFile = Schema.decodeUnknownSync(Preset.File)

/** Seven ChatGPT logins (`ChatGPT 01` is `acc_aaaa` on `CODEX_A`) and a DeepSeek key. */
const SEATS: ReadonlyArray<AccountSeed> = [
  ...["aaaa", "bbbb", "cccc", "eeee", "ffff", "gggg", "hhhh"].map(
    (slug, index): AccountSeed => ({
      kind: "codex",
      label: `ChatGPT 0${index + 1}`,
      slug,
      identity: { fingerprint: `sha256:${String(index + 1).repeat(64)}` },
    }),
  ),
  { kind: "ds", label: "DeepSeek", slug: "dddd" },
]
const CHATGPT_01 = "acc_aaaa"

const REVIEW_ID = "pr_01JB0000000000000000000001"
const DEEP_ID = "pr_01JB0000000000000000000002"
const LIGHT_ID = "pr_01JB0000000000000000000003"
const QUICK_ID = "pr_01JB0000000000000000000004"
const TWICE_ID = "pr_01JB0000000000000000000005"
const CROSS_ID = "pr_01JB0000000000000000000006"

const pin = (account: string, id: string) => ({ pin: { account, model: id } })

/** A stored preset with `by-role` rows. */
function stored(id: string, name: string, group: Preset.Group, roles: Record<string, ReadonlyArray<unknown>>) {
  return decodeInfo({
    ...Preset.builtin(group),
    id,
    name,
    workers: {
      mode: "by-role",
      roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
    },
    delegation: "when-useful",
    revision: 1,
  })
}

/** `ChatGPT · 다른 회사 리뷰`: review on Claude Opus 5, then DeepSeek; the next target takes over. */
const REVIEW = stored(REVIEW_ID, "다른 회사 리뷰", "codex", {
  "own-review": [pin(CLAUDE, "claude-opus-5"), pin(DEEPSEEK_KEY, "deepseek-v4-pro")],
})
/** `ChatGPT · 어려운 일`: deep work on Claude Opus 5 only; the role runs like the main without it. */
const DEEP = stored(DEEP_ID, "어려운 일", "codex", { "own-deep": [pin(CLAUDE, "claude-opus-5")] })
/** `ChatGPT · 가볍게 나눠 쓰기`: explore on the main account's lighter model. */
const LIGHT = stored(LIGHT_ID, "가볍게 나눠 쓰기", "codex", { explore: [{ rel: "lighter" }] })

function file(groups: Record<string, unknown>): Preset.File {
  return decodeFile({ version: 1, groups })
}

/** A hand-built OpenCode event with the fields the presets module reads. */
function event(type: string, data: Record<string, unknown> = {}): Module.OpenCodeEvent {
  // SAFETY: `type` and `data` follow the event schema for the members the presets module reads.
  return {
    id: `evt_${type}`,
    created: 0,
    type,
    location: { directory: WORKSPACE },
    data,
  } as unknown as Module.OpenCodeEvent
}

/** A handler's output, failing the test on a declared error. */
function ok<T>(value: T): Exclude<T, { readonly type: string; readonly message: string }> {
  const declared = failure(value)
  if (declared) throw new Error(`${declared.type}: ${declared.message}`)
  // SAFETY: `failure` recognises every declared error of the fake context, so what is left is the output.
  return value as Exclude<T, { readonly type: string; readonly message: string }>
}

/**
 * Real slots and presets modules on the control Location (the one that writes template diffs), over the 2026-10-01
 * catalogs, with the Claude slot installed and alerts recorded. `leader` stands for the runtime's leader election.
 */
async function rig(input: { readonly file?: Preset.File; readonly codex?: Record<string, string> } = {}) {
  const leader = { value: true }
  const t = await testDeps({
    control: true,
    directory: WORKSPACE,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }) },
      storage: memoryStorage().storage,
    },
  })
  const codexHome = path.join(t.home, "codex-fixture")
  await fs.mkdir(codexHome)
  await Promise.all(
    Object.entries(input.codex ?? {}).map(([name, text]) => fs.writeFile(path.join(codexHome, name), text)),
  )
  const deps = {
    ...t.deps,
    options: { ...t.deps.options, codexHome },
    runtime: { ...t.deps.runtime, isLeader: () => leader.value },
  }
  await deps.runtime.registry.write(await registry(SEATS))
  if (input.file) await deps.runtime.presets.write(input.file)
  const alerts: Telemetry.AlertInput[] = []
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (base, peers) => ({ ...Modules.FACTORIES.telemetry(base, peers), alert: (alert) => alerts.push(alert) }),
  })
  await modules.slots.start()
  await modules.presets.start()
  const catalogs: Record<string, ReadonlyArray<Model.Info>> = {
    openai: OPENAI,
    anthropic: ANTHROPIC,
    deepseek: DEEPSEEK,
  }
  const fold = () =>
    modules.slots.transformProviders(
      fakeEditor(Object.fromEntries(Object.entries(catalogs).map(([id, models]) => [id, { models }]))).editor,
    )
  fold()
  const events: string[] = []
  // SAFETY: the fake implements the only member the emitter uses, `events.emit`.
  const registration = { events: { emit: async (name: string) => void events.push(name) } }
  deps.emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
  const presets = modules.presets
  /** A `models-dev.refreshed`, then the check once the burst settled. */
  const settle = async () => {
    await presets.onEvent?.(event("models-dev.refreshed"), { local: false })
    t.clock.advance(PresetRepair.SETTLE_MS)
    await presets.repair.check()
  }
  /** A catalog change: the fold, the template diff written (`marked`), then the check. */
  const refresh = async (next: Record<string, ReadonlyArray<Model.Info>>, marked?: () => boolean) => {
    Object.assign(catalogs, next)
    fold()
    if (marked) await until(marked)
    await settle()
  }
  const list = async (group?: Preset.Group) => ok(await presets.list(group ? { group } : {}, rpcContext()))
  const row = async (group: Preset.Group) => (await list(group)).groups[0]
  /** Whether a model is offered: registered enabled and not `deprecated` (a gone model runs on as `deprecated`). */
  const offered = (providerID: string, id: string) => {
    const model = modules.slots.model(providerID, id)
    return model && model.enabled && model.status !== "deprecated"
  }
  return {
    t,
    deps,
    leader,
    modules,
    presets,
    alerts,
    /** How many `presets.changed` were sent. */
    changed: () => events.filter((name) => name === "presets.changed").length,
    settle,
    refresh,
    list,
    row,
    offered,
    file: () => deps.runtime.presets.read(),
    coded: (code: string) => alerts.filter((alert) => alert.code === code),
    async [Symbol.asyncDispose]() {
      await presets.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

type Rig = Awaited<ReturnType<typeof rig>>

const without = (models: ReadonlyArray<Model.Info>, ...ids: ReadonlyArray<string>) =>
  models.filter((item) => !ids.includes(item.id))

/** The main a preset resolves against: ChatGPT 01 on GPT-6 Astra · high. */
async function astra(r: Rig) {
  const main = await r.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-astra", variant: "high" })
  if (!main) throw new Error("no main")
  return main
}

/** `deepseek-flash` as models.dev listed it on 09-10, under another id. */
const renamedFacts = {
  family: "deepseek-flash",
  released: Date.UTC(2026, 8, 10),
  price: 0.15,
  variants: ["low", "high", "max"],
}

describe("a pinned model that is gone (07 §4.3)", () => {
  test("its roles skip to the next target or run like the main; one notice with the successor; one alert per model event across seven accounts and two presets", async () => {
    await using r = await rig({ file: file({ codex: { presets: [REVIEW, DEEP, LIGHT] } }) })
    await r.settle()
    expect(r.alerts).toEqual([])
    expect((await r.row("codex"))?.status).toBe("ok")
    const before = await r.file()
    const changed = r.changed()

    await r.refresh({ anthropic: without(ANTHROPIC, "claude-opus-5") })
    // presets.json did not change, but its rows did: clients read presets.list again.
    expect(r.changed()).toBe(changed + 1)
    const codex = await r.row("codex")
    expect(codex?.status).toBe("needs_repair")
    expect(codex?.presets?.map((item) => [item.name, item.status])).toEqual([
      ["평소대로", "ok"],
      ["다른 회사 리뷰", "needs_repair"],
      ["어려운 일", "needs_repair"],
      ["가볍게 나눠 쓰기", "ok"],
    ])
    // One notice for the model, every use listed with Claude's successor (the bundled anth row names the family).
    expect<unknown>((await r.list()).repairs).toEqual([
      {
        model: "claude-opus-5",
        uses: [
          {
            kind: "pin",
            group: "codex",
            presetID: REVIEW_ID,
            place: "own-review",
            account: CLAUDE,
            suggestion: "claude-opus-5-5",
          },
          {
            kind: "pin",
            group: "codex",
            presetID: DEEP_ID,
            place: "own-deep",
            account: CLAUDE,
            suggestion: "claude-opus-5-5",
          },
        ],
      },
    ])
    const needs = r.coded("preset_needs_repair")
    expect(r.alerts).toHaveLength(1)
    expect(needs[0]).toMatchObject({ severity: "warning" })
    expect(needs[0]?.message).toContain("모델 claude-opus-5이(가) 없어졌습니다.")
    expect(needs[0]?.message).toContain("프리셋 2개의 리뷰·어려운 일")
    expect(needs[0]?.message).toContain("(제안: claude-opus-5-5)")

    // The gate resolves every call again: review moves to DeepSeek, deep work runs like the main.
    const main = await astra(r)
    const resolution = await r.presets.resolver.resolve(REVIEW, main)
    expect(resolution.roles["own-review"]?.targets[0]).toMatchObject({ skip: "unavailable" })
    expect(resolution.roles["own-review"]).toMatchObject({
      use: { providerID: DS, id: "deepseek-v4-pro", variant: "high" },
      fallback: false,
    })
    expect((await r.presets.resolver.resolve(DEEP, main)).roles["own-deep"]).toMatchObject({
      use: main.ref,
      fallback: true,
    })

    // More refreshes and checks of the same event raise nothing more; nothing was rewritten.
    await r.settle()
    await r.settle()
    expect(r.alerts).toHaveLength(1)
    expect(r.changed()).toBe(changed + 1)
    expect(await r.file()).toEqual(before)

    // The model comes back: the notice goes, quietly. It goes again: a new event, one more alert.
    await r.refresh({ anthropic: ANTHROPIC })
    expect(r.changed()).toBe(changed + 2)
    expect((await r.list()).repairs).toBeUndefined()
    expect((await r.row("codex"))?.status).toBe("ok")
    expect(r.alerts).toHaveLength(1)
    await r.refresh({ anthropic: without(ANTHROPIC, "claude-opus-5") })
    expect(r.coded("preset_needs_repair")).toHaveLength(2)
    expect(r.alerts[1]?.subject).not.toBe(r.alerts[0]?.subject)
  })

  test("a rename offers the new id (same family, same release day); the old row stays, marked missing upstream", async () => {
    const quick = stored(QUICK_ID, "빠른 일은 DeepSeek", "codex", {
      "own-quick": [pin(DEEPSEEK_KEY, "deepseek-flash")],
    })
    await using r = await rig({ file: file({ codex: { presets: [quick] } }) })
    await r.settle()
    const renamed = DEEPSEEK.map((item) =>
      item.id === "deepseek-flash" ? model("deepseek", "deepseek-flash-0910", renamedFacts) : item,
    )
    await r.refresh({ deepseek: renamed }, () => r.offered(DS, "deepseek-flash") === false)
    expect(r.offered(DS, "deepseek-flash-0910")).toBe(true)
    expect<unknown>((await r.list()).repairs).toEqual([
      {
        model: "deepseek-flash",
        uses: [
          {
            kind: "pin",
            group: "codex",
            presetID: QUICK_ID,
            place: "own-quick",
            account: DEEPSEEK_KEY,
            suggestion: "deepseek-flash-0910",
          },
          // The DeepSeek group's own default was that model too: the same notice, its own alert.
          { kind: "default", group: "ds", suggestion: "deepseek-flash-0910" },
        ],
      },
    ])
    expect(r.alerts.map((alert) => alert.code)).toEqual(["preset_needs_repair", "group_default_model_missing"])
    // Until the user fixes it, quick work runs like the main; the preset still names the old id.
    expect((await r.presets.resolver.resolve(quick, await astra(r))).roles["own-quick"]?.fallback).toBe(true)
    expect<unknown>(r.presets.presetsOf("codex")[0]?.workers.roles["own-quick"]?.targets).toEqual([
      pin(DEEPSEEK_KEY, "deepseek-flash"),
    ])
  })
})

describe("what is not a repair (U3)", () => {
  test("a new model changes no preset, pair, default or file and raises nothing; it is only selectable", async () => {
    const pairs = { "gpt-6-astra": { model: "gpt-6-luna", source: "auto" } }
    await using r = await rig({ file: file({ codex: { presets: [REVIEW, LIGHT], lighter: pairs } }) })
    await r.settle()
    const before = { list: await r.list(), file: await r.file() }
    const defaultModel = await r.presets.defaultFor({ kind: "codex", providerID: CODEX_A })
    const newest = model("openai", "gpt-7", { family: "gpt-7", released: Date.UTC(2026, 9, 1), price: 20 })
    await r.refresh({ openai: [...OPENAI, newest] }, () => r.offered(CODEX_A, "gpt-7") === true)
    expect(await r.list()).toEqual(before.list)
    expect(await r.file()).toEqual(before.file)
    expect(await r.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual(defaultModel)
    expect(r.alerts).toEqual([])
  })

  test("a Codex retirement date alone raises nothing and offers no successor; the date shows beside the model", async () => {
    const retiring = Date.parse("2026-10-14T00:00:00Z")
    const cache = JSON.stringify({
      models: [
        { slug: "gpt-6-sol", upgrade: { model: "gpt-6.1-sol", retirement_at: "2026-10-14T00:00:00Z" } },
        { slug: "gpt-6-astra" },
      ],
    })
    const cross = stored(CROSS_ID, "ChatGPT 리뷰", "claude-sub", { "own-review": [pin(CHATGPT_01, "gpt-6-sol")] })
    await using r = await rig({
      file: file({ "claude-sub": { presets: [cross] } }),
      codex: { "models_cache.json": cache },
    })
    await r.settle()
    const claude = await r.row("claude-sub")
    expect(claude).toMatchObject({ status: "ok", retirements: { "gpt-6-sol": retiring } })
    expect(claude?.presets?.map((item) => item.status)).toEqual(["ok", "ok"])
    expect((await r.list()).repairs).toBeUndefined()
    expect(r.alerts).toEqual([])
  })
})

describe("lighter pairs and group defaults (07 §4.2, §2.2)", () => {
  test("a gone lighter pair is marked 없어짐 and never decided again; the role runs like the main", async () => {
    const pairs = { "gpt-6-astra": { model: "gpt-6-luna", source: "auto" } }
    await using r = await rig({ file: file({ codex: { presets: [LIGHT], lighter: pairs } }) })
    await r.settle()
    const before = await r.file()
    await r.refresh({ openai: without(OPENAI, "gpt-6-luna") }, () => r.offered(CODEX_A, "gpt-6-luna") === false)
    const codex = await r.row("codex")
    expect<unknown>(codex?.lighter).toEqual({ "gpt-6-astra": { model: "gpt-6-luna", source: "auto", missing: true } })
    expect(codex?.status).toBe("needs_repair")
    // `[짝 고치기]` offers the rule's result (the newest of the cheapest cheaper family left), never applied by itself.
    expect<unknown>((await r.list()).repairs).toEqual([
      {
        model: "gpt-6-luna",
        uses: [{ kind: "lighter", group: "codex", main: "gpt-6-astra", suggestion: "gpt-5.6-luna" }],
      },
    ])
    const main = await astra(r)
    const resolution = await r.presets.resolver.resolve(LIGHT, main, { write: true })
    expect(resolution.roles.explore).toMatchObject({ use: main.ref, fallback: true })
    expect(await r.file()).toEqual(before)
    const needs = r.coded("preset_needs_repair")
    expect(r.alerts).toHaveLength(1)
    expect(needs[0]?.message).toContain("'메인 계정의 더 가벼운 모델'은 고칠 때까지 메인 모델로 돕니다.")
  })

  test("a gone user default: new sessions start on the group rule, one group_default_model_missing, the value stays", async () => {
    const userDefault = { id: "gpt-5.6-sol", variant: "high", source: "user" }
    await using r = await rig({ file: file({ codex: { defaultModel: userDefault } }) })
    await r.settle()
    expect(await r.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-5.6-sol",
      variant: "high",
    })
    await r.refresh({ openai: without(OPENAI, "gpt-5.6-sol") }, () => r.offered(CODEX_A, "gpt-5.6-sol") === false)
    expect(await r.row("codex")).toMatchObject({
      defaultModel: { ...userDefault, missing: true },
      label: "user",
    })
    expect<unknown>((await r.list()).repairs).toEqual([
      { model: "gpt-5.6-sol", uses: [{ kind: "default", group: "codex", suggestion: "gpt-6-astra" }] },
    ])
    expect(await r.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-astra",
    })
    expect(r.alerts).toHaveLength(1)
    expect(r.coded("group_default_model_missing")[0]?.message).toBe(
      "ChatGPT 새 대화 기본 모델 gpt-5.6-sol이(가) 없어졌습니다. 새 대화는 gpt-6-astra(으)로 시작합니다.",
    )
    expect<unknown>((await r.file()).groups.codex?.defaultModel).toEqual(userDefault)

    // The model comes back: the user's value is used again.
    await r.refresh({ openai: OPENAI }, () => r.offered(CODEX_A, "gpt-5.6-sol") === true)
    expect<unknown>((await r.row("codex"))?.defaultModel).toEqual(userDefault)
    expect(await r.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-5.6-sol",
      variant: "high",
    })
    expect(r.alerts).toHaveLength(1)
  })
})

describe("presets.set{repairOf} (07 §4.3 [고치기], §7.2 수리 기록)", () => {
  const TWICE = stored(TWICE_ID, "Claude에게 맡기기", "codex", {
    "own-review": [pin(CLAUDE, "claude-opus-5")],
    "own-deep": [pin(CLAUDE, "claude-opus-5")],
  })
  const save = (roles: Record<string, ReadonlyArray<unknown>>) =>
    decodeSave({
      id: TWICE_ID,
      name: TWICE.name,
      group: "codex",
      workers: {
        mode: "by-role",
        roles: Object.fromEntries(
          Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }]),
        ),
      },
      delegation: "when-useful",
      caps: Preset.CAPS,
      ultraCaps: null,
    })
  const repairOf = (place: Preset.Place) => Schema.decodeUnknownSync(Preset.RepairOf)({ model: "claude-opus-5", place })

  test("each fix of one place is saved and appended to the group's history; a new gone pin is still refused", async () => {
    await using r = await rig({ file: file({ codex: { presets: [TWICE] } }) })
    await r.settle()
    await r.refresh({ anthropic: without(ANTHROPIC, "claude-opus-5") })
    expect(r.alerts).toHaveLength(1)

    // Review first: the deep row still names the gone model, which does not refuse this save.
    const first = await r.presets.set(
      {
        preset: save({ "own-review": [pin(CLAUDE, "claude-opus-5-5")], "own-deep": [pin(CLAUDE, "claude-opus-5")] }),
        repairOf: repairOf("own-review"),
      },
      rpcContext(),
    )
    expect(ok(first).preset.revision).toBe(2)
    const at = r.t.clock.now()
    expect<unknown>((await r.file()).groups.codex?.history).toEqual([
      {
        at,
        presetID: TWICE_ID,
        place: "own-review",
        from: "claude-opus-5",
        to: { pin: { account: CLAUDE, model: "claude-opus-5-5" } },
      },
    ])
    await r.settle()
    expect(r.alerts).toHaveLength(1)
    expect((await r.row("codex"))?.status).toBe("needs_repair")

    // Then deep work: the row goes, so the role runs like the main.
    ok(
      await r.presets.set(
        { preset: save({ "own-review": [pin(CLAUDE, "claude-opus-5-5")] }), repairOf: repairOf("own-deep") },
        rpcContext(),
      ),
    )
    const codex = await r.row("codex")
    expect(codex?.status).toBe("ok")
    expect(codex?.presets?.map((item) => item.status)).toEqual(["ok", "ok"])
    expect<unknown>(codex?.history?.map((record) => [record.place, record.to])).toEqual([
      ["own-review", { pin: { account: CLAUDE, model: "claude-opus-5-5" } }],
      ["own-deep", { rel: "main" }],
    ])
    expect((await r.list()).repairs).toBeUndefined()
    await r.settle()
    expect(r.alerts).toHaveLength(1)

    // A fix that names a model the place never had is saved without a record; pinning a gone model is refused.
    ok(
      await r.presets.set(
        { preset: save({ "own-review": [pin(CLAUDE, "claude-opus-5-5")] }), repairOf: repairOf("explore") },
        rpcContext(),
      ),
    )
    expect((await r.file()).groups.codex?.history).toHaveLength(2)
    expect(
      failure(
        await r.presets.set(
          { preset: save({ "own-quick": [pin(CLAUDE, "claude-opus-5")] }), repairOf: repairOf("own-quick") },
          rpcContext(),
        ),
      ),
    ).toMatchObject({ type: "preset_target_unavailable", data: { role: "own-quick" } })
    expect((await r.file()).groups.codex?.history).toHaveLength(2)
  })
})

describe("when the presence check runs (07 §4.3 (가))", () => {
  test("after a refold of this Location, models-dev.refreshed or a presets.json change, once the burst settles", async () => {
    await using r = await rig({ file: file({ codex: { presets: [REVIEW] } }) })
    await r.settle()
    r.modules.slots.transformProviders(
      fakeEditor({
        openai: { models: OPENAI },
        anthropic: { models: without(ANTHROPIC, "claude-opus-5") },
        deepseek: { models: DEEPSEEK },
      }).editor,
    )
    // Another Location's refold is that Location's to follow.
    await r.presets.onEvent?.(event("provider.updated"), { local: false })
    r.t.clock.advance(PresetRepair.SETTLE_MS)
    await Bun.sleep(20)
    expect(r.alerts).toEqual([])
    await r.presets.onEvent?.(event("provider.updated"), { local: true })
    r.t.clock.advance(PresetRepair.SETTLE_MS - 1)
    await Bun.sleep(20)
    expect(r.alerts).toEqual([])
    r.t.clock.advance(1)
    await until(() => r.alerts.length === 1)
    expect(r.alerts[0]?.code).toBe("preset_needs_repair")

    // A hand edit of presets.json pins a model the Claude catalog never had: a new event after the change settles.
    const old = stored(DEEP_ID, "옛 리뷰", "codex", { "own-review": [pin(CLAUDE, "claude-opus-4-1")] })
    await r.deps.runtime.presets.write(file({ codex: { presets: [REVIEW, old] } }))
    r.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    await until(() => r.presets.presetsOf("codex").length === 2)
    r.t.clock.advance(PresetRepair.SETTLE_MS)
    await until(() => r.alerts.length === 2)
    expect(r.alerts[1]?.message).toContain("claude-opus-4-1")
    await r.presets.repair.check()
    expect(r.alerts).toHaveLength(2)
  })

  test("every instance follows the events, only the leader alerts: a new leader does not announce a model again", async () => {
    await using r = await rig({ file: file({ codex: { presets: [REVIEW, DEEP] } }) })
    await r.settle()
    r.leader.value = false
    const changed = r.changed()
    await r.refresh({ anthropic: without(ANTHROPIC, "claude-opus-5") })
    expect(r.alerts).toEqual([])
    // Every Location runs the check; only the leader tells clients to read `presets.list` again.
    expect(r.changed()).toBe(changed)
    // This instance takes over: the event it followed stays announced; the next one is its to raise.
    r.leader.value = true
    await r.settle()
    expect(r.alerts).toEqual([])
    await r.refresh({ anthropic: without(ANTHROPIC, "claude-opus-5", "claude-haiku-4-5") })
    expect(r.alerts).toEqual([])
    const fable = stored(LIGHT_ID, "Fable 리뷰", "codex", { "own-review": [pin(CLAUDE, "claude-fable-5-1")] })
    await r.deps.runtime.presets.write(file({ codex: { presets: [REVIEW, DEEP, fable] } }))
    r.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    await until(() => r.presets.presetsOf("codex").length === 3)
    await r.refresh({ anthropic: without(ANTHROPIC, "claude-opus-5", "claude-fable-5-1") })
    expect(r.alerts.map((alert) => alert.message.split(" ")[1])).toEqual(["claude-fable-5-1이(가)"])
  })
})

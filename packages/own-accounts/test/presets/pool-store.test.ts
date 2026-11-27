// The model pool in the presets store (07 §2.1, §3.3, §4.3, §8.1 모델 묶음, T4): lenient loading entry by entry,
// presets.set's pool checks and frozen cards, the repair of a pool entry and its history, presence and repair notices
// for pins and main-account entries, and a rollback's older build rewriting presets.json. Fake accounts, catalogs and
// Codex files only (the Codex home is a temp fixture folder).

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { Preserve, Preset, Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { failure, rpcContext } from "../slots/support.js"
import {
  CHATGPT_02,
  CLAUDE,
  DEEPSEEK_KEY,
  OLLAMA,
  OPENAI_KEY,
  harness,
  type Harness,
} from "./fixtures/catalog-2026-10-01.js"

setDefaultTimeout(30_000)

const decodeSave = Schema.decodeUnknownSync(Preset.Save)
const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const ID = Preset.ID.make("pr_01JB00000000000000000000PP")
const OTHER = Preset.ID.make("pr_01JB00000000000000000000QQ")

/** A model pool preset to save; `id` set = an update. */
function save(pool: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return decodeSave({
    name: "모델 묶음",
    group: "codex",
    workers: { mode: "same", roles: {}, pool },
    delegation: "when-useful",
    caps: Preset.CAPS,
    ultraCaps: null,
    ...extra,
  })
}

async function stored(h: Harness, input: Preset.Save, extra: { refreshCards?: boolean; repairOf?: unknown } = {}) {
  const out = await h.presets.set({ preset: input, ...extra } as never, rpcContext())
  if (!("preset" in out)) throw new Error(`set failed: ${JSON.stringify(out)}`)
  return out
}

const refused = async (h: Harness, input: Preset.Save) => failure(await h.presets.set({ preset: input }, rpcContext()))

const LUNA = { key: "gpt-6-luna", model: "gpt-6-luna" }
const OPUS = { key: "claude-opus-5-5", model: "claude-opus-5-5", account: CLAUDE }
const QWEN = { key: "qwen3-coder-30b", model: OLLAMA.id, account: "local:ollama" }
const DSPRO = { key: "deepseek-v4-pro", model: "deepseek-v4-pro", account: DEEPSEEK_KEY }

describe("presets.set with a model pool (07 §8.1)", () => {
  test("stored with mode same and frozen cards; warnings per pool spot; resolution carries the pool", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const out = await stored(h, save([LUNA, { ...OPUS, card: { name: "forged", at: 1 } }, QWEN, DSPRO]))
    const workers = out.preset.workers
    expect(workers.mode).toBe("same")
    expect(Preset.modeOf(workers)).toBe("pool")
    expect(workers.pool?.map((entry) => [entry.key, entry.card?.name, entry.card?.at])).toEqual([
      ["gpt-6-luna", "GPT-6-LUNA", h.t.clock.now()],
      // A client's card is never kept.
      ["claude-opus-5-5", "CLAUDE-OPUS-5-5", h.t.clock.now()],
      [QWEN.key, OLLAMA.name, h.t.clock.now()],
      ["deepseek-v4-pro", "DEEPSEEK-V4-PRO", h.t.clock.now()],
    ])
    expect(workers.pool?.[2]?.card?.windowVerified).toBe(false)
    expect(out.warnings).toEqual([
      { code: "local-unverified", place: `pool:${QWEN.key}` },
      { code: "paid", place: "pool:deepseek-v4-pro" },
    ])
    expect(out.resolution?.pool?.entries.map((entry) => entry.key)).toEqual(workers.pool?.map((entry) => entry.key))
    expect<unknown>((await h.file()).groups.codex?.presets?.[0]?.workers).toEqual(workers)
  })

  test("unchanged entries keep their card; new ones and refreshCards freeze from the catalog now", async () => {
    await using h = await harness()
    const first = await stored(h, save([LUNA]))
    const at = h.t.clock.now()
    h.t.clock.advance(60_000)
    const id = first.preset.id
    const again = await stored(h, save([{ ...LUNA, note: "fast" }, OPUS], { id }))
    expect(again.preset.workers.pool?.map((entry) => entry.card?.at)).toEqual([at, h.t.clock.now()])
    expect(again.preset.workers.pool?.[0]?.note).toBe("fast")
    h.t.clock.advance(60_000)
    const refreshed = await stored(h, save([LUNA, OPUS], { id }), { refreshCards: true })
    expect(refreshed.preset.workers.pool?.map((entry) => entry.card?.at)).toEqual([h.t.clock.now(), h.t.clock.now()])
  })

  test("pool_invalid: empty, too many, bad or reserved keys, long notes, a key or target twice", async () => {
    await using h = await harness()
    const many = Array.from({ length: Preset.POOL_MAX + 1 }, (_, index) => ({ key: `m${index}`, model: "gpt-6-luna" }))
    for (const pool of [
      [],
      many,
      [{ key: "Bad Key", model: "gpt-6-luna" }],
      [{ key: "explore", model: "gpt-6-luna" }],
      [{ ...LUNA, note: "n".repeat(Preset.NOTE_MAX + 1) }],
      [LUNA, { ...OPUS, key: LUNA.key }],
      [LUNA, { ...LUNA, key: "luna-again" }],
    ])
      expect(await refused(h, save(pool))).toMatchObject({ type: "internal_error", message: "pool_invalid" })
    expect(await Bun.file(h.deps.runtime.layout.presets).exists()).toBe(false)
  })

  test("new entries must be offered now: a main-account model of the group, a pin of its account", async () => {
    await using h = await harness()
    expect(await refused(h, save([{ key: "gpt-0", model: "gpt-0" }]))).toMatchObject({
      type: "preset_target_unavailable",
      data: { role: "pool:gpt-0" },
    })
    expect(await refused(h, save([LUNA, { ...OPUS, key: "claude-none", model: "claude-none" }]))).toMatchObject({
      data: { role: "pool:claude-none" },
    })
    expect(await refused(h, save([{ key: "gpt-6-pico", model: "gpt-6-pico" }]))).toMatchObject({
      data: { role: "pool:gpt-6-pico" },
    })
  })

  test("R4: another subscription of the group's company is refused; a paid key of it is allowed", async () => {
    await using h = await harness()
    expect(await refused(h, save([{ key: "gpt-6-sol", model: "gpt-6-sol", account: CHATGPT_02 }]))).toMatchObject({
      type: "same_company_subscription",
      data: { accountID: CHATGPT_02 },
    })
    const keyed = await stored(h, save([{ key: "gpt-6-sol-api", model: "gpt-6-sol", account: OPENAI_KEY }]))
    expect(keyed.warnings).toEqual([{ code: "paid", place: "pool:gpt-6-sol-api" }])
  })

  test("saving another mode drops nothing it does not have; a pool is never kept under another mode", async () => {
    await using h = await harness()
    const pooled = await stored(h, save([LUNA]))
    const back = await stored(
      h,
      decodeSave({ ...save([LUNA]), id: pooled.preset.id, workers: { mode: "same", roles: {} } }),
    )
    expect(back.preset.workers.pool).toBeUndefined()
    expect(Preset.modeOf(back.preset.workers)).toBe("same")
  })
})

/** A ChatGPT group whose pool names gone models: gpt-5.4 on the main account (Codex says gpt-6-sol), Opus 4 on Claude. */
const CODEX_CACHE = JSON.stringify({
  fetched_at: "2026-10-01T00:00:00Z",
  client_version: "0.157.0",
  models: [
    { slug: "gpt-5.4", upgrade: { model: "gpt-6-sol", retirement_at: null } },
    { slug: "gpt-6-luna", upgrade: { model: "gpt-6-sol", retirement_at: "2027-01-01T00:00:00Z" } },
  ],
})

function gonePool(): Preset.File {
  return Schema.decodeUnknownSync(Preset.File)({
    version: 1,
    groups: {
      codex: {
        presets: [
          {
            ...Preset.builtin("codex"),
            id: ID,
            name: "모델 묶음",
            revision: 1,
            delegation: "when-useful",
            workers: {
              mode: "same",
              roles: {},
              pool: [
                { key: "gpt-5.4", model: "gpt-5.4", card: { name: "GPT-5.4", at: 1 } },
                LUNA,
                { key: "claude-opus-4", model: "claude-opus-4", account: CLAUDE },
              ],
            },
          },
        ],
      },
    },
  })
}

describe("gone pool models and their repair (07 §4.3, §7.2)", () => {
  test("presence: needs_repair, one notice per model; the main-account use offers the group's successor", async () => {
    await using h = await harness({ codex: { "models_cache.json": CODEX_CACHE } })
    await h.deps.runtime.presets.write(gonePool())
    h.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    const list = await h.presets.list({ group: "codex" }, rpcContext())
    if (!("groups" in list)) throw new Error("list failed")
    expect(list.groups[0]?.presets?.find((preset) => preset.id === ID)?.status).toBe("needs_repair")
    expect<unknown>(list.repairs).toEqual([
      {
        model: "gpt-5.4",
        uses: [{ kind: "pin", group: "codex", presetID: ID, place: "pool:gpt-5.4", suggestion: "gpt-6-sol" }],
      },
      {
        model: "claude-opus-4",
        uses: [{ kind: "pin", group: "codex", presetID: ID, place: "pool:claude-opus-4", account: CLAUDE }],
      },
    ])
    // Retirement dates of the group's main-account pool models are shown dimmed, never a notice.
    expect(list.groups[0]?.retirements).toEqual({ "gpt-6-luna": Date.parse("2027-01-01T00:00:00Z") })
    await h.presets.repair.check()
    const notice = h.alerts.find((alert) => alert.code === "preset_needs_repair" && alert.message.includes("gpt-5.4"))
    expect(notice?.message).toBe(
      "모델 gpt-5.4이(가) 없어졌습니다. 프리셋 1개의 모델 묶음에서 gpt-5.4은(는) 고칠 때까지 고르면 기본 규칙으로 돕니다. 프리셋 알림에서 고칩니다(제안: gpt-6-sol).",
    )
  })

  test("[고치기]: the entry takes the successor under a new key and card; poolHistory records it", async () => {
    await using h = await harness({ codex: { "models_cache.json": CODEX_CACHE } })
    await h.deps.runtime.presets.write(gonePool())
    h.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    const kept = gonePool().groups.codex?.presets?.[0]?.workers.pool ?? []
    // The client kept the old key: the service gives the new model its own key.
    const fixed = await stored(h, save([{ key: "gpt-5.4", model: "gpt-6-sol" }, ...kept.slice(1)], { id: ID }), {
      repairOf: { model: "gpt-5.4", place: "pool:gpt-5.4" },
    })
    expect(fixed.preset.workers.pool?.map((entry) => [entry.key, entry.model])).toEqual([
      ["gpt-6-sol", "gpt-6-sol"],
      ["gpt-6-luna", "gpt-6-luna"],
      ["claude-opus-4", "claude-opus-4"],
    ])
    expect(fixed.preset.workers.pool?.[0]?.card?.name).toBe("GPT-6-SOL")
    const file = await h.file()
    expect<unknown>(file.groups.codex?.poolHistory).toEqual([
      { at: h.t.clock.now(), presetID: ID, key: "gpt-5.4", from: "gpt-5.4", to: "gpt-6-sol" },
    ])
    expect(file.groups.codex?.history).toBeUndefined()
    // A client that already gave a new key: recorded the same way. Removing the entry records no `to`.
    const removed = await stored(h, save([LUNA], { id: ID }), {
      repairOf: { model: "claude-opus-4", place: "pool:claude-opus-4" },
    })
    expect(removed.preset.workers.pool?.map((entry) => entry.key)).toEqual(["gpt-6-luna"])
    expect<unknown>((await h.file()).groups.codex?.poolHistory?.[1]).toEqual({
      at: h.t.clock.now(),
      presetID: ID,
      key: "claude-opus-4",
      from: "claude-opus-4",
    })
    const list = await h.presets.list({ group: "codex" }, rpcContext())
    if (!("groups" in list)) throw new Error("list failed")
    expect(list.groups[0]?.poolHistory?.length).toBe(2)
  })
})

describe("loading a hand-edited pool (07 §5.4 presets.json 로드, §8.1)", () => {
  test("only the broken entries leave the loaded view, with one alert each; the file and other presets stay", async () => {
    await using h = await harness()
    const pool = [
      LUNA,
      { key: "Bad Key", model: "gpt-6-sol" },
      { key: "gpt-6-luna", model: "gpt-6-astra" },
      { key: "luna-twice", model: "gpt-6-luna" },
      { key: "noted", model: "gpt-6-astra", note: "n".repeat(Preset.NOTE_MAX + 1) },
      { key: "gpt-6-sol", model: "gpt-6-sol", account: CHATGPT_02 },
      OPUS,
      ...Array.from({ length: Preset.POOL_MAX }, (_, index) => ({
        key: `extra-${index}`,
        model: `extra-model-${index}`,
      })),
    ]
    const edited = {
      version: 1 as const,
      groups: {
        codex: {
          presets: [
            decodeInfo({ ...save(pool), id: ID, revision: 2 }),
            decodeInfo({ ...save([LUNA]), id: OTHER, name: "다른 것", revision: 1 }),
          ],
        },
      },
    }
    await h.presets.stop()
    await h.deps.runtime.presets.write(edited)
    const bytes = await Bun.file(h.deps.runtime.layout.presets).text()
    await h.presets.start()
    const loaded = h.presets.preset(ID, "codex")?.workers.pool?.map((entry) => entry.key)
    // The first POOL_MAX entries are judged; the R4 breach is dropped after the format checks.
    expect(loaded).toEqual(["gpt-6-luna", "claude-opus-5-5", "extra-0", "extra-1", "extra-2", "extra-3", "extra-4"])
    expect(h.presets.preset(OTHER, "codex")?.workers.pool?.length).toBe(1)
    expect(await Bun.file(h.deps.runtime.layout.presets).text()).toBe(bytes)
    expect(h.alerts.filter((alert) => alert.code === "preset_entry_dropped").map((alert) => alert.subject)).toEqual([
      `${ID}:pool:Bad Key`,
      `${ID}:pool:gpt-6-luna`,
      `${ID}:pool:luna-twice`,
      `${ID}:pool:noted`,
      ...Array.from({ length: 7 }, (_, index) => `${ID}:pool:extra-${index + 5}`),
      `${ID}:pool:gpt-6-sol`,
    ])
    expect(h.alerts.find((alert) => alert.subject === `${ID}:pool:gpt-6-sol`)?.accountID).toBe(CHATGPT_02)
  })
})

describe("rollback (07 §2.4 앞으로 호환, P02/P05)", () => {
  test("an older build's store updating another preset keeps pool and poolHistory", async () => {
    await using h = await harness()
    const pooled = await stored(h, save([LUNA, OPUS]))
    const other = await stored(h, decodeSave({ ...save([LUNA]), name: "평범", workers: { mode: "same", roles: {} } }))
    const OldWorkers = Schema.Struct({
      mode: Schema.Literals(["same", "single", "by-role"]),
      single: optional(Preset.Target),
      roles: Preset.Workers.fields.roles,
    })
    const OldInfo = Schema.Struct({ ...Preset.Info.fields, workers: OldWorkers })
    const OldGroup = Schema.Struct({
      defaultModel: optional(Preset.DefaultModel),
      star: optional(Preset.ID),
      presets: optional(Schema.Array(OldInfo)),
      lighter: optional(Schema.Record(Schema.String, Preset.Lighter)),
      history: optional(Schema.Array(Preset.RepairRecord)),
    })
    const OldFile = Schema.Struct({ ...Preset.File.fields, groups: Schema.Record(Schema.String, OldGroup) })
    const older = new Store.JsonFile({
      file: h.deps.runtime.layout.presets,
      schema: OldFile,
      fallback: () => ({ version: 1 as const, groups: {} }),
    })
    const read = await older.read()
    expect(read.groups.codex?.presets?.find((preset) => preset.id === pooled.preset.id)?.workers.mode).toBe("same")
    await older.update((file) => ({
      ...file,
      groups: {
        ...file.groups,
        codex: {
          ...file.groups.codex,
          presets: (file.groups.codex?.presets ?? []).map((preset) =>
            preset.id === other.preset.id ? { ...preset, name: "이름 바꿈" } : preset,
          ),
        },
      },
    }))
    const after = await h.deps.runtime.presets.read()
    const presets = after.groups.codex?.presets ?? []
    expect(presets.find((preset) => preset.id === other.preset.id)?.name).toBe("이름 바꿈")
    expect<unknown>(presets.find((preset) => preset.id === pooled.preset.id)?.workers.pool).toEqual(
      pooled.preset.workers.pool,
    )
    expect(
      Option.getOrThrow(Preserve.decode(OldFile)(await Bun.file(path.resolve(h.deps.runtime.layout.presets)).json())),
    ).toBeDefined()
  })
})

// presets.set / presets.remove and the load check (07 §5.3, §5.4, §8.1) over the real presets store: revisions,
// recent presets, dry runs, R4 at save time (PG2 나·다, the same-login rule), target checks, ★ on removal, and
// hand-edited same-company targets dropped on load (PG2 라). Fake accounts only.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Preset } from "@own/protocol"
import { PresetsRpc } from "../../src/rpc/presets.js"
import { failure, rpcContext } from "../slots/support.js"
import {
  CHATGPT_01,
  CHATGPT_02,
  CLAUDE,
  CLAUDE_OFF,
  CODEX_A,
  DEEPSEEK_KEY,
  OAI,
  OLLAMA,
  OPENAI_KEY,
  SIWC_01,
  SIWC_UNKNOWN,
  harness,
  type Harness,
} from "./fixtures/catalog-2026-10-01.js"

const decodeSave = Schema.decodeUnknownSync(Preset.Save)
const decodeInfo = Schema.decodeUnknownSync(Preset.Info)

const pin = (account: string, model: string) => ({ pin: { account, model } })
const LIGHTER = { rel: "lighter" }

/** A `by-role` preset to save; `roles` maps a role to its targets in order. */
function save(group: Preset.Group, roles: Partial<Record<Preset.Role, ReadonlyArray<unknown>>>, extra = {}) {
  return decodeSave({
    name: "다른 회사 리뷰",
    group,
    workers: {
      mode: "by-role",
      roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
    },
    delegation: "when-useful",
    caps: Preset.CAPS,
    ultraCaps: null,
    ...extra,
  })
}

async function stored(h: Harness, input: Preset.Save) {
  const out = await h.presets.set({ preset: input }, rpcContext())
  if (!("preset" in out)) throw new Error(`set failed: ${JSON.stringify(out)}`)
  return out
}

describe("presets.set (07 §8.1)", () => {
  test("a new preset is stored under its group with revision 1 and leads recent; each save raises the revision", async () => {
    await using h = await harness()
    const input = save("codex", { explore: [LIGHTER], "own-review": [pin(CLAUDE, "claude-opus-5-5")] })
    const first = await stored(h, input)
    expect(first.preset.id).toMatch(/^pr_/)
    expect(first).toMatchObject({ preset: { ...input, revision: 1 }, warnings: [], dryRun: false })
    // Resolved for the group's new-session default on its first account. The lighter pair the rule gives now is shown,
    // not stored: saving is not a need, so it is decided when the user's main first needs it (07 §4.2).
    expect<unknown>(first.resolution?.roles.explore?.use).toEqual({ providerID: CODEX_A, id: "gpt-6-luna" })
    expect<unknown>(first.resolution?.roles["own-review"]?.use).toEqual({
      providerID: "anthropic",
      id: "claude-opus-5-5",
    })
    const file = await h.file()
    expect<unknown>(file.groups.codex?.presets).toEqual([first.preset])
    expect<unknown>(file.groups.codex?.lighter).toBeUndefined()
    expect(file.recent).toEqual([first.preset.id])

    const other = await stored(h, { ...input, name: "두 번째" })
    const again = await stored(h, { ...input, id: first.preset.id, name: "Claude 리뷰" })
    expect(again.preset).toMatchObject({ id: first.preset.id, name: "Claude 리뷰", revision: 2 })
    const after = await h.file()
    expect(after.groups.codex?.presets?.map((preset) => [preset.name, preset.revision])).toEqual([
      ["Claude 리뷰", 2],
      ["두 번째", 1],
    ])
    expect(after.recent).toEqual([first.preset.id, other.preset.id])
    expect(h.presets.preset(first.preset.id, "codex")?.name).toBe("Claude 리뷰")
    expect(h.events.some((event) => event.name === "presets.changed")).toBe(true)
  })

  test("dryRun answers the resolution and the warnings and writes nothing", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const input = save("claude-sub", {
      explore: [pin(OPENAI_KEY, "gpt-6-luna")],
      "own-review": [pin(DEEPSEEK_KEY, "deepseek-flash")],
      "own-quick": [pin("local:ollama", OLLAMA.id)],
    })
    const out = await h.presets.set({ preset: input, dryRun: true }, rpcContext())
    expect(out).toMatchObject({
      dryRun: true,
      preset: { ...input, revision: 1 },
      warnings: [
        { code: "paid", place: "explore" },
        { code: "paid", place: "own-review" },
        { code: "local-unverified", place: "own-quick" },
      ],
    })
    expect<unknown>("resolution" in out ? out.resolution?.roles.explore?.use : undefined).toEqual({
      providerID: OAI,
      id: "gpt-6-luna",
    })
    expect(await Bun.file(h.deps.runtime.layout.presets).exists()).toBe(false)
    expect(h.events).toEqual([])
  })

  test("R4 at save time: a same-company subscription is refused and nothing is written (PG2 나·다)", async () => {
    await using h = await harness()
    const refused = async (input: Preset.Save) => failure(await h.presets.set({ preset: input }, rpcContext()))
    // (나) A Claude preset with explore on ChatGPT 01 and review on ChatGPT 02: two OpenAI subscriptions.
    expect(
      await refused(
        save("claude-sub", {
          explore: [pin(CHATGPT_01, "gpt-6-luna")],
          "own-review": [pin(CHATGPT_02, "gpt-6-astra")],
        }),
      ),
    ).toMatchObject({ type: "same_company_subscription", data: { accountID: CHATGPT_02 } })
    // (다) A ChatGPT preset whose review falls back to ChatGPT 02.
    expect(
      await refused(save("codex", { "own-review": [pin(CLAUDE, "claude-opus-5-5"), pin(CHATGPT_02, "gpt-6-sol")] })),
    ).toMatchObject({ type: "same_company_subscription", data: { accountID: CHATGPT_02 } })
    // Sign in with ChatGPT on the main group's company is refused too, even on ChatGPT 01's own login.
    expect(await refused(save("codex", { explore: [pin(SIWC_01, "gpt-5.6-luna")] }))).toMatchObject({
      type: "same_company_subscription",
      data: { accountID: SIWC_01 },
    })
    // In another company's preset, codex and siwc of one ChatGPT login are one subscription; an unknown login is not.
    expect(
      await refused(
        save("claude-sub", {
          explore: [pin(CHATGPT_01, "gpt-6-luna")],
          "own-review": [pin(SIWC_UNKNOWN, "gpt-6-astra")],
        }),
      ),
    ).toMatchObject({ type: "same_company_subscription", data: { accountID: SIWC_UNKNOWN } })
    expect(await Bun.file(h.deps.runtime.layout.presets).exists()).toBe(false)
    const sameLogin = await stored(
      h,
      save("claude-sub", { explore: [pin(CHATGPT_01, "gpt-6-luna")], "own-review": [pin(SIWC_01, "gpt-6-astra")] }),
    )
    expect(sameLogin.preset.revision).toBe(1)
    // A paid key of the same company is no subscription: allowed, with a warning.
    const keyed = await stored(h, save("codex", { "own-review": [pin(OPENAI_KEY, "gpt-6-sol")] }))
    expect(keyed.warnings).toEqual([{ code: "paid", place: "own-review" }])
  })

  test("every stored target must exist and call tools (preset_target_unavailable)", async () => {
    await using h = await harness()
    const unavailable = async (input: Preset.Save) => failure(await h.presets.set({ preset: input }, rpcContext()))
    expect(await unavailable(save("codex", { explore: [pin(CLAUDE, "claude-none")] }))).toMatchObject({
      type: "preset_target_unavailable",
      data: { role: "explore" },
    })
    // gpt-6-pico cannot call tools; an inactive row is checked too (`모두 메인과 같게` uses none).
    const inactive = { "own-review": { targets: [pin(OPENAI_KEY, "gpt-6-pico")], effort: "inherit" } }
    expect(await unavailable(save("codex", {}, { workers: { mode: "same", roles: inactive } }))).toMatchObject({
      data: { role: "own-review" },
    })
    expect(
      await unavailable(decodeSave({ ...save("codex", {}), workers: { mode: "single", roles: {} } })),
    ).toMatchObject({ type: "preset_target_unavailable", data: { role: "single" } })
    expect(await unavailable(save("codex", { explore: [pin("local:ollama", OLLAMA.id)] }))).toMatchObject({
      data: { role: "explore" },
    })
    h.claude.value = CLAUDE_OFF
    expect(await unavailable(save("codex", { "own-quick": [pin(CLAUDE, "claude-opus-5-5")] }))).toMatchObject({
      data: { role: "own-quick" },
    })
    expect(await Bun.file(h.deps.runtime.layout.presets).exists()).toBe(false)
  })

  test("a group's 평소대로 is locked, an unknown id is not found, and a preset never changes group", async () => {
    await using h = await harness()
    const set = async (input: Preset.Save) => failure(await h.presets.set({ preset: input }, rpcContext()))
    expect(await set({ ...save("codex", {}), id: Preset.builtinID("codex") })).toMatchObject({
      type: "preset_builtin_locked",
    })
    expect(await set({ ...save("codex", {}), id: Preset.ID.make("pr_01JB0000000000000000000000") })).toMatchObject({
      type: "preset_not_found",
    })
    const first = await stored(h, save("codex", { explore: [LIGHTER] }))
    expect(await set({ ...save("ds", {}), id: first.preset.id })).toMatchObject({
      type: "preset_wrong_group",
      data: { group: "codex" },
    })
    expect(await set(save("codex", {}, { caps: { concurrent: 3, perMessage: 200, perSession: 100 } }))).toMatchObject({
      type: "internal_error",
      message: "caps_invalid",
    })
  })
})

describe("presets.remove (07 §5.3 지울 때)", () => {
  test("평소대로 is locked; removing the ★ preset returns ★ to 평소대로; the leader announces the removal", async () => {
    await using h = await harness()
    expect(failure(await h.presets.remove({ presetID: Preset.builtinID("codex") }, rpcContext()))).toMatchObject({
      type: "preset_builtin_locked",
    })
    expect(
      failure(await h.presets.remove({ presetID: Preset.ID.make("pr_01JB0000000000000000000000") }, rpcContext())),
    ).toMatchObject({ type: "preset_not_found" })
    const starred = await stored(h, save("codex", { explore: [LIGHTER] }))
    const other = await stored(h, { ...save("codex", { explore: [LIGHTER] }), name: "가볍게" })
    await h.presets.defaultsSet({ group: "codex", star: starred.preset.id }, rpcContext())
    expect(h.presets.star("codex")).toBe(starred.preset.id)

    const removed = await h.presets.remove({ presetID: starred.preset.id }, rpcContext())
    expect<unknown>(removed).toEqual({ presetID: starred.preset.id, group: "codex", star: Preset.builtinID("codex") })
    expect(h.presets.star("codex")).toBeUndefined()
    expect(h.presets.preset(starred.preset.id, "codex")).toBeUndefined()
    const file = await h.file()
    expect(file.groups.codex?.star).toBeUndefined()
    expect(file.recent).toEqual([other.preset.id])
    expect(h.events.filter((event) => event.name === "presets.changed").at(-1)?.payload).toMatchObject({
      removed: [starred.preset.id],
    })
    // Removing another preset keeps the ★.
    await h.presets.defaultsSet({ group: "codex", star: other.preset.id }, rpcContext())
    const third = await stored(h, { ...save("codex", {}), name: "세 번째" })
    expect(await h.presets.remove({ presetID: third.preset.id }, rpcContext())).toMatchObject({ star: other.preset.id })
  })
})

describe("load check (07 §5.4 presets.json 로드, PG2 라)", () => {
  test("a hand-edited same-company target is dropped from the loaded preset, never from the file, and alerted once", async () => {
    await using h = await harness()
    const id = Preset.ID.make("pr_01JB00000000000000000000AA")
    const crossed = Preset.ID.make("pr_01JB00000000000000000000BB")
    const edited = {
      version: 1 as const,
      groups: {
        codex: {
          star: id,
          presets: [
            decodeInfo({
              ...save("codex", {
                explore: [pin(CHATGPT_02, "gpt-6-luna"), LIGHTER],
                "own-review": [pin(CLAUDE, "claude-opus-5-5")],
              }),
              id,
              revision: 3,
            }),
          ],
        },
        "claude-sub": {
          presets: [
            decodeInfo({
              ...save("claude-sub", {
                explore: [pin(CHATGPT_01, "gpt-6-luna")],
                "own-review": [pin(CHATGPT_02, "gpt-6-astra")],
              }),
              id: crossed,
              revision: 1,
            }),
          ],
        },
      },
    }
    // Written while the service is down, read at start.
    await h.presets.stop()
    await h.deps.runtime.presets.write(edited)
    const bytes = await Bun.file(h.deps.runtime.layout.presets).text()
    await h.presets.start()
    expect<unknown>(h.presets.preset(id, "codex")?.workers.roles).toEqual({
      explore: { targets: [LIGHTER], effort: "inherit" },
      "own-review": { targets: [pin(CLAUDE, "claude-opus-5-5")], effort: "inherit" },
    })
    // The first OpenAI subscription of a Claude preset stays; the second is dropped.
    expect<unknown>(h.presets.preset(crossed, "claude-sub")?.workers.roles).toEqual({
      explore: { targets: [pin(CHATGPT_01, "gpt-6-luna")], effort: "inherit" },
      "own-review": { targets: [], effort: "inherit" },
    })
    expect(h.presets.star("codex")).toBe(id)
    expect(await Bun.file(h.deps.runtime.layout.presets).text()).toBe(bytes)
    expect(h.alerts.map((alert) => [alert.code, alert.accountID, alert.subject])).toEqual([
      ["preset_entry_dropped", CHATGPT_02, `${id}:explore`],
      ["preset_entry_dropped", CHATGPT_02, `${crossed}:own-review`],
    ])

    // The file watch reloads it again: nothing new to alert. A new hand edit raises only its own entry.
    h.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    expect(h.alerts).toHaveLength(2)
    const quick = decodeInfo({
      ...save("codex", {
        explore: [pin(CHATGPT_02, "gpt-6-luna"), LIGHTER],
        "own-review": [pin(CLAUDE, "claude-opus-5-5")],
        "own-quick": [pin(SIWC_01, "gpt-5.6-luna")],
      }),
      id,
      revision: 4,
    })
    await h.deps.runtime.presets.write({
      ...edited,
      groups: { ...edited.groups, codex: { star: id, presets: [quick] } },
    })
    h.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    expect(h.alerts.map((alert) => alert.subject)).toEqual([
      `${id}:explore`,
      `${crossed}:own-review`,
      `${id}:own-quick`,
    ])
  })

  test("UC 2026-10-18: 다른 모델 하나로 on 메인과 같게 loads and saves as 메인과 같은 모델로; the file is not rewritten", async () => {
    await using h = await harness()
    const id = Preset.ID.make("pr_01JB00000000000000000000CC")
    const single = (target: unknown) => ({
      ...save("codex", {}),
      workers: { mode: "single", single: target, roles: {} },
    })
    await h.presets.stop()
    await h.deps.runtime.presets.write({
      version: 1 as const,
      groups: { codex: { presets: [decodeInfo({ ...single({ rel: "main" }), id, revision: 2 })] } },
    })
    const bytes = await Bun.file(h.deps.runtime.layout.presets).text()
    await h.presets.start()
    // An older build reads the file as before (single on the main = like the main); this build lists `same`.
    expect<unknown>(h.presets.preset(id, "codex")?.workers).toEqual({ mode: "same", roles: {} })
    expect(await Bun.file(h.deps.runtime.layout.presets).text()).toBe(bytes)
    expect(h.alerts).toEqual([])

    // An older window that still sends it saves `same`; another target stays `single`.
    const saved = await stored(h, decodeSave({ ...single({ rel: "main" }), id }))
    expect<unknown>(saved.preset.workers).toEqual({ mode: "same", roles: {} })
    expect<unknown>((await h.file()).groups.codex?.presets?.[0]?.workers).toEqual({ mode: "same", roles: {} })
    const lighter = await stored(h, decodeSave({ ...single(LIGHTER), id }))
    expect<unknown>(lighter.preset.workers).toEqual({ mode: "single", single: LIGHTER, roles: {} })
  })
})

describe("RPC wiring", () => {
  test("every presets.* method is answered by the presets module", async () => {
    await using h = await harness()
    const rpc = PresetsRpc.handlers(h.modules)
    expect(failure(await rpc["presets.suggest"]({ group: "codex" }, rpcContext()))).toBeUndefined()
    const saved = await rpc["presets.set"]({ preset: save("codex", { explore: [LIGHTER] }) }, rpcContext())
    expect(failure(saved)).toBeUndefined()
    const listed = await rpc["presets.list"]({ group: "codex" }, rpcContext())
    expect("groups" in listed ? listed.groups[0]?.presets?.map((preset) => preset.name) : []).toEqual([
      "평소대로",
      "다른 회사 리뷰",
    ])
    if (!("preset" in saved)) throw new Error("set failed")
    expect(failure(await rpc["presets.remove"]({ presetID: saved.preset.id }, rpcContext()))).toBeUndefined()
  })
})

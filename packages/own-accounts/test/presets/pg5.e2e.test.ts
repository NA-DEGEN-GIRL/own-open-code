// End to end on a real upstream server: gate PG5 of 07 §8.4 (catalog changes, 07 §4). The server starts from a
// catalog variant (`OPENCODE_MODELS_PATH`, fixtures/catalog-variants/README.md) and is restarted on the same temp root
// (database, OWN_HOME, ledger, sessions) for each change, since core reads that file once:
// - additions: a newer model of a family in use (gpt-6.1-sol), which the Codex metadata also makes priority 1, a new
//   cheapest family (gpt-6-nano), and a Codex retirement date for a pinned model (gpt-5.6-sol) → no preset, lighter pair,
//   group default or session changes, no notice, no successor; the new models are only selectable (`addedAt`, the
//   `새` tag) and the date shows beside the model.
// - a pinned model deprecated (gpt-5.6-terra, used by two presets) and the lighter pair's model removed (gpt-6-luna)
//   → each role goes to its next target or runs like the main, one repair notice per model however many presets,
//   accounts or refolds, the pair is marked `없어짐` and never decided again, nothing outside a role's list is used.
// - a rename (gpt-6-astra → gpt-6-astra-1001, same family and day; pinned and the ChatGPT group's `auto` default) →
//   one notice offering the new name for the pin, the group rule's model for the default, nothing rewritten; the
//   models of the previous change came back and lost their marks quietly.
// - a level removed upstream (gpt-6-sol without `xhigh`) → the pinned template keeps its variants (`템플릿 갱신 있음`,
//   one `template_update_available`) and an `xhigh` session runs; once the user refreshes the catalog, the session's
//   main is reported gone with the refitted level to switch to, and nothing switches by itself. The rename's new id,
//   gone again, stays in the template marked missing and is announced by nobody, since nothing uses it.
// - Every catalog the server saw lists levels low → high (the order `Preset.effortToVariant` assumes), as do the Codex
//   metadata's levels. No session or hook failed.
//
// Presets: a group may not pin a subscription of its own company (R4, 07 §5.4), so the presets pinned to ChatGPT
// models belong to the DeepSeek group (main on a DeepSeek API key, children on ChatGPT 01); the ChatGPT group has the
// lighter pair (`가볍게 나눠 쓰기`) and the `auto` default (Codex metadata priority 1). Two linked ChatGPT accounts share
// the ChatGPT group. The control Location runs (`control`), so the template diff is written and the Codex metadata is
// read like in production; the fake Codex backend has no model list, so each start's fetch fails and the metadata in
// `codex-meta.json` (the e2e kit's fixture) is kept. The DeepSeek key lives in the e2e kit's memory vault, so it is
// entered again after each restart. Every credential is fake; servers bind 127.0.0.1; this PC's `.codex` is never read.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { Account, CodexModels, Preset } from "@own/protocol"
import {
  GPT_61_SOL,
  PREDATED_MODELS,
  afterToolResult,
  bundledCatalog,
  catalogVariant,
  childOf,
  codexMetaFixture,
  lastUserText,
  sessionInfo,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolOutputs,
  toolParts,
  waitUntil,
  type Catalog,
  type CatalogEdit,
  type FakeCodex,
  type FakeOpenAIChat,
  type FakeProvider,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 240_000
const STEP_TIMEOUT = 240_000
/** The presence check runs this long after a refold settles (`PresetRepair.SETTLE_MS`), plus room for the ledger. */
const SETTLED_MS = 6_000

const ONE = { accountID: "acct-pg5-01", email: "one@example.test", plan: "pro" }
const TWO = { accountID: "acct-pg5-02", email: "two@example.test", plan: "plus" }
const SLOT = "own-codex-pg01"
const CHATGPT_01 = "acc_pg01"
const CODEX_MAIN = { providerID: SLOT, id: "gpt-6-sol", variant: "high" }
const DS_KEY = "sk-fake-pg5-deepseek-0001"
const DS_MODEL = "deepseek-flash"
const RETIRES = Date.parse("2026-10-14T00:00:00Z")

const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
const AFTER_TOOL = "도구 결과를 읽었습니다."
const CHILD_DONE = "자식 작업을 마쳤습니다."
const DIRECTIVES = ["[review]", "[deep]", "[explore]"] as const
type Directive = (typeof DIRECTIVES)[number]
/** The subagent call a directive in a parent's prompt makes. */
const CALLS: Readonly<
  Record<Directive, { readonly agent: string; readonly description: string; readonly prompt: string }>
> = {
  "[review]": { agent: "own-review", description: "리뷰", prompt: "자식 작업: 리뷰" },
  "[deep]": { agent: "own-deep", description: "어려운 일", prompt: "자식 작업: 어려운 일" },
  "[explore]": { agent: "explore", description: "탐색", prompt: "자식 작업: 탐색" },
}

// Catalog variants over the bundled catalog (fixtures/catalog-variants/README.md).
const ADDITIONS: ReadonlyArray<CatalogEdit> = [
  GPT_61_SOL,
  {
    provider: "openai",
    add: "gpt-6-nano",
    from: "gpt-6-luna",
    set: {
      name: "GPT-6 Nano",
      family: "gpt-nano",
      release_date: "2026-10-01",
      last_updated: "2026-10-01",
      cost: { input: 0.05, output: 0.25, cache_read: 0.005 },
    },
  },
]
const VARIANTS = {
  additions: ADDITIONS,
  gone: [
    ...ADDITIONS,
    { provider: "openai", change: "gpt-5.6-terra", set: { status: "deprecated" } },
    { provider: "openai", remove: "gpt-6-luna" },
  ],
  renamed: [...ADDITIONS, { provider: "openai", rename: "gpt-6-astra", to: "gpt-6-astra-1001" }],
  levels: [
    ...ADDITIONS,
    {
      provider: "openai",
      change: "gpt-6-sol",
      // models.dev v2 (upstream v2.1) lists the levels in `capabilities.reasoning.effort`.
      set: (model) => ({
        capabilities: {
          ...(isRecord(model.capabilities) ? model.capabilities : {}),
          reasoning: { supported: true, effort: ["none", "low", "medium", "high", "max"] },
        },
      }),
    },
  ],
} satisfies Record<string, ReadonlyArray<CatalogEdit>>

/**
 * The ChatGPT group's lighter pairs once decided: only the main a call needed it for (saving a preset is not a need),
 * never decided again, whatever the catalog does (07 §4.2, U3).
 */
const PAIRS = {
  "gpt-6-sol": { model: "gpt-6-luna", source: "auto" },
}

const fixture: {
  codex?: FakeCodex
  chat?: FakeOpenAIChat
  rig?: PresetRig
  base?: Catalog
  /** The metadata before the additions (no gpt-6.1-sol, no upgrade hints) and with them (the fixture as fetched). */
  meta?: { readonly before: CodexModels.Snapshot; readonly after: CodexModels.Snapshot }
  ds?: { readonly id: string; readonly providerID: string }
  presets: Map<string, string>
  sessions: Map<string, string>
  /** `presets.json` groups and each session's model once the first calls decided the lighter pair. */
  baseline?: { readonly groups: unknown; readonly models: ReadonlyMap<string, unknown> }
} = { presets: new Map(), sessions: new Map() }

beforeAll(async () => {
  const codex = startFakeCodex({ responder: reply })
  const chat = startFakeOpenAIChat({ responder: reply })
  // The bundled catalog lists gpt-6.1-sol since v2.0.24 (with other levels than GPT_61_SOL's copy); the additions
  // bring it, so the starting catalog leaves it out.
  const base = catalogVariant(await bundledCatalog(), [{ provider: "openai", remove: "gpt-6.1-sol" }])
  const fetched = await codexMetaFixture()
  const after: CodexModels.Snapshot = {
    ...fetched,
    models: fetched.models.map((row) =>
      row.slug === "gpt-5.6-terra"
        ? { ...row, upgrade: { model: "gpt-6.1-sol", retirement_at: null } }
        : // Codex's list dates gpt-5.5, which ChatGPT accounts no longer run (upstream v2.1): a pinned model gets one.
          row.slug === "gpt-5.6-sol"
          ? { ...row, upgrade: { model: "gpt-6-sol", retirement_at: new Date(RETIRES).toISOString() } }
          : row,
    ),
  }
  const before: CodexModels.Snapshot = {
    ...fetched,
    models: fetched.models.filter((row) => row.slug !== "gpt-6.1-sol").map((row) => ({ ...row, upgrade: null })),
  }
  Object.assign(fixture, { codex, chat, base, meta: { before, after } })
  fixture.rig = await startPresetRig({
    name: "pg5",
    codex,
    chatgpt: [
      { id: "01", tokens: codex.login(ONE) },
      { id: "02", tokens: codex.login(TWO) },
    ],
    endpoints: { deepseek: chat.baseURL },
    catalog: base,
    codexMeta: before,
    control: true,
    templatePredates: PREDATED_MODELS,
    models: [CODEX_MAIN],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
}, 60_000)

describe("PG5: catalog changes (07 §4, §8.4)", () => {
  test(
    "setup: presets, sessions and the first calls on the bundled catalog",
    async () => {
      const rig = required(fixture.rig)
      const added = await rig.call("accounts.add.key", { kind: "ds", label: "DeepSeek", key: DS_KEY })
      const account = isRecord(added.account) ? added.account : {}
      fixture.ds = { id: String(account.id), providerID: String(account.providerID) }
      await rig.server.waitForModels([{ providerID: required(fixture.ds).providerID, id: DS_MODEL }])
      // Both groups' `auto` defaults are decided once and written by the leader (07 §2.2): ChatGPT by the Codex
      // metadata's first priority.
      await waitUntil(
        async () => (await groupsFile(rig)).codex?.defaultModel && (await groupsFile(rig)).ds?.defaultModel,
        "the groups' default models were never written",
      )
      expect((await groupsFile(rig)).codex?.defaultModel).toMatchObject({ id: "gpt-6-astra", source: "auto" })

      const pin = (model: string) => ({ pin: { account: CHATGPT_01, model } })
      await save("ChatGPT 리뷰", "ds", {
        "own-review": [pin("gpt-5.6-terra"), pin("gpt-5.6-sol")],
        "own-deep": [pin("gpt-6-astra")],
      })
      await save("ChatGPT 탐색", "ds", { explore: [pin("gpt-5.6-terra")] })
      await save("가볍게 나눠 쓰기", "codex", { explore: [{ rel: "lighter" }] })
      await root("deepseek", { providerID: required(fixture.ds).providerID, id: DS_MODEL }, "ChatGPT 리뷰")
      await root("chatgpt", CODEX_MAIN, "가볍게 나눠 쓰기")

      expect(await delegate("deepseek", "[review]")).toMatchObject({ providerID: SLOT, id: "gpt-5.6-terra" })
      expect(await delegate("deepseek", "[deep]")).toMatchObject({ providerID: SLOT, id: "gpt-6-astra" })
      // The first call that needs the pair decides it once (07 §4.2): the cheapest cheaper family's newest. Saving the
      // preset only showed the group default's pair in its answer and stored none.
      expect(await delegate("chatgpt", "[explore]")).toMatchObject({ providerID: SLOT, id: "gpt-6-luna" })
      await waitUntil(
        async () => (await groupsFile(rig)).codex?.lighter?.["gpt-6-sol"],
        "the lighter pair was never written",
      )
      expect<unknown>((await groupsFile(rig)).codex?.lighter).toEqual(PAIRS)

      const models = await Promise.all(
        [...fixture.sessions].map(async ([name, id]) => [name, await modelOf(id)] as const),
      )
      fixture.baseline = { groups: (await presetsFile(rig)).groups, models: new Map(models) }
      const listed = await list(rig)
      expect(listed.repairs).toBeUndefined()
      expect(
        listed.groups.every(
          (item) => item.status === "ok" && (item.presets ?? []).every((preset) => preset.status === "ok"),
        ),
      ).toBe(true)
      expect(await unordered(rig, required(fixture.base))).toEqual([])
      expect(await repairAlerts(rig)).toEqual({ preset_needs_repair: 0, group_default_model_missing: 0 })
    },
    STEP_TIMEOUT,
  )

  test(
    "additions and a retirement date: nothing changes and nothing is announced; the new models are only selectable",
    async () => {
      const rig = required(fixture.rig)
      await restart(VARIANTS.additions, required(fixture.meta).after)
      await waitUntil(
        async () => marked(await chatgpt(rig), "addedAt").includes("gpt-6-nano"),
        "the additions were never added to the template",
      )
      // gpt-6-astra-ultrafast: the bundled catalog lists an ultrafast mode since v2.0.24, which the templates predate.
      // gpt-6-cyber and the GPT-6.2 rows: upstream v2.4.1's bundled catalog lists them, the pinned templates predate it.
      expect(marked(await chatgpt(rig), "addedAt")).toEqual([
        "gpt-6-astra-ultrafast",
        "gpt-6-cyber",
        "gpt-6-nano",
        "gpt-6-nano-fast",
        "gpt-6.1-sol",
        "gpt-6.1-sol-fast",
        "gpt-6.2-astra",
        "gpt-6.2-astra-fast",
        "gpt-6.2-astra-ultrafast",
        "gpt-6.2-sol",
        "gpt-6.2-sol-fast",
        "gpt-6.2-sol-ultrafast",
      ])
      expect(await enabled(rig, ["gpt-6.1-sol", "gpt-6-nano"])).toEqual([true, true])
      await settle(rig)

      const listed = await list(rig)
      expect(listed.repairs).toBeUndefined()
      const codex = row(listed, "codex")
      const ds = row(listed, "ds")
      // The newer priority 1 changes no `auto` default, the cheaper family no pair (U3).
      expect(codex.defaultModel).toMatchObject({ id: "gpt-6-astra", source: "auto" })
      expect(codex.defaultModel?.missing).toBeUndefined()
      expect<unknown>(codex.lighter).toEqual(PAIRS)
      // A retirement date is shown, never announced, and offers no successor (07 §4.3).
      expect(ds.retirements).toEqual({ "gpt-5.6-sol": RETIRES })
      expect([codex.status, ds.status]).toEqual(["ok", "ok"])
      await expectUnchanged()

      expect(await delegate("deepseek", "[review]")).toMatchObject({ providerID: SLOT, id: "gpt-5.6-terra" })
      expect(await delegate("deepseek", "[deep]")).toMatchObject({ providerID: SLOT, id: "gpt-6-astra" })
      expect(await delegate("chatgpt", "[explore]")).toMatchObject({ providerID: SLOT, id: "gpt-6-luna" })
      expect(await repairAlerts(rig)).toEqual({ preset_needs_repair: 0, group_default_model_missing: 0 })
      // Upstream v2.4.1's bundled catalog adds capabilities (freeform formats) the pinned templates predate: that one
      // fixed-field alert is there from the start; the additions announce nothing more.
      expect((await rig.alerts("template_update_available")).map((line) => line.message)).toEqual([CAPABILITIES_ALERT])
      expect(await unordered(rig, catalogOf(VARIANTS.additions))).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a pinned model deprecated and the pair's model removed: next target or the main, one notice per model",
    async () => {
      const rig = required(fixture.rig)
      await restart(VARIANTS.gone)
      await waitUntil(
        async () => marked(await chatgpt(rig), "upstream").includes("gpt-6-luna"),
        "the gone models were never marked",
      )
      expect(marked(await chatgpt(rig), "upstream")).toEqual([
        "gpt-5.6-terra",
        "gpt-5.6-terra-fast",
        "gpt-6-luna",
        "gpt-6-luna-fast",
      ])
      await waitUntil(
        async () => (await repairAlerts(rig)).preset_needs_repair === 2,
        "the repair notices were never raised",
      )

      const listed = await list(rig)
      const review = presetID("ChatGPT 리뷰")
      const explore = presetID("ChatGPT 탐색")
      const [terraNotice, lunaNotice] = sorted(listed.repairs)
      expect<unknown>([terraNotice?.model, lunaNotice?.model]).toEqual(["gpt-5.6-terra", "gpt-6-luna"])
      // Codex's upgrade hint is the successor offered (07 §4.3), never applied.
      expect<unknown>(terraNotice?.uses).toHaveLength(2)
      expect<unknown>(terraNotice?.uses).toContainEqual(pinUse(review, "own-review", "gpt-6.1-sol"))
      expect<unknown>(terraNotice?.uses).toContainEqual(pinUse(explore, "explore", "gpt-6.1-sol"))
      // `[짝 고치기]` offers the pair rule's result now (the new cheapest family); a pair is never decided again.
      expect<unknown>(lunaNotice?.uses).toEqual(
        Object.keys(PAIRS).map((main) => ({ kind: "lighter", group: "codex", main, suggestion: "gpt-6-nano" })),
      )
      const ds = row(listed, "ds")
      expect(ds.status).toBe("needs_repair")
      expect(ds.presets?.map((item) => [item.name, item.status])).toEqual([
        ["평소대로", "ok"],
        ["ChatGPT 리뷰", "needs_repair"],
        ["ChatGPT 탐색", "needs_repair"],
      ])
      const codex = row(listed, "codex")
      expect(codex.status).toBe("needs_repair")
      expect<unknown>(codex.lighter).toEqual(
        Object.fromEntries(Object.entries(PAIRS).map(([main, pair]) => [main, { ...pair, missing: true }])),
      )
      const terra = (await rig.alerts("preset_needs_repair")).filter((line) => line.message.includes("gpt-5.6-terra"))
      expect(terra).toHaveLength(1)
      expect(terra[0]?.message).toContain("프리셋 2개")
      expect(terra[0]?.message).toContain("(제안: gpt-6.1-sol)")
      await expectUnchanged()

      // Review goes on to its next target, the pair's role runs like the main; nothing outside the lists.
      expect(await delegate("deepseek", "[review]")).toMatchObject({ providerID: SLOT, id: "gpt-5.6-sol" })
      expect(lastToolOutput(required(fixture.chat))).toContain(
        "Note: the own-review role's first target is not available now",
      )
      expect(await delegate("chatgpt", "[explore]")).toMatchObject({ providerID: SLOT, id: "gpt-6-sol" })
      expect(lastToolOutput(required(fixture.codex))).toContain("Note: no target of the explore role is available now")

      // Another refold (a registry change on ChatGPT 02) announces nothing more: one notice per model event, also with
      // two accounts sharing the group.
      await rig.call("accounts.update", { accountID: "acc_pg02", label: "ChatGPT 02 · PG5" })
      await settle(rig)
      expect(await repairAlerts(rig)).toEqual({ preset_needs_repair: 2, group_default_model_missing: 0 })
      expect(sorted((await list(rig)).repairs)).toEqual(sorted(listed.repairs))
    },
    STEP_TIMEOUT,
  )

  test(
    "a rename: one notice offers the new name for the pin and the group rule for the default; nothing is rewritten",
    async () => {
      const rig = required(fixture.rig)
      await restart(VARIANTS.renamed)
      await waitUntil(
        async () => marked(await chatgpt(rig), "upstream").includes("gpt-6-astra"),
        "the renamed model was never marked",
      )
      // The models of the previous change are listed again and lose their marks, quietly.
      expect(marked(await chatgpt(rig), "upstream")).toEqual([
        "gpt-6-astra",
        "gpt-6-astra-fast",
        "gpt-6-astra-ultrafast",
      ])
      await waitUntil(
        async () => (await repairAlerts(rig)).group_default_model_missing === 1,
        "the default's notice was never raised",
      )

      const listed = await list(rig)
      expect<unknown>(listed.repairs?.map((notice) => notice.model)).toEqual(["gpt-6-astra"])
      const uses: unknown = listed.repairs?.[0]?.uses
      expect(uses).toHaveLength(2)
      // A rename: the model of the same family released the same day.
      expect(uses).toContainEqual(pinUse(presetID("ChatGPT 리뷰"), "own-deep", "gpt-6-astra-1001"))
      // A new session now starts on the group rule's model (Codex metadata priority 1); the stored one stays.
      expect(uses).toContainEqual({ kind: "default", group: "codex", suggestion: "gpt-6.1-sol" })
      const codex = row(listed, "codex")
      expect(codex.defaultModel).toMatchObject({ id: "gpt-6-astra", source: "auto", missing: true })
      expect<unknown>(codex.lighter).toEqual(PAIRS)
      expect(row(listed, "ds").presets?.map((item) => item.status)).toEqual(["ok", "needs_repair", "ok"])
      expect(await repairAlerts(rig)).toEqual({ preset_needs_repair: 3, group_default_model_missing: 1 })
      await expectUnchanged()

      // The single deep target is gone: the role runs like the main. Review is back on its first target.
      expect(await delegate("deepseek", "[deep]")).toMatchObject({
        providerID: required(fixture.ds).providerID,
        id: DS_MODEL,
      })
      expect(await delegate("deepseek", "[review]")).toMatchObject({ providerID: SLOT, id: "gpt-5.6-terra" })
      expect(await delegate("chatgpt", "[explore]")).toMatchObject({ providerID: SLOT, id: "gpt-6-luna" })
    },
    STEP_TIMEOUT,
  )

  test(
    "a level removed upstream: the pinned template keeps it until the user refreshes; then the main is reported, not switched",
    async () => {
      const rig = required(fixture.rig)
      await restart(VARIANTS.levels)
      await waitUntil(
        async () => (await chatgpt(rig)).templateUpdate?.fields.includes("variants"),
        "the fixed-field change was never flagged",
      )
      // Fixed fields reach the request bytes: only `템플릿 갱신 있음`, one alert. The old name is listed again and the
      // new one is gone: kept, marked, and announced by nobody, since nothing uses it.
      expect(marked(await chatgpt(rig), "upstream")).toEqual([
        "gpt-6-astra-1001",
        "gpt-6-astra-1001-fast",
        "gpt-6-astra-1001-ultrafast",
      ])
      // One more than v2.4.1's capabilities alert (see the additions test).
      expect(await rig.alerts("template_update_available")).toHaveLength(2)
      expect(await levels(rig, SLOT, "gpt-6-sol")).toEqual(["none", "low", "medium", "high", "xhigh", "max"])

      const effort = await rig.server.createSession({ model: { ...CODEX_MAIN, variant: "xhigh" } })
      fixture.sessions.set("xhigh", effort.id)
      await turn(effort.id, "한 줄로 답해 줘")
      const sent = required(fixture.codex).requests.findLast((request) => request.model === "gpt-6-sol")
      expect(isRecord(sent?.json) && isRecord(sent.json.reasoning) ? sent.json.reasoning.effort : undefined).toBe(
        "xhigh",
      )
      expect((await list(rig)).repairs).toBeUndefined()

      // The user applies the change (`템플릿 갱신 있음` → `accounts.update{refreshCatalog}`, 07 §4.4).
      await rig.call("accounts.update", { accountID: CHATGPT_01, refreshCatalog: true })
      await waitUntil(
        async () => !(await levels(rig, SLOT, "gpt-6-sol")).includes("xhigh"),
        "the refreshed template never reached the registered model",
      )
      expect((await chatgpt(rig)).templateUpdate).toBeUndefined()
      const view = decodeView(await rig.call("session.preset.get", { sessionID: effort.id }))
      // 07 §2.3: `xhigh` refitted to the next level above it; the switch is the user's (02).
      expect<unknown>(view.main).toEqual({ missing: "variant", suggestion: { id: "gpt-6-sol", variant: "max" } })
      expect(await modelOf(effort.id)).toMatchObject({ providerID: SLOT, id: "gpt-6-sol", variant: "xhigh" })
      expect(await unordered(rig, catalogOf(VARIANTS.levels))).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test("no session or hook failed and no session's model changed by itself", async () => {
    const rig = required(fixture.rig)
    for (const [name, id] of fixture.sessions) {
      const errors = (await rig.server.messages(id)).filter(
        (message) => message.type === "assistant" && message.error !== undefined,
      )
      expect({ name, errors }).toEqual({ name, errors: [] })
      const calls = await toolParts(rig.server, id, "subagent")
      expect({ name, failed: calls.filter((call) => call.state.status !== "completed").length }).toEqual({
        name,
        failed: 0,
      })
    }
    await expectUnchanged()
    expect(rig.server.logs()).not.toMatch(/hook_failed|event_handler_failed|subagent_gate_undecided/)
  })
})

// ---------------------------------------------------------------------------------------------------------------

/**
 * The scripted models (Codex and DeepSeek). A tool result gets a short text, a child its "done"; a parent's directive
 * calls that role.
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  if (text.includes(SUBAGENT_PROMPT)) return { type: "text", text: CHILD_DONE }
  const directive = DIRECTIVES.find((key) => text.includes(key))
  return directive ? { type: "tool-call", name: "subagent", input: CALLS[directive] } : { type: "text", text: "답변" }
}

/** Restarts on a catalog variant (and metadata), then enters the DeepSeek key again (the e2e vault is memory). */
async function restart(edits: ReadonlyArray<CatalogEdit>, codexMeta?: CodexModels.Snapshot) {
  const rig = required(fixture.rig)
  await rig.restart({ catalog: catalogOf(edits), ...(codexMeta ? { codexMeta } : {}) })
  await rig.call("accounts.update", { accountID: required(fixture.ds).id, replaceKey: DS_KEY })
  await rig.server.waitForModels([{ providerID: required(fixture.ds).providerID, id: DS_MODEL }])
}

function catalogOf(edits: ReadonlyArray<CatalogEdit>) {
  return catalogVariant(required(fixture.base), edits)
}

async function save(name: string, group: Preset.Group, roles: Record<string, ReadonlyArray<unknown>>) {
  const saved = await required(fixture.rig).call("presets.set", {
    preset: {
      name,
      group,
      workers: {
        mode: "by-role",
        roles: Object.fromEntries(
          Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }]),
        ),
      },
      delegation: "on-request",
      caps: Preset.CAPS,
      ultraCaps: null,
    },
  })
  fixture.presets.set(name, decodeInfo(saved.preset).id)
}

/** A root on `model` bound to the named preset (own-web's order: create, then apply). */
async function root(name: string, model: { readonly providerID: string; readonly id: string }, preset: string) {
  const rig = required(fixture.rig)
  const session = await rig.server.createSession({ model })
  await rig.call("session.preset.apply", { sessionID: session.id, presetID: presetID(preset) })
  fixture.sessions.set(name, session.id)
}

/**
 * Waits {@link SETTLED_MS}, long enough for a presence check that could announce something, asking the service
 * meanwhile: node's HTTP server closes a keep-alive connection after 5 idle seconds, and reusing that connection can
 * reset the next request.
 */
async function settle(rig: PresetRig) {
  const end = Date.now() + SETTLED_MS
  while (Date.now() < end) {
    await rig.call("health", {})
    await Bun.sleep(1_000)
  }
}

async function turn(sessionID: string, text: string) {
  const server = required(fixture.rig).server
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
}

/** One directive turn of a root: the subagent call completed, and the model its child ran on. */
async function delegate(name: string, directive: Directive) {
  const server = required(fixture.rig).server
  const sessionID = required(fixture.sessions.get(name))
  await turn(sessionID, `${directive} 맡겨 줘`)
  const call = required((await toolParts(server, sessionID, "subagent")).at(-1))
  expect(call.state.status).toBe("completed")
  const child = await childOf(server, call)
  // Since upstream v2.3.0 (#63382) the child runs in the background and its report wakes the parent later: wait for
  // that report to be answered, so it never lands in the next directive's turn.
  await server.waitIdle(child.id)
  const deadline = Date.now() + 60_000
  while (
    Date.now() < deadline &&
    !(await server.messages(sessionID)).some(
      (message) => message.type !== "assistant" && JSON.stringify(message).includes(child.id),
    )
  )
    await Bun.sleep(100)
  await server.waitIdle(sessionID)
  return child.model
}

async function modelOf(sessionID: string) {
  return (await sessionInfo(required(fixture.rig).server, sessionID)).model
}

/** Nothing rewrote a preset, a lighter pair or a group default, and no session's model moved. */
async function expectUnchanged() {
  const rig = required(fixture.rig)
  const baseline = required(fixture.baseline)
  expect<unknown>((await presetsFile(rig)).groups).toEqual(baseline.groups)
  for (const [name, model] of baseline.models)
    expect({ name, model: await modelOf(required(fixture.sessions.get(name))) }).toEqual({ name, model })
}

const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const decodeView = Schema.decodeUnknownSync(Preset.SessionView)
const decodeFile = Schema.decodeUnknownSync(Preset.File)
const decodeAccounts = Schema.decodeUnknownSync(Schema.Array(Account.View))
const decodeList = Schema.decodeUnknownSync(
  Schema.Struct({ groups: Schema.Array(Preset.GroupView), repairs: optional(Schema.Array(Preset.Repair)) }),
)

async function presetsFile(rig: PresetRig) {
  const json: unknown = await Bun.file(path.join(rig.home, "presets.json"))
    .json()
    .catch(() => ({ version: 1, groups: {} }))
  return decodeFile(json)
}

async function groupsFile(rig: PresetRig) {
  return (await presetsFile(rig)).groups
}

async function list(rig: PresetRig) {
  return decodeList(await rig.call("presets.list", {}))
}

function row(listed: { readonly groups: ReadonlyArray<Preset.GroupView> }, group: Preset.Group) {
  return required(listed.groups.find((item) => item.group === group))
}

function presetID(name: string) {
  return required(fixture.presets.get(name))
}

function pinUse(preset: string, place: Preset.Place, suggestion: string) {
  return { kind: "pin", group: "ds", presetID: preset, place, account: CHATGPT_01, suggestion }
}

/** Repair notices in model order (the service lists them in the order first seen). */
function sorted(repairs: ReadonlyArray<Preset.Repair> | undefined) {
  return (repairs ?? []).toSorted((a, b) => a.model.localeCompare(b.model))
}

async function chatgpt(rig: PresetRig) {
  const found = decodeAccounts((await rig.call("accounts.list", {})).accounts).find((item) => item.id === CHATGPT_01)
  return required(found)
}

/** The template models carrying a mark (07 §4.4): `addedAt` (the `새` tag) or `upstream: "missing"`, sorted. */
function marked(view: Account.View, mark: "addedAt" | "upstream") {
  return (view.models ?? [])
    .filter((model) => model[mark] !== undefined)
    .map((model) => String(model.id))
    .toSorted()
}

/** Whether each model of ChatGPT 01 is registered enabled (`GET /api/model` lists only those). */
async function enabled(rig: PresetRig, ids: ReadonlyArray<string>) {
  const models = await rig.server.models()
  return ids.map((id) => models.some((model) => model.providerID === SLOT && model.id === id && model.enabled === true))
}

/** A registered model's variant ids in order. */
async function levels(rig: PresetRig, providerID: string, id: string) {
  const model = (await rig.server.models()).find((item) => item.providerID === providerID && item.id === id)
  const variants = isRecord(model) && Array.isArray(model.variants) ? model.variants : []
  return variants.flatMap((variant: unknown) =>
    isRecord(variant) && typeof variant.id === "string" ? [variant.id] : [],
  )
}

/** Effort names in their usual order: what `Preset.effortToVariant` places an intent by (07 §2.3, ⚠PG5). */
const LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Every place whose levels are not low → high: the catalog's effort levels (`capabilities.reasoning.effort`), each registered
 * model's variants and the Codex metadata's levels. Names outside the usual ladder (`thinking`, Codex's client-only
 * `ultra`) are not ranked.
 */
async function unordered(rig: PresetRig, catalog: Catalog) {
  const ascending = (names: ReadonlyArray<string>) => {
    const ranks = names.map((name) => LADDER.indexOf(name)).filter((rank) => rank >= 0)
    return ranks.every((rank, index) => index === 0 || rank > (ranks[index - 1] ?? -1))
  }
  const listed = Object.entries(catalog).flatMap(([providerID, provider]) =>
    Object.values(provider.models).flatMap((model) => {
      // models.dev v2: `capabilities.reasoning.effort`.
      const reasoning = isRecord(model.capabilities) ? model.capabilities.reasoning : undefined
      const values = isRecord(reasoning) && Array.isArray(reasoning.effort) ? reasoning.effort.map(String) : []
      return ascending(values) ? [] : [`catalog ${providerID}/${String(model.id)}: ${values.join(",")}`]
    }),
  )
  const registered = (await rig.server.models()).flatMap((model) => {
    const ids = (Array.isArray(model.variants) ? model.variants : []).flatMap((variant: unknown) =>
      isRecord(variant) && typeof variant.id === "string" ? [variant.id] : [],
    )
    return ascending(ids) ? [] : [`registered ${String(model.providerID)}/${String(model.id)}: ${ids.join(",")}`]
  })
  const meta = required(fixture.meta).after.models.flatMap((row) => {
    const names = CodexModels.levels(row)
    return ascending(names) ? [] : [`metadata ${row.slug}: ${names.join(",")}`]
  })
  return [...listed, ...registered, ...meta]
}

async function repairAlerts(rig: PresetRig) {
  return {
    preset_needs_repair: (await rig.alerts("preset_needs_repair")).length,
    group_default_model_missing: (await rig.alerts("group_default_model_missing")).length,
  }
}

/** The tool results the last request of `fake` that carried any. */
function lastToolOutput(fake: FakeProvider) {
  const last = fake.requests.filter((request) => request.model !== undefined && toolOutputs(request).length > 0).at(-1)
  return toolOutputs(required(last)).join("\n")
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

/** The fixed-field alert upstream v2.4.1's bundled catalog raises against the pinned ChatGPT template (MR18-13). */
const CAPABILITIES_ALERT =
  "ChatGPT 모델 템플릿의 고정 항목(capabilities)이 카탈로그에서 바뀌었습니다. 계정 카드의 '템플릿 갱신 있음'에서 적용합니다."

// End to end on a real upstream server: gate PG6 of 07 §8.4 (R8, the effective compaction threshold), its T2 value.
// The window every own model registers with is the model's own (07 §6.1): the live catalog's, and for a Codex model
// the Codex metadata's largest input once the metadata is there (07 §4.5, §6.2 #4). Core compacts at the ceiling of
// `limit.input || limit.context`, `ctx − max(floor(0.15·ctx), 16k)` (upstream v2.1; 0.1 from d9987ef9c8, `floor(0.9·ctx)` before), which
// `accounts.list` reports as `compaction.effective`.
// - Before the metadata (T0, 07 §6.2 #4): gpt-6.1-sol, a model the bundled template predates, is added by the template
//   diff (07 §4.4) and registers with the catalog's 922k: 783,700.
// - The metadata arrives (as a fetch writes it: `codex-meta.json`, taken by the running service's store watcher):
//   its 872k makes 741,200, with no restart. gpt-5.6-sol is 741,200 either way.
// - DeepSeek v4-pro (1,048,576) 891,290; an OpenAI-compatible model with a 128k window 115,200: 90% of its window, where
//   core alone would keep 15% free (108,800), through a registered input of 135,529.
// - Presets, the ultra switch and the ultra level change none of it, nor any registered window.
// - The advice thresholds and `compact_advice` (07 §6.2 #9–#11) are gone from the policy file and the ledger.
//
// own-accounts loads from its package directory (`startPresetRig`) with one linked ChatGPT account on a fake Codex
// backend and a catalog variant with gpt-6.1-sol (`GPT_61_SOL`); the DeepSeek and the compat account are added through
// `accounts.add.key` against one fake chat backend. The Codex metadata is the e2e kit's fixture of the backend's list
// (`codexMetaFixture`): the fake Codex backend has no model list, so the service's own fetch fails and keeps what the
// store has (07 §4.5). Every credential is fake; the servers bind 127.0.0.1; nothing reads this PC's `.codex`.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Schema } from "effect"
import { Account } from "@own/protocol"
import {
  GPT_61_SOL,
  PREDATED_MODELS,
  bundledCatalog,
  catalogVariant,
  codexMetaFixture,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  waitUntil,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const STEP_TIMEOUT = 120_000

const ONE = { accountID: "acct-pg6-01", email: "one@example.test", plan: "pro" }
const SLOT = "own-codex-pg01"
const MAIN = { providerID: SLOT, id: "gpt-6.1-sol", variant: "high" }
const DS_KEY = "sk-fake-pg6-deepseek-0001"
const COMPAT_KEY = "sk-fake-pg6-compat-0001"
const COMPAT_MODEL = "fake-128k"

/** 07 §8.4 PG6: the thresholds of the T2 release. */
const T2 = {
  "gpt-6.1-sol": 741_200,
  "gpt-5.6-sol": 741_200,
  "deepseek-v4-pro": 891_290,
  // Core keeps 15% free since upstream v2.1 (108,800); a compat slot stays at 90% (R8).
  [COMPAT_MODEL]: 115_200,
}

const fixture: {
  codex?: FakeCodex
  chat?: FakeOpenAIChat
  rig?: PresetRig
  ds?: string
  compat?: string
} = {}

beforeAll(async () => {
  const codex = startFakeCodex()
  const chat = startFakeOpenAIChat()
  Object.assign(fixture, { codex, chat })
  fixture.rig = await startPresetRig({
    name: "pg6",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ONE) }],
    endpoints: { deepseek: chat.baseURL },
    catalog: catalogVariant(await bundledCatalog(), [GPT_61_SOL]),
    control: true,
    templatePredates: PREDATED_MODELS,
    models: [MAIN, { providerID: SLOT, id: "gpt-5.6-sol" }],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
}, 60_000)

describe("PG6: the effective compaction threshold, T2 value (07 §6, §8.4)", () => {
  test("before the Codex metadata: gpt-6.1-sol, added by the template diff, compacts at its catalog window", async () => {
    const rig = required(fixture.rig)
    const listed = await account(rig, "acc_pg01")
    // The model the bundled template lacks is added, marked new, and registered with the live catalog's 922k.
    expect(listed.models?.find((model) => model.id === "gpt-6.1-sol")?.addedAt).toBeString()
    expect(triggers(listed)).toMatchObject({ "gpt-6.1-sol": 783_700, "gpt-5.6-sol": 741_200 })
    expect(await registered(rig, SLOT, "gpt-6.1-sol")).toMatchObject({ input: 922_000 })
  })

  test(
    "the Codex metadata arrives: gpt-6.1-sol compacts at 741,200 from its 872k maximum, without a restart",
    async () => {
      const rig = required(fixture.rig)
      await rig.setCodexMeta(await codexMetaFixture())
      await waitUntil(
        async () => triggers(await account(rig, "acc_pg01"))["gpt-6.1-sol"] === T2["gpt-6.1-sol"],
        "the metadata window never reached gpt-6.1-sol",
      )
      expect(triggers(await account(rig, "acc_pg01"))).toMatchObject({
        "gpt-6.1-sol": T2["gpt-6.1-sol"],
        "gpt-5.6-sol": T2["gpt-5.6-sol"],
      })
      // What core compacts at: the ceiling of the registered input (872k − 130.8k).
      expect(await registered(rig, SLOT, "gpt-6.1-sol")).toMatchObject({ input: 872_000 })
    },
    STEP_TIMEOUT,
  )

  test(
    "DeepSeek v4-pro compacts at 891,290 and a 128k OpenAI-compatible model at 115,200",
    async () => {
      const rig = required(fixture.rig)
      const chat = required(fixture.chat)
      const ds = await rig.call("accounts.add.key", { kind: "ds", label: "DeepSeek", key: DS_KEY })
      const compat = await rig.call("accounts.add.key", {
        kind: "compat",
        label: "Compat",
        key: COMPAT_KEY,
        options: { baseURL: chat.baseURL, models: [{ id: COMPAT_MODEL, contextLimit: 128_000 }] },
      })
      fixture.ds = idOf(ds)
      fixture.compat = idOf(compat)
      await waitUntil(
        async () =>
          triggers(await account(rig, required(fixture.ds)))["deepseek-v4-pro"] !== undefined &&
          triggers(await account(rig, required(fixture.compat)))[COMPAT_MODEL] !== undefined,
        "the new accounts never listed their thresholds",
      )
      expect(triggers(await account(rig, required(fixture.ds)))["deepseek-v4-pro"]).toBe(T2["deepseek-v4-pro"])
      expect(triggers(await account(rig, required(fixture.compat)))[COMPAT_MODEL]).toBe(T2[COMPAT_MODEL])
      // What core compacts at: the ceiling of the registered input (135,529 − 20,329); the window and output stay.
      const slot = (await accounts(rig)).find((item) => item.id === fixture.compat)?.providerID
      expect(await registered(rig, String(slot), COMPAT_MODEL)).toMatchObject({ context: 128_000, input: 135_529 })
      // Every value comes from the model's window (`v2`): nobody lowered one.
      expect(
        (await accounts(rig)).flatMap((item) => item.compaction?.effective ?? []).every((row) => row.source === "v2"),
      ).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "presets, the ultra switch and the ultra level change no threshold and no registered window",
    async () => {
      const rig = required(fixture.rig)
      const before = await windows(rig)
      expect(before.thresholds).toMatchObject({
        acc_pg01: { "gpt-6.1-sol": T2["gpt-6.1-sol"], "gpt-5.6-sol": T2["gpt-5.6-sol"] },
        [required(fixture.ds)]: { "deepseek-v4-pro": T2["deepseek-v4-pro"] },
        [required(fixture.compat)]: { [COMPAT_MODEL]: T2[COMPAT_MODEL] },
      })
      const session = await rig.server.createSession({ model: MAIN })
      const saved = await rig.call("presets.set", {
        preset: {
          name: "가볍게 나눠 쓰기",
          group: "codex",
          workers: { mode: "by-role", roles: { explore: { targets: [{ rel: "lighter" }], effort: "inherit" } } },
          delegation: "when-useful",
          caps: { concurrent: 3, perMessage: 6, perSession: 100 },
          ultraCaps: null,
        },
      })
      const presetID = isRecord(saved.preset) ? String(saved.preset.id) : ""
      // Each step with what it answers: the binding moves and ultra really changes the main's effort.
      const steps: ReadonlyArray<readonly [string, () => Promise<unknown>, Record<string, unknown>]> = [
        [
          "apply the preset",
          () => rig.call("session.preset.apply", { sessionID: session.id, presetID }),
          { binding: { presetID } },
        ],
        [
          "ultra on",
          () => rig.call("session.ultra.set", { sessionID: session.id, on: true }),
          { on: true, variant: { from: "high", to: "xhigh" } },
        ],
        [
          "ultra level 크게",
          () => rig.call("presets.defaults.set", { group: "codex", ultraCaps: "large" }),
          { group: "codex" },
        ],
        [
          "ultra off",
          () => rig.call("session.ultra.set", { sessionID: session.id, on: false }),
          { on: false, variant: { from: "xhigh", to: "high" } },
        ],
        [
          "평소대로",
          () => rig.call("session.preset.apply", { sessionID: session.id, presetID: "builtin:codex" }),
          { binding: { presetID: "builtin:codex" } },
        ],
      ]
      for (const [name, step, answer] of steps) {
        expect(await step()).toMatchObject(answer)
        expect({ step: name, ...(await windows(rig)) }).toEqual({ step: name, ...before })
      }
      expect(await rig.call("presets.list", {})).toMatchObject({ ultraCaps: "large" })
    },
    STEP_TIMEOUT,
  )

  test("no advice threshold in the policy file and no compact_advice in the ledger (07 §6.2 #9–#11)", async () => {
    const rig = required(fixture.rig)
    const policy = JSON.stringify(await rig.call("policy.get", {}))
    for (const name of [
      "newSessionAdviceTokens",
      "compactAfterSwitchMinTokens",
      "compactMinTokens",
      "compactAdviceUsedPercent",
    ])
      expect(policy).not.toContain(name)
    expect(await rig.alerts("compact_advice")).toEqual([])
    expect(rig.server.logs()).not.toMatch(/hook_failed|event_handler_failed/)
  })
})

// ---------------------------------------------------------------------------------------------------------------

const decodeAccounts = Schema.decodeUnknownSync(Schema.Array(Account.View))

async function accounts(rig: PresetRig) {
  return decodeAccounts((await rig.call("accounts.list", {})).accounts)
}

async function account(rig: PresetRig, id: string) {
  const found = (await accounts(rig)).find((item) => item.id === id)
  if (!found) throw new Error(`accounts.list has no ${id}`)
  return found
}

/** An account's `compaction.effective` as model id → trigger tokens. */
function triggers(view: Account.View): Record<string, number> {
  return Object.fromEntries((view.compaction?.effective ?? []).map((row) => [row.modelID, row.triggerTokens]))
}

/** The `limit` a model is registered with (`GET /api/model`), what core compacts by. */
async function registered(rig: PresetRig, providerID: string, id: string) {
  const model = (await rig.server.models()).find((item) => item.providerID === providerID && item.id === id)
  return isRecord(model) && isRecord(model.limit) ? model.limit : undefined
}

/** Every account's thresholds and every own model's registered limit. */
async function windows(rig: PresetRig) {
  const listed = await accounts(rig)
  const own = new Set(listed.map((item) => String(item.providerID)))
  return {
    thresholds: Object.fromEntries(listed.map((item) => [item.id, triggers(item)])),
    limits: Object.fromEntries(
      (await rig.server.models())
        .filter((model) => own.has(String(model.providerID)))
        .map((model) => [`${String(model.providerID)}/${String(model.id)}`, model.limit]),
    ),
  }
}

function idOf(added: Record<string, unknown>) {
  return isRecord(added.account) ? String(added.account.id) : ""
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

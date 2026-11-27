// End to end on a real upstream server: the model pool variants of gates PG2, PG4 and PG11 of 07 §8.4 (PG2-P, PG4-P,
// PG11-P, T4 모델 묶음). A pool preset is built from `presets.suggest` candidates (ChatGPT 01's GPT-6 Luna on the main
// account and DeepSeek Flash on a prepaid key with a $1 budget) and saved like the editor does; a session bound to it
// then runs subagents through the gate:
// - PG2-P: a pool pin on ChatGPT 02 is refused at save; a hand-edited pool with an R4 breach, a bad key and a too long
//   note loads without just those entries (the file kept, one alert each); no request ever reaches ChatGPT 02.
// - PG11-P: a call without `model` takes the default rule (never the paid key) with no consent asked; the LLM naming
//   the paid entry runs on it within its budget; past the budget the same call runs on the default with the budget
//   notice and the key gets no request.
// - PG4-P: binding and running the pool never selects a model, keeps the tool definitions' bytes and raises no
//   `toolset_changed`; the `own.preset` entry is appended once on apply and again only when an edit changes its text.
// The team variant of PG2-P (own.team) and PG5-P (catalog changes) are covered by `pool-store.test.ts`,
// `gate-pool.test.ts` and own-team's `team-context.test.ts`, without a server.
//
// own-accounts loads from its package directory (`startPresetRig`) with linked ChatGPT accounts 01 (the main) and 02
// on one fake Codex backend, and a DeepSeek key added through `accounts.add.key` against a fake DeepSeek chat backend.
// The scripted models read directives in the last user text. Every credential is fake; servers bind 127.0.0.1; no
// real account or money is used.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Kv, Preset } from "@own/protocol"
import { Prefix } from "@own/runtime"
import {
  afterToolResult,
  childOf,
  lastUserText,
  replaceFile,
  sessionInfo,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolError,
  toolOutputs,
  toolParts,
  waitUntil,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const ONE = { accountID: "acct-pool-01", email: "one@example.test", plan: "plus" }
const TWO = { accountID: "acct-pool-02", email: "two@example.test", plan: "plus" }
const MAIN = { providerID: "own-codex-pg01", id: "gpt-6-sol", variant: "high" }
const DS_KEY = "sk-fake-pool-deepseek-0001"
const DS_MODEL = "deepseek-flash"
const BUDGET_USD = 1
/** Output tokens a `<<big>>` child reports: 2M × $0.6/M on deepseek-flash, past the $1 budget in one call. */
const BIG_OUTPUT = 2_000_000

const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
const AFTER_TOOL = "도구 결과를 읽었습니다."
const CHILD_DONE = "자식 작업을 마쳤습니다."
const EXPLORE = { agent: "explore", description: "탐색", prompt: "자식 작업: 탐색" }

const fixture: {
  codex?: FakeCodex
  chat?: FakeOpenAIChat
  rig?: PresetRig
  ds?: { readonly id: string; readonly providerID: string }
  /** The pool preset saved in setup, and the names of its two entries. */
  pool?: { readonly id: Preset.ID; readonly luna: string; readonly flash: string }
  session?: string
} = {}

beforeAll(async () => {
  const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 }, responder: reply })
  const chat = startFakeOpenAIChat({ responder: reply })
  Object.assign(fixture, { codex, chat })
  fixture.rig = await startPresetRig({
    name: "pool",
    codex,
    chatgpt: [
      { id: "01", tokens: codex.login(ONE) },
      { id: "02", tokens: codex.login(TWO) },
    ],
    endpoints: { deepseek: chat.baseURL },
    models: [MAIN],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
}, 60_000)

describe("model pool on a real server (07 §8.4 PG2-P, PG4-P, PG11-P)", () => {
  test(
    "setup: a DeepSeek key with a $1 budget; the pool is saved from presets.suggest candidates",
    async () => {
      const rig = required(fixture.rig)
      const added = await rig.call("accounts.add.key", { kind: "ds", label: "DeepSeek", key: DS_KEY })
      const account = isRecord(added.account) ? added.account : {}
      const ds = { id: String(account.id), providerID: String(account.providerID) }
      fixture.ds = ds
      await rig.call("accounts.update", { accountID: ds.id, budget: { monthlyUSD: BUDGET_USD } })
      await rig.server.waitForModels([{ providerID: ds.providerID, id: DS_MODEL }])

      const offer = required(decodeSuggestion(await rig.call("presets.suggest", { group: "codex" })).pool)
      const luna = required(offer.candidates.find((item) => item.account === undefined && item.model === "gpt-6-luna"))
      const flash = required(offer.candidates.find((item) => item.account === ds.id && item.model === DS_MODEL))
      expect(flash.runs).toBe("paid")
      // PG11-P: the paid key is offered, never recommended; another ChatGPT subscription is not offered at all.
      expect(offer.recommended).not.toContain(flash.key)
      expect(offer.candidates.some((item) => item.account === rig.accounts["02"]?.id)).toBe(false)

      const saved = await rig.call("presets.set", {
        preset: {
          name: "모델 묶음",
          group: "codex",
          workers: { mode: "same", roles: {}, pool: [luna, flash].map(entryOf) },
          delegation: "when-useful",
          caps: Preset.CAPS,
          ultraCaps: null,
        },
      })
      expect(saved.warnings).toEqual([{ code: "paid", place: `pool:${flash.key}` }])
      const preset = decodeInfo(saved.preset)
      expect(preset.workers.mode).toBe("same")
      // The service froze the cards again (the editor's are never kept); they match what the editor showed.
      expect(preset.workers.pool?.map((entry) => [entry.key, entry.card?.window])).toEqual([
        [luna.key, luna.card?.window],
        [flash.key, flash.card?.window],
      ])
      expect(luna.card?.window).toBeNumber()
      fixture.pool = { id: preset.id, luna: luna.key, flash: flash.key }
      expect(modelRequests()).toEqual([])
    },
    TURN_TIMEOUT,
  )

  test("PG2-P: a pool pin on ChatGPT 02 is refused when saving, and nothing is written", async () => {
    const rig = required(fixture.rig)
    const file = path.join(rig.home, "presets.json")
    const before = await Bun.file(file).text()
    const refused = await rig.rpc("presets.set", {
      preset: {
        name: "다른 로그인",
        group: "codex",
        workers: {
          mode: "same",
          roles: {},
          pool: [{ key: "gpt-6-sol", model: "gpt-6-sol", account: required(rig.accounts["02"]).id }],
        },
        delegation: "when-useful",
        caps: Preset.CAPS,
        ultraCaps: null,
      },
    })
    expect(refused.error).toMatchObject({
      type: "same_company_subscription",
      data: { accountID: required(rig.accounts["02"]).id },
    })
    expect(await Bun.file(file).text()).toBe(before)
  })

  test(
    "PG2-P: a hand edit loads without its R4 breach, bad key and long note; the file keeps them, one alert each",
    async () => {
      const rig = required(fixture.rig)
      const file = path.join(rig.home, "presets.json")
      // After the leader wrote the DeepSeek group's default model, so the hand edit races no write.
      const current = await waitUntil(async () => {
        const json: unknown = await Bun.file(file)
          .json()
          .catch(() => undefined)
        const groups = isRecord(json) && isRecord(json.groups) ? json.groups : {}
        return isRecord(json) && isRecord(groups.ds) && "defaultModel" in groups.ds ? json : undefined
      }, "the leader never wrote the DeepSeek group's default model")
      const id = Preset.ID.create()
      const pool = [
        { key: "gpt-6-luna", model: "gpt-6-luna" },
        { key: "gpt-6-sol-02", model: "gpt-6-sol", account: required(rig.accounts["02"]).id },
        { key: "Bad Key", model: "gpt-5.6-sol" },
        { key: "noted", model: "gpt-6-astra", note: "n".repeat(Preset.NOTE_MAX + 1) },
      ]
      const edited = withPreset(current, {
        id,
        name: "손으로 고친 묶음",
        group: "codex",
        workers: { mode: "same", roles: {}, pool },
        delegation: "when-useful",
        caps: Preset.CAPS,
        ultraCaps: null,
        revision: 1,
      })
      await replaceFile(file, JSON.stringify(edited, null, 2))
      const loaded = await waitUntil(async () => {
        const listed = decodeList(await rig.call("presets.list", { group: "codex" }))
        return listed.groups.flatMap((group) => group.presets ?? []).find((preset) => preset.id === id)
      }, "the hand-edited pool was never loaded")
      expect(loaded.workers.pool?.map((entry) => entry.key)).toEqual(["gpt-6-luna"])
      const messages = await waitUntil(async () => {
        const found = rig.events
          .own("alert")
          .filter((event) => event.data.code === "preset_entry_dropped")
          .map((event) => String(event.data.message))
        return found.length >= 3 ? found : undefined
      }, "the dropped entries were never alerted")
      expect(messages).toHaveLength(3)
      for (const key of ["Bad Key", "gpt-6-sol-02", "noted"])
        expect(messages.filter((message) => message.includes(`모델 묶음 항목 ${key}`))).toHaveLength(1)
      expect(JSON.stringify(await Bun.file(file).json())).toContain('"Bad Key"')
    },
    TURN_TIMEOUT,
  )

  test(
    "PG11-P + PG4-P: the default rule takes Luna, never the key; no consent, no model change, the entry once",
    async () => {
      const rig = required(fixture.rig)
      const pool = required(fixture.pool)
      const session = await rig.server.createSession({ model: MAIN })
      fixture.session = session.id
      expect(await rig.call("session.preset.apply", { sessionID: session.id, presetID: pool.id })).toMatchObject({
        entry: "written",
      })
      await turn(session.id, "[explore] 훑어봐 줘")
      const call = required((await toolParts(rig.server, session.id, "subagent")).at(-1))
      expect(call.state.status).toBe("completed")
      expect((await childOf(rig.server, call)).model).toMatchObject({ providerID: MAIN.providerID, id: "gpt-6-luna" })
      expect(modelRequests()).toEqual([])
      expect(rejectedAlerts(session.id)).toEqual([])
      expect(updatesOf(session.id)).toHaveLength(1)
      expect(selections(session.id)).toEqual([])
    },
    TURN_TIMEOUT,
  )

  test(
    "PG11-P: the named paid entry runs within its budget, then drops out with the budget notice and no request",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      const ds = required(fixture.ds)
      await turn(sessionID, "[pick-flash-big] 디프시크로 크게 해 줘")
      const ran = required((await toolParts(rig.server, sessionID, "subagent")).at(-1))
      expect(ran.state.status).toBe("completed")
      expect((await childOf(rig.server, ran)).model).toMatchObject({ providerID: ds.providerID, id: DS_MODEL })
      expect(modelRequests().length).toBeGreaterThan(0)
      await waitUntil(async () => {
        const snapshot = await rig.call("quota.snapshot", { accountIDs: [ds.id] })
        const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
        return windows.some((window) => isRecord(window) && window.kind === "budget" && window.status === "exhausted")
      }, "the DeepSeek budget window never reported exhausted")

      const requests = modelRequests().length
      await turn(sessionID, "[pick-flash] 디프시크로 한 번 더")
      const moved = required((await toolParts(rig.server, sessionID, "subagent")).at(-1))
      expect(moved.state.status).toBe("completed")
      expect((await childOf(rig.server, moved)).model).toMatchObject({ providerID: MAIN.providerID, id: MAIN.id })
      expect(lastToolOutput()).toContain(
        `Note: model ${required(fixture.pool).flash} is not available now (its monthly budget is used up), so this subagent ran on your own model.`,
      )
      expect(modelRequests()).toHaveLength(requests)
      expect(rejectedAlerts(sessionID)).toEqual([])
    },
    TURN_TIMEOUT,
  )

  test(
    "PG2-P: another login's model is declined with the pool's names; ChatGPT 02 never gets a request",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      const pool = required(fixture.pool)
      await turn(sessionID, "[pick-02] 02 계정으로 해 줘")
      const declined = required((await toolParts(rig.server, sessionID, "subagent")).at(-1))
      expect(declined.state.status).toBe("error")
      expect(toolError(declined)).toBe(
        `Unknown agent: ${Preset.rejection({ reason: "model", models: [pool.luna, pool.flash] })}`,
      )
      expect(codex().requests.filter((request) => request.identity === `codex:${TWO.accountID}`)).toEqual([])
    },
    TURN_TIMEOUT,
  )

  test(
    "PG4-P: a pool edit appends the entry once; an edit the text does not show appends nothing; bytes and model stay",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      const pool = required(fixture.pool)
      const listed = decodeList(await rig.call("presets.list", { group: "codex" }))
      const stored = required(listed.groups.flatMap((group) => group.presets ?? []).find((item) => item.id === pool.id))
      const { status: _status, revision: _revision, ...current } = stored
      const save = async (edit: typeof current) =>
        decodeInfo((await rig.call("presets.set", { preset: edit })).preset).revision
      const followed = (revision: number) =>
        waitUntil(async () => {
          const value = binding(sessionID)
          return value.revision === revision ? value : undefined
        }, `the binding never took revision ${revision}`)

      const noted = {
        ...current,
        workers: {
          ...current.workers,
          pool: (current.workers.pool ?? []).map((entry) =>
            entry.key === pool.luna ? { ...entry, note: "탐색 전용" } : entry,
          ),
        },
      }
      await followed(await save(noted))
      await turn(sessionID, "메모를 고친 뒤 질문")
      expect(updatesOf(sessionID)).toHaveLength(2)
      expect(presetBlock(required(requestsOf(sessionID).at(-1)))).toContain("Note from the user: '탐색 전용'")

      await followed(await save({ ...noted, caps: { ...noted.caps, perSession: 150 } }))
      await turn(sessionID, "상한을 고친 뒤 질문")
      expect(updatesOf(sessionID)).toHaveLength(2)

      // The tool definitions every root request of the session carried are the same bytes; no model was selected.
      const tools = new Set(requestsOf(sessionID).map((request) => Prefix.section(request.json, "tools")))
      expect(tools.size).toBe(1)
      expect(selections(sessionID)).toEqual([])
      expect(rig.events.own("alert").filter((event) => event.data.code === "toolset_changed")).toEqual([])
      expect(rig.server.logs()).not.toMatch(/hook_failed|subagent_gate_undecided|preset_entry_write_failed/)
    },
    TURN_TIMEOUT,
  )

  test(
    "07 §2.3: a pool entry runs at the per-call level, `openai/<entry>#low` included (its variant was dropped before)",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(fixture.session)
      for (const [directive, variant] of [
        ["[luna-low]", "low"],
        ["[luna-xhigh]", "xhigh"],
      ] as const) {
        await turn(sessionID, `${directive} 강도를 정해 맡겨 줘`)
        const call = required((await toolParts(rig.server, sessionID, "subagent")).at(-1))
        expect(call.state.status).toBe("completed")
        expect((await childOf(rig.server, call)).model).toEqual({
          providerID: MAIN.providerID,
          id: "gpt-6-luna",
          variant,
        })
        const requests = codex().requests.filter(
          (request) => request.model !== undefined && request.body.includes(`자식 작업: ${directive}`),
        )
        expect(requests.length).toBeGreaterThan(0)
        for (const request of requests) expect(request.json).toMatchObject({ reasoning: { effort: variant } })
      }
      expect(rig.server.logs()).not.toMatch(/hook_failed|subagent_gate_undecided/)
    },
    TURN_TIMEOUT * 2,
  )

  test(
    "07 §2.3 강도 고정 (PF 2026-11-03): the preset's fixed effort reaches the parent's requests, an entry's its subagent's",
    async () => {
      const rig = required(fixture.rig)
      const luna = required(fixture.pool).luna
      // The whole preset at low; the Luna entry at medium of its own.
      const saved = await rig.call("presets.set", {
        preset: {
          name: "강도 고정",
          group: "codex",
          workers: {
            mode: "same",
            roles: {},
            pool: [{ key: luna, model: "gpt-6-luna", forcedEffort: "medium" }],
          },
          delegation: "when-useful",
          caps: Preset.CAPS,
          ultraCaps: null,
          forcedEffort: "low",
        },
      })
      const preset = decodeInfo(saved.preset)
      expect(preset.forcedEffort).toBe("low")
      expect(preset.workers.pool?.[0]?.forcedEffort).toBe("medium")
      const session = await rig.server.createSession({ model: MAIN })
      expect(MAIN.variant).toBe("high")
      await rig.call("session.preset.apply", { sessionID: session.id, presetID: preset.id })
      // An idle conversation runs at the fixed level before the call returns: its next prompt goes out at low.
      await waitUntil(
        async () => {
          const info = await sessionInfo(rig.server, session.id)
          return isRecord(info.model) && info.model.variant === "low"
        },
        "the main runs at the fixed level",
      )
      // The parent asks Luna at xhigh: the entry's fixed medium runs, and the result says the request was not used.
      const before = codex().requests.length
      await turn(session.id, "[luna-xhigh] 강도를 정해 맡겨 줘")
      const parent = requestsOf(session.id)
      expect(parent.length).toBeGreaterThan(0)
      // GPT-6 Sol takes effort updates: the switch goes out once as a `configuration_update` to low (the cached
      // prefix stays); a continued request adds none, and none names another level.
      const sampled = parent.filter((request) => request.body.includes("[luna-xhigh] 강도를"))
      expect(sampled.length).toBeGreaterThan(0)
      expect(effortOf(sampled[0]!)).toBe("low")
      expect(parent.flatMap(effortUpdates).every((effort) => effort === "low")).toBe(true)
      const call = required((await toolParts(rig.server, session.id, "subagent")).at(-1))
      expect(call.state.status).toBe("completed")
      expect((await childOf(rig.server, call)).model).toEqual({
        providerID: MAIN.providerID,
        id: "gpt-6-luna",
        variant: "medium",
      })
      const child = codex()
        .requests.slice(before)
        .filter((request) => request.model !== undefined && request.body.includes("자식 작업: [luna-xhigh]"))
      expect(child.length).toBeGreaterThan(0)
      expect(effortOf(child[0]!)).toBe("medium")
      expect(lastToolOutput()).toContain("this preset fixes reasoning effort at medium, so the requested xhigh")
      // A default-rule child (no model named) runs at the preset's own fixed low.
      await turn(session.id, "[explore] 훑어봐 줘")
      const explored = required((await toolParts(rig.server, session.id, "subagent")).at(-1))
      expect((await childOf(rig.server, explored)).model).toMatchObject({ variant: expect.any(String) })
      expect(rig.server.logs()).not.toMatch(/hook_failed|subagent_gate_undecided|preset_forced_effort_failed/)
    },
    TURN_TIMEOUT * 2,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** The scripted models (both backends): directives call the subagent tool; children and tool results get a text. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  if (text.includes(SUBAGENT_PROMPT))
    return { type: "text", text: CHILD_DONE, ...(text.includes("<<big>>") ? { outputTokens: BIG_OUTPUT } : {}) }
  if (text.includes("[explore]")) return { type: "tool-call", name: "subagent", input: EXPLORE }
  const flash = fixture.pool?.flash ?? DS_MODEL
  if (text.includes("[pick-flash-big]"))
    return {
      type: "tool-call",
      name: "subagent",
      input: { agent: "general", description: "큰 일", prompt: "자식 작업: 디프시크 <<big>>", model: flash },
    }
  if (text.includes("[pick-flash]"))
    return {
      type: "tool-call",
      name: "subagent",
      input: { agent: "general", description: "일", prompt: "자식 작업: 디프시크", model: flash },
    }
  const luna = fixture.pool?.luna ?? "gpt-6-luna"
  const levels = { "[luna-low]": "openai/gpt-6-luna#low", "[luna-xhigh]": `${luna}#xhigh` }
  const level = Object.entries(levels).find((entry) => text.includes(entry[0]))
  if (level)
    return {
      type: "tool-call",
      name: "subagent",
      input: { agent: "general", description: "강도", prompt: `자식 작업: ${level[0]}`, model: level[1] },
    }
  if (text.includes("[pick-02]"))
    return {
      type: "tool-call",
      name: "subagent",
      input: { agent: "general", description: "일", prompt: "자식 작업: 02", model: "own-codex-pg02/gpt-6-sol" },
    }
  return { type: "text", text: `답변: ${text}` }
}

/**
 * The effort a Responses request runs at: its newest `configuration_update` (an effort update, which keeps the
 * top-level `reasoning.effort` at the window's first one), else the top-level value.
 */
function effortOf(request: RecordedRequest) {
  const json = isRecord(request.json) ? request.json : {}
  return effortUpdates(request).at(-1) ?? (isRecord(json.reasoning) ? json.reasoning.effort : undefined)
}

/** The efforts of a request's `configuration_update` items, oldest first. */
function effortUpdates(request: RecordedRequest) {
  const json = isRecord(request.json) ? request.json : {}
  const input = Array.isArray(json.input) ? json.input : []
  return input.flatMap((item) =>
    isRecord(item) && item.type === "configuration_update" && isRecord(item.reasoning) ? [item.reasoning.effort] : [],
  )
}

/** A candidate as the editor checks it: the entry fields only (the service freezes the card again). */
function entryOf(candidate: Preset.PoolCandidate) {
  return {
    key: candidate.key,
    model: candidate.model,
    ...(candidate.account === undefined ? {} : { account: candidate.account }),
  }
}

const sessionRequests = new Map<string, RecordedRequest[]>()

/** One prompt until idle; the root's model requests it made are kept per session. */
async function turn(sessionID: string, text: string) {
  const server = required(fixture.rig).server
  const before = codex().requests.length
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
  // The root's own requests: a child's carry the subagent prompt (and may run on the main model too).
  const made = codex()
    .requests.slice(before)
    .filter((request) => request.model === MAIN.id && !request.body.includes(SUBAGENT_PROMPT))
  sessionRequests.set(sessionID, [...requestsOf(sessionID), ...made])
}

function requestsOf(sessionID: string) {
  return sessionRequests.get(sessionID) ?? []
}

/** The `own.preset` text among a request's new input items (`""` without one). */
function presetBlock(request: RecordedRequest) {
  const input = isRecord(request.json) && Array.isArray(request.json.input) ? request.json.input : []
  return input
    .flatMap((item) => (isRecord(item) && typeof item.content === "string" ? [item.content] : []))
    .filter((text) => text.includes('"own.preset"'))
    .join("\n")
}

/** `session.instructions.updated` events of the session that carry the `own.preset` entry. */
function updatesOf(sessionID: string) {
  return required(fixture.rig).events.events.filter(
    (event) =>
      event.type === "session.instructions.updated" &&
      event.data.sessionID === sessionID &&
      isRecord(event.data.delta) &&
      "api/own.preset" in event.data.delta,
  )
}

function selections(sessionID: string) {
  return required(fixture.rig).events.events.filter(
    (event) => event.type === "session.model.selected" && event.data.sessionID === sessionID,
  )
}

function rejectedAlerts(sessionID: string) {
  return required(fixture.rig)
    .events.own("alert")
    .filter((event) => event.data.code === "subagent_rejected" && event.data.sessionID === sessionID)
}

function binding(sessionID: string) {
  return decodeBinding(required(fixture.rig).kv(Kv.preset(sessionID)))
}

/** Model requests DeepSeek received (the account probe excluded). */
function modelRequests() {
  return required(fixture.chat).requests.filter((request) => request.model !== undefined)
}

/** The tool results the last Codex request carried. */
function lastToolOutput() {
  const last = codex()
    .requests.filter((request) => request.model !== undefined && toolOutputs(request).length > 0)
    .at(-1)
  return toolOutputs(required(last)).join("\n")
}

function withPreset(file: Record<string, unknown>, preset: Record<string, unknown>) {
  const groups = isRecord(file.groups) ? file.groups : {}
  const codexGroup = isRecord(groups.codex) ? groups.codex : {}
  const presets = Array.isArray(codexGroup.presets) ? codexGroup.presets : []
  return { ...file, groups: { ...groups, codex: { ...codexGroup, presets: [...presets, preset] } } }
}

const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const decodeBinding = Schema.decodeUnknownSync(Preset.Binding)
const decodeSuggestion = Schema.decodeUnknownSync(Preset.Suggestion)
const decodeList = Schema.decodeUnknownSync(Schema.Struct({ groups: Schema.Array(Preset.GroupView) }))

function codex() {
  return required(fixture.codex)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

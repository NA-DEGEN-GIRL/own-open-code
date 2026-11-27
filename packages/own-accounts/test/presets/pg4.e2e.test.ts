// End to end on a real upstream server: gate PG4 of 07 §8.4 (cache). Choosing, editing and binding presets never
// touches the request prefix (07 §5.2): the main Ref stays (`session.model.selected` 0, no 02 cost window, no switch
// state), `system` and the tool definitions keep their bytes, the conversation continues from the previous response,
// and only the `own.preset` instruction entry changes, appended at the end when its text changes. Main changes, which
// are 02 switches, leave the preset alone and its relative roles follow the new main and its account.
//
// own-accounts loads from its package directory (`startPresetRig`) with two linked ChatGPT accounts (01, 02) answering
// from a fake Codex backend with a deterministic prompt cache (32-token blocks, no minimum). Core continues a Codex
// conversation with `previous_response_id` and sends only the new input items; the fake caches what a request
// carries (tools, instructions, input), so "prefix kept" is measured as: the same tool and instruction sections
// (`Prefix.section`, canonical) and the same bytes as sent (sha256 in wire key order, cache hints included), all of
// them read from the cache, and the input chained to the previous response. The scripted
// model reads a directive in the last user text. `다른 회사 리뷰` is the starter's shape, written into `presets.json`
// by hand: its review role is pinned to the Claude slot, which the e2e kit does not install (the starter needs another
// company's subscription to be offered), so its card names Anthropic. The other presets come from `presets.suggest`
// and `presets.set`. A second server without own-accounts (a static Codex provider for the same account and model) is
// the "before the role agents are registered" side of the tool hash. A wire evidence capture window runs for the whole
// file, so own-accounts' prefix watch (P0-2b) compares every own-slot primary request with its slot's previous one: no
// prefix line is `unexplained` and no `prefix_diverged` is raised. Last, a positive control for the "no
// `toolset_changed`" check: a custom agent added mid-session changes the subagent tool's description, own-accounts
// raises the alert once and the prefix line of that request says `toolset`. Every credential is fake; servers bind
// 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Kv, Preset } from "@own/protocol"
import { Home, LedgerWriter, Prefix } from "@own/runtime"
import {
  afterToolResult,
  assistantMessages,
  childOf,
  codexProvider,
  estimateTokens,
  instructionEntries,
  lastUserText,
  opencodeConfig,
  replaceFile,
  sessionInfo,
  sha256,
  startFakeCodex,
  startOpencodeServer,
  startPresetRig,
  toolParts,
  waitUntil,
  type FakeCodex,
  type OpencodeServer,
  type PresetRig,
  type RecordedRequest,
  type Reply,
  type ServerEvent,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const STEP_TIMEOUT = 120_000
const BLOCK = 32

const ONE = { accountID: "acct-pg4-01", email: "one@example.test", plan: "plus" }
const TWO = { accountID: "acct-pg4-02", email: "two@example.test", plan: "plus" }
const SLOT_01 = "own-codex-pg01"
const SLOT_02 = "own-codex-pg02"
const MAIN = { providerID: SLOT_01, id: "gpt-6-sol", variant: "high" }
/** The main changes of the scenario (02 switches): another model of ChatGPT 01, then the same model on ChatGPT 02. */
const NEXT_MODEL = { providerID: SLOT_01, id: "gpt-5.6-sol", variant: "high" }
const NEXT_ACCOUNT = { providerID: SLOT_02, id: "gpt-5.6-sol", variant: "high" }
const LIGHT_SPLIT = "가볍게 나눠 쓰기"
const CROSS_REVIEW = "다른 회사 리뷰"
const CLAUDE_PIN = { pin: { account: "acc_claude_slot", model: "claude-opus-5-5" } }
/** The roles `가볍게 나눠 쓰기` runs on the main account's lighter model (the review role once edited). */
const LIGHTER_ROLES = ["explore", "own-quick", "own-review"] as const

const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
const AFTER_TOOL = "도구 결과를 읽었습니다."
const CHILD_DONE = "자식 작업을 마쳤습니다."
const EXPLORE = { agent: "explore", description: "탐색", prompt: "자식 작업: 탐색" }
/** The custom agent of the positive control, added to the global config at the end. */
const PROBE = { id: "pg4-probe", description: "Added mid-session by the PG4 positive control." }

const fixture: {
  codex?: FakeCodex
  rig?: PresetRig
  plain?: OpencodeServer
  /** Preset ids by name. */
  presets: Map<string, Preset.ID>
  /** Each session's model requests, in order. */
  requests: Map<string, RecordedRequest[]>
} = { presets: new Map(), requests: new Map() }

beforeAll(async () => {
  const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: BLOCK }, responder: reply })
  fixture.codex = codex
  const one = codex.login(ONE)
  fixture.rig = await startPresetRig({
    name: "pg4",
    codex,
    chatgpt: [
      { id: "01", tokens: one },
      { id: "02", tokens: codex.login(TWO) },
    ],
    models: [MAIN, NEXT_MODEL, NEXT_ACCOUNT],
  })
  // The prefix watch runs while a capture window does (02 §7.8): one for the whole file.
  await fixture.rig.call("diagnostics.capture.start", { mode: "hash", minutes: 1_440 })
  fixture.plain = await startOpencodeServer({
    config: opencodeConfig({
      providers: {
        "fake-codex": codexProvider(codex, {
          accessToken: one.accessToken,
          accountID: one.accountID,
          models: [MAIN.id],
        }),
      },
    }),
  })
  await fixture.plain.waitForModels([{ providerID: "fake-codex", id: MAIN.id }])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await fixture.plain?.stop()
  await fixture.codex?.stop()
}, 60_000)

describe("PG4: presets never touch the request prefix (07 §5.2, §8.4)", () => {
  const state: {
    /** A session created like the TUI does (no `session.preset.apply`), bound to `평소대로` by own-accounts. */
    session?: string
    /** Another TUI session, bound to the ★ later. */
    other?: string
    /** Entry updates (`session.instructions.updated` with `api/own.preset`) of `session` so far. */
    updates: number
  } = { updates: 0 }

  test(
    "setup: TUI-made sessions are bound to `평소대로`; the presets come from a starter and a hand edit",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: MAIN })
      const other = await rig.server.createSession({ model: MAIN })
      Object.assign(state, { session: session.id, other: other.id })
      await turn(session.id, "첫 질문")
      await turn(other.id, "다른 대화의 첫 질문")
      for (const sessionID of [session.id, other.id])
        expect(binding(sessionID)).toMatchObject({ presetID: Preset.builtinID("codex"), entryHash: null })
      state.updates = updatesOf(session.id).length

      // `가볍게 나눠 쓰기` from its starter, saved like the editor does.
      const suggestion = await rig.call("presets.suggest", { group: "codex", template: "light-split" })
      const light = decodeInfo((await rig.call("presets.set", { preset: suggestion.draft })).preset)
      expect(light).toMatchObject({ name: LIGHT_SPLIT, delegation: "when-useful" })
      fixture.presets.set(LIGHT_SPLIT, light.id)

      // `다른 회사 리뷰` as the starter fills it with the Claude slot installed, by hand into presets.json once the
      // leader wrote the group's default model (so the hand edit races no write).
      const file = path.join(rig.home, "presets.json")
      const current = await waitUntil(async () => {
        const json: unknown = await Bun.file(file)
          .json()
          .catch(() => undefined)
        return isRecord(json) && JSON.stringify(json).includes('"defaultModel"') ? json : undefined
      }, "the leader never wrote the codex group's default model")
      const id = Preset.ID.create()
      const cross = {
        id,
        name: CROSS_REVIEW,
        group: "codex",
        workers: { mode: "by-role", roles: { "own-review": { targets: [CLAUDE_PIN], effort: "inherit" } } },
        delegation: "when-useful",
        caps: Preset.CAPS,
        ultraCaps: null,
        revision: 1,
      }
      await replaceFile(file, JSON.stringify(withPreset(current, cross), null, 2))
      await waitUntil(async () => {
        const listed = await rig.call("presets.list", { group: "codex" })
        return JSON.stringify(listed).includes(id)
      }, "the hand-written preset was never loaded")
      fixture.presets.set(CROSS_REVIEW, id)
    },
    STEP_TIMEOUT,
  )

  test(
    "switching presets 평소대로 ↔ 다른 회사 리뷰 ↔ 가볍게 나눠 쓰기: the entry is appended, prefix and main stay",
    async () => {
      const sessionID = required(state.session)
      const steps: ReadonlyArray<{ readonly preset: string; readonly entry: string }> = [
        { preset: CROSS_REVIEW, entry: "written" },
        { preset: LIGHT_SPLIT, entry: "written" },
        { preset: Preset.builtinID("codex"), entry: "removed" },
        { preset: LIGHT_SPLIT, entry: "written" },
        { preset: CROSS_REVIEW, entry: "written" },
        { preset: LIGHT_SPLIT, entry: "written" },
      ]
      for (const step of steps) {
        const applied = await apply(sessionID, presetID(step.preset))
        expect(applied).toMatchObject({ entry: step.entry, dryRun: false })
        // No 02 cost window: binding a preset never changes the main, so it has no estimate.
        expect(applied).not.toHaveProperty("estimate")
        await nextTurn(sessionID, `${step.preset} 다음 질문`, true)
      }
      const blocks = requestsOf(sessionID).map(presetBlock)
      expect(blocks.some((text) => text.includes("from another company (Anthropic)"))).toBe(true)
      expect(blocks.some((text) => text.includes('The context under "own.preset" no longer applies'))).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "editing the bound preset: edits the cards do not show change no entry; role, delegation and caps edits do",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(state.session)
      const id = presetID(LIGHT_SPLIT)
      const edits: ReadonlyArray<{ readonly name: string; readonly entryChanged: boolean; readonly edit: Edit }> = [
        // The guidance lists the concurrent and per-message caps only.
        {
          name: "perSession cap",
          entryChanged: false,
          edit: (preset) => ({ ...preset, caps: { ...preset.caps, perSession: 150 } }),
        },
        // `general` already runs like the main: an explicit `메인과 같게` row has the same card.
        {
          name: "general row",
          entryChanged: false,
          edit: (preset) => withRole(preset, "general", { rel: "main" }),
        },
        { name: "delegation", entryChanged: true, edit: (preset) => ({ ...preset, delegation: "active" }) },
        {
          name: "review role",
          entryChanged: true,
          edit: (preset) => withRole(preset, "own-review", { rel: "lighter" }),
        },
        {
          name: "concurrent cap",
          entryChanged: true,
          edit: (preset) => ({ ...preset, caps: { ...preset.caps, concurrent: 4 } }),
        },
      ]
      for (const item of edits) {
        const before = binding(sessionID)
        const entries = await instructionEntries(rig.server, sessionID)
        const listed = decodeList(await rig.call("presets.list", { group: "codex" }))
        const preset = listed.groups.flatMap((group) => group.presets ?? []).find((candidate) => candidate.id === id)
        const { status: _status, revision: _revision, ...current } = required(preset)
        const revision = decodeInfo((await rig.call("presets.set", { preset: item.edit(current) })).preset).revision
        // The bound session follows the edit on its runner (`presets.json` changed → reconcile).
        const after = await waitUntil(async () => {
          const value = binding(sessionID)
          return value.revision === revision ? value : undefined
        }, `the binding never took revision ${revision} (${item.name})`)
        expect(after.presetID).toBe(id)
        if (item.entryChanged) expect(after.entryHash).not.toBe(before.entryHash)
        if (!item.entryChanged) {
          expect(after.entryHash).toBe(before.entryHash)
          expect(await instructionEntries(rig.server, sessionID)).toEqual(entries)
        }
        await nextTurn(sessionID, `${item.name} 편집 뒤 질문`, item.entryChanged)
      }
    },
    STEP_TIMEOUT,
  )

  test(
    "binding sessions to the ★: an existing TUI session gets the entry appended; a new one is bound on creation",
    async () => {
      const rig = required(fixture.rig)
      const star = presetID(LIGHT_SPLIT)
      await rig.call("presets.defaults.set", { group: "codex", star })

      // The existing session keeps `평소대로` until it is bound; binding appends the entry and keeps the prefix.
      const other = required(state.other)
      expect(binding(other).presetID).toBe(Preset.builtinID("codex"))
      const previous = required(requestsOf(other).at(-1))
      const chain = await lastResponseID(other)
      expect(await apply(other, star)).toMatchObject({ entry: "written" })
      const [first] = await turn(other, "★에 묶은 뒤 질문")
      expectPrefixKept(previous, required(first), chain)
      expect(presetBlock(required(first))).toContain('<context key="own.preset">')

      // own-web's order (07 §5.1): `session.create` → `session.preset.apply` → the first prompt. Whichever of the
      // apply and the ★ binding on `session.created` wrote it, the entry is in the epoch baseline of the first request.
      const web = await rig.server.createSession({ model: MAIN })
      const applied = await apply(web.id, star)
      expect(["written", "unchanged"]).toContain(String(applied.entry))
      expect(binding(web.id)).toMatchObject({ presetID: star })
      const [opening] = await turn(web.id, "새 대화의 첫 질문")
      expect(JSON.stringify(required(opening).json)).toContain('<context key=\\"own.preset\\">')
      expect(presetBlock(required(opening))).toBe("")
      await expectQuietSecondTurn(web.id)

      // A TUI prompts right after creating: own-accounts binds the root to the ★ on `session.created` (on the
      // session's runner, after the pin). Its entry is in the baseline when that ran first, else it is appended at
      // the next step boundary (07 §5.2 기존 세션을 프리셋에 묶기); either way it is delivered once and the prefix stays.
      const tui = await rig.server.createSession({ model: MAIN })
      await turn(tui.id, "TUI 새 대화의 첫 질문")
      expect(binding(tui.id)).toMatchObject({ presetID: star })
      expect(binding(tui.id).entryHash).not.toBeNull()
      const opened = await lastResponseID(tui.id)
      const last = required(requestsOf(tui.id).at(-1))
      const [second] = await turn(tui.id, "TUI 새 대화의 두 번째 질문")
      expectPrefixKept(last, required(second), opened)
      expect(updatesOf(tui.id)).toHaveLength(1)
      const carried = requestsOf(tui.id).filter((request) => JSON.stringify(request.json).includes("own.preset"))
      expect(carried.length).toBeGreaterThan(0)
      for (const sessionID of [other, web.id, tui.id]) expect(selections(sessionID)).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "main changes (02 switches) keep the preset; its relative roles follow the new main and its account",
    async () => {
      const rig = required(fixture.rig)
      const sessionID = required(state.session)
      const presetBefore = binding(sessionID).presetID
      const before = await resolution(sessionID)
      expect(plainRef(before.main)).toEqual(MAIN)
      for (const role of LIGHTER_ROLES)
        expect(required(before.roles[role]).targets[0]?.target).toEqual({ rel: "lighter" })
      expect(required(before.roles.general).targets[0]?.target).toEqual({ rel: "main" })

      // The model: gpt-6-sol → gpt-5.6-sol on ChatGPT 01. `메인과 같게` runs the new model; the lighter pair is the main
      // account's, decided for the new main model.
      await switchMain(sessionID, NEXT_MODEL)
      const model = await resolutionFor(sessionID, NEXT_MODEL)
      expect(plainRef(required(model.roles.general).use)).toEqual(NEXT_MODEL)
      for (const role of LIGHTER_ROLES) expect(required(model.roles[role]).use).toMatchObject({ providerID: SLOT_01 })

      // The account: ChatGPT 01 → 02. Every relative role moves to the new main account.
      await switchMain(sessionID, NEXT_ACCOUNT)
      const account = await resolutionFor(sessionID, NEXT_ACCOUNT)
      expect(plainRef(required(account.roles.general).use)).toEqual(NEXT_ACCOUNT)
      for (const role of LIGHTER_ROLES)
        expect(plainRef(required(account.roles[role]).use)).toEqual({
          ...plainRef(required(model.roles[role]).use),
          providerID: SLOT_02,
        })
      expect(binding(sessionID).presetID).toBe(presetBefore)

      // The next explore call runs on the new main account's lighter model.
      const server = rig.server
      const requests = await turn(sessionID, "[explore] 새 메인으로 탐색해 줘")
      const part = required((await toolParts(server, sessionID, "subagent")).at(-1))
      expect(part.state.input).toEqual(EXPLORE)
      const child = await childOf(server, part)
      expect(child.model).toEqual(plainRef(required(account.roles.explore).use))
      expect(requests.map((request) => request.identity)).toEqual(requests.map(() => `codex:${TWO.accountID}`))
    },
    STEP_TIMEOUT,
  )

  test("tool definitions are the same as on a server without own-accounts (role agents not registered)", async () => {
    const plain = required(fixture.plain)
    const session = await plain.createSession({ model: { providerID: "fake-codex", id: MAIN.id } })
    const before = codex().requests.length
    await plain.prompt(session.id, "own-accounts 없는 서버의 질문")
    await plain.waitIdle(session.id)
    const request = required(
      codex()
        .requests.slice(before)
        .find((item) => item.model !== undefined),
    )
    // The roots' requests on the first main (a child's agent has its own tool set).
    const own = [...fixture.requests.values()]
      .flat()
      .filter((item) => item.model === MAIN.id)
      .map((item) => [Prefix.section(item.json, "tools"), wireBytes(item, "tools")].join(" "))
    expect(new Set(own).size).toBe(1)
    expect([Prefix.section(request.json, "tools"), wireBytes(request, "tools")].join(" ")).toBe(required(own[0]))
    // The own role agents are hidden: the subagent tool lists upstream's only.
    const subagent = JSON.stringify(toolNamed(request, "subagent"))
    expect(subagent).toContain("Available subagents")
    for (const role of ["own-review", "own-quick", "own-deep"]) expect(subagent).not.toContain(`- ${role}:`)
  })

  test("no model change but the two main changes, no switch while presets changed, no toolset alert", async () => {
    const rig = required(fixture.rig)
    const sessionID = required(state.session)
    expect(selections(sessionID).map((event) => event.data.model)).toEqual([
      expect.objectContaining(NEXT_MODEL),
      expect.objectContaining(NEXT_ACCOUNT),
    ])
    expect(rig.events.own("alert").filter((event) => event.data.code === "toolset_changed")).toEqual([])
    expect(rig.server.logs()).not.toMatch(
      /hook_failed|preset_entry_write_failed|preset_refresh_failed|preset_reconcile_failed/,
    )
    // The prefix watch saw every primary request: presets only appended, and the main changes (the account one came
    // before any request on the new model) started the second slot's comparison.
    const own = (await prefixLines()).filter((line) => line.sessionID === sessionID)
    expect(new Set(own.map((line) => line.data?.cause))).toEqual(new Set(["first", "append"]))
    expect(new Set(own.map((line) => line.providerID))).toEqual(new Set([SLOT_01, SLOT_02]))
    expect((await prefixLines()).filter((line) => line.data?.cause === "unexplained")).toEqual([])
    expect(await rig.alerts("prefix_diverged")).toEqual([])
  })

  test(
    "positive control: a custom agent added mid-session changes the subagent tool description, one toolset alert",
    async () => {
      const rig = required(fixture.rig)
      const server = rig.server
      const sessionID = required(state.session)
      // A visible custom agent in the global config: core lists it in the subagent tool's description from the next
      // request on, so the tool definitions every own slot request starts with change once.
      const file = path.join(server.paths.config, "opencode.jsonc")
      const config: unknown = await Bun.file(file).json()
      if (!isRecord(config)) throw new Error("the generated opencode.jsonc is not an object")
      const agents = { [PROBE.id]: { description: PROBE.description, mode: "subagent" } }
      await replaceFile(file, JSON.stringify({ ...config, agents }, null, 2))
      // The e2e servers watch no files: a config write through the server (which changes nothing itself) reloads it.
      await server.call("PATCH", "/api/experimental/config", { body: { shell: null } })
      await waitUntil(async () => {
        const response = await server.request("GET", `/api/agent/${PROBE.id}`, {
          query: { "location[directory]": server.paths.workspace },
        })
        return response.ok || undefined
      }, "the custom agent was never registered")

      // The ledger writes prefix lines after the turn: only lines past these count, or the earlier turns' tail (a
      // `first` then an `append`) passes the wait before the control's own lines arrive.
      const before = (await prefixLines()).filter((line) => line.sessionID === sessionID).length
      const [first] = await turn(sessionID, "에이전트를 더한 뒤 질문")
      expect(JSON.stringify(toolNamed(required(first), "subagent"))).toContain(`- ${PROBE.id}: ${PROBE.description}`)
      await turn(sessionID, "에이전트를 더한 뒤 두 번째 질문")
      const changes = rig.events.own("alert").filter((event) => event.data.code === "toolset_changed")
      expect(changes.map((event) => event.data.sessionID)).toEqual([sessionID])
      const lines = await waitUntil(async () => {
        const found = await rig.alerts("toolset_changed")
        return found.length > 0 ? found : undefined
      }, "the toolset alert never reached the ledger")
      expect(lines.map((line) => line.data.fields)).toEqual([
        { providerID: NEXT_ACCOUNT.providerID, modelID: NEXT_ACCOUNT.id, agent: "build", changed: "tools" },
      ])
      // The prefix watch puts the rewrite on the tool definitions, then sees the next request append again.
      const prefixes = await waitUntil(async () => {
        const found = (await prefixLines()).filter((line) => line.sessionID === sessionID).slice(before)
        return found.length >= 2 && found.at(-1)?.data?.cause === "append" ? found.slice(-2) : undefined
      }, "the prefix lines of the control never reached the ledger")
      expect(prefixes.map((line) => [line.data?.cause, line.data?.at])).toEqual([
        ["toolset", "tools"],
        ["append", null],
      ])
      expect(await rig.alerts("prefix_diverged")).toEqual([])
    },
    STEP_TIMEOUT,
  )

  /** A turn after a preset step, with the checks every step makes against the session's previous request. */
  async function nextTurn(sessionID: string, text: string, entryChanged: boolean) {
    const rig = required(fixture.rig)
    const previous = required(requestsOf(sessionID).at(-1))
    const chain = await lastResponseID(sessionID)
    const switches = rig.events.own("switch.state").length
    const [first] = await turn(sessionID, text)
    expectPrefixKept(previous, required(first), chain)
    expect(required(first).model).toBe(MAIN.id)
    expect(selections(sessionID)).toEqual([])
    expect(
      rig.events
        .own("switch.state")
        .slice(switches)
        .filter((event) => event.data.sessionID === sessionID),
    ).toEqual([])
    const updates = updatesOf(sessionID).length
    expect(updates - state.updates).toBe(entryChanged ? 1 : 0)
    expect(presetBlock(required(first)) !== "").toBe(entryChanged)
    state.updates = updates
  }
})

// ---------------------------------------------------------------------------------------------------------------

type Edit = (preset: Omit<Preset.Info, "revision">) => Omit<Preset.Info, "revision">

/** The scripted model: a directive picks a subagent call; children and tool results get a short text. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  if (text.includes(SUBAGENT_PROMPT)) return { type: "text", text: CHILD_DONE }
  if (text.includes("[explore]")) return { type: "tool-call", name: "subagent", input: EXPLORE }
  return { type: "text", text: `답변: ${text}` }
}

/** One prompt until idle; the model requests it made, in order (also kept per session). */
async function turn(sessionID: string, text: string) {
  const server = required(fixture.rig).server
  const before = codex().requests.length
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
  const requests = codex()
    .requests.slice(before)
    .filter((request) => request.model !== undefined)
  fixture.requests.set(sessionID, [...requestsOf(sessionID), ...requests])
  return requests
}

function requestsOf(sessionID: string) {
  return fixture.requests.get(sessionID) ?? []
}

/**
 * The request continues the conversation as it was: the same tool and instruction bytes, all read from the cache
 * (the read ratio stays high), and the input chained to the previous response, so nothing before it was rewritten.
 */
function expectPrefixKept(previous: RecordedRequest, next: RecordedRequest, chain: string) {
  expect(Prefix.section(next.json, "tools")).toBe(Prefix.section(previous.json, "tools"))
  expect(wireBytes(next, "tools")).toBe(wireBytes(previous, "tools"))
  // Since upstream v2.3.2 (#64542) the system prompt is the leading input item, so a chained request carries it in the
  // previous response and sends none of its own: it cannot rewrite it. An unchained one sends the same bytes.
  if (!isRecord(next.json) || next.json.previous_response_id === undefined) {
    expect(Prefix.section(next.json, "system")).toBe(Prefix.section(previous.json, "system"))
    expect(wireBytes(next, "instructions")).toBe(wireBytes(previous, "instructions"))
  }
  expect(isRecord(next.json) ? next.json.previous_response_id : undefined).toBe(chain)
  const cache = required(next.cache)
  expect(cache.cachedTokens).toBeGreaterThanOrEqual(systemTokens(next) - BLOCK)
  // 0.85: since upstream v2.3.2 the appended entry is measured against a chained prompt without a resent system.
  expect(cache.cachedTokens / cache.promptTokens).toBeGreaterThan(0.85)
}

/** A second turn of a session whose entry was in its baseline: the prefix stays and nothing about the entry is new. */
async function expectQuietSecondTurn(sessionID: string) {
  const last = required(requestsOf(sessionID).at(-1))
  const chain = await lastResponseID(sessionID)
  const [second] = await turn(sessionID, "두 번째 질문")
  expectPrefixKept(last, required(second), chain)
  expect(presetBlock(required(second))).toBe("")
  expect(updatesOf(sessionID)).toHaveLength(1)
}

/** The provider response id of the session's last assistant message. */
async function lastResponseID(sessionID: string) {
  const last = (await assistantMessages(required(fixture.rig).server, sessionID)).at(-1)
  // `native` since upstream v2.1 (`providerState` before).
  const id = isRecord(last?.native) ? last.native.responseId : undefined
  if (typeof id !== "string") throw new Error(`no provider response id in ${sessionID}`)
  return id
}

async function apply(sessionID: string, presetID: string) {
  return required(fixture.rig).call("session.preset.apply", { sessionID, presetID })
}

/** A main change through the 02 switch RPCs (the cost window's estimate, then `now`). */
async function switchMain(sessionID: string, target: typeof MAIN) {
  const rig = required(fixture.rig)
  const estimate = await rig.call("switch.estimate", { sessionID, target })
  await rig.call("switch.apply", {
    sessionID,
    estimateID: estimate.estimateID,
    target,
    strategy: "now",
    reason: "manual",
  })
  await waitUntil(async () => {
    const model = (await sessionInfo(rig.server, sessionID)).model
    return isRecord(model) && model.providerID === target.providerID && model.id === target.id
  }, `the main never moved to ${target.providerID}/${target.id}`)
}

function presetID(name: string) {
  return Preset.isBuiltin(name) ? Preset.ID.make(name) : required(fixture.presets.get(name))
}

function binding(sessionID: string) {
  return decodeBinding(required(fixture.rig).kv(Kv.preset(sessionID)))
}

async function resolution(sessionID: string) {
  const view = decodeView(await required(fixture.rig).call("session.preset.get", { sessionID }))
  return required(view.resolution ?? undefined)
}

/** The resolution once it is made against `main` (the binding follows `session.model.selected` on its runner). */
function resolutionFor(sessionID: string, main: typeof MAIN) {
  return waitUntil(async () => {
    const value = await resolution(sessionID)
    return value.main.providerID === main.providerID && value.main.id === main.id ? value : undefined
  }, `the resolution never followed ${main.providerID}/${main.id}`)
}

function withRole(
  preset: Omit<Preset.Info, "revision">,
  role: Preset.Role,
  target: Preset.Target,
): Omit<Preset.Info, "revision"> {
  return {
    ...preset,
    workers: {
      ...preset.workers,
      roles: { ...preset.workers.roles, [role]: { targets: [target], effort: "inherit" } },
    },
  }
}

/** A Ref as plain strings, comparable with the constants. */
function plainRef(ref: { readonly providerID: string; readonly id: string; readonly variant?: string }) {
  return { providerID: ref.providerID, id: ref.id, ...(ref.variant === undefined ? {} : { variant: ref.variant }) }
}

/**
 * sha256 of a request body member as sent (wire key order, cache hints included): what `Prefix.section` leaves out
 * (key order, `cache_control`) still changes the bytes a provider's prompt cache sees.
 */
function wireBytes(request: RecordedRequest, member: "tools" | "instructions") {
  const json = isRecord(request.json) ? request.json : {}
  return sha256(JSON.stringify((member === "instructions" ? systemOf(json) : json[member]) ?? null))
}

/**
 * The system prompt as sent: `instructions`, or since upstream v2.3.2 (#64542) the leading developer message with text
 * content that replaces it on every Responses route; a chained request sends none (it is in the previous response).
 */
function systemOf(json: Readonly<Record<string, unknown>>) {
  if (json.instructions !== undefined) return json.instructions
  if (json.previous_response_id !== undefined) return undefined
  const first: unknown = Array.isArray(json.input) ? json.input[0] : undefined
  return isRecord(first) && first.role === "developer" && typeof first.content === "string" ? first : undefined
}

/** The prefix watch's `prefix` lines (P0-2b) in the rig's `events.jsonl`, oldest first. */
async function prefixLines() {
  const ledger = new LedgerWriter.Writer({ dir: path.join(required(fixture.rig).home, "ledger") })
  const events = await ledger.eventsOf(Home.month(Date.now()))
  return events.filter((event) => event.type === "prefix")
}

/** The tokens of the request's system prefix as the fake counts them (tools, then instructions). */
function systemTokens(request: RecordedRequest) {
  const json = isRecord(request.json) ? request.json : {}
  return estimateTokens(`${JSON.stringify(json.tools ?? [])}\n${JSON.stringify(systemOf(json) ?? null)}`)
}

function toolNamed(request: RecordedRequest, name: string) {
  const tools = isRecord(request.json) && Array.isArray(request.json.tools) ? request.json.tools : []
  return tools.find((tool) => isRecord(tool) && tool.name === name)
}

/** The `own.preset` text among the request's new input items (`""` without one). */
function presetBlock(request: RecordedRequest) {
  const json = isRecord(request.json) ? request.json : {}
  const input = Array.isArray(json.input) ? json.input : []
  // The leading system message (upstream v2.3.2) holds the baseline entry, not an update.
  const system = systemOf(json)
  return input
    .filter((item) => item !== system)
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

function selections(sessionID: string): ServerEvent[] {
  return required(fixture.rig).events.events.filter(
    (event) => event.type === "session.model.selected" && event.data.sessionID === sessionID,
  )
}

function withPreset(file: Record<string, unknown>, preset: Record<string, unknown>) {
  const groups = isRecord(file.groups) ? file.groups : {}
  const codexGroup = isRecord(groups.codex) ? groups.codex : {}
  const presets = Array.isArray(codexGroup.presets) ? codexGroup.presets : []
  return { ...file, groups: { ...groups, codex: { ...codexGroup, presets: [...presets, preset] } } }
}

const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const decodeBinding = Schema.decodeUnknownSync(Preset.Binding)
const decodeView = Schema.decodeUnknownSync(Preset.SessionView)
const decodeList = Schema.decodeUnknownSync(Schema.Struct({ groups: Schema.Array(Preset.GroupView) }))

function codex() {
  return required(fixture.codex)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

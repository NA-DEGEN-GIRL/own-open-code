// End to end on a real upstream server: gate PG2 (R4) of 07 §8.4, T1 parts (나)–(바) and (사), with (마) again under
// T1 presets; (가) and PG1 are the T0 suite (`e2e.test.ts`). R4 (07 §5.4): one subscription per company in a session's
// set, and for the main's company only the main account. One ChatGPT login is one subscription: its `codex` and
// `siwc` accounts count once; another login never does.
// - (나)(다) `presets.set` refuses a same-company subscription target: a Claude group preset with ChatGPT 01 and 02, a
//   ChatGPT preset with ChatGPT 02 second, a ChatGPT preset with the same login's `siwc` account.
// - Team context (`session.preset.apply{team}`): a ChatGPT 01 main with the same login's `siwc` account in the team is
//   accepted; another login's is refused and the binding stays.
// - (라) A hand edit of `presets.json` that adds ChatGPT 02 is dropped on load (the file keeps it) with an alert.
// - (마) `agents.title.model` = ChatGPT 02 is removed: the title runs on the session's account, with an alert.
// - (사) Main 01 → 02 while `가볍게 나눠 쓰기` children (lighter and `메인과 같게`) run on 01: `끝나면 바꾸기` waits for
//   them, `멈추고 바꾸기` stops them first; no 01 request overlaps a 02 request, and children after the switch run on 02.
// - (바) own-accounts' side of a team (06 own.team excluded): a team session's switch to ChatGPT 02/03 or another login
//   is `team_switch_required`, and its exhaustion suggestions leave them out while a plain session's list has them.
//
// own-accounts loads from its package directory (`startPresetRig`) with three linked ChatGPT accounts (01, 02, 03) on
// one fake Codex backend that tells them apart by `chatgpt-account-id`, and two `siwc` accounts kept in the registry
// only (one with ChatGPT 01's login, one with another login; the OpenAI endpoint points at the local fake, and nothing
// is ever sent to them). The scripted model reads a directive in the last user text. Every credential is fake;
// servers bind 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Kv, Preset } from "@own/protocol"
import {
  afterToolResult,
  assistantMessages,
  childOf,
  hashSecret,
  lastUserText,
  replaceFile,
  sessionInfo,
  startFakeCodex,
  startPresetRig,
  toolParts,
  waitUntil,
  type ChatGPTTokens,
  type FakeCodex,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const ACCOUNTS = {
  "01": { accountID: "acct-pg2-01", email: "one@example.test", plan: "plus" },
  "02": { accountID: "acct-pg2-02", email: "two@example.test", plan: "plus" },
  "03": { accountID: "acct-pg2-03", email: "three@example.test", plan: "pro" },
} as const
const SLOT = { "01": "own-codex-pg01", "02": "own-codex-pg02", "03": "own-codex-pg03" } as const
const ACC = { "01": "acc_pg01", "02": "acc_pg02", "03": "acc_pg03", same: "acc_sw01", other: "acc_swxx" } as const
const MAIN = { providerID: SLOT["01"], id: "gpt-6-sol", variant: "high" }
const ON_02 = { providerID: SLOT["02"], id: "gpt-6-sol", variant: "high" }
const ON_03 = { providerID: SLOT["03"], id: "gpt-6-sol", variant: "high" }
/** A model the `siwc` template has. */
const SIWC_MODEL = "gpt-5.5"
// Codex rejects gpt-5.5 and older for ChatGPT accounts since upstream v2.1; Sign in with ChatGPT still offers it.
const CONFIGURED_02 = `${SLOT["02"]}/gpt-5.6-sol`
const LIGHT_SPLIT = "가볍게 나눠 쓰기"
/** How long a slow child's reply takes (keeps it running while the main switches). */
const SLOW_MS = 8_000

const TITLE_PROMPT = "You name conversations so the user can find them later"
const TITLE = "R4 시험"
const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
const AFTER_TOOL = "도구 결과를 읽었습니다."
const CHILD_DONE = "자식 작업을 마쳤습니다."
const CALLS = {
  "[bg-explore]": {
    agent: "explore",
    description: "느린 탐색",
    prompt: "자식 작업: 탐색 <<slow>>",
    background: true,
  },
  "[bg-general]": {
    agent: "general",
    description: "느린 구현",
    prompt: "자식 작업: 구현 <<slow>>",
    background: true,
  },
  "[explore]": { agent: "explore", description: "탐색", prompt: "자식 작업: 탐색" },
  "[review]": { agent: "own-review", description: "리뷰", prompt: "자식 작업: 리뷰" },
} as const

const fixture: {
  codex?: FakeCodex
  rig?: PresetRig
  tokens?: Record<keyof typeof ACCOUNTS, ChatGPTTokens>
  presets: Map<string, string>
} = { presets: new Map() }

beforeAll(async () => {
  const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 }, responder: reply })
  fixture.codex = codex
  const tokens = {
    "01": codex.login(ACCOUNTS["01"]),
    "02": codex.login(ACCOUNTS["02"]),
    "03": codex.login(ACCOUNTS["03"]),
  }
  fixture.tokens = tokens
  fixture.rig = await startPresetRig({
    name: "pg2",
    codex,
    chatgpt: (["01", "02", "03"] as const).map((id) => ({ id, tokens: tokens[id] })),
    siwc: [
      { slug: "sw01", login: { of: "01" } },
      { slug: "swxx", login: "sha256:another-chatgpt-login" },
    ],
    // `siwc` slots call the OpenAI endpoint: keep it on the local fake (it answers 404), never the real API.
    endpoints: { openai: `${codex.url}/v1` },
    config: { agents: { title: { model: CONFIGURED_02 } } },
    models: [MAIN, ON_02, ON_03, { providerID: "own-siwc-sw01", id: SIWC_MODEL }],
  })
  const light = await fixture.rig.call("presets.suggest", { group: "codex", template: "light-split" })
  fixture.presets.set(
    LIGHT_SPLIT,
    decodeInfo((await fixture.rig.call("presets.set", { preset: light.draft })).preset).id,
  )
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await fixture.codex?.stop()
}, 60_000)

describe("PG2 (나)(다): saving a preset with another subscription of its own company is refused", () => {
  const cases = [
    {
      name: "(나) a Claude group preset: explore on ChatGPT 01 and review on ChatGPT 02",
      group: "claude-sub",
      roles: { explore: [pin(ACC["01"])], "own-review": [pin(ACC["02"])] },
      offender: ACC["02"],
    },
    {
      name: "(다) a ChatGPT preset: review on the main, then ChatGPT 02",
      group: "codex",
      roles: { "own-review": [{ rel: "main" }, pin(ACC["02"])] },
      offender: ACC["02"],
    },
    {
      name: "(다) a ChatGPT preset: review on the `siwc` account of ChatGPT 01's own login",
      group: "codex",
      roles: { "own-review": [pin(ACC.same, SIWC_MODEL)] },
      offender: ACC.same,
    },
  ] as const

  for (const item of cases)
    test(item.name, async () => {
      const rig = required(fixture.rig)
      const answer = await rig.rpc("presets.set", { preset: save(`거절 ${item.offender}`, item.group, item.roles) })
      expect(answer.status).toBe(400)
      expect(answer.error).toMatchObject({ type: "same_company_subscription", data: { accountID: item.offender } })
      const listed = JSON.stringify(await rig.call("presets.list", {}))
      expect(listed).not.toContain(`거절 ${item.offender}`)
      expect(await Bun.file(path.join(rig.home, "presets.json")).text()).not.toContain(`거절 ${item.offender}`)
    })

  test("a Claude group preset with ChatGPT 01 alone is one OpenAI subscription and is saved", async () => {
    const rig = required(fixture.rig)
    const saved = await rig.call("presets.set", {
      preset: save("Claude + ChatGPT 01 리뷰", "claude-sub", { "own-review": [pin(ACC["01"])] }),
    })
    expect(decodeInfo(saved.preset)).toMatchObject({ group: "claude-sub", revision: 1 })
  })
})

describe("PG2 team context: one ChatGPT login is one subscription (07 §5.4, 06 §10.1)", () => {
  test("a ChatGPT 01 main with the same login's `siwc` account in its team is accepted; another login is refused", async () => {
    const rig = required(fixture.rig)
    const session = await rig.server.createSession({ model: MAIN })
    const accepted = await rig.call("session.preset.apply", {
      sessionID: session.id,
      presetID: Preset.builtinID("codex"),
      team: team("tm_pg2same", [ACC["01"], ACC.same]),
    })
    expect(decodeBinding(accepted.binding).team).toMatchObject({ accounts: [ACC["01"], ACC.same] })

    for (const breach of [
      { team: team("tm_pg2other", [ACC["01"], ACC.other]), offender: ACC.other },
      { team: team("tm_pg2pin", [ACC["01"]], [pin(ACC["02"])]), offender: ACC["02"] },
    ]) {
      const refused = await rig.rpc("session.preset.apply", {
        sessionID: session.id,
        presetID: Preset.builtinID("codex"),
        team: breach.team,
      })
      expect(refused.error).toMatchObject({ type: "same_company_subscription", data: { accountID: breach.offender } })
      // The binding stays as it was.
      expect(decodeBinding(rig.kv(Kv.preset(session.id))).team).toMatchObject({ teamID: "tm_pg2same" })
    }
  })
})

describe("PG2 (라): a hand edit that adds ChatGPT 02 is dropped on load, with an alert", () => {
  test(
    "the loaded preset runs without the 02 target; presets.json keeps it; 02 gets nothing",
    async () => {
      const rig = required(fixture.rig)
      const saved = decodeInfo(
        (
          await rig.call("presets.set", {
            preset: save("손으로 고칠 리뷰", "codex", { "own-review": [{ rel: "main" }] }),
          })
        ).preset,
      )
      const file = path.join(rig.home, "presets.json")
      const current: unknown = await Bun.file(file).json()
      const edited = JSON.stringify(current).replace(
        JSON.stringify({ targets: [{ rel: "main" }], effort: "inherit" }),
        JSON.stringify({ targets: [pin(ACC["02"]), { rel: "main" }], effort: "inherit" }),
      )
      expect(edited).toContain(ACC["02"])
      await replaceFile(file, edited)

      const alert = await rig.events.waitFor(
        (event) =>
          event.type === "rpc.own.accounts.alert" &&
          event.data.code === "preset_entry_dropped" &&
          event.data.accountID === ACC["02"],
      )
      expect(alert.data).toMatchObject({ severity: "warning" })
      const listed = decodeList(await rig.call("presets.list", { group: "codex" }))
      const loaded = required(
        listed.groups.flatMap((group) => group.presets ?? []).find((item) => item.id === saved.id),
      )
      expect(loaded.workers.roles["own-review"]?.targets).toEqual([{ rel: "main" }])
      expect(await Bun.file(file).text()).toContain(ACC["02"])
      expect((await rig.alerts("preset_entry_dropped")).length).toBeGreaterThan(0)

      // A review call of a session on this preset runs on the main.
      const session = await rig.server.createSession({ model: MAIN })
      await rig.call("session.preset.apply", { sessionID: session.id, presetID: saved.id })
      await turn(session.id, "[review] 리뷰해 줘")
      const part = required((await toolParts(rig.server, session.id, "subagent")).at(-1))
      expect(part.state.status).toBe("completed")
      expect((await childOf(rig.server, part)).model).toEqual(MAIN)
      expect(requestsOf("02")).toEqual([])
    },
    TURN_TIMEOUT,
  )
})

describe("PG2 (마): `agents.title.model` = ChatGPT 02 runs on the session's account", () => {
  test(
    "the title request goes to ChatGPT 01, the ledger has the alert, selfTest lists the removal",
    async () => {
      const rig = required(fixture.rig)
      const server = rig.server
      const created = await server.call("POST", "/api/session", {
        body: { model: MAIN, location: { directory: server.paths.workspace } },
      })
      const sessionID = String(isRecord(created) && isRecord(created.data) ? created.data.id : "")
      const before = codex().requests.filter(isTitleRequest).length
      await turn(sessionID, "제목을 붙일 첫 메시지")
      await waitUntil(async () => (await sessionInfo(server, sessionID)).title === TITLE, "no title answer")
      const titles = codex().requests.filter(isTitleRequest).slice(before)
      expect(titles.map((request) => [request.identity, request.status])).toEqual([[identity("01"), 200]])
      const alerts = await waitUntil(async () => {
        const lines = await rig.alerts("internal_agent_model_removed")
        return lines.length > 0 ? lines : undefined
      }, "no internal_agent_model_removed alert in the ledger")
      expect(alerts.some((line) => line.message.includes("title") && line.message.includes(CONFIGURED_02))).toBe(true)
      expect(await rig.call("diagnostics.selfTest", {})).toMatchObject({
        agentModels: { ok: false, removed: [{ agent: "title", model: { providerID: SLOT["02"], id: "gpt-5.6-sol" } }] },
      })
      expect(requestsOf("02")).toEqual([])
    },
    TURN_TIMEOUT,
  )
})

describe("PG2 (사): main 01 → 02 while relative-target children run on 01 (07 §5.5)", () => {
  for (const children of ["after-idle", "stop"] as const)
    test(
      `\`${children === "after-idle" ? "끝나면 바꾸기" : "멈추고 바꾸기"}\` (${children}): no 01 request overlaps a 02 request`,
      async () => {
        const rig = required(fixture.rig)
        const server = rig.server
        const begin = Date.now()
        const root = (await server.createSession({ model: MAIN })).id
        await rig.call("session.preset.apply", {
          sessionID: root,
          presetID: required(fixture.presets.get(LIGHT_SPLIT)),
        })
        // Two background children on ChatGPT 01: explore on the lighter model, general like the main.
        await turn(root, "[bg-explore] 탐색을 맡겨 줘")
        await turn(root, "[bg-general] 구현을 맡겨 줘")
        const launched = await toolParts(server, root, "subagent")
        const kids = await Promise.all(launched.map((part) => childOf(server, part)))
        expect(kids.map((kid) => kid.model)).toEqual([
          expect.objectContaining({ providerID: SLOT["01"], id: "gpt-6-luna" }),
          expect.objectContaining(MAIN),
        ])

        const estimate = await rig.call("switch.estimate", { sessionID: root, target: ON_02 })
        expect(estimate.busyChildren).toEqual({ count: 2, accountID: ACC["01"] })
        const applied = await rig.call("switch.apply", {
          sessionID: root,
          estimateID: estimate.estimateID,
          target: ON_02,
          strategy: "now",
          reason: "manual",
          children,
        })
        expect(applied.state).toBe("WAIT_SAFE")
        expect((await sessionInfo(server, root)).model).toMatchObject({ providerID: SLOT["01"] })

        const switchedAt = await waitUntil(
          async () => {
            const model = (await sessionInfo(server, root)).model
            return isRecord(model) && model.providerID === SLOT["02"] ? Date.now() : undefined
          },
          "the main never moved to ChatGPT 02",
          60_000,
        )
        // When the children's requests started (each one's reply takes SLOW_MS).
        const started = Math.min(
          ...codex()
            .requests.filter((request) => request.model !== undefined && request.at >= begin)
            .filter((request) => request.body.includes("<<slow>>"))
            .map((request) => request.at),
        )
        if (children === "stop") {
          // Stopped, not waited for: the switch came before the children's replies would have ended.
          expect(switchedAt - started).toBeLessThan(SLOW_MS)
          for (const kid of kids)
            await rig.events.waitFor(
              (event) => event.type === "session.execution.interrupted" && event.data.sessionID === kid.id,
            )
        }
        if (children === "after-idle") expect(switchedAt - started).toBeGreaterThanOrEqual(SLOW_MS)

        // After the switch the relative roles follow the main: the next child runs on ChatGPT 02.
        await turn(root, "[explore] 전환 뒤 탐색")
        const after = await childOf(server, required((await toolParts(server, root, "subagent")).at(-1)))
        expect(after.model).toMatchObject({ providerID: SLOT["02"], id: "gpt-6-luna" })
        await server.waitIdle(root)

        // No moment with a 01 and a 02 request of this tree at once.
        const messages = (
          await Promise.all([root, ...kids.map((kid) => kid.id), after.id].map((id) => assistantMessages(server, id)))
        ).flat()
        const spans = (slot: string) =>
          messages.flatMap((message) => {
            const model = message.model
            const time = message.time
            if (!isRecord(model) || model.providerID !== slot || !isRecord(time)) return []
            return [{ created: Number(time.created), completed: Number(time.completed ?? Number.POSITIVE_INFINITY) }]
          })
        const one = spans(SLOT["01"])
        const two = spans(SLOT["02"])
        expect(one.length).toBeGreaterThan(0)
        expect(two.length).toBeGreaterThan(0)
        expect(Math.max(...one.map((span) => span.completed))).toBeLessThanOrEqual(
          Math.min(...two.map((span) => span.created)),
        )
        const firstTwo = Math.min(
          ...requestsOf("02")
            .filter((request) => request.at >= started)
            .map((request) => request.at),
        )
        expect(Math.max(...one.map((span) => span.completed))).toBeLessThanOrEqual(firstTwo)
      },
      TURN_TIMEOUT,
    )
})

describe("PG2 (바): own-accounts' side of a team on ChatGPT 01 (07 §5.5 팀 거르기)", () => {
  test(
    "switching a team session to another subscription of the team's company is `team_switch_required`",
    async () => {
      const rig = required(fixture.rig)
      const root = (await rig.server.createSession({ model: MAIN })).id
      await rig.call("session.preset.apply", {
        sessionID: root,
        presetID: Preset.builtinID("codex"),
        team: team("tm_pg2team", [ACC["01"]]),
      })
      const twos = requestsOf("02").length
      for (const target of [ON_02, ON_03, { providerID: "own-siwc-swxx", id: SIWC_MODEL }]) {
        for (const method of ["switch.estimate", "switch.apply", "switch.schedule"] as const) {
          const answer = await rig.rpc(method, {
            sessionID: root,
            target,
            ...(method === "switch.apply" ? { strategy: "now", reason: "manual" } : {}),
            ...(method === "switch.schedule" ? { trigger: "idle_ttl" } : {}),
          })
          expect(answer.error).toMatchObject({ type: "team_switch_required", data: { teamID: "tm_pg2team" } })
        }
      }
      // The same login's `siwc` account is the team's own subscription.
      const sibling = await rig.rpc("switch.estimate", {
        sessionID: root,
        target: { providerID: "own-siwc-sw01", id: SIWC_MODEL },
      })
      expect(sibling.error?.type).not.toBe("team_switch_required")
      expect((await sessionInfo(rig.server, root)).model).toMatchObject(MAIN)
      expect(requestsOf("02")).toHaveLength(twos)
    },
    TURN_TIMEOUT,
  )

  test(
    "exhausting ChatGPT 01: the team session's suggestions leave out 02, 03 and another login; a plain session's do not",
    async () => {
      const rig = required(fixture.rig)
      const team01 = (await rig.server.createSession({ model: MAIN })).id
      await rig.call("session.preset.apply", {
        sessionID: team01,
        presetID: Preset.builtinID("codex"),
        team: team("tm_pg2team", [ACC["01"]]),
      })
      const plain = (await rig.server.createSession({ model: MAIN })).id
      const twos = requestsOf("02").length
      codex().setUsage(ACCOUNTS["01"].accountID, { primary: 100 })

      const suggested = async (sessionID: string) => {
        await turn(sessionID, "한도에 걸리는 질문")
        const event = await rig.events.waitFor(
          (item) => item.type === "rpc.own.accounts.switch.suggested" && item.data.sessionID === sessionID,
        )
        expect(event.data.reason).toBe("hard")
        const candidates = Array.isArray(event.data.candidates) ? event.data.candidates.filter(isRecord) : []
        return candidates.map((candidate) => candidate.accountID)
      }
      const teamList = await suggested(team01)
      expect(teamList).not.toContain(ACC["02"])
      expect(teamList).not.toContain(ACC["03"])
      expect(teamList).not.toContain(ACC.other)
      const plainList = await suggested(plain)
      expect(plainList).toEqual(expect.arrayContaining([ACC["02"], ACC["03"]]))
      // Subscriptions never rotate by themselves: both stay on ChatGPT 01, and 02 got nothing.
      for (const sessionID of [team01, plain])
        expect((await sessionInfo(rig.server, sessionID)).model).toMatchObject({ providerID: SLOT["01"] })
      expect(requestsOf("02")).toHaveLength(twos)
    },
    TURN_TIMEOUT,
  )
})

test("nothing reached a `siwc` account; no hook failed", () => {
  const rig = required(fixture.rig)
  expect(codex().requests.filter((request) => request.path.startsWith("/v1"))).toEqual([])
  expect(rig.server.logs()).not.toMatch(/hook_failed|setup_failed|module_start_failed|agent_transform_register_failed/)
})

// ---------------------------------------------------------------------------------------------------------------

/**
 * The scripted model. Titles get a fixed answer, tool results a short text, a child its "done" (a `<<slow>>` child
 * after {@link SLOW_MS}); otherwise the directive in the last user text picks the subagent call.
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes(TITLE_PROMPT)) return { type: "text", text: TITLE }
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  if (text.includes(SUBAGENT_PROMPT))
    return { type: "text", text: CHILD_DONE, ...(text.includes("<<slow>>") ? { delayMs: SLOW_MS } : {}) }
  const call = Object.entries(CALLS).find((entry) => text.includes(entry[0]))
  if (call) return { type: "tool-call", name: "subagent", input: call[1] }
  return { type: "text", text: "답변" }
}

async function turn(sessionID: string, text: string) {
  const server = required(fixture.rig).server
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
}

function save(name: string, group: Preset.Group, roles: Readonly<Record<string, ReadonlyArray<unknown>>>) {
  return {
    name,
    group,
    workers: {
      mode: "by-role",
      roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
    },
    delegation: "when-useful",
    caps: Preset.CAPS,
    ultraCaps: null,
  }
}

function pin(account: string, model = "gpt-5.6-sol") {
  return { pin: { account, model } }
}

function team(teamID: string, accounts: ReadonlyArray<string>, pinned: ReadonlyArray<unknown> = []) {
  return { teamID, role: "owner", accounts, pinned }
}

function identity(id: keyof typeof ACCOUNTS) {
  return `codex:${ACCOUNTS[id].accountID}`
}

/** Everything the fake saw from one ChatGPT account: by its identity, its account header or its access token. */
function requestsOf(id: keyof typeof ACCOUNTS) {
  const token = hashSecret(`Bearer ${required(fixture.tokens)[id].accessToken}`)
  return codex().requests.filter(
    (request) =>
      request.identity === identity(id) ||
      request.headers["chatgpt-account-id"] === ACCOUNTS[id].accountID ||
      request.headers.authorization === token,
  )
}

function isTitleRequest(request: RecordedRequest) {
  return request.model !== undefined && request.body.includes(TITLE_PROMPT)
}

function codex() {
  return required(fixture.codex)
}

const decodeInfo = Schema.decodeUnknownSync(Preset.Info)
const decodeBinding = Schema.decodeUnknownSync(Preset.Binding)
const decodeList = Schema.decodeUnknownSync(Schema.Struct({ groups: Schema.Array(Preset.GroupView) }))

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

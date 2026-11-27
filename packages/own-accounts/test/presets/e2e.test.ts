// End to end on a real upstream server (e2e kit) for the subagent gate and the hidden-agent model check (07 §5.4):
// gates PG1 (refusal path, hook order) and PG2 (가)(마) of 07 §8.4, the T0 item of 06 TG15.
//
// own-accounts loads from its package directory (every module real). Two ChatGPT (`codex`) accounts are linked to fake
// codex-multi-provider profiles (`accounts.json` seeded like test/slots-auth/e2e.test.ts) and answer from one fake
// Codex backend, which tells them apart by `chatgpt-account-id`. Every session's main is ChatGPT 01. The scripted model
// reads a directive in the last user text and calls the `subagent` tool (or Code Mode's `execute`); the opencode config
// points `agents.explore.model` and `agents.title.model` at ChatGPT 02 (a second server checks the legacy `agent` and
// `small_model` keys). Verdicts come from durable state: the session message API, the child sessions, the requests the
// fake recorded, the `kv` row of the root's preset binding, the instruction entries, the ledger's alert lines.
//
// The fake ChatGPT 02 must never see a request (PG2: "02로 가는 요청 0"). Every credential is fake; the real old-app
// profiles and this PC's `.codex` are never read (the harness points CODEX_HOME at a temp folder). Servers bind
// 127.0.0.1 only.

import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Kind, Kv, OwnAccounts, Preset } from "@own/protocol"
import { CodexSource } from "@own/runtime"
import {
  hashSecret,
  ledgerAlerts,
  opencodeConfig,
  recordServerEvents,
  removeTree,
  startFakeCodex,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type ChatGPTTokens,
  type EventRecorder,
  type FakeCodex,
  type LegacyProfile,
  type OpencodeServer,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"
import { registryWith } from "../slots/support.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const PACKAGE = path.join(import.meta.dir, "../..")

const ONE = { accountID: "acct-pg01", email: "one@example.test", plan: "plus" }
const TWO = { accountID: "acct-pg02", email: "two@example.test", plan: "plus" }
const SLOT_01 = Kind.ProviderID.from("codex", "pg01")
const SLOT_02 = Kind.ProviderID.from("codex", "pg02")
// Codex rejects gpt-5.5 and older for ChatGPT accounts since upstream v2.1, so the slots run gpt-5.6-sol.
const MAIN = { providerID: SLOT_01, id: "gpt-5.6-sol" }
/** A subscription slot the user configured for agents (another ChatGPT account of the same company). */
const CONFIGURED_02 = `${SLOT_02}/gpt-5.6-sol`

const TITLE_PROMPT = "You name conversations so the user can find them later"
const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
const TITLE = "프리셋 관문 시험"
const AFTER_TOOL = "도구 결과를 읽었습니다."
const CHILD_DONE = "자식 작업을 마쳤습니다."
const MODELS_CODE = "return await tools.opencode.models({})"

/** The subagent calls the scripted model makes, by directive: exactly the input the LLM writes. */
const CALLS = {
  "[reject-02]": {
    agent: "general",
    description: "다른 계정 리뷰",
    prompt: "자식 작업: reject-02",
    model: `${SLOT_02}/gpt-6-sol`,
  },
  "[canonical]": {
    agent: "general",
    description: "정규 ID",
    prompt: "자식 작업: canonical",
    model: "openai/gpt-6-sol",
  },
  "[role]": { agent: "general", description: "역할 이름", prompt: "자식 작업: role", model: "review" },
  "[explore]": { agent: "explore", description: "설정 모델", prompt: "자식 작업: explore" },
  "[blank]": { agent: "general", description: "빈 모델", prompt: "자식 작업: blank", model: "" },
  // 07 §2.3 대화에서 정하는 강도: an effort alone, a role with one, and the raw form with one.
  "[effort]": { agent: "general", description: "강도만", prompt: "자식 작업: effort", model: "#low" },
  "[role-effort]": {
    agent: "general",
    description: "역할과 강도",
    prompt: "자식 작업: role-effort",
    model: "review#xhigh",
  },
  "[raw-effort]": {
    agent: "general",
    description: "정규 ID와 강도",
    prompt: "자식 작업: raw-effort",
    model: "openai/gpt-6-sol#max",
  },
} as const

const fixture: {
  codex?: FakeCodex
  temp?: string
  legacy?: string
  profiles?: ReadonlyArray<LegacyProfile>
  tokens?: { readonly one: ChatGPTTokens; readonly two: ChatGPTTokens }
} = {}

beforeAll(async () => {
  const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 }, responder: reply })
  const tokens = { one: codex.login(ONE), two: codex.login(TWO) }
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-presets-e2e-")))
  const legacy = path.join(temp, "control-center")
  const profiles = await writeCodexMultiProviderProfiles(legacy, [
    { id: "01", alias: "one", tokens: tokens.one },
    { id: "02", alias: "two", tokens: tokens.two },
  ])
  Object.assign(fixture, { codex, temp, legacy, profiles, tokens })
})

afterAll(async () => {
  await fixture.codex?.stop()
  if (fixture.temp) await removeTree(fixture.temp)
}, 60_000)

describe("subagent gate and hidden-agent models on a real server (07 PG1, PG2 (가)(마))", () => {
  const state: { server?: OpencodeServer; events?: EventRecorder; home?: string } = {}

  beforeAll(async () => {
    const booted = await boot("main", {
      agents: { explore: { model: CONFIGURED_02 }, title: { model: CONFIGURED_02 } },
    })
    Object.assign(state, booted)
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.events?.close()
    await state.server?.stop()
  }, 60_000)

  test(
    "(1) PG1: another ChatGPT slot is refused as a tool failure the LLM reads, never a session error",
    async () => {
      const server = required(state.server)
      const events = required(state.events)
      const sessionID = await turn(server, "[reject-02] 다른 계정으로 리뷰해 줘")
      const part = await toolPart(server, sessionID, "subagent")
      expect(part.state.status).toBe("error")
      const message = errorMessage(part)
      expect(message.startsWith(`Unknown agent: ${Preset.REJECT_PREFIX}`)).toBe(true)
      expect(message).toEndWith("Ask the user if another model is needed.")
      // The refusal names roles only, never a provider, model or account.
      expect(message).not.toContain(SLOT_02)
      expect(message).not.toContain("gpt-")
      // (8) The transcript shows the LLM's own input, not the gate's rewrite of `agent`.
      expect(part.state.input).toEqual(CALLS["[reject-02]"])

      // Not a session error: the run went on, the LLM read the failure and answered.
      const assistants = (await server.messages(sessionID)).filter((item) => item.type === "assistant")
      expect(assistants.filter((item) => item.error !== undefined)).toEqual([])
      expect(texts(assistants)).toContain(AFTER_TOOL)
      const followUp = required(codex().requests.find((request) => failureOutputs(request).length > 0))
      expect(failureOutputs(followUp).join("\n")).toContain(`Unknown agent: ${Preset.REJECT_PREFIX}`)
      expect(followUp.identity).toBe(identity(ONE))
      // No child was made: nothing ever ran the child's prompt.
      expect(requestsWith(CALLS["[reject-02]"].prompt)).toEqual([])

      const alert = await events.waitFor(
        (event) =>
          event.type === "rpc.own.accounts.alert" &&
          event.data.code === "subagent_rejected" &&
          event.data.sessionID === sessionID,
      )
      expect(alert.data.severity).toBe("info")
      expect(String(alert.data.message)).toContain(`${SLOT_02}/gpt-6-sol`)
    },
    TURN_TIMEOUT,
  )

  test(
    "(2) PG2 (가): the canonical `openai/<id>` runs on the main account (ChatGPT 01)",
    async () => {
      const server = required(state.server)
      const sessionID = await turn(server, "[canonical] 정규 ID로 맡겨 줘")
      const part = await toolPart(server, sessionID, "subagent")
      expect(part.state.status).toBe("completed")
      // (8) The transcript keeps what the LLM wrote; the gate's `own-codex-…` rewrite is never published.
      expect(part.state.input).toEqual(CALLS["[canonical]"])
      const child = await childOf(server, part)
      expect(child.model).toMatchObject({ providerID: SLOT_01, id: "gpt-6-sol" })
      expect(child.parentID).toBe(sessionID)
      const requests = requestsWith(CALLS["[canonical]"].prompt)
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expect(request).toMatchObject({ identity: identity(ONE), model: "gpt-6-sol" })
    },
    TURN_TIMEOUT,
  )

  test(
    "(3) PG2 (가): a role name runs like the main (ChatGPT 01, the parent's model)",
    async () => {
      const server = required(state.server)
      const sessionID = await turn(server, "[role] 리뷰 역할로 맡겨 줘")
      const part = await toolPart(server, sessionID, "subagent")
      expect(part.state.status).toBe("completed")
      expect(part.state.input).toEqual(CALLS["[role]"])
      const child = await childOf(server, part)
      expect(child.model).toMatchObject(MAIN)
      const requests = requestsWith(CALLS["[role]"].prompt)
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expect(request.identity).toBe(identity(ONE))
    },
    TURN_TIMEOUT,
  )

  test(
    "(4) PG2 (가): `agents.explore.model` = ChatGPT 02 runs on ChatGPT 01 and raises subagent_model_overridden",
    async () => {
      const server = required(state.server)
      const events = required(state.events)
      const sessionID = await turn(server, "[explore] 탐색을 맡겨 줘")
      const part = await toolPart(server, sessionID, "subagent")
      expect(part.state.status).toBe("completed")
      expect(part.state.input).toEqual(CALLS["[explore]"])
      const child = await childOf(server, part)
      expect(child).toMatchObject({ agent: "explore", model: MAIN })
      const requests = requestsWith(CALLS["[explore]"].prompt)
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expect(request.identity).toBe(identity(ONE))
      const alert = await events.waitFor(
        (event) =>
          event.type === "rpc.own.accounts.alert" &&
          event.data.code === "subagent_model_overridden" &&
          event.data.sessionID === sessionID,
      )
      expect(String(alert.data.message)).toContain(CONFIGURED_02)
      expect(String(alert.data.message)).toContain(`${SLOT_01}/gpt-5.6-sol`)
    },
    TURN_TIMEOUT,
  )

  test(
    "(5) PG2 (마): `agents.title.model` = ChatGPT 02 is removed; the title runs on the session's account",
    async () => {
      const server = required(state.server)
      await expectTitleOnMain(server, required(state.home))
      // The same check `diagnostics.selfTest` reports (07 §5.4 "selfTest도 같은 것을 본다").
      const selfTest = await rpc(server, "diagnostics.selfTest")
      expect(selfTest.agentModels).toEqual({
        ok: false,
        removed: [{ agent: "title", model: { providerID: SLOT_02, id: "gpt-5.6-sol" } }],
      })
    },
    TURN_TIMEOUT,
  )

  test(
    "(6) PG2 (가): Code Mode `tools.opencode.models({})` lists only the main account's slot",
    async () => {
      const server = required(state.server)
      const sessionID = await turn(server, "[models] 쓸 수 있는 모델을 보여 줘")
      const part = await toolPart(server, sessionID, "execute")
      expect(part.state.status).toBe("completed")
      expect(part.state.input).toEqual({ code: MODELS_CODE })
      const outputs = codex().requests.flatMap((request) =>
        functionOutputs(request).filter((output) => output.includes("providers")),
      )
      expect(outputs.length).toBeGreaterThan(0)
      for (const output of outputs) {
        expect(output).toContain(SLOT_01)
        expect(output).not.toContain(SLOT_02)
      }
      expect(JSON.stringify(part.state)).not.toContain(SLOT_02)
    },
    TURN_TIMEOUT,
  )

  test(
    '(7) PG1 hook order: `model: ""` with agent `general` succeeds (core\'s normaliser ran before the gate)',
    async () => {
      const server = required(state.server)
      const sessionID = await turn(server, "[blank] 그냥 맡겨 줘")
      const part = await toolPart(server, sessionID, "subagent")
      expect(part.state.status).toBe("completed")
      expect(part.state.input).toEqual(CALLS["[blank]"])
      const child = await childOf(server, part)
      expect(child.model).toMatchObject(MAIN)
      const requests = requestsWith(CALLS["[blank]"].prompt)
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expect(request.identity).toBe(identity(ONE))
    },
    TURN_TIMEOUT,
  )

  test(
    "(10) 07 §2.3: `#low`, `review#xhigh` and `openai/gpt-6-sol#max` reach core rewritten; the child runs at that level",
    async () => {
      const server = required(state.server)
      const cases = [
        ["[effort]", "강도만 낮춰 맡겨 줘", { providerID: SLOT_01, id: "gpt-5.6-sol", variant: "low" }],
        ["[role-effort]", "리뷰를 매우 높음으로 맡겨 줘", { providerID: SLOT_01, id: "gpt-5.6-sol", variant: "xhigh" }],
        ["[raw-effort]", "정규 ID를 최대로 맡겨 줘", { providerID: SLOT_01, id: "gpt-6-sol", variant: "max" }],
      ] as const
      for (const [directive, text, model] of cases) {
        const sessionID = await turn(server, `${directive} ${text}`)
        const part = await toolPart(server, sessionID, "subagent")
        // Never core's "Invalid model": the gate wrote `provider/model#variant`, the transcript keeps the LLM's input.
        expect(part.state.status).toBe("completed")
        expect(part.state.input).toEqual(CALLS[directive])
        expect(part.state.metadata?.own).toEqual({
          effort: { requested: CALLS[directive].model.split("#")[1], used: model.variant },
        })
        expect((await childOf(server, part)).model).toEqual(model)
        const requests = requestsWith(CALLS[directive].prompt)
        expect(requests.length).toBeGreaterThan(0)
        for (const request of requests) {
          expect(request).toMatchObject({ identity: identity(ONE), model: model.id })
          expect(request.json).toMatchObject({ reasoning: { effort: model.variant } })
        }
      }
    },
    TURN_TIMEOUT * 3,
  )

  test("(9) roots are bound to builtin:codex without an own.preset entry; children are not bound", async () => {
    const server = required(state.server)
    const sessionID = await turn(server, "[role] 바인딩 확인")
    const part = await toolPart(server, sessionID, "subagent")
    const child = await childOf(server, part)
    const stored = kv(server, Kv.preset(sessionID))
    expect(stored).toMatchObject({ presetID: Preset.builtinID("codex"), group: "codex", entryHash: null })
    expect(kv(server, Kv.preset(child.id))).toBeUndefined()
    const entries = await server.call("GET", `/api/experimental/session/${sessionID}/instructions/entries`)
    const keys = (isRecord(entries) && Array.isArray(entries.data) ? entries.data : []).flatMap((entry) =>
      isRecord(entry) && typeof entry.key === "string" ? [entry.key] : [],
    )
    expect(keys.filter((key) => key.startsWith("own.preset"))).toEqual([])
  })

  test("ChatGPT 02 never received a request; no hook failed", () => {
    expect(requestsOfTwo()).toEqual([])
    expect(codex().requests.filter((request) => request.identity === identity(ONE)).length).toBeGreaterThan(0)
    const logs = required(state.server).logs()
    expect(logs).not.toMatch(/hook_failed|setup_failed|module_start_failed|agent_transform_register_failed/)
  })
})

describe("legacy config keys: `agent.explore.model` and `small_model` (07 §5.4, PG2 (가)(마))", () => {
  const state: { server?: OpencodeServer; events?: EventRecorder; home?: string } = {}

  beforeAll(async () => {
    const booted = await boot("legacy", { agent: { explore: { model: CONFIGURED_02 } }, small_model: CONFIGURED_02 })
    Object.assign(state, booted)
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.events?.close()
    await state.server?.stop()
  }, 60_000)

  test(
    "`small_model` = ChatGPT 02 is removed like `agents.title.model`",
    async () => {
      const server = required(state.server)
      await expectTitleOnMain(server, required(state.home))
    },
    TURN_TIMEOUT,
  )

  test(
    "`agent.explore.model` = ChatGPT 02 is replaced by the main",
    async () => {
      const server = required(state.server)
      const events = required(state.events)
      const sessionID = await turn(server, "[explore] 탐색을 맡겨 줘")
      const child = await childOf(server, await toolPart(server, sessionID, "subagent"))
      expect(child).toMatchObject({ agent: "explore", model: MAIN })
      await events.waitFor(
        (event) =>
          event.type === "rpc.own.accounts.alert" &&
          event.data.code === "subagent_model_overridden" &&
          event.data.sessionID === sessionID,
      )
    },
    TURN_TIMEOUT,
  )

  test("ChatGPT 02 never received a request; no hook failed", () => {
    expect(requestsOfTwo()).toEqual([])
    const logs = required(state.server).logs()
    expect(logs).not.toMatch(/hook_failed|setup_failed|module_start_failed|agent_transform_register_failed/)
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** Boots a server whose own-accounts has the two linked ChatGPT accounts; `config` adds agent settings. */
async function boot(name: string, config: Readonly<Record<string, unknown>>) {
  const codex = required(fixture.codex)
  const legacy = required(fixture.legacy)
  const home = path.join(required(fixture.temp), `own-home-${name}`)
  await fs.mkdir(home, { recursive: true })
  const profiles = required(fixture.profiles)
  const seeds = await Promise.all(
    profiles.map(async (profile, index) => ({
      kind: "codex" as const,
      label: `ChatGPT ${profile.id}`,
      slug: `pg${profile.id}`,
      identity: await sourceIdentity(profile.authPath),
      credential: {
        type: "linked-codex-source" as const,
        source: {
          app: "codex-multi-provider" as const,
          profileID: profile.id,
          alias: profile.alias,
          authPath: profile.authPath,
        },
        linkedAt: `2026-10-0${index + 1}T00:00:00Z`,
      },
    })),
  )
  await Bun.write(path.join(home, "accounts.json"), JSON.stringify(await registryWith(seeds), null, 2))
  const server = await startOpencodeServer({
    env: { OWN_OPEN_CODE: "1" },
    config: opencodeConfig({
      providers: {},
      plugins: [
        {
          package: PACKAGE,
          options: {
            home,
            buildId: `e2e-presets-${name}-${process.pid}`,
            vault: "memory",
            endpoints: { codex: codex.baseURL, oauthIssuer: codex.url },
            codexImportRoot: legacy,
          },
        },
      ],
      extra: config,
    }),
  })
  // Subscribed before any session exists, so every session alert is on the stream.
  const events = await recordServerEvents(server)
  await server.waitForModels([
    MAIN,
    { providerID: SLOT_01, id: "gpt-6-sol" },
    { providerID: SLOT_02, id: "gpt-5.6-sol" },
  ])
  return { server, events, home }
}

/**
 * The scripted model. Titles get a fixed answer, tool results a short text, a child its "done"; otherwise the
 * directive in the last user text picks the tool call. Children never see a directive (their prompts have none).
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes(TITLE_PROMPT)) return { type: "text", text: TITLE }
  const input = inputItems(request)
  const last = input.at(-1)
  // `custom_tool_call_output`: Code Mode's `execute` is a freeform tool on models whose capabilities list it (v2.3.0).
  if (isRecord(last) && (last.type === "function_call_output" || last.type === "custom_tool_call_output"))
    return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(input)
  if (text.includes(SUBAGENT_PROMPT)) return { type: "text", text: CHILD_DONE }
  if (text.includes("[models]")) return { type: "tool-call", name: "execute", input: { code: MODELS_CODE } }
  const call = Object.entries(CALLS).find((entry) => text.includes(entry[0]))
  if (call) return { type: "tool-call", name: "subagent", input: call[1] }
  return { type: "text", text: "답변" }
}

/** One titled session on ChatGPT 01, one prompt, until idle. */
async function turn(server: OpencodeServer, text: string) {
  const session = await server.createSession({ model: MAIN, title: "presets e2e" })
  await server.prompt(session.id, text)
  await server.waitIdle(session.id)
  return session.id
}

/**
 * An untitled session: core asks the title agent, whose configured model (ChatGPT 02) own-accounts removed, so the
 * title request goes to the session's account and nothing reaches ChatGPT 02 (not even core's title fallback, which
 * would try the configured model first). The ledger keeps the `internal_agent_model_removed` alert.
 */
async function expectTitleOnMain(server: OpencodeServer, home: string) {
  const created = await server.call("POST", "/api/session", {
    body: { model: MAIN, location: { directory: server.paths.workspace } },
  })
  const sessionID = String(isRecord(created) && isRecord(created.data) ? created.data.id : "")
  expect(sessionID).not.toBe("")
  // The fake is shared by both servers: count only this session's title requests.
  const before = codex().requests.filter(isTitleRequest).length
  await server.prompt(sessionID, "제목을 붙일 첫 메시지")
  await server.waitIdle(sessionID)
  await waitUntil(async () => {
    const session = await server.call("GET", `/api/session/${sessionID}`)
    return isRecord(session) && isRecord(session.data) && session.data.title === TITLE
  }, "the session never got the title answer")
  const titles = codex().requests.filter(isTitleRequest).slice(before)
  expect(titles.map((request) => [request.identity, request.status])).toEqual([[identity(ONE), 200]])
  const alerts = await waitUntil(async () => {
    const lines = await ledgerAlerts(home, "internal_agent_model_removed")
    return lines.length > 0 ? lines : undefined
  }, "no internal_agent_model_removed alert in the ledger")
  expect(alerts.some((line) => line.message.includes("title") && line.message.includes(CONFIGURED_02))).toBe(true)
  expect(alerts.every((line) => line.severity === "warning")).toBe(true)
}

interface ToolPart {
  readonly name: string
  readonly state: {
    readonly status: string
    readonly input: unknown
    readonly error?: unknown
    readonly metadata?: Readonly<Record<string, unknown>>
  }
}

/** The session's one call of `name`, as the message API returns it. */
async function toolPart(server: OpencodeServer, sessionID: string, name: string): Promise<ToolPart> {
  const parts = (await server.messages(sessionID))
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter(
      (part): part is ToolPart => isRecord(part) && part.type === "tool" && part.name === name && isRecord(part.state),
    )
  expect(parts).toHaveLength(1)
  return required(parts[0])
}

function errorMessage(part: ToolPart) {
  const error = part.state.error
  return isRecord(error) && typeof error.message === "string" ? error.message : ""
}

/** The child a completed subagent call ran (`metadata.sessionID`), as `GET /api/session/:id` returns it. */
async function childOf(server: OpencodeServer, part: ToolPart) {
  const childID = part.state.metadata?.sessionID
  if (typeof childID !== "string") throw new Error(`subagent call without a child: ${JSON.stringify(part.state)}`)
  const session = await server.call("GET", `/api/session/${childID}`)
  if (!isRecord(session) || !isRecord(session.data)) throw new Error(`no session ${childID}`)
  return { id: childID, parentID: session.data.parentID, agent: session.data.agent, model: session.data.model }
}

function texts(messages: ReadonlyArray<Record<string, unknown>>) {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
}

function codex() {
  return required(fixture.codex)
}

function identity(account: { readonly accountID: string }) {
  return `codex:${account.accountID}`
}

/** Model requests (HTTP or WebSocket frames) whose input carries `marker`. */
function requestsWith(marker: string) {
  return codex().requests.filter((request) => request.model !== undefined && request.body.includes(marker))
}

/** Everything the fake saw from ChatGPT 02: by its identity, its account header or its access token. */
function requestsOfTwo() {
  const token = hashSecret(`Bearer ${required(fixture.tokens).two.accessToken}`)
  return codex().requests.filter(
    (request) =>
      request.identity === identity(TWO) ||
      request.headers["chatgpt-account-id"] === TWO.accountID ||
      request.headers.authorization === token,
  )
}

function isTitleRequest(request: RecordedRequest) {
  return request.model !== undefined && request.body.includes(TITLE_PROMPT)
}

function inputItems(request: RecordedRequest): readonly unknown[] {
  const json = request.json
  return isRecord(json) && Array.isArray(json.input) ? json.input : []
}

/** The text of every tool result in the request's input (`function_call_output`, a string or content parts). */
function functionOutputs(request: RecordedRequest) {
  return inputItems(request).flatMap((item) => {
    if (!isRecord(item) || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) return []
    const output = item.output
    if (typeof output === "string") return [output]
    if (!Array.isArray(output)) return [JSON.stringify(output)]
    return [
      output
        .map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : JSON.stringify(part)))
        .join("\n"),
    ]
  })
}

function failureOutputs(request: RecordedRequest) {
  return functionOutputs(request).filter((output) => output.includes("Unknown agent:"))
}

function lastUserText(input: readonly unknown[]) {
  const user = input.findLast((item) => isRecord(item) && item.role === "user")
  if (!isRecord(user)) return ""
  if (typeof user.content === "string") return user.content
  return (Array.isArray(user.content) ? user.content : [])
    .flatMap((part: unknown) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
}

/** One own.accounts RPC sent to the session Location (the instance whose presets module folded the agents). */
async function rpc(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${text}`)
  const body: unknown = JSON.parse(text)
  return isRecord(body) && isRecord(body.output) ? body.output : {}
}

/** A value of own-accounts' plugin storage (`plugin:<id>:<key>` in the server's `kv` table). */
function kv(server: OpencodeServer, key: string): unknown {
  const db = new Database(server.paths.database, { readonly: true })
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM kv WHERE key LIKE 'plugin:%'")
      .all()
    const row = rows.find((item) => item.key.endsWith(`:${key}`))
    return row === undefined ? undefined : JSON.parse(row.value)
  } finally {
    db.close()
  }
}

async function sourceIdentity(authPath: string) {
  const read = await CodexSource.read(authPath)
  if (!read.ok) throw new Error(`fixture source unreadable: ${read.problem}`)
  const identity = read.snapshot.summary.identity
  if (!identity.chatgptAccountId || !identity.fingerprint) throw new Error("fixture source without identity")
  return { chatgptAccountId: identity.chatgptAccountId, fingerprint: identity.fingerprint }
}

async function waitUntil<T>(probe: () => Promise<T | false | undefined>, message: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== false && value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`${message} within ${timeoutMs} ms`)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

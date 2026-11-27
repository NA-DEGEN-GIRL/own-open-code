// Auto-compaction thresholds on a real upstream server (02 §4.7, AC-P40): both own plugins load from their package
// directories, the only provider is an own `compat` slot created by `accounts.add.key` against the fake OpenAI-
// compatible chat server (window 200k → v2 default 180k, the template limit registered as it is).
//
// 1. The slot threshold: a session grows past 64k without compacting (default 180k). Lowering the account setting to
//    64k (`accounts.update{compaction}` after a `dryRun` that lists the session) re-registers the slot model, and the
//    next step makes core's own v2 auto-compaction run (`session.compaction.started{reason:"auto"}`) — earlier than
//    before, with no client involved.
// 2. The session value: on a fresh session, `compaction.setSession` below the current context makes own-accounts
//    admit the compaction itself through the plugin's `session.compact` under the `compaction.due` id, with no client
//    connected; core runs it, and a client that still sends the event's id gets 409.
// Global methods go to the control location, session methods to the workspace (02 §9.1, `OwnAccounts.MethodLocation`).
// Every credential is fake.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Compaction, OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  opencodeConfig,
  recordServerEvents,
  startFakeOpenAIChat,
  startOpencodeServer,
  type EventRecorder,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const SCENARIO_TIMEOUT = 400_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const RATECARDS = path.join(REPO_ROOT, "own/config/ratecards.default.json")
const MODEL = "fake-chat"
const WINDOW = 200_000
/** Every kind, compat included, defaults to v2; compat keeps floor(0.9 · 200k) (07 §6.2 #2, US-1). */
const DEFAULT_TRIGGER = 180_000
/**
 * Core keeps 15% of a window free since upstream v2.1 (170k of 200k), so the compat slot reaches its 90% by
 * registering the window whose core ceiling is 180k (02 §4.7.3 `ceilingOf`).
 */
const DEFAULT_INPUT = Compaction.windowFor(DEFAULT_TRIGGER)
const LOWERED = 64_000
/** Chat fake counts `ceil(chars / 4)` tokens: one filler prompt is about 15k tokens. */
const FILLER_CHARS = 60_000
/** A summary in core's template shape (at least one `## …` heading line, `compaction.ts:266-267`). */
const SUMMARY = ["## Objective", "- fill the context", "", "## Next Move", "1. (none)"].join("\n")
// Fake credential only.
const KEY = "sk-e2e-compaction-000000000000000000000001"

type Json = Record<string, unknown>

describe("auto-compaction thresholds on a real server (02 §4.7)", () => {
  const state: {
    chat?: FakeOpenAIChat
    server?: OpencodeServer
    events?: EventRecorder
    control?: string
    accountID?: string
    providerID?: string
  } = {}

  async function call(method: OwnAccounts.MethodName, input: unknown = {}) {
    const server = required(state.server)
    const directory =
      OwnAccounts.MethodLocation[method] === "session" ? server.paths.workspace : required(state.control)
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const text = await response.text()
    return { status: response.status, body: JSON.parse(text) as { readonly output?: Json; readonly type?: string } }
  }

  async function rpc(method: OwnAccounts.MethodName, input: unknown = {}) {
    const result = await call(method, input)
    if (result.status !== 200) throw new Error(`${method}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
    return result.body.output ?? {}
  }

  async function compactionOf(sessionID: string) {
    const snapshot = await rpc("cache.state", { sessionID })
    return snapshot.compaction as Json | null
  }

  /** The registered `limit.input` of the slot model (core compacts at `floor(0.9 × limit.input)`). */
  async function registeredInput() {
    const models = await required(state.server).models()
    const model = models.find((item) => item.providerID === state.providerID && item.id === MODEL)
    const limit = isRecord(model?.limit) ? model.limit : {}
    return typeof limit.input === "number" ? limit.input : undefined
  }

  /** Prompts filler turns until the measured context reaches `atLeast`; returns P. */
  async function grow(sessionID: string, atLeast: number) {
    const server = required(state.server)
    for (const round of Array.from({ length: 10 }, (_, index) => index)) {
      await server.prompt(sessionID, `round ${round}: ${"lorem ipsum dolor sit amet ".repeat(FILLER_CHARS / 27)}`)
      await server.waitIdle(sessionID)
      const P = (await compactionOf(sessionID))?.P
      if (typeof P === "number" && P >= atLeast) return P
    }
    throw new Error(`the context never reached ${atLeast}`)
  }

  const compactions = (sessionID: string, type: string) =>
    required(state.events).events.filter((event) => event.type === type && event.data.sessionID === sessionID)

  beforeAll(async () => {
    // Core checks that a summary fills its template (one "## …" heading line at least), so the fake answers the
    // summary request with one; everything else gets the default short text.
    const chat = startFakeOpenAIChat({
      models: [MODEL],
      responder: (request) =>
        request.body.includes("## Objective") ? { type: "text", text: SUMMARY, outputTokens: 400 } : undefined,
    })
    state.chat = chat
    const buildId = `e2e-compaction-${process.pid}`
    const server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: { home: paths.ownHome, buildId, vault: "memory", ratecardsSeed: RATECARDS },
            },
            { package: TELEMETRY, options: { home: paths.ownHome, buildId } },
          ],
        }),
    })
    state.server = server
    const control = path.join(server.paths.ownHome, "control")
    await fs.mkdir(control, { recursive: true })
    state.control = control
    state.events = await recordServerEvents(server)
    const added = await rpc("accounts.add.key", {
      kind: "compat",
      label: "Local",
      key: KEY,
      options: { baseURL: chat.baseURL, models: [{ id: MODEL, contextLimit: WINDOW }] },
    })
    const account = isRecord(added.account) ? added.account : {}
    state.accountID = String(account.id)
    state.providerID = String(account.providerID)
    await server.waitForModels([{ providerID: state.providerID, id: MODEL }])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.events?.close()
    await state.server?.stop()
    await state.chat?.stop()
  }, 60_000)

  test(
    "a lowered account threshold makes core's own auto-compaction run earlier",
    async () => {
      const server = required(state.server)
      const providerID = required(state.providerID)
      // At the v2 default a compat slot registers the input that puts core's ceiling on its 90%.
      expect(await registeredInput()).toBe(DEFAULT_INPUT)
      expect(DEFAULT_INPUT).toBe(211_764)
      const listed = await rpc("accounts.list")
      const account = (listed.accounts as ReadonlyArray<Json>).find((item) => item.id === state.accountID)
      expect(account?.compaction).toEqual({
        setting: null,
        effective: [{ modelID: MODEL, windowTokens: WINDOW, triggerTokens: DEFAULT_TRIGGER, source: "v2" }],
      })
      expect(account?.connection).toEqual({ type: "key", method: "api-key" })

      const session = await server.createSession({ model: { providerID, id: MODEL }, title: "threshold" })
      const P = await grow(session.id, LOWERED + 2_000)
      expect(P).toBeLessThan(DEFAULT_TRIGGER)
      // Above the lowered value, below the default: nothing compacted yet.
      expect(compactions(session.id, "session.compaction.started")).toEqual([])
      expect(await compactionOf(session.id)).toMatchObject({
        providerID,
        modelID: MODEL,
        windowTokens: WINDOW,
        triggerTokens: DEFAULT_TRIGGER,
        slotTriggerTokens: DEFAULT_TRIGGER,
        source: "v2",
        floorTokens: 63_000,
      })
      // The session index knows the binding: listed on the account and in the remove plan.
      const counted = await rpc("accounts.list")
      expect((counted.accounts as ReadonlyArray<Json>).find((item) => item.id === state.accountID)?.sessions).toEqual({
        running: 0,
        total: 1,
      })
      const plan = await rpc("accounts.remove.plan", { accountID: state.accountID, mode: "disable" })
      expect(plan.affectedSessions).toEqual([session.id])

      // Dry run first (02 §4.7.5): the session would compact at its next step.
      const setting = { maxTriggerTokens: LOWERED }
      const dry = await rpc("accounts.update", { accountID: state.accountID, compaction: setting, dryRun: true })
      expect(dry.compactionImpact).toEqual({
        sessions: [{ sessionID: session.id, P, triggerTokens: LOWERED, truncates: P - 15_000 > LOWERED }],
      })
      expect(await registeredInput()).toBe(DEFAULT_INPUT)

      const saved = await rpc("accounts.update", { accountID: state.accountID, compaction: setting })
      expect(saved.account).toMatchObject({
        compaction: {
          setting,
          effective: [{ modelID: MODEL, windowTokens: WINDOW, triggerTokens: LOWERED, source: "account" }],
        },
      })
      // Every Location reloads providers; the registered window follows.
      await until(async () => (await registeredInput()) === Compaction.windowFor(LOWERED), 30_000)

      const before = required(state.chat).requests.length
      await server.prompt(session.id, "continue with a short answer")
      await server.waitIdle(session.id)
      const started = await required(state.events).waitFor(
        (event) => event.type === "session.compaction.started" && event.data.sessionID === session.id,
      )
      expect(started.data.reason).toBe("auto")
      await required(state.events).waitFor(
        (event) => event.type === "session.compaction.ended" && event.data.sessionID === session.id,
      )
      // The summary request went to the same own slot (the fake saw it).
      expect(required(state.chat).requests.length).toBeGreaterThan(before + 1)
      const after = await compactionOf(session.id)
      expect(after).toMatchObject({ triggerTokens: LOWERED, slotTriggerTokens: LOWERED, source: "account" })
      expect(Number(after?.P)).toBeLessThan(LOWERED)

      // Back to the kind default for the next test.
      await rpc("accounts.update", { accountID: state.accountID, compaction: null })
      await until(async () => (await registeredInput()) === DEFAULT_INPUT, 30_000)
    },
    SCENARIO_TIMEOUT,
  )

  test(
    "a session value below the context compacts on the server with no client; compaction.due only reports it",
    async () => {
      const server = required(state.server)
      const providerID = required(state.providerID)
      const session = await server.createSession({ model: { providerID, id: MODEL }, title: "session value" })
      const P = await grow(session.id, LOWERED + 2_000)

      expect((await call("compaction.setSession", { sessionID: session.id, triggerTokens: 10 })).body).toMatchObject({
        type: "setting_out_of_range",
        data: { field: "triggerTokens", min: 63_000, max: DEFAULT_TRIGGER - 1 },
      })
      const set = await rpc("compaction.setSession", { sessionID: session.id, triggerTokens: LOWERED })
      expect(set.compaction).toMatchObject({
        triggerTokens: LOWERED,
        slotTriggerTokens: DEFAULT_TRIGGER,
        sessionTriggerTokens: LOWERED,
        source: "session",
        P,
      })
      const due = await required(state.events).waitFor(
        (event) => event.type === "rpc.own.accounts.compaction.due" && event.data.sessionID === session.id,
      )
      expect(due.data).toMatchObject({ P, triggerTokens: LOWERED, origin: "session" })
      const inputID = String(due.data.inputID)

      // Nobody sends POST /compact: own-accounts admitted it through the plugin's session.compact (924c12b291) under
      // the due's id, and core runs it like a client's.
      const started = await required(state.events).waitFor(
        (event) => event.type === "session.compaction.started" && event.data.sessionID === session.id,
      )
      expect(started.data).toMatchObject({ reason: "manual", inputID })
      await required(state.events).waitFor(
        (event) => event.type === "session.compaction.ended" && event.data.sessionID === session.id,
      )
      await until(async () => (await compactionOf(session.id))?.pendingDue === null, 10_000)
      // A client that still runs the event's id changes nothing: that item was delivered (409, 02 §4.7.1).
      const late = await server.request("POST", `/api/session/${session.id}/compact`, { body: { id: inputID } })
      expect(late.status).toBe(409)
      // One due per epoch: nothing else was sent for this session.
      expect(
        required(state.events)
          .own("compaction.due")
          .filter((event) => event.data.sessionID === session.id),
      ).toHaveLength(1)
      expect(compactions(session.id, "session.compaction.started")).toHaveLength(1)
    },
    SCENARIO_TIMEOUT,
  )
})

async function until(probe: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return
    await Bun.sleep(200)
  }
  throw new Error(`condition not met within ${ms}ms`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("compaction e2e fixture was not set up")
  return value
}

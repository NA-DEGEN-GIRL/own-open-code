// End to end on a real upstream server (02 §4.8): a session's speed on a Codex account and on an Anthropic API key.
// - Codex: the account's own list (Codex metadata `accounts`, as a fetch writes it) offers Fast and Ultrafast; the
//   composer's choice goes out as `service_tier` in the WebSocket `response.create`; a tier the backend refuses (its
//   `Unsupported service_tier` error frame before any output) is retried at once with Fast, the account untouched, the
//   reason in the toast's event and the alert; the backend's `auto`/`default` answers (it names no served tier, live
//   2026-10-18) never turn a tier off, and the ledger bills the tier sent.
// - Anthropic: Fast adds `speed: "fast"` and the beta header; turning it off keeps the header (the cache key) and drops
//   `speed`.
// own-accounts loads from its package directory (`startPresetRig`): one linked ChatGPT account on the fake Codex
// backend, an Anthropic key added through `accounts.add.key` against the fake Anthropic API. Every credential is fake;
// the servers bind 127.0.0.1; nothing reaches a real provider or spends anything.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Speed } from "@own/protocol"
import {
  codexMetaFixture,
  startFakeAnthropic,
  startFakeCodex,
  startPresetRig,
  waitUntil,
  type FakeAnthropic,
  type FakeCodex,
  type PresetRig,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const STEP_TIMEOUT = 120_000

const ONE = { accountID: "acct-speed-01", email: "speed@example.test", plan: "pro" }
const SLOT = "own-codex-pg01"
const MAIN = { providerID: SLOT, id: "gpt-6-astra" }
const SOL = { providerID: SLOT, id: "gpt-6-sol" }
const ANTH_KEY = "sk-ant-fake-speed-0001"
const OPUS = "claude-opus-5-5"

const fixture: {
  codex?: FakeCodex
  anthropic?: FakeAnthropic
  rig?: PresetRig
} = {}

beforeAll(async () => {
  // The backend's own tier answers (`auto`, then `default`): no `servedTier`.
  const codex = startFakeCodex()
  const anthropic = startFakeAnthropic()
  Object.assign(fixture, { codex, anthropic })
  fixture.rig = await startPresetRig({
    name: "speed",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ONE) }],
    endpoints: { anthropic: anthropic.baseURL },
    codexMeta: await codexMetaFixture(),
    codexAccounts: {
      acc_pg01: {
        source: "backend",
        fetchedAt: Date.parse("2026-10-06T00:00:00Z"),
        models: [
          {
            slug: "gpt-6-astra",
            max_context_window: 872_000,
            service_tiers: [
              { id: "priority", name: "Fast", description: "2x speed, increased usage" },
              { id: "ultrafast", name: "Ultrafast" },
            ],
          },
          {
            slug: "gpt-6-sol",
            max_context_window: 400_000,
            service_tiers: [
              { id: "priority", name: "Fast" },
              { id: "ultrafast", name: "Ultrafast" },
            ],
          },
        ],
      },
    },
    models: [MAIN, SOL],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.anthropic?.stop()])
}, 60_000)

describe("Speed on a Codex account (02 §4.8)", () => {
  test(
    "Ultrafast the backend refuses falls back to Fast at once, with the reason; the ledger bills the tier sent",
    async () => {
      const rig = required(fixture.rig)
      const codex = required(fixture.codex)
      const session = await rig.server.createSession({ model: MAIN })
      const fresh = await rig.call("session.speed.get", { sessionID: session.id })
      expect(fresh).toMatchObject({ choice: "standard", effective: "standard", tier: null })
      expect(offers(fresh)).toEqual([
        ["fast", "priority", "available"],
        ["ultrafast", "ultrafast", "available"],
      ])

      const dry = await rig.call("session.speed.set", { sessionID: session.id, speed: "ultrafast", dryRun: true })
      expect(dry).toMatchObject({ dryRun: true, change: { from: "standard", to: "ultrafast" } })
      await rig.call("session.speed.set", { sessionID: session.id, speed: "ultrafast" })

      // The backend's answer to a tier it does not take (live 2026-10-18, as the WebSocket error frame
      // `{"type":"error","status":400,"error":{…}}`): before any output, so the second attempt goes at Fast.
      const before = codex.requests.length
      codex.enqueue({
        type: "error",
        status: 400,
        body: { error: { type: "invalid_request_error", message: "Unsupported service_tier: ultrafast" } },
      })
      await rig.server.prompt(session.id, "빠르게 답해 주세요")
      await rig.server.waitIdle(session.id)
      expect(tiers(codex, before)).toEqual(["ultrafast", "priority"])
      const fell = await rig.call("session.speed.get", { sessionID: session.id })
      expect(fell).toMatchObject({ choice: "ultrafast", effective: "fast", tier: "priority" })
      expect(offers(fell)).toEqual([
        ["fast", "priority", "available"],
        ["ultrafast", "ultrafast", "unavailable"],
      ])
      expect(Array.isArray(fell.offers) ? fell.offers : []).toContainEqual(
        expect.objectContaining({ choice: "ultrafast", reason: "unsupported_tier" }),
      )
      const fallback = rig.events
        .own("session.speed.changed")
        .find((event) => event.data.sessionID === session.id && event.data.reason === "fallback")
      expect(fallback?.data).toMatchObject({ effective: "fast", cause: "unsupported_tier" })
      const alerts = await rig.alerts("speed_fallback")
      expect(alerts.map((alert) => (isRecord(alert.data.fields) ? alert.data.fields.detail : undefined))).toContain(
        "Unsupported service_tier: ultrafast",
      )
      // Never another account (R2/R4): the session's binding is the account it had.
      const binding = await rig.call("session.binding", { sessionIDs: [session.id] })
      expect(binding).toMatchObject({ bindings: [{ model: { providerID: SLOT, id: MAIN.id } }] })

      // The Codex backend names no served tier (`auto`, then `default`): the line bills the tier sent.
      await waitUntil(async () => (await speedLines(rig, session.id)).length >= 1, "no ledger line had a speed")
      expect((await speedLines(rig, session.id)).at(-1)).toEqual({ requested: "priority", served: null })

      // A new conversation starts at Standard and sends no tier.
      const other = await rig.server.createSession({ model: MAIN })
      const plain = codex.requests.length
      await rig.server.prompt(other.id, "표준으로")
      await rig.server.waitIdle(other.id)
      expect(tiers(codex, plain)).toEqual([undefined])
    },
    STEP_TIMEOUT,
  )

  test(
    "Ultrafast stays on although every answer says `default` (the backend reports no served tier)",
    async () => {
      // The user's 2026-10-18 report: Ultrafast went to Fast, then Fast to Standard, on an account that has both. The
      // backend served them (about 8 and 1.6 times Standard's output speed) while naming `default` every time.
      const rig = required(fixture.rig)
      const codex = required(fixture.codex)
      const session = await rig.server.createSession({ model: SOL })
      await rig.call("session.speed.set", { sessionID: session.id, speed: "ultrafast" })
      const mark = codex.requests.length
      for (const [index, text] of ["하나", "둘", "셋", "넷"].entries()) {
        await rig.server.prompt(session.id, text)
        await rig.server.waitIdle(session.id)
        await waitUntil(async () => (await speedLines(rig, session.id)).length > index, "a step had no ledger speed")
      }
      expect(tiers(codex, mark)).toEqual(["ultrafast", "ultrafast", "ultrafast", "ultrafast"])
      const reasons = rig.events
        .own("session.speed.changed")
        .filter((event) => event.data.sessionID === session.id)
        .map((event) => event.data.reason)
      expect(reasons).toEqual(["user"])
      const view = await rig.call("session.speed.get", { sessionID: session.id })
      expect(view).toMatchObject({ choice: "ultrafast", effective: "ultrafast", tier: "ultrafast" })
      expect(view.served).toBeUndefined()
      expect(offers(view)).toEqual([
        ["fast", "priority", "available"],
        ["ultrafast", "ultrafast", "available"],
      ])
      expect(await speedLines(rig, session.id)).toEqual(
        Array.from({ length: 4 }, () => ({ requested: "ultrafast", served: null })),
      )
      const ignored = (await rig.alerts("speed_fallback")).filter(
        (alert) => isRecord(alert.data.fields) && alert.data.fields.reason === "ignored",
      )
      expect(ignored).toEqual([])
      expect(await rig.alerts("speed_downgraded")).toEqual([])
    },
    STEP_TIMEOUT,
  )
})

describe("Speed on an Anthropic API key (02 §4.8)", () => {
  test(
    "Fast sends speed and the beta; off again keeps the beta and drops speed",
    async () => {
      const rig = required(fixture.rig)
      const anthropic = required(fixture.anthropic)
      const added = await rig.call("accounts.add.key", { kind: "anth", label: "Anthropic", key: ANTH_KEY })
      const providerID = isRecord(added.account) ? String(added.account.providerID) : ""
      await rig.server.waitForModels([{ providerID, id: OPUS }])
      const session = await rig.server.createSession({ model: { providerID, id: OPUS } })
      const view = await rig.call("session.speed.get", { sessionID: session.id })
      expect(offers(view)).toEqual([["fast", "fast", "available"]])

      await rig.call("session.speed.set", { sessionID: session.id, speed: "fast" })
      const first = anthropic.requests.length
      await rig.server.prompt(session.id, "fast please")
      await rig.server.waitIdle(session.id)
      const fast = messages(anthropic, first)
      expect(fast.map((request) => request.speed)).toEqual(["fast"])
      expect(fast[0]?.beta).toContain(Speed.ANTHROPIC_BETA)

      await rig.call("session.speed.set", { sessionID: session.id, speed: "standard" })
      const second = anthropic.requests.length
      await rig.server.prompt(session.id, "standard again")
      await rig.server.waitIdle(session.id)
      const standard = messages(anthropic, second)
      expect(standard.map((request) => request.speed)).toEqual([undefined])
      expect(standard[0]?.beta).toContain(Speed.ANTHROPIC_BETA)
      await waitUntil(async () => (await speedLines(rig, session.id)).length >= 1, "no ledger line had a speed")
      expect((await speedLines(rig, session.id))[0]).toEqual({ requested: "fast", served: "fast" })
    },
    STEP_TIMEOUT,
  )
})

/** The offers of a `session.speed.get` answer as `[choice, tier, status]`. */
function offers(view: Record<string, unknown>) {
  return (Array.isArray(view.offers) ? view.offers : []).map((offer: unknown) =>
    isRecord(offer) ? [offer.choice, offer.tier, offer.status] : [],
  )
}

/** The `service_tier` of every Codex `response.create` frame after `from`. */
function tiers(codex: FakeCodex, from: number) {
  return codex.requests
    .slice(from)
    .filter((request) => isRecord(request.json) && request.json.type === "response.create")
    .map((request) => (isRecord(request.json) ? request.json.service_tier : undefined))
}

/** The Anthropic messages requests after `from`: their `speed` and beta header. */
function messages(anthropic: FakeAnthropic, from: number) {
  return anthropic.requests
    .slice(from)
    .filter((request) => request.path.startsWith("/v1/messages") && isRecord(request.json))
    .map((request) => ({
      speed: isRecord(request.json) ? request.json.speed : undefined,
      beta: request.headers["anthropic-beta"] ?? "",
    }))
}

/** The session's ledger lines' `speed`, oldest first. */
async function speedLines(rig: PresetRig, sessionID: string) {
  const ledger = await rig.call("ledger.session", { sessionID })
  return (Array.isArray(ledger.steps) ? ledger.steps : []).flatMap((line: unknown) =>
    isRecord(line) && isRecord(line.speed) ? [line.speed] : [],
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

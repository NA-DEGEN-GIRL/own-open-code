// Phase 2 integration on a real upstream server: both own plugins load from their package directories and the
// opencode config has no providers, so every provider the session uses is created by own.accounts from RPCs:
//
// - two `oai` API key accounts (`accounts.add.key`, probed against the fake OpenAI Responses server),
// - one `codex` account from a device-code login against the fake ChatGPT issuer (`accounts.add.chatgpt.*`),
// - one `codex` account imported linked from a fake codex-multi-provider profile (`accounts.import.codex.*`).
//
// One session then moves Alpha → Bravo → Alpha (same kind, within the TTL) → Device (oai → codex) → Linked (codex →
// codex) through `switch.estimate`/`switch.apply` only. The test checks per-request auth on the fakes, the cache hit
// on the return to Alpha, `quota.snapshot`, `ledger.session`, the `flap` alert on the event stream, and that no secret
// reaches logs, RPC outputs, events or OWN_HOME. Global methods go to the control location and session methods to the
// session's Location (02 §9.1), so two own.accounts instances (leader = control) share one runtime.
// Every credential is fake; the real old-app profiles are never read.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  hashSecret,
  opencodeConfig,
  recordServerEvents,
  removeTree,
  startFakeChatGPTAuth,
  startFakeCodex,
  startFakeOpenAIResponses,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type ChatGPTTokens,
  type EventRecorder,
  type FakeChatGPTAuth,
  type FakeCodex,
  type FakeOpenAIResponses,
  type LegacyProfile,
  type ModelRef,
  type OpencodeServer,
  type RecordedRequest,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const SCENARIO_TIMEOUT = 300_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const RATECARDS = path.join(REPO_ROOT, "own/config/ratecards.default.json")
const BLOCK = 16
// Codex rejects gpt-5.5 and older for ChatGPT accounts since upstream v2.1 (cdf1c200a6): a model both kinds offer.
const MODEL = "gpt-5.6-sol"

// Fake credentials only.
const KEY_A = "sk-proj-e2eIntegrationAlpha000000000000000001"
const KEY_B = "sk-proj-e2eIntegrationBravo000000000000000002"
const DEVICE = { accountID: "acct-e2e-device", userID: "user-e2e-device", email: "device@example.test", plan: "pro" }
const LINKED = { accountID: "acct-e2e-linked", userID: "user-e2e-linked", email: "linked@example.test", plan: "plus" }

// Long enough that the switched part dominates block alignment.
const ANSWER = (tag: string) => `${tag} ${"integration answer text ".repeat(60)}`

type Json = Record<string, unknown>

interface Account {
  readonly id: string
  readonly providerID: string
}

interface Estimate {
  readonly estimateID: string
  readonly context: { readonly P: number }
  readonly inputs: { readonly W_lo: number; readonly W_hi: number }
}

interface LedgerLine {
  readonly kind: string
  readonly accountID: string | null
  readonly providerID: string
  readonly modelID: string
  readonly tokens: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number } | null
  readonly P: number | null
  readonly coldExpected: number | null
  readonly usageSource?: string
}

describe("own.accounts + own.telemetry integrated on a real server", () => {
  const state: {
    responses?: FakeOpenAIResponses
    codex?: FakeCodex
    auth?: FakeChatGPTAuth
    server?: OpencodeServer
    events?: EventRecorder
    root?: string
    profile?: LegacyProfile
    linkedTokens?: ChatGPTTokens
    control?: string
    accounts: Partial<Record<"alpha" | "bravo" | "device" | "linked", Account>>
    outputs: string[]
    sessionID?: string
  } = { accounts: {}, outputs: [] }

  /** One RPC; global methods go to the control location, session methods to the workspace (02 §9.1). */
  async function call(method: string, input: unknown = {}) {
    const server = required(state.server)
    const directory = SESSION_METHODS.has(method) ? server.paths.workspace : required(state.control)
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const text = await response.text()
    state.outputs.push(text)
    return {
      status: response.status,
      text,
      body: JSON.parse(text) as { readonly output?: Json; readonly type?: string },
    }
  }

  async function rpc(method: string, input: unknown = {}) {
    const result = await call(method, input)
    if (result.status !== 200) throw new Error(`${method}: HTTP ${result.status} ${result.text}`)
    return result.body.output ?? {}
  }

  beforeAll(async () => {
    const small = { minTokens: 0, blockTokens: BLOCK }
    const responses = startFakeOpenAIResponses({ cache: small, models: [MODEL] })
    const codex = startFakeCodex({ cache: small })
    const auth = startFakeChatGPTAuth({ codex })
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-integration-")))
    const linkedTokens = codex.login(LINKED)
    const [profile] = await writeCodexMultiProviderProfiles(path.join(root, "control-center"), [
      { id: "07", alias: "linked", tokens: linkedTokens },
    ])
    Object.assign(state, { responses, codex, auth, root, profile, linkedTokens })
    const buildId = `e2e-integration-${process.pid}`
    const server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          // No providers: every provider below comes from own.accounts.
          providers: {},
          // A default model off the own slots: the catalog newest (gpt-6.1-terra since October) would otherwise be the
          // default, and health warns about an own slot as the default model (default_model_own_slot).
          model: "opencode/big-pickle",
          plugins: [
            {
              package: ACCOUNTS,
              options: {
                home: paths.ownHome,
                buildId,
                vault: "memory",
                ratecardsSeed: RATECARDS,
                endpoints: { openai: responses.baseURL, codex: codex.baseURL, oauthIssuer: auth.url },
                codexImportRoot: path.join(root, "control-center"),
              },
            },
            { package: TELEMETRY, options: { home: paths.ownHome, buildId } },
          ],
        }),
    })
    state.server = server
    // The launcher creates the empty control directory (02 §9.1); `health` names it.
    const control = path.join(server.paths.ownHome, "control")
    await fs.mkdir(control, { recursive: true })
    state.control = control
    state.events = await recordServerEvents(server)
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.events?.close()
    await state.server?.stop()
    await Promise.all([state.responses?.stop(), state.codex?.stop(), state.auth?.stop()])
    if (state.root) await removeTree(state.root)
  }, 60_000)

  test(
    "accounts come only from own.accounts RPCs: two API keys, a device login and a linked import",
    async () => {
      const server = required(state.server)
      const responses = required(state.responses)
      const auth = required(state.auth)

      // An RPC waits for plugin activation. The first one creates the control Location, whose allowlist is not
      // checked yet (fail closed, reported as a warning); it never reports a telemetry build mismatch.
      const health = await rpc("health")
      expect(health).toMatchObject({ guard: "ok", vault: "ok", controlDir: state.control })
      expect(JSON.stringify(health.warnings)).not.toContain("telemetry_build_mismatch")
      const before = await providers(server)
      expect(before.filter((provider) => String(provider.id).startsWith("own-"))).toEqual([])

      // API keys: each is probed with its own key before anything is stored.
      const alpha = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: KEY_A })
      const bravo = await rpc("accounts.add.key", { kind: "oai", label: "Bravo", key: KEY_B })
      expect(alpha).toMatchObject({ test: { ok: true }, account: { status: "ready" } })
      expect(bravo).toMatchObject({ test: { ok: true }, account: { status: "ready" } })
      const probes = responses.requests.filter((request) => request.path.startsWith("/v1/models"))
      expect(probes.map((request) => request.headers.authorization)).toEqual([
        hashSecret(`Bearer ${KEY_A}`),
        hashSecret(`Bearer ${KEY_B}`),
      ])
      const alphaAccount = accountOf(alpha)
      state.accounts.alpha = alphaAccount
      state.accounts.bravo = accountOf(bravo)

      // ChatGPT device-code login against the fake issuer.
      const started = await rpc("accounts.add.chatgpt.start", { method: "device" })
      expect(started).toMatchObject({ method: "device", verificationURL: `${auth.url}/codex/device` })
      auth.approve(String(started.userCode), DEVICE)
      const authorized = await until(async () => {
        const status = await rpc("accounts.add.chatgpt.status", { attemptID: started.attemptID })
        return status.phase === "authorized" ? status : undefined
      }, 30_000)
      expect(authorized).toMatchObject({ identity: { plan: "pro" } })
      const completed = await rpc("accounts.add.chatgpt.complete", { attemptID: started.attemptID, label: "Device" })
      expect(completed).toMatchObject({ reauthenticated: false, account: { kind: "codex", status: "ready" } })
      const deviceAccount = accountOf(completed)
      state.accounts.device = deviceAccount
      expect(auth.exchangeCount()).toBe(1)

      // Linked import of the fake old-app profile.
      const listed = await rpc("accounts.import.codex.list")
      expect(listed).toMatchObject({ available: true, sources: [{ profileID: "07", importable: true }] })
      const planned = await rpc("accounts.import.codex.plan", { profileID: "07" })
      const imported = await rpc("accounts.import.codex.execute", { nonce: planned.nonce })
      expect(imported.mode).toBe("linked")
      const linkedAccount = accountOf(imported)
      state.accounts.linked = linkedAccount

      const list = await rpc("accounts.list")
      const byID = new Map((list.accounts as ReadonlyArray<Json>).map((account) => [account.id, account]))
      expect(byID.get(alphaAccount.id)).toMatchObject({
        kind: "oai",
        billing: "metered",
        connection: { type: "key", method: "api-key" },
      })
      // The registry records the login method (`Account.Info.method`), so the UI can label the account (02 §9.2).
      expect(byID.get(deviceAccount.id)).toMatchObject({
        kind: "codex",
        billing: "subscription",
        connection: { type: "oauth", method: "chatgpt-device" },
        identity: { emailMasked: "de***@example.test", plan: "pro" },
      })
      expect(byID.get(linkedAccount.id)).toMatchObject({
        kind: "codex",
        connection: {
          method: "codex-linked",
          source: { app: "codex-multi-provider", profileID: "07", mode: "linked" },
        },
      })
      expect(byID.size).toBe(4)

      const refs = Object.values(state.accounts).map((account) => ref(required(account)))
      await server.waitForModels(refs)
      // Both plugins are active in both Locations, from their source directories, and share one runtime.
      for (const directory of [server.paths.workspace, required(state.control)]) {
        const plugins = (await server.call("GET", "/api/plugin", { query: { "location[directory]": directory } })) as {
          readonly data: ReadonlyArray<{ readonly id?: string; readonly state: { readonly status: string } }>
        }
        expect(Object.fromEntries(plugins.data.map((plugin) => [plugin.id, plugin.state.status]))).toMatchObject({
          "own.accounts": "active",
          "own.telemetry": "active",
        })
      }
      const settled = await until(async () => {
        const current = await rpc("health")
        return (current.warnings as ReadonlyArray<string>).length === 0 ? current : undefined
      })
      expect(settled.locations).toEqual([
        { directory: required(state.control), allowlist: "ok" },
        { directory: server.paths.workspace, allowlist: "ok" },
      ])
      const after = new Map((await providers(server)).map((provider) => [String(provider.id), provider]))
      const own = [...after.keys()].filter((id) => id.startsWith("own-")).toSorted()
      expect(own).toEqual(refs.map((item) => item.providerID).toSorted())
      for (const id of own) {
        expect(after.get(id)).toMatchObject({ activation: "enabled", settings: { compaction: { type: "summary" } } })
        expect(after.get(id)).not.toHaveProperty("integrationID")
        expect(JSON.stringify(after.get(id))).not.toContain("apiKey")
      }
      // hideBuiltinProviders "auto": the built-in openai is hidden once oai/codex accounts exist.
      expect(after.has("openai")).toBe(false)
    },
    SCENARIO_TIMEOUT,
  )

  test(
    "one session switches account and provider through own.accounts; each request carries its account's credential",
    async () => {
      const server = required(state.server)
      const responses = required(state.responses)
      const codex = required(state.codex)
      const events = required(state.events)
      const accounts = state.accounts
      const [alpha, bravo, device, linked] = [accounts.alpha, accounts.bravo, accounts.device, accounts.linked].map(
        (account) => ref(required(account)),
      )
      responses.reset()
      const session = await server.createSession({ model: alpha, title: "integration e2e" })
      const turn = async (text: string, answer: string, fake: FakeOpenAIResponses | FakeCodex) => {
        fake.enqueue({ type: "text", text: answer })
        await server.prompt(session.id, text)
        await server.waitIdle(session.id)
      }
      const switchTo = async (target: ModelRef) => {
        const estimate = (await rpc("switch.estimate", { sessionID: session.id, target })) as unknown as Estimate
        const applied = await rpc("switch.apply", {
          sessionID: session.id,
          estimateID: estimate.estimateID,
          target,
          strategy: "now",
          reason: "manual",
        })
        expect(["SWITCHING", "COOLDOWN"]).toContain(String(applied.state))
        return estimate
      }

      await turn("first question", ANSWER("A1"), responses)
      await switchTo(bravo)
      await turn(`second question ${"please consider this detail ".repeat(30)}`, ANSWER("B1"), responses)
      const back = await switchTo(alpha)
      await turn("third, back on alpha", ANSWER("A2"), responses)
      await switchTo(device)
      await turn("fourth, now on the device codex account", ANSWER("C1"), codex)
      await switchTo(linked)
      await turn("fifth, on the linked codex account", ANSWER("D1"), codex)

      // oai: Alpha, Bravo, Alpha, each with its own key; the return to Alpha hits Alpha's cached prefix.
      const calls = await responses.waitForRequests(3, { filter: isResponsesCall })
      expect(calls.map((call) => call.status)).toEqual([200, 200, 200])
      expect(calls.map((call) => call.headers.authorization)).toEqual([
        hashSecret(`Bearer ${KEY_A}`),
        hashSecret(`Bearer ${KEY_B}`),
        hashSecret(`Bearer ${KEY_A}`),
      ])
      expect(calls[1]?.identity).not.toBe(calls[0]?.identity)
      expect(calls[2]?.identity).toBe(calls[0]?.identity)
      const previousAlpha = calls[0]?.cache?.promptTokens ?? 0
      expect(calls[1]?.cache?.cachedTokens).toBe(0)
      expect(calls[2]?.cache?.cachedTokens ?? 0).toBeGreaterThanOrEqual(previousAlpha - BLOCK)
      // The estimator knew Alpha was still warm: its reusable prefix is exactly Alpha's last input.
      expect(back.inputs.W_lo).toBe(previousAlpha)
      for (const call of calls) expect(instructions(call)).toContain("- Provider ID: openai")

      // codex: the device account, then the linked one, each with its own ChatGPT account and token.
      const frames = await codex.waitForRequests(2, { filter: (request) => request.method === "WS" })
      expect(frames.map((frame) => [frame.status, frame.identity, frame.model])).toEqual([
        [200, `codex:${DEVICE.accountID}`, MODEL],
        [200, `codex:${LINKED.accountID}`, MODEL],
      ])
      const handshakes = codex.requests.filter(
        (request) => request.transport === "websocket" && request.method === "GET",
      )
      expect(handshakes.map((request) => request.headers["chatgpt-account-id"])).toEqual([
        DEVICE.accountID,
        LINKED.accountID,
      ])
      for (const handshake of handshakes) {
        expect(handshake).toMatchObject({ status: 101 })
        expect(handshake.headers["session-id"]).toBe(session.id)
        expect(handshake.headers.originator).toBe("opencode")
      }
      expect(handshakes[1]?.headers.authorization).toBe(
        hashSecret(`Bearer ${required(state.linkedTokens).accessToken}`),
      )
      expect(handshakes[0]?.headers.authorization).toBe(
        hashSecret(`Bearer ${required(required(state.auth).issued[0]).accessToken}`),
      )
      // Nobody refreshed: the device tokens are fresh and a linked source is never refreshed by us.
      expect(codex.requests.filter((request) => request.path.includes("/oauth/token"))).toEqual([])
      expect(required(state.auth).requests.filter((request) => request.path === "/oauth/token")).toHaveLength(1)

      const models = (await server.messages(session.id))
        .filter((message) => message.type === "assistant")
        .toReversed()
        .map((message) => (isRecord(message.model) ? message.model.providerID : undefined))
      expect(models).toEqual([alpha, bravo, alpha, device, linked].map((item) => item.providerID))

      const binding = await rpc("session.binding", { sessionIDs: [session.id] })
      expect(binding.bindings).toEqual([
        expect.objectContaining({ accountID: required(accounts.linked).id, builtin: false, thirdParty: false }),
      ])
      expect((await rpc("switch.state", { sessionID: session.id })).state).toBe("COOLDOWN")

      // Alpha → Bravo → Alpha within ten minutes is a flap (02 §7.7), announced by the session's Location.
      const flap = await events.waitFor(
        (event) =>
          event.type === `rpc.own.accounts.alert` && event.data.code === "flap" && event.data.sessionID === session.id,
      )
      expect(flap.data).toMatchObject({ severity: "warning", origin: "session" })
      expect(flap.location?.directory?.toLowerCase()).toBe(server.paths.workspace.toLowerCase())
      // Four applied switches, each recorded once with the estimate and then with the measured cold part.
      const recorded = events.own("switch.recorded").filter((event) => event.data.sessionID === session.id)
      expect(recorded.filter((event) => event.data.actual === undefined)).toHaveLength(4)
      await until(async () => {
        const actual = events
          .own("switch.recorded")
          .filter((event) => event.data.sessionID === session.id && event.data.actual !== undefined)
        return actual.length === 4 ? actual : undefined
      })

      state.sessionID = session.id
    },
    SCENARIO_TIMEOUT,
  )

  test(
    "telemetry: quota.snapshot has each account's windows, the ledger one line per step with cache fields",
    async () => {
      const codex = required(state.codex)
      const sessionID = required(state.sessionID)
      const accounts = state.accounts

      // codex: WebSocket `codex.rate_limits` frames carry the fake's values for each ChatGPT account.
      for (const [account, chatgpt] of [
        [required(accounts.device), DEVICE],
        [required(accounts.linked), LINKED],
      ] as const) {
        const usage = codex.usage(chatgpt.accountID)
        const primary = await until(async () => {
          const snapshot = await rpc("quota.snapshot", { accountIDs: [account.id] })
          const window = (snapshot.windows as ReadonlyArray<Json>).find((item) => item.id === "codex.primary")
          return window?.usedPercent === usage.primary ? window : undefined
        })
        expect(primary).toMatchObject({ accountID: account.id, providerID: account.providerID, windowMinutes: 300 })
      }
      // oai: `x-ratelimit-*` headers of each key's responses.
      for (const account of [required(accounts.alpha), required(accounts.bravo)]) {
        const snapshot = await rpc("quota.snapshot", { accountIDs: [account.id] })
        const ids = (snapshot.windows as ReadonlyArray<Json>).map((window) => [window.id, window.accountID])
        expect(ids).toEqual(
          expect.arrayContaining([
            ["oai.requests", account.id],
            ["oai.tokens", account.id],
          ]),
        )
      }

      // Ledger: one primary line per step, attributed to the account that served it.
      const ledger = await until(async () => {
        const result = await rpc("ledger.session", { sessionID })
        return (result.steps as ReadonlyArray<LedgerLine>).length >= 5 ? result : undefined
      })
      const steps = ledger.steps as ReadonlyArray<LedgerLine>
      expect(steps.map((line) => [line.kind, line.accountID, line.modelID])).toEqual(
        [accounts.alpha, accounts.bravo, accounts.alpha, accounts.device, accounts.linked].map((account) => [
          "primary",
          required(account).id,
          MODEL,
        ]),
      )
      expect(steps.every((line) => line.usageSource === "event" && line.tokens !== null && line.P !== null)).toBe(true)
      // The return to Alpha shows the hit; the first step on a new account is cold and carries the estimate.
      expect(steps[2]?.tokens?.cacheRead).toBeGreaterThan(0)
      expect(steps[1]?.tokens?.cacheRead).toBe(0)
      expect(steps[0]?.coldExpected).toBeNull()
      for (const line of steps.slice(1)) expect(line.coldExpected).toBeGreaterThan(0)
      expect(ledger.switchCount).toBe(4)

      const totals = (ledger.totals as { readonly byAccount: Record<string, { readonly requests: number }> }).byAccount
      expect(totals[required(accounts.alpha).id]?.requests).toBe(2)
      expect(totals[required(accounts.linked).id]?.requests).toBe(1)
      // The session usage row (a global method, answered in the control location) knows the session's project.
      const usage = await rpc("accounts.usage", { from: 0, to: Date.now() + 60_000, groupBy: "session" })
      expect((usage.rows as ReadonlyArray<Json>).find((row) => row.key === sessionID)).toMatchObject({
        requests: 5,
        switchCount: 4,
        projectID: expect.any(String),
      })

      // accounts.list knows when each account was last used.
      const list = await rpc("accounts.list")
      for (const account of list.accounts as ReadonlyArray<Json>) expect(account.lastUsedAt).toEqual(expect.any(Number))

      const cache = await rpc("cache.state", { sessionID })
      const slots = new Map((cache.slots as ReadonlyArray<Json>).map((slot) => [slot.providerID, slot.state]))
      expect(slots.get(required(accounts.linked).providerID)).toBe("warm")
      expect(slots.size).toBe(4)
    },
    SCENARIO_TIMEOUT,
  )

  test("events: global ones once, from the leader (control location); session ones from the session's Location", async () => {
    const server = required(state.server)
    const events = required(state.events)
    const own = events.events.filter((event) => event.type.startsWith("rpc.own.accounts."))
    const where = (directory: string | undefined) => directory?.toLowerCase()
    const global = new Set([
      "accounts.changed",
      "quota.updated",
      "account.status",
      "plugin.status",
      "plugin.trust.changed",
      "presets.changed",
    ])
    for (const event of own) {
      const name = event.type.slice("rpc.own.accounts.".length)
      // `alert` is either (src/emitter.ts): a session alert, or a global one the leader raises, such as
      // `codex_window_unverified` for a catalog model outside the Codex stand-in list (gpt-6.1-sol from v2.0.24's catalog).
      const expected = global.has(name) || (name === "alert" && event.data.origin === "global") ? "global" : "session"
      expect({ name, origin: event.data.origin }).toEqual({ name, origin: expected })
      expect({ name, directory: where(event.location?.directory) }).toEqual({
        name,
        directory: where(expected === "global" ? state.control : server.paths.workspace),
      })
      expect(event.data.eventId).toEqual(expect.any(String))
    }
    // Two instances share the runtime, yet every registry change is announced exactly once.
    expect(events.own("accounts.changed").map((event) => event.data.revision)).toEqual([1, 2, 3, 4])
    expect(new Set(own.map((event) => event.data.eventId)).size).toBe(own.length)
    // One ledger.step and one cache.state per step.
    const sessionID = required(state.sessionID)
    expect(
      events.own("ledger.step").filter((event) => isRecord(event.data.line) && event.data.line.sessionID === sessionID),
    ).toHaveLength(5)
  })

  test(
    "removing an account retires its slot: no models, no switch target, no credential, one registry change",
    async () => {
      const server = required(state.server)
      const events = required(state.events)
      const bravo = required(state.accounts.bravo)
      const sessionID = required(state.sessionID)

      const planned = await rpc("accounts.remove.plan", { accountID: bravo.id, mode: "delete" })
      // (Bun's `toMatchObject` with `expect.any` writes the matcher into the received object, so read it first.)
      const nonce = String(planned.nonce)
      expect(planned).toMatchObject({ willShredVault: true, affectedSessions: [] })
      // The plan has no side effect.
      expect((await rpc("accounts.list")).revision).toBe(4)
      const removed = await rpc("accounts.remove.execute", { nonce })
      expect(removed).toMatchObject({ account: { id: bravo.id, status: "retired" } })
      const replay = await call("accounts.remove.execute", { nonce })
      expect([replay.status, replay.body.type]).toEqual([400, "nonce_invalid"])
      await events.waitFor((event) => event.type === "rpc.own.accounts.accounts.changed" && event.data.revision === 5)

      // The retired slot stays registered (old sessions still render) but offers no model.
      await until(async () => {
        const models = await server.models()
        return models.some((model) => model.providerID === bravo.providerID && model.enabled !== false)
          ? undefined
          : true
      })
      const estimate = await call("switch.estimate", { sessionID, target: ref(bravo) })
      expect(estimate.status).toBe(400)
      expect(estimate.body).toMatchObject({ type: "no_eligible_target", data: { reasons: ["retired"] } })
      expect((await call("accounts.test", { accountID: bravo.id })).body.type).toBe("account_not_found")
    },
    SCENARIO_TIMEOUT,
  )

  test(
    "a hard quota on a subscription is recorded and suggested, never switched automatically",
    async () => {
      const server = required(state.server)
      const codex = required(state.codex)
      const events = required(state.events)
      const device = required(state.accounts.device)
      // 02 §7.1.1: the account holds a reset credit; nothing but the user's confirmation may redeem it.
      codex.setResetCredits(DEVICE.accountID, [{ id: "credit-e2e", granted_at: "2026-10-01T00:00:00Z" }], 0)
      codex.setUsage(DEVICE.accountID, { primary: 100 })
      const session = await server.createSession({ model: ref(device), title: "exhaustion e2e" })
      await server.prompt(session.id, "this one hits the usage limit")
      await server.waitIdle(session.id)

      const status = await events.waitFor(
        (event) =>
          event.type === "rpc.own.accounts.account.status" &&
          event.data.accountID === device.id &&
          event.data.status === "exhausted",
      )
      expect(status.data.until).toEqual(expect.any(Number))
      const suggested = await events.waitFor(
        (event) => event.type === "rpc.own.accounts.switch.suggested" && event.data.sessionID === session.id,
      )
      expect(suggested.data.reason).toBe("hard")
      // Subscriptions never rotate by themselves (02 §5.10): the session stays on the exhausted account.
      const binding = await rpc("session.binding", { sessionIDs: [session.id] })
      expect(binding.bindings).toEqual([
        expect.objectContaining({
          accountID: device.id,
          model: expect.objectContaining({ providerID: device.providerID }),
        }),
      ])
      // The limit shows as exhausted, and the account is no switch target until it resets.
      const snapshot = await rpc("quota.snapshot", { accountIDs: [device.id] })
      expect((snapshot.windows as ReadonlyArray<Json>).find((window) => window.id === "codex.primary")).toMatchObject({
        usedPercent: 100,
        status: "exhausted",
      })
      const other = await server.createSession({ model: ref(required(state.accounts.linked)), title: "other" })
      const estimate = await call("switch.estimate", { sessionID: other.id, target: ref(device) })
      expect([estimate.status, estimate.text]).toEqual([400, expect.stringContaining("exhausted")])
      // The exhaustion read the account's reset credit count once (its count was unknown), and redeemed nothing.
      const counted = await until(async () => {
        const credits = (await rpc("quota.snapshot", { accountIDs: [device.id] })).resetCredits
        return Array.isArray(credits) && credits.length > 0 ? credits : undefined
      })
      expect(counted).toEqual([expect.objectContaining({ accountID: device.id, availableCount: 1 })])
      expect(codex.consumes).toEqual([])
      expect(codex.resetCreditReads).toEqual([])
    },
    SCENARIO_TIMEOUT,
  )

  test("no secret reaches logs, RPC outputs, events or OWN_HOME; the linked source is untouched", async () => {
    const server = required(state.server)
    const linkedTokens = required(state.linkedTokens)
    const issued = required(state.auth).issued
    const secrets = [
      KEY_A,
      KEY_B,
      linkedTokens.accessToken,
      linkedTokens.refreshToken,
      linkedTokens.idToken,
      ...issued.flatMap((tokens) => [tokens.accessToken, tokens.refreshToken, tokens.idToken]),
    ]
    expect(issued).toHaveLength(1)

    const logs = server.logs()
    expect(logs).toContain('"scope":"own.accounts","msg":"ready"')
    expect(logs).not.toMatch(
      /hook_failed|setup_failed|module_start_failed|event_handler_failed|auth_missing|auth_blocked_by_plugin|auth_swap_broken/,
    )
    const home = await filesUnder(server.paths.ownHome)
    expect(home.length).toBeGreaterThan(0)
    const sources = [
      ["server log", logs],
      ["RPC outputs", state.outputs.join("\n")],
      ["event stream", required(state.events).text()],
      ["GET /api/provider", JSON.stringify(await providers(server))],
      ...(await Promise.all(home.map(async (file) => [file, await fs.readFile(file, "latin1")] as const))),
    ] as const
    const leaks = sources.flatMap(([name, text]) =>
      secrets.filter((secret) => text.includes(secret)).map((secret) => `${name}: …${secret.slice(-6)}`),
    )
    expect(leaks).toEqual([])

    // Linked: the source file still holds the old app's tokens, byte for byte.
    expect(await Bun.file(required(state.profile).authPath).json()).toMatchObject({
      tokens: { access_token: linkedTokens.accessToken, refresh_token: linkedTokens.refreshToken },
    })
    // selfTest checks every live slot (the retired Bravo slot is not one) and finds nothing wrong.
    const selfTest = await rpc("diagnostics.selfTest")
    const verdicts = (selfTest.slots as ReadonlyArray<Json>).map((slot) => [slot.providerID, slot.ok, slot.authSwap])
    const live = [state.accounts.alpha, state.accounts.device, state.accounts.linked].map((account) => [
      required(account).providerID,
      true,
      "ok",
    ])
    expect(verdicts.toSorted()).toEqual(live.toSorted())
  })
})

const SESSION_METHODS = new Set([
  "session.binding",
  "cache.state",
  "cache.setTtlMode",
  "ledger.session",
  "switch.estimate",
  "switch.apply",
  "switch.schedule",
  "switch.cancel",
  "switch.undo",
  "switch.state",
  "switch.waitReset",
  "switch.setConfirmOverride",
])

function accountOf(output: Json): Account {
  const account = output.account
  if (!isRecord(account) || typeof account.id !== "string" || typeof account.providerID !== "string")
    throw new Error(`no account in ${JSON.stringify(output)}`)
  return { id: account.id, providerID: account.providerID }
}

function ref(account: Account): ModelRef {
  return { providerID: account.providerID, id: MODEL }
}

async function providers(server: OpencodeServer) {
  const listed = (await server.call("GET", "/api/provider")) as unknown
  const list = Array.isArray(listed) ? listed : isRecord(listed) && Array.isArray(listed.data) ? listed.data : []
  return list.filter(isRecord)
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name))
}

function isResponsesCall(request: RecordedRequest) {
  return request.method === "POST" && request.path === "/v1/responses"
}

/** The system prompt: a leading developer message on Responses routes since upstream v2.3.2 (#64542). */
function instructions(request: RecordedRequest) {
  const json = request.json
  const first: unknown = isRecord(json) && Array.isArray(json.input) ? json.input[0] : undefined
  return isRecord(first) && first.role === "developer" && typeof first.content === "string" ? first.content : ""
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(200)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("integration fixture was not set up")
  return value
}

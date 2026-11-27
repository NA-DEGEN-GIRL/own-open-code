// End to end on a real upstream server (e2e kit): two `oai` API key accounts and one `codex` account linked to a
// fake codex-multi-provider profile, registered from `accounts.json` by the slots module and authenticated per
// request by the auth module against the fake providers. One session moves between the three slots.
// Every credential is fake; the real old-app profiles are never read.
//
// The scenario runs twice: on the production entry (`packages/own-accounts`, every module real) and on a fixture
// entry that pins the two peers this module depends on (`logins.headers`, `plugins.trustStatus`, see its header), so
// a regression in those peers is told apart from one in slots/auth.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { Hash } from "@own/runtime"
import {
  hashSecret,
  opencodeConfig,
  removeTree,
  startFakeCodex,
  startFakeOpenAIResponses,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type ChatGPTTokens,
  type FakeCodex,
  type FakeOpenAIResponses,
  type OpencodeServer,
  type RecordedRequest,
} from "../e2e-kit"
import { registryWith } from "../slots/support.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const ENTRIES = [
  { name: "production entry", dir: path.join(import.meta.dir, "../.."), buildId: "e2e-slots-auth-package" },
  {
    name: "pinned-peers fixture",
    dir: path.join(import.meta.dir, "fixture/accounts-under-test"),
    buildId: "e2e-slots-auth-fixture",
  },
]
const VAULT_HELPER = path.join(import.meta.dir, "fixture/seed-vault-helper.ts")

// Fake API keys (never real).
const KEY_A = "sk-proj-e2eFakeKeyAlpha0000000000000000000001"
const KEY_B = "sk-proj-e2eFakeKeyBravo0000000000000000000002"

const OAI_A = { providerID: "own-oai-e2ea", id: "gpt-5.5" }
const OAI_B = { providerID: "own-oai-e2eb", id: "gpt-5.5" }
// Codex rejects gpt-5.5 and older for ChatGPT accounts since upstream v2.1.
const CODEX = { providerID: "own-codex-e2ec", id: "gpt-5.6-sol" }

describe.each(ENTRIES)("own slots on a real server ($name): registration and per-request auth", (entry) => {
  const state: {
    responses?: FakeOpenAIResponses
    codex?: FakeCodex
    tokens?: ChatGPTTokens
    server?: OpencodeServer
    temp?: string
    authPath?: string
  } = {}

  beforeAll(async () => {
    const small = { minTokens: 0, blockTokens: 32 }
    state.responses = startFakeOpenAIResponses({ cache: small })
    state.codex = startFakeCodex({ cache: small })
    const tokens = state.codex.login({ accountID: "acct-e2e", email: "e2e@example.test" })
    state.tokens = tokens
    const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-slots-auth-")))
    state.temp = temp
    const home = path.join(temp, "own-home")
    const legacy = path.join(temp, "control-center")
    await fs.mkdir(home, { recursive: true })
    const [profile] = await writeCodexMultiProviderProfiles(legacy, [{ id: "01", alias: "work", tokens }])
    if (!profile) throw new Error("no legacy profile")
    state.authPath = profile.authPath
    const claims = await sourceIdentity(profile.authPath)
    const registry = await registryWith([
      { kind: "oai", label: "Alpha", slug: "e2ea", identity: { keyHint: Hash.keyHint(KEY_A) } },
      { kind: "oai", label: "Bravo", slug: "e2eb", identity: { keyHint: Hash.keyHint(KEY_B) } },
      {
        kind: "codex",
        label: "Work",
        slug: "e2ec",
        identity: { chatgptAccountId: claims.chatgptAccountId, fingerprint: claims.fingerprint },
        credential: {
          type: "linked-codex-source",
          source: { app: "codex-multi-provider", profileID: profile.id, alias: "work", authPath: profile.authPath },
          linkedAt: "2026-09-27T00:00:00Z",
        },
      },
    ])
    await Bun.write(path.join(home, "accounts.json"), JSON.stringify(registry, null, 2))
    const seed = path.join(temp, "vault-seed.json")
    await Bun.write(
      seed,
      JSON.stringify({
        acc_e2ea: JSON.stringify({ v: 1, type: "key", key: KEY_A, generation: 1 }),
        acc_e2eb: JSON.stringify({ v: 1, type: "key", key: KEY_B, generation: 1 }),
      }),
    )
    const responses = state.responses
    const codex = state.codex
    state.server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: opencodeConfig({
        providers: {},
        plugins: [
          {
            package: entry.dir,
            options: {
              home,
              buildId: entry.buildId,
              vault: { command: [process.execPath, VAULT_HELPER, seed] },
              endpoints: { openai: responses.baseURL, codex: codex.baseURL, oauthIssuer: codex.url },
              codexImportRoot: legacy,
              logLevel: "debug",
            },
          },
        ],
      }),
    })
    await state.server.waitForModels([OAI_A, OAI_B, CODEX])
    // No wait for the Location allowlist here: the first model request right after boot waits for the first
    // allowlist check itself (`plugins.trustSettled`, 02 §4.2) instead of failing closed with a 401.
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await Promise.all([state.responses?.stop(), state.codex?.stop()])
    if (state.temp) await removeTree(state.temp)
  }, 60_000)

  test(
    "one session moves between two oai slots and a linked codex slot; each request carries its slot's credential",
    async () => {
      const server = required(state.server)
      const responses = required(state.responses)
      const codex = required(state.codex)
      const tokens = required(state.tokens)
      const session = await server.createSession({ model: OAI_A, title: "slots-auth e2e" })
      const turn = async (model: typeof OAI_A, text: string) => {
        await server.switchModel(session.id, model)
        await server.prompt(session.id, text)
        await server.waitIdle(session.id)
      }

      await turn(OAI_A, "first via alpha")
      await turn(OAI_B, "second via bravo")
      await turn(CODEX, "third via codex")
      await turn(OAI_A, "fourth back to alpha")

      const calls = await responses.waitForRequests(3, { filter: isResponsesCall })
      expect(calls.map((call) => call.status)).toEqual([200, 200, 200])
      expect(calls.map((call) => call.headers.authorization)).toEqual([
        hashSecret(`Bearer ${KEY_A}`),
        hashSecret(`Bearer ${KEY_B}`),
        hashSecret(`Bearer ${KEY_A}`),
      ])
      // Each key is its own cache domain on the fake; a switch back to Alpha finds Alpha's prefix again.
      expect(calls[1]?.identity).not.toBe(calls[0]?.identity)
      expect(calls[2]?.identity).toBe(calls[0]?.identity)
      // D9: the identity block names the slot-neutral provider, never the own slot id.
      for (const call of calls) {
        expect(instructions(call)).toContain("- Provider ID: openai")
        expect(instructions(call)).not.toContain("own-oai-")
      }
      // Static slot data only: the provider sends no credential of its own and no account id.
      for (const call of calls) expect(call.headers["chatgpt-account-id"]).toBeUndefined()

      const [frame] = await codex.waitForRequests(1, { filter: (request) => request.method === "WS" })
      const handshake = codex.requests.find((request) => request.transport === "websocket" && request.method === "GET")
      expect(handshake).toMatchObject({ status: 101 })
      expect(frame).toMatchObject({ status: 200, model: CODEX.id, identity: "codex:acct-e2e" })
      for (const recorded of [handshake, frame]) {
        expect(recorded?.headers.authorization).toBe(hashSecret(`Bearer ${tokens.accessToken}`))
        expect(recorded?.headers["chatgpt-account-id"]).toBe("acct-e2e")
        expect(recorded?.headers["session-id"]).toBe(session.id)
        expect(recorded?.headers.originator).toBe("opencode")
        expect(recorded?.headers["x-codex-beta-features"]).toBe("remote_compaction_v2")
      }
      // Linked source: never refreshed by us, never written.
      expect(codex.requests.filter((request) => request.path.includes("/oauth/token"))).toEqual([])
      expect(await Bun.file(state.authPath ?? "").json()).toMatchObject({
        tokens: { access_token: tokens.accessToken },
      })

      expect(await assistantModels(server, session.id)).toEqual([OAI_A, OAI_B, CODEX, OAI_A])
      await waitForTrust(server)
    },
    TURN_TIMEOUT,
  )

  test("the registered slots follow 02 §3.6 and expose no secret", async () => {
    const server = required(state.server)
    const providers = (await server.call("GET", "/api/provider")) as { readonly data?: unknown } | unknown
    const text = JSON.stringify(providers)
    const list = Array.isArray(providers)
      ? providers
      : isRecord(providers) && Array.isArray(providers.data)
        ? providers.data
        : []
    const byID = new Map(list.filter(isRecord).map((provider) => [String(provider.id), provider]))
    expect(byID.get(OAI_A.providerID)).toMatchObject({
      activation: "enabled",
      canonical: "openai",
      package: "@opencode/ai/providers/openai",
      settings: { compaction: { type: "summary" } },
    })
    expect(byID.get(CODEX.providerID)).toMatchObject({
      activation: "enabled",
      canonical: "openai",
      settings: { transport: "websocket", compaction: { type: "summary" } },
      headers: { originator: "opencode", "x-codex-beta-features": "remote_compaction_v2" },
    })
    for (const provider of [byID.get(OAI_A.providerID), byID.get(CODEX.providerID)]) {
      expect(provider).not.toHaveProperty("integrationID")
      expect(JSON.stringify(provider)).not.toContain("apiKey")
    }
    // hideBuiltinProviders "auto": the built-in openai is hidden once oai/codex accounts exist.
    expect(byID.has("openai")).toBe(false)
    for (const secret of secrets()) expect(text).not.toContain(secret)

    const accounts = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/accounts.list`, {
      body: { input: {} },
      query: { "location[directory]": server.paths.workspace },
    })
    expect(accounts.status).toBe(200)
    const body = await accounts.text()
    expect(JSON.parse(body)).toMatchObject({
      output: {
        accounts: [
          { id: "acc_e2ea", providerID: OAI_A.providerID, connection: { type: "key", method: "api-key" } },
          { id: "acc_e2eb", providerID: OAI_B.providerID },
          { id: "acc_e2ec", providerID: CODEX.providerID, connection: { method: "codex-linked" } },
        ],
      },
    })
    for (const secret of secrets()) expect(body).not.toContain(secret)
  })

  test("nothing secret reaches the server log", () => {
    const logs = required(state.server).logs()
    expect(logs).toContain('"msg":"registry_loaded"')
    expect(logs).not.toMatch(/hook_failed|setup_failed|module_start_failed|auth_missing|auth_swap_broken/)
    for (const secret of secrets()) expect(logs).not.toContain(secret)
  })

  function secrets() {
    const tokens = required(state.tokens)
    return [KEY_A, KEY_B, tokens.accessToken, tokens.refreshToken, tokens.idToken]
  }
})

async function waitForTrust(server: OpencodeServer) {
  const deadline = Date.now() + 30_000
  const status = async () => {
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/plugin.trust.list`, {
      body: { input: {} },
      query: { "location[directory]": server.paths.workspace },
    })
    const body: unknown = await response.json()
    const locations =
      isRecord(body) && isRecord(body.output) && Array.isArray(body.output.locations) ? body.output.locations : []
    return locations.filter(isRecord).find((location) => location.directory === server.paths.workspace)?.status
  }
  while ((await status()) !== "ok") {
    if (Date.now() > deadline) throw new Error("the test Location never became trusted (plugin.trust.list)")
    await Bun.sleep(100)
  }
}

async function sourceIdentity(authPath: string) {
  const { CodexSource } = await import("@own/runtime")
  const read = await CodexSource.read(authPath)
  if (!read.ok) throw new Error(`fixture source unreadable: ${read.problem}`)
  const identity = read.snapshot.summary.identity
  if (!identity.chatgptAccountId || !identity.fingerprint) throw new Error("fixture source without identity")
  return { chatgptAccountId: identity.chatgptAccountId, fingerprint: identity.fingerprint }
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

async function assistantModels(server: OpencodeServer, sessionID: string) {
  return (await server.messages(sessionID))
    .filter((message) => message.type === "assistant")
    .toReversed()
    .map((message) => {
      const model = message.model
      return isRecord(model) ? { providerID: model.providerID, id: model.id } : undefined
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

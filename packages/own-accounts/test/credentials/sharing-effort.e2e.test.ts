// Sign in with ChatGPT and a mid-conversation effort change on a real upstream server (02 §3.2c "입력 항목"). Core turns a
// same-model variant change into an effort marker, and OpenAI Responses lowers it to a `configuration_update` input item
// for GPT-6 and later. The fake token-sharing endpoint refuses that item exactly as the real one did
// (`subscription_sharing_unsupported_capability`, `param: "input"`). own-accounts must keep it out of siwc requests, so
// the turn after the change succeeds with the new effort as the top-level `reasoning.effort`; a refusal that still
// happens ends the turn with the Korean `sharing_unsupported_input` alert. Every credential is fake.
//
// With own's `codex` harness (own-harness after own-accounts, the release's plugin order), Codex rust-v0.165.0 places
// its own `configuration_update` items for catalog models that take them: one after the first user message, another
// where the effort changed, with `reasoning.effort` kept at the first one. They reach a ChatGPT login (`codex`) and
// never Sign in with ChatGPT, whose refusal the fake keeps.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { OwnAccounts } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { CodexSource } from "@own/runtime"
import {
  REPO_ROOT,
  opencodeConfig,
  removeTree,
  sessionInfo,
  sharingError,
  startFakeChatGPTSharing,
  startFakeCodex,
  startFakeOpenAIResponses,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type FakeChatGPTSharing,
  type FakeCodex,
  type FakeOpenAIResponses,
  type OpencodeServer,
  type RecordedRequest,
} from "../e2e-kit"
import { registryWith } from "../slots/support.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 240_000
const SCENARIO_TIMEOUT = 300_000
/** A GPT-6 model of the bundled catalog and the token-sharing list: OpenAI Responses keeps effort updates for it. */
const MODEL = "gpt-6-sol"
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
const USER = { sub: "user-e2e-sharing-effort", email: "effort@example.test", plan: "pro" }
const REFUSED = "subscription_sharing_unsupported_capability"

type Json = Record<string, unknown>

describe("Sign in with ChatGPT effort change on a real server", () => {
  const state: {
    auth?: FakeChatGPTSharing
    responses?: FakeOpenAIResponses
    server?: OpencodeServer
    control?: string
    refuseAll: boolean
  } = { refuseAll: false }

  async function rpc(method: string, input: unknown = {}) {
    const server = required(state.server)
    const directory = required(state.control)
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${text}`)
    return ((JSON.parse(text) as { readonly output?: Json }).output ?? {}) as Json
  }

  beforeAll(async () => {
    const auth = startFakeChatGPTSharing()
    const responses = startFakeOpenAIResponses({
      cache: { minTokens: 0, blockTokens: 16 },
      sharingModels: [
        {
          slug: MODEL,
          display_name: "GPT-6 Sol",
          visibility: "list",
          supported_in_api: true,
          context_window: 1_050_000,
          input_modalities: ["text", "image"],
        },
      ],
      // The real route's answer to an input item it does not accept (user report of 2026-10-10).
      responder: (request) =>
        state.refuseAll || request.body.includes('"configuration_update"')
          ? sharingError(REFUSED, { param: "input" })
          : undefined,
    })
    Object.assign(state, { auth, responses })
    const server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      // A cold transpile cache on a busy machine can take most of the default 90 s.
      startupTimeoutMs: BOOT_TIMEOUT - 10_000,
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: path.join(REPO_ROOT, "packages/own-accounts"),
              options: {
                home: paths.ownHome,
                buildId: `e2e-sharing-effort-${process.pid}`,
                vault: "memory",
                endpoints: { openai: responses.baseURL, oauthIssuer: auth.url },
              },
            },
          ],
        }),
    })
    state.server = server
    const control = path.join(server.paths.ownHome, "control")
    await fs.mkdir(control, { recursive: true })
    state.control = control
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await Promise.all([state.auth?.stop(), state.responses?.stop()])
  }, 60_000)

  test(
    "the turn after a variant change sends no configuration_update; a refusal left raises the Korean alert",
    async () => {
      const server = required(state.server)
      const auth = required(state.auth)
      const responses = required(state.responses)

      const started = await rpc("accounts.add.chatgpt.start", { method: "siwc" })
      await fetch(auth.authorize(String(started.authorizeURL), USER))
      const completed = await rpc("accounts.add.chatgpt.complete", { attemptID: started.attemptID, label: "01" })
      const providerID = String((completed.account as Json).providerID)
      await server.waitForModels([{ providerID, id: MODEL }])
      const listed = (await server.models()).find((item) => item.providerID === providerID && item.id === MODEL)
      const variants = (Array.isArray(listed?.variants) ? listed.variants : [])
        .map((variant: unknown) => (isRecord(variant) ? String(variant.id) : String(variant)))
        .filter((id) => EFFORTS.includes(id))
      // Two effort levels of the model, like the reported high → max.
      const [from, to] = [variants.at(-2), variants.at(-1)].map((value) => required(value))

      const session = await server.createSession({ model: { providerID, id: MODEL, variant: from } })
      responses.enqueue({ type: "text", text: "first answer" })
      await server.prompt(session.id, "first")
      await server.waitIdle(session.id)
      await server.switchModel(session.id, { providerID, id: MODEL, variant: to })
      await server.switchModel(session.id, { providerID, id: MODEL, variant: from })
      await server.switchModel(session.id, { providerID, id: MODEL, variant: to })
      await server.prompt(session.id, "after the change")
      await server.waitIdle(session.id)

      const calls = responses.requests.filter(isResponsesCall)
      expect(calls).toHaveLength(2)
      const after = calls[1]
      expect(after?.status).toBe(200)
      expect(after?.body).not.toContain("configuration_update")
      expect((after?.json as Json).reasoning).toMatchObject({ effort: to })
      expect(JSON.stringify(after?.json)).toContain("first answer")
      expect(await failures(server, session.id)).toEqual([])

      // A refusal that still happens (any other input item) ends the turn once, with the Korean alert.
      state.refuseAll = true
      await server.prompt(session.id, "refused")
      await server.waitIdle(session.id)
      state.refuseAll = false
      const refused = responses.requests.filter(isResponsesCall).slice(2)
      expect(refused).toHaveLength(1)
      expect(refused[0]?.status).toBe(400)
      expect(await failures(server, session.id)).toEqual([REFUSED])
      const logs = server.logs()
      expect(logs).toContain("sharing_unsupported_input")
    },
    SCENARIO_TIMEOUT,
  )
})

/** A catalog model of Codex rust-v0.165.0 with `supports_reasoning_effort_updates`, in the bundled codex template. */
const ASTRA = "gpt-6-astra"

describe("codex harness: Codex's effort updates on a ChatGPT login, none on Sign in with ChatGPT", () => {
  const state: {
    codex?: FakeCodex
    auth?: FakeChatGPTSharing
    responses?: FakeOpenAIResponses
    server?: OpencodeServer
    temp?: string
  } = {}

  async function rpc(method: string, input: unknown = {}) {
    const server = required(state.server)
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": server.paths.workspace },
    })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${text}`)
    return ((JSON.parse(text) as { readonly output?: Json }).output ?? {}) as Json
  }

  beforeAll(async () => {
    const codex = startFakeCodex()
    const auth = startFakeChatGPTSharing()
    const responses = startFakeOpenAIResponses({
      sharingModels: [
        {
          slug: ASTRA,
          display_name: "GPT-6 Astra",
          visibility: "list",
          supported_in_api: true,
          context_window: 1_050_000,
          input_modalities: ["text", "image"],
        },
      ],
      responder: (request) =>
        request.body.includes('"configuration_update"') ? sharingError(REFUSED, { param: "input" }) : undefined,
    })
    Object.assign(state, { codex, auth, responses })
    const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-sharing-effort-")))
    state.temp = temp
    const home = path.join(temp, "own-home")
    const legacy = path.join(temp, "control-center")
    await fs.mkdir(home, { recursive: true })
    const [profile] = await writeCodexMultiProviderProfiles(legacy, [
      { id: "01", alias: "effort", tokens: codex.login({ accountID: "acct-effort" }) },
    ])
    const source = required(profile)
    const read = await CodexSource.read(source.authPath)
    if (!read.ok) throw new Error(`fixture source unreadable: ${read.problem}`)
    const identity = read.snapshot.summary.identity
    const registry = await registryWith([
      {
        kind: "codex",
        label: "Codex",
        slug: "efcodex",
        identity: {
          chatgptAccountId: required(identity.chatgptAccountId),
          fingerprint: required(identity.fingerprint),
        },
        credential: {
          type: "linked-codex-source",
          source: { app: "codex-multi-provider", profileID: source.id, alias: source.alias, authPath: source.authPath },
          linkedAt: "2026-10-30T00:00:00Z",
        },
      },
    ])
    await Bun.write(path.join(home, "accounts.json"), JSON.stringify(registry, null, 2))
    state.server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      startupTimeoutMs: BOOT_TIMEOUT - 10_000,
      projectConfig: true,
      config: opencodeConfig({
        providers: {},
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: {
              home,
              buildId: `e2e-sharing-effort-harness-${process.pid}`,
              vault: "memory",
              endpoints: { codex: codex.baseURL, openai: responses.baseURL, oauthIssuer: auth.url },
              codexImportRoot: legacy,
            },
          },
          // Last, as in the release (10 §2): its request hook runs after own-accounts'.
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
        ],
      }),
    })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await Promise.all([state.codex?.stop(), state.auth?.stop(), state.responses?.stop()])
    if (state.temp) await removeTree(state.temp)
  }, 60_000)

  test(
    "a ChatGPT login gets the first-window update and one more on the change; Sign in with ChatGPT gets none",
    async () => {
      const server = required(state.server)
      const auth = required(state.auth)
      const started = await rpc("accounts.add.chatgpt.start", { method: "siwc" })
      await fetch(auth.authorize(String(started.authorizeURL), USER))
      const completed = await rpc("accounts.add.chatgpt.complete", { attemptID: started.attemptID, label: "01" })
      const siwc = String((completed.account as Json).providerID)
      const codex = "own-codex-efcodex"
      await server.waitForModels([
        { providerID: codex, id: ASTRA },
        { providerID: siwc, id: ASTRA },
      ])

      // A ChatGPT login: Codex's updates, the top-level effort kept at the first one.
      const login = await turns(codex, ["high", "low"], required(state.codex), isCodexCall)
      const inputs = login.map(inputOf)
      // The second request extends the first, so the Responses WebSocket sends only what is new after the first
      // response (`previous_response_id`, ai open-responses-continuation.ts); a request sent in full repeats the first.
      const incremental = typeof (login[1]?.json as Json | undefined)?.previous_response_id === "string"
      if (!incremental) expect(JSON.stringify(inputs[1]?.slice(0, inputs[0]?.length))).toBe(JSON.stringify(inputs[0]))
      expect(inputs.map(updatesAfterUsers)).toEqual([
        [["first", "high"]],
        [...(incremental ? [] : [["first", "high"]]), ["second", "low"]],
      ])
      expect(login.map((call) => (call.json as Json).reasoning)).toEqual([
        expect.objectContaining({ effort: "high" }),
        expect.objectContaining({ effort: "high" }),
      ])

      // Sign in with ChatGPT: no update at all, the current effort at the top (the fake refuses any update).
      const sharing = await turns(siwc, ["high", "low"], required(state.responses), isResponsesCall)
      expect(sharing.map((call) => call.status)).toEqual([200, 200])
      expect(sharing.map((call) => call.body.includes("configuration_update"))).toEqual([false, false])
      expect(sharing.map((call) => ((call.json as Json).reasoning as Json).effort)).toEqual(["high", "low"])
    },
    SCENARIO_TIMEOUT,
  )

  /** Two turns of a new codex-harness session on `providerID`, the second after a switch to the second effort. */
  async function turns(
    providerID: string,
    efforts: readonly [string, string],
    fake: FakeCodex | FakeOpenAIResponses,
    isCall: (request: RecordedRequest) => boolean,
  ) {
    const server = required(state.server)
    const before = fake.requests.length
    const session = await server.createSession({ model: { providerID, id: ASTRA, variant: efforts[0] } })
    while (OwnHarness.bound((await sessionInfo(server, session.id)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    fake.enqueue({ type: "text", text: "first answer" }, { type: "text", text: "second answer" })
    await server.prompt(session.id, "first")
    await server.waitIdle(session.id)
    await server.switchModel(session.id, { providerID, id: ASTRA, variant: efforts[1] })
    await server.prompt(session.id, "second")
    await server.waitIdle(session.id)
    expect(await failures(server, session.id)).toEqual([])
    const calls = fake.requests.slice(before).filter(isCall)
    expect(calls).toHaveLength(2)
    return calls
  }
})

/** A Codex `response.create` frame, or a Responses POST when the slot speaks HTTP. */
function isCodexCall(request: RecordedRequest) {
  if (request.method === "WS") return isRecord(request.json) && request.json.type === "response.create"
  return request.method === "POST" && request.path.endsWith("/responses")
}

function inputOf(request: RecordedRequest) {
  const body = isRecord(request.json) ? request.json : {}
  return Array.isArray(body.input) ? body.input.filter(isRecord) : []
}

/** Each `configuration_update` with the user message right before it, as `[text, effort]`. */
function updatesAfterUsers(input: ReadonlyArray<Json>) {
  return input.flatMap((item, index) => {
    if (item.type !== "configuration_update") return []
    const before = input[index - 1]
    const content = Array.isArray(before?.content) ? before.content.filter(isRecord) : []
    const reasoning = isRecord(item.reasoning) ? item.reasoning : {}
    return [[before?.role === "user" ? String(content[0]?.text) : "?", String(reasoning.effort)]]
  })
}

/** The token-sharing codes of the session's failed assistant messages (upstream v2.0.28 repeats it on `idle`). */
async function failures(server: OpencodeServer, sessionID: string) {
  return (await server.messages(sessionID)).flatMap((message) => {
    if (message.type !== "assistant") return []
    const error = isRecord(message.error) ? message.error : undefined
    const response = isRecord(error?.response) ? error.response : undefined
    const body = typeof response?.body === "string" ? response.body : ""
    return body.includes(REFUSED) ? [REFUSED] : []
  })
}

function isResponsesCall(request: RecordedRequest) {
  return request.method === "POST" && request.path === "/v1/responses"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("sharing effort e2e fixture was not set up")
  return value
}

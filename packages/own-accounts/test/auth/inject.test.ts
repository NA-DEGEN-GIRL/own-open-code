import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hash } from "@own/runtime"
import { chatGPTAccount, mintChatGPTTokens, writeCodexMultiProviderProfiles, type ChatGPTTokens } from "../e2e-kit"
import { registryWith } from "../slots/support.js"
import { authSetup, modelRequest, ref } from "./support.js"

// Fake credentials only.
const KEY_A = "sk-proj-fakeaccountA000000000000000000001"
const KEY_B = "sk-proj-fakeaccountB000000000000000000002"
const ANTH_KEY = "sk-ant-api03-fakeanthropic00000000000000000003"
const SESSION = "ses_inject_test"

const OAI_A = ref("own-oai-aaaa", "gpt-5.5")
const OAI_B = ref("own-oai-bbbb", "gpt-5.5")
const ANTH = ref("own-anth-nnnn", "claude-opus-5-5")
const CODEX_VAULT = ref("own-codex-vvvv", "gpt-5.5")
const CODEX_LINKED = ref("own-codex-llll", "gpt-5.5")
const SIWC = ref("own-siwc-ssss", "gpt-5.5")
const SIWC_WRONG = ref("own-siwc-wwww", "gpt-5.5")

const state: { root?: string; linked?: ChatGPTTokens; authPath?: string } = {}

beforeAll(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), "own-auth-legacy-"))
})

afterAll(async () => {
  if (state.root) await fs.rm(state.root, { recursive: true, force: true })
})

async function setup() {
  const now = Date.UTC(2026, 8, 27, 3, 0, 0)
  const vaultAccount = chatGPTAccount({ accountID: "acct-vault" })
  const linkedAccount = chatGPTAccount({ accountID: "acct-linked" })
  const linked = mintChatGPTTokens(linkedAccount, now, 3_600_000)
  const [profile] = await writeCodexMultiProviderProfiles(state.root ?? "", [{ alias: "개인", tokens: linked }])
  if (!profile) throw new Error("no profile")
  state.linked = linked
  state.authPath = profile.authPath
  const registry = await registryWith([
    { kind: "oai", label: "A", slug: "aaaa" },
    { kind: "oai", label: "B", slug: "bbbb" },
    { kind: "anth", label: "N", slug: "nnnn" },
    {
      kind: "codex",
      label: "V",
      slug: "vvvv",
      identity: {
        chatgptAccountId: vaultAccount.accountID,
        fingerprint: Hash.fingerprint(vaultAccount.accountID, vaultAccount.userID),
      },
    },
    {
      kind: "codex",
      label: "L",
      slug: "llll",
      identity: {
        chatgptAccountId: linkedAccount.accountID,
        fingerprint: Hash.fingerprint(linkedAccount.accountID, linkedAccount.userID),
      },
      credential: {
        type: "linked-codex-source",
        source: { app: "codex-multi-provider", profileID: profile.id, alias: "개인", authPath: profile.authPath },
        linkedAt: "2026-09-27T00:00:00Z",
      },
    },
    { kind: "siwc", label: "S", slug: "ssss", identity: { fingerprint: Hash.fingerprint("oaiapp_inject", "user-s") } },
    { kind: "siwc", label: "W", slug: "wwww", identity: { fingerprint: Hash.fingerprint("oaiapp_wrong", "user-w") } },
  ])
  const s = await authSetup({ registry })
  const credentials = s.t.deps.runtime.credentials
  await credentials.store("acc_aaaa", { type: "key", key: KEY_A })
  await credentials.store("acc_bbbb", { type: "key", key: KEY_B })
  await credentials.store("acc_nnnn", { type: "key", key: ANTH_KEY })
  const vaultTokens = mintChatGPTTokens(vaultAccount, s.t.clock.now(), 3_600_000)
  await credentials.store("acc_vvvv", {
    type: "oauth",
    access: vaultTokens.accessToken,
    refresh: vaultTokens.refreshToken,
    idToken: vaultTokens.idToken,
    expiresAt: vaultTokens.expiresAt,
  })
  const sharing = mintChatGPTTokens(chatGPTAccount({ accountID: "acct-sharing" }), s.t.clock.now(), 3_600_000)
  await credentials.store("acc_ssss", {
    type: "oauth",
    family: "openai-chatgpt-sharing",
    access: sharing.accessToken,
    refresh: sharing.refreshToken,
    expiresAt: sharing.expiresAt,
    clientId: "oaiapp_inject",
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  })
  // A Codex-family item on a siwc account: never sent (fail closed).
  await credentials.store("acc_wwww", {
    type: "oauth",
    access: sharing.accessToken,
    refresh: sharing.refreshToken,
    expiresAt: sharing.expiresAt,
  })
  return { s, vaultTokens, linked, sharing }
}

describe("model.request auth injection (02 §4.1)", () => {
  test("each API key slot gets its own Authorization; anth gets x-api-key only", async () => {
    const { s } = await setup()
    await using _s = s
    const a = modelRequest(SESSION, OAI_A)
    const b = modelRequest(SESSION, OAI_B)
    const n = modelRequest(SESSION, ANTH, { Authorization: "Bearer stale-from-elsewhere" })
    await s.auth.onModelRequest(a)
    await s.auth.onModelRequest(b)
    await s.auth.onModelRequest(n)
    expect(a.headers).toEqual({ "x-session-affinity": SESSION, authorization: `Bearer ${KEY_A}` })
    expect(b.headers).toEqual({ "x-session-affinity": SESSION, authorization: `Bearer ${KEY_B}` })
    expect(n.headers).toEqual({ "x-session-affinity": SESSION, "x-api-key": ANTH_KEY })
    // The base URL is never changed (02 §3.6).
    expect(a.baseURL).toBe("https://example.invalid/v1")
    // How long each credential took is logged at debug level, without any header value.
    const timings = s.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "auth_headers")
    expect(timings.map((line) => [line.providerID, line.ok, typeof line.latencyMs])).toEqual([
      ["own-oai-aaaa", true, "number"],
      ["own-oai-bbbb", true, "number"],
      ["own-anth-nnnn", true, "number"],
    ])
    expect(JSON.stringify(timings)).not.toContain(KEY_A)
  })

  test("codex (vault OAuth and linked source) adds chatgpt-account-id, session-id and originator", async () => {
    const { s, vaultTokens, linked } = await setup()
    await using _s = s
    const vault = modelRequest(SESSION, CODEX_VAULT)
    const source = modelRequest("ses_other", CODEX_LINKED)
    await s.auth.onModelRequest(vault)
    await s.auth.onModelRequest(source)
    expect(vault.headers).toEqual({
      "x-session-affinity": SESSION,
      authorization: `Bearer ${vaultTokens.accessToken}`,
      "chatgpt-account-id": "acct-vault",
      "session-id": SESSION,
      originator: "opencode",
    })
    expect(source.headers).toEqual({
      "x-session-affinity": "ses_other",
      authorization: `Bearer ${linked.accessToken}`,
      "chatgpt-account-id": "acct-linked",
      "session-id": "ses_other",
      originator: "opencode",
    })
    // The linked source is only read: the file is unchanged and we never refresh it.
    expect(await Bun.file(state.authPath ?? "").json()).toMatchObject({ tokens: { access_token: linked.accessToken } })
    // A child session carries its parent's affinity (core `SessionAffinity.get`); ChatGPT routes its cache on it.
    const child = modelRequest("ses_child", CODEX_VAULT, { "x-session-affinity": SESSION })
    await s.auth.onModelRequest(child)
    expect(child.headers).toMatchObject({ "session-id": SESSION, "chatgpt-account-id": "acct-vault" })
  })

  test("siwc sends Bearer and upstream's token-sharing session headers; a Codex-family item is never sent", async () => {
    const { s, sharing } = await setup()
    await using _s = s
    const event = modelRequest(SESSION, SIWC, {
      "chatgpt-account-id": "stale",
      Authorization: "Bearer stale",
      "Session-Id": "ses_stale",
      "Thread-Id": "ses_stale",
      "X-Client-Request-Id": "req_stale",
      originator: "opencode",
      "X-Codex-Beta-Features": "remote_compaction_v2",
      "x-session-id": SESSION,
    })
    await s.auth.onModelRequest(event)
    // Upstream chatgpt.ts (5183ea45c3): session-id = the affinity, thread-id and x-client-request-id = the session.
    // No Codex account, originator or x-codex-* header, and no stale casing of a session header left beside them.
    expect(event.headers).toEqual({
      "x-session-affinity": SESSION,
      "x-session-id": SESSION,
      authorization: `Bearer ${sharing.accessToken}`,
      "session-id": SESSION,
      "thread-id": SESSION,
      "x-client-request-id": SESSION,
    })
    // Every request of the session sends the same values (the prompt cache routes on them, D3).
    const again = modelRequest(SESSION, SIWC, { "x-session-id": SESSION })
    await s.auth.onModelRequest(again)
    expect(again.headers).toEqual(event.headers)
    // A subagent (child) or a fork carries core's affinity, its parent's or its source's: the same session-id as the
    // parent, while thread-id and x-client-request-id stay its own id.
    const child = modelRequest("ses_child", SIWC, { "x-session-affinity": SESSION })
    await s.auth.onModelRequest(child)
    expect(child.headers).toEqual({
      "x-session-affinity": SESSION,
      authorization: `Bearer ${sharing.accessToken}`,
      "session-id": SESSION,
      "thread-id": "ses_child",
      "x-client-request-id": "ses_child",
    })
    const wrong = modelRequest(SESSION, SIWC_WRONG)
    await s.auth.onModelRequest(wrong)
    expect(wrong.headers).toEqual({ "x-session-affinity": SESSION })
    expect(s.logs.join("\n")).toContain("kind_mismatch")
  })

  test("a siwc request that fails closed leaves without the session headers it arrived with", async () => {
    const { s } = await setup()
    await using _s = s
    const stale = { "Session-Id": "ses_stale", "thread-id": "ses_stale", "X-Client-Request-Id": "req_stale" }
    // A Codex-family item on a siwc account, then an untrusted Location: neither request gets a credential, and neither
    // keeps the session headers of another session's request (they come from the session alone, 02 §3.2c).
    const mismatch = modelRequest(SESSION, SIWC_WRONG, stale)
    await s.auth.onModelRequest(mismatch)
    s.trust.value = "blocked_by_plugin"
    const blocked = modelRequest(SESSION, SIWC, stale)
    await s.auth.onModelRequest(blocked)
    expect(mismatch.headers).toEqual({ "x-session-affinity": SESSION })
    expect(blocked.headers).toEqual({ "x-session-affinity": SESSION })
    const lines = s.logs.join("\n")
    expect(lines).toContain("kind_mismatch")
    expect(lines).toContain("auth_blocked_by_plugin")
  })

  test("header values are stable across attempts (D3) and the injected hash is recorded", async () => {
    const { s } = await setup()
    await using _s = s
    const first = modelRequest(SESSION, OAI_A)
    const second = modelRequest(SESSION, OAI_A)
    await s.auth.onModelRequest(first)
    await s.auth.onModelRequest(second)
    expect(second.headers).toEqual(first.headers)
    expect(s.t.deps.runtime.lastResponse.injected(SESSION, "own-oai-aaaa")).toBe(Hash.short(`Bearer ${KEY_A}`))
  })

  test("providers that are not own slots are never touched, anthropic included", async () => {
    const { s } = await setup()
    await using _s = s
    for (const model of [
      ref("openai", "gpt-5.5"),
      ref("anthropic", "claude-opus-5-5"),
      ref("own-oai-zzzz", "gpt-5.5"),
    ]) {
      const event = modelRequest(SESSION, model, { authorization: "Bearer untouched-value" })
      const before = structuredClone(event)
      await s.auth.onModelRequest(event)
      expect(event).toEqual(before)
    }
  })

  test("fails closed: an untrusted Location, a disabled account or a missing secret inject nothing", async () => {
    const { s } = await setup()
    await using _s = s
    s.trust.value = "blocked_by_plugin"
    const blocked = modelRequest(SESSION, OAI_A)
    await s.auth.onModelRequest(blocked)
    expect(blocked.headers).toEqual({ "x-session-affinity": SESSION })
    s.trust.value = "ok"

    await s.modules.slots.mutate((current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.id === "acc_bbbb" ? { ...account, status: "disabled" as const } : account,
      ),
    }))
    const disabled = modelRequest(SESSION, OAI_B)
    await s.auth.onModelRequest(disabled)
    expect(disabled.headers).toEqual({ "x-session-affinity": SESSION })

    await s.t.deps.runtime.credentials.remove(s.modules.slots.account("acc_aaaa") ?? never(), { shred: true })
    const missing = modelRequest(SESSION, OAI_A, { authorization: "Bearer injected-by-someone-else-0000" })
    await s.auth.onModelRequest(missing)
    // A credential header already on the request is dropped too: the request fails with 401 instead of using it.
    expect(missing.headers).toEqual({ "x-session-affinity": SESSION })
    const lines = s.logs.join("\n")
    expect(lines).toContain("auth_blocked_by_plugin")
    expect(lines).toContain("auth_slot_unusable")
    expect(lines).toContain("auth_missing")
    expect(lines).toContain("not_found")
  })

  test("an expired linked source is stale: nothing injected, never refreshed", async () => {
    const { s } = await setup()
    await using _s = s
    s.t.clock.advance(2 * 3_600_000)
    const event = modelRequest(SESSION, CODEX_LINKED)
    await s.auth.onModelRequest(event)
    expect(event.headers).toEqual({ "x-session-affinity": SESSION })
    expect(s.logs.join("\n")).toContain("source_stale")
  })

  test("switching the session's slot switches the credential", async () => {
    const { s } = await setup()
    await using _s = s
    const sequence = [OAI_A, OAI_B, OAI_A, ANTH]
    const sent = await Promise.all(
      sequence.map(async (model) => {
        const event = modelRequest(SESSION, model)
        await s.auth.onModelRequest(event)
        return event.headers.authorization ?? event.headers["x-api-key"]
      }),
    )
    expect(sent).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`, `Bearer ${KEY_A}`, ANTH_KEY])
  })

  test("no secret reaches the log", async () => {
    const { s, vaultTokens, linked } = await setup()
    await using _s = s
    for (const model of [OAI_A, OAI_B, ANTH, CODEX_VAULT, CODEX_LINKED])
      await s.auth.onModelRequest(modelRequest(SESSION, model))
    s.trust.value = "blocked_by_plugin"
    await s.auth.onModelRequest(modelRequest(SESSION, OAI_A))
    const lines = s.logs.join("\n")
    for (const secret of [
      KEY_A,
      KEY_B,
      ANTH_KEY,
      vaultTokens.accessToken,
      vaultTokens.refreshToken,
      linked.accessToken,
    ])
      expect(lines).not.toContain(secret)
  })
})

function never(): never {
  throw new Error("missing fixture")
}

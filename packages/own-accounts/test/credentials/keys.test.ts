// accounts.add.key, replaceKey, accounts.test and forget for API key accounts against the e2e-kit fakes. Every key
// here is fake.

import { afterAll, describe, expect, test } from "bun:test"
import { hashSecret, startFakeAnthropic, startFakeOpenAIChat, startFakeOpenAIResponses } from "../e2e-kit"
import { call, harness } from "./support.js"

const GOOD = "sk-test-oai-good-key-0001"
const OTHER = "sk-test-oai-good-key-0002"
const ANTH = "sk-ant-test-good-key-0003"

const openai = startFakeOpenAIResponses({
  credentials: { [GOOD]: { domain: "org-a" }, [OTHER]: { domain: "org-a" } },
})
const anthropic = startFakeAnthropic({ credentials: { [ANTH]: { domain: "wrk-a" } } })
const chat = startFakeOpenAIChat()

afterAll(async () => {
  await Promise.all([openai.stop(), anthropic.stop(), chat.stop()])
})

const endpoints = { openai: openai.baseURL, anthropic: anthropic.baseURL, deepseek: chat.baseURL }

async function vaultIDs(h: Awaited<ReturnType<typeof harness>>) {
  const listed = await h.deps.runtime.vault.list()
  return listed.ok ? listed.ids : []
}

describe("accounts.add.key", () => {
  test("probes the key, stores it in the vault only and registers the account", async () => {
    await using h = await harness({ options: { endpoints } })
    openai.reset()
    const result = await call(h.logins.addKey, { kind: "oai", label: "work", key: GOOD })
    if (!result.ok) throw new Error(`addKey failed: ${result.type}`)
    expect(result.output.account.status).toBe("ready")
    expect(result.output.account.providerID).toMatch(/^own-oai-[a-z0-9]{4,8}$/)
    expect(result.output.test.ok).toBe(true)
    expect(result.output.sameDomainCandidates).toEqual([])

    const [probe] = openai.requests
    expect(probe?.method).toBe("GET")
    expect(probe?.path).toBe("/v1/models")
    expect(probe?.headers.authorization).toBe(hashSecret(`Bearer ${GOOD}`))

    const account = h.modules.slots.account(result.output.account.id)
    expect(account?.identity.keyHint).toBe("sk-…0001")
    expect(account?.credential).toBeUndefined()
    expect(await vaultIDs(h)).toEqual([result.output.account.id])
    const inspection = account && (await h.deps.runtime.credentials.inspect(account))
    expect(inspection).toMatchObject({ ok: true, type: "key", keyHint: "sk-…0001", generation: 1 })

    const registryText = await Bun.file(h.deps.runtime.layout.accounts).text()
    expect(registryText).not.toContain(GOOD)
    expect(h.logs.join("\n")).not.toContain(GOOD)
    expect(JSON.stringify(result.output)).not.toContain(GOOD)

    // The slot's requests carry the key through the per-request auth path.
    const auth = account && (await h.logins.headers(account, "ses_test"))
    expect(auth).toMatchObject({ ok: true, headers: { authorization: `Bearer ${GOOD}` }, source: "vault" })
  })

  test("a rejected key is probe_failed and nothing is stored or registered", async () => {
    await using h = await harness({ options: { endpoints } })
    const result = await call(h.logins.addKey, { kind: "oai", label: "bad", key: "sk-test-oai-unknown-9999" })
    expect(result).toMatchObject({ ok: false, type: "probe_failed", data: { status: 401, message: "unauthorized" } })
    expect(h.modules.slots.snapshot().accounts).toEqual([])
    expect(await vaultIDs(h)).toEqual([])
  })

  test("the same key twice is duplicate_account; a different key of the same org is a separate slot", async () => {
    await using h = await harness({ options: { endpoints } })
    const first = await call(h.logins.addKey, { kind: "oai", label: "one", key: GOOD })
    if (!first.ok) throw new Error("first add failed")
    const again = await call(h.logins.addKey, { kind: "oai", label: "two", key: GOOD })
    expect(again).toMatchObject({ ok: false, type: "duplicate_account", data: { accountID: first.output.account.id } })
    const other = await call(h.logins.addKey, { kind: "oai", label: "three", key: OTHER })
    if (!other.ok) throw new Error("second key failed")
    expect(other.output.account.providerID).not.toBe(first.output.account.providerID)
    expect(h.modules.slots.snapshot().accounts.map((account) => account.color)).toEqual(["indigo", "teal"])
  })

  test("anthropic probes with x-api-key and anthropic-version; deepseek probes the balance on the API origin", async () => {
    await using h = await harness({ options: { endpoints } })
    anthropic.reset()
    chat.reset()
    const anth = await call(h.logins.addKey, { kind: "anth", label: "prod", key: ANTH })
    expect(anth.ok).toBe(true)
    expect(anthropic.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/models?limit=1",
      headers: { "x-api-key": hashSecret(ANTH), "anthropic-version": "2023-06-01" },
    })
    expect(anthropic.requests[0]?.headers.authorization).toBeUndefined()
    const ds = await call(h.logins.addKey, { kind: "ds", label: "deep", key: "sk-test-ds-key-0004" })
    expect(ds.ok).toBe(true)
    expect(chat.requests[0]).toMatchObject({ method: "GET", path: "/user/balance" })
    const account = h.modules.slots.snapshot().accounts.find((candidate) => candidate.kind === "anth")
    const auth = account && (await h.logins.headers(account, "ses_test"))
    expect(auth).toMatchObject({ ok: true, headers: { "x-api-key": ANTH } })
  })

  test("compat needs a base URL and models with a context limit", async () => {
    await using h = await harness({ options: { endpoints } })
    const noBase = await call(h.logins.addKey, { kind: "compat", label: "c", key: "sk-test-compat-0005" })
    expect(noBase).toMatchObject({ ok: false, type: "probe_failed", data: { message: "base_url_required" } })
    const noLimit = await call(h.logins.addKey, {
      kind: "compat",
      label: "c",
      key: "sk-test-compat-0005",
      options: { baseURL: chat.baseURL, models: [{ id: "m" }] },
    })
    expect(noLimit).toMatchObject({
      ok: false,
      type: "template_unavailable",
      data: { reason: "context_limit_required" },
    })
    chat.reset()
    const ok = await call(h.logins.addKey, {
      kind: "compat",
      label: "c",
      key: "sk-test-compat-0005",
      options: { baseURL: chat.baseURL, models: [{ id: "m", contextLimit: 128_000 }] },
    })
    if (!ok.ok) throw new Error(`compat failed: ${ok.type}`)
    expect(chat.requests[0]?.path).toBe("/v1/models")
    expect(h.modules.slots.snapshot().slots[ok.output.account.providerID]?.baseURL).toBe(chat.baseURL)
  })

  test("a failed create discards the stored key", async () => {
    await using h = await harness({ options: { endpoints }, slots: { failCreate: "no_template" } })
    const result = await call(h.logins.addKey, { kind: "oai", label: "x", key: GOOD })
    expect(result).toMatchObject({
      ok: false,
      type: "template_unavailable",
      data: { kind: "oai", reason: "no_template" },
    })
    expect(await vaultIDs(h)).toEqual([])
  })

  test("an unexpected throw becomes a declared internal_error", async () => {
    await using h = await harness({ options: { endpoints } })
    const broken = {
      ...h.modules.slots,
      snapshot: () => {
        throw new Error("boom")
      },
    }
    Object.assign(h.modules, { slots: broken })
    const result = await call(h.logins.addKey, { kind: "oai", label: "x", key: GOOD })
    expect(result).toMatchObject({ ok: false, type: "internal_error", message: "unexpected" })
  })
})

describe("key accounts", () => {
  test("replaceKey probes first and keeps the previous item; accounts.test follows the provider's verdict", async () => {
    await using h = await harness({ options: { endpoints } })
    const added = await call(h.logins.addKey, { kind: "oai", label: "work", key: GOOD })
    if (!added.ok) throw new Error("add failed")
    const account = h.modules.slots.account(added.output.account.id)
    if (!account) throw new Error("no account")

    const rejected = await h.logins.replaceKey(account, "sk-test-oai-unknown-9999")
    expect(rejected).toMatchObject({ ok: false, error: "probe_failed", status: 401 })
    const replaced = await h.logins.replaceKey(account, OTHER)
    expect(replaced).toMatchObject({ ok: true, keyHint: "sk-…0002" })
    expect(await h.deps.runtime.credentials.inspect(account)).toMatchObject({ generation: 2, keyHint: "sk-…0002" })
    const auth = await h.logins.headers(account, "ses_test")
    expect(auth).toMatchObject({ ok: true, headers: { authorization: `Bearer ${OTHER}` } })

    const tested = await call(h.logins.test, { accountID: account.id })
    expect(tested).toMatchObject({ ok: true, output: { ok: true, status: "ready" } })
    expect(h.modules.slots.account(account.id)?.lastVerifiedAt).toBeDefined()
    const missing = await call(h.logins.test, { accountID: "acc_missing" as typeof account.id })
    expect(missing).toMatchObject({ ok: false, type: "account_not_found" })
  })

  test("accounts.test marks a rejected key auth_failed and a working one ready again", async () => {
    await using provider = startFakeOpenAIResponses({ credentials: { [GOOD]: { domain: "org-a" } } })
    await using h = await harness({ options: { endpoints: { openai: provider.baseURL } } })
    const added = await call(h.logins.addKey, { kind: "oai", label: "work", key: GOOD })
    if (!added.ok) throw new Error("add failed")
    // Point the slot at a provider that does not know the key.
    await using stranger = startFakeOpenAIResponses({ credentials: { "sk-test-stranger-key": { domain: "z" } } })
    await h.modules.slots.mutate((registry) => ({
      ...registry,
      slots: Object.fromEntries(
        Object.entries(registry.slots).map(([id, slot]) => [id, { ...slot, baseURL: stranger.baseURL }]),
      ),
    }))
    const failing = await call(h.logins.test, { accountID: added.output.account.id })
    expect(failing).toMatchObject({ ok: true, output: { ok: false, status: "auth_failed" } })
    await h.modules.slots.mutate((registry) => ({
      ...registry,
      slots: Object.fromEntries(
        Object.entries(registry.slots).map(([id, slot]) => [id, { ...slot, baseURL: provider.baseURL }]),
      ),
    }))
    const working = await call(h.logins.test, { accountID: added.output.account.id })
    expect(working).toMatchObject({ ok: true, output: { ok: true, status: "ready" } })
  })

  test("forget shreds the vault item only when asked", async () => {
    await using h = await harness({ options: { endpoints } })
    const added = await call(h.logins.addKey, { kind: "oai", label: "work", key: GOOD })
    if (!added.ok) throw new Error("add failed")
    const account = h.modules.slots.account(added.output.account.id)
    if (!account) throw new Error("no account")
    expect(await h.logins.forget(account, { shred: false })).toEqual({ ok: true })
    expect(await vaultIDs(h)).toEqual([account.id])
    expect(await h.logins.forget(account, { shred: true })).toEqual({ ok: true })
    expect(await vaultIDs(h)).toEqual([])
    expect(await h.logins.headers(account, "ses_test")).toMatchObject({ ok: false, problem: "not_found" })
  })
})

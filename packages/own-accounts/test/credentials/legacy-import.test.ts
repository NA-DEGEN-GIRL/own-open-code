// Linked import of API keys saved by the old app (02 §3.2b): accounts.import.keys.list/plan/execute, the linked
// credential on the request path, status on file problems, and removal. The old app is a temp copy made with the e2e
// kit (fake keys sealed for the memory vault); the real old-app files are never read. Probes go to the e2e-kit
// fake OpenAI-chat server in its DeepSeek dialect.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Account } from "@own/protocol"
import {
  createLegacyApp,
  hashSecret,
  removeTree,
  replaceLegacyKey,
  sealKey,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  writeLegacyDeepSeek,
  type LegacyApp,
} from "../e2e-kit"
import { call, harness, until, type Harness } from "./support.js"

const KEY = "sk-fake-legacy-deepseek-00000000000001"
const NEXT = "sk-fake-legacy-deepseek-00000000000002"
const OAI_KEY = "sk-fake-legacy-openai-000000000000003"
const OAI_PROVIDER = "5f0c3a1e-7d2b-4c8e-9a6f-0b1c2d3e4f50"

// The DeepSeek fake knows both fake keys; any other key is 401.
const chat = startFakeOpenAIChat({ credentials: { [KEY]: { domain: "ds-a" }, [NEXT]: { domain: "ds-a" } } })
const openai = startFakeOpenAIResponses({ credentials: { [OAI_KEY]: { domain: "org-a" } } })
const roots: string[] = []

afterAll(async () => {
  await Promise.all([chat.stop(), openai.stop()])
  await Promise.all(roots.map((root) => removeTree(root)))
})

interface Setup extends AsyncDisposable {
  readonly h: Harness
  readonly app: LegacyApp
  readonly file: string
}

async function setup(input: { readonly key?: string } = { key: KEY }): Promise<Setup> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-legacy-keys-")))
  roots.push(root)
  const app = await createLegacyApp(root)
  const file = await writeLegacyDeepSeek(app, { key: input.key })
  const h = await harness({
    options: {
      endpoints: { deepseek: chat.baseURL, openai: openai.baseURL },
      codexImportRoot: app.controlCenter,
    },
  })
  chat.reset()
  openai.reset()
  return { h, app, file, [Symbol.asyncDispose]: () => h[Symbol.asyncDispose]() }
}

async function link(h: Harness, providerRef: "legacy:deepseek" | `dpapi:${string}` = "legacy:deepseek") {
  const planned = await call(h.logins.keysPlan, { providerRef })
  if (!planned.ok) throw new Error(`plan failed: ${planned.type} ${planned.message}`)
  const executed = await call(h.logins.keysExecute, { nonce: planned.output.nonce })
  if (!executed.ok) throw new Error(`execute failed: ${executed.type} ${executed.message}`)
  const account = executed.output.account && h.modules.slots.account(executed.output.account.id)
  if (!account) throw new Error("no account")
  return { planned: planned.output, executed: executed.output, account }
}

async function headersOf(h: Harness, account: Account.Info) {
  const result = await h.logins.headers(h.modules.slots.account(account.id) ?? account, "ses_1")
  if (!result.ok) throw new Error(`headers failed: ${result.problem} ${result.detail ?? ""}`)
  return result.headers
}

async function vaultIDs(h: Harness) {
  const listed = await h.deps.runtime.vault.list()
  return listed.ok ? listed.ids : []
}

describe("accounts.import.keys.list", () => {
  test("lists the old app's saved keys without decrypting them; no key and no path on the wire", async () => {
    await using s = await setup()
    const listed = await call(s.h.logins.keysList, {})
    expect(listed).toEqual({
      ok: true,
      output: {
        available: true,
        keys: [
          {
            providerRef: "legacy:deepseek",
            name: "DeepSeek",
            kind: "ds",
            baseURL: "https://api.deepseek.com",
            models: ["deepseek-flash"],
            keySaved: true,
            importable: true,
            importedAs: null,
          },
        ],
      },
    })
    expect(JSON.stringify(listed)).not.toContain(s.app.appRoot)
    // Listing is a stat, not a decrypt.
    expect(s.h.logs.join("\n")).not.toContain(KEY)

    const { account } = await link(s.h)
    const again = await call(s.h.logins.keysList, {})
    expect(again.ok && again.output.keys[0]?.importedAs).toEqual({ accountID: account.id })

    await fs.rm(s.file)
    const gone = await call(s.h.logins.keysList, {})
    expect(gone.ok && gone.output.keys[0]).toMatchObject({ keySaved: false, importable: false, problem: "not_found" })
  })

  test("not available without the old app layout", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-legacy-none-")))
    roots.push(root)
    await using h = await harness({ options: { codexImportRoot: path.join(root, "legacy-control-center") } })
    expect(await call(h.logins.keysList, {})).toEqual({ ok: true, output: { available: false, keys: [] } })
    const app = await createLegacyApp(root)
    await using empty = await harness({ options: { codexImportRoot: app.controlCenter } })
    expect(await call(empty.logins.keysList, {})).toEqual({ ok: true, output: { available: false, keys: [] } })
  })
})

describe("accounts.import.keys.plan", () => {
  test("reads the key once for its hint and duplicates, suggests a label, changes nothing", async () => {
    await using s = await setup()
    const planned = await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })
    expect(planned).toMatchObject({
      ok: true,
      output: {
        providerRef: "legacy:deepseek",
        name: "DeepSeek",
        kind: "ds",
        label: "DeepSeek (이전 앱)",
        baseURL: "https://api.deepseek.com",
        model: "deepseek-flash",
        keyHint: "sk-…0001",
        duplicateOf: null,
        warnings: ["linked_key_depends_on_source"],
      },
    })
    expect(JSON.stringify(planned)).not.toContain(KEY)
    expect(s.h.modules.slots.snapshot().accounts).toEqual([])
    expect(chat.requests).toEqual([])
    expect(await vaultIDs(s.h)).toEqual([])
  })

  test("unknown provider, missing key, undecryptable file and unsupported providers are declared errors", async () => {
    await using s = await setup()
    expect(await call(s.h.logins.keysPlan, { providerRef: `dpapi:${OAI_PROVIDER}` })).toMatchObject({
      ok: false,
      type: "legacy_key_not_found",
      data: { providerRef: `dpapi:${OAI_PROVIDER}` },
    })
    await fs.writeFile(s.file, "not a sealed key")
    expect(await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })).toMatchObject({
      ok: false,
      type: "legacy_key_invalid",
      data: { providerRef: "legacy:deepseek", reason: "decrypt_failed" },
    })
    await sealKey(s.file, "   ", "fake")
    expect(await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })).toMatchObject({
      ok: false,
      data: { reason: "invalid_key" },
    })
    await fs.rm(s.file)
    expect(await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })).toMatchObject({
      ok: false,
      type: "legacy_key_not_found",
    })
    await writeLegacyDeepSeek(s.app, { key: KEY, baseURL: "https://lab.example.test/v1" })
    expect(await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })).toMatchObject({
      ok: false,
      type: "legacy_key_invalid",
      data: { reason: "unsupported_provider" },
    })
  })
})

describe("accounts.import.keys.execute", () => {
  test("dryRun decrypts and checks only; execute probes, then links the file by reference", async () => {
    await using s = await setup()
    const before = await fs.readFile(s.file)
    const planned = await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })
    if (!planned.ok) throw new Error("plan failed")
    const dry = await call(s.h.logins.keysExecute, { nonce: planned.output.nonce, dryRun: true })
    expect(dry).toEqual({
      ok: true,
      output: { account: null, dryRun: true, keyHint: "sk-…0001", test: { ok: false, skipped: true } },
    })
    expect(chat.requests).toEqual([])
    expect(s.h.modules.slots.snapshot().accounts).toEqual([])

    const executed = await call(s.h.logins.keysExecute, { nonce: planned.output.nonce, color: "teal" })
    if (!executed.ok) throw new Error(`execute failed: ${executed.type}`)
    expect(executed.output).toMatchObject({
      dryRun: false,
      keyHint: "sk-…0001",
      test: { ok: true, skipped: false },
      account: {
        kind: "ds",
        label: "DeepSeek (이전 앱)",
        color: "teal",
        status: "ready",
        billing: "prepaid",
        connection: {
          type: "key",
          method: "legacy-key-linked",
          legacyKey: { app: "codex-multi-provider", providerRef: "legacy:deepseek", name: "DeepSeek" },
        },
      },
    })
    expect(await call(s.h.logins.keysExecute, { nonce: planned.output.nonce })).toMatchObject({
      ok: false,
      type: "nonce_invalid",
    })
    // The probe is the kind's connection test (02 §3.3): DeepSeek's balance, with the old app's key.
    const [probe] = chat.requests
    expect(probe).toMatchObject({ method: "GET", path: "/user/balance" })
    expect(probe?.headers.authorization).toBe(hashSecret(`Bearer ${KEY}`))

    const account = s.h.modules.slots.account(executed.output.account?.id ?? "")
    expect(account?.credential).toEqual({
      type: "linked-legacy-key",
      source: { app: "codex-multi-provider", providerRef: "legacy:deepseek", name: "DeepSeek", path: s.file },
      linkedAt: expect.any(String),
    })
    expect(account?.method).toBe("legacy-key-linked")
    expect(account?.identity.keyHint).toBe("sk-…0001")
    // Nothing of the key is stored on our side; the old file is unchanged.
    expect(await vaultIDs(s.h)).toEqual([])
    expect(await fs.readFile(s.file)).toEqual(before)
    const registry = await Bun.file(s.h.deps.runtime.layout.accounts).text()
    expect(registry).not.toContain(KEY)
    expect(s.h.logs.join("\n")).not.toContain(KEY)
    expect(JSON.stringify(s.h.events)).not.toContain(KEY)
    expect(s.h.events.map((event) => [event.name, event.payload.phase])).toContainEqual([
      "account.status",
      "imported_legacy_key",
    ])
  })

  test("requests carry the file's current key and follow the old app replacing it", async () => {
    await using s = await setup()
    const { account } = await link(s.h)
    expect(await headersOf(s.h, account)).toEqual({ authorization: `Bearer ${KEY}` })
    await replaceLegacyKey(s.file, NEXT)
    s.h.clock.advance(1_000)
    expect(await headersOf(s.h, account)).toEqual({ authorization: `Bearer ${NEXT}` })
    // A 401 makes the next use read the file again (here: still the same key).
    s.h.logins.unauthorized(account)
    expect(await headersOf(s.h, account)).toEqual({ authorization: `Bearer ${NEXT}` })
    expect(s.h.logs.join("\n")).not.toContain(NEXT)
  })

  test("a key already in use is duplicate_account, whether linked or stored in our vault", async () => {
    await using s = await setup()
    const { account } = await link(s.h)
    const again = await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })
    expect(again.ok && again.output.duplicateOf).toBe(account.id)
    if (!again.ok) throw new Error("plan failed")
    expect(await call(s.h.logins.keysExecute, { nonce: again.output.nonce })).toMatchObject({
      ok: false,
      type: "duplicate_account",
      data: { accountID: account.id },
    })

    await using other = await setup()
    const added = await call(other.h.logins.addKey, { kind: "ds", label: "직접 추가", key: KEY })
    if (!added.ok) throw new Error(`addKey failed: ${added.type}`)
    const planned = await call(other.h.logins.keysPlan, { providerRef: "legacy:deepseek" })
    expect(planned.ok && planned.output.duplicateOf).toBe(added.output.account.id)
  })

  test("a key the provider rejects is probe_failed and nothing is created", async () => {
    await using s = await setup({ key: "sk-fake-legacy-deepseek-unknown-99999" })
    const planned = await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })
    if (!planned.ok) throw new Error("plan failed")
    expect(await call(s.h.logins.keysExecute, { nonce: planned.output.nonce })).toMatchObject({
      ok: false,
      type: "probe_failed",
      data: { status: 401, message: "unauthorized" },
    })
    expect(s.h.modules.slots.snapshot().accounts).toEqual([])
  })

  test("a key the old app deleted before execute is legacy_key_not_found", async () => {
    await using s = await setup()
    const planned = await call(s.h.logins.keysPlan, { providerRef: "legacy:deepseek" })
    if (!planned.ok) throw new Error("plan failed")
    await fs.rm(s.file)
    s.h.clock.advance(1_000)
    expect(await call(s.h.logins.keysExecute, { nonce: planned.output.nonce })).toMatchObject({
      ok: false,
      type: "legacy_key_not_found",
    })
  })

  test("the manager registry's keys map to their kinds (OpenAI here)", async () => {
    await using s = await setup()
    await Bun.write(
      path.join(s.app.controlCenter, "providers.json"),
      JSON.stringify({
        version: 1,
        revision: 2,
        providers: [
          {
            id: OAI_PROVIDER,
            name: "OpenAI 회사",
            base_url: "https://api.openai.com/v1",
            protocol: "responses",
            credential_ref: `dpapi:${OAI_PROVIDER}`,
          },
        ],
        models: [{ provider_id: OAI_PROVIDER, wire_model_id: "no-such-model" }],
        history: [],
      }),
    )
    await sealKey(path.join(s.app.controlCenter, "credentials", `${OAI_PROVIDER}.dpapi`), OAI_KEY, "fake")
    const planned = await call(s.h.logins.keysPlan, { providerRef: `dpapi:${OAI_PROVIDER}` })
    expect(planned).toMatchObject({
      ok: true,
      output: {
        kind: "oai",
        label: "OpenAI 회사 (이전 앱)",
        model: "no-such-model",
        warnings: ["linked_key_depends_on_source", "model_not_in_template"],
      },
    })
    const { account } = await link(s.h, `dpapi:${OAI_PROVIDER}`)
    expect(account.kind).toBe("oai")
    expect(openai.requests[0]).toMatchObject({ path: "/v1/models" })
    expect(await headersOf(s.h, account)).toEqual({ authorization: `Bearer ${OAI_KEY}` })
  })
})

describe("linked key status and removal", () => {
  test("a deleted key file makes the account misconfigured; the key coming back makes it ready", async () => {
    await using s = await setup()
    const { account } = await link(s.h)
    await fs.rm(s.file)
    s.h.clock.advance(1_000)
    const failed = await s.h.logins.headers(account, "ses_1")
    expect(failed).toEqual({ ok: false, problem: "source_invalid", detail: "not_found" })
    await until(() => (s.h.modules.slots.account(account.id)?.status === "misconfigured" ? true : undefined))
    const announced = await until(() =>
      s.h.events.find((event) => event.name === "account.status" && event.payload.status === "misconfigured"),
    )
    expect(announced.payload).toMatchObject({ accountID: account.id, reason: "not_found" })
    // No codex stale alert for a key account.
    expect(s.h.alerts.filter((alert) => alert.code === "codex_source_stale")).toEqual([])
    const tested = await call(s.h.logins.test, { accountID: account.id })
    expect(tested).toMatchObject({ ok: true, output: { ok: false, status: "misconfigured" } })

    await sealKey(s.file, KEY, "fake")
    s.h.clock.advance(1_000)
    expect(await headersOf(s.h, account)).toEqual({ authorization: `Bearer ${KEY}` })
    await until(() => (s.h.modules.slots.account(account.id)?.status === "ready" ? true : undefined))
    const passed = await call(s.h.logins.test, { accountID: account.id })
    expect(passed).toMatchObject({ ok: true, output: { ok: true, status: "ready" } })
  })

  test("forget removes only our reference: no vault call, the old file stays", async () => {
    await using s = await setup()
    const { account } = await link(s.h)
    const before = await fs.readFile(s.file)
    expect(await s.h.logins.forget(account, { shred: true })).toEqual({ ok: true })
    expect(await fs.readFile(s.file)).toEqual(before)
    expect(await vaultIDs(s.h)).toEqual([])
  })
})

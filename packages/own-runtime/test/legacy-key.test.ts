// Linked API keys saved by the older codex-multi-provider app (02 §3.2b): the own-vault `linked.get` allowlist mirror,
// discovery of the old app's providers (never decrypting), the in-memory reader (cache by mtime+size, re-read on
// change, TTL and 401, drop a key the file no longer holds), and the Credentials integration. The old app's files are
// temp copies with FAKE keys, sealed with `Vault.fakeSeal` for the memory helper (the real DPAPI path is covered by
// own-vault's own tests and the own-accounts e2e). The real old-app directory is never read.

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { inspect } from "node:util"
import { Credential } from "@own/protocol"
import { Credentials, Hash, LegacyKey, Redact, Vault } from "../src/index.js"
import { account, clock, tmpdir } from "./fixture.js"

const SESSION_ID = "ses_2f7c0a1b2c3d4e5f6a7b8c9d0e"
const KEY_A = "sk-fake0000000000000000000000000000aaaa"
const KEY_B = "sk-fake1111111111111111111111111111bbbb"
const OAI_PROVIDER = "5f0c3a1e-7d2b-4c8e-9a6f-0b1c2d3e4f50"
const LAB_PROVIDER = "6a1d4b2f-8e3c-4d9f-8b7a-1c2d3e4f5061"
const CHAT_PROVIDER = "7b2e5c3a-9f4d-4e0a-9c8b-2d3e4f506172"

async function legacyRoot() {
  const dir = await tmpdir("own-legacy-key-")
  const app = path.join(dir.path, "codex-multi-provider")
  await fs.mkdir(path.join(app, "profiles"), { recursive: true })
  await fs.mkdir(path.join(app, "work", "control-center", "credentials"), { recursive: true })
  return { dir, app, [Symbol.asyncDispose]: () => dir[Symbol.asyncDispose]() }
}

async function writeKey(file: string, key: string, mtime?: Date) {
  await fs.writeFile(file, Vault.fakeSeal(key))
  if (mtime) await fs.utimes(file, mtime, mtime)
}

function setup(options: { readonly secretCacheSeconds?: number } = {}) {
  const time = clock()
  const memory = Vault.memory({ now: time.now })
  const vault = new Vault.Client(memory)
  const service = new Credentials.Service({ vault, now: time.now, secretCacheSeconds: options.secretCacheSeconds })
  return { time, memory, vault, service, reads: () => memory.calls.get("linked.get") ?? 0 }
}

function linkedAccount(kind: "anth" | "oai", file: string) {
  return account(kind, {
    credential: {
      type: "linked-legacy-key",
      source: { app: "codex-multi-provider", providerRef: "legacy:deepseek", name: "DeepSeek", path: file },
      linkedAt: "2026-09-28T00:00:00.000Z",
    },
  })
}

describe("own-vault linked.get allowlist (TS mirror of linked.rs check_path)", () => {
  test("accepts exactly the two old-app key locations", () => {
    for (const file of [
      "C:\\x\\codex-multi-provider\\profiles\\deepseek.dpapi",
      "D:\\#Projects\\codex-multi-provider\\profiles\\deepseek.dpapi",
      "d:\\#Projects\\Codex-Multi-Provider\\PROFILES\\DeepSeek.DPAPI",
      `C:\\a b\\codex-multi-provider\\work\\control-center\\credentials\\${OAI_PROVIDER}.dpapi`,
      "C:/x/codex-multi-provider/profiles/deepseek.dpapi",
    ])
      expect({ file, problem: Vault.linkedPathProblem(file) }).toEqual({ file, problem: undefined })
  })

  test("refuses everything else", () => {
    for (const file of [
      "",
      "codex-multi-provider\\profiles\\deepseek.dpapi",
      "\\codex-multi-provider\\profiles\\deepseek.dpapi",
      "C:codex-multi-provider\\profiles\\deepseek.dpapi",
      "\\\\server\\share\\codex-multi-provider\\profiles\\deepseek.dpapi",
      "\\\\?\\C:\\x\\codex-multi-provider\\profiles\\deepseek.dpapi",
      "C:\\x\\codex-multi-provider\\profiles\\..\\profiles\\deepseek.dpapi",
      "C:\\x\\codex-multi-provider\\profiles\\.\\deepseek.dpapi",
      "C:\\x\\\\codex-multi-provider\\profiles\\deepseek.dpapi",
      "C:\\x\\codex-multi-provider\\profiles\\deepseek.txt",
      "C:\\x\\codex-multi-provider\\profiles\\sub\\deepseek.dpapi",
      "C:\\x\\other-app\\profiles\\deepseek.dpapi",
      "C:\\x\\codex-multi-provider\\work\\control-center\\deepseek.dpapi",
      "C:\\x\\codex-multi-provider\\profiles\\deepseek.dpapi:stream",
      "C:\\x\\codex-multi-provider\\profiles\\deepseek.dpapi.",
      "C:\\x\\codex-multi-provider \\profiles\\deepseek.dpapi",
      "C:\\x\\codex-multi-provider\\profiles\\con.dpapi",
      "C:\\x\\codex-multi-provider\\wor\u212A\\control-center\\credentials\\k.dpapi",
      "C:\\Users\\me\\AppData\\Local\\own-open-code\\vault\\acc_01JAX3.dpapi",
      `C:\\${"a".repeat(1024)}\\codex-multi-provider\\profiles\\k.dpapi`,
    ])
      expect(Vault.linkedPathProblem(file)).toBeString()
  })

  test("the client refuses a denied path without asking the helper", async () => {
    const { vault, reads } = setup()
    expect(await vault.linkedGet("C:\\Windows\\System32\\drivers\\etc\\hosts")).toMatchObject({
      ok: false,
      error: "path_denied",
    })
    expect(reads()).toBe(0)
  })

  test("the memory helper reads fake-sealed files the way own-vault reads DPAPI ones", async () => {
    await using root = await legacyRoot()
    const { vault } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    expect(await vault.linkedGet(file)).toEqual({ ok: false, error: "not_found" })
    await writeKey(file, KEY_A, new Date(Date.UTC(2026, 8, 1)))
    expect(await vault.linkedGet(file)).toEqual({
      ok: true,
      value: KEY_A,
      size: Vault.fakeSeal(KEY_A).byteLength,
      mtimeMs: Date.UTC(2026, 8, 1),
    })
    expect(await fs.readFile(file, "utf8")).not.toContain(KEY_A)
    await fs.writeFile(file, "not a sealed key")
    expect(await vault.linkedGet(file)).toMatchObject({ ok: false, error: "decrypt_failed" })
    await fs.rm(file)
    await fs.mkdir(file)
    expect(await vault.linkedGet(file)).toMatchObject({ ok: false, error: "path_denied" })
    expect((await vault.hello()).ok && (await vault.hello())).toMatchObject({
      ops: expect.arrayContaining(["linked.get"]),
    })
  })
})

describe("LegacyKey.list (never decrypts)", () => {
  test("the old app's first DeepSeek connection: profiles\\provider.json + profiles\\deepseek.dpapi", async () => {
    await using root = await legacyRoot()
    await Bun.write(
      path.join(root.app, "profiles", "provider.json"),
      `\ufeff${JSON.stringify({ base_url: "https://api.deepseek.com", protocol: "responses", model: "deepseek-flash" })}`,
    )
    const listed = await LegacyKey.list(root.app)
    expect(listed.available).toBe(true)
    expect(listed.candidates).toHaveLength(1)
    const [deepseek] = listed.candidates
    expect(deepseek).toMatchObject({
      providerRef: "legacy:deepseek",
      name: "DeepSeek",
      kind: "ds",
      baseURL: "https://api.deepseek.com",
      models: [{ id: "deepseek-flash" }],
      keySaved: false,
      problem: "not_found",
    })
    await writeKey(path.join(root.app, "profiles", "deepseek.dpapi"), KEY_A)
    const again = await LegacyKey.list(root.app)
    expect(again.candidates[0]).toMatchObject({ keySaved: true })
    expect(again.candidates[0]?.problem).toBeUndefined()
    expect(again.candidates[0]?.source).toEqual({
      app: "codex-multi-provider",
      providerRef: "legacy:deepseek",
      name: "DeepSeek",
      path: path.join(root.app, "profiles", "deepseek.dpapi"),
    })
    expect(JSON.stringify(again)).not.toContain(KEY_A)
  })

  test("the manager registry work\\control-center\\providers.json wins, with kinds by API host", async () => {
    await using root = await legacyRoot()
    // A stale legacy file is ignored once the registry exists (the old app's own rule).
    await Bun.write(path.join(root.app, "profiles", "provider.json"), JSON.stringify({ base_url: "https://x.test" }))
    const credentials = path.join(root.app, "work", "control-center", "credentials")
    await writeKey(path.join(root.app, "profiles", "deepseek.dpapi"), KEY_A)
    await writeKey(path.join(credentials, `${OAI_PROVIDER}.dpapi`), KEY_B)
    await writeKey(path.join(credentials, `${CHAT_PROVIDER}.dpapi`), KEY_B)
    await writeKey(path.join(credentials, `${LAB_PROVIDER}.dpapi`), KEY_B)
    await Bun.write(
      path.join(root.app, "work", "control-center", "providers.json"),
      JSON.stringify({
        version: 1,
        revision: 4,
        providers: [
          {
            id: "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e",
            name: "DeepSeek",
            base_url: "https://api.deepseek.com",
            protocol: "responses",
            credential_ref: "legacy:deepseek",
            auth_type: "api_key",
          },
          {
            id: OAI_PROVIDER,
            name: "OpenAI 회사",
            base_url: "https://api.openai.com/v1",
            protocol: "responses",
            credential_ref: `dpapi:${OAI_PROVIDER}`,
          },
          {
            id: LAB_PROVIDER,
            name: "Lab",
            base_url: "https://lab.example.test/v1",
            protocol: "responses",
            credential_ref: `dpapi:${LAB_PROVIDER}`,
          },
          {
            id: CHAT_PROVIDER,
            name: "Chat",
            base_url: "https://chat.example.test/v1",
            protocol: "chat_completions",
            credential_ref: `dpapi:${CHAT_PROVIDER}`,
          },
          {
            id: "8c3f6d4b-0a5e-4f1b-8d9c-3e4f50617283",
            name: "Missing key",
            base_url: "https://api.x.ai/v1",
            protocol: "responses",
            credential_ref: "dpapi:8c3f6d4b-0a5e-4f1b-8d9c-3e4f50617283",
          },
          // Not a ref the old app would accept for this provider: never listed.
          { id: "9d4a7e5c-1b6f-4a2c-9e0d-4f5061728394", name: "Forged", credential_ref: `dpapi:${OAI_PROVIDER}` },
          { id: "not-a-uuid", name: "Broken", base_url: "https://api.openai.com/v1", credential_ref: "dpapi:../../x" },
        ],
        models: [
          { provider_id: OAI_PROVIDER, wire_model_id: "gpt-5.5", name: "GPT", capabilities: { verified: true } },
          { provider_id: CHAT_PROVIDER, wire_model_id: "chat-1", capabilities: { context_window: 131072 } },
        ],
        history: [],
      }),
    )
    const listed = await LegacyKey.list(root.app)
    expect(listed.available).toBe(true)
    const byRef = Object.fromEntries(listed.candidates.map((candidate) => [candidate.providerRef, candidate]))
    expect(Object.keys(byRef).sort()).toEqual(
      [
        "legacy:deepseek",
        `dpapi:${OAI_PROVIDER}`,
        `dpapi:${LAB_PROVIDER}`,
        `dpapi:${CHAT_PROVIDER}`,
        "dpapi:8c3f6d4b-0a5e-4f1b-8d9c-3e4f50617283",
      ].sort(),
    )
    expect(byRef["legacy:deepseek"]).toMatchObject({ kind: "ds", keySaved: true, models: [] })
    expect(byRef[`dpapi:${OAI_PROVIDER}`]).toMatchObject({
      name: "OpenAI 회사",
      kind: "oai",
      models: [{ id: "gpt-5.5" }],
      source: { path: path.join(credentials, `${OAI_PROVIDER}.dpapi`) },
    })
    expect(byRef[`dpapi:${LAB_PROVIDER}`]).toMatchObject({ problem: "unsupported_provider" })
    expect(byRef[`dpapi:${LAB_PROVIDER}`]?.kind).toBeUndefined()
    expect(byRef[`dpapi:${CHAT_PROVIDER}`]).toMatchObject({
      kind: "compat",
      models: [{ id: "chat-1", contextLimit: 131072 }],
    })
    for (const ref of ["legacy:deepseek", `dpapi:${OAI_PROVIDER}`, `dpapi:${CHAT_PROVIDER}`])
      expect({ ref, problem: byRef[ref]?.problem }).toEqual({ ref, problem: undefined })
    expect(byRef["dpapi:8c3f6d4b-0a5e-4f1b-8d9c-3e4f50617283"]).toMatchObject({
      kind: "xai",
      keySaved: false,
      problem: "not_found",
    })
  })

  test("nothing to list, and roots own-vault would refuse", async () => {
    await using root = await legacyRoot()
    expect(await LegacyKey.list(root.app)).toEqual({ available: false, candidates: [] })
    const other = path.join(root.dir.path, "other-app")
    await fs.mkdir(path.join(other, "profiles"), { recursive: true })
    await Bun.write(
      path.join(other, "profiles", "provider.json"),
      JSON.stringify({ base_url: "https://api.deepseek.com" }),
    )
    await writeKey(path.join(other, "profiles", "deepseek.dpapi"), KEY_A)
    expect((await LegacyKey.list(other)).candidates[0]).toMatchObject({ keySaved: true, problem: "path_denied" })
  })

  test("the old app root is found from the codex import control center", () => {
    expect(LegacyKey.appRootOf("D:\\#Projects\\codex-multi-provider\\work\\control-center")).toBe(
      path.resolve("D:\\#Projects\\codex-multi-provider"),
    )
    expect(LegacyKey.appRootOf("C:\\t\\Codex-Multi-Provider\\Work\\Control-Center\\")).toBe(
      path.resolve("C:\\t\\Codex-Multi-Provider"),
    )
    expect(LegacyKey.appRootOf("C:\\t\\legacy-control-center")).toBeUndefined()
    expect(LegacyKey.appRootOf("C:\\t\\other\\work\\control-center")).toBeUndefined()
    expect(LegacyKey.keyPath("C:\\a\\codex-multi-provider", `dpapi:${OAI_PROVIDER}`)).toBe(
      path.join("C:\\a\\codex-multi-provider", "work", "control-center", "credentials", `${OAI_PROVIDER}.dpapi`),
    )
  })

  test("kinds follow the official API hosts; other hosts only as compat Chat Completions", () => {
    expect(LegacyKey.kindOf("https://api.deepseek.com", "responses")).toBe("ds")
    expect(LegacyKey.kindOf("https://API.OpenAI.com/v1", null)).toBe("oai")
    expect(LegacyKey.kindOf("https://api.anthropic.com", "anthropic_messages")).toBe("anth")
    expect(LegacyKey.kindOf("https://api.x.ai/v1", "responses")).toBe("xai")
    expect(LegacyKey.kindOf("https://openrouter.ai/api/v1", "chat_completions")).toBe("or")
    expect(LegacyKey.kindOf("https://llm.example.test/v1", "chat_completions")).toBe("compat")
    expect(LegacyKey.kindOf("https://llm.example.test/v1", "responses")).toBeUndefined()
    expect(LegacyKey.kindOf("http://api.deepseek.com", "responses")).toBeUndefined()
    expect(LegacyKey.kindOf(null, "responses")).toBeUndefined()
  })
})

describe("LegacyKey.Reader", () => {
  test("keeps the key in memory by mtime+size; re-reads on change, TTL and 401 only", async () => {
    await using root = await legacyRoot()
    const { time, vault, reads } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    await writeKey(file, KEY_A, new Date(Date.UTC(2026, 8, 1)))
    const reader = new LegacyKey.Reader(file, { vault, now: time.now, ttlMs: 600_000 })

    const first = await reader.usable()
    expect(first.ok && first.snapshot.secret.key()).toBe(KEY_A)
    expect(reads()).toBe(1)
    await reader.usable()
    time.advance(5_000)
    await reader.usable()
    expect(reads()).toBe(1)

    // The old app replaced the key: the next stat sees the change and the helper decrypts the new file.
    await writeKey(file, KEY_B, new Date(Date.UTC(2026, 8, 2)))
    const within = await reader.usable()
    expect(within.ok && within.snapshot.secret.key()).toBe(KEY_A)
    time.advance(1_000)
    const changed = await reader.usable()
    expect(changed.ok && changed.snapshot.secret.key()).toBe(KEY_B)
    expect(reads()).toBe(2)

    reader.invalidate()
    await reader.usable()
    expect(reads()).toBe(3)
    time.advance(600_000)
    await reader.usable()
    expect(reads()).toBe(4)
    expect(reader.status()).toEqual({ keyHint: "sk-…bbbb", mtimeMs: Date.UTC(2026, 8, 2), problem: undefined })
  })

  test("a key the file no longer holds is dropped at once and never served again", async () => {
    await using root = await legacyRoot()
    const { time, vault } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    await writeKey(file, KEY_A)
    const reader = new LegacyKey.Reader(file, { vault, now: time.now })
    expect((await reader.usable()).ok).toBe(true)
    await fs.rm(file)
    time.advance(1_000)
    expect(await reader.usable()).toEqual({ ok: false, problem: "not_found" })
    expect(reader.status().keyHint).toBeUndefined()
    await fs.writeFile(file, "garbage")
    time.advance(1_000)
    expect(await reader.usable()).toEqual({ ok: false, problem: "decrypt_failed" })
    await writeKey(file, "  sk-fake with space  ")
    time.advance(1_000)
    expect(await reader.usable()).toEqual({ ok: false, problem: "invalid_key" })
    await writeKey(file, `\n${KEY_B}\r\n`)
    time.advance(1_000)
    const back = await reader.usable()
    expect(back.ok && back.snapshot.secret.key()).toBe(KEY_B)
  })

  test("concurrent uses share one read; an unreachable helper is vault_unavailable", async () => {
    await using root = await legacyRoot()
    const { time, memory, vault, reads } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    await writeKey(file, KEY_A)
    const reader = new LegacyKey.Reader(file, { vault, now: time.now })
    const results = await Promise.all([reader.usable(), reader.usable(), reader.usable()])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(reads()).toBe(1)
    const outdated = new LegacyKey.Reader(file, { vault, now: time.now })
    memory.inject((request) => (request.op === "linked.get" ? { ok: false, error: "unknown_op" } : undefined))
    expect(await outdated.usable()).toEqual({ ok: false, problem: "helper_outdated" })
    await memory.close()
    const closed = new LegacyKey.Reader(file, { vault, now: time.now })
    expect(await closed.usable()).toEqual({ ok: false, problem: "vault_unavailable" })
  })

  test("the key never shows in JSON, inspection or redacted logs", async () => {
    await using root = await legacyRoot()
    const { time, vault } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    await writeKey(file, KEY_A)
    const usable = await new LegacyKey.Reader(file, { vault, now: time.now }).usable()
    expect(JSON.stringify(usable)).not.toContain(KEY_A)
    expect(inspect(usable, { depth: 10 })).not.toContain(KEY_A)
    expect(Redact.text(`linked key ${KEY_A} failed`)).not.toContain(KEY_A)
    expect(JSON.stringify(Redact.value({ usable, header: `Bearer ${KEY_A}` }))).not.toContain(KEY_A)
    expect(Redact.findings({ value: KEY_A })).toEqual([{ path: "value", reason: "API key" }])
  })
})

describe("Credentials with a linked-legacy-key account", () => {
  test("injects the old app's current key per kind and follows the file", async () => {
    await using root = await legacyRoot()
    const { time, memory, service } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    await writeKey(file, KEY_A, new Date(Date.UTC(2026, 8, 1)))
    const oai = linkedAccount("oai", file)
    const first = await service.headersFor({ account: oai, sessionID: SESSION_ID })
    expect(first).toMatchObject({ ok: true, headers: { authorization: `Bearer ${KEY_A}` }, expiresAt: null })
    expect(first.ok && first.source).toBe("linked")
    const anth = await service.headersFor({ account: linkedAccount("anth", file), sessionID: SESSION_ID })
    expect(anth.ok && anth.headers).toEqual({ "x-api-key": KEY_A })
    const codex = account("codex", { credential: oai.credential })
    expect(await service.headersFor({ account: codex, sessionID: SESSION_ID })).toEqual({
      ok: false,
      problem: "kind_mismatch",
    })

    await writeKey(file, KEY_B, new Date(Date.UTC(2026, 8, 2)))
    time.advance(1_000)
    const second = await service.headersFor({ account: oai, sessionID: SESSION_ID })
    expect(second.ok && second.headers.authorization).toBe(`Bearer ${KEY_B}`)
    expect(await service.inspect(oai)).toEqual({
      source: "linked",
      ok: true,
      type: "key",
      expiresAt: null,
      keyHint: "sk-…bbbb",
    })
    // 401: the file is read again on the next use even though it did not change.
    const before = memory.calls.get("linked.get") ?? 0
    expect(service.unauthorized(oai)).toBe("reread_source")
    await service.headersFor({ account: oai, sessionID: SESSION_ID })
    expect(memory.calls.get("linked.get")).toBe(before + 1)
    expect(await service.refresh(oai, async () => ({ type: "failed", reason: "x" }) as never)).toEqual({
      type: "unavailable",
      reason: "linked_source",
    })
    expect(Credentials.linked(oai)).toBe(true)
    expect(Credentials.linked(account("oai"))).toBe(false)
  })

  test("a missing or unreadable file is source_invalid; removal forgets only our reference", async () => {
    await using root = await legacyRoot()
    const { time, memory, service } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    const oai = linkedAccount("oai", file)
    expect(await service.headersFor({ account: oai, sessionID: SESSION_ID })).toEqual({
      ok: false,
      problem: "source_invalid",
      detail: "not_found",
    })
    await writeKey(file, KEY_A)
    const bytes = await fs.readFile(file)
    // A failed file is not read again within the stat interval.
    expect(await service.prefetch(oai)).toBe(false)
    time.advance(1_000)
    expect(await service.prefetch(oai)).toBe(true)
    expect(await service.remove(oai, { shred: true })).toEqual({ ok: true, deleted: false })
    expect(memory.calls.get("delete")).toBeUndefined()
    expect(await fs.readFile(file)).toEqual(bytes)
    expect(memory.snapshot().ids).toEqual([])
  })

  test("legacyAuth gives headers, hint and header hash for an import, never the key", async () => {
    await using root = await legacyRoot()
    const { service } = setup()
    const file = path.join(root.app, "profiles", "deepseek.dpapi")
    await writeKey(file, KEY_A)
    const source = Credential.LegacyKeySource.make({
      app: "codex-multi-provider",
      providerRef: "legacy:deepseek",
      name: "DeepSeek",
      path: file,
    })
    const read = await service.legacyAuth(source, "ds")
    expect(read).toEqual({
      ok: true,
      headers: { authorization: `Bearer ${KEY_A}` },
      hash: Hash.auth(Credentials.keyHeaders("ds", KEY_A))[0]?.hash ?? "",
      keyHint: "sk-…aaaa",
    })
    await fs.rm(file)
    expect(await service.legacyAuth(source, "ds")).toEqual({ ok: false, problem: "not_found" })
  })
})

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { inspect } from "node:util"
import { Credential, SearchKey, Voice } from "@own/protocol"
import { CodexSource, Credentials, Hash, Refresh, Vault } from "../src/index.js"
import {
  ACCOUNT_A,
  ACCOUNT_B,
  account,
  ANTH_ID,
  chatgptTokens,
  clock,
  CODEX_ID,
  OAI_ID,
  SHARING_CLIENT,
  SHARING_SCOPES,
  sharingTokens,
  SIWC_ID,
  tmpdir,
  writeAuth,
} from "./fixture.js"

const SESSION = "ses_2f7c0a1b2c3d4e5f6a7b8c9d0e"
const HOUR = 3_600_000

function setup(options: { readonly secretCacheSeconds?: number } = {}) {
  const time = clock()
  const memory = Vault.memory({ now: time.now })
  const vault = new Vault.Client(memory)
  const injected: Array<[string, string, string]> = []
  const service = new Credentials.Service({
    vault,
    now: time.now,
    secretCacheSeconds: options.secretCacheSeconds,
    onInjected: (sessionID, providerID, hash) => injected.push([sessionID, providerID, hash]),
    refresh: { pollMs: [1, 5], waitMs: 200, backoffMs: [30_000, 120_000] },
  })
  return { time, memory, vault, service, injected }
}

function oauth(expiresAt: number, generation = 1): Credential.OAuthSecret {
  const tokens = chatgptTokens(ACCOUNT_A, expiresAt)
  return {
    v: 1,
    type: "oauth",
    family: "openai-chatgpt",
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    idToken: tokens.idToken,
    expiresAt,
    obtainedAt: expiresAt - HOUR,
    generation,
  }
}

/** A refresher that counts calls and mints new fake tokens. */
function refresher(time: ReturnType<typeof clock>, outcome?: Refresh.Outcome) {
  const calls: Credential.OAuthSecret[] = []
  const run: Refresh.Refresher = async (current) => {
    calls.push(current)
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (outcome) return outcome
    const next = chatgptTokens(ACCOUNT_A, time.now() + HOUR)
    return { type: "tokens", access: next.accessToken, refresh: next.refreshToken, expiresAt: time.now() + HOUR }
  }
  return { calls, run }
}

describe("Credentials.Service with vault items", () => {
  test("builds the 02 §4.1 headers per kind and records the injected hash", async () => {
    const { time, service, injected } = setup()
    expect(await service.store(ANTH_ID, { type: "key", key: "sk-ant-fake-anthropic-key-0001" })).toEqual({
      ok: true,
      generation: 1,
    })
    expect(await service.store(OAI_ID, { type: "key", key: "sk-fake-openai-key-0001" })).toEqual({
      ok: true,
      generation: 1,
    })
    const item = oauth(time.now() + HOUR)
    await service.store(CODEX_ID, item)

    const anth = await service.headersFor({ account: account("anth"), sessionID: SESSION })
    expect(anth).toMatchObject({
      ok: true,
      headers: { "x-api-key": "sk-ant-fake-anthropic-key-0001" },
      expiresAt: null,
    })
    const oai = await service.headersFor({ account: account("oai"), sessionID: SESSION })
    expect(oai).toMatchObject({ ok: true, headers: { authorization: "Bearer sk-fake-openai-key-0001" } })
    const codex = await service.headersFor({ account: account("codex"), sessionID: SESSION })
    expect(codex).toEqual({
      ok: true,
      headers: {
        authorization: `Bearer ${item.access}`,
        "chatgpt-account-id": ACCOUNT_A.accountId,
        "session-id": SESSION,
        originator: "opencode",
      },
      hash: Hash.short(`Bearer ${item.access}`),
      expiresAt: item.expiresAt,
      source: "vault",
    })
    expect(injected).toEqual([
      [SESSION, "own-anth-w3p8", Hash.short("sk-ant-fake-anthropic-key-0001")],
      [SESSION, "own-oai-q9x1", Hash.short("Bearer sk-fake-openai-key-0001")],
      [SESSION, "own-codex-7k2m", Hash.short(`Bearer ${item.access}`)],
    ])
  })

  test("the hot path reads the cache: one helper get per account while the TTL lasts", async () => {
    const { time, memory, service } = setup()
    // Written behind the service's back, as by another process: nothing is cached yet.
    memory.handle({
      op: "put",
      id: ANTH_ID,
      value: JSON.stringify({ v: 1, type: "key", key: "fake-key", generation: 1 }),
    })
    const before = memory.calls.get("get") ?? 0
    await Promise.all(
      Array.from({ length: 10 }, () => service.headersFor({ account: account("anth"), sessionID: SESSION })),
    )
    expect((memory.calls.get("get") ?? 0) - before).toBe(1)
    time.advance(600_000)
    await service.headersFor({ account: account("anth"), sessionID: SESSION })
    expect((memory.calls.get("get") ?? 0) - before).toBe(2)
  })

  test("reports missing, broken and mismatched credentials instead of throwing", async () => {
    const { time, memory, service } = setup()
    expect(await service.headersFor({ account: account("anth"), sessionID: SESSION })).toEqual({
      ok: false,
      problem: "not_found",
      hasPrev: false,
    })
    memory.plant(ANTH_ID, "not a vault item")
    expect(await service.headersFor({ account: account("anth"), sessionID: SESSION })).toMatchObject({
      problem: "corrupt",
    })
    await service.store(ANTH_ID, oauth(time.now() + HOUR))
    expect(await service.headersFor({ account: account("anth"), sessionID: SESSION })).toMatchObject({
      problem: "kind_mismatch",
    })
    await service.store(CODEX_ID, { type: "key", key: "fake" })
    expect(await service.headersFor({ account: account("codex"), sessionID: SESSION })).toMatchObject({
      problem: "kind_mismatch",
    })
    await service.store(CODEX_ID, oauth(time.now() + HOUR))
    expect(await service.headersFor({ account: account("codex", { identity: {} }), sessionID: SESSION })).toMatchObject(
      {
        problem: "identity_missing",
      },
    )
    memory.inject(() => ({ ok: false, error: "busy" }))
    service.configure({ secretCacheSeconds: 0 })
    expect(await service.headersFor({ account: account("oai"), sessionID: SESSION })).toMatchObject({
      problem: "vault_unavailable",
    })
    await memory.close()
    expect(await service.headersFor({ account: account("oai"), sessionID: SESSION })).toMatchObject({
      problem: "vault_unavailable",
    })
  })

  test("store assigns increasing generations and keepPrev keeps the replaced secret", async () => {
    const { memory, service } = setup()
    await service.store(ANTH_ID, { type: "key", key: "first-fake-key-0001" })
    expect(await service.store(ANTH_ID, { type: "key", key: "second-fake-key-0002" }, { keepPrev: true })).toEqual({
      ok: true,
      generation: 2,
    })
    expect(memory.snapshot().prev).toEqual([ANTH_ID])
    expect(await service.inspect(account("anth"))).toEqual({
      source: "vault",
      ok: true,
      type: "key",
      generation: 2,
      expiresAt: null,
      keyHint: "…0002",
    })
    expect(await service.restorePrevious(ANTH_ID)).toEqual({ ok: true, generation: 3 })
    const restored = await service.headersFor({ account: account("anth"), sessionID: SESSION })
    expect(restored.ok && restored.headers["x-api-key"]).toBe("first-fake-key-0001")
  })

  test("OAuth .prev is only restored with explicit confirmation", async () => {
    const { time, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + HOUR))
    await service.store(CODEX_ID, oauth(time.now() + 2 * HOUR), { keepPrev: true })
    expect(await service.restorePrevious(CODEX_ID)).toMatchObject({
      ok: false,
      detail: "oauth_restore_needs_confirmation",
    })
    expect(await service.restorePrevious(CODEX_ID, { allowOAuth: true })).toEqual({ ok: true, generation: 3 })
  })

  test("remove shreds the vault item and forgets the cache", async () => {
    const { memory, service } = setup()
    await service.store(ANTH_ID, { type: "key", key: "fake" }, { keepPrev: true })
    expect(await service.remove(account("anth"))).toEqual({ ok: true, deleted: true })
    expect(memory.snapshot().ids).toEqual([])
    expect(await service.headersFor({ account: account("anth"), sessionID: SESSION })).toMatchObject({
      problem: "not_found",
    })
  })
})

describe("Feature keys (voice 02 §3.9, web search 02 §9.2)", () => {
  // Every feature key the app keeps: Brave's, the five keyed web search services' and voice input's.
  const FEATURES = [...SearchKey.Service.literals.map(SearchKey.keyID), ...Voice.Provider.literals.map(Voice.keyID)]

  /**
   * A vault whose answers to one op wait for `release`, to overlap a key's reads with its removal: a held `get` reads
   * the vault when it is asked and answers late (a read already under way), a held `delete` runs late (a removal
   * under way).
   */
  function slowVault() {
    const memory = Vault.memory()
    const held: Array<() => void> = []
    const state: { op?: "get" | "delete" } = {}
    const transport: Vault.Transport = {
      request: (message) => {
        if (message.op !== state.op) return memory.request(message)
        const read = message.op === "get" ? memory.handle(message) : undefined
        return new Promise((resolve) => held.push(() => resolve(read ?? memory.handle(message))))
      },
      close: () => memory.close(),
    }
    const service = new Credentials.Service({ vault: new Vault.Client(transport) })
    return {
      service,
      plant: (id: string, key: string) =>
        memory.handle({ op: "put", id, value: JSON.stringify({ v: 1, type: "key", key, generation: 1 }) }),
      hold: (op: "get" | "delete") => {
        state.op = op
      },
      /** Waits until a request of the held op came in. */
      asked: async () => {
        for (let tries = 0; tries < 200 && held.length === 0; tries++) await Bun.sleep(1)
        expect(held.length).toBeGreaterThan(0)
      },
      release: () => {
        state.op = undefined
        for (const answer of held.splice(0)) answer()
      },
    }
  }

  for (const id of FEATURES)
    test(`${id}: a read that overlaps the removal never brings the removed key back`, async () => {
      const key = `fake-${id}-key-0001`

      // A read already under way when the key is removed: it found the key, its answer comes after the removal.
      const before = slowVault()
      before.plant(id, key)
      before.hold("get")
      const reading = before.service.featureHeaders(id, "Bearer")
      await before.asked()
      expect(await before.service.removeFeatureKey(id)).toEqual({ ok: true, deleted: true })
      // Asked once the key is gone: never the read still under way.
      const after = before.service.inspectFeatureKey(id)
      await Bun.sleep(5)
      before.release()
      expect(await reading).toMatchObject({ ok: true })
      expect(await after).toEqual({ configured: false })
      expect(await before.service.inspectFeatureKey(id)).toEqual({ configured: false })
      expect(await before.service.featureHeaders(id, "Bearer")).toMatchObject({ problem: "not_found" })

      // A read that starts while the delete runs still finds the key; the removal must not leave it cached.
      const during = slowVault()
      during.plant(id, key)
      during.hold("delete")
      const removing = during.service.removeFeatureKey(id)
      await during.asked()
      expect(await during.service.featureHeaders(id, "Bearer")).toMatchObject({ ok: true })
      during.release()
      expect(await removing).toEqual({ ok: true, deleted: true })
      expect(await during.service.inspectFeatureKey(id)).toEqual({ configured: false })
      expect(await during.service.featureHeaders(id, "Bearer")).toMatchObject({ problem: "not_found" })
    })
})

describe("OAuth refresh (02 §3.5)", () => {
  test("a due token is refreshed once for many concurrent requests and persisted before use", async () => {
    const { time, memory, service } = setup()
    const item = oauth(time.now() + 60_000)
    await service.store(CODEX_ID, item)
    const refresh = refresher(time)
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run }),
      ),
    )
    expect(refresh.calls).toHaveLength(1)
    expect(refresh.calls[0]?.refresh).toBe(item.refresh)
    const headers = new Set(results.map((result) => result.ok && result.headers.authorization))
    expect(headers.size).toBe(1)
    expect([...headers][0]).not.toBe(`Bearer ${item.access}`)
    expect(memory.snapshot()).toMatchObject({ ids: [CODEX_ID], prev: [CODEX_ID], leases: {} })
    const stored = JSON.parse(memory.handle({ op: "get", id: CODEX_ID }).value as string)
    expect(stored).toMatchObject({ generation: 2, obtainedAt: time.now(), idToken: item.idToken })
    expect(`Bearer ${stored.access}`).toBe([...headers][0] as string)
  })

  test("a token that is not due is used without a refresh; without a refresher an expired token fails", async () => {
    const { time, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + HOUR))
    const refresh = refresher(time)
    expect(
      (await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run })).ok,
    ).toBe(true)
    expect(refresh.calls).toHaveLength(0)
    time.advance(2 * HOUR)
    expect(await service.headersFor({ account: account("codex"), sessionID: SESSION })).toMatchObject({
      problem: "expired",
    })
  })

  test("a 401 refreshes once on the next use even when not due", async () => {
    const { time, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + HOUR))
    const refresh = refresher(time)
    const first = await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run })
    expect(service.unauthorized(account("codex"))).toBe("refresh_next")
    const second = await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run })
    const third = await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run })
    expect(refresh.calls).toHaveLength(1)
    expect(second.ok && first.ok && second.headers.authorization !== first.headers.authorization).toBe(true)
    expect(third).toEqual(second)
    expect(service.unauthorized(account("anth"))).toBe("none")
  })

  test("a 401 refresh also works with the secret cache disabled", async () => {
    const { time, service } = setup({ secretCacheSeconds: 0 })
    await service.store(CODEX_ID, oauth(time.now() + HOUR))
    const refresh = refresher(time)
    await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run })
    expect(service.unauthorized(account("codex"))).toBe("refresh_next")
    await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run })
    expect(refresh.calls).toHaveLength(1)
  })

  test("permanent failures need re-auth; transient ones back off while the token is still valid", async () => {
    const { time, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + 60_000))
    const transient = refresher(time, { type: "transient", reason: "http_503" })
    const kept = await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: transient.run })
    expect(kept.ok).toBe(true)
    await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: transient.run })
    expect(transient.calls).toHaveLength(1)
    time.advance(90_000)
    expect(
      await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: transient.run }),
    ).toMatchObject({
      ok: false,
      problem: "refresh_backoff",
      detail: "http_503",
    })
    // The second transient failure doubled the backoff to 60 s.
    time.advance(60_000)
    const dead = refresher(time, { type: "permanent", reason: "refresh_token_reused" })
    expect(await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: dead.run })).toEqual({
      ok: false,
      problem: "needs_reauth",
      detail: "refresh_token_reused",
    })
    // A dead family is never sent to the token endpoint again (02 §3.5 F5), not even by a forced refresh.
    expect(await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: dead.run })).toEqual({
      ok: false,
      problem: "needs_reauth",
      detail: "refresh_token_reused",
    })
    expect(await service.refresh(account("codex"), dead.run, { force: true })).toEqual({
      type: "needs_reauth",
      reason: "refresh_token_reused",
    })
    expect(dead.calls).toHaveLength(1)
    // A new login stores a newer generation, which refreshes normally again.
    await service.store(CODEX_ID, oauth(time.now() + 60_000), { keepPrev: true })
    const alive = refresher(time)
    expect((await service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: alive.run })).ok).toBe(
      true,
    )
    expect(alive.calls).toHaveLength(1)
  })

  test("waits for another process's lease and uses the tokens it stored", async () => {
    const { time, memory, vault, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + 60_000))
    const lease = await vault.acquireLease(CODEX_ID, { pid: 999_999 })
    if (!lease.ok || !lease.lease) throw new Error("lease expected")
    const refresh = refresher(time)
    const pending = service.headersFor({ account: account("codex"), sessionID: SESSION, refresher: refresh.run })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const other = oauth(time.now() + HOUR, 2)
    await vault.put(CODEX_ID, JSON.stringify(other), { keepPrev: true, ifGeneration: 1 })
    const result = await pending
    expect(result.ok && result.headers.authorization).toBe(`Bearer ${other.access}`)
    expect(refresh.calls).toHaveLength(0)
    expect(memory.snapshot().leases).toMatchObject({ [CODEX_ID]: { pid: 999_999 } })
  })

  test("gives up waiting for a live lease that never changes", async () => {
    const { time, vault, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + 30_000))
    await vault.acquireLease(CODEX_ID, { pid: 999_999 })
    const refresh = refresher(time)
    const result = await service.refresh(account("codex"), refresh.run, { force: true })
    expect(result).toEqual({ type: "unavailable", reason: "lease_timeout" })
    expect(refresh.calls).toHaveLength(0)
  })

  test("a write outside the lease wins over our refresh, and a failed persist kills the family", async () => {
    const { time, memory, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + 60_000))
    const concurrent = oauth(time.now() + HOUR, 5)
    const sneaky: Refresh.Refresher = async () => {
      memory.plant(CODEX_ID, JSON.stringify(concurrent))
      return { type: "tokens", access: "fake-new", refresh: "fake-new-refresh", expiresAt: time.now() + HOUR }
    }
    expect(await service.refresh(account("codex"), sneaky, { force: true })).toEqual({
      type: "current",
      generation: 5,
      expiresAt: concurrent.expiresAt,
    })
    memory.inject((request) =>
      request.op === "put" ? { ok: false, error: "io_error", message: "disk full" } : undefined,
    )
    const lost = await service.refresh(account("codex"), refresher(time).run, { force: true })
    expect(lost).toEqual({ type: "needs_reauth", reason: "persist_failed:io_error" })
  })

  test("refresh reports without token values", async () => {
    const { time, service } = setup()
    await service.store(CODEX_ID, oauth(time.now() + HOUR))
    const refresh = refresher(time)
    expect(await service.refresh(account("codex"), refresh.run)).toMatchObject({ type: "current", generation: 1 })
    const forced = await service.refresh(account("codex"), refresh.run, { force: true })
    expect(forced).toMatchObject({ type: "refreshed", generation: 2 })
    expect(Object.keys(forced).sort()).toEqual(["expiresAt", "generation", "type"])
    expect(await service.refresh(account("anth"), refresh.run)).toMatchObject({ type: "unavailable" })
  })
})

describe("Sign in with ChatGPT token sharing (siwc)", () => {
  function sharing(expiresAt: number, patch: Partial<Credential.OAuthSecret> = {}): Credential.OAuthSecret {
    const tokens = sharingTokens(ACCOUNT_A, expiresAt)
    return {
      v: 1,
      type: "oauth",
      family: "openai-chatgpt-sharing",
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt,
      obtainedAt: expiresAt - HOUR,
      generation: 1,
      clientId: SHARING_CLIENT,
      scopes: SHARING_SCOPES,
      ...patch,
    }
  }

  /** A token-sharing refresher: rotates the pair and reports only what the response carried. */
  function sharingRefresher(
    time: ReturnType<typeof clock>,
    extra: Partial<Extract<Refresh.Outcome, { type: "tokens" }>> = {},
  ) {
    const calls: Credential.OAuthSecret[] = []
    const run: Refresh.Refresher = async (current) => {
      calls.push(current)
      await new Promise((resolve) => setTimeout(resolve, 5))
      const next = sharingTokens(ACCOUNT_A, time.now() + HOUR, current.clientId)
      return {
        type: "tokens",
        access: next.accessToken,
        refresh: next.refreshToken,
        expiresAt: time.now() + HOUR,
        ...extra,
      }
    }
    return { calls, run }
  }

  function stored(memory: ReturnType<typeof setup>["memory"], id: string) {
    return JSON.parse(memory.handle({ op: "get", id }).value as string)
  }

  test("headers are Bearer only: no account id, session id or originator, and no ChatGPT account id needed", async () => {
    const { time, service, injected } = setup()
    const item = sharing(time.now() + HOUR)
    await service.store(SIWC_ID, item)
    const siwc = account("siwc")
    expect(siwc.identity.chatgptAccountId).toBeUndefined()
    expect(await service.headersFor({ account: siwc, sessionID: SESSION })).toEqual({
      ok: true,
      headers: { authorization: `Bearer ${item.access}` },
      hash: Hash.short(`Bearer ${item.access}`),
      expiresAt: item.expiresAt,
      source: "vault",
    })
    expect(injected).toEqual([[SESSION, "own-siwc-r4t6", Hash.short(`Bearer ${item.access}`)]])
  })

  test("an item of the other token family, a key or a linked old-app key is a kind mismatch", async () => {
    const { time, memory, service } = setup()
    // A Codex-style item under a siwc account, and a sharing item under a codex account.
    await service.store(SIWC_ID, oauth(time.now() + HOUR))
    expect(await service.headersFor({ account: account("siwc"), sessionID: SESSION })).toEqual({
      ok: false,
      problem: "kind_mismatch",
    })
    await service.store(CODEX_ID, sharing(time.now() + HOUR))
    expect(await service.headersFor({ account: account("codex"), sessionID: SESSION })).toEqual({
      ok: false,
      problem: "kind_mismatch",
    })
    await service.store(OAI_ID, sharing(time.now() + HOUR))
    expect(await service.headersFor({ account: account("oai"), sessionID: SESSION })).toMatchObject({
      problem: "kind_mismatch",
    })
    await service.store(SIWC_ID, { type: "key", key: "sk-fake-openai-key-0001" }, { keepPrev: true })
    expect(await service.headersFor({ account: account("siwc"), sessionID: SESSION })).toMatchObject({
      problem: "kind_mismatch",
    })
    const legacy = account("siwc", {
      credential: {
        type: "linked-legacy-key",
        source: {
          app: "codex-multi-provider",
          providerRef: "legacy:deepseek",
          name: "DeepSeek",
          path: "C:\\fake\\profiles\\deepseek.dpapi",
        },
        linkedAt: "2026-09-27T03:00:00Z",
      },
    })
    const before = memory.calls.get("linked.get") ?? 0
    expect(await service.headersFor({ account: legacy, sessionID: SESSION })).toEqual({
      ok: false,
      problem: "kind_mismatch",
    })
    expect(memory.calls.get("linked.get") ?? 0).toBe(before)
  })

  test("store writes the family and token-sharing metadata; inspect shows the client id and no token", async () => {
    const { time, memory, service } = setup()
    const tokens = sharingTokens(ACCOUNT_A, time.now() + HOUR)
    expect(
      await service.store(SIWC_ID, {
        type: "oauth",
        family: "openai-chatgpt-sharing",
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresAt: time.now() + HOUR,
        clientId: SHARING_CLIENT,
        scopes: SHARING_SCOPES,
        earliestRefreshAt: time.now() + 600_000,
      }),
    ).toEqual({ ok: true, generation: 1 })
    expect(stored(memory, SIWC_ID)).toEqual({
      v: 1,
      type: "oauth",
      family: "openai-chatgpt-sharing",
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: time.now() + HOUR,
      obtainedAt: time.now(),
      generation: 1,
      clientId: SHARING_CLIENT,
      scopes: SHARING_SCOPES,
      earliestRefreshAt: time.now() + 600_000,
    })
    const inspection = await service.inspect(account("siwc"))
    expect(inspection).toEqual({
      source: "vault",
      ok: true,
      type: "oauth",
      generation: 1,
      expiresAt: time.now() + HOUR,
      clientId: SHARING_CLIENT,
    })
    const shown = JSON.stringify(inspection) + inspect(inspection)
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.idToken]) expect(shown).not.toContain(secret)
    // A Codex-style login stores the default family and no sharing metadata.
    const codex = chatgptTokens(ACCOUNT_A, time.now() + HOUR)
    await service.store(CODEX_ID, {
      type: "oauth",
      access: codex.accessToken,
      refresh: codex.refreshToken,
      expiresAt: time.now() + HOUR,
    })
    const codexItem = stored(memory, CODEX_ID)
    expect(codexItem.family).toBe("openai-chatgpt")
    expect(Object.keys(codexItem)).not.toContain("clientId")
    expect((await service.inspect(account("codex"))).clientId).toBeUndefined()
  })

  test("a due token is refreshed once for many concurrent requests and keeps family, client id and scopes", async () => {
    const { time, memory, service } = setup()
    const item = sharing(time.now() + 60_000, { earliestRefreshAt: time.now() - 1_000 })
    await service.store(SIWC_ID, item)
    const refresh = sharingRefresher(time, { earliestRefreshAt: time.now() + 1_800_000 })
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: refresh.run }),
      ),
    )
    expect(refresh.calls).toHaveLength(1)
    expect(refresh.calls[0]).toMatchObject({ refresh: item.refresh, clientId: SHARING_CLIENT })
    const headers = new Set(results.map((result) => result.ok && JSON.stringify(result.headers)))
    expect(headers.size).toBe(1)
    const next = stored(memory, SIWC_ID)
    expect(JSON.parse([...headers][0] as string)).toEqual({ authorization: `Bearer ${next.access}` })
    expect(next).toMatchObject({
      family: "openai-chatgpt-sharing",
      clientId: SHARING_CLIENT,
      scopes: SHARING_SCOPES,
      idToken: item.idToken,
      earliestRefreshAt: time.now() + 1_800_000,
      generation: 2,
    })
    expect(next.refresh).not.toBe(item.refresh)
    expect(memory.snapshot()).toMatchObject({ prev: [SIWC_ID], leases: {} })
  })

  test("a refresh replaces scopes and id token when the response has them and drops an unrepeated earliest time", async () => {
    const { time, memory, service } = setup()
    await service.store(SIWC_ID, sharing(time.now() + 60_000))
    const idToken = sharingTokens(ACCOUNT_A, time.now() + 2 * HOUR).idToken
    const narrowed = ["openid", "offline_access"]
    const first = sharingRefresher(time, { scopes: narrowed, idToken, earliestRefreshAt: time.now() + 900_000 })
    expect(await service.refresh(account("siwc"), first.run)).toMatchObject({ type: "refreshed", generation: 2 })
    expect(stored(memory, SIWC_ID)).toMatchObject({
      scopes: narrowed,
      idToken,
      earliestRefreshAt: time.now() + 900_000,
    })
    // The 401 path refreshes before the earliest time; tokens without `earliest_refresh_at` carry no limit.
    await service.headersFor({ account: account("siwc"), sessionID: SESSION })
    expect(service.unauthorized(account("siwc"))).toBe("refresh_next")
    const second = sharingRefresher(time)
    expect((await service.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: second.run })).ok).toBe(
      true,
    )
    expect(second.calls).toHaveLength(1)
    const next = stored(memory, SIWC_ID)
    expect(next).toMatchObject({ generation: 3, scopes: narrowed, clientId: SHARING_CLIENT, idToken })
    expect(Object.keys(next)).not.toContain("earliestRefreshAt")
  })

  test("earliest_refresh_at holds back a due refresh; the current token is used until then", async () => {
    const { time, service } = setup()
    const item = sharing(time.now() + 120_000, { earliestRefreshAt: time.now() + 60_000 })
    await service.store(SIWC_ID, item)
    const refresh = sharingRefresher(time)
    const held = await service.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: refresh.run })
    expect(held.ok && held.headers.authorization).toBe(`Bearer ${item.access}`)
    expect(await service.refresh(account("siwc"), refresh.run)).toEqual({
      type: "current",
      generation: 1,
      expiresAt: item.expiresAt,
    })
    expect(refresh.calls).toHaveLength(0)
    time.advance(60_000)
    const refreshed = await service.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: refresh.run })
    expect(refresh.calls).toHaveLength(1)
    expect(refreshed.ok && refreshed.headers.authorization).not.toBe(`Bearer ${item.access}`)
  })

  test("even a forced refresh waits for the earliest time while the token works", async () => {
    const { time, service } = setup()
    const item = sharing(time.now() + 120_000, { earliestRefreshAt: time.now() + 60_000 })
    await service.store(SIWC_ID, item)
    const refresh = sharingRefresher(time)
    expect(await service.refresh(account("siwc"), refresh.run, { force: true })).toEqual({
      type: "deferred",
      until: time.now() + 60_000,
      generation: 1,
      expiresAt: item.expiresAt,
    })
    expect(refresh.calls).toHaveLength(0)
    time.advance(60_000)
    expect(await service.refresh(account("siwc"), refresh.run, { force: true })).toMatchObject({
      type: "refreshed",
      generation: 2,
    })
    expect(refresh.calls).toHaveLength(1)
  })

  test("an expired token refreshes before the earliest time, also right after a restart", async () => {
    const { time, vault, service } = setup()
    await service.store(SIWC_ID, sharing(time.now() + 30_000, { earliestRefreshAt: time.now() + 600_000 }))
    time.advance(40_000)
    // A new process: nothing was served, so no 401 can force the refresh.
    const restarted = new Credentials.Service({ vault, now: time.now, refresh: { pollMs: [1, 5], waitMs: 200 } })
    expect(restarted.unauthorized(account("siwc"))).toBe("none")
    const refresh = sharingRefresher(time)
    const result = await restarted.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: refresh.run })
    expect(result.ok).toBe(true)
    expect(refresh.calls).toHaveLength(1)
    expect(await restarted.inspect(account("siwc"))).toMatchObject({ generation: 2, expiresAt: time.now() + HOUR })
  })

  test("an earliest time at or after the token's expiry never holds back a refresh", async () => {
    const { time, service } = setup()
    // Epoch milliseconds read as seconds: about 56,000 years ahead.
    const misread = Refresh.earliestOf(time.now() + 55 * 60_000)
    await service.store(SIWC_ID, sharing(time.now() + 120_000, { earliestRefreshAt: misread }))
    const refresh = sharingRefresher(time)
    expect(
      (await service.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: refresh.run })).ok,
    ).toBe(true)
    expect(refresh.calls).toHaveLength(1)
  })

  test("a permanent refresh failure needs re-auth and the family is not retried", async () => {
    const { time, service } = setup()
    await service.store(SIWC_ID, sharing(time.now() + 60_000))
    const dead = refresher(time, { type: "permanent", reason: "invalid_grant" })
    const failure = { ok: false, problem: "needs_reauth", detail: "invalid_grant" } as const
    expect(await service.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: dead.run })).toEqual(
      failure,
    )
    expect(await service.headersFor({ account: account("siwc"), sessionID: SESSION, refresher: dead.run })).toEqual(
      failure,
    )
    expect(dead.calls).toHaveLength(1)
  })

  test("a rejected login answers needs_reauth on every use until a new login stores newer tokens", async () => {
    const { time, service } = setup()
    const siwc = account("siwc")
    const refreshing = sharingRefresher(time)
    // Nothing served yet: there is no generation to reject.
    expect(service.reject(siwc, "subscription_sharing_invalid_user")).toBe(false)
    await service.store(SIWC_ID, sharing(time.now() + HOUR))
    expect((await service.headersFor({ account: siwc, sessionID: SESSION, refresher: refreshing.run })).ok).toBe(true)
    expect(service.reject(siwc, "subscription_sharing_invalid_user")).toBe(true)
    const failure = { ok: false, problem: "needs_reauth", detail: "subscription_sharing_invalid_user" } as const
    for (const _ of [1, 2])
      expect(await service.headersFor({ account: siwc, sessionID: SESSION, refresher: refreshing.run })).toEqual(
        failure,
      )
    expect(refreshing.calls).toHaveLength(0)
    await service.store(SIWC_ID, sharing(time.now() + HOUR), { keepPrev: true })
    expect((await service.headersFor({ account: siwc, sessionID: SESSION })).ok).toBe(true)
  })

  test("remove hands the OAuth item it read to the revoker only once the delete succeeded", async () => {
    const { time, memory, service } = setup()
    const item = sharing(time.now() + HOUR)
    await service.store(SIWC_ID, item)
    const seen: Credential.OAuthSecret[] = []
    const revoker = (current: Credential.OAuthSecret) => void seen.push(current)
    // A failed delete keeps a working login: nothing is revoked, the item is still served.
    memory.inject((request) => (request.op === "delete" ? { ok: false, error: "busy" } : undefined))
    expect(await service.remove(account("siwc"), { revoker })).toMatchObject({
      ok: false,
      problem: "vault_unavailable",
    })
    expect(seen).toEqual([])
    expect((await service.headersFor({ account: account("siwc"), sessionID: SESSION })).ok).toBe(true)
    expect(await service.remove(account("siwc"), { revoker })).toEqual({ ok: true, deleted: true })
    expect(seen.map((current) => [current.refresh, current.clientId])).toEqual([[item.refresh, SHARING_CLIENT]])
    // Nothing stored any more: nothing to revoke.
    expect(await service.remove(account("siwc"), { revoker })).toEqual({ ok: true, deleted: false })
    expect(seen).toHaveLength(1)
  })

  test("restoring .prev keeps the token-sharing metadata", async () => {
    const { time, memory, service } = setup()
    await service.store(SIWC_ID, sharing(time.now() + HOUR))
    await service.store(SIWC_ID, sharing(time.now() + 2 * HOUR, { clientId: "oaiapp_other" }), { keepPrev: true })
    expect(await service.restorePrevious(SIWC_ID, { allowOAuth: true })).toEqual({ ok: true, generation: 3 })
    expect(stored(memory, SIWC_ID)).toMatchObject({
      family: "openai-chatgpt-sharing",
      clientId: SHARING_CLIENT,
      scopes: SHARING_SCOPES,
    })
  })
})

describe("Refresh due check", () => {
  const now = Date.UTC(2026, 9, 1, 12)

  test("due within the window and once earliest_refresh_at has passed", () => {
    expect(Refresh.due({ expiresAt: now + Refresh.DUE_MS - 1 }, now)).toBe(true)
    expect(Refresh.due({ expiresAt: now + Refresh.DUE_MS }, now)).toBe(false)
    expect(Refresh.due({ expiresAt: now - 1 }, now)).toBe(true)
    expect(Refresh.due({ expiresAt: now + 1_000, earliestRefreshAt: now + 1 }, now)).toBe(false)
    expect(Refresh.due({ expiresAt: now + 1_000, earliestRefreshAt: now }, now)).toBe(true)
    expect(Refresh.due({ expiresAt: now + HOUR, earliestRefreshAt: now - 1 }, now)).toBe(false)
    // The gate only defers a token that still works.
    expect(Refresh.due({ expiresAt: now, earliestRefreshAt: now + 1 }, now)).toBe(true)
    expect(Refresh.due({ expiresAt: now - 1_000, earliestRefreshAt: now + HOUR }, now)).toBe(true)
  })

  test("earliest_refresh_at defers only while the token works and only when it is before the expiry", () => {
    expect(Refresh.deferredUntil({ expiresAt: now + 1_000, earliestRefreshAt: now + 500 }, now)).toBe(now + 500)
    expect(Refresh.deferredUntil({ expiresAt: now + 1_000 }, now)).toBeUndefined()
    expect(Refresh.deferredUntil({ expiresAt: now + 1_000, earliestRefreshAt: now }, now)).toBeUndefined()
    expect(Refresh.deferredUntil({ expiresAt: now + 1_000, earliestRefreshAt: now + 1_000 }, now)).toBeUndefined()
    expect(Refresh.deferredUntil({ expiresAt: now - 1, earliestRefreshAt: now + 500 }, now)).toBeUndefined()
    const misread = Refresh.earliestOf(now + 55 * 60_000)
    expect(misread).toBeGreaterThan(now + 1_000 * 365 * 24 * HOUR)
    expect(Refresh.due({ expiresAt: now + 1_000, earliestRefreshAt: misread }, now)).toBe(true)
  })

  test("earliest_refresh_at is epoch seconds as a number and an ISO time as a string", () => {
    expect(Refresh.earliestOf(1_790_000_000)).toBe(1_790_000_000_000)
    expect(Refresh.earliestOf(1_790_000_000.5)).toBe(1_790_000_000_500)
    expect(Refresh.earliestOf("2026-10-01T12:00:00Z")).toBe(now)
    expect(Refresh.earliestOf("2026-10-01T21:00:00+09:00")).toBe(now)
    for (const value of [undefined, null, "soon", "", -1, Number.NaN, Number.POSITIVE_INFINITY, {}, [1]])
      expect(Refresh.earliestOf(value)).toBeUndefined()
  })
})

describe("codex-multi-provider sources", () => {
  async function linkedSetup() {
    const dir = await tmpdir()
    const env = setup()
    const authPath = path.join(dir.path, "profiles", "p1", "codex", "auth.json")
    const tokens = chatgptTokens(ACCOUNT_A, env.time.now() + HOUR)
    await writeAuth(authPath, tokens)
    const source = CodexSource.source(dir.path, { id: "p1", alias: "personal" })
    const linked = account("codex", {
      identity: {
        chatgptAccountId: ACCOUNT_A.accountId,
        fingerprint: Hash.fingerprint(ACCOUNT_A.accountId, ACCOUNT_A.sub),
      },
      credential: { type: "linked-codex-source", source, linkedAt: "2026-09-27T03:00:00Z" },
    })
    return { ...env, dir, authPath, tokens, source, linked }
  }

  test("linked accounts read the source and never touch the vault or the refresher", async () => {
    const { dir, time, memory, authPath, tokens, linked, service } = await linkedSetup()
    await using _ = dir
    const before = await fs.readFile(authPath, "utf8")
    const refresh = refresher(time)
    const result = await service.headersFor({ account: linked, sessionID: SESSION, refresher: refresh.run })
    expect(result).toMatchObject({
      ok: true,
      source: "linked",
      headers: { authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": ACCOUNT_A.accountId },
    })
    time.advance(HOUR)
    expect(await service.headersFor({ account: linked, sessionID: SESSION, refresher: refresh.run })).toMatchObject({
      ok: false,
      problem: "source_stale",
      detail: "expired",
    })
    expect(await service.refresh(linked, refresh.run, { force: true })).toEqual({
      type: "unavailable",
      reason: "linked_source",
    })
    expect(refresh.calls).toHaveLength(0)
    expect(memory.calls.get("get")).toBeUndefined()
    expect(memory.calls.get("put")).toBeUndefined()
    expect(await fs.readFile(authPath, "utf8")).toBe(before)
  })

  test("a 401 on a linked account re-reads the source; new tokens from the old app are used", async () => {
    const { dir, time, authPath, linked, service } = await linkedSetup()
    await using _ = dir
    await service.headersFor({ account: linked, sessionID: SESSION })
    expect(service.unauthorized(linked)).toBe("reread_source")
    expect(await service.headersFor({ account: linked, sessionID: SESSION })).toMatchObject({
      problem: "source_stale",
      detail: "rejected",
    })
    const fresh = chatgptTokens(ACCOUNT_A, time.now() + 2 * HOUR)
    await writeAuth(authPath, fresh)
    time.advance(1_000)
    const result = await service.headersFor({ account: linked, sessionID: SESSION })
    expect(result.ok && result.headers.authorization).toBe(`Bearer ${fresh.accessToken}`)
    expect(await service.inspect(linked)).toMatchObject({
      source: "linked",
      ok: true,
      identity: { chatgptAccountId: ACCOUNT_A.accountId, emailMasked: "al***@example.test" },
      lastRefresh: "2026-09-26T10:11:12.123456789Z",
    })
  })

  test("a linked source that switched to another ChatGPT login is refused", async () => {
    const { dir, time, authPath, linked, service } = await linkedSetup()
    await using _ = dir
    await writeAuth(authPath, chatgptTokens(ACCOUNT_B, time.now() + HOUR))
    expect(await service.headersFor({ account: linked, sessionID: SESSION })).toEqual({
      ok: false,
      problem: "source_invalid",
      detail: "account_mismatch",
    })
  })

  test("another member of the same ChatGPT workspace in a linked source is refused (fingerprint guard)", async () => {
    const { dir, time, authPath, linked, service } = await linkedSetup()
    await using _ = dir
    expect((await service.headersFor({ account: linked, sessionID: SESSION })).ok).toBe(true)
    const colleague = { ...ACCOUNT_A, sub: "auth0|fake-user-c", email: "carol@example.test" }
    await writeAuth(authPath, chatgptTokens(colleague, time.now() + HOUR))
    time.advance(1_000)
    expect(await service.headersFor({ account: linked, sessionID: SESSION })).toEqual({
      ok: false,
      problem: "source_invalid",
      detail: "account_mismatch",
    })
  })

  test("takeover copies the tokens into the vault once; afterwards we refresh and the source is untouched", async () => {
    const { dir, time, memory, authPath, tokens, source, linked, service } = await linkedSetup()
    await using _ = dir
    const before = await fs.readFile(authPath, "utf8")
    const taken = await service.takeover(CODEX_ID, source, { expected: Credentials.expectedOf(linked) })
    expect(taken).toMatchObject({ ok: true, generation: 1, identity: { chatgptAccountId: ACCOUNT_A.accountId } })
    expect(JSON.stringify(taken) + inspect(taken)).not.toContain(tokens.refreshToken)
    const stored = JSON.parse(memory.handle({ op: "get", id: CODEX_ID }).value as string)
    expect(stored).toMatchObject({
      type: "oauth",
      family: "openai-chatgpt",
      refresh: tokens.refreshToken,
      obtainedAt: Date.UTC(2026, 8, 26, 10, 11, 12, 123),
      generation: 1,
    })
    const takenOver = account("codex", {
      credential: { type: "takeover-codex-source", source, takenOverAt: "2026-09-27T03:00:00Z" },
    })
    time.advance(HOUR)
    const refresh = refresher(time)
    const result = await service.headersFor({ account: takenOver, sessionID: SESSION, refresher: refresh.run })
    expect(result).toMatchObject({ ok: true, source: "vault" })
    expect(refresh.calls.map((call) => call.refresh)).toEqual([tokens.refreshToken])
    expect(await fs.readFile(authPath, "utf8")).toBe(before)
    expect(await service.takeover(CODEX_ID, source, { expected: { accountId: ACCOUNT_B.accountId } })).toEqual({
      ok: false,
      problem: "source_invalid",
      detail: "account_mismatch",
    })
  })
})

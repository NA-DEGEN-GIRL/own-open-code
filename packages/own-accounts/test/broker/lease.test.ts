// `headers.get` lease rules (04 §8.5, §8.8, §8.9): relative lifetimes, the minimum validity, source-specific handling
// (vault/takeover refresh first; linked never refreshes and is refused per host), invalidation, scope and rate limits.
import { describe, expect, test } from "bun:test"
import { Broker, type Account, type Registry } from "@own/protocol"
import { Hash, type Credentials } from "@own/runtime"
import { Lease } from "../../src/broker/lease.js"
import { registryWith } from "../slots/support.js"

const NOW = Date.UTC(2026, 8, 27, 3, 0, 0)
const MIN = 60_000

interface Fake {
  now: number
  auth: Map<string, Credentials.Auth>
  refreshed: string[]
  unauthorized: string[]
  headersCalls: Array<{ accountID: string; sessionID: string }>
  onRefresh?: (accountID: string) => void
  /** What the next refreshes report; default `refreshed`. */
  refreshResult?: Awaited<ReturnType<Lease.Backend["refresh"]>>
}

function ok(headers: Record<string, string>, expiresAt: number | null): Credentials.Auth {
  return { ok: true, headers, hash: Hash.auth(headers)[0]!.hash, expiresAt, source: "vault" }
}

async function setup(scope: Lease.HostState["settings"]["accounts"] = { mode: "all" }) {
  const registry: Registry.File = await registryWith([
    { kind: "oai", label: "Key", slug: "keya" },
    { kind: "codex", label: "Vault", slug: "vault", identity: { chatgptAccountId: "acct-v" } },
    {
      kind: "codex",
      label: "Linked",
      slug: "linked",
      identity: { chatgptAccountId: "acct-l" },
      credential: {
        type: "linked-codex-source",
        source: { app: "codex-multi-provider", profileID: "07", alias: null, authPath: "C:\\fake\\auth.json" },
        linkedAt: "2026-09-27T00:00:00.000Z",
      },
    },
  ])
  const fake: Fake = { now: NOW, auth: new Map(), refreshed: [], unauthorized: [], headersCalls: [] }
  const issuer = new Lease.Issuer({
    now: () => fake.now,
    registry: async () => registry,
    headers: async (account, sessionID) => {
      fake.headersCalls.push({ accountID: account.id, sessionID })
      return fake.auth.get(account.id) ?? { ok: false, problem: "not_found" }
    },
    refresh: async (account) => {
      fake.refreshed.push(account.id)
      fake.onRefresh?.(account.id)
      return fake.refreshResult ?? { type: "refreshed" }
    },
    unauthorized: (account) => void fake.unauthorized.push(account.id),
  })
  const host = new Lease.HostState("h-test01")
  host.settings = { accounts: scope, leaseSeconds: 900, failClosedGraceSeconds: 300 }
  const account = (label: string) => registry.accounts.find((item) => item.label === label)!
  const request = (target: Account.Info, extra: Partial<Broker.HeadersGet> = {}): Broker.HeadersGet => ({
    providerID: target.providerID,
    kind: target.kind,
    sessionID: "ses_remote",
    directory: "/home/u/work",
    allowlist: "ok",
    ...extra,
  })
  return { registry, fake, issuer, host, account, request }
}

describe("Lease.Issuer", () => {
  test("API key: leaseSeconds, only the credential header, audit and generation", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const key = account("Key")
    fake.auth.set(key.id, ok({ authorization: "Bearer sk-test-lease-key" }, null))
    const outcome = await issuer.issue(host, request(key))
    expect(outcome.result).toEqual({
      headers: { authorization: "Bearer sk-test-lease-key" },
      authHash8: Hash.short("Bearer sk-test-lease-key"),
      ttlMs: 900_000,
      generation: 1,
    })
    expect(outcome.issued).toBe(key.id)
    expect(host.active(fake.now)).toBe(1)
    // The broker asks with its own session id, never the remote session's (lastResponse of local sessions untouched).
    expect(fake.headersCalls[0]!.sessionID).toBe("own-broker:h-test01")
    // Same value → same generation; a new value → the next one.
    expect((await issuer.issue(host, request(key))).result).toMatchObject({ generation: 1 })
    fake.auth.set(key.id, ok({ authorization: "Bearer sk-test-lease-key-2" }, null))
    expect((await issuer.issue(host, request(key))).result).toMatchObject({ generation: 2 })
  })

  test("Codex (vault): ttl = min(expiresAt − 5 min, now + lease) − now; session headers are not leased", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const vault = account("Vault")
    fake.auth.set(
      vault.id,
      ok({ authorization: "Bearer at-1", "chatgpt-account-id": "acct-v", "session-id": "own-broker:h-test01", originator: "opencode" }, NOW + 20 * MIN),
    )
    const outcome = await issuer.issue(host, request(vault))
    expect(outcome.result).toMatchObject({ ttlMs: 15 * MIN, headers: { authorization: "Bearer at-1", "chatgpt-account-id": "acct-v" } })
    expect(Object.keys((outcome.result as Broker.Lease).headers).toSorted()).toEqual(["authorization", "chatgpt-account-id"])
    expect(fake.refreshed).toEqual([])
    // A long-lived token is capped by leaseSeconds.
    fake.auth.set(vault.id, ok({ authorization: "Bearer at-2", "chatgpt-account-id": "acct-v" }, NOW + 60 * MIN))
    expect((await issuer.issue(host, request(vault))).result).toMatchObject({ ttlMs: 15 * MIN })
    host.settings = { ...host.settings, leaseSeconds: 60 }
    expect((await issuer.issue(host, request(vault))).result).toMatchObject({ ttlMs: MIN })
  })

  test("Codex (vault) below the minimum validity is refreshed (single-flight) before the lease", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const vault = account("Vault")
    fake.auth.set(vault.id, ok({ authorization: "Bearer at-short", "chatgpt-account-id": "acct-v" }, NOW + 6 * MIN))
    fake.onRefresh = () => fake.auth.set(vault.id, ok({ authorization: "Bearer at-new", "chatgpt-account-id": "acct-v" }, NOW + 60 * MIN))
    const outcome = await issuer.issue(host, request(vault))
    expect(fake.refreshed).toEqual([vault.id])
    expect(outcome.result).toMatchObject({ headers: { authorization: "Bearer at-new" } })
    // A refresh that does not help: no short lease, the host is told the vault is unavailable.
    fake.onRefresh = undefined
    fake.auth.set(vault.id, ok({ authorization: "Bearer at-short", "chatgpt-account-id": "acct-v" }, NOW + 6 * MIN))
    expect((await issuer.issue(host, request(vault))).result).toEqual({ error: "vault_unavailable" })
  })

  test("a token whose refresh the token endpoint deferred is leased until the refresh may run", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const vault = account("Vault")
    fake.refreshResult = { type: "deferred", until: NOW + 2 * MIN }
    fake.auth.set(vault.id, ok({ authorization: "Bearer at-held" }, NOW + 6 * MIN))
    expect((await issuer.issue(host, request(vault))).result).toMatchObject({
      headers: { authorization: "Bearer at-held" },
      ttlMs: 2 * MIN,
    })
    expect(fake.refreshed).toEqual([vault.id])
    // The refresh may not run before the last minute: the still valid token is leased inside the five-minute margin,
    // up to a minute before its expiry.
    fake.refreshResult = { type: "deferred", until: NOW + 5.5 * MIN }
    fake.now = NOW + 3 * MIN
    expect((await issuer.issue(host, request(vault))).result).toMatchObject({ ttlMs: 2 * MIN })
    fake.now = NOW + 4.5 * MIN
    expect((await issuer.issue(host, request(vault))).result).toMatchObject({ ttlMs: 0.5 * MIN })
    // Within that last minute nothing is left to lease.
    fake.now = NOW + 5.2 * MIN
    expect((await issuer.issue(host, request(vault))).result).toEqual({ error: "vault_unavailable" })
    expect(fake.refreshed).toHaveLength(4)
  })

  test("linked: below the minimum validity → source_stale for this host only, no refresh, released later", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const linked = account("Linked")
    fake.auth.set(linked.id, ok({ authorization: "Bearer lt-1", "chatgpt-account-id": "acct-l" }, NOW + 6 * MIN))
    const refused = await issuer.issue(host, request(linked))
    expect(refused.result).toEqual({ error: "source_stale", expiresInMs: 6 * MIN })
    expect(refused.pushes).toEqual([
      { event: "account.status", data: { accountID: linked.id, status: "auth_failed", reason: "codex_source_stale", scope: "host" } },
    ])
    expect(fake.refreshed).toEqual([])
    expect(host.stale.has(linked.id)).toBe(true)
    // The same state again: no second push.
    expect((await issuer.issue(host, request(linked))).pushes).toEqual([])
    // Nothing changed at the source: the sweep keeps it stale.
    expect(await issuer.release(host)).toEqual([])
    // The old app wrote a new token: the sweep releases the host.
    fake.auth.set(linked.id, ok({ authorization: "Bearer lt-2", "chatgpt-account-id": "acct-l" }, NOW + 50 * MIN))
    expect(await issuer.release(host)).toEqual([
      { event: "account.status", data: { accountID: linked.id, status: "ready", scope: "host" } },
    ])
    expect((await issuer.issue(host, request(linked))).result).toMatchObject({ headers: { authorization: "Bearer lt-2" }, ttlMs: 15 * MIN })
    expect(fake.refreshed).toEqual([])
  })

  test("linked invalidate: the rejected hash is refused on this host only; the local reader is never rejected", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const linked = account("Linked")
    const first = ok({ authorization: "Bearer lt-1", "chatgpt-account-id": "acct-l" }, NOW + 50 * MIN)
    fake.auth.set(linked.id, first)
    await issuer.issue(host, request(linked))
    const refused = await issuer.issue(host, request(linked, { invalidate: first.ok ? first.hash : "" }))
    expect(refused.result).toMatchObject({ error: "source_stale" })
    expect(refused.pushes).toEqual([
      { event: "account.status", data: { accountID: linked.id, status: "auth_failed", reason: "codex_source_stale", scope: "host" } },
      { event: "revoke", data: { providerID: linked.providerID } },
    ])
    // 04 §8.8: no `credentials.unauthorized` for a linked source (the local sessions keep working), no refresh.
    expect(fake.unauthorized).toEqual([])
    expect(fake.refreshed).toEqual([])
    // Another host is not affected.
    const other = new Lease.HostState("h-other2")
    expect((await issuer.issue(other, request(linked))).result).toMatchObject({ headers: { authorization: "Bearer lt-1" } })
    // Still the same token on this host: refused, and a repeated invalidate within 5 minutes changes nothing.
    fake.now += MIN
    expect((await issuer.issue(host, request(linked, { invalidate: first.ok ? first.hash : "" }))).result).toEqual({ error: "source_stale" })
    expect((await issuer.issue(host, request(linked))).result).toMatchObject({ error: "source_stale" })
    // The old app refreshed: a different token is leased again.
    fake.auth.set(linked.id, ok({ authorization: "Bearer lt-2", "chatgpt-account-id": "acct-l" }, NOW + 60 * MIN))
    const back = await issuer.issue(host, request(linked))
    expect(back.result).toMatchObject({ headers: { authorization: "Bearer lt-2" } })
    expect(back.pushes).toEqual([{ event: "account.status", data: { accountID: linked.id, status: "ready", scope: "host" } }])
  })

  test("vault invalidate of the current value marks it for refresh, at most once per 5 minutes per host and account", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const vault = account("Vault")
    const current = ok({ authorization: "Bearer at-1", "chatgpt-account-id": "acct-v" }, NOW + 50 * MIN)
    fake.auth.set(vault.id, current)
    const hash = current.ok ? current.hash : ""
    await issuer.issue(host, request(vault, { invalidate: hash }))
    expect(fake.unauthorized).toEqual([vault.id])
    await issuer.issue(host, request(vault, { invalidate: hash }))
    expect(fake.unauthorized).toEqual([vault.id])
    fake.now += 5 * MIN
    await issuer.issue(host, request(vault, { invalidate: hash }))
    expect(fake.unauthorized).toEqual([vault.id, vault.id])
    // A stale hash (already refreshed) triggers nothing.
    fake.now += 5 * MIN
    await issuer.issue(host, request(vault, { invalidate: "deadbeef" }))
    expect(fake.unauthorized).toHaveLength(2)
  })

  test("scope, remote deny, disabled and needs_reauth accounts get no lease", async () => {
    const { registry, fake, issuer, account, request } = await setup({ mode: "only", ids: [] })
    const key = account("Key")
    fake.auth.set(key.id, ok({ authorization: "Bearer sk-x" }, null))
    const host = new Lease.HostState("h-scope1")
    host.settings = { accounts: { mode: "only", ids: [] }, leaseSeconds: 900, failClosedGraceSeconds: 300 }
    expect((await issuer.issue(host, request(key))).result).toEqual({ error: "account_not_remote" })
    host.settings = { ...host.settings, accounts: { mode: "all" } }
    Object.assign(registry.accounts[0]!, { remote: "deny" })
    expect((await issuer.issue(host, request(key))).result).toEqual({ error: "account_not_remote" })
    Object.assign(registry.accounts[0]!, { remote: "allow", status: "needs_reauth" })
    expect((await issuer.issue(host, request(key))).result).toEqual({ error: "needs_reauth" })
    Object.assign(registry.accounts[0]!, { status: "disabled" })
    expect((await issuer.issue(host, request(key))).result).toEqual({ error: "account_not_remote" })
    expect((await issuer.issue(host, { ...request(key), providerID: "own-oai-missing" as never })).result).toEqual({ error: "not_found" })
  })

  test("rate limit: 30/s with a burst of 60 per host", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const key = account("Key")
    fake.auth.set(key.id, ok({ authorization: "Bearer sk-x" }, null))
    host.refilledAt = fake.now
    const results = []
    for (let index = 0; index < Broker.RATE_BURST + 5; index++) results.push((await issuer.issue(host, request(key))).result)
    expect(results.filter((result) => "error" in result && result.error === "rate_limited")).toHaveLength(5)
    fake.now += 1_000
    const after = []
    for (let index = 0; index < 35; index++) after.push((await issuer.issue(host, request(key))).result)
    expect(after.filter((result) => "error" in result && result.error === "rate_limited")).toHaveLength(5)
  })

  test("vault problems map to host errors without detail", async () => {
    const { fake, issuer, host, account, request } = await setup()
    const vault = account("Vault")
    fake.auth.set(vault.id, { ok: false, problem: "needs_reauth", detail: "invalid_grant" })
    expect((await issuer.issue(host, request(vault))).result).toEqual({ error: "needs_reauth" })
    fake.auth.set(vault.id, { ok: false, problem: "refresh_backoff", retryAt: NOW + MIN })
    expect((await issuer.issue(host, request(vault))).result).toEqual({ error: "vault_unavailable" })
  })
})

// T4 (04 §8.11.12): the PC's consent and per-host switches of the remote Claude relay. The remote consent names the
// bundled plugin's pin and the remote notice (the local slot needs no consent since 2026-10-18); `remote.set` writes `accounts.json` `claudeSlot.remoteHosts`
// (`store.changed`) only with a valid remote consent, while switching off always works; `fastAck` records the Fast
// consent on this PC; a remote service refuses all three. Fake plugin pin and connections only.
import { Hash } from "@own/runtime"
import { describe, expect, test } from "bun:test"
import { Kv, Speed } from "@own/protocol"
import { Schema } from "effect"
import { Claude } from "../../src/plugins/claude.js"
import { Notice } from "../../src/plugins/notice.js"
import { Register } from "../../src/rpc/register.js"
import { FAKE_PIN, call, ok, sessionEvent, until, world } from "./support.js"

const REMOTE = { version: FAKE_PIN.version, integrity: FAKE_PIN.integrity, noticeHash: Notice.REMOTE_HASH }
const HOST = "h-abc123"
const OAUTH = { type: "credential", id: "crd_1", label: "Claude Max · someone@example.com", method: "oauth" } as const

/** The plugins module with the app's (fake) Claude bundle loaded and verified. */
async function installed() {
  const w = await world()
  w.bundle()
  await w.plugins.start()
  return w
}

describe("plugin.claudeAuth.remote.ack", () => {
  test("needs the bundled pin and the remote notice hash; no local consent is asked", async () => {
    await using w = await world()
    await w.plugins.start()
    // A build without the bundle has no pin to consent to.
    expect(await call(w.plugins.claudeRemoteAck, REMOTE)).toMatchObject({ ok: false, type: "internal_error" })
    w.bundle()
    await w.plugins.refreshed()
    const changes: string[] = []
    w.deps.runtime.broadcast.on("claudeSlot.changed", (change) => changes.push(change.reason))
    // Another notice's hash is not the remote one.
    expect(await call(w.plugins.claudeRemoteAck, { ...REMOTE, noticeHash: "0".repeat(64) })).toMatchObject({
      ok: false,
      type: "ack_required",
      data: { reason: "stale" },
    })
    expect(await call(w.plugins.claudeRemoteAck, { ...REMOTE, version: "0.0.0-other" })).toMatchObject({
      ok: false,
      type: "ack_required",
    })
    expect(w.storage.has(Kv.ackClaudeRemote)).toBe(false)

    const acked = await ok(w.plugins.claudeRemoteAck, REMOTE)
    expect(w.storage.get(Kv.ackClaudeRemote)).toEqual({
      acknowledgedAt: acked.acknowledgedAt,
      pluginVersion: FAKE_PIN.version,
      integrity: FAKE_PIN.integrity,
      noticeHash: Notice.REMOTE_HASH,
    })
    expect(changes).toEqual(["remote"])
    const status = await ok(w.plugins.claudeAuthStatus, {})
    expect(status.remote).toEqual({
      acknowledged: { at: acked.acknowledgedAt, valid: true },
      noticeHash: Notice.REMOTE_HASH,
      hosts: [],
    })
    expect(status.acknowledged).toBeNull()
  })

  test("a consent to the English notice counts, is stored as given, and the Korean one before it stays valid", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    await ok(w.plugins.claudeRemoteAck, REMOTE)
    expect((await ok(w.plugins.claudeAuthStatus, {})).remote?.acknowledged?.valid).toBe(true)
    const english = Hash.sha256(Notice.REMOTE_TEXT_EN)
    await ok(w.plugins.claudeRemoteAck, { ...REMOTE, noticeHash: english })
    expect(w.storage.get(Kv.ackClaudeRemote)).toMatchObject({ noticeHash: english })
    const status = await ok(w.plugins.claudeAuthStatus, {})
    expect(status.remote).toMatchObject({ acknowledged: { valid: true }, noticeHash: Notice.REMOTE_HASH })
  })
})

describe("plugin.claudeAuth.remote.set", () => {
  test("switching on needs the remote consent; it writes remoteHosts and store.changed; off always works", async () => {
    await using w = await installed()
    const stores: string[] = []
    w.deps.runtime.broadcast.on("store.changed", (change) => stores.push(change.store))

    expect(await call(w.plugins.claudeRemoteSet, { hostId: HOST, enabled: true })).toMatchObject({
      ok: false,
      type: "ack_required",
      data: { reason: "remote" },
    })
    expect(w.registry.claudeSlot?.remoteHosts).toBeUndefined()

    await ok(w.plugins.claudeRemoteAck, REMOTE)
    const on = await ok(w.plugins.claudeRemoteSet, { hostId: HOST, enabled: true })
    // No `anthropic` connection yet: switched on, but the slot is not ready on this PC.
    expect(on).toEqual({ hostId: HOST, enabled: true, state: "not_ready" })
    expect(w.registry.claudeSlot).toEqual({
      accountID: "acc_claude_slot",
      label: null,
      shortLabel: "C",
      color: "orange",
      remoteHosts: [HOST],
    })
    expect((await w.deps.runtime.registry.read()).claudeSlot?.remoteHosts).toEqual([HOST])
    expect(stores).toEqual(["accounts"])

    // A second switch-on changes nothing (no write, no event).
    await ok(w.plugins.claudeRemoteSet, { hostId: HOST, enabled: true })
    expect(stores).toEqual(["accounts"])

    w.connection = OAUTH
    await w.plugins.refreshed()
    await ok(w.plugins.claudeRemoteSet, { hostId: "h-other1", enabled: true })
    const status = await ok(w.plugins.claudeAuthStatus, {})
    expect(status.remote?.hosts).toEqual([
      { hostId: HOST, enabled: true, state: "enabled" },
      { hostId: "h-other1", enabled: true, state: "enabled" },
    ])

    // Off works even after the remote consent went stale (another notice hash).
    w.storage.set(Kv.ackClaudeRemote, { ...(w.storage.get(Kv.ackClaudeRemote) as object), noticeHash: "0".repeat(64) })
    await w.plugins.refreshed()
    expect(await ok(w.plugins.claudeRemoteSet, { hostId: HOST, enabled: false })).toEqual({
      hostId: HOST,
      enabled: false,
      state: "off",
    })
    await ok(w.plugins.claudeRemoteSet, { hostId: "h-other1", enabled: false })
    // The last host gone: no empty list is left behind.
    expect(w.registry.claudeSlot).toEqual({ accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "orange" })
  })

  test("the verdict rows: not_ready, billing, off, consent, host_scope, enabled (first match wins)", () => {
    const facts = { ready: true, billing: false, acknowledged: true }
    const verdict = (patch: Partial<typeof facts>, hosts: string[] | undefined, scope = { mode: "all" as const }) =>
      Claude.remoteState({ facts: { ...facts, ...patch }, remoteHosts: hosts, hostId: HOST, scope })
    expect(verdict({ ready: false, billing: true, acknowledged: false }, undefined)).toBe("not_ready")
    expect(verdict({ billing: true, acknowledged: false }, undefined)).toBe("billing")
    expect(verdict({ acknowledged: false }, undefined)).toBe("off")
    expect(verdict({ acknowledged: false }, [HOST])).toBe("consent")
    expect(
      Claude.remoteState({ facts, remoteHosts: [HOST], hostId: HOST, scope: { mode: "only", ids: ["acc_x"] } }),
    ).toBe("host_scope")
    expect(
      Claude.remoteState({
        facts,
        remoteHosts: [HOST],
        hostId: HOST,
        scope: { mode: "only", ids: ["acc_claude_slot"] },
      }),
    ).toBe("enabled")
    expect(verdict({}, [HOST])).toBe("enabled")
  })

  test("an API key or env connection is billing; a connection change is broadcast as `connection`", async () => {
    await using w = await installed()
    await ok(w.plugins.claudeRemoteAck, REMOTE)
    await ok(w.plugins.claudeRemoteSet, { hostId: HOST, enabled: true })
    const changes: string[] = []
    w.deps.runtime.broadcast.on("claudeSlot.changed", (change) => changes.push(change.reason))
    const deliver = async () => {
      w.plugins.onEvent?.(
        sessionEvent("credential.switched", { integrationID: "anthropic", credentialID: null }, w.workspace),
        { local: true },
      )
      await Bun.sleep(20)
    }
    w.connection = OAUTH
    await deliver()
    await until(() => changes.includes("connection"))
    expect(w.plugins.claudeRemote()).toMatchObject({ ready: true, billing: false, acknowledged: true })
    w.connection = { type: "env", name: "ANTHROPIC_API_KEY" }
    await deliver()
    await until(() => changes.filter((reason) => reason === "connection").length === 2)
    expect(w.plugins.claudeRemote()).toMatchObject({ ready: true, billing: true })
    expect((await ok(w.plugins.claudeAuthStatus, {})).remote?.hosts).toEqual([
      { hostId: HOST, enabled: true, state: "billing" },
    ])
    // The same connection again: nothing to announce.
    await deliver()
    expect(changes.filter((reason) => reason === "connection")).toHaveLength(2)
  })
})

describe("plugin.claudeAuth.fastAck", () => {
  test("records the Fast consent on this PC and announces it", async () => {
    await using w = await world()
    await w.plugins.start()
    const changes: string[] = []
    w.deps.runtime.broadcast.on("claudeSlot.changed", (change) => changes.push(change.reason))
    expect(w.plugins.claudeRemote().fast).toBe(false)
    const result = await ok(w.plugins.claudeFastAck, {})
    expect(result.at).toBe(w.clock.now())
    expect(Schema.decodeUnknownSync(Speed.Consent)(w.storage.get(Kv.ackClaudeFast))).toEqual({ at: w.clock.now() })
    expect(w.plugins.claudeRemote().fast).toBe(true)
    expect(changes).toEqual(["fast"])
  })
})

test("a remote service refuses the three PC methods (remote_managed)", () => {
  for (const method of ["plugin.claudeAuth.remote.ack", "plugin.claudeAuth.remote.set", "plugin.claudeAuth.fastAck"])
    expect<ReadonlyArray<string>>(Register.REMOTE_MANAGED).toContain(method)
})

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Limit } from "@own/protocol"
import { Home, Runtime, Vault } from "../src/index.js"
import { account, ANTH_ID, tmpdir } from "./fixture.js"

let builds = 0
const buildId = () => `test-${process.pid}-${++builds}`

describe("Runtime singleton", () => {
  test("instances of one build share services; the last release shuts down", async () => {
    await using dir = await tmpdir()
    const memory = Vault.memory()
    const id = buildId()
    const first = await Runtime.acquire({ buildId: id, home: dir.path, vault: { transport: memory } })
    const second = await Runtime.acquire({ buildId: id, home: dir.path, vault: { transport: Vault.memory() } })
    expect(second.credentials).toBe(first.credentials)
    expect(second.ledger).toBe(first.ledger)
    // A slot's Z samples one Location's instance saw answer `estimate.request` at another (09 §5.6).
    expect(second.samples).toBe(first.samples)
    expect(Runtime.peek(id)).toEqual({ refs: 2, home: dir.path, roles: { "own.accounts": 2 } })
    expect((await fs.readdir(dir.path)).sort()).toEqual(["control", "ledger", "locks", "state"])

    await first.credentials.store(ANTH_ID, { type: "key", key: "fake-key" })
    const auth = await second.credentials.headersFor({ account: account("anth"), sessionID: "ses_1" })
    expect(auth.ok).toBe(true)
    expect(second.lastResponse.injected("ses_1", "own-anth-w3p8")).toBe(auth.ok ? auth.hash : "")

    await first.release()
    await first.release()
    expect(Runtime.peek(id)?.refs).toBe(1)
    expect(await second.vault.list()).toEqual({ ok: true, ids: [ANTH_ID] })
    await second.release()
    expect(Runtime.peek(id)).toBeUndefined()
    expect(await new Vault.Client(memory).list()).toMatchObject({ ok: false, error: "unavailable" })
  })

  test("acquiring writes the control Location's config that keeps core's housekeeping away from it", async () => {
    await using dir = await tmpdir()
    const runtime = await Runtime.acquire({ buildId: buildId(), home: dir.path, vault: { transport: Vault.memory() } })
    const config = path.join(dir.path, "control", "opencode.json")
    expect(await Bun.file(config).json()).toEqual({ experimental: { location_idle_timeout: false } })
    await runtime.release()
    // Left as it is when it already says so (core watches its config files).
    const before = (await fs.stat(config)).mtimeMs
    await Home.ensure(Home.layout(Home.resolve({ home: dir.path })))
    expect((await fs.stat(config)).mtimeMs).toBe(before)
  })

  test("the key is Symbol.for(own-open-code.runtime/<buildId>) and builds never share state", async () => {
    await using dir = await tmpdir()
    const one = await Runtime.acquire({ buildId: buildId(), home: dir.path, vault: { transport: Vault.memory() } })
    const two = await Runtime.acquire({ buildId: buildId(), home: dir.path, vault: { transport: Vault.memory() } })
    expect(one.credentials).not.toBe(two.credentials)
    expect(Runtime.key("abc")).toBe(Symbol.for("own-open-code.runtime/abc"))
    await Promise.all([one.release(), two.release()])
  })

  test("the control-location instance leads; otherwise the oldest instance does", async () => {
    await using dir = await tmpdir()
    const id = buildId()
    const options = { buildId: id, home: dir.path, vault: { transport: Vault.memory() } }
    const a = await Runtime.acquire(options)
    const b = await Runtime.acquire(options)
    expect([a.isLeader(), b.isLeader()]).toEqual([true, false])
    const control = await Runtime.acquire({ ...options, preferLeader: true })
    expect([a.isLeader(), b.isLeader(), control.isLeader()]).toEqual([false, false, true])
    await control.release()
    await a.release()
    expect(b.isLeader()).toBe(true)
    await b.release()
  })

  test("each role (plugin) elects its own leader among its own instances", async () => {
    await using dir = await tmpdir()
    const id = buildId()
    const options = { buildId: id, home: dir.path, vault: { transport: Vault.memory() } }
    // Plugin order in the control location: own.accounts, then own.remote (both prefer leadership there).
    const accounts = await Runtime.acquire({ ...options, preferLeader: true })
    const remote = await Runtime.acquire({ ...options, preferLeader: true, role: "own.remote" })
    const telemetry = await Runtime.acquire({ ...options, role: "own.telemetry" })
    const remoteOther = await Runtime.acquire({ ...options, role: "own.remote" })
    expect([accounts.isLeader(), remote.isLeader(), telemetry.isLeader(), remoteOther.isLeader()]).toEqual([
      true,
      true,
      true,
      false,
    ])
    await remote.release()
    expect([accounts.isLeader(), remoteOther.isLeader()]).toEqual([true, true])
    await Promise.all([accounts.release(), telemetry.release(), remoteOther.release()])
  })

  test("peek counts the references of each role (06 §10.4 #3)", async () => {
    await using dir = await tmpdir()
    const id = buildId()
    const options = { buildId: id, home: dir.path, vault: { transport: Vault.memory() } }
    const accounts = await Runtime.acquire(options)
    const accountsOther = await Runtime.acquire({ ...options, role: "own.accounts" })
    const team = await Runtime.acquire({ ...options, role: "own.team" })
    expect(Runtime.peek(id)).toEqual({ refs: 3, home: dir.path, roles: { "own.accounts": 2, "own.team": 1 } })
    await team.release()
    expect(Runtime.peek(id)).toEqual({ refs: 2, home: dir.path, roles: { "own.accounts": 2 } })
    await Promise.all([accounts.release(), accountsOther.release()])
    expect(Runtime.peek(id)).toBeUndefined()
  })

  test("a second OWN_HOME for the same build is refused", async () => {
    await using dir = await tmpdir()
    const id = buildId()
    const handle = await Runtime.acquire({ buildId: id, home: dir.path, vault: { transport: Vault.memory() } })
    await expect(
      Runtime.acquire({ buildId: id, home: path.join(dir.path, "other"), vault: { transport: Vault.memory() } }),
    ).rejects.toThrow("already uses OWN_HOME")
    expect(Runtime.peek(id)?.refs).toBe(1)
    await handle.release()
  })

  test("await using releases the handle, flushing the ledger and saving limits", async () => {
    await using dir = await tmpdir()
    const id = buildId()
    {
      await using handle = await Runtime.acquire({ buildId: id, home: dir.path, vault: { transport: Vault.memory() } })
      void handle.ledger.event({ eid: "evt_1", type: "alert", data: { code: "flap" } })
      handle.limits.upsert([
        Schema.decodeUnknownSync(Limit.Window)({
          id: "codex.primary",
          accountID: account("codex").id,
          providerID: "own-codex-7k2m",
          scope: "account",
          kind: "rolling_quota",
          label: "5시간",
          status: "ok",
          confidence: "live",
          source: "header",
          observedAt: Date.now(),
        }),
      ])
    }
    expect(Runtime.peek(id)).toBeUndefined()
    expect(await fs.readdir(path.join(dir.path, "ledger"))).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path.join(dir.path, "state", "limits.json"), "utf8")).windows).toHaveLength(1)
  })

  test("registry files are reachable through the handle", async () => {
    await using dir = await tmpdir()
    await using handle = await Runtime.acquire({
      buildId: buildId(),
      home: dir.path,
      vault: { transport: Vault.memory() },
    })
    const registry = await handle.registry.update((file) => ({ ...file, accounts: [account("anth")] }))
    expect(registry.revision).toBe(1)
    expect(handle.registry.cached()?.accounts).toHaveLength(1)
    expect((await handle.policy.read()).secretCacheSeconds).toBe(600)
    expect(await handle.trust.read()).toEqual([])
    expect(handle.vault.status()).toBe("unknown")
  })
})

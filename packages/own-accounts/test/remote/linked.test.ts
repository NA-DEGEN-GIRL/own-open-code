// Linked Codex accounts through the broker (04 §8.5, §8.8, RG7 (b) in-process): the local side never refreshes and
// never writes the old app's auth.json; a token below the minimum validity, or one this host reported as rejected,
// is refused as `source_stale` for this host only (the host's mirror shows the account blocked, the local account
// stays ready and usable), and the host is released once the old app wrote a usable token.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Broker, type Account } from "@own/protocol"
import { BrokerHost } from "../../src/broker/host.js"
import { Contract } from "../../src/broker/contract.js"
import type { Server } from "../../src/broker/server.js"
import { Clock } from "../../src/clock.js"
import type { Modules } from "../../src/modules.js"
import { RemoteHost } from "../../src/remote/host.js"
import {
  chatGPTAccount,
  mintChatGPTTokens,
  updateCodexMultiProviderAuth,
  writeCodexMultiProviderProfiles,
  type LegacyProfile,
} from "../e2e-kit"
import { registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const HOST = "h-lnk001"
const MIN = 60_000

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(25)
  }
}

describe("linked Codex account leased to a host", () => {
  const state = {} as {
    local: Awaited<ReturnType<typeof testDeps>>
    remote: Awaited<ReturnType<typeof testDeps>>
    detach: () => Promise<void>
    server: Server.LocalBroker
    handle: RemoteHost.Handle
    linked: Account.Info
    profile: LegacyProfile
    root: string
    refreshCalls: number
  }
  const person = chatGPTAccount({ accountID: "acct-linked-e2e" })
  const hashOf = () => createHash("sha256").update(fs.readFileSync(state.profile.authPath)).digest("hex")

  beforeAll(async () => {
    state.refreshCalls = 0
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "own-linked-broker-"))
    ;[state.profile] = await writeCodexMultiProviderProfiles(state.root, [
      { id: "07", alias: "work", tokens: mintChatGPTTokens(person, Date.now(), 6 * MIN) },
    ])
    state.local = await testDeps({ ctx: { app: { version: "local" } }, control: true })
    const runtime = state.local.deps.runtime
    const registry = await registryWith([
      {
        kind: "codex",
        label: "Linked",
        slug: "linkd",
        identity: { chatgptAccountId: person.accountID },
        credential: {
          type: "linked-codex-source",
          source: { app: "codex-multi-provider", profileID: "07", alias: "work", authPath: state.profile.authPath },
          linkedAt: new Date().toISOString(),
        },
      },
    ])
    state.linked = (await runtime.registry.write(registry)).accounts[0]!
    const modules = {
      logins: {
        // The local header path for a linked source: the read-only reader, no refresher (02 §3.5 F9).
        headers: (account: Account.Info, sessionID: string) => runtime.credentials.headersFor({ account, sessionID }),
        refresher: () => {
          state.refreshCalls++
          return undefined
        },
        test: async () => ({}),
      },
      telemetry: { alert: () => {} },
    } as unknown as Modules.All
    state.detach = BrokerHost.attach({ ...state.local.deps, clock: Clock.system }, modules)
    state.server = BrokerHost.peek(runtime.buildId)!
    state.remote = await testDeps({ ctx: {} })
    state.handle = await RemoteHost.acquire({
      buildId: runtime.buildId,
      version: "local",
      runtime: state.remote.deps.runtime,
      options: {},
      log: state.remote.deps.log,
    })
    const key = randomBytes(32)
    const { port } = await state.server.listen(HOST)
    state.server.setKey(HOST, { epoch: 3, key })
    state.server.configure(HOST, { accounts: { mode: "all" }, leaseSeconds: 900, failClosedGraceSeconds: 0 })
    const client = Contract.lookup(Contract.remoteKey(runtime.buildId)) as Contract.RemoteBrokerClient
    expect(await client.arm({ hostId: HOST, epoch: 3, key: new Uint8Array(key), endpoint: { tcpPort: port }, proto: Broker.PROTO })).toEqual({ accepted: true })
    await until(async () => (await state.remote.deps.runtime.registry.read()).accounts.length === 1)
  }, 30_000)

  afterAll(async () => {
    await state.handle?.release()
    await state.detach?.()
    await state.remote?.[Symbol.asyncDispose]()
    await state.local?.[Symbol.asyncDispose]()
    if (state.root) fs.rmSync(state.root, { recursive: true, force: true })
  })

  test("a token below 7 minutes is refused for this host only; the local account stays ready", async () => {
    const before = hashOf()
    const refused = await state.handle.api.headers(state.linked, "ses_l1", "/home/u")
    expect(refused).toMatchObject({ ok: false, problem: "source_stale", detail: "source_stale" })
    expect(state.server.status(HOST).sourceStale).toEqual([state.linked.id])
    // The host's mirror blocks the account (its switcher leaves it out), the local registry does not change.
    await until(async () => (await state.remote.deps.runtime.registry.read()).accounts[0]?.status === "auth_failed")
    expect((await state.local.deps.runtime.registry.read()).accounts[0]?.status).toBe("ready")
    // Locally the same token is still usable (60 s margin), and nothing refreshed or wrote the source.
    const local = await state.local.deps.runtime.credentials.headersFor({ account: state.linked, sessionID: "ses_local" })
    expect(local.ok).toBe(true)
    expect(state.refreshCalls).toBe(0)
    expect(hashOf()).toBe(before)
  })

  test("the old app writes a new token: the sweep releases the host and the next request gets a lease", async () => {
    await updateCodexMultiProviderAuth(state.profile, mintChatGPTTokens(person, Date.now(), 60 * MIN))
    state.local.clock.advance(5_000) // the reader re-reads the source at most once per second (runtime clock)
    await state.server.sweep()
    expect(state.server.status(HOST).sourceStale).toEqual([])
    await until(async () => (await state.remote.deps.runtime.registry.read()).accounts[0]?.status === "ready")
    const granted = await state.handle.api.headers(state.linked, "ses_l1", "/home/u")
    expect(granted).toMatchObject({ ok: true, headers: { "chatgpt-account-id": person.accountID, "session-id": "ses_l1", originator: "opencode" } })
    expect(state.refreshCalls).toBe(0)
  })

  test("a 401 on the lease: invalidate → source_stale for this host, the local reader is not rejected", async () => {
    const lease = await state.handle.api.headers(state.linked, "ses_l2", "/home/u")
    expect(lease.ok).toBe(true)
    state.handle.api.unauthorized(state.linked)
    const refused = await state.handle.api.headers(state.linked, "ses_l2", "/home/u")
    expect(refused).toMatchObject({ ok: false, problem: "source_stale" })
    expect(state.server.status(HOST).sourceStale).toEqual([state.linked.id])
    // A remote report never marks the local reader rejected (04 §8.8): local sessions keep the token.
    const local = await state.local.deps.runtime.credentials.headersFor({ account: state.linked, sessionID: "ses_local" })
    expect(local.ok && lease.ok && local.hash).toBe(lease.ok && lease.hash)
    // The spool carried the auth failure to the local side (04 §10.6), without the token.
    await until(() => state.handle.api.health().broker.state === "connected")
    expect(state.refreshCalls).toBe(0)
  })
})

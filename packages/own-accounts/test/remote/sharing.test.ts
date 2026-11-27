// A Sign in with ChatGPT account leased to an SSH host through the broker (04 §8.5–8.6, 02 §3.2c), in process: the
// lease is the Bearer token only, the host's request hook adds token sharing's session headers and no Codex header,
// exactly like a local request, and the broker never refreshes before the token endpoint's `earliest_refresh_at`.
// Fake tokens only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { Broker, type Account } from "@own/protocol"
import { Hash } from "@own/runtime"
import { BrokerHost } from "../../src/broker/host.js"
import { Contract } from "../../src/broker/contract.js"
import type { Server } from "../../src/broker/server.js"
import { Clock } from "../../src/clock.js"
import { Modules } from "../../src/modules.js"
import { RemoteHost } from "../../src/remote/host.js"
import { modelRequest, ref, registeredHooks } from "../auth/support.js"
import { memoryStorage, registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const HOST = "h-shr001"
const ACCESS = "at_sharing_fake_remote_lease_0001"
const HELD = "at_sharing_fake_remote_lease_held1"

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(25)
  }
}

describe("Sign in with ChatGPT account leased to a host", () => {
  const state = {} as {
    local: Awaited<ReturnType<typeof testDeps>>
    remote: Awaited<ReturnType<typeof testDeps>>
    detach: () => Promise<void>
    server: Server.LocalBroker
    handle: RemoteHost.Handle
    account: Account.Info
    held: Account.Info
    refreshes: number
  }

  beforeAll(async () => {
    state.local = await testDeps({ ctx: { app: { version: "local" } }, control: true })
    const runtime = state.local.deps.runtime
    const registry = await registryWith([
      {
        kind: "siwc",
        label: "Plus",
        slug: "shr1",
        identity: { fingerprint: Hash.fingerprint("oaiapp_remote", "user-remote") },
      },
      {
        kind: "siwc",
        label: "Held",
        slug: "shr2",
        identity: { fingerprint: Hash.fingerprint("oaiapp_held", "user-held") },
      },
    ])
    const written = await runtime.registry.write(registry)
    state.account = written.accounts[0]!
    state.held = written.accounts[1]!
    state.refreshes = 0
    await runtime.credentials.store(state.account.id, {
      type: "oauth",
      family: "openai-chatgpt-sharing",
      access: ACCESS,
      refresh: "rt_sharing_fake_remote_lease_0001",
      expiresAt: Date.now() + 60 * 60_000,
      clientId: "oaiapp_remote",
    })
    // Six minutes left, below the lease minimum; the token endpoint asked for no refresh in the next three minutes.
    await runtime.credentials.store(state.held.id, {
      type: "oauth",
      family: "openai-chatgpt-sharing",
      access: HELD,
      refresh: "rt_sharing_fake_remote_lease_held1",
      expiresAt: Date.now() + 6 * 60_000,
      clientId: "oaiapp_held",
      earliestRefreshAt: Date.now() + 3 * 60_000,
    })
    const modules = {
      logins: {
        headers: (account: Account.Info, sessionID: string) => runtime.credentials.headersFor({ account, sessionID }),
        refresher: () => async () => {
          state.refreshes++
          return { type: "transient", reason: "unexpected_refresh" }
        },
        test: async () => ({}),
      },
      telemetry: { alert: () => {} },
    } as unknown as Modules.All
    state.detach = BrokerHost.attach({ ...state.local.deps, clock: Clock.system }, modules)
    state.server = BrokerHost.peek(runtime.buildId)!
    // The context the host's slots module reads (storage, provider reloads) for the request hook below.
    state.remote = await testDeps({
      ctx: { storage: memoryStorage().storage, provider: { reload: async () => {}, list: async () => [] } },
    })
    state.handle = await RemoteHost.acquire({
      buildId: runtime.buildId,
      version: "local",
      runtime: state.remote.deps.runtime,
      options: {},
      log: state.remote.deps.log,
    })
    const key = randomBytes(32)
    const listening = await state.server.listen(HOST)
    state.server.setKey(HOST, { epoch: 1, key })
    state.server.configure(HOST, { accounts: { mode: "all" }, leaseSeconds: 900, failClosedGraceSeconds: 0 })
    const client = Contract.lookup(Contract.remoteKey(runtime.buildId)) as Contract.RemoteBrokerClient
    expect(
      await client.arm({
        hostId: HOST,
        epoch: 1,
        key: new Uint8Array(key),
        endpoint: { tcpPort: listening.port },
        proto: Broker.PROTO,
      }),
    ).toEqual({ accepted: true })
    await until(async () => (await state.remote.deps.runtime.registry.read()).accounts.length === 2)
  }, 30_000)

  afterAll(async () => {
    await state.handle?.release()
    await state.detach?.()
    await state.remote?.[Symbol.asyncDispose]()
    await state.local?.[Symbol.asyncDispose]()
  })

  test("the host request carries the leased Bearer token and nothing Codex-specific", async () => {
    const granted = await state.handle.api.headers(state.account, "ses_r1", "/home/u")
    if (!granted.ok) throw new Error(`lease failed: ${granted.problem}`)
    expect(granted.headers).toEqual({ authorization: `Bearer ${ACCESS}` })
    const local = await state.local.deps.runtime.credentials.headersFor({ account: state.account, sessionID: "ses_r1" })
    expect(local.ok && local.headers).toEqual(granted.headers)
  })

  test("the host's request hook sends the lease with token sharing's session headers and no Codex header", async () => {
    // The host's own-accounts as a remote service runs it: the mirrored slot, credentials from the broker's lease.
    const deps = {
      ...state.remote.deps,
      runtime: state.handle.wrap(state.remote.deps.runtime),
      remote: state.handle.api,
    }
    const modules = Modules.create(deps, {
      plugins: (base, peers) => ({
        ...Modules.FACTORIES.plugins(base, peers),
        trustStatus: () => "ok",
        trustSettled: async () => "ok",
        claudeSlot: () => ({ detected: false, version: null, integrity: null, verified: false }),
      }),
    })
    await modules.slots.start()
    await modules.auth.start()
    await using _modules = {
      [Symbol.asyncDispose]: async () => {
        await modules.auth.stop()
        await modules.slots.stop()
      },
    }
    const hook = (await registeredHooks({ t: { deps }, modules })).get("model.request")
    if (!hook) throw new Error("no model.request hook")
    const model = ref(state.account.providerID, "gpt-5.5")
    // Whatever the request already carries is dropped: another session's headers and the Codex route's own.
    const parent = modelRequest("ses_r3", model, {
      "Session-Id": "ses_stale",
      "Thread-Id": "ses_stale",
      "x-client-request-id": "req_stale",
      "chatgpt-account-id": "stale",
      originator: "opencode",
      "X-Codex-Beta-Features": "remote_compaction_v2",
    })
    await hook(parent)
    expect(parent.headers).toEqual({
      "x-session-affinity": "ses_r3",
      authorization: `Bearer ${ACCESS}`,
      "session-id": "ses_r3",
      "thread-id": "ses_r3",
      "x-client-request-id": "ses_r3",
    })
    // A subagent routes on its parent's affinity; the thread is its own session, as on this PC.
    const child = modelRequest("ses_r3_child", model, { "x-session-affinity": "ses_r3" })
    await hook(child)
    expect(child.headers).toEqual({
      "x-session-affinity": "ses_r3",
      authorization: `Bearer ${ACCESS}`,
      "session-id": "ses_r3",
      "thread-id": "ses_r3_child",
      "x-client-request-id": "ses_r3_child",
    })
  })

  test("a token whose refresh is deferred is leased until the refresh may run and never refreshed early", async () => {
    const granted = await state.handle.api.headers(state.held, "ses_r2", "/home/u")
    if (!granted.ok) throw new Error(`lease failed: ${granted.problem}`)
    expect(granted.headers).toEqual({ authorization: `Bearer ${HELD}` })
    // Up to `earliest_refresh_at` (three minutes), not only to five minutes before the expiry (one minute).
    expect(granted.expiresAt).toBeLessThanOrEqual(Date.now() + 3 * 60_000)
    expect(granted.expiresAt).toBeGreaterThan(Date.now() + 60_000)
    expect(state.refreshes).toBe(0)
  })
})

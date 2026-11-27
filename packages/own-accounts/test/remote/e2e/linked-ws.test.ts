// RG7 (b) remote half and the RG6 WebSocket rewrite, end to end over the fake-SSH harness (04 §8.5–8.8, §20.3).
// Run here and not on the real host: the remote Codex slot's endpoint is chatgpt.com in production, and Bun's
// WebSocket client ignores HTTPS_PROXY, so a remote Codex request that escaped the sink could not be caught there.
// Here the remote service's Codex endpoint is a fake, so an escaped handshake is recorded instead of leaving the PC.
//
//   L (own-accounts local: a LINKED Codex login of the old app's layout, FAKE tokens) → broker ← R (real server from
//   source, own-accounts mode:"remote", Codex slot → the fake Codex backend; WebSocket transport by default)
//
// 1. The source token has 6 minutes left (< 5 min + 120 s minimum): R's request is refused as `source_stale`, the
//    WebSocket handshake is rewritten to R's sink, the fake Codex backend sees nothing (neither WebSocket nor HTTP),
//    the turn ends without the grace, the local account stays usable, no token endpoint call, auth.json untouched.
// 2. The "old app" writes a fresh token: the host is released (`ready` push) and the next turn reaches the fake over
//    the WebSocket with the new token.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import * as Harness from "../../../../own-remote/test/harness/remote.js"
import {
  E2E_TRANSPILER_CACHE,
  REPO_ROOT,
  chatGPTAccount,
  manualClock,
  opencodeConfig,
  removeTree,
  startFakeCodex,
  startOpencodeServer,
  updateCodexMultiProviderAuth,
  writeCodexMultiProviderProfiles,
  type FakeCodex,
  type LegacyProfile,
  type OpencodeServer,
} from "../../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.0.18-own.9"
const LEASE_MS = 4_000
const BROKER_WAIT_MS = 1_500
const GRACE_SECONDS = 20
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE = path.join(REPO_ROOT, "packages/own-remote")
const PERSON = chatGPTAccount({ accountID: "acct-linked-ws-e2e" })

type Json = Record<string, any>

async function until<T>(read: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs: number, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`timeout${last ? `: ${String(last)}` : ""}`)
    await Bun.sleep(stepMs)
  }
}

run("linked Codex account on a remote host over fake SSH: source_stale → sink (WebSocket), then released", () => {
  const state = {} as {
    harness: Harness.Harness
    codex: FakeCodex
    clock: ReturnType<typeof manualClock>
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    linked: Json
    profile: LegacyProfile
    scratch: string
    hash: string
    mtime: number
    model: string
  }

  async function local(id: string, method: string, input: unknown = {}) {
    const response = await state.local.request("POST", `/api/rpc/${id}/${method}`, {
      body: { input },
      query: { "location[directory]": state.control },
      directory: state.control,
    })
    const body = JSON.parse(await response.text()) as Json
    if (response.status !== 200) throw new Error(`${id}/${method}: ${response.status} ${JSON.stringify(body)}`)
    return body.output as Json
  }
  // Plugins load in the background since upstream v2.4.0 (#63814), in every Location of the host's service too: an RPC
  // into a Location that just booted answers `rpc.unavailable` until the plugin registered there (asked again, 60 s).
  async function remote(method: string, route: string, options: Parameters<typeof remoteOnce>[2] = {}) {
    const deadline = Date.now() + 60_000
    while (true) {
      const result = await remoteOnce(method, route, options)
      const body: unknown = result.body
      const unavailable =
        typeof body === "object" && body !== null && "type" in body && body.type === "rpc.unavailable"
      if (!route.startsWith("/api/rpc/") || !unavailable || Date.now() > deadline) return result
      await Bun.sleep(200)
    }
  }
  async function remoteOnce(method: string, route: string, options: { body?: unknown; directory?: string } = {}) {
    const url = new URL(route, state.remote.url)
    const directory = options.directory ?? state.workspace
    if (route.startsWith("/api/rpc/")) url.searchParams.set("location[directory]", directory)
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Basic ${btoa(`opencode:${state.remote.token}`)}`,
        "x-opencode-directory": encodeURIComponent(directory),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  const host = async () => ((await local("own.remote", "hosts.list")).hosts as Json[]).find((item) => item.id === state.hostId)!
  async function connect() {
    await local("own.remote", "connect", { hostId: state.hostId, clientId: "e2e-tab" })
    return until(async () => {
      const view = await host()
      return view.stage === "ready" || view.stage === "needs_install" || view.paused ? view : undefined
    }, 240_000, 500)
  }
  const fileState = () => ({
    hash: createHash("sha256").update(fs.readFileSync(state.profile.authPath)).digest("hex"),
    mtime: fs.statSync(state.profile.authPath).mtimeMs,
  })

  beforeAll(async () => {
    // The fake mints with its own clock: 54 minutes behind, a 60-minute token has 6 minutes of real time left.
    state.clock = manualClock(Date.now() - 54 * 60_000)
    state.codex = startFakeCodex({ accounts: [PERSON], clock: state.clock })
    const buildId = `e2e-remote-linked-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-accounts-linked-ws-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    ;[state.profile] = await writeCodexMultiProviderProfiles(path.join(state.scratch, "control-center"), [
      { id: "07", alias: "work", tokens: state.codex.login(PERSON) },
    ])
    ;({ hash: state.hash, mtime: state.mtime } = fileState())
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        lab: {
          env: {
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(import.meta.dir, "real-service.ts")),
            OWN_E2E_CONFIG: Harness.toPosix(configFile),
          },
        },
      },
    })
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        repo: REPO_ROOT,
        buildId,
        // R's Codex slot talks to the fake (production: chatgpt.com).
        endpoints: { codex: state.codex.baseURL },
        logs: path.join(state.harness.testRoot, "e2e-logs"),
        transpilerCache: E2E_TRANSPILER_CACHE,
      }),
    )
    state.local = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: {
                home: paths.ownHome,
                buildId,
                vault: "memory",
                codexImportRoot: path.join(state.scratch, "control-center"),
                endpoints: { codex: state.codex.baseURL, oauthIssuer: state.codex.url, chatgpt: state.codex.url },
                broker: { leaseMs: LEASE_MS, brokerWaitMs: BROKER_WAIT_MS },
              },
            },
            {
              package: REMOTE,
              options: {
                home: paths.ownHome,
                buildId,
                version: VERSION,
                sshCommand: state.harness.sshCommand,
                askpassHelper: state.harness.askpassHelper,
                remoteBundles: state.harness.bundles,
                sshDir: state.harness.sshDir,
                keepIntervalSeconds: 1,
                readyTimeoutMs: 120_000,
                backoffMs: [60_000],
                lingerSeconds: 0,
              },
            },
          ],
        }),
    })
    state.control = path.join(state.local.paths.ownHome, "control")
    fs.mkdirSync(state.control, { recursive: true })
  }, 240_000)

  afterAll(async () => {
    await state.local?.stop()
    await state.harness?.cleanup()
    await state.codex?.stop()
    if (state.scratch) await removeTree(state.scratch)
  }, 120_000)

  test("the linked login is imported on this PC; the host is installed, connected and mirrors the Codex slot", async () => {
    const plan = await local(OwnAccounts.ID, "accounts.import.codex.plan", { profileID: "07", mode: "linked" })
    const imported = await local(OwnAccounts.ID, "accounts.import.codex.execute", { nonce: plan.nonce, label: "Linked" })
    expect(imported.mode).toBe("linked")
    state.linked = imported.account
    const added = await local("own.remote", "hosts.add", { alias: "lab" })
    state.hostId = added.host.id
    await local("own.remote", "hosts.update", { hostId: state.hostId, failClosedGraceSeconds: GRACE_SECONDS })
    expect((await connect()).stage).toBe("needs_install")
    const prepare = await local("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await local("own.remote", "prepare.execute", { nonce: prepare.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await local("own.remote", "resolve", { hostId: state.hostId })
    // The remote service serves on the harness's free port, never on the channel default the installed service holds.
    expect(state.harness.registeredPort("lab")).toBe(state.harness.servicePort("lab"))
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("lab"), "work")
    await until(async () => {
      const result = await remote("POST", `/api/rpc/${OwnAccounts.ID}/health`, { body: { input: {} }, directory: state.remote.controlDir })
      return result.body?.output?.broker?.state === "connected" && result.body.output.mirror?.revision !== null
    }, 120_000, 500)
    const models = await until(async () => {
      const listed = await remote("GET", "/api/model")
      const own = ((listed.body?.data ?? []) as Json[]).filter((model) => model.providerID === state.linked.providerID)
      return own.length > 0 ? own : undefined
    }, 60_000, 500)
    state.model = models[0]!.id
  }, 600_000)

  test("a token below the minimum validity: source_stale → the WebSocket goes to the sink, nothing reaches the backend", async () => {
    state.codex.reset()
    const created = await remote("POST", "/api/session", {
      body: { title: "linked", model: { providerID: state.linked.providerID, id: state.model }, location: { directory: state.workspace } },
    })
    expect(created.status).toBe(200)
    const sessionID = created.body.data.id as string
    const started = Date.now()
    expect((await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text: "linked on the host, short token" } })).status).toBe(200)
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    const took = Date.now() - started
    // No grace for a refused lease (04 §8.5 "source_stale은 유예 대상이 아니다").
    expect(took).toBeLessThan(GRACE_SECONDS * 1000)
    // Neither the WebSocket handshake nor an HTTP fallback reached the Codex backend.
    expect(state.codex.requests.filter((request) => request.path.startsWith("/backend-api/codex"))).toEqual([])
    const messages = await remote("GET", `/api/session/${sessionID}/message`)
    expect(messages.body.data[0]).toMatchObject({ type: "idle", outcome: "failed" })
    const view = await until(async () => {
      const current = await host()
      return current.broker.sourceStale.length > 0 ? current : undefined
    }, 30_000, 250)
    expect(view.broker.sourceStale).toContain(state.linked.id)
    // The local account stays usable; nothing refreshed, nothing written to the old app's file.
    const accounts = (await local(OwnAccounts.ID, "accounts.list")).accounts as Json[]
    expect(accounts.find((account) => account.id === state.linked.id)?.status).toBe("ready")
    expect(state.codex.refreshCount(PERSON.accountID)).toBe(0)
    expect(fileState()).toEqual({ hash: state.hash, mtime: state.mtime })
  }, 240_000)

  test("the old app writes a fresh token: the host is released and the next turn reaches the backend over the WebSocket", async () => {
    state.clock.set(Date.now())
    await updateCodexMultiProviderAuth(state.profile, state.codex.login(PERSON))
    // The leader's 1-minute stat watch pushes `ready` for this host (04 §8.5 "풀림").
    await until(async () => (await host()).broker.sourceStale.length === 0, 150_000, 1_000)
    state.codex.reset()
    const created = await remote("POST", "/api/session", {
      body: { title: "linked 2", model: { providerID: state.linked.providerID, id: state.model }, location: { directory: state.workspace } },
    })
    const sessionID = created.body.data.id as string
    expect((await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text: "linked on the host, fresh token" } })).status).toBe(200)
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    const calls = state.codex.requests.filter((request) => request.path.startsWith("/backend-api/codex"))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((call) => call.transport === "websocket" && call.identity === `codex:${PERSON.accountID}`)).toBe(true)
    const messages = await remote("GET", `/api/session/${sessionID}/message`)
    expect(messages.body.data[0]).toMatchObject({ type: "idle", outcome: "succeeded" })
    expect(state.codex.refreshCount(PERSON.accountID)).toBe(0)
  }, 300_000)
})

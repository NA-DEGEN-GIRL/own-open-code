// Boots the upstream server from source with both own plugins loaded from their package directories (the
// development config of 02 §8.2) and checks the wiring end to end: guard 1, runtime acquire, RPC registration with
// declared errors, and the health-only registration when the guard fails.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  opencodeConfig,
  startOpencodeServer,
  type OpencodeServer,
  type OpencodeServerPaths,
} from "./e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")

function config(buildId: string) {
  return (paths: OpencodeServerPaths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        { package: ACCOUNTS, options: { home: paths.ownHome, buildId, vault: "memory" } },
        { package: TELEMETRY, options: { home: paths.ownHome, buildId } },
      ],
    })
}

async function rpc(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function ready(server: OpencodeServer) {
  const deadline = Date.now() + 120_000
  while ((await rpc(server, "health")).body.type === "rpc.unavailable") {
    if (Date.now() > deadline) throw new Error("own.accounts did not register within 120 s")
    await Bun.sleep(250)
  }
}

describe("own plugins on a real server", () => {
  const state: { managed?: OpencodeServer; unmanaged?: OpencodeServer } = {}

  beforeAll(async () => {
    const [managed, unmanaged] = await Promise.all([
      startOpencodeServer({ config: config("e2e-managed"), env: { OWN_OPEN_CODE: "1" } }),
      startOpencodeServer({ config: config("e2e-unmanaged"), env: { OWN_OPEN_CODE: undefined } }),
    ])
    state.managed = managed
    state.unmanaged = unmanaged
    // Plugins load in the background since upstream v2.4.0 (#63814): `health` is the one method an unmanaged instance
    // registers too, so both answer it once own.accounts has loaded; the plugin list shows both plugins once their
    // activation finished.
    await Promise.all([ready(managed), ready(unmanaged)])
    await Promise.all([managed.waitForPlugins(2), unmanaged.waitForPlugins(2)])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await Promise.all([state.managed?.stop(), state.unmanaged?.stop()])
  })

  test("a managed instance registers every method and answers declared errors as HTTP 400", async () => {
    const server = state.managed
    if (!server) throw new Error("server did not start")
    const health = await rpc(server, "health")
    expect(health.status).toBe(200)
    expect(health.body.output).toMatchObject({
      guard: "ok",
      buildId: "e2e-managed",
      vault: "ok",
      registryRevision: 0,
      controlDir: path.join(server.paths.ownHome, "control"),
    })
    // Every group is implemented: an empty registry lists nothing, and a declared error is an HTTP 400 RpcError
    // (02 §9.4), not a 500.
    const list = await rpc(server, "accounts.list")
    expect(list.status).toBe(200)
    expect(list.body.output).toEqual({ revision: 0, accounts: [] })
    const stale = await rpc(server, "accounts.remove.execute", { nonce: "nonce-never-issued-0000" })
    expect(stale.status).toBe(400)
    expect(stale.body).toMatchObject({ type: "nonce_invalid" })

    const plugins = (await server.call("GET", "/api/plugin", {
      query: { "location[directory]": server.paths.workspace },
    })) as { readonly data: ReadonlyArray<{ readonly id?: string; readonly state: { readonly status: string } }> }
    const states = Object.fromEntries(plugins.data.map((plugin) => [plugin.id, plugin.state.status]))
    expect(states).toMatchObject({ "own.accounts": "active", "own.telemetry": "active" })
    expect(server.logs()).toContain('"scope":"own.accounts","msg":"ready"')
    expect(server.logs()).not.toMatch(/setup_failed|hook_failed|module_start_failed/)
  })

  test("an unmanaged instance registers only health and reports the guard", async () => {
    const server = state.unmanaged
    if (!server) throw new Error("server did not start")
    const health = await rpc(server, "health")
    expect(health.status).toBe(200)
    expect(health.body.output).toMatchObject({ guard: "unmanaged", buildId: "e2e-unmanaged" })
    const list = await rpc(server, "accounts.list")
    expect(list.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(list.body)).toContain("rpc.method_not_found")
    expect(server.logs()).toContain("guard_failed")
  })
})

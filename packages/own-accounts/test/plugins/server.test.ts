// End to end on a real server (source build): the allowlist blocks an unknown plugin until it is approved, and the
// Claude plugin the app ships (02 §8.2) is detected from the live plugin list and verified with no consent. The
// "claude-auth" here is a fake bundle in the temp OWN_HOME's app folder; nothing is downloaded and no real profile is
// read.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { Hash } from "@own/runtime"
import { REPO_ROOT, removeTree, startOpencodeServer, type OpencodeServer } from "../e2e-kit"
import { writeFakeClaudeAuth } from "../support/fake-claude-auth.js"
import { FAKE_PIN } from "./support.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 240_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const UNTRUSTED = 'export default { id: "e2e.untrusted", setup: () => {} }\n'

async function rpc(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  return {
    status: response.status,
    body: (await response.json()) as { output?: unknown; type?: string; message?: string },
  }
}

async function output(server: OpencodeServer, method: string, input: unknown = {}) {
  const result = await rpc(server, method, input)
  if (result.status !== 200) throw new Error(`${method}: ${result.status} ${JSON.stringify(result.body)}`)
  return result.body.output as Record<string, unknown>
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  const attempt = async (): Promise<T> => {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(250)
    return attempt()
  }
  return attempt()
}

async function anthropicActivation(server: OpencodeServer) {
  const result = (await server.call("GET", "/api/provider/anthropic")) as {
    readonly data: { readonly activation: string }
  }
  return result.data.activation
}

describe("plugins module on a real server", () => {
  const state: { server?: OpencodeServer; root?: string } = {}
  const paths = (root: string) => ({
    ownHome: path.join(root, "own-home"),
    workspace: path.join(root, "workspace"),
    // The app version folder of a source run without an installed version (app/current/plugins/claude-auth).
    bundle: path.join(root, "own-home", "app", "current", "plugins", "claude-auth"),
    untrusted: path.join(root, "workspace", "untrusted-plugin"),
  })

  beforeAll(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-plugins-")))
    state.root = root
    const p = paths(root)
    writeFakeClaudeAuth(p.bundle, { multi: true })
    await fs.mkdir(p.untrusted, { recursive: true })
    await Bun.write(path.join(p.untrusted, "index.js"), UNTRUSTED)
    const buildId = "e2e-plugins"
    state.server = await startOpencodeServer({
      root,
      env: { OWN_OPEN_CODE: "1", OPENCODE_DISABLE_FILEWATCHER: undefined },
      config: (server) => ({
        plugins: [
          { package: ACCOUNTS, options: { home: server.ownHome, buildId, vault: "memory" } },
          p.bundle,
          { package: TELEMETRY, options: { home: server.ownHome, buildId } },
          p.untrusted,
        ],
      }),
    })
    // Plugins load in the background since upstream v2.4.0 (#63814): own.accounts answers once it has registered.
    const server = state.server
    await until(async () => ((await rpc(server, "health")).body.type === "rpc.unavailable" ? undefined : true), 120_000)
  }, BOOT_TIMEOUT)

  // Graceful stop may take up to 10 s before the harness kills the process tree, then the temp root is removed.
  afterAll(async () => {
    await state.server?.stop()
    if (state.root) await removeTree(state.root).catch(() => undefined)
  }, 60_000)

  test(
    "allowlist: an unknown configured plugin blocks the Location until approved",
    async () => {
      const server = state.server
      if (!server) throw new Error("server did not start")
      const p = paths(server.paths.root)
      const entry = path.join(p.untrusted, "index.js")
      const listed = await until(async () => {
        const list = (await output(server, "plugin.trust.list")) as unknown as {
          readonly locations: ReadonlyArray<{
            readonly status: string
            readonly plugins: ReadonlyArray<{ source: string }>
          }>
        }
        return list.locations.find((location) => location.plugins.length > 0)
      })
      expect(listed).toMatchObject({
        status: "blocked_by_plugin",
        plugins: [{ id: "e2e.untrusted", source: `local:${entry}`, sha256: Hash.sha256(UNTRUSTED), approved: false }],
      })
      const health = await output(server, "health")
      expect(health).toMatchObject({ guard: "ok", locations: [{ allowlist: "blocked_by_plugin" }] })

      const plan = (await output(server, "plugin.trust.approve.plan", {
        directory: server.paths.workspace,
        sources: [`local:${entry}`],
      })) as unknown as { nonce: string; plugins: unknown[] }
      expect(plan.plugins).toEqual([{ id: "e2e.untrusted", source: `local:${entry}`, sha256: Hash.sha256(UNTRUSTED) }])
      expect(await output(server, "plugin.trust.approve.execute", { nonce: plan.nonce })).toMatchObject({
        status: "ok",
      })
      expect(await Bun.file(path.join(p.ownHome, "trust.json")).json()).toEqual([
        expect.objectContaining({ source: `local:${entry}`, sha256: Hash.sha256(UNTRUSTED) }),
      ])
      expect(await output(server, "health")).toMatchObject({ locations: [{ allowlist: "ok" }] })
    },
    BOOT_TIMEOUT,
  )

  test(
    "the Claude plugin ships with the app: detected and verified with no consent; anthropic keeps its activation",
    async () => {
      const server = state.server
      if (!server) throw new Error("server did not start")
      const detected = await until(async () => {
        const status = await output(server, "plugin.claudeAuth.status")
        return (status as { order?: string }).order === "ok" ? status : undefined
      })
      expect(detected).toMatchObject({
        installed: true,
        version: FAKE_PIN.version,
        integrityOk: true,
        order: "ok",
        phase: "installed",
        acknowledged: null,
        connection: null,
        warnings: [],
        patch: { state: "patched", loaded: true },
        bundle: { version: FAKE_PIN.version, integrity: FAKE_PIN.integrity },
      })
      // Verified: the fold leaves the built-in activation (connection presence decides availability, 02 §8.4).
      await until(async () => ((await anthropicActivation(server)) === "disabled" ? undefined : true))
      const health = await output(server, "health")
      expect(health).toMatchObject({ pluginVersions: { claudeAuth: FAKE_PIN.version } })
      expect((health.warnings as string[]).filter((warning) => warning.startsWith("claude_auth"))).toEqual([])
      // The retired consent answers; the retired jobs are refused.
      expect(await output(server, "plugin.claudeAuth.ack", { ...FAKE_PIN, noticeHash: "0".repeat(64) })).toHaveProperty(
        "acknowledgedAt",
      )
      const uninstall = await rpc(server, "plugin.claudeAuth.uninstall.plan")
      expect(uninstall.status).toBe(400)
      expect(uninstall.body).toMatchObject({ type: "internal_error" })
      expect(server.logs()).not.toMatch(/hook_failed|module_start_failed|refresh_failed/)
    },
    BOOT_TIMEOUT,
  )
})

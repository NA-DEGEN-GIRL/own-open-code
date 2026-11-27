// The real bundled claude-auth (02 §8.2: the pinned plugin, patched and bundled by own/scripts/claude-auth-bundle.ts)
// loaded by a real server from source, where an install puts it (`<OWN_HOME>\app\current\plugins\claude-auth` of a
// temp OWN_HOME): the host provides `@opencode/plugin` and `effect`, own-accounts verifies the bundle with no consent,
// names its state folder and the plugin holds no login. The child's user profile, Claude Code folder and OWN_HOME are
// temp folders, so no real login is ever read; with no Claude account nothing is sent. Skipped without a built bundle
// (`support/claude-auth-bundle.ts`).

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnAccounts, Plugin } from "@own/protocol"
import { REPO_ROOT, removeTree, startOpencodeServer, type OpencodeServer } from "../e2e-kit"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import { INTEGRITY, source, VERSION } from "../support/claude-auth-bundle.js"

setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 240_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const from = source()

async function output(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body = (await response.json()) as { output?: unknown }
  if (response.status !== 200) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output as Record<string, unknown>
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

describe.skipIf(from === undefined)("the bundled Claude plugin on a real server", () => {
  const state: { server?: OpencodeServer; root?: string } = {}
  const paths = (root: string) => ({
    ownHome: path.join(root, "own-home"),
    bundle: path.join(root, "own-home", "app", "current", "plugins", ClaudeBundle.DIR_NAME),
    profile: path.join(root, "profile"),
  })

  beforeAll(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-e2e-bundled-")))
    state.root = root
    const p = paths(root)
    fs.cpSync(from!, p.bundle, { recursive: true })
    fs.mkdirSync(path.join(p.profile, ".claude"), { recursive: true })
    const buildId = "e2e-bundled"
    state.server = await startOpencodeServer({
      root,
      env: {
        OWN_OPEN_CODE: "1",
        // The default Claude Code folder (`<userHome>\.claude`) and every path the plugin may read: temp only.
        USERPROFILE: p.profile,
        HOMEDRIVE: undefined,
        HOMEPATH: undefined,
        CLAUDE_CONFIG_DIR: path.join(p.profile, ".claude"),
      },
      config: (server) => ({
        plugins: [
          { package: ACCOUNTS, options: { home: server.ownHome, buildId, vault: "memory" } },
          p.bundle,
          { package: TELEMETRY, options: { home: server.ownHome, buildId } },
        ],
      }),
    })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    if (state.root) await removeTree(state.root)
  }, 60_000)

  test(
    "loads with the host's modules, verified and patched, no consent, no account, nothing to sign",
    async () => {
      const server = state.server
      if (!server) throw new Error("server did not start")
      const p = paths(server.paths.root)
      const status = await until(async () => {
        const found = await output(server, "plugin.claudeAuth.status")
        return (found as { patch?: { loaded?: boolean } }).patch?.loaded === true ? found : undefined
      })
      expect(status).toMatchObject({
        installed: true,
        version: VERSION,
        integrityOk: true,
        order: "ok",
        acknowledged: null,
        connection: null,
        warnings: [],
        patch: { state: "patched", loaded: true },
        bundle: { version: VERSION, integrity: INTEGRITY },
      })
      const plugins = (await server.call("GET", "/api/plugin")) as {
        readonly data: ReadonlyArray<{ readonly id: string; readonly state: { readonly status: string } }>
      }
      expect(plugins.data.find((plugin) => plugin.id === Plugin.CLAUDE_AUTH_ID)?.state.status).toBe("active")
      const health = await output(server, "health")
      expect(health).toMatchObject({ pluginVersions: { claudeAuth: VERSION } })
      expect((health.warnings as string[]).filter((warning) => warning.startsWith("claude_auth"))).toEqual([])
      // The plugin's state lives in the state folder own named, outside the versioned folder; account 1 is the temp
      // profile's Claude Code folder, which holds no login, so the plugin holds none.
      const list = JSON.parse(
        fs.readFileSync(path.join(p.ownHome, "thirdparty", "claude-auth", ClaudeBundle.ACCOUNTS_FILE), "utf8"),
      ) as { readonly accounts: ReadonlyArray<{ readonly configDir: string }> }
      expect(list.accounts.map((item) => path.resolve(item.configDir).toLowerCase())).toEqual([
        path.resolve(p.profile, ".claude").toLowerCase(),
      ])
      const accounts = (await output(server, "accounts.list")).accounts as ReadonlyArray<{ readonly id: string }>
      expect(accounts.find((item) => item.id === "acc_claude_slot")).toMatchObject({
        status: "needs_reauth",
        claude: { default: true, loaded: false },
      })
      expect(fs.readdirSync(p.bundle).sort()).toEqual(["node_modules", "own-bundle.json", "package.json", "server.js"])
      expect(server.logs()).not.toMatch(/hook_failed|module_start_failed|refresh_failed/)
    },
    BOOT_TIMEOUT,
  )
})

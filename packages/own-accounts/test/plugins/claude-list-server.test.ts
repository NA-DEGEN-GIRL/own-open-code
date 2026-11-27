// CL (2026-11-27): own-web's first `accounts.list` after a service start reached a control Location whose plugin list
// still described the previous generation, so it had no Claude subscription account. claude-auth was detected a moment
// later, which moves no registry revision, and nothing told the clients: 계정 관리 showed account 1's card without its
// account, and AC-01..04 were missing from 계정·한도 and from the SSH host's switcher (whose list copies this PC's).
// A real server from source with the real bundled claude-auth and four Claude accounts in own login folders; every
// login is a fake whose token does not expire, so nothing is refreshed or sent. Skipped without a built bundle.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { Store } from "@own/runtime"
import {
  REPO_ROOT,
  recordServerEvents,
  removeTree,
  startOpencodeServer,
  type EventRecorder,
  type OpencodeServer,
} from "../e2e-kit"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import { ClaudeLogin } from "../../src/claude/login.js"
import { source } from "../support/claude-auth-bundle.js"

setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 240_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const ADDED = ["acc_01J9CLAUDETWO0000000000000", "acc_01J9CLAUDETHREE00000000000", "acc_01J9CLAUDEFOUR000000000000"]
const from = source()

describe.skipIf(from === undefined)("the Claude accounts on a new control Location", () => {
  const state: { server?: OpencodeServer; root?: string; events?: EventRecorder; control?: string } = {}

  beforeAll(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-e2e-claude-list-")))
    state.root = root
    const ownHome = path.join(root, "own-home")
    const profile = path.join(root, "profile")
    fs.cpSync(from!, path.join(ownHome, "app", "current", "plugins", ClaudeBundle.DIR_NAME), { recursive: true })
    fs.mkdirSync(path.join(profile, ".claude"), { recursive: true })
    // Account 1 moved to an own login folder, three added ones; the second is the default.
    const folders = ["acc_01J9SLOTMOVED0000000000000", ...ADDED].map((id) => path.join(ownHome, "claude-accounts", id))
    for (const [index, folder] of folders.entries()) {
      fs.mkdirSync(folder, { recursive: true })
      const oauth = {
        accessToken: `fake-${index}`,
        refreshToken: `fake-r-${index}`,
        expiresAt: Date.now() + 6 * 3_600_000,
      }
      fs.writeFileSync(path.join(folder, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }))
    }
    const registry = {
      ...Store.emptyRegistry(),
      claudeSlot: {
        accountID: "acc_claude_slot",
        label: "AC-01",
        shortLabel: "A1",
        color: "orange",
        configDir: folders[0],
      },
      claudeAccounts: ADDED.map((accountID, index) => ({
        accountID,
        key: ClaudeLogin.key(folders[index + 1]!),
        configDir: folders[index + 1],
        label: `AC-0${index + 2}`,
        shortLabel: `A${index + 2}`,
        color: "amber",
        managed: true,
        addedAt: "2026-10-18T00:00:00Z",
      })),
      claudeDefault: ADDED[0],
    }
    fs.mkdirSync(ownHome, { recursive: true })
    fs.writeFileSync(path.join(ownHome, "accounts.json"), JSON.stringify(registry, null, 2))
    const buildId = "e2e-claude-list"
    state.server = await startOpencodeServer({
      root,
      env: {
        OWN_OPEN_CODE: "1",
        USERPROFILE: profile,
        HOMEDRIVE: undefined,
        HOMEPATH: undefined,
        CLAUDE_CONFIG_DIR: path.join(profile, ".claude"),
      },
      config: (server) => ({
        plugins: [
          { package: ACCOUNTS, options: { home: server.ownHome, buildId, vault: "memory" } },
          path.join(server.ownHome, "app", "current", "plugins", ClaudeBundle.DIR_NAME),
          { package: TELEMETRY, options: { home: server.ownHome, buildId } },
        ],
      }),
    })
    // The launcher creates the empty control directory (02 §9.1); its instance is the leader.
    state.control = path.join(state.server.paths.ownHome, "control")
    fs.mkdirSync(state.control, { recursive: true })
    state.events = await recordServerEvents(state.server)
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.events?.close()
    await state.server?.stop()
    if (state.root) await removeTree(state.root)
  }, 60_000)

  test(
    "a list read before claude-auth's detection is followed by plugin.status, and the list then names every account",
    async () => {
      const server = state.server!
      const claudeIDs = async () => {
        const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/accounts.list`, {
          body: { input: {} },
          query: { "location[directory]": state.control! },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { output: { accounts: ReadonlyArray<{ id: string; kind: string }> } }
        return body.output.accounts.filter((item) => item.kind === "claude-sub").map((item) => item.id)
      }
      const first = await claudeIDs()
      // What own-web does on its first read; the Location is new, so claude-auth is usually not detected yet.
      if (first.length === 0)
        await state.events!.waitFor((event) => event.type === "rpc.own.accounts.plugin.status", 120_000)
      expect(await claudeIDs()).toEqual(["acc_claude_slot", ...ADDED])
      expect(server.logs()).not.toMatch(/refresh_failed|module_start_failed/)
    },
    BOOT_TIMEOUT,
  )
})

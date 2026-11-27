// End to end on a real server (AC-P39 shape): a fake old-app control center is imported over RPC in linked mode and a
// session prompt goes to the fake Codex backend with the source's token; the old app's refresh (fixture) is followed
// without own-accounts refreshing; a takeover then refreshes once through the fake OAuth issuer and the source file
// stays byte-for-byte untouched. Needs SLOTS (slot registration), AUTH (injection) and PLUGINS (trust) as well.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  hashSecret,
  opencodeConfig,
  removeTree,
  startFakeChatGPTAuth,
  startFakeCodex,
  startOpencodeServer,
  updateCodexMultiProviderAuth,
  writeCodexMultiProviderProfiles,
  type ChatGPTTokens,
  type FakeChatGPTAuth,
  type FakeCodex,
  type LegacyProfile,
  type OpencodeServer,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const WORK = { accountID: "acct-e2e-work", userID: "user-e2e-work", email: "worker@example.test", plan: "plus" }

async function rpc(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body = (await response.json()) as { readonly output?: Record<string, unknown> }
  if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

describe("codex import on a real server", () => {
  const state: {
    codex?: FakeCodex
    auth?: FakeChatGPTAuth
    server?: OpencodeServer
    root?: string
    profile?: LegacyProfile
    tokens?: ChatGPTTokens
  } = {}

  beforeAll(async () => {
    const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 } })
    const auth = startFakeChatGPTAuth({ codex })
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-legacy-")))
    const tokens = codex.login(WORK)
    const [profile] = await writeCodexMultiProviderProfiles(root, [{ id: "01", alias: "work", tokens }])
    Object.assign(state, { codex, auth, root, profile, tokens })
    const buildId = `e2e-import-${process.pid}`
    state.server = await startOpencodeServer({
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
                endpoints: { codex: codex.baseURL, oauthIssuer: auth.url },
                codexImportRoot: root,
              },
            },
            { package: TELEMETRY, options: { home: paths.ownHome, buildId } },
          ],
        }),
    })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await Promise.all([state.codex?.stop(), state.auth?.stop()])
    if (state.root) await removeTree(state.root)
  })

  test(
    "linked import serves a prompt with the source token, follows the old app's refresh, then takeover refreshes once",
    async () => {
      const server = state.server
      const codex = state.codex
      const auth = state.auth
      const profile = state.profile
      const tokens = state.tokens
      if (!server || !codex || !auth || !profile || !tokens) throw new Error("setup failed")

      const listed = await rpc(server, "accounts.import.codex.list")
      expect(listed).toMatchObject({ available: true, sources: [{ profileID: "01", importable: true }] })
      const planned = await rpc(server, "accounts.import.codex.plan", { profileID: "01" })
      expect(planned.warnings).toEqual(["linked_depends_on_source"])
      const executed = await rpc(server, "accounts.import.codex.execute", { nonce: planned.nonce })
      const account = executed.account as { readonly id: string; readonly providerID: string }
      expect(executed.mode).toBe("linked")

      // The new slot appears after the provider reload; use whatever the pinned codex template holds.
      const model = await modelOf(server, account.providerID)
      const session = (await server.createSession({
        model: { providerID: account.providerID, id: model },
        title: "e2e",
      })) as {
        readonly id: string
      }
      const turn = async (text: string) => {
        const before = codex.requests.length
        await server.prompt(session.id, text)
        await server.waitIdle(session.id)
        const sent = codex.requests.slice(before).filter((request) => request.path.endsWith("/responses"))
        expect(sent.length).toBeGreaterThan(0)
        return sent
      }

      const source = await fs.readFile(profile.authPath, "utf8")
      const first = await turn("hello")
      expect(
        first.every((request) => request.headers.authorization === hashSecret(`Bearer ${tokens.accessToken}`)),
      ).toBe(true)
      expect(first.every((request) => request.status === 200 || request.status === 101)).toBe(true)
      expect(first[0]?.headers["chatgpt-account-id"]).toBe(WORK.accountID)

      // The old app refreshes the profile; the next request uses its new token and we never call the token endpoint.
      const rotated = codex.refresh(tokens.refreshToken)
      if (rotated.type !== "ok") throw new Error("old app refresh failed")
      await updateCodexMultiProviderAuth(profile, rotated.tokens)
      const written = await fs.readFile(profile.authPath, "utf8")
      expect(written).not.toBe(source)
      await Bun.sleep(1_200)
      const second = await turn("again")
      expect(second.at(-1)?.headers.authorization).toBe(hashSecret(`Bearer ${rotated.tokens.accessToken}`))
      expect(codex.refreshCount(WORK.accountID)).toBe(1)
      expect(auth.requests.filter((request) => request.path === "/oauth/token")).toHaveLength(0)
      expect(await fs.readFile(profile.authPath, "utf8")).toBe(written)

      // Takeover of the same account: vault copy plus one forced refresh through the fake issuer.
      const takeover = await rpc(server, "accounts.import.codex.plan", {
        profileID: "01",
        mode: "takeover",
        accountID: account.id,
      })
      const taken = await rpc(server, "accounts.import.codex.execute", { nonce: takeover.nonce })
      expect(taken).toMatchObject({ mode: "takeover", reauthenticated: true, account: { id: account.id } })
      expect(codex.refreshCount(WORK.accountID)).toBe(2)
      expect(auth.requests.filter((request) => request.path === "/oauth/token")).toHaveLength(1)
      const third = await turn("after takeover")
      const ours = third.at(-1)?.headers.authorization
      expect(ours).not.toBe(hashSecret(`Bearer ${rotated.tokens.accessToken}`))
      expect(third.at(-1)?.status === 200 || third.at(-1)?.status === 101).toBe(true)
      expect(await fs.readFile(profile.authPath, "utf8")).toBe(written)
      expect(server.logs()).not.toContain(tokens.accessToken)
      expect(server.logs()).not.toContain(rotated.tokens.refreshToken)
    },
    TURN_TIMEOUT,
  )
})

async function modelOf(server: OpencodeServer, providerID: string) {
  const deadline = performance.now() + 30_000
  const find = async (): Promise<string> => {
    const models = await server.models()
    const found = models.find((model) => model.providerID === providerID && typeof model.id === "string")
    if (found && typeof found.id === "string") return found.id
    if (performance.now() > deadline) throw new Error(`no model registered for ${providerID}`)
    await Bun.sleep(250)
    return find()
  }
  return find()
}

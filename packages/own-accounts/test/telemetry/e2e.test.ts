// Telemetry end to end on a real server: a fake old-app profile is imported over RPC (linked), two prompts go to the
// fake Codex backend, and then `quota.snapshot` shows the fake's limit values (WS `codex.rate_limits` frames on the
// primary path, `x-codex-*` headers on the HTTP compaction request) and `ledger.session` has exactly one line per
// step with cache fields, plus the compaction line. Needs SLOTS, CREDENTIALS, AUTH and PLUGINS as well. Fake
// credentials only; the real old-app profiles are never read.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  opencodeConfig,
  removeTree,
  startFakeCodex,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type FakeCodex,
  type OpencodeServer,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 150_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const WORK = {
  accountID: "acct-e2e-telemetry",
  userID: "user-e2e-telemetry",
  email: "telemetry@example.test",
  plan: "plus",
}
const PROMPT = Array.from(
  { length: 30 },
  (_, index) => `line ${index}: the quick brown fox jumps over the lazy dog`,
).join("\n")

type Json = Record<string, unknown>

async function rpc(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body = (await response.json()) as { readonly output?: Json }
  if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  const attempt = async (): Promise<T> => {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(200)
    return attempt()
  }
  return attempt()
}

describe("telemetry on a real server", () => {
  const state: { codex?: FakeCodex; server?: OpencodeServer; root?: string } = {}

  beforeAll(async () => {
    const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 } })
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-telemetry-")))
    await writeCodexMultiProviderProfiles(root, [{ id: "01", alias: "work", tokens: codex.login(WORK) }])
    Object.assign(state, { codex, root })
    const buildId = `e2e-telemetry-${process.pid}`
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
                endpoints: { codex: codex.baseURL, oauthIssuer: codex.url },
                codexImportRoot: root,
                // Development seed of ratecards.json (TTL_lo for cache.state, codex credits for costs).
                ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
              },
            },
            { package: TELEMETRY, options: { home: paths.ownHome, buildId } },
          ],
        }),
    })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await state.codex?.stop()
    if (state.root) await removeTree(state.root)
  })

  test(
    "fake codex limits reach quota.snapshot; the ledger has one line per step with cache fields",
    async () => {
      const server = state.server
      const codex = state.codex
      if (!server || !codex) throw new Error("setup failed")

      const planned = await rpc(server, "accounts.import.codex.plan", { profileID: "01" })
      const executed = await rpc(server, "accounts.import.codex.execute", { nonce: planned.nonce })
      const account = executed.account as { readonly id: string; readonly providerID: string }
      // gpt-5.5 has a rate card (credits); otherwise any model of the pinned template.
      const model = await until(async () => {
        const ids = (await server.models())
          .filter((item) => item.providerID === account.providerID && typeof item.id === "string")
          .map((item) => String(item.id))
        return ids.includes("gpt-5.5") ? "gpt-5.5" : ids[0]
      }, 30_000)
      const session = (await server.createSession({
        model: { providerID: account.providerID, id: model },
        title: "telemetry e2e",
      })) as { readonly id: string }

      for (const text of [PROMPT, `${PROMPT}\nand once more`]) {
        codex.enqueue({ type: "text", text: "ok" })
        await server.prompt(session.id, text)
        await server.waitIdle(session.id)
      }

      // Limits: the primary path is the WebSocket; its `codex.rate_limits` frame carries the fake's values.
      const usage = codex.usage(WORK.accountID)
      const windows = await until(async () => {
        const snapshot = await rpc(server, "quota.snapshot", { accountIDs: [account.id] })
        const list = snapshot.windows as ReadonlyArray<Json>
        const primary = list.find((window) => window.id === "codex.primary")
        return primary?.usedPercent === usage.primary ? list : undefined
      })
      expect(windows.find((window) => window.id === "codex.primary")).toMatchObject({
        accountID: account.id,
        providerID: account.providerID,
        usedPercent: usage.primary,
        windowMinutes: 300,
        resetAt: Math.floor(usage.primaryResetAt / 1000) * 1000,
        label: "5시간",
        status: "ok",
      })
      expect(windows.find((window) => window.id === "codex.secondary")).toMatchObject({
        usedPercent: usage.secondary,
        windowMinutes: 10_080,
      })

      // Ledger: exactly one line per step, with the cache fields the fake reported.
      const sent = codex.requests.filter((request) => request.cache !== undefined && request.status === 200)
      const ledger = await until(async () => {
        const result = await rpc(server, "ledger.session", { sessionID: session.id })
        const steps = result.steps as ReadonlyArray<Json>
        return steps.length >= sent.length ? result : undefined
      })
      const steps = ledger.steps as ReadonlyArray<{
        readonly kind: string
        readonly accountID: string
        readonly providerID: string
        readonly messageID: string | null
        readonly tokens: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number } | null
        readonly P: number | null
        readonly hit: number | null
        readonly cost: { readonly unit: string } | null
      }>
      expect(steps).toHaveLength(sent.length)
      expect(new Set(steps.map((line) => line.messageID)).size).toBe(steps.length)
      steps.forEach((line, index) => {
        const cache = sent[index].cache
        expect(line).toMatchObject({ kind: "primary", accountID: account.id, providerID: account.providerID })
        expect(line.tokens).toMatchObject({
          input: (cache?.promptTokens ?? 0) - (cache?.cachedTokens ?? 0),
          cacheRead: cache?.cachedTokens,
          cacheWrite: 0,
        })
        expect(line.P).toBe(cache?.promptTokens ?? null)
        if (model === "gpt-5.5") expect(line.cost?.unit).toBe("credits")
      })
      // The second turn replays the first: the fake cache hits and the ledger shows it.
      expect(steps.at(-1)?.tokens?.cacheRead).toBeGreaterThan(0)
      expect(steps.at(-1)?.hit).toBeGreaterThan(0)
      expect(
        (ledger.totals as { byAccount: Record<string, { requests: number }> }).byAccount[account.id]?.requests,
      ).toBe(steps.length)

      // cache.state knows the slot the session used.
      const cacheState = await rpc(server, "cache.state", { sessionID: session.id })
      expect(cacheState.slots).toEqual([expect.objectContaining({ providerID: account.providerID, state: "warm" })])

      // A manual compaction is an HTTP request on the codex slot: its `x-codex-*` headers update the same windows, and
      // `session.compaction.ended` becomes a compaction line.
      codex.enqueue({ type: "text", text: "summary of the conversation" })
      const compact = await server.request("POST", `/api/session/${session.id}/compact`, { body: {} })
      expect(compact.status).toBe(200)
      await server.waitIdle(session.id)
      const after = codex.usage(WORK.accountID)
      const header = await until(async () => {
        const snapshot = await rpc(server, "quota.snapshot", { accountIDs: [account.id] })
        const primary = (snapshot.windows as ReadonlyArray<Json>).find((window) => window.id === "codex.primary")
        return primary?.source === "header" ? primary : undefined
      })
      expect(header).toMatchObject({ usedPercent: after.primary, status: "ok" })
      const compacted = await until(async () => {
        const result = await rpc(server, "ledger.session", { sessionID: session.id })
        const lines = result.steps as ReadonlyArray<{ readonly kind: string; readonly tokens: unknown }>
        return lines.find((line) => line.kind === "compaction")
      })
      expect(compacted.tokens).not.toBeNull()
      expect(server.logs()).not.toMatch(/hook_failed|event_handler_failed|session_work_failed/)
    },
    TURN_TIMEOUT,
  )
})

// End to end on a real server with the REAL own-vault.exe (02 §3.2b): a fake old-app DeepSeek key, written with DPAPI
// exactly like the old app does (CurrentUser, no entropy), is linked over RPC by reference; a session prompt goes to the
// e2e-kit DeepSeek fake with that key; the old app replacing its key is followed on the next turn; `replaceKey` is
// refused; removal leaves the old file byte-for-byte untouched and nothing of the key lands in OWN_HOME, the logs, RPC
// output or events. Fake keys in temp dirs only; the real old-app directory is never read.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  canSealDpapi,
  createLegacyApp,
  hashSecret,
  opencodeConfig,
  recordServerEvents,
  removeTree,
  replaceLegacyKey,
  startFakeOpenAIChat,
  startOpencodeServer,
  writeLegacyDeepSeek,
  type EventRecorder,
  type FakeOpenAIChat,
  type LegacyApp,
  type OpencodeServer,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const TELEMETRY = path.join(REPO_ROOT, "packages/own-telemetry")
const EXE = path.join(REPO_ROOT, "own", "native", "own-vault", "target", "release", "own-vault.exe")
const KEY = "sk-fake-e2e-legacy-deepseek-0000000001"
const NEXT = "sk-fake-e2e-legacy-deepseek-0000000002"

const runnable = process.platform === "win32" && existsSync(EXE) && canSealDpapi()

async function rpc(server: OpencodeServer, method: string, input: unknown = {}) {
  const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body = (await response.json()) as {
    readonly output?: Record<string, unknown>
    readonly error?: Record<string, unknown>
  }
  return { status: response.status, output: body.output ?? {}, body, text: JSON.stringify(body) }
}

async function ok(server: OpencodeServer, method: string, input: unknown = {}) {
  const result = await rpc(server, method, input)
  if (result.status !== 200) throw new Error(`${method}: HTTP ${result.status} ${result.text}`)
  return result.output
}

describe.skipIf(!runnable)("linked old-app API key on a real server with own-vault.exe", () => {
  const state: {
    chat?: FakeOpenAIChat
    server?: OpencodeServer
    events?: EventRecorder
    root?: string
    app?: LegacyApp
    file?: string
  } = {}

  beforeAll(async () => {
    const chat = startFakeOpenAIChat({
      cache: { minTokens: 0, blockTokens: 32 },
      credentials: { [KEY]: { domain: "ds-e2e" }, [NEXT]: { domain: "ds-e2e" } },
    })
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-legacy-key-")))
    const app = await createLegacyApp(root)
    const file = await writeLegacyDeepSeek(app, { key: KEY, seal: "dpapi" })
    Object.assign(state, { chat, root, app, file })
    const buildId = `e2e-legacy-key-${process.pid}`
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
                vault: { exePath: EXE },
                endpoints: { deepseek: chat.baseURL },
                codexImportRoot: app.controlCenter,
              },
            },
            { package: TELEMETRY, options: { home: paths.ownHome, buildId } },
          ],
        }),
    })
    state.events = await recordServerEvents(state.server)
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.events?.close()
    await state.server?.stop()
    await state.chat?.stop()
    if (state.root) await removeTree(state.root)
  })

  test(
    "list → plan → dryRun → execute, prompts carry the old app's key, a replaced key is followed, removal keeps the file",
    async () => {
      const { server, chat, file, events } = state
      if (!server || !chat || !file || !events) throw new Error("setup failed")
      const original = await fs.readFile(file)
      const outputs: string[] = []

      const listed = await ok(server, "accounts.import.keys.list")
      outputs.push(JSON.stringify(listed))
      expect(listed).toMatchObject({
        available: true,
        keys: [{ providerRef: "legacy:deepseek", kind: "ds", keySaved: true, importable: true, importedAs: null }],
      })

      const planned = await ok(server, "accounts.import.keys.plan", { providerRef: "legacy:deepseek" })
      outputs.push(JSON.stringify(planned))
      expect(planned).toMatchObject({ kind: "ds", label: "DeepSeek (이전 앱)", keyHint: "sk-…0001", duplicateOf: null })

      const dry = await ok(server, "accounts.import.keys.execute", { nonce: planned.nonce, dryRun: true })
      expect(dry).toEqual({ account: null, dryRun: true, keyHint: "sk-…0001", test: { ok: false, skipped: true } })
      expect(chat.requests).toHaveLength(0)

      const executed = await ok(server, "accounts.import.keys.execute", { nonce: planned.nonce })
      outputs.push(JSON.stringify(executed))
      const account = executed.account as { readonly id: string; readonly providerID: string }
      expect(executed).toMatchObject({
        dryRun: false,
        test: { ok: true, skipped: false },
        account: { kind: "ds", status: "ready", connection: { type: "key", method: "legacy-key-linked" } },
      })
      expect(chat.requests[0]).toMatchObject({ method: "GET", path: "/user/balance" })
      expect(chat.requests[0]?.headers.authorization).toBe(hashSecret(`Bearer ${KEY}`))

      const model = await modelOf(server, account.providerID)
      const session = (await server.createSession({
        model: { providerID: account.providerID, id: model },
        title: "e2e",
      })) as { readonly id: string }
      const turn = async (text: string) => {
        const before = chat.requests.length
        await server.prompt(session.id, text)
        await server.waitIdle(session.id)
        const sent = chat.requests.slice(before).filter((request) => request.path.endsWith("/chat/completions"))
        expect(sent.length).toBeGreaterThan(0)
        return sent
      }
      const first = await turn("hello")
      expect(first.every((request) => request.headers.authorization === hashSecret(`Bearer ${KEY}`))).toBe(true)
      expect(first.every((request) => request.status === 200)).toBe(true)

      // The old app saves a new key (new DPAPI blob, atomic replace): the next turn uses it.
      await replaceLegacyKey(file, NEXT, "dpapi")
      const replaced = await fs.readFile(file)
      await Bun.sleep(1_200)
      const second = await turn("again")
      expect(second.at(-1)?.headers.authorization).toBe(hashSecret(`Bearer ${NEXT}`))
      expect(second.at(-1)?.status).toBe(200)

      // The key belongs to the old app: it cannot be replaced here.
      const replace = await rpc(server, "accounts.update", {
        accountID: account.id,
        replaceKey: "sk-fake-other-0000000000",
      })
      expect(replace.status).not.toBe(200)
      expect(replace.text).toContain("policy_denied")

      const removal = await ok(server, "accounts.remove.plan", { accountID: account.id, mode: "delete" })
      expect(removal.willShredVault).toBe(false)
      const removed = await ok(server, "accounts.remove.execute", { nonce: removal.nonce })
      outputs.push(JSON.stringify(removed))
      expect(removed).toMatchObject({ account: { id: account.id, status: "retired" } })

      // Only read, never written; nothing of either key anywhere on our side.
      expect(await fs.readFile(file)).toEqual(replaced)
      expect(original.equals(replaced)).toBe(false)
      expect(await fs.readdir(path.dirname(file))).toEqual(["deepseek.dpapi", "provider.json"])
      const vaultFiles = await fs.readdir(path.join(server.paths.ownHome, "vault")).catch(() => [])
      expect(vaultFiles.filter((name) => name.endsWith(".dpapi"))).toEqual([])
      const home = await filesUnder(server.paths.ownHome)
      for (const secret of [KEY, NEXT]) {
        expect(server.logs()).not.toContain(secret)
        expect(outputs.join("\n")).not.toContain(secret)
        expect(events.text()).not.toContain(secret)
        expect(home.some((text) => text.includes(secret))).toBe(false)
      }
    },
    TURN_TIMEOUT,
  )
})

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return filesUnder(full)
      return [await fs.readFile(full, "latin1").catch(() => "")]
    }),
  )
  return nested.flat()
}

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

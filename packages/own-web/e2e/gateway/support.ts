import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { BrowserContext, Page } from "@playwright/test"

export const STATE_DIR = checkoutTmp("own-web-e2e-gateway")
export const STATE_FILE = path.join(STATE_DIR, "backend.json")
export const PROVIDER_LOG = path.join(STATE_DIR, "provider-requests.jsonl")
/** Every request the local service received from the gateway (`{at, method, path}`; the recorder sits between them). */
export const SERVICE_LOG = path.join(STATE_DIR, "service-requests.jsonl")

/**
 * `<tmp>/<name>-<short hash of this checkout's root>`: worktrees running the same suite never read or remove each
 * other's state. Shared with the main and remote suites. Hashes the real path: Node (Playwright, the specs) keeps the
 * drive letter as the cwd spells it, while Bun (the backends) upper-cases it.
 */
export function checkoutTmp(name: string) {
  const root = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."))
  return path.join(os.tmpdir(), `${name}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`)
}

/** Fake API keys of the PC's accounts (never real credentials); MG8 scans the device side for them. */
export const FAKE_KEYS = {
  Alpha: "sk-proj-ownWebGatewayE2eAlphaKey00000001",
  Bravo: "sk-proj-ownWebGatewayE2eBravoKey00000002",
} as const

export interface GatewayBackendState {
  /** own-web on the PC (Vite dev, /api proxied to the local server with server-side Basic). */
  readonly dev: string
  /** Free loopback port the test types into 설정 > 기기. */
  readonly gatewayPort: number
  readonly serverUrl: string
  readonly serverPid: number
  readonly localPassword: string
  readonly control: string
  readonly ownHome: string
  readonly serverRoot: string
  readonly testRoot: string
  readonly model: string
  readonly accounts: Readonly<Record<string, { readonly id: string; readonly providerID: string; readonly label: string }>>
  readonly localSession: { readonly id: string; readonly title: string }
  readonly host: {
    readonly id: string
    readonly name: string
    readonly session: { readonly id: string; readonly title: string }
    /** The remote service's own password (the fake host's service config); a device must never see it. */
    readonly password: string
  } | null
  readonly farHost: string
}

export function readState(): GatewayBackendState | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as GatewayBackendState
  } catch {
    return undefined
  }
}

export function backend(): GatewayBackendState {
  const state = readState()
  if (!state) throw new Error(`backend state missing: ${STATE_FILE}`)
  return state
}

export function serviceRequests(): Array<{ readonly at: number; readonly method: string; readonly path: string }> {
  if (!fs.existsSync(SERVICE_LOG)) return []
  return fs
    .readFileSync(SERVICE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { at: number; method: string; path: string })
}

export function providerRequests(): Array<{ readonly at: number; readonly account: string }> {
  if (!fs.existsSync(PROVIDER_LOG)) return []
  return fs
    .readFileSync(PROVIDER_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { at: number; account: string })
}

/** Phone emulation (Edge's Chromium): 375 px wide, touch, coarse pointer, a phone user agent. */
export const PHONE = {
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "ko-KR",
  userAgent:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
} as const

/** Everything a device page keeps: Web Storage, the IndexedDB stores, Cache Storage (URLs and bodies), cookies. */
export async function deviceStorage(page: Page, context: BrowserContext) {
  const inPage = await page.evaluate(async () => {
    const dump: string[] = []
    for (const storage of [localStorage, sessionStorage])
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)!
        dump.push(`${key}=${storage.getItem(key)}`)
      }
    const databases = (await indexedDB.databases?.().catch(() => [])) ?? []
    for (const info of databases) {
      if (!info.name) continue
      const db = await new Promise<IDBDatabase | undefined>((resolve) => {
        const request = indexedDB.open(info.name!)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(undefined)
      })
      if (!db) continue
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve) => {
          try {
            const all = db.transaction(store, "readonly").objectStore(store).getAll()
            all.onsuccess = () => resolve(all.result)
            all.onerror = () => resolve([])
          } catch {
            resolve([])
          }
        })
        dump.push(`${info.name}/${store}=${JSON.stringify(rows)}`)
      }
      db.close()
    }
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) {
        const response = await cache.match(request)
        const text = response ? await response.text().catch(() => "") : ""
        dump.push(`cache ${name} ${request.url} ${text.length}`)
        dump.push(text)
      }
    }
    return dump.join("\n")
  })
  const cookies = (await context.cookies()).map((cookie) => `${cookie.name} httpOnly=${cookie.httpOnly}`).join("\n")
  return { text: inPage, cookies }
}

export function shotsDir() {
  return process.env.OWN_WEB_GATEWAY_SHOTS ?? path.join(STATE_DIR, "shots")
}

/** Remote services the fake host started: the fake /proc entries and every `started` record of remote-service.ts. */
export function remotePids(testRoot: string) {
  const pids = new Set<string>()
  const proc = path.join(testRoot, "proc")
  for (const entry of fs.existsSync(proc) ? fs.readdirSync(proc) : []) if (/^\d+$/.test(entry)) pids.add(entry)
  const events = path.join(testRoot, "service-events.jsonl")
  for (const line of fs.existsSync(events) ? fs.readFileSync(events, "utf8").split("\n") : []) {
    try {
      const entry = JSON.parse(line) as { kind?: string; pid?: number }
      if (entry.kind === "started" && typeof entry.pid === "number") pids.add(String(entry.pid))
    } catch {}
  }
  return [...pids]
}

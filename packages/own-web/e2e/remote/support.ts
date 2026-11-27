import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { checkoutTmp } from "../gateway/support"

export const STATE_FILE = path.join(checkoutTmp("own-web-e2e-remote"), "backend.json")
/**
 * The fake API keys of the PC-only accounts (never real credentials). The tests scan the fake host for them: a remote
 * session leases them per request and must never write them to the host (04 §8.3, RG10).
 */
export const FAKE_KEYS = {
  Alpha: "sk-proj-ownWebRemoteE2eAlphaKey000000001",
  Bravo: "sk-proj-ownWebRemoteE2eBravoKey000000002",
} as const

/** A prompt holding this gets its answer 8 s late (backend.ts): written on the host while the link is silent. */
export const SLOW_MARK = "링크가 끊기는 동안 답해 줘"

/** The fake host's link (own-remote fake-ssh.ts): `silent` is a pulled cable, no FIN, no RST. */
export function setLink(state: RemoteBackendState, alias: string, link: "up" | "silent") {
  fs.mkdirSync(path.join(state.testRoot, "links"), { recursive: true })
  fs.writeFileSync(path.join(state.testRoot, "links", alias), link)
}

/** Every model request the fake provider answered: `{at, account}` (the account whose key it carried, never a key). */
export const PROVIDER_LOG = path.join(checkoutTmp("own-web-e2e-remote"), "provider-requests.jsonl")

export interface RemoteBackendState {
  readonly dev: string
  readonly control: string
  readonly localPassword: string
  readonly account: { readonly id: string; readonly providerID: string; readonly label: string }
  /** Accounts that exist on the PC only (Alpha, Bravo); remote sessions lease their credentials (04 §8). */
  readonly accounts: Readonly<
    Record<string, { readonly id: string; readonly providerID: string; readonly label: string }>
  >
  readonly version: string
  readonly oldVersion: string
  readonly model: string
  readonly localSession: { readonly id: string; readonly title: string }
  readonly hosts: Readonly<
    Record<string, { readonly fingerprint: string; readonly home: string; readonly posixHome: string }>
  >
  readonly password: string
  readonly testRoot: string
  readonly ownHome: string
  readonly serverRoot: string
}

export function readState(): RemoteBackendState | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RemoteBackendState
  } catch {
    return undefined
  }
}

export function backend(): RemoteBackendState {
  const state = readState()
  if (!state) throw new Error(`backend state missing: ${STATE_FILE}`)
  return state
}

/** What the remote service's proxy saw (method, path, auth kind, cookie present, origin; never a value). */
export function remoteRequests(state: RemoteBackendState) {
  const file = path.join(state.testRoot, "service-events.jsonl")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.kind === "request")
}

/** Model requests the fake provider answered so far, oldest first. */
export function providerRequests(): Array<{ readonly at: number; readonly account: string }> {
  if (!fs.existsSync(PROVIDER_LOG)) return []
  return fs
    .readFileSync(PROVIDER_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { at: number; account: string })
}

/** Everything the page keeps in storage (localStorage, sessionStorage, the IndexedDB session-list store) as text. */
export async function storedText(page: Page) {
  return page.evaluate(async () => {
    const dump: string[] = []
    for (const storage of [localStorage, sessionStorage])
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)!
        dump.push(`${key}=${storage.getItem(key)}`)
      }
    const rows = await new Promise<unknown[]>((resolve) => {
      const request = indexedDB.open("own-web")
      request.onsuccess = () => {
        try {
          const all = request.result.transaction("session-list", "readonly").objectStore("session-list").getAll()
          all.onsuccess = () => resolve(all.result)
          all.onerror = () => resolve([])
        } catch {
          resolve([])
        }
      }
      request.onerror = () => resolve([])
    })
    dump.push(JSON.stringify(rows))
    dump.push(location.href)
    return dump.join("\n")
  })
}

/** Collects console errors and CSP violations for the lifetime of the page. */
export function watchErrors(page: Page) {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

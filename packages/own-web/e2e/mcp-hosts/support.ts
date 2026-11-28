import fs from "node:fs"
import path from "node:path"
import { checkoutTmp } from "../gateway/support"

export const STATE_FILE = path.join(checkoutTmp("own-web-e2e-mcp-hosts"), "backend.json")
/**
 * Every model request the fake provider answered: whether the install tool was offered, whether it carried a brief
 * (llm-router's: `router`), and the account it ran on (`alpha`, `beta`).
 */
export const PROVIDER_LOG = path.join(checkoutTmp("own-web-e2e-mcp-hosts"), "provider-requests.jsonl")
/** The fake value sent to the host (never a real credential); the tests scan the host and the page for it. */
export const SECRET = "fake-mcp-hosts-pw-key-0000000000Zq8"

export interface BackendState {
  readonly dev: string
  readonly control: string
  readonly hosts: { readonly buildbox: string; readonly oldbox: string }
  readonly hostSession: string
  readonly servers: Readonly<Record<string, string>>
  readonly testRoot: string
  readonly buildboxHome: string
  readonly serverRoot: string
  readonly localPassword: string
  readonly api: string
}

export function readState(): BackendState | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as BackendState
  } catch {
    return undefined
  }
}

export function backend(): BackendState {
  const state = readState()
  if (!state) throw new Error(`backend state missing: ${STATE_FILE}`)
  return state
}

export interface ProviderRequest {
  readonly at: number
  readonly tool: boolean
  readonly brief: boolean
  readonly router: boolean
  readonly account?: string
}

export function providerRequests(): ProviderRequest[] {
  if (!fs.existsSync(PROVIDER_LOG)) return []
  return fs
    .readFileSync(PROVIDER_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProviderRequest)
}

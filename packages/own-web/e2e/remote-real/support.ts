import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const STATE_FILE = path.join(os.tmpdir(), "own-web-e2e-remote-real", "backend.json")
export const DEV_PORT = Number(process.env.OWN_WEB_E2E_REMOTE_REAL_PORT ?? 5422)

export interface RealBackendState {
  readonly dev: string
  readonly control: string
  /** This PC's service (the release opencode.exe) and its password: never sent to a remote endpoint (RG16). */
  readonly localServer: string
  readonly localPassword: string
  readonly hostId: string
  readonly alias: string
  readonly project: string
  readonly account: { readonly id: string; readonly providerID: string }
  readonly model: string
  readonly keys: readonly string[]
  readonly evidence: string
}

export function readState(): RealBackendState | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RealBackendState
  } catch {
    return undefined
  }
}

// `app\<version>\manifest.json` of the installed release (app\current.json, own-env.ts ownPaths; FORK §8.3): its
// version and the rpcHash its own-web build carries.
// Synchronous on purpose: the entry reads it once before the first window (a few KB, R-D1); everything else reads it
// off the startup path.
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"

export interface OwnManifest {
  readonly version?: string
  /** 05 §5.5 names the key `desktop.rpc_hash`; FORK §8.3 shows `desktop.rpcHash`. Both are read. */
  readonly rpcHash?: string
}

export function parseManifest(text: string): OwnManifest | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) return undefined
    const desktop = isRecord(value.desktop) ? value.desktop : undefined
    const hash = desktop?.rpc_hash ?? desktop?.rpcHash
    return {
      version: typeof value.version === "string" ? value.version : undefined,
      rpcHash: typeof hash === "string" ? hash : undefined,
    }
  } catch {
    return undefined
  }
}

export function readManifestSync(file: string): OwnManifest | undefined {
  if (!existsSync(file)) return undefined
  try {
    return parseManifest(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

export async function readManifest(file: string): Promise<OwnManifest | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  return text === undefined ? undefined : parseManifest(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

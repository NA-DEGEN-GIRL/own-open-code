// Discovery only (05 §5.3 step 2): read the registration file, check `/api/info` (pid match), never start or replace
// anything. `Service.ensure` is never called and no version is passed: whatever healthy service the launcher
// registered is the one the shell uses (01 §5.3).
import { readFile } from "node:fs/promises"
import { Service } from "@opencode/client/service"

export interface DiscoveredService {
  readonly url: string
  readonly password?: string
  /** Basic header for the service's own API (the tray's running-conversation count, 05 §7.3). */
  readonly authorization?: string
  /** From the registration file; `discover` already checked it against `/api/info`. */
  readonly version?: string
}

export async function discoverService(file: string): Promise<DiscoveredService | undefined> {
  const endpoint = await Service.discover({ file }).catch(() => undefined)
  if (!endpoint) return undefined
  const registration = await readRegistration(file)
  return {
    url: endpoint.url,
    password: endpoint.auth?.password,
    authorization: Service.headers(endpoint)?.authorization,
    version: registration?.version,
  }
}

export async function waitForService(file: string, options: { readonly timeoutMs: number; readonly intervalMs: number }) {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const found = await discoverService(file)
    if (found || Date.now() >= deadline) return found
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
  }
}

async function readRegistration(file: string): Promise<{ version?: string } | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as { version?: unknown }
    return { version: typeof value.version === "string" ? value.version : undefined }
  } catch {
    return undefined
  }
}

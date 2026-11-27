// Dev only (03 §16.2 "개발(웹)"): Vite proxies /api to the local-channel service and adds Basic auth on the server
// side, so the password never reaches the browser. Production is same-origin embedding (01 §6.1), never this.
import { readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export interface DevApiTarget {
  readonly url: string
  /** Where the password comes from, for the startup log (never the value). */
  readonly source: "env" | "registration" | "none"
  /** Basic header for the current password; re-read when the registration file changes. */
  authorization(): string | undefined
}

/**
 * Resolution order:
 * 1. `OWN_WEB_API_URL` (+ `OWN_WEB_API_PASSWORD`, optional for a service without auth).
 * 2. The local-channel registration file `service-local.json` (`OWN_WEB_REGISTRATION` overrides the path).
 * 3. Default local-channel port without credentials: requests get 401 and the UI shows it. 0xC0DF (49375), which
 *    Windows moves into the 0x7000 block (28895, upstream e441dafb09 `defaultPort`).
 */
export function resolveDevApi(env: NodeJS.ProcessEnv = process.env): DevApiTarget {
  if (env.OWN_WEB_API_URL) {
    const password = env.OWN_WEB_API_PASSWORD
    return {
      url: trimSlash(env.OWN_WEB_API_URL),
      source: password ? "env" : "none",
      authorization: () => (password ? basic(password) : undefined),
    }
  }
  const file = env.OWN_WEB_REGISTRATION ?? registrationPath(env)
  const first = readRegistration(file)
  if (!first)
    return {
      url: `http://127.0.0.1:${process.platform === "win32" ? 28_895 : 49_375}`,
      source: "none",
      authorization: () => undefined,
    }
  const cache = { mtime: first.mtime, password: first.password }
  return {
    url: trimSlash(first.url),
    source: "registration",
    authorization() {
      const mtime = modified(file)
      if (mtime !== undefined && mtime !== cache.mtime) {
        const next = readRegistration(file)
        if (next) Object.assign(cache, { mtime: next.mtime, password: next.password })
      }
      return cache.password ? basic(cache.password) : undefined
    },
  }
}

/** `<XDG_STATE_HOME or ~/.local/state>/opencode/service-local.json` (packages/cli service-config `filename("local")`). */
export function registrationPath(env: NodeJS.ProcessEnv = process.env) {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "service-local.json")
}

function readRegistration(file: string) {
  const mtime = modified(file)
  if (mtime === undefined) return undefined
  const parsed = parse(readFileSync(file, "utf8"))
  if (!parsed) return undefined
  return { ...parsed, mtime }
}

function parse(text: string) {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null) return undefined
    const url = "url" in value && typeof value.url === "string" ? value.url : undefined
    if (!url) return undefined
    const password = "password" in value && typeof value.password === "string" ? value.password : undefined
    return { url, password }
  } catch {
    return undefined
  }
}

function modified(file: string) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function basic(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

function trimSlash(url: string) {
  return url.replace(/\/+$/, "")
}

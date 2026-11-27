export * as ServiceTarget from "./service-target.js"

import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { readText } from "./fsx.js"

/**
 * The local service own plugins call over loopback HTTP for what the plugin API cannot do: own-remote's gateway relays
 * `/srv/local/api/*` and reads `/api/event` (05 §13.4 "프록시", 01 §6.4 불변식 5), own-accounts and own-team make
 * self-HTTP calls (06 §2.6). The installed build reads URL and password from the service's registration file (same
 * user, {@link Service}); source runs and tests pass the plugin option `service:{url, password}` ({@link fixed},
 * 06 §12.2). Only a loopback `http:` service is accepted. The password stays in a private field or closure: never
 * logged, never in an error, never sent anywhere but `Authorization` to that loopback URL.
 */

/** Where to send a request: the service origin and the `Authorization` value for it. */
export interface Target {
  readonly url: string
  readonly authorization: string
}

/** A {@link Service} or a {@link fixed} endpoint. Callers `invalidate()` after a 401 and ask `current()` again. */
export interface Source {
  current(): Promise<Target | undefined>
  invalidate(): void
}

/** `<XDG_STATE_HOME or ~/.local/state>/opencode/service-<channel>.json` (packages/cli service-config `filename`). */
export function registrationPath(channel: string, env: NodeJS.ProcessEnv = process.env) {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  const name =
    channel === "latest" || channel === "dev" || channel === "beta" || channel === "next"
      ? "service.json"
      : `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
  return path.join(state, "opencode", name)
}

/** The registration file, re-read when it changes or after `invalidate()` (a restart may change the password). */
export class Service implements Source {
  readonly file: string
  #cached: { readonly mtime: number; readonly target: Target } | undefined

  constructor(file: string) {
    this.file = file
  }

  async current(): Promise<Target | undefined> {
    const stat = await fs.stat(this.file).catch(() => undefined)
    if (!stat) {
      this.#cached = undefined
      return undefined
    }
    if (this.#cached && this.#cached.mtime === stat.mtimeMs) return this.#cached.target
    const text = await readText(this.file).catch(() => undefined)
    const registration = text ? Option.getOrUndefined(decodeRegistration(text)) : undefined
    const value = registration ? target(registration.url, registration.password) : undefined
    this.#cached = value ? { mtime: stat.mtimeMs, target: value } : undefined
    return value
  }

  /** The service said 401: read the file again next time. */
  invalidate() {
    this.#cached = undefined
  }
}

/** A fixed endpoint (plugin option `service:{url, password}`); `current()` is `undefined` unless loopback `http:`. */
export function fixed(input: { readonly url: string; readonly password: string }): Source {
  const value = target(input.url, input.password)
  return { current: async () => value, invalidate: () => undefined }
}

const decodeRegistration = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String, password: Schema.String })),
)

/**
 * A loopback address: `127.0.0.0/8`, `::1` and the IPv4-mapped `::ffff:127.x.y.z`, bracketed or not. Host names
 * (`localhost` too) are not addresses; callers decide about them. own-remote's gateway binds and checks peers with it.
 */
export function isLoopback(address: string) {
  const plain = address.replace(/^\[(.*)\]$/, "$1").toLowerCase()
  if (net.isIPv4(plain)) return plain.startsWith("127.")
  if (plain === "::1" || plain === "0:0:0:0:0:0:0:1") return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain)
  return mapped ? mapped[1]!.startsWith("127.") : false
}

/** `Authorization` value for a Basic credential of user `opencode` (the service password, or a remote token). */
export function basic(secret: string) {
  return `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}`
}

function target(url: string, password: string): Target | undefined {
  const parsed = URL.parse(url)
  // Only a loopback http service: the password never goes to another interface.
  if (!parsed || parsed.protocol !== "http:" || !(parsed.hostname === "localhost" || isLoopback(parsed.hostname)))
    return undefined
  if (!password) return undefined
  return { url: parsed.origin, authorization: basic(password) }
}

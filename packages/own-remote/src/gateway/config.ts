export * as GatewayConfig from "./config.js"

import net from "node:net"
import path from "node:path"
import { Schema } from "effect"
import { Fsx, ServiceTarget } from "@own/runtime"

/**
 * Gateway settings `OWN_HOME\gateway.json` (05 §13.4 "게이트웨이 설정(켜짐 여부, 포트)은 파일에 있으므로"): what the
 * launcher reads to wake the control location after a service start, and what own-remote reads on its first
 * instance. No secrets.
 */
/**
 * The pinned-TLS app listener (08 §3.7): loopback `port`; `directHost`/`directPort` are where devices dial from
 * outside through the user's portproxy and router forward (DDNS). Absent in files written before it: off.
 */
export const AppSettings = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.Int,
  directHost: Schema.NullOr(Schema.String),
  directPort: Schema.NullOr(Schema.Int),
})
export type AppSettings = typeof AppSettings.Type

export const Settings = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  /** Loopback only (MG1). */
  bind: Schema.String,
  port: Schema.Int,
  /** Where devices reach the gateway when Tailscale is not detected (`https://pc.tailnet.ts.net`). */
  publicOrigin: Schema.NullOr(Schema.String),
  app: Schema.optionalKey(AppSettings),
  updatedAt: Schema.Finite,
})
export type Settings = typeof Settings.Type

/** The own channel's service listens on 28538 (05 §3); the gateway takes the next port by default. */
export const DEFAULT_PORT = 28539
export const DEFAULT_BIND = "127.0.0.1"
/** The app listener takes the port after the gateway's; the portproxy listens on the next one (08 §1). */
export const DEFAULT_APP_PORT = 28540
export const DEFAULT_DIRECT_PORT = 28541

export function appDefaults(): AppSettings {
  return { enabled: false, port: DEFAULT_APP_PORT, directHost: null, directPort: null }
}

/** The app settings of a file, defaults when the file predates them. */
export function appOf(settings: Settings): AppSettings {
  return settings.app ?? appDefaults()
}

/**
 * A DDNS name or an IP address devices dial (08 §3.7), lower-cased; no scheme, port, path or credentials. A loopback
 * or LAN address is accepted (testing from the same network); the exposure is the user's portproxy and router rule.
 */
export function checkDirectHost(input: string): string | undefined {
  const value = input.trim().toLowerCase().replace(/\.$/, "")
  if (net.isIPv4(value)) return value
  const bracketed = /^\[(.*)\]$/.exec(value)?.[1]
  if (bracketed && net.isIPv6(bracketed)) return `[${bracketed}]`
  if (net.isIPv6(value)) return `[${value}]`
  if (value.length > 253 || !value.includes(".")) return undefined
  const labels = value.split(".")
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? value : undefined
}

export function defaults(): Settings {
  return { version: 1, enabled: false, bind: DEFAULT_BIND, port: DEFAULT_PORT, publicOrigin: null, updatedAt: 0 }
}

export function file(ownHome: string) {
  return path.join(ownHome, "gateway.json")
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Settings))

export async function load(ownHome: string): Promise<Settings> {
  const text = await Fsx.readText(file(ownHome)).catch(() => undefined)
  if (!text) return defaults()
  const parsed = decode(text)
  if (parsed._tag === "None") return defaults()
  const value = parsed.value
  // A hand-edited file cannot open the gateway on another interface: a non-loopback bind comes back as off.
  if (!checkBind(value.bind).ok) return { ...value, enabled: false, bind: DEFAULT_BIND }
  return value
}

export async function save(ownHome: string, settings: Settings) {
  await Fsx.writeAtomic(file(ownHome), JSON.stringify(settings, null, 2) + "\n")
}

export type BindCheck =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly reason: "lan" | "invalid"; readonly address: string }

/**
 * 05 §13.3 and MG1: the listener binds loopback only. `0.0.0.0`/`::`, RFC 1918, link-local, CGNAT (Tailscale's own
 * 100.64/10) and any other address or host name is `bind_rejected_lan`: exposure goes through `tailscale serve`,
 * never through a listener on another interface. `localhost` becomes `127.0.0.1`.
 */
export function checkBind(input: string): BindCheck {
  const address = input.trim().replace(/^\[(.*)\]$/, "$1")
  if (address.toLowerCase() === "localhost") return { ok: true, address: DEFAULT_BIND }
  const family = net.isIP(address)
  if (family === 0) return { ok: false, reason: address === "" ? "invalid" : "lan", address: input }
  if (ServiceTarget.isLoopback(address)) return { ok: true, address }
  return { ok: false, reason: "lan", address }
}

/**
 * The public origin devices use (05 §13.4): `https://<host>` without path, or a loopback `http://` origin (tests and
 * this PC's own browser). A plain-http LAN or public origin would mean tokens on the wire: refused.
 */
export function checkOrigin(input: string): string | undefined {
  const url = URL.parse(input.trim())
  if (!url || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    return undefined
  if (url.protocol === "https:") return url.origin
  if (url.protocol === "http:" && (url.hostname === "localhost" || ServiceTarget.isLoopback(url.hostname)))
    return url.origin
  return undefined
}

export function loopbackUrl(bind: string, port: number) {
  return `http://${net.isIPv6(bind) ? `[${bind}]` : bind}:${port}`
}

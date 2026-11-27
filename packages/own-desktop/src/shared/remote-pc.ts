// 원격 PC identifiers and the pairing link (08 §3.1, §3.3), pure so the shell's main process and own-web's 원격 PC
// dialog read a link the same way. Main validates every link it is handed again; the renderer only uses this to
// explain a bad paste before any IPC. Not an rpcHash input: nothing here crosses the shell ↔ renderer IPC as a type.

/** `[a-z2-7]{12}`: one fixed id per gateway, the label of the app origin. */
export const PC_KEY = /^[a-z2-7]{12}$/
/** base64url (no padding) SHA-256 of the certificate's SubjectPublicKeyInfo DER: 43 characters. */
export const PIN = /^[A-Za-z0-9_-]{43}$/
/** The one-use pairing code (05 §13.5: 128-bit base64url, 22 characters); longer codes are accepted. */
const CODE = /^[A-Za-z0-9_-]{22,128}$/
const DNS_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/
/** More routes than any gateway offers (tailnet, direct, a test route); the rest are ignored. */
const MAX_ROUTES = 8
const MAX_NAME = 64

export const APP_HOST_SUFFIX = ".ownpc.internal"

/** `<pcKey>.ownpc.internal`: the name the app uses for the page and its API; it exists in no DNS. */
export function appHost(pcKey: string) {
  return `${pcKey}${APP_HOST_SUFFIX}`
}

/** `https://<pcKey>.ownpc.internal` (port 443 implied): cookies and storage stay with it whatever the route. */
export function appOrigin(pcKey: string) {
  return `https://${appHost(pcKey)}`
}

/** The pcKey of an app host name, or undefined for any other name. */
export function pcKeyOfHost(host: string) {
  const lower = host.toLowerCase()
  if (!lower.endsWith(APP_HOST_SUFFIX)) return undefined
  const key = lower.slice(0, -APP_HOST_SUFFIX.length)
  return PC_KEY.test(key) ? key : undefined
}

export interface Route {
  /** Host name or address, IPv6 without brackets. */
  readonly host: string
  readonly port: number
}

/** `host:port` or `[ipv6]:port` (08 §3.1 route); undefined when it is neither. */
export function parseRoute(value: string): Route | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value.trim())
  if (!match) return undefined
  const port = Number(match[3])
  if (port < 1 || port > 65535) return undefined
  const v6 = match[1]
  if (v6 !== undefined) return IPV6.test(v6) && v6.includes(":") ? { host: v6, port } : undefined
  const host = match[2]!
  return DNS_NAME.test(host) ? { host, port } : undefined
}

export function formatRoute(route: Route) {
  return route.host.includes(":") ? `[${route.host}]:${route.port}` : `${route.host}:${route.port}`
}

/** A route to this PC itself: an IPv4 loopback address (`127.x.x.x`) or `[::1]`, never a name that could resolve elsewhere. */
export function isLoopbackRoute(value: string) {
  const route = parseRoute(value)
  if (!route) return false
  return route.host === "::1" || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(route.host)
}

/** Valid routes in their order (preference: tailnet first), normalized, without duplicates, at most MAX_ROUTES. */
export function cleanRoutes(values: readonly string[]) {
  const routes = values
    .map(parseRoute)
    .filter((route): route is Route => route !== undefined)
    .map(formatRoute)
  return [...new Set(routes)].slice(0, MAX_ROUTES)
}

/** A PC name for display: no control characters, trimmed, at most MAX_NAME characters. */
export function cleanName(value: string) {
  return [...value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()].slice(0, MAX_NAME).join("").trim()
}

export interface PairingLink {
  readonly pcKey: string
  readonly pin: string
  readonly code: string
  /** The PC's name (`n`), or the pcKey when the link has none. */
  readonly name: string
  /** At least one, in the link's order. */
  readonly routes: readonly string[]
}

export type LinkProblem = "not_link" | "version" | "pc_key" | "pin" | "code" | "routes"

/**
 * `ownpc://pair?v=1&k=<pcKey>&p=<pin>&c=<code>&n=<name>&r=<route>&r=…` (08 §3.3). Refused: another scheme or
 * version, a malformed `k`/`p`/`c`, or no usable route. Whitespace around a pasted link is ignored.
 */
export function parsePairingLink(text: string): { ok: true; link: PairingLink } | { ok: false; problem: LinkProblem } {
  const value = text.trim()
  if (!/^ownpc:\/\/pair[/?]/i.test(value) || !URL.canParse(value)) return { ok: false, problem: "not_link" }
  const url = new URL(value)
  if (
    url.protocol !== "ownpc:" ||
    url.hostname.toLowerCase() !== "pair" ||
    (url.pathname !== "" && url.pathname !== "/")
  )
    return { ok: false, problem: "not_link" }
  const params = url.searchParams
  if (params.get("v") !== "1") return { ok: false, problem: "version" }
  const pcKey = params.get("k") ?? ""
  if (!PC_KEY.test(pcKey)) return { ok: false, problem: "pc_key" }
  const pin = params.get("p") ?? ""
  if (!PIN.test(pin)) return { ok: false, problem: "pin" }
  const code = params.get("c") ?? ""
  if (!CODE.test(code)) return { ok: false, problem: "code" }
  const routes = cleanRoutes(params.getAll("r"))
  if (routes.length === 0) return { ok: false, problem: "routes" }
  return { ok: true, link: { pcKey, pin, code, name: cleanName(params.get("n") ?? "") || pcKey, routes } }
}

// Where the browser pane of an SSH host's conversation sends a connection (05 §8.6, decisions SB): the pane is on this
// PC, the conversation and its dev servers on the host. A connection to the host's own names, `localhost`,
// `127.0.0.0/8` and `[::1]` goes through the host (upstream's plugin-browser tunnel on the host's own service, over the
// SSH connection own-remote already keeps); everything else leaves this PC directly, as the PC's own browser would.
// The host's names are what own-remote knows of it: the ssh config alias, the host part of the target the user typed,
// and the destination `ssh -G` resolved at the last connection (`hosts.detail`). Asked of this PC's service once per
// attachment; an answer that does not come in time leaves loopback alone going through the host.
// Nothing here imports Electron.
import { Effect } from "effect"
import type { BrowserProxy } from "../../../plugin-browser/src/proxy"
import type { Browser } from "../../../plugin-browser/src/rpc"
import { BrowserTunnel } from "../../../plugin-browser/src/tunnel"

/**
 * A loopback name or address: `localhost` and its subdomains, `127.0.0.0/8` (also as an IPv4-mapped IPv6 address),
 * `::1`, and `0.0.0.0` (on Linux: this machine).
 */
export function loopback(host: string) {
  const name = bare(host)
  if (name === "localhost" || name.endsWith(".localhost")) return true
  if (name === "::1" || name === "0:0:0:0:0:0:0:1" || name === "0.0.0.0") return true
  return /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(name) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(name)
}

/** Whether a connection to `host` goes through the SSH host whose names are `names` (lower case). */
export function throughHost(host: string, names: ReadonlySet<string>) {
  return loopback(host) || names.has(bare(host))
}

/** Lower case, without IPv6 brackets or a trailing dot. */
function bare(host: string) {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
}

/**
 * The host's names, lower case: its alias, the host of its target (`[user@]host[:port]` as typed, or the alias), and
 * the destination `ssh -G` gave (`user@host:port`). Loopback forms are left out (they always go through the host).
 */
export function hostNames(input: {
  readonly alias: string | null
  readonly target: string
  readonly destination: string | null
}) {
  return [input.alias, input.target.trim().split(/\s+/).at(-1), input.destination]
    .flatMap((value) => (value ? [nameOf(value)] : []))
    .filter((name) => name !== "" && !loopback(name))
}

/** `user@host:port`, `user@[::1]:22`, `host` → the host, lower case. */
function nameOf(value: string) {
  const host = value.slice(value.lastIndexOf("@") + 1)
  const bracket = /^\[([^\]]+)\]/.exec(host)
  if (bracket) return bracket[1]!.toLowerCase()
  // One colon is a port; more is a bare IPv6 address.
  return (host.split(":").length === 2 ? host.split(":")[0]! : host).toLowerCase()
}

/** How long the pane waits for the host's names before it attaches with loopback alone. */
export const NAMES_WAIT_MS = 3_000

/**
 * The host's names from this PC's service (`own.remote` `hosts.list` and `hosts.detail`, both this PC's own calls).
 * `service`: the sidecar's url and Basic header and own-remote's control location.
 */
export async function lookupHostNames(
  service: { readonly url: string; readonly authorization: string; readonly control: string },
  hostId: string,
): Promise<string[]> {
  const call = async (method: string, input: object) => {
    const url = new URL(`/api/rpc/own.remote/${method}`, service.url)
    url.searchParams.set("location[directory]", service.control)
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: service.authorization, "content-type": "application/json" },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(NAMES_WAIT_MS),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    return typeof body === "object" && body !== null ? (body as { readonly output?: unknown }).output : undefined
  }
  const [list, detail] = await Promise.all([
    call("hosts.list", {}).catch(() => undefined),
    call("hosts.detail", { hostId }).catch(() => undefined),
  ])
  const hosts = field(list, "hosts")
  const host = Array.isArray(hosts) ? hosts.find((item) => field(item, "id") === hostId) : undefined
  const alias = field(host, "alias")
  const target = field(host, "target")
  const destination = field(detail, "destination")
  return hostNames({
    alias: typeof alias === "string" ? alias : null,
    target: typeof target === "string" ? target : "",
    destination: typeof destination === "string" ? destination : null,
  })
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>)[name] : undefined
}

/** A tunnel open through the SSH host that has not answered by then fails (the host's own connect waits 10 s). */
export const OPEN_TIMEOUT_MS = 20_000

/**
 * The pane's tunnels for an SSH host's attachment: a target `through` names goes to `server` (the host's plugin-browser
 * tunnel), any other is connected from this PC by the same tunnel code the server runs (`BrowserTunnel`). Each tunnel
 * stays with the side that opened it. `dispose` closes this PC's ones (the attachment ended).
 */
export function routedTransport(
  server: BrowserProxy.Transport,
  through: (target: Browser.TunnelTarget) => boolean,
  openTimeoutMs = OPEN_TIMEOUT_MS,
) {
  const local = BrowserTunnel.make()
  const mine = new Set<string>()
  const transport: BrowserProxy.Transport = {
    open: async (target, signal) => {
      if (through(target)) return server.open(target, AbortSignal.any([signal, AbortSignal.timeout(openTimeoutMs)]))
      const id = await Effect.runPromise(local.open(target), { signal })
      mine.add(id)
      return id
    },
    read: (id, signal) => (mine.has(id) ? Effect.runPromise(local.read(id), { signal }) : server.read(id, signal)),
    write: (id, data, end, signal) =>
      mine.has(id) ? Effect.runPromise(local.write(id, data, end), { signal }) : server.write(id, data, end, signal),
    close: (id) => (mine.delete(id) ? Effect.runPromise(local.close(id)) : server.close(id)),
  }
  return { transport, dispose: () => local.dispose() }
}

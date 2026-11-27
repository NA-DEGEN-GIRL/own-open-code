// The in-process CONNECT proxy of 원격 PC partitions (08 §3.4 1). Chromium sends every request of a PC's partition
// here; only `CONNECT <pcKey>.ownpc.internal:443` for a PC the shell knows (paired or being paired) is tunnelled, by
// raw TCP to that PC's routes in turn (the last good one first, then the stored order: tailnet before direct), each
// with a 3 s limit. TLS stays end to end between Chromium and the PC's gateway; this only moves bytes. Everything
// else (other hosts, other ports, plain-HTTP proxy requests) gets 403. Loopback only, on an ephemeral port, started on
// first use. The 모바일 미리보기 (08 §4.3) runs its own instance over `singleRoute`. Electron-free so tests run under
// bun.
import net from "node:net"
import { isLoopbackRoute, parseRoute, pcKeyOfHost } from "../../shared/remote-pc"

export const CONNECT_TIMEOUT_MS = 3_000
/** A CONNECT head is one short line plus a few headers. */
const MAX_HEAD = 8 * 1024
const HEAD_TIMEOUT_MS = 10_000

export interface ProxyRoutes {
  /** Routes of a known PC in preference order, or undefined for an unknown pcKey (403). */
  routes(pcKey: string): readonly string[] | undefined
  /** The route the last tunnel to this PC used, tried first. */
  lastRoute(pcKey: string): string | undefined
  /** A tunnel to `route` is open (the TCP connection; TLS and the pin are Chromium's business). */
  connected(pcKey: string, route: string): void
  /** No route of this PC accepted a connection (502). */
  unreachable(pcKey: string): void
}

export interface ConnectProxy {
  /** Starts listening on first call; the same port afterwards. */
  port(): Promise<number>
  close(): Promise<void>
}

export function createConnectProxy(known: ProxyRoutes, options: { readonly connectTimeoutMs?: number } = {}) {
  const sockets = new Set<net.Socket>()
  const track = (socket: net.Socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }
  const server = net.createServer((client) => {
    track(client)
    // A reset while the head is read or a route dialled must not become an uncaught 'error'.
    client.on("error", () => client.destroy())
    client.setNoDelay(true)
    void readHead(client).then((head) => {
      if (!head) return void client.destroy()
      const pcKey = connectTarget(head.text)
      const routes = pcKey ? known.routes(pcKey) : undefined
      if (!pcKey || !routes || routes.length === 0) return refuse(client, "403 Forbidden")
      return tunnel(client, head.rest, pcKey, orderRoutes(routes, known.lastRoute(pcKey)))
    })
  })
  let listening: Promise<number> | undefined

  async function tunnel(client: net.Socket, rest: Buffer, pcKey: string, routes: readonly string[]) {
    for (const route of routes) {
      if (client.destroyed) return
      const upstream = await dial(route, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
      if (!upstream) continue
      if (client.destroyed) return void upstream.destroy()
      track(upstream)
      known.connected(pcKey, route)
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (rest.length > 0) upstream.write(rest)
      const close = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on("error", close).on("close", close)
      upstream.on("error", close).on("close", close)
      client.pipe(upstream)
      upstream.pipe(client)
      return
    }
    known.unreachable(pcKey)
    refuse(client, "502 Bad Gateway")
  }

  return {
    port() {
      listening ??= new Promise<number>((resolve, reject) => {
        server.once("error", reject)
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
          server.off("error", reject)
          resolve((server.address() as net.AddressInfo).port)
        })
      })
      return listening
    },
    async close() {
      sockets.forEach((socket) => socket.destroy())
      if (!listening) return
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  } satisfies ConnectProxy
}

/**
 * The table of the 모바일 미리보기 proxy (08 §4.3): exactly one pcKey (this PC's own) and its one loopback route.
 * Every other pcKey, a stored 원격 PC's included, is unknown here (403), and so is a route that is not loopback.
 */
export function singleRoute(
  target: () => { readonly pcKey: string; readonly route: string } | undefined,
  events: Pick<ProxyRoutes, "connected" | "unreachable">,
): ProxyRoutes {
  return {
    routes(pcKey) {
      const current = target()
      return current && current.pcKey === pcKey && isLoopbackRoute(current.route) ? [current.route] : undefined
    },
    lastRoute: () => undefined,
    connected: events.connected,
    unreachable: events.unreachable,
  }
}

/** The last good route first, then the others in their stored order. */
export function orderRoutes(routes: readonly string[], last: string | undefined) {
  if (!last || !routes.includes(last)) return [...routes]
  return [last, ...routes.filter((route) => route !== last)]
}

/** The pcKey of `CONNECT <pcKey>.ownpc.internal:443 HTTP/1.x`, or undefined for any other request. */
export function connectTarget(head: string) {
  const match = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/i.exec(head.split("\r\n", 1)[0] ?? "")
  if (!match || match[2] !== "443") return undefined
  return pcKeyOfHost(match[1]!)
}

/** The request head up to the blank line, and whatever the client sent after it (normally nothing). */
function readHead(socket: net.Socket) {
  return new Promise<{ text: string; rest: Buffer } | undefined>((resolve) => {
    let buffer = Buffer.alloc(0)
    const done = (value: { text: string; rest: Buffer } | undefined) => {
      // Held until the tunnel pipes it (Chromium sends nothing before the 200 anyway).
      socket.pause()
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("close", onEnd)
      socket.off("error", onEnd)
      resolve(value)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf("\r\n\r\n")
      if (end >= 0) return done({ text: buffer.subarray(0, end).toString("latin1"), rest: buffer.subarray(end + 4) })
      if (buffer.length > MAX_HEAD) done(undefined)
    }
    const onEnd = () => done(undefined)
    const timer = setTimeout(onEnd, HEAD_TIMEOUT_MS)
    socket.on("data", onData)
    socket.once("close", onEnd)
    socket.once("error", onEnd)
  })
}

function refuse(client: net.Socket, status: string) {
  client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
}

/** A TCP connection to `route` within `timeoutMs` (name resolution included), or undefined. */
function dial(route: string, timeoutMs: number) {
  const target = parseRoute(route)
  if (!target) return Promise.resolve(undefined)
  return new Promise<net.Socket | undefined>((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port })
    const fail = () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(undefined)
    }
    const timer = setTimeout(fail, timeoutMs)
    socket.once("error", fail)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.off("error", fail)
      socket.setNoDelay(true)
      resolve(socket)
    })
  })
}

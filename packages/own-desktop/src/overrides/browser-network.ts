// Substitutes packages/gui-plugins/src/browser/network.ts @ 698800f59c (MIT) for the pane override
// (./browser-pane.ts imports it instead). See own/ledger/vendored.yaml.
// own: a pane of an SSH host's conversation (05 §8.6, decisions SB) routes each connection by its target. The host's
// own names and loopback go through the host's plugin-browser tunnel as upstream sends everything (the host's service
// over own-remote's SSH connection: no second login, no new listener on the host); every other target is connected
// from this PC by the same tunnel code the server runs (`BrowserTunnel`), so the internet is reached as from the PC's
// own browser, not from the host. This PC's own service (`route` absent) keeps upstream's rule: everything through it,
// and a pane of this PC's own service browses directly (`createDirectNetwork`, upstream's).
// own: a tunnel open on an SSH host is given up after a while (`OPEN_TIMEOUT_MS`), so a link that went silent fails the
// page with the pane's error instead of leaving it loading until the SSH keepalive notices.
// Marked "own:" below; the imports of packages this package does not depend on point at their sources.
import { net, session, type WebContents } from "electron"
import type { RpcClient } from "@opencode/client/effect/api"
import type { Session } from "../../../schema/src/session"
import { Browser } from "../../../plugin-browser/src/rpc"
import { BrowserProxy } from "../../../plugin-browser/src/proxy"
import { routedTransport } from "../main/browser-route"
import { Effect } from "effect"
import { Base64 } from "effect/encoding"

export type BrowserNetwork = Effect.Success<ReturnType<typeof createBrowserNetwork>>

export const createBrowserNetwork = Effect.fn("BrowserNetwork.create")(function* (input: {
  rpc: RpcClient<typeof Browser.Definition, unknown>
  attachment: { sessionID: Session.ID; connectionID: string }
  location: { directory: string; workspace?: string }
  partition: string
  /** own: an SSH host's pane: whether a target goes through the host (main/browser-route.ts `throughHost`). */
  route?: (target: Browser.TunnelTarget) => boolean
}) {
  const options = { location: input.location }
  const server: BrowserProxy.Transport = {
    open: (target, signal) =>
      Effect.runPromise(input.rpc["tunnel.open"]({ ...input.attachment, target }, options), { signal }),
    read: (tunnelID, signal) =>
      Effect.runPromise(input.rpc["tunnel.read"]({ ...input.attachment, tunnelID }, options), { signal }),
    write: (tunnelID, data, end, signal) =>
      Effect.runPromise(
        input.rpc["tunnel.write"](
          { ...input.attachment, tunnelID, data: Base64.encode(data), ...(end !== undefined && { end }) },
          options,
        ),
        { signal },
      ),
    close: (tunnelID) =>
      Effect.runPromise(
        input.rpc["tunnel.close"]({ ...input.attachment, tunnelID }, options).pipe(Effect.timeout("5 seconds")),
      ),
  }
  // own: an SSH host's pane routes each target (see the header); this PC's own service sends everything through.
  const routed = input.route ? routedTransport(server, input.route) : undefined
  if (routed) yield* Effect.addFinalizer(() => Effect.sync(routed.dispose))
  const transport = routed?.transport ?? server

  const proxy = yield* Effect.acquireRelease(
    Effect.tryPromise(() => BrowserProxy.make(transport)),
    (proxy) => Effect.promise(() => proxy.close()),
  )

  const partition = session.fromPartition(input.partition)
  yield* Effect.addFinalizer(() => Effect.promise(() => partition.closeAllConnections()))
  // This is the browser's private partition, not the app/API connection. Never
  // bypass localhost: it must resolve on the machine running the OC2 server.
  yield* Effect.tryPromise(() =>
    partition.setProxy({ mode: "fixed_servers", proxyRules: proxy.url, proxyBypassRules: "<-loopback>" }),
  )
  yield* Effect.tryPromise(() => partition.closeAllConnections())

  return {
    attach(contents: WebContents) {
      const login = (
        event: Electron.Event,
        _details: Electron.AuthenticationResponseDetails,
        auth: Electron.AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => {
        if (
          !auth.isProxy ||
          auth.scheme !== "basic" ||
          auth.host !== proxy.host ||
          auth.port !== proxy.port ||
          auth.realm !== "OpenCode Browser Proxy"
        )
          return
        event.preventDefault()
        callback(proxy.credentials.username, proxy.credentials.password)
      }

      contents.on("login", login)
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")

      return () => void contents.off("login", login)
    },
    /** Fetches a page icon through the server's network, as the page loaded it. */
    icon: (url: string) =>
      fetchIcon(url, partition, (auth, callback) => {
        if (auth.isProxy && auth.host === proxy.host && auth.port === proxy.port)
          return callback(proxy.credentials.username, proxy.credentials.password)
        callback()
      }),
  }
})

/**
 * The network of a server on this machine: the same one this desktop has, so pages load directly in the partition,
 * with the system's proxy settings, rather than through the server's tunnel.
 */
export function createDirectNetwork(partition: Electron.Session): BrowserNetwork {
  return {
    attach: () => () => undefined,
    icon: (url) => fetchIcon(url, partition, (_auth, callback) => callback()),
  }
}

/**
 * Resolves undefined for anything but a small image: a failure, a timeout, another content type, or more than
 * `MAX_ICON_BYTES`.
 */
function fetchIcon(
  url: string,
  partition: Electron.Session,
  login: (auth: Electron.AuthInfo, callback: (username?: string, password?: string) => void) => void,
) {
  return new Promise<{ mime: string; data: Buffer } | undefined>((resolve) => {
    // The page supplies this URL. The browser chrome must not turn an icon into a credentialed navigation.
    const request = net.request({
      url,
      session: partition,
      useSessionCookies: false,
      credentials: "omit",
      redirect: "follow",
    })
    const chunks: Buffer[] = []

    const finish = (value?: { mime: string; data: Buffer }) => {
      clearTimeout(timeout)
      resolve(value)
    }

    const fail = () => {
      request.abort()
      finish()
    }

    const timeout = setTimeout(fail, 5_000)
    request.on("login", login)
    request.on("response", (response) => {
      const header = response.headers["content-type"]
      const mime = (Array.isArray(header) ? header[0] : header)?.split(";")[0]?.trim().toLowerCase() ?? ""

      if (response.statusCode !== 200 || !mime.startsWith("image/")) return fail()
      response.on("data", (chunk) => {
        chunks.push(chunk)

        if (chunks.reduce((size, item) => size + item.length, 0) > MAX_ICON_BYTES) fail()
      })
      response.on("end", () => finish({ mime, data: Buffer.concat(chunks) }))
      response.on("error", fail)
    })
    request.on("error", fail)
    request.end()
  })
}

/** Icons larger than this are not worth reducing; sites list a favicon of a few kilobytes. */
const MAX_ICON_BYTES = 256 * 1024

export * as EgressStub from "./egress-stub.js"

import net from "node:net"
import type { Contract } from "../broker/contract.js"
import type { Logger } from "../logger.js"
import type { Dial } from "./dial.js"

/**
 * The remote end of the Claude egress relay (04 §8.11.4.4): a loopback byte pipe of the remote service
 * (`127.0.0.1:0`). Every connection dials the PC's relay through the tunnel's second `-R` (the endpoint the current arm
 * names, `Dial.system`, or the fake-SSH placeholder in tests) and pipes both ways: pull-based (backpressure), a
 * half-close passed on, and a side that goes away without finishing destroys the other. It never reads, parses or signs
 * anything: the request already carries its per-request proof from the `http.request` hook, so anything else on this
 * host that reaches the port (another process, a browser pane, a shell tool) is refused by the PC (401 `mac`).
 * Nothing is logged but the failure to dial.
 */

export interface Stub {
  readonly url: string
  close(): Promise<void>
}

export async function start(input: {
  /** The egress endpoint of the current arm, read per connection (a re-arm moves it). */
  readonly endpoint: () => Contract.Endpoint | undefined
  readonly dial: Dial.Dial
  readonly log: Logger.Logger
}): Promise<Stub> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    const endpoint = input.endpoint()
    if (!endpoint) {
      socket.destroy()
      return
    }
    socket.pause()
    input.dial(endpoint).then(
      (upstream) => {
        sockets.add(upstream)
        upstream.on("close", () => sockets.delete(upstream))
        join(socket, upstream)
        join(upstream, socket)
        socket.resume()
        // The local side left while the dial was pending.
        if (socket.destroyed) upstream.destroy()
      },
      (error: unknown) => {
        input.log.warn("egress_dial_failed", { error })
        socket.destroy()
      },
    )
  })
  server.on("error", (error) => input.log.warn("egress_stub_error", { error }))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject)
      resolve()
    })
  })
  server.unref()
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * `from` → `to`: bytes with backpressure (`pipe`), `from`'s end becomes `to`'s half-close, and `from` closing before it
 * finished both ways (a reset, an abort, a write to a peer that left) resets `to`, so its peer sees a failure, not a
 * clean end.
 */
function join(from: net.Socket, to: net.Socket) {
  from.pipe(to)
  from.on("error", () => {})
  from.on("close", () => {
    if (!from.readableEnded || !from.writableFinished) to.resetAndDestroy()
  })
}

export * as Loopback from "./loopback.js"

import net from "node:net"

/**
 * Host loopback addresses (04 §7.3). Everything a remote host produces (API tunnel, dev forwards) is bound to
 * `127.0.<k>.2` / `127.0.<k>.3`, never `127.0.0.1`/`localhost`: browser cookies ignore ports and the local server's
 * CORS allows `http://127.0.0.1:*`. If such an address cannot be bound we stop (`loopback_unavailable`) instead of
 * falling back to 127.0.0.1.
 */
export const apiAddress = (k: number) => `127.0.${k}.2`
export const forwardAddress = (k: number) => `127.0.${k}.3`

export type BindResult = "ok" | "in_use" | "unavailable"

/**
 * Tries to bind `address:port`. Windows reports ports inside an excluded range (Hyper-V/WinNAT) as `EACCES`, which is
 * treated like "in use" (04 §7.3); `EADDRNOTAVAIL` means the address itself cannot be used.
 */
export function tryBind(address: string, port: number): Promise<BindResult> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve("in_use")
      else resolve("unavailable")
    })
    server.listen({ host: address, port, exclusive: true }, () => server.close(() => resolve("ok")))
  })
}

/** First free k in 1–250 whose API address binds (04 §7.3). */
export async function pickK(used: ReadonlySet<number>) {
  for (let k = 1; k <= 250; k++) {
    if (used.has(k)) continue
    const result = await tryBind(apiAddress(k), 0)
    if (result === "ok") return k
    if (result === "unavailable") return undefined
  }
  return undefined
}

/** A fixed LP in 20000–29999 chosen by a real bind test (04 §7.3). */
export async function pickPort(address: string, used: ReadonlySet<number>, random = Math.random) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = 20_000 + Math.floor(random() * 10_000)
    if (used.has(port)) continue
    const result = await tryBind(address, port)
    if (result === "ok") return port
    if (result === "unavailable") return undefined
  }
  return undefined
}

/** A temporary port on `address` (the fixed LP is busy): the OS picks. */
export function ephemeralPort(address: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once("error", () => resolve(undefined))
    server.listen({ host: address, port: 0, exclusive: true }, () => {
      const info = server.address()
      const port = typeof info === "object" && info ? info.port : undefined
      server.close(() => resolve(port))
    })
  })
}

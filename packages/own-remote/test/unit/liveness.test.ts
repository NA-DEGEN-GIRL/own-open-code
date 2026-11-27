// 04 §6.3 "죽은 링크" (own.15): the timing rules behind the tunnel's silent-link handling.
import { afterAll, describe, expect, test } from "bun:test"
import net from "node:net"
import { Liveness } from "../../src/ssh/liveness.js"

const sockets: net.Socket[] = []
const silent = net.createServer((socket) => sockets.push(socket))
await new Promise<void>((resolve) => silent.listen({ host: "127.0.0.1", port: 0 }, () => resolve()))
const silentPort = (silent.address() as net.AddressInfo).port
const answering = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 401 }) })

afterAll(() => {
  for (const socket of sockets) socket.destroy()
  silent.close()
  answering.stop(true)
})

describe("Liveness", () => {
  test("ssh's keepalive gives a silent tunnel 12 s after its last received byte", () => {
    expect(Liveness.SILENT_LIMIT_MS).toBe((Liveness.SERVER_ALIVE_COUNT_MAX + 1) * Liveness.SERVER_ALIVE_INTERVAL * 1000)
    expect(Liveness.SILENT_LIMIT_MS).toBeLessThanOrEqual(15_000)
  })

  test("a tick counts as a wake only when it comes at least 8 s later than due", () => {
    expect(Liveness.resumed(0, Liveness.TICK_MS)).toBe(false)
    // A busy event loop that runs a tick a few seconds late is not a sleep.
    expect(Liveness.resumed(0, Liveness.TICK_MS + 5000)).toBe(false)
    expect(Liveness.resumed(0, Liveness.TICK_MS + Liveness.RESUME_GAP_MS - 1)).toBe(false)
    expect(Liveness.resumed(0, Liveness.TICK_MS + Liveness.RESUME_GAP_MS)).toBe(true)
    expect(Liveness.resumed(1000, 1000 + 8 * 60 * 60_000)).toBe(true)
  })

  test("a drop keeps connection failures retrying for ten minutes, then the usual pause applies", () => {
    expect(Liveness.keepRetrying(undefined, 5000)).toBe(false)
    expect(Liveness.keepRetrying(1000, 1000)).toBe(true)
    expect(Liveness.keepRetrying(1000, 1000 + Liveness.DROP_RETRY_MS - 1)).toBe(true)
    expect(Liveness.keepRetrying(1000, 1000 + Liveness.DROP_RETRY_MS)).toBe(false)
  })

  test("ssh's own keepalive exit is told apart from other ends", () => {
    expect(Liveness.silentExit("Timeout, server build-host not responding.\r\n")).toBe(true)
    expect(Liveness.silentExit("Connection to devbox closed by remote host.\r\n")).toBe(false)
    expect(Liveness.silentExit("")).toBe(false)
  })

  test("any HTTP answer through the tunnel counts as alive, even a refusal", async () => {
    expect(await Liveness.reachable({ url: `http://127.0.0.1:${answering.port}`, secret: "x" }, 2000)).toBe(true)
  })

  test("a connection nothing answers on is not alive once the probe's time is up", async () => {
    const started = Date.now()
    expect(await Liveness.reachable({ url: `http://127.0.0.1:${silentPort}`, secret: "x" }, 500)).toBe(false)
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(450)
    expect(took).toBeLessThan(5000)
  })

  test("a closed port is not alive", async () => {
    const closed = net.createServer()
    await new Promise<void>((resolve) => closed.listen({ host: "127.0.0.1", port: 0 }, () => resolve()))
    const port = (closed.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(await Liveness.reachable({ url: `http://127.0.0.1:${port}`, secret: "x" }, 2000)).toBe(false)
  })
})

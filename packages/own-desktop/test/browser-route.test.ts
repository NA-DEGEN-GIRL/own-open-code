// Where an SSH host's browser pane sends a connection (05 §8.6, decisions SB): the routing rule, the host's names out
// of this PC's service, and the routed transport behind upstream's real proxy (`BrowserProxy`), with two loopback
// HTTP servers playing "a dev server on the host" and "a site reached from this PC". No Electron.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { BrowserProxy } from "../../plugin-browser/src/proxy"
import type { Browser } from "../../plugin-browser/src/rpc"
import { BrowserTunnel } from "../../plugin-browser/src/tunnel"
import { hostNames, lookupHostNames, loopback, routedTransport, throughHost } from "../src/main/browser-route"

describe("the routing rule", () => {
  test("loopback names and addresses always go through the host", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "app.localhost",
      "localhost.",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "0.0.0.0",
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
    ])
      expect({ host, loopback: loopback(host) }).toEqual({ host, loopback: true })
    for (const host of [
      "example.com",
      "localhost.example.com",
      "128.0.0.1",
      "10.0.0.5",
      "::2",
      "127.0.0",
      "mylocalhost",
    ])
      expect({ host, loopback: loopback(host) }).toEqual({ host, loopback: false })
  })

  test("the host's own names go through it, case and trailing dot aside; everything else leaves from this PC", () => {
    const names = new Set(
      hostNames({ alias: "build-host", target: "build-host", destination: "dev@Build-Box.lan:22" }),
    )
    expect([...names].sort()).toEqual(["build-box.lan", "build-host"])
    for (const host of ["build-host", "BUILD-HOST", "build-box.lan.", "localhost", "127.0.0.1"])
      expect({ host, through: throughHost(host, names) }).toEqual({ host, through: true })
    for (const host of ["github.com", "build-host.example.com", "build-box"])
      expect({ host, through: throughHost(host, names) }).toEqual({ host, through: false })
  })

  test("names out of a typed target and a destination: user, port and brackets taken off; loopback left out", () => {
    expect(hostNames({ alias: null, target: "-p 2222 dev@10.1.2.3", destination: "dev@10.1.2.3:2222" })).toEqual([
      "10.1.2.3",
      "10.1.2.3",
    ])
    expect(hostNames({ alias: null, target: "root@[fd00::7]:22", destination: "root@fd00::7" })).toEqual([
      "fd00::7",
      "fd00::7",
    ])
    expect(hostNames({ alias: "tunnel", target: "tunnel", destination: "me@localhost:2200" })).toEqual([
      "tunnel",
      "tunnel",
    ])
    expect(hostNames({ alias: null, target: "", destination: null })).toEqual([])
  })
})

describe("the host's names from this PC's service", () => {
  const seen: Array<{ readonly path: string; readonly auth: string | null; readonly location: string | null }> = []
  const answer = { list: true, detail: true, slow: false }
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      seen.push({
        path: url.pathname,
        auth: request.headers.get("authorization"),
        location: url.searchParams.get("location[directory]"),
      })
      if (answer.slow) await Bun.sleep(4_000)
      if (url.pathname.endsWith("/hosts.list"))
        return answer.list
          ? Response.json({
              output: {
                revision: 1,
                hosts: [
                  { id: "h-other1", alias: "lab", target: "lab" },
                  { id: "h-abc123", alias: "build-host", target: "build-host" },
                ],
              },
            })
          : new Response("no", { status: 500 })
      if (url.pathname.endsWith("/hosts.detail"))
        return answer.detail
          ? Response.json({
              output: { destination: "dev@build-host.lan:22", source: "connect", configKeys: [], forwards: [] },
            })
          : Response.json({ type: "host_not_found" }, { status: 400 })
      return new Response("?", { status: 404 })
    },
  })
  afterAll(() => service.stop(true))
  const target = {
    url: `http://127.0.0.1:${service.port}`,
    authorization: "Basic c3ZjOnB3",
    control: "C:\\own-home\\control",
  }

  test("hosts.list and hosts.detail with the sidecar's own credential at own-remote's control location", async () => {
    expect((await lookupHostNames(target, "h-abc123")).sort()).toEqual([
      "build-host",
      "build-host",
      "build-host.lan",
    ])
    expect(seen.map((item) => item.path).sort()).toEqual([
      "/api/rpc/own.remote/hosts.detail",
      "/api/rpc/own.remote/hosts.list",
    ])
    expect(seen.every((item) => item.auth === target.authorization && item.location === target.control)).toBe(true)
  })

  test("what the service cannot say is left out: an unknown host, a refusal, an answer that does not come", async () => {
    expect(await lookupHostNames(target, "h-gone99")).toEqual(["build-host.lan"])
    answer.detail = false
    expect(await lookupHostNames(target, "h-abc123")).toEqual(["build-host", "build-host"])
    answer.list = false
    expect(await lookupHostNames(target, "h-abc123")).toEqual([])
    answer.list = true
    answer.detail = true
    answer.slow = true
    const started = Date.now()
    expect(await lookupHostNames(target, "h-abc123")).toEqual([])
    expect(Date.now() - started).toBeLessThan(3_900)
    answer.slow = false
  }, 10_000)
})

describe("the routed transport behind the pane's proxy", () => {
  const servers: http.Server[] = []
  const ports = { host: 0, pc: 0 }
  beforeAll(async () => {
    const listen = (body: string) =>
      new Promise<number>((resolve) => {
        const server = http.createServer((request, response) => {
          response.writeHead(200, { "content-type": "text/plain" })
          response.end(`${body} ${request.url}`)
        })
        servers.push(server)
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
      })
    ports.host = await listen("from the host")
    ports.pc = await listen("from this pc")
  })
  afterAll(() => servers.forEach((server) => server.close()))

  /** The host's plugin-browser tunnel as the RPC would reach it: its own `BrowserTunnel`, names resolved "there". */
  function hostSide() {
    const tunnel = BrowserTunnel.make()
    const opened: Browser.TunnelTarget[] = []
    const transport: BrowserProxy.Transport = {
      open: (target, signal) => {
        opened.push(target)
        return Effect.runPromise(tunnel.open({ host: "127.0.0.1", port: target.port }), { signal })
      },
      read: (id, signal) => Effect.runPromise(tunnel.read(id), { signal }),
      write: (id, data, end, signal) => Effect.runPromise(tunnel.write(id, data, end), { signal }),
      close: (id) => Effect.runPromise(tunnel.close(id)),
    }
    return { transport, opened, dispose: () => tunnel.dispose() }
  }

  function get(proxy: BrowserProxy.Proxy, url: string) {
    return new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
      const request = http.request({
        host: proxy.host,
        port: proxy.port,
        path: url,
        headers: {
          "proxy-authorization": `Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}`,
        },
      })
      request.on("response", (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        )
      })
      request.on("error", reject)
      request.end()
    })
  }

  test("a host name goes through the host, any other target is connected here; each side keeps its tunnels", async () => {
    const host = hostSide()
    const routed = routedTransport(host.transport, (target) => throughHost(target.host, new Set(["build-host"])))
    const proxy = await BrowserProxy.make(routed.transport)
    try {
      // The dev server "on the host" answers at localhost there; this PC's 127.0.0.1:<host port> would answer too, so
      // the host side records what it was asked.
      expect(await get(proxy, `http://localhost:${ports.host}/app`)).toEqual({
        status: 200,
        body: "from the host /app",
      })
      expect(await get(proxy, `http://build-host:${ports.host}/`)).toEqual({ status: 200, body: "from the host /" })
      expect(host.opened).toEqual([
        { host: "localhost", port: ports.host },
        { host: "build-host", port: ports.host },
      ])
      // A name that is neither loopback nor the host's: resolved and connected on this PC, the host never asked.
      const routedHere = routedTransport(host.transport, (target) => target.host !== "127.0.0.1")
      const direct = await BrowserProxy.make(routedHere.transport)
      try {
        expect(await get(direct, `http://127.0.0.1:${ports.pc}/x`)).toEqual({ status: 200, body: "from this pc /x" })
        expect(host.opened).toHaveLength(2)
      } finally {
        await direct.close()
        routedHere.dispose()
      }
    } finally {
      await proxy.close()
      routed.dispose()
      host.dispose()
    }
  })

  test("a host that does not answer a tunnel open fails it after the timeout: the page gets the proxy's 502", async () => {
    const silent: BrowserProxy.Transport = {
      open: (_target, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      read: () => Promise.reject(new Error("no")),
      write: () => Promise.reject(new Error("no")),
      close: async () => {},
    }
    const routed = routedTransport(silent, () => true, 200)
    const proxy = await BrowserProxy.make(routed.transport)
    try {
      const started = Date.now()
      expect((await get(proxy, `http://localhost:${ports.host}/`)).status).toBe(502)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await proxy.close()
      routed.dispose()
    }
  })
})

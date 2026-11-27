// The browser pane's shared service clients (src/overrides/browser-clients.ts, P3): attachments of one endpoint and
// credential share one client and so one `/api/event` stream; a later attachment still gets `server.connected`; a
// dropped stream ends every attachment (the window then registers them again) and the next subscription opens a new
// one; the stream closes with the last subscriber; a new credential gets a new client. Against a local fake SSE
// endpoint, with the client's real HTTP stack (NodeHttpClient, like the pane's runtime).
import { afterAll, describe, expect, test } from "bun:test"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Fiber, ManagedRuntime, Stream } from "effect"
import { createBrowserClients } from "../src/overrides/browser-clients"

type Connection = { id: number; auth: string | null; push: (event: object) => void; end: () => void; open: boolean }

const connections: Connection[] = []
const encoder = new TextEncoder()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/api/event") return new Response("not found", { status: 404 })
    const connection: Connection = {
      id: connections.length + 1,
      auth: request.headers.get("authorization"),
      open: true,
      push: () => undefined,
      end: () => undefined,
    }
    connections.push(connection)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        connection.push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        connection.end = () => {
          connection.open = false
          controller.close()
        }
        connection.push({ id: `evt_c${connection.id}`, type: "server.connected", data: {} })
      },
      cancel() {
        connection.open = false
      },
    })
    request.signal.addEventListener("abort", () => (connection.open = false))
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})
const url = `http://127.0.0.1:${server.port}`
const runtime = ManagedRuntime.make(NodeHttpClient.layerNodeHttp)

afterAll(async () => {
  await runtime.dispose()
  server.stop(true)
})

const control = (n: number) => ({
  id: `evt_r${n}`,
  created: n,
  type: "rpc.experimental.browser.control",
  location: { directory: "C:\\fake" },
  data: { connectionID: "c", n },
})

/** One attachment's `client.event.subscribe()`, as the pane runs it, collecting event types until it ends. */
function attach(client: Awaited<ReturnType<ReturnType<typeof createBrowserClients>["get"]>>) {
  const seen: string[] = []
  const fiber = runtime.runFork(
    client.event.subscribe().pipe(
      Stream.runForEach((event) => Effect.sync(() => seen.push(event.type))),
      Effect.exit,
    ),
  )
  return { seen, fiber }
}

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}
const open = () => connections.filter((connection) => connection.open)

describe("browser pane clients", () => {
  test("attachments of one server share one event stream, and a late one still sees server.connected", async () => {
    const clients = createBrowserClients(runtime)
    const server = { url, headers: { authorization: "Basic b3BlbmNvZGU6YQ==" } }
    const client = await clients.get(server)
    expect(await clients.get(server)).toBe(client)
    const first = attach(client)
    const second = attach(client)
    await until(() => first.seen.includes("server.connected") && second.seen.includes("server.connected"), "connect")
    expect(open()).toHaveLength(1)
    expect(open()[0]!.auth).toBe("Basic b3BlbmNvZGU6YQ==")
    const late = attach(client)
    await until(() => late.seen.includes("server.connected"), "the replayed server.connected")
    open()[0]!.push(control(1))
    await until(() => [first, second, late].every((item) => item.seen.includes(control(1).type)), "the event")
    expect(open()).toHaveLength(1)
    // The stream closes with the last subscriber.
    for (const item of [first, second, late]) await Effect.runPromise(Fiber.interrupt(item.fiber))
    await until(() => open().length === 0, "the stream to close")
  })

  test("a dropped stream ends every attachment, and the next subscription opens a new one", async () => {
    const clients = createBrowserClients(runtime)
    const client = await clients.get({ url, headers: { authorization: "Basic b3BlbmNvZGU6Yg==" } })
    const before = connections.length
    const first = attach(client)
    const second = attach(client)
    await until(() => first.seen.length > 0 && second.seen.length > 0, "connect")
    open()[0]!.end()
    // Both end (the pane then closes the attachments, and the window registers them again).
    await Effect.runPromise(Fiber.join(first.fiber))
    await Effect.runPromise(Fiber.join(second.fiber))
    const again = attach(client)
    await until(() => again.seen.includes("server.connected"), "reconnect")
    expect(connections.length - before).toBe(2)
    expect(open()).toHaveLength(1)
    await Effect.runPromise(Fiber.interrupt(again.fiber))
    await until(() => open().length === 0, "the stream to close")
  })

  test("a new credential for the endpoint gets its own client and forgets the old one", async () => {
    const clients = createBrowserClients(runtime)
    const old = { url, headers: { authorization: "Basic b3BlbmNvZGU6Yw==" } }
    const renewed = { url, headers: { authorization: "Basic b3BlbmNvZGU6ZA==" } }
    const before = await clients.get(old)
    const after = await clients.get(renewed)
    expect(after).not.toBe(before)
    expect(await clients.get(renewed)).toBe(after)
    expect(await clients.get(old)).not.toBe(before)
    const item = attach(after)
    await until(() => item.seen.includes("server.connected"), "connect")
    expect(open().at(-1)!.auth).toBe("Basic b3BlbmNvZGU6ZA==")
    await Effect.runPromise(Fiber.interrupt(item.fiber))
  })
})

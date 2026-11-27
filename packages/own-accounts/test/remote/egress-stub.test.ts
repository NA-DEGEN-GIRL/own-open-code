// B7 (04 §8.11.4.4, T8): the remote end of the Claude relay. The stub pipes bytes unchanged both ways to the endpoint
// the current arm names (a re-arm moves new connections), passes a half-close on and a destroy across, and reaches a
// fake-SSH placeholder socket on Windows. The broker client counts the per-request proofs from 1 per arm, and the PC
// relay's own check accepts them once.
import { afterAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Broker, type Plugin } from "@own/protocol"
import type { Contract } from "../../src/broker/contract.js"
import { Egress } from "../../src/broker/egress.js"
import { Logger } from "../../src/logger.js"
import { Client } from "../../src/remote/client.js"
import { Dial } from "../../src/remote/dial.js"
import { EgressStub } from "../../src/remote/egress-stub.js"

const closers: Array<() => unknown> = []
afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** A TCP server that hands each accepted socket to `handle`. */
async function server(handle: (socket: net.Socket) => void) {
  const sockets: net.Socket[] = []
  const listener = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket)
    socket.on("error", () => {})
    handle(socket)
  })
  await new Promise<void>((resolve) => listener.listen({ host: "127.0.0.1", port: 0 }, resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        listener.close(() => resolve())
      }),
  )
  return { port: (listener.address() as net.AddressInfo).port, sockets }
}

async function stub(endpoint: () => Contract.Endpoint | undefined, dial: Dial.Dial = Dial.system) {
  const started = await EgressStub.start({ endpoint, dial, log: Logger.silent })
  closers.push(() => started.close())
  return { ...started, port: Number(new URL(started.url).port) }
}

function connect(port: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true }, () => resolve(socket))
    socket.once("error", reject)
  })
}

function collect(socket: net.Socket) {
  const chunks: Buffer[] = []
  const ended = new Promise<Buffer>((resolve) => {
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("end", () => resolve(Buffer.concat(chunks)))
  })
  return { chunks, ended }
}

describe("the egress stub", () => {
  test("bytes go through unchanged both ways; a half-close is passed on in each direction", async () => {
    const upstream = await server((socket) => {
      const received: Buffer[] = []
      socket.on("data", (chunk: Buffer) => received.push(chunk))
      // The client's half-close arrives: answer with everything reversed, then half-close back.
      socket.on("end", () => socket.end(Buffer.concat(received).reverse()))
    })
    const pipe = await stub(() => ({ tcpPort: upstream.port }))
    const client = await connect(pipe.port)
    const back = collect(client)
    const payload = randomBytes(3 * 1024 * 1024)
    client.end(payload)
    const answer = await back.ended
    expect(answer.equals(Buffer.from(payload).reverse())).toBe(true)
  })

  test("a reset on one side destroys the other; a plain close is a half-close the relay ends on", async () => {
    const closed: Array<Promise<boolean>> = []
    const upstream = await server((socket) => {
      closed.push(new Promise<boolean>((resolve) => socket.on("close", (hadError) => resolve(hadError))))
      // Like the PC's HTTP relay: the client's end of the request is the end of the connection.
      socket.on("end", () => socket.destroy())
      socket.write("hello")
    })
    const pipe = await stub(() => ({ tcpPort: upstream.port }))
    const within = <T>(promise: Promise<T>, what: string) =>
      Promise.race([promise, Bun.sleep(2_000).then(() => Promise.reject(new Error(what)))])

    // core aborts (the connection resets): the stub destroys the relay side at once.
    const aborted = await connect(pipe.port)
    await new Promise<void>((resolve) => aborted.once("data", () => resolve()))
    aborted.resetAndDestroy()
    await within(closed[0]!, "upstream kept open after a reset")

    // A plain close travels as a half-close; the relay side ends the connection on it.
    const plain = await connect(pipe.port)
    await new Promise<void>((resolve) => plain.once("data", () => resolve()))
    plain.end()
    await within(closed[1]!, "upstream kept open after a close")

    // The relay side resets: the local client's connection fails at once.
    const third = await connect(pipe.port)
    third.on("error", () => {})
    await new Promise<void>((resolve) => third.once("data", () => resolve()))
    const gone = new Promise<void>((resolve) => third.on("close", () => resolve()))
    upstream.sockets.at(-1)!.resetAndDestroy()
    await within(gone, "client kept open after the relay side reset")
  })

  test("a re-arm moves new connections; without an endpoint a connection is closed at once", async () => {
    const a = await server((socket) => socket.end("A"))
    const b = await server((socket) => socket.end("B"))
    const endpoint = { value: { tcpPort: a.port } as Contract.Endpoint | undefined }
    const pipe = await stub(() => endpoint.value)
    const read = async () => {
      const socket = await connect(pipe.port)
      return (await collect(socket).ended).toString()
    }
    expect(await read()).toBe("A")
    endpoint.value = { tcpPort: b.port }
    expect(await read()).toBe("B")
    endpoint.value = undefined
    const refused = await connect(pipe.port)
    expect((await collect(refused).ended).length).toBe(0)
  })

  test("Windows: the fake-SSH placeholder of the egress socket reaches its relay", async () => {
    const upstream = await server((socket) => socket.end("relayed"))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-egress-stub-"))
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const file = path.join(dir, "egress-7.sock")
    fs.writeFileSync(file, JSON.stringify({ fakeSocket: true, tcp: upstream.port }))
    const posix =
      process.platform === "win32" ? `/tmp/${path.relative(os.tmpdir(), file).split(path.sep).join("/")}` : file
    const pipe = await stub(() => ({ socket: posix }), Dial.placeholder)
    const socket = await connect(pipe.port)
    expect((await collect(socket).ended).toString()).toBe("relayed")
  })
})

describe("the broker client's egress proofs", () => {
  const HOST = "h-proof01"

  function client() {
    const broker = new Client.BrokerClient({
      version: "local",
      buildId: "egress-proof-test",
      streamId: () => "0123456789abcdef",
      dial: () => Promise.reject(new Error("no broker in this test")),
      log: Logger.silent,
      onReady: () => {},
      onPush: () => {},
      onState: () => {},
    })
    closers.push(() => broker.close())
    return broker
  }

  test("counted from 1 per arm, checked once by the PC relay", async () => {
    const key = randomBytes(32)
    const broker = client()
    expect(broker.egressProof("acc_claude_slot")).toBeUndefined()
    const arm = { hostId: HOST, epoch: 5, key: new Uint8Array(key), endpoint: { tcpPort: 1 }, proto: Broker.PROTO }
    // An arm without an egress endpoint (an older PC): no proofs.
    expect(broker.arm(arm)).toEqual({ accepted: true })
    expect(broker.egressProof("acc_claude_slot")).toBeUndefined()
    // The same epoch and key with an egress endpoint: a new arm, counting from 1.
    expect(broker.arm({ ...arm, egress: { tcpPort: 2 } })).toEqual({ accepted: true })
    expect(broker.egress).toEqual({ tcpPort: 2 })
    const proofs = [
      broker.egressProof("acc_claude_slot")!,
      broker.egressProof("acc_claude_slot")!,
      broker.egressProof("acc_claude_slot")!,
    ]
    expect(proofs.map((proof) => Broker.parseEgressHeader(proof)?.n)).toEqual([1, 2, 3])
    expect(proofs.every((proof) => Broker.parseEgressHeader(proof)?.epoch === 5)).toBe(true)

    // The PC's check of the same proofs: a verdict `off` answers 403 after a valid proof, 401 after a refused one.
    const state: { value: Plugin.ClaudeRemoteState } = { value: "off" }
    const relay = new Egress.Relay({
      now: Date.now,
      log: Logger.silent,
      upstream: "http://127.0.0.1:9",
      wire: async () => ({ ok: false, detail: "wire" }),
      limits: () => {},
      audit: async () => {},
      changed: () => {},
    })
    closers.push(() => relay.shutdown())
    const port = await relay.listen(HOST, {
      local: async () => ({ ok: false, status: 404, code: "not_found" }),
      key: () => ({ epoch: 5, key }),
      state: () => state.value,
      account: () => ({ key: undefined }),
    })
    const status = async (proof: string) =>
      (
        await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: "POST",
          headers: { [Broker.EGRESS_HEADER]: proof },
          body: "{}",
        })
      ).status
    expect(await Promise.all(proofs.map(status))).toEqual([403, 403, 403])
    expect(await status(proofs[1]!)).toBe(401)
    // A re-arm (a new tunnel of the same epoch) restarts the count; the PC restarts its window on `setKey`.
    expect(broker.arm({ ...arm, egress: { tcpPort: 3 } })).toEqual({ accepted: true })
    expect(Broker.parseEgressHeader(broker.egressProof("acc_claude_slot")!)?.n).toBe(1)
    relay.reset(HOST)
    expect(await status(broker.egressProof("acc_claude_slot")!)).toBe(403)
  })
})

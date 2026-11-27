// Broker framing and handshake primitives (04 §8.3–8.4): length-prefixed JSON, the 1 MiB limit, HMAC proofs, and
// the channel's queueing of frames that arrive before a listener exists.
import { describe, expect, test } from "bun:test"
import net from "node:net"
import { Broker } from "@own/protocol"
import { Wire } from "../../src/broker/wire.js"

function frame(value: unknown) {
  return Buffer.from(Broker.encodeFrame(value))
}

describe("Wire.Decoder", () => {
  test("decodes frames split across chunks and several frames in one chunk", () => {
    const decoder = new Wire.Decoder()
    const bytes = Buffer.concat([frame({ a: 1 }), frame({ b: "two" }), frame({ c: [3] })])
    const first = decoder.push(bytes.subarray(0, 3))
    expect(first.frames).toEqual([])
    const second = decoder.push(bytes.subarray(3, 20))
    const third = decoder.push(bytes.subarray(20))
    expect([...second.frames, ...third.frames]).toEqual([{ a: 1 }, { b: "two" }, { c: [3] }])
  })

  test("a frame over the limit fails at its header, before its body is buffered", () => {
    const decoder = new Wire.Decoder()
    const head = Buffer.alloc(4)
    head.writeUInt32BE(Broker.MAX_FRAME_BYTES + 1)
    expect(decoder.push(head).error).toBe("too_large")
    // Failed decoders stay failed.
    expect(decoder.push(frame({ ok: true })).error).toBe("too_large")
    expect(() => Broker.encodeFrame("x".repeat(Broker.MAX_FRAME_BYTES))).toThrow(RangeError)
  })

  test("a body that is not JSON fails", () => {
    const decoder = new Wire.Decoder()
    const body = Buffer.from("GET / HTTP/1.1")
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    expect(decoder.push(Buffer.concat([head, body])).error).toBe("not_json")
  })

  test("an HTTP request to the port reads as an oversized frame (closed without buffering)", () => {
    const decoder = new Wire.Decoder()
    expect(decoder.push(Buffer.from("GET /api/info HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).error).toBe("too_large")
  })
})

describe("Wire handshake proofs", () => {
  const key = new Uint8Array(32).fill(7)
  const input = { hostId: "h-abc123", epoch: 12, nonceR: "r".repeat(32), nonceL: "l".repeat(32) }

  test("L and R proofs use distinct labels and nonce orders", () => {
    const local = Wire.mac(key, "L", input)
    const remote = Wire.mac(key, "R", input)
    expect(local).toMatch(/^[0-9a-f]{64}$/)
    expect(local).not.toBe(remote)
    expect(Broker.macInput("L", input)).toBe(`${Broker.MAC_LOCAL}h-abc123|12|${input.nonceR}|${input.nonceL}`)
    expect(Broker.macInput("R", input)).toBe(`${Broker.MAC_REMOTE}h-abc123|12|${input.nonceL}|${input.nonceR}`)
    // A proof never verifies for another epoch or host.
    expect(Wire.equal(local, Wire.mac(key, "L", { ...input, epoch: 13 }))).toBe(false)
    expect(Wire.equal(local, Wire.mac(key, "L", { ...input, hostId: "h-other1" }))).toBe(false)
    expect(Wire.equal(local, Wire.mac(key, "L", input))).toBe(true)
    expect(Wire.equal(local, local.slice(1))).toBe(false)
  })

  test("nonces are 16 random bytes", () => {
    const a = Wire.nonce()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(Wire.nonce()).not.toBe(a)
  })
})

describe("Wire.Channel", () => {
  test("queues frames that arrive before a listener and hands them over in order", async () => {
    const server = net.createServer((socket) => {
      socket.write(Buffer.concat([frame({ type: "ready" }), frame({ type: "push", n: 1 }), frame({ type: "push", n: 2 })]))
    })
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()))
    const socket = net.connect({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port })
    const channel = new Wire.Channel(socket)
    try {
      expect(await channel.next(5_000)).toEqual({ type: "ready" })
      const rest: unknown[] = []
      channel.onFrame((value) => rest.push(value))
      await Bun.sleep(50)
      expect(rest).toEqual([
        { type: "push", n: 1 },
        { type: "push", n: 2 },
      ])
    } finally {
      channel.close()
      server.close()
    }
  })

  test("next() resolves undefined on close and on timeout", async () => {
    const server = net.createServer((socket) => setTimeout(() => socket.destroy(), 50))
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()))
    const channel = new Wire.Channel(net.connect({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port }))
    try {
      expect(await channel.next(5_000)).toBeUndefined()
      expect(channel.closed).toBe(true)
      expect(await channel.next(10)).toBeUndefined()
    } finally {
      server.close()
    }
  })
})

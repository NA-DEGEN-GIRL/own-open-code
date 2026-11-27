// 04 §8.11.4.2 (T7, B9): `agent.broker.arm` hands the Claude egress endpoint to the remote broker client with the
// broker endpoint, after the same check (a socket must be an absolute path); without one nothing is passed, as from
// an older PC.
import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent.js"
import { Broker } from "../../src/protocol/broker.js"

const BUILD = "agent-arm-test"
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function client() {
  const armed: Broker.ArmInput[] = []
  stops.push(
    Broker.provideRemote(BUILD, {
      arm: (input) => {
        armed.push({ ...input, key: new Uint8Array(input.key) })
        return { accepted: true }
      },
      status: () => ({
        state: "connected",
        epoch: 1,
        leases: [],
        mirror: { revision: null, fetchedAt: null },
        spool: { backlog: 0, bytes: 0, gaps: 0 },
      }),
    }),
  )
  return armed
}

const context = { buildId: BUILD, version: "2.0.24-own.1", home: "/home/u/own" }
const base = {
  hostId: "h-abc123",
  epoch: 7,
  key: Buffer.alloc(32, 7).toString("base64url"),
  endpoint: { socket: "/home/u/own/run/broker-7.sock" },
  proto: Broker.PROTO,
}

describe("agent.broker.arm with the Claude egress endpoint", () => {
  test("an absolute socket or a TCP port reaches the client with the broker endpoint", async () => {
    const armed = client()
    expect(await Agent.arm(context, { ...base, egress: { socket: "/home/u/own/run/egress-7.sock" } })).toEqual({
      accepted: true,
    })
    expect(await Agent.arm(context, { ...base, egress: { tcpPort: 51234 } })).toEqual({ accepted: true })
    expect(armed.map((input) => input.egress)).toEqual([{ socket: "/home/u/own/run/egress-7.sock" }, { tcpPort: 51234 }])
    expect(armed[0]!.endpoint).toEqual({ socket: "/home/u/own/run/broker-7.sock" })
  })

  test("a relative egress socket is refused like a relative broker socket; none at all passes nothing", async () => {
    const armed = client()
    expect(await Agent.arm(context, { ...base, egress: { socket: "run/egress-7.sock" } })).toEqual({
      accepted: false,
      reason: "unavailable",
    })
    expect(armed).toHaveLength(0)
    expect(await Agent.arm(context, base)).toEqual({ accepted: true })
    expect(armed[0]).not.toHaveProperty("egress")
  })
})

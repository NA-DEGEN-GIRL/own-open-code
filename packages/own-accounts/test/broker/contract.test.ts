// The run-time contract with own-remote: the same protocol constants, and own-remote's lookup functions find what
// own-accounts publishes (local broker, remote broker client) under the shared process-global keys.
import { afterEach, describe, expect, test } from "bun:test"
import { Broker } from "@own/protocol"
// own-remote's copy of the contract (a dependency-free module); own-accounts never imports it outside tests.
import { Broker as RemoteContract } from "../../../own-remote/src/protocol/broker.js"
import { Contract } from "../../src/broker/contract.js"

const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

describe("own-remote contract", () => {
  test("protocol constants match own-remote's", () => {
    expect(Broker.PROTO).toBe(RemoteContract.PROTO)
    expect(Broker.KEY_BYTES).toBe(RemoteContract.KEY_BYTES)
    expect(Broker.MAC_LOCAL).toBe(RemoteContract.MAC_LOCAL)
    expect(Broker.MAC_REMOTE).toBe(RemoteContract.MAC_REMOTE)
    expect(Broker.MAX_FRAME_BYTES).toBe(RemoteContract.MAX_FRAME_BYTES)
    expect(Contract.localKey("b1")).toBe(RemoteContract.localKey("b1"))
    expect(Contract.remoteKey("b1")).toBe(RemoteContract.remoteKey("b1"))
  })

  test("own-remote finds the published local broker and remote client", () => {
    const local: Contract.LocalBroker = {
      listen: async () => ({ port: 1 }),
      setKey: () => {},
      configure: () => {},
      close: async () => {},
      status: () => ({
        state: "disconnected",
        mode: null,
        proto: Broker.PROTO,
        leasesActive: 0,
        lastPushAt: null,
        spoolBacklog: 0,
        gaps: 0,
        clockSkewMs: null,
        sourceStale: [],
        lastConnectedAt: null,
      }),
      subscribe: () => () => {},
    }
    const remote: Contract.RemoteBrokerClient = {
      arm: () => ({ accepted: true }),
      status: () => ({
        state: "unarmed",
        epoch: null,
        leases: [],
        mirror: { revision: null, fetchedAt: null },
        spool: { backlog: 0, bytes: 0, gaps: 0 },
      }),
    }
    stops.push(Contract.provide(Contract.localKey("contract-test"), local))
    stops.push(Contract.provide(Contract.remoteKey("contract-test"), remote))
    // Structural compatibility with own-remote's interfaces, checked by the compiler as well.
    const found: RemoteContract.LocalBroker | undefined = RemoteContract.findLocal("contract-test")
    const client: RemoteContract.RemoteBrokerClient | undefined = RemoteContract.findRemote("contract-test")
    expect(found).toBe(local)
    expect(client).toBe(remote)
    // A runtime services object without a `broker` falls back to the global key (own-remote passes the runtime).
    expect(RemoteContract.findLocal("contract-test", { buildId: "contract-test" })).toBe(local)
    expect(RemoteContract.findLocal("another-build")).toBeUndefined()
  })

  test("unregistering does not remove a newer registration", () => {
    const first = Contract.provide(Contract.remoteKey("contract-replace"), {
      arm: () => ({ accepted: false }),
      status: () => {
        throw new Error("unused")
      },
    })
    const second = { arm: () => ({ accepted: true }), status: () => ({ state: "unarmed" }) as never }
    stops.push(Contract.provide(Contract.remoteKey("contract-replace"), second))
    first()
    expect(Contract.lookup(Contract.remoteKey("contract-replace"))).toBe(second)
  })
})

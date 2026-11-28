// The event publisher's leader and remote rules (02 §9.1, 04 §9.1). RL34 (2026-11-28): a remote service dropped every
// global event, its own `mcp.changed` too, so own-web's host MCP card read between an install's save and its connection
// test kept `아직 호스트에서 연결 시험을 하지 않았어요` until the page was opened again.
import { describe, expect, test } from "bun:test"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { Emitter } from "../src/emitter.js"
import { Logger } from "../src/logger.js"
import type { RpcTypes } from "../src/rpc/types.js"

function publisher(input: { readonly leader: boolean; readonly remote: boolean }) {
  const sent: string[] = []
  const emitter = new Emitter.Publisher({
    isLeader: () => input.leader,
    log: Logger.create({ scope: "test", level: "debug", sink: () => {} }),
    remote: input.remote,
  })
  // SAFETY: the recorder implements the only member the publisher calls (`events.emit`).
  emitter.bind({
    dispose: async () => {},
    events: { emit: async (name: string) => void sent.push(name) },
  } as unknown as RpcRegistration<RpcTypes.Definition>)
  return { emitter, sent }
}

describe("global events", () => {
  test("a remote service sends its own MCP list's change and none of the PC's copies", async () => {
    const remote = publisher({ leader: true, remote: true })
    expect(await remote.emitter.global("mcp.changed", {})).toBe(true)
    expect(await remote.emitter.global("accounts.changed", { revision: 3 })).toBe(false)
    expect(remote.sent).toEqual(["mcp.changed"])
  })

  test("only the leader sends them, on this PC as on a host", async () => {
    const pc = publisher({ leader: false, remote: false })
    const host = publisher({ leader: false, remote: true })
    expect(await pc.emitter.global("mcp.changed", {})).toBe(false)
    expect(await host.emitter.global("mcp.changed", {})).toBe(false)
    expect([...pc.sent, ...host.sent]).toEqual([])
    const leader = publisher({ leader: true, remote: false })
    expect(await leader.emitter.global("accounts.changed", { revision: 3 })).toBe(true)
  })
})

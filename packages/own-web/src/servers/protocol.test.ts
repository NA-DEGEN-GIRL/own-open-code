// The own-web copy of the `own.remote` scope table and event names against the real definition (04 §16.7,
// `@own/protocol/rpc-remote`).
import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { REMOTE_ID, remoteAllowed, remoteEvent, remoteMethodScope, remoteScopeOf, tokenHeader } from "@/data/remote-rpc"
import { ALL_SCOPES } from "@/data/rpc"

describe("own.remote client contract", () => {
  test("id and scope table match the definition", () => {
    expect(REMOTE_ID).toBe(OwnRemote.ID)
    const methods = Object.keys(OwnRemote.Definition.methods) as OwnRemote.MethodName[]
    expect(methods.length).toBeGreaterThan(50)
    for (const method of methods) expect([method, remoteMethodScope(method)]).toEqual([method, OwnRemote.MethodScope[method]])
  })

  test("connect with hostKeyPrompt is local (body rule)", () => {
    expect(remoteScopeOf("connect", { hostId: "h-abcdef", clientId: "c" })).toBe("manage")
    expect(remoteScopeOf("connect", { hostId: "h-abcdef", clientId: "c", hostKeyPrompt: true })).toBe(
      OwnRemote.scopeOf("connect", { hostKeyPrompt: true }),
    )
  })

  test("PC windows may call local methods; a device never; agent.* never through this client", () => {
    expect(remoteAllowed("local", ALL_SCOPES)).toBe(true)
    expect(remoteAllowed("remote", ALL_SCOPES)).toBe(false)
    const device = new Set(["read", "prompt"] as const)
    expect(remoteAllowed("read", device)).toBe(true)
    expect(remoteAllowed("manage", device)).toBe(false)
    expect(remoteAllowed("local", device)).toBe(false)
    expect(remoteAllowed("manage", new Set(["read", "admin"] as const))).toBe(true)
  })

  test("events: every declared name parses; others are ignored", () => {
    for (const name of Object.keys(OwnRemote.Events)) {
      const event = remoteEvent({ type: `rpc.own.remote.${name}`, data: { eventId: "e1" } } as unknown as OpenCodeEvent)
      expect(event?.name).toBe(name as never)
    }
    expect(remoteEvent({ type: "rpc.own.remote.unknown", data: {} } as unknown as OpenCodeEvent)).toBeUndefined()
    expect(remoteEvent({ type: "rpc.own.accounts.alert", data: {} } as unknown as OpenCodeEvent)).toBeUndefined()
  })

  test("the production CSP lets own-web reach every host endpoint own-remote can bind (04 §7.3, 127.0.<k>.2)", async () => {
    const { csp } = await import("../../vite/plugins")
    const connect = csp("hash")
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "))!
    for (const k of [1, 3, 250]) {
      expect(connect).toContain(`http://127.0.${k}.2:*`)
      expect(connect).toContain(`ws://127.0.${k}.2:*`)
    }
    // Dev forwards (127.0.<k>.3) open outside the app (04 §7.6).
    expect(connect).not.toContain(".3:*")
  })

  test("token header is Basic with the token in the password position (04 §12.1)", () => {
    const header = tokenHeader("1790000000.abc_DEF-123")
    expect(header.startsWith("Basic ")).toBe(true)
    expect(atob(header.slice(6))).toBe("opencode:1790000000.abc_DEF-123")
  })
})

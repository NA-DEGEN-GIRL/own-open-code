import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Broker } from "../../src/protocol/broker.js"
import { OwnRemote } from "../../src/protocol/rpc-remote.js"

describe("own.remote definition (04 §16)", () => {
  const methods = Object.keys(OwnRemote.Definition.methods) as OwnRemote.MethodName[]

  test("every method has exactly one device scope; agent.* are remote-only; resolve/respond are local", () => {
    expect(Object.keys(OwnRemote.MethodScope).sort()).toEqual([...methods].sort())
    for (const method of methods.filter((name) => name.startsWith("agent."))) expect(OwnRemote.MethodScope[method]).toBe("remote")
    for (const method of ["resolve", "respond", "hosts.add", "prepare.execute", "legacy.execute"] as const)
      expect(OwnRemote.MethodScope[method]).toBe("local")
    expect(OwnRemote.MethodScope["hosts.list"]).toBe("read")
    expect(OwnRemote.scopeOf("connect", { hostId: "h-abcdef", clientId: "c" })).toBe("manage")
    expect(OwnRemote.scopeOf("connect", { hostId: "h-abcdef", clientId: "c", hostKeyPrompt: true })).toBe("local")
    expect(OwnRemote.EventScope["host.prompt"]).toBe("local")
    expect(Object.keys(OwnRemote.EventScope).sort()).toEqual(Object.keys(OwnRemote.Definition.events).sort())
  })

  test("hosts.tools.ensure is device admin (manage), refused without admin, and git-lfs only (06 §4.13)", () => {
    expect(OwnRemote.MethodScope["hosts.tools.ensure"]).toBe("manage")
    expect(OwnRemote.MethodLocation("hosts.tools.ensure")).toBe("control")
    const input = { hostId: "h-abcdef", tool: "git-lfs" } as const
    const phone = new Set(["read", "prompt", "switch", "files", "terminal"])
    expect(OwnRemote.deviceAllows(phone, "hosts.tools.ensure", input)).toBe(false)
    expect(OwnRemote.deviceAllows(new Set(["admin"]), "hosts.tools.ensure", input)).toBe(true)
    const method = OwnRemote.Definition.methods["hosts.tools.ensure"]
    expect(Schema.decodeUnknownSync(method.input)(input)).toEqual(input)
    expect(() => Schema.decodeUnknownSync(method.input)({ ...input, tool: "git" })).toThrow()
    for (const state of ["uploaded", "present"] as const)
      expect(Schema.decodeUnknownSync(method.output)({ state, version: "3.7.1" })).toEqual({ state, version: "3.7.1" })
    expect(() => Schema.decodeUnknownSync(method.output)({ state: "installed", version: "3.7.1" })).toThrow()
    expect(Object.keys(method.errors).sort()).toEqual(
      [
        "host_not_found",
        "host_busy",
        "remote_unreachable",
        "bundle_missing",
        "disk_full",
        "not_supported",
        "tool_hash_mismatch",
        "noexec",
        "install_failed",
        "input_invalid",
        "internal_error",
      ].sort(),
    )
    // Everything `Operations.toolsEnsure` answers is declared, so none of it turns into `internal_error`.
    expect(Schema.decodeUnknownSync(OwnRemote.errors.noexec)({})).toEqual({})
    expect(Schema.decodeUnknownSync(OwnRemote.errors.install_failed)({})).toEqual({})
    const mismatch = { tool: "git-lfs", expected: "a".repeat(64), actual: "b".repeat(64) }
    expect(Schema.decodeUnknownSync(OwnRemote.errors.tool_hash_mismatch)(mismatch)).toEqual(mismatch)
  })

  test("the feed has the team.decision kind (06 §9.8)", () => {
    expect<ReadonlyArray<string>>(OwnRemote.FeedKind.literals).toContain("team.decision")
    const item = { id: "01JB0", at: 1, kind: "team.decision", serverKey: "local", severity: "warn" } as const
    expect(Schema.decodeUnknownSync(OwnRemote.FeedItem)(item)).toEqual(item)
  })

  test("the agent definition is exactly agent.*", () => {
    expect(Object.keys(OwnRemote.AgentDefinition.methods).sort()).toEqual(methods.filter((name) => name.startsWith("agent.")).sort())
    expect(OwnRemote.AgentDefinition.id).toBe("own.remote")
  })

  test("every method declares internal_error; no reserved rpc.* names", () => {
    for (const method of methods) {
      const errors = Object.keys(OwnRemote.Definition.methods[method].errors ?? {})
      expect(errors).toContain("internal_error")
      expect(errors.some((name) => name.startsWith("rpc."))).toBe(false)
    }
  })

  test("a hosts.list row of 04 §16.2 decodes", () => {
    const row = {
      id: "h-7k2m9q",
      alias: "lab",
      name: "lab",
      target: "lab",
      stage: "ready",
      paused: false,
      error: null,
      detail: "",
      platform: { os: "linux", arch: "x64", target: "linux-x64-baseline", libc: "glibc" },
      hostIdentity: "sha256:1f3c",
      identityChanged: false,
      versions: { local: "2.0.18-own.3", remoteRunning: "2.0.18-own.3", remoteStaged: ["2.0.18-own.2"], skew: false },
      autoConnect: true,
      loopback: "127.0.3.2",
      localPort: 24817,
      epoch: 12,
      accounts: { mode: "all" },
      leaseSeconds: 900,
      failClosedGraceSeconds: 300,
      tokenTtlHours: 12,
      projectConfig: "disabled",
      shellEnv: "login",
      warnings: ["path_differs_interactive"],
      broker: {
        state: "connected",
        mode: "normal",
        proto: 1,
        leasesActive: 3,
        lastPushAt: 1790001234000,
        spoolBacklog: 0,
        gaps: 0,
        clockSkewMs: 420,
        sourceStale: [],
      },
      sessions: { active: 1 },
      events: { state: "subscribed", catalogEpoch: 31, catalogFetchedAt: 1790001230000 },
      pendingSettings: false,
      owner: { clientId: null },
      upstreamOpencodeDetected: false,
    }
    expect(Schema.decodeUnknownSync(OwnRemote.HostView)(row).id).toBe("h-7k2m9q")
  })

  test("broker contract constants", () => {
    expect(Broker.PROTO).toBe(1)
    expect(Broker.KEY_BYTES).toBe(32)
    expect(Broker.MAX_FRAME_BYTES).toBe(1_048_576)
    expect(Broker.MAC_LOCAL).toBe("own-broker/v1|L|")
    expect(Broker.MAC_REMOTE).toBe("own-broker/v1|R|")
  })

  test("the process-global broker lookup prefers a runtime `broker` property", () => {
    const fake = { listen: async () => ({ port: 1 }), setKey: () => {} } as unknown as Broker.LocalBroker
    const other = { listen: async () => ({ port: 2 }), setKey: () => {} } as unknown as Broker.LocalBroker
    const undo = Broker.provideLocal("proto-test", other)
    expect(Broker.findLocal("proto-test", { broker: fake })).toBe(fake)
    expect(Broker.findLocal("proto-test", {})).toBe(other)
    undo()
    expect(Broker.findLocal("proto-test")).toBeUndefined()
  })
})

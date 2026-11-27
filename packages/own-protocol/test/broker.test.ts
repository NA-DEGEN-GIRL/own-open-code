// The credential broker wire schemas (04 §8.3–8.4, §10): identifiers, frame encoding, and the shapes both sides
// decode (a lease vs a refusal, observation items, the mirror metadata), plus the remote additions of 04 §16.5.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Account, Alert, Broker, Kv, Ledger, Limit, OwnAccounts, OwnError, Plugin, Preset, Registry } from "../src/index.js"
import { OwnRemote } from "../src/rpc-remote.js"
import { OwnRouting } from "../src/rpc-routing.js"
import { accountsFile, policyFile, ratecardsFile, roundTrip } from "./fixtures.js"
import { CLAUDE, DEEPSEEK, OPENAI_KEY, preset, target } from "./preset-fixtures.js"

describe("Broker schemas", () => {
  test("identifiers are namespaced and unique", () => {
    const identifiers = Object.values(Broker)
      .filter((value) => Schema.isSchema(value))
      .flatMap((schema) => {
        const identifier = (schema as Schema.Top).ast.annotations?.identifier
        return typeof identifier === "string" ? [identifier] : []
      })
    expect(identifiers.length).toBeGreaterThan(25)
    expect(identifiers.every((identifier) => identifier.startsWith("Own.Broker."))).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("frames are a 4-byte big-endian length and UTF-8 JSON, 1 MiB at most", () => {
    const frame = Broker.encodeFrame({ type: "ping", text: "한글" })
    const length = new DataView(frame.buffer).getUint32(0, false)
    expect(length).toBe(frame.length - 4)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(4)))).toEqual({ type: "ping", text: "한글" })
    expect(() => Broker.encodeFrame({ big: "x".repeat(Broker.MAX_FRAME_BYTES) })).toThrow(RangeError)
  })

  test("a headers.get result decodes as a lease or a refusal", () => {
    const decode = Schema.decodeUnknownSync(Broker.HeadersResult)
    expect(decode({ headers: { authorization: "Bearer x" }, authHash8: "abcd1234", ttlMs: 900_000, generation: 1 })).toHaveProperty("ttlMs")
    expect(decode({ error: "source_stale", expiresInMs: -5 })).toEqual({ error: "source_stale", expiresInMs: -5 })
    expect(() => decode({ error: "made_up" })).toThrow()
    expect(() => decode({ headers: {}, authHash8: "a", ttlMs: 0, generation: 0 })).toThrow()
  })

  test("hello and ready carry what the other side checks", () => {
    const hello = Schema.decodeUnknownSync(Broker.Hello)({
      type: "hello",
      proto: 1,
      hostId: "h-abc123",
      epoch: 1790000000,
      nonceR: "0123456789abcdef0123456789abcdef",
      version: "2.0.18-own.3",
      buildId: "b",
      mirrorSchemaVersion: Broker.MIRROR_SCHEMA_VERSION,
      streamId: "0011223344556677",
    })
    expect(hello.epoch).toBe(1790000000)
    expect(() => Schema.decodeUnknownSync(Broker.Hello)({ ...hello, nonceR: "short" })).toThrow()
    const ready = Schema.decodeUnknownSync(Broker.Ready)({
      type: "ready",
      mode: "drain",
      proto: 1,
      localNow: 1,
      from: "own-abc",
      settings: { failClosedGraceSeconds: 300, brokerWaitMs: 10_000 },
    })
    expect(ready.mode).toBe("drain")
    expect(Broker.DRAIN_METHODS).toEqual(["headers.get", "observe.push", "ping"])
    expect(Broker.DRAIN_PUSHES).toEqual(["account.status", "revoke"])
  })

  test("account.status pushes may be host-scoped (a linked account's source_stale on one host)", () => {
    const decode = Schema.decodeUnknownSync(Broker.AccountStatus)
    expect(decode({ accountID: "acc_x", status: "auth_failed", reason: "codex_source_stale", scope: "host" }).scope).toBe("host")
    expect(decode({ accountID: "acc_x", status: "ready" }).scope).toBeUndefined()
  })

  test("the lease constants follow 04 §8.5", () => {
    expect(Broker.MIN_VALIDITY_MS).toBe(7 * 60_000)
    expect(Broker.EXPIRY_MARGIN_MS).toBe(5 * 60_000)
    expect(Broker.LEASE_SECONDS_DEFAULT).toBe(900)
    expect(Broker.SUPPORTED_PROTOS).toContain(Broker.PROTO)
  })
})

describe("mirror view (04 §9.2) and the T3 presets in it (07 §8.1 원격)", () => {
  const decode = Schema.decodeUnknownSync(Broker.MirrorView)
  const { claudeSlot: _, ...registry } = accountsFile
  /** A view as a T2 build sends it: no presets. */
  const t2View = {
    schemaVersion: 1,
    registryRevision: 42,
    policyRevision: 7,
    ratecardsRevision: 9,
    registry: { ...registry, modelTemplates: {} },
    templates: { "codex-v1": "0123456789abcdef" },
    policy: policyFile,
    ratecards: ratecardsFile,
  }
  const presets = Schema.encodeSync(Preset.File)({
    version: 1,
    groups: { codex: { star: Preset.builtinID("codex"), presets: [preset("codex", { "own-review": [CLAUDE] })] } },
    ultraCaps: "recommended",
  })
  const t3View = {
    ...t2View,
    presets,
    presetsRevision: 123_456,
    presetsBudget: { [OPENAI_KEY]: { exhausted: true }, [DEEPSEEK]: { exhausted: false } },
  }

  test("the T3 fields are additions: neither the schema version nor the proto moves", () => {
    expect(Broker.MIRROR_SCHEMA_VERSION).toBe(1)
    expect(Broker.PROTO).toBe(1)
    expect(Object.keys(Broker.MirrorView.fields)).toEqual(
      expect.arrayContaining(["presets", "presetsRevision", "presetsBudget"]),
    )
  })

  test("a view decodes with and without presets, presetsRevision and presetsBudget", () => {
    expect(roundTrip(Broker.MirrorView, t2View)).toEqual(t2View)
    expect(decode(t2View).presets).toBeUndefined()
    expect(roundTrip(Broker.MirrorView, t3View)).toEqual(t3View)
    const view = decode(t3View)
    expect(view.presets?.groups.codex?.presets?.[0]?.workers.roles["own-review"]?.targets).toEqual([target(CLAUDE)])
    expect(view.presetsBudget?.[OPENAI_KEY]).toEqual({ exhausted: true })
    for (const [name, value] of [
      ["presets", t3View.presets],
      ["presetsRevision", t3View.presetsRevision],
      ["presetsBudget", t3View.presetsBudget],
    ] as const)
      expect(roundTrip(Broker.MirrorView, { ...t2View, [name]: value })).toEqual({ ...t2View, [name]: value })
  })

  test("an older build still reads a T3 view (unknown fields are ignored)", () => {
    const t2Fields = Object.fromEntries(
      // `claude` (04 §8.11), `claudeAgent` (02 §8.10.13), `localRelay` (04 §8.14) and `codexRows` (10 §6.14) are later
      // additions, absent from the T2 view as well.
      Object.entries(Broker.MirrorView.fields).filter(
        ([name]) => !name.startsWith("presets") && !["claude", "claudeAgent", "localRelay", "codexRows"].includes(name),
      ),
    )
    expect(Object.keys(t2Fields).sort()).toEqual(Object.keys(t2View).sort())
    expect(Schema.decodeUnknownSync(Schema.Struct(t2Fields))(t3View)).toEqual(decode(t2View))
  })

  test("budget keys are account ids and the presets file keeps its own rules", () => {
    expect(() => decode({ ...t3View, presetsBudget: { deepseek: { exhausted: false } } })).toThrow()
    expect(() => decode({ ...t3View, presetsBudget: { [DEEPSEEK]: { exhausted: "no" } } })).toThrow()
    expect(() => decode({ ...t3View, presetsRevision: -1 })).toThrow()
    expect(() => decode({ ...t3View, presets: { version: 3, groups: {} } })).toThrow()
    expect(() => decode({ ...t3View, schemaVersion: 2 })).toThrow()
  })

  test("the mirror metadata records the presets revision it wrote; older metadata still decodes", () => {
    const meta = {
      schemaVersion: 1,
      from: "own-abc",
      registryRevision: 42,
      policyRevision: 7,
      ratecardsRevision: 9,
      fetchedAt: 1_790_000_000_000,
      templates: { "codex-v1": "0123456789abcdef" },
    }
    expect(roundTrip(Broker.MirrorMeta, meta)).toEqual(meta)
    expect(roundTrip(Broker.MirrorMeta, { ...meta, presetsRevision: 123_456 })).toEqual({
      ...meta,
      presetsRevision: 123_456,
    })
  })
})

describe("remote additions to own.accounts (04 §16.5)", () => {
  test("ledger lines and usage rows know their server; absent reads as local", () => {
    const base = Schema.decodeUnknownSync(Ledger.Line)({
      v: 1,
      ts: 1,
      sessionID: "ses_1",
      messageID: null,
      kind: "primary",
      accountID: null,
      providerID: "own-oai-abcd",
      modelID: "m",
      variant: null,
      credentialRef: null,
      transport: null,
      switchEpoch: 0,
      compactionEpoch: 0,
      tokens: null,
      P: null,
      hit: null,
      cost: null,
      costUSDOpenCode: null,
      coldExpected: null,
    })
    expect(Ledger.serverOf(base)).toBe("local")
    expect(Ledger.serverOf({ ...base, server: "h-abc123" })).toBe("h-abc123")
    expect(Ledger.GroupBy.literals).toContain("server")
  })

  test("windows, accounts, alerts and errors carry the remote fields", () => {
    expect(Limit.Window.fields.origin).toBeDefined()
    expect(Account.Info.fields.remote).toBeDefined()
    for (const code of [
      "broker_unavailable",
      "remote_spool_overflow",
      "remote_observation_rejected",
      "remote_skew",
      "remote_host_identity_changed",
      "remote_clock_skew",
    ])
      expect<ReadonlyArray<string>>(Alert.Code.literals).toContain(code)
    expect(OwnError.data.remote_managed).toBeDefined()
    const methods = OwnAccounts.Definition.methods
    for (const method of ["accounts.add.key", "accounts.update", "accounts.remove.execute", "accounts.test", "policy.set", "ratecards.set", "plugin.claudeAuth.install.execute"] as const)
      expect(Object.keys(methods[method].errors)).toContain("remote_managed")
    // Reads stay unrefused.
    expect(Object.keys(methods["accounts.list"].errors)).not.toContain("remote_managed")
    const health = Schema.decodeUnknownSync(OwnAccounts.Health)({
      version: "1",
      buildId: "b",
      guard: "ok",
      mode: "remote",
      broker: { state: "connected", epoch: 12, lastSeenAt: 5 },
      mirror: { revision: 3, fetchedAt: 4 },
    })
    expect(health.mode).toBe("remote")
  })
})

describe("Claude egress relay (04 §8.11)", () => {
  const { claudeSlot: _, ...registry } = accountsFile
  const view = {
    schemaVersion: 1,
    registryRevision: 42,
    policyRevision: 7,
    ratecardsRevision: 9,
    registry: { ...registry, modelTemplates: {} },
    templates: {},
    policy: policyFile,
    ratecards: ratecardsFile,
  }
  const claude: Broker.ClaudeRemote = {
    state: "enabled",
    fast: true,
    display: { label: null, shortLabel: "C", color: "orange" },
  }

  test("`claude` is an addition: the view and the mirror metadata decode with and without it", () => {
    expect(Broker.PROTO).toBe(1)
    expect(Broker.MIRROR_SCHEMA_VERSION).toBe(1)
    expect(roundTrip(Broker.MirrorView, view)).toEqual(view)
    expect(roundTrip(Broker.MirrorView, { ...view, claude })).toEqual({ ...view, claude })
    for (const state of Plugin.ClaudeRemoteState.literals)
      expect(Schema.decodeUnknownSync(Broker.MirrorView)({ ...view, claude: { ...claude, state } }).claude?.state).toBe(
        state,
      )
    expect(() => Schema.decodeUnknownSync(Broker.MirrorView)({ ...view, claude: { ...claude, state: "on" } })).toThrow()
    const meta = {
      schemaVersion: 1,
      from: "own-abc",
      registryRevision: 1,
      policyRevision: 2,
      ratecardsRevision: 3,
      fetchedAt: 4,
    }
    expect(roundTrip(Broker.MirrorMeta, meta)).toEqual(meta)
    expect(roundTrip(Broker.MirrorMeta, { ...meta, claude })).toEqual({ ...meta, claude })
  })

  test("an older host drops `claude` from a view and an older PC's view has none", () => {
    const older = Object.fromEntries(Object.entries(Broker.MirrorView.fields).filter(([name]) => name !== "claude"))
    expect(Schema.decodeUnknownSync(Schema.Struct(older))({ ...view, claude })).toEqual(
      Schema.decodeUnknownSync(Broker.MirrorView)(view),
    )
    expect(Schema.decodeUnknownSync(Broker.MirrorView)(view).claude).toBeUndefined()
  })

  test("the display carries no identity: no e-mail, connection label, version or integrity field", () => {
    expect(Object.keys(Broker.ClaudeRemote.fields).sort()).toEqual(["accounts", "display", "fast", "state"])
    expect(Object.keys(Broker.ClaudeRemote.fields.display.fields).sort()).toEqual(["color", "label", "shortLabel"])
    const decoded = Schema.decodeUnknownSync(Broker.ClaudeRemote)({
      state: "enabled",
      fast: false,
      display: { label: null, shortLabel: "C", color: "orange" },
      accounts: [{ accountID: "acc_claude_slot", label: "A", shortLabel: "A", color: "orange", default: true }],
    })
    expect(Object.keys(decoded.accounts![0]!).sort()).toEqual(["accountID", "color", "default", "label", "shortLabel"])
  })

  test("the proof header v2: v2.<epoch>.<n>.<accountID>.<mac>, the MAC input covers the account", () => {
    const mac = "ab".repeat(32)
    const accountID = "acc_01J9ZZZZZZZZZZZZZZZZZZZZZZ"
    expect(Broker.egressHeader({ epoch: 1790000000, n: 7, accountID, mac })).toBe(
      `v2.1790000000.7.${accountID}.${mac}`,
    )
    expect(Broker.parseEgressHeader(`v2.1790000000.7.${accountID}.${mac}`)).toEqual({
      epoch: 1790000000,
      n: 7,
      accountID,
      mac,
    })
    expect(Broker.egressMacInput({ hostId: "h-abc123", epoch: 5, n: 9, accountID: "acc_claude_slot" })).toBe(
      "own-egress/v2|h-abc123|5|9|acc_claude_slot",
    )
    for (const bad of [
      null,
      "",
      `v1.1.1.${mac}`,
      `v2.1.1.${mac}`,
      `v2.1.0.${accountID}.${mac}`,
      `v2.1.1.${accountID}.${mac.toUpperCase()}`,
      `v2.1.1.${accountID}.${mac}x`,
      `v2.1.1.other_1.${mac}`,
      `v2.1.1.acc_a.b.${mac}`,
      "v2.a.1.acc_x.b",
    ])
      expect(Broker.parseEgressHeader(bad)).toBeUndefined()
  })

  test("the relay bounds follow 04 §8.11.4.5 and the decisions D2, D3", () => {
    expect(Broker.EGRESS_MAX_BODY_BYTES).toBe(32 * 1024 * 1024)
    expect(Broker.EGRESS_MAX_INFLIGHT).toBe(16)
    expect([Broker.EGRESS_RATE_PER_SECOND, Broker.EGRESS_RATE_BURST]).toEqual([10, 30])
    expect(Broker.EGRESS_REPLAY_WINDOW).toBe(1024)
    expect(Broker.EGRESS_REAUTH_HOLD_MS).toBe(60_000)
    expect(Broker.EGRESS_UPLOAD_TIMEOUT_MS).toBe(120_000)
    expect(Broker.EGRESS_MAC_FAILURES_PER_MINUTE).toBe(20)
    // Every verdict but `enabled` is also a refusal code the host can show.
    for (const state of Plugin.ClaudeRemoteState.literals.filter((state) => state !== "enabled"))
      expect<ReadonlyArray<string>>(Broker.EgressError.literals).toContain(state)
  })

  test("an older agent's arm schema ignores `egress`; the current one keeps it", () => {
    // SAFETY: the arm input is an Effect struct with Standard Schema attached (`method` in rpc-remote.ts).
    const arm = OwnRemote.Definition.methods["agent.broker.arm"].input as unknown as Schema.Codec<
      Record<string, unknown>,
      unknown
    > & { readonly fields: Record<string, Schema.Top> }
    const input = {
      hostId: "h-abc123",
      epoch: 5,
      key: "a".repeat(43),
      endpoint: { socket: "/run/broker-5.sock" },
      egress: { socket: "/run/egress-5.sock" },
      proto: 1,
    }
    const older = Schema.Struct(
      // SAFETY: the arm fields have no services; they are the struct's own fields minus one.
      Object.fromEntries(Object.entries(arm.fields).filter(([name]) => name !== "egress")) as Record<
        string,
        Schema.Codec<unknown, unknown>
      >,
    )
    expect(Schema.decodeUnknownSync(older)(input)).not.toHaveProperty("egress")
    expect(Schema.decodeUnknownSync(arm)(input)).toHaveProperty("egress", { socket: "/run/egress-5.sock" })
    const { egress: _egress, ...withoutEgress } = input
    expect(Schema.decodeUnknownSync(arm)(withoutEgress)).not.toHaveProperty("egress")
  })

  test("the PC's switch, consent and Fast methods are local control methods a host refuses", () => {
    for (const method of [
      "plugin.claudeAuth.remote.ack",
      "plugin.claudeAuth.remote.set",
      "plugin.claudeAuth.fastAck",
    ] as const) {
      expect(OwnRouting.MethodScope[method]).toBe("local")
      expect(OwnRouting.MethodLocation[method]).toBe("control")
      expect(Object.keys(OwnAccounts.Definition.methods[method].errors)).toContain("remote_managed")
    }
    expect(Kv.ackClaudeRemote).toBe("ack:claudeRemote")
    expect(Schema.decodeUnknownSync(OwnError.data.ack_required)({ reason: "remote" })).toEqual({ reason: "remote" })
    expect(Schema.decodeUnknownSync(OwnError.data.speed_consent_required)({ recordOn: "local" })).toEqual({
      recordOn: "local",
    })
    expect(Schema.decodeUnknownSync(OwnError.data.speed_consent_required)({})).toEqual({})
    for (const code of ["claude_remote_refused", "claude_remote_conflict"])
      expect<ReadonlyArray<string>>(Alert.Code.literals).toContain(code)
  })

  test("remoteHosts lives in accounts.json's claudeSlot; status and health carry the remote parts", () => {
    const slot = { accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "orange" }
    expect(roundTrip(Registry.ClaudeSlot, slot)).toEqual(slot)
    expect(roundTrip(Registry.ClaudeSlot, { ...slot, remoteHosts: ["h-abc123"] })).toEqual({
      ...slot,
      remoteHosts: ["h-abc123"],
    })
    expect(() => Schema.decodeUnknownSync(Registry.ClaudeSlot)({ ...slot, remoteHosts: ["dev-host"] })).toThrow()
    const status = {
      installed: true,
      version: "0.4.0-beta.5",
      integrityOk: true,
      order: "ok",
      phase: "ready",
      acknowledged: null,
      connection: null,
      warnings: [],
    }
    expect(roundTrip(Plugin.ClaudeAuthStatus, status)).toEqual(status)
    const remote = {
      acknowledged: { at: "2026-10-09T00:00:00.000Z", valid: true },
      noticeHash: "ab",
      hosts: [{ hostId: "h-abc123", enabled: true, state: "enabled" }],
    }
    expect(roundTrip(Plugin.ClaudeAuthStatus, { ...status, remote })).toEqual({ ...status, remote })
    const health = { version: "1", buildId: "b", guard: "ok", claudeSlot: { state: null, conflict: true } }
    expect(roundTrip(OwnAccounts.Health, health)).toEqual(health)
    const broker = {
      state: "connected",
      mode: "normal",
      proto: 1,
      leasesActive: 0,
      lastPushAt: null,
      spoolBacklog: 0,
      gaps: 0,
      clockSkewMs: null,
      sourceStale: [],
    }
    expect(roundTrip(OwnRemote.BrokerView, broker)).toEqual(broker)
    const claudeView = { state: "consent", inflight: 2, lastError: "needs_reauth", holdUntil: 5 }
    expect(roundTrip(OwnRemote.BrokerView, { ...broker, claude: claudeView })).toEqual({ ...broker, claude: claudeView })
  })
})

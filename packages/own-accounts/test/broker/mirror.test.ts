// The mirrored registry view (04 §9.2): what reaches a host, what never does, and that a host computes the same
// auto-compaction thresholds from it as this PC does. T3 (07 §8.1 원격): the view carries `presets.json` with its
// revision and the budget verdict of every paid account the host may use, and the local broker (real slots and
// telemetry modules on a temp OWN_HOME, a hand-rolled host on loopback) announces `mirror.changed` when presets.json
// changes or a paid account's spend crosses its budget. Every account and key is fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import net from "node:net"
import { Schema } from "effect"
import { Account, Broker, Compaction, Ledger, Policy, Preset, type Ratecard, type Registry } from "@own/protocol"
import { BrokerHost } from "../../src/broker/host.js"
import { Mirror } from "../../src/broker/mirror.js"
import type { Server } from "../../src/broker/server.js"
import { Wire } from "../../src/broker/wire.js"
import { Modules } from "../../src/modules.js"
import { memoryStorage, registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const ratecards: Ratecard.File = { schemaVersion: 1, updatedAt: "2026-09-27", cards: [] }

async function fixture() {
  const base = await registryWith([
    {
      kind: "codex",
      label: "Pro",
      slug: "prox",
      identity: { chatgptAccountId: "acct-secret-id", emailMasked: "na***@x.test", fingerprint: "sha256:ffff", plan: "pro" },
      credential: {
        type: "linked-codex-source",
        source: { app: "codex-multi-provider", profileID: "07", alias: "work", authPath: "C:\\Users\\u\\auth.json" },
        linkedAt: "2026-09-27T00:00:00.000Z",
      },
    },
    { kind: "oai", label: "Key", slug: "keya", identity: { keyHint: "sk-…9fQ2", organizationId: "org-hidden" } },
    { kind: "oai", label: "Denied", slug: "denied" },
  ])
  const registry: Registry.File = {
    ...base,
    cacheDomains: Object.fromEntries(
      Object.entries(base.cacheDomains).map(([id, domain]) => [id, { ...domain, externalId: `ext-${id}` }]),
    ) as Registry.File["cacheDomains"],
    accounts: base.accounts.map((account) =>
      account.label === "Denied"
        ? { ...account, remote: "deny" as const }
        : account.label === "Key"
          ? { ...account, budget: { monthlyUSD: 20 }, compaction: { triggerPercent: 60 } }
          : account,
    ),
    claudeSlot: { accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "violet" },
  }
  const policy: Policy.File = {
    ...Policy.defaults,
    compaction: { byKind: { oai: { triggerPercent: 70, models: { "gpt-5.5": { maxTriggerTokens: 150_000 } } } } },
  }
  return { registry, policy }
}

describe("Mirror.build", () => {
  test("carries no identifiers, secrets, credential refs, budgets or the Claude slot", async () => {
    const { registry, policy } = await fixture()
    const { view } = Mirror.build({ registry, policy, ratecards, scope: { mode: "all" } })
    const text = JSON.stringify(view)
    for (const hidden of ["acct-secret-id", "na***@x.test", "sha256:ffff", "sk-…9fQ2", "org-hidden", "auth.json", "ext-cd_", "monthlyUSD", "acc_claude_slot"])
      expect(text).not.toContain(hidden)
    for (const account of view.registry.accounts) {
      expect(account.identity).toEqual({})
      expect(account).not.toHaveProperty("credential")
      expect(account).not.toHaveProperty("budget")
    }
    // The view decodes with the protocol schema (what the remote checks) and is a valid registry file.
    expect(Schema.decodeUnknownSync(Broker.MirrorView)(view).registry.accounts).toHaveLength(3)
    expect(view.schemaVersion).toBe(Broker.MIRROR_SCHEMA_VERSION)
    expect(view.registryRevision).toBe(registry.revision)
  })

  test("04 §8.11.4.3: the Claude verdict with the slot's display only; no remoteHosts, label source or identity", async () => {
    const { registry, policy } = await fixture()
    const switched: Registry.File = {
      ...registry,
      claudeSlot: { ...registry.claudeSlot!, label: "내 Claude", remoteHosts: ["h-abc123", "h-other1"] },
    }
    for (const state of ["not_ready", "billing", "off", "consent", "host_scope", "enabled"] as const) {
      const { view } = Mirror.build({ registry: switched, policy, ratecards, scope: { mode: "all" }, claude: { state, fast: true } })
      expect(view.claude).toEqual({
        state,
        fast: true,
        display: { label: "내 Claude", shortLabel: "C", color: "violet" },
        accounts: [{ accountID: Account.ID.claudeSlot, label: "내 Claude", shortLabel: "C", color: "violet", default: true }],
      })
      const text = JSON.stringify(view)
      for (const hidden of ["remoteHosts", "h-abc123", "h-other1", "na***@x.test"]) expect(text).not.toContain(hidden)
      expect(Schema.decodeUnknownSync(Broker.MirrorView)(view).claude?.state).toBe(state)
    }
    // No slot detected on this PC: no field at all.
    expect(Mirror.build({ registry: switched, policy, ratecards, scope: { mode: "all" } }).view).not.toHaveProperty("claude")
    // Defaults of a slot nobody renamed.
    const { claudeSlot: _, ...bare } = registry
    expect(Mirror.claudeDisplay(bare)).toEqual({ label: null, shortLabel: "C", color: "orange" })
  })

  test("02 §8.7: every Claude account the host's scope allows, display only; no folder, key, e-mail or uuid", async () => {
    const { registry, policy } = await fixture()
    const two = "acc_01J9CLAUDETWO0000000000000" as Registry.ClaudeAccount["accountID"]
    const three = "acc_01J9CLAUDETHREE00000000000" as Registry.ClaudeAccount["accountID"]
    const account = (accountID: Registry.ClaudeAccount["accountID"], folder: string): Registry.ClaudeAccount => ({
      accountID,
      key: `c:/hiddenfolder/${folder}`,
      configDir: `C:/hiddenfolder/${folder}`,
      label: folder,
      shortLabel: "C2",
      color: "amber",
      managed: true,
      email: "hi***@…",
      accountUuid: "uuid-hidden",
      addedAt: "2026-10-10T00:00:00Z",
    })
    const many: Registry.File = {
      ...registry,
      claudeAccounts: [account(two, "two"), account(three, "three")],
      claudeDefault: three,
    }
    const all = Mirror.build({ registry: many, policy, ratecards, scope: { mode: "all" }, claude: { state: "enabled", fast: false } })
    expect(all.view.claude?.accounts?.map((item) => [String(item.accountID), item.default])).toEqual([
      ["acc_claude_slot", false],
      [two, false],
      [three, true],
    ])
    const text = JSON.stringify(all.view)
    for (const hidden of ["hiddenfolder", "hi***@…", "uuid-hidden", "configDir", "managed"]) expect(text).not.toContain(hidden)
    // A scope without this PC's default: the first account it may use is the host's default.
    const only = Mirror.build({
      registry: many,
      policy,
      ratecards,
      scope: { mode: "only", ids: [two, "acc_claude_slot"] },
      claude: { state: "enabled", fast: false },
    })
    expect(only.view.claude?.accounts?.map((item) => [String(item.accountID), item.default])).toEqual([
      ["acc_claude_slot", true],
      [two, false],
    ])
  })

  test("templates travel by content hash; the registry in the view has none", async () => {
    const { registry, policy } = await fixture()
    const built = Mirror.build({ registry, policy, ratecards, scope: { mode: "all" } })
    expect(built.view.registry.modelTemplates).toEqual({})
    expect(Object.keys(built.view.templates).toSorted()).toEqual(Object.keys(registry.modelTemplates).toSorted())
    for (const [id, hash] of Object.entries(built.view.templates)) {
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
      expect(built.templates.get(id)?.hash).toBe(hash)
      // Each template fits one frame on its own.
      expect(Broker.encodeFrame({ template: built.templates.get(id)?.template }).length).toBeLessThan(Broker.MAX_FRAME_BYTES)
    }
  })

  test("accounts the host may not use stay registered but disabled (account deny, host scope)", async () => {
    const { registry, policy } = await fixture()
    const all = Mirror.build({ registry, policy, ratecards, scope: { mode: "all" } }).view.registry.accounts
    expect(Object.fromEntries(all.map((account) => [account.label, account.status]))).toEqual({
      Pro: "ready",
      Key: "ready",
      Denied: "disabled",
    })
    const key = registry.accounts.find((account) => account.label === "Key")!
    const only = Mirror.build({ registry, policy, ratecards, scope: { mode: "only", ids: [key.id] } }).view.registry
    expect(Object.fromEntries(only.accounts.map((account) => [account.label, account.status]))).toEqual({
      Pro: "disabled",
      Key: "ready",
      Denied: "disabled",
    })
    // Slots are all there (past turns keep their attribution).
    expect(Object.keys(only.slots)).toHaveLength(3)
  })

  test("a host computes the same compaction thresholds as this PC (account + policy settings travel)", async () => {
    const { registry, policy } = await fixture()
    const { view } = Mirror.build({ registry, policy, ratecards, scope: { mode: "all" } })
    for (const local of registry.accounts) {
      const remote = view.registry.accounts.find((account) => account.id === local.id)!
      const template = registry.modelTemplates[registry.slots[local.providerID]!.modelTemplate]!
      for (const model of template.models.slice(0, 5)) {
        const limit = { context: model.limit.context, input: model.limit.input }
        const mine = Compaction.resolve(
          Compaction.chain({ kind: local.kind, modelID: model.id, policy: policy.compaction?.byKind, account: local.compaction }),
          limit,
        )
        const theirs = Compaction.resolve(
          Compaction.chain({ kind: remote.kind, modelID: model.id, policy: view.policy.compaction?.byKind, account: remote.compaction }),
          limit,
        )
        expect(theirs).toEqual(mine)
      }
    }
    expect(view.registry.accounts.find((account) => account.label === "Key")?.compaction).toEqual({ triggerPercent: 60 })
  })

  test("policy and rate card revisions are stable content hashes", async () => {
    const { policy } = await fixture()
    expect(Mirror.revisionOf(policy)).toBe(Mirror.revisionOf(structuredClone(policy)))
    expect(Mirror.revisionOf(policy)).not.toBe(Mirror.revisionOf({ ...policy, horizonRequests: 21 }))
    expect(Number.isSafeInteger(Mirror.revisionOf(ratecards))).toBe(true)
  })
})

const PRESET_ID = Preset.ID.make("pr_01JB0000000000000000000041")
const decodePresets = Schema.decodeUnknownSync(Preset.File)

/** `presets.json` with one ChatGPT preset (★): review on the DeepSeek key. */
function presetsFile(name: string): Preset.File {
  return decodePresets({
    version: 1,
    groups: {
      codex: {
        star: PRESET_ID,
        presets: [
          {
            ...Preset.builtin("codex"),
            id: PRESET_ID,
            name,
            workers: {
              mode: "by-role",
              roles: {
                "own-review": {
                  targets: [{ pin: { account: "acc_ds01", model: "deepseek-flash" } }],
                  effort: "inherit",
                },
              },
            },
          },
        ],
      },
    },
  })
}

describe("Mirror.build: presets for the host's gate (T3, 07 §8.1 원격)", () => {
  test("the view carries presets.json, its content-hash revision and the budget verdicts it is given", async () => {
    const { registry, policy } = await fixture()
    const presets = presetsFile("리뷰")
    const key = registry.accounts.find((account) => account.label === "Key")!
    const { view } = Mirror.build({
      registry,
      policy,
      ratecards,
      scope: { mode: "all" },
      presets,
      budget: { [key.id]: { exhausted: true } },
    })
    expect(view.presets).toEqual(presets)
    expect(view.presetsRevision).toBe(Mirror.revisionOf(presets))
    expect(view.presetsBudget).toEqual({ [key.id]: { exhausted: true } })
    expect(Mirror.revisionOf(structuredClone(presets))).toBe(Mirror.revisionOf(presets))
    expect(Mirror.revisionOf(presetsFile("다른 리뷰"))).not.toBe(Mirror.revisionOf(presets))
    // Over the wire and back: the protocol schema reads all three; the budget itself never travels.
    const decoded = Schema.decodeUnknownSync(Broker.MirrorView)(JSON.parse(JSON.stringify(view)))
    expect(decoded.presets).toEqual(presets)
    expect(decoded.presetsBudget).toEqual({ [key.id]: { exhausted: true } })
    expect(JSON.stringify(view)).not.toContain("monthlyUSD")
    // Without presets (an unreadable presets.json) and budgets the view is the T2 one: the host keeps 평소대로 only.
    const bare = Mirror.build({ registry, policy, ratecards, scope: { mode: "all" } }).view
    expect(Object.keys(bare).filter((name) => name.startsWith("presets"))).toEqual([])
  })

  test("paid: the accounts a host may use that cost money (no subscription, denied or out-of-scope one)", async () => {
    const { registry } = await fixture()
    const labels = (accounts: ReadonlyArray<{ readonly label: string }>) => accounts.map((account) => account.label)
    expect(labels(Mirror.paid(registry, { mode: "all" }))).toEqual(["Key"])
    const pro = registry.accounts.find((account) => account.label === "Pro")!
    expect(labels(Mirror.paid(registry, { mode: "only", ids: [pro.id] }))).toEqual([])
    const retired = {
      ...registry,
      accounts: registry.accounts.map((account) =>
        account.label === "Key" ? { ...account, status: "retired" as const } : account,
      ),
    }
    expect(labels(Mirror.paid(retired, { mode: "all" }))).toEqual([])
  })
})

const HOST = "h-presets1"
const BUDGET_USD = 5
const decodeView = Schema.decodeUnknownSync(Broker.MirrorView)
const decodeLine = Schema.decodeUnknownSync(Ledger.Line)

describe("the local broker announces presets.json and budget crossings (T3)", () => {
  const state = {} as {
    t: Awaited<ReturnType<typeof testDeps>>
    modules: Modules.All
    detach: () => Promise<void>
    server: Server.LocalBroker
    channel: Wire.Channel
    frames: unknown[]
    ids: number
    spent: number
    deepseek: Registry.File["accounts"][number]
  }

  const announced = () =>
    state.frames.filter((frame) => isFrame(frame) && frame.type === "push" && frame.event === "mirror.changed").length

  const view = async () => {
    const id = ++state.ids
    state.channel.send({ type: "req", id, method: "registry.get", params: { since: null } })
    const reply = await until(() =>
      state.frames.find((frame) => isFrame(frame) && frame.type === "res" && frame.id === id),
    )
    return decodeView((reply as { readonly result: unknown }).result)
  }

  /** Spends `amount` USD on the DeepSeek key this month (a ledger line, as telemetry or a host's push writes it). */
  const spend = async (amount: number) => {
    const runtime = state.t.deps.runtime
    const eid = `evt_mirror_spend_${++state.spent}`
    const line = decodeLine({
      v: 1,
      ts: state.t.clock.now(),
      sessionID: "ses_spent",
      messageID: null,
      kind: "primary",
      accountID: state.deepseek.id,
      providerID: state.deepseek.providerID,
      modelID: "deepseek-flash",
      variant: null,
      credentialRef: null,
      transport: null,
      switchEpoch: 0,
      compactionEpoch: 0,
      tokens: null,
      P: null,
      hit: null,
      cost: { unit: "USD", amount, source: "ratecard" },
      costUSDOpenCode: null,
      coldExpected: null,
    })
    await runtime.ledger.usage(eid, line)
    await runtime.ledger.flush()
    runtime.broadcast.emit("ledger.line", { eid, line })
  }

  beforeAll(async () => {
    state.frames = []
    state.ids = 0
    state.spent = 0
    state.t = await testDeps({
      ctx: {
        app: { version: "local" },
        provider: { reload: async () => {}, list: async () => [] },
        storage: memoryStorage().storage,
      },
    })
    const runtime = state.t.deps.runtime
    const base = await registryWith([
      { kind: "codex", label: "ChatGPT 01", slug: "cx01" },
      { kind: "ds", label: "DeepSeek", slug: "ds01" },
      { kind: "oai", label: "OpenAI key", slug: "keya" },
    ])
    const registry = await runtime.registry.write({
      ...base,
      accounts: base.accounts.map((account) =>
        account.kind === "ds" ? { ...account, budget: { monthlyUSD: BUDGET_USD } } : account,
      ),
    })
    state.deepseek = registry.accounts.find((account) => account.kind === "ds")!
    await runtime.presets.write(presetsFile("리뷰"))
    // Real slots and telemetry: the verdict is `quota.snapshot`'s budget window over this OWN_HOME's ledger.
    state.modules = state.t.modules()
    await state.modules.slots.start()
    state.detach = BrokerHost.attach(state.t.deps, state.modules)
    state.server = BrokerHost.peek(runtime.buildId)!
    const key = randomBytes(32)
    const { port } = await state.server.listen(HOST)
    state.server.setKey(HOST, { epoch: 1, key })
    state.server.configure(HOST, { accounts: { mode: "all" }, leaseSeconds: 900, failClosedGraceSeconds: 2 })
    state.channel = await connect(port, key, runtime.buildId)
    state.channel.onFrame((frame) => void state.frames.push(frame))
  }, 30_000)

  afterAll(async () => {
    state.channel?.close()
    await state.detach?.()
    await state.modules?.slots.stop()
    await state.t?.[Symbol.asyncDispose]()
  }, 30_000)

  test("registry.get: presets.json, its revision and this PC's verdict for every paid account", async () => {
    const mirrored = await view()
    expect(mirrored.presets?.groups.codex?.star).toBe(PRESET_ID)
    expect(mirrored.presetsRevision).toBe(Mirror.revisionOf(await state.t.deps.runtime.presets.read()))
    // The subscription account has no entry; the paid ones are within budget (nothing spent yet).
    expect(mirrored.presetsBudget).toEqual({ acc_ds01: { exhausted: false }, acc_keya: { exhausted: false } })
  })

  test("a presets.json change pushes mirror.changed and the next view carries it", async () => {
    const before = announced()
    await state.t.deps.runtime.presets.write(presetsFile("리뷰 2"))
    state.t.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "local" })
    await until(() => announced() > before)
    const mirrored = await view()
    expect(mirrored.presets?.groups.codex?.presets?.[0]?.name).toBe("리뷰 2")
    expect(mirrored.presetsRevision).toBe(Mirror.revisionOf(await state.t.deps.runtime.presets.read()))
  })

  test("a presets.json that cannot be read (a broken hand edit) sends the last one read, never none", async () => {
    const runtime = state.t.deps.runtime
    const good = await runtime.presets.read()
    const text = await Bun.file(runtime.presets.file).text()
    await Bun.write(runtime.presets.file, "{ broken by hand")
    try {
      const mirrored = await view()
      expect(mirrored.presets).toEqual(good)
      expect(mirrored.presetsRevision).toBe(Mirror.revisionOf(good))
    } finally {
      await Bun.write(runtime.presets.file, text)
    }
  })

  test("spend below the budget pushes nothing; the line that crosses it pushes mirror.changed", async () => {
    const before = announced()
    await spend(1)
    // The once-a-minute check sees the same verdict too.
    await state.server.sweep()
    await Bun.sleep(150)
    expect(announced()).toBe(before)
    expect((await view()).presetsBudget?.acc_ds01).toEqual({ exhausted: false })
    await spend(BUDGET_USD)
    await until(() => announced() > before)
    expect((await view()).presetsBudget).toEqual({ acc_ds01: { exhausted: true }, acc_keya: { exhausted: false } })
    // Spending on beyond it changes no verdict: nothing more is announced.
    const after = announced()
    await spend(1)
    await state.server.sweep()
    await Bun.sleep(150)
    expect(announced()).toBe(after)
  })

  test("a new month frees the budget: the once-a-minute check pushes mirror.changed", async () => {
    const before = announced()
    const now = state.t.clock.now()
    const date = new Date(now)
    state.t.clock.advance(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 5) - now)
    await state.server.sweep()
    await until(() => announced() > before)
    expect((await view()).presetsBudget?.acc_ds01).toEqual({ exhausted: false })
  })
})

/** A hand-rolled host of this build: hello, auth, `ready` in normal mode. */
async function connect(port: number, key: Uint8Array, buildId: string) {
  const socket = net.connect({ host: "127.0.0.1", port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  const channel = new Wire.Channel(socket)
  const nonceR = Wire.nonce()
  channel.send({
    type: "hello",
    proto: Broker.PROTO,
    hostId: HOST,
    epoch: 1,
    nonceR,
    version: "local",
    buildId,
    mirrorSchemaVersion: Broker.MIRROR_SCHEMA_VERSION,
    streamId: "0123456789abcdef",
  })
  const challenge = (await channel.next(5_000)) as Broker.Challenge
  channel.send({ type: "auth", mac: Wire.mac(key, "R", { hostId: HOST, epoch: 1, nonceR, nonceL: challenge.nonceL }) })
  expect(await channel.next(5_000)).toMatchObject({ type: "ready", mode: "normal" })
  return channel
}

function isFrame(value: unknown): value is { readonly type: string; readonly id?: number; readonly event?: string } {
  return typeof value === "object" && value !== null && "type" in value
}

async function until<T>(read: () => T | undefined | false, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(20)
  }
}

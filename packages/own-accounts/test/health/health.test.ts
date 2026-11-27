import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Registry } from "@own/protocol"
import { Runtime, Vault } from "@own/runtime"
import { Build } from "../../src/build.js"
import type { Deps } from "../../src/deps.js"
import { Health } from "../../src/health/health.js"
import type { Module } from "../../src/module.js"
import type { Modules } from "../../src/modules.js"
import type { Board } from "../../src/plugins/board.js"
import type { Agents } from "../../src/presets/agents.js"
import { CoreConfig } from "../../src/slots/core-config.js"
import { Templates } from "../../src/slots/templates.js"
import type { Registry as RegistryFile } from "@own/protocol"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps } from "../support/deps.js"
import { local, ok, sessionEvent, until } from "../plugins/support.js"
import { catalogModel } from "../slots/support.js"

const GOOD = "own-oai-good1"
const BAD = "own-anth-bad01"
const GONE = "own-ds-gone1"
const NEW = "own-xai-new01"

function account(id: string, providerID: string, kind: string, status = "ready") {
  return {
    id,
    kind,
    label: id,
    shortLabel: "a",
    color: "indigo",
    providerID,
    cacheDomain: `cd_${id}`,
    quotaDomain: `qd_${id}`,
    billing: "metered",
    identity: {},
    autoSwitch: false,
    status,
  }
}

function slot(kind: string, id: string, retired = false) {
  return { kind, accounts: [id], pooling: "off", modelTemplate: `tpl_${kind}`, ...(retired ? { retired } : {}) }
}

const registry: RegistryFile.File = Schema.decodeUnknownSync(Registry.File)({
  schemaVersion: 1,
  revision: 7,
  cacheDomains: {},
  quotaDomains: {},
  accounts: [
    account("acc_good", GOOD, "oai"),
    account("acc_bad", BAD, "anth"),
    account("acc_gone", GONE, "ds", "retired"),
    account("acc_new", NEW, "xai"),
  ],
  slots: {
    [GOOD]: slot("oai", "acc_good"),
    [BAD]: slot("anth", "acc_bad"),
    [GONE]: slot("ds", "acc_gone", true),
    [NEW]: slot("xai", "acc_new"),
  },
  modelTemplates: {},
})

function provider(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, activation: "enabled", package: "@opencode/ai/providers/openai", ...overrides }
}

function model(providerID: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: {},
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1, output: 1 },
    ...overrides,
  }
}

/** A Location whose providers show every self-check problem once. */
function context(options: { readonly defaultProvider?: string; readonly anthropic?: boolean } = {}) {
  const records: Record<string, unknown> = {
    [GOOD]: provider(GOOD),
    [BAD]: provider(BAD, {
      activation: "disabled",
      integrationID: "anthropic",
      package: "@opencode/ai/providers/openai",
      settings: { apiKey: "{env:SOME_KEY}" },
    }),
    other: provider("other", { headers: { "x-custom": "sk-ant-api03-FAKEFAKEFAKEFAKE" } }),
    ...(options.anthropic === false
      ? {}
      : { anthropic: provider("anthropic", { package: "@opencode/ai/providers/anthropic" }) }),
  }
  return {
    provider: {
      list: async () => ({ data: [records[GOOD], records.other] }),
      get: async (input: { providerID: string }) => {
        const record = records[input.providerID]
        if (!record) throw new Error("not found")
        return { data: record }
      },
    },
    model: {
      list: async () => ({
        data: [
          model(GOOD, "m1"),
          model(BAD, "m2", { headers: { Authorization: "Bearer x" } }),
          model("other", "m3", { body: { note: "eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl" } }),
        ],
      }),
      default: async () => ({ data: options.defaultProvider ? model(options.defaultProvider, "m1") : null }),
    },
    integration: {
      list: async () => ({ data: [{ id: BAD, name: BAD, methods: [], connections: [{ type: "env", name: "X" }] }] }),
    },
    plugin: {
      list: async () => ({
        data: [
          local("own.accounts", "C:/own/app/current/plugins/own-accounts/index.js"),
          local("own.telemetry", "C:/own/app/current/plugins/own-telemetry/index.js"),
        ],
      }),
    },
  }
}

async function harness(
  options: Parameters<typeof context>[0] & {
    readonly locations?: ReadonlyArray<Board.LocationState>
    /** The own global config's compaction keys as the slots module reads them. */
    readonly core?: CoreConfig.Values
    readonly registry?: RegistryFile.File
    /** Hidden agents' models the presets module removed (07 §5.4). */
    readonly removedAgentModels?: ReadonlyArray<Agents.Removal>
    readonly vault?: Vault.Transport
  } = {},
) {
  const test = await testDeps({ ctx: context(options), control: true, vault: options.vault })
  const alerts: Telemetry.AlertInput[] = []
  const mutations: RegistryFile.File[] = []
  const state = { registry: options.registry ?? registry }
  const peers: Module.Peers = () =>
    // SAFETY: health uses only these members of its peers.
    ({
      slots: {
        refreshCore: async () => options.core ?? CoreConfig.DEFAULTS,
        snapshot: () => state.registry,
        mutate: async (change: (current: RegistryFile.File) => RegistryFile.File | undefined) => {
          const next = change(state.registry)
          if (next) {
            state.registry = next
            mutations.push(next)
          }
          return state.registry
        },
      },
      plugins: {
        locations: () => options.locations ?? [],
        claudeOrder: () => "after_own_telemetry",
        claudeSlot: () => ({ detected: true, version: "0.4.0-fake", integrity: "sha512-x", verified: true }),
        bundleSettled: async () => undefined,
      },
      telemetry: { alert: (input: Telemetry.AlertInput) => alerts.push(input) },
      auth: { authSwap: (providerID: string) => (providerID === GOOD ? "ok" : "broken") },
      presets: { removedAgentModels: () => options.removedAgentModels ?? [] },
    }) as unknown as Modules.All
  const health = Health.create(test.deps, peers)
  return {
    test,
    health,
    alerts,
    mutations,
    state,
    deps: test.deps as Deps,
    [Symbol.asyncDispose]: () => test[Symbol.asyncDispose](),
  }
}

describe("diagnostics.selfTest", () => {
  test("judges every live slot, scans overlays without echoing values, and checks the default model", async () => {
    await using h = await harness({ defaultProvider: GOOD, anthropic: false })
    const result = await ok(h.health.selfTest, {})
    expect(result.slots as ReadonlyArray<unknown>).toEqual([
      { providerID: GOOD, ok: true, problems: [], authSwap: "ok" },
      {
        providerID: BAD,
        ok: false,
        problems: [
          "activation_disabled",
          "integration_id_set",
          "integration_connection",
          "auth_in_provider_settings",
          "auth_in_model_settings",
          "package_not_allowed",
        ],
        authSwap: "broken",
      },
      { providerID: NEW, ok: false, problems: ["provider_missing"], authSwap: "broken" },
    ])
    expect(result.secretScan).toEqual({
      ok: false,
      findings: ["other.headers.x-custom: anthropic_key", "other/m3.body.note: jwt"],
    })
    expect(JSON.stringify(result)).not.toContain("FAKEFAKE")
    expect(result.defaultModel).toEqual({ ok: false, warning: "default_model_own_slot" })
    expect(result.surface).toEqual({ ok: false, changed: ["anthropic_record_missing"] })
  })

  test("a non-own default model and an anthropic record pass", async () => {
    await using h = await harness({ defaultProvider: "anthropic" })
    const result = await ok(h.health.selfTest, {})
    expect(result.defaultModel).toEqual({ ok: true })
    expect(result.surface).toEqual({ ok: true, changed: [] })
    expect(result.agentModels).toEqual({ ok: true, removed: [] })
  })

  test("hidden agents whose subscription-slot model was removed fail agentModels (07 §5.4)", async () => {
    const removed = [{ agent: "title", model: Model.Ref.parse("own-codex-cx02/gpt-6-luna") }]
    await using h = await harness({ removedAgentModels: removed })
    const result = await ok(h.health.selfTest, {})
    expect(result.agentModels).toEqual({ ok: false, removed })
  })
})

describe("startup self-check", () => {
  test("marks slots with configuration problems misconfigured and alerts once", async () => {
    await using h = await harness({ defaultProvider: BAD })
    await h.health.check()
    expect(h.mutations).toHaveLength(1)
    const statuses = Object.fromEntries(h.mutations[0].accounts.map((item) => [item.providerID, item.status]))
    // provider_missing right after setup is not a configuration fact; retired accounts are never touched.
    expect(statuses).toEqual({ [GOOD]: "ready", [BAD]: "misconfigured", [GONE]: "retired", [NEW]: "ready" })
    expect(h.alerts.map((alert) => [alert.code, alert.severity])).toEqual([
      ["secret_in_overlay", "error"],
      ["default_model_own_slot", "warning"],
    ])
    expect(h.alerts[0].message).not.toContain("FAKEFAKE")

    await h.health.check()
    expect(h.mutations).toHaveLength(1)
    expect(h.alerts).toHaveLength(2)
  })

  test("each Codex model without a known Codex window raises its own info alert (07 §6.2 #4, §8.1)", async () => {
    const codex = "own-codex-cdx01"
    const registryOf = (ids: ReadonlyArray<string>) => {
      const built = Templates.fromCatalog(
        "codex",
        ids.map((id) => catalogModel("openai", id)),
        "2026-10-01T00:00:00Z",
      )
      if (!built.ok) throw new Error(built.reason)
      return Schema.decodeUnknownSync(Registry.File)({
        schemaVersion: 1,
        revision: 7,
        cacheDomains: {},
        quotaDomains: {},
        accounts: [account("acc_cdx", codex, "codex")],
        slots: { [codex]: slot("codex", "acc_cdx") },
        modelTemplates: { tpl_codex: built.template },
      })
    }
    await using h = await harness({ registry: registryOf(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.5"]) })
    await h.health.check()
    await h.health.check()
    const unverified = () => h.alerts.filter((alert) => alert.code === "codex_window_unverified")
    expect(unverified().map((alert) => [alert.severity, alert.subject])).toEqual([["info", "gpt-6.1-sol"]])
    expect(unverified()[0]?.message).toContain("gpt-6.1-sol")
    // A model that appears later (a refreshed catalog) gets its own alert; the one already raised is not repeated.
    h.state.registry = registryOf(["gpt-6.1-sol", "gpt-6.2-nova", "gpt-6-astra"])
    await h.health.check()
    expect(unverified().map((alert) => alert.subject)).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
  })

  test("runs again after provider reloads settle", async () => {
    await using h = await harness()
    h.health.onEvent?.(sessionEvent("provider.updated", {}), { local: true })
    h.health.onEvent?.(sessionEvent("provider.updated", {}), { local: true })
    h.health.onEvent?.(sessionEvent("provider.updated", {}), { local: false })
    expect(h.mutations).toHaveLength(0)
    h.test.clock.advance(Health.CHECK_DEBOUNCE_MS)
    await until(() => h.mutations.length > 0)
    expect(h.mutations).toHaveLength(1)
    await h.health.stop()
  })
})

describe("health", () => {
  test("reports versions, vault, registry, Locations, sizes and warnings", async () => {
    const blocked: Board.LocationState = {
      directory: "D:/tmp/cloned",
      status: "blocked_by_plugin",
      candidates: [],
      pending: 1,
    }
    const fine: Board.LocationState = { directory: "D:/work/repo", status: "ok", candidates: [], pending: 0 }
    await using h = await harness({ locations: [blocked, fine] })
    await h.health.check()
    const health = await ok(h.health.health, {})
    expect(health).toMatchObject({
      version: Build.PLUGIN_VERSION,
      buildId: h.deps.runtime.buildId,
      guard: "ok",
      pluginVersions: { accounts: Build.PLUGIN_VERSION, telemetry: null },
      vaultBackend: { name: "own-vault-memory" },
      vault: "ok",
      registryRevision: 7,
      controlDir: h.deps.runtime.layout.control,
      locations: [
        { directory: "D:/tmp/cloned", allowlist: "blocked_by_plugin" },
        { directory: "D:/work/repo", allowlist: "ok" },
      ],
      sizes: { kv: null, ledger: 0 },
    })
    expect(health.warnings).toEqual([
      "telemetry_build_mismatch",
      "untrusted_plugin:D:/tmp/cloned",
      "claude_auth_order:after_own_telemetry",
      "secret_in_overlay",
      `slot_misconfigured:${BAD}`,
      `slot_misconfigured:${NEW}`,
    ])
  })

  test("a compaction buffer or auto:false in the own global config is reported (02 §4.7.2 (b))", async () => {
    await using h = await harness({
      locations: [],
      core: { keepTokens: 15_000, auto: false, buffer: 20_000, model: null },
    })
    const health = await ok(h.health.health, {})
    expect(health.warnings).toContain("compaction_buffer_set")
    expect(health.warnings).toContain("compaction_auto_off")
  })

  test("own-telemetry holding this build's runtime counts as attached", async () => {
    await using h = await harness({ locations: [] })
    await using telemetry = await Runtime.acquire({
      buildId: h.deps.runtime.buildId,
      home: h.deps.runtime.layout.root,
      role: "own.telemetry",
    })
    expect(telemetry.buildId).toBe(h.deps.runtime.buildId)
    const health = await ok(h.health.health, {})
    expect(health.pluginVersions).toEqual({
      accounts: Build.PLUGIN_VERSION,
      telemetry: Build.PLUGIN_VERSION,
      claudeAuth: "0.4.0-fake",
    })
    expect(health.warnings).not.toContain("telemetry_build_mismatch")
  })

  test("only own-telemetry's runtime references count: own.remote and own.team holders are not telemetry", async () => {
    await using h = await harness({ locations: [] })
    const options = { buildId: h.deps.runtime.buildId, home: h.deps.runtime.layout.root }
    await using remote = await Runtime.acquire({ ...options, role: "own.remote" })
    await using team = await Runtime.acquire({ ...options, role: "own.team" })
    expect([remote.buildId, team.buildId]).toEqual([h.deps.runtime.buildId, h.deps.runtime.buildId])
    const health = await ok(h.health.health, {})
    expect(health.pluginVersions).toEqual({ accounts: Build.PLUGIN_VERSION, telemetry: null, claudeAuth: "0.4.0-fake" })
    expect(health.warnings).toContain("telemetry_build_mismatch")
  })
})

describe("vault warm-up", () => {
  /** The in-memory vault, recording the operation of every request. */
  function recorded() {
    const ops: unknown[] = []
    const memory = Vault.memory()
    const transport: Vault.Transport = {
      request: (message) => {
        ops.push(message.op)
        return memory.request(message)
      },
      close: () => memory.close(),
    }
    return { ops, transport }
  }

  test("the leader says hello to the vault helper once the startup window passed, and reads no secret", async () => {
    const vault = recorded()
    await using h = await harness({ vault: vault.transport })
    await h.health.start()
    h.test.clock.advance(Health.VAULT_WARM_MS - 1)
    expect(vault.ops).toEqual([])
    h.test.clock.advance(1)
    await until(() => h.deps.runtime.vault.status() === "ok")
    expect(vault.ops).toEqual(["hello"])
    await h.health.stop()
  })

  test("a follower, a stopped instance and a remote service do not start it", async () => {
    const vault = recorded()
    await using h = await harness({ vault: vault.transport })
    await using leader = await Runtime.acquire({
      buildId: h.deps.runtime.buildId,
      home: h.deps.runtime.layout.root,
      preferLeader: true,
    })
    expect(leader.isLeader()).toBe(true)
    await h.health.start()
    h.test.clock.advance(Health.VAULT_WARM_MS)
    await h.health.stop()

    const stopped = Health.create(h.deps, () => ({}) as Modules.All)
    await stopped.start()
    await stopped.stop()
    expect(h.test.clock.pending()).toBe(0)
    // SAFETY: a remote service's broker client is only checked for presence here.
    const remote = Health.create({ ...h.deps, remote: {} as NonNullable<Deps["remote"]> }, () => ({}) as Modules.All)
    await remote.start()
    expect(h.test.clock.pending()).toBe(0)
    h.test.clock.advance(Health.VAULT_WARM_MS)
    await Bun.sleep(20)
    expect(vault.ops).toEqual([])
  })
})

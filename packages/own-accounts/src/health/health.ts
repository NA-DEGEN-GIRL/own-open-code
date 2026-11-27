export * as Health from "./health.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Kind } from "@own/protocol"
import type { OwnAccounts, Registry } from "@own/protocol"
import { Runtime } from "@own/runtime"
import { Build } from "../build.js"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Inventory } from "../plugins/inventory.js"
import type { RpcTypes } from "../rpc/types.js"
import { Templates } from "../slots/templates.js"

/**
 * Owner: HEALTH agent. `health` (01 §14.5, 02 §9.2), the per-slot startup self-check after setup and after each
 * provider reload (02 §4.2: activation, no connection, no auth settings, allowed package, secret scan of overlays,
 * default model not an own slot, upstream surface), and `diagnostics.selfTest`. Guard 1 lives in `guard.ts`.
 */
export interface Api extends Module.Lifecycle {
  health: RpcTypes.Handler<"health">
  selfTest: RpcTypes.Handler<"diagnostics.selfTest">
  /** Startup self-check; marks broken slots `misconfigured` (via slots.mutate) and raises alerts. Never throws. */
  check(): Promise<void>
}

/** `opencode-own.db` size that `health` warns about (01 §14.5; v2 event-table growth is unverified). */
export const DB_WARN_BYTES = 1024 ** 3
/** Provider reloads come in bursts (every Location, every registry change); one check after they settle. */
export const CHECK_DEBOUNCE_MS = 2_000
/** Delay before the leader starts the vault helper, after the startup work of the first seconds (PF6). */
export const VAULT_WARM_MS = 3_000

/**
 * Problems that are configuration facts, not a moment of a reload: the slot is marked `misconfigured` and leaves the
 * switch targets (02 §4.2). `provider_missing` is not one of them: right after setup the list can predate the fold.
 */
export const HARD_PROBLEMS: ReadonlySet<string> = new Set([
  "activation_auto",
  "activation_disabled",
  "integration_id_set",
  "integration_connection",
  "auth_in_provider_settings",
  "auth_in_model_settings",
  "package_not_allowed",
])

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("health")
  const state = {
    last: undefined as OwnAccounts.SelfTest | undefined,
    cancel: undefined as (() => void) | undefined,
    warm: undefined as (() => void) | undefined,
    alerted: new Set<string>(),
  }

  const check = async () => {
    const result = await selfTest(deps, peers).catch((error: unknown) => {
      log.error("self_test_failed", { error })
      return undefined
    })
    if (!result) return
    state.last = result
    // Process-wide effects once: registry writes and global alerts come from the leader instance only.
    if (!deps.runtime.isLeader()) return
    await markMisconfigured(peers, result).catch((error: unknown) => log.error("mark_misconfigured_failed", { error }))
    raiseAlerts(peers, result, state.alerted)
  }

  return {
    start: async () => {
      // The vault helper is spawned on first use, which the first `health` and the first credential read would wait
      // for. A local service starts it shortly after startup from the leader; `hello` reads no secret.
      if (deps.remote) return
      state.warm = deps.clock.schedule(VAULT_WARM_MS, () => {
        if (deps.runtime.isLeader()) void deps.runtime.vault.hello().catch(() => undefined)
      })
    },
    stop: async () => {
      state.cancel?.()
      state.cancel = undefined
      state.warm?.()
    },
    onEvent: (event, meta) => {
      if (event.type !== "provider.updated" || !meta.local) return
      state.cancel?.()
      state.cancel = deps.clock.schedule(CHECK_DEBOUNCE_MS, () => {
        state.cancel = undefined
        void check()
      })
    },
    health: async () => {
      const plugins = peers().plugins
      const locations = plugins.locations()
      // A remote service (04 §9.1) has no vault and no own-telemetry (`anthropic` is off there): no such warnings.
      const remote = deps.remote
      const [entries, vaultBackend, sizes, core] = await Promise.all([
        Inventory.read(deps.ctx),
        remote ? Promise.resolve(null) : vaultInfo(deps),
        measure(deps.runtime.layout.ledger),
        // The own global config is re-read: a user may have edited it (02 §4.7.2 (b), 03 §5.8.2 banner).
        peers().slots.refreshCore(),
      ])
      const telemetry = telemetryState(deps.runtime.buildId, entries)
      const order = plugins.claudeOrder()
      const claudeBundle = remote ? undefined : await plugins.bundleSettled()
      const last = state.last
      const warnings = [
        ...(!remote && deps.runtime.vault.status() === "unavailable" ? ["vault_unavailable"] : []),
        ...(sizes.db !== null && sizes.db > DB_WARN_BYTES ? [`db_size:${Math.round(sizes.db / 1024 ** 2)}MB`] : []),
        ...(remote || telemetry === "attached" ? [] : [`telemetry_${telemetry}`]),
        ...locations.flatMap((location) =>
          location.status === "ok" ? [] : [`untrusted_plugin:${location.directory}`],
        ),
        ...(order === "ok" || order === "missing" ? [] : [`claude_auth_order:${order}`]),
        // 02 §8.2: the Claude plugin ships with the app and is always on (this PC; a remote service never loads it).
        ...(remote || order !== "missing" || claudeBundle === undefined ? [] : ["claude_auth_missing"]),
        ...(remote || order === "missing" || plugins.claudeSlot().verified ? [] : ["claude_auth_unverified"]),
        ...(last?.defaultModel.warning ? [last.defaultModel.warning] : []),
        ...(last && !last.secretScan.ok ? ["secret_in_overlay"] : []),
        ...(last?.slots.flatMap((slot) => (slot.ok ? [] : [`slot_misconfigured:${slot.providerID}`])) ?? []),
        ...(last?.surface.changed.map((item) => `surface:${item}`) ?? []),
        // own never sets these: a buffer moves core's threshold off T_slot, auto:false stops overflow recovery too.
        ...(core.buffer === null ? [] : ["compaction_buffer_set"]),
        ...(core.auto === false ? ["compaction_auto_off"] : []),
      ]
      return {
        version: Build.PLUGIN_VERSION,
        buildId: deps.runtime.buildId,
        guard: "ok" as const,
        pluginVersions: {
          accounts: Build.PLUGIN_VERSION,
          telemetry: telemetry === "attached" ? Build.PLUGIN_VERSION : null,
          ...(remote
            ? {}
            : { claudeAuth: plugins.claudeSlot().verified ? (plugins.claudeSlot().version ?? null) : null }),
        },
        vaultBackend,
        ...(remote
          ? {}
          : { vault: deps.runtime.vault.status() === "unavailable" ? ("unavailable" as const) : ("ok" as const) }),
        registryRevision: peers().slots.snapshot().revision,
        controlDir: deps.runtime.layout.control,
        locations: locations.map((location) => ({ directory: location.directory, allowlist: location.status })),
        sizes: { kv: null, ...sizes },
        warnings,
        // 04 §16.5.
        mode: remote ? ("remote" as const) : ("local" as const),
        ...(remote ? remote.health() : {}),
        // 04 §8.11.4.3: the PC's mirrored verdict and this Location's own Claude login.
        ...(remote
          ? { claudeSlot: { state: remote.claude()?.state ?? null, conflict: peers().plugins.claudeConflict() } }
          : {}),
      }
    },
    selfTest: async (_input, context) => {
      const result = await selfTest(deps, peers).catch((error: unknown) => {
        log.error("self_test_failed", { error })
        return undefined
      })
      if (!result) return context.error("internal_error", "self_test_failed", {})
      state.last = result
      return result
    },
    check,
  }
}

type ProviderRecord = Awaited<ReturnType<Deps["ctx"]["provider"]["get"]>>["data"]
type ModelRecord = Awaited<ReturnType<Deps["ctx"]["model"]["list"]>>["data"][number]

/**
 * `diagnostics.selfTest` (02 §4.2, §10.1). Reads providers, models, integrations and the default model once and
 * judges every live own slot. Findings name locations and patterns, never values.
 */
export async function selfTest(deps: Deps, peers: Module.Peers): Promise<OwnAccounts.SelfTest> {
  const registry = peers().slots.snapshot()
  const live = Object.entries(registry.slots).filter(
    (entry): entry is [Kind.ProviderID, Registry.Slot] =>
      isProviderID(entry[0]) && !entry[1].retired && liveAccount(registry, entry[0]),
  )
  const [available, records, models, integrations, defaultModel, anthropic] = await Promise.all([
    deps.ctx.provider.list().then(
      (result) => result.data,
      () => [],
    ),
    Promise.all(live.map((entry) => providerRecord(deps, entry[0]))),
    deps.ctx.model.list().then(
      (result) => result.data,
      () => [],
    ),
    deps.ctx.integration.list().then(
      (result) => result.data,
      () => undefined,
    ),
    deps.ctx.model.default().then(
      (result) => result.data,
      () => null,
    ),
    providerRecord(deps, "anthropic"),
  ])
  const slots = live.map((entry, index) => {
    const providerID = entry[0]
    const problems = slotProblems({
      kind: entry[1].kind,
      provider: records[index],
      models: models.filter((model) => model.providerID === providerID),
      connections: integrations?.find((integration) => integration.id === providerID)?.connections.length ?? 0,
    })
    return { providerID, ok: problems.length === 0, problems, authSwap: peers().auth.authSwap(providerID) }
  })
  const providers = [
    ...available,
    ...records
      .filter((record) => record !== undefined)
      .filter((record) => !available.some((item) => item.id === record.id)),
  ]
  const findings = [
    ...providers.flatMap((provider) =>
      scan({ settings: provider.settings, headers: provider.headers, body: provider.body }, provider.id),
    ),
    ...models.flatMap((model) =>
      scan({ settings: model.settings, headers: model.headers, body: model.body }, `${model.providerID}/${model.id}`),
    ),
  ]
  const defaultOwn = defaultModel !== null && defaultModel !== undefined && ownSlot(registry, defaultModel.providerID)
  const changed = anthropic ? [] : ["anthropic_record_missing"]
  // 07 §5.4: hidden agents whose configured model named an own subscription slot (removed, they run on the session's
  // account), from every live Location: a project config is folded only in its own Location.
  const removed = peers().presets.removedAgentModels()
  return {
    slots,
    secretScan: { ok: findings.length === 0, findings },
    defaultModel: defaultOwn ? { ok: false, warning: "default_model_own_slot" } : { ok: true },
    surface: { ok: changed.length === 0, changed },
    agentModels: { ok: removed.length === 0, removed },
  }
}

/** Per-slot checks of 02 §4.2: `Auth.none` needs activation enabled, no connection and no auth settings. */
export function slotProblems(input: {
  readonly kind: Kind.Own
  readonly provider: ProviderRecord | undefined
  readonly models: ReadonlyArray<ModelRecord>
  readonly connections: number
}) {
  const provider = input.provider
  if (!provider) return ["provider_missing"]
  const allowed = Kind.meta[input.kind].package
  return [
    ...(provider.activation === "enabled" ? [] : [`activation_${provider.activation}`]),
    ...(provider.integrationID ? ["integration_id_set"] : []),
    ...(input.connections > 0 ? ["integration_connection"] : []),
    ...(hasAuth(provider.settings, provider.headers) ? ["auth_in_provider_settings"] : []),
    ...(input.models.some((model) => hasAuth(model.settings, model.headers)) ? ["auth_in_model_settings"] : []),
    ...(provider.package === allowed && input.models.every((model) => !model.package || model.package === allowed)
      ? []
      : ["package_not_allowed"]),
  ]
}

/** Secret-looking strings in an overlay (02 §4.2, 01 §13 log patterns). One finding per string, never the value. */
export function scan(value: unknown, at: string): string[] {
  if (typeof value === "string") {
    const hit = SECRET_PATTERNS.find((pattern) => pattern.test.test(value))
    return hit ? [`${at}: ${hit.name}`] : []
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => scan(item, `${at}[${index}]`))
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap((entry) => scan(entry[1], `${at}.${entry[0]}`))
  return []
}

const SECRET_PATTERNS = [
  { name: "anthropic_key", test: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "openrouter_key", test: /sk-or-v1-[A-Za-z0-9]{16,}/ },
  { name: "openai_key", test: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/ },
  { name: "xai_key", test: /xai-[A-Za-z0-9]{20,}/ },
  { name: "jwt", test: /eyJ[\w-]+\.[\w-]+\.[\w-]+/ },
  { name: "bearer", test: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
]

const isProviderID = Schema.is(Kind.ProviderID)
const AUTH_SETTINGS = ["apiKey", "authToken", "accessToken", "token"]
const AUTH_HEADERS = ["authorization", "x-api-key", "api-key"]

function hasAuth(
  settings: Readonly<Record<string, unknown>> | undefined,
  headers: Readonly<Record<string, string>> | undefined,
) {
  const nested = settings?.headers
  const headerNames = [
    ...Object.keys(headers ?? {}),
    ...(typeof nested === "object" && nested !== null ? Object.keys(nested) : []),
  ].map((name) => name.toLowerCase())
  return (
    AUTH_SETTINGS.some((key) => settings?.[key] !== undefined) ||
    headerNames.some((name) => AUTH_HEADERS.includes(name))
  )
}

function providerRecord(deps: Deps, providerID: string) {
  return deps.ctx.provider.get({ providerID }).then(
    (result): ProviderRecord | undefined => result.data,
    () => undefined,
  )
}

/** Slots of accounts the user turned off or removed are not judged. */
function liveAccount(registry: Registry.File, providerID: string) {
  return registry.accounts.some(
    (account) => account.providerID === providerID && account.status !== "retired" && account.status !== "disabled",
  )
}

function ownSlot(registry: Registry.File, providerID: string) {
  return providerID in registry.slots || /^own-[a-z]+-/.test(providerID)
}

async function markMisconfigured(peers: Module.Peers, result: OwnAccounts.SelfTest) {
  const broken = new Set(
    result.slots
      .filter((slot) => slot.problems.some((problem) => HARD_PROBLEMS.has(problem)))
      .map((slot) => slot.providerID),
  )
  if (broken.size === 0) return
  await peers().slots.mutate((registry) => {
    const hit = (account: Registry.File["accounts"][number]) =>
      broken.has(account.providerID) && account.status !== "retired" && account.status !== "disabled"
    if (!registry.accounts.some((account) => hit(account) && account.status !== "misconfigured")) return undefined
    return {
      ...registry,
      accounts: registry.accounts.map((account) =>
        hit(account) ? { ...account, status: "misconfigured" as const } : account,
      ),
    }
  })
}

/** Alerts for findings not reported before in this process (the check runs after every provider reload). */
function raiseAlerts(peers: Module.Peers, result: OwnAccounts.SelfTest, alerted: Set<string>) {
  const fresh = (key: string) => {
    if (alerted.has(key)) return false
    alerted.add(key)
    return true
  }
  const telemetry = peers().telemetry
  if (!result.secretScan.ok && fresh(`secret:${result.secretScan.findings.join("|")}`))
    telemetry.alert({
      code: "secret_in_overlay",
      severity: "error",
      message: `프로바이더 설정에 비밀처럼 보이는 값이 있습니다: ${result.secretScan.findings.slice(0, 3).join(", ")}`,
    })
  if (result.defaultModel.warning && fresh("default_model_own_slot"))
    telemetry.alert({
      code: "default_model_own_slot",
      severity: "warning",
      message: "기본 모델이 own 계정 모델입니다. 세션 밖 생성 요청(ctx.generate.text)은 인증 없이 실패합니다.",
    })
  // 07 §6.2 #4, §8.1 `codex_window_unverified{modelID}`: one alert per model, so a model that appears later (a
  // refreshed catalog) gets its own. These register with the catalog window, never a shorter guess; core's overflow
  // recovery covers a miss.
  for (const modelID of Templates.unverifiedCodex(peers().slots.snapshot()))
    if (fresh(`codex_window_unverified:${modelID}`))
      telemetry.alert({
        code: "codex_window_unverified",
        severity: "info",
        subject: modelID,
        message: `Codex 구독 창을 확인하지 못해 ${modelID}을(를) 카탈로그 창으로 등록했습니다.`,
      })
}

type TelemetryState = "attached" | "missing" | "build_mismatch"

/**
 * own-telemetry must share this runtime (same build id and home, 01 §4): an attached own-telemetry holds runtime
 * references under its own role. own-remote and own-team hold references too (06 §10.4 #3), so only that role counts.
 * An active own-telemetry without one runs on another build's singleton, so Claude slot data never reaches
 * own-accounts.
 */
function telemetryState(buildId: string, entries: ReadonlyArray<Inventory.Entry> | undefined): TelemetryState {
  const active = entries?.some((entry) => entry.id === Inventory.TELEMETRY_ID && Inventory.active(entry)) ?? false
  if (!active) return "missing"
  return (Runtime.peek(buildId)?.roles[Inventory.TELEMETRY_ID] ?? 0) > 0 ? "attached" : "build_mismatch"
}

async function vaultInfo(deps: Deps) {
  const hello = await deps.runtime.vault.hello().catch(() => undefined)
  return hello?.ok ? { name: hello.name, version: hello.version } : null
}

/** Ledger directory size and, when the server was given an absolute `OPENCODE_DB`, the database size. */
async function measure(ledger: string) {
  const names = await fs.readdir(ledger).catch(() => [])
  const sizes = await Promise.all(
    names.map((name) =>
      fs.stat(path.join(ledger, name)).then(
        (info) => (info.isFile() ? info.size : 0),
        () => 0,
      ),
    ),
  )
  const db = process.env.OPENCODE_DB
  const dbSize =
    db && path.isAbsolute(db)
      ? await fs.stat(db).then(
          (info) => info.size,
          () => null,
        )
      : null
  return { ledger: sizes.reduce((sum, size) => sum + size, 0), db: dbSize }
}

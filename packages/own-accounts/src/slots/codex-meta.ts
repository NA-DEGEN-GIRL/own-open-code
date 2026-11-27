export * as CodexMeta from "./codex-meta.js"

import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { CodexModels, type Account, type Preset, type Registry } from "@own/protocol"
import { Hash, Store, type Home } from "@own/runtime"
import { Build } from "../build.js"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Variant } from "../switching/variant.js"

/**
 * Owner: SLOTS. Codex model metadata, the second layer of model facts (07 §4.5), for the `codex` kind only: a `siwc`
 * slot never reads it (07 §2.2), nor does any other kind.
 * - Backend: the control Location fetches the Codex model list ({@link BACKEND}) with a ready `codex` slot's token
 *   through the own auth path (`logins.headers`), on start and whenever the codex template is captured again
 *   (`accounts.update{refreshCatalog}`, a first ChatGPT login), sending the stored etag. A 200 with a usable list
 *   replaces the snapshot in `OWN_HOME\codex-meta.json` (`store.changed{codex-meta}`); a 304 keeps it; an error, a
 *   timeout or a body without a usable list keeps the last one (logged `codex_meta_fetch_failed`).
 * - 02 §4.8: every other ready `codex` account is asked too, with its own token and etag, because the speed tiers
 *   (`service_tiers`) depend on the account's plan: each account's list is kept in `codex-meta.json` `accounts`
 *   ({@link accountModel}); the shared model facts stay the first account's. A list read again lifts that account's
 *   refused tiers (`runtime.speed.clear`).
 * - Until a fetch has succeeded once, the Codex CLI's `models_cache.json` on this PC is the snapshot (read only);
 *   without either, every consumer uses its no-metadata rule. A remote service reads neither file of this PC.
 * - The Codex CLI's `config.toml` (`model`, `model_reasoning_effort`) is read only for the ChatGPT group's default ①.
 * Nothing else in the Codex home is read, never `auth.json`; no token, account id or e-mail is logged.
 * The snapshot is loaded outside the provider fold and kept in memory ({@link current}, what `Templates` reads while
 * folding: the window from `max_context_window`, 07 §6.2 #4); a changed snapshot reloads this Location's providers.
 * `effort_update_drift` is raised once per model whose metadata disagrees with own's upstream mirror
 * (`Variant.supportsEffortUpdates`, 07 §3.5), which keeps deciding the cost dialog.
 * - CA (2026-10-19, "최신 버전 자동 확인"): the lists are asked as the newest Codex release when the setting
 *   `Codex 최신 모델 자동 확인` is on (the default): the control Location reads it from the npm registry ({@link LATEST})
 *   at most once a day and only while a ready `codex` account exists, keeps it in `codex-meta.json` `latest`, and asks
 *   as the newer of it and this build's {@link BACKEND} version ({@link clientVersion}). A changed version asks every
 *   list again in full ({@link reusable}). Rows newer than own knows are left out and counted (`CodexModels.decode`),
 *   shown by `codexModels.get` and `codexModels.changed`.
 */
export interface Api extends Module.Lifecycle {
  /** Fetches the Codex model list now (07 §4.5); joins a fetch already running. Never throws. */
  refresh(): Promise<Refreshed>
  /** `codexModels.get` (CA): the setting, the version asked now, the registry's newest release, the left-out rows. */
  view(): CodexModels.View
  /**
   * `codexModels.rows` (10 §6.14): the served rows own.harness takes at runtime, from the shared list this Location
   * holds, and their revision; the rows are left out when `have` is that revision.
   */
  rows(have?: string): CodexModels.Rows
  /**
   * `codexModels.set` (CA): stores the setting; a changed version asks every list again, turning it on reads the
   * registry when due. Throws when `codex-meta.json` cannot be written (nothing changed then).
   */
  setAutoVersion(on: boolean): Promise<CodexModels.View>
}

/** How a {@link Api.refresh} ended. `no-slot`: no ready `codex` slot has a token; `skipped`: a remote service. */
export type Refreshed = "updated" | "not-modified" | "failed" | "no-slot" | "skipped"

/**
 * The Codex backend's model list as the Codex CLI asks for it (07 §4.5, ⚠PG7 (나)): every assumption about the
 * endpoint in this one block, verified live (T2.20) before the stand-in window list goes (T2.21).
 */
export const BACKEND = {
  /** Appended to the `codex` endpoint (`https://chatgpt.com/backend-api/codex`, test fakes override it). */
  path: "/models",
  /**
   * This build's `client_version`: the backend lists the models the asking Codex client may use (`minimal_client_version`
   * per row), so own asks as the newest Codex release does: the release the `codex` harness is pinned to
   * (`own/ledger/codex-pin.json`, `rust-v0.171.0` since 2026-11-23, `rust-v0.167.0` from 2026-11-12, `rust-v0.166.0` from 2026-11-01,
   * `rust-v0.165.0` from 2026-10-30, `rust-v0.164.0-alpha.3` before), sent as Codex sends it:
   * `client_version_to_whole()` (codex-rs `models-manager/src/lib.rs`) drops any pre-release part. Live 2026-10-18:
   * against 0.157.0 the lists of accounts 01 and 03 add `gpt-6.1-sol` (priority 1) and change nothing else. Since CA
   * (2026-10-19) it is the floor:
   * with `Codex 최신 모델 자동 확인` on, a newer release read from the registry is asked instead ({@link clientVersion});
   * off, only this. A stored snapshot of another version is fetched again in full ({@link reusable}).
   */
  clientVersion: "0.171.0",
  /** The `session-id` of the auth headers; it names no session. */
  sessionID: "own-accounts:codex-meta",
  /** A fetch without an answer by then keeps the last snapshot. */
  timeoutMs: 20_000,
} as const

/**
 * Where own learns the newest Codex release (07 §4.5, CA 2026-10-19): the npm registry's `latest` tag of
 * `@openai/codex`, the package the Codex CLI ships in. Every assumption about it is in this block. Only `version` is
 * read; only `accept` and a fixed `user-agent` are sent (no credential, cookie, account or path), through the
 * service's proxy settings like the other requests (Bun's `fetch` follows `HTTPS_PROXY`/`NO_PROXY`). Live 2026-10-19:
 * 200, about 3.5 KB, `version` 0.163.0.
 */
export const LATEST = {
  /** Appended to the registry root (`https://registry.npmjs.org`, test fakes override it). */
  path: "/@openai/codex/latest",
  /** At most one read a day; a service start reads when the stored one is older. */
  everyMs: 24 * 60 * 60_000,
  /** A read without an answer by then keeps the last version. */
  timeoutMs: 10_000,
  userAgent: `own-open-code/${Build.PLUGIN_VERSION}`,
} as const

/** The soonest the daily check looks again, so a check that cannot run yet never spins. */
const WAKE_MS = 60 * 60_000

/**
 * Started instances' snapshots, newest last: one per Location in production (each Location imports its own copy of
 * this module), several in a test process. Stopping removes the instance. `accounts`: each codex account's own list
 * (02 §4.8, the speed tiers its plan may send).
 */
const live: Array<{
  readonly layout: Home.Layout
  snapshot: CodexModels.Snapshot | undefined
  accounts: Readonly<Record<string, CodexModels.Snapshot>>
}> = []

/**
 * The Codex metadata snapshot of the newest started instance, in memory. The provider fold reads it synchronously
 * (`Templates.limit`), so it is loaded outside the fold: at start, on `store.changed{codex-meta}` and after a fetch.
 */
export function current(): CodexModels.Snapshot | undefined {
  return live.at(-1)?.snapshot
}

/**
 * The snapshot of this runtime now: the started instance's, in memory; before one started (a unit test), read from
 * the files on each call ({@link load}).
 */
export async function snapshot(deps: Deps): Promise<CodexModels.Snapshot | undefined> {
  const started = live.findLast((holder) => holder.layout === deps.runtime.layout)
  return started ? started.snapshot : load(deps)
}

/** One model's row of the snapshot ({@link snapshot}); `undefined` without metadata or without that model. */
export async function model(deps: Deps, slug: string): Promise<CodexModels.Model | undefined> {
  return CodexModels.find(await snapshot(deps), slug)
}

/**
 * One model's row of a codex account's own list (02 §4.8): what that account's plan offers (the speed tiers).
 * `undefined` until that account's list was fetched, or when it lacks the model.
 */
export async function accountModel(deps: Deps, accountID: string, slug: string) {
  return CodexModels.find(await accountList(deps, accountID), slug)
}

/** A codex account's own list (02 §4.8): what its plan offers. `undefined` until that account's list was fetched. */
export async function accountList(deps: Deps, accountID: string): Promise<CodexModels.Snapshot | undefined> {
  const started = live.findLast((holder) => holder.layout === deps.runtime.layout)
  const accounts = started ? started.accounts : await loadAccounts(deps)
  return accounts[accountID]
}

/** Every codex account's stored list (`codex-meta.json` `accounts`); empty when unreadable or before a fetch. */
export async function loadAccounts(deps: Deps): Promise<Readonly<Record<string, CodexModels.Snapshot>>> {
  return file(deps.runtime.layout)
    .read()
    .then(
      (value) => value.accounts ?? {},
      () => ({}),
    )
}

/**
 * What the ChatGPT group's `auto` default reads (07 §2.2 ①②): this PC's Codex config, read now, and the snapshot's
 * priorities and default levels.
 */
export async function hints(deps: Deps): Promise<Preset.CodexHints> {
  const [config, rows] = await Promise.all([readConfig(home(deps.options.codexHome)), snapshot(deps)])
  return { ...config, models: CodexModels.hints(rows?.models ?? []) }
}

/**
 * The stored snapshot (`codex-meta.json`, the last fetch), else on this PC the Codex CLI's `models_cache.json`. An
 * unusable store file reads as none and is never overwritten.
 */
export async function load(deps: Deps): Promise<CodexModels.Snapshot | undefined> {
  const stored = await file(deps.runtime.layout)
    .read()
    .then(
      (value) => value.kinds.codex,
      (error: unknown) => {
        deps.log.child("codex-meta").warn("codex_meta_unreadable", { error })
        return undefined
      },
    )
  if (stored || deps.remote) return stored
  return readCache(home(deps.options.codexHome))
}

const files = new WeakMap<Home.Layout, ReturnType<typeof Store.codexMeta>>()

/**
 * `OWN_HOME\codex-meta.json` of a runtime: one handle per runtime layout (shared by every holder of the singleton), so
 * the store watcher and this module see the same last read value.
 */
export function file(layout: Home.Layout) {
  const known = files.get(layout)
  if (known) return known
  const created = Store.codexMeta(layout)
  files.set(layout, created)
  return created
}

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("codex-meta")
  const holder = {
    layout: deps.runtime.layout,
    snapshot: undefined as CodexModels.Snapshot | undefined,
    accounts: {} as Readonly<Record<string, CodexModels.Snapshot>>,
  }
  const state = {
    started: false,
    stops: [] as Array<() => void>,
    abort: new AbortController(),
    running: undefined as Promise<Refreshed> | undefined,
    /** The codex template id last seen; a new one is a captured catalog (`refreshCatalog`, a first login). */
    template: undefined as string | undefined,
    /** Models whose `effort_update_drift` was raised by this instance. */
    drifted: new Set<string>(),
    /** `codex-meta.json` `latest` and `autoVersion` as last read or written (CA). */
    version: {} as Versioning,
    /** When this instance last asked the registry, answered or not: at most once a day ({@link LATEST}). */
    checkedAt: undefined as number | undefined,
    checking: undefined as Promise<boolean> | undefined,
    /** Cancels the daily check's timer. */
    wake: undefined as (() => void) | undefined,
    /** The view `codexModels.changed` last carried, hashed. */
    shown: undefined as string | undefined,
  }

  /**
   * The registry root the version check reads, or `undefined` when this instance never reads it: a remote service, and
   * a service given test endpoints (any override) without a registry override of its own (`Options.EndpointOverrides`).
   */
  const registry = deps.remote
    ? undefined
    : (deps.endpoints.overrides.npmRegistry ??
      (Object.keys(deps.endpoints.overrides).length === 0 ? deps.endpoints.url.npmRegistry : undefined))

  /** Takes a snapshot as current; answers whether its models changed (a new fetch time or etag alone is no change). */
  const adopt = (next: CodexModels.Snapshot | undefined) => {
    // The served rows' registered facts count too (10 §6.14): a model no catalog lists registers from its row.
    const registered = (snapshot: CodexModels.Snapshot | undefined) => ({
      models: snapshot?.models ?? null,
      served: (snapshot?.harness ?? []).map((row) => [row.slug, row.visibility, row.display_name, row.max_context_window, row.supported_reasoning_levels]),
    })
    const changed = Hash.stable(registered(next)) !== Hash.stable(registered(holder.snapshot))
    holder.snapshot = next
    if (changed) drift(next)
    return changed
  }

  /** `effort_update_drift{modelID}` once per model (07 §4.5), raised by the leader so every Location does not. */
  const drift = (next: CodexModels.Snapshot | undefined) => {
    if (!next || !deps.runtime.isLeader()) return
    next.models
      .filter((row) => {
        const said = row.supports_reasoning_effort_updates
        return typeof said === "boolean" && said !== Variant.supportsEffortUpdates("codex", row.slug)
      })
      .filter((row) => !state.drifted.has(row.slug))
      .forEach((row) => {
        state.drifted.add(row.slug)
        const said = row.supports_reasoning_effort_updates === true
        log.info("effort_update_drift", { modelID: row.slug, metadata: said })
        peers().telemetry.alert({
          code: "effort_update_drift",
          severity: "info",
          subject: row.slug,
          message: `Codex 메타데이터는 ${row.slug}의 추론 강도를 바꿔도 캐시가 ${said ? "유지된다" : "유지되지 않는다"}고 하지만, 비용 창은 upstream 규칙을 따릅니다(원장 후보).`,
        })
      })
  }

  /** The `codex` accounts whose list may be asked for now. */
  const ready = () =>
    peers()
      .slots.snapshot()
      .accounts.filter(
        (account) => account.kind === "codex" && (account.status === "ready" || account.status === "unverified"),
      )

  /** The first ready `codex` slot that has a token now, with its headers; `undefined` when none has. */
  const credentials = async (
    accounts: ReadonlyArray<Account.Info>,
  ): Promise<{ readonly account: Account.Info; readonly headers: Readonly<Record<string, string>> } | undefined> => {
    const [account, ...rest] = accounts
    if (!account) return undefined
    const auth = await peers().logins.headers(account, BACKEND.sessionID)
    return auth.ok ? { account, headers: auth.headers } : credentials(rest)
  }

  /** `codexModels.get` (CA): from memory, so it answers at once. */
  const view = (): CodexModels.View => {
    const shared = holder.snapshot?.source === "backend" ? holder.snapshot : undefined
    return {
      autoVersion: state.version.autoVersion !== false,
      version: clientVersion(state.version),
      build: BACKEND.clientVersion,
      ...(state.version.latest ? { latest: state.version.latest } : {}),
      ...(shared ? { fetchedAt: shared.fetchedAt } : {}),
      rejected: shared?.rejected ?? 0,
      accounts: Object.fromEntries(Object.entries(holder.accounts).map(([id, list]) => [id, list.rejected ?? 0])),
      left: shared?.left ?? [],
      accountLeft: Object.fromEntries(Object.entries(holder.accounts).map(([id, list]) => [id, list.left ?? []])),
      borrowed: CodexModels.borrowed(shared?.harness ?? []),
    }
  }

  /** `codexModels.rows`: from memory; the revision is the rows' stable hash, kept per snapshot. */
  const rows = (have?: string): CodexModels.Rows => {
    const served = holder.snapshot?.source === "backend" ? (holder.snapshot.harness ?? []) : []
    const revision = revisionOf(served)
    return have === revision ? { revision } : { revision, rows: served }
  }

  /** `codexModels.changed` when the view differs from the last one sent; only the control Location sends it. */
  const announce = () => {
    if (!deps.location.control) return
    const next = view()
    const key = Hash.stable(next)
    if (key === state.shown) return
    state.shown = key
    void deps.emitter.global("codexModels.changed", { view: next })
  }

  /** Whether the registry is read now: the setting on, no read by this instance within a day, the stored one older. */
  const due = () => {
    if (registry === undefined || state.version.autoVersion === false) return false
    const now = deps.clock.now()
    if (state.checkedAt !== undefined && now - state.checkedAt < LATEST.everyMs) return false
    const read = state.version.latest?.fetchedAt
    return read === undefined || now - read >= LATEST.everyMs
  }

  /**
   * Reads the newest Codex release when due ({@link LATEST}) and keeps it in `codex-meta.json` `latest`; a failed read
   * keeps the last one. Answers whether the version the lists are asked as changed. Joins a read running. Never throws.
   */
  const check = () => {
    state.checking ??= readLatest()
      .catch((error: unknown) => {
        log.error("codex_version_check_failed", { reason: "internal", error })
        return false
      })
      .finally(() => {
        state.checking = undefined
      })
    return state.checking
  }

  const readLatest = async () => {
    if (registry === undefined || !due()) return false
    state.checkedAt = deps.clock.now()
    const before = clientVersion(state.version)
    const read = await fetchLatest({ registry, signal: state.abort.signal })
    if (read.type === "failed") {
      log.warn("codex_version_check_failed", { reason: read.reason, status: read.status })
      return false
    }
    const latest = { version: read.version, fetchedAt: deps.clock.now() }
    state.version = { ...state.version, latest }
    // Only this instance asks as it, so the other Locations are not told (their snapshots did not change).
    await file(deps.runtime.layout)
      .update((stored) => ({ ...stored, latest }))
      .catch((error: unknown) => log.error("codex_meta_write_failed", { error }))
    const after = clientVersion(state.version)
    log.info("codex_version_checked", { latest: read.version, clientVersion: after })
    announce()
    return after !== before
  }

  /**
   * 02 §4.8: every other ready codex account's own list, with its own etag. Speed tiers depend on the plan, so each
   * account is asked; the shared model facts stay the first account's (`kinds.codex`). A list read again (`updated`
   * or `not-modified`) lifts that account's refused tiers (`runtime.speed`). Never throws; failures are logged.
   */
  const fetchAccounts = async (
    accounts: ReadonlyArray<Account.Info>,
    known: Readonly<Record<string, CodexModels.Snapshot>>,
    version: string,
  ): Promise<Record<string, CodexModels.Snapshot>> => {
    const fetched = await Promise.all(
      accounts.map(async (account) => {
        const auth = await peers().logins.headers(account, BACKEND.sessionID)
        if (!auth.ok) return []
        const etag = reusable(known[account.id], version)
        const result = await fetchList({
          baseURL: deps.endpoints.url.codex,
          headers: auth.headers,
          clientVersion: version,
          ...(etag === undefined ? {} : { etag }),
          now: deps.clock.now(),
          signal: state.abort.signal,
        })
        if (result.type === "failed") {
          log.warn("codex_meta_account_fetch_failed", { accountID: account.id, reason: result.reason })
          return []
        }
        deps.runtime.speed.clear(account.id)
        return result.type === "updated" ? [[account.id, withoutHarness(result.snapshot)] as const] : []
      }),
    )
    return Object.fromEntries(fetched.flat())
  }

  const fetchOnce = async (): Promise<Refreshed> => {
    if (deps.remote) return "skipped"
    const candidates = ready()
    const first = await credentials(candidates)
    if (!first) {
      log.info("codex_meta_no_slot", { accounts: candidates.length })
      return "no-slot"
    }
    if (!state.started) state.version = (await storedVersion(deps.runtime.layout)) ?? state.version
    // CA: the newest Codex release first (when due), so a new one is asked as at once.
    await check()
    const version = clientVersion(state.version)
    const last = state.started ? holder.snapshot : await load(deps)
    const known = state.started ? holder.accounts : await loadAccounts(deps)
    const etag = last?.source === "backend" ? reusable(last, version) : undefined
    const [result, others] = await Promise.all([
      fetchList({
        baseURL: deps.endpoints.url.codex,
        headers: first.headers,
        clientVersion: version,
        ...(etag === undefined ? {} : { etag }),
        now: deps.clock.now(),
        signal: state.abort.signal,
      }),
      fetchAccounts(
        candidates.filter((account) => account.id !== first.account.id),
        known,
        version,
      ),
    ])
    // Stopped meanwhile: nothing to report.
    if (state.abort.signal.aborted) return "failed"
    // The first account's own list is the kind snapshot it answered (02 §4.8).
    if (result.type !== "failed") deps.runtime.speed.clear(first.account.id)
    const kind = result.type === "updated" ? result.snapshot : undefined
    const accounts = { ...others, ...(kind ? { [first.account.id]: withoutHarness(kind) } : {}) }
    if (result.type === "not-modified") log.info("codex_meta_not_modified", {})
    // Logged only: `codex_meta_unavailable` waits for the endpoint's live check (⚠PG7 (나)), so an unverified endpoint
    // does not alert on every start.
    if (result.type === "failed") log.warn("codex_meta_fetch_failed", { reason: result.reason, status: result.status })
    if (result.type === "updated")
      log.info("codex_meta_fetched", {
        models: result.snapshot.models.length,
        rejected: result.rejected,
        // Served rows own.harness runs from (10 §6.14), and the left-out ones by field (never a value or a prompt).
        harness: result.snapshot.harness?.length ?? 0,
        left: (result.snapshot.left ?? []).map((left) => `${left.slug}:${left.field}`),
        clientVersion: version,
      })
    // Every account's tiers register nothing, so a change of them alone reloads no provider.
    holder.accounts = { ...holder.accounts, ...accounts }
    const written =
      (kind !== undefined || Object.keys(accounts).length > 0) &&
      (await file(deps.runtime.layout)
        .update((stored) => ({
          ...stored,
          ...(kind ? { kinds: { ...stored.kinds, codex: kind } } : {}),
          ...(Object.keys(accounts).length > 0 ? { accounts: { ...stored.accounts, ...accounts } } : {}),
        }))
        .then(
          () => true,
          (error: unknown) => {
            log.error("codex_meta_write_failed", { error })
            return false
          },
        ))
    // In memory even when the file could not be written; the other Locations read the file.
    const changed = kind !== undefined && adopt(kind)
    if (written) deps.runtime.broadcast.emit("store.changed", { store: "codex-meta", origin: "local" })
    announce()
    if (!kind) return result.type === "not-modified" ? "not-modified" : "failed"
    if (changed && state.started) await peers().slots.reload()
    return "updated"
  }

  const refresh = () => {
    state.running ??= fetchOnce()
      .catch((error: unknown) => {
        log.error("codex_meta_refresh_failed", { error })
        return "failed" as const
      })
      .finally(() => {
        state.running = undefined
      })
    return state.running
  }

  /** Every list again once the fetch running now is done: it may have asked as the version before (CA). */
  const again = () => (state.running ?? Promise.resolve()).then(refresh)

  /** The daily check (CA): the registry when due and a codex account exists, then every list if the version moved. */
  const tick = async () => {
    if (!due() || ready().length === 0) return
    if (await check()) await again()
  }

  /** Wakes the daily check when the next read falls due, an hour at the soonest. */
  const plan = () => {
    state.wake?.()
    const last = Math.max(state.checkedAt ?? 0, state.version.latest?.fetchedAt ?? 0)
    state.wake = deps.clock.schedule(Math.max(WAKE_MS, last + LATEST.everyMs - deps.clock.now()), () => {
      void tick()
        .catch((error: unknown) => log.error("codex_version_check_failed", { reason: "internal", error }))
        .finally(() => {
          if (state.started) plan()
        })
    })
  }

  /** Another instance (or process) wrote the store: take its snapshot, reloading providers when it changed. */
  const reread = async () => {
    holder.accounts = await loadAccounts(deps)
    state.version = (await storedVersion(deps.runtime.layout)) ?? state.version
    if (adopt(await load(deps))) await peers().slots.reload()
  }

  /** A codex template captured again (`refreshCatalog`, a first login): the control Location fetches the list. */
  const captured = async () => {
    const template = codexTemplate(deps.runtime.registry.cached() ?? peers().slots.snapshot())
    if (template === state.template) return
    state.template = template
    if (template !== undefined && deps.location.control) await refresh()
  }

  return {
    refresh,
    view,
    rows,

    setAutoVersion: async (on) => {
      const before = clientVersion(state.version)
      await file(deps.runtime.layout).update((stored) => ({ ...stored, autoVersion: on }))
      state.version = { ...state.version, autoVersion: on }
      log.info("codex_auto_version_set", { on })
      announce()
      // Another version: every list again, as a Codex of that version sees it. Turned on: the registry when due.
      const moved = clientVersion(state.version) !== before
      if (moved) void again()
      if (!moved && on) void tick()
      return view()
    },

    start: async () => {
      state.abort = new AbortController()
      adopt(await load(deps))
      holder.accounts = await loadAccounts(deps)
      state.version = (await storedVersion(deps.runtime.layout)) ?? {}
      live.push(holder)
      state.started = true
      state.shown = Hash.stable(view())
      state.template = codexTemplate(peers().slots.snapshot())
      state.stops.push(
        deps.runtime.broadcast.on("store.changed", (payload) => {
          const run = payload.store === "codex-meta" ? reread : payload.store === "accounts" ? captured : undefined
          void run?.().catch((error: unknown) => log.error("codex_meta_reload_failed", { error }))
        }),
      )
      // One fetch per PC: the Location that answers the global RPCs (as the local-window probe, 07 §6.2 #8). On the
      // next turn of the event loop, once the modules after this one (logins) have started too. That fetch reads the
      // registry first when the stored release is older than a day; the timer keeps the check daily (CA).
      if (!deps.location.control || deps.remote) return
      const initial = setTimeout(() => void refresh(), 0)
      state.stops.push(() => clearTimeout(initial))
      if (registry === undefined) return
      plan()
      state.stops.push(() => state.wake?.())
    },

    stop: async () => {
      for (const stop of state.stops.splice(0)) stop()
      state.abort.abort()
      state.started = false
      const index = live.indexOf(holder)
      if (index >= 0) live.splice(index, 1)
      await Promise.all([state.running, state.checking])
    },
  }
}

/** How a fetch of the model list ended (`failed`: the last snapshot stays). */
export type Fetched =
  | { readonly type: "updated"; readonly snapshot: CodexModels.Snapshot; readonly rejected: number }
  | { readonly type: "not-modified" }
  | {
      readonly type: "failed"
      /** `status`: an HTTP error; `malformed`: a 200 without a usable model list. */
      readonly reason: "status" | "timeout" | "network" | "malformed"
      readonly status?: number
    }

export interface FetchInput {
  /** The `codex` endpoint (`…/backend-api/codex`). */
  readonly baseURL: string
  /** The slot's auth headers (`logins.headers`); never logged. */
  readonly headers: Readonly<Record<string, string>>
  /** The `client_version` asked ({@link clientVersion}), kept with the snapshot. */
  readonly clientVersion: string
  /** The stored snapshot's etag, sent as `If-None-Match`. */
  readonly etag?: string
  /** When the list was fetched (the snapshot's `fetchedAt`). */
  readonly now: number
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/**
 * One fetch of the Codex model list (07 §4.5, {@link BACKEND}). A 200 whose body has a model list with at least one
 * usable row is a `backend` snapshot (rows that are malformed or newer than own knows left out and counted,
 * `CodexModels.decode`); a 304 is `not-modified`; anything else, including an empty list, is `failed`. Never throws.
 */
export async function fetchList(input: FetchInput): Promise<Fetched> {
  const url = new URL(`${input.baseURL.replace(/\/+$/, "")}${BACKEND.path}`)
  url.searchParams.set("client_version", input.clientVersion)
  const timeout = AbortSignal.timeout(input.timeoutMs ?? BACKEND.timeoutMs)
  const response = await fetch(url, {
    headers: {
      ...input.headers,
      accept: "application/json",
      ...(input.etag === undefined ? {} : { "if-none-match": input.etag }),
    },
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  }).catch(() => undefined)
  if (!response) return { type: "failed", reason: timeout.aborted ? "timeout" : "network" }
  if (response.status === 304) return { type: "not-modified" }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { type: "failed", reason: "status", status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (timeout.aborted) return { type: "failed", reason: "timeout" }
  const rows = CodexModels.decode(body)
  if (!rows || rows.models.length === 0) return { type: "failed", reason: "malformed", status: response.status }
  const etag = response.headers.get("etag")
  return {
    type: "updated",
    rejected: rows.rejected,
    snapshot: {
      source: "backend",
      fetchedAt: input.now,
      ...(etag ? { etag } : {}),
      clientVersion: input.clientVersion,
      rows: CodexModels.ROWS,
      rejected: rows.rejected,
      ...(rows.left.length === 0 ? {} : { left: rows.left }),
      ...(rows.harness.length === 0 ? {} : { harness: rows.harness }),
      models: rows.models,
    },
  }
}

/** An account's own list without the served harness rows: the shared list carries them once (02 §4.8). */
function withoutHarness(snapshot: CodexModels.Snapshot): CodexModels.Snapshot {
  const { harness: _harness, ...rest } = snapshot
  return rest
}

/** The revision of a set of served rows (`codexModels.rows`), hashed once per array. */
const revisions = new WeakMap<ReadonlyArray<CodexModels.HarnessRow>, string>()
function revisionOf(rows: ReadonlyArray<CodexModels.HarnessRow>) {
  const known = revisions.get(rows)
  if (known !== undefined) return known
  const revision = rows.length === 0 ? "none" : Hash.stable(rows)
  revisions.set(rows, revision)
  return revision
}

/**
 * The etag a stored list may send back (`If-None-Match`): only for the version asked now and a list judged as this
 * build judges rows (`CodexModels.ROWS`). An older snapshot lost fields when it was decoded (T4: Codex's
 * `description`) or kept rows this build leaves out (CA), so it is fetched in full once and stored with the marker; a
 * backend that sends no description is not asked again. A new version (CA: a newer Codex release, or the setting
 * turned off) is fetched in full too.
 */
function reusable(snapshot: CodexModels.Snapshot | undefined, version: string) {
  return snapshot?.clientVersion === version && snapshot.rows === CodexModels.ROWS ? snapshot.etag : undefined
}

/** `codex-meta.json`'s Codex version fields (CA): the newest release read and the setting. */
type Versioning = Pick<CodexModels.File, "latest" | "autoVersion">

/** {@link Versioning} as stored; `undefined` when the file cannot be read (the caller keeps what it has). */
function storedVersion(layout: Home.Layout): Promise<Versioning | undefined> {
  return file(layout)
    .read()
    .then(
      (value) => ({
        ...(value.latest ? { latest: value.latest } : {}),
        ...(value.autoVersion === undefined ? {} : { autoVersion: value.autoVersion }),
      }),
      () => undefined,
    )
}

/**
 * The `client_version` every list is asked with (CA): with `Codex 최신 모델 자동 확인` on (absent: on), the newer of
 * this build's ({@link BACKEND}) and the newest release read ({@link LATEST}); off, this build's. Never lower than
 * this build's.
 */
export function clientVersion(stored: Versioning | undefined) {
  const latest = stored?.autoVersion === false ? undefined : stored?.latest?.version
  return latest !== undefined && newer(latest, BACKEND.clientVersion) ? latest : BACKEND.clientVersion
}

const RELEASE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * A registry version as Codex asks with it (`client_version_to_whole()`): `major.minor.patch`, any pre-release or
 * build part dropped; `undefined` for anything else.
 */
export function release(value: string | undefined) {
  const match = value?.match(RELEASE)
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : undefined
}

/** Whether release `a` is newer than release `b` (both `major.minor.patch`). */
export function newer(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  const at = left.findIndex((part, index) => part !== right[index])
  return at >= 0 && (left[at] ?? 0) > (right[at] ?? 0)
}

/** How a read of the newest Codex release ended (`failed`: the last one read stays). */
export type LatestRead =
  | { readonly type: "ok"; readonly version: string }
  | {
      readonly type: "failed"
      /** `status`: an HTTP error; `malformed`: no release version in the answer. */
      readonly reason: "status" | "timeout" | "network" | "malformed"
      readonly status?: number
    }

const decodeManifest = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.String }))

/**
 * One GET of `@openai/codex`'s `latest` manifest ({@link LATEST}): its `version` as Codex asks with it ({@link release}).
 * Sends `accept` and the fixed `user-agent` only. Never throws.
 */
export async function fetchLatest(input: {
  /** The registry root (`https://registry.npmjs.org`). */
  readonly registry: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}): Promise<LatestRead> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? LATEST.timeoutMs)
  const response = await fetch(`${input.registry.replace(/\/+$/, "")}${LATEST.path}`, {
    headers: { accept: "application/json", "user-agent": LATEST.userAgent },
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  }).catch(() => undefined)
  if (!response) return { type: "failed", reason: timeout.aborted ? "timeout" : "network" }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { type: "failed", reason: "status", status: response.status }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (timeout.aborted) return { type: "failed", reason: "timeout" }
  const version = release(Option.getOrUndefined(decodeManifest(body))?.version)
  return version ? { type: "ok", version } : { type: "failed", reason: "malformed", status: response.status }
}

/** The template the live `codex` slots use; `undefined` without one. */
function codexTemplate(registry: Pick<Registry.File, "slots">) {
  return Object.values(registry.slots).find((slot) => slot.kind === "codex" && !slot.retired)?.modelTemplate
}

/** The Codex home: the `codexHome` plugin option (tests), else `CODEX_HOME` like the Codex CLI, else `~/.codex`. */
export function home(option: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env) {
  return option || env.CODEX_HOME || path.join(os.homedir(), ".codex")
}

/** This PC's Codex config (`config.toml`), read only: `model` and `model_reasoning_effort`; empty when unreadable. */
export async function readConfig(dir: string): Promise<Preset.CodexHints> {
  return parseConfig(await text(path.join(dir, "config.toml")))
}

/**
 * The Codex CLI's `models_cache.json` on this PC as a `pc-cache` snapshot (`CodexModels.fromCache`), read only;
 * `undefined` when it is missing or of another shape.
 */
export async function readCache(dir: string): Promise<CodexModels.Snapshot | undefined> {
  const cache = path.join(dir, "models_cache.json")
  const source = await text(cache)
  return source === undefined ? undefined : CodexModels.fromCache(source, Bun.file(cache).lastModified)
}

const Config = Schema.Struct({
  model: optional(Schema.String),
  model_reasoning_effort: optional(Schema.String),
})
const decodeConfig = Schema.decodeUnknownOption(Config)

/** Top-level `model` and `model_reasoning_effort`; profiles and every other table are ignored. */
export function parseConfig(source: string | undefined): Preset.CodexHints {
  const config = Option.getOrUndefined(decodeConfig(source === undefined ? undefined : toml(source)))
  return {
    ...(config?.model ? { model: config.model } : {}),
    ...(config?.model_reasoning_effort ? { effort: config.model_reasoning_effort } : {}),
  }
}

function text(file: string) {
  return Bun.file(file)
    .text()
    .catch(() => undefined)
}

/** `Bun.TOML.parse` throws on malformed input and Bun has no non-throwing parse; that reads as no config. */
function toml(source: string): unknown {
  try {
    return Bun.TOML.parse(source)
  } catch {
    return undefined
  }
}

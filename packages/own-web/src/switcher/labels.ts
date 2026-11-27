// Names shown for a Model.Ref on every surface: "모델 @ 계정" (03 §1 계정 칩 문법), model display names from the model
// catalog, account labels, variant names and cache state text (03 §7.4). Reads stores only; reactive when used in JSX.
import type { ModelInfo } from "@opencode/client"
import type { Account, Cache, Switch } from "@own/protocol"
import { Speed } from "@own/protocol/speed"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import type { I18n } from "@/i18n"
import { modelLabel } from "@/sidebar/model"
import type { TargetRef } from "./cost"

const indexes = new WeakMap<readonly ModelInfo[], Map<string, ModelInfo>>()

/** providerID/id → ModelInfo, built once per catalog array (the store replaces the array on every sync). */
function indexOf(list: readonly ModelInfo[]) {
  const cached = indexes.get(list)
  if (cached) return cached
  const map = new Map(list.map((model) => [`${model.providerID}/${model.id}`, model]))
  indexes.set(list, map)
  return map
}

/** Directories whose model catalog this window loaded, per server (reactive, so labels update when one lands). */
const [loaded, setLoaded] = createRoot(() => createStore<Record<string, string[]>>({}))

/**
 * The catalog of a directory, else any catalog this window loaded (the server's own one included, see
 * {@link ensureCatalog}), else the default location's. Models are the same for every Location of a server; the API only
 * lists them per Location.
 */
export function catalog(runtime: ServerRuntime, directory?: string) {
  const location = runtime.data.location.model
  const own = directory !== undefined ? location.list({ directory }) : undefined
  if (own) return own
  for (const known of loaded[runtime.key] ?? []) {
    const list = location.list({ directory: known })
    if (list) return list
  }
  return location.list() ?? []
}

export function modelInfo(runtime: ServerRuntime, ref: Pick<TargetRef, "providerID" | "id">, directory?: string) {
  return indexOf(catalog(runtime, directory)).get(`${ref.providerID}/${ref.id}`)
}

/**
 * Display name from the catalog; until the catalog is loaded, for a model it does not list, or one it names by its id
 * (the Claude slot's `claude-opus-5-5`), the id in words (`Claude Opus 5.5`, sidebar/model `modelLabel`), never the
 * raw id (UX 2026-10-26).
 */
export function modelName(runtime: ServerRuntime, ref: Pick<TargetRef, "providerID" | "id">, directory?: string) {
  return modelLabel(ref.id, modelInfo(runtime, ref, directory)?.name)
}

/**
 * "모델 @ 계정" (`own.session.runningOn`) in segments, so the pills can let the model give way before the account
 * (03 §4.4, §4.6, UX 2026-10-26): `[{ part: "model", text }, { text: " @ " }, { part: "account", text }]` in the
 * locale's order. Joined, the segments are the translated string.
 */
export function runningOnParts(i18n: I18n, model: string, account: string) {
  const text = i18n.t("own.session.runningOn", { model: "\u0001", account: "\u0002" })
  return text
    .split(/(\u0001|\u0002)/)
    .filter((piece) => piece !== "")
    .map((piece) =>
      piece === "\u0001"
        ? { part: "model" as const, text: model }
        : piece === "\u0002"
          ? { part: "account" as const, text: account }
          : { part: undefined, text: piece },
    )
}

/**
 * Models of one provider in catalog order (release date) that can be picked: enabled and not `deprecated`. A model the
 * live catalog dropped stays registered as `deprecated` so sessions on it keep running (07 §4.4); it is not offered.
 */
export function providerModels(runtime: ServerRuntime, providerID: string, directory?: string) {
  return catalog(runtime, directory).filter((model) => model.providerID === providerID && offered(model))
}

/**
 * A model a picker offers: enabled, not `deprecated` (07 §4.4), and not a speed mode entry (`gpt-6-astra-fast`, 02
 * §4.8): its prompt prefix differs from the base model's, and the composer's 속도 sends the same speed on the base model
 * instead. Sessions already on one keep running.
 */
export function offered(model: Pick<ModelInfo, "enabled" | "status" | "id" | "modelID">) {
  return model.enabled && model.status !== "deprecated" && Speed.modeOf(model) === undefined
}

const requested = new Set<string>()

/** Servers whose own catalog (no folder) could not be loaded: the switcher says so instead of loading forever. */
const [failed, setFailed] = createRoot(() => createStore<Record<string, boolean>>({}))

/** Whether any model catalog of this server answered: one this window loaded, or the default location's. */
export function catalogLoaded(runtime: ServerRuntime) {
  return (loaded[runtime.key]?.length ?? 0) > 0 || runtime.data.location.model.list() !== undefined
}

/** Whether the last load of this server's own catalog failed; `ensureCatalog` again retries it. */
export function catalogFailed(runtime: ServerRuntime) {
  return failed[runtime.key] === true
}

/**
 * Loads the model catalog of a directory once per server, when the page is idle (03 §20.2 R8: only what is visible
 * at start); `eager` for the switcher, which needs it now. Call it again after a reconnect or a failure: a request made
 * while disconnected, or one that failed, is forgotten. Later changes arrive through `model.updated` events handled by
 * the data layer.
 *
 * Without a directory it loads the server's own catalog from the control location (02 §9.1), an empty folder the
 * service keeps and its RPCs already use, never from the default location: in service mode that is the home directory
 * (01 §5.3, G15), a heavy Location whose model list may answer 503 while its plugins start, and whose later
 * `model.updated` lists land under the home directory's key, so the default key would stay empty for good (ML). The
 * default location only while the control location is unknown (an SSH host before `resolve`, an older service before
 * any project). A directory whose Location cannot load (a default conversation folder not created yet, a removed
 * folder) loads the server's own catalog too: its models are the same.
 */
export function ensureCatalog(runtime: ServerRuntime, directory?: string, eager = false) {
  const key = `${runtime.key}|${directory ?? ""}`
  if (requested.has(key)) return
  requested.add(key)
  const load = () => {
    if (runtime.connection.status() !== "connected") return void requested.delete(key)
    const located = directory !== undefined ? Promise.resolve(directory) : runtime.control().catch(() => undefined)
    located
      .then(async (target) => {
        await runtime.data.location.model.sync(target !== undefined ? { directory: target } : undefined)
        return target
      })
      .then(
        (target) => {
          if (target !== undefined && !(loaded[runtime.key] ?? []).includes(target))
            setLoaded(runtime.key, (list) => [...(list ?? []), target])
          if (directory === undefined) setFailed(runtime.key, false)
        },
        () => {
          requested.delete(key)
          if (directory !== undefined) return ensureCatalog(runtime, undefined, true)
          setFailed(runtime.key, true)
        },
      )
  }
  if (eager || typeof requestIdleCallback !== "function") return load()
  requestIdleCallback(load, { timeout: 2_000 })
}

/**
 * The account of `providerID`; with `sessionID`, the account that session runs on (02 §8.7: its own Claude account
 * among the ones sharing `anthropic`, never just the first listed).
 */
export function accountOf(runtime: ServerRuntime, providerID: string, sessionID?: string): Account.View | undefined {
  return sessionID === undefined
    ? runtime.own.accountFor(providerID)
    : runtime.own.accountOfSession(sessionID, providerID)
}

/**
 * The account a switch of `sessionID` to `providerID` lands on (SL-17): the Claude account the router names for it
 * (`accountID`: an estimate's target, else the session's pending switch record), else {@link accountOf} with the
 * session. A switch from another company to Claude needs the named one: the switcher moved the tree to the chosen
 * Claude account first, and the binding names the old company's account until the switch lands.
 */
export function targetAccount(runtime: ServerRuntime, providerID: string, sessionID: string, accountID?: string) {
  const named = accountID ?? pendingAccountID(runtime.own.state.switchState[sessionID])
  const account = named ? runtime.own.state.accounts[named] : undefined
  return account?.providerID === providerID ? account : accountOf(runtime, providerID, sessionID)
}

/** The Claude account a pending switch record names (`WAIT_SAFE`, `COMPACTING`, `SCHEDULED`, `SWITCHING`, SL-17). */
export function pendingAccountID(state: Switch.State | undefined) {
  return state && "accountID" in state ? state.accountID : undefined
}

/**
 * A reasoning effort's name everywhere in the UI (03 §4.6, user decision of 2026-10-10): the provider's own level name
 * verbatim (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or any other a model lists), never translated;
 * the model's default reads `기본`/`Default`, whether the variant is missing or `default` (what own-web and presets
 * store for it). The text around it stays in the UI language.
 */
export function variantName(i18n: I18n, variant: string | undefined) {
  return namedVariant(variant) ?? i18n.t("own.switcher.variant.default")
}

/** A variant that names a level; `undefined` for the model's default (missing or `default`). */
export function namedVariant(variant: string | undefined) {
  return variant && variant !== "default" ? variant : undefined
}

/** 03 §7.4 symbol and text for a slot of this session; `cold` when the session never used that account. */
export function cacheText(i18n: I18n, slot: Cache.Slot | undefined, now: number) {
  if (!slot) return { state: "cold" as const, symbol: "○", text: i18n.t("own.cache.cold") }
  if (slot.state === "warm") {
    const minutes = slot.warmUntil ? Math.max(1, Math.ceil((slot.warmUntil - now) / 60_000)) : undefined
    return {
      state: "warm" as const,
      symbol: "●",
      text: minutes ? i18n.t("own.cache.warm", { minutes }) : i18n.t("own.switcher.cacheWarm"),
    }
  }
  if (slot.state === "cooling") return { state: "cooling" as const, symbol: "◐", text: i18n.t("own.cache.cooling") }
  if (slot.state === "unknown") return { state: "unknown" as const, symbol: "◌", text: i18n.t("own.cache.unknown") }
  return { state: "cold" as const, symbol: "○", text: i18n.t("own.cache.cold") }
}

/**
 * The cache slot of `providerID`. With `accountID`, that account's (SL 2026-10-26, SL-8): several Claude accounts share
 * `anthropic`, one account's cache is no other's, and the router keeps a slot per Claude account; a slot without an
 * account (written before, or a side without one) stands in. A conversation's own cache is its bound account's (the
 * account of its next request). Without `accountID`, the provider's newest slot.
 */
export function slotOf(snapshot: Cache.Snapshot | undefined, providerID: string, accountID?: string | null) {
  const slots = snapshot?.slots.filter((item) => item.providerID === providerID) ?? []
  if (!accountID) return slots[0]
  return slots.find((item) => item.accountID === accountID) ?? slots.find((item) => !item.accountID)
}

/** Account kind group name (03 §5.2 group headers). */
export function kindName(i18n: I18n, kind: Account.View["kind"]) {
  return i18n.t(`own.switcher.kind.${kind}`)
}

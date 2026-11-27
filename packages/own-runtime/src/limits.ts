export * as Limits from "./limits.js"

import { Option, Schema } from "effect"
import { Limit, LimitModel } from "@own/protocol"
import { readText, writeAtomic } from "./fsx.js"

/** Confidence bands of 02 §7.4. */
export const LIVE_MS = 2 * 60_000
export const RECENT_MS = 15 * 60_000

/**
 * A window as it should be shown at `now` (02 §7.4): confidence from its age, and a reset that passed without a
 * new observation becomes an estimated 0 % ("리셋됨(추정)"). A model bucket without a reset whose observation is stale
 * keeps its last value but no longer its state (`LimitModel.lapsed`, LV 2026-10-24): nothing else would ever end an
 * exhausted one.
 */
export function freshen(window: Limit.Window, now: number): Limit.Window {
  if (window.source === "estimate") return { ...window, confidence: "estimated" }
  if (window.resetAt !== undefined && window.resetAt <= now && window.observedAt < window.resetAt)
    return {
      ...window,
      ...(window.usedPercent === undefined ? {} : { usedPercent: 0 }),
      status: "ok",
      confidence: "estimated",
    }
  if (LimitModel.lapsed(window, now)) return { ...window, status: "unknown", confidence: "stale" }
  const age = now - window.observedAt
  return { ...window, confidence: age <= LIVE_MS ? "live" : age <= RECENT_MS ? "recent" : "stale" }
}

/**
 * Whether `next` is worth storing and announcing over `previous` (02 §7.4 "의미가 있으면"): a new window, a status
 * change, a move of at least one percentage point, a changed remaining/limit, a reset moved by more than a minute, or
 * another Claude billing verdict (`meta.billing`, 02 §8.9: the card's extra-usage line).
 */
export function significant(previous: Limit.Window | undefined, next: Limit.Window) {
  if (!previous) return true
  if (previous.status !== next.status) return true
  if (previous.meta?.billing !== next.meta?.billing) return true
  if (Math.abs((previous.usedPercent ?? 0) - (next.usedPercent ?? 0)) >= 1) return true
  if ((previous.usedPercent === undefined) !== (next.usedPercent === undefined)) return true
  if (previous.remaining !== next.remaining || previous.limit !== next.limit) return true
  return Math.abs((previous.resetAt ?? 0) - (next.resetAt ?? 0)) > 60_000
}

const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(Limit.SnapshotFile))

/**
 * Whether `next` is worth storing and announcing over `previous` (02 §7.1.1): a first count, another count, or credits
 * the dialog's details read brought or changed. A later observation with the same numbers only refreshes its age.
 */
export function significantCredits(previous: Limit.ResetCredits | undefined, next: Limit.ResetCredits) {
  if (!previous) return true
  if (previous.availableCount !== next.availableCount || previous.applicableCount !== next.applicableCount) return true
  return JSON.stringify(previous.credits ?? null) !== JSON.stringify(next.credits ?? null)
}

/**
 * The runtime limit store (01 §3.1, 02 §7.4): the newest observation of every `(accountID, window id)`, the current
 * hard exhaustion per account and model bucket (02 §5.2), each ChatGPT account's reset credit count (02 §7.1.1), and
 * `state\limits.json` persistence. Only the leader saves.
 */
export class Store {
  readonly #file: string
  readonly #now: () => number
  readonly #windows = new Map<string, Limit.Window>()
  /** accountID → the newest reset credit observation (02 §7.1.1). Not a window: nothing ranks or exhausts on it. */
  readonly #credits = new Map<string, Limit.ResetCredits>()
  /** Keyed by {@link scopeOf}: the account's account-wide record and one per model bucket. */
  readonly #exhaustion = new Map<string, Limit.Exhaustion>()
  /** When each exhaustion in {@link #exhaustion} was recorded. */
  readonly #exhaustedAt = new Map<string, number>()
  #dirty = false

  constructor(options: { readonly file: string; readonly now?: () => number }) {
    this.#file = options.file
    this.#now = options.now ?? Date.now
  }

  /**
   * Merges observations; for one `(accountID, id)` the newest `observedAt` wins, including error observations
   * (02 §7.4 "병합"). Returns the windows whose change is {@link significant}.
   */
  upsert(windows: ReadonlyArray<Limit.Window>) {
    return windows.filter((window) => {
      const key = keyOf(window.accountID, window.id)
      const previous = this.#windows.get(key)
      if (previous && previous.observedAt > window.observedAt) return false
      this.#windows.set(key, window)
      const changed = significant(previous, window)
      if (changed) this.#dirty = true
      return changed
    })
  }

  /** Windows (optionally of one account) as of now, see {@link freshen}. */
  list(filter: { readonly accountID?: string } = {}) {
    const now = this.#now()
    return [...this.#windows.values()]
      .filter((window) => filter.accountID === undefined || window.accountID === filter.accountID)
      .map((window) => freshen(window, now))
  }

  /**
   * Merges a reset credit observation; the newest `observedAt` wins. Returns whether it is {@link significantCredits}
   * (announce it). An observation without `credits` (a count from `wham/usage`) keeps the known credits while the
   * count stays the same.
   */
  upsertCredits(credits: Limit.ResetCredits) {
    const previous = this.#credits.get(credits.accountID)
    if (previous && previous.observedAt > credits.observedAt) return false
    const same = previous?.availableCount === credits.availableCount
    const next =
      credits.credits === undefined && same && previous?.credits ? { ...credits, credits: previous.credits } : credits
    this.#credits.set(credits.accountID, next)
    // The screen shows the count's age, so a newer observation is saved even when the numbers stay.
    this.#dirty = true
    return significantCredits(previous, next)
  }

  /**
   * Forgets an account's reset credit count: it is unknown until the next read (02 §7.1.1, a redeem whose read after
   * it reported none, as Codex). Not saved either, so a restart does not bring the old count back.
   */
  forgetCredits(accountID: string) {
    if (this.#credits.delete(accountID)) this.#dirty = true
  }

  /** The reset credit observations, optionally of one account. */
  credits(filter: { readonly accountID?: string } = {}) {
    return [...this.#credits.values()].filter(
      (credits) => filter.accountID === undefined || credits.accountID === filter.accountID,
    )
  }

  /** Forgets one window of an account, e.g. its monthly budget once the budget is removed. Whether it was there. */
  drop(accountID: string, id: string) {
    const dropped = this.#windows.delete(keyOf(accountID, id))
    if (dropped) this.#dirty = true
    return dropped
  }

  /** Forgets an account's windows and exhaustions, e.g. after removal. */
  remove(accountID: string) {
    for (const [key, window] of this.#windows) if (window.accountID === accountID) this.#windows.delete(key)
    this.#credits.delete(accountID)
    for (const [key, exhaustion] of this.#exhaustion) if (exhaustion.accountID === accountID) this.#forget(key)
    this.#dirty = true
  }

  /**
   * Records a retry-hook classification (02 §5.2); it lasts until `until` or {@link clearExhaustion}. An account keeps
   * one account-wide record and one per model weekly bucket (`LimitModel.accountWide`, LV 2026-10-24): a used-up Opus
   * week neither replaces nor is replaced by the 5 hours.
   */
  exhaust(exhaustion: Limit.Exhaustion) {
    const key = scopeOf(exhaustion.accountID, exhaustion.windowId)
    this.#exhaustion.set(key, exhaustion)
    this.#exhaustedAt.set(key, this.#now())
  }

  /**
   * The exhaustion in force that holds back requests of `model` on the account: the account-wide one, and a model
   * bucket's only for that bucket's family (`LimitModel.limits`; without a model account-wide ones only). With both, the
   * one that lasts longer.
   */
  exhaustion(accountID: string, model?: string) {
    return this.#held(accountID)
      .filter((exhaustion) => exhaustion.windowId === null || LimitModel.limits(exhaustion.windowId, model))
      .toSorted((a, b) => b.until - a.until)
      .at(0)
  }

  /** Every exhaustion in force now, a model bucket's included. Memory only: a restarted process starts without any. */
  exhaustions() {
    const now = this.#now()
    return [...this.#exhaustion.values()].filter((exhaustion) => exhaustion.until > now)
  }

  /**
   * A success from any session clears the account's exhaustion (02 §5.2): the account-wide one, and a model bucket's
   * when the success ran a model of its family (`model`). `at` is when that success happened, when it is known: one from
   * before the exhaustion was recorded keeps it (a ledger line of an earlier step that its session queue wrote after the
   * next request was refused).
   */
  clearExhaustion(accountID: string, at?: number, model?: string) {
    for (const [key, exhaustion] of this.#exhaustion) {
      if (exhaustion.accountID !== accountID) continue
      if (exhaustion.windowId !== null && !LimitModel.limits(exhaustion.windowId, model)) continue
      if (at !== undefined && at < (this.#exhaustedAt.get(key) ?? Number.NEGATIVE_INFINITY)) continue
      this.#forget(key)
    }
  }

  /** The account's records in force; expired ones go. */
  #held(accountID: string) {
    const now = this.#now()
    return [...this.#exhaustion].flatMap(([key, exhaustion]) => {
      if (exhaustion.accountID !== accountID) return []
      if (exhaustion.until > now) return [exhaustion]
      this.#forget(key)
      return []
    })
  }

  #forget(key: string) {
    this.#exhaustion.delete(key)
    this.#exhaustedAt.delete(key)
  }

  /** Loads `state\limits.json`. A missing or unreadable file starts empty: it is only a cache of observations. */
  async load() {
    const text = await readText(this.#file).catch(() => undefined)
    const snapshot = text === undefined ? undefined : Option.getOrUndefined(decodeSnapshot(text))
    if (!snapshot) return false
    this.upsert(snapshot.windows)
    for (const credits of snapshot.resetCredits ?? []) this.upsertCredits(credits)
    this.#dirty = false
    return true
  }

  /** Writes `state\limits.json` when something changed since the last save or load. */
  async save() {
    if (!this.#dirty) return false
    this.#dirty = false
    const snapshot: Limit.SnapshotFile = {
      schemaVersion: 1,
      savedAt: this.#now(),
      windows: [...this.#windows.values()],
      ...(this.#credits.size > 0 ? { resetCredits: [...this.#credits.values()] } : {}),
    }
    await writeAtomic(this.#file, `${JSON.stringify(snapshot)}\n`).catch((error: unknown) => {
      this.#dirty = true
      throw error
    })
    return true
  }
}

function keyOf(accountID: string, id: string) {
  return `${accountID}\u0000${id}`
}

/** An exhaustion's slot: the account's account-wide record, or the one of the model bucket it names. */
function scopeOf(accountID: string, windowID: string | null) {
  return LimitModel.accountWide(windowID) ? accountID : keyOf(accountID, windowID ?? "")
}

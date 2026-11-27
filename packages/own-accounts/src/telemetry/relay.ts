export * as Relay from "./relay.js"

import { type Account, type Limit, LimitModel } from "@own/protocol"
import type { Deps } from "../deps.js"

/**
 * Leader-only publication of process-wide limit state (02 §7.4, §9.1, §9.3): `quota.updated` per account at most once
 * per {@link QUOTA_INTERVAL_MS} (trailing), debounced `state\limits.json` saves, and `account.status` for exhaustion
 * records and their clearance. Every instance runs one; only the current leader acts, so leadership can move.
 */

/** 02 §7.4 "전송 빈도는 계정당 최대 1회/5초". */
export const QUOTA_INTERVAL_MS = 5_000
/** Delay before the leader writes `state\limits.json` after a significant change. */
export const SAVE_DELAY_MS = 10_000

export interface Relay {
  /**
   * `limits.updated` from any plugin instance. `dropped`: windows the store forgot (a removed budget); their accounts'
   * next `quota.updated` carries what is left, even nothing. `credits`: reset credit counts that changed (02 §7.1.1).
   * `unknown`: accounts whose count the store forgot; their next `quota.updated` says `resetCredits: null`.
   */
  limits(
    windows: ReadonlyArray<Limit.Window>,
    dropped?: ReadonlyArray<Pick<Limit.Window, "accountID" | "id">>,
    credits?: ReadonlyArray<Limit.ResetCredits>,
    unknown?: ReadonlyArray<Account.ID>,
  ): void
  /**
   * `exhausted` from any plugin instance (hard or auth only). Only an account-wide one is the account's status: a model
   * weekly bucket's (`LimitModel.accountWide`) leaves the account open to other models, so it announces nothing (no
   * `account.status`, hence no phone `quota.exhausted`); the refused session learns from its own switch state.
   */
  exhausted(exhaustion: Limit.Exhaustion): void
  /** A success was observed for the account (a step ended, a 2xx): announce clearance if we announced exhaustion. */
  succeeded(accountID: string): void
  stop(): void
}

/**
 * `account.status{reason}` of an exhaustion, and its `quota.snapshot` entry: the exhausted window, else the
 * classification code (the UI keys the Sign in with ChatGPT usage-limit notice on it, 02 §3.2c), else the class.
 */
export function reasonOf(exhaustion: Limit.Exhaustion) {
  return exhaustion.windowId ?? exhaustion.reason ?? exhaustion.class
}

export function create(deps: Deps): Relay {
  const log = deps.log.child("telemetry.relay")
  const quota = new Map<string, { last: number; cancel?: () => void }>()
  const announced = new Map<string, { accountID: Account.ID; until: number; cancel: () => void }>()
  const state: { save?: () => void } = {}
  const leader = () => deps.runtime.isLeader()

  /** Accounts whose next `quota.updated` goes out even without windows: they lost one (`dropped`). */
  const emptied = new Set<string>()
  /** Accounts whose next `quota.updated` says their reset credit count is unknown now (`resetCredits: null`). */
  const uncounted = new Set<string>()

  const emitQuota = (accountID: Account.ID) => {
    const entry = quota.get(accountID) ?? { last: Number.NEGATIVE_INFINITY }
    entry.last = deps.clock.now()
    entry.cancel = undefined
    quota.set(accountID, entry)
    const windows = deps.runtime.limits.list({ accountID })
    const forced = emptied.delete(accountID)
    // The account's reset credit count rides along whenever one is known (02 §7.1.1); it is not a window. A count
    // read since it was forgotten wins over saying it is unknown.
    const credits = deps.runtime.limits.credits({ accountID })[0]
    const unknown = uncounted.delete(accountID) && !credits
    if (windows.length > 0 || forced || credits || unknown)
      void deps.emitter.global("quota.updated", {
        accountID,
        windows,
        ...(credits ? { resetCredits: credits } : unknown ? { resetCredits: null } : {}),
      })
  }

  const scheduleQuota = (accountID: Account.ID) => {
    const entry = quota.get(accountID)
    if (entry?.cancel) return
    const wait = (entry?.last ?? Number.NEGATIVE_INFINITY) + QUOTA_INTERVAL_MS - deps.clock.now()
    if (wait <= 0) return emitQuota(accountID)
    quota.set(accountID, {
      last: entry?.last ?? Number.NEGATIVE_INFINITY,
      cancel: deps.clock.schedule(wait, () => {
        if (leader()) emitQuota(accountID)
      }),
    })
  }

  const scheduleSave = () => {
    if (state.save) return
    state.save = deps.clock.schedule(SAVE_DELAY_MS, () => {
      state.save = undefined
      if (!leader()) return
      void deps.runtime.limits.save().catch((error: unknown) => log.warn("limits_save_failed", { error }))
    })
  }

  const clear = (accountID: string, reason: string) => {
    const entry = announced.get(accountID)
    if (!entry) return
    entry.cancel()
    announced.delete(accountID)
    if (leader()) void deps.emitter.global("account.status", { accountID: entry.accountID, status: "ready", reason })
  }

  return {
    limits: (windows, dropped = [], credits = [], unknown = []) => {
      if (!leader()) return
      dropped.forEach((window) => emptied.add(window.accountID))
      unknown.forEach((accountID) => uncounted.add(accountID))
      for (const accountID of new Set([
        ...[...windows, ...dropped, ...credits].map((item) => item.accountID),
        ...unknown,
      ]))
        scheduleQuota(accountID)
      scheduleSave()
      for (const accountID of announced.keys())
        if (!deps.runtime.limits.exhaustion(accountID)) clear(accountID, "exhaustion_cleared")
    },
    exhausted: (exhaustion) => {
      if (!leader() || !LimitModel.accountWide(exhaustion.windowId)) return
      announced.get(exhaustion.accountID)?.cancel()
      announced.set(exhaustion.accountID, {
        accountID: exhaustion.accountID,
        until: exhaustion.until,
        cancel: deps.clock.schedule(Math.max(0, exhaustion.until - deps.clock.now()), () =>
          clear(exhaustion.accountID, "exhaustion_expired"),
        ),
      })
      void deps.emitter.global("account.status", {
        accountID: exhaustion.accountID,
        status: exhaustion.class === "auth" ? "auth_failed" : "exhausted",
        reason: reasonOf(exhaustion),
        until: exhaustion.until,
      })
    },
    succeeded: (accountID) => {
      if (announced.has(accountID) && !deps.runtime.limits.exhaustion(accountID)) clear(accountID, "exhaustion_cleared")
    },
    stop: () => {
      for (const entry of quota.values()) entry.cancel?.()
      for (const entry of announced.values()) entry.cancel()
      state.save?.()
      quota.clear()
      announced.clear()
    },
  }
}

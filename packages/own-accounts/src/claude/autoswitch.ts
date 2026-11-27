export * as ClaudeSwitch from "./autoswitch.js"

import type { Limit } from "@own/protocol"
import { LimitModel, LimitRank, Unified } from "@own/protocol"

/**
 * Automatic switching between this PC's Claude subscription accounts (02 §8.8, user decision C-D3 2026-10-10). Pure:
 * the claude module reads the facts and applies the answer. Same company only; leaving Claude for another company
 * stays a suggestion (5.10), and another company never switches to Claude by itself (`toClaudeSlot: "off"`).
 *
 * - Trigger ({@link signal}): the failed request's unified status says `rejected` (the 5-hour, weekly, a model weekly
 *   bucket's or the overall limit, `Unified.rejected`), or a 429 asks to wait longer than the plugin's own retry cap
 *   (30 s, its `fetchWithRetry`): a quota reset, not a burst.
 * - Target ({@link choose}): another account the plugin holds a login of, not exhausted now for the refused model
 *   (neither its exhaustion record nor a window holds that model back) and not one this tree left for that model before
 *   the refused window's reset ({@link returns}: a model weekly bucket's refusal keeps the tree off the account for that
 *   model family only), with the lowest 5-hour use (an account without a five-hour window, 02 §7.1.2, its weekly use in
 *   that place; unknown last), then the lowest weekly use. The whole tree moves, so
 *   the models its mains run now count too (`kept`, LV 2026-10-25): a Sonnet subagent's refusal does not bring an Opus
 *   main back to an account where Opus is held. A model weekly bucket
 *   (`claude.7d_oi`, `claude.7d_opus`, `claude.7d_sonnet`) blocks only its own model family, and Claude's extra usage
 *   never blocks alone (`LimitRank.blocks`, LV 2026-10-24): a used-up Fable week leaves the account open to a Sonnet
 *   session.
 * - Breaker ({@link allowed}): at most `breakerAutoPerHour` automatic switches per tree in an hour (each one starts the
 *   cache over); past it the tree stays where it is and the usual exhaustion stop applies.
 */

/** The plugin's own retry cap (`OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS` default): a longer `retry-after` is a quota reset. */
export const PLUGIN_RETRY_CAP_MS = 30_000

export interface Signal {
  /** `claude.5h`, `claude.7d`, a model weekly bucket, or `null` for the overall status or a long retry-after. */
  readonly windowId: string | null
  readonly reason: string
  /** When the exhausted account comes back, when the answer says. */
  readonly until?: number
}

/** Whether a failed `anthropic` answer means the account ran out (see the module comment). */
export function signal(headers: Headers, status: number | undefined, now: number): Signal | undefined {
  const refused = Unified.rejected(headers)
  if (refused) return withUntil({ windowId: refused.windowId, reason: refused.reason }, refused.resetAt)
  if (status !== 429) return undefined
  const after = retryAfter(headers, now)
  if (after === undefined || after - now <= PLUGIN_RETRY_CAP_MS) return undefined
  return { windowId: null, reason: "long_retry_after", until: after }
}

export interface Candidate {
  readonly accountID: string
  /** The plugin holds a login of this account (a remote service: always). */
  readonly loaded: boolean
}

/**
 * The account to move to, or `undefined`. `model` is the refused request's model id, `kept` the other models the tree's
 * mains run now (the whole tree moves with the refused request), `windows(id)` are the account's limit windows (as the
 * store shows them now), `exhausted(id, model)` whether an exhaustion record holds that model back on it
 * (`Limits.Store.exhaustion(id, model)`), `departed(id, model)` the time before which this tree must not come back to
 * it for that model. A candidate must be open to every one of those models.
 */
export function choose(input: {
  readonly from: string
  readonly candidates: ReadonlyArray<Candidate>
  readonly now: number
  readonly model: string | undefined
  readonly kept?: ReadonlyArray<string>
  readonly windows: (accountID: string) => ReadonlyArray<Limit.Window>
  readonly exhausted: (accountID: string, model: string | undefined) => boolean
  readonly departed: (accountID: string, model: string | undefined) => number | undefined
}): string | undefined {
  const used = (accountID: string, id: string) =>
    input.windows(accountID).find((window) => window.id === id)?.usedPercent ?? Number.POSITIVE_INFINITY
  const models = [input.model, ...(input.kept ?? [])]
  const open = (accountID: string, model: string | undefined) => {
    if (input.exhausted(accountID, model)) return false
    if (input.windows(accountID).some((window) => LimitRank.blocks(window, input.now, model))) return false
    const until = input.departed(accountID, model)
    return until === undefined || until <= input.now
  }
  const usable = input.candidates.filter(
    (candidate) =>
      candidate.accountID !== input.from &&
      candidate.loaded &&
      models.every((model) => open(candidate.accountID, model)),
  )
  const first = (accountID: string) =>
    LimitRank.claudeFirst(input.windows(accountID))?.usedPercent ?? Number.POSITIVE_INFINITY
  return usable.toSorted(
    (a, b) =>
      first(a.accountID) - first(b.accountID) || used(a.accountID, "claude.7d") - used(b.accountID, "claude.7d"),
  )[0]?.accountID
}

/**
 * The refusals a tree left one account for (02 §8.8): the refused window's scope (`null`: account-wide, the 5 hours, the
 * week, the overall status or a long retry-after; else the model weekly bucket, `LimitModel.bucket`) → until when.
 */
export type Departures = ReadonlyMap<string | null, number>

/**
 * A departure on `signal`'s refusal until `until`. A model weekly bucket's is its own record (LV 2026-10-25): an Opus
 * week used up keeps the tree off the account for Opus only, so a Sonnet refusal elsewhere may bring it back.
 */
export function depart(records: Departures | undefined, signal: Pick<Signal, "windowId">, until: number): Departures {
  return new Map(records).set(LimitModel.accountWide(signal.windowId) ? null : signal.windowId, until)
}

/** Until when the tree must not come back for `model`: the latest departure that holds that model back. */
export function returns(records: Departures | undefined, model: string | undefined) {
  const held = [...(records ?? [])].flatMap(([windowId, until]) =>
    windowId === null || LimitModel.limits(windowId, model) ? [until] : [],
  )
  return held.length === 0 ? undefined : Math.max(...held)
}

/** The breaker: fewer than `perHour` automatic switches of this tree within the last hour. */
export function allowed(history: ReadonlyArray<number>, now: number, perHour: number) {
  return history.filter((at) => now - at < 3_600_000).length < perHour
}

function withUntil(signal: Signal, until: number | undefined): Signal {
  return until === undefined ? signal : { ...signal, until }
}

/** `retry-after-ms`, or `retry-after` as seconds or an HTTP date → epoch ms. */
function retryAfter(headers: Headers, now: number) {
  const ms = headers.get("retry-after-ms")
  if (ms !== null && Number.isFinite(Number(ms))) return now + Number(ms)
  const value = headers.get("retry-after")
  if (value === null) return undefined
  if (Number.isFinite(Number(value))) return now + Number(value) * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : undefined
}

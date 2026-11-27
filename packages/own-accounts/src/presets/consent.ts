export * as PresetConsent from "./consent.js"

import { Option, Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { Account, Kv, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import { PresetBudget } from "./budget.js"
import { PresetUsage } from "./usage.js"

/**
 * Owner: PRESETS (07 §2.6, §5.4 step 4). What the user allows a root beyond its preset, both read by the subagent gate:
 * - `session.preset.raiseOnce`: the per-message cap of the current user message only (`이번 메시지만 늘리기`), KV
 *   `presetUsage.raise`, keyed by the message the gate counts against (`PresetUsage.message`). Without a number it
 *   rises to what the message asked for: the subagents the gate let through for it (`runtime.reservations`) plus the
 *   calls its per-message cap declined, which are followed in memory from the root's failed subagent calls (07 §2.6:
 *   per-message counts are never stored). With `effort` (07 §2.3 `이번 메시지만 허용`) it lifts the per-call effort
 *   ceiling of free targets to `max` for that message instead (`presetUsage.effort`), and leaves the cap as it is.
 * - `session.preset.consent`: for this conversation, whether a role may move onto a paid account (`[이 대화에서만]
 *   [아니오]`), KV `presetConsent`. Allowing an account whose monthly budget is used up is `preset_budget_exhausted`
 *   (`PresetBudget.exhausted`: on a remote service, the local PC's mirrored verdict).
 */
export interface Api {
  raiseOnce: RpcTypes.Handler<"session.preset.raiseOnce">
  consent: RpcTypes.Handler<"session.preset.consent">
  /** Follows the per-message rejections of local roots (`session.tool.failed`). */
  observe(event: Module.OpenCodeEvent): void
}

/** Roots whose declined calls are followed at once; the oldest are forgotten first. */
export const MAX_FOLLOWED = 1_000

const encodeUsage = Schema.encodeSync(Preset.Usage)
const encodeConsent = Schema.encodeSync(Preset.Consent)
const decodeConsent = Schema.decodeUnknownOption(Preset.Consent)
const toJson = Schema.decodeUnknownSync(Schema.Json)

/** core's `Unknown agent: <text>` failure of a subagent call the gate declined (07 §5.4 거절 경로). */
const UNKNOWN_AGENT = "Unknown agent: "

export function create(deps: Deps, peers: Module.Peers, caps: (sessionID: string) => Promise<Preset.Caps>): Api {
  /** Per root: calls the per-message cap declined, for the message they counted against. */
  const declined = new Map<string, { readonly messageID: string; readonly count: number }>()

  /** The root of a session as the runtime index knows it (subagents are one level deep, 07 §2.8). */
  const rootOf = (sessionID: string): string => {
    const parentID = deps.runtime.sessions.get(sessionID)?.parentID
    return parentID ? rootOf(parentID) : sessionID
  }

  return {
    observe: (event) => {
      if (event.type !== "session.tool.failed") return
      const text = event.data.error.message
      const at = text.indexOf(`${UNKNOWN_AGENT}${Preset.REJECT_PREFIX}`)
      const rejection = at < 0 ? undefined : Preset.parse(text.slice(at + UNKNOWN_AGENT.length))
      if (rejection?.reason !== "caps" || rejection.cap !== "perMessage") return
      // The per-message cap only declines a call of the message the root's last new subagent counted against.
      const root = rootOf(event.data.sessionID)
      const messageID = deps.runtime.reservations.counts(root).messageID
      if (messageID === undefined) return
      const known = declined.get(root)
      declined.delete(root)
      declined.set(root, { messageID, count: known?.messageID === messageID ? known.count + 1 : 1 })
      for (const key of declined.keys()) {
        if (declined.size <= MAX_FOLLOWED) break
        declined.delete(key)
      }
    },

    raiseOnce: async (input, context) => {
      const sessionID = input.sessionID
      const message = await PresetUsage.message(deps, sessionID)
      if (message === PresetUsage.UNKNOWN_MESSAGE)
        return context.error("internal_error", "no user message of this session is known", {})
      if (input.effort) {
        const usage = await PresetUsage.read(deps, sessionID)
        const next: Preset.Usage = { ...usage, effort: { messageID: SessionMessage.ID.make(message) } }
        await deps.ctx.storage.set(Kv.presetUsage(sessionID), toJson(encodeUsage(next)))
        return { perMessage: (await caps(sessionID)).perMessage, effort: true }
      }
      const counts = deps.runtime.reservations.counts(sessionID)
      const started = counts.messageID === message ? counts.message : 0
      const refused = declined.get(sessionID)?.messageID === message ? (declined.get(sessionID)?.count ?? 0) : 0
      const perMessage = input.perMessage ?? Math.max(started + refused, (await caps(sessionID)).perMessage)
      const usage = await PresetUsage.read(deps, sessionID)
      const next: Preset.Usage = {
        ...usage,
        raise: { messageID: SessionMessage.ID.make(message), perMessage },
      }
      await deps.ctx.storage.set(Kv.presetUsage(sessionID), toJson(encodeUsage(next)))
      return { perMessage }
    },

    consent: async (input, context) => {
      const accountID = input.accountID
      const account = accountID === Account.ID.claudeSlot ? undefined : peers().slots.account(accountID)
      // The Claude slot and a Claude Agent account (CAG-53) are subscriptions outside the registry's accounts.
      const outside = accountID === Account.ID.claudeSlot || peers().claudeAgent.entry(accountID) !== undefined
      if (!outside && (!account || account.status === "retired"))
        return context.error("account_not_found", "account_not_found", { accountID })
      if (input.allow && account && PresetBudget.paid(account) && (await PresetBudget.exhausted(peers, account)))
        return context.error("preset_budget_exhausted", "preset_budget_exhausted", { accountID })
      const key = Kv.presetConsent(input.sessionID)
      const stored = Option.getOrUndefined(decodeConsent(await deps.ctx.storage.get(key))) ?? { accounts: {} }
      const next: Preset.Consent = {
        accounts: { ...stored.accounts, [accountID]: { allow: input.allow, at: deps.clock.now() } },
      }
      await deps.ctx.storage.set(key, toJson(encodeConsent(next)))
      return { accountID, allow: input.allow }
    },
  }
}

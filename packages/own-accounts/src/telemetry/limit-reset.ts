export * as LimitReset from "./limit-reset.js"

import { Account, type Limit, type OwnError } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Nonces } from "../nonces.js"
import type { RpcTypes } from "../rpc/types.js"
import { Poller } from "./poller.js"
import { ResetCredits } from "./reset-credits.js"

/**
 * ChatGPT usage-limit reset credits ("리셋권", 02 §7.1.1): read them for the dialog, and redeem one after the user
 * confirmed it there (`quota.resetCredits.*`, run by the control Location, which leads the runtime). Only `codex`
 * accounts: Sign in with ChatGPT must not call ChatGPT's `backend-api` (02 §7.1), Claude's resets are claude.ai's
 * (02 §8.5), and API keys have none. Nothing here redeems by itself: only `execute`, with the nonce of a `plan`
 * the UI asked for after the user's click. Switching, autoswitch, retries, exhaustion, team, ultra, presets and start
 * never call it. The exhaustion hook only reads the count, once, when it is older than {@link STALE_MS}.
 *
 * Every request uses the login as it is (`credentials.headersFor` without a refresher, valid for more than
 * `Poller.FRESH_MS`): a reset credit read or redeem never refreshes a token.
 */

/** `quota.resetCredits.list` reads ChatGPT at most this often per account; in between it answers what it read. */
export const LIST_MIN_MS = 2 * 60_000
/** A hard exhaustion reads the count again when the one known is older than this (or none is known). */
export const STALE_MS = 15 * 60_000
/** How long a confirmation may wait between `plan` and `execute` (the plan's single-use nonce). */
export const NONCE_TTL_MS = 10 * 60_000
/** Session id of these requests' headers (no session exists). */
export const SESSION_ID = "own-limit-reset"

export interface Api {
  readonly list: RpcTypes.Handler<"quota.resetCredits.list">
  readonly plan: RpcTypes.Handler<"quota.resetCredits.redeem.plan">
  readonly execute: RpcTypes.Handler<"quota.resetCredits.redeem.execute">
  /** The leader saw a hard exhaustion: one count read for a `codex` account whose count is stale. Never throws. */
  exhausted(exhaustion: Limit.Exhaustion): Promise<void>
}

export interface Input {
  /** Telemetry's publication: the runtime store, `limits.updated` and the leader's `quota.updated`. */
  readonly publish: Poller.Publish
  readonly fetcher?: Poller.Fetcher
}

/** What `plan` fixed for its `execute`s: one `redeem_request_id` for every attempt of this confirmation. */
interface Planned {
  readonly accountID: Account.ID
  readonly creditID?: string
  readonly requestID: string
}

type Read =
  | { readonly ok: true; readonly credits: Limit.ResetCredits }
  | { readonly ok: false; readonly cause: OwnError.CredentialCause }
  | Poller.ReadFailure

export function create(deps: Deps, peers: Module.Peers, input: Input): Api {
  const log = deps.log.child("telemetry.limit-reset")
  const fetcher = input.fetcher ?? fetch
  const plans = new Nonces.Scope<Planned>(deps.clock, { ttlMs: NONCE_TTL_MS })
  /** accountID → when `list` last asked ChatGPT, and the read in flight. */
  const listed = new Map<string, { readonly at: number; readonly read: Promise<Read> }>()
  /** accountID → when an exhaustion last read the count (one read per {@link STALE_MS}, even a failed one). */
  const exhaustionReads = new Map<string, number>()

  const known = (accountID: string) => deps.runtime.limits.credits({ accountID })[0]

  /** Why the login is not usable as it is: the account's own `needs_reauth` first, then the stored login. */
  const notReady = async (account: Account.Info) =>
    account.status === "needs_reauth" ? ("needs_reauth" as const) : Poller.unready(deps, account)

  /** The login's headers as they are, or why it is not usable without a refresh. */
  const headers = async (account: Account.Info) => {
    const cause = await notReady(account)
    if (cause) return { ok: false as const, cause }
    const auth = await deps.runtime.credentials.headersFor({ account, sessionID: SESSION_ID })
    if (!auth.ok) return { ok: false as const, cause: Poller.causeOf(auth.problem) }
    return { ok: true as const, headers: auth.headers }
  }

  /** The count from `wham/usage` and the credits from the list, both now; the windows the usage read are published. */
  const read = async (account: Account.Info): Promise<Read> => {
    const auth = await headers(account)
    if (!auth.ok) return auth
    const [details, usage] = await Promise.all([
      Poller.getJson(fetcher, `${Poller.chatgptRoot(deps)}/wham/rate-limit-reset-credits`, auth.headers),
      Poller.readUsage(deps, fetcher, account, auth.headers),
    ])
    const named = details.ok ? ResetCredits.fromDetails(details.json) : undefined
    const counted = usage.ok ? usage.credits : undefined
    if (!named && !counted) {
      log.debug("reset_credits_unread", { accountID: account.id, details: failure(details), usage: failure(usage) })
      if (!details.ok) return details
      return usage.ok ? { ok: false, reason: "invalid" } : usage
    }
    const subject = { accountID: account.id, providerID: account.providerID }
    const credits = ResetCredits.observed(
      subject,
      deps.clock.now(),
      {
        availableCount: named?.availableCount ?? counted?.availableCount ?? 0,
        ...(counted?.applicableCount === undefined ? {} : { applicableCount: counted.applicableCount }),
      },
      named?.credits,
    )
    input.publish(usage.ok ? usage.windows : [], credits)
    return { ok: true, credits }
  }

  /** A `codex` account, or the declared error to answer (a Claude account is `not_supported`, not unknown). */
  const codexAccount = (accountID: string) => {
    const account = peers().slots.account(accountID)
    if (!account) {
      const claude = accountID === Account.ID.claudeSlot || peers().claude.entry(accountID) !== undefined
      if (claude) return { error: "not_supported" as const, kind: "claude-sub" }
      // A Claude Agent account has no reset credits either (CAG-53).
      if (peers().claudeAgent.entry(accountID)) return { error: "not_supported" as const, kind: "claude-agent" }
      return { error: "account_not_found" as const, kind: undefined }
    }
    if (account.kind !== "codex") return { error: "not_supported" as const, kind: account.kind }
    return { error: undefined, account }
  }

  const list: Api["list"] = async (request, context) => {
    const found = codexAccount(request.accountID)
    if (found.error === "account_not_found")
      return context.error("account_not_found", "no such account", { accountID: request.accountID })
    if (found.error === "not_supported")
      return context.error("not_supported", "only ChatGPT subscription accounts have reset credits", {
        kind: found.kind,
      })
    const account = found.account
    const now = deps.clock.now()
    const last = listed.get(account.id)
    const current = last && now - last.at < LIST_MIN_MS ? last : { at: now, read: read(account) }
    listed.set(account.id, current)
    const result = await current.read
    // The store's newest observation (a poll may have come in since), else what this read saw.
    if (result.ok) return { resetCredits: known(account.id) ?? result.credits }
    // A failed read does not hold the next one back.
    if (listed.get(account.id) === current) listed.delete(account.id)
    if ("cause" in result)
      return context.error("credential_not_ready", "the login is not usable without a refresh", {
        accountID: account.id,
        cause: result.cause,
      })
    return context.error("limit_reset_failed", "ChatGPT did not list the reset credits", {
      reason: result.reason,
      ...(result.status === undefined ? {} : { status: result.status }),
      retryable: true,
    })
  }

  const plan: Api["plan"] = async (request, context) => {
    const found = codexAccount(request.accountID)
    if (found.error === "account_not_found")
      return context.error("account_not_found", "no such account", { accountID: request.accountID })
    if (found.error === "not_supported")
      return context.error("not_supported", "only ChatGPT subscription accounts have reset credits", {
        kind: found.kind,
      })
    const account = found.account
    const cause = await notReady(account)
    if (cause)
      return context.error("credential_not_ready", "the login is not usable without a refresh", {
        accountID: account.id,
        cause,
      })
    const credit = request.creditID
      ? known(account.id)?.credits?.find((item) => item.id === request.creditID)
      : undefined
    const issued = plans.issue({
      accountID: account.id,
      ...(request.creditID ? { creditID: request.creditID } : {}),
      requestID: crypto.randomUUID(),
    })
    return {
      ...issued,
      account: { id: account.id, label: account.label },
      ...(credit
        ? {
            credit: {
              id: credit.id,
              ...(credit.title === undefined ? {} : { title: credit.title }),
              ...(credit.expiresAt === undefined ? {} : { expiresAt: credit.expiresAt }),
            },
          }
        : {}),
      windows: deps.runtime.limits.list({ accountID: account.id }),
    }
  }

  const execute: Api["execute"] = async (request, context) => {
    // Peeked, not used: no answer keeps the nonce for a retry with the same request id.
    const planned = plans.peek(request.nonce)
    if (!planned) return context.error("nonce_invalid", "plan again", {})
    const account = peers().slots.account(planned.accountID)
    if (!account) {
      plans.consume(request.nonce)
      return context.error("account_not_found", "the account was removed", { accountID: planned.accountID })
    }
    const auth = await headers(account)
    if (!auth.ok)
      return context.error("credential_not_ready", "the login is not usable without a refresh", {
        accountID: account.id,
        cause: auth.cause,
      })
    // From the send on, the credits are what they were before only until ChatGPT answers, and an answer can be lost
    // (a timeout after the redeem went through): no list read from before the send, or from while it was on its way,
    // is served again, answered or not. The next list asks ChatGPT, as the Codex TUI does on every open.
    listed.delete(account.id)
    const sent = await Poller.send(fetcher, `${Poller.chatgptRoot(deps)}/wham/rate-limit-reset-credits/consume`, {
      method: "POST",
      headers: { ...auth.headers, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        redeem_request_id: planned.requestID,
        ...(planned.creditID === undefined ? {} : { credit_id: planned.creditID }),
      }),
    })
    listed.delete(account.id)
    const answer = sent.ok ? ResetCredits.consumed(sent.json) : undefined
    if (!answer) {
      const reason = sent.ok ? "invalid" : sent.reason
      const status = sent.ok ? undefined : sent.status
      log.warn("reset_credit_failed", { accountID: account.id, reason, status })
      return context.error("limit_reset_failed", "ChatGPT did not answer the redeem", {
        reason,
        ...(status === undefined ? {} : { status }),
        retryable: true,
      })
    }
    plans.consume(request.nonce)
    if (answer.outcome === "nothing_to_reset" || answer.outcome === "no_credit") {
      log.info("reset_credit_refused", { accountID: account.id, outcome: answer.outcome })
      // codex-rs: without a picked credit, `no_credit` means none is left.
      if (answer.outcome === "no_credit" && planned.creditID === undefined)
        input.publish(
          [],
          ResetCredits.observed({ accountID: account.id, providerID: account.providerID }, deps.clock.now(), {
            availableCount: 0,
          }),
        )
      return { outcome: answer.outcome }
    }
    const usage = await Poller.readUsage(deps, fetcher, account, auth.headers)
    // The redeemed credit is gone from the list; without a picked one the list is unknown until the next read.
    const previous = known(account.id)?.credits
    const credits =
      usage.ok && usage.credits
        ? {
            ...usage.credits,
            ...(planned.creditID && previous
              ? { credits: previous.filter((item) => item.id !== planned.creditID) }
              : {}),
          }
        : undefined
    // No count is ever guessed: when the read after the redeem failed or named none, the count from before it is not
    // what is left, so it is unknown until the next read (Codex sets it to none after a reset as well). Forgotten
    // before the windows are published: the publication's `quota.updated` reads the stored count, and the old one
    // would show again until the next tick.
    if (!credits) deps.runtime.limits.forgetCredits(account.id)
    if (usage.ok) input.publish(usage.windows, credits)
    // The reset ended the account's exhaustion: `account.status{ready}` follows from the relay (02 §5.2).
    deps.runtime.limits.clearExhaustion(account.id)
    const stored = known(account.id)
    deps.runtime.broadcast.emit("limits.updated", {
      windows: [],
      ...(stored ? { resetCredits: [stored] } : { creditsUnknown: [account.id] }),
    })
    log.info("reset_credit_redeemed", {
      accountID: account.id,
      outcome: answer.outcome,
      windowsReset: answer.windowsReset,
      counted: stored !== undefined,
    })
    return {
      outcome: answer.outcome,
      windowsReset: answer.windowsReset,
      ...(stored ? { resetCredits: stored } : {}),
      windows: deps.runtime.limits.list({ accountID: account.id }),
    }
  }

  const exhausted: Api["exhausted"] = async (exhaustion) => {
    if (deps.remote || !deps.runtime.isLeader() || exhaustion.class !== "hard") return
    const account = peers().slots.account(exhaustion.accountID)
    if (!account || account.kind !== "codex" || account.pollBalance === false) return
    const now = deps.clock.now()
    const count = known(account.id)
    if (count && now - count.observedAt <= STALE_MS) return
    if (now - (exhaustionReads.get(account.id) ?? Number.NEGATIVE_INFINITY) < STALE_MS) return
    exhaustionReads.set(account.id, now)
    const auth = await headers(account)
    if (!auth.ok) return log.debug("reset_credits_skipped", { accountID: account.id, cause: auth.cause })
    const usage = await Poller.readUsage(deps, fetcher, account, auth.headers)
    if (!usage.ok) return log.debug("reset_credits_unread", { accountID: account.id, usage: failure(usage) })
    input.publish(usage.windows, usage.credits)
  }

  return { list, plan, execute, exhausted }
}

/** A read's failure for the log: reason and status, never a body. */
function failure(read: { readonly ok: boolean; readonly reason?: string; readonly status?: number }) {
  return read.ok ? undefined : { reason: read.reason, status: read.status }
}

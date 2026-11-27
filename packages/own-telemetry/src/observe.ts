export * as Observe from "./observe.js"

import type { SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session"
import { Provider } from "@opencode/schema/provider"
import { Account, Broker, type Limit, LimitModel, LimitRank, OwnID } from "@own/protocol"
import { Hash, type Runtime } from "@own/runtime"
import { ExtraUsage } from "./extra-usage.js"
import { Unified } from "./unified.js"

/** Retry-after above this is a long stall to cut short (02 §8.8: core caps one wait at 15 minutes). */
export const LONG_RETRY_MS = 15 * 60_000
/** Exhaustion without a known reset lasts this long (02 §5.2 first backoff step). */
export const BACKOFF_MS = 15 * 60_000
/** Error bodies are read at most this long; they are not streams, but a stalled server must not stall the hook. */
export const BODY_TIMEOUT_MS = 2_000
/** 02 §7.2 "앞 2KB". */
export const BODY_HEAD_CHARS = 2_048

export interface Deps {
  readonly runtime: Runtime.Handle
  readonly now: () => number
  readonly log: {
    readonly warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void
  }
  /** `resetAt` jitter (02 §5.2 "1~3분 지터"); tests pass a fixed value. */
  readonly jitter?: () => number
}

/**
 * Owner: TELEMETRY agent. Observation of the final `anthropic` responses, registered after claude-auth (01 §4):
 * nothing here changes a request. Results go to the runtime only; own-accounts turns them into RPC events.
 */
export interface Api {
  /**
   * Read-only. Unified headers → `Unified.parse` → `runtime.limits.upsert` → broadcast `limits.updated`;
   * `runtime.lastResponse.record`; status ≥ 400 → first 2 KB of `response.clone().text()` → `ExtraUsage.detect` →
   * the account's `claude.overage` says `billing: "rejected"` (`Unified.refused`) and broadcast
   * `alert{code:"claude_extra_usage", severity:"danger"}`; a later success of a model the used-up plan windows hold back
   * clears that verdict (02 §8.9). Never consumes the body stream.
   */
  onHttpResponse(event: SessionHttpResponse): Promise<void>
  /**
   * Long-stall prevention (02 §8.8): last unified status `rejected`, or a 429 whose retry-after exceeds
   * {@link LONG_RETRY_MS} → `event.decision = { retry: false }`, `runtime.limits.exhaust`, an `events.jsonl` record
   * via `runtime.ledger.event`, and broadcast `exhausted`, all for the Claude account that signed the session's last
   * request (G4). The record names the refused window (`Unified.rejected`); a model weekly bucket's holds back only its
   * model family, until the bucket's reset. Never decides a switch (own-accounts does, 5.10); when own-accounts already moved the conversation to
   * another Claude account in this retry (02 §8.8, `runtime.claude.markSwitched`), the decision stays a retry. A
   * refusal for extra usage (`ExtraUsage.detect` on the last error body, 02 §8.9) is never retried either.
   */
  onRetry(event: SessionRetry): Promise<void>
}

export function create(deps: Deps): Api {
  const runtime = deps.runtime
  const jitter = deps.jitter ?? (() => 60_000 + Math.floor(Math.random() * 120_000))
  const providerID = Provider.ID.anthropic

  /**
   * A success after a refusal for extra usage (02 §8.9): requests go through again, so the account's `rejected` verdict
   * and the refusal's state go even when this response carried no overage header (the refusal's own window may have been
   * made from nothing). Extra usage is headroom past the plan (`LimitRank.extra`): what it would do now is unknown until
   * a response says. Only a success of a model that the used-up plan windows hold back says so (LV 2026-10-25): with
   * only the Fable week used up (#5920), a Sonnet answer went through the plan, not extra usage, and the Fable
   * conversation's `추가 사용량 거절됨` stays.
   */
  const cleared = (
    parsed: ReadonlyArray<Limit.Window>,
    failed: boolean,
    accountID: Account.ID,
    now: number,
    model: string,
  ) => {
    if (failed || parsed.some((window) => window.id === "claude.overage")) return []
    const windows = runtime.limits.list({ accountID })
    const stale = windows.find((window) => window.id === "claude.overage" && window.meta?.billing === "rejected")
    if (!stale) return []
    const covered = windows.filter(
      (window) => window.kind === "rolling_quota" && LimitRank.facts(window, now).status === "exhausted",
    )
    if (covered.length > 0 && !covered.some((window) => LimitModel.limits(window.id, model))) return []
    const { billing: _billing, ...meta } = stale.meta ?? {}
    const { meta: _meta, ...rest } = stale
    const next: Limit.Window = {
      ...rest,
      status: "unknown",
      source: "header",
      confidence: "live",
      observedAt: now,
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    }
    return [next]
  }

  return {
    onHttpResponse: async (event) => {
      if (event.model.providerID !== providerID) return
      const response = event.response
      // On an SSH host (04 §8.11.4.6): a refusal of the PC's egress relay or the fail-closed sink is not Anthropic's.
      if (response.headers.has(Broker.EGRESS_ERROR_HEADER) || response.headers.has(Broker.FAIL_CLOSED_HEADER)) return
      // G4 (02 §8.5): the Claude account that signed this very request; the slot's own when only one account signs.
      const accountID = (runtime.claude.accountOf(event.request) ?? Account.ID.claudeSlot) as Account.ID
      runtime.claude.remember(event.sessionID, accountID)
      const now = deps.now()
      const failed = response.status >= 400
      const bodyHead = failed ? await head(response.clone()) : null
      runtime.lastResponse.record(event.sessionID, {
        providerID,
        status: response.status,
        headers: response.headers,
        bodyHead,
        authHash8: Hash.auth(event.request.headers)[0]?.hash ?? null,
        at: now,
      })
      const parsed = Unified.parse(response.headers, now, failed ? "error" : "header", accountID)
      const refused = bodyHead !== null && ExtraUsage.detect(bodyHead)
      const changed = runtime.limits.upsert(
        refused
          ? Unified.refused(parsed, now, accountID)
          : [...parsed, ...cleared(parsed, failed, accountID, now, event.model.id)],
      )
      // An account without a five-hour window (02 §7.1.2): the one stored from before goes, so nothing shows or ranks it.
      const gone =
        Unified.withoutFiveHour(response.headers, response.status) && runtime.limits.drop(accountID, Unified.FIVE_HOUR)
      if (changed.length > 0 || gone)
        runtime.broadcast.emit("limits.updated", {
          windows: changed,
          ...(gone ? { dropped: [{ accountID, id: Unified.FIVE_HOUR }] } : {}),
        })
      if (!failed) {
        // A success from any session ends the slot's exhaustion (02 §5.2): the account-wide one, and a model bucket's
        // when this model is of its family (a Sonnet answer says nothing of the Opus week).
        if (runtime.limits.exhaustion(accountID, event.model.id))
          runtime.limits.clearExhaustion(accountID, undefined, event.model.id)
        return
      }
      if (refused)
        runtime.broadcast.emit("alert", {
          code: "claude_extra_usage",
          severity: "danger",
          sessionID: event.sessionID,
          accountID,
          message:
            "Anthropic이 이 요청을 서드파티 사용으로 보고 추가 사용량에서 내려 했지만, 추가 사용량이 꺼져 있거나 모자라 거절했어요. claude.ai › 설정 › 사용량에서 켜거나 Anthropic API 키를 쓰세요.",
        })
    },

    onRetry: async (event) => {
      if (event.model.providerID !== providerID) return
      // The account of the session's last answer (the one that ran out), never the binding of the moment.
      const accountID = (runtime.claude.lastOf(event.sessionID) ?? Account.ID.claudeSlot) as Account.ID
      const switched = runtime.claude.takeSwitched(event.sessionID)
      const now = deps.now()
      const last = runtime.lastResponse.get(event.sessionID)
      const capture = last?.providerID === providerID ? last : undefined
      const headers = new Headers(capture?.headers ?? {})
      const rejected = Unified.rejected(headers)
      const status = event.error.status ?? capture?.status ?? undefined
      const retryAt = retryAfter(headers, now)
      const long = status === 429 && retryAt !== undefined && retryAt - now > LONG_RETRY_MS
      // A refusal for extra usage (02 §8.9, e.g. the 429 `credits_required`) is final: every try would be refused
      // alike, and each is a request. It ends here unless own-accounts already moved the conversation.
      if (capture?.bodyHead && ExtraUsage.detect(capture.bodyHead) && !switched) event.decision = { retry: false }
      if (!rejected && !long) return
      // own-accounts already moved the conversation to another Claude account and retries at once (02 §8.8, C-D3):
      // the exhaustion below is still the old account's, the retry stays.
      if (!switched) event.decision = { retry: false }
      // The refused window's own reset: a model weekly bucket (`claude.7d_opus`, …) is recorded for its model family
      // only, until that bucket resets (LV 2026-10-24); without one, retry-after, else the backoff.
      const resetAt = [rejected?.resetAt, retryAt].find((at) => at !== undefined && at > now)
      const exhaustion: Limit.Exhaustion = {
        accountID,
        windowId: rejected?.windowId ?? null,
        until: resetAt === undefined ? now + BACKOFF_MS : resetAt + jitter(),
        class: "hard",
      }
      runtime.limits.exhaust(exhaustion)
      await runtime.ledger
        .event({
          eid: `exh_${OwnID.ulid(now)}`,
          ts: now,
          type: "exhaustion",
          accountID,
          providerID,
          sessionID: event.sessionID,
          data: {
            class: "hard",
            windowId: exhaustion.windowId,
            until: exhaustion.until,
            reason: rejected ? `unified_${rejected.reason}` : "long_retry_after",
          },
        })
        .catch((error: unknown) => deps.log.warn("exhaustion_record_failed", { error }))
      // After a switch the conversation already runs on a healthy account: the exhaustion is the old account's and no
      // session should react to it (the switching planner would move it away from Claude).
      runtime.broadcast.emit("exhausted", { exhaustion, providerID, ...(switched ? {} : { sessionID: event.sessionID }) })
    },
  }
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

async function head(response: Response) {
  const timeout = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), BODY_TIMEOUT_MS)
    timer.unref?.()
  })
  const text = response.text().then(
    (value) => value.slice(0, BODY_HEAD_CHARS),
    () => null,
  )
  return Promise.race([text, timeout])
}

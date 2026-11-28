export * as LoginStatus from "./status.js"

import type { Account, Registry } from "@own/protocol"
import { Credentials } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Logger } from "../logger.js"
import type { Module } from "../module.js"

/** A credential outcome as `headersFor` or `inspect` reports it. */
export interface Observation {
  readonly ok: boolean
  readonly problem?: Credentials.Problem
  readonly detail?: string
}

interface Verdict {
  readonly status: Account.Status
  readonly reason: string
}

/** How often the leader re-checks stale linked sources while nobody uses them (02 §3.2a "1분에 한 번 stat"). */
export const POLL_MS = 60_000

export const STALE_MESSAGE =
  "이전 앱이 로그인을 갱신하지 않았습니다 — 이전 앱에서 이 프로필을 한 번 실행하세요 (또는 takeover로 전환)"

/**
 * Account status that follows from credentials (02 §3.2a stale handling, §3.5 F5, 01 §8.3 "훅 불변식"):
 *
 * - linked source expired/rejected and not refreshed by the old app → `auth_failed`, reason `codex_source_stale`,
 *   global alert `codex_source_stale`; back to `ready` once the source has usable tokens again;
 * - linked source holds another login or cannot be read → `misconfigured` (`account_mismatch`, …);
 * - linked old-app API key file deleted, unreadable or not a key (02 §3.2b) → `misconfigured` (`not_found`,
 *   `decrypt_failed`, …); back to `ready` once the file holds a usable key again. A key the provider rejects is
 *   `auth_failed` from the connection test (reason `legacy_key_rejected`), not from reading the file;
 * - vault token family dead or vault item unusable → `needs_reauth`.
 *
 * Any instance that sees an outcome writes the registry (off the hot path, once per change). The process leader is
 * the only one that announces: it scans the registry after every change and emits `account.status` (and the stale
 * alert) once per episode, so an outcome seen in a non-leader Location is still announced.
 */
export class Tracker {
  readonly #deps: Deps
  readonly #peers: Module.Peers
  readonly #log: Logger.Logger
  readonly #writing = new Set<string>()
  /** Verdicts seen by this instance; a reason is used only while the registry still shows its status. */
  readonly #reasons = new Map<string, Verdict>()
  /** Leader only: the status last announced per account. */
  readonly #announced = new Map<string, Account.Status>()
  #cancel: (() => void) | undefined

  constructor(input: { readonly deps: Deps; readonly peers: Module.Peers; readonly log: Logger.Logger }) {
    this.#deps = input.deps
    this.#peers = input.peers
    this.#log = input.log
  }

  start() {
    const tick = () => {
      this.#cancel = this.#deps.clock.schedule(POLL_MS, tick)
      void this.poll().catch((error: unknown) => this.#log.warn("status_poll_failed", { error }))
    }
    this.#cancel = this.#deps.clock.schedule(POLL_MS, tick)
  }

  stop() {
    this.#cancel?.()
    this.#cancel = undefined
  }

  /** Records a credential outcome of `account` from the hot path. Synchronous and never throws. */
  observe(account: Account.Info, observation: Observation) {
    void this.apply(account, observation)
  }

  /** {@link observe}, resolving once the resulting registry write (if any) is done. Never rejects. */
  apply(account: Account.Info, observation: Observation): Promise<void> {
    const current = this.#peers().slots.account(account.id) ?? account
    const verdict = decide(current, observation)
    if (!verdict || verdict.status === current.status || !changeable(current.status)) return Promise.resolve()
    this.#reasons.set(account.id, verdict)
    return this.#write(account.id, verdict).catch((error: unknown) =>
      this.#log.warn("account_status_failed", { accountID: account.id, error }),
    )
  }

  /**
   * RS (2026-11-28): a success from the provider ends an `auth_failed` of an account own holds the credential of (a
   * connection test's 401, or {@link refused}; later requests with the refreshed token or the same key work).
   */
  accepted(account: Account.Info): Promise<void> {
    return this.#settle(account, "auth_failed", { status: "ready", reason: "accepted" })
  }

  /**
   * RS: the provider refused the account's credential again after the refresh its first refusal asked for (02 §5.2
   * T-AUTH): the card, the limits tab and the picker say `인증 실패` (before, only a passing reason of the session did).
   */
  refused(account: Account.Info): Promise<void> {
    return this.#settle(account, "ready", { status: "auth_failed", reason: "refused" })
  }

  /**
   * A status a request's outcome moves `from`, on an account own holds the credential of: a linked source's status
   * stays with its source file ({@link poll}). Resolves once the write (if any) is done; never rejects.
   */
  #settle(account: Account.Info, from: Account.Status, verdict: Verdict) {
    const current = this.#peers().slots.account(account.id) ?? account
    if (current.status !== from || Credentials.linked(current)) return Promise.resolve()
    this.#reasons.set(account.id, verdict)
    return this.#write(account.id, verdict).catch((error: unknown) =>
      this.#log.warn("account_status_failed", { accountID: account.id, error }),
    )
  }

  /** Forgets an account (removal). */
  forget(accountID: string) {
    this.#reasons.delete(accountID)
    this.#announced.delete(accountID)
  }

  /**
   * Leader: re-checks linked accounts in a problem state. The runtime reader only re-reads the file when its mtime
   * or size changed, so an idle stale account costs one `stat` per minute.
   */
  async poll() {
    if (!this.#deps.runtime.isLeader()) return
    const stuck = this.#peers()
      .slots.snapshot()
      .accounts.filter(
        (account) =>
          Credentials.linked(account) && (account.status === "auth_failed" || account.status === "misconfigured"),
      )
    for (const account of stuck) this.observe(account, await this.#deps.runtime.credentials.inspect(account))
    this.scan()
  }

  /**
   * Leader: announces status changes found in the registry (call after every registry change). `registry` is a fresh
   * read when the change came from another instance, whose slots memory may still be reloading.
   */
  scan(registry: Registry.File = this.#peers().slots.snapshot()) {
    if (!this.#deps.runtime.isLeader()) return
    for (const account of registry.accounts) {
      const announced = this.#announced.get(account.id)
      if (problem(account)) {
        if (announced === account.status) continue
        this.#announced.set(account.id, account.status)
        const seen = this.#reasons.get(account.id)
        const reason = seen?.status === account.status ? seen.reason : defaultReason(account)
        void this.#deps.emitter.global("account.status", { accountID: account.id, status: account.status, reason })
        if (account.status === "auth_failed" && reason === "codex_source_stale")
          this.#peers().telemetry.alert({
            code: "codex_source_stale",
            severity: "warning",
            accountID: account.id,
            message: STALE_MESSAGE,
          })
        continue
      }
      if (announced === undefined) continue
      this.#announced.delete(account.id)
      this.#reasons.delete(account.id)
      if (account.status === "ready")
        void this.#deps.emitter.global("account.status", { accountID: account.id, status: "ready" })
    }
  }

  async #write(accountID: string, verdict: Verdict) {
    if (this.#writing.has(accountID)) return
    this.#writing.add(accountID)
    await this.#peers()
      .slots.mutate((registry) => {
        const target = registry.accounts.find((account) => account.id === accountID)
        if (!target || target.status === verdict.status || !changeable(target.status)) return undefined
        return {
          ...registry,
          accounts: registry.accounts.map((account) =>
            account.id === accountID ? { ...account, status: verdict.status } : account,
          ),
        }
      })
      .then(
        () => this.#log.info("account_status", { accountID, status: verdict.status, reason: verdict.reason }),
        (error: unknown) => this.#log.warn("account_status_write_failed", { accountID, error }),
      )
      .finally(() => this.#writing.delete(accountID))
    this.scan()
  }
}

function decide(account: Account.Info, observation: Observation): Verdict | undefined {
  const type = Credentials.credentialOf(account).type
  if (observation.ok) {
    // A readable old-app key file says nothing about whether the provider still accepts the key: only a file
    // problem clears here; `auth_failed` clears through a successful connection test.
    const recovered =
      type === "linked-codex-source"
        ? account.status === "auth_failed" || account.status === "misconfigured"
        : type === "linked-legacy-key"
          ? account.status === "misconfigured"
          : account.status === "needs_reauth"
    return recovered ? { status: "ready", reason: "recovered" } : undefined
  }
  const problem = observation.problem
  if (problem === "source_stale") return { status: "auth_failed", reason: "codex_source_stale" }
  if (problem === "source_invalid") return { status: "misconfigured", reason: observation.detail ?? "source_invalid" }
  if (problem === "kind_mismatch" || problem === "identity_missing") return { status: "misconfigured", reason: problem }
  if (problem === "needs_reauth" || problem === "not_found" || problem === "decrypt_failed" || problem === "corrupt")
    return { status: "needs_reauth", reason: observation.detail ?? problem }
  // expired, refresh_backoff, vault_unavailable: transient, the next use may succeed.
  return undefined
}

/** Statuses a credential outcome may replace. `disabled` and `retired` are user decisions. */
function changeable(status: Account.Status) {
  return status !== "disabled" && status !== "retired"
}

function problem(account: Account.Info) {
  if (account.status === "needs_reauth") return true
  if (!Credentials.linked(account)) return false
  return account.status === "auth_failed" || account.status === "misconfigured"
}

function defaultReason(account: Account.Info) {
  const legacy = Credentials.credentialOf(account).type === "linked-legacy-key"
  if (account.status === "auth_failed") return legacy ? "legacy_key_rejected" : "codex_source_stale"
  if (account.status === "misconfigured") return "source_invalid"
  return "needs_reauth"
}

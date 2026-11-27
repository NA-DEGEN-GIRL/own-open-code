export * as CodexImport from "./codex.js"

import fs from "node:fs/promises"
import { Account, type Credential, type OwnAccounts, type OwnError, type Registry } from "@own/protocol"
import { CodexSource, Credentials, type Refresh } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Logger } from "../logger.js"
import type { Module } from "../module.js"
import { Nonces } from "../nonces.js"
import { ChatgptLogin } from "./chatgpt.js"
import type { LoginStatus } from "./status.js"
import { LoginView } from "./view.js"

// codex-multi-provider import (02 §3.2a, D7). Source files are only read: linked mode follows the old app's
// `auth.json` (the old app stays the single refresher), takeover copies the tokens into the vault once and then
// refreshes immediately so we become the single refresher (F10). Paths come from the profile id, never from input.

export interface Env {
  readonly deps: Deps
  readonly peers: Module.Peers
  readonly log: Logger.Logger
  readonly tracker: LoginStatus.Tracker
  readonly refresher: (account: Account.Info) => Refresh.Refresher | undefined
  readonly plans: Nonces.Scope<Plan>
  /** New accounts: color and label defaults. */
  readonly defaults: {
    readonly color: (registry: Registry.File) => Account.Color
  }
  /** Removes a vault item nobody references (a failed create). */
  readonly discard: (accountID: Account.ID) => Promise<void>
}

/** What `plan` decided; `execute` re-reads the source and acts on exactly this. */
export interface Plan {
  readonly profileID: string
  readonly alias: string | null
  readonly mode: Credential.CodexImportMode
  readonly source: Credential.CodexSource
  /** The login the plan saw; `execute` refuses a source that holds another one (C5). */
  readonly expected: CodexSource.Expected
  /** Re-link or take over this account instead of creating one. */
  readonly target?: Account.ID
}

export type Failure =
  | { readonly type: "source_not_found"; readonly profileID: string }
  | { readonly type: "source_invalid"; readonly profileID: string; readonly reason: OwnError.SourceProblem }
  | { readonly type: "account_not_found"; readonly accountID: string }
  | { readonly type: "nonce_invalid" }
  | { readonly type: "template_unavailable"; readonly reason: string }
  | { readonly type: "vault_unavailable" }

export function root(deps: Deps) {
  return deps.options.codexImportRoot ?? CodexSource.DEFAULT_CONTROL_CENTER
}

/** `accounts.import.codex.list`: every profile with its importability; no token values, no paths. */
export async function list(env: Env): Promise<{ available: boolean; sources: OwnAccounts.CodexCandidate[] }> {
  const found = await CodexSource.list(root(env.deps), { now: env.deps.clock.now() })
  const accounts = env.peers().slots.snapshot().accounts
  return {
    available: found.available,
    sources: found.profiles.map((profile): OwnAccounts.CodexCandidate => {
      const imported = importedAs(accounts, profile.source)
      const base = { profileID: profile.profileID, alias: profile.alias, importedAs: imported }
      if (!profile.inspection.ok) return { ...base, importable: false, problem: profile.inspection.problem }
      return {
        ...base,
        // An expired access token is still importable: takeover refreshes at once, linked waits for the old app.
        importable: true,
        problem: profile.inspection.expired ? "token_expired" : undefined,
        identity: {
          emailMasked: profile.inspection.summary.identity.emailMasked,
          plan: profile.inspection.summary.identity.plan,
        },
        lastRefresh: profile.inspection.summary.lastRefresh,
      }
    }),
  }
}

/** `accounts.import.codex.plan`: no side effects besides the nonce. */
export async function plan(
  env: Env,
  input: { readonly profileID: string; readonly mode: Credential.CodexImportMode; readonly accountID?: Account.ID },
): Promise<
  { readonly ok: true; readonly plan: OwnAccounts.CodexImportPlan } | { readonly ok: false; readonly failure: Failure }
> {
  const found = await CodexSource.list(root(env.deps), { now: env.deps.clock.now() })
  const profile = found.profiles.find((candidate) => candidate.profileID === input.profileID)
  if (!profile) return { ok: false, failure: { type: "source_not_found", profileID: input.profileID } }
  const slots = env.peers().slots
  const target = input.accountID === undefined ? undefined : slots.account(input.accountID)
  if (input.accountID !== undefined && (!target || target.kind !== "codex" || target.status === "retired"))
    return { ok: false, failure: { type: "account_not_found", accountID: input.accountID } }
  const now = env.deps.clock.now()
  const inspection = await CodexSource.inspect(profile.source.authPath, {
    now,
    expected: target && Credentials.expectedOf(target),
  })
  if (!inspection.ok)
    return { ok: false, failure: { type: "source_invalid", profileID: input.profileID, reason: inspection.problem } }
  const identity = inspection.summary.identity
  const duplicate = target?.id ?? ChatgptLogin.duplicateOf(slots.snapshot().accounts, identity, "codex")
  const warnings: OwnAccounts.CodexImportWarning[] = [
    input.mode === "linked" ? "linked_depends_on_source" : "takeover_supersedes_source",
    ...(inspection.expired ? (["source_token_expired"] as const) : []),
  ]
  const issued = env.plans.issue({
    profileID: profile.profileID,
    alias: profile.alias,
    mode: input.mode,
    source: profile.source,
    expected: { accountId: identity.chatgptAccountId, fingerprint: identity.fingerprint },
    target: duplicate,
  })
  return {
    ok: true,
    plan: {
      ...issued,
      profileID: profile.profileID,
      alias: profile.alias,
      mode: input.mode,
      identity: { emailMasked: identity.emailMasked, plan: identity.plan },
      duplicateOf: duplicate ?? null,
      warnings,
    },
  }
}

export interface Executed {
  readonly account: Account.Info
  readonly mode: Credential.CodexImportMode
  readonly reauthenticated: boolean
}

/** `accounts.import.codex.execute`: re-reads the source (the old app may have refreshed since `plan`). */
export async function execute(
  env: Env,
  input: { readonly nonce: string; readonly label?: string; readonly color?: Account.Color },
): Promise<{ readonly ok: true; readonly result: Executed } | { readonly ok: false; readonly failure: Failure }> {
  const planned = env.plans.consume(input.nonce)
  if (!planned) return { ok: false, failure: { type: "nonce_invalid" } }
  const now = env.deps.clock.now()
  const exists = await fs.stat(planned.source.authPath).then(
    () => true,
    () => false,
  )
  if (!exists) return { ok: false, failure: { type: "source_not_found", profileID: planned.profileID } }
  const read = await CodexSource.read(planned.source.authPath, { now, expected: planned.expected })
  if (!read.ok)
    return { ok: false, failure: { type: "source_invalid", profileID: planned.profileID, reason: read.problem } }
  const summary = read.snapshot.summary
  const target = planned.target === undefined ? undefined : env.peers().slots.account(planned.target)
  if (planned.target !== undefined && (!target || target.status === "retired"))
    return { ok: false, failure: { type: "account_not_found", accountID: planned.target } }
  const identity = importIdentity(summary.identity)
  const at = new Date(now).toISOString()
  const credential: Credential.Ref =
    planned.mode === "linked"
      ? { type: "linked-codex-source", source: planned.source, linkedAt: at }
      : { type: "takeover-codex-source", source: planned.source, takenOverAt: at }
  const stale = summary.expiresAt <= now
  const linkedStatus: Account.Status = stale ? "auth_failed" : "ready"
  if (planned.mode === "takeover") {
    const id = target?.id ?? Account.ID.create()
    // Persist before use: the copied tokens are in the vault before the registry points at them.
    const copied = await env.deps.runtime.credentials.takeover(id, planned.source, { expected: planned.expected })
    if (!copied.ok) return { ok: false, failure: copyFailure(planned, copied) }
    const saved = target
      ? await relink(env, target, { credential, identity, status: "ready", at, label: input.label, color: input.color })
      : await create(env, {
          id,
          planned,
          identity,
          credential,
          status: "ready",
          label: input.label,
          color: input.color,
        })
    if (!saved.ok) {
      // The copy has no registry account (create failed, or the target was removed meanwhile).
      await env.discard(id)
      return saved
    }
    await confirmRefresher(env, saved.account, planned)
    return {
      ok: true,
      result: { account: current(env, saved.account), mode: "takeover", reauthenticated: target !== undefined },
    }
  }
  const saved = target
    ? await relink(env, target, {
        credential,
        identity,
        status: linkedStatus,
        at,
        label: input.label,
        color: input.color,
      })
    : await create(env, {
        id: Account.ID.create(),
        planned,
        identity,
        credential,
        status: linkedStatus,
        label: input.label,
        color: input.color,
      })
  if (!saved.ok) return saved
  // takeover → linked (or own login → linked): our vault copy is no longer the credential; shred it (02 §3.2a 4).
  if (target && Credentials.credentialOf(target).type !== "linked-codex-source")
    await env.deps.runtime.credentials.remove(target, { shred: true }).then(
      (removed) => {
        if (!removed.ok) env.log.warn("codex_relink_shred_failed", { accountID: target.id, problem: removed.problem })
      },
      (error: unknown) => env.log.warn("codex_relink_shred_failed", { accountID: target.id, error }),
    )
  // An expired source starts `auth_failed`; the leader announces `codex_source_stale` for it.
  env.tracker.scan()
  return {
    ok: true,
    result: { account: current(env, saved.account), mode: "linked", reauthenticated: target !== undefined },
  }
}

/**
 * F10: the takeover refreshes once right away so the old app stops being a second holder of the refresh token. A
 * `refresh_token_reused` failure means the old app refreshed after our copy: copy the source again and retry once;
 * a second failure leaves the account `needs_reauth` (announced by the status tracker).
 */
async function confirmRefresher(env: Env, account: Account.Info, planned: Plan) {
  const refresher = env.refresher(account)
  if (!refresher) return
  const credentials = env.deps.runtime.credentials
  const first = await credentials.refresh(account, refresher, { force: true })
  if (first.type === "backoff" || first.type === "unavailable")
    env.log.warn("codex_takeover_refresh_deferred", { accountID: account.id, result: first.type, reason: first.reason })
  if (first.type !== "needs_reauth") return
  env.log.warn("codex_takeover_refresh_failed", { accountID: account.id, reason: first.reason })
  const retry = async () => {
    const again = await credentials.takeover(account.id, planned.source, { expected: planned.expected })
    return again.ok ? credentials.refresh(account, refresher, { force: true }) : undefined
  }
  const second = first.reason === "refresh_token_reused" ? await retry() : undefined
  if (second?.type === "refreshed" || second?.type === "current") return
  await env.tracker.apply(account, { ok: false, problem: "needs_reauth", detail: first.reason })
}

async function create(
  env: Env,
  input: {
    readonly id: Account.ID
    readonly planned: Plan
    readonly identity: Account.Identity
    readonly credential: Credential.Ref
    readonly status: Account.Status
    readonly label?: string
    readonly color?: Account.Color
  },
): Promise<{ readonly ok: true; readonly account: Account.Info } | { readonly ok: false; readonly failure: Failure }> {
  const slots = env.peers().slots
  const created = await slots.createAccount({
    id: input.id,
    kind: "codex",
    label: input.label || input.planned.alias || input.identity.emailMasked || "ChatGPT",
    color: input.color ?? env.defaults.color(slots.snapshot()),
    identity: input.identity,
    credential: input.credential,
    cacheDomain: { scope: "chatgpt_login", externalId: input.identity.chatgptAccountId },
    quotaDomain: { scope: "chatgpt_seat", externalId: input.identity.chatgptAccountId },
    status: input.status,
  })
  if (!created.ok) return { ok: false, failure: { type: "template_unavailable", reason: created.reason } }
  return { ok: true, account: created.account }
}

/** Points an existing account at the source (re-link, takeover, or mode switch). Same id and provider id: no cache effect. */
async function relink(
  env: Env,
  target: Account.Info,
  input: {
    readonly credential: Credential.Ref
    readonly identity: Account.Identity
    readonly status: Account.Status
    /** `linkedAt` / `takenOverAt`, also the verification time. */
    readonly at: string
    readonly label?: string
    readonly color?: Account.Color
  },
): Promise<{ readonly ok: true; readonly account: Account.Info } | { readonly ok: false; readonly failure: Failure }> {
  const registry = await env.peers().slots.mutate((current) => {
    if (!current.accounts.some((account) => account.id === target.id)) return undefined
    return {
      ...current,
      accounts: current.accounts.map((account) =>
        account.id === target.id
          ? {
              ...account,
              ...(input.label ? { label: input.label } : {}),
              ...(input.color ? { color: input.color } : {}),
              identity: ChatgptLogin.mergeIdentity(account.identity, input.identity),
              credential: input.credential,
              status: account.status === "disabled" ? account.status : input.status,
              lastVerifiedAt: input.at,
            }
          : account,
      ),
    }
  })
  const account = registry.accounts.find((candidate) => candidate.id === target.id)
  if (!account) return { ok: false, failure: { type: "account_not_found", accountID: target.id } }
  return { ok: true, account }
}

function copyFailure(planned: Plan, failure: Credentials.Failure): Failure {
  if (failure.problem === "source_invalid")
    return { type: "source_invalid", profileID: planned.profileID, reason: sourceProblem(failure.detail) }
  return { type: "vault_unavailable" }
}

function sourceProblem(detail: string | undefined): OwnError.SourceProblem {
  const problems: ReadonlyArray<OwnError.SourceProblem> = [
    "unreadable",
    "parse_failed",
    "not_chatgpt",
    "missing_tokens",
    "token_expired",
    "account_mismatch",
  ]
  return problems.find((problem) => problem === detail) ?? "unreadable"
}

function importIdentity(identity: CodexSource.Identity): Account.Identity {
  return {
    chatgptAccountId: identity.chatgptAccountId,
    emailMasked: identity.emailMasked,
    plan: identity.plan,
    fingerprint: identity.fingerprint,
  }
}

/** The registry's current copy (a status write may have followed). */
function current(env: Env, account: Account.Info) {
  return env.peers().slots.account(account.id) ?? account
}

/** The import mode of an account already imported from this source file. */
function importedAs(accounts: ReadonlyArray<Account.Info>, source: Credential.CodexSource) {
  const match = accounts
    .filter((account) => account.status !== "retired")
    .map((account) => ({ account, credential: Credentials.credentialOf(account) }))
    .find(
      (entry) =>
        (entry.credential.type === "linked-codex-source" || entry.credential.type === "takeover-codex-source") &&
        LoginView.samePath(entry.credential.source.authPath, source.authPath),
    )
  if (!match) return null
  return {
    accountID: match.account.id,
    mode: match.credential.type === "linked-codex-source" ? ("linked" as const) : ("takeover" as const),
  }
}

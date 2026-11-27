export * as LegacyImport from "./legacy.js"

import { Account, type Credential, type Kind, type OwnAccounts, type OwnError, type Registry } from "@own/protocol"
import { CodexSource, Credentials, LegacyKey } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Logger } from "../logger.js"
import type { Module } from "../module.js"
import { Nonces } from "../nonces.js"
import { Templates } from "../slots/templates.js"
import { Probe } from "./probe.js"
import { LoginView } from "./view.js"

// Linked import of API keys saved by the older codex-multi-provider app (02 §3.2b), the key counterpart of the
// linked Codex import: the registry keeps only a reference to the old app's DPAPI file (`linked-legacy-key`), the file
// is never written, copied or re-encrypted, and the key is decrypted in memory by own-vault `linked.get` when a
// request needs it. Paths come from the old app's credential ref, never from RPC input.

/** Kind names used in the suggested account label (`DeepSeek (이전 앱)`). */
const KIND_NAME: Readonly<Record<Kind.Api, string>> = {
  oai: "OpenAI",
  anth: "Anthropic",
  ds: "DeepSeek",
  xai: "xAI",
  or: "OpenRouter",
  compat: "Compatible",
}

export interface Env {
  readonly deps: Deps
  readonly peers: Module.Peers
  readonly log: Logger.Logger
  readonly plans: Nonces.Scope<Plan>
  readonly defaults: { readonly color: (registry: Registry.File) => Account.Color }
  /** Cache and quota domains of a new key account (the `accounts.add.key` rules, 02 §3.3). */
  readonly domains: (
    kind: Kind.Api,
    identity: Account.Identity,
  ) => {
    readonly cacheDomain: { readonly scope: Registry.CacheDomainScope; readonly externalId?: string }
    readonly quotaDomain: { readonly scope: Registry.QuotaDomainScope; readonly externalId?: string }
  }
}

/** What `plan` decided; `execute` re-reads the key file and acts on exactly this. */
export interface Plan {
  readonly providerRef: Credential.LegacyProviderRef
  readonly name: string | null
  readonly kind: Kind.Api
  readonly source: Credential.LegacyKeySource
  readonly label: string
  /** `compat` only: the slot's base URL and models (with the old app's context windows). */
  readonly baseURL?: string
  readonly compatModels?: ReadonlyArray<OwnAccounts.CompatModel>
}

export type Failure =
  | { readonly type: "legacy_key_not_found"; readonly providerRef: string }
  | { readonly type: "legacy_key_invalid"; readonly providerRef: string; readonly reason: OwnError.LegacyKeyProblem }
  | { readonly type: "duplicate_account"; readonly accountID: Account.ID }
  | { readonly type: "probe_failed"; readonly status?: number; readonly message: string }
  | { readonly type: "template_unavailable"; readonly kind: Kind.Api; readonly reason: string }
  | { readonly type: "vault_unavailable" }
  | { readonly type: "nonce_invalid" }

/**
 * The old app's root: two levels above the codex import control center (`codexImportRoot`, default
 * `D:\#Projects\codex-multi-provider\work\control-center`). `undefined` when that is not a
 * `codex-multi-provider\work\control-center` directory.
 */
export function root(deps: Deps) {
  return LegacyKey.appRootOf(deps.options.codexImportRoot ?? CodexSource.DEFAULT_CONTROL_CENTER)
}

/** `accounts.import.keys.list`: saved API-key providers; nothing is decrypted, no key or path is returned. */
export async function list(env: Env): Promise<{ available: boolean; keys: OwnAccounts.LegacyKeyCandidate[] }> {
  const appRoot = root(env.deps)
  if (!appRoot) return { available: false, keys: [] }
  const found = await LegacyKey.list(appRoot)
  const accounts = env.peers().slots.snapshot().accounts
  return {
    available: found.available,
    keys: found.candidates.map((candidate): OwnAccounts.LegacyKeyCandidate => {
      const imported = importedAs(accounts, candidate.source)
      return {
        providerRef: candidate.providerRef,
        name: candidate.name,
        kind: candidate.kind ?? null,
        baseURL: candidate.baseURL,
        models: candidate.models.map((model) => model.id),
        keySaved: candidate.keySaved,
        importable: candidate.problem === undefined,
        ...(candidate.problem === undefined ? {} : { problem: candidate.problem }),
        importedAs: imported ? { accountID: imported.id } : null,
      }
    }),
  }
}

/** `accounts.import.keys.plan`: reads (decrypts) the key once to check it and find duplicates; no other side effects. */
export async function plan(
  env: Env,
  input: { readonly providerRef: Credential.LegacyProviderRef },
): Promise<
  | { readonly ok: true; readonly plan: OwnAccounts.LegacyKeyImportPlan }
  | { readonly ok: false; readonly failure: Failure }
> {
  const appRoot = root(env.deps)
  const found = appRoot ? await LegacyKey.list(appRoot) : undefined
  const candidate = found?.candidates.find((item) => item.providerRef === input.providerRef)
  if (!candidate) return { ok: false, failure: { type: "legacy_key_not_found", providerRef: input.providerRef } }
  const kind = candidate.kind
  if (kind === undefined || candidate.problem === "unsupported_provider")
    return {
      ok: false,
      failure: { type: "legacy_key_invalid", providerRef: input.providerRef, reason: "unsupported_provider" },
    }
  if (candidate.problem === "not_found")
    return { ok: false, failure: { type: "legacy_key_not_found", providerRef: input.providerRef } }
  if (candidate.problem)
    return {
      ok: false,
      failure: { type: "legacy_key_invalid", providerRef: input.providerRef, reason: candidate.problem },
    }
  const read = await env.deps.runtime.credentials.legacyAuth(candidate.source, kind)
  if (!read.ok) return { ok: false, failure: readFailure(input.providerRef, read.problem) }
  const compat = kind === "compat" ? compatOf(candidate) : undefined
  const duplicate = await duplicateOf(env, kind, candidate.source, read, compat?.baseURL)
  const model = candidate.models[0]?.id ?? null
  const inTemplate = kind === "compat" || model === null ? true : await templateHas(env, kind, model)
  const label = `${candidate.name ?? KIND_NAME[kind]} (이전 앱)`
  const issued = env.plans.issue({
    providerRef: candidate.providerRef,
    name: candidate.name,
    kind,
    source: candidate.source,
    label,
    ...compat,
  })
  return {
    ok: true,
    plan: {
      ...issued,
      providerRef: candidate.providerRef,
      name: candidate.name,
      kind,
      label,
      baseURL: candidate.baseURL,
      model,
      keyHint: read.keyHint,
      duplicateOf: duplicate ?? null,
      warnings: ["linked_key_depends_on_source", ...(inTemplate ? [] : (["model_not_in_template"] as const))],
    },
  }
}

export interface Executed {
  readonly account: Account.Info | null
  readonly keyHint: string
  readonly detected?: Account.Detected
}

/**
 * `accounts.import.keys.execute`: reads the key file again (the old app may have changed it since `plan`), refuses a
 * key another live account already uses, probes it with the kind's connection test (02 §3.3) and creates the account
 * with a `linked-legacy-key` reference. `dryRun` stops after the read and the duplicate check: no probe, no account,
 * and the nonce stays valid.
 */
export async function execute(
  env: Env,
  input: {
    readonly nonce: string
    readonly label?: string
    readonly color?: Account.Color
    readonly dryRun?: boolean
    readonly signal?: AbortSignal
  },
): Promise<{ readonly ok: true; readonly result: Executed } | { readonly ok: false; readonly failure: Failure }> {
  const planned = input.dryRun ? env.plans.peek(input.nonce) : env.plans.consume(input.nonce)
  if (!planned) return { ok: false, failure: { type: "nonce_invalid" } }
  const credentials = env.deps.runtime.credentials
  const read = await credentials.legacyAuth(planned.source, planned.kind)
  if (!read.ok) return { ok: false, failure: readFailure(planned.providerRef, read.problem) }
  const duplicate = await duplicateOf(env, planned.kind, planned.source, read, planned.baseURL)
  if (duplicate) return { ok: false, failure: { type: "duplicate_account", accountID: duplicate } }
  if (input.dryRun) return { ok: true, result: { account: null, keyHint: read.keyHint } }
  const probe = await Probe.run({
    kind: planned.kind,
    headers: read.headers,
    endpoints: env.deps.endpoints,
    baseURL: planned.baseURL,
    signal: input.signal,
  })
  if (!probe.ok)
    return {
      ok: false,
      failure: {
        type: "probe_failed",
        message: probe.message,
        ...(probe.status === undefined ? {} : { status: probe.status }),
      },
    }
  const identity: Account.Identity = {
    keyHint: read.keyHint,
    organizationId: probe.detected.organizationId ?? undefined,
    projectId: probe.detected.projectId ?? undefined,
    workspaceId: probe.detected.workspaceId ?? undefined,
    teamId: probe.detected.teamId ?? undefined,
  }
  const domains = env.domains(planned.kind, identity)
  const slots = env.peers().slots
  const created = await slots.createAccount({
    id: Account.ID.create(),
    kind: planned.kind,
    label: input.label?.trim() || planned.label,
    color: input.color ?? env.defaults.color(slots.snapshot()),
    identity,
    credential: {
      type: "linked-legacy-key",
      source: planned.source,
      linkedAt: new Date(env.deps.clock.now()).toISOString(),
    },
    cacheDomain: domains.cacheDomain,
    quotaDomain: domains.quotaDomain,
    baseURL: planned.baseURL,
    compatModels: planned.compatModels,
    status: "ready",
    method: "legacy-key-linked",
  })
  if (!created.ok)
    return { ok: false, failure: { type: "template_unavailable", kind: planned.kind, reason: created.reason } }
  env.log.info("legacy_key_linked", {
    accountID: created.account.id,
    kind: planned.kind,
    providerID: created.account.providerID,
    providerRef: planned.providerRef,
  })
  return { ok: true, result: { account: created.account, keyHint: read.keyHint, detected: probe.detected } }
}

function readFailure(providerRef: string, problem: LegacyKey.Problem): Failure {
  if (problem === "vault_unavailable") return { type: "vault_unavailable" }
  if (problem === "not_found") return { type: "legacy_key_not_found", providerRef }
  return { type: "legacy_key_invalid", providerRef, reason: problem }
}

/** `compat` slots use the old app's endpoint and its models with their recorded context windows. */
function compatOf(candidate: LegacyKey.Candidate) {
  return {
    baseURL: candidate.baseURL ?? undefined,
    compatModels: candidate.models.flatMap((model): OwnAccounts.CompatModel[] =>
      model.contextLimit === undefined ? [] : [{ id: model.id, contextLimit: model.contextLimit }],
    ),
  }
}

/**
 * A live account already backed by this key: one linked to the same file, or one of the same kind (and, for
 * `compat`, the same base URL) whose credential header hashes the same (vault or linked; compared without reading
 * any key out of the runtime).
 */
async function duplicateOf(
  env: Env,
  kind: Kind.Api,
  source: Credential.LegacyKeySource,
  read: { readonly hash: string; readonly keyHint: string },
  baseURL: string | undefined,
) {
  const slots = env.peers().slots
  const accounts = slots.snapshot().accounts
  const linked = importedAs(accounts, source)
  if (linked) return linked.id
  const candidates = accounts.filter(
    (account) =>
      account.kind === kind &&
      account.status !== "retired" &&
      account.identity.keyHint === read.keyHint &&
      (kind !== "compat" || slots.slot(account.providerID)?.slot.baseURL === baseURL),
  )
  const matches = await Promise.all(
    candidates.map(async (account) => {
      const auth = await env.deps.runtime.credentials.headersFor({ account, sessionID: "own-accounts:import" })
      return auth.ok && auth.hash === read.hash ? account.id : undefined
    }),
  )
  return matches.find((id) => id !== undefined)
}

/** The live account linked to this key file, if any. */
function importedAs(accounts: ReadonlyArray<Account.Info>, source: Credential.LegacyKeySource) {
  return accounts.find((account) => {
    if (account.status === "retired") return false
    const credential = Credentials.credentialOf(account)
    return credential.type === "linked-legacy-key" && LoginView.samePath(credential.source.path, source.path)
  })
}

/** Whether the kind's model template (the registry's current one, else the bundled one) has the old app's model. */
async function templateHas(env: Env, kind: Exclude<Kind.Api, "compat">, model: string) {
  const registry = env.peers().slots.snapshot()
  const id = Templates.current(registry, kind)
  const template = (id ? registry.modelTemplates[id] : undefined) ?? (await Templates.bundled(kind))
  if (!template) return true
  return template.models.some((item) => item.id === model || item.modelID === model)
}

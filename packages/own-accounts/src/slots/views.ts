export * as Views from "./views.js"

import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account, type Compaction, type Limit, LimitRank, type Registry } from "@own/protocol"
import type { Plugins } from "../plugins/plugins.js"

/**
 * `accounts.list` items (02 §9.2). Views never carry secrets and drop the identity facts the UI does not need
 * (`chatgptAccountId`, the guard `fingerprint`). A `codex` account's fingerprint is its ChatGPT login, so its view
 * carries it as `login` (07 §5.4 R4): own.team and own-web pair it with the same login's `siwc` account from views.
 * The pinned template's diff marks (07 §4.4) show on every account of the kind: `templateUpdate` waiting for
 * `refreshCatalog`, and only the marked models (`addedAt` for the picker's `새` tag, `upstream: "missing"`).
 */

/** Facts about an account that live outside the registry (runtime session index, compaction resolution). */
export interface Extra {
  /** The moment the windows are ranked at ({@link summary}); now when absent. */
  readonly now?: number
  /** Sessions bound to the account's slot (`running` = executing now), from the runtime session index. */
  readonly sessions?: { readonly running: number; readonly total: number }
  readonly compaction?: Compaction.AccountView
  /** Models of the account's slot registered from served Codex rows (10 §6.14): marked `source: "served"`. */
  readonly served?: ReadonlyArray<string>
}

export function account(
  registry: Registry.File,
  info: Account.Info,
  windows: ReadonlyArray<Limit.Window>,
  /** Last step seen in this process (`ledger.line`); the registry's `lastUsedAt` covers earlier runs. */
  lastStepAt?: number,
  extra: Extra = {},
): Account.View {
  const template = registry.modelTemplates[registry.slots[info.providerID]?.modelTemplate ?? ""]
  const marked = (template?.models ?? []).flatMap((model) =>
    model.addedAt === undefined && model.upstream === undefined
      ? []
      : [
          {
            id: model.id,
            ...(model.addedAt === undefined ? {} : { addedAt: model.addedAt }),
            ...(model.upstream === undefined ? {} : { upstream: model.upstream }),
          },
        ],
  )
  const servedMarks = (extra.served ?? []).map((id) => ({ id: Model.ID.make(id), source: "served" as const }))
  const used = [
    info.lastUsedAt === undefined ? Number.NaN : Date.parse(info.lastUsedAt),
    lastStepAt ?? Number.NaN,
  ].filter((at) => !Number.isNaN(at))
  return {
    id: info.id,
    kind: info.kind,
    label: info.label,
    shortLabel: info.shortLabel,
    color: info.color,
    providerID: info.providerID,
    billing: Account.chargeOf(info),
    status: info.status,
    autoSwitch: info.autoSwitch,
    thirdParty: false,
    readOnly: false,
    identity: publicIdentity(info),
    connection: connection(info),
    cacheDomain: domain(registry, info, "cacheDomain"),
    quotaDomain: domain(registry, info, "quotaDomain"),
    limitsSummary: summary(windows, extra.now ?? Date.now()),
    lastUsedAt: used.length === 0 ? null : Math.max(...used),
    budget: info.budget ?? null,
    pollBalance: info.pollBalance ?? null,
    // 04 §8.9: remote use through the credential broker (absent = allow).
    ...(info.remote === undefined ? {} : { remote: info.remote }),
    ...(extra.sessions === undefined ? {} : { sessions: extra.sessions }),
    ...(extra.compaction === undefined ? {} : { compaction: extra.compaction }),
    ...(template?.update === undefined ? {} : { templateUpdate: template.update }),
    ...(marked.length + servedMarks.length === 0 ? {} : { models: [...marked, ...servedMarks] }),
  }
}

/**
 * The synthetic Claude slot account `acc_claude_slot` (02 §9.2): listed while claude-auth is installed, even before
 * the ack. Only its display metadata lives in the registry; connection details belong to the plugins module.
 */
export function claudeSlot(
  registry: Registry.File,
  slot: Plugins.ClaudeSlot,
  windows: ReadonlyArray<Limit.Window>,
  extra: Extra = {},
): Account.View | undefined {
  if (!slot.detected) return undefined
  const meta = registry.claudeSlot
  return {
    id: Account.ID.claudeSlot,
    kind: "claude-sub",
    label: meta?.label ?? "Claude",
    shortLabel: meta?.shortLabel ?? "C",
    color: meta?.color ?? "orange",
    providerID: Provider.ID.make("anthropic"),
    billing: "subscription",
    status: slot.verified ? "ready" : "unverified",
    autoSwitch: false,
    thirdParty: true,
    readOnly: true,
    connection: { type: "oauth", method: "claude-code" },
    limitsSummary: summary(windows, extra.now ?? Date.now()),
    plugin: { installed: true, acknowledged: slot.verified, version: slot.version },
    ...(extra.sessions === undefined ? {} : { sessions: extra.sessions }),
    ...(extra.compaction === undefined ? {} : { compaction: extra.compaction }),
  }
}

/**
 * The account's state: its first window in the one ranking without a model (`LimitRank.ranked`, LV 2026-10-24), the
 * window own-web's cards, dashboard and switcher rows lead with. So a model weekly bucket (`LimitModel.bucket`), which
 * limits one model family, and Claude's extra usage (`LimitRank.extra`), headroom past the plan, never name it.
 */
export function summary(windows: ReadonlyArray<Limit.Window>, now: number): Limit.Summary {
  const lead = LimitRank.ranked(windows, now)[0]
  if (!lead) return { worst: null }
  const facts = LimitRank.facts(lead, now)
  return {
    worst: {
      id: lead.id,
      label: lead.label,
      usedPercent: facts.percent ?? null,
      resetAt: facts.resetAt ?? null,
      status: facts.status,
    },
  }
}

/**
 * How the account is connected (02 §9.2): imported codex accounts from their credential source, linked old-app keys
 * from theirs (provider only, never the file path), others from the stored login method (`Account.Info.method`); a
 * codex account created before the method was stored shows `oauth` without one.
 */
export function connection(info: Account.Info): Account.Connection {
  const credential = info.credential
  if (credential?.type === "linked-legacy-key")
    return {
      type: "key",
      method: "legacy-key-linked",
      legacyKey: {
        app: credential.source.app,
        providerRef: credential.source.providerRef,
        name: credential.source.name,
      },
    }
  if (credential?.type === "linked-codex-source" || credential?.type === "takeover-codex-source") {
    const linked = credential.type === "linked-codex-source"
    return {
      type: "oauth",
      method: linked ? "codex-linked" : "codex-takeover",
      source: {
        app: credential.source.app,
        profileID: credential.source.profileID,
        alias: credential.source.alias,
        mode: linked ? "linked" : "takeover",
        superseded: !linked,
      },
    }
  }
  if (info.kind === "codex")
    return info.method === "chatgpt-device" || info.method === "chatgpt-browser"
      ? { type: "oauth", method: info.method }
      : { type: "oauth" }
  if (info.kind === "siwc") return { type: "oauth", method: "chatgpt-siwc" }
  return { type: "key", method: "api-key" }
}

function publicIdentity(info: Account.Info): Account.Identity {
  const { chatgptAccountId: _account, fingerprint, ...rest } = info.identity
  const login = rest.login ?? (info.kind === "codex" ? fingerprint : undefined)
  return login === undefined ? rest : { ...rest, login }
}

function domain(registry: Registry.File, info: Account.Info, field: "cacheDomain" | "quotaDomain"): Account.DomainRef {
  return {
    id: info[field],
    sharedWith: registry.accounts
      .filter((other) => other.id !== info.id && other[field] === info[field] && other.status !== "retired")
      .map((other) => other.id),
  }
}

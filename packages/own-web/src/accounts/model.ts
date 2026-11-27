// Account presentation rules shared by the accounts page, the 계정·한도 tab, the limits dashboard and settings
// (03 §5.4, §4.7.1): provider grouping and order, type badges, identity lines, "in use", the one-line
// auto-compaction summary (5.8.4), the compat card's server, output cap and running window lines (07 §6.2 #2,
// #7, #8) and model capabilities (02 §3.3), and the card's `템플릿 갱신 있음 [갱신]` (07 §4.4). Pure: no stores, no RPC.
import type { Account, Kind, Policy } from "@own/protocol"
import { Compaction } from "@own/protocol/compaction"
import type { I18n, I18nKey } from "@/i18n"
import { parseTokens, tokens } from "@/limits/format"
import type { FeatureText } from "@/queue/text"
import type { CompatKey } from "./compat-strings"

/**
 * 5.4 section order; the Claude subscription slot always comes last (it is a plugin slot, not an own account), right
 * after Claude Agent (02 §8.10), the other route to a Claude subscription.
 */
export const KIND_ORDER: readonly Kind.Any[] = [
  "codex",
  "siwc",
  "oai",
  "anth",
  "ds",
  "xai",
  "or",
  "compat",
  "claude-agent",
  "claude-sub",
]

/** Kinds whose own slots can be tuned (`claude-sub` is fixed at the v2 default, 02 §4.7.3). */
/** Kinds with a 종류 기본 row in the compaction settings: own's slots and the Claude Agent route (CAG-50). */
export const TUNABLE_KINDS: readonly Compaction.Tunable[] = Compaction.tunable

export const COLORS: readonly Account.Color[] = [
  "indigo",
  "teal",
  "amber",
  "rose",
  "violet",
  "green",
  "slate",
  "orange",
]

/** `@opencode/ui/provider-icon` ids (15.1). */
export function providerIcon(kind: Kind.Any) {
  if (kind === "codex" || kind === "siwc" || kind === "oai") return "openai"
  if (kind === "anth" || kind === "claude-sub" || kind === "claude-agent") return "anthropic"
  if (kind === "ds") return "deepseek"
  if (kind === "xai") return "xai"
  if (kind === "or") return "openrouter"
  return "synthetic"
}

export function kindLabel(i18n: I18n, kind: Kind.Any) {
  return i18n.t(`own.acct.kind.${kind}`)
}

export type TypeTag = "subscription" | "api" | "unofficial"

/** 4.7.1 badge: `구독` / `API` / `비공식` (the Claude slot is always 비공식, 0-11). */
export function typeTag(account: Pick<Account.View, "thirdParty" | "billing">): TypeTag {
  if (account.thirdParty) return "unofficial"
  return account.billing === "subscription" ? "subscription" : "api"
}

export const TYPE_LABEL: Record<TypeTag, I18nKey> = {
  subscription: "own.accounts.type.subscription",
  api: "own.accounts.type.api",
  unofficial: "own.accounts.type.unofficial",
}

/** Imported codex login mode, for the small `연결`/`인수` badge (4.7.1, 5.4.2). */
export function importMode(account: Pick<Account.View, "connection">) {
  return account.connection.source?.mode
}

/**
 * A linked codex login whose source went stale: the router reports `status: "auth_failed"` for it (02 §9.2, with
 * `account.status{reason:"codex_source_stale"}` and the alert), and `ready` again once the old app refreshed.
 */
export function isCodexStale(account: Pick<Account.View, "status" | "connection">) {
  if (account.connection.method !== "codex-linked" && account.connection.source?.mode !== "linked") return false
  return account.status === "auth_failed"
}

const DAY = 24 * 60 * 60_000

/** Running now, or a step in the last 24 hours (03 §4.3 "사용 중 계정 (최근 24시간)"). */
export function inUse(account: Pick<Account.View, "sessions" | "lastUsedAt">, now: number) {
  if ((account.sessions?.running ?? 0) > 0) return true
  return account.lastUsedAt !== undefined && account.lastUsedAt !== null && now - account.lastUsedAt <= DAY
}

/**
 * 4.7.1 order: the session's account, accounts in use, then the rest (server order within each rank), grouped by
 * provider kind; groups follow their best account. Empty kinds are dropped.
 */
export function panelGroups(accounts: readonly Account.View[], currentID: string | undefined, now: number) {
  const rank = (account: Account.View) => (account.id === currentID ? 0 : inUse(account, now) ? 1 : 2)
  const ranked = accounts.map((account, index) => ({ account, index, rank: rank(account) }))
  const groups = Map.groupBy(ranked, (item) => item.account.kind)
  return [...groups.entries()]
    .map(([kind, items]) => ({
      kind,
      ids: items.toSorted((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.account.id),
      best: Math.min(...items.map((item) => item.rank)),
      first: Math.min(...items.map((item) => item.index)),
    }))
    .toSorted((a, b) => a.best - b.best || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.first - b.first)
}

/** 5.4 sections: kind order, server order inside. */
export function pageSections(accounts: readonly Account.View[]) {
  const groups = Map.groupBy(accounts, (account) => account.kind)
  return KIND_ORDER.flatMap((kind) => {
    const items = groups.get(kind)
    return items ? [{ kind, ids: items.map((account) => account.id) }] : []
  })
}

/** `org-…7Qa`, `ws_…3kd` (5.4: ids are shortened; secrets never appear). */
export function shortID(id: string) {
  if (id.length <= 12) return id
  const cut = id.search(/[-_]/)
  const head = cut > 0 && cut <= 7 ? id.slice(0, cut + 1) : id.slice(0, 4)
  return `${head}…${id.slice(-3)}`
}

/**
 * The identity line of a card (5.4 mock): subscriptions `Pro · pe***@gmail.com`; API keys `조직 org-…7Qa · 워크스페이스
 * ws_…3kd · 키 sk-…d41c`. Every value comes from the router's non-secret identity (`keyHint`, masked email).
 */
export function identityParts(i18n: I18n, account: Pick<Account.View, "identity" | "billing" | "thirdParty">) {
  const identity = account.identity
  if (!identity) return []
  if (account.billing === "subscription")
    return [identity.plan ? planLabel(identity.plan) : undefined, identity.emailMasked].filter(
      (part): part is string => !!part,
    )
  return [
    identity.organizationId ? i18n.t("own.acct.org", { id: shortID(identity.organizationId) }) : undefined,
    identity.projectId ? i18n.t("own.acct.project", { id: shortID(identity.projectId) }) : undefined,
    identity.workspaceId ? i18n.t("own.acct.workspace", { id: shortID(identity.workspaceId) }) : undefined,
    identity.teamId ? i18n.t("own.acct.team", { id: shortID(identity.teamId) }) : undefined,
    identity.keyHint ? i18n.t("own.acct.key", { hint: identity.keyHint }) : undefined,
  ].filter((part): part is string => !!part)
}

/** `plus` → `Plus`; plan names are product names and stay in English. */
export function planLabel(plan: string) {
  return plan.length ? plan[0]!.toUpperCase() + plan.slice(1) : plan
}

export interface CompactionSummary {
  /** 5.8.2 source label key. */
  readonly source: I18nKey
  readonly percent: number
  readonly cap: number | null
  readonly reserve: number
}

/**
 * The account card / expanded row line `자동 압축: 종류 기본 · 창의 60% · 최대 256k · 여유 32k` (5.8.4): the account
 * setting when stored, else the kind layer (user change in `policy.compaction.byKind`, else the code constant, which is
 * the model limit for every kind). Per-model overrides are listed in settings, not here.
 */
export function compactionSummary(
  kind: Kind.Any,
  accountSetting: Compaction.Setting | null | undefined,
  byKind: Policy.PolicyCompaction["byKind"] | undefined,
): CompactionSummary {
  // The Claude slot keeps the v2 default; the Claude Agent route takes kind and account layers (CAG-50).
  const userKind = kind === "claude-sub" ? undefined : byKind?.[kind]
  const layers = [
    Compaction.defaults[kind],
    userKind,
    kind === "claude-sub" ? undefined : (accountSetting ?? undefined),
  ]
  const merged = layers.reduce<{
    triggerPercent?: number
    maxTriggerTokens?: number | null
    minReserveTokens?: number
  }>(
    (result, layer) => ({
      ...result,
      ...(layer?.triggerPercent === undefined ? {} : { triggerPercent: layer.triggerPercent }),
      ...(layer?.maxTriggerTokens === undefined ? {} : { maxTriggerTokens: layer.maxTriggerTokens }),
      ...(layer?.minReserveTokens === undefined ? {} : { minReserveTokens: layer.minReserveTokens }),
    }),
    {},
  )
  const source: I18nKey =
    kind !== "claude-sub" && accountSetting
      ? "own.compact.source.account"
      : userKind
        ? "own.compact.source.kind"
        : "own.compact.source.v2"
  return {
    source,
    percent: Compaction.shownPercent(merged.triggerPercent, kind),
    cap: merged.maxTriggerTokens ?? null,
    reserve: merged.minReserveTokens ?? 0,
  }
}

export function compactionSummaryText(i18n: I18n, summary: CompactionSummary) {
  return i18n.t("own.compact.summary", {
    source: i18n.t(summary.source),
    percent: summary.percent,
    cap: summary.cap === null ? "" : ` · ${i18n.t("own.acct.compactCap", { tokens: tokens(summary.cap) })}`,
    reserve: summary.reserve > 0 ? ` · ${i18n.t("own.compact.reserve", { tokens: tokens(summary.reserve) })}` : "",
  })
}

/**
 * 07 §6.2 #2: a compat card keeps `넘침 자동 복구 확인 안 됨 · 서버 창을 정확히 적으세요` until PG9 verified its server's
 * family or own saw core recover from an overflow of that server; the router folds both into `overflowClassified`.
 */
export function compatOverflowWarning(account: Pick<Account.View, "kind" | "compat">) {
  return account.kind === "compat" && account.compat?.server?.overflowClassified !== true
}

/**
 * 07 §6.2 #2, #7: `서버: Ollama · 출력 한도: qwen3:8b 16k(서버 값), llama3 32k(모름)`; the 32k fallback reads `모름`.
 * `undefined` when the router sent nothing about the server or its models.
 */
export function compatFactsText(text: FeatureText<CompatKey>, account: Pick<Account.View, "compat">) {
  const compat = account.compat
  const outputs = (compat?.models ?? []).flatMap((model) =>
    model.output
      ? [
          text("own.compat.output", {
            model: model.id,
            tokens: tokens(model.output.tokens),
            source: text(`own.compat.source.${model.output.source}`),
          }),
        ]
      : [],
  )
  const parts = [
    compat?.server ? text("own.compat.server", { family: text(`own.compat.family.${compat.server.family}`) }) : "",
    outputs.length ? text("own.compat.outputs", { list: outputs.join(", ") }) : "",
  ].filter((part) => part !== "")
  return parts.length ? parts.join(" · ") : undefined
}

/**
 * 02 §3.3: `모델 기능: qwen2.5vl:7b 그림 입력 켬(서버 값) · 도구 켬(서버 값), gemma3:1b 그림 입력 끔(모름) · 도구 끔(직접 정함)`.
 * `undefined` from a service older than the capability settings.
 */
export function compatCapabilitiesText(text: FeatureText<CompatKey>, account: Pick<Account.View, "compat">) {
  const models = (account.compat?.models ?? []).flatMap((model) =>
    model.image && model.tools
      ? [
          text("own.compat.capability", {
            model: model.id,
            image: capabilityValue(text, model.image),
            tools: capabilityValue(text, model.tools),
          }),
        ]
      : [],
  )
  return models.length ? text("own.compat.capabilities", { list: models.join(", ") }) : undefined
}

/** 02 §3.3: some model of the compat account registers without tools (it only chats). */
export function compatWithoutTools(account: Pick<Account.View, "compat">) {
  return (account.compat?.models ?? []).some((model) => model.tools?.on === false)
}

/**
 * 02 §3.3: the `accounts.update{compatCapabilities}` items of the `모델 기능` dialog: only the settings that differ from
 * the account's, per model.
 */
export function compatSettingsChange(
  models: Account.CompatView["models"],
  draft: Readonly<
    Record<
      string,
      {
        readonly image: Account.CompatSetting
        readonly tools: Account.CompatSetting
        /** 02 §3.3a; absent = unchanged (a service older than the reasoning setting lists none). */
        readonly reasoning?: Account.ReasoningSetting
      }
    >
  >,
) {
  return models.flatMap((model) => {
    const next = draft[model.id]
    if (!next || !model.image || !model.tools) return []
    const image = next.image === model.image.setting ? {} : { image: next.image }
    const tools = next.tools === model.tools.setting ? {} : { tools: next.tools }
    const reasoning =
      next.reasoning === undefined ||
      !model.reasoning ||
      JSON.stringify(next.reasoning) === JSON.stringify(model.reasoning.setting)
        ? {}
        : { reasoning: next.reasoning }
    const changed = { ...image, ...tools, ...reasoning }
    return Object.keys(changed).length ? [{ id: model.id, ...changed }] : []
  })
}

function capabilityValue(text: FeatureText<CompatKey>, capability: Account.CompatCapability) {
  const source = capability.setting !== "auto" ? "user" : capability.detected === undefined ? "unknown" : "server"
  return text("own.compat.value", {
    value: text(capability.on ? "own.compat.value.on" : "own.compat.value.off"),
    source: text(`own.compat.from.${source}`),
  })
}

/** 07 §6.2 #8: the running window of each model of a local runtime server (an Ollama compat account), in model order. */
export function runningWindows(account: Pick<Account.View, "compat">) {
  return (account.compat?.models ?? []).flatMap((model) =>
    model.localWindow ? [{ model: model.id, ...model.localWindow }] : [],
  )
}

export type RunningWindow = ReturnType<typeof runningWindows>[number]

/** `qwen3:8b 실행 창 8k · 요청에 필요 27k`, or `… 실행 창 확인 안 됨 …` while the server has not said. */
export function runningWindowText(text: FeatureText<CompatKey>, window: RunningWindow) {
  const needed = tokens(window.needed)
  if (window.runtime === null) return text("own.compat.runtimeUnknown", { model: window.model, needed })
  return text("own.compat.runtime", { model: window.model, runtime: tokens(window.runtime), needed })
}

/**
 * 07 §6.2 #8 "카드에 실행 창과 늘리는 법": the window to raise the server to (the largest a model that does not fit
 * needs), and whether some window is still unknown. `undefined` when every model fits.
 */
export function raiseHint(windows: readonly RunningWindow[]) {
  const short = windows.filter((window) => window.status !== "verified")
  if (!short.length) return undefined
  return {
    needed: Math.max(...short.map((window) => window.needed)),
    unknown: short.some((window) => window.status === "unknown"),
  }
}

/**
 * 07 §4.4 `템플릿 갱신 있음 [갱신]`: a fixed-field change of the kind's pinned template (names, families, reasoning
 * levels …) waits for the user, since those fields reach the request bytes. Shown only where this connection may apply
 * it: `accounts.update` is `local`, so never on a phone or another PC's window. `undefined` = nothing to show.
 */
export function templateUpdate(account: Pick<Account.View, "templateUpdate">, local: boolean) {
  return local ? account.templateUpdate : undefined
}

/**
 * `[갱신]`: re-captures the kind's template for every account of the kind (02 §2.4.2); new sessions and the point right
 * after a compaction use it, running conversations keep theirs. Nothing else in the update.
 */
export function refreshCatalogInput(account: Pick<Account.View, "id">) {
  return { accountID: account.id, refreshCatalog: true }
}

/** The optional output cap of the add-account form: empty is fine, anything else must read as a token count. */
export function outputLimitOf(text: string) {
  if (!text.trim()) return { ok: true as const, value: undefined }
  const value = parseTokens(text)
  return value ? { ok: true as const, value } : { ok: false as const }
}

/** Default name of a new key account: `Anthropic 1`, `Anthropic 2`, … (5.4 "기본값 예"). */
export function defaultLabel(base: string, existing: readonly string[]) {
  const taken = new Set(existing)
  const index = Array.from({ length: existing.length + 1 }, (_, n) => n + 1).find((n) => !taken.has(`${base} ${n}`))
  return `${base} ${index ?? existing.length + 1}`
}

/** First color no account uses yet, else round-robin (the router does the same when none is sent). */
export function nextColor(used: readonly (Account.Color | undefined)[]): Account.Color {
  const taken = new Set(used)
  return COLORS.find((color) => !taken.has(color)) ?? COLORS[used.length % COLORS.length]!
}

/** The account's color token (13.2), as a CSS custom property value. */
export function colorVar(color: Account.Color) {
  return `var(--own-account-${color})`
}

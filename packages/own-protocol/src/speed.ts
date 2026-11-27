export * as Speed from "./speed.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import type { CodexModels } from "./codex-models.js"
import { Estimate } from "./estimate.js"
import { EpochMillis, NonNegative } from "./id.js"

/**
 * Per-session speed (02 §4.8, 03 §4.6, 07 §2.10, user decisions of 2026-10-06): the composer's `속도: 표준 | Fast |
 * Ultrafast`, kept per root session (KV `sess:<root>:speed`, never in a preset) and Standard in every new
 * conversation. A faster speed is a request field, not another model: OpenAI's `service_tier` (Codex, Sign in with
 * ChatGPT, API keys; Fast is `priority`, never `fast`, and Standard sends none) or Anthropic's `speed: "fast"` with
 * the beta header {@link ANTHROPIC_BETA}. Which tiers a session may use comes from the account (a Codex account's own
 * model list, a Sign in with ChatGPT list that names tiers) or from the catalog's model modes (models.dev
 * `experimental.modes`, the `<model>-fast` entries core registers); nothing here names a model, a plan or a price.
 * Pure: own-accounts gathers the candidates, marks and rates, own-web reads the views.
 */

/** The user's speed of a session. */
export const Choice = Schema.Literals(["standard", "fast", "ultrafast"]).annotate({ identifier: "Own.Speed.Choice" })
export type Choice = typeof Choice.Type

/** A speed faster than Standard: what an offer, a mode entry or a tier names. */
export const Faster = Schema.Literals(["fast", "ultrafast"]).annotate({ identifier: "Own.Speed.Faster" })
export type Faster = typeof Faster.Type

/** Fastest first: a choice that cannot be used now falls back along it (Ultrafast → Fast → Standard). */
export const ORDER: ReadonlyArray<Choice> = ["ultrafast", "fast", "standard"]

/**
 * Anthropic's beta header value that `speed: "fast"` needs. It is part of the prompt cache key, so once a conversation
 * sent it the header stays on its later requests (Standard ones too) and only `speed` varies, as Claude Code does.
 */
export const ANTHROPIC_BETA = "fast-mode-2026-02-01"

/** OpenAI's request value of Fast. The API also takes `fast`, but own sends only the value Codex sends. */
export const PRIORITY = "priority"

/** How a provider takes a tier: the OpenAI family's body `service_tier`, or Anthropic's body `speed` plus the beta. */
export const Wire = Schema.Literals(["service_tier", "speed"]).annotate({ identifier: "Own.Speed.Wire" })
export type Wire = typeof Wire.Type

/** Where an offer comes from: the account's own model list, or the catalog's model modes. */
export const Basis = Schema.Literals(["account", "catalog"]).annotate({ identifier: "Own.Speed.Basis" })
export type Basis = typeof Basis.Type

/**
 * `available`: listed for this account, or an API catalog mode. `unverified`: offered from the catalog for an account
 * whose list does not name tiers (Sign in with ChatGPT) or was not read yet; the provider's answer decides.
 * `unavailable`: the provider refused it for this account and model, until its list is read again. `cooldown`:
 * Anthropic's fast rate limit, until `until`.
 */
export const Status = Schema.Literals(["available", "unverified", "unavailable", "cooldown"]).annotate({
  identifier: "Own.Speed.Status",
})
export type Status = typeof Status.Type

/**
 * What a tier costs, for the composer's badge (03 §4.6): `plan` = usage times `included` on the plan's included usage
 * and `credits` on purchased credits (`codex`, `siwc`; `null` = not known); `api` = the catalog's mode price in USD per
 * 1M tokens; `extra` = the same price billed to the Claude subscription's usage credits, never its plan limits.
 */
export const Billing = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("plan"),
    included: Schema.NullOr(NonNegative),
    credits: Schema.NullOr(NonNegative),
  }),
  Schema.Struct({ type: Schema.Literal("api"), input: NonNegative, output: NonNegative }),
  Schema.Struct({ type: Schema.Literal("extra"), input: NonNegative, output: NonNegative }),
]).annotate({ identifier: "Own.Speed.Billing" })
export type Billing = typeof Billing.Type

/** One speed a session's main may use: the request value (`tier`) and how it is sent, known and billed. */
export interface Offer extends Schema.Schema.Type<typeof Offer> {}
export const Offer = Schema.Struct({
  choice: Faster,
  tier: Schema.NonEmptyString,
  wire: Wire,
  basis: Basis,
  status: Status,
  /** `cooldown`: when it ends. */
  until: optional(EpochMillis),
  /** `unavailable`/`cooldown`: why (the provider's code or status). */
  reason: optional(Schema.String),
  /** The label and description the account's list gives (`Fast`, `2x speed, increased usage`). */
  name: optional(Schema.String),
  description: optional(Schema.String),
  billing: optional(Billing),
}).annotate({ identifier: "Own.Speed.Offer" })

/**
 * KV `sess:<sid>:speed`. `choice`: a root's speed (absent = Standard); a child keeps none and follows its root
 * ({@link inherit}). `beta`: the first request of this session that sent the Anthropic beta header, and its model; the
 * header stays until the model changes or a compaction rebuilds the prefix.
 */
export interface State extends Schema.Schema.Type<typeof State> {}
export const State = Schema.Struct({
  choice: optional(Choice),
  setAt: optional(EpochMillis),
  beta: optional(Schema.Struct({ since: EpochMillis, modelID: Model.ID })),
}).annotate({ identifier: "Own.Speed.State" })

/** KV `ack:claudeFast`: when the user accepted that Fast on the Claude subscription slot is billed to usage credits. */
export interface Consent extends Schema.Schema.Type<typeof Consent> {}
export const Consent = Schema.Struct({ at: EpochMillis }).annotate({ identifier: "Own.Speed.Consent" })

/** The tier the provider named for the session's last faster request (02 §4.8). */
export interface Served extends Schema.Schema.Type<typeof Served> {}
export const Served = Schema.Struct({
  requested: Schema.String,
  /** `null`: the response did not say. */
  served: Schema.NullOr(Schema.String),
  /** Served at another speed than sent ({@link downgraded}): the badge turns grey. */
  downgraded: Schema.Boolean,
  at: EpochMillis,
}).annotate({ identifier: "Own.Speed.Served" })

/**
 * Why a main offers no faster speed, so the composer and the switcher grey `속도` with a reason instead of hiding it:
 * `provider` = own does not run the provider (a built-in or local one, or the Claude subscription slot is not set up);
 * `kind` = the account's kind has no speed tier (DeepSeek, xAI, OpenRouter, compat); `model` = this account and model
 * list no faster tier now (a Codex plan without priority, a model without fast modes); `session` = the session is not
 * known yet (an optimistic create still on its way; the client reads again on `session.created`).
 */
export const None = Schema.Literals(["provider", "kind", "model", "session"]).annotate({ identifier: "Own.Speed.None" })
export type None = typeof None.Type

/** `session.speed.get` (02 §9.2): a session's speed as its next request would send it. */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  sessionID: SessionID,
  /** The root whose choice applies; the session itself for a root. */
  root: SessionID,
  /** The stored choice of the root. */
  choice: Choice,
  /** What the next request sends after the fallback ({@link resolve}) or, for a child, {@link inherit}. */
  effective: Choice,
  /** The request value of `effective`; `null` for Standard. */
  tier: Schema.NullOr(Schema.String),
  /** What the session's main (account and model) offers now, Fast first. Empty without a faster tier. */
  offers: Schema.Array(Offer),
  /** The main is a catalog mode entry (`gpt-6-astra-fast`): its speed is the model's, the control is off. */
  fixed: optional(Faster),
  /** The Claude subscription slot: whether the one-time usage-credit consent is still `needed`. */
  consent: optional(Schema.Literals(["needed", "given"])),
  /** Anthropic: this conversation already sends the beta header (turning Fast off and on keeps the cache). */
  beta: Schema.Boolean,
  served: optional(Served),
  /** Why `offers` is empty and nothing is `fixed`; absent from an older service. */
  none: optional(None),
}).annotate({ identifier: "Own.Speed.View" })

/**
 * `speed.offers` (02 §4.8, 2026-10-10): what a main (account and model) offers before a session runs on it, for the
 * new-conversation composer and the switcher's speed row. Same facts as {@link View} without a session's choice.
 */
export interface Targeted extends Schema.Schema.Type<typeof Targeted> {}
export const Targeted = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  offers: Schema.Array(Offer),
  fixed: optional(Faster),
  consent: optional(Schema.Literals(["needed", "given"])),
  none: optional(None),
}).annotate({ identifier: "Own.Speed.Targeted" })

/**
 * Why a speed changed (`session.speed.changed`). `downgraded`: a response was served slower than sent, the first of a
 * run (a passing downgrade, or the start of {@link IGNORED_AFTER}). `ignored`: the provider kept serving a tier it never
 * honored for the account and model, so the tier is marked unavailable and the speed falls back as on a refusal.
 */
export const Reason = Schema.Literals(["user", "fallback", "cooldown", "downgraded", "ignored", "recovered"]).annotate({
  identifier: "Own.Speed.Reason",
})
export type Reason = typeof Reason.Type

/**
 * The estimate's warnings: the cache retention across a tier change is a rule, not measured (`cache_unverified`);
 * Anthropic's first fast request writes the whole prefix again at the fast price (`first_fast_rewrite`); a rate is not
 * known (`rate_unknown`); the cost goes to the Claude subscription's usage credits (`extra_usage`); the tier is offered
 * from the catalog only (`unverified_tier`).
 */
export const ChangeWarning = Schema.Literals([
  "cache_unverified",
  "first_fast_rewrite",
  "rate_unknown",
  "extra_usage",
  "unverified_tier",
]).annotate({ identifier: "Own.Speed.ChangeWarning" })
export type ChangeWarning = typeof ChangeWarning.Type

/**
 * The cost of a speed-only change (`session.speed.set{dryRun}`, 02 §6.3 ⑬): the prompt bytes stay the same, so only the
 * cache and the price change. `delta` compares the first request after the change with staying: `lo` with the cache
 * kept, `hi` with it lost (`null` when a rate is unknown). `factor`: the per-request price after the change over the
 * one before. `cache`: what own expects (`basis: "measured"` once this kind's tier changes were observed).
 */
export interface Change extends Schema.Schema.Type<typeof Change> {}
export const Change = Schema.Struct({
  from: Choice,
  to: Choice,
  /** The next request's input (02 §6.1 `P`). */
  P: NonNegative,
  unit: Estimate.Unit,
  delta: Schema.NullOr(Estimate.Delta),
  factor: Schema.NullOr(NonNegative),
  cache: Schema.Literals(["kept", "lost", "unknown"]),
  basis: Schema.Literals(["rule", "measured"]),
  warnings: Schema.Array(ChangeWarning),
}).annotate({ identifier: "Own.Speed.Change" })

/**
 * The choice a tier names: OpenAI's `priority` (also its `fast` alias, or a tier the list calls Fast) is Fast,
 * `ultrafast` Ultrafast. `default`, `flex`, `auto` and any other tier are no speed of the composer.
 */
export function choiceOf(tier: { readonly id: string; readonly name?: string }): Faster | undefined {
  const id = tier.id.toLowerCase()
  if (id === PRIORITY || id === "fast") return "fast"
  if (id === "ultrafast") return "ultrafast"
  if (id === "default" || id === "standard") return undefined
  const name = tier.name?.toLowerCase().replace(/[\s_-]/g, "")
  if (name === "fast") return "fast"
  return name === "ultrafast" ? "ultrafast" : undefined
}

/** The `service_tier` own sends for a listed tier id: the id, with `fast` sent as `priority`; never `default`. */
export function requestTier(id: string): string | undefined {
  if (id === "default" || id === "standard") return undefined
  return id === "fast" ? PRIORITY : id
}

/**
 * The speed of a catalog mode entry: core registers models.dev's `experimental.modes` as models of their own
 * (`<model>-fast`, `<model>-ultrafast`, `modelID` = the base model), whose prompt prefix differs from the base model's.
 * Pickers hide them (02 §4.8); sessions already on one keep running. `undefined` for a base model or another mode.
 */
export function modeOf(model: { readonly id: string; readonly modelID?: string }): Faster | undefined {
  const base = model.modelID
  if (base === undefined || base === model.id) return undefined
  if (model.id === `${base}-fast`) return "fast"
  return model.id === `${base}-ultrafast` ? "ultrafast" : undefined
}

/** A tier before the account's marks: where it comes from, whether it is confirmed for the account, what it costs. */
export interface Candidate {
  readonly choice: Faster
  readonly tier: string
  readonly wire: Wire
  readonly basis: Basis
  /** Confirmed for this account (its own list, or an API catalog mode); else a guess the provider's answer decides. */
  readonly verified: boolean
  readonly name?: string
  readonly description?: string
  readonly billing?: Billing
}

/** The tiers an account's model list names for a model (a Codex row's `service_tiers`), as candidates. */
export function listed(
  tiers: ReadonlyArray<CodexModels.Tier>,
  input: { readonly verified?: boolean; readonly billing?: (tier: string) => Billing | undefined } = {},
): Candidate[] {
  return tiers.flatMap((tier) => {
    const choice = choiceOf(tier)
    const request = requestTier(tier.id)
    if (!choice || !request) return []
    const billing = input.billing?.(request)
    return [
      {
        choice,
        tier: request,
        wire: "service_tier" as const,
        basis: "account" as const,
        verified: input.verified ?? true,
        ...(tier.name ? { name: tier.name } : {}),
        ...(tier.description ? { description: tier.description } : {}),
        ...(billing ? { billing } : {}),
      },
    ]
  })
}

/** A catalog model as {@link modes} reads it: core's `Model.Info` or an own template entry. */
export interface ModeEntry {
  readonly id: string
  readonly modelID?: string
  readonly body?: Readonly<Record<string, unknown>>
}

/**
 * The speeds the catalog's mode entries of `base` offer: an OpenAI-family mode's `body.service_tier` (sent as
 * {@link requestTier}) or an Anthropic mode's `body.speed` (with the beta header). Other modes (`-pro`, `-flex`) and
 * entries of other models are skipped.
 */
export function modes<E extends ModeEntry>(
  entries: ReadonlyArray<E>,
  base: string,
  input: { readonly verified?: boolean; readonly billing?: (entry: E) => Billing | undefined } = {},
): Candidate[] {
  return entries.flatMap((entry): Candidate[] => {
    const choice = modeOf(entry)
    if (!choice || entry.modelID !== base) return []
    const billing = input.billing?.(entry)
    const common = {
      choice,
      basis: "catalog" as const,
      verified: input.verified ?? true,
      ...(billing ? { billing } : {}),
    }
    const tier = entry.body?.service_tier
    const request = typeof tier === "string" ? requestTier(tier) : undefined
    if (request) return [{ ...common, tier: request, wire: "service_tier" }]
    const speed = entry.body?.speed
    return typeof speed === "string" && speed !== "" ? [{ ...common, tier: speed, wire: "speed" }] : []
  })
}

/** What the provider said about a tier for an account and model (02 §4.8): refused until a refresh, or cooling. */
export interface Mark {
  readonly tier: string
  readonly status: "unavailable" | "cooldown"
  readonly reason: string
  /** A mark with a past `until` no longer applies. */
  readonly until?: number
}

/**
 * The offers of a model, Fast first: one per choice (an account's own list beats the catalog, a confirmed candidate
 * a guess), with the account's marks applied at `now`.
 */
export function offers(candidates: ReadonlyArray<Candidate>, marks: ReadonlyArray<Mark>, now: number): Offer[] {
  const rank = (candidate: Candidate) => (candidate.basis === "account" ? 0 : 2) + (candidate.verified ? 0 : 1)
  return Faster.literals.flatMap((choice) => {
    const candidate = candidates.filter((item) => item.choice === choice).toSorted((a, b) => rank(a) - rank(b))[0]
    if (!candidate) return []
    const mark = marks.find((item) => item.tier === candidate.tier && (item.until === undefined || item.until > now))
    const status: Status = mark ? mark.status : candidate.verified ? "available" : "unverified"
    return [
      {
        choice,
        tier: candidate.tier,
        wire: candidate.wire,
        basis: candidate.basis,
        status,
        ...(mark?.until === undefined ? {} : { until: mark.until }),
        ...(mark ? { reason: mark.reason } : {}),
        ...(candidate.name ? { name: candidate.name } : {}),
        ...(candidate.description ? { description: candidate.description } : {}),
        ...(candidate.billing ? { billing: candidate.billing } : {}),
      },
    ]
  })
}

/** An offer a request may send now: `available`, or `unverified` (the provider's answer decides). */
export function usable(offer: Pick<Offer, "status">) {
  return offer.status === "available" || offer.status === "unverified"
}

/** The speed a request sends: `effective`, its offer (absent for Standard), and whether it fell short of the choice. */
export interface Resolved {
  readonly effective: Choice
  readonly offer?: Offer
  readonly fell: boolean
}

/**
 * The speed a root's request sends for `choice` (decision 6): the choice when usable, else the next slower usable one
 * (Ultrafast → Fast → Standard). `fell` tells the composer to show the notice and the grey badge.
 */
export function resolve(choice: Choice, list: ReadonlyArray<Offer>): Resolved {
  const steps = ORDER.slice(ORDER.indexOf(choice))
  const found = steps.flatMap((step): Resolved[] => {
    if (step === "standard") return [{ effective: step, fell: choice !== "standard" }]
    const offer = list.find((item) => item.choice === step && usable(item))
    return offer ? [{ effective: step, offer, fell: step !== choice }] : []
  })[0]
  return found ?? { effective: "standard", fell: choice !== "standard" }
}

/**
 * A subagent's speed (07 §2.10, as Codex shares the root's tier with its agent tree): the root's effective speed when
 * the child runs on the root main's account (`메인과 같게`, the account's lighter model, a pin on that same account)
 * and its own model lists that same speed; Standard otherwise, never a slower fallback. A child on another account or
 * provider never inherits.
 */
export function inherit(input: {
  readonly root: { readonly providerID: string; readonly effective: Choice }
  readonly child: { readonly providerID: string; readonly offers: ReadonlyArray<Offer> }
}): Resolved {
  const wanted = input.root.effective
  if (wanted === "standard" || input.child.providerID !== input.root.providerID)
    return { effective: "standard", fell: false }
  const offer = input.child.offers.find((item) => item.choice === wanted && usable(item))
  return offer ? { effective: wanted, offer, fell: false } : { effective: "standard", fell: true }
}

/**
 * Answers in a row served slower than sent, with the tier never honored for the account and model, after which the
 * provider is taken not to offer it there (`ignored`, 02 §4.8): an account list that names a tier the provider then
 * serves at `default` every time. A tier honored once is never marked this way; its later downgrades are passing ones.
 */
export const IGNORED_AFTER = 3

/**
 * Whether a response served another speed than the one sent (a silent downgrade): OpenAI's `service_tier: "default"`
 * for a `priority` request, Anthropic's `usage.speed: "standard"` for `fast`. `priority` and its `fast` alias are the
 * same speed. An unreported tier is no downgrade.
 */
export function downgraded(requested: string, served: string | null | undefined) {
  if (served === null || served === undefined) return false
  return choiceOf({ id: served }) !== choiceOf({ id: requested })
}

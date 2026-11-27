// The composer's `속도` (02 §4.8, 03 §4.6): what the button says, the menu's items and badges, whether a change shows
// the cost dialog or the Claude subscription's one-time consent, and the dialog's lines. Pure over the service's
// `session.speed.get` and `session.speed.set{dryRun}` answers; the UI never computes a cost (03 P10). A remote
// session's Fast consent is recorded on this PC (04 §8.11.9, `setSpeed`). Since 2026-10-10 the control is grey with a
// reason instead of hidden when a main offers nothing, and a new conversation (and the switcher's 속도 row) shows the
// target's `speed.offers` with a pending choice (`pendingView`).
import { Speed } from "@own/protocol/speed"
import { OwnRpcError } from "@/data/rpc"
import type { I18n } from "@/i18n"
import { coming } from "@/limits/format"
import { formatDelta } from "@/switcher/format"

/** `표준`, `Fast`, `Ultrafast`. */
export function speedName(i18n: I18n, choice: Speed.Choice) {
  return i18n.t(
    choice === "standard" ? "own.speed.standard" : choice === "fast" ? "own.speed.fast" : "own.speed.ultrafast",
  )
}

/**
 * An offer's badge (decision 3): `Fast · 한도 ×2.5` on a plan (`codex`, `siwc`), `Fast · $8/$40` with an API key,
 * `Fast · 추가 사용량 $8/$40` on the Claude subscription slot; `확인 전` while the account's list does not name it,
 * `42분 후까지 쉼` during Anthropic's cooldown (a coming time, `@/limits/format` `coming`). The screens put the speed's
 * mark (speed-mark.tsx) in front of it.
 */
export function offerBadge(i18n: I18n, offer: Speed.Offer, now = Date.now()) {
  const name = speedName(i18n, offer.choice)
  const billing = offer.billing
  const main =
    billing?.type === "plan" && billing.included !== null
      ? i18n.t("own.speed.badge.plan", { name, times: trim(billing.included) })
      : billing?.type === "api"
        ? i18n.t("own.speed.badge.api", { name, input: trim(billing.input), output: trim(billing.output) })
        : billing?.type === "extra"
          ? i18n.t("own.speed.badge.extra", { name, input: trim(billing.input), output: trim(billing.output) })
          : name
  const notes = [
    ...(offer.status === "unverified" ? [i18n.t("own.speed.unverified")] : []),
    ...(offer.status === "cooldown" && offer.until !== undefined
      ? [i18n.t("own.speed.cooldown", { time: coming(i18n, now, offer.until) })]
      : []),
  ]
  return [main, ...notes].join(" · ")
}

/**
 * What the control shows: a session's `session.speed.get` view, or a new conversation's pending choice on the
 * target's `speed.offers` ({@link pendingView}).
 */
export type Shown = Pick<Speed.View, "choice" | "effective" | "offers" | "fixed" | "consent" | "served" | "none">

/**
 * A new conversation's control, and the switcher's row (2026-10-10): the pending choice resolved on what the target
 * offers now, as a request would send it (Ultrafast → Fast → Standard). The Claude slot without the consent sends
 * Standard unless the consent card was accepted for this choice (`consented`).
 */
export function pendingView(target: Speed.Targeted, choice: Speed.Choice, consented = false): Shown {
  const resolved = Speed.resolve(choice, target.offers).effective
  const blocked = target.consent === "needed" && !consented
  return {
    choice,
    effective: target.fixed ?? (blocked ? "standard" : resolved),
    offers: target.offers,
    ...(target.fixed ? { fixed: target.fixed } : {}),
    ...(target.consent ? { consent: target.consent } : {}),
    ...(target.none ? { none: target.none } : {}),
  }
}

/** One menu row: Standard and each offer the main has; a refused or cooling one disabled with its note. */
export interface Item {
  readonly choice: Speed.Choice
  readonly offer?: Speed.Offer
  readonly disabled: boolean
}

export function items(view: Shown): Item[] {
  return [
    { choice: "standard", disabled: false },
    ...view.offers.map((offer) => ({ choice: offer.choice, offer, disabled: !Speed.usable(offer) })),
  ]
}

/**
 * Whether the control can be changed: a main with a faster speed (even a refused one, shown disabled), or a choice
 * to undo. Otherwise it stays on screen grey with {@link noneNote}; a fixed-speed model shows its speed, also grey.
 */
export function active(view: Shown | undefined) {
  return !!view && view.fixed === undefined && (view.offers.length > 0 || view.choice !== "standard")
}

/** Why the control is grey: the service's `none`, or a generic line from an older service. */
export function noneNote(i18n: I18n, view: Shown) {
  if (view.fixed !== undefined) return undefined
  if (view.none === "provider") return i18n.t("own.speed.none.provider")
  if (view.none === "kind") return i18n.t("own.speed.none.kind")
  if (view.none === "model") return i18n.t("own.speed.none.model")
  if (view.none === "session") return i18n.t("own.speed.none.session")
  return i18n.t("own.speed.none.unknown")
}

/**
 * Why the service refused a faster tier, from its refusal code (a `fallback`'s `cause`, a refused offer's `reason`):
 * `unsupported_tier` (the Codex backend's `Unsupported service_tier`), token sharing's unsupported capability, no
 * usage credits, or an HTTP status. `undefined` for a code that says nothing more (`rejected`).
 */
export function refusalWhy(i18n: I18n, reason: string | undefined) {
  if (reason === "unsupported_tier") return i18n.t("own.speed.why.unsupported")
  if (reason === "subscription_sharing_unsupported_capability") return i18n.t("own.speed.why.sharing")
  if (reason === "usage_credits") return i18n.t("own.speed.why.credits")
  const status = reason === undefined ? undefined : /^status_(\d{3})$/.exec(reason)?.[1]
  return status === undefined ? undefined : i18n.t("own.speed.why.status", { status })
}

/** A menu row's hover note: why a refused or cooling speed cannot be picked now. */
export function offerNote(i18n: I18n, offer: Speed.Offer, now = Date.now()) {
  if (offer.status === "unavailable" && offer.reason === "ignored") return i18n.t("own.speed.ignoredNote")
  if (offer.status === "unavailable") {
    const why = refusalWhy(i18n, offer.reason)
    return why === undefined ? i18n.t("own.speed.refused") : i18n.t("own.speed.refusedWhy", { why })
  }
  if (offer.status === "cooldown" && offer.until !== undefined)
    return i18n.t("own.speed.cooldown", { time: coming(i18n, now, offer.until) })
  return offer.description
}

/**
 * The button: `속도: 표준`, `Fast`, `Ultrafast` (what the next request sends) behind its `mark` (speed-mark.tsx), grey
 * with a note when it falls short of the choice (refused, cooling, the Claude consent missing) or the last response
 * was served at Standard.
 */
export function button(i18n: I18n, view: Shown) {
  if (view.fixed)
    return { label: i18n.t("own.speed.fixed", { speed: speedName(i18n, view.fixed) }), mark: view.fixed, dim: false }
  const mark = view.effective
  const label =
    view.effective === "standard"
      ? i18n.t("own.speed.button", { speed: speedName(i18n, "standard") })
      : speedName(i18n, view.effective)
  if (view.effective !== view.choice)
    return {
      label,
      mark,
      dim: true,
      note: i18n.t("own.speed.fell", {
        choice: speedName(i18n, view.choice),
        effective: speedName(i18n, view.effective),
      }),
    }
  if (view.served?.downgraded && view.effective !== "standard")
    return { label, mark, dim: true, note: i18n.t("own.speed.downgraded") }
  return { label, mark, dim: false }
}

/** Whether choosing `to` first asks for the Claude subscription's one-time usage-credit consent. */
export function needsConsent(view: Pick<Shown, "consent">, to: Speed.Choice) {
  return to !== "standard" && view.consent === "needed"
}

/**
 * Whether a change shows the cost dialog first: a faster speed whose next request may cost more, or whose cache or
 * availability is not verified. Back to Standard (cheaper, the beta stays) applies at once.
 */
export function needsDialog(change: Speed.Change | null, to: Speed.Choice) {
  if (to === "standard" || !change) return false
  return (change.delta?.hi ?? 0) > 0 || change.warnings.length > 0 || (change.factor ?? 1) > 1
}

/**
 * The cost dialog's lines: the next request's Δ, the per-request factor, then each warning. With `consent` the
 * consent card already says that Fast bills usage credits, so that warning is left out.
 */
export function changeLines(i18n: I18n, change: Speed.Change, input: { readonly consent?: boolean } = {}) {
  const notes: Readonly<Partial<Record<Speed.ChangeWarning, Parameters<I18n["t"]>[0]>>> = {
    cache_unverified: "own.speed.dialog.cacheUnknown",
    first_fast_rewrite: "own.speed.dialog.firstFast",
    unverified_tier: "own.speed.dialog.unverified",
    rate_unknown: "own.speed.dialog.rateUnknown",
    extra_usage: "own.speed.consent.body",
  }
  return [
    ...(change.delta ? [i18n.t("own.speed.dialog.first", { delta: formatDelta(i18n, change.delta) })] : []),
    ...(change.factor !== null && change.factor !== 1
      ? [i18n.t("own.speed.dialog.factor", { times: trim(change.factor) })]
      : []),
    ...change.warnings.flatMap((warning) => {
      const key = input.consent && warning === "extra_usage" ? undefined : notes[warning]
      return key ? [i18n.t(key)] : []
    }),
  ]
}

/**
 * The toast of a speed change the service made (`session.speed.changed`); `undefined` for the user's own. The service
 * announces only the first slower answer of a run (`downgraded`) and a tier it then takes as not offered (`ignored`).
 */
export function notice(
  i18n: I18n,
  reason: Speed.Reason,
  effective: Speed.Choice,
  choice: Speed.Choice = effective,
  cause?: string,
) {
  if (reason === "fallback") {
    const why = refusalWhy(i18n, cause)
    const speed = speedName(i18n, effective)
    return why === undefined
      ? i18n.t("own.speed.toast.fallback", { speed })
      : i18n.t("own.speed.toast.fallbackWhy", { speed, why })
  }
  if (reason === "cooldown") return i18n.t("own.speed.toast.cooldown")
  if (reason === "downgraded") return i18n.t("own.speed.toast.downgraded", { speed: speedName(i18n, effective) })
  if (reason === "ignored")
    return i18n.t("own.speed.toast.ignored", {
      choice: speedName(i18n, choice),
      speed: speedName(i18n, effective),
    })
  if (reason === "recovered") return i18n.t("own.speed.toast.recovered", { speed: speedName(i18n, effective) })
  return undefined
}

/** 04 §8.11.9: how long a remote session waits for this PC's Fast consent to reach its host (the mirror push). */
export const CONSENT_REACH_MS = 10_000
const CONSENT_RETRY_MS = 500

/**
 * Whether the service refused for the Claude subscription's missing Fast consent, and where that consent is recorded:
 * `local` from a remote service (04 §8.11.9: on this PC, never on the host), else `here` (`consent: true`).
 */
export function consentRequired(error: unknown) {
  if (!(error instanceof OwnRpcError) || error.type !== "speed_consent_required") return undefined
  const data = error.data
  return typeof data === "object" && data !== null && "recordOn" in data && data.recordOn === "local" ? "local" : "here"
}

export interface SpeedCalls<T> {
  /** `session.speed.set` of the change on the session's own server, with `consent: true` when asked. */
  readonly set: (consent: boolean) => Promise<T>
  /** This PC's `plugin.claudeAuth.fastAck` (04 §8.11.9). */
  readonly fastAck: () => Promise<unknown>
}

/**
 * Applies a speed change; `consent` after the consent card. The consent goes with the change to the session's server,
 * except for a remote session (`local`, or a server that answers `speed_consent_required{recordOn: "local"}`): this
 * PC records it (`fastAck`), then the host's `session.speed.set` is asked again until the consent reached it, for at
 * most {@link CONSENT_REACH_MS} (a bounded wait, not a poll).
 */
export async function setSpeed<T>(
  calls: SpeedCalls<T>,
  input: { readonly consent: boolean; readonly local: boolean },
  timing: { readonly retryMs: number; readonly waitMs: number } = {
    retryMs: CONSENT_RETRY_MS,
    waitMs: CONSENT_REACH_MS,
  },
): Promise<T> {
  if (!input.consent) return calls.set(false)
  if (!input.local) {
    const recorded = await calls.set(true).then(
      (result) => ({ result }),
      (error: unknown) => {
        if (consentRequired(error) === "local") return undefined
        throw error
      },
    )
    if (recorded) return recorded.result
  }
  await calls.fastAck()
  const deadline = Date.now() + timing.waitMs
  for (;;) {
    const answer = await calls.set(false).then(
      (result) => ({ result }),
      (error: unknown) => {
        if (consentRequired(error) && Date.now() < deadline) return undefined
        throw error
      },
    )
    if (answer) return answer.result
    await new Promise((resolve) => setTimeout(resolve, timing.retryMs))
  }
}

/** `2.5`, `8`, `0.4`: at most two decimals, no trailing zeros. */
function trim(value: number) {
  return String(Math.round(value * 100) / 100)
}

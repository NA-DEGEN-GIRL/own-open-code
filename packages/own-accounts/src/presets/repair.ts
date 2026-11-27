export * as PresetRepair from "./repair.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { CodexModels, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { CodexMeta } from "../slots/codex-meta.js"
import { Registration } from "../slots/registration.js"
import { Templates } from "../slots/templates.js"
import type { Telemetry } from "../telemetry/telemetry.js"
import type { Variant } from "../switching/variant.js"
import type { PresetResolve } from "./resolve.js"

/**
 * Owner: PRESETS (07 §4.3). Repair notices for what the catalog took away. Nothing here changes a preset, a lighter
 * pair, a group default or a session's main (U3): it only tells, and the user fixes.
 * - The presence check (`PresetStore` `repairs`, `Preset.presence`) runs again {@link SETTLE_MS} after
 *   `models-dev.refreshed`, a provider refold of this Location and a `presets.json` change, which come in bursts. A
 *   model that is newly gone raises one alert, however many presets, groups or accounts use it: `preset_needs_repair`
 *   for pinned targets and lighter pairs, `group_default_model_missing` for new-session defaults. It stays announced
 *   while anything still uses it gone; one that comes back (or is no longer used) and goes again is a new event.
 *   Whenever the standing notices change, `presets.changed` tells clients to read `presets.list` again (presets.json
 *   itself did not change). Every instance follows the events so a new leader knows what was announced; only the
 *   leader raises them. The memory is the process's, so a restart announces a model still gone once more. A remote
 *   service runs no check: it mirrors this PC's registry, whose notices are the only ones.
 * - The subagent gate resolves each call again (`Preset.resolve`): a gone pin hands over to the role's next target,
 *   else the role runs like the main; a pair marked gone is never decided again.
 * - A root's main ({@link Api.main}): its model, or its level, gone from what its account offers. `session.preset.get`
 *   says so with the switch to offer, and a user prompt to such a root raises `session_model_unavailable` or
 *   `session_variant_unavailable`. Core fails that step itself (`ModelUnavailableError`, `VariantUnavailableError`): a
 *   promise prompt hook cannot refuse a prompt cleanly, so own-web holds the next message. The guard never throws and
 *   never switches.
 */
export interface Api extends Module.Lifecycle {
  /** The state of a root's main for `session.preset.get` (07 §4.3); `undefined` while it runs. */
  main(ref: Variant.Ref): Promise<Main | undefined>
  /** Runs the presence check now, after one already running; resolves once it has raised what is new. */
  check(): Promise<void>
}

/** `session.preset.get` `main`: what is gone, and the 02 switch to offer. */
export type Main = NonNullable<Preset.SessionView["main"]>

/** Catalog refreshes and provider refolds come in bursts (every Location, every registry change). */
export const SETTLE_MS = 2_000

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("presets.repair")
  const state = {
    /** Each standing notice (`<code>\n<model>`) and when its model event was first seen. */
    announced: new Map<string, number>(),
    chain: Promise.resolve(),
    cancel: undefined as (() => void) | undefined,
    stops: [] as Array<() => void>,
  }

  const run = async () => {
    const notices = (await peers().presets.repairs()).flatMap(alertsOf)
    const previous = state.announced
    const now = deps.clock.now()
    state.announced = new Map(notices.map((notice) => [notice.key, previous.get(notice.key) ?? now]))
    const fresh = notices.filter((item) => !previous.has(item.key))
    if (fresh.length === 0 && [...previous.keys()].every((key) => state.announced.has(key))) return
    if (!deps.runtime.isLeader()) return
    // The rows of `presets.list` changed without presets.json changing: clients read them again. Leader only: every
    // Location runs this check, and one event is enough.
    await deps.emitter.global("presets.changed", {})
    // The event time in the subject: a model that comes back and goes again is a new notice.
    for (const notice of fresh)
      peers().telemetry.alert({ ...notice.alert, subject: `${notice.key}\n${state.announced.get(notice.key)}` })
  }

  const check = () => {
    const next = state.chain.then(run).catch((error: unknown) => log.warn("preset_repair_check_failed", { error }))
    state.chain = next
    return next
  }

  const schedule = () => {
    state.cancel?.()
    state.cancel = deps.clock.schedule(SETTLE_MS, () => {
      state.cancel = undefined
      void check()
    })
  }

  const main = async (ref: Variant.Ref): Promise<Main | undefined> => {
    const presets = peers().presets
    const current = await presets.resolver.main(ref)
    const offer = current && (await presets.resolver.inventory(current.account))
    // A main outside every group, or on an account that is gone, belongs to 02's switch flows.
    if (!offer) return undefined
    const codex = offer.kind === "codex" ? await CodexMeta.snapshot(deps) : undefined
    // The session's own level fitted to a model's levels (07 §2.3), in Codex's order on a codex account.
    const fit = (id: string, variants: ReadonlyArray<string>): Preset.Choice => {
      const level = Preset.effortToVariant(ref.variant, variants, CodexModels.find(codex, id)).variant
      return { id: Model.ID.make(id), ...(level === undefined ? {} : { variant: Model.VariantID.make(level) }) }
    }
    const row = offer.models.find((model) => model.id === ref.id)
    if (row?.enabled) {
      const levels = row.variants.map((variant) => variant.id)
      // No level, or `default`, is the provider default and always runs.
      if (ref.variant === undefined || ref.variant === "default" || levels.includes(ref.variant)) return undefined
      return { missing: "variant", suggestion: fit(ref.id, levels) }
    }
    const candidates = Preset.candidates(offer.models, offer.price)
    // The successor (07 §4.3 `[고치기]`), else what a new session on this account starts on.
    const pick =
      Preset.successor(await gone(offer, ref.id), candidates, CodexModels.find(codex, ref.id)) ??
      (offer.kind && (await presets.defaultFor({ kind: offer.kind, providerID: offer.providerID }))?.id)
    const next = candidates.find((model) => model.id === pick && model.id !== ref.id)
    return { missing: "model", ...(next ? { suggestion: fit(next.id, next.variants) } : {}) }
  }

  /** A user prompt to a root of this Location: its main is checked before the step runs (07 §4.3). */
  const prompted = async (sessionID: string) => {
    const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
    if (!info?.model || info.parentID) return
    const ref = info.model
    const found = await main(ref)
    if (!found) return
    const suggestion = found.suggestion
    const offer = suggestion ? `${suggestion.id}${suggestion.variant ? ` · ${suggestion.variant}` : ""}` : undefined
    peers().telemetry.alert(
      found.missing === "model"
        ? {
            code: "session_model_unavailable",
            severity: "warning",
            sessionID,
            subject: `${ref.providerID}/${ref.id}`,
            message: `이 대화의 모델 ${ref.id}이(가) 없어졌습니다. 다음 메시지 전에 모델을 바꾸세요${offer ? `(제안: ${offer})` : ""}. 저절로 바꾸지 않습니다.`,
          }
        : {
            code: "session_variant_unavailable",
            severity: "warning",
            sessionID,
            subject: `${ref.providerID}/${ref.id}/${ref.variant ?? ""}`,
            message: `${ref.id}에서 추론 강도 '${ref.variant ?? ""}'이(가) 없어졌습니다. 다음 메시지 전에 ${suggestion?.variant ? `'${suggestion.variant}'` : "기본"}(으)로 바꾸세요. 저절로 바꾸지 않습니다.`,
          },
    )
  }

  return {
    start: async () => {
      // A remote service mirrors this PC's registry and has no presets.json (07 §8.1 원격): the PC's notices are the
      // only ones. Its sessions keep the main guard.
      if (deps.remote) return
      state.stops.push(
        deps.runtime.broadcast.on("store.changed", (payload) => {
          if (payload.store === "presets") schedule()
        }),
      )
    },
    stop: async () => {
      state.cancel?.()
      state.cancel = undefined
      for (const stop of state.stops.splice(0)) stop()
      await state.chain
    },
    onEvent: (event, meta) => {
      const refolded = event.type === "models-dev.refreshed" || (event.type === "provider.updated" && meta.local)
      if (refolded && !deps.remote) schedule()
      if (event.type === "session.inbox.enqueued" && meta.local && event.data.item.type === "user")
        void prompted(event.data.sessionID).catch((error: unknown) => log.warn("session_guard_failed", { error }))
    },
    main,
    check,
  }
}

/**
 * What is known of a model `offer` no longer has (07 §4.3), for its successor: the last template row (an own slot keeps
 * it, marked missing upstream), for the Claude slot the bundled `anth` template's row, else only its id.
 */
export async function gone(
  offer: Pick<PresetResolve.Inventory, "models" | "kind">,
  model: string,
): Promise<Preset.Gone> {
  const row =
    offer.models.find((entry) => entry.id === model) ??
    (offer.kind === "claude-sub"
      ? (await Templates.bundled("anth"))?.models.find((entry) => entry.id === model)
      : undefined)
  return {
    id: model,
    ...(row?.family === undefined ? {} : { family: row.family }),
    ...(row === undefined ? {} : { released: row.time.released }),
  }
}

/** One notice's alerts: pins and pairs as `preset_needs_repair`, defaults as `group_default_model_missing`. */
function alertsOf(notice: Preset.Repair) {
  const needs = notice.uses.filter((use) => use.kind !== "default")
  const defaults = notice.uses.flatMap((use) => (use.kind === "default" ? [use] : []))
  return [
    ...(needs.length > 0
      ? [
          {
            key: `preset_needs_repair\n${notice.model}`,
            alert: {
              code: "preset_needs_repair",
              severity: "warning",
              message: needed(notice.model, needs),
            } satisfies Omit<Telemetry.AlertInput, "subject">,
          },
        ]
      : []),
    ...(defaults.length > 0
      ? [
          {
            key: `group_default_model_missing\n${notice.model}`,
            alert: {
              code: "group_default_model_missing",
              severity: "warning",
              message: defaults
                .map(
                  (use) =>
                    `${groupName(use.group)} 새 대화 기본 모델 ${notice.model}이(가) 없어졌습니다.${use.suggestion ? ` 새 대화는 ${use.suggestion}(으)로 시작합니다.` : ""}`,
                )
                .join(" "),
            } satisfies Omit<Telemetry.AlertInput, "subject">,
          },
        ]
      : []),
  ]
}

/**
 * `리뷰 모델 … 없어져 …` (07 §4.3): the roles and pairs that run like the main (or on the next target) until fixed, and
 * the model pool entries that run on the default rule when named until fixed.
 */
function needed(model: string, uses: ReadonlyArray<Preset.Use>) {
  const pins = uses.flatMap((use) => (use.kind === "pin" && Preset.poolKeyOf(use.place) === undefined ? [use] : []))
  const pooled = uses.flatMap((use) => {
    const key = use.kind === "pin" ? Preset.poolKeyOf(use.place) : undefined
    return use.kind === "pin" && key !== undefined ? [{ presetID: use.presetID, key }] : []
  })
  const presets = new Set(pins.map((use) => use.presetID)).size
  const places = [...new Set(pins.map((use) => placeName(use.place)))].join("·")
  const keys = [...new Set(pooled.map((use) => use.key))].join(", ")
  const suggestion = uses.find((use) => use.suggestion !== undefined)?.suggestion
  return [
    `모델 ${model}이(가) 없어졌습니다.`,
    ...(pins.length > 0 ? [`프리셋 ${presets}개의 ${places}은(는) 고칠 때까지 다음 대상이나 메인 모델로 돕니다.`] : []),
    ...(pooled.length > 0
      ? [
          `프리셋 ${new Set(pooled.map((use) => use.presetID)).size}개의 모델 묶음에서 ${keys}은(는) 고칠 때까지 고르면 기본 규칙으로 돕니다.`,
        ]
      : []),
    ...(uses.some((use) => use.kind === "lighter")
      ? ["'메인 계정의 더 가벼운 모델'은 고칠 때까지 메인 모델로 돕니다."]
      : []),
    `프리셋 알림에서 고칩니다${suggestion ? `(제안: ${suggestion})` : ""}.`,
  ].join(" ")
}

/** The role names of the editor (07 §7.5 `own.preset.role.*`); `single` is `모두 한 곳으로`, a pool entry `모델 묶음`. */
function placeName(spot: Preset.Spot) {
  return isPlace(spot) ? PLACE_NAMES[spot] : "모델 묶음"
}

const isPlace = Schema.is(Preset.Place)

const PLACE_NAMES: Readonly<Record<Preset.Place, string>> = {
  explore: "탐색",
  general: "일반",
  "own-review": "리뷰",
  "own-quick": "빠른 일",
  "own-deep": "어려운 일",
  single: "하위 에이전트",
}

function groupName(group: Preset.Group) {
  if (Preset.isLocal(group)) return `로컬(${group.slice("local:".length)})`
  if (group === "claude-sub") return "Claude 구독"
  if (group === "claude-agent") return "Claude Agent"
  return Registration.KIND_NAMES[group]
}

export * as PresetGuidance from "./guidance.js"

import { Account, Preset } from "@own/protocol"
import type { ServiceTarget } from "@own/runtime"
import type { PresetResolve } from "./resolve.js"

/**
 * Owner: PRESETS (07 §3.3). The `own.preset` session instruction entry: what each role's card says about where it runs
 * ({@link cards}), the guidance text and hash (`Preset.renderGuidance`), whether the entry changes ({@link plan}), and
 * the self-HTTP writer that puts or removes it (`PUT|DELETE /api/experimental/session/:id/instructions/entries/
 * own.preset`) through an `@own/runtime` `ServiceTarget.Source` (the channel's registration file in an installed
 * build, `ServiceTarget.fixed` in source runs and tests). Core renders the entry as `<context key="own.preset">`: before
 * the first step it lands in the epoch baseline, later changes are appended at the next step boundary.
 */

/** The instruction entry key (07 §3.3). */
export const KEY = "own.preset"

/** What a binding change does to the entry (07 §8.1 `session.preset.apply` `entry`). */
export type Outcome = "unchanged" | "written" | "removed"

/** Requests to the own service give up after this. */
export const TIMEOUT_MS = 15_000

/**
 * Each role's card (07 §3.3): its first configured target only, so a temporary fallback (a local server off, a quota
 * wait) or the binding's team never changes the text. Roles without a target are left out (they run like the main).
 * - `메인과 같게`: the main's card. `더 가벼운 모델`: lighter on the main account, or the main's card when the group's
 *   pair for this main is the main itself (`none`).
 * - A pinned target: what it runs on (the main account, a subscription, a paid API, the user's machine), another
 *   company's canonical id when not the main's, and its rough relation to the main: the same model, else lighter,
 *   similar or stronger by input price (07 §3.4's price order). Without both prices a local model counts as lighter
 *   than a hosted main and anything else as similar. A target whose account is gone runs like the main.
 * `resolution` is the preset resolved for this main (its lighter rows read the decided pair).
 */
export async function cards(
  resolver: PresetResolve.Api,
  workers: Preset.Workers,
  main: Preset.Main | undefined,
  resolution: Preset.Resolution | undefined,
): Promise<Partial<Record<Preset.Role, Preset.Card>>> {
  const offers = new Map<string, Promise<PresetResolve.Inventory | undefined>>()
  const offer = (account: string) => {
    const known = offers.get(account)
    if (known) return known
    const found = resolver.inventory(account)
    offers.set(account, found)
    return found
  }
  const home = main && companyOf(resolver, main.account)
  const mainPrice = async () => {
    if (!main) return undefined
    const own = await offer(main.account)
    const entry = own?.models.find((model) => model.id === main.ref.id)
    return entry && own?.price(entry)
  }

  const cardOf = async (role: Preset.Role, target: Preset.Target): Promise<Preset.Card> => {
    if ("rel" in target) {
      if (target.rel === "main") return Preset.MAIN_CARD
      const ref = resolution?.roles[role]?.targets[0]?.ref
      return main && ref?.providerID === main.ref.providerID && ref.id === main.ref.id ? Preset.MAIN_CARD : LIGHTER
    }
    const pin = target.pin
    const local = Preset.isLocal(pin.account)
    const found = await offer(pin.account)
    const billing = found?.billing ?? (local ? "local" : resolver.lookup(Account.ID.make(pin.account))?.billing)
    if (billing === undefined) return Preset.MAIN_CARD
    const company = local ? undefined : companyOf(resolver, pin.account)
    const runs =
      pin.account === main?.account
        ? "main"
        : billing === "local"
          ? "local"
          : billing === "subscription"
            ? "subscription"
            : "paid"
    const other = company !== undefined && company !== home ? { company } : {}
    if (main && !local && company === home && pin.model === main.ref.id) return { relation: "same", runs, ...other }
    const entry = found?.models.find((model) => model.id === pin.model)
    const price = entry && found?.price(entry)
    const against = await mainPrice()
    const relation =
      price === undefined || against === undefined
        ? local && main !== undefined && !Preset.isLocal(main.account)
          ? "lighter"
          : "similar"
        : price < against
          ? "lighter"
          : price > against
            ? "stronger"
            : "similar"
    return { relation, runs, ...other }
  }

  const firsts = Preset.ROLES.flatMap((role) => {
    const target = firstOf(workers, role)
    return target ? [{ role, target }] : []
  })
  return Object.fromEntries(
    await Promise.all(firsts.map(async (item) => [item.role, await cardOf(item.role, item.target)] as const)),
  )
}

/** Whether any role of the mode has a target, or the preset is a model pool, so its guidance needs the main. */
export function targeted(workers: Preset.Workers) {
  return Preset.modeOf(workers) === "pool" || Preset.ROLES.some((role) => firstOf(workers, role) !== undefined)
}

/**
 * The model pool block's input (07 §3.3 모델 묶음): each entry's frozen card and note with the facts `Resolution.pool`
 * worked out for this main (what it runs on, the company, the raw price), the relation to the main and the static
 * default rule. `undefined` for a preset that is no model pool, or without a resolved main.
 */
export function pool(
  workers: Preset.Workers,
  resolution: Preset.Resolution | undefined,
): Preset.PoolGuidance | undefined {
  const resolved = resolution?.pool
  if (Preset.modeOf(workers) !== "pool" || !resolution || !resolved) return undefined
  const sides = new Map(resolved.entries.map((item) => [item.key, item]))
  const facts = (workers.pool ?? []).map((entry) => {
    const item = sides.get(entry.key)
    return {
      ...entry,
      side: {
        ...(item?.runs === undefined ? {} : { runs: item.runs }),
        ...(item?.company === undefined ? {} : { company: item.company }),
        ...(item?.price === undefined ? {} : { price: item.price }),
      },
    }
  })
  return Preset.poolGuidance(facts, { model: resolution.main.id, side: resolved.main })
}

/**
 * The guidance a binding needs (07 §3.3): delegation (ultra delegates actively), the caps in force (the preset's, or
 * with ultra the larger of the preset's and the ultra level's, `Preset.caps`), the role cards and the per-call effort
 * line unless the preset raises no effort or fixes one (07 §2.3, 강도 고정). `null` = no entry (`평소대로`, or `모델
 * 기본` with no cards).
 */
export function render(input: {
  readonly preset: Pick<Preset.Info, "delegation" | "caps" | "ultraCaps" | "subagentEffortMax" | "forcedEffort">
  readonly ultra: boolean
  readonly level: Preset.UltraCaps
  readonly cards: Partial<Record<Preset.Role, Preset.Card>>
  /** A model pool preset's block ({@link pool}); it replaces the role cards. */
  readonly pool?: Preset.PoolGuidance
}) {
  return Preset.renderGuidance({
    delegation: input.preset.delegation,
    ultra: input.ultra,
    caps: Preset.caps(input.preset, input.ultra, input.level),
    cards: input.cards,
    ...(input.pool ? { pool: input.pool } : {}),
    effort:
      Preset.effortMaxOf(input.preset) !== "off" && Preset.forcedEffortOf(input.preset.forcedEffort) === undefined,
  })
}

/** What moving from the entry last written (`entryHash`, `null` = none) to `next` does. */
export function plan(previous: string | null, next: Preset.Guidance | null): Outcome {
  if (next === null) return previous === null ? "unchanged" : "removed"
  return next.hash === previous ? "unchanged" : "written"
}

/** A session as the entry endpoint addresses it: its id and `location[directory]` (01 §15). */
export interface Place {
  readonly sessionID: string
  readonly directory: string
}

export type Result =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** HTTP status, or `null` when nothing answered (no service, unreachable, timeout). */
      readonly status: number | null
      readonly message: string
    }

export interface Writer {
  put(place: Place, text: string): Promise<Result>
  remove(place: Place): Promise<Result>
}

/**
 * The entry over self-HTTP. `source` is read on every call (a restart may move the service); a 401 re-reads it once.
 * The password only ever goes into `Authorization` of these loopback requests (`ServiceTarget`). Never throws.
 */
export function writer(source: () => ServiceTarget.Source, timeoutMs = TIMEOUT_MS): Writer {
  const send = async (method: "PUT" | "DELETE", place: Place, body: unknown, retry: boolean): Promise<Result> => {
    const service = source()
    const target = await service.current().catch(() => undefined)
    if (!target) return { ok: false, status: null, message: "no own service registration" }
    const url = new URL(
      `/api/experimental/session/${encodeURIComponent(place.sessionID)}/instructions/entries/${encodeURIComponent(KEY)}`,
      target.url,
    )
    url.searchParams.set("location[directory]", place.directory)
    const response = await fetch(url, {
      method,
      headers: {
        authorization: target.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: unknown) => error)
    if (!(response instanceof Response))
      return { ok: false, status: null, message: response instanceof Error ? response.message : String(response) }
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 && retry) {
      service.invalidate()
      return send(method, place, body, false)
    }
    return response.ok ? { ok: true } : { ok: false, status: response.status, message: response.statusText }
  }
  return {
    put: (place, text) => send("PUT", place, { value: text }, true),
    remove: (place) => send("DELETE", place, undefined, true),
  }
}

const LIGHTER: Preset.Card = { relation: "lighter", runs: "main" }

/** A role's first configured target: its row for `by-role`, `single` for `single`, none for `same` or a pool. */
function firstOf(workers: Preset.Workers, role: Preset.Role): Preset.Target | undefined {
  const mode = Preset.modeOf(workers)
  if (mode === "single") return workers.single
  if (mode === "same" || mode === "pool") return undefined
  return workers.roles[role]?.targets[0]
}

/** An account's company (`Preset.company`); `undefined` for a local provider or an account the registry lost. */
function companyOf(resolver: PresetResolve.Api, account: string) {
  if (Preset.isLocal(account)) return undefined
  const member = resolver.lookup(Account.ID.make(account))
  return member && Preset.company(member)
}

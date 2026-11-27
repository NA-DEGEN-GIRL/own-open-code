export * as TemplateDiff from "./template-diff.js"

import { Struct } from "effect"
import type { Model } from "@opencode/schema/model"
import type { Registry } from "@own/protocol"
import { Templates } from "./templates.js"

/**
 * The pinned-template diff (07 §4.4): what the catalog the provider fold just saw changed against a kind's pinned
 * template. Pure and synchronous, so the fold runs it; `Slots` writes what lasts to `accounts.json` after the fold
 * (02 §3.8: no I/O in folds).
 *
 * - A new model id is added at once with `addedAt`. It only becomes selectable (the picker's `새` tag): no binding,
 *   preset, lighter pair or group default changes, and no session's bytes change.
 * - A model id the catalog no longer lists is never deleted: it is marked `upstream: "missing"` (still registered and
 *   running as `deprecated`, never picked anew, `Registration.current`), which the repair notices of 07 §4.3 follow. A
 *   model that comes back loses the mark.
 * - `limit`, `cost`, `status` and the release date are read live at every registration (`Templates.live`) and never
 *   written here.
 * - Every other field (name, family, variants, package, settings, capabilities …) reaches the request bytes, so a
 *   change only sets the template's `update` (`템플릿 갱신 있음`), applied by the user's `accounts.update{refreshCatalog}`.
 *
 * A changed model id is a removal plus an addition; the successor a repair notice offers is 07 §4.3's
 * (`Preset.successor`). `compat` templates come from the user and have no catalog to diff against.
 */

/** Fields read live at every registration (`Templates.live`); `released` is `time.released`. */
export const LIVE_FIELDS = ["cost", "limit", "released", "status"] as const
export type LiveField = (typeof LIVE_FIELDS)[number]

/** Fields that never count as a fixed change: the live ones, the registration switch and own's marks. */
const NOT_FIXED: ReadonlySet<string> = new Set(["cost", "limit", "status", "time", "enabled", "addedAt", "upstream"])

/** Which fields of one model differ. */
export interface Change<F extends string = string> {
  readonly id: Model.ID
  /** Sorted. */
  readonly fields: ReadonlyArray<F>
}

/** One template against the catalog; every list is sorted by model id. */
export interface Diff {
  /** Catalog models the template lacks, as entries of the kind's template (the rules of `Templates.fromCatalog`). */
  readonly added: ReadonlyArray<Registry.TemplateModel>
  /** Template models the catalog no longer lists that are not marked yet. */
  readonly removed: ReadonlyArray<Model.ID>
  /** Template models marked missing that the catalog lists again. */
  readonly returned: ReadonlyArray<Model.ID>
  /** Listed models that register with other live values than their pinned ones. */
  readonly live: ReadonlyArray<Change<LiveField>>
  /** Listed models whose fixed fields differ from the catalog's. */
  readonly fixed: ReadonlyArray<Change>
}

/**
 * `template` against the fold's catalog of its source provider; `undefined` while that catalog has no models (offline
 * start, a fold that did not see the provider), so nothing is ever marked missing for want of a catalog. Added
 * models and fixed fields need the kind's template rules to accept the catalog (`anth` refuses one with an unpriced
 * model, I6); removals only need the ids.
 */
export function diff(kind: Templates.CatalogKind, template: Registry.ModelTemplate, live: Templates.Live) {
  const catalog = live.get(Templates.SOURCE[kind])?.models
  if (!catalog || catalog.size === 0) return undefined
  const built = Templates.fromCatalog(kind, catalog.values(), template.capturedAt)
  const fresh = new Map(built.ok ? built.template.models.map((model) => [String(model.id), model] as const) : [])
  const pinned = new Set(template.models.map((model) => String(model.id)))
  const listed = template.models.filter((model) => catalog.has(model.id)).toSorted(byID)
  return {
    added: [...fresh.values()].filter((model) => !pinned.has(model.id)).toSorted(byID),
    // Core's catalog drops models without text in or out (upstream 944959566f) while the provider still serves them,
    // so a pinned one stays as it is instead of retiring.
    removed: template.models
      .filter((model) => model.upstream === undefined && Templates.supportsText(model) && !catalog.has(model.id))
      .map((model) => model.id)
      .toSorted(),
    returned: listed.filter((model) => model.upstream === "missing").map((model) => model.id),
    live: listed.flatMap((model) => {
      const current = Templates.live(kind, model, live)
      const fields = LIVE_FIELDS.filter((field) =>
        field === "released"
          ? current.time.released !== model.time.released
          : !Bun.deepEquals(current[field], model[field]),
      )
      return fields.length === 0 ? [] : [{ id: model.id, fields }]
    }),
    fixed: listed.flatMap((model) => {
      const entry = fresh.get(model.id)
      const fields = entry ? fixedFields(model, entry) : []
      return fields.length === 0 ? [] : [{ id: model.id, fields }]
    }),
  } satisfies Diff
}

/**
 * The template with what lasts of a {@link diff}: added models appended with `addedAt`, removed ones marked, returned ones
 * unmarked, every other model byte-identical, and `update` naming the changed fixed fields (a new `detectedAt` only
 * when that set changes; none left clears it). `undefined` when nothing lasting changed.
 */
export function apply(template: Registry.ModelTemplate, found: Diff, at: string): Registry.ModelTemplate | undefined {
  const removed = new Set<string>(found.removed)
  const returned = new Set<string>(found.returned)
  const fields = [...new Set(found.fixed.flatMap((change) => change.fields))].toSorted()
  const update =
    fields.length === 0
      ? undefined
      : Bun.deepEquals(template.update?.fields, fields)
        ? template.update
        : { detectedAt: at, fields }
  if (found.added.length === 0 && removed.size === 0 && returned.size === 0 && update === template.update)
    return undefined
  return {
    ...Struct.omit(template, ["update"]),
    models: [
      ...template.models.map((model) =>
        removed.has(model.id)
          ? { ...model, upstream: "missing" as const }
          : returned.has(model.id)
            ? Struct.omit(model, ["upstream"])
            : model,
      ),
      ...found.added.map((model) => ({ ...model, addedAt: at })),
    ],
    ...(update === undefined ? {} : { update }),
  }
}

/** A template whose lasting diff {@link reconcile} wrote. */
export interface Applied {
  readonly templateID: string
  readonly kind: Templates.CatalogKind
  readonly added: number
  readonly missing: number
  readonly returned: number
  /** The fixed fields of a new or changed `update` (alert `template_update_available` once per change). */
  readonly update?: ReadonlyArray<string>
}

/**
 * The registry with the lasting diff of every catalog template a live slot uses, or `undefined` when none changed.
 * `Slots` runs it in the fold to decide whether to write, then again on the current file under the registry lock.
 */
export function reconcile(registry: Registry.File, live: Templates.Live, at: string) {
  const used = new Set<string>(
    Object.values(registry.slots)
      .filter((slot) => !slot.retired)
      .map((slot) => slot.modelTemplate),
  )
  const changed = Object.entries(registry.modelTemplates).flatMap(([templateID, template]) => {
    if (!used.has(templateID) || template.kind === "compat") return []
    const found = diff(template.kind, template, live)
    const next = found && apply(template, found, at)
    if (!found || !next) return []
    const update = next.update === template.update ? undefined : next.update?.fields
    const applied: Applied = {
      templateID,
      kind: template.kind,
      added: found.added.length,
      missing: found.removed.length,
      returned: found.returned.length,
      ...(update === undefined ? {} : { update }),
    }
    return [{ applied, next }]
  })
  if (changed.length === 0) return undefined
  return {
    registry: {
      ...registry,
      modelTemplates: {
        ...registry.modelTemplates,
        ...Object.fromEntries(changed.map((item) => [item.applied.templateID, item.next])),
      },
    } satisfies Registry.File,
    applied: changed.map((item) => item.applied),
  }
}

/**
 * A template the user's `accounts.update{refreshCatalog}` just captured, with the marks of the template it replaces:
 * a model still listed keeps its `addedAt` (its `새` tag runs its course), and a model marked missing stays, still
 * marked, since a gone model is never deleted (the repair notices read its last row, 07 §4.3).
 */
export function carry(
  previous: Registry.ModelTemplate | undefined,
  next: Registry.ModelTemplate,
): Registry.ModelTemplate {
  if (!previous) return next
  const added = new Map(
    previous.models.flatMap((model) =>
      model.addedAt === undefined ? [] : [[String(model.id), model.addedAt] as const],
    ),
  )
  const listed = new Set(next.models.map((model) => String(model.id)))
  return {
    ...next,
    models: [
      ...next.models.map((model) => {
        const addedAt = added.get(model.id)
        return addedAt === undefined ? model : { ...model, addedAt }
      }),
      ...previous.models.filter((model) => model.upstream === "missing" && !listed.has(model.id)),
    ],
  }
}

/** The sorted names of the fields that differ between a pinned model and the catalog's entry for it. */
function fixedFields(pinned: Registry.TemplateModel, fresh: Registry.TemplateModel) {
  const a = new Map<string, unknown>(Object.entries(pinned))
  const b = new Map<string, unknown>(Object.entries({ ...fresh, capabilities: comparable(pinned, fresh) }))
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((field) => !NOT_FIXED.has(field) && !Bun.deepEquals(a.get(field), b.get(field)))
    .toSorted()
}

/**
 * The catalog's capabilities as the pinned template would have recorded them. Upstream v2.0.32 (d889cb2044) added the
 * optional `capabilities.temperature` from models.dev, which core does not use to build a request, so a template
 * captured before it is not out of date for lacking it. Once a template records it, a change counts.
 */
function comparable(pinned: Registry.TemplateModel, fresh: Registry.TemplateModel) {
  if (pinned.capabilities.temperature !== undefined) return fresh.capabilities
  return Struct.omit(fresh.capabilities, ["temperature"])
}

function byID(a: { readonly id: string }, b: { readonly id: string }) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

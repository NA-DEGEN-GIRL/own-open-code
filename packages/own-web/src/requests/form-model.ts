// Form dock data rules (03 §18.2): which fields are active (`when`, packages/schema/src/form.ts:25-38), which are
// missing, and the answer that goes to `POST …/form/:id/reply`. Pure; the dock keeps a `Draft` and calls these.
import type { FormAnswer, FormInfo } from "@opencode/client"

export type FormField = FormInfo["fields"][number]
type FormValue = FormAnswer[string]

export interface Draft {
  /** Scalar values: picked option or text of a string field, numbers, booleans. */
  readonly values: Readonly<Record<string, FormValue | undefined>>
  /** Picked options of multiselect fields. */
  readonly picked: Readonly<Record<string, readonly string[] | undefined>>
  /** "직접 입력" text of fields with `custom`. */
  readonly custom: Readonly<Record<string, string | undefined>>
  readonly customOn: Readonly<Record<string, boolean | undefined>>
}

export function initialDraft(form: Pick<FormInfo, "fields">): Draft {
  const values: Record<string, FormValue | undefined> = {}
  const picked: Record<string, string[] | undefined> = {}
  const custom: Record<string, string | undefined> = {}
  const customOn: Record<string, boolean | undefined> = {}
  for (const field of form.fields) {
    if (field.type === "multiselect") {
      const known = new Set(field.options.map((option) => option.value))
      const defaults = field.default ?? []
      picked[field.key] = defaults.filter((value) => known.has(value))
      const extra = defaults.find((value) => !known.has(value))
      if (extra !== undefined && field.custom) {
        custom[field.key] = extra
        customOn[field.key] = true
      }
      continue
    }
    if (field.type === "string") {
      if (field.default === undefined) continue
      const option = field.options?.some((item) => item.value === field.default)
      if (field.options?.length && !option && field.custom) {
        custom[field.key] = field.default
        customOn[field.key] = true
        continue
      }
      values[field.key] = field.default
      continue
    }
    if (field.type === "boolean") values[field.key] = field.default ?? false
    if ((field.type === "number" || field.type === "integer") && bound(field.default) !== undefined)
      values[field.key] = bound(field.default)
  }
  return { values, picked, custom, customOn }
}

/** The value a field would send now, `undefined` when unanswered. */
export function valueOf(field: FormField, draft: Draft): FormValue | undefined {
  const text = draft.customOn[field.key] ? draft.custom[field.key]?.trim() : undefined
  if (field.type === "external") return true
  if (field.type === "multiselect") {
    const values = [...(draft.picked[field.key] ?? []), ...(text ? [text] : [])]
    return values.length ? [...new Set(values)] : undefined
  }
  if (field.type === "string") {
    if (draft.customOn[field.key]) return text || undefined
    const value = draft.values[field.key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  if (field.type === "boolean") return typeof draft.values[field.key] === "boolean" ? draft.values[field.key] : false
  const value = draft.values[field.key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Active fields in order: not `hidden`, every `when` condition holds against earlier active fields. A condition on an
 * unanswered or inactive field is false for both ops; against a multiselect `eq` means "includes".
 */
export function activeFields(form: Pick<FormInfo, "fields">, draft: Draft): FormField[] {
  const active = new Map<string, FormField>()
  for (const field of form.fields) {
    if ("hidden" in field && field.hidden) continue
    const conditions = "when" in field ? (field.when ?? []) : []
    const holds = conditions.every((condition) => {
      const other = active.get(condition.key)
      const value = other ? valueOf(other, draft) : undefined
      if (value === undefined) return false
      const equal = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value
      return condition.op === "eq" ? equal : !equal
    })
    if (holds) active.set(field.key, field)
  }
  return [...active.values()]
}

export type Problem = "required" | "range" | "integer" | "length" | "pattern" | "items"

/** Problems per active field key; empty when the form can be sent. */
export function problems(form: Pick<FormInfo, "fields">, draft: Draft) {
  const found: Record<string, Problem> = {}
  for (const field of activeFields(form, draft)) {
    const problem = problemOf(field, valueOf(field, draft))
    if (problem) found[field.key] = problem
  }
  return found
}

function problemOf(field: FormField, value: FormValue | undefined): Problem | undefined {
  const required = "required" in field && field.required === true
  if (value === undefined) return required ? "required" : undefined
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number") return "range"
    if (field.type === "integer" && !Number.isInteger(value)) return "integer"
    const minimum = bound(field.minimum)
    const maximum = bound(field.maximum)
    if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) return "range"
    return undefined
  }
  if (field.type === "string" && typeof value === "string") {
    if (
      (field.minLength !== undefined && value.length < field.minLength) ||
      (field.maxLength !== undefined && value.length > field.maxLength)
    )
      return "length"
    if (field.pattern && !matches(field.pattern, value)) return "pattern"
    return undefined
  }
  if (field.type === "multiselect" && Array.isArray(value)) {
    if (
      (field.minItems !== undefined && value.length < field.minItems) ||
      (field.maxItems !== undefined && value.length > field.maxItems)
    )
      return "items"
  }
  return undefined
}

/** Number bounds travel as JSON numbers or the strings `Infinity`/`-Infinity`/`NaN` (generated client types). */
export function bound(value: number | string | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  return undefined
}

/** A pattern the browser cannot compile is left to the server's check. */
function matches(pattern: string, value: string) {
  try {
    return new RegExp(pattern, "u").test(value)
  } catch {
    return true
  }
}

/** The reply body: answered active fields only (inactive fields are neither required nor answerable). */
export function buildAnswer(form: Pick<FormInfo, "fields">, draft: Draft): FormAnswer {
  return Object.fromEntries(
    activeFields(form, draft).flatMap((field) => {
      const value = valueOf(field, draft)
      return value === undefined ? [] : [[field.key, value]]
    }),
  )
}

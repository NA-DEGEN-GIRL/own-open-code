// Pi's tool arguments: the JSON schemas Pi's TypeBox definitions serialize to, and Pi's argument check before a tool
// runs (packages/ai/src/utils/validation.ts `validateToolArguments`, on @earendil-works/pi-schema since Pi 1.5.0):
// optional nulls dropped, values converted to the declared type (pi-schema's port of TypeBox 1.3.27 `Value.Convert`:
// a single value becomes a one-item array, null becomes "null" for a string), then the schema checked, with Pi's
// failure text. The tools take their input through a pass-through Standard Schema so this check, not core's, answers
// the model, under the tool's Pi name. The checked subset is what Pi's four tools use (objects, strings, numbers, arrays
// of objects), with pi-schema's messages (packages/schema/src/explain.ts): `missing` for each absent required property
// and `expected <type>, got <type>`. own keeps this small validator rather than depend on pi-schema.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiArgs from "./args.js"

export interface Property {
  readonly type: "string" | "number" | "array" | "object"
  readonly description?: string
  readonly items?: ObjectSchema
}

export interface ObjectSchema {
  readonly type: "object"
  readonly properties: Readonly<Record<string, Property>>
  readonly required: ReadonlyArray<string>
  readonly description?: string
}

/**
 * A Standard Schema whose JSON Schema is Pi's and whose check passes every value through: the tool checks its own
 * arguments ({@link check}) so a failure reads as Pi's and names the tool the model called.
 */
export function standard(schema: ObjectSchema) {
  const json = (): Record<string, unknown> => structuredClone({ ...schema })
  return {
    "~standard": {
      version: 1 as const,
      vendor: "own.harness.pi",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: json, output: json },
    },
  }
}

/** `validateToolArguments`: the converted arguments, or Pi's failure text. */
export function check<T>(tool: string, schema: ObjectSchema, raw: unknown) {
  const value = convert(normalizeOptionalNulls(structuredClone(raw), schema), schema)
  const errors = issues(value, schema, "")
  if (errors.length === 0) return { ok: true as const, value: value as T }
  const lines = errors.map((error) => `  - ${error.path}: ${error.message}`).join("\n")
  return {
    ok: false as const,
    message: `Validation failed for tool "${tool}":\n${lines}\n\nReceived arguments:\n${JSON.stringify(raw, null, 2)}`,
  }
}

function normalizeOptionalNulls(value: unknown, schema: ObjectSchema | Property): unknown {
  if (Array.isArray(value))
    return schema.type === "array" && schema.items !== undefined
      ? value.map((item) => normalizeOptionalNulls(item, schema.items!))
      : value
  if (!isRecord(value) || schema.type !== "object" || !("properties" in schema)) return value
  const object = schema as ObjectSchema
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const property = object.properties[key]
      if (property === undefined) return [[key, item]]
      if (item === null && !object.required.includes(key)) return []
      return [[key, normalizeOptionalNulls(item, property)]]
    }),
  )
}

/**
 * pi-schema's conversion pass (TypeBox `Value.Convert`) for the declared types: `tryNumber`, `tryString`, an array's
 * items, or a single value wrapped into a one-item array, and an object's declared properties. A value that does not
 * convert stays as it is, for the check to report.
 */
function convert(value: unknown, schema: ObjectSchema | Property): unknown {
  if (schema.type === "number") return toNumber(value) ?? value
  if (schema.type === "string") {
    if (typeof value === "boolean" || isFiniteNumber(value)) return String(value)
    return value === null ? "null" : value
  }
  if (schema.type === "array") {
    if (schema.items === undefined) return Array.isArray(value) ? value : [value]
    return Array.isArray(value) ? value.map((item) => convert(item, schema.items!)) : [convert(value, schema.items)]
  }
  if (!isRecord(value) || !("properties" in schema) || schema.properties === undefined) return value
  const object = schema as ObjectSchema
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const property = object.properties[key]
      return [key, property === undefined ? item : convert(item, property)]
    }),
  )
}

/** TypeBox's `TryNumber`: booleans, finite numbers, null, numeric strings, "true"/"false" and `12n`-style strings. */
function toNumber(value: unknown) {
  if (typeof value === "boolean") return value ? 1 : 0
  if (isFiniteNumber(value)) return value
  if (value === null) return 0
  if (typeof value !== "string") return undefined
  const number = +value
  if (Number.isFinite(number)) return number
  const lowercase = value.toLowerCase()
  if (lowercase === "false") return 0
  if (lowercase === "true") return 1
  const integer = /^-?(0|[1-9]\d*)n$/.test(value) ? Number(value.slice(0, -1)) : undefined
  return integer !== undefined && Number.isSafeInteger(integer) ? integer : undefined
}

/**
 * pi-schema's `Explainer` for this subset: a value of the wrong type is reported alone; an object reports each missing
 * required property at that property, in `required` order, then its declared properties' errors in declaration order.
 */
function issues(value: unknown, schema: ObjectSchema | Property, at: string): Array<{ path: string; message: string }> {
  const here = at === "" ? "root" : at
  const typed =
    schema.type === "number"
      ? isFiniteNumber(value)
      : schema.type === "array"
        ? Array.isArray(value)
        : schema.type === "object"
          ? isRecord(value)
          : typeof value === schema.type
  if (!typed) return [{ path: here, message: `expected ${schema.type}, got ${typeName(value)}` }]
  if (schema.type === "array" && Array.isArray(value))
    return schema.items === undefined
      ? []
      : value.flatMap((item, index) => issues(item, schema.items!, join(at, String(index))))
  if (!isRecord(value)) return []
  const object = schema as ObjectSchema
  return [
    ...object.required.filter((key) => !(key in value)).map((key) => ({ path: join(at, key), message: "missing" })),
    ...Object.entries(object.properties).flatMap(([key, property]) =>
      key in value ? issues(value[key], property, join(at, key)) : [],
    ),
  ]
}

/** pi-schema's `typeName`: `integer` for a whole number, `null` and `array` apart from `object`. */
function typeName(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number" && Number.isInteger(value)) return "integer"
  if (typeof value === "number" && !Number.isFinite(value)) return String(value)
  return typeof value
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function join(at: string, key: string) {
  return at === "" ? key : `${at}.${key}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

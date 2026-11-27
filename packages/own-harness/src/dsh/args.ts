// dsh's tool arguments: the JSON Schemas dsh's `ParameterSchemaSpec` compiles to (packages/core/tools/src/schema.ts
// `parameterSchemaSpecToJsonSchema`: an open object root, each property's `type` then its description, enum, items) and
// dsh's argument check before a tool runs (`validateArgs` with core/tools/src/json-schema.ts `checkValue`): the
// violations in schema-walk order, joined into `invalid arguments: …`, which the tool registry answers as
// `Error: <message>`. The tools take their input through a pass-through Standard Schema so this check, not core's,
// answers the model. The checked subset is what the ported tools declare (objects, strings, numbers, booleans, arrays,
// enums).
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshArgs from "./args.js"

export interface Property {
  readonly type: "string" | "number" | "integer" | "boolean" | "array" | "object"
  readonly description?: string
  readonly enum?: ReadonlyArray<string>
  readonly items?: Property
  readonly additionalProperties?: false
  readonly properties?: Readonly<Record<string, Property>>
  readonly required?: ReadonlyArray<string>
}

export interface ObjectSchema {
  readonly type: "object"
  readonly properties: Readonly<Record<string, Property>>
  readonly required?: ReadonlyArray<string>
}

/** A Standard Schema whose JSON Schema is dsh's and whose check passes every value through ({@link check} runs). */
export function standard(schema: ObjectSchema) {
  const json = (): Record<string, unknown> => structuredClone({ ...schema })
  return {
    "~standard": {
      version: 1 as const,
      vendor: "own.harness.dsh",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: json, output: json },
    },
  }
}

/** `defineTool`'s check: the arguments as given, or dsh's `ToolArgsError` text. */
export function check<T>(schema: ObjectSchema, raw: unknown) {
  const violations = issues(raw, schema, "")
  if (violations.length === 0) return { ok: true as const, value: raw as T }
  return { ok: false as const, message: `invalid arguments: ${violations.join("; ")}` }
}

function issues(value: unknown, schema: ObjectSchema | Property, at: string): Array<string> {
  const here = at === "" ? "arguments" : at
  if (schema.type === "object") {
    if (!isRecord(value)) return [`"${here}" must be an object`]
    const properties = schema.properties ?? {}
    const missing = (schema.required ?? [])
      .filter((key) => !Object.hasOwn(value, key) || value[key] === undefined)
      .map((key) => `missing required property "${join(at, key)}"`)
    const nested = Object.entries(properties).flatMap(([key, property]) =>
      Object.hasOwn(value, key) && value[key] !== undefined ? issues(value[key], property, join(at, key)) : [],
    )
    const extra =
      "additionalProperties" in schema && schema.additionalProperties === false
        ? Object.keys(value)
            .filter((key) => !Object.hasOwn(properties, key))
            .map((key) => `"${join(at, key)}" is not a declared property (additionalProperties: false)`)
        : []
    return [...missing, ...nested, ...extra]
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`"${here}" must be an array`]
    const items = schema.items
    return items === undefined ? [] : value.flatMap((item, index) => issues(item, items, `${here}[${index}]`))
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`"${here}" must be a string`]
    return schema.enum !== undefined && !schema.enum.includes(value)
      ? [`"${here}" must be one of ${JSON.stringify(schema.enum)}`]
      : []
  }
  if (schema.type === "number") {
    if (typeof value !== "number") return [`"${here}" must be a number`]
    return Number.isFinite(value) ? [] : [`"${here}" must be a finite JSON number`]
  }
  if (schema.type === "integer")
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
      ? []
      : [`"${here}" must be an integer`]
  return typeof value === "boolean" ? [] : [`"${here}" must be a boolean`]
}

function join(at: string, key: string) {
  return at === "" ? key : `${at}.${key}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

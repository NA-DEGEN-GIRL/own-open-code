/**
 * Registry files keep fields they do not know (02 §2.3 "모르는 필드는 보존한다"), so a rewrite by an older build does
 * not drop what a newer one wrote. Effect 4 strips undeclared keys when it decodes and encodes, so these do what its
 * former `onExcessProperty: "preserve"` did: `decode` puts the undeclared keys of the JSON back into the decoded value,
 * and `encode` writes the undeclared keys a value carries. Code that rebuilds an object therefore drops them on
 * purpose, and code that spreads one keeps them, as before.
 */
export * as Preserve from "./preserve.js"

import { Option, Schema, SchemaAST } from "effect"

/** Decodes `input`, keeping the keys the schema does not declare. */
export function decode<S extends Schema.Codec<unknown, unknown>>(schema: S) {
  const decoded = Schema.decodeUnknownOption(schema)
  const type = SchemaAST.toType(schema.ast)
  return (input: unknown): Option.Option<S["Type"]> =>
    Option.map(decoded(input), (value) => merge(type, value, input) as S["Type"])
}

/** Encodes `value`, keeping the undeclared keys it carries. */
export function encode<S extends Schema.Codec<unknown, unknown>>(schema: S) {
  const encoded = Schema.encodeSync(schema)
  const form = SchemaAST.toEncoded(schema.ast)
  return (value: S["Type"]): unknown => merge(form, encoded(value), value)
}

/** Decodes and re-encodes `value` as a registry rewrite would. */
export function roundTrip(schema: Schema.Codec<unknown, unknown>, value: unknown) {
  return encode(schema)(Option.getOrThrow(decode(schema)(value)))
}

/** `next` with the undeclared keys of `source` put back, wherever both still have an object. */
function merge(ast: SchemaAST.AST, next: unknown, source: unknown): unknown {
  if (ast._tag === "Suspend") return merge(ast.thunk(), next, source)
  if (ast._tag === "Union") {
    const member = ast.types.find((type) => covers(type, next))
    return member === undefined ? next : merge(member, next, source)
  }
  if (ast._tag === "Arrays" && Array.isArray(next) && Array.isArray(source))
    return next.map((item, index) => {
      const type = ast.elements[index] ?? ast.rest[0]
      return type === undefined || index >= source.length ? item : merge(type, item, source[index])
    })
  if (ast._tag !== "Objects" || !isRecord(next) || !isRecord(source)) return next
  const declared = new Map(ast.propertySignatures.map((property) => [property.name, property.type]))
  // Records (index signatures) own their keys: a key `next` lacks was removed, not unknown.
  const indexed = ast.indexSignatures[0]?.type
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(next)) {
    const type = declared.get(key) ?? indexed
    merged[key] = type === undefined || !(key in source) ? value : merge(type, value, source[key])
  }
  if (indexed !== undefined) return merged
  for (const [key, value] of Object.entries(source)) if (!declared.has(key) && !(key in merged)) merged[key] = value
  return merged
}

/** Whether `value` fits an object member of a union: its keys are declared there and its discriminants match. */
function covers(ast: SchemaAST.AST, value: unknown): boolean {
  if (ast._tag === "Suspend") return covers(ast.thunk(), value)
  if (ast._tag === "Arrays") return Array.isArray(value)
  if (ast._tag !== "Objects" || !isRecord(value)) return false
  if (ast.indexSignatures.length > 0) return true
  const declared = new Set(ast.propertySignatures.map((property) => property.name))
  const discriminants = ast.propertySignatures.every(
    (property) =>
      property.type._tag !== "Literal" ||
      !(String(property.name) in value) ||
      value[String(property.name)] === property.type.literal,
  )
  return discriminants && Object.keys(value).every((key) => declared.has(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

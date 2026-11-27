import { Schema } from "effect"

/**
 * A string-keyed record whose keys must satisfy `key`. A record with a refined key schema silently drops
 * non-matching keys on decode, which would lose registry entries on the next rewrite, so the keys are
 * validated explicitly and reported as issues instead.
 */
export function keyedRecord<V extends Schema.Top>(key: Schema.Codec<string>, value: V) {
  const isKey = Schema.is(key)
  return Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record) =>
      Object.keys(record).flatMap((name) => (isKey(name) ? [] : [{ path: [name], issue: `Invalid key "${name}"` }])),
    ),
  )
}

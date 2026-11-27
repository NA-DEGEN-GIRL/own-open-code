export * as Portable from "./portable.js"

import { Cause, Exit, Schema } from "effect"
import type { Rpc } from "@opencode/schema/rpc"

/**
 * RPC definitions a plugin can register from its own bundle (upstream `Rpc.PortableDefinition`).
 *
 * A release plugin bundle (FORK §8.2 step 3) carries its own copy of `effect`, and the host (`opencode.exe`) validates
 * RPC inputs, outputs, errors and events with its copy. The host's Schema parser does not run checks of a schema built
 * by another copy (`Schema.Int` answers "Expected an integer" for 0), so an Effect schema from a bundle fails on the
 * first integer. From source the plugin and the host share one `effect` module, which hid this until the first run of
 * the bundles inside the compiled CLI.
 *
 * `definition` replaces every Effect schema with a Standard Schema object that runs in this module's copy:
 * - method `input`: decode (the host passes the parsed value to the handler);
 * - method `output`, declared `errors`, `events`: encode (for Standard Schema the host "parses forward" what the
 *   handler returned or the plugin emitted and sends `value`, `@opencode/schema/rpc` `HandlerOutput`).
 * Non-Effect schemas (already Standard or JSON Schema) are kept. The own-protocol schemas have no transformations, so
 * encoded values equal decoded ones; the direction only matters for correctness if one is added.
 */
export function definition<const D extends Rpc.Definition>(definition: D): D {
  const methods = Object.fromEntries(
    Object.entries(definition.methods).map(([name, method]) => [
      name,
      {
        ...method,
        input: standard(method.input, "decode"),
        output: standard(method.output, "encode"),
        ...(method.errors
          ? {
              errors: Object.fromEntries(
                Object.entries(method.errors).map(([type, schema]) => [type, standard(schema, "encode")]),
              ),
            }
          : {}),
      },
    ]),
  )
  const events = Object.fromEntries(
    Object.entries(definition.events).map(([name, event]) => [name, { ...event, schema: standard(event.schema, "encode") }]),
  )
  // SAFETY: same ids, method and event names; handlers keep the Effect-typed signatures of `D` (their values are
  // validated by the same schemas, now run through this module's `effect`).
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return { ...definition, methods, events } as unknown as D
}

type Direction = "decode" | "encode"

interface StandardResult {
  readonly value?: unknown
  readonly issues?: ReadonlyArray<{ readonly message: string }>
}

/** A plain Standard Schema v1 object (never an Effect schema, so the host takes its Standard Schema path). */
export function standard<S>(schema: S, direction: Direction): S {
  if (!Schema.isSchema(schema)) return schema
  // SAFETY: own-protocol schemas need no decoding/encoding services (plain structs, literals, checks, brands).
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const codec = schema as unknown as Schema.Codec<unknown, unknown>
  const run = direction === "decode" ? Schema.decodeUnknownExit(codec) : Schema.encodeUnknownExit(codec)
  const validate = (value: unknown): StandardResult => {
    const exit = run(value, { errors: "all" })
    if (Exit.isSuccess(exit)) return { value: exit.value }
    const error = Cause.squash(exit.cause)
    return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return { "~standard": { version: 1, vendor: "own", validate } } as unknown as S
}

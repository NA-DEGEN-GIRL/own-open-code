// Ports `parse_exec_source` from codex-rs/code-mode-protocol/src/description.rs: the optional first-line
// `// @exec: {...}` pragma of Code Mode's `exec` input and its exact validation errors.
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as CodeModePragma from "./pragma.js"

export const PREFIX = "// @exec:"

const MAX_JS_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const U64_MAX = 18_446_744_073_709_551_615
const FIELDS = "`yield_time_ms` and `max_output_tokens`"

export interface ParsedExecSource {
  readonly code: string
  readonly yieldTimeMs?: number
  readonly maxOutputTokens?: number
}

/** Codex's `FunctionCallError::RespondToModel`: the message is the exact plain-text failure output the model sees. */
export class RespondToModelError extends Error {}

/**
 * Splits off a first-line `// @exec: {"yield_time_ms": N, "max_output_tokens": N}` pragma. Input without the pragma is
 * returned unchanged as `code`.
 */
export function parseExecSource(input: string): ParsedExecSource {
  if (input.trim() === "") {
    throw new RespondToModelError(
      'exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.',
    )
  }
  const newline = input.indexOf("\n")
  const firstLine = newline === -1 ? input : input.slice(0, newline)
  const rest = newline === -1 ? "" : input.slice(newline + 1)
  const trimmed = firstLine.trimStart()
  if (!trimmed.startsWith(PREFIX)) return { code: input }
  if (rest.trim() === "")
    throw new RespondToModelError("exec pragma must be followed by JavaScript source on subsequent lines")

  const directive = trimmed.slice(PREFIX.length).trim()
  if (directive === "")
    throw new RespondToModelError(`exec pragma must be a JSON object with supported fields ${FIELDS}`)
  const value = parseJson(directive)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RespondToModelError(`exec pragma must be a JSON object with supported fields ${FIELDS}`)
  }
  const fields = value as Record<string, unknown>
  const unsupported = Object.keys(fields).find((key) => key !== "yield_time_ms" && key !== "max_output_tokens")
  if (unsupported !== undefined) {
    throw new RespondToModelError(`exec pragma only supports ${FIELDS}; got \`${unsupported}\``)
  }
  // serde reports the first field that fails to deserialize; keys are visited in input order.
  const invalid = Object.keys(fields)
    .map((key) => decodeError(fields[key], key === "yield_time_ms" ? "u64" : "usize"))
    .find((error) => error !== undefined)
  if (invalid !== undefined) {
    throw new RespondToModelError(`exec pragma fields ${FIELDS} must be non-negative safe integers: ${invalid}`)
  }
  const yieldTimeMs = optionalInteger(fields.yield_time_ms)
  const maxOutputTokens = optionalInteger(fields.max_output_tokens)
  if (yieldTimeMs !== undefined && yieldTimeMs > MAX_JS_SAFE_INTEGER) {
    throw new RespondToModelError("exec pragma field `yield_time_ms` must be a non-negative safe integer")
  }
  if (maxOutputTokens !== undefined && maxOutputTokens > MAX_JS_SAFE_INTEGER) {
    throw new RespondToModelError("exec pragma field `max_output_tokens` must be a non-negative safe integer")
  }
  return {
    code: rest,
    ...(yieldTimeMs === undefined ? {} : { yieldTimeMs }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

function parseJson(directive: string): unknown {
  try {
    return JSON.parse(directive)
  } catch (error) {
    // serde_json words its syntax errors differently (`expected value at line 1 column 1`); keep the prefix exact.
    const reason = error instanceof Error ? error.message : String(error)
    throw new RespondToModelError(`exec pragma must be valid JSON with supported fields ${FIELDS}: ${reason}`)
  }
}

/** serde's message for a value that is not an `Option<u64>`/`Option<usize>`, or `undefined` when it decodes. */
function decodeError(value: unknown, expected: "u64" | "usize") {
  if (value === null) return undefined
  if (typeof value === "boolean") return `invalid type: boolean \`${value}\`, expected ${expected}`
  if (typeof value === "string") return `invalid type: string ${JSON.stringify(value)}, expected ${expected}`
  if (Array.isArray(value)) return `invalid type: sequence, expected ${expected}`
  if (typeof value === "object") return `invalid type: map, expected ${expected}`
  if (typeof value !== "number") return `invalid type: unit value, expected ${expected}`
  if (!Number.isInteger(value) || value > U64_MAX)
    return `invalid type: floating point \`${value}\`, expected ${expected}`
  if (value < 0) return `invalid value: integer \`${value}\`, expected ${expected}`
  return undefined
}

function optionalInteger(value: unknown) {
  return typeof value === "number" ? value : undefined
}

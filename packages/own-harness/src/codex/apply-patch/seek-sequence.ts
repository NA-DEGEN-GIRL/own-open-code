// Ports codex-rs/apply-patch/src/seek_sequence.rs: locating a chunk's lines with decreasing strictness.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as SeekSequence from "./seek-sequence.js"

import { RustStr } from "./rust-str.js"

/**
 * Finds `pattern` within `lines` at or after `start` and returns the first matching index. Passes, in order: exact,
 * ignoring trailing whitespace, ignoring surrounding whitespace, and finally after normalising typographic punctuation
 * to ASCII. With `eof`, the search starts where the pattern would end the file (but not before `start`).
 * An empty pattern matches at `start`; a pattern longer than `lines` never matches.
 */
export function seekSequence(
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  start: number,
  eof: boolean,
) {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined
  const searchStart = eof ? Math.max(lines.length - pattern.length, start) : start
  const last = lines.length - pattern.length
  const passes: Array<(line: string) => string> = [(line) => line, RustStr.trimEnd, RustStr.trim, normalise]
  return passes.reduce<number | undefined>(
    (found, transform) => found ?? findWith(lines, pattern, searchStart, last, transform),
    undefined,
  )
}

function findWith(
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  searchStart: number,
  last: number,
  transform: (line: string) => string,
) {
  const wanted = pattern.map(transform)
  for (let index = searchStart; index <= last; index++) {
    if (wanted.every((line, offset) => transform(lines[index + offset]!) === line)) return index
  }
  return undefined
}

/**
 * Codex's fuzzy pass: trims, then maps typographic dashes, quotes, and odd spaces to their ASCII equivalents so ASCII
 * patches apply to files with typographic punctuation (like `git apply`).
 */
function normalise(line: string) {
  return RustStr.trim(line)
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[            　]/g, " ")
}

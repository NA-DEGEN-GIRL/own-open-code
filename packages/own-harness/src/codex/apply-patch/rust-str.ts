// Rust `str` helpers the apply_patch port depends on (`trim`, `trim_end`, `lines`).
// Ported from openai/codex (Apache-2.0) @ 8c0f701167 semantics of Rust core/std, as used by codex-rs/apply-patch.
export * as RustStr from "./rust-str.js"

// Rust's `char::is_whitespace` (Unicode White_Space). JavaScript's `trim` differs: it strips U+FEFF and keeps U+0085.
const WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
])

export function trim(text: string) {
  const end = trimmedEnd(text)
  let start = 0
  while (start < end && WHITESPACE.has(text.charCodeAt(start))) start += 1
  return text.slice(start, end)
}

export function trimEnd(text: string) {
  return text.slice(0, trimmedEnd(text))
}

// All White_Space characters are in the BMP, so UTF-16 code units can be tested directly.
function trimmedEnd(text: string) {
  let end = text.length
  while (end > 0 && WHITESPACE.has(text.charCodeAt(end - 1))) end -= 1
  return end
}

/**
 * Rust's `str::lines`: splits on `\n`, drops one `\r` before each `\n`, and yields no final empty line for a trailing
 * newline. A lone `\r` is not a separator, and a final unterminated line keeps its trailing `\r`.
 */
export function lines(text: string) {
  if (text === "") return []
  const parts = text.split("\n")
  const terminated = parts.at(-1) === ""
  const kept = terminated ? parts.slice(0, -1) : parts
  return kept.map((line, index) => (index < parts.length - 1 && line.endsWith("\r") ? line.slice(0, -1) : line))
}

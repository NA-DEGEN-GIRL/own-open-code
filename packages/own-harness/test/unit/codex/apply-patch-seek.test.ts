// Ports the tests of codex-rs/apply-patch/src/seek_sequence.rs, plus checks of text_file.rs line-ending handling.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
import { describe, expect, test } from "bun:test"
import { SeekSequence } from "../../../src/codex/apply-patch/seek-sequence.js"
import { TextFile } from "../../../src/codex/apply-patch/text-file.js"

describe("seek_sequence.rs", () => {
  test("test_exact_match_finds_sequence", () => {
    expect(SeekSequence.seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toBe(1)
  })

  test("test_rstrip_match_ignores_trailing_whitespace", () => {
    expect(SeekSequence.seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0, false)).toBe(0)
  })

  test("test_trim_match_ignores_leading_and_trailing_whitespace", () => {
    expect(SeekSequence.seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toBe(0)
  })

  test("test_pattern_longer_than_input_returns_none", () => {
    expect(SeekSequence.seekSequence(["just one line"], ["too", "many", "lines"], 0, false)).toBeUndefined()
  })

  test("an empty pattern matches at start", () => {
    expect(SeekSequence.seekSequence(["a"], [], 5, false)).toBe(5)
  })

  test("eof starts at the end of the file", () => {
    expect(SeekSequence.seekSequence(["x", "y", "x", "y"], ["x", "y"], 0, true)).toBe(2)
    // Falls back to nothing earlier: the eof search does not revisit lines before its start.
    expect(SeekSequence.seekSequence(["x", "y", "z"], ["x", "y"], 0, true)).toBeUndefined()
  })

  test("the normalisation table maps typographic punctuation and spaces", () => {
    const fancy = "‐‑‒–—―− ‘’‚‛ “”„‟ a            　b"
    expect(SeekSequence.seekSequence([fancy], [`------- '''' """" a${" ".repeat(13)}b`], 0, false)).toBe(0)
    // The ellipsis U+2026 is not in the table.
    expect(SeekSequence.seekSequence(["a…"], ["a..."], 0, false)).toBeUndefined()
  })
})

describe("text_file.rs", () => {
  const rebuild = (contents: string, replacements: Array<TextFile.Replacement>) =>
    TextFile.applyReplacements(TextFile.parse(contents), replacements)

  test("splits on CRLF, CR, and LF and keeps each ending", () => {
    const file = TextFile.parse("a\r\nb\rc\nd")
    expect(TextFile.lineTexts(file)).toEqual(["a", "b", "c", "d"])
    expect(file.preferredEnding).toBe("\r\n")
    expect(TextFile.parse("plain").preferredEnding).toBe("\n")
  })

  test("unchanged lines keep their endings, inserted lines use the first ending, every line ends", () => {
    expect(rebuild("one\r\ntwo\rthree\nfour", [[2, 1, ["THREE", "new"]]])).toBe("one\r\ntwo\rTHREE\r\nnew\r\nfour\r\n")
    expect(rebuild("", [[0, 0, ["x"]]])).toBe("x\n")
  })
})

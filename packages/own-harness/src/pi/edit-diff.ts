// Ports packages/coding-agent/src/core/tools/edit-diff.ts: Pi's exact-text replacement (every edit matched against the
// original content, exact first and then a fuzzy normal form that strips trailing whitespace and folds smart quotes,
// dashes, special spaces and NFKC forms), its error texts, the line-numbered display diff and the unified patch.
// Matching runs on the LF-normalized text; the replacements are then spliced into the original, so untouched lines keep
// their line endings (Pi 1.5.1, d448c51e2, #8544). Pi's windowed `generateEditDiff` is not ported: own's approval card
// diffs the whole file anyway (tools.ts), and the display diff and patch are the same text.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiEditDiff from "./edit-diff.js"

import { createTwoFilesPatch, diffLines, FILE_HEADERS_ONLY } from "diff"

export interface Edit {
  readonly oldText: string
  readonly newText: string
}

export function normalizeToLF(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Replacement of `matchLength` characters at `matchIndex` with `newText`. */
export interface Replacement {
  readonly matchIndex: number
  readonly matchLength: number
  readonly newText: string
}

/**
 * Applies replacements matched in `normalizeToLF(originalContent)` to `originalContent` itself. Text outside the
 * replaced ranges keeps its bytes, including its line endings. Line breaks in the new text get the line ending of the
 * line where the replaced range starts. The result, normalized to LF, equals the replacements applied to the
 * normalized content.
 */
export function applyReplacementsToOriginal(originalContent: string, replacements: ReadonlyArray<Replacement>) {
  // Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is at p - n in the
  // normalized text. Adding the number of CRLFs before a normalized offset gives the original offset, and a range that
  // covers that LF covers the whole CRLF. Offsets are asked in increasing order, so the count only moves forward.
  const crlf = { before: 0, next: originalContent.indexOf("\r\n") }
  const toOriginal = (offset: number) => {
    while (crlf.next !== -1 && crlf.next - crlf.before < offset) {
      crlf.before++
      crlf.next = originalContent.indexOf("\r\n", crlf.next + 2)
    }
    return offset + crlf.before
  }
  const cursor = { at: 0 }
  const parts = replacements.flatMap((replacement) => {
    const start = toOriginal(replacement.matchIndex)
    const kept = originalContent.slice(cursor.at, start)
    const ending = lineEndingAt(originalContent, start)
    cursor.at = toOriginal(replacement.matchIndex + replacement.matchLength)
    return [kept, ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending)]
  })
  // A CR before a seam and an LF after it would merge into one CRLF line break, for example a kept lone CR followed by
  // inserted text that starts with LF, or both sides of a deleted range. Adding an LF turns the CR into a CRLF of its
  // own, so the written file has the line breaks the diff shows.
  return [...parts, originalContent.slice(cursor.at)]
    .filter((part) => part.length > 0)
    .map((part, index, all) => (all[index - 1]?.endsWith("\r") && part.startsWith("\n") ? `\n${part}` : part))
    .join("")
}

/**
 * `getLineEndingAt`: the line ending of the line containing `offset`, its own LF or CRLF, or that of the line before
 * for an unterminated last line. A lone CR only counts in files without any LF (classic Mac line endings); elsewhere it
 * is more likely a control character inside a line.
 */
function lineEndingAt(content: string, offset: number): "\r\n" | "\n" | "\r" {
  const ahead = content.indexOf("\n", offset)
  const lineFeed = ahead === -1 ? content.lastIndexOf("\n", offset) : ahead
  if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n"
  return content[lineFeed - 1] === "\r" ? "\r\n" : "\n"
}

/** A leading UTF-8 byte order mark apart from the text; the model never includes it in oldText. */
export function splitBom(content: string) {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content }
}

/** The fuzzy normal form: NFKC, no trailing whitespace per line, ASCII quotes, dashes and spaces. */
export function normalizeForFuzzyMatch(text: string) {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ")
}

export interface FuzzyMatch {
  readonly found: boolean
  readonly index: number
  readonly matchLength: number
  readonly usedFuzzyMatch: boolean
  /** The content offsets refer to: the original on an exact match, the normal form on a fuzzy one. */
  readonly contentForReplacement: string
}

/** `oldText` in `content`, exactly first, then in the fuzzy normal form of both. */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatch {
  const exact = content.indexOf(oldText)
  if (exact !== -1)
    return {
      found: true,
      index: exact,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    }
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOld = normalizeForFuzzyMatch(oldText)
  const index = fuzzyContent.indexOf(fuzzyOld)
  if (index === -1)
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content }
  return { found: true, index, matchLength: fuzzyOld.length, usedFuzzyMatch: true, contentForReplacement: fuzzyContent }
}

interface Matched extends Replacement {
  readonly editIndex: number
}

/**
 * Applies every edit to LF-normalized content. All edits match the same original; if any needs the fuzzy form, the
 * replacement runs in that form and only the touched lines are rewritten from it, so other lines keep their bytes.
 * Also answers the sorted replacements of `baseContent` that make `newContent` ({@link applyReplacementsToOriginal}).
 */
export function applyEditsToNormalizedContent(normalizedContent: string, edits: ReadonlyArray<Edit>, file: string) {
  const normalized = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }))
  const empty = normalized.findIndex((edit) => edit.oldText.length === 0)
  if (empty !== -1) throw emptyOldTextError(file, empty, normalized.length)
  const usedFuzzyMatch = normalized.some((edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch)
  const replacementBase = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent
  const matched = normalized
    .map((edit, index): Matched => {
      const match = fuzzyFindText(replacementBase, edit.oldText)
      if (!match.found) throw notFoundError(file, index, normalized.length)
      const occurrences = countOccurrences(replacementBase, edit.oldText)
      if (occurrences > 1) throw duplicateError(file, index, normalized.length, occurrences)
      return { editIndex: index, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText }
    })
    .toSorted((a, b) => a.matchIndex - b.matchIndex)
  matched.forEach((current, index) => {
    const previous = matched[index - 1]
    if (previous !== undefined && previous.matchIndex + previous.matchLength > current.matchIndex)
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${file}. Merge them into one edit or target disjoint regions.`,
      )
  })
  const replacements = usedFuzzyMatch ? widenReplacementsToLines(normalizedContent, replacementBase, matched) : matched
  const newContent = applyReplacements(normalizedContent, replacements)
  if (normalizedContent === newContent) throw noChangeError(file, normalized.length)
  return { baseContent: normalizedContent, newContent, replacements }
}

/**
 * Turns replacements matched against `baseContent` (a normal form of `originalContent`) into replacements of the
 * original that keep its unchanged line blocks: each replacement is widened to the lines it touches, those lines are
 * rewritten from the normal form, and every other line keeps its original text. The actual replacement ranges drive
 * this, so duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
function widenReplacementsToLines(
  originalContent: string,
  baseContent: string,
  replacements: ReadonlyArray<Replacement>,
) {
  const originalLines = lineSpans(originalContent)
  const baseLines = lineSpans(baseContent)
  if (originalLines.length !== baseLines.length)
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.")
  const groups = replacements
    .toSorted((a, b) => a.matchIndex - b.matchIndex)
    .reduce<Array<{ startLine: number; endLine: number; replacements: Array<Replacement> }>>((all, replacement) => {
      const range = replacementLineRange(baseLines, replacement)
      const current = all.at(-1)
      if (current !== undefined && range.startLine < current.endLine)
        return [
          ...all.slice(0, -1),
          {
            startLine: current.startLine,
            endLine: Math.max(current.endLine, range.endLine),
            replacements: [...current.replacements, replacement],
          },
        ]
      return [...all, { ...range, replacements: [replacement] }]
    }, [])
  return groups.map((group) => {
    const start = baseLines[group.startLine]!.start
    const end = baseLines[group.endLine - 1]!.end
    const originalStart = originalLines[group.startLine]!.start
    return {
      matchIndex: originalStart,
      matchLength: originalLines[group.endLine - 1]!.end - originalStart,
      newText: applyReplacements(baseContent.slice(start, end), group.replacements, start),
    }
  })
}

/** `Diff.createTwoFilesPatch` with file headers only and 4 context lines. */
export function generateUnifiedPatch(file: string, oldContent: string, newContent: string, contextLines = 4) {
  return createTwoFilesPatch(file, file, oldContent, newContent, undefined, undefined, {
    context: contextLines,
    headerOptions: FILE_HEADERS_ONLY,
  })
}

/**
 * The display diff: changed lines as `+N text` / `-N text` with line numbers padded to the widest, up to
 * `contextLines` unchanged lines around each change and ` ...` for skipped runs. Also the first changed line in the
 * new file.
 */
export function generateDiffString(oldContent: string, newContent: string, contextLines = 4) {
  const parts = diffLines(oldContent, newContent)
  const width = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length
  const number = (value: number) => String(value).padStart(width, " ")
  const gap = ` ${"".padStart(width, " ")} ...`
  const result = parts.reduce(
    (state, part, index) => {
      const raw = part.value.split("\n")
      const lines = raw.at(-1) === "" ? raw.slice(0, -1) : raw
      if (part.added || part.removed) {
        const first = state.firstChangedLine ?? state.newLine
        const shown = lines.map((line, offset) =>
          part.added ? `+${number(state.newLine + offset)} ${line}` : `-${number(state.oldLine + offset)} ${line}`,
        )
        return {
          output: [...state.output, ...shown],
          oldLine: state.oldLine + (part.removed ? lines.length : 0),
          newLine: state.newLine + (part.added ? lines.length : 0),
          lastWasChange: true,
          firstChangedLine: first,
        }
      }
      const next = parts[index + 1]
      const trailing = next !== undefined && (next.added === true || next.removed === true)
      const context = (from: number, slice: ReadonlyArray<string>) =>
        slice.map((line, offset) => ` ${number(from + offset)} ${line}`)
      const shown = ((): ReadonlyArray<string> => {
        if (state.lastWasChange && trailing) {
          if (lines.length <= contextLines * 2) return context(state.oldLine, lines)
          const skipped = lines.length - contextLines * 2
          return [
            ...context(state.oldLine, lines.slice(0, contextLines)),
            gap,
            ...context(state.oldLine + contextLines + skipped, lines.slice(lines.length - contextLines)),
          ]
        }
        if (state.lastWasChange) {
          const head = lines.slice(0, contextLines)
          return [...context(state.oldLine, head), ...(lines.length > head.length ? [gap] : [])]
        }
        if (trailing) {
          const skipped = Math.max(0, lines.length - contextLines)
          return [...(skipped > 0 ? [gap] : []), ...context(state.oldLine + skipped, lines.slice(skipped))]
        }
        return []
      })()
      return {
        output: [...state.output, ...shown],
        oldLine: state.oldLine + lines.length,
        newLine: state.newLine + lines.length,
        lastWasChange: false,
        firstChangedLine: state.firstChangedLine,
      }
    },
    {
      output: [] as ReadonlyArray<string>,
      oldLine: 1,
      newLine: 1,
      lastWasChange: false,
      firstChangedLine: undefined as number | undefined,
    },
  )
  return { diff: result.output.join("\n"), firstChangedLine: result.firstChangedLine }
}

/** Each line's span, its line ending included. */
function lineSpans(content: string) {
  const offset = { at: 0 }
  return (content.match(/[^\n]*\n|[^\n]+/g) ?? []).map((line) => {
    const span = { start: offset.at, end: offset.at + line.length }
    offset.at = span.end
    return span
  })
}

function replacementLineRange(lines: ReadonlyArray<{ start: number; end: number }>, replacement: Replacement) {
  const start = replacement.matchIndex
  const end = replacement.matchIndex + replacement.matchLength
  const startLine = lines.findIndex((line) => start >= line.start && start < line.end)
  if (startLine === -1) throw new Error("Replacement range is outside the base content.")
  const endLine = lines.findIndex((line, index) => index >= startLine && line.end >= end)
  if (endLine === -1) throw new Error("Replacement range is outside the base content.")
  return { startLine, endLine: endLine + 1 }
}

function applyReplacements(content: string, replacements: ReadonlyArray<Replacement>, offset = 0) {
  return replacements.toReversed().reduce((result, replacement) => {
    const at = replacement.matchIndex - offset
    return result.substring(0, at) + replacement.newText + result.substring(at + replacement.matchLength)
  }, content)
}

function countOccurrences(content: string, oldText: string) {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1
}

function notFoundError(file: string, index: number, total: number) {
  if (total === 1)
    return new Error(
      `Could not find the exact text in ${file}. The old text must match exactly including all whitespace and newlines.`,
    )
  return new Error(
    `Could not find edits[${index}] in ${file}. The oldText must match exactly including all whitespace and newlines.`,
  )
}

function duplicateError(file: string, index: number, total: number, occurrences: number) {
  if (total === 1)
    return new Error(
      `Found ${occurrences} occurrences of the text in ${file}. The text must be unique. Please provide more context to make it unique.`,
    )
  return new Error(
    `Found ${occurrences} occurrences of edits[${index}] in ${file}. Each oldText must be unique. Please provide more context to make it unique.`,
  )
}

function emptyOldTextError(file: string, index: number, total: number) {
  if (total === 1) return new Error(`oldText must not be empty in ${file}.`)
  return new Error(`edits[${index}].oldText must not be empty in ${file}.`)
}

function noChangeError(file: string, total: number) {
  if (total === 1)
    return new Error(
      `No changes made to ${file}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    )
  return new Error(`No changes made to ${file}. The replacements produced identical content.`)
}

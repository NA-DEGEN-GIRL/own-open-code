// Ports codex-rs/apply-patch/src/text_file.rs: line splitting that keeps each line's own ending (codex#51203).
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as TextFile from "./text-file.js"

/** `[startIndex, oldLength, newLines]`, applied in source order without overlap. */
export type Replacement = readonly [number, number, ReadonlyArray<string>]

type Ending = "\n" | "\r\n" | "\r"

interface SourceLine {
  text: string
  ending: Ending | undefined
}

export interface SourceFile {
  lines: Array<SourceLine>
  /** The first ending in the file (LF when there is none); inserted lines use it. */
  preferredEnding: Ending
}

/** Splits contents into lines at `\r\n`, `\r`, or `\n`, keeping each ending. */
export function parse(contents: string): SourceFile {
  const lines: Array<SourceLine> = []
  const pattern = /\r\n|\r|\n/g
  let lineStart = 0
  for (const match of contents.matchAll(pattern)) {
    lines.push({ text: contents.slice(lineStart, match.index), ending: match[0] as Ending })
    lineStart = match.index + match[0].length
  }
  if (lineStart < contents.length) lines.push({ text: contents.slice(lineStart), ending: undefined })
  return { lines, preferredEnding: lines[0]?.ending ?? "\n" }
}

export function lineTexts(file: SourceFile) {
  return file.lines.map((line) => line.text)
}

/**
 * Rebuilds the contents after source-ordered replacements: unchanged lines keep their own endings, inserted lines use
 * the preferred ending, and every line ends with one (apply_patch has always added a trailing newline).
 */
export function applyReplacements(file: SourceFile, replacements: ReadonlyArray<Replacement>) {
  const segments: Array<Array<SourceLine>> = []
  let sourceIndex = 0
  for (const [start, oldLength, newLines] of replacements) {
    segments.push(file.lines.slice(sourceIndex, start))
    segments.push(newLines.map((text) => ({ text, ending: file.preferredEnding })))
    sourceIndex = start + oldLength
  }
  segments.push(file.lines.slice(sourceIndex))
  return segments
    .flat()
    .map((line) => line.text + (line.ending ?? file.preferredEnding))
    .join("")
}

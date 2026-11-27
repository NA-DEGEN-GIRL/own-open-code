// Idea notes (03 §4.4.1 아이디어 노트): the pure rules of the board. Kept free of Solid and the data layer so the first
// chunk (the header button, the layer) and the tests can import them.
import type { Ideas } from "@own/protocol/ideas"

/** One idea as `ideas.list` and `ideas.put` answer it (own.accounts, 02 §9.2). */
export interface Idea {
  readonly id: string
  readonly text: string
  readonly color: Ideas.Color
  readonly pinned: boolean
  readonly rev: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** A `#tag` in the text: letters, digits, `_` and `-` after a `#` that starts a word (`C#` is no tag). */
const TAG = /(?:^|[\s([{])#([\p{L}\p{N}_-]{1,30})/gu

/** Pinned first, then newest first. Editing never moves a card: the order is the creation time. */
export function sortIdeas(ideas: readonly Idea[]) {
  return [...ideas].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  )
}

/** The idea's `#tags`, lower-cased for matching, each once, in the order they appear. */
export function tagsOf(text: string) {
  return [...new Set([...text.matchAll(TAG)].map((match) => match[1]!.toLowerCase()))]
}

/** Every tag of the board with how many ideas carry it, most used first, then alphabetically. */
export function tagCounts(ideas: readonly Idea[]) {
  const counts = new Map<string, number>()
  for (const idea of ideas) for (const tag of tagsOf(idea.text)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/**
 * The board's filter: every word of the search appears in the text (case-insensitive), and the idea carries the chosen
 * tag. A `#word` in the search must be one of the idea's tags.
 */
export function filterIdeas(ideas: readonly Idea[], filter: { readonly query: string; readonly tag?: string }) {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean)
  return ideas.filter((idea) => {
    const text = idea.text.toLowerCase()
    const tags = tagsOf(idea.text)
    if (filter.tag && !tags.includes(filter.tag)) return false
    return words.every((word) =>
      word.length > 1 && word.startsWith("#") ? tags.includes(word.slice(1)) : text.includes(word),
    )
  })
}

/** The first line with something to read, for a project note's title (at most `max` characters). */
export function titleOf(text: string, max: number) {
  const line =
    text
      .split("\n")
      .find((part) => part.trim())
      ?.trim() ?? ""
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** What a save sends: without blank lines before and spaces after; `undefined` when nothing is left to read. */
export function cleanText(text: string) {
  const trimmed = text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "")
  return /\S/.test(trimmed) ? trimmed : undefined
}

/** The text cut at its `#tags`, so the board can make each tag a filter button. */
export function segments(text: string) {
  const parts: { readonly text: string; readonly tag?: string }[] = []
  let last = 0
  for (const match of text.matchAll(TAG)) {
    const start = match.index + match[0].length - match[1]!.length - 1
    if (start > last) parts.push({ text: text.slice(last, start) })
    parts.push({ text: `#${match[1]}`, tag: match[1]!.toLowerCase() })
    last = start + match[1]!.length + 1
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}

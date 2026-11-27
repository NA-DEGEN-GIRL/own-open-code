// Ranking of local candidates (agents, skills, references, MCP resources, commands). Small lists (tens to a few
// hundred), so one linear pass per keystroke: exact > prefix > word start > substring > in-order letters. Like
// upstream (`filterKeys: ["label"]`, commands `["trigger", "title"]`) only names are matched, never descriptions;
// in-order letters count on the first key only, so a long second key cannot produce noise. Files are never re-ranked
// here: `fs.find` ranks them on the server (03 §18.12).

/** Characters after which a word starts (`src/router.ts`, `code-review`, `docs:summarize`). */
const BOUNDARY = new Set(["/", "\\", "-", "_", ".", ":", " ", "@", "#"])

/** Higher is better; `-1` means no match. An empty query matches everything with 0. */
export function score(candidate: string, query: string, loose = true): number {
  if (!query) return 0
  const text = candidate.toLowerCase()
  const needle = query.toLowerCase()
  if (text === needle) return 1_000
  if (text.startsWith(needle)) return 900 - Math.min(99, text.length - needle.length)
  const boundary = boundaryIndex(text, needle)
  if (boundary >= 0) return 800 - Math.min(99, boundary)
  const index = text.indexOf(needle)
  if (index >= 0) return 600 - Math.min(99, index)
  return loose ? subsequence(text, needle) : -1
}

/** Best score over an item's keys; later keys match strictly (no in-order letters). */
export function bestScore<T>(item: T, query: string, keys: (item: T) => readonly string[]) {
  return keys(item).reduce((top, key, position) => Math.max(top, score(key, query, position === 0)), -1)
}

/**
 * Match class for choosing the preselected row across groups: exact/prefix 3, word start 2, substring 1, else 0. The
 * bands follow {@link score}: exact 1000, prefix 801-899, word start 701-799, substring 501-599, letters ≤ 499.
 */
export function matchClass(value: number) {
  if (value > 800) return 3
  if (value > 700) return 2
  if (value > 500) return 1
  return 0
}

/** Keeps the matching items, best first; ties keep the given order (catalog order is meaningful: built-ins first). */
export function rank<T>(items: readonly T[], query: string, keys: (item: T) => readonly string[], limit: number): T[] {
  const trimmed = query.trim()
  if (!trimmed) return items.slice(0, limit)
  return items
    .flatMap((item, index) => {
      const best = bestScore(item, trimmed, keys)
      return best < 0 ? [] : [{ item, index, best }]
    })
    .toSorted((a, b) => b.best - a.best || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item)
}

function boundaryIndex(text: string, needle: string) {
  for (let index = text.indexOf(needle, 1); index > 0; index = text.indexOf(needle, index + 1))
    if (BOUNDARY.has(text[index - 1]!)) return index
  return -1
}

/** Letters in order (`rtr` → `router`), rewarding runs and word starts; always below a substring match. */
function subsequence(text: string, needle: string) {
  let at = 0
  let bonus = 0
  let previous = -2
  for (const char of needle) {
    const found = text.indexOf(char, at)
    if (found < 0) return -1
    if (found === previous + 1) bonus += 5
    if (found === 0 || BOUNDARY.has(text[found - 1]!)) bonus += 3
    previous = found
    at = found + 1
  }
  return Math.min(499, 100 + bonus - Math.min(90, previous - needle.length))
}

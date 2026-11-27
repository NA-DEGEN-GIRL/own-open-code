// Palette search (03 §10 Ctrl+K, §12 test 11): every query word must appear in order (subsequence) in the title or the
// hidden keywords; word starts and runs score higher, gaps lower. Korean:
//   - initial consonants: `ㅌㅁㄴ` finds 터미널 (a lone consonant matches a syllable that starts with it),
//   - the syllable an IME is still composing: while typing 세션 the box shows 셋 (세 + a final ㅅ that becomes the
//     next initial) and then 셔 (no final yet); both keep 세션 in the list, so results follow the composition without
//     jumping (03 §12 rule 11: the list updates while composing).
// Targets are prepared once per open; a keystroke scans them once (linear in their total length, no allocation per
// character), which keeps a few thousand sessions well under a frame.

const SYLLABLE_FIRST = 0xac00
const SYLLABLE_LAST = 0xd7a3
const JAMO_FIRST = 0x3131
const JAMO_LAST = 0x314e
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
/** Final consonant index (1–27) → [the final that stays, the initial it becomes on the next syllable]. */
const FINAL_SPLIT: readonly (readonly [number, string])[] = [
  [0, ""],
  [0, "ㄱ"],
  [0, "ㄲ"],
  [1, "ㅅ"],
  [0, "ㄴ"],
  [4, "ㅈ"],
  [4, "ㅎ"],
  [0, "ㄷ"],
  [0, "ㄹ"],
  [8, "ㄱ"],
  [8, "ㅁ"],
  [8, "ㅂ"],
  [8, "ㅅ"],
  [8, "ㅌ"],
  [8, "ㅍ"],
  [8, "ㅎ"],
  [0, "ㅁ"],
  [0, "ㅂ"],
  [17, "ㅅ"],
  [0, "ㅅ"],
  [0, "ㅆ"],
  [0, "ㅇ"],
  [0, "ㅈ"],
  [0, "ㅊ"],
  [0, "ㅋ"],
  [0, "ㅌ"],
  [0, "ㅍ"],
  [0, "ㅎ"],
]

export interface Prepared {
  /** Lower-cased, same length as the source text. */
  readonly lower: string
  /** Initial consonant of each syllable, the lower-cased character elsewhere. */
  readonly initials: string
  /** 1 where a word starts (after a separator, a camelCase hump, a script change). */
  readonly starts: Uint8Array
}

export function prepare(text: string): Prepared {
  const chars = Array.from(text, (char) => {
    const lower = char.toLowerCase()
    return lower.length === char.length ? lower : char
  })
  const lower = chars.join("")
  const initials = chars.map((char) => initialOf(char) ?? char).join("")
  const starts = new Uint8Array(lower.length)
  for (let index = 0; index < lower.length; index++) starts[index] = wordStart(text, lower, index) ? 1 : 0
  return { lower, initials, starts }
}

type Kind = "exact" | "initial" | "syllable"

interface QueryChar {
  readonly char: string
  readonly kind: Kind
  /** `syllable`: the initial and medial the target syllable must share. */
  readonly base?: number
}

export type Term = readonly (readonly QueryChar[])[]

/** Splits a query into words; each word gets one or two spellings (the second for a composing final consonant). */
export function parseQuery(query: string): Term[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return words.map((word, index) => spellings(Array.from(word), index === words.length - 1))
}

function spellings(chars: readonly string[], last: boolean): (readonly QueryChar[])[] {
  const plain = chars.map((char, index) => queryChar(char, last && index === chars.length - 1))
  const tail = chars.at(-1)
  const code = tail?.charCodeAt(0) ?? 0
  if (!last || !tail || !isSyllable(code)) return [plain]
  const final = (code - SYLLABLE_FIRST) % 28
  if (final === 0) return [plain]
  // 셋 while typing 세션: the final ㅅ may still become the next syllable's initial.
  const [kept, initial] = FINAL_SPLIT[final]!
  const head = String.fromCharCode(code - final + kept)
  const split = [...chars.slice(0, -1).map((char) => queryChar(char, false)), queryChar(head, false)]
  return [plain, [...split, { char: initial, kind: "initial" }]]
}

function queryChar(char: string, last: boolean): QueryChar {
  const code = char.charCodeAt(0)
  if (code >= JAMO_FIRST && code <= JAMO_LAST && INITIALS.includes(char)) return { char, kind: "initial" }
  // The last syllable without a final may still get one (셔 → 션): same initial and medial is enough.
  if (last && isSyllable(code) && (code - SYLLABLE_FIRST) % 28 === 0)
    return { char, kind: "syllable", base: Math.floor((code - SYLLABLE_FIRST) / 28) }
  return { char, kind: "exact" }
}

export interface Match {
  readonly score: number
  /** Matched indices in the target, ascending. */
  readonly positions: readonly number[]
}

/** Best spelling of one word against one target; `undefined` when no spelling appears in order. */
export function matchTerm(term: Term, target: Prepared): Match | undefined {
  const matches = term.flatMap((spelling) => {
    const match = matchSpelling(spelling, target)
    return match ? [match] : []
  })
  return matches.reduce<Match | undefined>(
    (best, match) => (!best || match.score > best.score ? match : best),
    undefined,
  )
}

function matchSpelling(query: readonly QueryChar[], target: Prepared): Match | undefined {
  if (!query.length) return { score: 0, positions: [] }
  const length = target.lower.length
  // Forward: the first place the whole word appears in order.
  let q = 0
  let end = -1
  for (let index = 0; index < length && q < query.length; index++) {
    if (!hit(query[q]!, target, index)) continue
    q++
    if (q === query.length) end = index
  }
  if (end < 0) return undefined
  // Backward from that end: the tightest window, so `term` in "terminal · new terminal" does not spread out.
  const positions = new Array<number>(query.length)
  q = query.length - 1
  for (let index = end; index >= 0 && q >= 0; index--) {
    if (!hit(query[q]!, target, index)) continue
    positions[q] = index
    q--
  }
  return { score: score(query, target, positions), positions }
}

function hit(query: QueryChar, target: Prepared, index: number) {
  const char = target.lower[index]!
  if (char === query.char) return true
  if (query.kind === "initial") return target.initials[index] === query.char
  if (query.kind === "syllable") {
    const code = char.charCodeAt(0)
    return isSyllable(code) && Math.floor((code - SYLLABLE_FIRST) / 28) === query.base
  }
  return false
}

function score(query: readonly QueryChar[], target: Prepared, positions: readonly number[]) {
  const total = positions.reduce((sum, position, index) => {
    const exact = target.lower[position] === query[index]!.char
    const base = exact ? 10 : 8
    const start = target.starts[position] ? 8 : 0
    const previous = index > 0 ? positions[index - 1]! : -1
    const run = index > 0 && position === previous + 1 ? 6 : 0
    const gap = index > 0 ? Math.min(position - previous - 1, 5) : Math.min(position, 5) * 0.5
    return sum + base + start + run - gap
  }, 0)
  // The whole word at the very start of the target ("설정" typed, "설정: 셸·터미널" listed).
  const prefix = positions[0] === 0 && positions.every((position, index) => position === index) ? 4 : 0
  // Shorter targets win ties: "터미널" before "터미널 위치: 대화 아래".
  return total + prefix - target.lower.length * 0.02
}

export interface Candidate {
  readonly title: Prepared
  /** The hidden keywords joined with " · ". */
  readonly keywords?: Prepared
  readonly detail?: Prepared
}

/** Weight of a word matched in the keywords or the detail instead of the title. */
const KEYWORD_WEIGHT = 0.8
const DETAIL_WEIGHT = 0.5

export interface CandidateMatch {
  readonly score: number
  /** Title positions to highlight. */
  readonly positions: readonly number[]
}

/** Every word must match somewhere (title, keywords or detail); each takes its best field. */
export function matchCandidate(terms: readonly Term[], candidate: Candidate): CandidateMatch | undefined {
  const positions: number[] = []
  let total = 0
  for (const term of terms) {
    const title = matchTerm(term, candidate.title)
    const keywords = candidate.keywords ? matchTerm(term, candidate.keywords) : undefined
    const detail = candidate.detail ? matchTerm(term, candidate.detail) : undefined
    const best = Math.max(
      title?.score ?? -Infinity,
      (keywords?.score ?? -Infinity) * KEYWORD_WEIGHT,
      (detail?.score ?? -Infinity) * DETAIL_WEIGHT,
    )
    if (best === -Infinity) return undefined
    total += best
    if (title && title.score === best) positions.push(...title.positions)
  }
  return { score: total, positions: [...new Set(positions)].sort((a, b) => a - b) }
}

function initialOf(char: string) {
  const code = char.charCodeAt(0)
  if (!isSyllable(code)) return undefined
  return INITIALS[Math.floor((code - SYLLABLE_FIRST) / 588)]
}

function isSyllable(code: number) {
  return code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST
}

function wordStart(text: string, lower: string, index: number) {
  if (index === 0) return true
  const previous = lower[index - 1]!
  const current = lower[index]!
  if (/[\s\-_/\\.:·@,()[\]]/.test(previous)) return !/[\s\-_/\\.:·@,()[\]]/.test(current)
  // camelCase hump: `newSession` → Session.
  if (text[index] !== current && text[index - 1] === previous) return true
  // Script change: `MCP목록`, `v2세션`.
  return isSyllable(previous.charCodeAt(0)) !== isSyllable(current.charCodeAt(0))
}

// The BM25 search Codex's `tool_search` runs over deferred tools: the bm25 2.3.2 crate's `EmbedderBuilder::
// with_fit_to_corpus(Language::English, …)` and `Scorer<usize>` (codex-rs/core/src/tools/handlers/tool_search.rs).
//
// Tokenizer (bm25 `DefaultTokenizer`, English, normalization + stopwords + stemming): deunicode's ASCII
// transliteration (`[?]` for unknown characters), lowercase, UAX #29 words that contain an alphanumeric character
// (unicode-segmentation `unicode_words`), minus the NLTK English stopwords (stop-words 0.9.0), each stemmed with the
// Snowball English stemmer (rust-stemmers 1.2.0). Tokens are embedded by `fxhash::hash32`. A document's token value
// is `tf·(k1+1) / (tf + k1·(1 − b + b·len/avgdl))` with k1 = 1.2, b = 0.75 and avgdl the corpus' mean token count;
// a document scores Σ over query tokens (repeats included) of `ln(1 + (N − n + 0.5)/(n + 0.5)) · value`, all in f32.
// Ported from bm25 (MIT), unicode-segmentation, fxhash (MIT/Apache-2.0), stop-words (MIT/Apache-2.0) and
// deunicode (BSD-3-Clause) at the versions openai/codex (Apache-2.0) @ rust-v0.162.1 locks.
//
// Not reproduced: deunicode's table outside the blocks in `deunicode-data.ts` (other characters fall back to their
// NFKD ASCII letters, else `[?]`), and Codex's order among equal scores, which comes from a randomly seeded
// `HashSet` and so varies between runs; here ties keep corpus order.
export * as Bm25 from "./index.js"

import { BLOCKS } from "./deunicode-data.js"
import { EnglishStemmer } from "./stemmer.js"

const K1 = Math.fround(1.2)
const B = Math.fround(0.75)
const FALLBACK_AVGDL = 256

/** stop-words 0.9.0 `nltk/english`. */
const STOPWORDS = new Set(
  (
    "i me my myself we our ours ourselves you you're you've you'll you'd your yours yourself yourselves he him his " +
    "himself she she's her hers herself it it's its itself they them their theirs themselves what which who whom this " +
    "that that'll these those am is are was were be been being have has had having do does did doing a an the and but " +
    "if or because as until while of at by for with about against between into through during before after above " +
    "below to from up down in out on off over under again further then once here there when where why how all any " +
    "both each few more most other some such no nor not only own same so than too very s t can will just don don't " +
    "should should've now d ll m o re ve y ain aren aren't couldn couldn't didn didn't doesn doesn't hadn hadn't hasn " +
    "hasn't haven haven't isn isn't ma mightn mightn't mustn mustn't needn needn't shan shan't shouldn shouldn't wasn " +
    "wasn't weren weren't won won't wouldn wouldn't"
  ).split(" "),
)

export interface Match {
  /** Index of the document in the corpus. */
  readonly id: number
  readonly score: number
}

/** An embedder fit to `corpus` plus a scorer holding every document, as `ToolSearchHandler::new` builds them. */
export class Index {
  private readonly avgdl: number
  private readonly documents: ReadonlyArray<ReadonlyArray<Token>>
  private readonly containing = new Map<number, Set<number>>()

  constructor(corpus: ReadonlyArray<string>) {
    const tokenized = corpus.map(tokenize)
    const total = tokenized.reduce((sum, tokens) => sum + tokens.length, 0)
    this.avgdl = corpus.length === 0 ? FALLBACK_AVGDL : Math.fround(total / corpus.length)
    this.documents = tokenized.map((tokens) => this.embed(tokens))
    this.documents.forEach((tokens, id) =>
      tokens.forEach((token) => {
        const set = this.containing.get(token.index) ?? new Set<number>()
        set.add(id)
        this.containing.set(token.index, set)
      }),
    )
  }

  /** `Scorer::matches`: every document sharing a token with the query, best first. */
  matches(query: string): ReadonlyArray<Match> {
    const tokens = tokenize(query).map(hash32)
    const candidates = new Set(tokens.flatMap((index) => [...(this.containing.get(index) ?? [])]))
    return [...candidates]
      .toSorted((left, right) => left - right)
      .map((id) => ({ id, score: this.score(this.documents[id]!, tokens) }))
      .toSorted((left, right) => right.score - left.score)
  }

  private score(document: ReadonlyArray<Token>, query: ReadonlyArray<number>) {
    return query.reduce((sum, index) => {
      const value = document.find((token) => token.index === index)?.value ?? 0
      return Math.fround(sum + Math.fround(this.idf(index) * value))
    }, 0)
  }

  private idf(index: number) {
    const frequency = this.containing.get(index)?.size ?? 0
    const numerator = Math.fround(Math.fround(this.documents.length - frequency) + 0.5)
    const denominator = Math.fround(frequency + 0.5)
    return Math.fround(Math.log(Math.fround(1 + Math.fround(numerator / denominator))))
  }

  private embed(tokens: ReadonlyArray<string>): ReadonlyArray<Token> {
    const avgdl = this.avgdl <= 0 ? FALLBACK_AVGDL : this.avgdl
    const indices = tokens.map(hash32)
    const counts = indices.reduce((map, index) => map.set(index, (map.get(index) ?? 0) + 1), new Map<number, number>())
    const lengthRatio = Math.fround(B * Math.fround(tokens.length / avgdl))
    const normalizer = Math.fround(K1 * Math.fround(Math.fround(1 - B) + lengthRatio))
    return indices.map((index) => {
      const frequency = counts.get(index) ?? 0
      const numerator = Math.fround(frequency * Math.fround(K1 + 1))
      return { index, value: Math.fround(numerator / Math.fround(frequency + normalizer)) }
    })
  }
}

interface Token {
  readonly index: number
  readonly value: number
}

/** `DefaultTokenizer::tokenize` for English. */
export function tokenize(text: string): ReadonlyArray<string> {
  if (text === "") return []
  return words(deunicode(text).toLowerCase())
    .filter((word) => !STOPWORDS.has(word))
    .map(EnglishStemmer.stem)
}

/** `fxhash::hash32` of a `str` (its bytes, then the `0xff` terminator `Hash for str` writes). */
export function hash32(token: string) {
  const bytes = new TextEncoder().encode(token)
  const word = (hash: number, value: number) => Math.imul(((hash << 5) | (hash >>> 27)) ^ value, 0x27220a95)
  const whole = Math.floor(bytes.length / 4) * 4
  const words = Array.from({ length: whole / 4 }, (_, index) =>
    new DataView(bytes.buffer, bytes.byteOffset + index * 4, 4).getUint32(0, true),
  )
  const hashed = [...bytes.subarray(whole), 0xff].reduce(word, words.reduce(word, 0))
  return hashed >>> 0
}

const ASCII_LIMIT = 0x7f
const TOFU = "[?]"

/** `deunicode_with_tofu_cow(text, "[?]")` (see the module note for characters outside the bundled blocks). */
export function deunicode(text: string) {
  if (Array.from(text).every((char) => char.codePointAt(0)! < ASCII_LIMIT)) return text
  return Array.from(text)
    .map((char) => {
      const code = char.codePointAt(0)!
      if (code < ASCII_LIMIT) return char
      const block = BLOCKS.find(([start, entries]) => code >= start && code < start + entries.length)
      if (block !== undefined) return block[1][code - block[0]] ?? TOFU
      const decomposed = char.normalize("NFKD").replace(/[^\x20-\x7e]/g, "")
      return decomposed === "" ? TOFU : decomposed
    })
    .join("")
}

type WordCategory =
  | "CR"
  | "LF"
  | "Newline"
  | "WSegSpace"
  | "ALetter"
  | "Numeric"
  | "MidLetter"
  | "MidNumLet"
  | "SingleQuote"
  | "MidNum"
  | "ExtendNumLet"
  | "Other"

/** UAX #29 Word_Break values of the ASCII characters (unicode-segmentation 1.12 tables). */
function category(char: string): WordCategory {
  if (char === "\r") return "CR"
  if (char === "\n") return "LF"
  if (char === "\u000b" || char === "\u000c") return "Newline"
  if (char === " ") return "WSegSpace"
  if (/[A-Za-z]/.test(char)) return "ALetter"
  if (/[0-9]/.test(char)) return "Numeric"
  if (char === ":") return "MidLetter"
  if (char === ".") return "MidNumLet"
  if (char === "'") return "SingleQuote"
  if (char === "," || char === ";") return "MidNum"
  if (char === "_") return "ExtendNumLet"
  return "Other"
}

/** `unicode_words` over ASCII text: the UAX #29 word segments that contain an ASCII letter or digit. */
export function words(text: string): ReadonlyArray<string> {
  const categories = Array.from(text, category)
  const breaks = categories.flatMap((_, index) => (index > 0 && isBreak(categories, index) ? [index] : []))
  return [0, ...breaks]
    .map((start, position) => text.slice(start, breaks[position] ?? text.length))
    .filter((segment) => /[A-Za-z0-9]/.test(segment))
}

const LINE = new Set<WordCategory>(["CR", "LF", "Newline"])
const MID_LETTER = new Set<WordCategory>(["MidLetter", "MidNumLet", "SingleQuote"])
const MID_NUMBER = new Set<WordCategory>(["MidNum", "MidNumLet", "SingleQuote"])

/** Whether UAX #29 breaks between `categories[index - 1]` and `categories[index]` (rules WB3 to WB13b). */
function isBreak(categories: ReadonlyArray<WordCategory>, index: number) {
  const before = categories[index - 1]!
  const after = categories[index]!
  const earlier = categories[index - 2]
  const later = categories[index + 1]
  if (before === "CR" && after === "LF") return false
  if (LINE.has(before) || LINE.has(after)) return true
  if (before === "WSegSpace" && after === "WSegSpace") return false
  if (before === "ALetter" && after === "ALetter") return false
  if (before === "ALetter" && MID_LETTER.has(after) && later === "ALetter") return false
  if (earlier === "ALetter" && MID_LETTER.has(before) && after === "ALetter") return false
  if ((before === "Numeric" || before === "ALetter") && after === "Numeric") return false
  if (before === "Numeric" && after === "ALetter") return false
  if (earlier === "Numeric" && MID_NUMBER.has(before) && after === "Numeric") return false
  if (before === "Numeric" && MID_NUMBER.has(after) && later === "Numeric") return false
  if (after === "ExtendNumLet" && (before === "ALetter" || before === "Numeric" || before === "ExtendNumLet"))
    return false
  if (before === "ExtendNumLet" && (after === "ALetter" || after === "Numeric")) return false
  return true
}

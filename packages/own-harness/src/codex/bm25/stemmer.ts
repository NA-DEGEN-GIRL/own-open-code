// The Snowball English (Porter2) stemmer as rust-stemmers 1.2.0 builds it from `algorithms/english.sbl` (the
// 2006 revision: `gener`/`commun`/`arsen` regions, Step 1a's "vowel not immediately before the s" rule). The bm25
// crate's default tokenizer stems every token with it. Ported from rust-stemmers (MIT) and the Snowball project
// (BSD-3-Clause); verified against rust-stemmers' `test_data/voc_en.txt` / `res_en.txt`.
//
// Codex only stems text that deunicode has already turned into ASCII, so the word is handled as ASCII here.
export * as EnglishStemmer from "./stemmer.js"

const VOWELS = new Set("aeiouy")
const VOWELS_WXY = new Set("aeiouywxY")
const VALID_LI = new Set("cdeghkmnrt")

const EXCEPTION1: Readonly<Record<string, string>> = {
  skis: "ski",
  skies: "sky",
  dying: "die",
  lying: "lie",
  tying: "tie",
  idly: "idl",
  gently: "gentl",
  ugly: "ugli",
  early: "earli",
  only: "onli",
  singly: "singl",
  sky: "sky",
  news: "news",
  howe: "howe",
  atlas: "atlas",
  cosmos: "cosmos",
  bias: "bias",
  andes: "andes",
}

const EXCEPTION2 = new Set(["inning", "outing", "canning", "herring", "earring", "proceed", "exceed", "succeed"])

const REGION_PREFIXES = ["gener", "commun", "arsen"]

/** `(replacement or a condition, suffix)` tables; Snowball's `among` picks the longest matching suffix. */
const STEP2: ReadonlyArray<readonly [string, string]> = [
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["abli", "able"],
  ["entli", "ent"],
  ["izer", "ize"],
  ["ization", "ize"],
  ["ational", "ate"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["aliti", "al"],
  ["alli", "al"],
  ["fulness", "ful"],
  ["ousli", "ous"],
  ["ousness", "ous"],
  ["iveness", "ive"],
  ["iviti", "ive"],
  ["biliti", "ble"],
  ["bli", "ble"],
  ["ogi", "og"],
  ["fulli", "ful"],
  ["lessli", "less"],
  ["li", ""],
]

const STEP3: ReadonlyArray<readonly [string, string]> = [
  ["tional", "tion"],
  ["ational", "ate"],
  ["alize", "al"],
  ["icate", "ic"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
  ["ative", ""],
]

const STEP4 = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
  "ion",
]

const DOUBLES = new Set(["bb", "dd", "ff", "gg", "mm", "nn", "pp", "rr", "tt"])

export function stem(input: string) {
  const exception = EXCEPTION1[input]
  if (exception !== undefined) return exception
  if (input.length < 3) return input
  const prepared = prelude(input)
  const regions = markRegions(prepared.word)
  const word = steps(prepared.word, regions.p1, regions.p2)
  return prepared.yFound ? word.replaceAll("Y", "y") : word
}

/** Drops a leading apostrophe and marks `y` as consonant `Y` at the start and after a vowel. */
function prelude(input: string) {
  const unquoted = input.startsWith("'") ? input.slice(1) : input
  const chars = Array.from(unquoted)
  const marked = chars.reduce<Array<string>>((out, char, index) => {
    const consonantY = char === "y" && (index === 0 || VOWELS.has(out[index - 1]!))
    out.push(consonantY ? "Y" : char)
    return out
  }, [])
  return { word: marked.join(""), yFound: marked.some((char, index) => char !== chars[index]) }
}

function markRegions(word: string) {
  const prefix = REGION_PREFIXES.find((candidate) => word.startsWith(candidate))
  const p1 = prefix === undefined ? afterVowelConsonant(word, 0) : prefix.length
  if (p1 === undefined) return { p1: word.length, p2: word.length }
  return { p1, p2: afterVowelConsonant(word, p1) ?? word.length }
}

/** `gopast v gopast non-v` from `start`: the position after the first non-vowel that follows a vowel. */
function afterVowelConsonant(word: string, start: number) {
  const vowel = indexWhere(word, start, (char) => VOWELS.has(char))
  if (vowel === undefined) return undefined
  const consonant = indexWhere(word, vowel + 1, (char) => !VOWELS.has(char))
  return consonant === undefined ? undefined : consonant + 1
}

function indexWhere(word: string, start: number, predicate: (char: string) => boolean) {
  const found = Array.from(word.slice(start)).findIndex(predicate)
  return found === -1 ? undefined : start + found
}

function steps(input: string, p1: number, p2: number) {
  const afterStep1a = step1a(input)
  if (EXCEPTION2.has(afterStep1a)) return afterStep1a
  return [step1b, step1c, step2, step3, step4, step5].reduce((word, step) => step(word, p1, p2), afterStep1a)
}

function longestSuffix<T>(word: string, entries: ReadonlyArray<T>, suffix: (entry: T) => string) {
  return entries
    .filter((entry) => word.endsWith(suffix(entry)))
    .reduce<
      T | undefined
    >((best, entry) => (best === undefined || suffix(entry).length > suffix(best).length ? entry : best), undefined)
}

function step1a(input: string) {
  const apostrophe = longestSuffix(input, ["'", "'s", "'s'"], (entry) => entry)
  const word = apostrophe === undefined ? input : input.slice(0, -apostrophe.length)
  const suffix = longestSuffix(word, ["sses", "ied", "ies", "s", "us", "ss"], (entry) => entry)
  if (suffix === undefined) return word
  const stemmed = word.slice(0, -suffix.length)
  if (suffix === "sses") return `${stemmed}ss`
  if (suffix === "ied" || suffix === "ies") return stemmed.length >= 2 ? `${stemmed}i` : `${stemmed}ie`
  if (suffix !== "s") return word
  // `next gopast v`: a vowel somewhere before the character that precedes the `s`.
  const hasVowel = Array.from(stemmed.slice(0, -1)).some((char) => VOWELS.has(char))
  return stemmed.length >= 1 && hasVowel ? stemmed : word
}

function step1b(word: string, p1: number) {
  const suffix = longestSuffix(word, ["eed", "eedly", "ed", "edly", "ing", "ingly"], (entry) => entry)
  if (suffix === undefined) return word
  const stemmed = word.slice(0, -suffix.length)
  if (suffix === "eed" || suffix === "eedly") return stemmed.length >= p1 ? `${stemmed}ee` : word
  if (!Array.from(stemmed).some((char) => VOWELS.has(char))) return word
  const ending = stemmed.slice(-2)
  if (ending === "at" || ending === "bl" || ending === "iz") return `${stemmed}e`
  if (DOUBLES.has(ending)) return stemmed.slice(0, -1)
  return stemmed.length === p1 && shortSyllable(stemmed) ? `${stemmed}e` : stemmed
}

/** `shortv` at the end of `word`. */
function shortSyllable(word: string) {
  const length = word.length
  const last = word[length - 1]
  const middle = word[length - 2]
  if (last === undefined || middle === undefined || VOWELS.has(last) || !VOWELS.has(middle)) return false
  if (length === 2) return true
  const first = word[length - 3]!
  return !VOWELS_WXY.has(last) && !VOWELS.has(first)
}

function step1c(word: string) {
  const last = word[word.length - 1]
  if (last !== "y" && last !== "Y") return word
  const before = word[word.length - 2]
  if (before === undefined || VOWELS.has(before) || word.length - 2 === 0) return word
  return `${word.slice(0, -1)}i`
}

function step2(word: string, p1: number) {
  const entry = longestSuffix(word, STEP2, (candidate) => candidate[0])
  if (entry === undefined) return word
  const stemmed = word.slice(0, -entry[0].length)
  if (stemmed.length < p1) return word
  if (entry[0] === "ogi" && !stemmed.endsWith("l")) return word
  if (entry[0] === "li" && !VALID_LI.has(stemmed.slice(-1))) return word
  return `${stemmed}${entry[1]}`
}

function step3(word: string, p1: number, p2: number) {
  const entry = longestSuffix(word, STEP3, (candidate) => candidate[0])
  if (entry === undefined) return word
  const stemmed = word.slice(0, -entry[0].length)
  if (stemmed.length < p1) return word
  if (entry[0] === "ative" && stemmed.length < p2) return word
  return `${stemmed}${entry[1]}`
}

function step4(word: string, _p1: number, p2: number) {
  const suffix = longestSuffix(word, STEP4, (entry) => entry)
  if (suffix === undefined) return word
  const stemmed = word.slice(0, -suffix.length)
  if (stemmed.length < p2) return word
  if (suffix === "ion" && !stemmed.endsWith("s") && !stemmed.endsWith("t")) return word
  return stemmed
}

function step5(word: string, p1: number, p2: number) {
  const stemmed = word.slice(0, -1)
  if (word.endsWith("e")) {
    const deletable = stemmed.length >= p2 || (stemmed.length >= p1 && !shortSyllable(stemmed))
    return deletable ? stemmed : word
  }
  if (word.endsWith("l")) return stemmed.length >= p2 && stemmed.endsWith("l") ? stemmed : word
  return word
}

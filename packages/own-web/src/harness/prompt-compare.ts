// 설정 > 에이전트 방식's `비교` (10 §3.11, prompt-page.tsx): two variants' previews of one 에이전트 방식, model and approval
// mode side by side, part by part and tool by tool. What differs is found line by line and marked word by word inside
// each changed run (a stretch of a run rewritten as a whole is marked whole, a word that differs in unseen characters
// alone only at them; a large run line pair by line pair). Whitespace and the characters that render as nothing,
// which a mark would hide, are drawn in glyphs (`inks`: ⏎ · → ␍ ⍽ □ ⁞ ¬ ␤ ␛ ⇄ ◌ ⌑ ▯), and a run that differs in them
// only says so. Each changed run carries own's changes (variant.ts, `prompt.preview` `changes`) whose texts it
// touches; the changes no run shows (tool arguments, the per-conversation Code Mode catalog) are listed apart. Pure
// but for the copy handler (`copyReal`), so unit tests drive it; prompt-compare-view.tsx draws it.
import type { OwnHarness } from "@own/protocol/rpc-harness"

type Preview = OwnHarness.PromptPreview
type Change = OwnHarness.PromptChange

/**
 * A stretch of one side of a changed run, in its real text: what copying it gives (`inks` says how a mark is drawn).
 * The side's last line break is left out, unless a mark draws it as ⏎.
 */
export interface Piece {
  readonly text: string
  readonly mark: boolean
  /** A mark of whitespace alone: every character of it is drawn as a glyph. */
  readonly space?: true
}

/**
 * What a glyph stands for: ⏎ a line break, · a space, → a tab, ␍ a `\r`, ⍽ a no-break space, □ U+3000, ⁞ a character
 * of no width (zero-width space and joiners, BOM, invisible operators, any other default-ignorable one), ¬ a soft
 * hyphen, ␤ U+0085 (NEL), ␀…␟ ␡ ␦ the other control characters, ⇄ a direction control (LRM, RLM, embeddings,
 * overrides, isolates), ◌ a variation selector, ⌑ a tag character, ▯ a Hangul filler.
 */
export type Glyph =
  | "break"
  | "space"
  | "tab"
  | "return"
  | "nbsp"
  | "wide"
  | "zero"
  | "soft"
  | "nel"
  | "control"
  | "bidi"
  | "variant"
  | "tag"
  | "filler"

/**
 * A stretch of a mark as drawn: plain text, or a run of one glyph (`text`) with the real characters it stands for
 * (`real`, copied but not drawn). A line break's glyph has no `real`: the real line break follows it as text.
 */
export type Ink = string | { readonly glyph: Glyph; readonly text: string; readonly real: string }

export type Segment =
  | {
      readonly kind: "same"
      readonly text: string
      /** The stretch's first line on the left side, from 1; with the row's key it names the stretch and its fold. */
      readonly line: number
    }
  | {
      readonly kind: "change"
      readonly line: number
      /** Empty where the run has no lines on that side (lines added or removed); an empty line is one empty piece. */
      readonly left: ReadonlyArray<Piece>
      readonly right: ReadonlyArray<Piece>
      /** own's changes this run shows, each under the first run that shows it. */
      readonly notes: ReadonlyArray<Change>
      /**
       * The run differs in whitespace only: `lines` in line ends and blank lines alone, `invisible` in zero-width
       * characters alone, `spaces` otherwise.
       */
      readonly whitespace?: "lines" | "spaces" | "invisible"
    }

export interface Row {
  /** A part's kind with its place among parts of that kind (`tools#1`), or `tool:<name>`. */
  readonly key: string
  /** A part's kind; absent for a tool. */
  readonly kind?: OwnHarness.PromptPartKind
  readonly role?: OwnHarness.PromptPart["role"]
  /** A tool's name. */
  readonly tool?: string
  /** The text on each side; absent where that side has no such part or tool. */
  readonly left?: string
  readonly right?: string
  readonly same: boolean
  readonly segments: ReadonlyArray<Segment>
}

export interface Comparison {
  readonly parts: ReadonlyArray<Row>
  readonly tools: ReadonlyArray<Row>
  /** own's changes (of those given) that no changed run shows. */
  readonly elsewhere: ReadonlyArray<Change>
}

/**
 * The copy handler of 비교's sections: copying a selection gives its real text. Chromium's own copy turns each no-break
 * space into a space, so a copied mark would lose the very character it shows (⍽); the selection's text keeps it, and
 * the characters drawn as glyphs are in it through their hidden real ones (`inks`' `real`), never the glyphs, which
 * cannot be selected.
 */
export function copyReal(event: ClipboardEvent) {
  const text = getSelection()?.toString() ?? ""
  if (text === "" || event.clipboardData === null) return
  event.clipboardData.setData("text/plain", text)
  event.preventDefault()
}

/** A change's manual anchor: `codex.base.where` → `pc-codex-base-where` (own-harness script/prompt-manual.ts). */
export function changeAnchor(id: string) {
  return `pc-${id.replaceAll(".", "-")}`
}

/** The first sentence of a change's reason, for the small line under a run (the manual has the rest). */
export function firstSentence(text: string) {
  const end = /[.!?](?=\s|$)/.exec(text)
  return end === null ? text : text.slice(0, end.index + 1)
}

/**
 * `left` and `right` part by part (paired by kind, in order) and tool by tool (by name), with `changes` (own's changes
 * that apply between them; none for 개선판 and 내 지시문) under the runs that show them.
 */
export function comparePreviews(left: Preview, right: Preview, changes: ReadonlyArray<Change>): Comparison {
  const parts = pair(keyed(left.parts), keyed(right.parts)).map(([a, b]) => {
    const part = (b ?? a)!
    // Each preview reads the clock when it is built: one reading on both sides, so it is not taken for a change.
    const text = part.kind === "time" && a && b ? sameClock(a.text, b.text) : b?.text
    return row(part.key, a?.text, text, { kind: part.kind, role: part.role })
  })
  const tools = pair(
    left.tools.map((tool) => ({ ...tool, key: `tool:${tool.name}` })),
    right.tools.map((tool) => ({ ...tool, key: `tool:${tool.name}` })),
  ).map(([a, b]) => row((b ?? a)!.key, a?.description, b?.description, { tool: (b ?? a)!.name }))
  const placed = place([...parts, ...tools], changes)
  return {
    parts: placed.rows.slice(0, parts.length),
    tools: placed.rows.slice(parts.length),
    elsewhere: changes.filter((change) => !placed.ids.has(change.id)),
  }
}

/**
 * Rows as the page lists them: two or more same rows in a row fold into one `같은 부분` entry (dsh sends a tool
 * guidance part per tool, Pi's parts are all the same), a changed row or a lone same row stands alone.
 */
export function groupSame(rows: ReadonlyArray<Row>) {
  return rows.reduce<Array<{ readonly same: boolean; readonly rows: Row[] }>>((out, item) => {
    const last = out.at(-1)
    if (item.same && last?.same) last.rows.push(item)
    if (!item.same || !last?.same) out.push({ same: item.same, rows: [item] })
    return out
  }, [])
}

/**
 * The long unchanged stretch of a changed part, folded: `keep` lines next to each change stay, the rest hide behind a
 * button. `at` says where the stretch is: before the first change, between two, or after the last. `first` is the
 * first hidden line's place in the stretch, from 0.
 */
export function fold(text: string, at: "start" | "middle" | "end", keep = 3) {
  const lines = text.split("\n")
  const head = at === "start" ? 0 : keep
  const tail = at === "end" ? 0 : keep
  // Folding fewer than three lines saves nothing.
  if (lines.length - head - tail < 3) return { head: text, hidden: "", count: 0, tail: "", first: 0 }
  return {
    head: lines.slice(0, head).join("\n"),
    hidden: lines.slice(head, lines.length - tail).join("\n"),
    count: lines.length - head - tail,
    tail: lines.slice(lines.length - tail).join("\n"),
    first: head,
  }
}

/** `left` against `right`: unchanged stretches and changed runs, the runs marked word by word. */
export function diffText(left: string, right: string) {
  return runs(left, right).map((run) => segment(left, right, run, []))
}

/**
 * A mark as drawn. A mark of whitespace alone shows every character as a glyph. A mark with visible characters keeps
 * its spaces (U+0020) and tabs as they are (a struck-through `x ` would only get noisier) but shows every other
 * character that would pass for a space or for nothing (`\r`, other spaces, the default-ignorable and control
 * characters), and a line break that ends a line it has nothing visible on (a blank line added or removed, a line
 * break where a space was): a line break after marked text needs no glyph, as that line already reads as changed. The
 * line breaks a mark ends with come apart (`after`), for the page to draw outside the mark's box, so that the box does
 * not reach into the next line.
 */
export function inks(piece: Piece) {
  const out: Ink[] = []
  const line = { visible: false }
  const add = (ink: Ink) => {
    const last = out.at(-1)
    if (typeof ink === "string" && typeof last === "string") {
      out[out.length - 1] = last + ink
      return
    }
    if (typeof ink === "object" && typeof last === "object" && last.glyph === ink.glyph && ink.glyph !== "break") {
      out[out.length - 1] = { glyph: ink.glyph, text: last.text + ink.text, real: last.real + ink.real }
      return
    }
    out.push(ink)
  }
  for (const char of piece.text) {
    const glyph = glyphOf(char)
    const shown =
      glyph !== undefined &&
      (piece.space === true || (glyph === "break" ? !line.visible : char !== " " && char !== "\t"))
    line.visible = char !== "\n" && (line.visible || visible(char) > 0)
    if (!shown) add(char)
    if (shown && glyph === "break") {
      add({ glyph, text: GLYPHS.break, real: "" })
      add("\n")
    }
    if (shown && glyph !== "break") add({ glyph, text: glyphText(glyph, char), real: char })
  }
  const last = out.at(-1)
  const after = typeof last === "string" ? /\n*$/.exec(last)![0] : ""
  const inside =
    typeof last === "string" && after !== "" ? [...out.slice(0, -1), last.slice(0, last.length - after.length)] : out
  return { inside: inside.filter((ink) => ink !== ""), after }
}

/**
 * The code points a run of glyphs stands for (its `real`), each once and in order (`U+00AD, U+200B`), for its tooltip
 * and screen-reader name; none when it holds only spaces, tabs and CRs, which its name already says. A long list ends
 * in `…`.
 */
export function codePoints(real: string) {
  const points = [...new Set(Array.from(real, (char) => char.codePointAt(0)!))]
  if (points.every((point) => point === 0x20 || point === 0x09 || point === 0x0d)) return ""
  const names = points.map((point) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`)
  return names.length > POINTS ? `${names.slice(0, POINTS).join(", ")}, …` : names.join(", ")
}

// ---------------------------------------------------------------------------------------------------------------------

interface Run {
  readonly same: boolean
  /** The run's first line on the left side, from 1. */
  readonly line: number
  readonly l0: number
  readonly l1: number
  readonly r0: number
  readonly r1: number
}

interface Pending {
  readonly key: string
  readonly kind?: OwnHarness.PromptPartKind
  readonly role?: OwnHarness.PromptPart["role"]
  readonly tool?: string
  readonly left?: string
  readonly right?: string
  readonly same: boolean
  readonly runs: ReadonlyArray<Run>
}

/** Parts keyed by kind and place among their kind, so the n-th `tools` part meets the n-th. */
function keyed(parts: ReadonlyArray<OwnHarness.PromptPart>) {
  return parts.map((part, index) => ({
    ...part,
    key: `${part.kind}#${parts.slice(0, index).filter((other) => other.kind === part.kind).length}`,
  }))
}

/**
 * Two keyed lists merged: a pair wherever a key is on both sides, even in another order (tools pair by name), one side
 * alone where a key is on one side only. The right side's order leads; a key on the left only stays where it was among
 * the left ones.
 */
function pair<T extends { readonly key: string }>(left: ReadonlyArray<T>, right: ReadonlyArray<T>) {
  const lefts = new Map(left.map((item) => [item.key, item]))
  const rights = new Map(right.map((item, index) => [item.key, index]))
  const out: Array<readonly [T | undefined, T | undefined]> = []
  const at = { j: 0 }
  // The right side up to `index`, each item with its partner; a left item met this way is passed over later.
  const through = (index: number) => {
    for (; at.j <= index; at.j++) out.push([lefts.get(right[at.j]!.key), right[at.j]!])
  }
  for (const item of left) {
    const index = rights.get(item.key)
    if (index === undefined) out.push([item, undefined])
    if (index !== undefined) through(index)
  }
  through(right.length - 1)
  return out
}

function row(
  key: string,
  left: string | undefined,
  right: string | undefined,
  about: Pick<Pending, "kind" | "role" | "tool">,
): Pending {
  const same = left === right
  return {
    key,
    ...about,
    ...(left === undefined ? {} : { left }),
    ...(right === undefined ? {} : { right }),
    same,
    runs: same ? [] : runs(left ?? "", right ?? ""),
  }
}

/** Notes for the runs: by where a change's texts sit, then by the part a change names; the rest stays unplaced. */
function place(rows: ReadonlyArray<Pending>, changes: ReadonlyArray<Change>) {
  const notes = rows.map((item) => item.runs.map((): Change[] => []))
  const slots = rows.flatMap((item, at) =>
    item.runs.flatMap((run, index) => (run.same ? [] : [{ at, index, item, run }])),
  )
  const ids = new Set<string>()
  const put = (change: Change, slot: (typeof slots)[number] | undefined) => {
    if (slot === undefined) return
    notes[slot.at]![slot.index]!.push(change)
    ids.add(change.id)
  }
  for (const change of changes)
    put(
      change,
      slots.find((slot) => touches(change, slot.item, slot.run)),
    )
  for (const change of changes.filter((item) => !ids.has(item.id)))
    put(
      change,
      slots.find((slot) => holds(change.part, slot.item) && notes[slot.at]![slot.index]!.length === 0),
    )
  return {
    ids,
    rows: rows.map(
      (item, at): Row => ({
        key: item.key,
        ...(item.kind === undefined ? {} : { kind: item.kind }),
        ...(item.role === undefined ? {} : { role: item.role }),
        ...(item.tool === undefined ? {} : { tool: item.tool }),
        ...(item.left === undefined ? {} : { left: item.left }),
        ...(item.right === undefined ? {} : { right: item.right }),
        same: item.same,
        segments: item.runs.map((run, index) => segment(item.left ?? "", item.right ?? "", run, notes[at]![index]!)),
      }),
    ),
  }
}

/** Whether `run` changes the text `change` says it replaced or wrote. */
function touches(change: Change, item: Pending, run: Run) {
  const span = (text: string | undefined, part: string) => {
    const at = part === "" || text === undefined ? -1 : text.indexOf(part)
    return at < 0 ? undefined : { from: at, to: at + part.length }
  }
  const before = span(item.left, change.before)
  const after = span(item.right, change.after)
  return (
    (before !== undefined && meets(run.l0, run.l1, before.from, before.to)) ||
    (after !== undefined && meets(run.r0, run.r1, after.from, after.to))
  )
}

function meets(from: number, to: number, start: number, end: number) {
  if (from === to) return start <= from && from <= end
  return from < end && start < to
}

/** Whether a row is where a change of `part` shows when its texts are not found as they are. */
function holds(part: Change["part"], item: Pending) {
  if (part === "tools") return item.tool !== undefined || item.kind === "tools"
  if (part === "base") return item.kind === "base" || item.kind === "preamble" || item.kind === "persona"
  if (part === "environment") return item.kind === "environment" || item.kind === "time" || item.kind === "cwd"
  return item.kind === part
}

/** dsh's time reading (`2026-10-24T09:30:05+09:00`) of `left` in `right`. */
function sameClock(left: string, right: string) {
  const stamp = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/
  const reading = stamp.exec(left)
  return reading === null ? right : right.replace(stamp, reading[0])
}

function segment(left: string, right: string, run: Run, notes: ReadonlyArray<Change>): Segment {
  if (run.same) return { kind: "same", text: chomp(left.slice(run.l0, run.l1)), line: run.line }
  const before = left.slice(run.l0, run.l1)
  const after = right.slice(run.r0, run.r1)
  const words = wordDiff(before, after)
  const whitespace = spacing(before, after)
  return {
    kind: "change",
    line: run.line,
    left: drawn(words.left),
    right: drawn(words.right),
    notes,
    ...(whitespace === undefined ? {} : { whitespace }),
  }
}

/** Without the one line break that ends a stretch: the next stretch starts on its own line anyway. */
function chomp(text: string) {
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

/**
 * Whether a run differs in what a reader does not see only: `invisible` when only characters that render as nothing
 * differ (INVISIBLE: a soft hyphen, a zero-width, direction or control character, a variation selector, a tag), `lines`
 * when only line ends (spaces, `\r`) and blank lines do, `spaces` otherwise.
 */
function spacing(left: string, right: string) {
  if (seen(left) !== seen(right)) return undefined
  const bare = (text: string) => text.replace(INVISIBLE, "")
  if (bare(left) === bare(right)) return "invisible" as const
  const shape = (text: string) =>
    bare(text)
      .split(/\r\n|\r|\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line !== "")
      .join("\n")
  return shape(left) === shape(right) ? ("lines" as const) : ("spaces" as const)
}

/**
 * One side's pieces as drawn: a mark of whitespace alone flagged, and the side's last line break dropped (the next
 * stretch starts on its own line anyway) unless a mark draws it as ⏎ (`inks`). A side with text keeps a piece even
 * when that was a lone line break (an empty line); only a side without lines is empty.
 */
function drawn(pieces: ReadonlyArray<Piece>): ReadonlyArray<Piece> {
  const shown = pieces.map((piece) =>
    piece.mark && visible(piece.text) === 0 ? { ...piece, space: true as const } : piece,
  )
  const last = shown.at(-1)
  if (last === undefined) return []
  const kept = !last.text.endsWith("\n") || (last.mark && visible(last.text.slice(0, -1).split("\n").at(-1)!) === 0)
  const out = [...shown.slice(0, -1), kept ? last : { ...last, text: last.text.slice(0, -1) }].filter(
    (piece) => piece.text !== "",
  )
  return out.length === 0 ? [{ text: "", mark: false }] : out
}

const GLYPHS: Record<Glyph, string> = {
  break: "⏎",
  space: "·",
  tab: "→",
  return: "␍",
  nbsp: "⍽",
  wide: "□",
  zero: "⁞",
  soft: "¬",
  nel: "␤",
  control: "␦",
  bidi: "⇄",
  variant: "◌",
  tag: "⌑",
  filler: "▯",
}

/** How many code points a glyph run's name lists. */
const POINTS = 6

/**
 * The characters that render as nothing or nearly nothing but are not whitespace: every default-ignorable code point
 * (soft hyphen, zero-width characters, direction controls, variation selectors, tags, Hangul fillers …), the control
 * characters but tab, line feed, vertical tab, form feed and CR (U+0085 NEL among them), and the interlinear
 * annotation characters.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\x00-\x08\x0E-\x1F\x7F-\x9F\u{FFF9}-\u{FFFB}]/gu
/** Whitespace and INVISIBLE: what a reader does not see. */
const UNSEEN = /[\s\p{Default_Ignorable_Code_Point}\x00-\x08\x0E-\x1F\x7F-\x9F\u{FFF9}-\u{FFFB}]/gu

/** Each glyph's characters; the first kind that matches a character is its glyph. */
const KINDS: ReadonlyArray<readonly [Glyph, RegExp]> = [
  ["break", /\n/],
  ["return", /\r/],
  ["tab", /\t/],
  ["wide", /\u{3000}/u],
  ["nbsp", /[\u{A0}\u{2007}\u{202F}]/u],
  ["soft", /\u{AD}/u],
  ["nel", /\u{85}/u],
  ["bidi", /[\u{61C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u],
  ["variant", /[\u{180B}-\u{180D}\u{180F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u],
  ["tag", /[\u{E0000}-\u{E007F}]/u],
  ["filler", /[\u{115F}\u{1160}\u{3164}\u{FFA0}]/u],
  ["control", /[\x00-\x08\x0E-\x1F\x7F-\x9F]/],
  ["zero", new RegExp(INVISIBLE.source, "u")],
  ["space", /\s/],
]

function glyphOf(char: string) {
  return KINDS.find(([, chars]) => chars.test(char))?.[0]
}

/** A character's glyph: a C0 control's own picture (␛ for ESC), ␡ for DEL, else its kind's. */
function glyphText(glyph: Glyph, char: string) {
  const point = char.codePointAt(0)!
  if (glyph === "control" && point < 0x20) return String.fromCodePoint(0x2400 + point)
  if (glyph === "control" && point === 0x7f) return "␡"
  return GLYPHS[glyph]
}

// ---------------------------------------------------------------------------------------------------------------------
// Line diff: common start and end lines set aside, then the longest common subsequence of the lines between. A middle
// too large for the table (the product of the line counts above LINE_CELLS) is one changed run.

const LINE_CELLS = 1_000_000

function runs(left: string, right: string): ReadonlyArray<Run> {
  const a = lines(left)
  const b = lines(right)
  const start = commonStart(a, b)
  const end = commonEnd(a, b, start)
  const ops = [
    ...a.slice(0, start).map(() => "same" as const),
    ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map(() => "same" as const),
  ]
  // Walk the operations, cutting runs where `same` meets a change.
  const out: Run[] = []
  const at = { i: 0, j: 0, l: 0, r: 0 }
  for (const op of ops) {
    const same = op === "same"
    const lengthA = op === "insert" ? 0 : a[at.i]!.length
    const lengthB = op === "delete" ? 0 : b[at.j]!.length
    const last = out.at(-1)
    if (last && last.same === same) out[out.length - 1] = { ...last, l1: last.l1 + lengthA, r1: last.r1 + lengthB }
    if (!last || last.same !== same)
      out.push({ same, line: at.i + 1, l0: at.l, l1: at.l + lengthA, r0: at.r, r1: at.r + lengthB })
    at.l += lengthA
    at.r += lengthB
    if (op !== "insert") at.i++
    if (op !== "delete") at.j++
  }
  return bridge(out, left)
}

/**
 * Changed runs with only blank lines between them joined into one: a rewritten text shares little but its blank
 * lines, and cutting it at each of them would show one rewrite as many.
 */
function bridge(list: ReadonlyArray<Run>, left: string) {
  return list.reduce<Run[]>((out, run) => {
    const gap = out.at(-1)
    const before = out.at(-2)
    if (!run.same && gap?.same && before && !before.same && left.slice(gap.l0, gap.l1).trim() === "") {
      out.splice(-2, 2, { same: false, line: before.line, l0: before.l0, l1: run.l1, r0: before.r0, r1: run.r1 })
      return out
    }
    out.push(run)
    return out
  }, [])
}

function lines(text: string) {
  return text === "" ? [] : text.split(/(?<=\n)/)
}

function commonStart<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) {
  const limit = Math.min(a.length, b.length)
  const at = Array.from({ length: limit }, (_, index) => index).find((index) => a[index] !== b[index])
  return at ?? limit
}

function commonEnd<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>, start: number) {
  const limit = Math.min(a.length, b.length) - start
  const at = Array.from({ length: limit }, (_, index) => index).find(
    (index) => a[a.length - 1 - index] !== b[b.length - 1 - index],
  )
  return at ?? limit
}

type Op = "same" | "delete" | "insert"

/** Operations turning `a` into `b`, deletions before insertions within a change. */
function middle<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>, cells = LINE_CELLS): ReadonlyArray<Op> {
  if (a.length * b.length > cells || a.length === 0 || b.length === 0)
    return [...a.map(() => "delete" as const), ...b.map(() => "insert" as const)]
  const table = lcs(a, b)
  const width = b.length + 1
  const out: Op[] = []
  const at = { i: 0, j: 0 }
  while (at.i < a.length && at.j < b.length) {
    if (a[at.i] === b[at.j]) {
      out.push("same")
      at.i++
      at.j++
      continue
    }
    if (table[(at.i + 1) * width + at.j]! >= table[at.i * width + at.j + 1]!) {
      out.push("delete")
      at.i++
      continue
    }
    out.push("insert")
    at.j++
  }
  return [...out, ...a.slice(at.i).map(() => "delete" as const), ...b.slice(at.j).map(() => "insert" as const)]
}

/**
 * The LCS tables' memory, kept from one table to the next (`table` for `lcs`, `likes` for `pairs`): a large run fills
 * hundreds of tables, and a fresh array for each cost more than filling it.
 */
const scratch = { table: new Uint32Array(0), likes: new Uint32Array(0) }

/**
 * Suffix LCS lengths: `table[i * (b.length + 1) + j]` is the LCS of `a[i..]` and `b[j..]`. The table is `scratch`'s,
 * valid until the next call.
 */
function lcs<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) {
  // Small integers stand in for the items: the inner loop runs up to a million times per table.
  const ids = new Map<T, number>()
  const id = (item: T) => {
    const known = ids.get(item)
    if (known !== undefined) return known
    ids.set(item, ids.size)
    return ids.size - 1
  }
  // Mapped as an array first: a typed array's own `from` with a map walks an iterator, several times slower in Bun.
  const x = new Int32Array(a.map(id))
  const y = new Int32Array(b.map(id))
  const width = b.length + 1
  if (scratch.table.length < (a.length + 1) * width) scratch.table = new Uint32Array((a.length + 1) * width)
  const table = scratch.table
  // Only the last row and column are read before they are written.
  table.fill(0, a.length * width, (a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    const item = x[i]
    table[i * width + b.length] = 0
    // The cell to the right is the one just written: kept at hand rather than read back.
    let across = 0
    for (let j = b.length - 1, cell = i * width + j; j >= 0; j--, cell--) {
      const down = table[cell + width]!
      across = item === y[j] ? table[cell + width + 1]! + 1 : down >= across ? down : across
      table[cell] = across
    }
  }
  return table
}

// ---------------------------------------------------------------------------------------------------------------------
// Word marks inside a changed run: words, runs of spaces, single line breaks and single signs, matched by the same LCS.
// A run too large for one table is diffed line pair by line pair (`align`), and a span too large for one table is
// pinned at the words found once on each side (`diffSpan`). The run is cut at its common line breaks and long common
// stretches (ANCHOR visible characters), and each stretch between them is judged on its own: when less than SIMILAR of
// its visible characters match (a rewrite rather than an edit), scattered common words would only distract, so it is
// marked whole. A small edit beside a large deletion thus keeps its own marks. A word that differs in unseen characters
// alone is marked at those characters (`rejoin`).

const WORD_CELLS = 1_000_000
/** A window's size a side, in tokens, for a span with nothing to pin it (`windows`). */
const WINDOW = 1_000
const SIMILAR = 0.4
const ANCHOR = 32
/** How alike two lines of a large run must be to pair (`common`): twice their common visible characters over all. */
const LIKE = 0.5
/** The line pairing's table, in cells, before it goes in windows of PAIR_WINDOW lines a side (`liken`). */
const PAIR_CELLS = 250_000
const PAIR_WINDOW = 500

interface Step {
  readonly op: Op
  readonly a?: string
  readonly b?: string
}

function wordDiff(left: string, right: string) {
  const a = tokens(left)
  const b = tokens(right)
  if (a.length === 0 || b.length === 0) return { left: marked(left), right: marked(right) }
  const sides = { left: [] as Piece[], right: [] as Piece[] }
  for (const stretch of stretches(align(a, b))) {
    const kept = stretch.steps.reduce((sum, step) => sum + (step.op === "same" ? visible(step.a!) : 0), 0)
    const total = stretch.steps.reduce((sum, step) => sum + visible(step.a ?? "") + visible(step.b ?? ""), 0)
    const whole = !stretch.anchor && (2 * kept) / Math.max(1, total) < SIMILAR
    for (const step of stretch.steps) {
      if (step.a !== undefined) sides.left.push({ text: step.a, mark: whole || step.op === "delete" })
      if (step.b !== undefined) sides.right.push({ text: step.b, mark: whole || step.op === "insert" })
    }
  }
  return { left: merge(sides.left), right: merge(sides.right) }
}

/** Ranges: `[i0, i1)` of one side, `[j0, j1)` of the other (tokens, or lines for `liken`). */
interface Span {
  readonly i0: number
  readonly i1: number
  readonly j0: number
  readonly j1: number
}

/** An item of one side (`[0]`) met by one of the other (`[1]`). */
type Pin = readonly [number, number]

/**
 * The word steps turning `a` into `b`, in one table when it fits (WORD_CELLS). A larger run is diffed line pair by
 * line pair (`pairLines`), each pair on its own and the lines between two pairs together, so that a word added to
 * every line, or a block of lines added or removed, cannot pull the lines after it out of line (windows drifting
 * across them once marked thousands of characters deleted and added again).
 */
function align(a: ReadonlyArray<string>, b: ReadonlyArray<string>) {
  const keyA = keys(a)
  const keyB = keys(b)
  const out: Step[] = []
  const diff = (i0: number, i1: number, j0: number, j1: number) => diffSpan(a, b, keyA, keyB, { i0, i1, j0, j1 }, out)
  if (a.length * b.length <= WORD_CELLS) {
    diff(0, a.length, 0, b.length)
    return rejoin(out)
  }
  const linesA = starts(a)
  const linesB = starts(b)
  const at = { i: 0, j: 0 }
  for (const [i, j] of pairLines(a, b, linesA, linesB)) {
    diff(linesA[at.i]!, linesA[i]!, linesB[at.j]!, linesB[j]!)
    diff(linesA[i]!, linesA[i + 1]!, linesB[j]!, linesB[j + 1]!)
    at.i = i + 1
    at.j = j + 1
  }
  diff(linesA[at.i]!, a.length, linesB[at.j]!, b.length)
  return rejoin(out)
}

/** Where each line of tokens starts, then the end: line `k` is `list.slice(at[k], at[k + 1])`. */
function starts(list: ReadonlyArray<string>) {
  const out = [0]
  for (let at = 0; at + 1 < list.length; at++) if (list[at] === "\n") out.push(at + 1)
  out.push(list.length)
  return out
}

/** A line of a large run as `pairLines` matches it: its visible words (`ids`, sorted), their text and size. */
interface Bag {
  readonly text: string
  readonly ids: Int32Array
  /** In visible characters. */
  readonly size: number
}

/**
 * The lines of a large run paired, in order. Lines whose visible text is found once on each side pair first, the
 * longest chain of them (`chain`): a CRLF copy's or a re-indented line meets its own. Between two of those, lines
 * alike enough (LIKE) pair so that the most visible text is in common (`liken`): an edited line meets its edited
 * self, and a block of lines added or removed pairs with nothing. Blank lines never pair: they would pair with the
 * wrong one.
 */
function pairLines(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  linesA: ReadonlyArray<number>,
  linesB: ReadonlyArray<number>,
) {
  const vocabulary = { ids: new Map<string, number>(), weight: [] as number[] }
  const bagsA = bags(a, linesA, vocabulary)
  const bagsB = bags(b, linesB, vocabulary)
  const pins = chain(
    once(
      bagsA.map((bag) => bag.text),
      bagsB.map((bag) => bag.text),
      { i0: 0, i1: bagsA.length, j0: 0, j1: bagsB.length },
      (text) => text !== "",
    ),
  )
  const out: Pin[] = []
  const at = { i: 0, j: 0 }
  for (const [i, j] of [...pins, [bagsA.length, bagsB.length] as const]) {
    // Lines between two pins of which not even SIMILAR of the smaller side is found in the other are a rewrite, marked
    // whole either way: no pairing for them (a 100,000-character 내 지시문 of other text would fill hundreds of tables).
    const found = overlap(a, b, { i0: linesA[at.i]!, i1: linesA[i]!, j0: linesB[at.j]!, j1: linesB[j]! })
    const rewrite = found.shared < SIMILAR * Math.min(found.a, found.b)
    if (!rewrite)
      for (const pin of liken(bagsA, bagsB, vocabulary.weight, { i0: at.i, i1: i, j0: at.j, j1: j })) out.push(pin)
    if (i < bagsA.length) out.push([i, j])
    at.i = i + 1
    at.j = j + 1
  }
  return out
}

/** Each line's bag; `words` gives each visible word an id (shared by both sides) and its weight, its length. */
function bags(
  list: ReadonlyArray<string>,
  at: ReadonlyArray<number>,
  words: { readonly ids: Map<string, number>; readonly weight: number[] },
) {
  const id = (word: string) => {
    const known = words.ids.get(word)
    if (known !== undefined) return known
    words.ids.set(word, words.weight.length)
    words.weight.push(word.length)
    return words.weight.length - 1
  }
  return at.slice(0, -1).map((start, line): Bag => {
    const words = list
      .slice(start, at[line + 1])
      .map(seen)
      .filter((word) => word !== "")
    return {
      text: words.join(" "),
      ids: new Int32Array(words.map(id)).sort(),
      size: words.reduce((sum, word) => sum + word.length, 0),
    }
  })
}

/**
 * The visible characters two lines have in common, each word matched as often as both use it, when twice that is at
 * least LIKE of both sizes together; else 0.
 */
function common(x: Bag, y: Bag, weight: ReadonlyArray<number>) {
  // Lines too unequal in size cannot be alike enough: no need to compare their words.
  if (2 * Math.min(x.size, y.size) < LIKE * (x.size + y.size)) return 0
  let shared = 0
  for (let i = 0, j = 0; i < x.ids.length && j < y.ids.length; ) {
    const p = x.ids[i]!
    const q = y.ids[j]!
    if (p === q) shared += weight[p]!
    if (p <= q) i++
    if (q <= p) j++
  }
  return 2 * shared >= LIKE * (x.size + y.size) ? shared : 0
}

/**
 * The lines of `span` paired by likeness (`pairs`). A span too large for one table (PAIR_CELLS) goes in windows of
 * PAIR_WINDOW lines a side. A window keeps the pairs clear of its last quarter on each side it cuts off, where a line
 * may belong with one past the window (its first pair at least), and the next window starts after the last pair kept.
 * With no pair at all, a cut-off side's lines in the window are taken as removed or added: all of them when the other
 * side lies wholly in the window (none of its lines is alike them), else half.
 */
function liken(bagsA: ReadonlyArray<Bag>, bagsB: ReadonlyArray<Bag>, weight: ReadonlyArray<number>, span: Span) {
  const out: Pin[] = []
  const at = { i: span.i0, j: span.j0 }
  const past = (from: number, to: number, limit: number, other: boolean) =>
    to === limit ? from : other ? to : from + Math.ceil((to - from) / 2)
  while (at.i < span.i1 && at.j < span.j1) {
    const fits = (span.i1 - at.i) * (span.j1 - at.j) <= PAIR_CELLS
    const end = {
      i: fits ? span.i1 : Math.min(span.i1, at.i + PAIR_WINDOW),
      j: fits ? span.j1 : Math.min(span.j1, at.j + PAIR_WINDOW),
    }
    const found = pairs(bagsA, bagsB, weight, { i0: at.i, i1: end.i, j0: at.j, j1: end.j })
    if (end.i === span.i1 && end.j === span.j1) return [...out, ...found]
    const safe = {
      i: end.i === span.i1 ? end.i : end.i - (end.i - at.i) / 4,
      j: end.j === span.j1 ? end.j : end.j - (end.j - at.j) / 4,
    }
    const clear = found.filter(([i, j]) => i < safe.i && j < safe.j)
    const kept = clear.length > 0 ? clear : found.slice(0, 1)
    for (const pin of kept) out.push(pin)
    const last = kept.at(-1)
    at.i = last ? last[0] + 1 : past(at.i, end.i, span.i1, end.j === span.j1)
    at.j = last ? last[1] + 1 : past(at.j, end.j, span.j1, end.i === span.i1)
  }
  return out
}

/** The pairs of `span`'s lines, in order, with the most visible characters in common: a weighted LCS of `common`. */
function pairs(bagsA: ReadonlyArray<Bag>, bagsB: ReadonlyArray<Bag>, weight: ReadonlyArray<number>, span: Span) {
  const n = span.i1 - span.i0
  const m = span.j1 - span.j0
  const width = m + 1
  const like = (i: number, j: number) => common(bagsA[span.i0 + i]!, bagsB[span.j0 + j]!, weight)
  // Suffix sums: `table[i * width + j]` is the most text in common pairs of lines `i..` and `j..` can have. Only the
  // last row and column are read before they are written.
  if (scratch.likes.length < (n + 1) * width) scratch.likes = new Uint32Array((n + 1) * width)
  const table = scratch.likes
  table.fill(0, n * width, (n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    table[i * width + m] = 0
    for (let j = m - 1, cell = i * width + j; j >= 0; j--, cell--) {
      const shared = like(i, j)
      table[cell] = Math.max(table[cell + width]!, table[cell + 1]!, shared > 0 ? table[cell + width + 1]! + shared : 0)
    }
  }
  const out: Pin[] = []
  const at = { i: 0, j: 0 }
  while (at.i < n && at.j < m) {
    const cell = at.i * width + at.j
    const shared = like(at.i, at.j)
    if (shared > 0 && table[cell] === table[cell + width + 1]! + shared) {
      out.push([span.i0 + at.i, span.j0 + at.j])
      at.i++
      at.j++
      continue
    }
    const down = table[cell + width]! >= table[cell + 1]!
    if (down) at.i++
    if (!down) at.j++
  }
  return out
}

/** The items of `span` found once on each side, equal and `usable`, as pins in the first side's order. */
function once<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>, span: Span, usable: (item: T) => boolean) {
  const found = new Map<T, { count: number; i: number; others: number; j: number }>()
  for (let i = span.i0; i < span.i1; i++) {
    const item = a[i]!
    const entry = found.get(item)
    if (entry) entry.count++
    if (!entry && usable(item)) found.set(item, { count: 1, i, others: 0, j: -1 })
  }
  for (let j = span.j0; j < span.j1; j++) {
    const entry = found.get(b[j]!)
    if (entry) entry.others++
    if (entry) entry.j = j
  }
  return [...found.values()]
    .filter((entry) => entry.count === 1 && entry.others === 1)
    .map((entry): Pin => [entry.i, entry.j])
}

/** The longest run of `pins` (in their first side's order) that rises on the other side too: patience sorting. */
function chain(pins: ReadonlyArray<Pin>) {
  // `tails[k]`: the pin that ends the best run of k + 1 pins so far with the lowest place on the other side.
  const tails: number[] = []
  const before = new Int32Array(pins.length)
  for (const [index, pin] of pins.entries()) {
    const at = { low: 0, high: tails.length }
    while (at.low < at.high) {
      const mid = (at.low + at.high) >> 1
      const rises = pins[tails[mid]!]![1] < pin[1]
      at.low = rises ? mid + 1 : at.low
      at.high = rises ? at.high : mid
    }
    before[index] = at.low > 0 ? tails[at.low - 1]! : -1
    tails[at.low] = index
  }
  const out: Pin[] = []
  for (let index = tails.at(-1) ?? -1; index >= 0; index = before[index]!) out.push(pins[index]!)
  return out.reverse()
}

/**
 * The steps of `range` added to `out`: one table when it fits (WORD_CELLS). A larger span with too little in common to
 * be an edit is a rewrite, marked whole either way: no tables for it. Else the words found once on each side pin it,
 * the longest chain of them, and each stretch between two pins is diffed again, so that a word changed in a line of
 * thousands of tokens is the only one marked; a span with no such word goes in windows (`windows`).
 */
function diffSpan(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  keyA: ReadonlyArray<string>,
  keyB: ReadonlyArray<string>,
  range: Span,
  out: Step[],
): void {
  if ((range.i1 - range.i0) * (range.j1 - range.j0) <= WORD_CELLS) return lcsSteps(a, b, keyA, keyB, range, out)
  if (unlike(a, b, range)) {
    for (const token of a.slice(range.i0, range.i1)) out.push({ op: "delete", a: token })
    for (const token of b.slice(range.j0, range.j1)) out.push({ op: "insert", b: token })
    return
  }
  const pins = chain(once(keyA, keyB, range, (key) => visible(key) > 0))
  if (pins.length === 0) return windows(a, b, keyA, keyB, range, out)
  const at = { i: range.i0, j: range.j0 }
  for (const [i, j] of pins) {
    diffSpan(a, b, keyA, keyB, { i0: at.i, i1: i, j0: at.j, j1: j }, out)
    out.push({ op: "same", a: a[i]!, b: b[j]! })
    at.i = i + 1
    at.j = j + 1
  }
  diffSpan(a, b, keyA, keyB, { i0: at.i, i1: range.i1, j0: at.j, j1: range.j1 }, out)
}

/**
 * The steps of `range` from one LCS table, added to `out`. The tokens both sides start with are set aside first, as
 * the table's walk would take them anyway: a line pair edited near its end leaves a table of a few cells. (Those they
 * end with stay in: the walk pairs a token with its earliest match, a line split's line break with the first line.)
 */
function lcsSteps(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  keyA: ReadonlyArray<string>,
  keyB: ReadonlyArray<string>,
  range: Span,
  out: Step[],
) {
  const at = { i: range.i0, j: range.j0 }
  while (at.i < range.i1 && at.j < range.j1 && keyA[at.i] === keyB[at.j]) {
    out.push({ op: "same", a: a[at.i]!, b: b[at.j]! })
    at.i++
    at.j++
  }
  for (const op of middle(keyA.slice(at.i, range.i1), keyB.slice(at.j, range.j1), WORD_CELLS)) {
    // Built without spreads: a run of thousands of words makes as many steps.
    if (op === "same") out.push({ op, a: a[at.i]!, b: b[at.j]! })
    if (op === "delete") out.push({ op, a: a[at.i]! })
    if (op === "insert") out.push({ op, b: b[at.j]! })
    if (op !== "insert") at.i++
    if (op !== "delete") at.j++
  }
}

/**
 * A span with nothing to pin it, in windows of whole lines, WINDOW tokens a side (a line longer than that is cut inside
 * it). A window's steps are kept up to its last common line break in its first half (all of them in the last window),
 * because lines near a window's cut-off end lose their partners and pair wrongly; the next window starts there.
 */
function windows(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  keyA: ReadonlyArray<string>,
  keyB: ReadonlyArray<string>,
  range: Span,
  out: Step[],
) {
  const at = { i: range.i0, j: range.j0 }
  while (at.i < range.i1 || at.j < range.j1) {
    // Once one side is used up, the rest of the other is one insertion or deletion: no table, one window.
    const end = {
      i: at.j === range.j1 ? range.i1 : edge(a, at.i, range.i1),
      j: at.i === range.i1 ? range.j1 : edge(b, at.j, range.j1),
    }
    const steps: Step[] = []
    lcsSteps(a, b, keyA, keyB, { i0: at.i, i1: end.i, j0: at.j, j1: end.j }, steps)
    const last = end.i === range.i1 && end.j === range.j1
    for (const step of steps.slice(0, last ? steps.length : cut(steps, (end.i - at.i) / 2, (end.j - at.j) / 2))) {
      out.push(step)
      if (step.op !== "insert") at.i++
      if (step.op !== "delete") at.j++
    }
  }
}

/**
 * Whether a span's sides share under SIMILAR of their visible characters even with each word matched as often as both
 * use it, which is more than any table could match: then it is a rewrite.
 */
function unlike(a: ReadonlyArray<string>, b: ReadonlyArray<string>, span: Span) {
  const sum = overlap(a, b, span)
  return (2 * sum.shared) / Math.max(1, sum.a + sum.b) < SIMILAR
}

/** A span's visible characters: each side's, and those in common with each word matched as often as both use it. */
function overlap(a: ReadonlyArray<string>, b: ReadonlyArray<string>, span: Span) {
  const left = new Map<string, number>()
  const sum = { shared: 0, a: 0, b: 0 }
  for (const token of a.slice(span.i0, span.i1)) {
    left.set(token, (left.get(token) ?? 0) + 1)
    sum.a += visible(token)
  }
  for (const token of b.slice(span.j0, span.j1)) {
    const count = left.get(token) ?? 0
    sum.b += visible(token)
    if (count > 0) sum.shared += visible(token)
    if (count > 0) left.set(token, count - 1)
  }
  return sum
}

/** Where a window from `from` ends (`to` at the most): after its last line break within WINDOW tokens, else there. */
function edge(list: ReadonlyArray<string>, from: number, to: number) {
  if (to - from <= WINDOW) return to
  const end = list.lastIndexOf("\n", from + WINDOW - 1)
  return end >= from ? end + 1 : from + WINDOW
}

/**
 * How many of a window's steps to keep: through its last common line break while both sides are in their first half,
 * else everything up to that half (that stretch has no line in common).
 */
function cut(steps: ReadonlyArray<Step>, halfA: number, halfB: number) {
  const at = { i: 0, j: 0, early: 0, half: 0 }
  for (const [index, step] of steps.entries()) {
    if (at.i >= halfA || at.j >= halfB) break
    if (step.op === "same" && step.a === "\n") at.early = index + 1
    if (step.op !== "insert") at.i++
    if (step.op !== "delete") at.j++
    at.half = index + 1
  }
  return at.early > 0 ? at.early : Math.max(1, at.half)
}

/**
 * The tokens as matched: a line break that ends a blank line (nothing visible since the one before) only meets
 * another such, so where a blank line is added or removed beside an edited line, the blank line's break is the one
 * marked, not the edited line's (`rejoin` pairs the rest).
 */
function keys(list: ReadonlyArray<string>) {
  const line = { blank: true }
  return list.map((token) => {
    const key = token === "\n" && line.blank ? "\n\n" : token
    line.blank = token === "\n" || (line.blank && visible(token) === 0)
    return key
  })
}

/**
 * Each changed stretch as shown. One with visible characters whose sides differ in unseen characters alone (a soft
 * hyphen or a zero-width space put in a word, two words joined) is marked at those characters, one by one, not at the
 * words around them (`characters`). In any other, the line breaks it both deletes and adds are paired again in order
 * (`breaks`).
 */
function rejoin(steps: ReadonlyArray<Step>) {
  const out: Step[] = []
  const at = { i: 0 }
  while (at.i < steps.length) {
    const start = at.i
    while (at.i < steps.length && steps[at.i]!.op !== "same") at.i++
    if (at.i > start) for (const step of refined(steps.slice(start, at.i))) out.push(step)
    if (at.i < steps.length) out.push(steps[at.i]!)
    at.i++
  }
  return out
}

/** A changed stretch as `rejoin` shows it. */
function refined(hunk: ReadonlyArray<Step>) {
  const before = hunk.map((step) => step.a ?? "").join("")
  const after = hunk.map((step) => step.b ?? "").join("")
  const bare = seen(before)
  return bare !== "" && bare === seen(after) ? characters(before, after) : breaks(hunk)
}

/** The steps of two texts the same but for unseen characters: those deleted or added one by one, the rest the same. */
function characters(before: string, after: string) {
  const x = Array.from(before)
  const y = Array.from(after)
  const out: Step[] = []
  const at = { i: 0, j: 0 }
  while (at.i < x.length || at.j < y.length) {
    const p = x[at.i]
    const q = y[at.j]
    if (p !== undefined && p === q) {
      out.push({ op: "same", a: p, b: q })
      at.i++
      at.j++
      continue
    }
    // What is left of both reads the same without unseen characters, so one of the two is unseen.
    if (p !== undefined && visible(p) === 0) {
      out.push({ op: "delete", a: p })
      at.i++
      continue
    }
    out.push({ op: "insert", b: q! })
    at.j++
  }
  return out
}

/**
 * A changed stretch with the line breaks it both deletes and adds paired again, in order: there they are a blank
 * line's and a text line's, which `keys` keeps apart, and a line emptied (or filled) keeps its line break rather than
 * showing one removed and one added.
 */
function breaks(hunk: ReadonlyArray<Step>) {
  // A stretch that does not both delete and add a line break, most of them, stays as it is: no lists for it.
  if (!hunk.some((step) => step.a === "\n") || !hunk.some((step) => step.b === "\n")) return hunk
  const deleted = hunk.filter((step) => step.op === "delete")
  const added = hunk.filter((step) => step.op === "insert")
  const at = {
    a: deleted.map((step, index) => (step.a === "\n" ? index : -1)).filter((index) => index >= 0),
    b: added.map((step, index) => (step.b === "\n" ? index : -1)).filter((index) => index >= 0),
  }
  const count = Math.min(at.a.length, at.b.length)
  const out: Step[] = []
  const from = { a: 0, b: 0 }
  for (const pair of Array.from({ length: count }, (_, index) => index)) {
    for (const step of deleted.slice(from.a, at.a[pair])) out.push(step)
    for (const step of added.slice(from.b, at.b[pair])) out.push(step)
    out.push({ op: "same", a: "\n", b: "\n" })
    from.a = at.a[pair]! + 1
    from.b = at.b[pair]! + 1
  }
  return [...out, ...deleted.slice(from.a), ...added.slice(from.b)]
}

/**
 * The steps cut at anchors, which are never marked: a common line break, and a common stretch of ANCHOR visible
 * characters or more. What lies between two anchors is one stretch.
 */
function stretches(steps: ReadonlyArray<Step>) {
  const out: Array<{ readonly anchor: boolean; readonly steps: Step[] }> = []
  const at = { i: 0 }
  while (at.i < steps.length) {
    const start = at.i
    const same = steps[start]!.op === "same"
    while (at.i < steps.length && (steps[at.i]!.op === "same") === same) at.i++
    const group = steps.slice(start, at.i)
    const long = same && group.reduce((sum, step) => sum + visible(step.a!), 0) >= ANCHOR
    for (const step of group) {
      const anchor = long || (same && step.a === "\n")
      const last = out.at(-1)
      if (last?.anchor === anchor) last.steps.push(step)
      if (last?.anchor !== anchor) out.push({ anchor, steps: [step] })
    }
  }
  return out
}

function marked(text: string): ReadonlyArray<Piece> {
  return text === "" ? [] : [{ text, mark: true }]
}

function tokens(text: string) {
  return text.match(/[\p{L}\p{N}_]+|[^\S\r\n]+|\r|\n|[^\p{L}\p{N}_\s]/gu) ?? []
}

function visible(text: string) {
  return seen(text).length
}

/** `text` without what a reader does not see (UNSEEN). */
function seen(text: string) {
  // Most tokens are printable ASCII or plain spaces and line breaks: walked, which costs less than the pattern with its
  // Unicode property. It runs for every token, several times.
  let blank = false
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code > 0x20 && code < 0x7f) continue
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return text.replace(UNSEEN, "")
    blank = true
  }
  return blank ? text.replace(BLANKS, "") : text
}

const BLANKS = /[ \t\n\r]+/g

/**
 * Neighbouring pieces of one kind joined; spaces alone between two marks are marked, so a phrase reads as one. A
 * common line break never is: a mark stops at its line's end, and a line break added or removed next to it stays a
 * mark of its own (drawn ⏎).
 */
function merge(pieces: ReadonlyArray<Piece>) {
  // Texts gathered and joined once: a large run has a piece per token.
  const join = (list: ReadonlyArray<Piece>) =>
    list
      .reduce<Array<{ readonly mark: boolean; readonly texts: string[] }>>((out, piece) => {
        const last = out.at(-1)
        if (last?.mark === piece.mark) last.texts.push(piece.text)
        if (last?.mark !== piece.mark) out.push({ mark: piece.mark, texts: [piece.text] })
        return out
      }, [])
      .map((group): Piece => ({ text: group.texts.join(""), mark: group.mark }))
  const joined = join(pieces)
  return join(
    joined.map((piece, index) =>
      !piece.mark && /^[^\S\r\n]+$/.test(piece.text) && joined[index - 1]?.mark && joined[index + 1]?.mark
        ? { ...piece, mark: true }
        : piece,
    ),
  )
}

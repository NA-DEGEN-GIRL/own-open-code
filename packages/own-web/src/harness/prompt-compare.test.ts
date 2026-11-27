// 설정 > 에이전트 방식's `비교` (prompt-compare.ts): the line and word diff, whitespace marks drawn so they show (a
// line break added or removed beside an edit too, and the characters that pass for a space or for nothing: every
// default-ignorable, format and control character a glyph, named with its code points, marked alone inside a word),
// copying the real text (`copyReal` too), a small edit beside a large deletion marked on its own, large runs still
// marked word by word (a line of thousands of words, a run edited on every line with blocks of lines added or removed,
// in time), parts and tools paired, own's changes under the runs that show them (else listed apart), the clock read
// once, unchanged stretches folded and named by their lines, and same parts marked.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import {
  changeAnchor,
  codePoints,
  comparePreviews,
  copyReal,
  diffText,
  firstSentence,
  fold,
  groupSame,
  inks,
  type Piece,
  type Segment,
} from "./prompt-compare"

type Change = Extract<Segment, { kind: "change" }>

/** Codex's fallback base, line by line: Codex 방식 sends it to the models outside Codex's catalog. */
const CODEX = readFileSync(path.join(import.meta.dir, "../../../own-harness/codex-data/prompt.md"), "utf8").split("\n")

/** The changed runs of `left` against `right`. */
const changes = (left: string, right: string) =>
  diffText(left, right).filter((segment): segment is Change => segment.kind === "change")

const marks = (segments: ReadonlyArray<Segment>) =>
  segments.flatMap((segment) =>
    segment.kind === "change"
      ? [
          {
            left: segment.left.filter((piece) => piece.mark).map((piece) => piece.text),
            right: segment.right.filter((piece) => piece.mark).map((piece) => piece.text),
          },
        ]
      : [],
  )

/** A side as the page draws it: each mark in brackets (`[-…]`, `[+…]`), its glyphs as they look. */
const looks = (pieces: ReadonlyArray<Piece>, sign: "-" | "+") =>
  pieces
    .map((piece) => {
      if (!piece.mark) return piece.text
      const drawn = inks(piece)
      return `[${sign}${drawn.inside.map((ink) => (typeof ink === "string" ? ink : ink.text)).join("")}]${drawn.after}`
    })
    .join("")

/** A side as copying a selection of it gives: the glyphs left out, the real characters beside them in. */
const copied = (pieces: ReadonlyArray<Piece>) =>
  pieces
    .map((piece) => {
      if (!piece.mark) return piece.text
      const drawn = inks(piece)
      return `${drawn.inside.map((ink) => (typeof ink === "string" ? ink : ink.real)).join("")}${drawn.after}`
    })
    .join("")

describe("diffText", () => {
  test("the same text is one unchanged stretch", () => {
    expect(diffText("a\nb\n", "a\nb\n")).toEqual([{ kind: "same", text: "a\nb", line: 1 }])
  })

  test("a changed line keeps its neighbours and marks the changed words only", () => {
    const segments = diffText(
      "first line\nYou are running in the Codex CLI, a terminal tool.\nlast line\n",
      "first line\nYou are running in own, a coding app.\nlast line\n",
    )
    expect(segments.map((segment) => segment.kind)).toEqual(["same", "change", "same"])
    expect(segments[0]).toEqual({ kind: "same", text: "first line", line: 1 })
    expect(segments[2]).toEqual({ kind: "same", text: "last line", line: 3 })
    expect(marks(segments)).toEqual([{ left: ["the Codex CLI", "terminal tool"], right: ["own", "coding app"] }])
    // Both sides still read in full.
    const change = segments[1]!
    if (change.kind !== "change") throw new Error("expected a change")
    expect(change.line).toBe(2)
    expect(change.left.map((piece) => piece.text).join("")).toBe("You are running in the Codex CLI, a terminal tool.")
    expect(change.right.map((piece) => piece.text).join("")).toBe("You are running in own, a coding app.")
  })

  test("added and removed lines leave the other side empty", () => {
    expect(marks(diffText("a\nb\n", "a\nnew\nb\n"))).toEqual([{ left: [], right: ["new"] }])
    expect(marks(diffText("a\nold\nb\n", "a\nb\n"))).toEqual([{ left: ["old"], right: [] }])
    expect(marks(diffText("", "only\n"))).toEqual([{ left: [], right: ["only"] }])
  })

  test("a rewrite is one run marked whole line by line, its common blank lines left unmarked", () => {
    const before = "Keep going until the query is solved.\n\nUse the shell for every step of the task.\n\nBe brief.\n"
    const after = "Plan first and check with the user.\n\nNever touch files outside the folder.\n\nAnswer in Korean.\n"
    const segments = diffText(before, after)
    expect(segments.map((segment) => segment.kind)).toEqual(["change"])
    expect(marks(segments)).toEqual([{ left: before.trimEnd().split("\n\n"), right: after.trimEnd().split("\n\n") }])
    const [run] = changes(before, after)
    expect(looks(run!.right, "+")).toBe(
      "[+Plan first and check with the user.]\n\n[+Never touch files outside the folder.]\n\n[+Answer in Korean.]",
    )
  })

  test("Korean words are words", () => {
    expect(marks(diffText("원본은 그대로 보내요.\n", "개선판은 그대로 보내요.\n"))).toEqual([
      { left: ["원본은"], right: ["개선판은"] },
    ])
  })

  test("a small edit beside a large deletion keeps its own marks (Codex's spawn_agent, fallback tier)", () => {
    // Codex's description starts with its account's model list (codex.spawn.models deletes it); the line after it only
    // gains a sentence (codex.spawn.model-arg). Over the whole run under 40% matches, which once marked it all new.
    const line =
      "Spawn a sub-agent for a well-scoped task. Returns the spawned agent id plus the user-facing nickname when available. Spawned agents inherit your current model by default. Omit `model` to use that preferred default; set `model` only when an explicit override is needed."
    const added = " It is only ever a model id of your own provider, written like the `Model ID` under `# Your Model`."
    const models = [
      "- `gpt-6.1-sol`: Latest workhorse model for coding and everyday work. Reasoning efforts: low (default), medium, high, xhigh, max, ultra. Service tiers: priority.",
      "- `gpt-6-astra`: Frontier intelligence for the most demanding work. Reasoning efforts: low (default), medium, high, xhigh, max, ultra. Service tiers: priority.",
      "- `gpt-6-sol`: Previous generation workhorse model. Reasoning efforts: low, medium (default), high, xhigh, max, ultra. Service tiers: priority.",
      "- `gpt-6-luna`: Fast and affordable model for easier tasks. Reasoning efforts: low, medium (default), high, xhigh, max. Service tiers: priority.",
      "- `gpt-5.6-sol`: Older generation workhorse model. Reasoning efforts: low (default), medium, high, xhigh, max, ultra. Service tiers: priority.",
    ]
    const list = `\n        \n        Available model overrides (optional; inherited parent model is preferred):\n${models.join("\n")}\n        `
    const after = "This spawn_agent tool provides you access to sub-agents.\n"
    const [run, ...rest] = changes(`${list}${line}\n${after}`, `${line}${added}\n${after}`)
    expect(rest).toEqual([])
    // The added sentence is the right side's only mark; the line it extends reads as unchanged on both sides.
    expect(run!.right).toEqual([
      { text: line, mark: false },
      { text: added, mark: true },
    ])
    expect(run!.left).toEqual([
      { text: list, mark: true },
      { text: line, mark: false },
    ])
    // The two blank lines the list loses show as ⏎; its lines of text need none.
    expect(looks(run!.left, "-")).toBe(`[-⏎\n        ⏎\n${list.slice(10)}]${line}`)
  })

  test("a run is judged line by line: an edited line keeps word marks beside a rewritten one", () => {
    const [run] = changes(
      "Keep going until the query is solved.\n\nYou are running in the Codex CLI, a terminal tool.\n",
      "Plan first and check with the user.\n\nYou are running in own, a terminal tool.\n",
    )
    expect(marks([run!])).toEqual([
      {
        left: ["Keep going until the query is solved.", "the Codex CLI"],
        right: ["Plan first and check with the user.", "own"],
      },
    ])
  })
})

describe("a line break added or removed beside an edited line is a mark of its own, drawn ⏎", () => {
  test("a\\nb\\nc → a\\nB\\n\\nc: B is marked, and the blank line after it shows ⏎", () => {
    const [run, ...rest] = changes("a\nb\nc\n", "a\nB\n\nc\n")
    expect(rest).toEqual([])
    expect(run!.right).toEqual([
      { text: "B", mark: true },
      { text: "\n", mark: false },
      { text: "\n", mark: true, space: true },
    ])
    expect(looks(run!.left, "-")).toBe("[-b]")
    expect(looks(run!.right, "+")).toBe("[+B]\n[+⏎]\n")
    // The mark of B holds no line break: B's line ends where it did.
    expect(run!.right[0]!.text.includes("\n")).toBe(false)
  })

  test("the other way round: the removed blank line shows ⏎ on the left", () => {
    const [run] = changes("a\nB\n\nc\n", "a\nb\nc\n")
    expect(looks(run!.left, "-")).toBe("[-B]\n[-⏎]\n")
    expect(looks(run!.right, "+")).toBe("[+b]")
  })

  test("a line whose final . became ! with a blank line after it: ! and ⏎ are marked, nothing else", () => {
    const [run] = changes("Intro.\nBe brief.\nEnd.\n", "Intro.\nBe brief!\n\nEnd.\n")
    expect(looks(run!.left, "-")).toBe("Be brief[-.]")
    expect(looks(run!.right, "+")).toBe("Be brief[+!]\n[+⏎]\n")
    expect(run!.whitespace).toBeUndefined()
  })

  test("a line rewritten whole with a blank line after it: the line is one mark, the blank line ⏎", () => {
    const [run] = changes("Intro.\nshort line\nEnd.\n", "Intro.\nA completely different sentence here.\n\nEnd.\n")
    expect(looks(run!.left, "-")).toBe("[-short line]")
    expect(looks(run!.right, "+")).toBe("[+A completely different sentence here.]\n[+⏎]\n")
  })

  test("a blank line added before an edited line is the one marked, on its own line", () => {
    const [run] = changes("a\nb\nc\n", "a\n\nB\nc\n")
    expect(looks(run!.right, "+")).toBe("[+⏎\nB]")
  })

  test("two lines joined beside an edited word: the removed line break shows ⏎ where the line ended", () => {
    const [run] = changes("foo\nbar\n", "foo baz\n")
    expect(looks(run!.left, "-")).toBe("foo[-⏎\nbar]")
    expect(looks(run!.right, "+")).toBe("foo[+ baz]")
  })

  test("a line split beside an edited word: the new line's text is marked, the line ends where it did", () => {
    const [run] = changes("foo bar\n", "foo\nbaz\n")
    expect(looks(run!.left, "-")).toBe("foo[- bar]")
    expect(looks(run!.right, "+")).toBe("foo\n[+baz]")
  })

  test("lines added after an edited one need no ⏎: their text is marked", () => {
    const [run] = changes("a\nb\nc\n", "a\nB\nnew one\nnew two\nc\n")
    expect(looks(run!.right, "+")).toBe("[+B]\n[+new one\nnew two]")
  })
})

describe("whitespace", () => {
  const PI =
    "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code."

  test("Pi 방식 > 내 지시문 = 개선판 + a line break: the right side shows ⏎, and the run says only line ends differ", () => {
    const [run, ...rest] = changes(PI, `${PI}\n`)
    expect(rest).toEqual([])
    expect(run).toEqual({
      kind: "change",
      line: 1,
      left: [{ text: PI, mark: false }],
      right: [
        { text: PI, mark: false },
        { text: "\n", mark: true, space: true },
      ],
      notes: [],
      whitespace: "lines",
    })
    expect(looks(run!.right, "+")).toBe(`${PI}[+⏎]\n`)
  })

  test("an added blank line: no lines on the left (not `missing`), ⏎ on the right", () => {
    expect(diffText("a\n", "a\n\n")).toEqual([
      { kind: "same", text: "a", line: 1 },
      {
        kind: "change",
        line: 2,
        left: [],
        right: [{ text: "\n", mark: true, space: true }],
        notes: [],
        whitespace: "lines",
      },
    ])
    // Removed, the other way round.
    expect(changes("a\n\nb\n", "a\nb\n")).toEqual([
      {
        kind: "change",
        line: 2,
        left: [{ text: "\n", mark: true, space: true }],
        right: [],
        notes: [],
        whitespace: "lines",
      },
    ])
  })

  test("a space that became a line break: · on the left, ⏎ on the right (the line still breaks)", () => {
    const [run] = changes("one two", "one\ntwo")
    expect(run).toEqual({
      kind: "change",
      line: 1,
      left: [
        { text: "one", mark: false },
        { text: " ", mark: true, space: true },
        { text: "two", mark: false },
      ],
      right: [
        { text: "one", mark: false },
        { text: "\n", mark: true, space: true },
        { text: "two", mark: false },
      ],
      notes: [],
      whitespace: "spaces",
    })
    expect(looks(run!.left, "-")).toBe("one[-·]two")
    expect(looks(run!.right, "+")).toBe("one[+⏎]\ntwo")
  })

  test("\\r, tabs and trailing spaces show as glyphs; a common line break is never marked", () => {
    const [crlf] = changes("a\r\nb\n", "a\nb\n")
    expect([crlf!.left, crlf!.right, crlf!.whitespace]).toEqual([
      [
        { text: "a", mark: false },
        { text: "\r", mark: true, space: true },
      ],
      [{ text: "a", mark: false }],
      "lines",
    ])
    expect(looks(crlf!.left, "-")).toBe("a[-␍]")
    const [tab] = changes("a\tb\n", "a b\n")
    expect([looks(tab!.left, "-"), looks(tab!.right, "+")]).toEqual(["a[-→]b", "a[+·]b"])
    expect(marks(diffText("a  \nb\n", "a\nb\n"))).toEqual([{ left: ["  "], right: [] }])
  })

  test("a line emptied keeps its empty line on the right; a real edit is not called whitespace", () => {
    const [run] = changes("a\nx\nb\n", "a\n\nb\n")
    expect([run!.left, run!.right, run!.whitespace]).toEqual([
      [{ text: "x", mark: true }],
      [{ text: "", mark: false }],
      undefined,
    ])
  })
})

describe("glyphs inside marks with visible text, and the note when they are all that differs", () => {
  test("\\r, no-break and ideographic spaces and zero-width characters show; spaces and tabs stay as they are", () => {
    expect(inks({ text: "a\tb c d　e​f\r", mark: true })).toEqual({
      inside: [
        "a\tb c",
        { glyph: "nbsp", text: "⍽", real: " " },
        "d",
        { glyph: "wide", text: "□", real: "　" },
        "e",
        { glyph: "zero", text: "⁞", real: "​" },
        "f",
        { glyph: "return", text: "␍", real: "\r" },
      ],
      after: "",
    })
  })

  test("each kind has its own glyph, a run of one kind is one, and a mark of whitespace alone shows them all", () => {
    expect(inks({ text: "  \t  　⁠\r\n", mark: true, space: true })).toEqual({
      inside: [
        { glyph: "space", text: "··", real: "  " },
        { glyph: "tab", text: "→", real: "\t" },
        { glyph: "nbsp", text: "⍽⍽", real: "  " },
        { glyph: "wide", text: "□", real: "　" },
        { glyph: "zero", text: "⁞", real: "⁠" },
        { glyph: "return", text: "␍", real: "\r" },
        { glyph: "break", text: "⏎", real: "" },
      ],
      after: "\n",
    })
  })

  test("a word joined by a no-break space: the mark shows ⍽, and the run says only spaces differ", () => {
    const [run] = changes("Use the shell now.\n", "Use the shell now.\n")
    expect(looks(run!.left, "-")).toBe("Use the[-⍽]shell now.")
    expect(looks(run!.right, "+")).toBe("Use the[+·]shell now.")
    expect(run!.whitespace).toBe("spaces")
    // Inside a rewritten stretch too.
    const [wide] = changes("x　y\n", "z\n")
    expect(looks(wide!.left, "-")).toBe("[-x□y]")
  })

  test("a zero-width character alone: ⁞, the character alone marked, and the run says only invisible ones differ", () => {
    const [run] = changes("foo\u{200B}bar\n", "foobar\n")
    expect(looks(run!.left, "-")).toBe("foo[-⁞]bar")
    expect(looks(run!.right, "+")).toBe("foobar")
    expect(run!.whitespace).toBe("invisible")
    expect(changes("a\n", "a﻿\n")[0]!.whitespace).toBe("invisible")
    expect(changes("a\n", "a\r\n")[0]!.whitespace).toBe("lines")
  })
})

describe("characters that render as nothing: every one a glyph, a name with its code points, the note", () => {
  // The default-ignorable code points as Unicode lists them (DerivedCoreProperties.txt, Default_Ignorable_Code_Point),
  // which the page finds by `\p{Default_Ignorable_Code_Point}`: this list holds the engine to it.
  const IGNORABLE = [
    [0xad, 0xad],
    [0x34f, 0x34f],
    [0x61c, 0x61c],
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x206f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff0, 0xfff8],
    [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe0fff],
  ] as const
  // The control characters but tab, line feed, vertical tab, form feed and CR (NEL among them), and the interlinear
  // annotation characters, which render as a box or as nothing.
  const CONTROLS = [
    [0x00, 0x08],
    [0x0e, 0x1f],
    [0x7f, 0x9f],
    [0xfff9, 0xfffb],
  ] as const
  const each = (ranges: ReadonlyArray<readonly [number, number]>) =>
    ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, at) => String.fromCodePoint(from + at)))

  test("each kind has its own glyph, and inside a mark with text it shows as well", () => {
    const kinds = [
      ["\u{AD}", "soft", "¬"],
      ["\u{85}", "nel", "␤"],
      ["\u{1B}", "control", "␛"],
      ["\u{0}", "control", "␀"],
      ["\u{7F}", "control", "␡"],
      ["\u{9B}", "control", "␦"],
      ["\u{200E}", "bidi", "⇄"],
      ["\u{202E}", "bidi", "⇄"],
      ["\u{2066}", "bidi", "⇄"],
      ["\u{61C}", "bidi", "⇄"],
      ["\u{FE0F}", "variant", "◌"],
      ["\u{E0100}", "variant", "◌"],
      ["\u{180B}", "variant", "◌"],
      ["\u{E0041}", "tag", "⌑"],
      ["\u{E007F}", "tag", "⌑"],
      ["\u{3164}", "filler", "▯"],
      ["\u{180E}", "zero", "⁞"],
      ["\u{2061}", "zero", "⁞"],
      ["\u{2064}", "zero", "⁞"],
      ["\u{34F}", "zero", "⁞"],
      ["\u{FFF9}", "zero", "⁞"],
      ["\u{2003}", "space", "·"],
      ["\u{2028}", "space", "·"],
    ] as const
    for (const [char, glyph, text] of kinds) {
      expect(inks({ text: char, mark: true, space: true }).inside).toEqual([{ glyph, text, real: char }])
      expect(inks({ text: `a${char}b`, mark: true }).inside).toEqual(["a", { glyph, text, real: char }, "b"])
    }
    // Plain spaces and tabs inside a mark with text stay as they are.
    expect(inks({ text: "a b\tc", mark: true }).inside).toEqual(["a b\tc"])
  })

  test("every default-ignorable code point, NEL and the other control characters get a glyph and the note", () => {
    const all = [...each(IGNORABLE), ...each(CONTROLS)]
    expect(all.length).toBeGreaterThan(4_200)
    for (const char of all) {
      const drawn = inks({ text: `x${char}y`, mark: true }).inside
      expect(drawn.length).toBe(3)
      expect(drawn[1]).toMatchObject({ real: char })
    }
    // A run that differs in one of them alone says so: one string of all of them, against none.
    const [run] = changes(`a${all.join("")}b\n`, "ab\n")
    expect(run!.whitespace).toBe("invisible")
    expect(changes("a\u{85}b\n", "ab\n")[0]!.whitespace).toBe("invisible")
    expect(changes("a\u{2028}b\n", "a b\n")[0]!.whitespace).toBe("spaces")
  })

  test("a soft hyphen put in a word marks the hyphen alone, not the word", () => {
    const [run, ...rest] = changes("Use a hyphenated word.\n", "Use a hy\u{AD}phen\u{AD}ated word.\n")
    expect(rest).toEqual([])
    expect(looks(run!.left, "-")).toBe("Use a hyphenated word.")
    expect(looks(run!.right, "+")).toBe("Use a hy[+¬]phen[+¬]ated word.")
    expect(run!.whitespace).toBe("invisible")
    // Taken out again, the other way round.
    expect(looks(changes("Use a hy\u{AD}phenated word.\n", "Use a hyphenated word.\n")[0]!.left, "-")).toBe(
      "Use a hy[-¬]phenated word.",
    )
  })

  test("so are the others in a word: a tag, a variation selector, a direction mark, a Hangul filler", () => {
    expect(looks(changes("flag\n", "fl\u{E0067}\u{E0062}ag\n")[0]!.right, "+")).toBe("fl[+⌑⌑]ag")
    expect(looks(changes("heart ❤ here\n", "heart ❤\u{FE0F} here\n")[0]!.right, "+")).toBe("heart ❤[+◌] here")
    expect(looks(changes("abc\n", "a\u{200F}bc\n")[0]!.right, "+")).toBe("a[+⇄]bc")
    expect(looks(changes("이름\n", "이름\u{3164}\n")[0]!.right, "+")).toBe("이름[+▯]")
  })

  test("beside a real edit, a word that differs in them only still marks them alone", () => {
    const [run] = changes("Keep the hyphen and the plan.\n", "Keep the hy\u{AD}phen and a plan.\n")
    expect(looks(run!.left, "-")).toBe("Keep the hyphen and [-the] plan.")
    expect(looks(run!.right, "+")).toBe("Keep the hy[+¬]phen and [+a] plan.")
    expect(run!.whitespace).toBeUndefined()
    // Two words joined: the space alone is marked.
    const [joined] = changes("Use foo bar here.\n", "Use foobar here.\n")
    expect([looks(joined!.left, "-"), looks(joined!.right, "+")]).toEqual(["Use foo[-·]bar here.", "Use foobar here."])
  })

  test("a run of glyphs is named with its code points, each once, but for plain spaces, tabs and CRs", () => {
    expect(codePoints("\u{AD}")).toBe("U+00AD")
    expect(codePoints("\u{200B}\u{200B}\u{200C}")).toBe("U+200B, U+200C")
    expect(codePoints("\u{E0041}\u{E0042}")).toBe("U+E0041, U+E0042")
    expect(codePoints("\u{85}")).toBe("U+0085")
    expect(codePoints(" \u{2003}")).toBe("U+0020, U+2003")
    expect(codePoints("  \t\r")).toBe("")
    expect(codePoints("")).toBe("")
    expect(codePoints("\u{E0061}\u{E0062}\u{E0063}\u{E0064}\u{E0065}\u{E0066}\u{E0067}")).toBe(
      "U+E0061, U+E0062, U+E0063, U+E0064, U+E0065, U+E0066, …",
    )
    // A glyph run's `real` is what the name reads, and one glyph stands for one character, astral ones too.
    const [tag] = inks({ text: "\u{E0041}\u{E0042}", mark: true, space: true }).inside
    expect(tag).toEqual({ glyph: "tag", text: "⌑⌑", real: "\u{E0041}\u{E0042}" })
  })
})

describe("copying a selection (`copyReal`)", () => {
  test("writes the selection's own text, a no-break space and a hidden real character kept, and stops the browser's", () => {
    document.body.innerHTML =
      '<section><pre>Use the\u{A0}shell<span class="own-pcmp-real">\u{AD}</span> now.</pre></section>'
    const range = document.createRange()
    range.selectNodeContents(document.querySelector("pre")!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    const section = document.querySelector("section")!
    section.addEventListener("copy", copyReal)
    const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    document.querySelector("pre")!.dispatchEvent(event)
    expect(event.clipboardData!.getData("text/plain")).toBe("Use the\u{A0}shell\u{AD} now.")
    expect(event.defaultPrevented).toBe(true)
    // Nothing selected: the browser's own copy goes on.
    getSelection()!.removeAllRanges()
    const empty = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })
    section.dispatchEvent(empty)
    expect(empty.defaultPrevented).toBe(false)
    section.removeEventListener("copy", copyReal)
    document.body.innerHTML = ""
  })
})

describe("copying and boxes", () => {
  const cases = [
    ["a\nb\nc\n", "a\nB\n\nc\n"],
    ["Use the shell now.\n", "Use the shell now.\n"],
    ["foo​bar\tbaz\r\n", "foo bar baz\n"],
    ["one two", "one\ntwo"],
    ["x　y\n\n", "z\n"],
  ] as const

  test("a copied selection is the real text: no glyph in it, every real character", () => {
    for (const [left, right] of cases)
      for (const run of changes(left, right)) {
        for (const side of [run.left, run.right] as const) {
          expect(copied(side)).toBe(side.map((piece) => piece.text).join(""))
          expect(/[⏎·→␍⍽□⁞]/.test(copied(side))).toBe(false)
        }
      }
  })

  test("a mark's last line break is drawn after it, so its box stays on its line", () => {
    expect(inks({ text: "\n", mark: true, space: true })).toEqual({
      inside: [{ glyph: "break", text: "⏎", real: "" }],
      after: "\n",
    })
    expect(inks({ text: "x\n", mark: true })).toEqual({ inside: ["x"], after: "\n" })
    for (const [left, right] of cases)
      for (const run of changes(left, right))
        for (const piece of [...run.left, ...run.right].filter((item) => item.mark)) {
          const last = inks(piece).inside.at(-1)
          expect(typeof last === "string" && last.endsWith("\n")).toBe(false)
        }
  })
})

describe("large runs", () => {
  test("' Always.' added to every line of a 2.4 KB run: each line gets that mark, nothing is marked whole", () => {
    const words = [
      "Use",
      "Read",
      "Write",
      "Check",
      "Keep",
      "Name",
      "Run",
      "Plan",
      "Open",
      "List",
      "Skip",
      "Close",
      "Ask",
    ]
    const lines = Array.from(
      { length: 60 },
      (_, at) => `${words[at % 13]} the shell for step ${at + 1} of the whole task.`,
    )
    const left = `${lines.join("\n")}\n`
    // Over a thousand tokens a side, past one table (WORD_CELLS), which once marked the whole run.
    expect(left.length).toBeGreaterThan(2400)
    const right = `${lines.map((line) => `${line} Always.`).join("\n")}\n`
    const [run, ...rest] = changes(left, right)
    expect(rest).toEqual([])
    expect(marks([run!])).toEqual([{ left: [], right: lines.map(() => " Always.") }])
  })

  test("a CRLF copy of a template: every line shows ␍, the run says only line ends differ, nothing marked whole", () => {
    const verbs = ["read", "check", "write", "keep", "explain", "run", "open", "close", "list", "update", "review"]
    const things = ["the shell", "a file", "the user", "the plan", "each test", "the answer", "a tool"]
    const ends = ["before you edit.", "when it is unclear.", "after each change.", "in plain words.", "only once."]
    const lines = Array.from({ length: 90 }, (_, at) =>
      at % 9 === 8 ? "" : `${at + 1}. Always ${verbs[at % 11]} ${things[(at * 3) % 7]} ${ends[(at * 2) % 5]}`,
    )
    const template = `${lines.join("\n")}\n`
    const [run, ...rest] = changes(template, template.replaceAll("\n", "\r\n"))
    expect(rest).toEqual([])
    expect(run!.whitespace).toBe("lines")
    expect(marks([run!])).toEqual([{ left: [], right: lines.map(() => "\r") }])
    expect(looks(run!.right, "+").split("\n").slice(0, 2)).toEqual([`${lines[0]}[+␍]`, `${lines[1]}[+␍]`])
  })

  test("lines added and removed inside a large edited run: the rest stays paired, each with its own word mark", () => {
    const verbs = ["read", "check", "write", "keep", "explain", "run", "open", "close", "list", "update", "review"]
    const things = ["the shell", "a file", "the user", "the plan", "each test", "the answer", "a tool"]
    const ends = ["before you edit.", "when it is unclear.", "after each change.", "in plain words.", "only once."]
    const lines = Array.from({ length: 90 }, (_, at) =>
      at % 9 === 8 ? "" : `${at + 1}. Always ${verbs[at % 11]} ${things[(at * 3) % 7]} ${ends[(at * 2) % 5]}`,
    )
    const edited = lines.map((line) => (line === "" ? line : `${line} Really.`))
    const inserted = ["New rule one about something else entirely.", "New rule two about another topic here."]
    const right = [...edited.slice(0, 40), ...inserted, ...edited.slice(40, 60), ...edited.slice(62)]
    const [run] = changes(`${lines.join("\n")}\n`, `${right.join("\n")}\n`)
    const added = run!.right.filter((piece) => piece.mark).map((piece) => piece.text)
    // Each edited line shows its own ` Really.`, and the two new lines are one mark; a line paired with the wrong one
    // would show more. The lines are paired before their words, so the `.` of a ` Really.` no longer pairs with the
    // `.` of a deleted line beside it (as many matches either way, once).
    expect(added).toEqual(
      right.flatMap((line) =>
        line.endsWith(" Really.") ? [" Really."] : line === inserted[0] ? [`${inserted.join("\n")}\n`] : [],
      ),
    )
    const removed = run!.left.filter((piece) => piece.mark).map((piece) => piece.text)
    expect(removed).toEqual([`${lines[60]}\n${lines[61]}\n`])
  })
  test("a word changed in a line of 600 or 1,200 words: only that word is marked", () => {
    const words = CODEX.join(" ")
      .split(/[^A-Za-z]+/)
      .filter((word) => word !== "")
    for (const count of [600, 1_200]) {
      const line = words.slice(0, count)
      const edited = line.map((word, at) => (at === count / 2 ? "REPLACED" : word))
      const [run, ...rest] = changes(`Intro.\n${line.join(" ")}.\nEnd.\n`, `Intro.\n${edited.join(" ")}.\nEnd.\n`)
      expect(rest).toEqual([])
      // Past one table: thousands of tokens a side.
      expect(line.join(" ").length).toBeGreaterThan(3_000)
      expect(marks([run!])).toEqual([{ left: [line[count / 2]!], right: ["REPLACED"] }])
    }
  })

  test("a line of one sentence over and over, with no word found once: windows still mark the changed word alone", () => {
    const sentences = Array.from({ length: 700 }, () => "Keep the shell open.")
    const edited = sentences.map((sentence, at) => (at === 350 ? "Keep the SHELL open." : sentence))
    const [run] = changes(`${sentences.join(" ")}\n`, `${edited.join(" ")}\n`)
    expect(marks([run!])).toEqual([{ left: ["shell"], right: ["SHELL"] }])
  })

  // Codex's fallback base (own-harness codex-data/prompt.md, the text Codex 방식 sends other models), cut to about
  // 17 KB like 개선판's, with every line of text edited: a word added to one line, a word of the next in capitals.
  // Once, with 30 or more lines added or 60 removed besides, the windows drifted and some 13 K characters were marked
  // deleted and added again; the marks must stay at the edits.
  const base = CODEX.slice(
    0,
    CODEX.findIndex((_, at) => CODEX.slice(0, at + 1).join("\n").length > 17_000),
  )
  const edit = (line: string, at: number) => {
    const word = /\b[a-z]{4,}\b/.exec(line)
    if (line.trim() === "" || at % 2 === 0 || word === null) return line.trim() === "" ? line : `${line} Really.`
    return `${line.slice(0, word.index)}${word[0].toUpperCase()}${line.slice(word.index + word[0].length)}`
  }
  const verbs = ["Read", "Check", "Write", "Keep", "Name", "Plan", "Ask"]
  const things = ["the answer", "each test", "a tool call", "the patch", "every file"]
  const added = (count: number) =>
    Array.from(
      { length: count },
      (_, at) => `Added rule ${at + 1}: ${verbs[at % 7]} ${things[(at * 3) % 5]} once more before you go on.`,
    )
  const size = (text: string) => text.replace(/\s/g, "").length
  /** The visible characters marked on both sides. */
  const markedSize = (segments: ReadonlyArray<Segment>) =>
    segments
      .flatMap((segment) => (segment.kind === "change" ? [...segment.left, ...segment.right] : []))
      .filter((piece) => piece.mark)
      .reduce((sum, piece) => sum + size(piece.text), 0)

  for (const [inserted, deleted] of [
    [30, 0],
    [60, 0],
    [120, 0],
    [0, 60],
  ] as const)
    test(`a fully edited 17 KB run with ${inserted > 0 ? `${inserted} lines added` : `${deleted} lines removed`}: the marks stay at the edits`, () => {
      expect(base.join("\n").length).toBeGreaterThan(16_500)
      const edited = base.map(edit)
      const at = 80
      const right = [...edited.slice(0, at), ...added(inserted), ...edited.slice(at + deleted)]
      // What really changed: each kept line's edit, the lines added, the lines removed.
      const truth =
        base.reduce((sum, line, index) => {
          if (index >= at && index < at + deleted) return sum + size(line)
          if (line === edited[index]) return sum
          if (edited[index]!.startsWith(line)) return sum + size(edited[index]!.slice(line.length))
          return sum + 2 * (/\b[a-z]{4,}\b/.exec(line)?.[0].length ?? 0)
        }, 0) + added(inserted).reduce((sum, line) => sum + size(line), 0)
      const marked = markedSize(diffText(base.join("\n"), right.join("\n")))
      expect(marked).toBeGreaterThanOrEqual(truth)
      expect(marked).toBeLessThanOrEqual(truth * 1.1 + 50)
    })

  test("the 17 KB run with 120 lines added is diffed fast (tens of milliseconds warm under Bun)", () => {
    const right = [...base.map(edit).slice(0, 80), ...added(120), ...base.map(edit).slice(80)].join("\n")
    const times = Array.from({ length: 3 }, () => {
      const start = performance.now()
      diffText(base.join("\n"), right)
      return performance.now() - start
    })
    // Generous, for a loaded machine: what it guards against is a table per window, hundreds of milliseconds.
    expect(Math.min(...times)).toBeLessThan(300)
  })

  test("a run too long for one table of line pairs goes in windows of them, and keeps the pairing", () => {
    const words = ["plan", "test", "shell", "file", "patch", "user", "tool", "answer", "folder", "model", "change"]
    const lines = Array.from(
      { length: 600 },
      (_, at) =>
        `${at + 1}. ${Array.from({ length: 6 }, (_, word) => words[(at * 7 + word * 5 + ((at * word) % 3)) % 11]).join(" ")} step ${at * 13}.`,
    )
    const fresh = Array.from({ length: 40 }, (_, at) => `New zebra ${at} yak quartz violin ${at * 7} ember.`)
    const right = [...lines.slice(0, 300), ...fresh, ...lines.slice(300)].map((line) =>
      fresh.includes(line) ? line : `${line} Really.`,
    )
    // 600 × 640 lines: past one table of line pairs (PAIR_CELLS).
    const marked = markedSize(diffText(`${lines.join("\n")}\n`, `${right.join("\n")}\n`))
    expect(marked).toBe(lines.length * size(" Really.") + fresh.reduce((sum, line) => sum + size(line), 0))
  })
})

describe("comparePreviews", () => {
  const change = (fields: Partial<OwnHarness.PromptChange> & Pick<OwnHarness.PromptChange, "id">) =>
    ({
      title: "제목",
      why: "까닭이에요. 더 있어요.",
      part: "base",
      before: "",
      after: "",
      applies: true,
      ...fields,
    }) as const
  const part = (kind: OwnHarness.PromptPartKind, text: string): OwnHarness.PromptPart => ({
    kind,
    role: "system",
    text,
    editable: kind === "base",
  })
  const preview = (
    prompt: OwnHarness.PromptID,
    parts: ReadonlyArray<OwnHarness.PromptPart>,
    tools: ReadonlyArray<OwnHarness.PromptTool> = [],
  ) => ({ prompt, parts, tools }) as unknown as OwnHarness.PromptPreview

  const left = preview(
    "reference",
    [
      part("base", "Intro.\nYou are in the Codex CLI.\nMiddle.\nUse plain text.\nEnd.\n"),
      part("permissions", "Codex sandbox text."),
      part("environment", "<cwd>C:\\w</cwd>"),
      part("time", "Time: 2026-10-24T09:30:05+09:00[Asia/Seoul]\nZone: unavailable."),
    ],
    [
      { name: "exec_command", description: "Runs a command. Sandbox marks denials." },
      { name: "read", description: "Reads a file." },
    ],
  )
  const right = preview(
    "own",
    [
      part("base", "Intro.\nYou are in own.\nMiddle.\nUse Markdown.\nEnd.\n"),
      part("identity", "# Your Model\n- Name: X"),
      part("permissions", "Approval mode: ask."),
      part("environment", "<cwd>C:\\w</cwd>"),
      part("time", "Time: 2026-10-24T09:30:06+09:00[Asia/Seoul]\nZone: Asia/Seoul."),
    ],
    [
      { name: "exec_command", description: "Runs a command." },
      { name: "read", description: "Reads a file." },
    ],
  )
  const changes = [
    change({ id: "x.where", before: "You are in the Codex CLI.", after: "You are in own." }),
    change({ id: "x.format", before: "Use plain text.", after: "Use Markdown." }),
    change({ id: "x.identity", part: "identity", after: "# Your Model\n- Name: X" }),
    // Its texts are not found as they are: it goes by its part.
    change({ id: "x.permissions", part: "permissions", before: "(not quoted)", after: "(not quoted)" }),
    change({ id: "x.zone", part: "environment", before: "Zone: unavailable.", after: "Zone: Asia/Seoul." }),
    change({ id: "x.sandbox", part: "tools", before: " Sandbox marks denials." }),
    change({ id: "x.catalog", part: "catalog" }),
    change({ id: "x.escalation", part: "tools", before: "sandbox_permissions" }),
  ]
  const result = comparePreviews(left, right, changes)

  test("parts pair by kind in order; a part on one side only stands alone", () => {
    expect(result.parts.map((row) => [row.key, row.left !== undefined, row.right !== undefined, row.same])).toEqual([
      ["base#0", true, true, false],
      ["identity#0", false, true, false],
      ["permissions#0", true, true, false],
      ["environment#0", true, true, true],
      ["time#0", true, true, false],
    ])
    expect(result.tools.map((row) => [row.tool, row.same])).toEqual([
      ["exec_command", false],
      ["read", true],
    ])
  })

  test("each change sits under the run that shows it; the others are listed apart", () => {
    const notes = (rows: typeof result.parts) =>
      rows.map((row) => [
        row.key,
        row.segments.flatMap((segment) => (segment.kind === "change" ? [segment.notes.map((note) => note.id)] : [])),
      ])
    expect(notes(result.parts)).toEqual([
      ["base#0", [["x.where"], ["x.format"]]],
      ["identity#0", [["x.identity"]]],
      ["permissions#0", [["x.permissions"]]],
      ["environment#0", []],
      ["time#0", [["x.zone"]]],
    ])
    expect(notes(result.tools)).toEqual([
      ["tool:exec_command", [["x.sandbox"]]],
      ["tool:read", []],
    ])
    expect(result.elsewhere.map((item) => item.id)).toEqual(["x.catalog", "x.escalation"])
  })

  test("each preview's clock reading is one reading: only the zone line differs", () => {
    const time = result.parts.find((row) => row.kind === "time")!
    expect(time.right).toBe("Time: 2026-10-24T09:30:05+09:00[Asia/Seoul]\nZone: Asia/Seoul.")
    expect(time.segments[0]).toEqual({ kind: "same", text: "Time: 2026-10-24T09:30:05+09:00[Asia/Seoul]", line: 1 })
    // Two short lines with little in common: each is marked whole.
    expect(marks(time.segments)).toEqual([{ left: ["Zone: unavailable."], right: ["Zone: Asia/Seoul."] }])
  })

  test("tools pair by name even in another order; a part on one side only is the only one-sided row", () => {
    const tools = (names: ReadonlyArray<string>) => names.map((name) => ({ name, description: `${name}.` }))
    const reordered = comparePreviews(
      preview("reference", [part("base", "a")], tools(["read", "exec_command", "gone"])),
      preview("own", [part("identity", "x"), part("base", "a")], tools(["exec_command", "new", "read"])),
      [],
    )
    expect(reordered.tools.map((row) => [row.tool, row.left !== undefined, row.right !== undefined, row.same])).toEqual(
      [
        ["exec_command", true, true, true],
        ["new", false, true, false],
        ["read", true, true, true],
        ["gone", true, false, false],
      ],
    )
    expect(reordered.parts.map((row) => [row.key, row.left !== undefined, row.right !== undefined])).toEqual([
      ["identity#0", false, true],
      ["base#0", true, true],
    ])
  })

  test("between 개선판 and 내 지시문 nothing is attributed", () => {
    const custom = comparePreviews(right, { ...right, prompt: "custom" } as OwnHarness.PromptPreview, [])
    expect(custom.parts.every((row) => row.same)).toBe(true)
    expect(custom.elsewhere).toEqual([])
  })
})

describe("fold", () => {
  const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")

  test("keeps three lines next to each change and hides the rest", () => {
    expect(fold(text, "middle")).toMatchObject({
      count: 6,
      head: "line 1\nline 2\nline 3",
      tail: "line 10\nline 11\nline 12",
    })
    expect(fold(text, "start")).toMatchObject({ count: 9, head: "", tail: "line 10\nline 11\nline 12" })
    expect(fold(text, "end")).toMatchObject({ count: 9, head: "line 1\nline 2\nline 3", tail: "" })
    expect(fold(text, "middle").hidden.split("\n")).toEqual([
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
    ])
  })

  test("a short stretch is not folded", () => {
    const short = "a\nb\nc\nd\ne\nf\ng\nh"
    expect(fold(short, "middle")).toEqual({ head: short, hidden: "", count: 0, tail: "", first: 0 })
    expect(fold("a\nb\nc", "start")).toEqual({ head: "a\nb\nc", hidden: "", count: 0, tail: "", first: 0 })
  })

  test("a fold is named by the lines it hides, which stay put when the change before them is reworded", () => {
    // The page keys a fold's open state by its part and these lines (the left side's), so an approval mode that
    // rewords a change above keeps it open; the stretches carry their first line for that.
    const body = Array.from({ length: 12 }, (_, index) => `body ${index + 1}`)
    const left = ["Approval mode: ask.", ...body, "end"].join("\n")
    const hidden = (right: string) =>
      diffText(left, right).flatMap((segment) => {
        if (segment.kind !== "same") return []
        const folded = fold(segment.text, "middle")
        return folded.count === 0 ? [] : [[segment.line + folded.first, folded.count]]
      })
    const full = hidden(["Approval mode: full, nothing asked.", ...body, "the end"].join("\n"))
    expect(full).toEqual([[5, 6]])
    expect(hidden(["Approval mode: read-only.", ...body, "the end"].join("\n"))).toEqual(full)
    expect(fold(body.join("\n"), "middle").first).toBe(3)
  })
})

describe("change notes", () => {
  test("the small line is the reason's first sentence", () => {
    expect(firstSentence("Codex CLI가 아니라 이 앱이에요. 사용자는 앱에서 봐요.")).toBe(
      "Codex CLI가 아니라 이 앱이에요.",
    )
    expect(firstSentence("Claude Opus 4.8 이후에 맞아요. 줄어요.")).toBe("Claude Opus 4.8 이후에 맞아요.")
    expect(firstSentence("마침표 없이")).toBe("마침표 없이")
  })

  test("`자세히` opens the manual's entry: the anchor own-harness writes into 10.13", () => {
    expect(changeAnchor("codex.base.where")).toBe("pc-codex-base-where")
    const page = path.join(import.meta.dir, "../../../../own/docs/manual/own-open-code-manual.html")
    if (!existsSync(page)) return
    expect(readFileSync(page, "utf8").includes(`id="${changeAnchor("codex.base.where")}"`)).toBe(true)
  })
})

describe("groupSame", () => {
  test("same rows in a row fold into one entry; a lone same row and changed rows stand alone", () => {
    const row = (key: string, same: boolean) => ({ key, same, segments: [] })
    const groups = groupSame([row("a", true), row("b", true), row("c", false), row("d", true), row("e", false)])
    expect(groups.map((group) => [group.same, group.rows.map((item) => item.key)])).toEqual([
      [true, ["a", "b"]],
      [false, ["c"]],
      [true, ["d"]],
      [false, ["e"]],
    ])
  })
})

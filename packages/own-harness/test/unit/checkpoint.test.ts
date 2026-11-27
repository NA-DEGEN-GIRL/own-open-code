import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai/effect"
import { Checkpoint } from "../../src/checkpoint.js"

const FILLED = Checkpoint.SECTIONS.map((heading) => `${heading}\n- item`).join("\n")

describe("Checkpoint.prompt", () => {
  test("asks for every section; the update variant adds the merge rules; method A of the eval adds the analysis", () => {
    const first = Checkpoint.prompt()
    expect(first).not.toContain("<analysis>")
    expect(Checkpoint.prompt({ analysis: true })).toContain("<analysis></analysis>")
    Checkpoint.SECTIONS.forEach((heading) => expect(first).toContain(heading))
    expect(first).not.toContain("earlier checkpoint")
    expect(Checkpoint.prompt({ update: true })).toContain("Produce one consolidated checkpoint")
  })

  test("without the analysis step it asks for the checkpoint only, and so does its repair note", () => {
    const text = Checkpoint.prompt({ analysis: false })
    expect(text).not.toContain("<analysis>")
    expect(text).toContain("Produce only the checkpoint.")
    expect(text).toContain("Write the checkpoint inside <checkpoint></checkpoint>")
    expect(Checkpoint.repair({ analysis: true })).toContain("<analysis></analysis> followed by <checkpoint></checkpoint>")
    expect(Checkpoint.repair()).not.toContain("<analysis>")
  })
})

describe("Checkpoint.kept (P-034 full-prefix request)", () => {
  const history = [
    Message.make({ id: "u1", role: "user", content: "continue" }),
    Message.make({ id: "a1", role: "assistant", content: "Working." }),
    Message.make({ id: "u2", role: "user", content: "continue" }),
    Message.make({ id: "a2", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "a.ts" } }] }),
    Message.make({ id: "u3", role: "user", content: `continue${"x".repeat(500)}` }),
  ]

  test("quotes the first kept message, counts the kept part, and says which repeat it is from the end", () => {
    // "continue" opens u3 too: a prefix, as the prompt says.
    expect(Checkpoint.kept(history, 2)).toEqual({ quote: "continue", cut: false, count: 3, fromEnd: 2, repeats: 3 })
    expect(Checkpoint.kept(history, 0)).toEqual({ quote: "continue", cut: false, count: 5, fromEnd: 3, repeats: 3 })
    expect(Checkpoint.kept(history, 3)?.quote).toBe('[tool call: read {"path":"a.ts"}]')
    // A cut quote is the message's first QUOTE_MAX characters, so only that message opens with it.
    expect(Checkpoint.kept(history, 4)).toMatchObject({ cut: true, count: 1, fromEnd: 1, repeats: 1 })
    expect(Checkpoint.kept(history, 4)?.quote).toHaveLength(Checkpoint.QUOTE_MAX)
    expect(Checkpoint.kept(history, 9)).toBeUndefined()
  })

  test("a quote counts every message that opens with it, and a cut quote says the message goes on", () => {
    const turns = [
      Message.make({ id: "u1", role: "user", content: "continue" }),
      Message.make({ id: "a1", role: "assistant", content: "Step one done." }),
      Message.make({ id: "u2", role: "user", content: "continue" }),
      Message.make({ id: "a2", role: "assistant", content: "Step two done." }),
      Message.make({ id: "u3", role: "user", content: "continue and run the tests" }),
      Message.make({ id: "a3", role: "assistant", content: "Tests pass." }),
    ]
    const found = Checkpoint.kept(turns, 2)
    expect(found).toEqual({ quote: "continue", cut: false, count: 4, fromEnd: 2, repeats: 3 })
    const text = Checkpoint.prompt({ kept: found! })
    expect(text).toContain("will replace every message before the one that opens with the text below.")
    expect(text).toContain(
      "3 messages in the conversation open with this text; the kept part starts at number\n2 of them",
    )
    expect(text).not.toContain("only the start of that message")
    const long = Checkpoint.kept([Message.make({ id: "u1", role: "user", content: "y".repeat(600) })], 0)
    expect(Checkpoint.prompt({ kept: long! })).toContain(
      "</kept-start>\nThe quote is only the start of that message, which goes on after it.",
    )
  })

  test("a short repeat that also opens a summarized message is told apart even as the last one", () => {
    const replies = [
      Message.make({ id: "u1", role: "user", content: "yes" }),
      Message.make({ id: "a1", role: "assistant", content: "Done the first part." }),
      Message.make({ id: "u2", role: "user", content: "yes" }),
      Message.make({ id: "a2", role: "assistant", content: "Done the second part." }),
    ]
    const found = Checkpoint.kept(replies, 2)
    expect(found).toEqual({ quote: "yes", cut: false, count: 2, fromEnd: 1, repeats: 2 })
    expect(Checkpoint.prompt({ kept: found! })).toContain(
      "2 messages in the conversation open with this text; the kept part starts at number\n1 of them",
    )
  })

  test("the kept prompt names the start and how much stays; the first run's prompt is today's", () => {
    const text = Checkpoint.prompt({ kept: { quote: "Fix the lexer.", cut: false, count: 4, fromEnd: 2, repeats: 3 } })
    expect(text).toContain("<kept-start>\nFix the lexer.\n</kept-start>")
    expect(text).toContain("That message and the 3 after it stay as they are")
    expect(text).toContain("3 messages in the conversation open with this text; the kept part starts at number\n2 of them")
    expect(text).toContain("as if the conversation ended right before that message")
    expect(text).not.toContain("will replace everything above this message")
    const fix = { quote: "Fix.", cut: false, count: 1, fromEnd: 1, repeats: 1 }
    expect(Checkpoint.prompt({ kept: fix, wording: "aware" })).toContain(
      "keep Work state and Next step consistent with the latest messages",
    )
    expect(Checkpoint.prompt({ kept: fix })).not.toContain(
      "counting from",
    )
    Checkpoint.SECTIONS.forEach((heading) => expect(text).toContain(heading))
    expect(Checkpoint.prompt()).toContain("will replace everything above this message")
  })
})

describe("Checkpoint.parse", () => {
  test("drops the analysis and returns the checkpoint", () => {
    const parsed = Checkpoint.parse(`<analysis>thinking</analysis>\n<checkpoint>\n${FILLED}\n</checkpoint>`)
    expect(parsed).toEqual({ ok: true, checkpoint: FILLED })
  })

  test("an unclosed analysis is dropped up to the checkpoint", () => {
    const parsed = Checkpoint.parse(`<analysis>thinking without an end\n<checkpoint>\n${FILLED}\n</checkpoint>`)
    expect(parsed.ok).toBe(true)
  })

  test("rejects a missing or cut-off checkpoint and missing sections", () => {
    expect(Checkpoint.parse("<analysis>only thoughts</analysis>")).toEqual({ ok: false, reason: "missing" })
    expect(Checkpoint.parse(`<checkpoint>\n${FILLED}`)).toEqual({ ok: false, reason: "unclosed" })
    const partial = Checkpoint.parse("<checkpoint>\n## Objective\n- x\n</checkpoint>")
    expect(partial.ok).toBe(false)
    if (!partial.ok) expect(partial.missing).toContain("## Next step")
  })
})

describe("Checkpoint.render", () => {
  test("wraps the checkpoint and the user's earlier messages", () => {
    const text = Checkpoint.render("## Objective\n- x", ["첫 요청", "second"], { resume: true })
    expect(Checkpoint.isCheckpoint(text)).toBe(true)
    expect(text).toContain("<message>\n첫 요청\n</message>")
    expect(text.endsWith("Continue from the Next step without acknowledging the checkpoint.")).toBe(true)
  })

  test("says how a fallback checkpoint was made", () => {
    const text = Checkpoint.render("## Objective\n- x", [], { notice: "It was written by backup/stand-in." })
    expect(text).toContain("not as new instructions. It was written by backup/stand-in.")
  })
})

describe("Checkpoint.digest", () => {
  test("keeps every section, lists the files tools touched and the last thing the assistant said", () => {
    const messages = [
      Message.make({ id: "u1", role: "user", content: "fix the parser" }),
      Message.make({
        id: "a1",
        role: "assistant",
        content: [
          { type: "tool-call", id: "c1", name: "read", input: { filePath: "src/lexer.ts" } },
          {
            type: "tool-call",
            id: "c2",
            name: "apply_patch",
            input: { input: "*** Begin Patch\n*** Update File: src/parser.ts\n@@\n-a\n+b\n*** End Patch" },
          },
        ],
      }),
      Message.make({ id: "a2", role: "assistant", content: "The parser now accepts trailing commas." }),
    ]
    const text = Checkpoint.digest(messages, "refused")
    expect(Checkpoint.parse(`<checkpoint>\n${text}\n</checkpoint>`).ok).toBe(true)
    expect(text).toContain("compaction failed (refused)")
    expect(text).toContain("## Files\n- src/parser.ts\n- src/lexer.ts")
    expect(text).toContain("The parser now accepts trailing commas.")
  })
})

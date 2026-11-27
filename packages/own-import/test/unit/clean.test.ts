import { describe, expect, test } from "bun:test"
import { Clean } from "../../src/transcript/clean.js"
import { harnessSummary, rewordedSummary, SUMMARY_BODY } from "../fixtures/claude.js"

const TRANSCRIPT = "C:\\Users\\fixture\\.claude\\projects\\C--work-proj\\0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d01.jsonl"

describe("Clean.summary: Claude Code's compact-summary harness (09 §2.6)", () => {
  test("the opener, the transcript line and the instruction go; the summary stays", () => {
    expect(Clean.summary(harnessSummary(SUMMARY_BODY, TRANSCRIPT))).toEqual({ text: SUMMARY_BODY, unmatched: 0 })
  })

  test("slightly reworded phrases still match by keywords", () => {
    const cleaned = Clean.summary(rewordedSummary(SUMMARY_BODY, "/home/fixture/.claude/projects/-home-fixture/x.jsonl"))
    expect(cleaned).toEqual({ text: SUMMARY_BODY, unmatched: 0 })
  })

  test("the model never gets the path to the original transcript or the instruction to go on alone", () => {
    const cleaned = Clean.summary(harnessSummary(SUMMARY_BODY, TRANSCRIPT))
    expect(cleaned.text).not.toContain(".claude")
    expect(cleaned.text).not.toMatch(/without asking/i)
  })

  test("a separate '…summarized below:' line after the opener goes with it; CRLF is read", () => {
    const input = [
      "This session is being continued from a previous conversation that ran out of context.",
      "The conversation is summarized below:",
      SUMMARY_BODY,
      `If you need details, read the full transcript at: ${TRANSCRIPT}`,
      "Please continue the conversation from where we left it off without asking the user any further questions.",
    ].join("\r\n")
    expect(Clean.summary(input)).toEqual({ text: SUMMARY_BODY, unmatched: 0 })
  })

  test("a phrase that is not found is counted and nothing else is removed", () => {
    const older = [
      "This session is being continued from a previous conversation that ran out of context.",
      SUMMARY_BODY,
      "Please continue the conversation from where we left it off without asking the user any further questions.",
    ].join("\n")
    expect(Clean.summary(older)).toEqual({ text: SUMMARY_BODY, unmatched: 1 })
    expect(Clean.summary("Summary: the user fixed the installer.")).toEqual({
      text: "Summary: the user fixed the installer.",
      unmatched: 3,
    })
  })

  test("a sentence of the summary itself is never taken for a phrase: only the edges are searched", () => {
    const body = [
      "Summary:",
      "1. The user said: continue the previous session's refactor.",
      "2. The user said to continue without asking about formatting.",
      "3. The full transcript of the build log was attached.",
      "4. a",
      "5. b",
      "6. c",
      "7. d",
      "8. e",
    ].join("\n")
    const cleaned = Clean.summary(harnessSummary(body, TRANSCRIPT))
    expect(cleaned).toEqual({ text: body, unmatched: 0 })
  })
})

describe("Clean.human: harness wrappers around the human's words (09 §2.6)", () => {
  test("system reminders, IDE context and local command output go with their content", () => {
    const input = [
      "<ide_opened_file>The user opened a.ts</ide_opened_file>",
      "<ide_selection>lines 1-2</ide_selection>",
      "fix this",
      "",
      "<system-reminder>Remember the todo list.\nTwo lines.</system-reminder>",
      "",
      "",
      "and that",
      "<local-command-stdout>Set model</local-command-stdout><local-command-caveat>Caveat</local-command-caveat>",
    ].join("\n")
    expect(Clean.human(input)).toEqual({
      text: "fix this\n\nand that",
      notes: [],
      command: undefined,
      interrupted: false,
      stripped: 5,
    })
  })

  test("a slash command becomes `/name args`", () => {
    expect(
      Clean.human(
        "<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>the parser</command-args>",
      ),
    ).toEqual({ text: "", notes: [], command: "/review the parser", interrupted: false, stripped: 3 })
    expect(Clean.human("<command-name>compact</command-name><command-args></command-args>").command).toBe("/compact")
  })

  test("a task notification becomes a one-line note: its summary, else its text", () => {
    const said = Clean.human(
      '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "bun test" completed</summary>\n</task-notification>',
    )
    expect(said).toEqual({
      text: "",
      notes: ['Background command "bun test" completed'],
      command: undefined,
      interrupted: false,
      stripped: 0,
    })
    expect(Clean.notification("<task-id>b2</task-id>\n<status>failed</status>")).toBe("b2 failed")
  })

  test("the interrupt marker is not the human's words", () => {
    expect(Clean.human("[Request interrupted by user]")).toMatchObject({ text: "", interrupted: true })
    expect(Clean.human("[Request interrupted by user for tool use]")).toMatchObject({ text: "", interrupted: true })
    expect(Clean.human("why was the [Request interrupted by user] shown?")).toMatchObject({ interrupted: false })
  })

  test("an unclosed or unknown tag stays", () => {
    expect(Clean.human("<system-reminder>never closed").text).toBe("<system-reminder>never closed")
    expect(Clean.human("<goal>ship it</goal>").text).toBe("<goal>ship it</goal>")
  })
})

describe("Clean.oneLine", () => {
  test("whitespace runs become one space, long text is cut with an ellipsis", () => {
    expect(Clean.oneLine("  a\n\tb  c ", 120)).toBe("a b c")
    expect(Clean.oneLine("x".repeat(130), 120)).toBe(`${"x".repeat(120)}…`)
    expect(Clean.oneLine(`${"y".repeat(119)} z`, 120)).toBe(`${"y".repeat(119)}…`)
  })

  test("code points, not UTF-16 units: a surrogate pair and Hangul are never split", () => {
    const emoji = "😀".repeat(5)
    expect(Clean.oneLine(emoji, 3)).toBe("😀😀😀…")
    expect(Clean.oneLine("한글 제목입니다", 4)).toBe("한글 제…")
  })
})

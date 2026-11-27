// Line comments for the next prompt (03 §19.1): the per-session store (add/update/take/restore, focus), the parts a
// send gets (note lines in upstream's format, file parts with line ranges, metadata for the comment cards) and the
// message presentation read back from them.
import { describe, expect, test } from "bun:test"
import type { SessionMessageUser } from "@opencode/client"
import { promptParts, type PromptParts } from "@/attachments/model"
import { LOCAL } from "@/data"
import { commentLines, onRemovedLines, reviewComments, withCommentPresentation, withReviewComments } from "./comments"
import { parseCommentNote, readPromptPresentation } from "./vendor/comment-note"

describe("store", () => {
  test("per session: add focuses the new comment, update, take empties, restore puts back in front", () => {
    const first = reviewComments.add(LOCAL, "ses_a", {
      file: "src/a.ts",
      selection: { start: 12, end: 10, side: "additions" },
      comment: "이름을 바꿔 주세요",
    })
    const second = reviewComments.add(LOCAL, "ses_a", {
      file: "src/b.ts",
      selection: { start: 3, end: 3 },
      comment: "check",
    })
    expect(reviewComments.list(LOCAL, "ses_b")).toEqual([])
    expect(reviewComments.list(LOCAL, "ses_a").map((item) => item.id)).toEqual([first.id, second.id])
    expect(reviewComments.focus(LOCAL, "ses_a")).toEqual({ file: "src/b.ts", id: second.id })
    expect(reviewComments.focus(LOCAL, "ses_b")).toBeUndefined()

    reviewComments.update(LOCAL, "ses_a", first.id, "고쳐 주세요")
    expect(reviewComments.list(LOCAL, "ses_a")[0]?.comment).toBe("고쳐 주세요")

    const taken = reviewComments.take(LOCAL, "ses_a")
    expect(taken).toHaveLength(2)
    expect(reviewComments.list(LOCAL, "ses_a")).toEqual([])
    const later = reviewComments.add(LOCAL, "ses_a", { file: "c.ts", selection: { start: 1, end: 1 }, comment: "x" })
    reviewComments.restore(LOCAL, "ses_a", taken)
    expect(reviewComments.list(LOCAL, "ses_a").map((item) => item.id)).toEqual([first.id, second.id, later.id])

    reviewComments.remove(LOCAL, "ses_a", later.id)
    reviewComments.setFocus(LOCAL, "ses_a", null)
    expect(reviewComments.focus(LOCAL, "ses_a")).toBeUndefined()
    reviewComments.take(LOCAL, "ses_a")
  })

  test("line labels and removed-line selections", () => {
    expect(commentLines({ start: 12, end: 10 })).toBe("10-12")
    expect(commentLines({ start: 4, end: 4 })).toBe("4")
    expect(onRemovedLines({ start: 1, end: 2, side: "deletions" })).toBe(true)
    expect(onRemovedLines({ start: 1, end: 2, side: "deletions", endSide: "additions" })).toBe(false)
  })
})

describe("sending", () => {
  const comments = [
    {
      id: "c1",
      file: "src/라우터.ts",
      selection: { start: 12, end: 10, side: "additions" as const },
      comment: "이 분기를 합쳐 주세요",
      preview: "if (a) {",
      root: "C:\\work\\repo",
      time: 1,
    },
    {
      id: "c2",
      file: "src/old.ts",
      selection: { start: 5, end: 5, side: "deletions" as const },
      comment: "왜 지웠나요?",
      root: "C:\\work\\repo",
      time: 2,
    },
    { id: "c3", file: "b.ts", selection: { start: 1, end: 2 }, comment: "no root", time: 3 },
  ]

  test("note lines after the text, file parts for current lines with a known root, metadata for the cards", () => {
    const parts = withReviewComments(
      {
        text: "고쳐 주세요\nAttached file: `C:/tmp/x.png`",
        files: [{ uri: "data:image/png;base64,AA", name: "x.png" }],
        metadata: {
          displayText: "고쳐 주세요",
          comments: [],
          attachments: [{ name: "x.png", mime: "image/png", path: "C:/tmp/x.png" }],
        },
      },
      { typed: "고쳐 주세요", comments },
    )
    expect(parts.text.split("\n")).toEqual([
      "고쳐 주세요",
      "Attached file: `C:/tmp/x.png`",
      "The user made the following comment regarding lines 10 through 12 of src/라우터.ts: 이 분기를 합쳐 주세요",
      "The user made the following comment regarding line 5 of src/old.ts: 왜 지웠나요?",
      "The user made the following comment regarding lines 1 through 2 of b.ts: no root",
    ])
    // Removed lines and comments without a known repository root get no file part.
    expect(parts.files).toEqual([
      { uri: "data:image/png;base64,AA", name: "x.png" },
      { uri: "file:///C:/work/repo/src/%EB%9D%BC%EC%9A%B0%ED%84%B0.ts?start=10&end=12", name: "라우터.ts#L10-12" },
    ])
    const presentation = readPromptPresentation(parts.metadata)
    expect(presentation?.displayText).toBe("고쳐 주세요")
    expect(presentation?.attachments).toEqual([{ name: "x.png", mime: "image/png", path: "C:/tmp/x.png" }])
    expect(presentation?.comments[0]).toEqual({
      path: "src/라우터.ts",
      comment: "이 분기를 합쳐 주세요",
      selection: { startLine: 10, startChar: 0, endLine: 12, endChar: 0 },
      preview: "if (a) {",
      origin: "review",
    })
    expect(parseCommentNote(parts.text.split("\n")[3]!)?.path).toBe("src/old.ts")
  })

  test("fits the attachment store's parts both ways (the composer's send path)", () => {
    const prepared: PromptParts = promptParts("hi", [
      { kind: "path", name: "a.txt", mime: "text/plain", path: "/tmp/a.txt" },
    ])
    const parts: PromptParts = withReviewComments(prepared, { typed: "hi", comments: comments.slice(2) })
    expect(parts.text.split("\n")).toEqual([
      "hi",
      "Attached file: `/tmp/a.txt`",
      "The user made the following comment regarding lines 1 through 2 of b.ts: no root",
    ])
    expect(readPromptPresentation(parts.metadata)?.attachments).toEqual([
      { name: "a.txt", mime: "text/plain", path: "/tmp/a.txt" },
    ])
  })

  test("comments only (nothing typed) and no comments", () => {
    const only = withReviewComments({ text: "", files: [] }, { typed: "", comments: comments.slice(2) })
    expect(only.text).toBe("The user made the following comment regarding lines 1 through 2 of b.ts: no root")
    expect(only.metadata?.displayText).toBe("")
    const none = { text: "hi", files: [] }
    expect(withReviewComments(none, { typed: "hi", comments: [] })).toBe(none)
  })

  test("presentation: comment cards from the metadata, the typed text kept; a lone note line parsed", () => {
    const parts = withReviewComments({ text: "hi", files: [] }, { typed: "hi", comments: comments.slice(0, 1) })
    const message = { text: parts.text, metadata: parts.metadata } as Pick<SessionMessageUser, "text" | "metadata">
    expect(withCommentPresentation(message, { displayText: "hi", references: [] })).toEqual({
      displayText: "hi",
      references: [],
      comments: [
        { path: "src/라우터.ts", comment: "이 분기를 합쳐 주세요", selection: { startLine: 10, endLine: 12 } },
      ],
    })
    const note = { text: "The user made the following comment regarding line 3 of a.ts: ok", metadata: undefined }
    expect(withCommentPresentation(note, undefined)?.comments).toEqual([
      { path: "a.ts", comment: "ok", selection: { startLine: 3, endLine: 3 } },
    ])
    expect(withCommentPresentation({ text: "plain", metadata: undefined }, undefined)).toBeUndefined()
  })
})

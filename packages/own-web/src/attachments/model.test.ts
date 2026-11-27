// Attachment pipeline decisions (03 §18.10): routes (reject / inline / native path / upload), mime sniffing, the
// upload target, prompt assembly and restoring a message's attachments, and the image token constant pinned to core.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { SessionMessageUser } from "@opencode/client"
import { restoredText, storeRestore, takeRestore } from "./intents"
import {
  attachmentMime,
  draftFrom,
  formatSize,
  IMAGE_TOKEN_ESTIMATE,
  MAX_FILE_BYTES,
  MAX_INLINE_BYTES,
  modelInput,
  promptParts,
  readmitFiles,
  routeFor,
  uploadPath,
} from "./model"

const vision = { image: true, pdf: false }
const text = { image: false, pdf: false }

describe("routeFor", () => {
  test("more than 25 MiB is refused (own.attach.tooLarge)", () => {
    expect(routeFor({ size: MAX_FILE_BYTES + 1, mime: "text/plain", input: vision, local: true })).toEqual({
      kind: "reject",
      reason: "tooLarge",
    })
  })

  test("images the model reads go inline up to the inline limit, then by path", () => {
    expect(routeFor({ size: 200_000, mime: "image/png", input: vision, local: false })).toEqual({ kind: "inline" })
    expect(routeFor({ size: MAX_INLINE_BYTES + 1, mime: "image/png", input: vision, local: false })).toEqual({
      kind: "upload",
      imageFallback: false,
    })
  })

  test("an image the model cannot read goes as a path and says so (own.attach.noImageModel)", () => {
    expect(routeFor({ size: 10, mime: "image/jpeg", input: text, local: false })).toEqual({
      kind: "upload",
      imageFallback: true,
    })
  })

  test("a local server with a native path sends the path; otherwise the file is uploaded", () => {
    const file = { size: 10, mime: "text/plain", input: vision }
    expect(routeFor({ ...file, local: true, nativePath: "C:\\work\\#notes\\a.txt" })).toEqual({
      kind: "path",
      path: "C:\\work\\#notes\\a.txt",
      imageFallback: false,
    })
    // A remote server cannot open this PC's path (04 §12), and pasted files have none.
    expect(routeFor({ ...file, local: false, nativePath: "C:\\work\\a.txt" })).toMatchObject({ kind: "upload" })
    expect(routeFor({ ...file, local: true, nativePath: null })).toMatchObject({ kind: "upload" })
  })

  test("modelInput reads the catalog capabilities; unknown models read text only", () => {
    expect(modelInput({ input: ["text", "image"] })).toEqual({ image: true, pdf: false })
    expect(modelInput({ input: ["text", "image", "pdf"] })).toEqual({ image: true, pdf: true })
    expect(modelInput(undefined)).toEqual({ image: false, pdf: false })
  })
})

describe("attachmentMime", () => {
  const bytes = (value: string) => new TextEncoder().encode(value)
  test("images and PDFs keep their type, also from the extension when the browser left it empty", () => {
    expect(attachmentMime("a.png", "image/png", new Uint8Array())).toBe("image/png")
    expect(attachmentMime("shot.JPG", "", new Uint8Array([0xff, 0xd8]))).toBe("image/jpeg")
    expect(attachmentMime("spec.pdf", "application/octet-stream", new Uint8Array([0x25]))).toBe("application/pdf")
  })
  test("text-like types and text-looking bytes become text/plain; binary stays binary", () => {
    expect(attachmentMime("a.json", "application/json", bytes("{}"))).toBe("text/plain")
    expect(attachmentMime("notes", "", bytes("한글 메모\n두 번째 줄"))).toBe("text/plain")
    expect(attachmentMime("blob.bin", "application/octet-stream", new Uint8Array([1, 0, 2]))).toBe(
      "application/octet-stream",
    )
  })
})

test("uploadPath keeps the name inside its own upload directory", () => {
  expect(uploadPath("C:\\Temp\\oc\\", "u1", "보고서 #1.pdf")).toBe("C:\\Temp\\oc/uploads/u1/보고서 #1.pdf")
  expect(uploadPath("/tmp/oc", "u2", "../../etc/passwd")).toBe("/tmp/oc/uploads/u2/.._.._etc_passwd")
  expect(uploadPath("/tmp/oc", "u3", "..")).toBe("/tmp/oc/uploads/u3/_")
})

test("formatSize", () => {
  expect(formatSize(512)).toBe("512B")
  expect(formatSize(212 * 1024)).toBe("212KB")
  expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4MB")
  expect(formatSize(MAX_FILE_BYTES)).toBe("25MB")
})

describe("promptParts", () => {
  test("no attachments: the text as typed", () => {
    expect(promptParts("안녕", [])).toEqual({ text: "안녕", files: [] })
  })
  test("paths become `Attached file:` lines and metadata; inline media go as files", () => {
    const parts = promptParts("이 로그 봐줘", [
      { kind: "path", name: "a.log", mime: "text/plain", path: "/tmp/oc/uploads/u1/a.log" },
      { kind: "inline", name: "shot.png", mime: "image/png", uri: "data:image/png;base64,AAAA" },
    ])
    expect(parts.text).toBe("이 로그 봐줘\nAttached file: `/tmp/oc/uploads/u1/a.log`")
    expect(parts.files).toEqual([{ uri: "data:image/png;base64,AAAA", name: "shot.png" }])
    expect(parts.metadata).toEqual({
      displayText: "이 로그 봐줘",
      comments: [],
      attachments: [{ name: "a.log", mime: "text/plain", path: "/tmp/oc/uploads/u1/a.log" }],
    })
  })
  test("attachments without text send only the references", () => {
    expect(promptParts("  ", [{ kind: "path", name: "a", mime: "text/plain", path: "/p/a" }]).text).toBe(
      "Attached file: `/p/a`",
    )
  })
})

describe("draftFrom (revert and queue edit restore)", () => {
  test("typed text and composer attachments come back; mentions stay out", () => {
    const message: Pick<SessionMessageUser, "text" | "files" | "metadata"> = {
      text: "이 로그 봐줘\nAttached file: `/p/a.log`",
      metadata: {
        displayText: "이 로그 봐줘",
        comments: [],
        attachments: [{ name: "a.log", mime: "text/plain", path: "/p/a.log" }],
      },
      files: [
        { data: "AAAA", mime: "image/png", source: { type: "inline" }, name: "shot.png" },
        {
          data: "BBBB",
          mime: "text/plain",
          source: { type: "inline" },
          name: "x.ts",
          mention: { start: 0, end: 5, text: "@x.ts" },
        },
      ],
    }
    expect(draftFrom(message)).toEqual({
      text: "이 로그 봐줘",
      attachments: [
        { kind: "inline", name: "shot.png", mime: "image/png", uri: "data:image/png;base64,AAAA" },
        { kind: "path", name: "a.log", mime: "text/plain", path: "/p/a.log" },
      ],
    })
  })
  test("without metadata the reference lines are stripped from the text", () => {
    expect(draftFrom({ text: "hi", files: undefined, metadata: undefined })).toEqual({ text: "hi", attachments: [] })
  })
})

describe("readmitFiles (queue reorder)", () => {
  test("a stored file goes back by the URI it came from; an inline one as data:", () => {
    expect(
      readmitFiles({
        text: "x",
        files: [
          {
            data: "AAAA",
            mime: "text/plain",
            source: { type: "uri", uri: "file:///C:/p/a.ts" },
            name: "a.ts",
            mention: { start: 0, end: 5, text: "@a.ts" },
          },
          { data: "BBBB", mime: "image/png", source: { type: "inline" }, name: "shot.png" },
        ],
      }),
    ).toEqual([
      { uri: "file:///C:/p/a.ts", name: "a.ts", description: undefined, mention: { start: 0, end: 5, text: "@a.ts" } },
      { uri: "data:image/png;base64,BBBB", name: "shot.png", description: undefined, mention: undefined },
    ])
  })
})

describe("restoredText (composer side of own:composer-restore)", () => {
  test("replace wins; fill appends to a non-empty draft", () => {
    expect(restoredText("draft", { text: "old", mode: "replace" })).toBe("old")
    expect(restoredText("", { text: "old", mode: "fill" })).toBe("old")
    expect(restoredText("draft  ", { text: "old", mode: "fill" })).toBe("draft\n\nold")
  })
  test("ifDraft clears only a draft the user has not changed", () => {
    expect(restoredText("old", { text: "", mode: "replace", ifDraft: "old" })).toBe("")
    expect(restoredText("old, edited", { text: "", mode: "replace", ifDraft: "old" })).toBe("old, edited")
  })
})

test("IMAGE_TOKEN_ESTIMATE mirrors core (03 §18.10 검증 항목: core does not export it)", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "../../../core/src/session/compaction.ts")).text()
  const value = source.match(/const IMAGE_TOKEN_ESTIMATE = ([\d_]+)/)?.[1]
  expect(value && Number(value.replaceAll("_", ""))).toBe(IMAGE_TOKEN_ESTIMATE)
})

describe("one restore per request across split panes (03 §4.1.1, 2026-10-16)", () => {
  const detail = () => ({
    serverKey: "local",
    sessionID: "ses_main",
    text: "상의하자",
    attachments: [],
    mode: "fill" as const,
  })

  test("two composers that do not show the conversation store it once, right away", () => {
    const request = detail()
    const writes: string[] = []
    storeRestore(request, () => writes.push("left"))
    storeRestore(request, () => writes.push("right"))
    // Synchronous: `새 대화로 시작` navigates right after the request and the composer loads the stored draft at once.
    expect(writes).toEqual(["left"])
  })

  test("after a pane that shows the conversation took it, no other pane stores it", () => {
    const request = detail()
    const writes: string[] = []
    takeRestore(request)
    storeRestore(request, () => writes.push("stored"))
    expect(writes).toEqual([])
  })
})

// The two note features never share a name (03 §19.10 `대화 메모`, 05 §8.8 the workspace `노트` tab = 프로젝트 노트):
// every conversation-memo string says 메모 and never 노트, every notes-tab string the other way round, and the
// entry points (`⋯` menu, palette, workspace header) name the feature they open.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { translate } from "@/i18n"
import { notesEn, notesKo, notesText, type NotesKey } from "./strings"

const keys = Object.keys(notesKo) as NotesKey[]
/** Neutral words both features use (`다시 시도`, `새 내용 불러오기`). */
const shared = new Set<NotesKey>(["own.notes.retry", "own.notes.reload"])
const memo = keys.filter((key) => !key.startsWith("own.notes.ws.") && !shared.has(key))
const notebook = keys.filter((key) => key.startsWith("own.notes.ws."))

describe("conversation memo and project notes stay apart", () => {
  test("memo strings say 메모, never 노트 (except where the description points to the notes tab)", () => {
    for (const key of memo.filter((key) => key !== "own.notes.describe")) {
      expect(notesKo[key]).not.toContain("노트")
      expect(notesEn[key] ?? "").not.toMatch(/\bnotes?\b/i)
    }
    expect(notesKo["own.notes.dialogTitle"]).toBe("대화 메모")
    expect(notesEn["own.notes.dialogTitle"]).toBe("Conversation memo")
    expect(notesKo["own.notes.title"]).toBe("대화 메모")
    expect(notesKo["own.notes.nextRequest"]).toBe("다음 요청에서 이 메모가 대화 끝에 더해져요")
    expect(notesText.text("ko", "own.notes.describe")).toBe(
      "이 대화에만 붙는 짧은 메모예요. 켜면 모델에게도 보여 줄 수 있어요. 프로젝트 노트는 가운데 ‘노트’ 탭에 있어요.",
    )
  })

  test("notes-tab strings never say 메모", () => {
    for (const key of notebook) expect(notesKo[key]).not.toContain("메모")
    expect(`${notesKo["own.notes.ws.heading"]} · ${notesKo["own.notes.ws.headingPc"]}`).toBe(
      "프로젝트 노트 · 이 PC에 저장되어 어느 기기에서나 같아요",
    )
    expect(notesKo["own.notes.ws.loading"]).toBe("노트를 불러오는 중…")
  })

  test("entry points: `⋯` and the palette open the memo, the palette also has the notes tab", () => {
    expect(translate("ko", "own.header.notes")).toBe("대화 메모")
    expect(translate("ko", "own.palette.p7.notes")).toBe("대화 메모 열기")
    expect(translate("en", "own.palette.p7.notes")).toBe("Open conversation memo")
    expect(translate("ko", "own.palette.p7.projectNotes")).toBe("프로젝트 노트 열기")
  })

  test("the two features carry different icons and the notes tab uses only its own strings", async () => {
    const source = async (file: string) => Bun.file(path.join(import.meta.dir, "..", file)).text()
    expect(await source("notes/panel.tsx")).toContain('<InlineIcon name="memo" />')
    expect(await source("notes/workspace.tsx")).toContain('<InlineIcon name="notebook" />')
    expect(await source("shell/workspace.tsx")).toContain('<InlineIcon name="notebook"')
    const workspace = await source("notes/workspace.tsx")
    const used = [...workspace.matchAll(/"(own\.notes\.[\w.]+)"/g)].map((match) => match[1] as NotesKey)
    expect(used.filter((key) => !key.startsWith("own.notes.ws.") && !shared.has(key))).toEqual([])
  })
})

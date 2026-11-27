// Prompt history (03 §19.9): the list rules, when ↑/↓ may walk it (empty box or caret on the first/last line, never
// during an IME composition, never with modifiers), the draft that comes back on ↓, chips travelling with an entry,
// the persisted store (records made before the load are kept) and draft extras with image bytes as Blobs.
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ImeKeyEvent } from "@/ime/ime-enter"
import { createChipStore, type MentionChip } from "@/mentions"
import { blobFromDataUri, createDraftExtras } from "./drafts"
import { memoryStore } from "./idb"
import { canNavigate, pushEntry, readEntries, step, type HistoryEntry } from "./model"
import { createHistoryNavigator } from "./navigator"
import { signature } from "./persistence"
import { createPromptHistory } from "./store"

type KeyInit = Partial<Omit<ImeKeyEvent, "preventDefault">>

function key(code: string, init: KeyInit = {}) {
  const event = {
    code,
    key: code,
    keyCode: code === "ArrowUp" ? 38 : 40,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    prevented: false,
    ...init,
    preventDefault() {
      event.prevented = true
    },
  }
  return event
}

const skill: MentionChip = { kind: "skill", id: "review-guide", name: "Review guide" }
const file: MentionChip = { kind: "file", path: "src/router.ts" }

describe("history list", () => {
  test("newest first, empty sends skipped, an identical entry moves to the top", () => {
    const one = pushEntry([], { text: "첫 질문", at: 1 })
    expect(one.map((entry) => entry.text)).toEqual(["첫 질문"])
    expect(pushEntry(one, { text: "   ", at: 2 })).toBe(one)
    const two = pushEntry(one, { text: "두 번째", at: 3 })
    expect(pushEntry(two, { text: "두 번째", at: 4 })).toBe(two)
    const moved = pushEntry(two, { text: "첫 질문", at: 5 })
    expect(moved.map((entry) => entry.text)).toEqual(["첫 질문", "두 번째"])
    // Chips make an entry different, and a chips-only send is recorded.
    expect(pushEntry(moved, { text: "", chips: [skill], at: 6 })[0]).toEqual({ text: "", chips: [skill], at: 6 })
    expect(pushEntry(moved, { text: "첫 질문", chips: [file], at: 7 }).length).toBe(3)
  })

  test("at most 100 entries", () => {
    const list = Array.from({ length: 120 }, (_, index) => index).reduce<readonly HistoryEntry[]>(
      (entries, index) => pushEntry(entries, { text: `m${index}`, at: index }),
      [],
    )
    expect(list.length).toBe(100)
    expect(list[0]!.text).toBe("m119")
  })

  test("↑ only on an empty box or the first line, ↓ only while browsing and on the last line", () => {
    expect(canNavigate("up", { text: "", start: 0, end: 0, browsing: false })).toBe(true)
    expect(canNavigate("up", { text: "hello", start: 3, end: 3, browsing: false })).toBe(true)
    expect(canNavigate("up", { text: "a\nb", start: 3, end: 3, browsing: false })).toBe(false)
    expect(canNavigate("up", { text: "a\nb", start: 1, end: 1, browsing: false })).toBe(true)
    expect(canNavigate("up", { text: "hello", start: 0, end: 5, browsing: false })).toBe(false)
    expect(canNavigate("down", { text: "", start: 0, end: 0, browsing: false })).toBe(false)
    expect(canNavigate("down", { text: "a\nb", start: 0, end: 0, browsing: true })).toBe(false)
    expect(canNavigate("down", { text: "a\nb", start: 2, end: 2, browsing: true })).toBe(true)
    expect(step(-1, "up", 2)).toBe(0)
    expect(step(1, "up", 2)).toBeUndefined()
    expect(step(0, "down", 2)).toBe(-1)
    expect(step(-1, "down", 2)).toBeUndefined()
  })

  test("stored records are checked at the boundary", () => {
    expect(readEntries("nope")).toEqual([])
    expect(
      readEntries([
        { text: "ok", at: 1, chips: [skill, { kind: "bogus" }] },
        { text: 3, at: 1 },
        null,
        { text: "no time" },
      ]),
    ).toEqual([{ text: "ok", at: 1, chips: [skill] }])
  })
})

describe("history store", () => {
  test("loads once, merges sends made before the load, writes when flushed", async () => {
    const storage = memoryStore()
    storage.entries.set("normal", [{ text: "저장된 질문", at: 1 }])
    let now = 10
    const history = createRoot(() => createPromptHistory(storage, () => now++))
    history.record("normal", { text: "로드 전에 보낸 질문" })
    history.record("shell", { text: "bun test" })
    await history.load()
    expect(history.entries("normal").map((entry) => entry.text)).toEqual(["로드 전에 보낸 질문", "저장된 질문"])
    expect(history.entries("shell").map((entry) => entry.text)).toEqual(["bun test"])
    await history.flush()
    expect(readEntries(storage.entries.get("normal")).map((entry) => entry.text)).toEqual([
      "로드 전에 보낸 질문",
      "저장된 질문",
    ])
    expect(readEntries(storage.entries.get("shell")).map((entry) => entry.text)).toEqual(["bun test"])
  })
})

describe("history navigator", () => {
  async function setup(entries: { text: string; chips?: MentionChip[] }[]) {
    const storage = memoryStore()
    const history = createRoot(() => createPromptHistory(storage))
    await history.load()
    entries.toReversed().forEach((entry) => history.record("normal", entry))
    const textarea = document.createElement("textarea")
    document.body.append(textarea)
    const chips = createChipStore()
    const changed: string[] = []
    let composing = false
    const navigator = createRoot(() =>
      createHistoryNavigator({
        element: () => textarea,
        history,
        mode: () => "normal",
        composing: () => composing,
        chips,
        draftKey: () => "local/ses_1",
        changed: (text) => changed.push(text),
      }),
    )
    const type = (value: string, caret = value.length) => {
      textarea.value = value
      textarea.setSelectionRange(caret, caret)
    }
    return {
      textarea,
      navigator,
      chips,
      changed,
      type,
      setComposing: (value: boolean) => (composing = value),
    }
  }

  test("↑ walks back from the newest, ↓ returns and restores the draft with its chips", async () => {
    const env = await setup([{ text: "최신 질문", chips: [skill] }, { text: "이전 질문" }])
    env.type("쓰던 글")
    env.chips.add("local/ses_1", file)
    const up = key("ArrowUp")
    expect(env.navigator.keydown(up)).toBe(true)
    expect(up.prevented).toBe(true)
    expect(env.textarea.value).toBe("최신 질문")
    expect(env.textarea.selectionStart).toBe(0)
    expect(env.chips.list("local/ses_1")).toEqual([skill])
    expect(env.navigator.keydown(key("ArrowUp"))).toBe(true)
    expect(env.textarea.value).toBe("이전 질문")
    // Oldest reached: the arrow keeps its caret meaning.
    expect(env.navigator.keydown(key("ArrowUp"))).toBe(false)
    expect(env.navigator.keydown(key("ArrowDown"))).toBe(true)
    expect(env.textarea.value).toBe("최신 질문")
    expect(env.textarea.selectionStart).toBe("최신 질문".length)
    expect(env.navigator.keydown(key("ArrowDown"))).toBe(true)
    expect(env.textarea.value).toBe("쓰던 글")
    expect(env.chips.list("local/ses_1")).toEqual([file])
    expect(env.navigator.browsing()).toBe(false)
    expect(env.navigator.keydown(key("ArrowDown"))).toBe(false)
    expect(env.changed).toEqual(["최신 질문", "이전 질문", "최신 질문", "쓰던 글"])
  })

  test("IME: keys of a composition, modifiers and a caret below the first line are left alone", async () => {
    const env = await setup([{ text: "최신 질문" }])
    env.type("")
    // Chromium: keyCode 229 with isComposing; Safari: 229 without; our own flag.
    expect(env.navigator.keydown(key("ArrowUp", { keyCode: 229, isComposing: true, key: "Process" }))).toBe(false)
    expect(env.navigator.keydown(key("ArrowUp", { keyCode: 229 }))).toBe(false)
    env.setComposing(true)
    expect(env.navigator.keydown(key("ArrowUp"))).toBe(false)
    env.setComposing(false)
    expect(env.navigator.keydown(key("ArrowUp", { altKey: true }))).toBe(false)
    expect(env.navigator.keydown(key("ArrowUp", { ctrlKey: true }))).toBe(false)
    expect(env.navigator.keydown(key("ArrowUp", { shiftKey: true }))).toBe(false)
    env.type("첫 줄\n둘째 줄")
    expect(env.navigator.keydown(key("ArrowUp"))).toBe(false)
    expect(env.textarea.value).toBe("첫 줄\n둘째 줄")
    // A synthetic event without `code` falls back to `key` (03 §10).
    env.type("")
    expect(env.navigator.keydown(key("", { key: "ArrowUp" }))).toBe(true)
    expect(env.textarea.value).toBe("최신 질문")
  })

  test("reset starts again at the newest entry", async () => {
    const env = await setup([{ text: "a" }, { text: "b" }])
    env.type("")
    env.navigator.keydown(key("ArrowUp"))
    env.navigator.keydown(key("ArrowUp"))
    env.navigator.reset()
    env.type("")
    env.navigator.keydown(key("ArrowUp"))
    expect(env.textarea.value).toBe("a")
  })
})

describe("draft extras", () => {
  const png = "data:image/png;base64,iVBORw0KGgo="

  test("inline images are stored as Blobs and come back as data URIs, paths as paths", async () => {
    const storage = memoryStore()
    const extras = createDraftExtras(storage, () => 5)
    extras.save("local/ses_1", {
      chips: [skill],
      attachments: [
        { kind: "inline", name: "shot.png", mime: "image/png", uri: png },
        { kind: "path", name: "notes.txt", mime: "text/plain", path: "/tmp/uploads/1/notes.txt" },
      ],
    })
    await extras.flush()
    const record = storage.entries.get("local/ses_1") as { attachments: { blob?: Blob }[] }
    expect(record.attachments[0]!.blob).toBeInstanceOf(Blob)
    expect(record.attachments[0]!.blob!.type).toBe("image/png")
    expect(record.attachments[0]!.blob!.size).toBe(8)
    const fresh = createDraftExtras(storage)
    const loaded = await fresh.load("local/ses_1")
    expect(loaded?.chips).toEqual([skill])
    expect(loaded?.attachments).toEqual([
      { kind: "inline", name: "shot.png", mime: "image/png", uri: png },
      { kind: "path", name: "notes.txt", mime: "text/plain", path: "/tmp/uploads/1/notes.txt" },
    ])
  })

  test("an emptied draft is removed; pending saves win over the stored record; 50 drafts at most", async () => {
    const storage = memoryStore()
    const extras = createDraftExtras(storage)
    extras.save("a", { chips: [skill], attachments: [] })
    await extras.flush()
    extras.save("a", { chips: [], attachments: [] })
    expect(await extras.load("a")).toEqual({ chips: [], attachments: [] })
    await extras.flush()
    expect(storage.entries.has("a")).toBe(false)
    expect(await extras.load("a")).toBeUndefined()
    for (let index = 0; index < 55; index++) extras.save(`d${index}`, { chips: [file], attachments: [] })
    await extras.flush()
    expect(storage.entries.has("d0")).toBe(false)
    expect(storage.entries.has("d54")).toBe(true)
    expect((storage.entries.get("__index") as string[]).length).toBe(50)
  })

  test("data URIs decode to their bytes; signatures ignore the URI body", async () => {
    const blob = blobFromDataUri("data:text/plain;base64,7ZWc6riA", "application/octet-stream")
    expect(blob.type).toBe("text/plain")
    expect(await blob.text()).toBe("한글")
    expect(blobFromDataUri("data:,a%20b", "text/plain").type).toBe("text/plain")
    const long = `${png}${"A".repeat(200)}`
    const one = signature({
      chips: [skill],
      attachments: [{ kind: "inline", name: "a", mime: "image/png", uri: long }],
    })
    expect(one).toContain("skill:review-guide")
    expect(one).not.toContain("iVBORw0KGgo")
  })
})

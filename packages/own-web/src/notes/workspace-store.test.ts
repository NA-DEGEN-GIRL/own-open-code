// The workspace notebook (05 §8.8) against a stand-in for this PC's own.accounts `notes.*` that several clients share:
// the 350 ms save, the page-hide save and its unsent copy, revisions that never overwrite another device's newer text,
// `notes.changed` refreshes, the one-time move of a browser's old notebook, reconnects, read-only devices, the
// browser-only notebook of a workspace without a key, and the mapping of the service's answers.
import { describe, expect, test } from "bun:test"
import { Notes } from "@own/protocol/notes"
import { createRoot, createSignal } from "solid-js"
import { OwnRpcError } from "@/data"
import {
  createWorkspaceNotes,
  type NoteChange,
  type NotesTransport,
  type StoredNote,
  type WorkspaceNotes,
} from "./workspace-store"
import { browserTransport, serviceTransport } from "./workspace-transport"

const X = "6f1c2b8e-0d4a-4f7e-9c1d-2a3b4c5d6e7f"
const Y = "0b6f3d2c-1e5a-4c7b-8d9e-0f1a2b3c4d5e"

/** This PC's notes of one workspace, as own.accounts keeps and announces them, for any number of clients. */
function fakePc() {
  const notes = new Map<string, StoredNote>()
  const watchers = new Set<(change?: NoteChange) => void>()
  const calls: string[] = []
  const [ready, setReady] = createSignal(true)
  const state = { offline: false }
  // The event stream delivers after the answer, like the bus's next animation frame.
  const announce = (change: NoteChange) => setTimeout(() => watchers.forEach((watcher) => watcher(change)), 5)
  const reachable = () => {
    if (state.offline) throw new Error("offline")
  }
  return {
    notes,
    calls,
    setReady,
    setOffline: (offline: boolean) => void (state.offline = offline),
    seed(note: Omit<StoredNote, "rev"> & { readonly rev?: number }) {
      notes.set(note.id, { rev: 1, ...note })
    },
    /** Another device's save, announced to every client. */
    edit(id: string, patch: { readonly title?: string; readonly text?: string }) {
      const current = notes.get(id)!
      notes.set(id, { ...current, ...patch, rev: current.rev + 1 })
      announce({ id, rev: current.rev + 1 })
    },
    client(name: string, options: { readonly writable?: boolean } = {}): NotesTransport {
      return {
        synced: true,
        ready,
        writable: () => options.writable ?? true,
        list: async () => {
          calls.push(`${name} list`)
          reachable()
          return [...notes.values()].map((note) => ({ id: note.id, title: note.title, rev: note.rev }))
        },
        get: async (id) => {
          calls.push(`${name} get ${id}`)
          reachable()
          return notes.get(id)
        },
        put: async (input) => {
          const fields = [input.title !== undefined && "title", input.text !== undefined && "text"].filter(Boolean)
          calls.push(`${name} put ${input.id}@${input.baseRev} ${fields.join(",")}`)
          reachable()
          const current = notes.get(input.id)
          if ((current?.rev ?? 0) !== input.baseRev) return { type: "conflict", current: current ?? null }
          if (!current && notes.size >= Notes.PER_WORKSPACE_MAX) return { type: "limit", max: Notes.PER_WORKSPACE_MAX }
          const next = {
            id: input.id,
            title: input.title ?? current?.title ?? "",
            text: input.text ?? current?.text ?? "",
            rev: input.baseRev + 1,
          }
          notes.set(input.id, next)
          announce({ id: input.id, rev: next.rev })
          return { type: "ok", rev: next.rev }
        },
        remove: async (id, baseRev) => {
          calls.push(`${name} remove ${id}@${baseRev}`)
          reachable()
          const current = notes.get(id)
          if (current && current.rev !== baseRev) return { type: "conflict", current }
          notes.delete(id)
          announce({ id, rev: null })
          return { type: "ok" }
        },
        watch: (changed) => {
          watchers.add(changed)
          return () => watchers.delete(changed)
        },
      }
    },
  }
}

/** Fresh localStorage keys of one window's notebook. */
function keys() {
  const id = crypto.randomUUID()
  return { view: { key: `own.web.notes.view.test.${id}` }, unsent: `own.web.notes.unsent.${id}` }
}

/** Fresh keys of a browser's notebook before NOTES and of its move marker. */
function oldNotebook() {
  const id = crypto.randomUUID()
  return { marker: `own.web.notes.migrated.${id}`, legacy: `legacy-${id}` }
}

/** One window's notebook, with `dispose` for the window closing. */
function mount(input: Parameters<typeof createWorkspaceNotes>[0]) {
  return createRoot((dispose) => Object.assign(createWorkspaceNotes(input), { dispose }))
}

async function until(probe: () => boolean, timeout = 3_000) {
  const deadline = performance.now() + timeout
  while (!probe()) {
    if (performance.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(5)
  }
}

async function opened(notes: WorkspaceNotes, id: string) {
  await until(() => notes.state.status === "ready")
  notes.open(id)
  await until(() => notes.state.docs[id]?.status === "ready")
}

const puts = (calls: readonly string[], name: string) => calls.filter((call) => call.startsWith(`${name} put`))

describe("workspace notebook on the PC", () => {
  test("typing is saved 350 ms after the last keystroke, as one save of the changed field", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "첫 줄" })
    const notes = mount({ transport: pc.client("pc"), ...keys() })
    await opened(notes, X)
    notes.update(X, { text: "첫 줄\n한" })
    notes.update(X, { text: "첫 줄\n한글" })
    expect(notes.status()).toBe("pending")
    await Bun.sleep(250)
    notes.update(X, { text: "첫 줄\n한글 메모" })
    await Bun.sleep(250)
    expect(puts(pc.calls, "pc")).toEqual([])
    await until(() => notes.status() === "saved")
    expect(puts(pc.calls, "pc")).toEqual([`pc put ${X}@1 text`])
    expect(pc.notes.get(X)).toEqual({ id: X, title: "계획", text: "첫 줄\n한글 메모", rev: 2 })
    expect(notes.state.docs[X]?.rev).toBe(2)
    notes.update(X, { title: "작업 계획" })
    await until(() => notes.status() === "saved")
    expect(puts(pc.calls, "pc").at(-1)).toBe(`pc put ${X}@2 title`)
    expect(notes.state.notes).toEqual([{ id: X, title: "작업 계획", rev: 3 }])
    notes.dispose()
  })

  test("a new note is created with its title and text; a draft only with its first edit", async () => {
    const pc = fakePc()
    const notes = mount({ transport: pc.client("pc"), ...keys() })
    await until(() => notes.state.status === "ready")
    const draft = notes.create("새 노트", { draft: true })!
    await Bun.sleep(400)
    expect(pc.notes.size).toBe(0)
    notes.update(draft, { text: "이제 저장" })
    await until(() => pc.notes.has(draft))
    expect(puts(pc.calls, "pc")).toEqual([`pc put ${draft}@0 title,text`])
    const created = notes.create("작업")!
    await until(() => pc.notes.has(created))
    expect(pc.notes.get(created)).toEqual({ id: created, title: "작업", text: "", rev: 1 })
    expect(notes.state.open).toEqual([draft, created])
    expect(notes.state.active).toBe(created)
    notes.dispose()
  })

  test("pagehide sends at once; edits the PC did not get wait in localStorage and go out on the next load", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "처음" })
    const input = { transport: pc.client("pc"), ...keys() }
    const first = mount(input)
    await opened(first, X)
    pc.setOffline(true)
    first.update(X, { text: "마지막 키 입력" })
    window.dispatchEvent(new Event("pagehide"))
    expect(puts(pc.calls, "pc")).toEqual([`pc put ${X}@1 text`])
    await until(() => first.status() === "error")
    expect(first.state.failure).toEqual({ reason: "error", message: "offline" })
    expect(JSON.parse(localStorage.getItem(input.unsent)!)).toEqual({
      [X]: { title: "계획", text: "마지막 키 입력", rev: 1 },
    })
    first.dispose()

    pc.setOffline(false)
    const second = mount(input)
    await until(() => second.state.status === "ready" && second.status() === "saved")
    expect(pc.notes.get(X)).toEqual({ id: X, title: "계획", text: "마지막 키 입력", rev: 2 })
    expect(localStorage.getItem(input.unsent)).toBeNull()
    expect(second.state.docs[X]?.conflict).toBeUndefined()
    second.dispose()
  })

  test("a save that landed just before the page closed is not a conflict on the next load", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "보낸 글", rev: 2 })
    const input = { transport: pc.client("pc"), ...keys() }
    localStorage.setItem(input.unsent, JSON.stringify({ [X]: { title: "계획", text: "보낸 글", rev: 1 } }))
    const notes = mount(input)
    await until(() => notes.state.status === "ready" && notes.status() === "saved")
    expect(notes.state.docs[X]?.rev).toBe(2)
    expect(notes.state.docs[X]?.conflict).toBeUndefined()
    expect(pc.notes.get(X)?.rev).toBe(2)
    notes.dispose()
  })

  test("another device's newer text is a conflict, never overwritten; the user keeps theirs or saves this one", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "처음" })
    const notes = mount({ transport: pc.client("pc"), ...keys() })
    await opened(notes, X)
    notes.update(X, { text: "PC에서 고친 글" })
    pc.edit(X, { text: "휴대폰에서 고친 글" })
    await until(() => notes.state.docs[X]?.conflict !== undefined)
    expect(notes.state.docs[X]?.conflict).toEqual({ id: X, title: "계획", text: "휴대폰에서 고친 글", rev: 2 })
    expect(pc.notes.get(X)?.text).toBe("휴대폰에서 고친 글")
    // While the conflict is open nothing is saved, whatever is typed.
    const before = puts(pc.calls, "pc").length
    notes.update(X, { text: "PC에서 더 고친 글" })
    await Bun.sleep(400)
    expect(puts(pc.calls, "pc")).toHaveLength(before)
    expect(pc.notes.get(X)?.text).toBe("휴대폰에서 고친 글")

    const version = notes.state.docs[X]!.version
    notes.resolve(X, "theirs")
    expect(notes.state.docs[X]).toMatchObject({ text: "휴대폰에서 고친 글", rev: 2 })
    expect(notes.state.docs[X]?.conflict).toBeUndefined()
    expect(notes.state.docs[X]!.version).toBe(version + 1)
    expect(notes.status()).toBe("saved")

    notes.update(X, { text: "다시 PC" })
    pc.edit(X, { text: "다시 휴대폰" })
    await until(() => notes.state.docs[X]?.conflict !== undefined)
    notes.resolve(X, "mine")
    await until(() => notes.status() === "saved")
    expect(pc.notes.get(X)).toEqual({ id: X, title: "계획", text: "다시 PC", rev: 4 })
    expect(puts(pc.calls, "pc").at(-1)).toBe(`pc put ${X}@3 title,text`)
    notes.dispose()
  })

  test("another device's save, new note and removal reach this window; its own saves cause no extra reads", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "처음" })
    const here = mount({ transport: pc.client("here"), ...keys() })
    const there = mount({ transport: pc.client("there"), ...keys() })
    await opened(here, X)
    await opened(there, X)

    there.update(X, { title: "휴대폰 제목", text: "휴대폰에서 쓴 글" })
    await until(() => here.state.docs[X]?.text === "휴대폰에서 쓴 글")
    expect(here.state.docs[X]).toMatchObject({ title: "휴대폰 제목", rev: 2, version: 2 })
    expect(here.state.notes[0]?.title).toBe("휴대폰 제목")

    const created = there.create("휴대폰 새 노트")!
    await until(() => here.state.notes.some((note) => note.id === created))

    const lists = () => pc.calls.filter((call) => call === "here list").length
    const listed = lists()
    here.update(X, { text: "PC 답장" })
    await until(() => here.status() === "saved")
    await Bun.sleep(50)
    expect(lists()).toBe(listed)
    await until(() => there.state.docs[X]?.text === "PC 답장")

    await there.remove(X)
    await until(() => !here.state.notes.some((note) => note.id === X))
    expect(here.state.open).toEqual([])
    expect(here.state.docs[X]).toBeUndefined()
    here.dispose()
    there.dispose()
  })

  test("a note removed elsewhere while it has unsaved edits asks first; saving it again recreates it", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "처음" })
    const notes = mount({ transport: pc.client("pc"), ...keys() })
    await opened(notes, X)
    notes.update(X, { text: "지우기 전에 쓴 글" })
    pc.notes.delete(X)
    await until(() => notes.state.docs[X]?.conflict === null)
    notes.resolve(X, "mine")
    await until(() => notes.status() === "saved")
    expect(pc.notes.get(X)).toEqual({ id: X, title: "계획", text: "지우기 전에 쓴 글", rev: 1 })
    notes.dispose()
  })

  test("reconnecting reads what changed meanwhile and sends the edits that waited", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "처음" })
    pc.seed({ id: Y, title: "참고", text: "참고 글" })
    const notes = mount({ transport: pc.client("pc"), ...keys() })
    await opened(notes, X)
    notes.open(Y)
    await until(() => notes.state.docs[Y]?.status === "ready")
    pc.setReady(false)
    pc.setOffline(true)
    notes.update(X, { text: "연결이 끊긴 동안 쓴 글" })
    await until(() => notes.status() === "error")
    // Another device changes Y while this one is away (its event never arrives here).
    pc.notes.set(Y, { id: Y, title: "참고", text: "다른 기기의 글", rev: 2 })
    pc.setOffline(false)
    pc.setReady(true)
    await until(() => notes.status() === "saved" && notes.state.docs[Y]?.text === "다른 기기의 글")
    expect(pc.notes.get(X)?.text).toBe("연결이 끊긴 동안 쓴 글")
    notes.dispose()
  })

  test("the first load moves this browser's old notebook to an empty PC once, with its ids, titles and layout", async () => {
    const pc = fakePc()
    const k = { ...keys(), ...oldNotebook() }
    const old = `own.web.notes.${k.legacy}`
    localStorage.setItem(
      old,
      JSON.stringify({
        notes: [
          { id: X, title: "계획" },
          { id: Y, title: "참고" },
        ],
        open: [X, Y],
        active: Y,
      }),
    )
    localStorage.setItem(`${old}.${X}`, "한글 메모\n첫 번째")
    localStorage.setItem(`${old}.${Y}`, "두 번째")
    const input = {
      transport: pc.client("pc"),
      view: { key: k.view.key, fallback: old },
      legacy: { transport: browserTransport(localStorage, k.legacy), marker: k.marker },
      unsent: k.unsent,
    }
    const first = mount(input)
    await until(() => first.state.status === "ready")
    expect([...pc.notes.values()]).toEqual([
      { id: X, title: "계획", text: "한글 메모\n첫 번째", rev: 1 },
      { id: Y, title: "참고", text: "두 번째", rev: 1 },
    ])
    expect(first.state.notes.map((note) => note.id)).toEqual([X, Y])
    expect([first.state.open, first.state.active]).toEqual([[X, Y], Y])
    expect(JSON.parse(localStorage.getItem(k.marker)!)).toBe("done")
    // The old values stay as they were, as a backup.
    expect(JSON.parse(localStorage.getItem(old)!).notes).toEqual([
      { id: X, title: "계획" },
      { id: Y, title: "참고" },
    ])
    expect(localStorage.getItem(`${old}.${X}`)).toBe("한글 메모\n첫 번째")
    first.dispose()

    const second = mount(input)
    await until(() => second.state.status === "ready")
    expect(puts(pc.calls, "pc")).toHaveLength(2)
    second.dispose()
  })

  test("a PC that has notes already wins: nothing is merged and the old notebook stays as a backup", async () => {
    const pc = fakePc()
    pc.seed({ id: Y, title: "다른 기기에서 옮긴 노트", text: "PC의 글" })
    const k = { ...keys(), ...oldNotebook() }
    const old = `own.web.notes.${k.legacy}`
    localStorage.setItem(old, JSON.stringify({ notes: [{ id: X, title: "이 브라우저의 노트" }] }))
    localStorage.setItem(`${old}.${X}`, "이 브라우저의 글")
    const notes = mount({
      transport: pc.client("pc"),
      view: k.view,
      legacy: { transport: browserTransport(localStorage, k.legacy), marker: k.marker },
    })
    await until(() => notes.state.status === "ready")
    expect([...pc.notes.keys()]).toEqual([Y])
    expect(puts(pc.calls, "pc")).toEqual([])
    expect(JSON.parse(localStorage.getItem(k.marker)!)).toBe("done")
    expect(localStorage.getItem(`${old}.${X}`)).toBe("이 브라우저의 글")
    notes.dispose()
  })

  test("a move cut short goes on with the notes still missing; a note too large for the PC stays behind", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "이미 옮김" })
    const k = { ...keys(), ...oldNotebook() }
    const old = `own.web.notes.${k.legacy}`
    const big = "Z".repeat(32)
    localStorage.setItem(
      old,
      JSON.stringify({
        notes: [
          { id: X, title: "계획" },
          { id: Y, title: "참고" },
          { id: big, title: "큰 노트" },
        ],
      }),
    )
    localStorage.setItem(`${old}.${X}`, "이미 옮김")
    localStorage.setItem(`${old}.${Y}`, "아직 남은 노트")
    localStorage.setItem(`${old}.${big}`, "x".repeat(Notes.TEXT_MAX + 1))
    localStorage.setItem(k.marker, JSON.stringify("started"))
    const notes = mount({
      transport: pc.client("pc"),
      view: k.view,
      legacy: { transport: browserTransport(localStorage, k.legacy), marker: k.marker },
    })
    await until(() => notes.state.status === "ready")
    expect([...pc.notes.keys()]).toEqual([X, Y])
    expect(puts(pc.calls, "pc")).toEqual([`pc put ${Y}@0 title,text`])
    expect(notes.state.skipped).toBe(1)
    expect(localStorage.getItem(`${old}.${big}`)).toHaveLength(Notes.TEXT_MAX + 1)
    notes.dispose()
  })

  test("a failed load shows the error and loads again on retry", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "처음" })
    pc.setOffline(true)
    const notes = mount({ transport: pc.client("pc"), ...keys() })
    await until(() => notes.state.status === "error")
    expect(notes.state.error).toBe("offline")
    pc.setOffline(false)
    await notes.load()
    expect(notes.state.status).toBe("ready")
    expect(notes.state.notes.map((note) => note.id)).toEqual([X])
    notes.dispose()
  })

  test("a text over the limit is not sent and says so; a device without the prompt scope never writes", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "처음" })
    const writer = mount({ transport: pc.client("pc"), ...keys() })
    await opened(writer, X)
    writer.update(X, { text: "x".repeat(Notes.TEXT_MAX + 1) })
    await until(() => writer.status() === "error")
    expect(writer.state.failure).toEqual({ reason: "tooLong", max: Notes.TEXT_MAX })
    expect(puts(pc.calls, "pc")).toEqual([])
    writer.update(X, { text: "짧게" })
    await until(() => writer.status() === "saved")
    writer.dispose()

    const reader = mount({ transport: pc.client("phone", { writable: false }), ...keys() })
    await opened(reader, X)
    expect(reader.create("새 노트")).toBeUndefined()
    reader.update(X, { text: "읽기 전용 기기의 글" })
    await Bun.sleep(400)
    expect(puts(pc.calls, "phone")).toEqual([])
    expect(reader.state.docs[X]?.text).toBe("짧게")
    reader.dispose()
  })

  test("which notes are open is this window's layout, kept in localStorage", async () => {
    const pc = fakePc()
    pc.seed({ id: X, title: "계획", text: "" })
    pc.seed({ id: Y, title: "참고", text: "" })
    const input = { transport: pc.client("pc"), ...keys() }
    const first = mount(input)
    await opened(first, X)
    first.open(Y)
    first.close(X)
    first.dispose()
    const second = mount(input)
    await until(() => second.state.status === "ready")
    expect([second.state.open, second.state.active]).toEqual([[Y], Y])
    // Closing a tab never removes the note.
    expect(second.state.notes.map((note) => note.id)).toEqual([X, Y])
    second.dispose()
  })
})

describe("workspace notebook without a key (this browser only, as before)", () => {
  test("typing performs no synchronous storage writes; switching, closing and reopening retains each note", async () => {
    const workspace = crypto.randomUUID()
    const input = () => ({ transport: browserTransport(localStorage, workspace), view: { key: `view-${workspace}` } })
    const first = mount(input())
    await until(() => first.state.status === "ready")
    const one = first.create("계획")!
    first.update(one, { text: "한글 메모\nfirst" })
    const two = first.create("작업")!
    first.update(two, { text: "second" })
    expect(localStorage.getItem(`own.web.notes.${workspace}.${one}`)).toBeNull()
    expect(await first.flush()).toBe(true)
    expect(localStorage.getItem(`own.web.notes.${workspace}.${one}`)).toBe("한글 메모\nfirst")
    first.close(one)
    first.open(one)
    expect(first.state.docs[one]?.text).toBe("한글 메모\nfirst")
    expect(first.synced).toBe(false)
    first.dispose()

    const second = mount(input())
    await until(() => second.state.status === "ready")
    expect(second.state.notes.map((note) => note.title)).toEqual(["계획", "작업"])
    await opened(second, second.state.active!)
    expect(second.state.docs[one]?.text).toBe("한글 메모\nfirst")
    second.dispose()
  })

  test("workspaces are isolated, and pagehide writes the last keystroke before the page goes", async () => {
    const workspace = crypto.randomUUID()
    const notes = mount({ transport: browserTransport(localStorage, workspace), view: { key: `view-${workspace}` } })
    const other = mount({
      transport: browserTransport(localStorage, `${workspace}-other`),
      view: { key: `v-${workspace}` },
    })
    await until(() => notes.state.status === "ready" && other.state.status === "ready")
    const id = notes.create("local")!
    notes.update(id, { text: "last keystroke" })
    window.dispatchEvent(new Event("pagehide"))
    expect(localStorage.getItem(`own.web.notes.${workspace}.${id}`)).toBe("last keystroke")
    expect(other.state.notes).toEqual([])
    notes.dispose()
    other.dispose()
  })

  test("a second window cannot erase notes or titles the first one saved", async () => {
    const workspace = crypto.randomUUID()
    const input = (window: string) => ({
      transport: browserTransport(localStorage, workspace),
      view: { key: `view-${window}-${workspace}` },
    })
    const first = mount(input("a"))
    await until(() => first.state.status === "ready")
    const shared = first.create("initial")!
    await first.flush()
    const second = mount(input("b"))
    await until(() => second.state.status === "ready")
    const added = first.create("new from first window")!
    first.update(added, { text: "keep this document" })
    first.update(shared, { title: "renamed by first window" })
    await first.flush()
    second.open(shared)
    await second.flush()
    const restored = mount(input("c"))
    await until(() => restored.state.status === "ready")
    expect(restored.state.notes.map((note) => note.title)).toEqual(["renamed by first window", "new from first window"])
    restored.open(added)
    await until(() => restored.state.docs[added]?.status === "ready")
    expect(restored.state.docs[added]?.text).toBe("keep this document")
    first.dispose()
    second.dispose()
    restored.dispose()
  })
})

describe("service transport", () => {
  /** The local runtime as the transport sees it: own.accounts calls, their events and the connection. */
  function runtime(answer: (method: string, input: Record<string, unknown>) => Promise<unknown>) {
    const listeners = new Set<(event: { data: { workspace: string; id: string; rev: number | null } }) => void>()
    const value = {
      rpc: { call: answer, allowed: (method: string) => method !== "notes.put" },
      own: {
        on: (
          _name: string,
          listener: (event: { data: { workspace: string; id: string; rev: number | null } }) => void,
        ) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      connection: { status: () => "connected" },
    }
    // SAFETY: the transport uses only `rpc.call`, `rpc.allowed`, `own.on("notes.changed")` and `connection.status`.
    return { runtime: value as unknown as Parameters<typeof serviceTransport>[0], listeners }
  }
  const workspace = Notes.workspaceKey({ directory: "D:\\work\\repo" })!

  test("maps conflicts, the limit and a missing note; other errors stay errors", async () => {
    const current = { id: X, title: "계획", text: "휴대폰의 글", rev: 3 }
    const seen: unknown[] = []
    const fake = runtime(async (method, input) => {
      seen.push([method, input])
      if (method === "notes.put" && input.id === X) throw new OwnRpcError("note_conflict", "changed", { current })
      if (method === "notes.put") throw new OwnRpcError("notes_limit", "full", { max: 200 })
      if (method === "notes.get") throw new OwnRpcError("note_not_found", "gone", { id: input.id })
      if (method === "notes.remove") throw new OwnRpcError("rpc.unavailable", "down")
      return { notes: [] }
    })
    const transport = serviceTransport(fake.runtime, workspace)
    expect(await transport.put({ id: X, text: "PC의 글", baseRev: 2 })).toEqual({ type: "conflict", current })
    expect(await transport.put({ id: Y, baseRev: 0 })).toEqual({ type: "limit", max: 200 })
    expect(await transport.get(X)).toBeUndefined()
    await expect(transport.remove(X, 1)).rejects.toThrow("down")
    expect(seen[0]).toEqual(["notes.put", { workspace, id: X, text: "PC의 글", baseRev: 2 }])
    expect(transport.writable()).toBe(false)
    expect(transport.synced).toBe(true)
  })

  test("passes only this workspace's changes", () => {
    const fake = runtime(async () => ({}))
    const changes: unknown[] = []
    const stop = serviceTransport(fake.runtime, workspace).watch((change) => changes.push(change))
    fake.listeners.forEach((listener) => listener({ data: { workspace: "local:d:\\other", id: X, rev: 2 } }))
    fake.listeners.forEach((listener) => listener({ data: { workspace, id: Y, rev: null } }))
    expect(changes).toEqual([{ id: Y, rev: null }])
    stop()
    expect(fake.listeners.size).toBe(0)
  })
})

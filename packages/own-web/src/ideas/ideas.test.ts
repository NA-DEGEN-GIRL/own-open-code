// Idea notes (03 §4.4.1 아이디어 노트) against a stand-in for this PC's own.accounts `ideas.*` that several windows
// share: the board's order, tags and search; adding, editing, pinning and removing with revisions that never overwrite
// another device's newer text; undo keeping the card's place; `ideas.changed` and reconnect refreshes; read-only
// devices; the quick capture's draft; `새 대화로 시작` (a draft, never sent) and `프로젝트 노트로 옮기기`; and the
// wiring in the sources (components do not render under `bun test`; the Edge suite e2e/idea-notes.spec.ts does).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Ideas } from "@own/protocol/ideas"
import { Notes } from "@own/protocol/notes"
import { createRoot, createSignal } from "solid-js"
import { COMPOSER_RESTORE, type ComposerRestoreDetail } from "@/attachments/intents"
import { OwnRpcError } from "@/data"
import { DEFAULT_KEYMAP, findConflicts } from "@/keyboard/keymap"
import { auditKeymap } from "@/palette/audit"
import { moveToProject, startConversation } from "./actions"
import { createCaptureFlow } from "./capture-flow"
import { isOpenIdeas, OPEN_IDEAS, openIdeas } from "./intents"
import { cleanText, filterIdeas, segments, sortIdeas, tagCounts, tagsOf, titleOf, type Idea } from "./model"
import { createIdeas, serviceTransport, type IdeaChange, type IdeaPut, type IdeasTransport } from "./store"
import { ideasEn, ideasKo, ideasText } from "./strings"

const here = import.meta.dir
const read = (file: string) => Bun.file(path.join(here, file)).text()
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function idea(fields: Partial<Idea> & Pick<Idea, "id">): Idea {
  return { text: fields.id, color: "yellow", pinned: false, rev: 1, createdAt: 0, updatedAt: 0, ...fields }
}

/** This PC's ideas as own.accounts keeps and announces them, for any number of windows. */
function fakePc() {
  const ideas = new Map<string, Idea>()
  const watchers = new Set<(change: IdeaChange) => void>()
  const calls: string[] = []
  const [ready, setReady] = createSignal(true)
  let now = 1_000
  // The event stream delivers after the answer, like the bus's next animation frame.
  const announce = (change: IdeaChange) => setTimeout(() => watchers.forEach((watcher) => watcher(change)), 5)
  const put = (input: IdeaPut) => {
    const current = ideas.get(input.id)
    if ((current?.rev ?? 0) !== input.baseRev) return { type: "conflict" as const, current: current ?? null }
    if (!current && ideas.size >= Ideas.MAX) return { type: "limit" as const, max: Ideas.MAX }
    now += 1_000
    const next: Idea = {
      id: input.id,
      text: input.text ?? current?.text ?? "",
      color: input.color ?? current?.color ?? "yellow",
      pinned: input.pinned ?? current?.pinned ?? false,
      rev: input.baseRev + 1,
      createdAt: current?.createdAt ?? Math.min(input.createdAt ?? now, now),
      updatedAt: now,
    }
    ideas.set(input.id, next)
    announce({ id: input.id, rev: next.rev })
    return { type: "ok" as const, idea: next }
  }
  return {
    ideas,
    calls,
    setReady,
    /** Another device's write, announced to every window. */
    other: (input: IdeaPut) => put(input),
    otherRemove(id: string) {
      ideas.delete(id)
      announce({ id, rev: null })
    },
    client(name: string, options: { readonly writable?: boolean } = {}): IdeasTransport {
      return {
        ready,
        writable: () => options.writable ?? true,
        list: async () => {
          calls.push(`${name} list`)
          return [...ideas.values()]
        },
        put: async (input) => {
          calls.push(
            `${name} put ${input.id}@${input.baseRev} ${Object.keys(input)
              .filter((key) => key !== "id" && key !== "baseRev")
              .join(",")}`,
          )
          return put(input)
        },
        remove: async (id, baseRev) => {
          calls.push(`${name} remove ${id}@${baseRev}`)
          const current = ideas.get(id)
          if (current && current.rev !== baseRev) return { type: "conflict", current }
          ideas.delete(id)
          if (current) announce({ id, rev: null })
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

function open(transport: IdeasTransport) {
  return createRoot((dispose) => {
    const store = createIdeas(transport)
    const stop = store.watch()
    return {
      store,
      dispose: () => {
        stop()
        dispose()
      },
    }
  })
}

describe("board rules", () => {
  test("pinned first, then newest first; an edit never moves a card", () => {
    const ideas = [
      idea({ id: "old", createdAt: 1, updatedAt: 99 }),
      idea({ id: "new", createdAt: 3 }),
      idea({ id: "pinned-old", createdAt: 0, pinned: true }),
      idea({ id: "mid", createdAt: 2 }),
    ]
    expect(sortIdeas(ideas).map((item) => item.id)).toEqual(["pinned-old", "new", "mid", "old"])
  })

  test("#tags start a word, fold case, count once per idea; the search matches words and tags", () => {
    expect(tagsOf("#도구 회의록 #AI 요약 (#ai) C# a#b #긴_태그-2")).toEqual(["도구", "ai", "긴_태그-2"])
    const ideas = [
      idea({ id: "a", text: "회의록 자동 요약 #도구 #AI" }),
      idea({ id: "b", text: "산책 앱 #앱 #ai" }),
      idea({ id: "c", text: "그냥 메모" }),
    ]
    expect(tagCounts(ideas)).toEqual([
      { tag: "ai", count: 2 },
      { tag: "도구", count: 1 },
      { tag: "앱", count: 1 },
    ])
    expect(filterIdeas(ideas, { query: "", tag: "ai" }).map((item) => item.id)).toEqual(["a", "b"])
    expect(filterIdeas(ideas, { query: "요약 회의록" }).map((item) => item.id)).toEqual(["a"])
    expect(filterIdeas(ideas, { query: "#앱" }).map((item) => item.id)).toEqual(["b"])
    expect(filterIdeas(ideas, { query: "메모", tag: "ai" })).toEqual([])
    expect(segments("앞 #도구 뒤 #AI")).toEqual([
      { text: "앞 " },
      { text: "#도구", tag: "도구" },
      { text: " 뒤 " },
      { text: "#AI", tag: "ai" },
    ])
    expect(segments("태그 없음")).toEqual([{ text: "태그 없음" }])
  })

  test("a project note's title is the first line with text; a save drops blank lines and trailing spaces", () => {
    expect(titleOf("\n\n  회의록 자동 요약  \n둘째 줄", Notes.TITLE_MAX)).toBe("회의록 자동 요약")
    expect(titleOf("가".repeat(300), 10)).toBe(`${"가".repeat(9)}…`)
    expect(cleanText("\n \n  들여쓴 첫 줄\n둘째 줄 \n\n")).toBe("  들여쓴 첫 줄\n둘째 줄")
    expect(cleanText(" \n\t ")).toBeUndefined()
  })
})

describe("ideas store", () => {
  test("adds on top, edits text, color and pin, and another window sees each change", async () => {
    const pc = fakePc()
    const desk = open(pc.client("desk"))
    const phone = open(pc.client("phone"))
    await Promise.all([desk.store.load(), phone.store.load()])
    expect(desk.store.state.status).toBe("ready")
    const added = await desk.store.add("회의록 자동 요약 #도구")
    expect(added).toMatchObject({ type: "ok", idea: { text: "회의록 자동 요약 #도구", color: "yellow", rev: 1 } })
    if (added.type !== "ok") throw new Error("not added")
    await desk.store.add("주말 산책 앱", "green")
    await desk.store.edit(added.idea.id, { pinned: true })
    await desk.store.edit(added.idea.id, { color: "pink" })
    await desk.store.edit(added.idea.id, { text: "회의록 자동 요약\n화자 구분까지" })
    await tick()
    for (const window of [desk, phone])
      expect(sortIdeas(window.store.state.ideas).map((item) => [item.text, item.color, item.pinned, item.rev])).toEqual(
        [
          ["회의록 자동 요약\n화자 구분까지", "pink", true, 4],
          ["주말 산책 앱", "green", false, 1],
        ],
      )
    // The desk's own echoes read nothing again; the phone read the list for the desk's changes.
    expect(pc.calls.filter((call) => call === "desk list")).toEqual(["desk list"])
    expect(pc.calls.filter((call) => call === "phone list").length).toBeGreaterThan(1)
    desk.dispose()
    phone.dispose()
  })

  test("a text edit from an older revision comes back as the conflict; a pin or color goes out again on top", async () => {
    const pc = fakePc()
    pc.ideas.set("x", idea({ id: "x", text: "PC에서 적음", rev: 1, createdAt: 10 }))
    const desk = open(pc.client("desk"))
    await desk.store.load()
    pc.other({ id: "x", text: "휴대폰에서 고침", baseRev: 1 })
    // Before the event arrives the desk still has revision 1.
    const stale = await desk.store.edit("x", { text: "PC의 늦은 저장" })
    expect(stale).toMatchObject({ type: "conflict", current: { text: "휴대폰에서 고침", rev: 2 } })
    expect(desk.store.state.ideas.find((item) => item.id === "x")?.text).toBe("휴대폰에서 고침")
    // The user chose `내 글로 저장`: the revision the conflict named.
    expect(await desk.store.edit("x", { text: "PC의 늦은 저장" }, 2)).toMatchObject({ type: "ok", idea: { rev: 3 } })
    pc.other({ id: "x", text: "또 다른 기기", baseRev: 3 })
    const pinned = await desk.store.edit("x", { pinned: true }, 3)
    expect(pinned).toMatchObject({ type: "ok", idea: { text: "또 다른 기기", pinned: true, rev: 5 } })
    expect(pc.calls.filter((call) => call.startsWith("desk put x"))).toEqual([
      "desk put x@1 text",
      "desk put x@2 text",
      "desk put x@3 pinned",
      "desk put x@4 pinned",
    ])
    desk.dispose()
  })

  test("remove takes the card away; undo brings it back in its old place; a removal elsewhere is a conflict", async () => {
    const pc = fakePc()
    const desk = open(pc.client("desk"))
    await desk.store.load()
    const first = await desk.store.add("먼저 적은 것")
    await desk.store.add("나중에 적은 것")
    if (first.type !== "ok") throw new Error("not added")
    const removed = await desk.store.remove(first.idea.id)
    expect(removed).toMatchObject({ type: "ok", removed: { text: "먼저 적은 것" } })
    expect(desk.store.state.ideas.map((item) => item.text)).toEqual(["나중에 적은 것"])
    if (removed.type !== "ok") throw new Error("not removed")
    expect(await desk.store.restore(removed.removed)).toMatchObject({
      type: "ok",
      idea: { id: first.idea.id, createdAt: first.idea.createdAt, rev: 1 },
    })
    expect(sortIdeas(desk.store.state.ideas).map((item) => item.text)).toEqual(["나중에 적은 것", "먼저 적은 것"])
    // Another device changed it in between: nothing is removed, the newer idea shows.
    pc.other({ id: first.idea.id, text: "다른 기기에서 고침", baseRev: 1 })
    expect(await desk.store.remove(first.idea.id)).toMatchObject({
      type: "conflict",
      current: { text: "다른 기기에서 고침" },
    })
    expect(pc.ideas.has(first.idea.id)).toBe(true)
    desk.dispose()
  })

  test("ideas.changed from elsewhere and a reconnect read the list again; a refusal keeps the board", async () => {
    const pc = fakePc()
    const desk = open(pc.client("desk"))
    await desk.store.load()
    pc.other({ id: "p", text: "휴대폰에서 적음", baseRev: 0 })
    await tick()
    expect(desk.store.state.ideas.map((item) => item.text)).toEqual(["휴대폰에서 적음"])
    pc.otherRemove("p")
    await tick()
    expect(desk.store.state.ideas).toEqual([])
    pc.setReady(false)
    pc.ideas.set("q", idea({ id: "q", text: "끊긴 동안 생김" }))
    pc.setReady(true)
    await tick()
    expect(desk.store.state.ideas.map((item) => item.text)).toEqual(["끊긴 동안 생김"])
    desk.dispose()
  })

  test("the first load failing shows the error; a read-only device cannot write", async () => {
    const pc = fakePc()
    const failing: IdeasTransport = {
      ...pc.client("phone", { writable: false }),
      list: async () => Promise.reject(new Error("offline")),
    }
    const phone = open(failing)
    await phone.store.load()
    expect(phone.store.state).toMatchObject({ status: "error", error: "offline" })
    expect(phone.store.writable()).toBe(false)
    phone.dispose()
  })

  test("serviceTransport: ideas.* of this PC; conflicts and the limit are answers, other errors stay errors", async () => {
    const current = idea({ id: "x", text: "휴대폰의 글", rev: 3 })
    const seen: unknown[] = []
    const listeners = new Set<(event: { data: IdeaChange }) => void>()
    const runtime = {
      rpc: {
        call: async (method: string, input: Record<string, unknown>) => {
          seen.push([method, input])
          if (method === "ideas.put" && input.id === "x") throw new OwnRpcError("idea_conflict", "changed", { current })
          if (method === "ideas.put") throw new OwnRpcError("ideas_limit", "full", { max: Ideas.MAX })
          if (method === "ideas.remove") throw new OwnRpcError("rpc.unavailable", "down")
          return { ideas: [current] }
        },
        allowed: (method: string) => method !== "ideas.put",
      },
      own: {
        on: (_name: string, listener: (event: { data: IdeaChange }) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      connection: { status: () => "connected" },
    }
    // SAFETY: the transport uses only `rpc.call`, `rpc.allowed`, `own.on("ideas.changed")` and `connection.status`.
    const transport = serviceTransport(runtime as unknown as Parameters<typeof serviceTransport>[0])
    expect(await transport.list()).toEqual([current])
    expect(await transport.put({ id: "x", text: "PC의 글", baseRev: 2 })).toEqual({ type: "conflict", current })
    expect(await transport.put({ id: "y", text: "새것", baseRev: 0 })).toEqual({ type: "limit", max: Ideas.MAX })
    await expect(transport.remove("x", 1)).rejects.toThrow("down")
    expect(seen.slice(0, 2)).toEqual([
      ["ideas.list", {}],
      ["ideas.put", { id: "x", text: "PC의 글", baseRev: 2 }],
    ])
    expect(transport.writable()).toBe(false)
    const changes: IdeaChange[] = []
    const stop = transport.watch((change) => changes.push(change))
    for (const listener of listeners) listener({ data: { id: "x", rev: null } })
    stop()
    expect(changes).toEqual([{ id: "x", rev: null }])
  })
})

describe("quick capture", () => {
  test("Enter on an empty draft does nothing; a save sticks the idea, empties the draft and keeps the color", async () => {
    const flow = createRoot(() => createCaptureFlow())
    const added: unknown[] = []
    const add = async (text: string, color: Idea["color"]) => {
      added.push([text, color])
      return { type: "ok" as const, idea: idea({ id: "n", text, color }) }
    }
    flow.input("  \n ")
    expect(await flow.save(add)).toBeUndefined()
    flow.setColor("blue")
    flow.input("\n떠오른 생각 #도구 \n")
    expect(await flow.save(add)).toMatchObject({ text: "떠오른 생각 #도구", color: "blue" })
    expect(added).toEqual([["떠오른 생각 #도구", "blue"]])
    expect(flow.draft()).toBe("")
    expect(flow.color()).toBe("blue")
  })

  test("too long, the limit and a failure keep the draft and say why; typing during a save is kept", async () => {
    const flow = createRoot(() => createCaptureFlow())
    flow.input("가".repeat(Ideas.TEXT_MAX + 1))
    expect(await flow.save(async () => Promise.reject(new Error("never called")))).toBeUndefined()
    expect(flow.problem()).toEqual({ kind: "tooLong", max: Ideas.TEXT_MAX })
    flow.input("짧은 생각")
    expect(flow.problem()).toBeUndefined()
    expect(await flow.save(async () => ({ type: "limit" as const, max: Ideas.MAX }))).toBeUndefined()
    expect(flow.problem()).toEqual({ kind: "limit", max: Ideas.MAX })
    expect(await flow.save(async () => ({ type: "error" as const, message: "offline" }))).toBeUndefined()
    expect([flow.draft(), flow.problem()]).toEqual(["짧은 생각", { kind: "error", message: "offline" }])
    const saving = flow.save(async (text) => {
      flow.input("짧은 생각 그리고 더")
      return { type: "ok" as const, idea: idea({ id: "n", text }) }
    })
    expect(await saving).toMatchObject({ text: "짧은 생각" })
    expect(flow.draft()).toBe("짧은 생각 그리고 더")
  })
})

describe("what a sticky becomes", () => {
  test("새 대화로 시작: the new-session draft gets the idea after what is there, and nothing is sent", () => {
    const seen: ComposerRestoreDetail[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent<ComposerRestoreDetail>).detail)
    window.addEventListener(COMPOSER_RESTORE, listener)
    const routes: string[] = []
    startConversation("회의록 자동 요약", () => routes.push("home"))
    window.removeEventListener(COMPOSER_RESTORE, listener)
    expect(seen).toEqual([
      { serverKey: "local", sessionID: undefined, text: "회의록 자동 요약", attachments: [], mode: "fill" },
    ])
    expect(routes).toEqual(["home"])
  })

  test("프로젝트 노트로 옮기기: a new note in that folder's notebook, titled by the first line, then the idea leaves", async () => {
    const calls: unknown[] = []
    const removed: string[] = []
    const runtime = {
      rpc: {
        call: async (method: string, input: Record<string, unknown>) => {
          calls.push([method, { ...input, id: typeof input.id }])
          return { rev: 1, updatedAt: 1 }
        },
      },
    }
    const store = { remove: async (id: string) => (removed.push(id), { type: "ok" as const, removed: idea({ id }) }) }
    const sticky = idea({ id: "x", text: "회의록 자동 요약\n화자 구분까지 #도구" })
    // SAFETY: moveToProject uses only `rpc.call("notes.put")`.
    const result = await moveToProject(runtime as never, store, sticky, "D:/Work/Repo/")
    expect(result).toMatchObject({ type: "ok" })
    expect(calls).toEqual([
      [
        "notes.put",
        {
          workspace: "local:d:\\work\\repo",
          id: "string",
          title: "회의록 자동 요약",
          text: "회의록 자동 요약\n화자 구분까지 #도구",
          baseRev: 0,
        },
      ],
    ])
    expect(removed).toEqual(["x"])
    // A note the PC refused leaves the idea where it is.
    const failing = { rpc: { call: async () => Promise.reject(new OwnRpcError("scope_denied", "read only")) } }
    expect(await moveToProject(failing as never, store, sticky, "D:/Work/Repo")).toEqual({
      type: "error",
      message: "read only",
    })
    expect(await moveToProject(runtime as never, store, sticky, "relative/path")).toMatchObject({ type: "error" })
    expect(removed).toEqual(["x"])
  })

  test("the open-ideas intent carries only the two views", () => {
    const seen: unknown[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_IDEAS, listener)
    openIdeas("capture")
    openIdeas("board")
    window.removeEventListener(OPEN_IDEAS, listener)
    expect(seen).toEqual([{ view: "capture" }, { view: "board" }])
    expect(isOpenIdeas({ view: "settings" })).toBe(false)
  })
})

describe("strings and wiring (sources)", () => {
  test("every Korean string has an English one; the empty board explains the feature in one line", () => {
    expect(Object.keys(ideasEn).filter((key) => !(key in ideasKo))).toEqual([])
    expect(ideasText.text("ko", "own.ideas.empty")).toBe(
      "프로젝트와 상관없이 떠오른 생각을 빠르게 적어 두는 곳이에요. 프로젝트 노트·대화 메모와는 따로 저장돼요.",
    )
    expect(ideasText.text("ko", "own.ideas.palette.capture")).toBe("아이디어 적기")
    expect(ideasText.text("ko", "own.ideas.palette.open")).toBe("아이디어 노트 열기")
    expect(ideasText.text("ko", "own.ideas.buttonHint", { keys: "Ctrl+Alt+I" })).toContain("아이디어 노트 (전역)")
  })

  test("the quick capture has a default chord the shortcut audit accepts and nothing else uses", () => {
    expect(DEFAULT_KEYMAP["idea.capture"]).toEqual({ chords: ["Mod+Alt+KeyI"], scope: "global" })
    expect(auditKeymap(DEFAULT_KEYMAP, { mac: false }).issues.filter((issue) => issue.id === "idea.capture")).toEqual(
      [],
    )
    expect(findConflicts(DEFAULT_KEYMAP)).toEqual([])
  })

  test("the shell mounts the layer and the header button; the layer owns the shortcut and the palette commands", async () => {
    const shell = await read("../shell/app-shell.tsx")
    expect(shell).toContain("<IdeasLayer />")
    expect(await read("../shell/header.tsx")).toContain("<IdeasButton />")
    const layer = await read("layer.tsx")
    expect(layer).toContain('useShortcut("idea.capture"')
    expect(layer).toContain('id: "ideas.capture"')
    expect(layer).toContain('id: "ideas.open"')
    expect(layer).toContain('lazy(() => import("./capture"))')
    expect(layer).toContain('lazy(() => import("./board"))')
  })

  test("both capture fields and the card editor dictate into their own field; nothing here sends a message", async () => {
    const capture = await read("capture.tsx")
    expect(capture).toContain("<DictationButton target={() => area}")
    expect(capture).toContain("ref={area}")
    const board = await read("board.tsx")
    expect(board).toContain("<DictationButton target={() => area}")
    expect(board).toContain("<CaptureForm")
    for (const source of [capture, board, await read("actions.ts")])
      expect(source).not.toMatch(/session\.prompt|\.send\(|sendNow|promptAsync/)
    // The quick capture hands focus back (the composer keeps its draft and focus).
    expect(capture).toContain("opener.focus(")
  })
})

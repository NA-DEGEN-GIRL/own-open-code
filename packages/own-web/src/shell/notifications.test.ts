// Turn-end OS notifications (03 §9 "턴 완료", 05 §7.4): who is told, when, with what, and where a click goes.
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { DataLayer, ServerRuntime } from "@/data"
import type { HostNotification, OsNotifications } from "@/host/types"
import type { Route } from "@/routing/routes"
import { createTurnNotifier, shouldNotifyTurn, turnText } from "./notifications"

type Handler = (event: { data: { sessionID: string } }) => void

function fakeServer(sessions: Record<string, { title?: string; parentID?: string }>) {
  const handlers = new Map<string, Set<Handler>>()
  const runtime = {
    bus: {
      on(type: string, handler: Handler) {
        const set = handlers.get(type) ?? new Set<Handler>()
        set.add(handler)
        handlers.set(type, set)
        return () => set.delete(handler)
      },
    },
    sessions: {
      state: { sessions: Object.fromEntries(Object.entries(sessions).map(([id, row]) => [id, { id, ...row }])) },
    },
    data: { session: { get: (id: string) => sessions[id] } },
    team: { placeOf: () => undefined },
  } as unknown as ServerRuntime
  const emit = (type: string, sessionID: string) =>
    handlers.get(type)?.forEach((handler) => handler({ data: { sessionID } }))
  return { runtime, emit, listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0) }
}

function setup(
  options: {
    readonly capability?: OsNotifications
    readonly hidden?: boolean
    readonly focused?: boolean
    readonly route?: Route
    readonly notify?: boolean
  } = {},
) {
  const server = fakeServer({
    ses_a: { title: "계정 라우터 RPC 설계" },
    ses_child: { title: "subagent", parentID: "ses_a" },
    ses_untitled: {},
  })
  const data = {
    servers: { list: () => [{ key: "local" }] },
    get: (key: string) => (key === "local" ? server.runtime : undefined),
  } as unknown as DataLayer
  const sent: HostNotification[] = []
  const opened: string[] = []
  const state = { hidden: options.hidden ?? true, focused: options.focused ?? false }
  const dispose = createRoot((dispose) => {
    createTurnNotifier({
      data,
      capability: options.capability ?? "native",
      notify: options.notify === false ? undefined : (input) => sent.push(input),
      hidden: () => state.hidden,
      focused: () => state.focused,
      route: () => options.route ?? { name: "home" },
      locale: () => "ko",
      open: (serverKey, sessionID) => opened.push(`${serverKey}/${sessionID}`),
    })
    return dispose
  })
  return { ...server, sent, opened, state, dispose }
}

describe("when a turn end notifies (03 §9)", () => {
  const base = { capability: "native" as const, available: true, hidden: false, focused: false, onScreen: false }
  test("hidden window: always, even for the session on screen", () => {
    expect(shouldNotifyTurn({ ...base, hidden: true, onScreen: true, focused: true })).toBe(true)
  })
  test("visible, another app in front: only for sessions not on screen", () => {
    expect(shouldNotifyTurn({ ...base })).toBe(true)
    expect(shouldNotifyTurn({ ...base, onScreen: true })).toBe(false)
  })
  test("visible and focused: never (the user sees the sidebar mark)", () => {
    expect(shouldNotifyTurn({ ...base, focused: true })).toBe(false)
  })
  test("no capability or no notify: never", () => {
    expect(shouldNotifyTurn({ ...base, hidden: true, capability: "none" })).toBe(false)
    expect(shouldNotifyTurn({ ...base, hidden: true, available: false })).toBe(false)
  })
})

describe("turn notifier", () => {
  test("a finished turn of a top-level session, window hidden: title, tag, click opens it", () => {
    const run = setup()
    run.emit("session.execution.succeeded", "ses_a")
    expect(run.sent).toHaveLength(1)
    expect(run.sent[0]).toMatchObject({ title: "계정 라우터 RPC 설계 — 응답 완료", tag: "own:turn:local:ses_a" })
    expect(run.sent[0]?.body).toBeUndefined()
    run.sent[0]?.onClick?.()
    expect(run.opened).toEqual(["local/ses_a"])
    run.dispose()
  })

  test("failed turns say so; untitled sessions get a name", () => {
    const run = setup()
    run.emit("session.execution.failed", "ses_a")
    run.emit("session.execution.succeeded", "ses_untitled")
    expect(run.sent.map((item) => item.title)).toEqual([
      "계정 라우터 RPC 설계 — 응답 실패",
      "제목 없는 대화 — 응답 완료",
    ])
    run.dispose()
  })

  test("subagent turns, interruptions and turns the user can see do not notify", () => {
    const run = setup({
      hidden: false,
      focused: false,
      route: { name: "session", serverKey: "local", sessionID: "ses_a" },
    })
    run.emit("session.execution.succeeded", "ses_child")
    run.emit("session.execution.interrupted", "ses_a")
    run.emit("session.execution.succeeded", "ses_a")
    expect(run.sent).toHaveLength(0)
    // Another session than the one on screen, with another app in front: notified.
    run.emit("session.execution.succeeded", "ses_untitled")
    expect(run.sent).toHaveLength(1)
    run.dispose()
  })

  test("focused visible window: nothing", () => {
    const run = setup({ hidden: false, focused: true })
    run.emit("session.execution.succeeded", "ses_a")
    expect(run.sent).toHaveLength(0)
    run.dispose()
  })

  test("no OS notifications on this host: no listeners at all", () => {
    const run = setup({ capability: "none" })
    expect(run.listeners()).toBe(0)
    run.dispose()
    const none = setup({ notify: false })
    expect(none.listeners()).toBe(0)
    none.dispose()
  })

  test("disposing the shell removes the listeners", () => {
    const run = setup()
    expect(run.listeners()).toBe(2)
    run.dispose()
    expect(run.listeners()).toBe(0)
  })
})

describe("strings", () => {
  test("English and Korean", () => {
    expect(turnText("en", "own.notify.turn.succeeded", { session: "Refactor" })).toBe("Refactor — response ready")
    expect(turnText("ko", "own.notify.turn.failed", { session: "리팩터" })).toBe("리팩터 — 응답 실패")
  })
})

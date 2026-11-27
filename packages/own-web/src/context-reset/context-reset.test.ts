// 문맥 비우기 (03 §18.18, 11 §7, core P-035): the marker's states, which rows are before the active reset (by position,
// not id), the fold, what an undo would cost and when it asks, the actions' toasts and requests (idle, busy, staged
// revert, already fresh, subagent, an old server; the toast follows whether the server still holds the reset;
// `중단하고 지금 비우기` steers what was sent after it; `/compact` behind it), and the `⋯` items. Every message and
// server here is fake.
import { describe, expect, test } from "bun:test"
import type { SessionInboxInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { ServerRuntime } from "@/data"
import type { ToastInput } from "@/switcher/toast"
import { RESET_HELD } from "@/composer/send"
import { compactBehindReset, problem, released, resetContext, undoReset } from "./actions"
import { foldedView, isFolded, setFold, unfoldSession } from "./fold"
import { resetMenuItems } from "./menu"
import {
  activeReset,
  beforeReset,
  hasContext,
  justReset,
  markerState,
  pendingReset,
  turnsBefore,
  undoCost,
} from "./model"
import { resetKo, resetText } from "./strings"

const MODEL = { providerID: "own-codex-a1", id: "gpt-5.6-sol" }
const user = (id: string, text = "요청") => ({ id, type: "user", text, time: { created: 1 } }) as SessionMessageInfo
const step = (id: string, input = 0, read = 0, output = 0) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: MODEL,
    content: [],
    tokens: { input, output, reasoning: 0, cache: { read, write: 0 } },
    time: { created: 1, completed: 2 },
  }) as unknown as SessionMessageInfo
/** A reset marker; core keeps the instruction epoch it ended (`baseline`) until a revert or a fork drops it. */
const reset = (id: string, undone?: number, baseline: boolean = true) =>
  ({
    id,
    type: "compaction",
    status: "completed",
    reason: "reset",
    summary: "",
    recent: "",
    time: { created: 5 },
    ...(undone === undefined ? {} : { undone }),
    ...(baseline ? { baseline: { epochStart: 1, values: {} } } : {}),
  }) as SessionMessageInfo
const summary = (id: string) =>
  ({
    id,
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "## 요약",
    recent: "",
    time: { created: 6 },
  }) as SessionMessageInfo

describe("model", () => {
  test("a reset is active while it is the newest boundary; a later compaction blocks it, a later reset supersedes it", () => {
    const history = [user("msg_1"), step("msg_2"), reset("msg_3"), user("msg_4"), step("msg_5")]
    expect(markerState(history, "msg_3")).toBe("active")
    expect(activeReset(history)?.id).toBe("msg_3")
    expect(markerState([...history, summary("msg_6")], "msg_3")).toBe("blocked")
    expect(markerState([...history, reset("msg_6"), user("msg_7")], "msg_3")).toBe("superseded")
    expect(markerState([user("msg_1"), reset("msg_3", 9), user("msg_4")], "msg_3")).toBe("undone")
    // An undone reset is no boundary: the one before it is active again (last in, first out).
    const twice = [user("msg_1"), reset("msg_2"), user("msg_3"), reset("msg_4", 9), user("msg_5")]
    expect(activeReset(twice)?.id).toBe("msg_2")
    expect(markerState(twice, "msg_2")).toBe("active")
  })

  test("the rows before the active reset are found by position: a steer with a larger id delivered first counts", () => {
    // `msg_9` was steered in while the turn ran, after the reset's id was made at admission, and delivered first.
    const history = [user("msg_1"), step("msg_2"), user("msg_9"), step("msg_10"), reset("msg_5"), user("msg_11")]
    expect([...beforeReset(history)]).toEqual(["msg_1", "msg_2", "msg_9", "msg_10"])
    expect(turnsBefore(history)).toBe(2)
    expect(beforeReset([user("msg_1"), reset("msg_2", 9), user("msg_3")]).size).toBe(0)
    expect(beforeReset([user("msg_1"), summary("msg_2"), user("msg_3")]).size).toBe(0)
  })

  test("nothing to reset right after one, a reset waits in the inbox, /undo right after it asks", () => {
    expect(hasContext([user("msg_1"), reset("msg_2")])).toBe(false)
    expect(hasContext([user("msg_1"), reset("msg_2"), user("msg_3")])).toBe(true)
    expect(hasContext([])).toBe(false)
    expect(justReset([user("msg_1"), reset("msg_2")])).toBe(true)
    expect(justReset([user("msg_1"), reset("msg_2"), user("msg_3")])).toBe(false)
    const pending = [
      { id: "msg_7", type: "user", delivery: "queue" },
      { id: "msg_8", type: "reset", delivery: "queue" },
    ] as unknown as SessionInboxInfo[]
    expect(pendingReset(pending)?.id).toBe("msg_8")
  })

  test("an undo costs the size before the reset plus what came after; it asks at the compaction point or a cold cache", () => {
    const history = [user("msg_1"), step("msg_2", 2_000, 98_000, 1_000), reset("msg_3"), user("msg_4")]
    history.push(step("msg_5", 12_000, 0, 500), user("msg_6"), step("msg_7", 1_000, 14_000, 500))
    // 101k before, then 15.5k − 12k = 3.5k added after the reset.
    expect(undoCost({ messages: history, resetID: "msg_3", now: 1_000 })).toEqual({ tokens: 104_500 })
    expect(undoCost({ messages: history, resetID: "msg_3", trigger: 100_000, now: 1_000 })).toEqual({
      tokens: 104_500,
      ask: "compacts",
    })
    // The part before the reset was last sent at 1; a 5-minute cache is long cold 10 minutes later, not after a minute.
    expect(undoCost({ messages: history, resetID: "msg_3", trigger: 200_000, lifetime: 300_000, now: 60_000 })).toEqual(
      {
        tokens: 104_500,
      },
    )
    expect(
      undoCost({ messages: history, resetID: "msg_3", trigger: 200_000, lifetime: 300_000, now: 600_000 }),
    ).toEqual({
      tokens: 100_000,
      ask: "cold",
      why: "lifetime",
    })
    expect(undoCost({ messages: [user("msg_1"), reset("msg_3")], resetID: "msg_3", now: 1 })).toBeUndefined()
  })

  test("an undo that cannot restore the earlier prefix byte for byte asks as a cache rewrite (11 §7.3)", () => {
    const before = [user("msg_1"), step("msg_2", 2_000, 98_000, 1_000)]
    // A revert or a fork since dropped the epoch the reset ended: the system and the updates before it come back changed.
    expect(undoCost({ messages: [...before, reset("msg_3", undefined, false)], resetID: "msg_3", now: 1 })).toEqual({
      tokens: 100_000,
      ask: "cold",
      why: "baseline",
    })
    // Past Anthropic's 20-block lookback the tail breakpoint no longer reaches the earlier cache entry.
    const tool = { type: "tool", name: "shell" }
    const long = { ...step("msg_5"), content: Array.from({ length: 10 }, () => tool) } as unknown as SessionMessageInfo
    const after = [...before, reset("msg_3"), user("msg_4"), long]
    expect(undoCost({ messages: after, resetID: "msg_3", lookback: 20, now: 1 })).toMatchObject({ why: "lookback" })
    expect(undoCost({ messages: after, resetID: "msg_3", lookback: 21, now: 1 })).toEqual({ tokens: 101_000 })
    expect(undoCost({ messages: after, resetID: "msg_3", now: 1 })).toEqual({ tokens: 101_000 })
  })
})

describe("fold", () => {
  test("folding leaves the turns before the active reset out; the session's find unfolds them", () => {
    const history = [user("msg_1"), step("msg_2"), reset("msg_3"), user("msg_4")]
    expect(foldedView("local", "ses_1", history)).toBe(history)
    setFold("local", "ses_1", "msg_3", true)
    expect(isFolded("local", "ses_1", "msg_3")).toBe(true)
    expect(foldedView("local", "ses_1", history).map((message) => message.id)).toEqual(["msg_3", "msg_4"])
    expect(foldedView("local", "ses_2", history)).toBe(history)
    unfoldSession("local", "ses_1")
    expect(foldedView("local", "ses_1", history)).toBe(history)
  })
})

describe("strings", () => {
  test("the cheap undo says 되돌리기, never 복원 (03 §18.7); every key has an English text", () => {
    expect(resetKo["own.reset.undo"]).toBe("되돌리기")
    for (const [key, text] of Object.entries(resetKo))
      if (key !== "own.reset.undoTurn" && key !== "own.reset.revertStaged" && key !== "own.reset.undoRevert")
        expect(text).not.toContain("복원")
    for (const key of Object.keys(resetKo) as (keyof typeof resetKo)[])
      if (key !== "own.reset.keywords") expect(resetText.text("en", key)).not.toBe(resetKo[key])
    expect(resetText.text("ko", "own.reset.undoCompacts", { tokens: "120k" })).toContain("120k가")
  })
})

/** A server with the parts the actions read, recording every request. */
function fakeServer(input: {
  readonly messages?: SessionMessageInfo[]
  readonly pending?: SessionInboxInfo[]
  readonly running?: boolean
  /** The server still holds the reset after admitting it (a turn runs); by default as `running`. */
  readonly waiting?: boolean
  readonly revert?: boolean
  readonly child?: boolean
  readonly team?: boolean
  readonly fail?: Error
  readonly cache?: Record<string, unknown>
  readonly accounts?: Record<string, unknown>
  /** Background jobs of the session still running: shells and subagent conversations. */
  readonly shells?: ReadonlyArray<{ readonly id: string; readonly command: string }>
  readonly children?: ReadonlyArray<{ readonly id: string; readonly title: string }>
}) {
  const calls: Array<{ method: string; input: unknown }> = []
  const toasts: ToastInput[] = []
  const dismissed: number[] = []
  const handlers: Array<{ type: string; handler: (event: unknown) => void }> = []
  /** What the server's inbox holds now; `pending` by default, else the reset while it waits. */
  const inbox = {
    items: (input.pending ??
      ((input.waiting ?? input.running) ? [{ id: "msg_reset", type: "reset", delivery: "queue" }] : [])) as unknown[],
  }
  const record = (method: string) => async (body: unknown) => {
    calls.push({ method, input: body })
    if (input.fail) throw input.fail
    return method === "reset.create" ? { id: "msg_reset", type: "reset", delivery: "queue" } : undefined
  }
  const runtime = {
    client: () => ({
      session: {
        reset: { create: record("reset.create"), undo: record("reset.undo") },
        inbox: { list: async () => inbox.items, update: record("inbox.update") },
        interrupt: record("interrupt"),
        wait: record("wait"),
      },
      shell: { remove: record("shell.remove") },
    }),
    data: {
      session: {
        get: (id: string) => {
          const child = input.children?.find((item) => item.id === id)
          if (child) return { id, parentID: "ses_1", title: child.title }
          return {
            id: "ses_1",
            location: { directory: "/w" },
            ...(input.revert ? { revert: { messageID: "msg_1" } } : {}),
            ...(input.child ? { parentID: "ses_0" } : {}),
          }
        },
        family: () => ["ses_1", ...(input.children ?? []).map((child) => child.id)],
        status: (id: string) => (input.running || id !== "ses_1" ? "running" : "idle"),
        message: { list: () => input.messages ?? [user("msg_1")], sync: async () => undefined },
        pending: { list: () => input.pending ?? [] },
        prompt: record("prompt"),
      },
      shell: {
        listBySession: () => (input.shells ?? []).map((shell) => ({ ...shell, status: "running", metadata: {} })),
        get: () => undefined,
      },
    },
    key: "local",
    bus: {
      on: (type: string, handler: (event: unknown) => void) => {
        const entry = { type, handler }
        handlers.push(entry)
        return () => void handlers.splice(handlers.indexOf(entry), 1)
      },
    },
    own: { state: { cache: input.cache ?? {}, accounts: input.accounts ?? {} } },
    team: { areaOfSession: () => (input.team ? { teamID: "t", areaID: "a" } : undefined) },
    rpc: { can: () => true },
  } as unknown as ServerRuntime
  return {
    runtime,
    calls,
    toasts,
    dismissed,
    inbox,
    /** A server event, as the runtime's bus hands it on. */
    emit: (type: string, data: unknown) =>
      handlers.filter((entry) => entry.type === type).forEach((entry) => entry.handler({ type, data })),
    deps: {
      runtime,
      sessionID: "ses_1",
      locale: "ko" as const,
      toast: (toast: ToastInput) => toasts.push(toast) - 1,
      dismiss: (id: number) => void dismissed.push(id),
    },
  }
}

describe("actions", () => {
  test("idle: the reset is admitted and the toast offers 되돌리기 for 8 s; a team says its state stays", async () => {
    const server = fakeServer({})
    await resetContext(server.deps)
    expect(server.calls).toEqual([{ method: "reset.create", input: { sessionID: "ses_1" } }])
    expect(server.toasts).toMatchObject([
      { message: resetKo["own.reset.done"], action: { label: "되돌리기" }, duration: 8_000 },
    ])
    server.toasts[0]!.action!.run()
    await Bun.sleep(0)
    expect(server.calls.at(-1)).toEqual({ method: "reset.undo", input: { sessionID: "ses_1", resetID: "msg_reset" } })

    const team = fakeServer({ team: true })
    await resetContext(team.deps)
    expect(team.toasts[0]?.message).toBe(resetKo["own.reset.doneTeam"])
  })

  test("background jobs still running are listed after the reset, and the toast stops them (03 §18.18)", async () => {
    const server = fakeServer({
      shells: [{ id: "shl_1", command: "bun run build" }],
      children: [{ id: "ses_2", title: "테스트 돌리기" }],
    })
    await resetContext(server.deps)
    expect(server.toasts).toHaveLength(2)
    expect(server.toasts[1]).toMatchObject({
      message:
        "백그라운드 작업 2개가 아직 돌아요: bun run build, 테스트 돌리기 · 비우기 전 일이라 끝나도 턴을 시작하지 않아요",
      action: { label: "작업 멈추기" },
    })
    server.toasts[1]!.action!.run()
    await Bun.sleep(0)
    expect(server.calls.slice(1)).toEqual([
      { method: "shell.remove", input: { id: "shl_1", location: { directory: "/w" } } },
      { method: "interrupt", input: { sessionID: "ses_2" } },
    ])
  })

  test("busy: it waits for the turn, the toast offers to stop it now; `/reset-context <text>` queues the text after it", async () => {
    const queued = (id: string, text: string) => ({ id, type: "user", delivery: "queue", payload: { text } })
    const server = fakeServer({
      running: true,
      pending: [
        queued("msg_before", "앞에 둔 질문"),
        { id: "msg_reset", type: "reset", delivery: "queue" },
        queued("msg_text", "다음 작업"),
        queued("msg_later", "기다리는 동안 보낸 질문"),
      ] as unknown as SessionInboxInfo[],
    })
    await resetContext({ ...server.deps, text: "다음 작업" })
    expect(server.calls.map((call) => call.method)).toEqual(["reset.create", "prompt"])
    expect(server.calls[1]?.input).toEqual({ sessionID: "ses_1", text: "다음 작업", delivery: "queue" })
    expect(server.toasts[0]).toMatchObject({
      message: resetKo["own.reset.queued"],
      action: { label: "중단하고 지금 비우기" },
    })
    // A stop keeps queued prompts parked (core, upstream): what was sent after the reset is steered to run now in the
    // new context; the prompt queued before it stays parked.
    server.toasts[0]!.action!.run()
    await Bun.sleep(0)
    expect(server.calls.slice(2)).toEqual([
      { method: "inbox.update", input: { sessionID: "ses_1", inboxID: "msg_text", delivery: "steer" } },
      { method: "inbox.update", input: { sessionID: "ses_1", inboxID: "msg_later", delivery: "steer" } },
      { method: "interrupt", input: { sessionID: "ses_1", resume: true } },
    ])
  })

  test("중단하고 지금 비우기 stops nothing once the reset applied; the waiting toast closes when it applies", async () => {
    const server = fakeServer({ running: true })
    await resetContext(server.deps)
    expect(server.toasts[0]).toMatchObject({ message: resetKo["own.reset.queued"] })
    // The turn ended meanwhile: the reset applied, and the turn running now is the new context's own.
    server.inbox.items = []
    server.toasts[0]!.action!.run()
    await Bun.sleep(0)
    expect(server.calls.map((call) => call.method)).toEqual(["reset.create"])
    server.emit("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_other" })
    expect(server.dismissed).toEqual([])
    server.emit("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_reset" })
    expect(server.dismissed).toEqual([0])
  })

  test("the toast says what the server did with the reset, not what this window thought", async () => {
    // The turn ended before the reset arrived: it was applied at once.
    const ended = fakeServer({ running: true, waiting: false })
    await resetContext(ended.deps)
    expect(ended.toasts[0]).toMatchObject({ message: resetKo["own.reset.done"], action: { label: "되돌리기" } })
    // A turn started meanwhile (another client): the reset waits for it.
    const started = fakeServer({ waiting: true })
    await resetContext(started.deps)
    expect(started.toasts[0]).toMatchObject({ message: resetKo["own.reset.queued"] })
  })

  test("a cancelled reset steers what the composer queued only because it waited; the rest stays queued", async () => {
    const server = fakeServer({ running: true })
    const queued = (id: string, held?: boolean) => ({
      id,
      type: "user",
      delivery: "queue",
      payload: { text: id, ...(held === undefined ? {} : { metadata: { [RESET_HELD]: held, displayText: id } }) },
    })
    // What data/server.ts hands on: the reset and what was pending behind it when it was cancelled.
    const after = [
      { id: "msg_reset", type: "reset", delivery: "queue" },
      queued("msg_held", true),
      queued("msg_text"),
      queued("msg_other", false),
      { ...queued("msg_steer", true), delivery: "steer" },
      { id: "msg_notice", type: "synthetic", delivery: "steer", payload: { text: "done" } },
      queued("msg_held_2", true),
    ] as unknown as SessionInboxInfo[]
    await released(server.runtime.client, "ses_1", after)
    expect(server.calls).toEqual([
      { method: "inbox.update", input: { sessionID: "ses_1", inboxID: "msg_held", delivery: "steer" } },
      { method: "inbox.update", input: { sessionID: "ses_1", inboxID: "msg_held_2", delivery: "steer" } },
    ])
    // A steer the server refuses (delivered meanwhile) fails nothing else.
    const refused = fakeServer({ running: true, fail: new Error("409") })
    expect(await released(refused.runtime.client, "ses_1", after)).toMatchObject([
      { status: "rejected" },
      { status: "rejected" },
    ])
  })

  test("/compact behind a waiting reset admits nothing and offers to cancel the reset, then compacts", async () => {
    const server = fakeServer({ running: true })
    let compacted = 0
    compactBehindReset({ ...server.deps, resetID: "msg_reset", compact: () => void compacted++ })
    expect(server.calls).toEqual([])
    expect(server.toasts[0]).toMatchObject({
      message: "문맥 비우기가 기다리고 있어서 압축하지 않아요 · 비운 뒤에는 압축할 것이 없어요",
      action: { label: "비우기 취소하고 압축" },
    })
    server.toasts[0]!.action!.run()
    await Bun.sleep(0)
    expect(server.calls).toEqual([{ method: "reset.undo", input: { sessionID: "ses_1", resetID: "msg_reset" } }])
    expect(compacted).toBe(1)
  })

  test("a staged revert asks first; nothing after the boundary, a subagent conversation and an old server say so", async () => {
    const staged = fakeServer({ revert: true })
    await resetContext(staged.deps)
    expect(staged.calls).toEqual([])
    expect(staged.toasts[0]).toMatchObject({
      message: resetKo["own.reset.revertStaged"],
      action: { label: "그래도 비우기" },
    })
    staged.toasts[0]!.action!.run()
    await Bun.sleep(0)
    expect(staged.calls.map((call) => call.method)).toEqual(["reset.create"])

    const fresh = fakeServer({ messages: [user("msg_1"), reset("msg_2")] })
    await resetContext(fresh.deps)
    expect(fresh.calls).toEqual([])
    expect(fresh.toasts[0]?.message).toBe(resetKo["own.reset.already"])

    const child = fakeServer({ child: true })
    await resetContext(child.deps)
    expect(child.calls).toEqual([])
    expect(child.toasts[0]?.message).toBe(resetKo["own.reset.child"])

    const old = Object.assign(new Error("UnsupportedContentType: text/plain"), {
      name: "ClientError",
      reason: "UnsupportedContentType",
    })
    expect(problem(old)).toBe("own.reset.unsupported")
    const status = (code: number) =>
      Object.assign(new Error(`UnexpectedStatus: ${code}`), {
        name: "ClientError",
        reason: "UnexpectedStatus",
        cause: { status: code },
      })
    expect([404, 405, 401, 403, 500, 502, 504, 409].map((code) => problem(status(code)))).toEqual([
      "own.reset.unsupported",
      "own.reset.unsupported",
      "own.reset.forbidden",
      "own.reset.forbidden",
      "own.reset.offline",
      "own.reset.offline",
      "own.reset.offline",
      undefined,
    ])
    expect(problem(Object.assign(new Error("x"), { name: "ClientError", reason: "Transport" }))).toBe(
      "own.reset.offline",
    )
    expect(problem(Object.assign(new Error("Conflict"), { name: "ConflictError" }))).toBeUndefined()
    const denied = fakeServer({ fail: status(403) })
    await resetContext(denied.deps)
    expect(denied.toasts[0]).toMatchObject({ message: resetKo["own.reset.forbidden"], tone: "danger" })
    const outdated = fakeServer({ fail: old })
    await resetContext(outdated.deps)
    expect(outdated.toasts[0]).toMatchObject({ message: resetKo["own.reset.unsupported"], tone: "danger" })
  })

  test("undo: a pending reset is cancelled; a running turn and a costly restore ask first; a later compaction refuses", async () => {
    const pending = fakeServer({
      running: true,
      pending: [{ id: "msg_reset", type: "reset", delivery: "queue" }] as unknown as SessionInboxInfo[],
    })
    await undoReset({ ...pending.deps, resetID: "msg_reset" })
    expect(pending.calls.map((call) => call.method)).toEqual(["reset.undo"])
    expect(pending.toasts[0]?.message).toBe(resetKo["own.reset.cancelled"])

    const busy = fakeServer({ running: true, messages: [user("msg_1"), reset("msg_reset")] })
    await undoReset({ ...busy.deps, resetID: "msg_reset" })
    expect(busy.calls).toEqual([])
    expect(busy.toasts[0]).toMatchObject({
      message: resetKo["own.reset.undoRunning"],
      action: { label: "중단하고 되돌리기" },
    })

    const big = fakeServer({
      messages: [user("msg_1"), step("msg_2", 1_000, 240_000, 1_000), reset("msg_reset"), user("msg_4")],
      cache: {
        ses_1: {
          slots: [{ state: "warm", lastReqAt: 1, warmUntil: Date.now() + 300_000 }],
          compaction: { triggerTokens: 200_000 },
        },
      },
    })
    await undoReset({ ...big.deps, resetID: "msg_reset" })
    expect(big.calls).toEqual([])
    expect(big.toasts[0]?.message).toBe("되돌리면 문맥이 약 242k가 돼서 다음 요청 전에 압축해요")
    big.toasts[0]!.action!.run()
    await Bun.sleep(0)
    expect(big.calls.map((call) => call.method)).toEqual(["reset.undo"])
    expect(big.toasts.at(-1)?.message).toBe(resetKo["own.reset.undone"])

    const superseded = Object.assign(new Error("Context reset cannot be undone (superseded)"), {
      name: "ConflictError",
    })
    const blocked = fakeServer({ messages: [user("msg_1"), reset("msg_reset")], fail: superseded })
    await undoReset({ ...blocked.deps, resetID: "msg_reset" })
    expect(blocked.toasts[0]).toMatchObject({ message: resetKo["own.reset.undoBlocked"], tone: "danger" })
  })
})

describe("⋯ items", () => {
  test("문맥 비우기 after the compactions item, its undo while a reset is the boundary, a note when fresh or waiting", () => {
    const items = (server: ReturnType<typeof fakeServer>) =>
      resetMenuItems({ runtime: server.runtime, sessionID: "ses_1", locale: "ko" }).map((item) =>
        item === "separator" ? item : "label" in item ? item.label : `note:${item.note}`,
      )
    expect(items(fakeServer({}))).toEqual(["문맥 비우기"])
    expect(items(fakeServer({ messages: [user("msg_1"), reset("msg_2")] }))).toEqual([
      `note:${resetKo["own.reset.already"]}`,
      "문맥 비우기 되돌리기",
    ])
    expect(items(fakeServer({ messages: [user("msg_1"), reset("msg_2"), user("msg_3")] }))).toEqual([
      "문맥 비우기",
      "문맥 비우기 되돌리기",
    ])
    expect(
      items(
        fakeServer({ pending: [{ id: "msg_9", type: "reset", delivery: "queue" }] as unknown as SessionInboxInfo[] }),
      ),
    ).toEqual([`note:${resetKo["own.reset.queued"]}`])
    expect(items(fakeServer({ child: true }))).toEqual([])
  })
})

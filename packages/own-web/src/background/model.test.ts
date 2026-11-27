// Background jobs, pure part (03 §19.7): history scan, task collection, finish decision, terminal text.
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  backgroundedInHistory,
  collectTasks,
  elapsedMinutes,
  runningItems,
  runningLabel,
  scanHistory,
  shellDone,
  shortLabel,
  wasBackground,
  type ShellView,
} from "./model"
import { tail, terminalText } from "./terminal-text"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Part = Assistant["content"][number]

function assistant(id: string, content: Part[], completed = true): Assistant {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5.5" },
    time: { created: 1, completed: completed ? 2 : undefined },
    content,
  }
}

function tool(id: string, name: string, state: Extract<Part, { type: "tool" }>["state"]): Part {
  return { type: "tool", id, name, state, time: { created: 1 } }
}

const backgroundedShell = (partID: string, shellID: string, command: string) =>
  tool(partID, "shell", {
    status: "completed",
    input: { command },
    content: [{ type: "text", text: "moved" }],
    metadata: { status: "running", shellID },
  })

const backgroundedSubagent = (partID: string, sessionID: string, description: string) =>
  tool(partID, "subagent", {
    status: "completed",
    input: { description, agent: "general" },
    content: [{ type: "text", text: "working" }],
    metadata: { status: "running", sessionID },
  })

function synthetic(id: string, metadata: Record<string, string>): SessionMessageInfo {
  return { id, type: "synthetic", text: "done", time: { created: 3 }, metadata }
}

function shell(id: string, sessionID: string, command: string, extra: Record<string, unknown> = {}): ShellView {
  return { id, status: "running", command, metadata: { sessionID, ...extra }, time: { started: 1_000 } }
}

describe("scanHistory", () => {
  test("backgrounded tools stay until their completion notice arrives", () => {
    const messages = [
      assistant("m1", [
        backgroundedShell("p1", "sh_1", "bun run build"),
        backgroundedShell("p2", "sh_2", "bun dev"),
        backgroundedSubagent("p3", "ses_child", "라우터 조사"),
      ]),
      synthetic("s1", { source: "shell", shellID: "sh_1", jobID: "sh_1" }),
    ]
    const history = scanHistory(messages)
    expect(history.shells.map((task) => task.id)).toEqual(["sh_2"])
    expect(history.subagents).toEqual([{ id: "ses_child", kind: "subagent", label: "라우터 조사", agent: "general" }])
    expect(scanHistory([...messages, synthetic("s2", { source: "subagent", childID: "ses_child" })]).subagents).toEqual(
      [],
    )
  })

  test("blocking: running shell/subagent tools of the unfinished assistant message", () => {
    const history = scanHistory([
      assistant("m1", [backgroundedShell("p1", "sh_1", "old")]),
      assistant(
        "m2",
        [
          tool("p2", "shell", { status: "running", input: { command: "bun test" }, metadata: { shellID: "sh_9" } }),
          tool("p3", "read", { status: "running", input: { path: "a" }, metadata: {} }),
        ],
        false,
      ),
    ])
    expect(history.blocking).toEqual([{ kind: "shell", partID: "p2", id: "sh_9", label: "bun test" }])
  })

  test("no unfinished message, no blocking tool", () => {
    expect(scanHistory([assistant("m1", [backgroundedShell("p1", "sh_1", "x")])]).blocking).toEqual([])
  })
})

describe("collectTasks", () => {
  const base = { sessionID: "ses_1", children: [], shells: [] }

  test("running shells of the session, minus the blocking one (by id or by command)", () => {
    const history = scanHistory([
      assistant(
        "m1",
        [tool("p1", "shell", { status: "running", input: { command: "bun test" }, metadata: {} })],
        false,
      ),
    ])
    const tasks = collectTasks({
      ...base,
      history,
      shells: [
        shell("sh_a", "ses_1", "bun test"),
        shell("sh_b", "ses_1", "bun dev", { background: true }),
        shell("sh_c", "ses_other", "ls"),
        shell("sh_d", "ses_1", "git commit", { source: "own.git" }),
      ],
    })
    expect(tasks.map((task) => task.id)).toEqual(["sh_b"])
    expect(tasks[0]!.started).toBe(1_000)
  })

  test("running children that are not the blocking subagent", () => {
    const history = scanHistory([
      assistant(
        "m1",
        [
          tool("p1", "subagent", {
            status: "running",
            input: { description: "앞 작업" },
            metadata: { sessionID: "ses_fg" },
          }),
        ],
        false,
      ),
    ])
    const tasks = collectTasks({
      ...base,
      history,
      children: [
        { id: "ses_fg", title: "앞 작업", running: true },
        { id: "ses_bg", title: "뒤 작업", running: true },
        { id: "ses_idle", title: "끝난 작업", running: false },
      ],
    })
    expect(tasks.map((task) => task.id)).toEqual(["ses_bg"])
  })

  test("a backgrounded shell the synced list no longer has is gone; unknown stays", () => {
    const history = scanHistory([assistant("m1", [backgroundedShell("p1", "sh_1", "bun run build")])])
    expect(collectTasks({ ...base, history, shellRunning: () => false })).toEqual([])
    expect(collectTasks({ ...base, history, shellRunning: () => undefined }).map((task) => task.id)).toEqual(["sh_1"])
  })

  test("history and live list merge by id; the live list supplies the start time", () => {
    const history = scanHistory([assistant("m1", [backgroundedShell("p1", "sh_1", "bun run build")])])
    const tasks = collectTasks({ ...base, history, shells: [shell("sh_1", "ses_1", "bun run build")] })
    expect(tasks).toEqual([{ id: "sh_1", kind: "shell", label: "bun run build", started: 1_000 }])
  })
})

describe("finish decision", () => {
  test("background when listed, a user shell, backgrounded in history, or the turn is over", () => {
    const meta = { sessionID: "ses_1" }
    expect(wasBackground({ metadata: meta, listed: false, inHistory: false, sessionIdle: false })).toBe(false)
    expect(wasBackground({ metadata: meta, listed: true, inHistory: false, sessionIdle: false })).toBe(true)
    expect(wasBackground({ metadata: meta, listed: false, inHistory: true, sessionIdle: false })).toBe(true)
    expect(wasBackground({ metadata: meta, listed: false, inHistory: false, sessionIdle: true })).toBe(true)
    expect(
      wasBackground({ metadata: { ...meta, background: true }, listed: false, inHistory: false, sessionIdle: false }),
    ).toBe(true)
    expect(wasBackground({ metadata: {}, listed: true, inHistory: true, sessionIdle: true })).toBe(false)
    expect(
      wasBackground({ metadata: { ...meta, source: "own.git" }, listed: true, inHistory: true, sessionIdle: true }),
    ).toBe(false)
  })

  test("backgroundedInHistory matches the tool kind and id", () => {
    const messages = [assistant("m1", [backgroundedShell("p1", "sh_1", "x"), backgroundedSubagent("p2", "ses_c", "y")])]
    expect(backgroundedInHistory(messages, "shell", "sh_1")).toBe(true)
    expect(backgroundedInHistory(messages, "shell", "ses_c")).toBe(false)
    expect(backgroundedInHistory(messages, "subagent", "ses_c")).toBe(true)
  })

  test("shellDone picks the message and tone", () => {
    expect(shellDone("exited", 0)).toEqual({ key: "own.background.done.shell", tone: "neutral" })
    expect(shellDone("exited", 2)).toEqual({ key: "own.background.done.shell", tone: "danger" })
    expect(shellDone("exited", undefined).key).toBe("own.background.done.shellNoCode")
    expect(shellDone("killed", undefined).key).toBe("own.background.done.killed")
    expect(shellDone("timeout", 1)).toEqual({ key: "own.background.done.timeout", tone: "danger" })
  })
})

describe("text helpers", () => {
  test("terminalText strips escapes and keeps the last state of CR-rewritten lines", () => {
    expect(terminalText("\x1b[32mok\x1b[0m\r\nnext")).toBe("ok\nnext")
    expect(terminalText("progress 10%\rprogress 50%\rprogress 100%\ndone")).toBe("progress 100%\ndone")
    expect(terminalText("\x1b]0;title\x07plain")).toBe("plain")
  })

  test("tail keeps the end, from a line boundary when close", () => {
    expect(tail("short", 10)).toEqual({ text: "short", cut: false })
    const long = `${"a".repeat(20)}\n${"b".repeat(5)}`
    expect(tail(long, 10)).toEqual({ text: "bbbbb", cut: true })
  })

  test("shortLabel: one line, collapsed, ellipsis", () => {
    expect(shortLabel("bun   run\tbuild")).toBe("bun run build")
    expect(shortLabel("first line\nsecond")).toBe("first line …")
    expect(shortLabel("x".repeat(60), 10)).toBe(`${"x".repeat(9)}…`)
  })

  test("elapsedMinutes floors and never goes negative", () => {
    expect(elapsedMinutes(undefined, 5)).toBeUndefined()
    expect(elapsedMinutes(0, 179_000)).toBe(2)
    expect(elapsedMinutes(10, 0)).toBe(0)
  })
})

describe("running menu (header, upstream 3a861ff8b0)", () => {
  const agents: Record<string, string> = { ses_child1: "explore", ses_child2: "general" }
  const agentOf = (id: string | undefined) => (id ? agents[id] : undefined)

  test("the step's subagents first, then background subagents, then background shells; foreground shells stay out", () => {
    const items = runningItems(
      [
        { kind: "shell", partID: "prt_fg", id: "sh_fg", label: "bun test" },
        { kind: "subagent", partID: "prt_sa", id: "ses_child1", label: "라우터 조사" },
        { kind: "subagent", partID: "prt_new", label: "막 시작한 조사" },
      ],
      [
        { id: "sh_bg", kind: "shell", label: "bun run dev" },
        { id: "ses_child2", kind: "subagent", label: "문서 정리" },
      ],
      agentOf,
    )
    expect(items.map((item) => [item.key, item.kind, item.agent, item.sessionID, item.target])).toEqual([
      ["ses_child1", "subagent", "explore", "ses_child1", "prt_sa"],
      ["prt_new", "subagent", undefined, undefined, "prt_new"],
      ["ses_child2", "subagent", "general", "ses_child2", "ses_child2"],
      ["sh_bg", "shell", undefined, undefined, "sh_bg"],
    ])
  })

  test("label: 작업 중 for subagents, 실행 중 with a shell, 그 밖에 … in a subagent without the viewed one", () => {
    const subagents = runningItems([], [{ id: "ses_child1", kind: "subagent", label: "a" }], agentOf)
    expect(runningLabel([], undefined, false)).toBeUndefined()
    expect(runningLabel(subagents, "ses_root", false)).toEqual({ key: "own.background.running.working", count: 1 })
    // Viewing the only running subagent: nothing else runs.
    expect(runningLabel(subagents, "ses_child1", true)).toBeUndefined()
    const mixed = runningItems(
      [],
      [
        { id: "ses_child1", kind: "subagent", label: "a" },
        { id: "ses_child2", kind: "subagent", label: "b" },
        { id: "sh_bg", kind: "shell", label: "c" },
      ],
      agentOf,
    )
    expect(runningLabel(mixed, "ses_root", false)).toEqual({ key: "own.background.running.running", count: 3 })
    expect(runningLabel(mixed, "ses_child1", true)).toEqual({ key: "own.background.running.moreRunning", count: 2 })
  })
})

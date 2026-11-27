// Slash commands (03 §18.13): parsing, argument hints, which typed text is a client command, and what the default
// client actions do against a fake runtime (revert confirm before /compact, interrupt confirm before /undo, the
// queue cancelled after a revert, /agent never touching the model, /export to a file name Windows accepts).
import { describe, expect, test } from "bun:test"
import { fakeRuntime } from "@/mentions/testing"
import { createCommandActions, exportFilename, undoTarget, type CommandContext } from "./actions"
import { resetText } from "@/context-reset/strings"
import { argumentHint, CLIENT_COMMANDS, clientCommand, hasArguments, parseSlash } from "./catalog"
import { resolveClient, runClientCommand } from "./run"
import { commandText } from "./strings"
import type { ToastInput } from "@/switcher"

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe("catalog", () => {
  test("parseSlash splits the name and the arguments", () => {
    expect(parseSlash("/review main")).toEqual({ name: "review", args: "main" })
    expect(parseSlash("/init")).toEqual({ name: "init", args: "" })
    expect(parseSlash("/hello  a\n b ")).toEqual({ name: "hello", args: "a\n b" })
    expect(parseSlash("hello")).toBeUndefined()
    expect(parseSlash("/")).toBeUndefined()
  })

  test("argument hints come from […] and <…> in the description", () => {
    expect(argumentHint("review changes [commit|branch|pr], defaults to uncommitted")).toBe("[commit|branch|pr]")
    expect(argumentHint("say hello <name> [loud]")).toBe("<name> [loud]")
    expect(argumentHint("guided AGENTS.md setup")).toBeUndefined()
    expect(argumentHint(undefined)).toBeUndefined()
  })

  test("client commands are the 03 §18.13 list; /undo is worded with 복원, never 되돌리기 (18.7)", () => {
    expect(CLIENT_COMMANDS.map((command): string => command.id).toSorted()).toEqual(
      [
        "agent",
        "btw",
        "compact",
        "export",
        "fork",
        "model",
        "new",
        "redo",
        "reset-context",
        "review",
        "skills",
        "terminal",
        "undo",
      ].toSorted(),
    )
    expect(commandText("ko", "own.command.undo")).toBe("마지막 턴 복원(파일 포함)")
    // 18.7: `되돌리기` is the cheap undo's verb (a context reset's included), `복원` the revert's.
    for (const command of CLIENT_COMMANDS)
      if (command.description !== "own.reset.command" && command.description !== "own.side.command")
        expect(commandText("ko", command.description)).not.toContain("되돌리")
    expect(resetText.text("ko", "own.reset.command")).not.toContain("복원")
  })

  test("/reset-context and its Korean names resolve to the client command, with the text after it", () => {
    for (const name of ["reset-context", "문맥비우기", "맥락비우기"])
      expect(clientCommand(name)?.id).toBe("reset-context")
    expect(parseSlash("/문맥비우기 새 작업 시작")).toEqual({ name: "문맥비우기", args: "새 작업 시작" })
  })

  test("hasArguments: /agent and /skills always; server commands only with a hint", () => {
    const fake = fakeRuntime({
      catalog: {
        commands: [
          { name: "review", description: "x" },
          { name: "hello", description: "hi <name>" },
        ],
      },
    })
    fake.load("command")
    expect(hasArguments(undefined, undefined, "agent")).toBe(true)
    expect(hasArguments(fake.runtime, fake.directory, "hello")).toBe(true)
    expect(hasArguments(fake.runtime, fake.directory, "review")).toBe(true)
    expect(hasArguments(fake.runtime, fake.directory, "compact")).toBe(false)
    expect(hasArguments(fake.runtime, fake.directory, "unknown")).toBe(false)
  })
})

describe("resolveClient", () => {
  test("client names win; /review goes to the server when it has one, else opens the tab here", () => {
    const withReview = fakeRuntime({ catalog: { commands: [{ name: "review" }, { name: "compact" }] } })
    withReview.load("command")
    const context = (runtime = withReview.runtime): CommandContext => ({
      runtime,
      serverKey: "local",
      sessionID: "ses_1",
      directory: "/repo",
    })
    expect(resolveClient("/compact", context())?.command.id).toBe("compact")
    expect(resolveClient("  /agent plan ", context())).toMatchObject({ command: { id: "agent" }, args: "plan" })
    expect(resolveClient("/review", context())).toBeUndefined()
    expect(resolveClient("/init", context())).toBeUndefined()
    expect(resolveClient("hello /compact", context())).toBeUndefined()
    // 18.13: `/reset-context` also answers to its Korean names, with the text after it.
    expect(resolveClient("/문맥비우기 새 작업", context())).toMatchObject({
      command: { id: "reset-context" },
      args: "새 작업",
    })
    expect(resolveClient("/reset-context", context())?.command.id).toBe("reset-context")
    const bare = fakeRuntime({ catalog: { commands: [] } })
    expect(resolveClient("/review", context(bare.runtime))).toBeUndefined()
    bare.load("command")
    expect(resolveClient("/review", context(bare.runtime))?.command.id).toBe("review")
  })
})

function actionsFor(options: Parameters<typeof fakeRuntime>[0] = {}) {
  const fake = fakeRuntime({ session: { id: "ses_1" }, ...options })
  const toasts: ToastInput[] = []
  const routes: unknown[] = []
  const tabs: string[] = []
  const saved: { name: string; size: number }[] = []
  let switcher = 0
  const restored: string[] = []
  const actions = createCommandActions(
    {
      navigate: (route) => void routes.push(route),
      openTab: (tab) => void tabs.push(tab),
      openSwitcher: () => void switcher++,
      host: {
        capabilities: { saveDialog: true } as never,
        files: {
          saveFile: async (input) => {
            saved.push({ name: input.name, size: input.data.size })
            return true
          },
        },
      },
      t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
      text: (key, params) => commandText("ko", key, params),
      toast: (input) => void toasts.push(input),
    },
    { restoreDraft: (text) => void restored.push(text) },
  )
  const context: CommandContext = { runtime: fake.runtime, serverKey: "local", sessionID: "ses_1", directory: "/repo" }
  return { fake, actions, context, toasts, routes, tabs, saved, restored, switcher: () => switcher }
}

describe("client actions", () => {
  test("/compact asks first when a revert is staged (compaction commits it)", async () => {
    const env = actionsFor({ session: { id: "ses_1", revert: { messageID: "m1" } } })
    await env.actions.compact(env.context)
    expect(env.fake.calls.some((call) => call.method === "session.compact")).toBe(false)
    expect(env.toasts[0]?.message).toBe("복원 대기 중 — 압축하면 복원이 확정돼요")
    env.toasts[0]!.action!.run()
    await wait()
    expect(env.fake.calls.find((call) => call.method === "session.compact")?.input).toEqual({ sessionID: "ses_1" })
    expect(env.toasts[1]?.message).toBe("압축을 요청했어요")
  })

  test("/undo stages the last user message with files, cancels the queue and restores the text", async () => {
    const env = actionsFor({
      session: {
        id: "ses_1",
        messages: [
          { id: "u1", type: "user", text: "첫 질문" },
          { id: "a1", type: "assistant" },
          { id: "u2", type: "user", text: "두 번째" },
          { id: "a2", type: "assistant" },
        ],
        pending: [{ id: "q1", type: "user" }],
      },
    })
    await env.actions.undo(env.context)
    expect(env.fake.calls.map((call) => call.method)).toEqual(["session.revert.stage", "session.inbox.cancel"])
    expect(env.fake.calls[0]!.input).toEqual({ sessionID: "ses_1", messageID: "u2", files: true })
    expect(env.restored).toEqual(["두 번째"])
    expect(env.toasts.map((toast) => toast.message)).toEqual([
      "마지막 턴을 복원했어요 · 다음 요청은 캐시를 처음부터 다시 쓸 수 있어요",
      'own.revert.queueDropped:{"n":1}',
    ])
    // Again: one more turn back (before the staged boundary).
    expect(undoTarget(env.fake.runtime, "ses_1")?.id).toBe("u1")
  })

  test("/undo while running asks, then interrupts before staging", async () => {
    const env = actionsFor({
      session: { id: "ses_1", running: true, messages: [{ id: "u1", type: "user", text: "q" }] },
    })
    await env.actions.undo(env.context)
    expect(env.fake.calls).toEqual([])
    expect(env.toasts[0]?.action?.label).toBe("중단하고 복원")
    env.toasts[0]!.action!.run()
    await wait()
    expect(env.fake.calls.map((call) => call.method)).toEqual(["session.interrupt", "session.revert.stage"])
  })

  test("/redo clears a staged revert, and says so when there is none", async () => {
    const env = actionsFor({ session: { id: "ses_1", revert: { messageID: "u1" } } })
    await env.actions.redo(env.context)
    expect(env.fake.calls.map((call) => call.method)).toEqual(["session.revert.clear"])
    await env.actions.redo(env.context)
    expect(env.toasts.map((toast) => toast.message)).toEqual(["복원을 취소했어요", "복원 대기 중인 턴이 없어요"])
  })

  test("/agent switches only the agent (never the model), primary agents only", async () => {
    const env = actionsFor({
      catalog: {
        agents: [
          { id: "build", name: "build", mode: "primary" },
          { id: "plan", name: "Plan", mode: "primary" },
          { id: "explore", name: "explore", mode: "subagent" },
        ],
      },
      session: { id: "ses_1", agent: "build" },
    })
    await env.actions.switchAgent(env.context, "plan")
    await env.actions.switchAgent(env.context, "explore")
    await env.actions.switchAgent(env.context, "PLAN")
    expect(env.fake.calls.filter((call) => call.method.startsWith("session."))).toEqual([
      { method: "session.switchAgent", input: { sessionID: "ses_1", agent: "plan" } },
    ])
    expect(env.toasts.map((toast) => toast.message)).toEqual([
      "에이전트를 Plan으로 바꿨어요".replace("(으)로", "으로"),
      "에이전트 explore를 찾지 못했어요",
      "이미 Plan 에이전트예요",
    ])
  })

  test("/fork opens the fork; /new goes to the same folder; /export saves <title>.json", async () => {
    const env = actionsFor()
    await env.actions.fork(env.context)
    expect(env.routes).toEqual([{ name: "session", serverKey: "local", sessionID: "ses_forked" }])
    env.actions.newSession(env.context)
    expect(env.routes[1]).toEqual({ name: "project", serverKey: "local", projectID: "p1" })
    env.actions.newSession({ ...env.context, sessionID: undefined })
    expect(env.routes[2]).toEqual({ name: "home" })
    await env.actions.exportSession(env.context)
    expect(env.saved[0]?.name).toBe("세션-내보내기.json")
    expect(exportFilename({ id: "ses_x", title: "a/b:c*?" })).toBe("a-b-c.json")
    expect(exportFilename({ id: "ses_x" })).toBe("ses_x.json")
  })

  test("session commands on the new-session screen say they need a session", async () => {
    const env = actionsFor()
    await env.actions.compact({ ...env.context, sessionID: undefined })
    expect(env.toasts[0]?.message).toBe("대화를 연 뒤에 쓸 수 있는 명령이에요")
    expect(env.fake.calls).toEqual([])
  })

  test("runClientCommand dispatches; /agent and /skills without an argument come back as text", () => {
    const env = actionsFor({ catalog: { skills: [{ id: "review-guide", name: "Review guide" }] } })
    env.fake.load("skill")
    const run = (id: (typeof CLIENT_COMMANDS)[number]["id"], args = "") =>
      runClientCommand(
        { command: CLIENT_COMMANDS.find((command) => command.id === id)!, args },
        env.context,
        env.actions,
      )
    expect(run("model")).toBeUndefined()
    expect(env.switcher()).toBe(1)
    expect(run("terminal")).toBeUndefined()
    expect(env.tabs).toEqual(["terminal"])
    expect(run("agent")).toBe("/agent ")
    expect(run("skills")).toBe("/skills ")
    const chips: unknown[] = []
    expect(
      runClientCommand(
        { command: CLIENT_COMMANDS.find((command) => command.id === "skills")!, args: "Review guide" },
        env.context,
        env.actions,
        (chip) => void chips.push(chip),
      ),
    ).toBeUndefined()
    expect(chips).toEqual([{ kind: "skill", id: "review-guide", name: "Review guide" }])
  })

  test("/reset-context without a session asks for one first; the context-reset chunk does the rest", async () => {
    const env = actionsFor()
    await env.actions.resetContext({ ...env.context, sessionID: undefined })
    expect(env.toasts.map((toast) => toast.message)).toEqual([commandText("ko", "own.command.needsSession")])
  })
})

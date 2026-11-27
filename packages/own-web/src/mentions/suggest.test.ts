// The composer suggestion controller against a fake runtime (03 §18.12, §18.13, §12): trigger → lazy engine →
// grouped list, choosing (chips, command text, client commands), the IME orders of 03 §12 (A1, A2, B) with the
// `commitOnly` Enter, rule 9 (no list keys and no remote search while composing), dismissal, and the send path.
import { afterEach, describe, expect, test } from "bun:test"
import { resetText } from "@/context-reset/strings"
import { commandKo } from "@/commands/strings"
import { OwnHarnessRouting } from "@own/protocol/rpc-harness-routing"
import { createRoot } from "solid-js"
import type { CommandActions } from "@/commands/actions"
import type { ImeKeyEvent } from "@/ime/ime-enter"
import { selectionChip } from "./index"
import { requestMention } from "./intents"
import { createComposerSuggest, type ComposerSuggest } from "./suggest"
import { fakeRuntime, type FakeRuntimeOptions } from "./testing"

type KeyInit = Partial<Omit<ImeKeyEvent, "preventDefault">>

function key(init: KeyInit = {}) {
  const event = {
    code: "Enter",
    key: "Enter",
    keyCode: 13,
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
const arrow = (code: "ArrowDown" | "ArrowUp", init: KeyInit = {}) => key({ code, key: code, keyCode: 40, ...init })
const composingEnter = () => key({ key: "Process", keyCode: 229, isComposing: true })
const wait = (ms = 70) => new Promise((resolve) => setTimeout(resolve, ms))

const CATALOG: FakeRuntimeOptions["catalog"] = {
  agents: [
    { id: "build", name: "build", mode: "primary", description: "기본 에이전트" },
    { id: "plan", name: "plan", mode: "primary", description: "계획만 세웁니다" },
    { id: "explore", name: "explore", mode: "subagent", description: "코드 탐색" },
    { id: "general", name: "general", mode: "subagent" },
    { id: "secret", name: "secret", mode: "subagent", hidden: true },
  ],
  commands: [
    { name: "init", description: "guided AGENTS.md setup" },
    { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
    { name: "hello", description: "say hello <name>" },
    { name: "docs:summarize", description: "Summarize a document" },
    { name: "compact", description: "a user command shadowed by the client /compact" },
  ],
  skills: [{ id: "review-guide", name: "Review guide", description: "리뷰 체크리스트" }],
  references: [{ name: "docs", path: "/refs/docs", description: "제품 문서" }],
  resources: [{ server: "wiki", name: "Onboarding", uri: "wiki://page/42" }],
}
const FILES = ["src/router.ts", "src/routes/index.ts", "src/라우터.ts", "docs/"]

const roots: (() => void)[] = []
afterEach(() => {
  roots.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
})

function setup(options: FakeRuntimeOptions & { disabled?: () => boolean; sessionID?: string | null } = {}) {
  const fake = fakeRuntime({ catalog: CATALOG, files: FILES, session: { id: "ses_1" }, ...options })
  const textarea = document.createElement("textarea")
  document.body.append(textarea)
  const log: string[] = []
  const toasts: string[] = []
  const actions: CommandActions = {
    newSession: () => void log.push("new"),
    compact: async () => void log.push("compact"),
    resetContext: async (_context, text) => void log.push(`reset:${text ?? ""}`),
    fork: async () => void log.push("fork"),
    undo: async () => void log.push("undo"),
    redo: async () => void log.push("redo"),
    exportSession: async () => void log.push("export"),
    sideQuestion: (_context, question) => void log.push(`btw:${question}`),
    openSwitcher: () => void log.push("model"),
    switchAgent: async (_context, agent) => void log.push(`agent:${agent}`),
    openTab: (tab) => void log.push(`tab:${tab}`),
    toast: (input) => void toasts.push(input.message),
  }
  const sessionID = options.sessionID === null ? undefined : (options.sessionID ?? "ses_1")
  let suggest!: ComposerSuggest
  createRoot((dispose) => {
    roots.push(dispose)
    suggest = createComposerSuggest({
      element: () => textarea,
      context: () => ({ runtime: fake.runtime, serverKey: "local", sessionID, directory: fake.directory }),
      draftKey: () => `local/${sessionID ?? "home"}`,
      disabled: options.disabled,
      actions,
      locale: () => "ko",
    })
  })
  // What the composer wires: the synthetic `input` of a choice reaches the controller like typing does.
  textarea.addEventListener("input", () => suggest.input())
  textarea.focus()
  suggest.focus()

  const type = async (value: string, caret = value.length) => {
    textarea.value = value
    textarea.setSelectionRange(caret, caret)
    suggest.input()
    await wait()
  }
  /** One IME step: compositionstart once, then the composing text lands in the textarea with an `input`. */
  const compose = (value: string) => {
    textarea.value = value
    textarea.setSelectionRange(value.length, value.length)
    suggest.input()
  }
  const ready = async () => {
    for (let tries = 0; tries < 40 && !suggest.engine(); tries++) await wait(10)
    await wait()
  }
  const labels = () => suggest.items().map((item) => item.label)
  const groups = () =>
    suggest
      .engine()
      ?.groups()
      .map((group) => group.id)
  return { fake, textarea, suggest, log, toasts, type, compose, ready, labels, groups }
}

describe("@ mentions", () => {
  test("groups in 03 §18.12 order; catalogs load on first open, not before", async () => {
    const env = setup()
    expect(env.fake.calls.some((call) => call.method.startsWith("location."))).toBe(false)
    await env.type("@")
    await env.ready()
    expect(env.fake.calls.filter((call) => call.method.startsWith("location.")).map((call) => call.method)).toEqual(
      expect.arrayContaining([
        "location.agent.sync",
        "location.skill.sync",
        "location.reference.sync",
        "location.mcpResource.sync",
      ]),
    )
    await env.type("@")
    expect(env.groups()).toEqual(["agents", "skills", "references", "resources"])
    // Subagents only (primary agents are for /agent), hidden ones never.
    expect(env.labels()).toEqual(["@explore", "@general", "@review-guide", "@docs", "Onboarding"])
    expect(env.suggest.visible()).toBe(true)
  })

  test("files come from fs.find (limit 20, server order), debounced: one request for fast typing", async () => {
    const env = setup()
    await env.type("@")
    await env.ready()
    // Keystrokes with no gap at all: a 10 ms wait between them stretched past the debounce on a loaded PC (one more
    // request for "@r", 2.2.6-own.18 tier), which is slow typing, not what this test is about.
    env.textarea.value = "@r"
    env.suggest.input()
    env.textarea.value = "@ro"
    env.suggest.input()
    await env.type("@rou")
    await wait(120)
    const finds = env.fake.calls.filter((call) => call.method === "file.find")
    // The first open warms the server index with an empty query (once per location).
    expect(finds).toEqual([
      { method: "file.find", input: { location: { directory: "/repo" }, query: "", limit: 1 } },
      { method: "file.find", input: { location: { directory: "/repo" }, query: "rou", limit: 20 } },
    ])
    expect(env.groups()?.[0]).toBe("files")
    expect(env.labels().slice(0, 2)).toEqual(["src/router.ts", "src/routes/index.ts"])
  })

  test("Enter chooses: the @query leaves the text and a chip is added; #L10-40 gives a range", async () => {
    const env = setup()
    await env.type("고쳐줘 @rou")
    await env.ready()
    await wait(120)
    expect(env.suggest.keydown(key())).toBe(true)
    await wait()
    expect(env.textarea.value).toBe("고쳐줘 ")
    expect(env.suggest.chipList()).toEqual([{ kind: "file", path: "src/router.ts", range: undefined }])
    await env.type("고쳐줘 @router#L10-40")
    await wait(120)
    expect(env.labels()[0]).toBe("src/router.ts#L10-40")
    env.suggest.keydown(key({ code: "Tab", key: "Tab", keyCode: 9 }))
    await wait()
    expect(env.suggest.chipList()[1]).toEqual({ kind: "file", path: "src/router.ts", range: { start: 10, end: 40 } })
    expect(env.suggest.visible()).toBe(false)
  })

  test("files the last turn changed are pinned first (the server index can lag 10 s), deduplicated", async () => {
    const env = setup({ diff: ["src/new-router.ts", "src/router.ts"] })
    await env.type("@")
    await env.ready()
    await env.type("@router")
    await wait(120)
    expect(env.fake.calls.filter((call) => call.method === "session.diff")).toHaveLength(1)
    const files = env.suggest.engine()!.groups()[0]!
    expect(files.items.map((item) => [item.label, item.badge])).toEqual([
      ["src/router.ts", "최근 변경"],
      ["src/new-router.ts", "최근 변경"],
    ])
  })

  test("↑ ↓ move (wrapping), Esc dismisses until the word changes", async () => {
    const env = setup()
    await env.type("@")
    await env.ready()
    expect(env.suggest.activeItem()?.label).toBe("@explore")
    expect(env.suggest.keydown(arrow("ArrowDown"))).toBe(true)
    expect(env.suggest.activeItem()?.label).toBe("@general")
    env.suggest.keydown(arrow("ArrowUp"))
    env.suggest.keydown(arrow("ArrowUp"))
    expect(env.suggest.activeItem()?.label).toBe("Onboarding")
    const escape = key({ code: "Escape", key: "Escape", keyCode: 27 })
    expect(env.suggest.keydown(escape)).toBe(true)
    expect(escape.prevented).toBe(true)
    expect(env.suggest.visible()).toBe(false)
    await env.type("@ex")
    expect(env.suggest.visible()).toBe(false)
    await env.type("")
    await env.type("@ex")
    expect(env.suggest.visible()).toBe(true)
    // Closed list: keys belong to the composer.
    await env.type("plain text")
    expect(env.suggest.keydown(key())).toBe(false)
  })

  test("IME A2: the committing Enter only commits; the next Enter chooses (never sends)", async () => {
    const env = setup()
    await env.type("@")
    await env.ready()
    env.suggest.compositionstart()
    env.compose("@라")
    await wait()
    // Local lists follow the composing text (outside the textarea); no request while composing (rule 9).
    expect(env.labels()).toEqual([])
    env.compose("@라우")
    await wait(120)
    const searched = () =>
      env.fake.calls.filter((call) => call.method === "file.find" && (call.input as { query: string }).query)
    expect(searched()).toEqual([])
    // Rule 9: list keys are not intercepted while composing.
    expect(env.suggest.keydown(arrow("ArrowDown", { key: "Process", keyCode: 229, isComposing: true }))).toBe(false)
    const enter = composingEnter()
    expect(env.suggest.keydown(enter)).toBe(true)
    expect(enter.prevented).toBe(false)
    env.suggest.compositionend()
    env.suggest.keyup(key())
    await wait(120)
    expect(searched().map((call) => (call.input as { query: string }).query)).toEqual(["라우"])
    expect(env.suggest.chipList()).toEqual([])
    expect(env.textarea.value).toBe("@라우")
    expect(env.suggest.keydown(key())).toBe(true)
    await wait()
    expect(env.suggest.chipList()).toEqual([{ kind: "file", path: "src/라우터.ts", range: undefined }])
    expect(env.textarea.value).toBe("")
  })

  test("IME A1 (duplicate Enter after the commit) and B (Safari 229 after compositionend) choose nothing", async () => {
    const env = setup()
    await env.type("@")
    await env.ready()
    // A1
    env.suggest.compositionstart()
    env.compose("@ex")
    expect(env.suggest.keydown(composingEnter())).toBe(true)
    env.suggest.compositionend()
    const duplicate = key()
    expect(env.suggest.keydown(duplicate)).toBe(true)
    expect(duplicate.prevented).toBe(true)
    env.suggest.keyup(key())
    await wait()
    expect(env.suggest.chipList()).toEqual([])
    // B
    env.suggest.compositionstart()
    env.compose("@exp")
    env.suggest.compositionend()
    const safari = key({ key: "Enter", keyCode: 229, isComposing: false })
    expect(env.suggest.keydown(safari)).toBe(true)
    expect(safari.prevented).toBe(true)
    env.suggest.keyup(key())
    await wait()
    expect(env.suggest.chipList()).toEqual([])
    env.suggest.keydown(key())
    await wait()
    expect(env.suggest.chipList()).toEqual([{ kind: "agent", name: "explore" }])
  })

  test("a click while composing commits first, then chooses (rule 6)", async () => {
    const env = setup()
    await env.type("@")
    await env.ready()
    env.suggest.compositionstart()
    env.compose("@gen")
    await wait()
    const item = env.suggest.items().find((entry) => entry.label === "@general")!
    const choosing = env.suggest.choose(item)
    // The commit arrives (blur/focus in a browser); the edit waits for it.
    expect(env.textarea.value).toBe("@gen")
    env.suggest.compositionend()
    env.textarea.dispatchEvent(new Event("compositionend"))
    await choosing
    expect(env.suggest.chipList()).toEqual([{ kind: "agent", name: "general" }])
    expect(env.textarea.value).toBe("")
  })

  test("a ! shell command never opens a list", async () => {
    const env = setup()
    await env.type("@")
    await env.ready()
    await env.type("! ls @src")
    expect(env.suggest.visible()).toBe(false)
  })

  test("nothing opens when disabled (child session, shell mode)", async () => {
    const env = setup({ disabled: () => true })
    await env.type("@")
    await wait(50)
    expect(env.suggest.visible()).toBe(false)
    expect(env.suggest.keydown(key())).toBe(false)
  })
})

describe("/ commands", () => {
  test("server commands first (built-ins, then user commands and MCP prompts), then client commands", async () => {
    const env = setup()
    await env.type("/")
    await env.ready()
    await env.type("/")
    expect(env.groups()).toEqual(["server", "client"])
    const server = env.suggest.engine()!.groups()[0]!.items
    expect(server.map((item) => [item.label, item.badge, item.hint])).toEqual([
      ["/init", undefined, undefined],
      ["/review", undefined, "[commit|branch|pr]"],
      ["/hello", "사용자", "<name>"],
      ["/docs:summarize", "MCP", undefined],
    ])
    expect(server[0]!.detail).toBe("AGENTS.md 안내 설정")
    const client = env.suggest
      .engine()!
      .groups()[1]!
      .items.map((item) => item.label)
    // /redo only with a staged revert; /review is covered by the server entry.
    expect(client).toEqual([
      "/new",
      "/model",
      "/agent",
      "/btw",
      "/compact",
      "/reset-context",
      "/fork",
      "/undo",
      "/export",
      "/skills",
      "/terminal",
    ])
  })

  // MR8-15: own-harness runs Codex's own `/goal` in a codex session and core's goal loop elsewhere.
  test("/goal names Codex's goal in a codex session and the goal loop elsewhere, with the same hint", async () => {
    const goal = { name: "goal", description: "keep working until an objective is met [pause|resume|clear]" }
    const catalog = { ...CATALOG, commands: [...(CATALOG.commands ?? []), goal] }
    const line = async (metadata?: Readonly<Record<string, unknown>>, sessionID?: string | null) => {
      const env = setup({ catalog, session: { id: "ses_1", metadata }, sessionID })
      await env.type("/")
      await env.ready()
      await env.type("/goa")
      const item = env.suggest
        .engine()!
        .groups()
        .flatMap((group) => group.items)
        .find((entry) => entry.label === "/goal")
      return [item?.detail, item?.hint]
    }
    const harness = (id: OwnHarnessRouting.HarnessID) => ({ [OwnHarnessRouting.META_KEY]: OwnHarnessRouting.value(id) })
    const hint = "<목표> | pause | resume | clear"
    expect(await line(harness("codex"))).toEqual([commandKo["own.command.goalCodex"], hint])
    expect(await line(harness("opencode"))).toEqual([commandKo["own.command.goal"], hint])
    expect(await line(harness("pi"))).toEqual([commandKo["own.command.goal"], hint])
    expect(await line(undefined, null)).toEqual([commandKo["own.command.goal"], hint])
  })

  test("/reset-context is found by its Korean name, with its words from its own chunk (03 §18.18)", async () => {
    const env = setup()
    await env.type("/")
    await env.ready()
    await env.type("/문맥")
    const items = env.suggest
      .engine()!
      .groups()
      .flatMap((group) => group.items)
    expect(items.map((item) => item.label)).toContain("/reset-context")
    expect(items.find((item) => item.label === "/reset-context")?.detail).toBe(
      resetText.text("ko", "own.reset.command"),
    )
  })

  test("the home screen lists only commands that need no session", async () => {
    const env = setup({ sessionID: null })
    await env.type("/")
    await env.ready()
    await env.type("/")
    expect(
      env.suggest
        .engine()!
        .groups()[1]!
        .items.map((item) => item.label),
    ).toEqual(["/new", "/model", "/skills", "/terminal"])
  })

  test("choosing a client command clears its text and runs it; a server command waits for arguments", async () => {
    const env = setup()
    await env.type("/")
    await env.ready()
    await env.type("/comp")
    expect(env.suggest.activeItem()?.label).toBe("/compact")
    expect(env.suggest.keydown(key())).toBe(true)
    await wait()
    expect(env.log).toEqual(["compact"])
    expect(env.textarea.value).toBe("")
    await env.type("/rev")
    env.suggest.keydown(key())
    await wait()
    expect(env.textarea.value).toBe("/review ")
    // The hint line; Enter is the composer's again (it sends `/review`).
    expect(env.suggest.visible()).toBe(true)
    expect(env.suggest.engine()!.groups()[0]!.note).toBe("인자: [commit|branch|pr]")
    expect(env.suggest.keydown(key())).toBe(false)
  })

  test("/agent lists primary agents with the cache note; choosing switches the agent", async () => {
    const env = setup()
    await env.type("/")
    await env.ready()
    await env.type("/age")
    env.suggest.keydown(key())
    await wait()
    expect(env.textarea.value).toBe("/agent ")
    await env.type("/agent pl")
    const group = env.suggest.engine()!.groups()[0]!
    expect(group.note).toBe("에이전트마다 도구 권한이 달라 다음 요청에서 캐시를 새로 쓸 수 있어요")
    expect(group.items.map((item) => item.label)).toEqual(["plan"])
    env.suggest.keydown(key())
    await wait()
    expect(env.log).toEqual(["agent:plan"])
    expect(env.textarea.value).toBe("")
  })

  test("/skills lists skills; choosing adds a skill chip", async () => {
    const env = setup()
    await env.type("/skills ")
    await env.ready()
    await env.type("/skills rev")
    env.suggest.keydown(key())
    await wait()
    expect(env.suggest.chipList()).toEqual([{ kind: "skill", id: "review-guide", name: "Review guide" }])
    expect(env.textarea.value).toBe("")
  })
})

describe("sending", () => {
  test("submitClient runs typed client commands and leaves prompts and server commands alone", async () => {
    const env = setup()
    env.fake.load("command", "skill")
    expect(env.suggest.submitClient("/compact")).toEqual({})
    expect(env.suggest.submitClient("/model")).toEqual({})
    expect(env.suggest.submitClient("/terminal")).toEqual({})
    expect(env.log).toEqual(["compact", "model", "tab:terminal"])
    // 03 §4.4.2: `/btw` and `/곁질문` open the side panel with the question; the composer clears, queue and steer untouched.
    expect(env.suggest.submitClient("/btw 이 함수는 어디서 불려?")).toEqual({})
    expect(env.suggest.submitClient("/곁질문")).toEqual({})
    expect(env.log.slice(3)).toEqual(["btw:이 함수는 어디서 불려?", "btw:"])
    env.log.splice(3)
    expect(env.suggest.submitClient("hello")).toBeUndefined()
    expect(env.suggest.submitClient("/hello world")).toBeUndefined()
    // The server has /review: it goes to the server, then the tab opens (sendComposed).
    expect(env.suggest.submitClient("/review main")).toBeUndefined()
    // No argument: the list comes back.
    const agent = env.suggest.submitClient("/agent")
    agent?.after?.()
    await wait()
    expect(env.textarea.value).toBe("/agent ")
    env.suggest.submitClient("/skills review-guide")
    expect(env.suggest.chipList()).toEqual([{ kind: "skill", id: "review-guide", name: "Review guide" }])
  })

  test("send: a prompt with chips, a server command with parts and no token line, /review then the tab", async () => {
    const env = setup()
    env.fake.load("command")
    env.suggest.addChip({ kind: "file", path: "src/router.ts", range: { start: 10, end: 40 } })
    env.suggest.addChip({ kind: "agent", name: "explore" })
    expect(await env.suggest.send({ sessionID: "ses_1", text: "봐줘", delivery: "queue" })).toBe("prompt")
    expect(env.suggest.chipList()).toEqual([])
    const prompt = env.fake.calls.find((call) => call.method === "session.prompt")!.input as Record<string, unknown>
    expect(prompt).toMatchObject({
      sessionID: "ses_1",
      text: "@src/router.ts#L10-40 @explore\n봐줘",
      delivery: "queue",
      files: [{ uri: "file:///repo/src/router.ts?start=10&end=40", name: "router.ts#L10-40" }],
      agents: [{ name: "explore" }],
    })
    env.suggest.addChip({ kind: "file", path: "a.ts" })
    expect(await env.suggest.send({ sessionID: "ses_1", text: "/hello  world " })).toBe("command")
    expect(env.fake.calls.find((call) => call.method === "session.command")!.input).toEqual({
      sessionID: "ses_1",
      name: "hello",
      text: "world",
      files: [{ uri: "file:///repo/a.ts", name: "a.ts" }],
      agents: undefined,
      skills: undefined,
      delivery: undefined,
    })
    expect(await env.suggest.send({ sessionID: "ses_1", text: "/review main" })).toBe("command")
    expect(env.log).toEqual(["tab:review"])
  })

  test("send loads the command catalog when the list never opened; unknown /text is a prompt", async () => {
    const env = setup()
    expect(await env.suggest.send({ sessionID: "ses_1", text: "/init" })).toBe("command")
    expect(env.fake.calls.map((call) => call.method)).toEqual(["location.command.sync", "session.command"])
    expect(await env.suggest.send({ sessionID: "ses_1", text: "/tmp/build.log 봐줘" })).toBe("prompt")
  })

  test("lines picked elsewhere (Ctrl+Shift+L intent) land in the matching draft only", async () => {
    const env = setup()
    await wait(10)
    requestMention({ serverKey: "local", sessionID: "other", chip: selectionChip("src/a.ts", 3) })
    expect(env.suggest.chipList()).toEqual([])
    requestMention({ serverKey: "local", sessionID: "ses_1", chip: selectionChip("src\\a.ts", 12, 8) })
    expect(env.suggest.chipList()).toEqual([{ kind: "file", path: "src/a.ts", range: { start: 8, end: 12 } }])
  })

  test("chips taken earlier (a held message) are sent as given; the draft keeps its own", async () => {
    const env = setup()
    env.fake.load("command")
    env.suggest.addChip({ kind: "agent", name: "general" })
    await env.suggest.send({ sessionID: "ses_1", text: "x", chips: [{ kind: "agent", name: "explore" }] })
    expect(
      (env.fake.calls.find((call) => call.method === "session.prompt")!.input as { agents: unknown }).agents,
    ).toEqual([{ name: "explore", mention: { start: 0, end: 8, text: "@explore" } }])
    expect(env.suggest.chipList()).toEqual([{ kind: "agent", name: "general" }])
  })

  test("a failed send puts the chips back", async () => {
    const env = setup()
    env.fake.load("command")
    env.suggest.addChip({ kind: "agent", name: "explore" })
    const prompt = env.fake.runtime.data.session.prompt
    Object.assign(env.fake.runtime.data.session, {
      prompt: async () => {
        throw new Error("offline")
      },
    })
    await expect(env.suggest.send({ sessionID: "ses_1", text: "x" })).rejects.toThrow("offline")
    expect(env.suggest.chipList()).toEqual([{ kind: "agent", name: "explore" }])
    Object.assign(env.fake.runtime.data.session, { prompt })
  })
})

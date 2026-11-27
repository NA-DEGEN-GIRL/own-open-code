// The dsh request (src/dsh/request.ts): dsh's prompt from core's system parts, dsh's tools under dsh's names in dsh's
// name order, the history in dsh's tool names, and dsh's added messages where dsh puts them (instructions, runtime
// context, skill catalog and time after the first user message, readings every 10 minutes, repeat reminders after a
// step's results, a new runtime context where it changed), the same bytes for the same history; own's revision.
import { describe, expect, test } from "bun:test"
import { Message, SystemPart, ToolCallPart, ToolResultPart } from "@opencode/ai/effect"
import { Baseline } from "../../../src/codex/baseline.js"
import { Notice } from "../../../src/notice.js"
import { DshContext } from "../../../src/dsh/context.js"
import { DshPrompt } from "../../../src/dsh/prompt.js"
import { DshReminder } from "../../../src/dsh/reminder.js"
import { DshRequest } from "../../../src/dsh/request.js"
import { DshShell } from "../../../src/dsh/shell.js"
import { DshShellTool } from "../../../src/dsh/shell-tool.js"

const SHELL = DshShell.kind()
const CWD = process.platform === "win32" ? "C:\\work\\app\\pkg" : "/work/app/pkg"
const ROOT = process.platform === "win32" ? "C:\\work\\app" : "/work/app"
const HOME = process.platform === "win32" ? "C:\\Users\\me" : "/home/me"
const join = (...parts: Array<string>) => parts.join(process.platform === "win32" ? "\\" : "/")

const BASELINE = [
  "<mcp_instructions>\nUse the docs server.\n</mcp_instructions>",
  `Instructions from: ${join(HOME, ".config", "opencode", "AGENTS.md")}\nGlobal rules.`,
  `Instructions from: ${join(CWD, "AGENTS.md")}\nPackage rules.`,
  `Instructions from: ${join(ROOT, "AGENTS.md")}\nBe brief.`,
  "Today's date: Sun Oct 11 2026",
  `Here is some useful information about the environment you are running in:\n<env>\n  Working directory: ${CWD}\n  Workspace root folder: ${ROOT}\n  Platform: ${process.platform}\n</env>`,
  '<context key="own.preset">\nPlanner.\n</context>',
].join("\n\n")

const T0 = Date.UTC(2026, 9, 19, 1, 0, 0)
const MINUTE = 60_000

function session(overrides: Partial<DshRequest.Session> = {}): DshRequest.Session {
  return {
    cwd: CWD,
    model: { id: "deepseek-v4-pro", providerID: "deepseek" },
    responses: false,
    skills: [{ name: "release", description: "Cut a release." }],
    mode: "ask",
    timeZone: "UTC",
    home: HOME,
    ...overrides,
  }
}

const SHELL_ENTRY = () => ({ description: DshShellTool.description(SHELL), input: { type: "object" } })

function draft(messages: Array<Message>) {
  return {
    system: [
      SystemPart.make("You are opencode, an interactive CLI tool."),
      SystemPart.make("# Your Model\n- Name: M\n- Provider ID: p\n- Model ID: m"),
      SystemPart.make(BASELINE),
      SystemPart.make("A plugin's guidance."),
    ],
    messages,
    tools: {
      shell: { description: "core shell", input: {} },
      read: { description: "core read", input: {} },
      edit: { description: "core edit", input: {} },
      write: { description: "core write", input: {} },
      glob: { description: "core glob", input: {} },
      grep: { description: "core grep", input: {} },
      patch: { description: "patch", input: {} },
      [`dsh_${SHELL}`]: SHELL_ENTRY(),
      dsh_read: { description: "dsh read", input: {} },
      dsh_write: { description: "dsh write", input: {} },
      dsh_edit: { description: "dsh edit", input: {} },
      dsh_glob: { description: "dsh glob", input: {} },
      dsh_grep: { description: "dsh grep", input: {} },
      dsh_todo_write: { description: "dsh todo", input: {} },
      websearch: { description: "search", input: {} },
      subagent: { description: "subagent", input: {} },
    } as Record<string, { description: string; input: unknown }>,
  }
}

const user = (id: string, text: string) => Message.make({ id, role: "user", content: text })
const textOf = (message: Message) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

function call(id: string, name: string, input: unknown) {
  return Message.make({ id: `a-${id}`, role: "assistant", content: [ToolCallPart.make({ id, name, input })] })
}

function result(id: string, name: string, text: string) {
  return Message.tool(ToolResultPart.make({ id, name, result: { type: "text", value: text } }))
}

describe("DshRequest.build", () => {
  test("dsh's prompt replaces core's system; dsh's tools in dsh's name order replace core's, own's others follow", () => {
    const request = draft([user("u1", "hi")])
    const entry = request.tools[`dsh_${SHELL}`]
    const built = DshRequest.build(request, session())
    expect(request.system).toHaveLength(1)
    const prompt = request.system[0]!.text
    expect(prompt).toStartWith(
      `${DshPrompt.IDENTITY}\n\nYou are a coding agent powered by the deepseek-v4-pro model.\n\n`,
    )
    expect(prompt).toContain(SHELL === "pwsh" ? DshShellTool.PWSH_SECTION : DshShellTool.BASH_SECTION)
    expect(prompt).toContain("<mcp_instructions>\nUse the docs server.\n</mcp_instructions>")
    expect(prompt).toContain('<context key="own.preset">\nPlanner.\n</context>\n\nA plugin\'s guidance.')
    for (const gone of ["Today's date", "# Your Model", "<env>", "You are opencode", "Instructions from:"])
      expect(prompt).not.toContain(gone)
    expect(Object.keys(request.tools)).toEqual([
      ...[SHELL, "edit", "glob", "grep", "read", "todo_write", "write"].toSorted(),
      "websearch",
      "subagent",
    ])
    // The renamed tools are core's definition objects, so core maps the calls back to the plugin tools.
    expect(request.tools[SHELL]).toBe(entry)
    expect(request.tools.read!.description).toBe("dsh read")
    expect(built.sections.find((part) => part.name === "deployment:persona-prefix")!.text).toContain("deepseek-v4-pro")
  })

  const configured = (team: string) =>
    Baseline.parse(
      BASELINE.replace(
        "\n\nToday's date: ",
        `\n\nInstructions from: ${join(ROOT, "CONTRIBUTING.md")}\nRun the linter.\n\nInstructions from: https://example.com/team.md\n${team}\n\nToday's date: `,
      ),
    )

  test("config instructions sit between the global file and the project's AGENTS.md files, a URL as it is", () => {
    const text = DshRequest.contexts(session(), configured("Team rules.")).instructions
    const order = [
      "Instructions from: ~/.config/opencode/AGENTS.md\n\nGlobal rules.",
      "Instructions from: CONTRIBUTING.md\n\nRun the linter.",
      "Instructions from: https://example.com/team.md\n\nTeam rules.",
      "Instructions from: AGENTS.md\n\nBe brief.",
      `Instructions from: ${join("pkg", "AGENTS.md")}\n\nPackage rules.`,
    ].map((section) => text.indexOf(section))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
  })

  test("a configured entry too large for dsh's budget goes before any project AGENTS.md", () => {
    const large = configured(`Team rules.\n${"x".repeat(DshContext.INSTRUCTIONS_MAX_BYTES)}`)
    const text = DshRequest.contexts(session(), large).instructions
    expect(text).toContain(
      `Workspace instruction budget ${DshContext.INSTRUCTIONS_MAX_BYTES} bytes: omitted ~/.config/opencode/AGENTS.md, CONTRIBUTING.md, https://example.com/team.md`,
    )
    expect(text).not.toContain("Team rules.")
    // The project's files stay, the working directory's own as the most specific.
    expect(text).toContain("Instructions from: AGENTS.md\n\nBe brief.")
    expect(text).toEndWith(`Instructions from: ${join("pkg", "AGENTS.md")}\n\nPackage rules.\n</system-reminder>`)
  })

  test("after the first user message: workspace instructions, runtime context, skills, then the time reading", () => {
    const request = draft([user("u1", "hi")])
    const built = DshRequest.build(request, session({ facts: new Map([["u1", { kind: "user", created: T0 }]]) }))
    const texts = request.messages.map(textOf)
    expect(texts[0]).toBe("hi")
    expect(texts[1]).toStartWith(
      "<system-reminder>\nThe following workspace instructions may be relevant to your work.",
    )
    // Broadest first: the user-global file under ~, then the project's from its root down.
    expect(texts[1]!.indexOf("Instructions from: ~/.config/opencode/AGENTS.md")).toBeLessThan(
      texts[1]!.indexOf("Instructions from: AGENTS.md\n\nBe brief."),
    )
    expect(texts[1]).toContain(`Instructions from: ${join("pkg", "AGENTS.md")}\n\nPackage rules.`)
    expect(texts[2]).toBe(DshContext.snapshot([DshContext.workingDirectory(CWD), ...DshContext.policy("ask", CWD)]))
    expect(texts[3]).toContain("- `release`: Cut a release.")
    expect(texts[4]).toBe(
      "Time sampled while preparing turn 1, step 1: 2026-10-19T01:00:00+00:00[UTC]\n" +
        "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n" +
        "Elapsed since the preceding model-visible message: unavailable.",
    )
    expect(texts).toHaveLength(5)
    // The first request places the runtime context after the first user message, for later requests to keep.
    expect(built.recorded).toEqual({ after: "u1", text: texts[2] })
  })

  test("a turn later: the same bytes for the first turn, a reading only after 10 minutes, a new snapshot on change", () => {
    const facts = new Map<string, DshRequest.Fact>([
      ["u1", { kind: "user", created: T0 }],
      ["a-c1", { kind: "assistant", created: T0 + 1000, settled: T0 + 2000 }],
      ["a-c2", { kind: "assistant", created: T0 + 3000, settled: T0 + 4000 }],
      ["u2", { kind: "user", created: T0 + 5 * MINUTE }],
      ["a-c3", { kind: "assistant", created: T0 + 5 * MINUTE + 1000, settled: T0 + 16 * MINUTE }],
    ])
    const history = () => [
      user("u1", "hi"),
      call("c1", SHELL, { description: "list", command: "ls" }),
      result("c1", SHELL, "a.txt"),
      Message.make({ id: "a-c2", role: "assistant", content: "done" }),
      user("u2", "again"),
      call("c3", SHELL, { description: "list", command: "ls" }),
      result("c3", SHELL, "a.txt"),
    ]
    const first = draft(history().slice(0, 1))
    const placed = DshRequest.build(first, session({ facts })).recorded!
    const later = draft(history())
    const built = DshRequest.build(later, session({ facts, snapshots: [placed] }))
    expect(built.recorded).toBeUndefined()
    const texts = later.messages.map(textOf)
    expect(texts.slice(0, 5)).toEqual(first.messages.map(textOf))
    // Turn 2 started 5 minutes after the last reading: none. Its second step comes 16 minutes in: a reading.
    const turn = later.messages.findIndex((message) => message.id === "u2")
    expect(later.messages[turn + 1]!.role).toBe("assistant")
    expect(texts.at(-1)).toBe(
      "Time sampled while preparing turn 2, step 2: 2026-10-19T01:16:00+00:00[UTC]\n" +
        "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n" +
        "Elapsed since the preceding step context: unavailable.",
    )
    // The approval mode changed: a new snapshot after the last message, the first one stays where it was.
    const changed = draft(history())
    const moved = DshRequest.build(changed, session({ facts, snapshots: [placed], mode: "full" }))
    expect(moved.recorded).toEqual({ after: "a-c3", text: expect.stringContaining("danger-full-access") })
    const changedTexts = changed.messages.map(textOf)
    expect(changedTexts.slice(0, 5)).toEqual(first.messages.map(textOf))
    expect(changedTexts.at(-2)).toContain("Current DSH file policy: danger-full-access.")
  })

  test("the third identical call in a row gets dsh's reminder after its result; a user message breaks the chain", () => {
    const input = { command: "ls", description: "list" }
    const steps = ["c1", "c2", "c3"].flatMap((id) => [call(id, SHELL, input), result(id, SHELL, "same")])
    const request = draft([user("u1", "hi"), ...steps])
    DshRequest.build(request, session())
    const texts = request.messages.map(textOf)
    expect(texts.at(-1)).toBe(DshReminder.GENTLE)
    expect(request.messages.at(-2)!.role).toBe("tool")
    expect(texts.filter((text) => text === DshReminder.GENTLE)).toHaveLength(1)
    const broken = draft([user("u1", "hi"), ...steps.slice(0, 4), user("u2", "go on"), ...steps.slice(4)])
    DshRequest.build(broken, session({ facts: new Map([["u2", { kind: "user", created: T0 }]]) }))
    expect(broken.messages.map(textOf)).not.toContain(DshReminder.GENTLE)
    expect(DshReminder.detailed("grep", 5, '{"pattern":"x"}')).toStartWith(
      'Repeated tool call detected:\n- tool: grep\n- consecutive_calls: 5\n- arguments: {"pattern":"x"}\n',
    )
    expect(DshReminder.canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  test("history in dsh's tool names; the switch notice stays; the same bytes again", () => {
    const history = [
      user("u1", "hi"),
      call("c1", "exec_command", { cmd: "Get-Content a.txt", workdir: "C:\\w" }),
      result("c1", "exec_command", "hello"),
      user("n1", Notice.text("codex", "dsh")),
    ]
    const first = draft(history)
    DshRequest.build(first, session())
    const calls = first.messages.flatMap((message) => message.content.filter((part) => part.type === "tool-call"))
    expect(calls[0]).toMatchObject({ name: SHELL, input: { command: "Get-Content a.txt", workdir: "C:\\w" } })
    expect(Notice.text("codex", "dsh")).toContain(`Earlier exec_command calls are shown as ${SHELL}.`)
    expect(Notice.text("codex", "dsh")).toContain(
      "Earlier apply_patch calls keep their name: the dsh harness has no patch tool.",
    )
    const again = draft(history)
    DshRequest.build(again, session())
    expect(JSON.stringify(again.messages)).toBe(JSON.stringify(first.messages))
    expect(again.system[0]!.text).toBe(first.system[0]!.text)
  })

  test("OpenAI Responses: the prompt is the leading developer message; a config agent's prompt is the persona", () => {
    const request = draft([user("u1", "hi")])
    DshRequest.build(request, session({ responses: true, agentInstructions: "You explore code." }))
    expect(request.system).toEqual([])
    expect(request.messages[0]).toMatchObject({ role: "system" })
    expect(textOf(request.messages[0]!)).toStartWith(`${DshPrompt.IDENTITY}\n\nYou explore code.\n\n`)
  })

  test("own's revision: own's approval text, no sandbox sentence, the machine's zone; 내 지시문 replaces the persona", () => {
    const request = draft([user("u1", "hi")])
    DshRequest.build(
      request,
      session({
        prompt: "custom",
        custom: "You fix bugs on {{model}}.",
        facts: new Map([["u1", { kind: "user", created: T0 }]]),
      }),
    )
    expect(request.system[0]!.text).toContain("\n\nYou fix bugs on deepseek-v4-pro.\n\n")
    expect(request.tools[SHELL]!.description).not.toContain(DshShellTool.SANDBOX_SENTENCE)
    expect(request.tools[SHELL]!.description).toStartWith(DshShellTool.description(SHELL).slice(0, 40))
    const texts = request.messages.map(textOf)
    expect(texts[2]).toContain("Approval mode: ask. Before a command runs or a file is written or edited, own shows it")
    expect(texts[2]).not.toContain("DSH file")
    expect(texts[4]).toContain(
      "Time zone of this machine: UTC. Interpret otherwise-unqualified dates and times in this zone.",
    )
    const reference = draft([user("u1", "hi")])
    DshRequest.build(reference, session({ prompt: "reference" }))
    expect(reference.tools[SHELL]!.description).toContain(DshShellTool.SANDBOX_SENTENCE)
  })
})

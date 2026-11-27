// The pi request (src/pi/request.ts): Pi's prompt from core's system parts, Pi's tools under Pi's names, history in
// Pi's tool names, own's checkpoint rendered, the same bytes for the same history.
import { describe, expect, test } from "bun:test"
import { Message, SystemPart, ToolCallPart } from "@opencode/ai/effect"
import { CodexCompaction } from "../../../src/codex/compaction.js"
import { Notice } from "../../../src/notice.js"
import { PiPrompt } from "../../../src/pi/prompt.js"
import { PiRequest } from "../../../src/pi/request.js"
import { PiShell } from "../../../src/pi/shell.js"

const BASELINE = [
  "<mcp_instructions>\nUse the docs server.\n</mcp_instructions>",
  "Instructions from: C:\\Users\\me\\.config\\opencode\\AGENTS.md\nGlobal rules.",
  "Instructions from: C:\\work\\app\\pkg\\AGENTS.md\nPackage rules.",
  "Instructions from: C:\\work\\app\\AGENTS.md\nBe brief.",
  "Today's date: Sun Oct 11 2026",
  "Here is some useful information about the environment you are running in:\n<env>\n  Working directory: C:\\work\\app\\pkg\n  Platform: win32\n</env>",
  '<context key="own.preset">\nPlanner.\n</context>',
].join("\n\n")

const SESSION: PiRequest.Session = {
  cwd: "C:\\work\\app\\pkg",
  responses: false,
  skills: [{ name: "release", description: "Cut a release.", path: "C:\\skills\\release\\SKILL.md" }],
}

const PI_READ = { description: "pi read", input: { type: "object" } }
const PI_BASH = { description: "pi bash", input: { type: "object" } }

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
      glob: { description: "glob", input: {} },
      grep: { description: "grep", input: {} },
      patch: { description: "patch", input: {} },
      pi_write: { description: "pi write", input: {} },
      pi_read: PI_READ,
      pi_edit: { description: "pi edit", input: {} },
      pi_bash: PI_BASH,
      websearch: { description: "search", input: {} },
      subagent: { description: "subagent", input: {} },
    } as Record<string, { description: string; input: unknown }>,
  }
}

describe("PiRequest.build", () => {
  test("Pi's prompt replaces core's system: project context, skills, addendum and cwd from the baseline", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    const built = PiRequest.build(request, SESSION)
    expect(request.system).toHaveLength(1)
    const prompt = request.system[0]!.text
    expect(prompt).toBe(built.prompt)
    expect(prompt).toBe(
      PiPrompt.build({
        cwd: "C:\\work\\app\\pkg",
        appendSystemPrompt: [
          "<mcp_instructions>\nUse the docs server.\n</mcp_instructions>",
          '<context key="own.preset">\nPlanner.\n</context>',
          "A plugin's guidance.",
        ].join("\n\n"),
        contextFiles: [
          { path: "C:\\Users\\me\\.config\\opencode\\AGENTS.md", content: "Global rules." },
          { path: "C:\\work\\app\\AGENTS.md", content: "Be brief." },
          { path: "C:\\work\\app\\pkg\\AGENTS.md", content: "Package rules." },
        ],
        skills: [{ name: "release", description: "Cut a release.", filePath: "C:\\skills\\release\\SKILL.md" }],
      }),
    )
    expect(prompt).toStartWith(PiPrompt.PREAMBLE)
    expect(prompt).not.toContain("# Your Model")
    expect(prompt).not.toContain("You are opencode")
    expect(prompt).not.toContain("Today's date")
    expect(prompt).toEndWith("<cwd>\nC:/work/app/pkg\n</cwd>")
  })

  test("config instructions open Pi's addendum (its appended system prompt), not the project context", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    request.system[2] = SystemPart.make(
      BASELINE.replace(
        "\n\nToday's date: ",
        "\n\nInstructions from: C:\\work\\app\\CONTRIBUTING.md\nRun the linter.\n\nInstructions from: https://example.com/team.md\nTeam rules.\n\nToday's date: ",
      ),
    )
    const built = PiRequest.build(request, SESSION)
    expect(built.sections.addendum).toStartWith(
      "<addendum>\nRun the linter.\n\nTeam rules.\n\n<mcp_instructions>\nUse the docs server.\n</mcp_instructions>",
    )
    const context = built.sections.project_context!
    expect(context).not.toContain("Run the linter.")
    expect(context).not.toContain("example.com")
    expect(context.indexOf("Global rules.")).toBeLessThan(context.indexOf("Be brief."))
    expect(context.indexOf("Be brief.")).toBeLessThan(context.indexOf("Package rules."))
  })

  test("an empty configured file adds nothing to the addendum, as Codex drops an empty developer_instructions", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    // Core renders an empty file as its heading alone (`Instructions from: <path>\n`).
    request.system[2] = SystemPart.make(
      BASELINE.replace(
        "\n\nToday's date: ",
        "\n\nInstructions from: C:\\work\\app\\CONTRIBUTING.md\n\n\nInstructions from: https://example.com/team.md\nTeam rules.\n\nToday's date: ",
      ),
    )
    expect(PiRequest.build(request, SESSION).sections.addendum).toStartWith(
      "<addendum>\nTeam rules.\n\n<mcp_instructions>\nUse the docs server.\n</mcp_instructions>",
    )
  })

  test("Pi's tools come first under Pi's names as the same definitions; core's file and shell tools go", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    PiRequest.build(request, SESSION)
    expect(Object.keys(request.tools)).toEqual(["read", "bash", "edit", "write", "websearch", "subagent"])
    expect(request.tools.read).toBe(PI_READ)
    expect(request.tools.bash).toBe(PI_BASH)
  })

  test("own's guidelines (Windows: which shell bash runs) close Pi's tool guidelines in <rules>, before Pi's two rules", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    const note = PiShell.windowsGuidelines("win32", () => ({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["-c"],
      stdin: false,
    }))
    PiRequest.build(request, { ...SESSION, guidelines: note })
    const rules = /<rules>\n([\s\S]*?)\n<\/rules>/.exec(request.system[0]!.text)![1]!.split("\n")
    expect(rules.slice(-3)).toEqual([
      "- On Windows the bash tool runs Git Bash, not PowerShell: use bash syntax and POSIX commands (ls, cat, rg); PowerShell cmdlets such as Get-ChildItem do not work in it",
      "- Be concise in your responses",
      "- Show file paths clearly when working with files",
    ])
    // Without them the prompt is Pi's own.
    const plain = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    PiRequest.build(plain, SESSION)
    expect(plain.system[0]!.text).toBe(request.system[0]!.text.replace(`\n- ${note[0]}`, ""))
  })

  test("a session without Pi's tools lists none in the prompt", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    request.tools = { websearch: { description: "search", input: {} } }
    PiRequest.build(request, SESSION)
    expect(request.system[0]!.text).toContain("<tools>\n(none)\n")
  })

  test("a config agent's own prompt is Pi's custom prompt", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    PiRequest.build(request, { ...SESSION, agentInstructions: "You explore code." })
    const prompt = request.system[0]!.text
    expect(prompt).toStartWith("You explore code.\n\n<addendum>")
    expect(prompt).not.toContain("<tools>")
  })

  test("on OpenAI Responses the prompt is the leading developer (system) message", () => {
    const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
    const built = PiRequest.build(request, { ...SESSION, responses: true })
    expect(request.system).toEqual([])
    expect(request.messages[0]!.role).toBe("system")
    expect(request.messages[0]!.content).toEqual([{ type: "text", text: built.prompt }])
    expect(request.messages[1]!.id).toBe("u1")
  })

  test("history: shell and exec_command calls become bash, patch calls keep their name, checkpoints render", () => {
    const history = [
      Message.make({ id: "u1", role: "user", content: Notice.text("codex", "pi") }),
      Message.assistant([
        ToolCallPart.make({ id: "c1", name: "exec_command", input: { cmd: "git status", workdir: "src" } }),
      ]),
      Message.tool({ id: "c1", name: "exec_command", result: "clean" }),
      Message.assistant([ToolCallPart.make({ id: "c2", name: "apply_patch", input: { input: "*** Begin Patch" } })]),
      Message.assistant([ToolCallPart.make({ id: "c3", name: "shell", input: { command: "ls" } })]),
      Message.make({
        id: "k1",
        role: "user",
        content: "<conversation-checkpoint>\n<summary>\nDone so far.\n</summary>\n</conversation-checkpoint>",
      }),
    ]
    const request = draft(history)
    PiRequest.build(request, {
      ...SESSION,
      checkpoints: new Map([
        [
          "k1",
          {
            [CodexCompaction.FORMAT_KEY]: CodexCompaction.CHECKPOINT_FORMAT,
            [CodexCompaction.USER_MESSAGES_KEY]: ["fix it"],
          },
        ],
      ]),
    })
    expect(request.messages[1]!.content[0]).toMatchObject({
      name: "bash",
      input: { command: "cd 'src' && git status" },
    })
    expect(request.messages[2]!.content[0]).toMatchObject({ type: "tool-result", name: "bash" })
    expect(request.messages[3]!.content[0]).toMatchObject({ name: "apply_patch" })
    expect(request.messages[4]!.content[0]).toMatchObject({ name: "bash", input: { command: "ls" } })
    const checkpoint = request.messages[5]!.content[0]
    expect(checkpoint?.type === "text" ? checkpoint.text : "").toContain("Done so far.")
    expect(checkpoint?.type === "text" ? checkpoint.text : "").toContain("fix it")
  })

  test("the same history gives the same bytes", () => {
    const build = () => {
      const request = draft([Message.make({ id: "u1", role: "user", content: "hi" })])
      PiRequest.build(request, SESSION)
      return JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })
    }
    expect(build()).toBe(build())
  })
})

import { describe, expect, test } from "bun:test"
import { Message, ToolCallPart, ToolResultPart } from "@opencode/ai/effect"
import { History } from "../../src/history.js"
import { Notice } from "../../src/notice.js"
import { Registry } from "../../src/registry.js"

const PATCH = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch"

function call(id: string, name: string, input: unknown) {
  return Message.assistant([ToolCallPart.make({ id, name, input })])
}

function result(id: string, name: string, text: string) {
  return Message.tool({ id, name, result: text })
}

const opencodeHistory = [
  Message.user("fix it"),
  call("c1", "shell", { command: "ls", workdir: "src", timeout: 1000 }),
  result("c1", "shell", "a.ts"),
  call("c2", "patch", { patchText: PATCH }),
  result("c2", "patch", "Success"),
  call("c3", "read", { filePath: "a.ts" }),
  result("c3", "read", "content"),
]

describe("History.translate", () => {
  test("opencode calls take the codex names and input shapes; results follow by call id", () => {
    const out = History.translate(opencodeHistory, Registry.codex)
    expect(out[1]!.content[0]).toMatchObject({ name: "exec_command", input: { cmd: "ls", workdir: "src" } })
    expect(out[2]!.content[0]).toMatchObject({ type: "tool-result", id: "c1", name: "exec_command" })
    expect(out[3]!.content[0]).toMatchObject({ name: "apply_patch", input: { input: PATCH } })
    expect(out[4]!.content[0]).toMatchObject({ name: "apply_patch" })
    // A tool with no counterpart keeps its name, input and message object.
    expect(out[5]).toBe(opencodeHistory[5]!)
    expect(out[6]).toBe(opencodeHistory[6]!)
    expect(out[0]).toBe(opencodeHistory[0]!)
  })

  test("a history without another harness's tools comes back as the same objects", () => {
    const out = History.translate(opencodeHistory, Registry.opencode)
    out.forEach((message, index) => expect(message).toBe(opencodeHistory[index]!))
  })

  test("codex calls go back to the opencode forms, a freeform apply_patch included", () => {
    const history = [
      call("x1", "exec_command", { cmd: "git status", yield_time_ms: 1000 }),
      result("x1", "exec_command", "clean"),
      call("x2", "apply_patch", PATCH),
      result("x2", "apply_patch", "Done"),
      call("x3", "write_stdin", { session_id: 1, chars: "y" }),
    ]
    const out = History.translate(history, Registry.opencode)
    expect(out[0]!.content[0]).toMatchObject({ name: "shell", input: { command: "git status" } })
    expect(out[1]!.content[0]).toMatchObject({ name: "shell" })
    expect(out[2]!.content[0]).toMatchObject({ name: "patch", input: { patchText: PATCH } })
    expect(out[4]).toBe(history[4]!)
  })

  test("round trip keeps the action", () => {
    const back = History.translate(History.translate(opencodeHistory, Registry.codex), Registry.opencode)
    expect(back[1]!.content[0]).toMatchObject({ name: "shell", input: { command: "ls", workdir: "src" } })
    expect(back[3]!.content[0]).toMatchObject({ name: "patch", input: { patchText: PATCH } })
  })

  test("calls of the wrong shape, namespaced or provider-executed calls stay", () => {
    const history = [
      call("b1", "shell", { cmd: "not the shell shape" }),
      Message.assistant([ToolCallPart.make({ id: "b2", name: "shell", namespace: "mcp", input: { command: "x" } })]),
      Message.assistant([ToolCallPart.make({ id: "b3", name: "shell", providerExecuted: true, input: { command: "x" } })]),
      Message.tool(ToolResultPart.make({ id: "b1", name: "shell", result: "?" })),
    ]
    const out = History.translate(history, Registry.codex)
    out.forEach((message, index) => expect(message).toBe(history[index]!))
  })

  test("pi: shell calls become bash (a workdir as a cd), patch calls keep their name", () => {
    const out = History.translate(opencodeHistory, Registry.pi)
    expect(out[1]!.content[0]).toMatchObject({ name: "bash", input: { command: "cd 'src' && ls" } })
    expect(out[2]!.content[0]).toMatchObject({ type: "tool-result", id: "c1", name: "bash" })
    expect(out[3]).toBe(opencodeHistory[3]!)
    expect(out[5]).toBe(opencodeHistory[5]!)
    const quoted = History.translate([call("q1", "exec_command", { cmd: "ls", workdir: "it's" })], Registry.pi)
    expect(quoted[0]!.content[0]).toMatchObject({ input: { command: "cd 'it'\\''s' && ls" } })
  })

  test("pi's bash calls go to the codex and opencode shell tools", () => {
    const history = [call("p1", "bash", { command: "git log", timeout: 5 }), result("p1", "bash", "commit")]
    expect(History.translate(history, Registry.codex)[0]!.content[0]).toMatchObject({
      name: "exec_command",
      input: { cmd: "git log" },
    })
    const opencode = History.translate(history, Registry.opencode)
    expect(opencode[0]!.content[0]).toMatchObject({ name: "shell", input: { command: "git log" } })
    expect(opencode[1]!.content[0]).toMatchObject({ name: "shell" })
    // pi's own history stays as it is.
    History.translate(history, Registry.pi).forEach((message, index) => expect(message).toBe(history[index]!))
  })

  test("the same history gives the same bytes", () => {
    const first = JSON.stringify(History.translate(opencodeHistory, Registry.codex))
    expect(JSON.stringify(History.translate(opencodeHistory, Registry.codex))).toBe(first)
  })
})

describe("Notice.text", () => {
  test("names both harnesses and the renamed tools", () => {
    expect(Notice.text("opencode", "codex")).toBe(
      [
        "<harness_switch>",
        "This session now runs the codex harness (before: opencode).",
        "Earlier shell and patch calls are shown as exec_command and apply_patch.",
        "Use only the tools offered in this request; earlier calls to other tools are history.",
        "</harness_switch>",
      ].join("\n"),
    )
  })

  test("a switch to pi lists Pi's tools; its missing patch tool leaves patch calls named", () => {
    expect(Notice.text("codex", "pi")).toBe(
      [
        "<harness_switch>",
        "This session now runs the pi harness (before: codex).",
        "Earlier exec_command calls are shown as bash.",
        "Earlier apply_patch calls keep their name: the pi harness has no patch tool.",
        "The pi harness's tools: read, bash, edit, write.",
        "Use only the tools offered in this request; earlier calls to other tools are history.",
        "</harness_switch>",
      ].join("\n"),
    )
    expect(Notice.text("pi", "opencode")).toBe(
      [
        "<harness_switch>",
        "This session now runs the opencode harness (before: pi).",
        "Earlier bash calls are shown as shell.",
        "Use only the tools offered in this request; earlier calls to other tools are history.",
        "</harness_switch>",
      ].join("\n"),
    )
  })
})

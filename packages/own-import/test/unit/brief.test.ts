import { describe, expect, test } from "bun:test"
import { Token } from "@own/protocol/token"
import { Fill } from "../../src/migrate/fill.js"
import { Brief } from "../../src/transcript/brief.js"
import { CodexTranscript } from "../../src/transcript/codex.js"
import type { Transcript } from "../../src/transcript/ir.js"
import { T0, compactionItem, localSummary, rollout, threadId, userItem } from "../fixtures/codex.js"

const text = (value: string): Transcript.Step => ({ type: "text", text: value, time: T0 })

function tool(name: string, input: unknown, more: Partial<Transcript.ToolStep> = {}): Transcript.Step {
  return { type: "tool", name, input, output: { text: "ok", error: false }, time: T0, ...more }
}

function turn(index: number, steps: ReadonlyArray<Transcript.Step>, request = `request ${index}`): Transcript.Turn {
  return { index, time: T0 + index, user: { text: request, images: [] }, steps: [...steps], end: "completed" }
}

const whole = (turns: ReadonlyArray<Transcript.Turn>) => Fill.pieces(turns)

describe("brief (09 §4.4)", () => {
  test("files, the last commands with exit codes, the last plan and the stop point, under the fixed header", () => {
    const turns = [
      turn(0, [
        tool("exec_command", { cmd: "bun install", workdir: "C:\\work\\proj" }, { exit: 0 }),
        tool(
          "apply_patch",
          "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n+x\n*** End Patch",
        ),
        tool("update_plan", {
          explanation: "Two steps.",
          plan: [
            { step: "Read", status: "completed" },
            { step: "Fix", status: "in_progress" },
          ],
        }),
        text("Installed."),
      ]),
      turn(1, [
        tool("Bash", { command: "bun test\n  --bail" }, { exit: 1, output: { text: "1 fail", error: true } }),
        tool("shell", { command: ["bash", "-lc", "git status"] }),
        tool("local_shell", { type: "exec", command: ["git", "diff"] }, { output: undefined }),
        tool("Edit", { file_path: "C:\\work\\proj\\src\\a.ts", old_string: "a", new_string: "b" }),
        tool(
          "Write",
          { file_path: "C:\\work\\proj\\denied.ts", content: "x" },
          { output: { text: "denied", error: true } },
        ),
        tool(
          "apply_patch",
          { input: "*** Begin Patch\n*** Update File: src/c.ts\n*** Move to: src/d.ts\n*** End Patch" },
          { diff: [{ file: "src/c.ts", patch: "", additions: 0, deletions: 0, status: "modified" }] },
        ),
        tool("TodoWrite", { todos: [{ content: "Run the tests", status: "pending", activeForm: "Running" }] }),
        text(`Stopped here. ${"z".repeat(600)}`),
      ]),
    ]
    expect(Brief.brief(whole(turns))).toBe(
      [
        Brief.HEADER,
        ["Changed files:", "- src/a.ts", "- src/b.ts", "- C:\\work\\proj\\src\\a.ts", "- src/c.ts", "- src/d.ts"].join(
          "\n",
        ),
        [
          "Last commands, oldest first:",
          "- bun install (exit 0)",
          "- bun test ⏎ --bail (exit 1)",
          "- git status (no exit code)",
          "- git diff (no result)",
        ].join("\n"),
        "Last plan (TodoWrite):\n- [pending] Run the tests",
        `Where it stopped (the last assistant text, first 500 characters):\nStopped here. ${"z".repeat(486)}`,
      ].join("\n\n"),
    )
  })

  test("only the last 20 commands; an update_plan plan with its explanation", () => {
    const steps = Array.from({ length: 25 }, (_, index) => tool("exec_command", { cmd: `echo ${index}` }, { exit: 0 }))
    const facts = Brief.brief(
      whole([
        turn(0, [...steps, tool("update_plan", { explanation: "Why.", plan: [{ step: "Ship", status: "pending" }] })]),
      ]),
    )
    expect(facts).toContain("- echo 5 (exit 0)\n")
    expect(facts).not.toContain("- echo 4 (exit 0)")
    expect(facts).toContain("- echo 24 (exit 0)")
    expect(facts).toContain("Last plan (update_plan):\nWhy.\n- [pending] Ship")
  })

  test("a failed command line is kept; a plan of an unknown shape is its JSON; nothing recorded says so", () => {
    expect(Brief.brief(whole([turn(0, [tool("TodoWrite", { list: [1] })])]))).toContain(
      'Last plan (TodoWrite):\n{"list":[1]}',
    )
    expect(Brief.brief([])).toBe(`${Brief.HEADER}\n\nNothing was recorded before this point.`)
  })

  test("only the steps of the pieces count: a mid-turn cut leaves out the steps after it", () => {
    const turns = [
      turn(0, [
        tool("exec_command", { cmd: "first" }, { exit: 0 }),
        tool("exec_command", { cmd: "second" }, { exit: 0 }),
      ]),
    ]
    const facts = Brief.brief(Fill.pieces(turns, Fill.START, { turn: 0, step: 1 }))
    expect(facts).toContain("- first (exit 0)")
    expect(facts).not.toContain("second")
  })
})

describe("briefAt (09 §4.4 프로그램 checkpoint)", () => {
  const turns = [
    turn(0, [text("a0")], "first request"),
    turn(1, [tool("exec_command", { cmd: "bun test" }, { exit: 0 }), text("a1")], "second request"),
    turn(2, [text("a2")], "third request"),
    turn(3, [text("a3")], "fourth request"),
  ]
  const foreign: Transcript.Checkpoint = {
    at: { turn: 1, step: 1, source: { uuid: "u1" } },
    kind: "foreign",
    summary: "The tool's own summary.",
    recent: [],
  }
  const later: Transcript.Checkpoint = {
    ...foreign,
    at: { turn: 3, step: 1, source: { uuid: "u2" } },
    summary: "Later.",
  }

  test("summary = the last foreign summary before x + the brief of everything before x", () => {
    const at = Brief.briefAt({ turns, checkpoints: [foreign, later] }, { turn: 3 })
    expect(at.summary).toBe(`The tool's own summary.\n\n${Brief.brief(Fill.pieces(turns, Fill.START, { turn: 3 }))}`)
    expect(at.summary).toContain("- bun test (exit 0)")
    expect(at.summary).not.toContain("Later.")
    // Without a foreign checkpoint before x it is the brief alone.
    expect(Brief.briefAt({ turns, checkpoints: [later] }, { turn: 3 }).summary.startsWith(Brief.HEADER)).toBe(true)
  })

  test("recent = the user requests before x as [User]: lines in their order; a mid-turn x keeps that turn's request", () => {
    expect(Brief.briefAt({ turns, checkpoints: [] }, { turn: 2 }).recent).toBe(
      "[User]: first request\n\n[User]: second request",
    )
    expect(Brief.briefAt({ turns, checkpoints: [] }, { turn: 2, step: 0 }).recent).toBe(
      "[User]: first request\n\n[User]: second request\n\n[User]: third request",
    )
    expect(Brief.briefAt({ turns, checkpoints: [] }, Fill.START)).toEqual({
      summary: `${Brief.HEADER}\n\nNothing was recorded before this point.`,
      recent: "",
    })
  })

  test("newest first up to 20k tokens: the request that does not fit is cut and ends the list", () => {
    const long = "w".repeat(4 * 15_000)
    const big = [
      turn(0, [], "oldest, left out"),
      turn(1, [], long),
      turn(2, [], "y".repeat(4 * 6_000)),
      turn(3, [], "newest"),
    ]
    const recent = Brief.requests(Fill.pieces(big))
    expect(recent.startsWith(`[User]: ${"w".repeat(10)}`)).toBe(true)
    expect(recent).not.toContain("oldest")
    expect(recent).toContain("\n[truncated]\n\n[User]: yyyy")
    expect(recent.endsWith("[User]: newest")).toBe(true)
    const kept = recent.split("\n\n").map((line) => line.replace(/^\[User\]: /, "").replace(/\n\[truncated\]$/, ""))
    expect(kept.reduce((total, line) => total + Token.estimate(line), 0)).toBeLessThanOrEqual(Brief.RECENT_TOKENS)
    expect(kept.reduce((total, line) => total + Token.estimate(line), 0)).toBeGreaterThan(Brief.RECENT_TOKENS - 2)
  })

  test("at a Codex remote boundary, recent equals the requests Codex kept in replacement_history", () => {
    const info = CodexTranscript.parse(
      rollout()
        .meta({ id: threadId(9) })
        .user("turn zero")
        .assistant("zero done")
        .compacted(localSummary("Local summary.", CodexTranscript.SUMMARY_PREFIX), [userItem("turn zero")])
        .user("turn one")
        .call("exec_command", { cmd: "bun test" }, "call_1")
        .compacted("", [userItem("turn one"), compactionItem()])
        .output("call_1", "1 pass")
        .assistant("one done")
        .lines(),
      { rootID: "codex-0123456789ab", path: "C:\\fixture\\r.jsonl", bytes: 1, mtimeMs: T0, now: T0 + 3_600_000 },
    )
    const remote = info.checkpoints.find((item) => item.kind === "codex-remote")
    expect(remote?.at).toMatchObject({ turn: 1, step: 1 })
    const at = Brief.briefAt(info, { turn: 1, step: 1 })
    expect(at.recent).toBe("[User]: turn one")
    expect(at.summary.startsWith("Local summary.\n\n## Facts extracted from the original record")).toBe(true)
    // Elsewhere the requests come from the turns.
    expect(Brief.briefAt(info, { turn: 1, step: 0 }).recent).toBe("[User]: turn zero\n\n[User]: turn one")
  })

  test("the same transcript always gives the same text", () => {
    const one = Brief.briefAt({ turns, checkpoints: [foreign] }, { turn: 3 })
    const two = Brief.briefAt(structuredClone({ turns, checkpoints: [foreign] }), { turn: 3 })
    expect(two).toEqual(one)
  })
})

describe("text helpers", () => {
  test("serialize writes core's recent-line format, entries split by blank lines and tool results cut like core", () => {
    const lines: Transcript.Line[] = [
      { role: "user", text: "fix it" },
      { role: "assistant", text: "Looking." },
      { role: "tool-call", text: 'Bash({"command":"bun test"})' },
      { role: "tool-result", text: "r".repeat(1_300) },
      { role: "assistant", text: "Done." },
    ]
    expect(Brief.serialize(lines)).toBe(
      [
        "[User]: fix it",
        `[Assistant]: Looking.\n[Assistant tool call]: Bash({"command":"bun test"})\n[Tool result]: ${"r".repeat(1_250)}\n[truncated]`,
        "[Assistant]: Done.",
      ].join("\n\n"),
    )
    expect(
      Brief.serialize([
        { role: "user", text: "a" },
        { role: "user", text: "b" },
      ]),
    ).toBe("[User]: a\n\n[User]: b")
  })

  test("truncate counts code points and never splits a surrogate pair", () => {
    expect(Brief.truncate("😀".repeat(3), 2)).toBe("😀😀\n[truncated]")
    expect(Brief.truncate("short")).toBe("short")
  })

  test("command reads cmd or command, a string or an argv; an inline script is the script", () => {
    expect(Brief.command({ cmd: "bun test" })).toBe("bun test")
    expect(Brief.command({ command: ["bash", "-lc", "git status"] })).toBe("git status")
    expect(Brief.command({ command: ["powershell.exe", "-Command", "Get-ChildItem"] })).toBe("Get-ChildItem")
    expect(Brief.command({ command: ["git", "diff", "--stat"] })).toBe("git diff --stat")
    expect(Brief.command({ query: "x" })).toBeUndefined()
    expect(Brief.command("free text")).toBeUndefined()
  })
})

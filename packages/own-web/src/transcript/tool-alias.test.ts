import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { withToolAliases } from "./tool-alias"

function assistant(parts: ReadonlyArray<Record<string, unknown>>) {
  return { id: "msg_1", type: "assistant", content: [...parts] } as unknown as SessionMessageInfo
}

const exec = {
  type: "tool",
  id: "call_1",
  name: "exec_command",
  state: { status: "completed", input: { cmd: "Get-Content a.txt" }, content: [{ type: "text", text: "hi" }] },
}

describe("withToolAliases", () => {
  test("Codex tools draw as session-ui's shell, patch, question and read", () => {
    const message = withToolAliases(
      assistant([
        exec,
        { type: "tool", id: "c2", name: "apply_patch", state: { status: "completed", input: { input: "x" } } },
        { type: "tool", id: "c3", name: "request_user_input", state: { status: "completed", input: {} } },
        { type: "tool", id: "c4", name: "view_image", state: { status: "completed", input: { path: "a.png" } } },
        {
          type: "tool",
          id: "c5",
          name: "write_stdin",
          state: { status: "completed", input: { session_id: 7, chars: "" } },
        },
        { type: "text", id: "t1", text: "done" },
      ]),
    ) as unknown as { content: Array<{ name?: string; state?: { input: Record<string, unknown> } }> }
    expect(message.content.map((part) => part.name)).toEqual(["shell", "patch", "question", "read", "shell", undefined])
    expect(message.content[0]!.state!.input.command).toBe("Get-Content a.txt")
    expect(message.content[4]!.state!.input.command).toBe("write_stdin 7")
  })

  test("Code Mode's exec draws as execute and spawn_agent as a subagent card", () => {
    const message = withToolAliases(
      assistant([
        { type: "tool", id: "c1", name: "exec", state: { status: "completed", input: { input: "text(1)" } } },
        {
          type: "tool",
          id: "c2",
          name: "collaboration__spawn_agent",
          state: { status: "completed", input: { task_name: "helper", message: "Say hi." } },
        },
      ]),
    ) as unknown as { content: Array<{ name?: string; state?: { input: Record<string, unknown> } }> }
    expect(message.content.map((part) => part.name)).toEqual(["execute", "subagent"])
    expect(message.content[0]!.state!.input.code).toBe("text(1)")
    expect(message.content[1]!.state!.input).toMatchObject({ agent: "codex", description: "helper", prompt: "Say hi." })
  })

  test("omo's task and call_omo_agent draw as subagent cards; its todowrite stays the generic card (15)", () => {
    const message = withToolAliases(
      assistant([
        {
          type: "tool",
          id: "c1",
          name: "task",
          state: {
            status: "completed",
            input: { subagent_type: "explore", description: "find add", prompt: "Find add", run_in_background: true },
            metadata: { sessionID: "ses_child" },
          },
        },
        {
          type: "tool",
          id: "c2",
          name: "task",
          state: { status: "running", input: { category: "quick", prompt: "Say hi" }, metadata: {} },
        },
        {
          type: "tool",
          id: "c3",
          name: "call_omo_agent",
          state: { status: "completed", input: { subagent_type: "librarian", description: "docs", prompt: "Read docs" } },
        },
        { type: "tool", id: "c4", name: "todowrite", state: { status: "completed", input: { todos: [] } } },
      ]),
    ) as unknown as {
      content: Array<{ name?: string; state?: { input: Record<string, unknown>; metadata?: Record<string, unknown> } }>
    }
    expect(message.content.map((part) => part.name)).toEqual(["subagent", "subagent", "subagent", "todowrite"])
    expect(message.content[0]!.state!.input).toMatchObject({ agent: "explore", description: "find add", prompt: "Find add" })
    expect(message.content[0]!.state!.metadata).toEqual({ sessionID: "ses_child" })
    expect(message.content[1]!.state!.input).toMatchObject({ agent: "quick", description: "task", prompt: "Say hi" })
    expect(message.content[2]!.state!.input).toMatchObject({ agent: "librarian", description: "docs" })
  })

  test("other messages and parts are the same objects; wrappers are stable", () => {
    const plain = assistant([{ type: "tool", id: "c1", name: "shell", state: { status: "completed", input: {} } }])
    expect(withToolAliases(plain)).toBe(plain)
    const source = assistant([exec])
    const first = withToolAliases(source) as unknown as { content: Array<unknown> }
    const second = withToolAliases(source) as unknown as { content: Array<unknown> }
    expect(first).toBe(second)
    expect(first.content[0]).toBe(second.content[0])
  })

  test("the alias follows the store's later changes", () => {
    const part = { type: "tool", id: "c1", name: "exec_command", state: { status: "running", input: { cmd: "a" } } }
    const message = withToolAliases(assistant([part])) as unknown as { content: Array<{ state: { status: string } }> }
    part.state = { status: "completed", input: { cmd: "a" } }
    expect(message.content[0]!.state.status).toBe("completed")
  })
})

describe("pi harness tools", () => {
  test("bash draws as the shell card; one Pi edit previews as core's edit; read and write stay as they are", () => {
    const read = { type: "tool", id: "p0", name: "read", state: { status: "completed", input: { path: "a.ts" } } }
    const message = withToolAliases(
      assistant([
        { type: "tool", id: "p1", name: "bash", state: { status: "completed", input: { command: "ls -la" } } },
        {
          type: "tool",
          id: "p2",
          name: "edit",
          state: { status: "completed", input: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } },
        },
        {
          type: "tool",
          id: "p3",
          name: "edit",
          state: {
            status: "completed",
            input: {
              path: "a.ts",
              edits: [
                { oldText: "a", newText: "b" },
                { oldText: "c", newText: "d" },
              ],
            },
          },
        },
        read,
      ]),
    ) as unknown as { content: Array<{ name?: string; state?: { input: Record<string, unknown> } }> }
    expect(message.content.map((part) => part.name)).toEqual(["shell", "edit", "edit", "read"])
    expect(message.content[0]!.state!.input.command).toBe("ls -la")
    expect(message.content[1]!.state!.input).toMatchObject({ path: "a.ts", oldString: "a", newString: "b" })
    expect(message.content[2]!.state!.input.oldString).toBeUndefined()
    expect(message.content[3]).toBe(read)
  })

  test("core's own edit is not wrapped", () => {
    const plain = assistant([
      {
        type: "tool",
        id: "e1",
        name: "edit",
        state: { status: "completed", input: { path: "a", oldString: "x", newString: "y" } },
      },
    ])
    expect(withToolAliases(plain)).toBe(plain)
  })
})

describe("dsh harness tools", () => {
  test("pwsh draws as the shell card; read, write and edit get core's field names", () => {
    const message = withToolAliases(
      assistant([
        {
          type: "tool",
          id: "d1",
          name: "pwsh",
          state: { status: "completed", input: { description: "List", command: "Get-ChildItem" } },
        },
        { type: "tool", id: "d2", name: "read", state: { status: "completed", input: { file_path: "a.ts" } } },
        {
          type: "tool",
          id: "d3",
          name: "write",
          state: { status: "completed", input: { file_path: "b.ts", content: "x" } },
        },
        {
          type: "tool",
          id: "d4",
          name: "edit",
          state: {
            status: "completed",
            input: { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true },
          },
        },
      ]),
    ) as unknown as { content: Array<{ name?: string; state?: { input: Record<string, unknown> } }> }
    expect(message.content.map((part) => part.name)).toEqual(["shell", "read", "write", "edit"])
    expect(message.content[0]!.state!.input.command).toBe("Get-ChildItem")
    expect(message.content[1]!.state!.input.path).toBe("a.ts")
    expect(message.content[2]!.state!.input).toMatchObject({ path: "b.ts", content: "x" })
    expect(message.content[3]!.state!.input).toMatchObject({
      path: "a.ts",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    })
  })
})

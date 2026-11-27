import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Fiber } from "effect"
import { z } from "zod"
import { Names } from "../../src/host/names.js"
import { Todos } from "../../src/host/todo.js"
import { Tools } from "../../src/host/tools.js"
import type { V1ToolDefinition, ZodLike } from "../../src/omo-runtime.js"

const agents = Names.agents({ registered: new Map(), keyOf: (name) => name.toLowerCase() })
// SAFETY: the zod package is the copy the runtime bundles (same version); the host only calls these three functions.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const zod = z as unknown as ZodLike
const asked: Array<Record<string, unknown>> = []
const ctx = {
  location: { directory: "C:/work" },
  permission: { assert: (input: Record<string, unknown>) => Effect.sync(() => void asked.push(input)) },
} as unknown as Pick<Context, "permission" | "location">

function context(progress: Array<Record<string, unknown>> = []): Tool.Context {
  return {
    sessionID: "ses_1" as Tool.Context["sessionID"],
    agent: "build" as Tool.Context["agent"],
    messageID: "msg_1" as Tool.Context["messageID"],
    id: Tool.CallID.make("call_1"),
    progress: (update) => Effect.sync(() => void progress.push({ ...update })),
  }
}

function bridged(definition: V1ToolDefinition) {
  return Tools.bridge(ctx, { name: "task", definition, z: zod, agents, permission: "own_harness_omo" })
}

describe("Tools.bridge (15 §3.5)", () => {
  test("named omo_<name>, gated, direct; JSON Schema from the zod arguments, overrides kept, optional ones not required", () => {
    const prompt = z.string().describe("The prompt")
    // omo's normalizeToolArgSchemas attaches an override like this one to every argument.
    Object.assign(prompt._zod, { toJSONSchema: () => ({ type: "string", description: "from the override" }) })
    const tool = bridged({
      description: "Run a task",
      args: { prompt, run_in_background: z.boolean().optional().describe("Background") },
      execute: async () => "ok",
    })
    expect(tool.name).toBe("omo_task")
    expect(tool.options).toEqual({ codemode: false, permission: "own_harness_omo" })
    const schema = (tool.input as { "~standard": { jsonSchema: { input: () => unknown } } })["~standard"].jsonSchema.input()
    expect(schema).toEqual({
      type: "object",
      properties: {
        prompt: { type: "string", description: "from the override" },
        run_in_background: { type: "boolean", description: "Background" },
      },
      required: ["prompt"],
    })
  })

  test("invalid input is a Tool.Error before execute runs", async () => {
    let ran = false
    const tool = bridged({ description: "", args: { prompt: z.string() }, execute: async () => ((ran = true), "x") })
    const exit = await Effect.runPromiseExit(tool.execute({ prompt: 5 }, context()))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("Invalid task input")
    expect(ran).toBe(false)
  })

  test("string and object results; metadata() is progress with sessionId as sessionID; JSON-only metadata", async () => {
    const progress: Array<Record<string, unknown>> = []
    const tool = bridged({
      description: "",
      args: {},
      execute: async (_, v1) => {
        expect(v1).toMatchObject({ sessionID: "ses_1", messageID: "msg_1", agent: Names.SISYPHUS, directory: "C:/work", callID: "call_1" })
        v1.metadata({ title: "Explore", metadata: { sessionId: "ses_child", skipped: undefined } })
        await v1.ask({ permission: "bash", patterns: ["ls"], always: ["ls *"] })
        return { output: "done", title: "Task", metadata: { sessionId: "ses_child", gone: undefined } }
      },
    })
    const result = await Effect.runPromise(tool.execute({}, context(progress)))
    expect(result).toEqual({ content: "done", metadata: { sessionID: "ses_child", sessionId: "ses_child", title: "Task" } })
    await Bun.sleep(10)
    expect(progress).toEqual([{ sessionId: "ses_child", title: "Explore", sessionID: "ses_child" }])
    expect(asked[0]).toMatchObject({ sessionID: "ses_1", action: "bash", resources: ["ls"], save: ["ls *"], source: { type: "tool", messageID: "msg_1", id: "call_1" } })
    const plain = bridged({ description: "", args: {}, execute: async () => "" })
    expect(await Effect.runPromise(plain.execute({}, context()))).toEqual({ content: "(no output)" })
  })

  test("a thrown error is a Tool.Error; interruption aborts the tool's signal", async () => {
    const failing = bridged({ description: "", args: {}, execute: async () => Promise.reject(new Error("nope")) })
    expect(JSON.stringify(await Effect.runPromiseExit(failing.execute({}, context())))).toContain("nope")
    const seen: { aborted?: boolean } = {}
    const waiting = bridged({
      description: "",
      args: {},
      execute: (_, v1) =>
        new Promise<string>((resolve) =>
          v1.abort.addEventListener("abort", () => {
            seen.aborted = true
            resolve("aborted")
          }),
        ),
    })
    const fiber = Effect.runFork(waiting.execute({}, context()))
    await Bun.sleep(20)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(seen.aborted).toBe(true)
  })
})

describe("todowrite (15 §3.6)", () => {
  test("replaces the session's list, tells omo, and answers OpenCode 1's title and JSON", async () => {
    const stored = new Map<string, unknown>()
    const store = new Todos.Store({
      storage: {
        get: (key: string) => Effect.sync(() => stored.get(key) as never),
        set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
        remove: (key: string) => Effect.sync(() => void stored.delete(key)),
        scan: () => Effect.die("unused"),
      },
    } as unknown as Pick<Context, "storage">)
    const emitted: Array<[string, unknown]> = []
    const tool = Todos.tool(store, (sessionID, todos) => Effect.sync(() => void emitted.push([sessionID, todos])), "own_harness_omo")
    expect(tool.name).toBe("omo_todowrite")
    expect(tool.description).toContain("Create and maintain a structured task list")
    const todos = [
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "pending", priority: "low" },
    ]
    const result = await Effect.runPromise(tool.execute({ todos }, context()))
    expect(result.metadata).toEqual({ title: "1 todos", todos })
    expect(JSON.parse(result.content as string)).toEqual(todos)
    expect<unknown>(await Effect.runPromise(store.get("ses_1"))).toEqual(todos)
    expect(emitted).toEqual([["ses_1", todos]])
    expect(JSON.stringify(await Effect.runPromiseExit(tool.execute({ todos: [{ content: "x", status: "done" }] }, context())))).toContain(
      "Invalid todowrite input",
    )
  })
})

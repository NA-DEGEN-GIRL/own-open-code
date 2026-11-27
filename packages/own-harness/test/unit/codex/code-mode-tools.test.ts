import { describe, expect, test } from "bun:test"
import os from "node:os"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Scope, Stream } from "effect"
import { Catalog } from "../../../src/codex/catalog.js"
import { Clock } from "../../../src/codex/clock.js"
import { CodeModeTools } from "../../../src/codex/code-mode-tools.js"
import { ExecManager } from "../../../src/codex/exec/manager.js"
import { GoalRuntime } from "../../../src/codex/goal-runtime.js"

const FULL = CodeModeTools.spec("functions", "exec").description

describe("CodeModeTools.execDescription", () => {
  test("every nested tool present gives Codex's description unchanged", () => {
    const all = new Set([...FULL.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]!))
    expect(CodeModeTools.execDescription(all)).toBe(FULL)
  })

  test("absent tools and their emptied namespaces drop out", () => {
    const text = CodeModeTools.execDescription(CodeModeTools.nestedNames(Catalog.lookup("gpt-5.6-sol")))
    expect(text).toContain("### `exec_command`")
    expect(text).toContain("### `apply_patch`")
    expect(text).toContain("### `read_mcp_resource`")
    expect(text).not.toContain("## clock\n")
    expect(text).not.toContain("## web\n")
    expect(text).not.toContain("## Decision boundary")
    expect(text.indexOf("### `write_stdin`")).toBeGreaterThan(text.indexOf("### `view_image`"))
  })

  test("the clock namespace stays with clock__curr_time", () => {
    const text = CodeModeTools.execDescription(CodeModeTools.nestedNames(Catalog.lookup("gpt-6.1-sol")))
    expect(text).toContain("## clock\nTools for reading and waiting on time.\n\n### `clock__curr_time`")
  })
})

type Event = { readonly type: string; readonly data: { readonly sessionID: string; readonly reason?: string } }

/** Events the test publishes while the plugin's subscription runs, until `end`. */
function channel() {
  const queued: Array<Event> = []
  const state: { resolve?: () => void; ended: boolean } = { ended: false }
  return {
    publish: (event: Event) => {
      queued.push(event)
      state.resolve?.()
    },
    end: () => {
      state.ended = true
      state.resolve?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (!state.ended) {
          while (queued.length > 0) yield queued.shift()!
          await new Promise<void>((resolve) => (state.resolve = resolve))
        }
      },
    },
  }
}

/** A plugin context for `exec`: lookups fail as for an unknown session; synthetic messages are recorded. */
function setup(events: ReadonlyArray<Event> | AsyncIterable<Event>, tools: ReadonlyArray<Tool.Info> = []) {
  const registered = new Map<string, Tool.Info>()
  const admitted: Array<{
    readonly sessionID: string
    readonly text: string
    readonly resume?: boolean
    readonly background?: boolean
    readonly startedAt?: number
  }> = []
  const missing = () => Effect.fail(new Error("not in this test"))
  const ctx = {
    location: { directory: os.tmpdir() },
    session: {
      get: missing,
      hook: () => Effect.void,
      synthetic: (input: (typeof admitted)[number]) => Effect.sync(() => void admitted.push(input)),
    },
    agent: { get: missing },
    mcp: { list: missing },
    event: {
      subscribe: () =>
        Symbol.asyncIterator in events
          ? Stream.fromAsyncIterable(events, (error) => error)
          : Stream.fromIterable(events),
    },
    tool: {
      list: () => Effect.succeed(tools),
      transform: (callback: (editor: { add: (tool: Tool.Info) => void }) => void) =>
        Effect.sync(() => callback({ add: (tool) => void registered.set(tool.name, tool) })),
    },
  }
  const runtimes = new CodeModeTools.Runtimes()
  // The subscription lives until `close`.
  const scope = Effect.runSync(Scope.make())
  const ready = Effect.runPromise(
    CodeModeTools.register(
      ctx as unknown as Parameters<typeof CodeModeTools.register>[0],
      new ExecManager.Manager(),
      runtimes,
      new Clock.Activity(),
      new GoalRuntime.Runtime(ctx as unknown as ConstructorParameters<typeof GoalRuntime.Runtime>[0]),
    ).pipe(Scope.provide(scope)),
  )
  const call = async (name: string, input: unknown) => {
    await ready
    await Bun.sleep(10)
    return Effect.runPromise(
      registered.get(name)!.execute(input, {
        sessionID: "ses_n",
        agent: "build",
        messageID: "msg_n",
        id: "call_n",
        progress: () => Effect.void,
      } as unknown as Tool.Context) as Effect.Effect<Tool.Result, unknown>,
    )
  }
  const exec = (source: string) => call("exec", { input: source })
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
  return { admitted, exec, call, runtimes, close }
}

describe("Code Mode notify", () => {
  test("during a turn each notify is admitted at once as the exec call's extra output; the result has none", async () => {
    const world = setup([{ type: "session.execution.started", data: { sessionID: "ses_n" } }])
    const before = Date.now()
    const done = await world.exec('notify("half way"); notify({ step: 2 }); text("done")')
    expect(JSON.stringify(done.content)).not.toContain("half way")
    expect(world.admitted.map((entry) => entry.text)).toEqual([
      CodeModeTools.notification("call_n", "half way"),
      CodeModeTools.notification("call_n", '{"step":2}'),
    ])
    expect(world.admitted.every((entry) => entry.sessionID === "ses_n" && entry.resume === false)).toBe(true)
    // Background work of the running turn (core P-035, 11 §7.2): it reaches the turn while a context reset waits for
    // it, and a reset that applied since the `exec` call started keeps it out of the new context.
    expect(world.admitted.every((entry) => entry.background === true)).toBe(true)
    const started = world.admitted[0]?.startedAt ?? 0
    expect(started).toBeGreaterThanOrEqual(before)
    expect(world.admitted.every((entry) => entry.startedAt === started)).toBe(true)
    await world.runtimes.terminate()
    await world.close()
  })

  test("outside a turn a notify is dropped, as Codex fails to inject it", async () => {
    const world = setup([])
    await world.exec('notify("nobody listens"); text("done")')
    expect(world.admitted).toEqual([])
    await world.runtimes.terminate()
    await world.close()
  })
})

describe("kept plugin tools in exec", () => {
  const SCREENSHOT = "data:image/png;base64,iVBORw0KGgo="
  // own.computer-use's screenshot as the plugin registers it: an output schema, and the image as a named file part.
  const screenshot = {
    id: "computer_screenshot",
    name: "screenshot",
    description: "Take a screenshot.",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { captureId: { type: "string" } }, required: ["captureId"] },
    options: { namespace: "computer", permission: "computer", codemode: true },
    execute: () =>
      Effect.succeed({
        output: { captureId: "cap_1" },
        content: [
          { type: "text", text: "cap_1: 1429x804 screenshot" },
          { type: "file", uri: SCREENSHOT, mime: "image/png", name: "own-computer-use/cap_1.png" },
        ],
      }),
  } as unknown as Tool.Info
  const plain = {
    ...screenshot,
    id: "notes_read",
    name: "read",
    output: undefined,
    options: { namespace: "notes", codemode: true },
    execute: () =>
      Effect.succeed({ content: [{ type: "file", uri: SCREENSHOT, mime: "image/png", name: "notes/page.png" }] }),
  } as unknown as Tool.Info

  test("a tool with an output schema gives the program its output, and its images reach the cell output", async () => {
    const world = setup([], [screenshot])
    const done = await world.exec("const shot = await tools.computer__screenshot({}); text(shot.captureId)")
    const parts = typeof done.content === "string" ? [] : (done.content ?? [])
    expect(parts.filter((part) => part.type === "file")).toEqual([
      { type: "file", mime: "image/png", uri: SCREENSHOT, name: "own-computer-use/cap_1.png" },
    ])
    expect(JSON.stringify(parts.filter((part) => part.type === "text"))).toContain("cap_1")
    // The program's value is the output alone: no data URL in its text.
    expect(JSON.stringify(parts.filter((part) => part.type === "text"))).not.toContain("base64")
    await world.runtimes.terminate()
    await world.close()
  })

  test("a tool without an output schema hands the data URL over in its text, as Codex does; nothing is added", async () => {
    const world = setup([], [plain])
    const done = await world.exec(
      "const page = await tools.notes__read({}); text(page.length > 0 ? 'got it' : 'empty')",
    )
    const parts = typeof done.content === "string" ? [] : (done.content ?? [])
    expect(parts.filter((part) => part.type === "file")).toEqual([])
    expect(JSON.stringify(parts)).toContain("got it")
    await world.runtimes.terminate()
    await world.close()
  })
})

describe("Code Mode interrupt", () => {
  const text = (result: Tool.Result) =>
    (typeof result.content === "string" ? [result.content] : (result.content ?? [])).map((item) =>
      typeof item === "string" ? item : item.type === "text" ? item.text : item.type,
    )

  // #51835: a user's stop ends the cells an earlier `exec` left running; the store stays. A shutdown does not.
  test("a user interrupt ends the session's yielded cells and keeps stored values; a shutdown keeps them", async () => {
    const events = channel()
    const world = setup(events.iterable)
    events.publish({ type: "session.execution.started", data: { sessionID: "ses_n" } })
    await world.exec('store("persisted", "preserved")')
    const yielded = await world.exec("yield_control(); await new Promise(() => {})")
    expect(text(yielded)[0]).toStartWith("Script running with cell ID 2")
    const kept = await world.exec("yield_control(); await new Promise(() => {})")
    expect(text(kept)[0]).toStartWith("Script running with cell ID 3")

    events.publish({ type: "session.execution.interrupted", data: { sessionID: "ses_n", reason: "shutdown" } })
    await Bun.sleep(50)
    expect(text(await world.call("wait", { cell_id: "2", yield_time_ms: 1 }))[0]).toStartWith(
      "Script running with cell ID 2",
    )

    events.publish({ type: "session.execution.interrupted", data: { sessionID: "ses_n", reason: "user" } })
    await Bun.sleep(50)
    for (const cell of ["2", "3"])
      expect(text(await world.call("wait", { cell_id: cell, yield_time_ms: 1 }))).toEqual([
        expect.stringMatching(/^Script failed\n/),
        `Script error:\nexec cell ${cell} not found`,
      ])
    expect(text(await world.exec('text(load("persisted"))')).slice(1)).toEqual(["preserved"])
    await world.runtimes.terminate()
    events.end()
    await world.close()
  })
})

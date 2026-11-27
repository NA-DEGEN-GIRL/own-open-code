import { describe, expect, test } from "bun:test"
import { CodeModeRuntime } from "../../../src/codex/code-mode/index.js"
import { CodeModePragma } from "../../../src/codex/code-mode/pragma.js"

const PNG = "data:image/png;base64,iVBORw0KGgo="

/** The status line of a response's header item, after checking the header's exact shape. */
function header(items: ReadonlyArray<CodeModeRuntime.ContentItem>) {
  const first = items[0]
  if (first?.type !== "text") throw new Error("missing header")
  expect(first.text).toMatch(/^[^\n]+\nWall time \d+\.\d seconds\nOutput:\n$/)
  return first.text.split("\n")[0]
}

function texts(items: ReadonlyArray<CodeModeRuntime.ContentItem>) {
  return items.slice(1).map((item) => (item.type === "text" ? item.text : item.type))
}

const execCommand = (calls: Array<unknown>): CodeModeRuntime.NestedTool => ({
  name: "exec_command",
  description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
  input: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  execute: async (input) => {
    calls.push(input)
    return { wall_time_seconds: 0.1, exit_code: 0, output: "hello from the workspace\r\n" }
  },
})

describe("exec", () => {
  test("text() output under the Codex header", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec('text("hello")', [])
    expect(items).toEqual([
      { type: "text", text: expect.stringMatching(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/) },
      { type: "text", text: "hello" },
    ])
  })

  test("text() stringifies non-strings like Codex", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      "text(1); text(true); text(null); text(undefined); text({ a: [1, 'x'] }); text(['y'])",
      [],
    )
    expect(texts(items)).toEqual(["1", "true", "null", "undefined", '{"a":[1,"x"]}', '["y"]'])
  })

  test("replays the captured GPT-6 exec_command cell", async () => {
    const calls: Array<unknown> = []
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      'const result = await tools.exec_command({ cmd: "Get-Content hello.txt" });\ntext(result.output);',
      [execCommand(calls)],
    )
    expect(calls).toEqual([{ cmd: "Get-Content hello.txt" }])
    expect(header(items)).toBe("Script completed")
    expect(items.slice(1)).toEqual([{ type: "text", text: "hello from the workspace\r\n" }])
  })

  test("nested tools return objects and receive JSON-serialized input", async () => {
    const calls: Array<unknown> = []
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      "const r = await tools.exec_command({ cmd: 'ls', skip: undefined, when: new Date(0) }); text(r); text(r.exit_code)",
      [execCommand(calls)],
    )
    expect(calls).toEqual([{ cmd: "ls", when: "1970-01-01T00:00:00.000Z" }])
    expect(texts(items)).toEqual([
      '{"wall_time_seconds":0.1,"exit_code":0,"output":"hello from the workspace\\r\\n"}',
      "0",
    ])
  })

  test("function tools take an object, freeform tools a string", async () => {
    const received: Array<unknown> = []
    const patch: CodeModeRuntime.NestedTool = {
      name: "apply_patch",
      description: "Applies a patch.",
      input: "string",
      execute: async (input) => {
        received.push(input)
        return "Success."
      },
    }
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      [
        'text(await tools.apply_patch("*** Begin Patch"))',
        "await tools.exec_command()",
        'try { await tools.exec_command("ls") } catch (e) { text(typeof e + ": " + e) }',
        "try { await tools.apply_patch({}) } catch (e) { text(e) }",
      ].join("\n"),
      [patch, execCommand(received)],
    )
    expect(received).toEqual(["*** Begin Patch", {}])
    expect(texts(items)).toEqual([
      "Success.",
      "string: tool `exec_command` expects a JSON object for arguments",
      "tool `apply_patch` expects a string input",
    ])
  })

  test("a rejected tool call reaches the program as its message string", async () => {
    const failing: CodeModeRuntime.NestedTool = {
      name: "flaky",
      description: "Always fails.",
      input: { type: "object" },
      execute: async () => {
        throw new Error("permission denied")
      },
    }
    const session = new CodeModeRuntime.Session()
    const caught = await session.exec("try { await tools.flaky({}) } catch (e) { text(typeof e + ': ' + e) }", [
      failing,
    ])
    expect(texts(caught)).toEqual(["string: permission denied"])
    const uncaught = await session.exec("await tools.flaky({})", [failing])
    expect(header(uncaught)).toBe("Script failed")
    expect(texts(uncaught)).toEqual(["Script error:\npermission denied"])
  })

  test("ALL_TOOLS lists the enabled tools sorted by name", async () => {
    const tool = (name: string): CodeModeRuntime.NestedTool => ({
      name,
      description: `${name} tool`,
      input: { type: "object" },
      execute: async () => null,
    })
    const session = new CodeModeRuntime.Session()
    const items = await session.exec("text(ALL_TOOLS); text(Object.keys(tools))", [
      tool("zeta"),
      tool("alpha"),
      tool("zeta"),
    ])
    expect(texts(items)).toEqual([
      '[{"name":"alpha","description":"alpha tool"},{"name":"zeta","description":"zeta tool"}]',
      '["alpha","zeta"]',
    ])
  })

  test("the model's declarations may shadow helpers", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec("const tools = [1, 2]; var store = 3; text(tools.length + store)", [])
    expect(header(items)).toBe("Script completed")
    expect(texts(items)).toEqual(["5"])
  })

  test("store() and load() persist across cells; load of a missing key is undefined", async () => {
    const session = new CodeModeRuntime.Session()
    await session.exec('store("config", { retries: 3, tags: ["a"] }); text(load("config").retries)', [])
    const items = await session.exec(
      'const c = load("config"); c.retries = 9; text(load("config")); text(load("missing"))',
      [],
    )
    expect(texts(items)).toEqual(['{"retries":3,"tags":["a"]}', "undefined"])
    const failure = await session.exec('store("x", undefined)', [])
    expect(texts(failure)).toEqual([
      'Script error:\nUnable to store "x". Only plain serializable objects can be stored.',
    ])
  })

  test("stored values reach later cells only once the writing cell completes", async () => {
    const session = new CodeModeRuntime.Session()
    const first = await session.exec(
      '// @exec: {"yield_time_ms": 50}\nstore("k", 1); await new Promise((resolve) => setTimeout(resolve, 300))',
      [],
    )
    expect(header(first)).toBe("Script running with cell ID 1")
    expect(texts(await session.exec('text(load("k"))', []))).toEqual(["undefined"])
    expect(header(await session.wait({ cell_id: "1" }))).toBe("Script completed")
    expect(texts(await session.exec('text(load("k"))', []))).toEqual(["1"])
  })

  test("a failed exec reports Script failed with the error item last", async () => {
    const session = new CodeModeRuntime.Session()
    const thrown = await session.exec('text("before")\nthrow new Error("boom")', [])
    expect(header(thrown)).toBe("Script failed")
    expect(texts(thrown)).toEqual(["before", "Script error:\nError: boom"])
    const located = await session.exec("const value = null\nvalue.field", [])
    expect(texts(located)).toEqual([
      "Script error:\nTypeError: Cannot read properties of null (reading 'field').\n    at exec_main.mjs:2:1",
    ])
    const thrownString = await session.exec('throw "plain"', [])
    expect(texts(thrownString)).toEqual(["Script error:\nplain"])
    const syntax = await session.exec("const x = ;", [])
    expect(texts(syntax)).toEqual(["Script error:\nSyntaxError: Unexpected token (1:10)"])
  })

  test("exit() ends the script successfully", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec('text("a")\nexit()\ntext("b")', [])
    expect(header(items)).toBe("Script completed")
    expect(texts(items)).toEqual(["a"])
  })

  // Codex's `exit_stops_the_whole_cell_and_preserves_only_prior_writes` (#52748), for the cases the interpreter can
  // express (it has no getters in object literals, so the exception-stack-getter case has no counterpart).
  test.each([
    ["exit inside an infinite loop", "for (;;) { exit(); }"],
    ["an infinite loop after exit", "exit(); for (;;) {}"],
    ["an invalid helper after exit", "try { exit(); image(null); } catch { for (;;) {} }"],
    [
      "catch and finally",
      'try { exit(); } catch { text("caught"); } finally { store("phase", "finally"); text("finally"); }',
    ],
    [
      "a queued microtask",
      'Promise.resolve().then(() => { store("phase", "microtask"); text("microtask"); }); exit();',
    ],
    [
      "an unawaited promise",
      'Promise.resolve().then(() => exit()).catch(() => text("caught")); await new Promise(() => {});',
    ],
    ["an async body", 'await Promise.resolve(); try { exit(); } finally { text("finally"); }'],
    [
      "parallel promises",
      'await Promise.all([Promise.resolve().then(() => exit()), Promise.resolve().then(() => { store("phase", "sibling"); text("sibling"); })]);',
    ],
    [
      "a timer callback",
      'setTimeout(() => { try { exit(); } catch { text("caught"); } finally { text("finally"); } }, 0); await new Promise(() => {});',
    ],
    [
      "a microtask of a timer callback",
      "setTimeout(() => { Promise.resolve().then(() => exit()); }, 0); await new Promise(() => {});",
    ],
    [
      "a pending timer",
      'setTimeout(() => { store("phase", "timer"); text("timer"); }, 20); exit(); await new Promise((resolve) => setTimeout(resolve, 100));',
    ],
    [
      "after an awaited timer",
      'await new Promise((resolve) => setTimeout(resolve, 0)); try { exit(); } catch { text("caught"); }',
    ],
    ["text toJSON", 'try { text({ toJSON() { exit(); } }); } catch { text("caught"); } finally { text("finally"); }'],
    [
      "store toJSON",
      'try { store("phase", { toJSON() { exit(); } }); } catch { text("caught"); } finally { text("finally"); }',
    ],
    [
      "store key coercion",
      'try { store({ toString() { exit(); } }, "late"); } catch { text("caught"); } finally { text("finally"); }',
    ],
  ])("exit() stops the whole cell and keeps only earlier writes: %s", async (_, source) => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      `// @exec: {"yield_time_ms": 5000}\nstore("phase", "before"); text("before"); ${source} store("phase", "after"); text("after");`,
      [],
    )
    expect(header(items)).toBe("Script completed")
    expect(texts(items)).toEqual(["before"])
    const next = await session.exec('text(load("phase"))', [])
    expect(header(next)).toBe("Script completed")
    expect(texts(next)).toEqual(["before"])
  })

  test("after exit() no host function has an effect, a nested call never starts and timers do not fire", async () => {
    const calls: Array<unknown> = []
    const notified: Array<string> = []
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      [
        'text("before"); notify("before"); store("phase", "before")',
        'const early = setTimeout(() => text("early timer"), 30)',
        "exit()",
        // Reached only if the interruption had not landed yet: each call must be a no-op.
        'text("late"); notify("late"); store("phase", "late"); yield_control(); clearTimeout(early)',
        'tools.exec_command({ cmd: "late" }); setTimeout(() => text("late timer"), 0)',
      ].join("\n"),
      [execCommand(calls)],
      { onNotify: (text) => void notified.push(text) },
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(header(items)).toBe("Script completed")
    expect(texts(items)).toEqual(["before"])
    expect(notified).toEqual(["before"])
    expect(calls).toEqual([])
    expect(texts(await session.exec('text(load("phase"))', []))).toEqual(["before"])
  })

  test("exit() after a yield and a tool response completes the cell for the next wait", async () => {
    const release = Promise.withResolvers<void>()
    const echo: CodeModeRuntime.NestedTool = {
      name: "echo",
      description: "Answers when released.",
      input: { type: "object" },
      execute: async () => {
        await release.promise
        return {}
      },
    }
    const session = new CodeModeRuntime.Session()
    const first = await session.exec(
      [
        '// @exec: {"yield_time_ms": 50}',
        'text("before yield")',
        "await tools.echo({})",
        'store("phase", "after tool"); text("after tool")',
        'try { exit() } catch { text("caught") } finally { text("finally") }',
        'text("after exit")',
      ].join("\n"),
      [echo],
    )
    expect(header(first)).toBe("Script running with cell ID 1")
    expect(texts(first)).toEqual(["before yield"])
    release.resolve()
    const done = await session.wait({ cell_id: "1", yield_time_ms: 5_000 })
    expect(header(done)).toBe("Script completed")
    expect(texts(done)).toEqual(["after tool"])
    expect(texts(await session.exec('text(load("phase"))', []))).toEqual(["after tool"])
  })

  test("exit() cuts off a pending nested call, which a completed cell leaves running", async () => {
    const signals: Array<{ readonly signal: AbortSignal; readonly terminated: AbortSignal }> = []
    const slow: CodeModeRuntime.NestedTool = {
      name: "slow",
      description: "Never finishes.",
      input: { type: "object" },
      execute: (_, context) => {
        signals.push(context)
        return new Promise(() => {})
      },
    }
    const session = new CodeModeRuntime.Session()
    await session.exec("tools.slow({}); text(1)", [slow])
    await session.exec("tools.slow({}); exit()", [slow])
    expect(signals.map((context) => [context.signal.aborted, context.terminated.aborted])).toEqual([
      [true, false],
      [true, true],
    ])
  })

  test("image() appends image items with Codex's validation", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      [
        `image("${PNG}")`,
        `image({ image_url: "${PNG}", detail: "LOW" })`,
        `image({ image_url: "${PNG}", detail: "low" }, "original")`,
        `image({ type: "image", data: "AAAA", mimeType: "image/jpeg", _meta: { "codex/imageDetail": "auto" } })`,
      ].join("\n"),
      [],
    )
    expect(items.slice(1)).toEqual([
      { type: "image", image_url: PNG, detail: "high" },
      { type: "image", image_url: PNG, detail: "low" },
      { type: "image", image_url: PNG, detail: "original" },
      { type: "image", image_url: "data:image/jpeg;base64,AAAA", detail: "auto" },
    ])
    const remote = await session.exec('image("https://example.com/a.png")', [])
    expect(texts(remote)).toEqual([
      "Script error:\nTool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead",
    ])
    const sanitized = await new CodeModeRuntime.Session({ supportsOriginalImageDetail: false }).exec(
      `image("${PNG}", "original")`,
      [],
    )
    expect(sanitized.slice(1)).toEqual([{ type: "image", image_url: PNG, detail: "high" }])
  })

  test("audio() and generatedImage() append their items", async () => {
    // A 16-bit mono 8 kHz PCM WAV holding one frame: far shorter than 25 ms.
    const header = Buffer.alloc(44)
    header.write("RIFF", 0, "latin1")
    header.writeUInt32LE(38, 4)
    header.write("WAVEfmt ", 8, "latin1")
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(8000, 24)
    header.writeUInt32LE(16000, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write("data", 36, "latin1")
    header.writeUInt32LE(2, 40)
    const tiny = `data:audio/wav;base64,${Buffer.concat([header, Buffer.alloc(2)]).toString("base64")}`
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      [
        'audio({ type: "audio", data: "AAAA", mimeType: "audio/mpeg" })',
        `audio("${tiny}")`,
        `generatedImage({ image_url: "${PNG}", output_hint: "Saved to out.png" })`,
      ].join("\n"),
      [],
    )
    expect(items.slice(1)).toEqual([
      { type: "audio", audio_url: "data:audio/mpeg;base64,AAAA" },
      { type: "text", text: "Audio output omitted because the clip is shorter than 25 ms; use a longer clip." },
      { type: "image", image_url: PNG, detail: "high" },
      { type: "text", text: "Saved to out.png" },
    ])
  })

  test("unsupported syntax fails the cell with the interpreter's explanation", async () => {
    // Classes run since the interpreter's class support (upstream #64965); `debugger` is still refused.
    const session = new CodeModeRuntime.Session()
    const items = await session.exec("debugger", [])
    expect(header(items)).toBe("Script failed")
    expect(texts(items)[0]).toStartWith("Script error:\nSyntaxError: Syntax 'DebuggerStatement' is not supported.")
  })

  test("notify() hands non-empty text to the host", async () => {
    const notified: Array<string> = []
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      'notify("working"); notify({ step: 1 }); try { notify("  ") } catch (e) { text(e) }',
      [],
      {
        onNotify: (text) => {
          notified.push(text)
        },
      },
    )
    expect(notified).toEqual(["working", '{"step":1}'])
    expect(texts(items)).toEqual(["notify expects non-empty text"])
  })

  test("pending timeouts do not keep the cell alive; clearTimeout cancels", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      [
        'clearTimeout(setTimeout(() => text("cancelled"), 10))',
        'await new Promise((resolve) => setTimeout(() => { text("fired"); resolve() }, 20))',
        'setTimeout(() => text("late"), 3600000)',
        'text("done")',
      ].join("\n"),
      [],
    )
    expect(header(items)).toBe("Script completed")
    expect(texts(items)).toEqual(["fired", "done"])
  })

  test("max_output_tokens truncates the output but never the header", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      '// @exec: {"max_output_tokens": 5}\ntext("0123456789012345678901234567890123456789")',
      [],
    )
    expect(header(items)).toBe("Script completed")
    expect(texts(items)).toEqual([
      "Warning: truncated output (original token count: 10)\nTotal output lines: 1\n\n0123456789…5 tokens truncated…0123456789",
    ])
  })
})

describe("yield and wait", () => {
  test("a short yield_time_ms returns the running cell, wait returns the rest", async () => {
    const session = new CodeModeRuntime.Session()
    const first = await session.exec(
      '// @exec: {"yield_time_ms": 50}\ntext("a")\nawait new Promise((resolve) => setTimeout(resolve, 300))\ntext("b")',
      [],
    )
    expect(header(first)).toBe("Script running with cell ID 1")
    expect(texts(first)).toEqual(["a"])
    const second = await session.wait({ cell_id: "1", yield_time_ms: 5_000 })
    expect(header(second)).toBe("Script completed")
    expect(texts(second)).toEqual(["b"])
    const gone = await session.wait({ cell_id: "1" })
    expect(texts(gone)).toEqual(["Script error:\nexec cell 1 not found"])
  })

  test("wait yields again while the cell keeps running, then returns a buffered completion", async () => {
    const session = new CodeModeRuntime.Session()
    await session.exec(
      '// @exec: {"yield_time_ms": 20}\nawait new Promise((resolve) => setTimeout(resolve, 200))\ntext("end")',
      [],
    )
    const again = await session.wait({ cell_id: "1", yield_time_ms: 20 })
    expect(header(again)).toBe("Script running with cell ID 1")
    expect(texts(again)).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 300))
    const done = await session.wait({ cell_id: "1", yield_time_ms: 20 })
    expect(header(done)).toBe("Script completed")
    expect(texts(done)).toEqual(["end"])
  })

  test("yield_control() yields the accumulated output immediately", async () => {
    const session = new CodeModeRuntime.Session()
    const started = performance.now()
    const first = await session.exec(
      'text("first")\nyield_control()\nawait new Promise((resolve) => setTimeout(resolve, 100))\ntext("second")',
      [],
    )
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(header(first)).toBe("Script running with cell ID 1")
    expect(texts(first)).toEqual(["first"])
    const rest = await session.wait({ cell_id: "1" })
    expect(header(rest)).toBe("Script completed")
    expect(texts(rest)).toEqual(["second"])
  })

  test("a cell awaiting a promise nothing settles keeps running until terminated, as V8 does", async () => {
    // Upstream v2.2's interpreter fails such a program at once; Codex's runtime keeps the cell (its tests rely on it).
    const session = new CodeModeRuntime.Session()
    const running = await session.exec(
      '// @exec: {"yield_time_ms": 10}\ntext("before"); await new Promise(() => {})',
      [],
    )
    expect(header(running)).toBe("Script running with cell ID 1")
    expect(texts(running)).toEqual(["before"])
    expect(header(await session.wait({ cell_id: "1", yield_time_ms: 10 }))).toBe("Script running with cell ID 1")
    expect(header(await session.wait({ cell_id: "1", terminate: true }))).toBe("Script terminated")
    // A finished program is not held by that pending host call.
    expect(header(await session.exec("text(1)", []))).toBe("Script completed")
  })

  test("cell IDs count up per session", async () => {
    const session = new CodeModeRuntime.Session()
    await session.exec("text(1)", [])
    const second = await session.exec('// @exec: {"yield_time_ms": 10}\nawait new Promise(() => {})', [])
    expect(header(second)).toBe("Script running with cell ID 2")
    await session.terminateAll()
  })

  test("wait with terminate stops a running cell, even a busy loop", async () => {
    const session = new CodeModeRuntime.Session()
    const first = await session.exec('// @exec: {"yield_time_ms": 50}\ntext("start")\nwhile (true) {}', [])
    expect(header(first)).toBe("Script running with cell ID 1")
    const stopped = await session.wait({ cell_id: "1", terminate: true })
    expect(header(stopped)).toBe("Script terminated")
    expect(texts(stopped)).toEqual([])
    expect(texts(await session.wait({ cell_id: "1" }))).toEqual(["Script error:\nexec cell 1 not found"])
  })

  test("terminate cancels nested tool calls and keeps unobserved output", async () => {
    const signals: Array<AbortSignal> = []
    const slow: CodeModeRuntime.NestedTool = {
      name: "slow",
      description: "Never finishes.",
      input: { type: "object" },
      execute: (_, context) => {
        signals.push(context.signal)
        return new Promise(() => {})
      },
    }
    const session = new CodeModeRuntime.Session()
    await session.exec('// @exec: {"yield_time_ms": 50}\nsetTimeout(() => text("tick"), 60)\nawait tools.slow({})', [
      slow,
    ])
    await new Promise((resolve) => setTimeout(resolve, 150))
    const stopped = await session.wait({ cell_id: "1", terminate: true })
    expect(header(stopped)).toBe("Script terminated")
    expect(texts(stopped)).toEqual(["tick"])
    expect(signals.map((signal) => signal.aborted)).toEqual([true])
  })

  // Codex's `code_mode_interrupt_terminates_active_cells_and_nested_tools` (#51835) at the runtime: a cell yielded by
  // an earlier `exec` and one whose nested call is still running both end, and the store stays.
  test("terminating all cells ends yielded and active ones with their nested calls and keeps stored values", async () => {
    const contexts: Array<CodeModeRuntime.ToolContext> = []
    const slow: CodeModeRuntime.NestedTool = {
      name: "slow",
      description: "Never finishes.",
      input: { type: "object" },
      execute: (_, context) => {
        contexts.push(context)
        return new Promise(() => {})
      },
    }
    const session = new CodeModeRuntime.Session()
    await session.exec('store("persisted", "preserved")', [])
    const background = await session.exec("yield_control(); await new Promise(() => {})", [])
    expect(header(background)).toBe("Script running with cell ID 2")
    const active = session.exec("await tools.slow({ sleep_after_ms: 60000 })", [slow])
    while (contexts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    await session.terminateAll()
    expect(header(await active)).toBe("Script terminated")
    expect(contexts.map((context) => [context.cellId, context.signal.aborted, context.terminated.aborted])).toEqual([
      ["3", true, true],
    ])
    expect(texts(await session.wait({ cell_id: "2", yield_time_ms: 1 }))).toEqual([
      "Script error:\nexec cell 2 not found",
    ])
    expect(texts(await session.wait({ cell_id: "3", yield_time_ms: 1 }))).toEqual([
      "Script error:\nexec cell 3 not found",
    ])
    expect(texts(await session.exec('text(load("persisted"))', []))).toEqual(["preserved"])
  })

  test("a second concurrent wait is refused", async () => {
    const session = new CodeModeRuntime.Session()
    await session.exec('// @exec: {"yield_time_ms": 10}\nawait new Promise(() => {})', [])
    const waiting = session.wait({ cell_id: "1", yield_time_ms: 200 })
    expect(session.wait({ cell_id: "1" })).rejects.toThrow("exec cell 1 already has an active observer")
    expect(header(await waiting)).toBe("Script running with cell ID 1")
    await session.terminateAll()
  })

  test("an unknown cell fails with Codex's not-found text", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.wait({ cell_id: "99" })
    expect(items).toEqual([
      { type: "text", text: expect.stringMatching(/^Script failed\nWall time \d+\.\d seconds\nOutput:\n$/) },
      { type: "text", text: "Script error:\nexec cell 99 not found" },
    ])
    const terminated = await session.wait({ cell_id: "99", terminate: true })
    expect(texts(terminated)).toEqual(["Script error:\nexec cell 99 not found"])
  })

  test("a throwing timeout callback fails the cell", async () => {
    const session = new CodeModeRuntime.Session()
    const items = await session.exec(
      'setTimeout(() => { throw new TypeError("bad tick") }, 10)\nawait new Promise((resolve) => setTimeout(resolve, 5000))',
      [],
    )
    expect(header(items)).toBe("Script failed")
    expect(texts(items)).toEqual(["Script error:\nTypeError: bad tick"])
  })
})

describe("pragma", () => {
  test("parses the first-line pragma and keeps the rest as code", () => {
    expect(CodeModePragma.parseExecSource("text('hi')")).toEqual({ code: "text('hi')" })
    expect(CodeModePragma.parseExecSource("// @exec: {\"yield_time_ms\": 10}\ntext('hi')")).toEqual({
      code: "text('hi')",
      yieldTimeMs: 10,
    })
    expect(
      CodeModePragma.parseExecSource('  // @exec: {"yield_time_ms": null, "max_output_tokens": 7}\r\ntext(1)\nmore'),
    ).toEqual({ code: "text(1)\nmore", maxOutputTokens: 7 })
  })

  test("rejects invalid pragmas with Codex's messages", () => {
    const error = (input: string) => {
      try {
        CodeModePragma.parseExecSource(input)
      } catch (caught) {
        expect(caught).toBeInstanceOf(CodeModeRuntime.RespondToModelError)
        return (caught as Error).message
      }
      throw new Error("expected a pragma error")
    }
    expect(error("   ")).toBe(
      'exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.',
    )
    expect(error('// @exec: {"yield_time_ms": 1}\n  ')).toBe(
      "exec pragma must be followed by JavaScript source on subsequent lines",
    )
    expect(error("// @exec:\ntext(1)")).toBe(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
    )
    expect(error("// @exec: [1]\ntext(1)")).toBe(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
    )
    expect(error("// @exec: {nope}\ntext(1)")).toStartWith(
      "exec pragma must be valid JSON with supported fields `yield_time_ms` and `max_output_tokens`: ",
    )
    expect(error('// @exec: {"timeout": 1}\ntext(1)')).toBe(
      "exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `timeout`",
    )
    expect(error('// @exec: {"yield_time_ms": -1}\ntext(1)')).toBe(
      "exec pragma fields `yield_time_ms` and `max_output_tokens` must be non-negative safe integers: invalid value: integer `-1`, expected u64",
    )
    expect(error('// @exec: {"max_output_tokens": "5"}\ntext(1)')).toBe(
      'exec pragma fields `yield_time_ms` and `max_output_tokens` must be non-negative safe integers: invalid type: string "5", expected usize',
    )
    expect(error('// @exec: {"yield_time_ms": 9007199254740993}\ntext(1)')).toBe(
      "exec pragma field `yield_time_ms` must be a non-negative safe integer",
    )
  })

  test("exec rejects a bad pragma without allocating a cell", async () => {
    const session = new CodeModeRuntime.Session()
    expect(session.exec('// @exec: {"bogus": 1}\ntext(1)', [])).rejects.toThrow(
      "exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `bogus`",
    )
    const items = await session.exec('// @exec: {"yield_time_ms": 10}\nawait new Promise(() => {})', [])
    expect(header(items)).toBe("Script running with cell ID 1")
    await session.terminateAll()
  })
})

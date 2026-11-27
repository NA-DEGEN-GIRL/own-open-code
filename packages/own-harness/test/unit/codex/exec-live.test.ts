// The live view of running commands (exec/live.ts): exec_command and write_stdin publish the output so far as progress
// while they wait, Code Mode's `exec` shows its nested command's output the same way, and none of it changes the
// result the model gets. Real short-lived processes, as in exec.test.ts.
import { describe, expect, test } from "bun:test"
import os from "node:os"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Stream } from "effect"
import { Clock } from "../../../src/codex/clock.js"
import { CodeModeTools } from "../../../src/codex/code-mode-tools.js"
import { ExecLive } from "../../../src/codex/exec/live.js"
import { ExecManager } from "../../../src/codex/exec/manager.js"
import { ExecOutput } from "../../../src/codex/exec/output.js"
import { GoalRuntime } from "../../../src/codex/goal-runtime.js"
import { CodexTools } from "../../../src/codex/tools.js"

const POLICY = { mode: "tokens", limit: 10_000 } as const
const shell = ExecManager.defaultShell()
/** Prints `line 1` … `line <count>`, pausing between lines. */
const slowLines = (count: number, pauseMs: number) =>
  shell.type === "powershell"
    ? `1..${count} | ForEach-Object { Write-Output "line $_"; Start-Sleep -Milliseconds ${pauseMs} }`
    : `for i in $(seq 1 ${count}); do echo "line $i"; sleep ${pauseMs / 1000}; done`

type Update = { readonly at: number; readonly metadata: Record<string, unknown> }

function toolContext(updates: Array<Update>, sessionID = "ses_live"): Tool.Context {
  return {
    sessionID,
    agent: "build",
    messageID: "msg_live",
    id: "call_live",
    progress: (metadata: Tool.Metadata) =>
      Effect.sync(() => void updates.push({ at: Date.now(), metadata: { ...metadata } })),
  } as unknown as Tool.Context
}

/** What the exec tools read from the plugin context; lookups the tests do not need fail, as for an unknown session. */
const missing = () => Effect.fail(new Error("not in this test"))
function pluginContext(registered?: Map<string, Tool.Info>) {
  return {
    location: { directory: os.tmpdir() },
    shell: { authorize: (input: { readonly cwd: string }) => Effect.succeed({ cwd: input.cwd }) },
    session: { get: missing, hook: () => Effect.void },
    event: { subscribe: () => Stream.never },
    agent: { get: missing },
    mcp: { list: missing },
    permission: {},
    storage: { get: () => Effect.succeed(undefined), set: () => Effect.void, remove: () => Effect.void },
    tool: {
      list: () => Effect.succeed([]),
      transform: (callback: (editor: { add: (tool: Tool.Info) => void; get: () => undefined }) => void) =>
        Effect.sync(() => callback({ add: (tool) => void registered?.set(tool.name, tool), get: () => undefined })),
    },
  }
}

type Ctx = Parameters<typeof CodexTools.runExec>[0]

const outputs = (updates: ReadonlyArray<Update>) => updates.map((update) => String(update.metadata.output))

describe("ExecLive.Tail", () => {
  test("keeps the last MAX_CHARS characters across chunks", () => {
    const tail = new ExecLive.Tail()
    const chunk = new TextEncoder().encode("0123456789".repeat(1_000))
    Array.from({ length: 20 }, () => tail.push(chunk))
    const text = tail.text()
    expect(text.length).toBe(ExecLive.MAX_CHARS)
    expect(text.endsWith("0123456789")).toBe(true)
    expect(tail.version).toBe(20)
  })

  test("a character split across chunks decodes whole", () => {
    const tail = new ExecLive.Tail()
    const bytes = new TextEncoder().encode("가나")
    tail.push(bytes.subarray(0, 2))
    tail.push(bytes.subarray(2))
    expect(tail.text()).toBe("가나")
  })
})

describe("live command output", () => {
  test("exec_command publishes its growing output while it waits; the result is the same as without", async () => {
    const manager = new ExecManager.Manager()
    const updates: Array<Update> = []
    const command = slowLines(5, 400)
    const outcome = await Effect.runPromise(
      CodexTools.runExec(
        pluginContext() as unknown as Ctx,
        manager,
        // 30 s like the plain run below: the call returns once the command ends (about 2 s idle).
        { cmd: command, login: false, yield_time_ms: 30_000 },
        toolContext(updates),
      ),
    )
    const returned = Date.now()
    expect(outcome.kind).toBe("result")
    if (outcome.kind !== "result") return
    const raw = outcome.result.raw.replace(/\r\n/g, "\n")
    expect(raw).toContain("line 5")

    // Several updates, each the command and the output so far, growing and never ahead of the result.
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates.every((update) => update.metadata.command === command)).toBe(true)
    const seen = outputs(updates).map((text) => text.replace(/\r\n/g, "\n"))
    seen.slice(1).forEach((text, index) => expect(text.startsWith(seen[index]!)).toBe(true))
    expect(seen.at(-1)!.length).toBeGreaterThan(seen[0]!.length)
    seen.forEach((text) => expect(raw.startsWith(text)).toBe(true))
    // At most one update per interval, and none once the call returned.
    updates
      .slice(1)
      .forEach((update, index) =>
        expect(update.at - updates[index]!.at).toBeGreaterThanOrEqual(ExecLive.INTERVAL_MS - 20),
      )
    expect(updates.every((update) => update.at <= returned)).toBe(true)

    // The model's text: the same output and header as the collection without a live view.
    const plain = await manager.execResult("ses_plain", {
      command,
      cwd: os.tmpdir(),
      shell,
      login: false,
      tty: false,
      // The command ends in about 2 s; 10 s ended the collection before its first line on a loaded PC (2026-10-29).
      yieldTimeMs: 30_000,
      policy: POLICY,
    })
    expect(plain.raw).toBe(outcome.result.raw)
    const text = ExecOutput.text(outcome.result)
    expect(text).toBe(
      ExecOutput.text({ ...plain, chunkID: outcome.result.chunkID, wallTimeMs: outcome.result.wallTimeMs }),
    )
    manager.terminate()
  }, 60_000)

  test("write_stdin publishes the output it collects", async () => {
    const manager = new ExecManager.Manager()
    const first = await Effect.runPromise(
      CodexTools.runExec(
        pluginContext() as unknown as Ctx,
        manager,
        // Windows waits at least 10 s for a first collection; the process outlives it either way.
        { cmd: slowLines(60, 300), login: false, yield_time_ms: 250 },
        toolContext([]),
      ),
    )
    if (first.kind !== "result" || first.result.sessionID === undefined) throw new Error("expected a running process")
    const updates: Array<Update> = []
    const polled = await Effect.runPromise(
      CodexTools.runWrite(
        pluginContext() as unknown as Ctx,
        manager,
        { session_id: first.result.sessionID, yield_time_ms: 5_000 },
        toolContext(updates),
      ),
    )
    expect(polled.kind).toBe("result")
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates.every((update) => update.metadata.session === first.result.sessionID)).toBe(true)
    if (polled.kind === "result") expect(polled.result.raw.startsWith(outputs(updates).at(-1)!)).toBe(true)
    manager.terminate()
  }, 60_000)

  test("Code Mode's exec shows its nested command's output while it runs, and nothing after it returned", async () => {
    const registered = new Map<string, Tool.Info>()
    const ctx = pluginContext(registered)
    const manager = new ExecManager.Manager()
    const runtimes = new CodeModeTools.Runtimes()
    await Effect.runPromise(
      Effect.scoped(
        CodeModeTools.register(
          ctx as unknown as Parameters<typeof CodeModeTools.register>[0],
          manager,
          runtimes,
          new Clock.Activity(),
          new GoalRuntime.Runtime(ctx as unknown as ConstructorParameters<typeof GoalRuntime.Runtime>[0]),
        ),
      ),
    )
    const exec = registered.get("exec")!
    const run = (source: string, updates: Array<Update>) =>
      Effect.runPromise(
        exec.execute({ input: source }, toolContext(updates, "ses_code")) as Effect.Effect<Tool.Result, unknown>,
      )

    const updates: Array<Update> = []
    const command = JSON.stringify(slowLines(4, 400))
    const done = await run(
      `const r = await tools.exec_command({ cmd: ${command}, login: false });\ntext(r.output);`,
      updates,
    )
    const content = done.content as ReadonlyArray<{ readonly type: string; readonly text?: string }>
    expect(content[0]!.text).toStartWith("Script completed\n")
    expect(content[1]!.text).toContain("line 4")
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(outputs(updates).at(-1)).toContain("line")

    // A cell that yields keeps its command running; its output no longer reaches the finished call. The nested command
    // ends in about 2 s; its default 10 s collection ended at line 4 on a loaded PC (2026-10-29), hence 30 s.
    const late: Array<Update> = []
    const slow = JSON.stringify(slowLines(6, 300))
    const yielded = await run(
      `// @exec: {"yield_time_ms": 300}\nconst r = await tools.exec_command({ cmd: ${slow}, login: false, yield_time_ms: 30000 });\ntext(r.output);`,
      late,
    )
    const returned = Date.now()
    expect((yielded.content as ReadonlyArray<{ readonly text?: string }>)[0]!.text).toStartWith(
      "Script running with cell ID",
    )
    const cell = /cell ID (\d+)/.exec(
      String((yielded.content as ReadonlyArray<{ readonly text?: string }>)[0]!.text),
    )![1]
    const waited = await Effect.runPromise(
      registered
        .get("wait")!
        .execute({ cell_id: cell, yield_time_ms: 40_000 }, toolContext([], "ses_code")) as Effect.Effect<
        Tool.Result,
        unknown
      >,
    )
    expect(JSON.stringify(waited.content)).toContain("line 6")
    expect(late.every((update) => update.at <= returned)).toBe(true)
    await runtimes.terminate()
    manager.terminate()
  }, 60_000)
})

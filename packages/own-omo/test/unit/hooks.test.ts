// The tool hooks of an omo session (15 §3.4): a failed `edit` whose reason omo's edit-error-recovery knows reaches
// omo's `tool.execute.after` with OpenCode 1's text for it, and what omo appends is appended to the model's error.
// Other failures, and failures outside omo sessions, reach no after hook. The omo hook here stands in for omo's
// (it appends a reminder when it sees OpenCode 1's text), the bridge under test is own-omo's.
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { Bridge } from "../../src/host/hooks.js"
import type { Overlays } from "../../src/host/overlay.js"
import type { OmoSessions } from "../../src/host/session.js"
import type { V1Hooks } from "../../src/omo-runtime.js"
import type { Runtime } from "../../src/runtime.js"

const REMINDER = "\n[EDIT ERROR - IMMEDIATE ACTION REQUIRED]"

function bridge(omo: boolean) {
  const seen: Array<{ input: Record<string, unknown>; output: string }> = []
  const after: NonNullable<V1Hooks["tool.execute.after"]> = async (input, output) => {
    seen.push({ input: { ...input }, output: output.output })
    if (input.tool === "edit" && /oldString not found|must be different|found multiple times/.test(output.output)) output.output += REMINDER
  }
  const hooks = new Map<string, (event: never) => Effect.Effect<unknown, unknown>>()
  const register = (name: string, run: (event: never) => Effect.Effect<unknown, unknown>) =>
    Effect.sync(() => void hooks.set(name, run))
  // SAFETY: the fake implements the hook registrations Bridge.register makes.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const ctx = { session: { hook: register }, tool: { hook: register } } as unknown as Pick<Context, "session" | "tool">
  // SAFETY: the tool hooks read only `current()` of the host and `isOmo` of the session cache.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const host = { current: () => ({ hooks: { "tool.execute.after": after } }) } as unknown as Runtime.Host
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const sessions = { isOmo: async () => omo } as unknown as OmoSessions.Cache
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Effect.runSync(Effect.scoped(Bridge.register(ctx, { host, sessions, overlays: {} as Overlays.Store, warn: () => {} })))
  const run = async (event: Record<string, unknown>) => {
    await Effect.runPromise(hooks.get("execute.after")!(event as never))
    return event
  }
  return { run, seen }
}

const failure = (message: string, tool = "edit") => ({
  tool,
  sessionID: "ses_1",
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  input: { path: "a.ts", oldString: "x", newString: "y" },
  status: "error",
  error: new Tool.Error({ message, metadata: { kept: true } }),
})

describe("Bridge tool hooks (15 §3.4)", () => {
  test("a failed edit omo knows gets omo's reminder after OpenCode 2's own message", async () => {
    const { run, seen } = bridge(true)
    const missing = "Could not find oldString in a.ts. It must match exactly, including whitespace and indentation."
    const event = await run(failure(missing))
    expect(seen).toEqual([
      {
        input: { tool: "edit", sessionID: "ses_1", callID: "call_1", args: { filePath: "a.ts", oldString: "x", newString: "y" } },
        output: "oldString not found in content",
      },
    ])
    const error = event.error as Tool.Error
    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toBe(`${missing}${REMINDER}`)
    expect(error.metadata).toEqual({ kept: true })
    expect(((await run(failure("No changes to apply: oldString and newString are identical."))).error as Tool.Error).message).toEndWith(REMINDER)
    expect(seen.at(-1)!.output).toBe("oldString and newString must be different")
    expect(((await run(failure("Found 2 matches for oldString, but expected exactly one."))).error as Tool.Error).message).toEndWith(REMINDER)
    expect(seen.at(-1)!.output).toStartWith("oldString found multiple times")
  })

  test("other failures, other tools and other sessions reach no after hook", async () => {
    const { run, seen } = bridge(true)
    const other = failure("File not found: a.ts")
    expect((await run(other)).error).toBe(other.error)
    const shell = failure("Could not find oldString in a.ts.", "shell")
    expect((await run(shell)).error).toBe(shell.error)
    expect(seen).toEqual([])
    const elsewhere = bridge(false)
    const plain = failure("Could not find oldString in a.ts.")
    expect((await elsewhere.run(plain)).error).toBe(plain.error)
    expect(elsewhere.seen).toEqual([])
  })
})

// `!` shell mode (03 §4.6, §10, §19.9): the `!` typed into an empty box is consumed (never during a composition),
// Esc/Backspace on an empty box leave, the mode is kept per draft, the command a send runs, the gate for devices, and
// the running-command list fed by the durable shell events.
import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createRoot, createSignal } from "solid-js"
import { createEventBus } from "@/data/events"
import type { ImeKeyEvent } from "@/ime/ime-enter"
import { createShellMode } from "./controller"
import { entersShell, leavesShell, shellAllowed, shellCommand } from "./model"
import { createShellRuns } from "./run"

type KeyInit = Partial<Omit<ImeKeyEvent, "preventDefault">>

function key(code: string, init: KeyInit = {}) {
  const event = {
    code,
    key: code,
    keyCode: 0,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    prevented: false,
    ...init,
    preventDefault() {
      event.prevented = true
    },
  }
  return event
}

describe("shell mode rules", () => {
  test("enter, leave, command", () => {
    expect(entersShell("!", false)).toBe(true)
    expect(entersShell("!", true)).toBe(false)
    expect(entersShell("!ls", false)).toBe(false)
    expect(leavesShell("Escape", "", true)).toBe(true)
    expect(leavesShell("Backspace", "", true)).toBe(true)
    expect(leavesShell("Escape", "ls", true)).toBe(false)
    expect(leavesShell("Escape", "", false)).toBe(false)
    expect(shellCommand("  bun test ", true)).toBe("bun test")
    expect(shellCommand("!git status", false)).toBe("git status")
    expect(shellCommand("hello", false)).toBeUndefined()
    expect(shellCommand("!  ", false)).toBeUndefined()
    expect(shellCommand("   ", true)).toBeUndefined()
  })

  test("devices without the terminal scope never get shell mode (05 §13.5)", () => {
    const runtime = (auth: "injected" | "cookie" | "device", prompt = true) => ({
      rpc: { can: (scope: string) => scope !== "prompt" || prompt },
      entry: () => ({ auth }),
    })
    // SAFETY: the gate reads only `rpc.can` and `entry().auth`.
    const gate = (value: ReturnType<typeof runtime>) =>
      shellAllowed(value as unknown as Parameters<typeof shellAllowed>[0])
    expect(gate(runtime("injected"))).toBe(true)
    expect(gate(runtime("cookie"))).toBe(true)
    expect(gate(runtime("device"))).toBe(false)
    expect(gate(runtime("injected", false))).toBe(false)
    expect(shellAllowed(undefined)).toBe(false)
  })
})

describe("shell mode controller", () => {
  function setup() {
    const textarea = document.createElement("textarea")
    document.body.append(textarea)
    const [draft, setDraft] = createSignal("local/ses_1")
    const [disabled, setDisabled] = createSignal(false)
    let composing = false
    const changed: string[] = []
    const shell = createRoot(() =>
      createShellMode({
        element: () => textarea,
        draftKey: draft,
        composing: () => composing,
        disabled,
        changed: (text) => changed.push(text),
      }),
    )
    return { textarea, shell, changed, setDraft, setDisabled, setComposing: (value: boolean) => (composing = value) }
  }

  test("`!` in an empty box is consumed and turns shell mode on; Esc on the empty box leaves", () => {
    const env = setup()
    env.textarea.value = "!"
    expect(env.shell.input({ isComposing: false })).toBe(true)
    expect(env.textarea.value).toBe("")
    expect(env.shell.active()).toBe(true)
    expect(env.shell.visual()).toBe(true)
    expect(env.changed).toEqual([""])
    env.textarea.value = "ls"
    expect(env.shell.keydown(key("Escape"))).toBe(false)
    env.textarea.value = ""
    const escape = key("Escape")
    expect(env.shell.keydown(escape)).toBe(true)
    expect(escape.prevented).toBe(true)
    expect(env.shell.active()).toBe(false)
  })

  test("never during a composition; per draft; a `!` prefix shows the mode without entering it", () => {
    const env = setup()
    env.setComposing(true)
    env.textarea.value = "!"
    expect(env.shell.input({ isComposing: true })).toBe(false)
    expect(env.textarea.value).toBe("!")
    env.setComposing(false)
    expect(env.shell.keydown(key("Escape", { keyCode: 229 }))).toBe(false)
    env.textarea.value = "!ls"
    env.shell.input({ isComposing: false })
    expect(env.shell.active()).toBe(false)
    expect(env.shell.visual()).toBe(true)
    expect(env.shell.command("!ls")).toBe("ls")
    env.textarea.value = ""
    env.shell.sync()
    expect(env.shell.visual()).toBe(false)
    env.shell.enter()
    expect(env.shell.active()).toBe(true)
    env.setDraft("local/ses_2")
    expect(env.shell.active()).toBe(false)
    env.setDraft("local/ses_1")
    expect(env.shell.active()).toBe(true)
    env.shell.sent()
    expect(env.shell.active()).toBe(false)
  })

  test("disabled (child session, device): no shell mode and no shell commands", () => {
    const env = setup()
    env.setDisabled(true)
    env.textarea.value = "!"
    expect(env.shell.input({ isComposing: false })).toBe(false)
    expect(env.shell.enter()).toBe(false)
    expect(env.shell.command("!ls")).toBeUndefined()
    expect(env.shell.visual()).toBe(false)
  })
})

describe("running commands", () => {
  const shellInfo = (id: string, command: string) => ({
    id,
    status: "running" as const,
    command,
    cwd: "/repo",
    shell: "bash",
    file: "/tmp/out",
    metadata: {},
    time: { started: 1 },
  })

  test("the local placeholder becomes the server's run and goes away when it ends", async () => {
    const bus = createEventBus()
    const release = Promise.withResolvers<void>()
    const calls: unknown[] = []
    const runtime = {
      bus,
      client: () => ({
        session: {
          shell: async (input: unknown) => {
            calls.push(input)
            await release.promise
          },
        },
      }),
    }
    // SAFETY: the tracker reads only `bus` and `client().session.shell`.
    const runs = createShellRuns(runtime as unknown as Parameters<typeof createShellRuns>[0], () => 7)
    const done = runs.run("ses_1", "bun test")
    expect(calls).toEqual([{ sessionID: "ses_1", command: "bun test" }])
    expect(runs.list("ses_1")).toEqual([{ id: "local:1", command: "bun test", startedAt: 7 }])
    const started = {
      type: "session.shell.started",
      data: { sessionID: "ses_1", shell: shellInfo("sh_1", "bun test") },
    }
    // SAFETY: a minimal event of the type the tracker subscribes to.
    bus.publish(started as unknown as OpenCodeEvent)
    // Another window's command in the same session shows too.
    bus.publish({
      type: "session.shell.started",
      data: { sessionID: "ses_1", shell: shellInfo("sh_2", "git status") },
    } as unknown as OpenCodeEvent)
    bus.flush()
    expect(runs.list("ses_1").map((run) => run.id)).toEqual(["sh_1", "sh_2"])
    bus.publish({
      type: "session.shell.ended",
      data: { sessionID: "ses_1", shell: shellInfo("sh_1", "bun test"), output: "" },
    } as unknown as OpenCodeEvent)
    bus.flush()
    release.resolve()
    expect(await done).toEqual({ ok: true })
    expect(runs.list("ses_1").map((run) => run.id)).toEqual(["sh_2"])
    runs.dispose()
  })

  test("a refused command reports the error and leaves no placeholder", async () => {
    const bus = createEventBus()
    const runtime = {
      bus,
      client: () => ({
        session: {
          shell: async () => {
            throw new Error("offline")
          },
        },
      }),
    }
    // SAFETY: as above.
    const runs = createShellRuns(runtime as unknown as Parameters<typeof createShellRuns>[0])
    const result = await runs.run("ses_1", "ls")
    expect(result.ok).toBe(false)
    expect(runs.list("ses_1")).toEqual([])
  })
})

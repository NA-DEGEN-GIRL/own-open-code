// Fakes of the plugin context pieces the computer-use modules use (tool editor, session lookup and history, hooks,
// storage, RPC), over a real Desktop with a FakeDriver. Nothing here touches the real desktop or a server.
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { Permission } from "@opencode/schema/permission"
import { SessionID } from "@opencode/schema/session-id"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Result } from "effect"
import type { Actions } from "../../src/actions.js"
import { Keys } from "../../src/core/keys.js"
import { FakeDriver } from "../../src/driver/fake.js"
import type { Gate } from "../../src/gate.js"
import { Options } from "../../src/options.js"
import { Desktop } from "../../src/singleton.js"
import { Tools } from "../../src/tools.js"

/** Waits until `check` holds (polled every 5 ms, at most 2 s), for work another fiber finishes. */
export async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met within 2 s")
    await Bun.sleep(5)
  }
}

export const ZERO: Actions.Timing = {
  pressMs: 0,
  clickGapMs: 0,
  dragSteps: 3,
  dragStepMs: 0,
  wheelGapMs: 0,
  keyGapMs: 0,
  textChunk: 32,
  sliceMs: 50,
  settleMs: 0,
}

/** A 125% 2560x1440 primary and a 1080p monitor to its left (FakeDriver `dual`) with windows on both. */
export const SCENARIO: FakeDriver.Scenario = {
  displays: FakeDriver.DISPLAYS.dual,
  windows: [
    {
      id: "0x10",
      exe: "C:\\Windows\\System32\\notepad.exe",
      title: "secret plans.txt - Notepad",
      bounds: { x: 100, y: 100, width: 1200, height: 800 },
    },
    {
      id: "0x20",
      exe: "C:\\Windows\\System32\\cmd.exe",
      title: "Command Prompt",
      bounds: { x: -1800, y: 300, width: 900, height: 500 },
    },
    {
      id: "0x30",
      exe: "C:\\Tools\\admin.exe",
      title: "Admin tool",
      bounds: { x: 1400, y: 900, width: 800, height: 400 },
      elevated: true,
    },
    {
      id: "0x40",
      exe: "C:\\Program Files\\Browser\\browser.exe",
      title: "Sign in",
      bounds: { x: 1400, y: 100, width: 1000, height: 700 },
      focus: { isPassword: true, controlType: "Edit" },
    },
  ],
  foreground: "0x10",
  cursor: { x: 700, y: 500 },
}

export const SESSION = SessionID.make("ses_computer_use_test_session_a")
export const OTHER = SessionID.make("ses_computer_use_test_session_b")
export const CHILD = SessionID.make("ses_computer_use_test_child_one")

export const ON: ReadonlyArray<Permission.Rule> = [{ action: "computer", resource: "*", effect: "allow" }]

/** The model every fake session runs on unless it says otherwise (a child created by core inherits its parent's). */
export const MAIN = { providerID: "own-codex-cx01", id: "gpt-6-sol" }

/** The assistant message of the calling step in {@link context} (`Tool.Context.messageID`). */
export const STEP = "msg_test"

/**
 * A fake session: what `ctx.session.get` reports (the model defaults to {@link MAIN}), its messages since the latest
 * compaction for the team-turn check (`ctx.session.context`; none by default, `"unreadable"` fails the read) and its
 * metadata, which the gate never reads.
 */
export interface FakeSession extends Gate.SessionView {
  readonly messages?: ReadonlyArray<Gate.MessageView> | "unreadable"
  /**
   * The messages before `messages` (which then start with a compaction), oldest first, as `ctx.session.messages` pages
   * them for a turn that began before the compaction; `"unreadable"` fails the read.
   */
  readonly earlier?: ReadonlyArray<Gate.MessageView> | "unreadable"
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface Harness {
  readonly driver: FakeDriver.FakeDriver
  readonly desktop: Desktop.Desktop
  readonly home: string
  readonly tools: ReadonlyMap<string, Tool.Info>
  readonly namespaces: ReadonlyArray<Tool.Namespace>
  readonly sessions: Map<string, FakeSession>
  /**
   * Whether a model (`providerID/id`) reads images, as `ctx.model.list` would tell; a model not listed reads them,
   * `"unknown"` is one the list does not know.
   */
  readonly images: Map<string, boolean | "unknown">
  readonly asked: Array<unknown>
  /** Every page read of messages before a compaction (`ctx.session.messages`). */
  readonly pages: Array<{ readonly sessionID: string; readonly before: string; readonly limit: number }>
  /** Runs a tool as `sessionID`'s step `messageID` ({@link STEP} by default). */
  readonly call: (
    name: string,
    input?: unknown,
    sessionID?: SessionID,
    messageID?: string,
  ) => Promise<Exit.Exit<Tool.Result, Tool.Error>>
  readonly ok: (name: string, input?: unknown, sessionID?: SessionID, messageID?: string) => Promise<Tool.Result>
  /** The `[computer.<code>]` message of a failed call. */
  readonly error: (name: string, input?: unknown, sessionID?: SessionID, messageID?: string) => Promise<string>
  readonly close: () => Promise<void>
}

/**
 * One scripted answer. `until` holds the question open until it resolves; `then` runs as the user answers (answering
 * in the app usually brings the app itself to the front).
 */
export type Answer =
  | { readonly answer: string; readonly until?: Promise<void>; readonly then?: () => void }
  | { readonly dismiss: true }

export function context(sessionID: SessionID = SESSION, id = "call_1", messageID = STEP): Tool.Context {
  return {
    sessionID,
    agent: "build" as Tool.Context["agent"],
    messageID: messageID as Tool.Context["messageID"],
    id: id as Tool.Context["id"],
    progress: () => Effect.void,
  }
}

/** The tool editor core hands to a transform, recording what the plugin registers. */
export function editor(question?: Tool.Info) {
  const tools = new Map<string, Tool.Info>()
  const namespaces: Array<Tool.Namespace> = []
  const value: ToolEditor = {
    list: () => [],
    get: (id) => (id === "question" && question !== undefined ? { ...question, id } : undefined),
    namespace: (namespace) => {
      namespaces.push(namespace)
    },
    add: (tool) => {
      tools.set(tool.name, tool as Tool.Info)
    },
    update: () => undefined,
    remove: () => undefined,
  }
  const ctx = {
    tool: {
      transform: (callback: (input: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(value)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Pick<Context, "tool">
  return { ctx, tools, namespaces }
}

/** Core's question tool as the gate sees it: answers from `answers` in order, recording each question. */
export function questionTool(answers: Array<Answer>, asked: Array<unknown>): Tool.Info {
  return {
    name: "question",
    description: "question",
    input: { type: "object" },
    execute: (input) =>
      Effect.suspend(() => {
        asked.push(input)
        const next = answers.shift()
        if (next === undefined || "dismiss" in next) return Effect.die(new Error("The user dismissed this question"))
        return Effect.promise(() => next.until ?? Promise.resolve()).pipe(
          Effect.map(() => {
            next.then?.()
            return { output: { answers: [[next.answer]] } }
          }),
        )
      }),
  }
}

export async function harness(
  input: {
    readonly scenario?: FakeDriver.Scenario
    readonly options?: Record<string, unknown>
    readonly answers?: Array<Answer>
    readonly codemode?: boolean
  } = {},
): Promise<Harness> {
  const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-gate-"))
  const options = Options.decode({ driver: "fake", home, ...input.options })
  const driver = await Effect.runPromise(FakeDriver.make(input.scenario ?? SCENARIO))
  const created = Desktop.create(options, driver)
  const sessions = new Map<string, FakeSession>([[SESSION, { permissions: ON }]])
  const images = new Map<string, boolean | "unknown">()
  const asked: Array<unknown> = []
  const pages: Harness["pages"] = []
  const fake = editor(questionTool(input.answers ?? [], asked))
  // The fake transform registers synchronously and its dispose does nothing, so the scope can close right away.
  await Effect.runPromise(
    Effect.scoped(
      Tools.register(fake.ctx, {
        codemode: input.codemode ?? options.codemode,
        deps: {
          desktop: created.desktop,
          blocked: Result.getOrThrow(Keys.blockList([...Keys.DEFAULT_BLOCKED, ...options.policy.blockedChords])),
          session: (sessionID) => {
            const session = sessions.get(sessionID)
            return Effect.succeed(session === undefined ? undefined : { model: MAIN, ...session })
          },
          history: (sessionID) => {
            const messages = sessions.get(sessionID)?.messages ?? []
            return Effect.succeed(messages === "unreadable" ? undefined : messages)
          },
          earlier: (page) => {
            pages.push(page)
            const session = sessions.get(page.sessionID)
            if (session?.earlier === "unreadable" || session?.messages === "unreadable")
              return Effect.succeed(undefined)
            const timeline = [...(session?.earlier ?? []), ...(session?.messages ?? [])]
            const at = timeline.findIndex((message) => message.id === page.before)
            return Effect.succeed(at === -1 ? [] : timeline.slice(0, at).reverse().slice(0, page.limit))
          },
          images: (model) => {
            const value = images.get(`${model.providerID}/${model.id}`)
            return Effect.succeed(value === "unknown" ? undefined : (value ?? true))
          },
          timing: ZERO,
        },
      }),
    ),
  )
  const calls = { count: 0 }
  const call = (name: string, value: unknown = {}, sessionID: SessionID = SESSION, messageID = STEP) => {
    const tool = fake.tools.get(name)
    if (tool === undefined) throw new Error(`no tool ${name}`)
    calls.count += 1
    return Effect.runPromiseExit(tool.execute(value, context(sessionID, `call_${calls.count}`, messageID)))
  }
  return {
    driver,
    desktop: created.desktop,
    home,
    tools: fake.tools,
    namespaces: fake.namespaces,
    sessions,
    images,
    asked,
    pages,
    call,
    ok: async (name, value, sessionID, messageID) => {
      const exit = await call(name, value, sessionID, messageID)
      if (Exit.isSuccess(exit)) return exit.value
      throw new Error(`computer.${name} failed: ${String(exit.cause)}`)
    },
    error: async (name, value, sessionID, messageID) => {
      const exit = await call(name, value, sessionID, messageID)
      if (Exit.isSuccess(exit)) throw new Error(`computer.${name} succeeded`)
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      if (failure?._tag !== "Fail")
        throw new Error(`computer.${name} did not fail with a Tool.Error: ${String(exit.cause)}`)
      return failure.error.message
    },
    close: async () => {
      await Effect.runPromise(created.close)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

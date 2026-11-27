// Agent activity in the browser pane (03 §18.17), rule 3 of the browser tool policy (05 §8.7) and the 7.2 close
// guard, without Electron: event reduction, phases, takeover, touched tabs, labels, the enable planner.
import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "@opencode/client"
import { BROWSER_DENY } from "@/policy/browser"
import {
  activityPhase,
  browserCalls,
  createBrowserActivity,
  describeCall,
  RECENT_MS,
  reduceActivity,
  type ActivityBus,
  type ToolEvent,
} from "./activity"
import { closeGuardNeeded, type SessionAttachment } from "./attachments"
import { planBrowserEnable } from "./enable"
import { browserPhase, setWindowActivity } from "./registry"

const TAB = "tab_00000000-0000-0000-0000-000000000001"
const OTHER = "tab_00000000-0000-0000-0000-000000000002"

function tool(
  type: ToolEvent["type"],
  calls: { tool: string; status: string; input?: Record<string, unknown> }[] | undefined,
  input: { sessionID?: string; id?: string } = {},
): ToolEvent {
  const data = {
    sessionID: input.sessionID ?? "ses_1",
    assistantMessageID: "msg_1",
    id: input.id ?? "prt_1",
    ...(calls ? { metadata: { toolCalls: calls } } : {}),
  }
  return { id: "evt", created: 0, type, data } as unknown as ToolEvent
}

describe("browser calls in execute metadata", () => {
  test("keeps browser.* rows only, strips the namespace, reads the tab", () => {
    expect(
      browserCalls({
        toolCalls: [
          { tool: "fetch", status: "completed", input: { url: "https://example.com" } },
          { tool: "browser.tabs.open", status: "completed", input: { url: "http://127.0.0.1:3000/" } },
          { tool: "browser.click", status: "running", input: { tabID: TAB, ref: "e12" } },
          { tool: "browser.snapshot", status: "weird" },
          "junk",
        ],
      }),
    ).toEqual([
      { operation: "tabs.open", status: "completed", input: { url: "http://127.0.0.1:3000/" } },
      { operation: "click", status: "running", tabID: TAB, input: { tabID: TAB, ref: "e12" } },
    ])
    expect(browserCalls(undefined)).toEqual([])
    expect(browserCalls({ toolCalls: "x" })).toEqual([])
  })

  test("labels: action word and a short detail", () => {
    expect(describeCall({ operation: "click", status: "running", input: { tabID: TAB, ref: "e12" } })).toEqual({
      action: "click",
      detail: "e12",
    })
    expect(
      describeCall({ operation: "navigate", status: "running", input: { url: "http://localhost:5173/settings?x=1" } }),
    ).toEqual({ action: "navigate", detail: "localhost:5173/settings?x=1" })
    expect(describeCall({ operation: "wait", status: "running", input: { text: "저장됨" } })).toEqual({
      action: "wait",
      detail: '"저장됨"',
    })
    expect(describeCall({ operation: "press", status: "running", input: { key: "Enter" } }).detail).toBe("Enter")
    expect(describeCall({ operation: "snapshot", status: "completed" })).toEqual({ action: "read" })
    expect(describeCall({ operation: "files.get", status: "completed" }).action).toBe("files")
    expect(describeCall({ operation: "trace.start", status: "completed" }).action).toBe("measure")
    expect(describeCall({ operation: "something.new", status: "completed" })).toEqual({
      action: "other",
      detail: "something.new",
    })
  })
})

describe("activity reduction", () => {
  test("running call → operating; finished part → recent while the turn runs, then idle", () => {
    const running = reduceActivity(
      undefined,
      tool("session.tool.progress", [{ tool: "browser.click", status: "running", input: { tabID: TAB, ref: "e3" } }]),
      1_000,
    )!
    expect(running).toMatchObject({ running: 1, open: true, calls: 1, at: 1_000, last: { operation: "click" } })
    expect(activityPhase(running, { now: 1_000, turnRunning: true })).toBe("operating")
    const done = reduceActivity(
      running,
      tool("session.tool.success", [{ tool: "browser.click", status: "completed", input: { tabID: TAB, ref: "e3" } }]),
      2_000,
    )!
    expect(done).toMatchObject({ running: 0, open: false, at: 1_000 })
    expect(activityPhase(done, { now: 2_000, turnRunning: true })).toBe("recent")
    expect(activityPhase(done, { now: 1_000 + RECENT_MS, turnRunning: true })).toBe("idle")
    expect(activityPhase(done, { now: 2_000, turnRunning: false })).toBe("idle")
  })

  test("other tools never create activity; a failed part without metadata closes ours", () => {
    expect(reduceActivity(undefined, tool("session.tool.progress", [{ tool: "read", status: "running" }]), 0)).toBe(
      undefined,
    )
    const open = reduceActivity(
      undefined,
      tool("session.tool.progress", [{ tool: "browser.wait", status: "running", input: { tabID: TAB } }]),
      0,
    )!
    expect(reduceActivity(open, tool("session.tool.failed", undefined, { id: "prt_other" }), 5)).toBe(undefined)
    expect(reduceActivity(open, tool("session.tool.failed", undefined), 5)).toMatchObject({ open: false, running: 0 })
    // A failed part reports its running row as an error.
    const failed = reduceActivity(
      open,
      tool("session.tool.failed", [{ tool: "browser.wait", status: "running", input: { tabID: TAB } }]),
      5,
    )!
    expect(failed.last.status).toBe("error")
  })
})

function fakeBus() {
  const handlers = new Map<string, Set<(event: ToolEvent) => void>>()
  const bus: ActivityBus = {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set()
      handlers.set(type, set)
      const erased = handler as (event: ToolEvent) => void
      set.add(erased)
      return () => set.delete(erased)
    },
  }
  return { bus, emit: (event: ToolEvent) => handlers.get(event.type)?.forEach((handler) => handler(event)) }
}

describe("tracker", () => {
  test("takeover stands until the agent's next browser call; user commands mark tabs while active", () => {
    const { bus, emit } = fakeBus()
    let now = 10_000
    let running = true
    const timers: (() => void)[] = []
    const tracker = createBrowserActivity({
      bus,
      turnRunning: () => running,
      now: () => now,
      timer: (run) => {
        timers.push(run)
        return () => undefined
      },
    })
    expect(tracker.phase("ses_1")).toBe("idle")
    tracker.userCommand("ses_1", TAB)
    expect(tracker.touched("ses_1", TAB)).toBe(false)

    emit(tool("session.tool.progress", [{ tool: "browser.tabs.open", status: "running", input: { url: "http://a/" } }]))
    expect(tracker.phase("ses_1")).toBe("operating")
    expect(tracker.last("ses_1")).toEqual({ action: "open", detail: "a", tabID: undefined })
    expect(timers).toHaveLength(1)

    emit(
      tool("session.tool.progress", [
        { tool: "browser.tabs.open", status: "completed", input: { url: "http://a/" } },
        { tool: "browser.click", status: "running", input: { tabID: TAB, ref: "e4" } },
      ]),
    )
    expect(tracker.agentTab("ses_1")).toBe(TAB)
    tracker.userCommand("ses_1", OTHER)
    expect(tracker.touched("ses_1", OTHER)).toBe(true)

    now += 100
    tracker.takeover("ses_1", TAB)
    expect(tracker.phase("ses_1")).toBe("takeover")
    expect(tracker.touched("ses_1", TAB)).toBe(true)
    // The interrupted part reports its end: same calls, the takeover stays.
    emit(
      tool("session.tool.failed", [
        { tool: "browser.tabs.open", status: "completed", input: { url: "http://a/" } },
        { tool: "browser.click", status: "error", input: { tabID: TAB, ref: "e4" } },
      ]),
    )
    expect(tracker.phase("ses_1")).toBe("takeover")
    // A new turn's browser call on that tab clears the takeover and the tab's user mark.
    now += 1_000
    emit(
      tool("session.tool.progress", [{ tool: "browser.snapshot", status: "running", input: { tabID: TAB } }], {
        id: "prt_2",
      }),
    )
    expect(tracker.phase("ses_1")).toBe("operating")
    expect(tracker.touched("ses_1", TAB)).toBe(false)
    expect(tracker.touched("ses_1", OTHER)).toBe(true)

    emit(
      tool("session.tool.success", [{ tool: "browser.snapshot", status: "completed", input: { tabID: TAB } }], {
        id: "prt_2",
      }),
    )
    expect(tracker.phase("ses_1")).toBe("recent")
    running = false
    now += 1_000
    timers[0]!()
    expect(tracker.phase("ses_1")).toBe("idle")
    tracker.takeover("ses_1")
    tracker.release("ses_1")
    expect(tracker.phase("ses_1")).toBe("idle")
    tracker.dispose()
  })

  test("window registry: badge phase per server, idle without a tracker", () => {
    const { bus, emit } = fakeBus()
    const tracker = createBrowserActivity({ bus, turnRunning: () => true, timer: () => () => undefined })
    expect(browserPhase("local", "ses_1")).toBe("idle")
    setWindowActivity("local", tracker)
    emit(
      tool("session.tool.progress", [{ tool: "browser.click", status: "running", input: { tabID: TAB, ref: "e1" } }]),
    )
    expect(browserPhase("local", "ses_1")).toBe("operating")
    expect(browserPhase("local", undefined)).toBe("idle")
    expect(browserPhase("ssh-1", "ses_1")).toBe("idle")
    setWindowActivity("local", undefined)
    expect(browserPhase("local", "ses_1")).toBe("idle")
    tracker.dispose()
  })
})

describe("rule 3: explicit per-session enable (05 §8.7)", () => {
  const ask: PermissionRule = { action: "edit", resource: "**", effect: "ask" }
  const always: PermissionRule = { action: "shell", resource: "bun test", effect: "allow" }
  test("removes only the creation deny and keeps every other rule in order", () => {
    expect(planBrowserEnable([ask, BROWSER_DENY, always])).toEqual({ ok: true, rules: [ask, always], removed: 1 })
    expect(planBrowserEnable([BROWSER_DENY, BROWSER_DENY])).toEqual({ ok: true, rules: [], removed: 2 })
  })
  test("nothing to do for a session that has the tools; refuses to override someone else's deny", () => {
    expect(planBrowserEnable(undefined)).toEqual({ ok: false, reason: "not-removed" })
    expect(planBrowserEnable([ask])).toEqual({ ok: false, reason: "not-removed" })
    expect(planBrowserEnable([{ action: "brow*", resource: "*", effect: "deny" }, BROWSER_DENY])).toEqual({
      ok: false,
      reason: "other-rule",
    })
  })
})

describe("7.2 close guard", () => {
  const attachment = (sessionID: string, attached: boolean, tabs: number) =>
    ({
      serverKey: "local",
      sessionID,
      state: () => ({
        attached,
        registered: attached,
        suspended: false,
        browser: attached
          ? {
              tabs: Array.from({ length: tabs }, (_, index) => ({
                id: `tab_${index}`,
                url: "http://a/",
                title: "",
                loading: false,
                canGoBack: false,
                canGoForward: false,
                generation: 1,
              })),
              focusedTabID: null,
            }
          : null,
      }),
    }) as unknown as SessionAttachment
  test("only a running session with an attached browser that has tabs", () => {
    const running = (_server: string, id: string) => id === "ses_run"
    expect(closeGuardNeeded({ list: () => [attachment("ses_run", true, 1)] }, running)).toBe(true)
    expect(closeGuardNeeded({ list: () => [attachment("ses_run", true, 0)] }, running)).toBe(false)
    expect(closeGuardNeeded({ list: () => [attachment("ses_run", false, 1)] }, running)).toBe(false)
    expect(closeGuardNeeded({ list: () => [attachment("ses_idle", true, 2)] }, running)).toBe(false)
  })
})

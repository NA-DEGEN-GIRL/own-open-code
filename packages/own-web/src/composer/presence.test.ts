// 02 §4.7.7 (CC-14, CC-16): the shown conversation is reported to own-accounts while the page is visible and touched, so
// idle compaction leaves a conversation the user is reading alone. happy-dom page (the test preload).
import { afterEach, describe, expect, jest, test } from "bun:test"
import path from "node:path"
import type { OwnRpc } from "@/data/rpc"
import { trackPresence } from "./presence"

function fakeRpc(allowed = true) {
  const calls: Array<readonly [string, unknown]> = []
  // SAFETY: the reporter uses `allowed` and `call` only.
  const rpc = {
    allowed: () => allowed,
    call: async (method: string, input: unknown) => {
      calls.push([method, input])
      return {}
    },
  } as unknown as OwnRpc
  return { rpc, calls }
}

function visibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

const stops: Array<() => void> = []

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  visibility("visible")
})

describe("session.presence", () => {
  test("reports the shown conversation at once and when the page shows again, not while it is hidden", () => {
    const { rpc, calls } = fakeRpc()
    stops.push(trackPresence({ rpc: () => rpc, sessionID: () => "ses_read" }))
    expect(calls).toEqual([["session.presence", { sessionID: "ses_read" }]])
    visibility("hidden")
    expect(calls).toHaveLength(1)
    visibility("visible")
    expect(calls).toEqual([
      ["session.presence", { sessionID: "ses_read" }],
      ["session.presence", { sessionID: "ses_read" }],
    ])
  })

  test("no window of its own: only while touched within the last minute, so the service's hiddenMinutes decides", () => {
    jest.useFakeTimers()
    const { rpc, calls } = fakeRpc()
    const stop = trackPresence({ rpc: () => rpc, sessionID: () => "ses_read" })
    // At once, and a minute later (touched when it started).
    jest.advanceTimersByTime(60_000)
    expect(calls).toHaveLength(2)
    // Untouched for two minutes: no report, so the service's wait runs from the last one.
    jest.advanceTimersByTime(60_000)
    expect(calls).toHaveLength(2)
    window.dispatchEvent(new Event("keydown"))
    jest.advanceTimersByTime(60_000)
    expect(calls).toHaveLength(3)
    stop()
    jest.useRealTimers()
  })

  test("nothing without a conversation, without the scope, or once stopped", () => {
    const none = fakeRpc()
    stops.push(trackPresence({ rpc: () => none.rpc, sessionID: () => undefined }))
    const denied = fakeRpc(false)
    stops.push(trackPresence({ rpc: () => denied.rpc, sessionID: () => "ses_read" }))
    const stopped = fakeRpc()
    trackPresence({ rpc: () => stopped.rpc, sessionID: () => "ses_read" })()
    visibility("hidden")
    visibility("visible")
    expect([none.calls, denied.calls, stopped.calls.length]).toEqual([[], [], 1])
  })

  test("the composer loads it lazily, outside the first chunk (PF5)", async () => {
    const composer = await Bun.file(path.join(import.meta.dir, "index.tsx")).text()
    expect(composer).toContain('await import("./presence")')
    expect(composer).not.toContain('from "./presence"')
  })
})

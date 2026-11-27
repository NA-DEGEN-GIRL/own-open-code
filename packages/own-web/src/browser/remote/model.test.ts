// The device viewer's rules (05 §8.10): which sentence stands in the frame's place, when a socket is opened at all,
// who may send input, the view area the gateway accepts, the keyboard's stable box and the reconnect delays.
import { describe, expect, test } from "bun:test"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { backoff, connects, focusedTab, gateOf, goAction, screenOf, stableBox, viewportOf, type Screen } from "./model"

const tab = (id: string, over: Partial<RemoteBrowser.Tab> = {}): RemoteBrowser.Tab => ({
  id,
  url: `https://example.com/${id}`,
  title: id,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over,
})
const view = (host: RemoteBrowser.HostState, tabs: RemoteBrowser.Tab[] = []): RemoteBrowser.ViewState => ({
  ...RemoteBrowser.EMPTY_PANE,
  host,
  tabs,
  focusedTabID: tabs[0]?.id ?? null,
})
const base = {
  sessionID: "ses_1",
  scopes: ["read", "prompt", "browser"],
  removed: false,
  link: "open",
  state: view("ready", [tab("a")]),
} as const

describe("what the view shows", () => {
  test("the frame once the pane is ready and has a tab", () => {
    expect(screenOf(base)).toBe("frame")
    expect(screenOf({ ...base, state: view("ready") })).toBe("empty")
  })

  test("the host's word while there is no pane to show", () => {
    expect(screenOf({ ...base, state: view("absent") })).toBe("absent")
    expect(screenOf({ ...base, state: view("attaching") })).toBe("attaching")
    expect(screenOf({ ...base, state: view("detached") })).toBe("detached")
    expect(screenOf({ ...base, link: "connecting", state: undefined })).toBe("connecting")
  })

  test("what needs no socket is decided first, in order", () => {
    const blocked = { ...base, scopes: ["read", "prompt"], removed: true }
    expect(screenOf({ ...blocked, sessionID: undefined })).toBe("none")
    expect(screenOf(blocked)).toBe("permission")
    expect(screenOf({ ...base, removed: true })).toBe("removed")
    const silent: Screen[] = ["none", "permission", "removed"]
    expect(silent.map(connects)).toEqual([false, false, false])
    const asking: Screen[] = ["connecting", "absent", "attaching", "detached", "empty", "frame", "busy"]
    expect(asking.map(connects)).toEqual(asking.map(() => true))
  })

  test("too many viewers says so even over the last state; a lost socket keeps the last frame", () => {
    expect(screenOf({ ...base, link: "busy" })).toBe("busy")
    expect(screenOf({ ...base, link: "retrying" })).toBe("frame")
  })
})

describe("who drives", () => {
  test("a device without prompt watches, whatever the agent does", () => {
    expect(gateOf({ control: false, phase: "idle" })).toBe("watch")
    expect(gateOf({ control: false, phase: "operating" })).toBe("watch")
  })

  test("nothing is sent while the agent operates; between its calls and after a takeover input flows", () => {
    expect(gateOf({ control: true, phase: "operating" })).toBe("agent")
    expect(gateOf({ control: true, phase: "recent" })).toBe("control")
    expect(gateOf({ control: true, phase: "takeover" })).toBe("control")
    expect(gateOf({ control: true, phase: "idle" })).toBe("control")
  })
})

describe("the address row", () => {
  test("navigates the focused tab, or opens a tab when there is none", () => {
    const state = { ...view("ready", [tab("a"), tab("b")]), focusedTabID: "b" }
    expect(focusedTab(state)?.id).toBe("b")
    expect(focusedTab({ ...state, focusedTabID: "gone" })?.id).toBe("a")
    expect(focusedTab(undefined)).toBeUndefined()
    expect(goAction(state, "https://example.com/")).toEqual({ type: "navigate", url: "https://example.com/" })
    expect(goAction(view("ready"), "https://example.com/")).toEqual({ type: "tabs.open", url: "https://example.com/" })
    expect(RemoteBrowser.parseAction(goAction(view("ready"), "http://localhost:3000"))).toBeDefined()
  })
})

describe("the view area", () => {
  test("the frame area of a Galaxy S23 Ultra passes the gateway's check as it is", () => {
    const viewport = viewportOf({ width: 384, height: 654, dpr: 2.8125 })
    expect(viewport).toEqual({ width: 384, height: 654, dpr: 2.8125 })
    expect(RemoteBrowser.parseViewport(viewport)).toEqual(viewport!)
  })

  test("stays inside the limits and waits for a laid-out area", () => {
    expect(viewportOf({ width: 0, height: 600, dpr: 2 })).toBeUndefined()
    expect(viewportOf({ width: 120.4, height: 9000, dpr: 9 })).toEqual({
      width: RemoteBrowser.MIN_SIDE,
      height: RemoteBrowser.MAX_SIDE,
      dpr: RemoteBrowser.MAX_DPR,
    })
    expect(viewportOf({ width: 400, height: 300, dpr: Number.NaN })?.dpr).toBe(1)
  })

  test("a soft keyboard does not shrink the box; a fold, a rotation or the end of typing follows the area", () => {
    const full = { width: 384, height: 654 }
    const keyboard = { width: 384, height: 332 }
    expect(stableBox(undefined, full, false)).toBe(full)
    expect(stableBox(full, keyboard, true)).toBe(full)
    expect(stableBox(full, keyboard, false)).toBe(keyboard)
    expect(stableBox(keyboard, full, true)).toBe(full)
    const unfolded = { width: 466, height: 300 }
    expect(stableBox(full, unfolded, true)).toBe(unfolded)
  })
})

test("reconnect delays: 1 s, 2 s, 4 s, 8 s, then 15 s", () => {
  expect([0, 1, 2, 3, 4, 5, 40].map(backoff)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 15_000])
})

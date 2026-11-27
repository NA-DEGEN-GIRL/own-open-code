// The browser pane on a paired device, the shell's side (05 §8.10): the pacing policy and the mappings without any
// I/O (src/main/remote-browser-model.ts), and the bridge (src/main/remote-browser.ts) against the real hub: own-remote's
// gateway in process behind a fake local service (its test harness), a paired device's viewer socket, and fake panes
// whose pages record the CDP commands they get. A small proxy in front of the service plays the hub going silent.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { RemoteBrowser } from "../../own-protocol/src/remote-browser"
import { BrowserGateway } from "../../own-remote/test/harness/browser-gateway"
import { Browser } from "../../plugin-browser/src/rpc"
import type { WebContents } from "electron"
import { startRemoteBrowser, type RemoteBrowserBridge } from "../src/main/remote-browser"
import { stillCaret } from "../src/main/remote-caret"
import {
  actionError,
  base64Bytes,
  clipboardChord,
  coalesce,
  dialogOf,
  frameSize,
  inputCommands,
  jpegSize,
  keyCommands,
  pace,
  METRICS_COMMAND,
  pageMetrics,
  paneAction,
  paneState,
  parsePull,
  PHONE_CLEAR,
  phoneCommands,
  phoneUserAgent,
  screencastCommand,
  screenshotCommand,
  type PaceInput,
} from "../src/main/remote-browser-model"
import {
  addRemotePane,
  remotePaneDownload,
  remotePanes,
  type RemotePage,
  type RemotePane,
  type RemotePaneEvent,
  type RemotePaneRegistry,
} from "../src/main/remote-panes"

const TAB_1 = Browser.TabID.make("tab_00000000-0000-0000-0000-000000000001")
const TAB_2 = Browser.TabID.make("tab_00000000-0000-0000-0000-000000000002")
const tab = (id: Browser.TabID, over: Partial<Browser.Tab> = {}): Browser.Tab => ({
  id,
  url: "http://localhost:5173/",
  title: "앱",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
  ...over,
})

/** A JPEG as far as its header goes: the size the bridge reads, and `fill` to tell pictures apart. */
function jpeg(width: number, height: number, fill = 1, length = 96) {
  const bytes = Buffer.alloc(length, fill)
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08], 0)
  bytes.writeUInt16BE(height, 13)
  bytes.writeUInt16BE(width, 15)
  return bytes.toString("base64")
}

describe("the panes the shell offers (src/main/remote-panes.ts)", () => {
  const pane = (sessionID: string, contents: object = {}, serverKey = "local"): RemotePane => ({
    serverKey,
    sessionID,
    state: () => ({ tabs: [], focusedTabID: null }),
    page: () => undefined,
    run: async () => undefined,
    dialog: async () => undefined,
    owns: (value) => value === contents,
  })

  test("a confirmed attachment is listed until it closes; the newest one of a session wins", () => {
    const events: RemotePaneEvent[] = []
    const off = remotePanes.on((event) => events.push(event))
    const first = pane("ses_a")
    const listed = addRemotePane(first)
    expect(remotePanes.sessions()).toEqual(["ses_a"])
    expect(remotePanes.get("ses_a")).toBe(first)
    listed.changed()
    // The service replaced the attachment (the window registered the session again): the old one closing changes nothing.
    const second = pane("ses_a")
    const again = addRemotePane(second)
    listed.changed()
    listed.remove()
    expect(remotePanes.get("ses_a")).toBe(second)
    again.remove()
    expect(remotePanes.sessions()).toEqual([])
    expect(events).toEqual([
      { type: "sessions" },
      { type: "changed", key: "ses_a" },
      { type: "sessions" },
      { type: "sessions" },
    ])
    off()
    addRemotePane(pane("ses_b")).remove()
    expect(events).toHaveLength(4)
  })

  test("an SSH host's pane is listed by host and session, apart from a local pane of the same id (05 §8.10.8)", () => {
    const events: RemotePaneEvent[] = []
    const off = remotePanes.on((event) => events.push(event))
    const local = addRemotePane(pane("ses_x"))
    const remote = pane("ses_x", {}, "h-abc123")
    const listed = addRemotePane(remote)
    expect(remotePanes.sessions().sort()).toEqual(["h-abc123/ses_x", "ses_x"])
    expect(remotePanes.get(RemoteBrowser.paneKey("h-abc123", "ses_x"))).toBe(remote)
    listed.changed()
    listed.remove()
    expect(remotePanes.sessions()).toEqual(["ses_x"])
    local.remove()
    off()
    expect(events.filter((event) => event.type === "changed")).toEqual([{ type: "changed", key: "h-abc123/ses_x" }])
  })

  test("a download is told for the session whose tab started it, and for no other page", () => {
    const events: RemotePaneEvent[] = []
    const off = remotePanes.on((event) => events.push(event))
    const tabPage = {}
    const listed = addRemotePane(pane("ses_d", tabPage))
    remotePaneDownload(tabPage)
    remotePaneDownload({})
    listed.remove()
    off()
    expect(events.filter((event) => event.type === "download")).toEqual([{ type: "download", key: "ses_d" }])
  })

  test("the shell starts the bridge with its own wiring, and never in a 원격 PC 전용 build", async () => {
    const source = await Bun.file(new URL("../src/main/own-browser.ts", import.meta.url)).text()
    const body = source.slice(source.indexOf("export function wireRemoteBrowser()"))
    expect(body.indexOf("if (clientOnly) return")).toBeGreaterThan(0)
    expect(body.indexOf("if (clientOnly) return")).toBeLessThan(body.indexOf("startRemoteBrowser("))
    expect(body).toContain("discoverService(paths.registration)")
    const desktop = await Bun.file(new URL("../src/main/desktop.ts", import.meta.url)).text()
    expect(desktop).toContain(
      "Effect.acquireRelease(Effect.sync(wireRemoteBrowser), (dispose) => Effect.sync(dispose))",
    )
    // The bridge and its model stay free of Electron, so they run here; the registry too.
    for (const file of ["remote-browser.ts", "remote-browser-model.ts", "remote-panes.ts"])
      expect(await Bun.file(new URL(`../src/main/${file}`, import.meta.url)).text()).not.toMatch(/from "electron"/)
  })
})

describe("pacing", () => {
  const base: PaceInput = {
    now: 10_000,
    sending: false,
    sentAt: Number.NEGATIVE_INFINITY,
    pending: false,
    changedAt: 0,
    rested: true,
    quality: "auto",
  }

  test("one frame at a time: nothing starts while a frame is on its way", () => {
    expect(pace({ ...base, sending: true, pending: true })).toEqual({ do: "idle" })
    expect(pace({ ...base, sending: true, rested: false })).toEqual({ do: "idle" })
  })

  test("a changed frame goes at once, but never sooner than MIN_FRAME_GAP_MS after the last one started", () => {
    expect(pace({ ...base, pending: true })).toEqual({ do: "quick" })
    expect(pace({ ...base, pending: true, sentAt: 10_000 - 30 })).toEqual({
      do: "wait",
      ms: RemoteBrowser.MIN_FRAME_GAP_MS - 30,
    })
    expect(pace({ ...base, pending: true, sentAt: 10_000 - RemoteBrowser.MIN_FRAME_GAP_MS })).toEqual({ do: "quick" })
  })

  test("a page that stayed the same for REST_MS gets one sharp frame, then nothing", () => {
    expect(pace({ ...base, rested: false, changedAt: 10_000 - 100 })).toEqual({
      do: "wait",
      ms: RemoteBrowser.REST_MS - 100,
    })
    expect(pace({ ...base, rested: false, changedAt: 10_000 - RemoteBrowser.REST_MS })).toEqual({ do: "sharp" })
    expect(pace({ ...base, rested: true, changedAt: 0 })).toEqual({ do: "idle" })
  })

  test("data saver: quick frames only, the rest is noted without a sharp frame", () => {
    expect(pace({ ...base, quality: "low", pending: true })).toEqual({ do: "quick" })
    expect(pace({ ...base, quality: "low", rested: false, changedAt: 0 })).toEqual({ do: "rest" })
  })

  test("a waiting frame comes before the rest frame", () => {
    expect(pace({ ...base, pending: true, rested: false, changedAt: 0 })).toEqual({ do: "quick" })
  })
})

describe("frames", () => {
  const metrics = { width: 1000, height: 700, dpr: 1.5, x: 0, y: 120 }
  const phone = { width: 390, height: 800, dpr: 3 }

  test("the page's viewport, pixel ratio and scroll place out of the page's own answer", () => {
    expect(METRICS_COMMAND.params).toEqual({
      expression: "[innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY]",
      returnByValue: true,
    })
    expect(pageMetrics({ result: { type: "object", value: [1000, 700, 1.5, 0, 120] } })).toEqual(metrics)
    expect(pageMetrics({ result: { value: [0, 700, 1.5, 0, 0] } })).toBeUndefined()
    expect(pageMetrics({ result: { value: [1000, 700, "2", 0, 0] } })).toBeUndefined()
    expect(pageMetrics({ result: { value: "1000" } })).toBeUndefined()
    expect(pageMetrics({ exceptionDetails: {} })).toBeUndefined()
    expect(pageMetrics(undefined)).toBeUndefined()
    // An overscrolled page reports a negative offset; a clip cannot start there.
    expect(pageMetrics({ result: { value: [390, 800, 3, -4, -20] } })).toEqual({
      width: 390,
      height: 800,
      dpr: 3,
      x: 0,
      y: 0,
    })
  })

  test("a quick frame's longest side is the tier's, a sharp one is the viewer's own pixels at most", () => {
    expect(frameSize(metrics, phone, RemoteBrowser.FRAME.quick)).toMatchObject({ width: 720, height: 504 })
    // 1500 px native, the phone shows 2400: never upscaled.
    expect(frameSize(metrics, phone, RemoteBrowser.FRAME.sharp)).toMatchObject({ scale: 1, width: 1500, height: 1050 })
    expect(frameSize(metrics, { width: 360, height: 640, dpr: 1 }, RemoteBrowser.FRAME.sharp)).toMatchObject({
      width: 640,
      height: 448,
    })
    expect(frameSize(metrics, phone, RemoteBrowser.FRAME.low)).toMatchObject({ width: 540, height: 378 })
  })

  test("the screencast and the screenshot carry the tier's size and quality", () => {
    expect(screencastCommand(metrics, { viewport: phone, quality: "auto" })).toEqual({
      method: "Page.startScreencast",
      params: { format: "jpeg", quality: 55, maxWidth: 720, maxHeight: 504, everyNthFrame: 1 },
    })
    expect(screencastCommand(metrics, { viewport: phone, quality: "low" }).params).toMatchObject({
      quality: 45,
      maxWidth: 540,
    })
    const shot = screenshotCommand(metrics, phone, RemoteBrowser.FRAME.sharp)
    expect(shot.params).toMatchObject({
      format: "jpeg",
      quality: 80,
      clip: { x: 0, y: 120, width: 1000, height: 700, scale: 1 },
      captureBeyondViewport: false,
    })
    const smaller = screenshotCommand(metrics, phone, RemoteBrowser.FRAME.sharp, 0.5)
    expect(smaller.params).toMatchObject({ quality: 64, clip: { scale: 0.5 } })
  })

  test("a JPEG's size is read from its header", () => {
    expect(jpegSize(jpeg(720, 504))).toEqual({ width: 720, height: 504 })
    expect(jpegSize(Buffer.from("not a jpeg at all").toString("base64"))).toBeUndefined()
    expect(base64Bytes(Buffer.alloc(100).toString("base64"))).toBe(100)
    expect(base64Bytes(Buffer.alloc(101).toString("base64"))).toBe(101)
    expect(base64Bytes(Buffer.alloc(102).toString("base64"))).toBe(102)
  })
})

describe("input", () => {
  const size = { width: 1000, height: 700 }

  test("touches go as the points still down, in CSS px of the page", () => {
    expect(inputCommands({ k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.25 }] }, size)).toEqual([
      { method: "Input.dispatchTouchEvent", params: { type: "touchStart", touchPoints: [{ id: 0, x: 500, y: 175 }] } },
    ])
    expect(inputCommands({ k: "touch", phase: "end", points: [] }, size)).toEqual([
      { method: "Input.dispatchTouchEvent", params: { type: "touchEnd", touchPoints: [] } },
    ])
    // Chromium refuses a cancel that names points.
    expect(inputCommands({ k: "touch", phase: "cancel", points: [{ id: 0, x: 0, y: 0 }] }, size)).toEqual([
      { method: "Input.dispatchTouchEvent", params: { type: "touchCancel", touchPoints: [] } },
    ])
  })

  test("mouse and wheel", () => {
    expect(inputCommands({ k: "mouse", phase: "down", x: 0.1, y: 0.2, button: "left", clicks: 2 }, size)).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 100, y: 140, button: "left", buttons: 1, clickCount: 2 },
      },
    ])
    expect(inputCommands({ k: "mouse", phase: "move", x: 0.1, y: 0.2, button: "left" }, size)[0]!.params).toMatchObject(
      {
        type: "mouseMoved",
        buttons: 1,
        clickCount: 0,
      },
    )
    expect(inputCommands({ k: "mouse", phase: "up", x: 0.1, y: 0.2, button: "right" }, size)[0]!.params).toMatchObject({
      type: "mouseReleased",
      button: "right",
      buttons: 0,
      clickCount: 1,
    })
    expect(inputCommands({ k: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 240 }, size)).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 500, y: 350, deltaX: 0, deltaY: 240 } },
    ])
  })

  test("named keys carry their code, virtual key and text", () => {
    const [down, up] = keyCommands({ k: "key", key: "Enter" })
    expect(down).toEqual({
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        modifiers: 0,
        text: "\r",
        unmodifiedText: "\r",
      },
    })
    expect(up!.params).toEqual({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 })
    expect(keyCommands({ k: "key", key: "Backspace" })[0]!.params).toEqual({
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      modifiers: 0,
    })
    expect(keyCommands({ k: "key", key: " " })[0]!.params).toMatchObject({
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      text: " ",
    })
    for (const key of RemoteBrowser.KEYS)
      expect(
        (keyCommands({ k: "key", key })[0]!.params as { windowsVirtualKeyCode: number }).windowsVirtualKeyCode,
      ).toBeGreaterThan(0)
  })

  test("a chord is a raw key with its modifiers; a lone character types itself", () => {
    for (const [key, vk] of [
      ["a", 65],
      ["y", 89],
      ["z", 90],
    ] as const)
      expect(keyCommands({ k: "key", key, ctrl: true })[0]!.params).toEqual({
        type: "rawKeyDown",
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: vk,
        modifiers: 2,
      })
    expect(keyCommands({ k: "key", key: "z", ctrl: true, shift: true })[0]!.params).toMatchObject({
      key: "Z",
      modifiers: 10,
    })
    expect(keyCommands({ k: "key", key: "a", alt: true, meta: true })[0]!.params).toMatchObject({ modifiers: 5 })
    expect(keyCommands({ k: "key", key: "a" })[0]!.params).toMatchObject({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
    })
    expect(keyCommands({ k: "key", key: "a", shift: true })[0]!.params).toMatchObject({
      key: "A",
      text: "A",
      modifiers: 8,
    })
    expect(keyCommands({ k: "key", key: "7" })[0]!.params).toMatchObject({
      code: "Digit7",
      windowsVirtualKeyCode: 55,
      text: "7",
    })
    expect(keyCommands({ k: "key", key: "한" })[0]!.params).toMatchObject({
      type: "keyDown",
      text: "한",
      windowsVirtualKeyCode: 0,
    })
  })

  test("no chord reaches the PC's clipboard: copy, cut and paste are not typed at all", () => {
    for (const key of ["c", "x", "v", "C", "X", "V"]) {
      expect(clipboardChord({ k: "key", key, ctrl: true })).toBe(true)
      expect(keyCommands({ k: "key", key, ctrl: true })).toEqual([])
      expect(keyCommands({ k: "key", key, meta: true })).toEqual([])
      expect(keyCommands({ k: "key", key, ctrl: true, shift: true })).toEqual([])
      expect(inputCommands({ k: "key", key, ctrl: true, alt: true }, size)).toEqual([])
    }
    // The old Windows chords: Shift+Delete cuts, Ctrl+Insert copies, Shift+Insert pastes.
    expect(keyCommands({ k: "key", key: "Delete", shift: true })).toEqual([])
    expect(keyCommands({ k: "key", key: "Insert", ctrl: true })).toEqual([])
    expect(keyCommands({ k: "key", key: "Insert", shift: true })).toEqual([])
    // A key name this build has no code for types nothing either (it would be inserted as the word).
    expect(keyCommands({ k: "key", key: "Insert" })).toEqual([])
    // What touches no clipboard stays: the letters themselves, select all, undo, redo, a plain Delete.
    for (const key of ["c", "x", "v"]) {
      expect(clipboardChord({ k: "key", key })).toBe(false)
      expect(keyCommands({ k: "key", key })[0]!.params).toMatchObject({ type: "keyDown", text: key })
      expect(keyCommands({ k: "key", key, alt: true })).toHaveLength(2)
    }
    for (const key of ["a", "z", "y"]) expect(keyCommands({ k: "key", key, ctrl: true })).toHaveLength(2)
    expect(keyCommands({ k: "key", key: "z", ctrl: true, shift: true })).toHaveLength(2)
    expect(keyCommands({ k: "key", key: "Delete" })).toHaveLength(2)
    expect(keyCommands({ k: "key", key: "Delete", ctrl: true })).toHaveLength(2)
  })

  test("text is inserted, a composition is set with the caret at its end, an empty one cancels", () => {
    expect(inputCommands({ k: "text", text: "한글" }, size)).toEqual([
      { method: "Input.insertText", params: { text: "한글" } },
    ])
    expect(inputCommands({ k: "compose", text: "한" }, size)).toEqual([
      { method: "Input.imeSetComposition", params: { text: "한", selectionStart: 1, selectionEnd: 1 } },
    ])
    expect(inputCommands({ k: "compose", text: "" }, size)[0]!.params).toEqual({
      text: "",
      selectionStart: 0,
      selectionEnd: 0,
    })
  })

  test("a burst of moves is one move; presses and other kinds keep their place", () => {
    const move = (y: number): RemoteBrowser.InputEvent => ({
      k: "touch",
      phase: "move",
      points: [{ id: 0, x: 0.5, y }],
    })
    const start: RemoteBrowser.InputEvent = { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.1 }] }
    const end: RemoteBrowser.InputEvent = { k: "touch", phase: "end", points: [] }
    expect(coalesce([start, move(0.2), move(0.3), move(0.4), end])).toEqual([start, move(0.4), end])
    const key: RemoteBrowser.InputEvent = { k: "key", key: "a" }
    expect(coalesce([move(0.2), key, move(0.3)])).toEqual([move(0.2), key, move(0.3)])
    const drag = (x: number, button: "left" | "none"): RemoteBrowser.InputEvent => ({
      k: "mouse",
      phase: "move",
      x,
      y: 0,
      button,
    })
    expect(coalesce([drag(0.1, "none"), drag(0.2, "none"), drag(0.3, "left"), drag(0.4, "left")])).toEqual([
      drag(0.2, "none"),
      drag(0.4, "left"),
    ])
  })
})

describe("the caret of a streamed page (src/main/remote-caret.ts)", () => {
  /** The part of a tab's WebContents the caret touches: its user style sheets and its navigations. */
  const fakeContents = () => {
    const contents = {
      destroyed: false,
      sheets: new Map<string, string>(),
      inserted: 0,
      listeners: new Set<() => void>(),
      isDestroyed: () => contents.destroyed,
      async insertCSS(css: string, options: { cssOrigin?: string }) {
        const key = `k${++contents.inserted}`
        contents.sheets.set(key, `${options.cssOrigin}:${css}`)
        return key
      },
      async removeInsertedCSS(key: string) {
        contents.sheets.delete(key)
      },
      on(event: string, listener: () => void) {
        if (event === "did-navigate") contents.listeners.add(listener)
      },
      off(event: string, listener: () => void) {
        if (event === "did-navigate") contents.listeners.delete(listener)
      },
      /** A new document: the old one's sheets went with it. */
      navigate() {
        contents.sheets.clear()
        contents.listeners.forEach((listener) => listener())
      },
    }
    return contents
  }
  const settled = () => Bun.sleep(5)

  test("a user style sheet holds the caret still, in every new document, and is taken out at the end", async () => {
    const contents = fakeContents()
    const blink = stillCaret(contents as unknown as WebContents)
    await settled()
    expect([...contents.sheets.values()]).toEqual(["user:*{caret-animation:manual!important}"])
    contents.navigate()
    await settled()
    expect(contents.sheets.size).toBe(1)
    expect(contents.inserted).toBe(2)
    blink()
    await settled()
    expect(contents.sheets.size).toBe(0)
    expect(contents.listeners.size).toBe(0)
    // After the end a navigation puts nothing in again.
    contents.navigate()
    await settled()
    expect(contents.inserted).toBe(2)
  })

  test("ended before the sheet was in: it still comes out; a closed tab is left alone", async () => {
    const contents = fakeContents()
    stillCaret(contents as unknown as WebContents)()
    await settled()
    expect(contents.sheets.size).toBe(0)
    const closed = fakeContents()
    closed.destroyed = true
    const blink = stillCaret(closed as unknown as WebContents)
    await settled()
    expect(closed.inserted).toBe(0)
    blink()
    await settled()
    expect(closed.listeners.size).toBe(0)
  })
})

describe("actions", () => {
  const state: Browser.State = { tabs: [tab(TAB_1), tab(TAB_2)], focusedTabID: TAB_2 }
  const empty: Browser.State = { tabs: [], focusedTabID: null }

  test("navigation runs on the focused tab; navigate opens a tab when there is none", () => {
    expect(paneAction({ type: "navigate", url: "http://localhost:5173/a" }, state)).toEqual({
      ok: true,
      navigates: true,
      action: { type: "navigate", tabID: TAB_2, url: "http://localhost:5173/a" },
    })
    expect(paneAction({ type: "navigate", url: "http://localhost:5173/a" }, empty)).toEqual({
      ok: true,
      navigates: true,
      action: { type: "tabs.open", url: "http://localhost:5173/a" },
    })
    for (const type of ["back", "forward", "reload", "stop"] as const) {
      expect(paneAction({ type }, state)).toMatchObject({ ok: true, action: { type, tabID: TAB_2 } })
      expect(paneAction({ type }, empty)).toEqual({ ok: false, error: "failed" })
    }
  })

  test("tabs: open, focus and close name the pane's own tab ids; an unknown tab fails", () => {
    expect(paneAction({ type: "tabs.open" }, state)).toEqual({
      ok: true,
      navigates: false,
      action: { type: "tabs.open" },
    })
    expect(paneAction({ type: "tabs.open", url: "https://example.com/" }, state)).toMatchObject({
      navigates: true,
      action: { type: "tabs.open", url: "https://example.com/" },
    })
    expect(paneAction({ type: "tabs.focus", tabID: TAB_1 }, state)).toMatchObject({
      action: { type: "tabs.focus", tabID: TAB_1 },
    })
    expect(paneAction({ type: "tabs.close", tabID: TAB_1 }, state)).toMatchObject({
      action: { type: "tabs.close", tabID: TAB_1 },
    })
    expect(paneAction({ type: "tabs.focus", tabID: "tab_gone" }, state)).toEqual({ ok: false, error: "failed" })
  })

  test("a dialog answer is the agent's own browser.dialog; text only with accept", () => {
    expect(paneAction({ type: "dialog", accept: true, text: "네" }, state)).toMatchObject({
      action: { type: "dialog", tabID: TAB_2, action: "accept", promptText: "네" },
    })
    expect(paneAction({ type: "dialog", accept: false, text: "네" }, state)).toEqual({
      ok: true,
      navigates: false,
      action: { type: "dialog", tabID: TAB_2, action: "dismiss" },
    })
    expect(paneAction({ type: "dialog", accept: true }, empty)).toEqual({ ok: false, error: "failed" })
  })

  test("a refused address answers its code, anything else `failed`", () => {
    expect(actionError(new Error("browser.address.workspace"))).toBe("browser.address.workspace")
    expect(actionError(new Error("browser.address.credentials"))).toBe("browser.address.credentials")
    expect(actionError(new Error("net::ERR_CONNECTION_REFUSED at http://localhost:1/"))).toBe("failed")
    expect(actionError("boom")).toBe("failed")
  })

  test("the hub's pull answer is checked once; entries this build does not know are left out", () => {
    const parsed = parsePull({
      idle: false,
      views: [
        { sessionID: "ses_1", mode: "phone", quality: "low", viewport: { width: 390, height: 800, dpr: 3 } },
        { sessionID: "ses_2", mode: "tv", quality: "auto", viewport: { width: 390, height: 800, dpr: 3 } },
        { sessionID: "ses_3", mode: "pc", quality: "auto", viewport: { width: 10, height: 800, dpr: 3 } },
      ],
      commands: [
        { type: "input", sessionID: "ses_1", events: [{ k: "text", text: "a" }, { k: "pinch" }] },
        { type: "action", sessionID: "ses_1", id: "a1", action: { type: "reload" } },
        {
          type: "action",
          sessionID: "ses_1",
          id: "a2",
          action: { type: "navigate", url: "file:///C:/Windows/win.ini" },
        },
        { type: "later", sessionID: "ses_1" },
      ],
    })
    expect(parsed).toEqual({
      idle: false,
      views: [{ sessionID: "ses_1", mode: "phone", quality: "low", viewport: { width: 390, height: 800, dpr: 3 } }],
      commands: [
        { type: "input", sessionID: "ses_1", events: [{ k: "text", text: "a" }] },
        { type: "action", sessionID: "ses_1", id: "a1", action: { type: "reload" } },
      ],
    })
    expect(parsePull({ views: [] })).toBeUndefined()
    expect(parsePull(undefined)).toBeUndefined()
  })
})

describe("휴대폰 크기로 보기 and the state", () => {
  test("the viewer's viewport, at most 3 device px per CSS px, touch and Android Chrome's user agent", () => {
    const commands = phoneCommands({ width: 390, height: 800, dpr: 3.5 }, "146.0.7680.65")
    expect(commands.map((command) => command.method)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ])
    expect(commands[0]!.params).toMatchObject({ width: 390, height: 800, deviceScaleFactor: 3, mobile: true })
    expect(commands[1]!.params).toEqual({ enabled: true, maxTouchPoints: 5 })
    expect(commands[2]!.params).toMatchObject({
      userAgent:
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
      userAgentMetadata: { mobile: true, platform: "Android" },
    })
    expect(phoneUserAgent("146.0.7680.65")).not.toContain("Electron")
    expect(phoneCommands({ width: 800, height: 390, dpr: 2 }, "146.0.0.0")[0]!.params).toMatchObject({
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    })
  })

  test("clearing undoes each of the three", () => {
    expect(PHONE_CLEAR).toEqual([
      { method: "Emulation.clearDeviceMetricsOverride", params: {} },
      { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
      { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
    ])
  })

  test("the pane as a device sees it, within the RPC's limits", () => {
    const state: Browser.State = {
      tabs: [
        tab(TAB_1, { title: "가".repeat(2000), loadError: "ERR_CONNECTION_REFUSED" }),
        tab(TAB_2, { loading: true }),
      ],
      focusedTabID: TAB_1,
    }
    const pane = paneState({
      state,
      mode: "phone",
      metrics: { width: 390.4, height: 800, dpr: 3, x: 0, y: 0 },
      dialog: null,
    })
    expect(pane.tabs.map((item) => item.id)).toEqual([TAB_1, TAB_2])
    expect(pane.tabs[0]!.title).toHaveLength(1024)
    expect(pane.tabs[0]).not.toHaveProperty("generation")
    expect(pane.tabs[0]!.loadError).toBe("ERR_CONNECTION_REFUSED")
    expect(pane.tabs[1]).not.toHaveProperty("loadError")
    expect(pane.focusedTabID).toBe(TAB_1)
    expect(pane.page).toEqual({ mode: "phone", width: 390, height: 800 })
    expect(
      paneState({ state: { tabs: [], focusedTabID: null }, mode: "pc", metrics: undefined, dialog: null }),
    ).toEqual(RemoteBrowser.EMPTY_PANE)
  })

  test("the open dialog out of the pane's own `dialog get` answer", () => {
    expect(
      dialogOf({ value: { tab: {}, dialog: { type: "confirm", message: "지울까요?", defaultValue: "" } }, files: [] }),
    ).toEqual({
      type: "confirm",
      message: "지울까요?",
      defaultPrompt: "",
    })
    expect(
      dialogOf({ value: { tab: {}, dialog: { type: "prompt", message: "이름", defaultValue: "홍길동" } } }),
    ).toMatchObject({
      type: "prompt",
      defaultPrompt: "홍길동",
    })
    expect(dialogOf({ value: { tab: {}, dialog: null } })).toBeNull()
    expect(dialogOf(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The bridge against the real hub

interface Sent {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

/** A tab's page: records what it is sent, answers metrics and screenshots, and lets the test play Chromium's events. */
function fakePage(tabID: Browser.TabID) {
  const sent: Sent[] = []
  const listeners = new Set<(method: string, params: unknown) => void>()
  const page = {
    tabID,
    sent,
    gone: false,
    kicks: 0,
    /** What a screenshot shows; changing it is the page changing. */
    picture: 1,
    /** The last screencast frame, as Chromium would send it again. */
    cast: undefined as { data: string; sessionId: number; metadata: object } | undefined,
    emulated: undefined as { width: number; height: number; deviceScaleFactor: number } | undefined,
    ready: Promise.resolve(),
    async send(method: string, params: object = {}) {
      sent.push({ method, params: params as Record<string, unknown> })
      if (method === "Emulation.setDeviceMetricsOverride") page.emulated = params as typeof page.emulated
      if (method === "Emulation.clearDeviceMetricsOverride") page.emulated = undefined
      if (method === "Runtime.evaluate") {
        const size = page.emulated ?? { width: 1000, height: 700, deviceScaleFactor: 1.5 }
        return { result: { type: "object", value: [size.width, size.height, size.deviceScaleFactor, 0, 0] } }
      }
      if (method === "Page.captureScreenshot") {
        // Chromium draws the page again for a screenshot, and a running screencast sends that picture once more.
        if (page.cast) queueMicrotask(() => page.emit("Page.screencastFrame", page.cast))
        const clip = (params as { clip: { width: number; height: number; scale: number } }).clip
        const dpr = page.emulated?.deviceScaleFactor ?? 1.5
        return {
          data: jpeg(
            Math.round(clip.width * dpr * clip.scale),
            Math.round(clip.height * dpr * clip.scale),
            page.picture,
          ),
        }
      }
      return {}
    },
    on(listener: (method: string, params: unknown) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    closed: () => page.gone,
    async kick() {
      page.kicks++
    },
    rests: 0,
    rest() {
      page.rests++
      page.still = false
    },
    /** The caret is held still while the page is streamed. */
    still: false,
    steady() {
      page.still = true
    },
    emit(method: string, params: unknown) {
      listeners.forEach((listener) => listener(method, params))
    },
    /** One screencast frame as Chromium sends it. */
    frame(fill: number, width = 720, height = 504) {
      page.cast = {
        data: jpeg(width, height, fill),
        sessionId: fill,
        metadata: { deviceWidth: 1000, deviceHeight: 700 },
      }
      page.emit("Page.screencastFrame", page.cast)
    },
    listening: () => listeners.size,
    methods: () => sent.map((item) => item.method),
    last: (method: string) => sent.findLast((item) => item.method === method)?.params,
    count: (method: string) => sent.filter((item) => item.method === method).length,
  }
  return page satisfies RemotePage
}

type FakePage = ReturnType<typeof fakePage>

function fakePanes() {
  const panes = new Map<string, RemotePane>()
  const listeners = new Set<(event: RemotePaneEvent) => void>()
  const emit = (event: RemotePaneEvent) => listeners.forEach((listener) => listener(event))
  const registry: RemotePaneRegistry = {
    sessions: () => [...panes.keys()],
    get: (key) => panes.get(key),
    on(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  return {
    registry,
    emit,
    /**
     * A pane with two tabs, the first focused; `ran` records the actions it was asked to run. `serverKey`: an SSH
     * host's pane.
     */
    add(sessionID: string, serverKey = "local") {
      const key = RemoteBrowser.paneKey(serverKey, sessionID)
      const pages = new Map<Browser.TabID, FakePage>([
        [TAB_1, fakePage(TAB_1)],
        [TAB_2, fakePage(TAB_2)],
      ])
      const pane = {
        serverKey,
        sessionID,
        pages,
        tabs: [tab(TAB_1), tab(TAB_2, { url: "http://localhost:5173/two", title: "둘" })],
        focusedTabID: TAB_1 as Browser.TabID | null,
        ran: [] as Browser.Action[],
        opened: null as { type: string; message: string; defaultValue: string } | null,
        refuse: undefined as string | undefined,
        state: (): Browser.State => ({ tabs: pane.tabs, focusedTabID: pane.focusedTabID }),
        page: () => (pane.focusedTabID ? pages.get(pane.focusedTabID) : undefined),
        asked: 0,
        async dialog() {
          pane.asked++
          return { value: { tab: {}, dialog: pane.opened }, files: [] }
        },
        // Like the real pane, every action publishes when it is done.
        async run(action: Browser.Action) {
          pane.ran.push(action)
          if (pane.refuse) throw new Error(pane.refuse)
          if (action.type === "tabs.focus") pane.focus(action.tabID)
          if (action.type === "dialog") pane.opened = null
          emit({ type: "changed", key })
          return { value: {}, files: [] }
        },
        owns: (contents: object) => [...pages.values()].some((page) => page === contents),
        focus(tabID: Browser.TabID) {
          pane.focusedTabID = tabID
          emit({ type: "changed", key })
        },
        changed: () => emit({ type: "changed", key }),
        remove() {
          panes.delete(key)
          emit({ type: "sessions" })
        },
      }
      panes.set(key, pane)
      emit({ type: "sessions" })
      return pane
    },
  }
}

async function eventually<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await Bun.sleep(15)
  }
}

describe("the bridge and the hub", () => {
  const slot: { fx?: BrowserGateway.Fixture; proxy?: ReturnType<typeof Bun.serve>; phone?: BrowserGateway.Device } = {}
  const fx = () => slot.fx!
  const link = { down: false }
  const open: { bridge?: RemoteBrowserBridge; views: BrowserGateway.ViewerClient[] } = { views: [] }
  /** Short times: the same rules, without the waits. */
  const timing = {
    pollMs: 400,
    viewPollMs: 200,
    idleGapMs: 150,
    failSafeMs: 700,
    backoffMs: [60, 120],
    tickMs: 50,
    actionMs: 400,
  }

  beforeAll(async () => {
    slot.fx = await BrowserGateway.start({ sessions: { ses_1: {}, ses_2: {}, ses_3: {} }, hostSessions: { ses_1: {} } })
    // The bridge's way to the service; `down` is the hub not answering.
    slot.proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      async fetch(request) {
        if (link.down) return new Response("down", { status: 503 })
        const url = new URL(request.url)
        return fetch(`${fx().service.url}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        })
      },
    })
    slot.phone = await fx().pair({ scopes: ["read", "prompt", "browser"] })
  })

  afterEach(async () => {
    await open.bridge?.stop()
    open.bridge = undefined
    for (const view of open.views.splice(0)) view.close()
    link.down = false
    await eventually(
      () => fx().gateway.browser.viewers(),
      (count) => count === 0,
    )
  })

  afterAll(async () => {
    slot.proxy?.stop(true)
    await slot.fx?.stop()
  })

  const start = (panes: ReturnType<typeof fakePanes>, over: { windows?: () => number } = {}) => {
    open.bridge = startRemoteBrowser({
      service: async () => ({
        url: `http://127.0.0.1:${slot.proxy!.port}`,
        authorization: `Basic ${btoa(`opencode:${fx().service.password}`)}`,
        control: "C:\\own-home\\control",
      }),
      panes: panes.registry,
      windows: over.windows ?? (() => 1),
      chrome: "146.0.7680.65",
      timing,
    })
    return open.bridge
  }

  const watch = async (
    sessionID: string,
    hello: Parameters<BrowserGateway.ViewerClient["hello"]>[0] = {},
    device = slot.phone!,
    serverKey = "local",
  ) => {
    const view = fx().viewer(device, sessionID, { serverKey })
    open.views.push(view)
    view.hello(hello)
    await view.ready()
    return view
  }

  const states = (view: BrowserGateway.ViewerClient) =>
    view.messages.flatMap((message) => (message.t === "state" ? [message.state] : []))

  test("it tells the hub what it hosts, at once when that changes, and that the app has a window", async () => {
    const panes = fakePanes()
    const count = { windows: 1 }
    start(panes, { windows: () => count.windows })
    await eventually(
      () => fx().gateway.browser.desktop(),
      (value) => value,
    )
    expect(fx().gateway.browser.desktop()).toBe(true)
    expect(fx().gateway.browser.hosted("ses_1")).toBe(false)
    const before = Date.now()
    panes.add("ses_1")
    await eventually(
      () => fx().gateway.browser.hosted("ses_1"),
      (value) => value,
    )
    // Not after the long poll (400 ms here): the waiting pull is overtaken.
    expect(fx().gateway.browser.hosted("ses_1")).toBe(true)
    expect(Date.now() - before).toBeLessThan(300)
    count.windows = 0
    await eventually(
      () => fx().gateway.browser.desktop(),
      (value) => !value,
    )
    expect(fx().gateway.browser.desktop()).toBe(false)
  })

  test("a wanted session: the pane's state, the screencast, a quick frame, then one sharp frame at rest", async () => {
    const panes = fakePanes()
    const pane = panes.add("ses_1")
    const page = pane.pages.get(TAB_1)!
    start(panes)
    const view = await watch("ses_1")
    const state = await view.state("ready")
    await view.until(() => states(view).find((item) => item.page !== null))
    expect(states(view).at(-1)).toMatchObject({
      host: "ready",
      focusedTabID: TAB_1,
      page: { mode: "pc", width: 1000, height: 700 },
      dialog: null,
    })
    expect(state.host).toBe("ready")
    expect(
      states(view)
        .at(-1)!
        .tabs.map((item) => item.title),
    ).toEqual(["앱", "둘"])
    await eventually(
      () => page.last("Page.startScreencast"),
      (value) => value !== undefined,
    )
    // 1000×700 at 1.5 on a 390×800@3 phone: the quick tier's 720 px.
    expect(page.last("Page.startScreencast")).toEqual({
      format: "jpeg",
      quality: 55,
      maxWidth: 720,
      maxHeight: 504,
      everyNthFrame: 1,
    })
    page.frame(7)
    const first = await view.frame(1)
    expect(first.header).toMatchObject({ width: 720, height: 504, sharp: false })
    expect(page.last("Page.screencastFrameAck")).toEqual({ sessionId: 7 })
    view.send({ t: "ack", seq: first.header.seq })
    // The page rests: one screenshot at the sharp tier (the page's own 1500 px, the phone could show 2400).
    const sharp = await view.frame(2)
    expect(sharp.header).toMatchObject({ width: 1500, height: 1050, sharp: true })
    expect(page.last("Page.captureScreenshot")).toMatchObject({
      quality: 80,
      clip: { width: 1000, height: 700, scale: 1 },
    })
    view.send({ t: "ack", seq: sharp.header.seq })
    await Bun.sleep(RemoteBrowser.REST_MS + 250)
    expect(view.frames).toHaveLength(2)
    expect(page.count("Page.captureScreenshot")).toBe(1)
  })

  test("an SSH host's pane streams under its host; a local pane of the same id is another one (05 §8.10.8)", async () => {
    fx().host.ready = true
    try {
      const panes = fakePanes()
      const remote = panes.add("ses_1", BrowserGateway.HOST_ID)
      const local = panes.add("ses_1")
      start(panes)
      await eventually(
        () => fx().gateway.browser.hosted(RemoteBrowser.paneKey(BrowserGateway.HOST_ID, "ses_1")),
        (value) => value,
      )
      const view = await watch("ses_1", {}, slot.phone!, BrowserGateway.HOST_ID)
      await view.state("ready")
      const page = remote.pages.get(TAB_1)!
      await eventually(
        () => page.last("Page.startScreencast"),
        (value) => value !== undefined,
      )
      // Only the host's pane is captured.
      expect(local.pages.get(TAB_1)!.last("Page.startScreencast")).toBeUndefined()
      page.frame(5)
      expect((await view.frame(1)).header).toMatchObject({ width: 720, height: 504 })
      // The device's input and actions reach the host's pane.
      view.send({ t: "action", id: 9, action: { type: "reload" } })
      expect(await view.result(9)).toMatchObject({ ok: true })
      expect(remote.ran).toEqual([{ type: "reload", tabID: TAB_1 }])
      expect(local.ran).toEqual([])
    } finally {
      fx().host.ready = false
    }
  })

  test("frames never overlap: the next one waits for the ack and is the newest picture; the same picture is skipped", async () => {
    const panes = fakePanes()
    const page = panes.add("ses_1").pages.get(TAB_1)!
    start(panes)
    const view = await watch("ses_1", { quality: "low" })
    await eventually(
      () => page.last("Page.startScreencast"),
      (value) => value !== undefined,
    )
    expect(page.last("Page.startScreencast")).toMatchObject({ quality: 45, maxWidth: 540 })
    page.frame(1)
    const first = await view.frame(1)
    page.frame(2)
    page.frame(3)
    page.frame(4)
    await Bun.sleep(300)
    // Not acknowledged yet: the hub still holds the push of the first one.
    expect(view.frames).toHaveLength(1)
    const sentAt = Date.now()
    view.send({ t: "ack", seq: first.header.seq })
    const second = await view.frame(2)
    expect(Buffer.from(second.jpeg)[40]).toBe(4)
    view.send({ t: "ack", seq: second.header.seq })
    expect(Date.now() - sentAt).toBeLessThan(1000)
    page.frame(4)
    // Data saver: no sharp frame when the page rests, and an unchanged picture is not sent again.
    await Bun.sleep(RemoteBrowser.REST_MS + 300)
    expect(view.frames).toHaveLength(2)
    expect(page.count("Page.captureScreenshot")).toBe(0)
  })

  test("a viewer that never acknowledges gets the next frame after ACK_TIMEOUT_MS", async () => {
    const panes = fakePanes()
    const page = panes.add("ses_1").pages.get(TAB_1)!
    start(panes)
    const view = await watch("ses_1", { quality: "low" })
    await eventually(
      () => page.last("Page.startScreencast"),
      (value) => value !== undefined,
    )
    page.frame(1)
    await view.frame(1)
    const at = Date.now()
    page.frame(2)
    await view.until(() => (view.frames.length >= 2 ? true : undefined), RemoteBrowser.ACK_TIMEOUT_MS + 1500)
    expect(Date.now() - at).toBeGreaterThanOrEqual(RemoteBrowser.ACK_TIMEOUT_MS - 300)
  }, 10_000)

  test("input reaches the focused page in order, in its CSS px; the first one guards the file chooser", async () => {
    const panes = fakePanes()
    const pane = panes.add("ses_1")
    const page = pane.pages.get(TAB_1)!
    start(panes)
    const view = await watch("ses_1")
    await view.until(() => states(view).find((item) => item.page !== null))
    view.send({
      t: "input",
      events: [
        { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.5 }] },
        { k: "touch", phase: "move", points: [{ id: 0, x: 0.5, y: 0.4 }] },
        { k: "touch", phase: "move", points: [{ id: 0, x: 0.5, y: 0.3 }] },
        { k: "touch", phase: "end", points: [] },
        { k: "compose", text: "하" },
        { k: "text", text: "한" },
        // Dropped: the clipboard these would use is the PC's.
        { k: "key", key: "v", ctrl: true },
        { k: "key", key: "c", ctrl: true },
        { k: "key", key: "Delete", shift: true },
        { k: "key", key: "Enter" },
      ],
    })
    await eventually(
      () => page.count("Input.dispatchKeyEvent"),
      (count) => count === 2,
    )
    const input = page.sent.filter((item) => item.method.startsWith("Input."))
    expect(input.map((item) => [item.method, item.params.type ?? item.params.text])).toEqual([
      ["Input.dispatchTouchEvent", "touchStart"],
      ["Input.dispatchTouchEvent", "touchMove"],
      ["Input.dispatchTouchEvent", "touchEnd"],
      ["Input.imeSetComposition", "하"],
      ["Input.insertText", "한"],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
    ])
    expect(input[0]!.params.touchPoints).toEqual([{ id: 0, x: 500, y: 350 }])
    expect(input[1]!.params.touchPoints).toEqual([{ id: 0, x: 500, y: 210 }])
    const methods = page.methods()
    expect(methods.indexOf("Page.setInterceptFileChooserDialog")).toBeLessThan(
      methods.indexOf("Input.dispatchTouchEvent"),
    )
    expect(page.last("Page.setInterceptFileChooserDialog")).toEqual({ enabled: true, cancel: true })
    // Nothing asks the page or the window for focus.
    expect(page.methods().filter((method) => /focus/i.test(method))).toEqual([])
    // The page opened a file chooser while the device held it: cancelled by the interception, and the device is told.
    page.emit("Page.fileChooserOpened", { mode: "selectSingle" })
    await view.until(() => view.messages.find((message) => message.t === "notice" && message.kind === "file_chooser"))
    // A download of one of the pane's tabs.
    panes.emit({ type: "download", key: "ses_1" })
    await view.until(() => view.messages.find((message) => message.t === "notice" && message.kind === "download"))
    // The view ends: the PC's own clicks get the native dialog again.
    view.send({ t: "view", visible: false })
    await eventually(
      () => page.last("Page.setInterceptFileChooserDialog"),
      (value) => value?.enabled === false,
    )
    expect(page.last("Page.setInterceptFileChooserDialog")).toEqual({ enabled: false })
    expect(page.methods()).toContain("Page.stopScreencast")
    expect(page.listening()).toBe(0)
  })

  test("actions run through the pane and answer: ok, the refusal code, a failure", async () => {
    const panes = fakePanes()
    const pane = panes.add("ses_1")
    start(panes)
    const view = await watch("ses_1")
    await view.state("ready")
    view.send({ t: "action", id: 1, action: { type: "navigate", url: "http://localhost:5173/next" } })
    expect(await view.result(1)).toEqual({ t: "result", id: 1, ok: true })
    expect(pane.ran.at(-1)).toEqual({ type: "navigate", tabID: TAB_1, url: "http://localhost:5173/next" })
    view.send({ t: "action", id: 2, action: { type: "tabs.focus", tabID: TAB_2 } })
    expect(await view.result(2)).toMatchObject({ ok: true })
    await view.until(() => states(view).find((item) => item.focusedTabID === TAB_2))
    view.send({ t: "action", id: 3, action: { type: "reload" } })
    expect(await view.result(3)).toMatchObject({ ok: true })
    expect(pane.ran.at(-1)).toEqual({ type: "reload", tabID: TAB_2 })
    pane.refuse = "browser.address.credentials"
    view.send({ t: "action", id: 4, action: { type: "navigate", url: "http://user:secret@localhost:5173/" } })
    expect(await view.result(4)).toEqual({ t: "result", id: 4, ok: false, error: "browser.address.credentials" })
    pane.refuse = "Browser tab is unavailable."
    view.send({ t: "action", id: 5, action: { type: "back" } })
    expect(await view.result(5)).toEqual({ t: "result", id: 5, ok: false, error: "failed" })
    view.send({ t: "action", id: 6, action: { type: "tabs.close", tabID: "tab_unknown" } })
    expect(await view.result(6)).toEqual({ t: "result", id: 6, ok: false, error: "failed" })
  })

  test("a navigation that is still loading is answered as started; other actions that hang time out", async () => {
    const panes = fakePanes()
    const pane = panes.add("ses_1")
    pane.run = async (action) => {
      pane.ran.push(action)
      return new Promise<never>(() => undefined)
    }
    start(panes)
    const view = await watch("ses_1")
    await view.state("ready")
    view.send({ t: "action", id: 1, action: { type: "navigate", url: "http://localhost:5173/slow" } })
    view.send({ t: "action", id: 2, action: { type: "tabs.close", tabID: TAB_2 } })
    expect(await view.result(1)).toEqual({ t: "result", id: 1, ok: true })
    expect(await view.result(2)).toEqual({ t: "result", id: 2, ok: false, error: "timeout" })
  })

  test("an open JavaScript dialog shows in the state, input waits for it, and the device's answer closes it", async () => {
    const panes = fakePanes()
    const pane = panes.add("ses_1")
    const page = pane.pages.get(TAB_1)!
    pane.opened = { type: "confirm", message: "정말 지울까요?", defaultValue: "" }
    start(panes)
    const view = await watch("ses_1")
    await view.until(() => states(view).find((item) => item.dialog !== null))
    expect(states(view).at(-1)!.dialog).toEqual({ type: "confirm", message: "정말 지울까요?", defaultPrompt: "" })
    // The renderer is blocked: a touch would only wait.
    view.send({ t: "input", events: [{ k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.5 }] }] })
    view.send({ t: "action", id: 9, action: { type: "dialog", accept: true } })
    expect(await view.result(9)).toMatchObject({ ok: true })
    expect(pane.ran.at(-1)).toEqual({ type: "dialog", tabID: TAB_1, action: "accept" })
    await view.until(() => (states(view).at(-1)!.dialog === null ? true : undefined))
    expect(page.count("Input.dispatchTouchEvent")).toBe(0)
    // A dialog that opens later publishes the same inventory: the pane still says "changed".
    pane.opened = { type: "alert", message: "저장했어요", defaultValue: "" }
    pane.changed()
    await view.until(() => states(view).find((item) => item.dialog?.type === "alert"))
    // A pane at rest is asked nothing: reading the dialog publishes no state that would ask again.
    await Bun.sleep(300)
    const asked = pane.asked
    await Bun.sleep(600)
    expect(pane.asked).toBe(asked)
  })

  test("phone mode: emulation on the focused tab, moved with the focus, cleared when the view goes back to pc", async () => {
    const panes = fakePanes()
    const pane = panes.add("ses_1")
    const one = pane.pages.get(TAB_1)!
    const two = pane.pages.get(TAB_2)!
    start(panes)
    const view = await watch("ses_1", { mode: "phone", viewport: { width: 390, height: 800, dpr: 3 } })
    await view.until(() => states(view).find((item) => item.page?.mode === "phone"))
    expect(states(view).at(-1)!.page).toEqual({ mode: "phone", width: 390, height: 800 })
    expect(one.last("Emulation.setDeviceMetricsOverride")).toMatchObject({
      width: 390,
      height: 800,
      deviceScaleFactor: 3,
      mobile: true,
    })
    expect(one.last("Emulation.setTouchEmulationEnabled")).toEqual({ enabled: true, maxTouchPoints: 5 })
    expect(String(one.last("Emulation.setUserAgentOverride")!.userAgent)).toContain("Android")
    // 390×800 at 3: the quick tier's 720 px on the long side.
    expect(one.last("Page.startScreencast")).toMatchObject({ maxWidth: 351, maxHeight: 720 })
    // Another viewport (the phone turned): emulated again, and the screencast follows.
    view.send({ t: "view", viewport: { width: 800, height: 390, dpr: 3 } })
    await eventually(
      () => one.last("Emulation.setDeviceMetricsOverride"),
      (value) => value?.width === 800,
    )
    await eventually(
      () => one.last("Page.startScreencast"),
      (value) => value?.maxWidth === 720,
    )
    expect(one.last("Page.startScreencast")).toMatchObject({ maxWidth: 720, maxHeight: 351 })
    // The other tab takes the focus: the emulation moves with it.
    pane.focus(TAB_2)
    await eventually(
      () => two.last("Emulation.setDeviceMetricsOverride"),
      (value) => value !== undefined,
    )
    expect(one.emulated).toBeUndefined()
    expect(one.last("Emulation.setTouchEmulationEnabled")).toEqual({ enabled: false })
    expect(one.last("Emulation.setUserAgentOverride")).toEqual({ userAgent: "" })
    expect(one.methods()).toContain("Page.stopScreencast")
    expect(one.listening()).toBe(0)
    expect(two.emulated).toMatchObject({ width: 800, height: 390 })
    // Back to the PC's size.
    view.send({ t: "view", mode: "pc" })
    await view.until(() => (states(view).at(-1)!.page?.mode === "pc" ? true : undefined))
    expect(two.emulated).toBeUndefined()
    expect(two.last("Emulation.setTouchEmulationEnabled")).toEqual({ enabled: false })
    expect(two.last("Emulation.setUserAgentOverride")).toEqual({ userAgent: "" })
    expect(states(view).at(-1)!.page).toEqual({ mode: "pc", width: 1000, height: 700 })
  })

  const emulating = async (panes: ReturnType<typeof fakePanes>) => {
    const pane = panes.add("ses_1")
    const page = pane.pages.get(TAB_1)!
    const view = await watch("ses_1", { mode: "phone" })
    await eventually(
      () => page.emulated,
      (value) => value !== undefined,
    )
    expect(page.emulated).toBeDefined()
    // While it is streamed the page's caret is held still.
    expect(page.still).toBe(true)
    return { pane, page, view }
  }
  const cleared = async (page: FakePage) => {
    await eventually(
      () => page.last("Emulation.setUserAgentOverride"),
      (value) => value?.userAgent === "",
    )
    expect(page.emulated).toBeUndefined()
    expect(page.last("Emulation.setTouchEmulationEnabled")).toEqual({ enabled: false })
    expect(page.last("Emulation.setUserAgentOverride")).toEqual({ userAgent: "" })
    expect(page.methods().lastIndexOf("Page.stopScreencast")).toBeGreaterThan(
      page.methods().lastIndexOf("Page.startScreencast"),
    )
    // The caret blinks again, and what the page borrowed went back.
    expect(page.still).toBe(false)
    expect(page.rests).toBeGreaterThan(0)
  }

  test("the PC's pane never stays phone-sized: the view turns hidden", async () => {
    const panes = fakePanes()
    const bridge = start(panes)
    const { page, view } = await emulating(panes)
    view.send({ t: "view", visible: false })
    await cleared(page)
    expect(bridge.sessions()).toEqual([])
  })

  test("the PC's pane never stays phone-sized: the viewer closes", async () => {
    const panes = fakePanes()
    start(panes)
    const { page, view } = await emulating(panes)
    view.close()
    await cleared(page)
  })

  test("the PC's pane never stays phone-sized: the device loses its browser scope, within one pull", async () => {
    const panes = fakePanes()
    const bridge = start(panes)
    const device = await fx().pair({ scopes: ["read", "prompt", "browser"], name: "곧 꺼질 기기" })
    const pane = panes.add("ses_2")
    const page = pane.pages.get(TAB_1)!
    const view = await watch("ses_2", { mode: "phone" }, device)
    await eventually(
      () => page.emulated,
      (value) => value !== undefined,
    )
    const at = Date.now()
    await fx().gateway.update({ deviceId: device.deviceId, scopes: ["read", "prompt"] })
    expect((await view.closed).code).toBe(RemoteBrowser.CLOSE.scope)
    await cleared(page)
    expect(Date.now() - at).toBeLessThan(1500)
    expect(bridge.sessions()).toEqual([])
  })

  test("the PC's pane never stays phone-sized: the hub goes silent (fail safe), and the stream comes back with it", async () => {
    const panes = fakePanes()
    const bridge = start(panes)
    const { page, view } = await emulating(panes)
    link.down = true
    const at = Date.now()
    await cleared(page)
    // Not before the fail safe's time (700 ms here, 15 s in the shell), and not long after it.
    expect(Date.now() - at).toBeGreaterThanOrEqual(timing.failSafeMs - 250)
    expect(bridge.sessions()).toEqual([])
    const before = page.count("Emulation.setDeviceMetricsOverride")
    link.down = false
    await eventually(
      () => page.count("Emulation.setDeviceMetricsOverride"),
      (count) => count > before,
    )
    expect(page.emulated).toBeDefined()
    expect(bridge.sessions()).toEqual(["ses_1"])
    view.close()
    await cleared(page)
  })

  test("the PC's pane never stays phone-sized: the pane's attachment goes away", async () => {
    const panes = fakePanes()
    start(panes)
    const { pane, page, view } = await emulating(panes)
    pane.remove()
    await cleared(page)
    await view.state("attaching")
    // It attaches again (the window registered the session anew): the state is sent again and the emulation is back.
    const again = panes.add("ses_1")
    await view.state("ready")
    await eventually(
      () => again.pages.get(TAB_1)!.emulated,
      (value) => value !== undefined,
    )
    expect(again.pages.get(TAB_1)!.emulated).toMatchObject({ width: 390, height: 800 })
    await view.until(() => (states(view).at(-1)!.page?.mode === "phone" ? true : undefined))
  })

  test("the PC's pane never stays phone-sized: the shell stops", async () => {
    const panes = fakePanes()
    const bridge = start(panes)
    const { page } = await emulating(panes)
    await bridge.stop()
    expect(page.emulated).toBeUndefined()
    expect(page.last("Emulation.setUserAgentOverride")).toEqual({ userAgent: "" })
    expect(page.listening()).toBe(0)
  })

  test("a tab whose view is not shown: screenshots after a compositor kick, only the ones that differ", async () => {
    const panes = fakePanes()
    const pane = panes.add("ses_1")
    const page = pane.pages.get(TAB_1)!
    start(panes)
    const view = await watch("ses_1", { quality: "low" })
    await eventually(
      () => page.last("Page.startScreencast"),
      (value) => value !== undefined,
    )
    page.emit("Page.screencastVisibilityChanged", { visible: false })
    const first = await view.frame(1)
    expect(first.header).toMatchObject({ width: 540, height: 378, sharp: false })
    expect(page.kicks).toBeGreaterThan(0)
    view.send({ t: "ack", seq: first.header.seq })
    await Bun.sleep(700)
    // The same picture again and again: nothing more is sent.
    expect(view.frames).toHaveLength(1)
    expect(page.count("Page.captureScreenshot")).toBeGreaterThan(1)
    page.picture = 2
    const second = await view.frame(2)
    expect(Buffer.from(second.jpeg)[40]).toBe(2)
    view.send({ t: "ack", seq: second.header.seq })
    // Chromium's "visible" alone is no promise of frames (a tab in a hidden window gets none): the screenshots go on.
    page.emit("Page.screencastVisibilityChanged", { visible: true })
    const before = page.count("Page.captureScreenshot")
    await Bun.sleep(700)
    expect(page.count("Page.captureScreenshot")).toBeGreaterThan(before)
    // A screencast frame is: Chromium's screencast takes over, the screenshots stop.
    page.frame(3, 540, 378)
    const third = await view.frame(3)
    view.send({ t: "ack", seq: third.header.seq })
    await Bun.sleep(100)
    const taken = page.count("Page.captureScreenshot")
    await Bun.sleep(700)
    expect(page.count("Page.captureScreenshot")).toBe(taken)
    // Done with the page: what the kick borrowed for it goes back.
    expect(page.rests).toBe(0)
    view.send({ t: "view", visible: false })
    await eventually(
      () => page.rests,
      (count) => count === 1,
    )
    expect(page.rests).toBe(1)
  })

  test("a tab made in a window in the tray: its first load waits for a surface, so a slow one is kicked", async () => {
    const panes = fakePanes()
    const page = panes.add("ses_1").pages.get(TAB_1)!
    const loaded = Promise.withResolvers<void>()
    page.ready = loaded.promise
    page.kick = async () => {
      page.kicks++
      loaded.resolve()
    }
    start(panes)
    const view = await watch("ses_1")
    await eventually(
      () => page.last("Page.startScreencast"),
      (value) => value !== undefined,
    )
    expect(page.kicks).toBeGreaterThan(0)
    // Lent a surface, the page draws.
    page.frame(1)
    const first = await view.frame(1)
    expect(first.header.sharp).toBe(false)
  })

  test("a tab that gives neither a frame nor a screenshot, and no word that it is hidden, is taken as hidden", async () => {
    const panes = fakePanes()
    const page = panes.add("ses_1").pages.get(TAB_1)!
    const send = page.send
    // No display surface until the kick: a screenshot answers nothing.
    page.send = async (method: string, params: object = {}) =>
      method === "Page.captureScreenshot" && page.kicks === 0 ? {} : send(method, params)
    start(panes)
    const view = await watch("ses_1", { quality: "low" })
    const first = await view.frame(1)
    expect(page.kicks).toBeGreaterThan(0)
    expect(first.header.sharp).toBe(false)
  })

  test("a frame above the limit is never sent: a smaller screenshot goes instead", async () => {
    const panes = fakePanes()
    const page = panes.add("ses_1").pages.get(TAB_1)!
    start(panes)
    const view = await watch("ses_1", { quality: "low" })
    await eventually(
      () => page.last("Page.startScreencast"),
      (value) => value !== undefined,
    )
    page.emit("Page.screencastFrame", {
      data: jpeg(540, 378, 9, RemoteBrowser.MAX_FRAME_BYTES + 10),
      sessionId: 1,
      metadata: {},
    })
    const frame = await view.frame(1)
    expect(frame.jpeg.byteLength).toBeLessThan(RemoteBrowser.MAX_FRAME_BYTES)
    expect(page.count("Page.captureScreenshot")).toBe(1)
    const posted = fx().service.seen.filter((item) => item.path.endsWith("/browser.host.frame"))
    expect(posted.every((item) => item.body.length < 2_100_000)).toBe(true)
  })

  test("no device may watch: the hub says idle and the bridge only looks in now and then, without waiting there", async () => {
    const idle = await BrowserGateway.start({ sessions: { ses_1: {} } })
    const panes = fakePanes()
    const bridge = startRemoteBrowser({
      service: async () => ({
        url: idle.service.url,
        authorization: `Basic ${btoa(`opencode:${idle.service.password}`)}`,
        control: "C:\\own-home\\control",
      }),
      panes: panes.registry,
      windows: () => 1,
      chrome: "146.0.7680.65",
      timing,
    })
    await Bun.sleep(700)
    const pulls = idle.service.seen.filter((item) => item.path.endsWith("/browser.host.pull"))
    const waits = pulls.map((item) => (JSON.parse(item.body) as { input: { waitMs: number } }).input.waitMs)
    // The first pull may wait (the bridge does not know yet); every later one is a plain look.
    expect(waits.slice(1).every((wait) => wait === 0)).toBe(true)
    expect(pulls.length).toBeGreaterThanOrEqual(3)
    expect(pulls.length).toBeLessThanOrEqual(7)
    // Still told at once when a pane appears.
    const before = Date.now()
    panes.add("ses_1")
    await eventually(
      () => idle.gateway.browser.hosted("ses_1"),
      (value) => value,
    )
    expect(Date.now() - before).toBeLessThan(140)
    await bridge.stop()
    await idle.stop()
  })

  test("the service is gone and comes back with another password: found again", async () => {
    const panes = fakePanes()
    panes.add("ses_3")
    const found = { calls: 0, wrong: true }
    const bridge = startRemoteBrowser({
      service: async () => {
        found.calls++
        return {
          url: fx().service.url,
          authorization: `Basic ${btoa(`opencode:${found.wrong ? "old-password" : fx().service.password}`)}`,
          control: "C:\\own-home\\control",
        }
      },
      panes: panes.registry,
      windows: () => 1,
      chrome: "146.0.7680.65",
      timing,
    })
    await eventually(
      () => found.calls,
      (calls) => calls >= 3,
    )
    expect(fx().gateway.browser.hosted("ses_3")).toBe(false)
    found.wrong = false
    await eventually(
      () => fx().gateway.browser.hosted("ses_3"),
      (value) => value,
    )
    expect(fx().gateway.browser.hosted("ses_3")).toBe(true)
    await bridge.stop()
  })
})

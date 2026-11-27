// 휴대폰·다른 PC에서 보는 앱 안 브라우저 (05 §8.10, MBR): the viewer's messages as the gateway checks them, the frame
// header, typing from a soft keyboard (한글 조합) and the frame scale.
import { describe, expect, test } from "bun:test"
import { RemoteBrowser } from "../src/remote-browser.js"
import { OwnRemote } from "../src/rpc-remote.js"

const hello = { t: "hello", v: 1, viewport: { width: 384, height: 620, dpr: 2.8125 }, mode: "pc", quality: "auto", visible: true }
const parse = (value: unknown) => RemoteBrowser.parseClientMessage(JSON.stringify(value))

describe("RemoteBrowser messages", () => {
  test("hello: version, viewport, mode and quality must all be right", () => {
    expect(parse(hello)).toEqual(hello as never)
    expect(parse({ ...hello, v: 2 })).toBeUndefined()
    expect(parse({ ...hello, mode: "tablet" })).toBeUndefined()
    expect(parse({ ...hello, quality: "max" })).toBeUndefined()
    expect(parse({ ...hello, visible: "yes" })).toBeUndefined()
    expect(parse({ ...hello, viewport: { width: 50, height: 620, dpr: 2 } })).toBeUndefined()
    expect(parse({ ...hello, viewport: { width: 384, height: 99_999, dpr: 2 } })).toBeUndefined()
    expect(parse({ ...hello, viewport: { width: 384, height: 620, dpr: 9 } })).toBeUndefined()
    expect(parse({ ...hello, viewport: { width: 384, height: 620, dpr: Number.NaN } })).toBeUndefined()
  })

  test("a viewport is rounded to whole px", () => {
    expect(RemoteBrowser.parseViewport({ width: 384.4, height: 619.6, dpr: 2.81251 })).toEqual({
      width: 384,
      height: 620,
      dpr: 2.8125,
    })
  })

  test("view: any subset; nothing else rides along", () => {
    expect(parse({ t: "view", visible: false })).toEqual({ t: "view", visible: false })
    expect(parse({ t: "view", mode: "phone", viewport: hello.viewport, extra: 1 })).toEqual({
      t: "view",
      mode: "phone",
      viewport: hello.viewport,
    })
    expect(parse({ t: "view", mode: "wide" })).toBeUndefined()
  })

  test("input: touches, mouse, wheel, keys and text inside the limits", () => {
    const events = [
      { k: "touch", phase: "start", points: [{ id: 0, x: 0.5, y: 0.25 }] },
      { k: "touch", phase: "end", points: [] },
      { k: "mouse", phase: "down", x: 0, y: 1, button: "left", clicks: 2 },
      { k: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 120 },
      { k: "key", key: "Enter" },
      { k: "key", key: "a", ctrl: true },
      { k: "text", text: "안녕하세요" },
      { k: "compose", text: "" },
    ]
    expect(parse({ t: "input", events })).toEqual({ t: "input", events } as never)
  })

  test("input: one bad event refuses the whole message", () => {
    const bad = [
      { k: "touch", phase: "start", points: [{ id: 0, x: 1.5, y: 0 }] },
      { k: "touch", phase: "start", points: Array.from({ length: 6 }, (_, id) => ({ id, x: 0, y: 0 })) },
      { k: "touch", phase: "hover", points: [] },
      { k: "mouse", phase: "down", x: 0, y: 0, button: "fourth" },
      { k: "mouse", phase: "down", x: 0, y: 0, button: "left", clicks: 9 },
      { k: "wheel", x: 0, y: 0, dx: "1", dy: 0 },
      { k: "key", key: "F13" },
      { k: "key", key: "ab" },
      { k: "text", text: "" },
      { k: "text", text: "x".repeat(RemoteBrowser.MAX_TEXT + 1) },
      { k: "script", code: "alert(1)" },
    ]
    for (const event of bad) expect(parse({ t: "input", events: [{ k: "key", key: "Enter" }, event] })).toBeUndefined()
    expect(parse({ t: "input", events: [] })).toBeUndefined()
    expect(
      parse({ t: "input", events: Array.from({ length: RemoteBrowser.MAX_EVENTS + 1 }, () => ({ k: "key", key: "Tab" })) }),
    ).toBeUndefined()
  })

  test("a wheel step is clamped, a key keeps only the modifiers that are on", () => {
    expect(RemoteBrowser.parseInputEvent({ k: "wheel", x: 0, y: 0, dx: 1e9, dy: -1e9 })).toEqual({
      k: "wheel",
      x: 0,
      y: 0,
      dx: 10_000,
      dy: -10_000,
    })
    expect(RemoteBrowser.parseInputEvent({ k: "key", key: "Tab", shift: true, ctrl: false })).toEqual({
      k: "key",
      key: "Tab",
      shift: true,
    })
  })

  test("actions: only http(s) addresses; file, javascript and data never", () => {
    expect(parse({ t: "action", id: 1, action: { type: "navigate", url: "http://localhost:3000/" } })).toEqual({
      t: "action",
      id: 1,
      action: { type: "navigate", url: "http://localhost:3000/" },
    })
    for (const url of ["file:///C:/Users/x/secret.txt", "javascript:alert(1)", "data:text/html,x", "C:\\Users\\x", "about:blank", ""])
      expect(parse({ t: "action", id: 1, action: { type: "navigate", url } })).toBeUndefined()
    expect(parse({ t: "action", id: 1, action: { type: "tabs.open", url: "chrome://settings" } })).toBeUndefined()
    expect(parse({ t: "action", id: 1, action: { type: "tabs.open" } })).toEqual({ t: "action", id: 1, action: { type: "tabs.open" } })
    expect(parse({ t: "action", id: 2, action: { type: "tabs.close", tabID: "tab_1" } })).toEqual({
      t: "action",
      id: 2,
      action: { type: "tabs.close", tabID: "tab_1" },
    })
    expect(parse({ t: "action", id: 2, action: { type: "tabs.close" } })).toBeUndefined()
    expect(parse({ t: "action", id: 3, action: { type: "dialog", accept: true, text: "네" } })).toEqual({
      t: "action",
      id: 3,
      action: { type: "dialog", accept: true, text: "네" },
    })
    expect(parse({ t: "action", id: 3, action: { type: "evaluate", script: "1" } })).toBeUndefined()
    expect(parse({ t: "action", id: -1, action: { type: "back" } })).toBeUndefined()
  })

  test("anything that is not a message of the contract is refused", () => {
    expect(RemoteBrowser.parseClientMessage("not json")).toBeUndefined()
    expect(RemoteBrowser.parseClientMessage("[]")).toBeUndefined()
    expect(RemoteBrowser.parseClientMessage("null")).toBeUndefined()
    expect(parse({ t: "attach", sessionID: "x" })).toBeUndefined()
    expect(parse({ t: "ack", seq: -1 })).toBeUndefined()
    expect(parse({ t: "ack", seq: 7 })).toEqual({ t: "ack", seq: 7 })
    expect(RemoteBrowser.parseClientMessage(JSON.stringify({ t: "ack", seq: 1, pad: "x".repeat(RemoteBrowser.MAX_MESSAGE_BYTES) }))).toBeUndefined()
  })
})

describe("RemoteBrowser frames", () => {
  test("the header round-trips and the JPEG follows it", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const bytes = RemoteBrowser.encodeFrame({ seq: 0xfffffffe, width: 1080, height: 2087, sharp: true }, jpeg)
    expect(bytes.byteLength).toBe(RemoteBrowser.FRAME_HEADER_BYTES + jpeg.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("OBF1")
    const decoded = RemoteBrowser.decodeFrame(bytes)
    expect(decoded?.header).toEqual({ seq: 0xfffffffe, width: 1080, height: 2087, sharp: true })
    expect([...decoded!.jpeg]).toEqual([...jpeg])
  })

  test("a view into a larger buffer decodes from its own offset", () => {
    const frame = RemoteBrowser.encodeFrame({ seq: 3, width: 10, height: 20, sharp: false }, new Uint8Array([9]))
    const padded = new Uint8Array(frame.byteLength + 8)
    padded.set(frame, 8)
    expect(RemoteBrowser.decodeFrame(padded.subarray(8))?.header).toEqual({ seq: 3, width: 10, height: 20, sharp: false })
  })

  test("bytes that are not a frame are not decoded", () => {
    expect(RemoteBrowser.decodeFrame(new Uint8Array(4))).toBeUndefined()
    expect(RemoteBrowser.decodeFrame(new Uint8Array(RemoteBrowser.FRAME_HEADER_BYTES + 4))).toBeUndefined()
    expect(RemoteBrowser.decodeFrame(RemoteBrowser.encodeFrame({ seq: 1, width: 1, height: 1, sharp: false }, new Uint8Array()))).toBeUndefined()
  })

  test("frames are never larger than the viewer's own pixels or the quality's side, and never upscaled", () => {
    const s23 = { width: 384, height: 620, dpr: 2.8125 }
    // A 1000×700 PC page on the S23: its longest side is 1744 px there, the quick tier allows 720.
    expect(RemoteBrowser.frameScale({ width: 1000, height: 700, pageDpr: 1, viewport: s23, side: 720 })).toBeCloseTo(0.72)
    // The sharp tier allows 1600, but the page only has 1000.
    expect(RemoteBrowser.frameScale({ width: 1000, height: 700, pageDpr: 1, viewport: s23, side: 1600 })).toBe(1)
    // Phone emulation at the S23's ratio: 620 × 2.8125 = 1744 px native, sharp capped at 1600.
    expect(RemoteBrowser.frameScale({ width: 384, height: 620, pageDpr: 2.8125, viewport: s23, side: 1600 })).toBeCloseTo(1600 / 1743.75)
    expect(RemoteBrowser.frameScale({ width: 0, height: 0, pageDpr: 1, viewport: s23, side: 720 })).toBe(1)
  })
})

describe("RemoteBrowser typing", () => {
  const typed = RemoteBrowser.typed

  test("plain text: what was added", () => {
    expect(typed({ before: "", after: "a", composed: "", composing: "" })).toEqual([{ k: "text", text: "a" }])
    expect(typed({ before: "ab", after: "abc d", composed: "", composing: "" })).toEqual([{ k: "text", text: "c d" }])
  })

  test("deleting: one backspace for each character that went away", () => {
    expect(typed({ before: "abc", after: "a", composed: "", composing: "" })).toEqual([
      { k: "key", key: "Backspace" },
      { k: "key", key: "Backspace" },
    ])
  })

  test("a replaced word (autocorrect): backspaces to the common start, then the new end", () => {
    expect(typed({ before: "teh", after: "the ", composed: "", composing: "" })).toEqual([
      { k: "key", key: "Backspace" },
      { k: "key", key: "Backspace" },
      { k: "text", text: "he " },
    ])
  })

  test("한글 조합: the syllable being built goes as the composition, the finished one as text", () => {
    // ㅎ → 하 → 한 while composing
    expect(typed({ before: "", after: "", composed: "", composing: "ㅎ" })).toEqual([{ k: "compose", text: "ㅎ" }])
    expect(typed({ before: "", after: "", composed: "ㅎ", composing: "하" })).toEqual([{ k: "compose", text: "하" }])
    expect(typed({ before: "", after: "", composed: "하", composing: "한" })).toEqual([{ k: "compose", text: "한" }])
    // ㄱ after 한: 한 is committed and ㄱ starts composing
    expect(typed({ before: "", after: "한", composed: "한", composing: "ㄱ" })).toEqual([
      { k: "text", text: "한" },
      { k: "compose", text: "ㄱ" },
    ])
    // 한글 then the composition ends (space, or the keyboard closes): the text alone, no composition left to clear
    expect(typed({ before: "한", after: "한글", composed: "글", composing: "" })).toEqual([{ k: "text", text: "글" }])
  })

  test("the same syllable composed again after a commit is set again", () => {
    expect(typed({ before: "", after: "가", composed: "가", composing: "가" })).toEqual([
      { k: "text", text: "가" },
      { k: "compose", text: "가" },
    ])
  })

  test("backspace inside a composition only changes the composition; emptying it cancels it", () => {
    expect(typed({ before: "한", after: "한", composed: "글", composing: "그" })).toEqual([{ k: "compose", text: "그" }])
    expect(typed({ before: "한", after: "한", composed: "ㄱ", composing: "" })).toEqual([{ k: "compose", text: "" }])
  })

  test("committed text deleted while a composition is open: the composition is cancelled first", () => {
    expect(typed({ before: "한글", after: "한", composed: "ㅇ", composing: "" })).toEqual([
      { k: "compose", text: "" },
      { k: "key", key: "Backspace" },
    ])
  })

  test("characters outside the BMP count once", () => {
    expect(typed({ before: "😀a", after: "😀", composed: "", composing: "" })).toEqual([{ k: "key", key: "Backspace" }])
    expect(typed({ before: "a😀", after: "a", composed: "", composing: "" })).toEqual([{ k: "key", key: "Backspace" }])
  })

  test("nothing changed: nothing is sent", () => {
    expect(typed({ before: "a", after: "a", composed: "", composing: "" })).toEqual([])
  })

  test("a long paste is cut into text events of the limit", () => {
    const events = typed({ before: "", after: "x".repeat(RemoteBrowser.MAX_TEXT + 5), composed: "", composing: "" })
    expect(events.map((event) => (event.k === "text" ? event.text.length : -1))).toEqual([RemoteBrowser.MAX_TEXT, 5])
    for (const event of events) expect(RemoteBrowser.parseInputEvent(event)).toEqual(event)
  })
})

describe("own.remote and the browser scope", () => {
  test("`browser` is a device scope that no new device gets by itself", () => {
    expect(OwnRemote.DEVICE_SCOPES).toContain("browser")
    expect(OwnRemote.DEFAULT_DEVICE_SCOPES).not.toContain("browser")
    expect(OwnRemote.EXTRA_DEVICE_SCOPES).toEqual(["browser"])
  })

  test("a device reads only whether the desktop app is there; the pane's and the shell's methods are local", () => {
    const every = new Set(OwnRemote.DEVICE_SCOPES as ReadonlyArray<string>)
    expect(OwnRemote.deviceAllows(new Set(["read"]), "browser.status", {})).toBe(true)
    expect(OwnRemote.deviceAllows(new Set(["browser", "prompt"]), "browser.status", {})).toBe(false)
    for (const method of ["browser.pane.wanted", "browser.host.pull", "browser.host.frame", "browser.host.state", "browser.host.result"] as const)
      expect(OwnRemote.deviceAllows(every, method, {})).toBe(false)
    expect(OwnRemote.EventScope["browser.pane.wanted"]).toBe("local")
  })
})

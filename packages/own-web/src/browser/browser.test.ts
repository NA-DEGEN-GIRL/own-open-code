// Browser pane model (05 §8.2) without Electron: registration lifecycle, closing reasons, re-register rule,
// address normalization and the host gate.
import { describe, expect, test } from "bun:test"
import type { OwnHost } from "@/host/types"
import { createBrowserAttachments } from "./attachments"
import { createPaneConnection } from "./connection"
import { normalizeAddress } from "./index"
import {
  browserPlatform,
  PANE_CLOSED,
  type BrowserPaneEvent,
  type BrowserPanePlatform,
  type BrowserPaneTarget,
} from "./types"

function fakePlatform() {
  const registrations: {
    target: BrowserPaneTarget
    emit: (event: BrowserPaneEvent) => void
    closed: boolean
    commands: unknown[]
  }[] = []
  const platform: BrowserPanePlatform = {
    platform: "desktop",
    register(target, listener) {
      const entry = { target, emit: listener, closed: false, commands: [] as unknown[] }
      registrations.push(entry)
      return {
        setLayout() {},
        command: async (command) => void entry.commands.push(command),
        capture: async () => null,
        close: () => void (entry.closed = true),
      }
    },
  }
  return { platform, registrations }
}

const target: BrowserPaneTarget = {
  serverKey: "local",
  sessionID: "ses_1",
  endpoint: { url: "http://127.0.0.1:28538" },
}
const tab = {
  id: "tab_00000000-0000-0000-0000-000000000001",
  url: "http://localhost:5173/",
  title: "app",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}

describe("pane connection", () => {
  test("registers on wake, attaches on the first state, restores the last state on re-register", () => {
    const { platform, registrations } = fakePlatform()
    const connection = createPaneConnection({ platform, target: () => target })
    connection.wake()
    connection.wake()
    expect(registrations).toHaveLength(1)
    registrations[0]!.emit({ type: "state", state: { tabs: [tab], focusedTabID: tab.id } })
    expect(connection.state()).toMatchObject({ attached: true, registered: true })
    connection.reset()
    expect(registrations[0]!.closed).toBe(true)
    expect(registrations).toHaveLength(2)
    expect(registrations[1]!.target.restore).toEqual({ tabs: [tab], focusedTabID: tab.id })
  })

  test("replaced / unsupported stop retrying until unblock", async () => {
    const { platform, registrations } = fakePlatform()
    const scheduled: number[] = []
    const connection = createPaneConnection({
      platform,
      target: () => target,
      schedule: (_run, ms) => {
        scheduled.push(ms)
        return () => undefined
      },
    })
    connection.wake()
    registrations[0]!.emit({ type: "state", state: null, error: PANE_CLOSED.replaced })
    expect(connection.state().blocked).toBe("replaced")
    connection.wake()
    expect(registrations).toHaveLength(1)
    expect(scheduled).toEqual([])
    await expect(connection.command({ type: "tabs.open" })).rejects.toThrow("browser.pane.unavailable")
    connection.unblock()
    expect(registrations).toHaveLength(2)
    expect(connection.state().blocked).toBeUndefined()
  })

  test("a closed registration retries with backoff; suspended waits for the next use", () => {
    const { platform, registrations } = fakePlatform()
    const scheduled: { ms: number; run: () => void }[] = []
    const connection = createPaneConnection({
      platform,
      target: () => target,
      schedule: (run, ms) => {
        scheduled.push({ ms, run })
        return () => undefined
      },
    })
    connection.wake()
    registrations[0]!.emit({ type: "state", state: null, error: PANE_CLOSED.closed })
    expect(scheduled.map((entry) => entry.ms)).toEqual([1_000])
    scheduled[0]!.run()
    registrations[1]!.emit({ type: "state", state: null, error: PANE_CLOSED.closed })
    expect(scheduled.map((entry) => entry.ms)).toEqual([1_000, 2_000])
    scheduled[1]!.run()
    registrations[2]!.emit({ type: "state", state: { tabs: [tab], focusedTabID: null }, error: PANE_CLOSED.suspended })
    expect(scheduled).toHaveLength(2)
    expect(connection.state()).toMatchObject({ suspended: true, registered: false })
    void connection.command({ type: "tabs.focus", tabID: tab.id })
    expect(registrations).toHaveLength(4)
    expect(registrations[3]!.commands).toEqual([{ type: "tabs.focus", tabID: tab.id }])
  })

  test("missing (the server does not know the session yet) shows no error, never retries and waits for the next use", () => {
    const { platform, registrations } = fakePlatform()
    const scheduled: number[] = []
    const connection = createPaneConnection({
      platform,
      target: () => target,
      schedule: (_run, ms) => {
        scheduled.push(ms)
        return () => undefined
      },
    })
    connection.wake()
    registrations[0]!.emit({ type: "state", state: null, error: PANE_CLOSED.missing })
    expect(scheduled).toEqual([])
    expect(connection.state()).toMatchObject({ suspended: true, registered: false })
    expect(connection.state().blocked).toBeUndefined()
    expect(connection.state().error).toBeUndefined()
    connection.refresh()
    expect(registrations).toHaveLength(1)
    connection.wake()
    expect(registrations).toHaveLength(2)
  })

  test("suspended because the pane went away registers again on refresh; an idle eviction does not", () => {
    const { platform, registrations } = fakePlatform()
    const connection = createPaneConnection({ platform, target: () => target })
    connection.wake()
    registrations[0]!.emit({ type: "state", state: { tabs: [tab], focusedTabID: null }, error: PANE_CLOSED.suspended })
    connection.refresh()
    expect(registrations).toHaveLength(1)
    connection.wake()
    registrations[1]!.emit({
      type: "state",
      state: { tabs: [tab], focusedTabID: null },
      error: PANE_CLOSED.suspended,
      lost: true,
    })
    expect(connection.state()).toMatchObject({ suspended: true, registered: false })
    connection.refresh()
    expect(registrations).toHaveLength(3)
    expect(registrations[2]!.target.restore).toEqual({ tabs: [tab], focusedTabID: null })
    // Registered again: a later refresh is a no-op.
    connection.refresh()
    expect(registrations).toHaveLength(3)
  })

  test("focus and preview events are routed, not stored", () => {
    const { platform, registrations } = fakePlatform()
    const focused: string[] = []
    const previews: string[] = []
    const connection = createPaneConnection({
      platform,
      target: () => target,
      focus: (id) => focused.push(id),
      preview: (path) => previews.push(path),
    })
    connection.wake()
    registrations[0]!.emit({ type: "focus", tabID: tab.id })
    registrations[0]!.emit({ type: "preview", path: "out/chart.png" })
    expect(focused).toEqual([tab.id])
    expect(previews).toEqual(["out/chart.png"])
    expect(connection.state().attached).toBe(false)
  })

  test("no target, no registration", () => {
    const { platform, registrations } = fakePlatform()
    createPaneConnection({ platform, target: () => undefined }).wake()
    expect(registrations).toHaveLength(0)
  })
})

describe("attachments", () => {
  test("one per session, none without an endpoint, reset per server", () => {
    const { platform, registrations } = fakePlatform()
    let url: string | undefined
    const attachments = createBrowserAttachments({
      platform,
      endpoint: (serverKey) => (serverKey === "local" && url ? { url } : undefined),
    })
    expect(attachments.ensure("local", "ses_1")).toBeUndefined()
    url = "http://127.0.0.1:28538"
    const first = attachments.ensure("local", "ses_1")!
    expect(attachments.ensure("local", "ses_1")).toBe(first)
    first.wake()
    attachments.ensure("local", "ses_2")!.wake()
    expect(registrations.map((entry) => entry.target.sessionID)).toEqual(["ses_1", "ses_2"])
    expect(registrations[0]!.target.endpoint).toEqual({ url: "http://127.0.0.1:28538" })
    attachments.reset("local")
    expect(registrations).toHaveLength(4)
    attachments.dispose()
    expect(registrations.every((entry) => entry.closed || registrations.indexOf(entry) >= 2)).toBe(true)
  })

  test("the pane coming back registers the attachments its loss suspended", () => {
    const { platform, registrations } = fakePlatform()
    const returns: (() => void)[] = []
    const attachments = createBrowserAttachments({
      platform: { ...platform, onAvailable: (listener) => (returns.push(listener), () => returns.splice(0)) },
      endpoint: () => ({ url: "http://127.0.0.1:28538" }),
    })
    attachments.ensure("local", "ses_1")!.wake()
    attachments.ensure("local", "ses_2")!.wake()
    registrations[0]!.emit({ type: "state", state: null, error: PANE_CLOSED.suspended, lost: true })
    registrations[1]!.emit({ type: "state", state: null, error: PANE_CLOSED.suspended })
    returns.forEach((listener) => listener())
    expect(registrations.map((entry) => entry.target.sessionID)).toEqual(["ses_1", "ses_2", "ses_1"])
    attachments.dispose()
    expect(returns).toEqual([])
  })

  test("the host gate: only a host with the capability and a register()", () => {
    const capabilities = { browserPane: true } as OwnHost["capabilities"]
    expect(browserPlatform({ capabilities, browser: undefined })).toBeUndefined()
    expect(browserPlatform({ capabilities, browser: { platform: "desktop" } })).toBeUndefined()
    const { platform } = fakePlatform()
    expect(browserPlatform({ capabilities, browser: platform })).toBe(platform)
    expect(
      browserPlatform({ capabilities: { browserPane: false } as OwnHost["capabilities"], browser: platform }),
    ).toBeUndefined()
  })
})

describe("address bar", () => {
  const search = (text: string) => `https://www.google.com/search?q=${encodeURIComponent(text)}`

  test("http(s) kept, bare hosts get https, loopback gets http, other schemes refused", () => {
    expect(normalizeAddress(" https://example.com/a ")).toBe("https://example.com/a")
    expect(normalizeAddress("HTTP://Example.com")).toBe("HTTP://Example.com")
    expect(normalizeAddress("example.com")).toBe("https://example.com")
    expect(normalizeAddress("docs.example.co.kr/guide?x=1#top")).toBe("https://docs.example.co.kr/guide?x=1#top")
    expect(normalizeAddress("localhost:5173/x")).toBe("http://localhost:5173/x")
    expect(normalizeAddress("localhost")).toBe("http://localhost")
    expect(normalizeAddress("app.localhost:3000")).toBe("http://app.localhost:3000")
    expect(normalizeAddress("127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    expect(normalizeAddress("[::1]:8080/x")).toBe("http://[::1]:8080/x")
    expect(normalizeAddress("192.168.0.10")).toBe("https://192.168.0.10")
    expect(normalizeAddress("my-server:8080/api")).toBe("https://my-server:8080/api")
    expect(normalizeAddress("about:blank")).toBe("about:blank")
    expect(normalizeAddress("  ")).toBeUndefined()
  })

  test("text that is no address is a web search", () => {
    expect(normalizeAddress("solid js 문서")).toBe(search("solid js 문서"))
    expect(normalizeAddress("  리액트  ")).toBe(search("리액트"))
    expect(normalizeAddress("intranet")).toBe(search("intranet"))
    expect(normalizeAddress("3.14")).toBe(search("3.14"))
    // A user name in the address is refused by main; as text it is a search.
    expect(normalizeAddress("me@example.com")).toBe(search("me@example.com"))
    expect(normalizeAddress("c++ & rust?")).toBe(search("c++ & rust?"))
  })

  test("other schemes, drive paths and broken URLs do not open (and never go to the search engine)", () => {
    expect(normalizeAddress("file:///C:/Windows")).toBeUndefined()
    expect(normalizeAddress("javascript:alert(1)")).toBeUndefined()
    expect(normalizeAddress("chrome://settings")).toBeUndefined()
    expect(normalizeAddress("about:config")).toBeUndefined()
    expect(normalizeAddress("C:\\Users\\demo\\index.html")).toBeUndefined()
    expect(normalizeAddress("D:/demo/space-game/index.html")).toBeUndefined()
    expect(normalizeAddress("https://")).toBeUndefined()
    expect(normalizeAddress("https://user:secret@example.com")).toBeUndefined()
  })
})

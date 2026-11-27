// The mobile host's `remotePane` (05 §8.10.5 rule 1): when a paired device asks the PC whether its desktop app is
// running, what it answers meanwhile, and the request it sends through the gateway. The page (visibility and its
// event) and the transport are passed in, so nothing global is replaced.
import { describe, expect, jest, test } from "bun:test"
import { createRemotePane, desktopRunning, PANE_STATUS_MS } from "./mobile"

/** A `browser.status` whose answers the test settles one by one, in any order. */
function status() {
  const pending: { readonly resolve: (desktop: boolean) => void; readonly reject: (error: Error) => void }[] = []
  return {
    pending,
    read: () => new Promise<boolean>((resolve, reject) => pending.push({ resolve, reject })),
  }
}

function page(visibilityState: DocumentVisibilityState = "visible") {
  return Object.assign(new EventTarget(), { visibilityState })
}

/** Lets the settled read's continuation run. */
const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => Promise.resolve())

describe("remotePane (05 §8.10.5)", () => {
  test("asks when the host is created; false until the first answer, then the answer", async () => {
    const fx = status()
    const pane = createRemotePane(fx.read, page())
    expect(fx.pending).toHaveLength(1)
    expect(pane.available()).toBe(false)
    fx.pending[0]!.resolve(true)
    await settled()
    expect(pane.available()).toBe(true)
    pane.dispose()
  })

  test("a reconnect asks again, and the desktop app having quit turns it off", async () => {
    const fx = status()
    const pane = createRemotePane(fx.read, page())
    fx.pending[0]!.resolve(true)
    await settled()
    const again = pane.refresh()
    expect(fx.pending).toHaveLength(2)
    // Still the last known answer while the read is under way.
    expect(pane.available()).toBe(true)
    fx.pending[1]!.resolve(false)
    await again
    expect(pane.available()).toBe(false)
    pane.dispose()
  })

  test("a failed read is false, and the next one recovers", async () => {
    const fx = status()
    const pane = createRemotePane(fx.read, page())
    fx.pending[0]!.resolve(true)
    await settled()
    const failing = pane.refresh()
    fx.pending[1]!.reject(new Error("offline"))
    await failing
    expect(pane.available()).toBe(false)
    const next = pane.refresh()
    fx.pending[2]!.resolve(true)
    await next
    expect(pane.available()).toBe(true)
    pane.dispose()
  })

  test("the page turning visible asks; turning hidden does not", async () => {
    const fx = status()
    const view = page("hidden")
    const pane = createRemotePane(fx.read, view)
    expect(fx.pending).toHaveLength(1)
    view.dispatchEvent(new Event("visibilitychange"))
    expect(fx.pending).toHaveLength(1)
    view.visibilityState = "visible"
    view.dispatchEvent(new Event("visibilitychange"))
    expect(fx.pending).toHaveLength(2)
    fx.pending[1]!.resolve(true)
    await settled()
    expect(pane.available()).toBe(true)
    pane.dispose()
    view.dispatchEvent(new Event("visibilitychange"))
    expect(fx.pending).toHaveLength(2)
  })

  test("an answer a later read overtook is dropped", async () => {
    const fx = status()
    const pane = createRemotePane(fx.read, page())
    const later = pane.refresh()
    fx.pending[1]!.resolve(false)
    await later
    // The first read (from before the app quit) answers last.
    fx.pending[0]!.resolve(true)
    await settled()
    expect(pane.available()).toBe(false)
    pane.dispose()
  })

  test("once a minute while visible, never while hidden", () => {
    jest.useFakeTimers()
    try {
      const fx = status()
      const view = page()
      const pane = createRemotePane(fx.read, view)
      jest.advanceTimersByTime(PANE_STATUS_MS - 1)
      expect(fx.pending).toHaveLength(1)
      jest.advanceTimersByTime(1)
      expect(fx.pending).toHaveLength(2)
      view.visibilityState = "hidden"
      jest.advanceTimersByTime(PANE_STATUS_MS * 3)
      expect(fx.pending).toHaveLength(2)
      view.visibilityState = "visible"
      jest.advanceTimersByTime(PANE_STATUS_MS)
      expect(fx.pending).toHaveLength(3)
      pane.dispose()
      jest.advanceTimersByTime(PANE_STATUS_MS * 2)
      expect(fx.pending).toHaveLength(3)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("browser.status through the gateway", () => {
  /** A transport that records the request and answers with `response`. */
  function transport(response: () => Response) {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const request = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init })
        return response()
      },
      { preconnect: fetch.preconnect },
    )
    return { seen, request }
  }

  test("the request is the client's rpc.call for own.remote browser.status at the device's control location", async () => {
    const fx = transport(() => Response.json({ output: { desktop: true } }))
    expect(await desktopRunning("C:\\Users\\me\\own control", fx.request)).toBe(true)
    expect(fx.seen).toHaveLength(1)
    const url = new URL(fx.seen[0]!.url, "https://pc.example")
    expect(url.pathname).toBe("/srv/local/api/rpc/own.remote/browser.status")
    expect([...url.searchParams]).toEqual([["location[directory]", "C:\\Users\\me\\own control"]])
    expect(fx.seen[0]!.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    })
  })

  test("only `desktop: true` counts; a refusal or another shape is false", async () => {
    const ask = (response: () => Response) => desktopRunning("C:/control", transport(response).request)
    expect(await ask(() => Response.json({ output: { desktop: false } }))).toBe(false)
    expect(await ask(() => Response.json({ output: { desktop: "yes" } }))).toBe(false)
    expect(await ask(() => Response.json({}))).toBe(false)
    expect(await ask(() => Response.json({ type: "scope_denied" }, { status: 403 }))).toBe(false)
    expect(await ask(() => Response.json({ type: "unknown_rpc" }, { status: 404 }))).toBe(false)
  })

  test("a transport failure rejects, which the pane reads as false", async () => {
    const pane = createRemotePane(
      () =>
        desktopRunning(
          "C:/control",
          Object.assign(() => Promise.reject(new TypeError("Failed to fetch")), { preconnect: fetch.preconnect }),
        ),
      page(),
    )
    await pane.refresh()
    expect(pane.available()).toBe(false)
    pane.dispose()
  })
})

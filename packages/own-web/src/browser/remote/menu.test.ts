// The conversation `⋯` entry of the device viewer (05 §8.10): only a paired device without a pane of its own gets it.
import { describe, expect, test } from "bun:test"
import type { DataLayer } from "@/data"
import type { Shell } from "@/shell/context"
import { ENTRY_TEXT, remoteBrowserItems, viewerHost } from "./menu"

function rig(input: { readonly pane: boolean; readonly auth: "device" | "cookie" | "injected" | undefined }) {
  const opened: boolean[] = []
  // SAFETY: the entry reads these two members only.
  const shell = {
    shownView: (view: string) => view !== "browser" || input.pane,
    setBrowserView: (open: boolean) => void opened.push(open),
  } as unknown as Shell
  const data = {
    local: () => ({ entry: () => (input.auth ? { auth: input.auth } : undefined) }),
  } as unknown as DataLayer
  return { shell, data, opened }
}

describe("the conversation menu's 브라우저", () => {
  test("a paired device gets the entry, and it opens the view", () => {
    const r = rig({ pane: false, auth: "device" })
    expect(viewerHost(r)).toBe(true)
    const items = remoteBrowserItems({ ...r, locale: "ko" })
    expect(items).toHaveLength(1)
    const item = items[0]!
    if (typeof item === "string" || !("label" in item)) throw new Error("not an item")
    expect(item.label).toBe("브라우저")
    expect(item.testid).toBe("session-menu-browser")
    item.onSelect()
    expect(r.opened).toEqual([true])
    expect(remoteBrowserItems({ ...r, locale: "en" })).toMatchObject([{ label: ENTRY_TEXT.en.open }])
  })

  test("the desktop app keeps its own pane; a PC's browser window is no device; an unconnected window waits", () => {
    expect(remoteBrowserItems({ ...rig({ pane: true, auth: "injected" }), locale: "ko" })).toEqual([])
    expect(remoteBrowserItems({ ...rig({ pane: true, auth: "device" }), locale: "ko" })).toEqual([])
    expect(remoteBrowserItems({ ...rig({ pane: false, auth: "cookie" }), locale: "ko" })).toEqual([])
    expect(remoteBrowserItems({ ...rig({ pane: false, auth: "injected" }), locale: "ko" })).toEqual([])
    expect(remoteBrowserItems({ ...rig({ pane: false, auth: undefined }), locale: "ko" })).toEqual([])
  })
})

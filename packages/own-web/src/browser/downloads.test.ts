// Pane downloads (05 §8.4) without Electron: placement with the session whose tab started them, the unsaved set that
// guards a tab close, `gone` from the shell, and the removed state once the tab leaves.
import { describe, expect, test } from "bun:test"
import type { SessionAttachment } from "./attachments"
import { createDownloadStore, formatBytes } from "./downloads"
import type { BrowserDownload, BrowserDownloadSaveResult, BrowserDownloads } from "./types"

const TAB_A = "tab_00000000-0000-0000-0000-00000000000a"
const TAB_B = "tab_00000000-0000-0000-0000-00000000000b"

function attachment(sessionID: string, tabs: { id: string; url: string }[]) {
  return {
    serverKey: "local",
    sessionID,
    state: () => ({
      attached: true,
      registered: true,
      suspended: false,
      browser: {
        tabs: tabs.map((tab) => ({
          ...tab,
          title: "",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          generation: 1,
        })),
        focusedTabID: tabs[0]?.id ?? null,
      },
    }),
  } as unknown as SessionAttachment
}

function fakeShell() {
  let listener: ((download: BrowserDownload) => void) | undefined
  const saved: string[] = []
  let answer: BrowserDownloadSaveResult = { ok: true }
  const downloads: BrowserDownloads = {
    subscribe(next) {
      listener = next
      return () => (listener = undefined)
    },
    async save(id) {
      saved.push(id)
      return answer
    },
  }
  return {
    downloads,
    saved,
    answer: (next: BrowserDownloadSaveResult) => (answer = next),
    emit: (download: Partial<BrowserDownload> & { id: string }) =>
      listener?.({
        name: "report.txt",
        mime: "text/plain",
        bytes: 34,
        total: 34,
        state: "completed",
        sourceURL: "http://127.0.0.1:3000/",
        saved: false,
        ...download,
      }),
    subscribed: () => !!listener,
  }
}

describe("pane downloads", () => {
  test("joins the session whose tab shows the source page; the routed session is the fallback", () => {
    const shell = fakeShell()
    const routed = attachment("ses_routed", [{ id: TAB_A, url: "http://127.0.0.1:4000/" }])
    const other = attachment("ses_other", [{ id: TAB_B, url: "http://127.0.0.1:3000/" }])
    const store = createDownloadStore({ downloads: shell.downloads, candidates: () => [routed, other] })
    shell.emit({ id: "d1" })
    shell.emit({ id: "d2", sourceURL: "http://elsewhere/" })
    expect(store.list("local", "ses_other").map((entry) => [entry.download.id, entry.tabID])).toEqual([["d1", TAB_B]])
    expect(store.list("local", "ses_routed").map((entry) => [entry.download.id, entry.tabID])).toEqual([
      ["d2", undefined],
    ])
    store.dispose()
    expect(shell.subscribed()).toBe(false)
  })

  test("unsaved completed files guard the tab close until saved; a closed tab turns them removed", async () => {
    const shell = fakeShell()
    const tab = attachment("ses_1", [{ id: TAB_A, url: "http://127.0.0.1:3000/" }])
    const store = createDownloadStore({ downloads: shell.downloads, candidates: () => [tab] })
    shell.emit({ id: "d1", state: "progressing", bytes: 10 })
    expect(store.unsaved("local", "ses_1", TAB_A)).toHaveLength(0)
    shell.emit({ id: "d1" })
    expect(store.unsaved("local", "ses_1", TAB_A).map((entry) => entry.download.id)).toEqual(["d1"])
    expect(await store.save("d1")).toEqual({ ok: true })
    shell.emit({ id: "d1", saved: true })
    expect(store.unsaved("local", "ses_1", TAB_A)).toHaveLength(0)

    shell.emit({ id: "d2", name: "second.csv" })
    store.tabClosed("local", "ses_1", TAB_A)
    expect(store.list("local", "ses_1").map((entry) => entry.download.state)).toEqual(["removed", "removed"])
    // A late progress message does not bring a deleted file back.
    shell.emit({ id: "d2" })
    expect(store.list("local", "ses_1")[0]!.download.state).toBe("removed")
    expect(store.unsaved("local", "ses_1", TAB_A)).toHaveLength(0)
    store.dismiss("d1")
    expect(store.list("local", "ses_1").map((entry) => entry.download.id)).toEqual(["d2"])
  })

  test("the shell's `gone` marks the entry removed", async () => {
    const shell = fakeShell()
    const tab = attachment("ses_1", [{ id: TAB_A, url: "http://127.0.0.1:3000/" }])
    const store = createDownloadStore({ downloads: shell.downloads, candidates: () => [tab] })
    shell.emit({ id: "d1" })
    shell.answer({ ok: false, reason: "gone" })
    expect(await store.save("d1")).toEqual({ ok: false, reason: "gone" })
    expect(store.list("local", "ses_1")[0]!.download.state).toBe("removed")
    expect(shell.saved).toEqual(["d1"])
  })

  test("sizes", () => {
    expect(formatBytes(34)).toBe("34 B")
    expect(formatBytes(2_048)).toBe("2.0 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
  })
})

// Browser-pane downloads of this window (05 §8.4, 03 §18.17 "파일 목록과 PC에 저장"). The shell reports each download
// of a pane tab (host `browser.downloads`); the file lives in the shell's temp folder for the agent and is deleted
// with its tab, so the user saves it (`PC에 저장`) before closing the tab or the window.
//
// The shell knows the page that started a download, not the session: a download joins the attachment whose tab shows
// that page (the routed session first), and remembers the tab. When the tab goes away the entry turns `removed`.
import { createSignal, type Accessor } from "solid-js"
import type { SessionAttachment } from "./attachments"
import type { BrowserDownload, BrowserDownloadSaveResult, BrowserDownloads } from "./types"

export interface PaneDownload {
  readonly download: BrowserDownload
  readonly serverKey: string
  readonly sessionID: string
  readonly tabID?: string
}

export interface DownloadStore {
  /** Downloads of one session, newest first (reactive). */
  list(serverKey: string, sessionID: string): PaneDownload[]
  /** Completed downloads of a tab that were never saved: closing the tab deletes them. */
  unsaved(serverKey: string, sessionID: string, tabID: string): PaneDownload[]
  save(id: string): Promise<BrowserDownloadSaveResult>
  /** The tab closed (or left the inventory): its files are gone. */
  tabClosed(serverKey: string, sessionID: string, tabID: string): void
  dismiss(id: string): void
  dispose(): void
}

export function createDownloadStore(input: {
  readonly downloads: BrowserDownloads
  /** Attachments to place a download with, the routed session's first. */
  readonly candidates: () => readonly SessionAttachment[]
}): DownloadStore {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, PaneDownload>>(new Map())
  const dismissed = new Set<string>()
  const write = (next: PaneDownload) => {
    const map = new Map(entries())
    map.set(next.download.id, next)
    setEntries(map)
  }
  const place = (download: BrowserDownload): Omit<PaneDownload, "download"> | undefined => {
    const candidates = input.candidates()
    for (const attachment of candidates) {
      const tab = attachment.state().browser?.tabs.find((item) => item.url === download.sourceURL)
      if (tab) return { serverKey: attachment.serverKey, sessionID: attachment.sessionID, tabID: tab.id }
    }
    const first = candidates[0]
    return first ? { serverKey: first.serverKey, sessionID: first.sessionID } : undefined
  }
  const stop = input.downloads.subscribe((download) => {
    const known = entries().get(download.id)
    // A tab already closed keeps its entry removed even if a late progress message arrives.
    const state = known?.download.state === "removed" ? "removed" : download.state
    if (known) return write({ ...known, download: { ...download, state } })
    const placed = place(download)
    if (placed) write({ ...placed, download })
  })
  const mark = (match: (entry: PaneDownload) => boolean) => {
    let changed = false
    const map = new Map(entries())
    for (const [id, entry] of map) {
      if (!match(entry) || entry.download.state === "removed") continue
      map.set(id, { ...entry, download: { ...entry.download, state: "removed" } })
      changed = true
    }
    if (changed) setEntries(map)
  }
  return {
    list: (serverKey, sessionID) =>
      [...entries().values()]
        .filter(
          (entry) =>
            entry.serverKey === serverKey && entry.sessionID === sessionID && !dismissed.has(entry.download.id),
        )
        .reverse(),
    unsaved: (serverKey, sessionID, tabID) =>
      [...entries().values()].filter(
        (entry) =>
          entry.serverKey === serverKey &&
          entry.sessionID === sessionID &&
          entry.tabID === tabID &&
          entry.download.state === "completed" &&
          !entry.download.saved,
      ),
    async save(id) {
      const result = await input.downloads.save(id)
      if (!result.ok && result.reason === "gone") mark((entry) => entry.download.id === id)
      return result
    },
    tabClosed: (serverKey, sessionID, tabID) =>
      mark((entry) => entry.serverKey === serverKey && entry.sessionID === sessionID && entry.tabID === tabID),
    dismiss(id) {
      dismissed.add(id)
      setEntries(new Map(entries()))
    },
    dispose: stop,
  }
}

const [current, setCurrent] = createSignal<DownloadStore>()

/** The window's download store, or undefined on hosts whose shell reports no downloads. */
export const windowDownloads: Accessor<DownloadStore | undefined> = current

export function setWindowDownloads(value: DownloadStore | undefined) {
  setCurrent(() => value)
}

/** "34 B", "1.2 KB", "4.8 MB" (the pane caps at 5 MiB, plugin-browser rpc.ts MAX_FILE_BYTES). */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Browser-pane downloads, the user's side (05 §8.4). Upstream's browser GUI plugin keeps every download of a pane
// tab for the agent: gui-plugins/src/browser/chromium.ts `will-download` saves it into
// `%TEMP%\opencode-browser-client-<uuid>\<fileId>\<name>` (files.ts, 5 MiB cap) and the folder is deleted with the tab
// page or the attachment. Every tab page is a host embed, a child view of its window's contentView (desktop
// plugin/embeds.ts), which is how `hostWindow` finds its window. own adds, without touching that code:
//  - the owning renderer window hears about each download (name, size, state, the page that started it), so own-web
//    can list it with the session's tabs and warn before a tab with unsaved files closes;
//  - `own:browser.save-download` copies a finished one to where the user picks in the save dialog (`PC에 저장`).
//    Nothing is written to a user folder without that dialog, and the temp path never leaves main.
// A second `will-download` listener on each session sees the same item as upstream's; the save path upstream sets is
// read once the item is done. Downloads of the renderer's own page (not a pane view) are ignored.
// Split panes (03 §4.1.1, `wireBrowserViews`): a pane view is a native view the renderer cannot see into, so a click
// there never focuses the split pane around it. Each pane view's `focus` sends its window the view's bounds
// (`own:browser.view-focus`, the units the renderer laid it out in), and the pane-focus chords typed in it (F6,
// Shift+F6, Ctrl+Alt+1–4) go to the window as `own:browser.view-key` instead of the page. Same discovery as downloads:
// a web contents that is a child view of a window's content view, never the renderer page itself.
// Paired devices (05 §8.10, `wireRemoteBrowser`): the bridge that shows this PC's panes on a phone or another PC
// (remote-browser.ts) is started here with what needs Electron: the app windows it counts and the local service it
// calls. A download of a pane tab is also told to the bridge, which tells the session's viewers; the file stays here.
import { randomUUID } from "node:crypto"
import { access, copyFile } from "node:fs/promises"
import path from "node:path"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  WebContentsView,
  type DownloadItem,
  type IpcMainInvokeEvent,
  type Session,
  type View,
  type WebContents,
} from "electron"
import log from "electron-log/main.js"
import { SidecarCredentials } from "@opencode/desktop/src/main/service/sidecar-credentials"
import { isRendererUrl } from "@opencode/desktop/src/main/windows/scheme"
import {
  OwnIpc,
  type OwnBrowserDownload,
  type OwnBrowserSaveResult,
  type OwnBrowserViewBounds,
} from "../preload/own-api"
import { clientOnly } from "./client-only"
import { ownPaths } from "./own-env"
import { paneChord } from "./pane-keys"
import { startRemoteBrowser } from "./remote-browser"
import { remotePaneDownload, remotePanes } from "./remote-panes"
import { lentHost } from "./remote-surface"
import { discoverService } from "./service/discover"

interface Tracked {
  entry: { -readonly [Key in keyof OwnBrowserDownload]: OwnBrowserDownload[Key] }
  win: BrowserWindow
  path?: string
}

const downloads = new Map<string, Tracked>()
const hooked = new WeakSet<Session>()
const windows = new WeakSet<BrowserWindow>()
/** Downloads kept per window for saving; older finished ones are forgotten first. */
const LIMIT = 200

/** Registers the session hook and the save handler; call before any browser pane can register. */
export function wireBrowserDownloads() {
  app.on("session-created", hook)
  ipcMain.handle(OwnIpc.browserSaveDownload, save)
  return () => {
    app.off("session-created", hook)
    ipcMain.removeHandler(OwnIpc.browserSaveDownload)
  }
}

function hook(session: Session) {
  if (hooked.has(session)) return
  hooked.add(session)
  session.on("will-download", (_event, item, source) => {
    if (source) track(item, source)
  })
}

/** The window whose content view holds `source` as a child view (a pane tab), never the renderer page itself. */
export function hostWindow(source: WebContents, all: readonly BrowserWindow[] = BrowserWindow.getAllWindows()) {
  return hostView(source, all)?.win
}

/** The pane view showing `source` and its window. */
export function hostView(source: WebContents, all: readonly BrowserWindow[] = BrowserWindow.getAllWindows()) {
  // A tab lent to the capture window while a device watches it (remote-surface.ts) still belongs to its app window.
  const lent = lentHost(source)
  if (lent) return lent
  for (const win of all) {
    if (win.isDestroyed() || win.webContents === source) continue
    const view = holder(win.contentView, source)
    if (view) return { win, view }
  }
  return undefined
}

function holder(view: View, source: WebContents): WebContentsView | undefined {
  for (const child of view.children) {
    if (child instanceof WebContentsView && child.webContents === source) return child
    const found = holder(child, source)
    if (found) return found
  }
  return undefined
}

/** Split panes (header): pane views report focus and hand the pane chords to their window. */
export function wireBrowserViews() {
  const hook = (_event: Electron.Event, contents: WebContents) => {
    contents.on("focus", () => {
      const host = hostView(contents)
      if (!host) return
      send(host.win, OwnIpc.browserViewFocus, host.view.getBounds() satisfies OwnBrowserViewBounds)
    })
    contents.on("before-input-event", (event, input) => {
      const key = paneChord(input)
      if (!key) return
      const host = hostView(contents)
      if (!host) return
      event.preventDefault()
      send(host.win, OwnIpc.browserViewKey, key)
    })
  }
  app.on("web-contents-created", hook)
  return () => app.off("web-contents-created", hook)
}

/**
 * Starts the bridge to paired devices (header); returns the function that stops it and puts every page back. A
 * 원격 PC 전용 build has no local service and so nothing to bridge. The dev channel works the same way (its own
 * registration file).
 */
export function wireRemoteBrowser() {
  if (clientOnly) return () => undefined
  const logger = log.scope("own")
  const bridge = startRemoteBrowser({
    // The registration is read again after every failure: a restarted service has a new password.
    service: async () => {
      const paths = ownPaths()
      const service = await discoverService(paths.registration)
      return service?.authorization
        ? { url: service.url, authorization: service.authorization, control: paths.control }
        : undefined
    },
    panes: remotePanes,
    // The app's own windows, hidden to the tray or minimized ones too; 원격 PC and preview windows hold no pane.
    windows: () =>
      BrowserWindow.getAllWindows().filter(
        (win) => !win.isDestroyed() && !win.webContents.isDestroyed() && isRendererUrl(win.webContents.getURL()),
      ).length,
    chrome: process.versions.chrome,
    log: (level, message, data) => logger[level](message, data ?? {}),
  })
  // The shell found its service (again): no need to wait out the bridge's own retry.
  const off = SidecarCredentials.onChange(bridge.wake)
  return () => {
    off()
    void bridge.stop()
  }
}

function send(win: BrowserWindow, channel: string, value: unknown) {
  const contents = win.isDestroyed() ? undefined : win.webContents
  if (!contents || contents.isDestroyed()) return
  contents.send(channel, value)
}

function track(item: DownloadItem, source: WebContents) {
  const win = hostWindow(source)
  if (!win) return
  // A device watching this session hears that a file waits on the PC (05 §8.10); nothing of it is sent.
  remotePaneDownload(source)
  const tracked: Tracked = {
    win,
    entry: {
      id: randomUUID(),
      name: item.getFilename(),
      mime: item.getMimeType() || "application/octet-stream",
      bytes: 0,
      total: item.getTotalBytes(),
      state: "progressing",
      sourceURL: source.isDestroyed() ? "" : source.getURL(),
      saved: false,
    },
  }
  remember(tracked)
  publish(tracked)
  let sent = 0
  item.on("updated", () => {
    tracked.entry.bytes = item.getReceivedBytes()
    const now = Date.now()
    if (now - sent < 250) return
    sent = now
    publish(tracked)
  })
  item.once("done", (_event, state) => {
    tracked.entry.bytes = item.getReceivedBytes()
    tracked.entry.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed"
    // Set by upstream's listener (browser/files.ts path under the tab's temp folder).
    tracked.path = item.getSavePath() || undefined
    publish(tracked)
  })
}

function remember(tracked: Tracked) {
  downloads.set(tracked.entry.id, tracked)
  if (!windows.has(tracked.win)) {
    windows.add(tracked.win)
    tracked.win.once("closed", () => {
      for (const [id, value] of downloads) if (value.win === tracked.win) downloads.delete(id)
    })
  }
  const mine = [...downloads.values()].filter((value) => value.win === tracked.win)
  for (const old of mine.slice(0, Math.max(0, mine.length - LIMIT))) downloads.delete(old.entry.id)
}

function publish(tracked: Tracked) {
  const contents = tracked.win.isDestroyed() ? undefined : tracked.win.webContents
  if (!contents || contents.isDestroyed()) return
  contents.send(OwnIpc.browserDownload, { ...tracked.entry } satisfies OwnBrowserDownload)
}

async function save(event: IpcMainInvokeEvent, input: unknown): Promise<OwnBrowserSaveResult> {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || !isRendererUrl(frame.url)) throw new Error("own IPC: not the renderer")
  const id =
    typeof input === "object" && input !== null && typeof (input as { id?: unknown }).id === "string"
      ? (input as { id: string }).id
      : ""
  const tracked = downloads.get(id)
  // Owner check: only the window that holds the tab may save its download.
  if (!tracked || tracked.win.isDestroyed() || tracked.win.webContents !== event.sender)
    return { ok: false, reason: "unknown" }
  if (tracked.entry.state === "removed") return { ok: false, reason: "gone" }
  if (tracked.entry.state !== "completed" || !tracked.path) return { ok: false, reason: "incomplete" }
  const source = tracked.path
  if (!(await exists(source))) {
    tracked.entry.state = "removed"
    publish(tracked)
    return { ok: false, reason: "gone" }
  }
  const choice = await dialog.showSaveDialog(tracked.win, {
    defaultPath: path.join(app.getPath("downloads"), safeName(tracked.entry.name)),
  })
  if (choice.canceled || !choice.filePath) return { ok: false, reason: "canceled" }
  try {
    await copyFile(source, choice.filePath)
  } catch {
    // The tab may have closed while the dialog was open.
    if (!(await exists(source))) {
      tracked.entry.state = "removed"
      publish(tracked)
      return { ok: false, reason: "gone" }
    }
    return { ok: false, reason: "failed" }
  }
  tracked.entry.saved = true
  publish(tracked)
  return { ok: true }
}

/** A file name for the dialog's default path: no folders, no characters Windows refuses. */
export function safeName(name: string) {
  const base = path
    .basename(name.replaceAll("\\", "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
  return base && base !== "." && base !== ".." ? base.slice(0, 200) : "download"
}

async function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  )
}

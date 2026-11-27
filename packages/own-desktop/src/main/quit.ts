// 05 §7.3 tray and quit (TQ): the notification-area icon, what the last app window's X does (트레이로 숨기기 by default,
// 앱 종료 from 설정 > 데스크톱 앱), 앱 종료 (the shell only: the service keeps serving phones, other PCs and running
// conversations) and 완전 종료 (asks, stops this PC's service through its launcher, `own.ps1 stop --force`, then quits).
// The tray menu, own-web's buttons, its palette and Ctrl+Q all end here; quit-model.ts decides, this file acts.
// Loaded with desktop.ts after the first window (windows-own.ts, the tray); own-shell.ts's IPC handlers import it on
// first use. Windows sign-out and shutdown are never held: windows-own.ts lets every close through once `session-end`
// or `before-quit` came, and the tray asks nothing of them.
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { app, BrowserWindow, dialog, Menu, nativeImage, screen, Tray, type Display, type WebContents } from "electron"
import log from "electron-log/main.js"
import { Option, Schema } from "effect"
import { getStore } from "@opencode/desktop/src/main/storage/store"
import { getLastFocusedWindow, getMainWindows } from "@opencode/desktop/src/main/windows"
import type { OwnCloseAction } from "../preload/own-api"
import { PRODUCT_NAME } from "../shared/identity"
import { readManifest } from "./manifest"
import { ownPaths } from "./own-env"
import { clientOnly } from "./client-only"
import {
  CLIENT_TRAY_MENU,
  closeAction as closeActionOf,
  closeOutcome,
  fullQuitPrompt,
  stopFailedPrompt,
  TRAY_HINT,
  TRAY_MENU,
  trayIconSize,
  trayIconSource,
  trayToolTip,
  type QuitChoice,
  type QuitPrompt,
} from "./quit-model"
import { discoverService, type DiscoveredService } from "./service/discover"
import { exclusive, holdStarts, launcherCommand, runLauncher, STOP_TIMEOUT_MS, stopResult } from "./service/launcher"

const logger = log.scope("own")
/** Main's settings store (userData\opencode.settings), next to upstream's keys. */
const CLOSE_ACTION_KEY = "ownCloseAction"
const TRAY_HINT_KEY = "ownTrayHintShown"
const TOOLTIP_REFRESH_MS = 2_000

let tray: Tray | undefined
let fullQuit: Promise<boolean> | undefined
/**
 * App windows this file sent to the tray. A minimized window is on the taskbar although Electron's isVisible() says
 * false for it on Windows, and one hidden while minimized still says isMinimized(): only this set tells them apart.
 */
const inTray = new WeakSet<BrowserWindow>()
const onTaskbar = (win: BrowserWindow) => win.isVisible() || (win.isMinimized() && !inTray.has(win))

export function closeAction(): OwnCloseAction {
  return closeActionOf(getStore().get(CLOSE_ACTION_KEY))
}

/** windows-own.ts, on every window close while the app is not quitting. */
export function hidesToTray(win: BrowserWindow) {
  const mains = getMainWindows()
  return (
    closeOutcome({
      action: closeAction(),
      main: mains.includes(win),
      // The taskbar's 창 닫기 on a minimized last window goes to the tray too; it quit the app before (2026-11-20).
      visible: onTaskbar(win),
      otherVisibleMain: mains.some((other) => other !== win && onTaskbar(other)),
    }) === "hide"
  )
}

/** After the last window went to the tray: the hint, once per profile (a balloon Windows shows as a notification). */
export function hiddenToTray(win: BrowserWindow) {
  inTray.add(win)
  win.once("show", () => inTray.delete(win))
  logger.info("window hidden to the tray", { minimized: win.isMinimized() })
  const store = getStore()
  if (!tray || store.get(TRAY_HINT_KEY) === true) return
  store.set(TRAY_HINT_KEY, true)
  tray.displayBalloon({
    title: PRODUCT_NAME,
    content: TRAY_HINT,
    iconType: "info",
    noSound: true,
    respectQuietTime: true,
  })
}

/** 앱 종료: the shell only. before-quit lets every window close and unload without asking (windows-own.ts). */
export function quitApp() {
  logger.info("quit: app (the service keeps running)")
  app.quit()
}

/** 완전 종료: one at a time; `false` when nothing closed. */
export function quitAll(parent?: BrowserWindow) {
  fullQuit ??= quitEverything(parent).finally(() => (fullQuit = undefined))
  return fullQuit
}

/** `own:app.quit` from own-web: `{mode: "app" | "all"}`. */
export function quitFromRenderer(sender: WebContents, input: unknown) {
  const mode = typeof input === "object" && input !== null && "mode" in input ? input.mode : undefined
  if (mode === "all") return quitAll(BrowserWindow.fromWebContents(sender) ?? undefined)
  if (mode !== "app") return Promise.resolve(false)
  quitApp()
  return Promise.resolve(true)
}

/** `own:app.close-action` from own-web: `{action?}`; sets it when given, answers the current one. */
export function closeActionFromRenderer(input: unknown) {
  const action = typeof input === "object" && input !== null && "action" in input ? input.action : undefined
  if (action !== undefined) getStore().set(CLOSE_ACTION_KEY, closeActionOf(action))
  return closeAction()
}

/**
 * The tray icon with its menu, for the app's whole run (desktop.ts; disposed at will-quit so no icon is left behind).
 * Click and double-click both open the app window (Windows apps open on a single click; the double-click's second
 * press then finds it open). A start of the app while it sits in the tray shows that window too.
 */
export function wireTray(createWindow: () => BrowserWindow) {
  const created = new Tray(trayImage())
  tray = created
  const open = () => openAppWindow(createWindow)
  const actions = { open, quitApp, quitAll: () => void quitAll() }
  created.setToolTip(trayToolTip())
  created.setContextMenu(
    Menu.buildFromTemplate(
      (clientOnly ? CLIENT_TRAY_MENU : TRAY_MENU).map((item) =>
        "separator" in item ? { type: "separator" as const } : { label: item.label, click: actions[item.action] },
      ),
    ),
  )
  created.on("click", open)
  created.on("double-click", open)
  let refreshedAt = 0
  const refresh = () => {
    if (Date.now() - refreshedAt < TOOLTIP_REFRESH_MS) return
    refreshedAt = Date.now()
    void serviceState().then((state) => {
      if (!created.isDestroyed()) created.setToolTip(trayToolTip(state))
    })
  }
  created.on("mouse-enter", refresh)
  created.on("right-click", refresh)
  refresh()
  // Upstream's second-instance handler shows the last focused window when it knows one; this covers the rest.
  const secondInstance = () => {
    if (!getMainWindows().some((win) => win.isVisible())) open()
  }
  const rescale = (_event: unknown, display: Display, changed: string[]) => {
    if (changed.includes("scaleFactor") && display.id === screen.getPrimaryDisplay().id) created.setImage(trayImage())
  }
  app.on("second-instance", secondInstance)
  screen.on("display-metrics-changed", rescale)
  logger.info("tray ready", { size: trayIconSize(screen.getPrimaryDisplay().scaleFactor), action: closeAction() })
  return () => {
    app.off("second-instance", secondInstance)
    screen.off("display-metrics-changed", rescale)
    if (tray === created) tray = undefined
    created.destroy()
  }
}

/** The last focused app window (or another one), shown and focused; a new one when none is left. */
function openAppWindow(createWindow: () => BrowserWindow) {
  const windows = getMainWindows()
  const last = getLastFocusedWindow()
  const win = last && windows.includes(last) ? last : windows.at(-1)
  // A new window shows itself once its renderer has painted (upstream windows/index.ts reveal).
  if (!win) return void createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * The app icon at exactly the notification area's size for the primary display (quit-model.ts trayIconSize), scaled
 * down from the icon set's PNG. app.getAppPath() is the package folder unpackaged and app.asar packaged; Electron's
 * fs reads inside the archive.
 */
function trayImage() {
  const size = trayIconSize(screen.getPrimaryDisplay().scaleFactor)
  const file = path.join(app.getAppPath(), "resources", "icons", trayIconSource(size))
  const image = existsSync(file) ? nativeImage.createFromBuffer(readFileSync(file)) : nativeImage.createEmpty()
  if (image.isEmpty()) logger.warn("tray icon missing", { file })
  return image.isEmpty() ? image : image.resize({ width: size, height: size, quality: "best" })
}

async function quitEverything(parent?: BrowserWindow) {
  // 원격 PC 전용 build: this PC runs no service to stop.
  if (clientOnly) {
    quitApp()
    return true
  }
  const paths = ownPaths()
  const service = await discoverService(paths.registration)
  const [manifest, active, remote] = await Promise.all([
    readManifest(paths.manifest),
    service ? activeSessions(service) : undefined,
    remoteAccess(paths.ownHome),
  ])
  const prompt = fullQuitPrompt({
    channel: paths.channel,
    running: !!service,
    missingLauncher: existsSync(paths.launcher) ? undefined : paths.launcher,
    version: service?.version,
    installed: manifest?.version,
    active,
    remote,
  })
  logger.info("quit: full", { running: !!service, active, remote, prompt: prompt.kind })
  if (prompt.kind === "quit") {
    quitApp()
    return true
  }
  const choice = await ask(parent, prompt)
  logger.info("quit: full answered", { choice })
  if (choice === "cancel") return false
  if (choice === "app") {
    quitApp()
    return true
  }
  // The windows go first, so the app looks closed while the launcher works; a failed stop brings them back.
  const shown = getMainWindows().filter((win) => win.isVisible())
  shown.forEach((win) => win.hide())
  holdStarts(true)
  const command = launcherCommand(paths, "stop", ["--force"])
  logger.info("launcher stop --force", { file: command.file, args: command.args })
  const ran = await exclusive(() => runLauncher(command, { timeoutMs: STOP_TIMEOUT_MS }))
  logger.info("launcher stop finished", { code: ran.code, timedOut: ran.timedOut })
  const result = stopResult(ran)
  if (result.ok) {
    quitApp()
    return true
  }
  holdStarts(false)
  shown.forEach((win) => {
    if (!win.isDestroyed()) win.show()
  })
  if ((await ask(shown[0] ?? parent, stopFailedPrompt(result.detail))) !== "app") return false
  quitApp()
  return true
}

async function ask(parent: BrowserWindow | undefined, prompt: QuitPrompt): Promise<QuitChoice> {
  const answer = testAnswer(prompt)
  if (answer) return answer
  const options = {
    type: prompt.type,
    title: PRODUCT_NAME,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [...prompt.buttons],
    defaultId: prompt.cancelId,
    cancelId: prompt.cancelId,
    noLink: true,
  }
  // From the tray every window may be hidden: a dialog owned by a hidden window would not show.
  const owner = parent && !parent.isDestroyed() && parent.isVisible() ? parent : undefined
  const { response } = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
  return prompt.choices[response] ?? "cancel"
}

/**
 * Automated runs of the development shell (own-shell.ts OWN_DESKTOP_TEST_RUN, scripts/tray-quit.ts): Windows keeps a
 * message box on a monitor even when its window is off the screen, so the run names the button in a file instead and
 * the prompt goes to the log. Never in a packaged build.
 */
function testAnswer(prompt: QuitPrompt): QuitChoice | undefined {
  const file = process.env.OWN_DESKTOP_TEST_ANSWER
  if (app.isPackaged || !process.env.OWN_DESKTOP_TEST_RUN || !file) return undefined
  const label = existsSync(file) ? readFileSync(file, "utf8").trim() : ""
  logger.info("quit: test answer", { message: prompt.message, detail: prompt.detail, buttons: prompt.buttons, label })
  const index = prompt.buttons.indexOf(label)
  return index < 0 ? "cancel" : prompt.choices[index]
}

/** The tooltip's state: running or not, and the running conversations when the service answered. */
async function serviceState() {
  if (clientOnly) return undefined
  const service = await discoverService(ownPaths().registration).catch(() => undefined)
  if (!service) return { running: false }
  return { running: true, active: await activeSessions(service) }
}

const decodeActive = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })),
)

/** `GET /api/session/active`, the count the launcher's Confirm-Stop asks about; undefined when it did not answer. */
async function activeSessions(service: DiscoveredService) {
  if (!service.authorization) return undefined
  const url = new URL("/api/session/active", service.url)
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
  const response = await fetch(url, {
    headers: { authorization: service.authorization },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const active = Option.getOrUndefined(decodeActive(await response.text().catch(() => "")))
  return active ? Object.keys(active.data).length : undefined
}

/** Remote access settings (own-remote gateway/config.ts): the gateway and the pinned app listener. */
const decodeGateway = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      enabled: Schema.optional(Schema.Unknown),
      app: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Unknown) })),
    }),
  ),
)

/** OWN_HOME\gateway.json: the gateway or the app listener is on, so phones or other PCs may be connected. */
async function remoteAccess(ownHome: string) {
  const text = await readFile(path.join(ownHome, "gateway.json"), "utf8").catch(() => "")
  const settings = Option.getOrUndefined(decodeGateway(text))
  return settings?.enabled === true || settings?.app?.enabled === true
}

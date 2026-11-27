// Renderer-window behavior own-desktop adds on top of upstream's windows (loaded with desktop.ts, after the first
// window). Upstream has neither.
//  - 05 §7.2 close confirmation. own-web raises a close guard only while a running session in the window holds a
//    browser attachment with tabs (`window.own.browser.guardClose`), and registers `beforeunload` for the same time.
//    A window close (X, Alt+F4, WM_CLOSE) is held at the window's `close` event while the guard is up and asked
//    without blocking main; [창 닫기] closes the window again, then without asking. Holding it there matters: a close
//    that reaches the page's beforeunload starts Electron's 5 s close timer, which a cancelled beforeunload does not
//    stop, so the window is reported unresponsive and upstream's recovery shows "not responding"
//    (windows/recovery.ts) although nothing hangs.
//    Unloads that are not window closes (own-web's own reloads, or a close whose guard message had not arrived yet)
//    reach `will-prevent-unload`, where Electron cancels them silently: main asks synchronously and lets them proceed
//    on [계속].
//    App quit (`before-quit`) and Windows log-off (`session-end`) are never asked: the unload just proceeds.
//  - 05 §7.3 tray: with 트레이로 숨기기 (the default) the close of the last visible app window hides it instead
//    (quit.ts hidesToTray), before the guard is looked at: a hidden window unloads nothing. After before-quit or
//    session-end every close goes through, so a quit, a sign-out or a shutdown is never held by the tray.
//  - 05 §5.5 manifest re-check: every top-frame navigation of a renderer window re-reads the installed version's
//    manifest.json (app\current.json → app\<version>) and logs a hash that no longer matches this shell. The page
//    itself comes from that version's web (renderer-protocol.ts follows the pointer on every page load); own-web's
//    own T0-0 check shows the mismatch screen.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type WebContents } from "electron"
import log from "electron-log/main.js"
import { Effect } from "effect"
import { isRendererUrl } from "@opencode/desktop/src/main/windows/scheme"
import { OwnIpc } from "../preload/own-api"
import { readManifest } from "./manifest"
import { ownPaths } from "./own-env"
import { hiddenToTray, hidesToTray } from "./quit"

const logger = log.scope("own")
const MESSAGE = "에이전트가 브라우저를 쓰는 중이에요."
const DETAIL = "브라우저 탭이 닫히고 브라우저 동작은 실패해요. 턴 자체는 계속돼요."
let quitting = false
const quit = () => {
  quitting = true
}
/** Close guard per renderer page (own-web's `guardClose`); a new document starts without one. */
const guards = new WeakMap<WebContents, boolean>()

function guardClose(event: IpcMainEvent, on: unknown) {
  const frame = event.senderFrame
  // The renderer's own top frame only (browser-pane tabs have another partition and no preload).
  if (!frame || frame.parent !== null || !isRendererUrl(frame.url)) return
  guards.set(event.sender, on === true)
}

export const wireRendererWindows = Effect.gen(function* () {
  const runFork = Effect.runForkWith(yield* Effect.context())
  const recheck = () =>
    runFork(
      Effect.promise(() => readManifest(ownPaths().manifest)).pipe(
        Effect.flatMap((manifest) =>
          manifest && manifest.rpcHash !== import.meta.env.OWN_RPC_HASH
            ? Effect.logWarning("own: installed UI no longer matches this shell", {
                shell: import.meta.env.OWN_RPC_HASH,
                installed: manifest.rpcHash,
                version: manifest.version,
              })
            : Effect.void,
        ),
      ),
    )
  const wire = (_event: unknown, win: BrowserWindow) => {
    const contents = win.webContents
    // Windows log-off reaches windows as `session-end` without `before-quit`.
    win.on("session-end", quit)
    let confirmed = false
    let asking = false
    win.on("close", (event) => {
      if (quitting || confirmed) return
      // 7.3: the last app window's X goes to the tray. Nothing unloads, so the turn's browser tabs stay and the close
      // guard has nothing to ask.
      if (hidesToTray(win)) {
        event.preventDefault()
        win.hide()
        hiddenToTray(win)
        return
      }
      if (!guards.get(contents)) return
      event.preventDefault()
      if (asking) return
      asking = true
      logger.info("close confirmation")
      void dialog
        .showMessageBox(win, {
          type: "warning",
          title: "Own OpenCode",
          message: MESSAGE,
          detail: `창을 닫으면 ${DETAIL}`,
          buttons: ["창 닫기", "취소"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then(({ response }) => {
          asking = false
          logger.info("close confirmation answered", { close: response === 0 })
          if (response !== 0 || win.isDestroyed()) return
          confirmed = true
          win.close()
        })
        .catch(() => {
          asking = false
        })
    })
    contents.on("will-prevent-unload", (event) => {
      if (!isRendererUrl(contents.getURL())) return
      // Quitting, logging off, or a close the user already confirmed: let the unload proceed without asking.
      if (quitting || confirmed) return event.preventDefault()
      logger.info("unload confirmation")
      const choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        title: "Own OpenCode",
        message: MESSAGE,
        detail: `계속하면 ${DETAIL}`,
        buttons: ["계속", "취소"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      if (choice === 0) event.preventDefault()
    })
    contents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument || !isRendererUrl(details.url)) return
      // A new document raises its own guard when it needs one.
      guards.delete(contents)
      recheck()
    })
  }
  // App quit and Windows log-off are not confirmed (7.2): a dialog must not block them.
  yield* Effect.sync(() => {
    app.on("before-quit", quit)
    app.on("browser-window-created", wire)
    ipcMain.on(OwnIpc.browserCloseGuard, guardClose)
    BrowserWindow.getAllWindows().forEach((win) => wire(undefined, win))
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      app.off("before-quit", quit)
      app.off("browser-window-created", wire)
      ipcMain.off(OwnIpc.browserCloseGuard, guardClose)
    }),
  )
})

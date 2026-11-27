// Substitutes packages/desktop/src/main/ipc-handlers/files.ts @ 698800f59c (MIT). See own/ledger/vendored.yaml
// Swapped in at build time for main/ipc.ts's import (electron.vite.config.ts, 05 §4.3); keeps the single export.
// own:
//  - FilesOpenDirectoryPicker (`폴더 열기…`, 03 §18.3): upstream opens the folder dialog without an owner window, so
//    the app window stays live while it is up — every click and Ctrl+O opens another dialog, and a click on the window
//    hides the dialog behind it. Here the dialog is modal to the window that asked (Windows disables the owner and
//    keeps the dialog above it), and a window gets one folder dialog at a time: a request while one is open, or
//    still appearing (Windows takes ~2.5 s to show it), shares that dialog's answer.
//  - Upstream modules by package path. Everything else is upstream's text.
import { existsSync } from "node:fs"
import { app, BrowserWindow, dialog } from "electron"
import { Effect } from "effect"
import { DesktopFiles, openExternalURL } from "@opencode/desktop/src/main/files"
import { pickerStarts } from "@opencode/desktop/src/main/files/picker-start"
import { sender } from "@opencode/desktop/src/main/ipc-handlers/context"
import { IpcPortHandoff } from "@opencode/desktop/src/main/ipc-transport"
import { nativeT } from "@opencode/desktop/src/main/native/translations"
import type { DirectoryPickerOptions } from "@opencode/desktop/src/shared/ipc-contract"
import { FileRpcs } from "@opencode/desktop/src/shared/ipc-rpc"

export const fileHandlers = FileRpcs.toLayer(
  Effect.gen(function* () {
    const files = yield* DesktopFiles.Service
    const handoff = yield* IpcPortHandoff
    // own: the open folder dialog of each window (webContents id).
    const folderDialogs = new Map<number, Promise<string | string[] | null>>()

    return FileRpcs.of({
      // own: modal to the asking window, one per window.
      FilesOpenDirectoryPicker: ({ options }, context) =>
        Effect.promise(() => {
          const contents = sender(handoff, context)
          const open = folderDialogs.get(contents.id)
          if (open) return open
          const opened = openDirectoryDialog(BrowserWindow.fromWebContents(contents), options).finally(() =>
            folderDialogs.delete(contents.id),
          )
          folderDialogs.set(contents.id, opened)
          return opened
        }),
      FilesOpenFilePicker: ({ options }, context) =>
        files
          .openFilePicker(
            sender(handoff, context).id,
            options ? { ...options, extensions: options.extensions && [...options.extensions] } : undefined,
          )
          .pipe(Effect.orDie),
      FilesReadPickedFile: ({ token, path }, context) =>
        files.readPickedFile(sender(handoff, context).id, token, path).pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.orDie,
        ),
      FilesReleasePickedFiles: ({ token }, context) =>
        Effect.sync(() => files.releasePickedFiles(sender(handoff, context).id, token)),
      FilesSaveFile: ({ options, content }) => files.saveFile(options, content).pipe(Effect.orDie),
      FilesOpenExternal: ({ url }) => openExternalURL(url).pipe(Effect.asVoid),
      FilesOpenBrowser: ({ url }) => (/^https?:/i.test(url) ? openExternalURL(url) : Effect.succeed(false)),
      FilesOpenPath: ({ path, application }) =>
        files.openPath(path, application).pipe(
          Effect.map((result) => result ?? null),
          Effect.orDie,
        ),
      FilesRevealPath: ({ path }) => files.revealPath(path),
      FilesStartDrag: ({ path }, context) => files.startDrag(sender(handoff, context), path),
      FilesReadClipboardImage: () => files.readClipboardImage(),
      FilesWriteClipboardText: ({ text }) => files.writeClipboardText(text),
    })
  }),
)

/** own: upstream DesktopFiles.openDirectoryPicker (main/files/index.ts) with the asking window as the owner. */
async function openDirectoryDialog(owner: BrowserWindow | null, options?: DirectoryPickerOptions) {
  const properties: ("openDirectory" | "multiSelections" | "createDirectory")[] = [
    "openDirectory",
    ...(options?.multiple ? ["multiSelections" as const] : []),
    "createDirectory",
  ]
  const settings = {
    properties,
    title: options?.title ?? nativeT("desktop.dialog.chooseFolder"),
    // Upstream's start (main/files/index.ts `start`): the first that exists, so Windows never opens at a missing folder.
    defaultPath: pickerStarts(options?.defaultPath, app.getPath("home"), false).find((candidate) =>
      existsSync(candidate.check),
    )?.use,
  }
  const result = await (owner ? dialog.showOpenDialog(owner, settings) : dialog.showOpenDialog(settings))
  if (result.canceled) return null
  return options?.multiple ? result.filePaths : (result.filePaths[0] ?? null)
}

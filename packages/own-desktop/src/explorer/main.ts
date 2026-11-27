// Main entry of the `explorer` built-in (overrides/gui-plugins.ts): Electron and the service behind main/explorer.ts.
import { dialog, shell } from "electron"
import { getStore } from "@opencode/desktop/src/main/storage/store"
import type { MainSetup } from "../../../plugin/src/gui/plugin"
import { createExplorer, EXPLORER_KEY, launchDetached, pathKind, serviceRoots } from "../main/explorer"
import { Explorer } from "./ipc"

const setup: MainSetup = (ctx) => {
  const explorer = createExplorer({
    roots: () => serviceRoots(ctx.serverEndpoints.get("sidecar")),
    kind: pathKind,
    openFolder: (folder) => shell.openPath(folder),
    showItem: (file) => shell.showItemInFolder(file),
    launch: (program, args) => launchDetached(program, args),
    async pick(window, current) {
      const owner = ctx.windows.get(window)
      const options = {
        title: "SSH 파일 탐색기 프로그램 고르기",
        defaultPath: current,
        properties: ["openFile" as const],
        filters: [{ name: "프로그램", extensions: ["exe"] }],
      }
      // Modal to the window that asked, like the folder dialog (overrides/ipc-files.ts).
      const result = await (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options))
      return result.canceled ? undefined : result.filePaths[0]
    },
    read: () => getStore().get(EXPLORER_KEY),
    write: (value) => getStore().set(EXPLORER_KEY, { ...value }),
    log: (message, data) => ctx.log.write("info", message, data),
  })
  ctx.provide(Explorer, {
    reveal: (input) => explorer.reveal(input.path),
    launch: (input) => explorer.launch(input),
    program: () => explorer.program(),
    pick: (_input, caller) => explorer.pick(caller.window),
    template: (input) => explorer.setTemplate(input.template),
    clear: () => explorer.clear(),
  })
}

export default setup

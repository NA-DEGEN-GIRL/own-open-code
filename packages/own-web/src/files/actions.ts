// `에디터에서 열기` / `탐색기에서 보기` for files of one session folder (03 §19.5), as a hook the files tab and the review
// header (18.5 "파일마다 … `에디터에서 열기`") share. Which actions exist is editor.ts `fileActions`: the host's
// capabilities for this server (servers/capabilities.ts turns local-only ones off for SSH servers), the connection's
// auth and the SSH host's ssh config alias. Paths are in the paths.ts form (relative to the folder, `/`).
import { createMemo } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { explorerEntries } from "@/explorer"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { remoteStore } from "@/servers/active"
import { serverCapabilities } from "@/servers/capabilities"
import { editorPreference, fileActions } from "./editor"
import { absolutePath } from "./paths"

export function createFileActions(input: {
  readonly serverKey: () => ServerKey
  readonly directory: () => string | undefined
}) {
  const data = useData()
  const host = useHost()
  const i18n = useI18n()
  const ssh = () => data.get(input.serverKey())?.kind === "ssh"
  const available = createMemo(() => {
    const runtime = data.get(input.serverKey())
    const server = runtime?.kind === "ssh" ? "ssh" : "local"
    return fileActions({
      capabilities: serverCapabilities(host.capabilities, runtime),
      server,
      auth: runtime?.entry()?.auth,
      openPath: Boolean(host.files?.openPath),
      revealPath: Boolean(host.files?.revealPath),
      alias: server === "ssh" ? remoteStore()?.host(input.serverKey())?.alias : undefined,
      explorer: explorerEntries() !== undefined,
    })
  })
  const absolute = (path: string) => {
    const folder = input.directory()
    return folder ? absolutePath(folder, path) : path
  }
  return {
    available,
    /** Native absolute path (Explorer, clipboard, editors). */
    absolute,
    /** Desktop, local server: the host opens the file in the chosen editor (else the OS default app). */
    async openInEditor(path: string) {
      const openPath = host.files?.openPath
      if (available().open?.kind !== "app" || !openPath) return
      const target = absolute(path)
      await openPath(target, editorPreference.get()).catch(() => openPath(target))
    },
    /** The `vscode://` link where the host cannot open files itself; `undefined` otherwise. */
    editorUrl(path: string, line?: number) {
      const open = available().open
      return open?.kind === "url" ? open.url(absolute(path), line) : undefined
    },
    /**
     * `탐색기에서 보기`: a folder opens, a file is shown selected in its folder. Through `host.explorer` where the host
     * has it (it reports its own failures as toasts and covers SSH servers), else the host's plain reveal.
     */
    async reveal(path: string) {
      if (!available().reveal) return
      const explorer = explorerEntries()
      if (explorer)
        return explorer.open({ ssh: ssh(), serverKey: input.serverKey(), path: absolute(path) }, i18n.locale())
      await host.files?.revealPath?.(absolute(path))
    },
  }
}

export type FileActions = ReturnType<typeof createFileActions>

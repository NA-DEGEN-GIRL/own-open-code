// The one mount point of the folder flow (03 §18.3). The shell mounts `<ProjectOpenerLayer />` once; entry points call
// `openProject()` (or the sidebar passes its own controller). The picker is a lazy chunk (20.2 R5): nothing of it is in
// the first chunk, and it is created only when the dialog opens.
import { createEffect, lazy, onCleanup, Show, Suspense } from "solid-js"
import { Portal } from "solid-js/web"
import { useData } from "@/data"
import { useHost } from "@/host"
import { useShortcut } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { openRemoteDialog } from "@/servers/active"
import { showToast } from "@/switcher/toast"
import { activeServer, followWorkspaceRoute } from "./active"
import { createProjectOpener, registerProjectOpener, type ProjectOpener } from "./opener"
import { useProjectsText } from "./strings"

/** Starts loading the picker chunk ahead of a click (hover, focus), so the dialog opens without a wait. */
export const preloadProjectPicker = () => import("./picker")

const ProjectPicker = lazy(preloadProjectPicker)

export function ProjectOpenerLayer(props: {
  readonly opener?: ProjectOpener
  /** Registers Ctrl+O (`folder.open`); off when another component already does. */
  readonly shortcut?: boolean
}) {
  const data = useData()
  const host = useHost()
  const router = useRouter()
  const text = useProjectsText()
  const opener =
    props.opener ??
    createProjectOpener({
      host,
      router,
      runtime: (serverKey) => (serverKey ? data.get(serverKey) : data.local()),
      onError: () => showToast({ message: text("own.project.dialogFailed"), tone: "danger" }),
    })
  onCleanup(registerProjectOpener(opener))
  followWorkspaceRoute(router)
  if (props.shortcut !== false) useShortcut("folder.open", () => opener.open(activeServer(data, router.route())))
  // An SSH host's folders come from the remote picker (04 §12.4, §17.4: realpath before the Location is made).
  const isRemote = (serverKey: string) => data.get(serverKey)?.kind === "ssh"
  createEffect(() => {
    const request = opener.dialog()
    if (!request || !isRemote(request.serverKey)) return
    opener.close()
    openRemoteDialog({ kind: "picker", hostId: request.serverKey })
  })
  return (
    <Show when={opener.dialog()}>
      {(request) => (
        <Show when={!isRemote(request().serverKey) && data.get(request().serverKey)}>
          {(runtime) => (
            <Portal>
              <Suspense>
                <ProjectPicker
                  runtime={runtime()}
                  initial={request().initial}
                  purpose={request().pick?.purpose}
                  attention={opener.attention}
                  onClose={() => opener.close()}
                  onStart={(project) => opener.start(project)}
                />
              </Suspense>
            </Portal>
          )}
        </Show>
      )}
    </Show>
  )
}

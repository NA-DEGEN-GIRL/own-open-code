// The one mount point of 원격 PC (08 §4.1), placed by the shell once: in a host with `capabilities.remotePcs` it
// creates this window's RemotePcStore and loads the dialog chunk (lazy, 03 §20.2 R5) only when a dialog is requested.
import { lazy, onCleanup, Show, Suspense } from "solid-js"
import { useHost } from "@/host"
import { registerRemotePcStore, remotePcDialog } from "./active"
import { createRemotePcStore } from "./store"

const RemotePcDialogs = lazy(() => import("./dialogs"))

export function RemotePcLayer() {
  const host = useHost()
  const api = host.capabilities.remotePcs ? host.remotePcs : undefined
  if (!api) return null
  const store = createRemotePcStore(api)
  onCleanup(registerRemotePcStore(store))
  onCleanup(() => store.dispose())
  return (
    <Show when={remotePcDialog()}>
      <Suspense>
        <RemotePcDialogs store={store} />
      </Suspense>
    </Show>
  )
}

// The one mount point of SSH remote support (04 §12, §17), placed by the shell once: creates this window's
// RemoteStore, and loads the dialog chunk (src/remote, lazy, 03 §20.2 R5) only when a dialog is requested or this
// tab owns a prompt (askpass: password, passphrase, host key, 04 §17.6).
import { lazy, onCleanup, Show, Suspense } from "solid-js"
import { useData } from "@/data"
import { registerRemoteStore, remoteDialog } from "./active"
import { createRemoteStore } from "./store"

const RemoteDialogs = lazy(() => import("@/remote/dialogs"))

export function RemoteLayer() {
  const data = useData()
  const store = createRemoteStore({ data })
  onCleanup(registerRemoteStore(store))
  onCleanup(() => store.dispose())
  // A host switched on or off on the Claude card writes accounts.json (04 §8.11.4.1): its relay verdict moved.
  onCleanup(data.local().own.on("accounts.changed", () => void store.refreshBroker()))
  const ownedPrompt = () =>
    Object.values(store.state.prompts).some((prompt) => prompt && prompt.ownerClientId === store.clientId)
  return (
    <Show when={remoteDialog() || ownedPrompt()}>
      <Suspense>
        <RemoteDialogs store={store} />
      </Suspense>
    </Show>
  )
}

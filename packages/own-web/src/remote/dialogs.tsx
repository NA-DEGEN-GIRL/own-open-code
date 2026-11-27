// SSH dialog host (lazy chunk, 03 §20.2 R5), rendered by `<RemoteLayer />` while a dialog is requested or this tab
// owns a prompt. Prompts come last, so their <dialog> opens above an add-host dialog (top layer order).
import { Match, Show, Switch } from "solid-js"
import { closeRemoteDialog, remoteDialog, type RemoteStore } from "@/servers"
import { AddHostDialog } from "./add-host"
import { OperationDialog } from "./operations"
import { RemotePicker } from "./picker"
import { PromptDialog } from "./prompt-dialog"

export default function RemoteDialogs(props: { readonly store: RemoteStore }) {
  const owned = () =>
    Object.values(props.store.state.prompts).find((prompt) => prompt && prompt.ownerClientId === props.store.clientId)
  return (
    <>
      <Switch>
        <Match when={remoteDialog()?.kind === "add" && remoteDialog()} keyed>
          {(request) =>
            request.kind === "add" && (
              <AddHostDialog
                store={props.store}
                hostId={request.hostId}
                hostKey={request.hostKey}
                onClose={closeRemoteDialog}
              />
            )
          }
        </Match>
        <Match when={remoteDialog()?.kind === "picker" && remoteDialog()} keyed>
          {(request) =>
            request.kind === "picker" && (
              <RemotePicker store={props.store} hostId={request.hostId} onClose={closeRemoteDialog} />
            )
          }
        </Match>
        <Match when={remoteDialog()} keyed>
          {(request) =>
            request.kind !== "add" &&
            request.kind !== "picker" && (
              <OperationDialog
                store={props.store}
                hostId={request.hostId}
                kind={request.kind}
                onClose={closeRemoteDialog}
              />
            )
          }
        </Match>
      </Switch>
      <Show when={owned()} keyed>
        {(prompt) => <PromptDialog store={props.store} prompt={prompt} />}
      </Show>
    </>
  )
}

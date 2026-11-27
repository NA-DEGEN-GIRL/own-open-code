// 원격 PC dialogs (lazy chunk, 03 §20.2 R5), rendered by `<RemotePcLayer />` while one is requested:
//  - `원격 PC 추가`: paste the `ownpc://` link → "확인 번호 4821 · <PC>에서 이 번호가 보이면 [허용]을 누르세요" while the
//    shell waits for the PC → added, [열기]. Closing it while waiting cancels the pairing.
//  - `제거…`: confirm; the shell closes the window and clears that PC's partition and record.
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Dialog, Notice, Spinner, TextField } from "@/limits/kit"
import { closeRemotePcDialog, remotePcDialog } from "./active"
import { createPairingFlow, pairingError } from "./pairing"
import type { RemotePcStore } from "./store"
import { useRemotePcDialogText } from "./dialog-strings"

export default function RemotePcDialogs(props: { readonly store: RemotePcStore }) {
  const adding = () => {
    const request = remotePcDialog()
    return request?.kind === "add" ? request : undefined
  }
  const removing = () => {
    const request = remotePcDialog()
    return request?.kind === "remove" ? request : undefined
  }
  return (
    <>
      <Show when={adding()} keyed>
        {(request) => <AddRemotePcDialog store={props.store} pcKey={request.pcKey} onClose={closeRemotePcDialog} />}
      </Show>
      <Show when={removing()} keyed>
        {(request) => <RemoveRemotePcDialog store={props.store} pcKey={request.pcKey} onClose={closeRemotePcDialog} />}
      </Show>
    </>
  )
}

function AddRemotePcDialog(props: {
  readonly store: RemotePcStore
  readonly pcKey?: string
  readonly onClose: () => void
}) {
  const text = useRemotePcDialogText()
  const flow = createPairingFlow(props.store.api)
  const [link, setLink] = createSignal("")
  let input: HTMLInputElement | undefined
  onMount(() => requestAnimationFrame(() => input?.focus()))
  // Closing (Esc, ✕, 취소, the layer going away) while the shell waits for the PC stops that wait.
  onCleanup(() => flow.cancel())
  const again = () => props.store.pcs().find((pc) => pc.pcKey === props.pcKey)
  const waiting = () => {
    const step = flow.state()
    return step.step === "waiting" ? step : undefined
  }
  const done = () => {
    const step = flow.state()
    return step.step === "done" ? step : undefined
  }
  const busy = () => flow.state().step === "starting"
  const submit = () => {
    if (!busy() && link().trim()) void flow.start(link())
  }
  return (
    <Dialog
      open
      title={again() ? text("own.remotePc.reconnectTitle", { name: again()!.name }) : text("own.remotePc.addTitle")}
      onClose={props.onClose}
      testid="remote-pc-add-dialog"
      footer={
        <Switch
          fallback={
            <>
              <button type="button" class="own-btn own-target" data-size="sm" onClick={props.onClose}>
                {text("own.remotePc.cancel")}
              </button>
              <button
                type="button"
                class="own-btn own-target"
                data-variant="primary"
                data-size="sm"
                disabled={busy() || !link().trim()}
                data-testid="remote-pc-connect"
                onClick={submit}
              >
                {text("own.remotePc.connect")}
              </button>
            </>
          }
        >
          <Match when={waiting()}>
            <button
              type="button"
              class="own-btn own-target"
              data-size="sm"
              data-testid="remote-pc-cancel"
              onClick={props.onClose}
            >
              {text("own.remotePc.cancel")}
            </button>
          </Match>
          <Match when={done()}>
            {(added) => (
              <>
                <button type="button" class="own-btn own-target" data-size="sm" onClick={props.onClose}>
                  {text("own.remotePc.close")}
                </button>
                <button
                  type="button"
                  class="own-btn own-target"
                  data-variant="primary"
                  data-size="sm"
                  data-testid="remote-pc-done-open"
                  onClick={() => {
                    props.store.open(added().pcKey)
                    props.onClose()
                  }}
                >
                  {text("own.remotePc.doneOpen")}
                </button>
              </>
            )}
          </Match>
        </Switch>
      }
    >
      <div class="flex flex-col gap-3 text-[13px]">
        <Switch
          fallback={
            <>
              <TextField
                label={text("own.remotePc.link")}
                value={link()}
                onValue={setLink}
                onEnter={submit}
                hint={text("own.remotePc.linkHint")}
                placeholder="ownpc://pair?…"
                spellcheck={false}
                autocomplete="off"
                disabled={busy()}
                testid="remote-pc-link"
                inputRef={(element) => (input = element)}
              />
              <Show when={busy()}>
                <p class="m-0 flex items-center gap-2 text-own-muted" role="status">
                  <Spinner /> {text("own.remotePc.starting")}
                </p>
              </Show>
              <Show when={pairingError(text, flow.state())}>
                {(message) => (
                  <Notice tone="danger" testid="remote-pc-error">
                    {message()}
                  </Notice>
                )}
              </Show>
            </>
          }
        >
          <Match when={waiting()}>
            {(current) => (
              <>
                <p class="m-0 text-[13.5px]" data-testid="remote-pc-sas-line">
                  {text("own.remotePc.sas", { sas: current().sas, name: current().name })}
                </p>
                <p
                  class="m-0 my-2 text-center font-mono text-[40px] font-semibold tracking-[0.3em]"
                  data-testid="remote-pc-sas"
                >
                  {current().sas}
                </p>
                <p class="m-0 flex items-center gap-2 text-own-muted" role="status">
                  <Spinner /> {text("own.remotePc.waiting")}
                </p>
              </>
            )}
          </Match>
          <Match when={done()}>
            {(added) => (
              <Notice tone="ok" testid="remote-pc-done">
                {text("own.remotePc.done", { name: added().name })}
              </Notice>
            )}
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}

function RemoveRemotePcDialog(props: {
  readonly store: RemotePcStore
  readonly pcKey: string
  readonly onClose: () => void
}) {
  const text = useRemotePcDialogText()
  const [busy, setBusy] = createSignal(false)
  const name = () => props.store.pcs().find((pc) => pc.pcKey === props.pcKey)?.name ?? props.pcKey
  const remove = async () => {
    setBusy(true)
    await props.store.remove(props.pcKey)
    setBusy(false)
    props.onClose()
  }
  return (
    <Dialog
      open
      title={text("own.remotePc.removeTitle", { name: name() })}
      onClose={props.onClose}
      testid="remote-pc-remove-dialog"
      footer={
        <>
          <button type="button" class="own-btn own-target" data-size="sm" onClick={props.onClose}>
            {text("own.remotePc.cancel")}
          </button>
          <button
            type="button"
            class="own-btn own-target"
            data-variant="danger"
            data-size="sm"
            disabled={busy()}
            data-testid="remote-pc-remove-confirm"
            onClick={() => void remove()}
          >
            {text("own.remotePc.removeConfirm")}
          </button>
        </>
      }
    >
      <p class="m-0 text-[13px]">{text("own.remotePc.removeBody", { name: name() })}</p>
    </Dialog>
  )
}

// "이 대화에서 내 브라우저 사용" (BRW, lazy): the per-conversation switch. Turning it on is the user's consent, so it
// says what the agent may do under the conversation's approval mode and asks once; turning it off is immediate.
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useData } from "@/data"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { ToggleSwitch } from "@/shell/switch"
import { showToast } from "@/switcher/toast"
import { useBrowseText, type BrowseKey } from "./strings"
import { browseStatus, refreshBrowseStatus } from "./state"
import { BrowseSwitchError, createBrowseSwitch } from "./switch"

export default function BrowseDialog(props: { readonly sessionID: string; readonly onClose: () => void }) {
  const data = useData()
  const router = useRouter()
  const text = useBrowseText()
  const writer = createMemo(() => createBrowseSwitch(data.local()))
  const [check, { refetch }] = createResource(
    () => props.sessionID,
    (sessionID) => writer().check(sessionID),
  )
  void refreshBrowseStatus(data.local().rpc)
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const settingOn = () => browseStatus()?.enabled === true
  const state = () => {
    const value = check()
    return value?.ok ? value : undefined
  }
  const blocked = (): BrowseKey | undefined => {
    const value = check()
    if (!value) return undefined
    if (!value.ok)
      return `own.browse.dialog.${value.reason === "unsupported" ? "unavailable" : value.reason}` as BrowseKey
    if (value.use === "off" && !writer().canTurnOn()) return "own.browse.dialog.scope"
    if (value.use === "off" && !settingOn()) return "own.browse.dialog.settingOff"
    return undefined
  }
  const write = (use: "on" | "off") => {
    setBusy(true)
    void writer()
      .set(props.sessionID, use)
      .then((after) => {
        setConfirming(false)
        showToast({ message: text(after === "on" ? "own.browse.dialog.done.on" : "own.browse.dialog.done.off") })
        void refetch()
      })
      .catch((error: unknown) => {
        const key = error instanceof BrowseSwitchError ? (`own.browse.dialog.${error.reason}` as BrowseKey) : undefined
        showToast({ message: text(key ?? "own.browse.dialog.failed"), tone: "danger" })
      })
      .finally(() => setBusy(false))
  }
  const change = (checked: boolean) => {
    if (!checked) return write("off")
    setConfirming(true)
  }
  return (
    <Dialog
      open
      title={text("own.browse.dialog.title")}
      onClose={props.onClose}
      testid="browse-dialog"
      footer={
        <Show
          when={confirming()}
          fallback={
            <button type="button" class="own-btn" onClick={() => props.onClose()}>
              {text("own.browse.dialog.cancel")}
            </button>
          }
        >
          <button type="button" class="own-btn" onClick={() => setConfirming(false)}>
            {text("own.browse.dialog.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="danger"
            data-testid="browse-confirm"
            onClick={() => write("on")}
          >
            {text("own.browse.dialog.turnOn")}
          </button>
        </Show>
      }
    >
      <Show when={check()} fallback={<Spinner />}>
        <div class="flex flex-col gap-3 text-[13px]">
          <Show when={state()}>
            {(current) => (
              <p class="m-0">
                {text("own.browse.dialog.lead", {
                  mode: text(`own.browse.dialog.mode.${current().mode}` as BrowseKey),
                })}
              </p>
            )}
          </Show>
          <Show when={blocked()}>
            {(key) => (
              <Notice tone="warn" testid="browse-blocked">
                <span>{text(key())}</span>
                <Show when={key() === "own.browse.dialog.settingOff"}>
                  {" "}
                  <button
                    type="button"
                    class="own-link"
                    onClick={() => {
                      props.onClose()
                      router.navigate({ name: "settings", section: "browse" })
                    }}
                  >
                    {text("own.browse.dialog.openSettings")} →
                  </button>
                </Show>
              </Notice>
            )}
          </Show>
          <Show when={state() && (state()!.use === "on" || !blocked())}>
            <label class="flex items-center justify-between gap-3">
              <span class="font-semibold">{text("own.browse.dialog.switch")}</span>
              <ToggleSwitch
                checked={state()!.use === "on" || confirming()}
                label={text("own.browse.dialog.switch")}
                busy={busy()}
                testid="browse-switch"
                onChange={change}
              />
            </label>
          </Show>
          <Show when={confirming()}>
            <Notice tone="warn" testid="browse-confirm-text">
              {text("own.browse.dialog.confirm")}
            </Notice>
          </Show>
          <ul class="m-0 flex list-disc flex-col gap-1 pl-5 text-[12px] text-own-muted">
            <li>{text("own.browse.modes.full")}</li>
            <li>{text("own.browse.modes.ask")}</li>
            <li>{text("own.browse.modes.readOnly")}</li>
            <li>{text("own.browse.safety.injection")}</li>
          </ul>
        </div>
      </Show>
    </Dialog>
  )
}

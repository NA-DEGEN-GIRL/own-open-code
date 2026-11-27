// "이 세션에서 컴퓨터 사용" (01 §10.2, 03 §4.4, lazy): the per-session switch. Turning it on is the user's consent, so
// it shows what the agent will do, how to stop it and what stays off limits, and asks once; turning it off is
// immediate. The write is own.accounts `session.approval.set{computerUse}` (switch.ts `createComputerSwitch`). A model
// that cannot see images blocks turning it on and says why; with it on, the dialog says it does nothing.
import { createMemo, Show } from "solid-js"
import { useData } from "@/data"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { ToggleSwitch } from "@/shell/switch"
import { usePanelText } from "./panel-strings"
import { sessionVision, type ComputerStore } from "./state"
import { createComputerSwitch, createComputerToggle } from "./switch"

export default function ComputerDialog(props: {
  readonly sessionID: string
  readonly store: ComputerStore
  readonly onClose: () => void
}) {
  const data = useData()
  const router = useRouter()
  const text = usePanelText()
  const writer = createMemo(() => createComputerSwitch(data.local()))
  const toggle = createComputerToggle({
    writer,
    sessionID: () => props.sessionID,
    rules: () => data.local().data.session.get(props.sessionID)?.permissions,
    vision: () => sessionVision(data.local(), props.sessionID),
  })
  const on = () => toggle.use() === "on"
  const locked = () => toggle.view() !== "on" && toggle.view() !== "off"
  const engaged = () => props.store.state.status?.killSwitch?.engaged === true
  const title = () =>
    data.local().data.session.get(props.sessionID)?.title ??
    data.local().sessions.state.sessions[props.sessionID]?.title
  return (
    <Dialog
      open
      title={text("own.computer.toggle")}
      onClose={props.onClose}
      testid="computer-dialog"
      footer={
        <Show
          when={toggle.view() === "confirm"}
          fallback={
            <button type="button" class="own-btn" onClick={() => props.onClose()}>
              {text("own.computer.cancel")}
            </button>
          }
        >
          <button type="button" class="own-btn" onClick={() => toggle.cancel()}>
            {text("own.computer.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="danger"
            data-testid="computer-confirm"
            onClick={() => void toggle.confirm()}
          >
            {text("own.computer.turnOn")}
          </button>
        </Show>
      }
    >
      <div class="flex flex-col gap-3 text-[13px]" data-view={toggle.view()}>
        <Show when={title()}>{(name) => <p class="m-0 truncate text-own-muted">{name()}</p>}</Show>
        <div class="flex items-center gap-3 rounded-lg border border-own-border p-3">
          <span class="min-w-0 flex-1 font-semibold">{text("own.computer.toggle")}</span>
          <Show when={toggle.view() === "busy" || toggle.view() === "checking"}>
            <Spinner />
          </Show>
          <span class="text-own-muted" data-testid="computer-state">
            {text(on() ? "own.computer.on" : "own.computer.off")}
          </span>
          <ToggleSwitch
            checked={on()}
            label={text("own.computer.toggle")}
            busy={locked()}
            testid="computer-switch"
            onChange={() => void toggle.flip()}
          />
        </div>
        <Show when={toggle.view() === "checking"}>
          <p class="m-0 text-[12.5px] text-own-muted">{text("own.computer.checking")}</p>
        </Show>
        <Show when={toggle.reason()}>
          {(reason) => (
            <Notice tone="warn" testid="computer-blocked">
              {text(`own.computer.blocked.${reason()}`)}
            </Notice>
          )}
        </Show>
        <Show when={toggle.blind()}>
          <Notice tone="warn" testid="computer-no-vision">
            {text("own.computer.noVisionOn")}
          </Notice>
        </Show>
        <Show when={engaged()}>
          <Notice tone="danger">{text("own.computer.stoppedNote")}</Notice>
        </Show>
        <ul class="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-own-muted">
          <li>{text("own.computer.what")}</li>
          <li>{text("own.computer.stopHint")}</li>
          <li>{text("own.computer.deniedApps")}</li>
          <li>{text("own.computer.privacy")}</li>
          <li>{text("own.computer.cache")}</li>
        </ul>
        <Show when={toggle.view() === "confirm"}>
          <Notice tone="warn" testid="computer-consent">
            {text("own.computer.confirm")}
          </Notice>
        </Show>
        <Show when={toggle.failed()}>
          <p class="m-0 text-[12.5px] text-own-danger" role="alert">
            {text("own.computer.failed")}
          </p>
        </Show>
        <button
          type="button"
          class="own-target self-start text-[12.5px] text-own-accent-text hover:underline"
          data-testid="computer-open-settings"
          onClick={() => {
            props.onClose()
            router.navigate({ name: "settings", section: "experimental" })
          }}
        >
          {text("own.computer.openSettings")} →
        </button>
      </div>
    </Dialog>
  )
}

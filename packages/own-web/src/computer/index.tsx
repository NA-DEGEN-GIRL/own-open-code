// Computer use in the session UI (01 §10.2, 03 §4.4, §5.7 실험). Small and in the first chunk:
// - `ComputerLayer`, mounted once by the shell: the window's ComputerStore and the per-session dialog (lazy chunk);
// - `ComputerChip`, in the session header while the session has computer use on: the activity indicator from `action`
//   events ("PC 조작 중 · notepad"), the stopped state, the Stop button (kill switch for every session), and the state
//   of a session whose model cannot see images (`이 모델로는 안 돼요`, with a notice when a model switch got there);
// - `useComputerMenu`, the session `⋯` item that opens the dialog.
// The dialog's switch (switch.ts) and the dialog and settings strings (panel-strings.ts) stay in the lazy chunks.
// Everything waits for the local service's `status.available`, asked lazily (state.ts). Only local sessions: SSH hosts
// never load the plugin (it is not a remote bundle), and a phone asks for nothing yet (src/data/index.tsx).
import { createEffect, createMemo, lazy, onCleanup, Show, Suspense } from "solid-js"
import { LOCAL, useData, type ServerKey } from "@/data"
import type { MenuItem } from "@/servers/menu"
import { InlineIcon } from "@/shell/icons"
import { showToast } from "@/switcher/toast"
import {
  closeComputerDialog,
  computerDialog,
  computerStore,
  computerUseOf,
  createComputerStore,
  openComputerDialog,
  registerComputerStore,
  sessionVision,
} from "./state"
import { useComputerText } from "./strings"

export { computerStore, computerUseOf, openComputerDialog, type ComputerStore } from "./state"

const ComputerDialog = lazy(() => import("./dialog"))

export function ComputerLayer() {
  const data = useData()
  const store = createComputerStore({ data })
  onCleanup(registerComputerStore(store))
  onCleanup(() => store.dispose())
  return (
    <Show when={computerDialog()}>
      {(request) => (
        <Suspense>
          <ComputerDialog sessionID={request().sessionID} store={store} onClose={closeComputerDialog} />
        </Suspense>
      )}
    </Show>
  )
}

/** The local session's computer use, when the service can drive this desktop (`undefined` otherwise). */
function useComputerSession(serverKey: () => ServerKey, sessionID: () => string | undefined) {
  const data = useData()
  const local = createMemo(() => {
    const id = sessionID()
    if (!id || serverKey() !== LOCAL) return undefined
    const info = data.local().data.session.get(id)
    return {
      sessionID: id,
      use: computerUseOf(info?.permissions),
      child: !!info?.parentID,
      vision: sessionVision(data.local(), id),
    }
  })
  // A session whose rules turn computer use on is the one thing on screen that needs `status` (state.ts `ensure`).
  createEffect(() => {
    if (local()?.use === "on") computerStore()?.ensure()
  })
  return createMemo(() => {
    const store = computerStore()
    const session = local()
    return store?.available() && session ? { store, ...session } : undefined
  })
}

/** Header chip of a session with computer use on (03 §4.4). */
export function ComputerChip(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const text = useComputerText()
  const session = useComputerSession(props.serverKey, props.sessionID)
  // A model switch of a session with computer use on to a model that cannot see images: said once, when it happens
  // (a session opened that way already shows the chip's state).
  const seen = { sessionID: undefined as string | undefined, vision: undefined as boolean | undefined }
  createEffect(() => {
    const current = session()
    const on = current?.use === "on" ? current : undefined
    if (on && seen.sessionID === on.sessionID && seen.vision === true && on.vision === false)
      showToast({ message: text("own.computer.noVisionSwitched") })
    seen.sessionID = on?.sessionID
    seen.vision = on?.vision
  })
  return (
    <Show when={session()?.use === "on" && session()}>
      {(current) => {
        const store = () => current().store
        const engaged = () => store().state.status?.killSwitch?.engaged === true
        const active = () => !engaged() && store().state.active[current().sessionID] === true
        const app = () => store().state.last[current().sessionID]?.app
        const blind = () => current().vision === false
        const label = () => {
          if (engaged()) return text("own.computer.chipStopped")
          if (blind()) return text("own.computer.chipNoVision")
          if (!active()) return text("own.computer.chip")
          const name = app()
          return name ? text("own.computer.chipActiveApp", { app: name }) : text("own.computer.chipActive")
        }
        const stop = () =>
          void store()
            .engage()
            .catch(() => showToast({ message: text("own.computer.stopFailed"), tone: "danger" }))
        // A crowded header folds the chip to its icon and 멈추기 to a mark (shell/header-fit.ts): the name and the
        // tooltip keep the state and what each does.
        return (
          <span
            class="inline-flex h-7 shrink-0 items-center rounded-full border text-[12px] data-[state=on]:border-own-border data-[state=on]:text-own-muted data-[state=active]:border-own-warn data-[state=active]:text-own-warn data-[state=novision]:border-own-warn data-[state=novision]:text-own-warn data-[state=stopped]:border-own-danger data-[state=stopped]:text-own-danger"
            data-testid="computer-chip"
            data-state={engaged() ? "stopped" : blind() ? "novision" : active() ? "active" : "on"}
          >
            <button
              type="button"
              class="own-target inline-flex h-full items-center gap-1.5 rounded-full px-2.5 hover:bg-own-hover"
              aria-label={label()}
              title={`${label()}\n${text(blind() ? "own.computer.chipNoVisionTitle" : "own.computer.chipTitle")}`}
              aria-haspopup="dialog"
              data-testid="computer-chip-open"
              onClick={() => openComputerDialog({ sessionID: current().sessionID })}
            >
              <span
                aria-hidden="true"
                class="own-give-full size-1.5 rounded-full bg-current"
                classList={{ "motion-safe:animate-pulse": active() }}
              />
              <span class="own-give-full max-w-[12rem] truncate">{label()}</span>
              <InlineIcon name="computer" class={`own-give-short${active() ? " motion-safe:animate-pulse" : ""}`} />
            </button>
            <Show when={!engaged() && store().allowed("killswitch.engage")}>
              <button
                type="button"
                class="own-target mr-0.5 inline-flex h-6 items-center rounded-full px-2 font-semibold text-own-danger hover:bg-own-hover"
                aria-label={text("own.computer.stop")}
                title={text("own.computer.stopTitle")}
                data-testid="computer-stop"
                onClick={stop}
              >
                <span class="own-give-full">{text("own.computer.stop")}</span>
                <span aria-hidden="true" class="own-give-short size-2 rounded-[2px] bg-current" />
              </button>
            </Show>
          </span>
        )
      }}
    </Show>
  )
}

/**
 * The session `⋯` item "이 세션에서 컴퓨터 사용…" (opens the dialog with the switch). Not for subagent sessions: the
 * plugin refuses them unless configured otherwise, and their parent's switch covers them. `prepare` goes to the menu's
 * `onOpen`: the first open of a local session's menu asks `status`, and the item appears once it answers.
 */
export function useComputerMenu(serverKey: () => ServerKey, sessionID: () => string | undefined) {
  const data = useData()
  const text = useComputerText()
  const session = useComputerSession(serverKey, sessionID)
  return {
    prepare() {
      if (serverKey() === LOCAL) computerStore()?.ensure()
    },
    items(): MenuItem[] {
      const current = session()
      if (!current || current.child || !data.local().rpc.allowed("session.approval.set")) return []
      return [
        {
          label: text("own.computer.menu"),
          onSelect: () => openComputerDialog({ sessionID: current.sessionID }),
          testid: "session-menu-computer",
        },
      ]
    },
  }
}

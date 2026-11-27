// 서버 고르기 on the new-conversation screen (03 §5.1, 04 §17.2; 2.2.6-own.16): which server the next conversation
// starts on, `이 PC` or an SSH host, each with its connection state. Lazy; the composer mounts it only while SSH hosts
// exist. Choosing a server opens its folderless new-conversation screen (`/`, `/srv/<hostId>/new`, where the
// conversation works in that server's 기본 대화 폴더) and is remembered in this browser (`newChatHost`), so `새 대화` and
// Alt+N open it next time. A host that is only disconnected (paused, or failed and paused) connects at once; every other
// state (authentication, host key, install, update) is the screen's overlay, which says what to do with its button.
import { createSignal, createUniqueId, For, Show } from "solid-js"
import { LOCAL, useData, type ServerKey, type ServerRuntime } from "@/data"
import { defaultFolder } from "@/projects/default-folder"
import { PathTail } from "@/projects/path-tail"
import { catalogText, useCatalogText } from "@/projects/text"
import { useRouter } from "@/routing/router"
import type { Route } from "@/routing/routes"
import { setNewSessionTarget } from "@/sidebar/target"
import { switcherControl } from "@/switcher/control"
import { newSessionTarget } from "@/switcher/new-session"
import { NEW_CHAT, remoteStore } from "./active"
import { accountAllowed, hostStatus, type HostStatus } from "./state"
import { useServersText } from "./strings"

const words = catalogText(
  {
    "own.newChat.server": "대화할 서버",
    "own.newChat.local": "이 PC의 기본 대화 폴더",
    "own.newChat.host": "호스트의 기본 대화 폴더",
  },
  {
    "own.newChat.server": "Server to talk on",
    "own.newChat.local": "This PC's default conversation folder",
    "own.newChat.host": "The host's default conversation folder",
  },
)

const TONE: Record<HostStatus["tone"], string> = {
  ok: "text-own-ok",
  warn: "text-own-warn",
  danger: "text-own-danger",
  muted: "text-own-faint",
}

/**
 * Opens the folderless new-conversation screen of `serverKey` and remembers it as the server `새 대화` opens next (this
 * PC clears it); the server choice and the palette's `<호스트>에서 새 대화` both come here.
 */
export function openNewChat(input: {
  readonly serverKey: ServerKey
  readonly navigate: (route: Route) => void
  /** The phone tier, where `/` is the conversation list: this PC's screen is `/srv/local/new` there. */
  readonly phone: boolean
  /** This PC's runtime: a host's new conversation starts on its "모델 @ 계정" ({@link adoptLocalTarget}). */
  readonly local?: ServerRuntime
}) {
  if (input.local && input.serverKey !== LOCAL) adoptLocalTarget(input.serverKey, input.local)
  try {
    if (input.serverKey === LOCAL) localStorage.removeItem(NEW_CHAT)
    else localStorage.setItem(NEW_CHAT, input.serverKey)
  } catch {}
  setNewSessionTarget(undefined)
  input.navigate(
    input.serverKey === LOCAL && !input.phone ? { name: "home" } : { name: "home", serverKey: input.serverKey },
  )
  const store = remoteStore()
  const view = store?.state.hosts[input.serverKey]
  // Only disconnected: connect now. Sign-in, host keys, install and update need the overlay's own step.
  if (store && view?.paused && (view.stage === "disconnected" || view.stage === "failed") && view.error !== "host_key")
    void store.connect(input.serverKey).catch(() => undefined)
}

/**
 * 04 §12.4: a new conversation on a host starts on this PC's "모델 @ 계정" when the host may use that account, unless
 * one was chosen for the host already. Without it the host's screen waits for the host's own mirror of this PC's
 * accounts and a send right away was refused as still loading (found by own-web's remote e2e, 2.2.6-own.16).
 */
export function adoptLocalTarget(hostId: string, local: ServerRuntime) {
  if (switcherControl.state.newSession[hostId]) return
  const target = newSessionTarget(local, LOCAL, undefined)
  const account = target ? local.own.accountFor(target.providerID) : undefined
  const scope = remoteStore()?.state.hosts[hostId]?.accounts
  if (target && (!account || !scope || accountAllowed(scope, account.id)))
    switcherControl.setNewSessionTarget(hostId, target)
}

export default function ServerSelect(props: {
  readonly serverKey: ServerKey
  /** The phone tier, where `/` is the conversation list: this PC's screen is `/srv/local/new` there. */
  readonly phone: boolean
}) {
  const text = useServersText()
  const own = useCatalogText(words)
  const router = useRouter()
  const data = useData()
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement
  const store = remoteStore

  const statusOf = (hostId: string) => {
    const current = store()
    const view = current?.state.hosts[hostId]
    if (!current || !view) return undefined
    const live = current.state.endpoints[hostId] ? current.runtime(hostId)?.connection.status() : undefined
    return hostStatus(view, live)
  }
  const nameOf = (serverKey: ServerKey) =>
    serverKey === LOCAL ? text("own.remote.group.local") : (store()?.state.hosts[serverKey]?.name ?? serverKey)

  /** That server's own default conversation folder; a host's only while it is connected. */
  const folderOf = (runtime: ServerRuntime | undefined) => (runtime ? defaultFolder(runtime).view()?.path : undefined)

  function choose(serverKey: ServerKey) {
    popover.hidePopover()
    button.focus()
    if (serverKey === props.serverKey && router.route().name === "home") return
    openNewChat({ serverKey, navigate: (route) => router.navigate(route), phone: props.phone, local: data.local() })
  }

  const items = () => [...popover.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")]
  function onKeyDown(event: KeyboardEvent) {
    if (event.code === "Escape") return event.stopPropagation()
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.code === "ArrowDown" ? index + 1 : event.code === "ArrowUp" ? index - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    list[(next + list.length) % list.length]?.focus()
  }

  const current = () => (props.serverKey === LOCAL ? undefined : statusOf(props.serverKey))

  return (
    <>
      <button
        ref={button}
        type="button"
        class="inline-flex h-7 max-w-[22ch] items-center gap-1 rounded-md px-2 text-[12.5px] text-own-muted hover:bg-own-hover hover:text-own-text"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={id}
        aria-label={`${own("own.newChat.server")}: ${nameOf(props.serverKey)}`}
        popovertarget={id}
        data-testid="server-select"
        data-server={props.serverKey}
      >
        <Show when={current()} fallback={<span aria-hidden="true">⌂</span>}>
          {(status) => (
            <span aria-hidden="true" class={TONE[status().tone]}>
              {status().symbol}
            </span>
          )}
        </Show>
        <span class="min-w-0 truncate">{nameOf(props.serverKey)}</span>
        <span aria-hidden="true" class="text-own-faint">
          ▾
        </span>
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="menu"
        aria-label={own("own.newChat.server")}
        class="fixed m-0 min-w-[220px] max-w-[min(360px,calc(100vw-16px))] rounded-[10px] border border-own-border bg-own-raised p-1 text-own-text shadow-[var(--own-shadow-float)] [inset:auto]"
        data-testid="server-select-menu"
        onToggle={(event) => {
          const opened = event.newState === "open"
          setOpen(opened)
          if (!opened) return
          const rect = button.getBoundingClientRect()
          popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popover.offsetWidth - 8))}px`
          popover.style.top = `${rect.bottom + popover.offsetHeight + 8 > innerHeight ? Math.max(8, rect.top - popover.offsetHeight - 4) : rect.bottom + 4}px`
          requestAnimationFrame(() => (items().find((item) => item.ariaChecked === "true") ?? items()[0])?.focus())
        }}
        onKeyDown={onKeyDown}
      >
        <Show when={open()}>
          <Item
            checked={props.serverKey === LOCAL}
            name={text("own.remote.group.local")}
            note={own("own.newChat.local")}
            path={folderOf(data.local())}
            symbol="⌂"
            tone="text-own-faint"
            serverKey={LOCAL}
            onChoose={choose}
          />
          <For each={store()?.state.order ?? []}>
            {(hostId) => (
              <Show when={statusOf(hostId)}>
                {(status) => (
                  <Item
                    checked={props.serverKey === hostId}
                    name={nameOf(hostId)}
                    note={`${text(`own.remote.state.${status().key}`)} · ${own("own.newChat.host")}`}
                    path={folderOf(store()?.state.endpoints[hostId] ? store()?.runtime(hostId) : undefined)}
                    symbol={status().symbol}
                    tone={TONE[status().tone]}
                    serverKey={hostId}
                    onChoose={choose}
                  />
                )}
              </Show>
            )}
          </For>
        </Show>
      </div>
    </>
  )
}

function Item(props: {
  readonly checked: boolean
  readonly name: string
  readonly note: string
  readonly path?: string
  readonly symbol: string
  readonly tone: string
  readonly serverKey: ServerKey
  readonly onChoose: (serverKey: ServerKey) => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.checked}
      class="flex min-h-[34px] w-full items-center gap-2 rounded-md px-2.5 py-1 text-left hover:bg-own-hover focus-visible:bg-own-hover focus-visible:outline-none aria-checked:font-semibold"
      data-testid="server-select-item"
      data-server={props.serverKey}
      title={props.path}
      onClick={() => props.onChoose(props.serverKey)}
    >
      <span aria-hidden="true" class={`w-4 flex-none text-center text-[12px] ${props.tone}`}>
        {props.symbol}
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="max-w-full truncate text-[13px]">{props.name}</span>
        <span class="max-w-full truncate text-[11px] font-normal text-own-faint">{props.note}</span>
        <Show when={props.path}>{(path) => <PathTail path={path()} class="max-w-full font-normal" />}</Show>
      </span>
    </button>
  )
}

// The server sections of the sidebar's scroll area (03 §4.3, 04 §12.3, §17.2, 08 §4.1). This PC, SSH hosts and other
// PCs are the same kind of section:
//
//   ▾ 이 PC ●                                    +  ⋯      ← sticky while its list scrolls; only with two or more
//     폴더 열기…                                           ← the first row; while a host is away: what brings it back
//     (the server's tree)
//   ▸ build-host ○ 연결 끊김                     ⋯
//   ↗ 집 PC ●                                       ⋯      ← its own window: nothing of it is listed here
//
// Each lies at its natural height in the one scroll area, in the user's order (servers/order.ts, per device; dragging
// and moving are ./reorder.ts). The host list reads the own-remote catalog / browser snapshot while a host is not live,
// so nothing here waits for SSH ([old] 84). A row of a host that is not live still opens its route: the session view
// shows the overlay with `연결하면 열 수 있습니다 [다시 연결]` (04 §17.2, §17.7).
import { createMemo, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import { LOCAL, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { OpenFolderButton, SECTION_ROW } from "@/projects/open-button"
import { openProject } from "@/projects/opener"
import { openRemotePcDialog, remotePcStore } from "@/remote-pcs/active"
import { useRemotePcText } from "@/remote-pcs/strings"
import { useRouter } from "@/routing/router"
import { openRemoteDialog, remoteStore } from "@/servers/active"
import { HostMenu, type MenuItem } from "@/servers/menu"
import { PC, serverCollapsed, serverOrder, toggleServer } from "@/servers/order"
import { selectHostPanel } from "@/servers/panel"
import { hostStatus, type HostStatus, type HostStatusKey } from "@/servers/state"
import { useServersText } from "@/servers/strings"
import { Icon } from "@/shell/icons"
import { useSidebar } from "./context"
import { folding, reorder } from "./reorder-api"
import { Chevron } from "./rows"
import { useScroller } from "./scroller"
import { useSidebarText } from "./strings"

export interface SectionsProps {
  /** One server's list (index.tsx); `top` is the height of the header that sticks over it. */
  readonly list: (runtime: ServerRuntime, top: () => number, last: () => boolean) => JSX.Element
  /** The server a new conversation and Ctrl+O act on now. */
  readonly current: () => ServerKey
  readonly onNew: (serverKey: ServerKey) => void
}

export function ServerSections(props: SectionsProps) {
  const order = createMemo(serverOrder, [], { equals: (a, b) => a.join("|") === b.join("|") })
  /** The last section that shows a list: the one whose list loads on while it is scrolled (others have a row for it). */
  const last = createMemo(() => order().findLast((key) => !key.startsWith(PC) && !serverCollapsed(key)))
  const lone = () => order().length < 2
  return (
    <For each={order()}>
      {(key) => (
        <Switch>
          <Match when={key === LOCAL}>
            <LocalSection {...props} headed={!lone()} last={() => last() === key} />
          </Match>
          <Match when={key.startsWith(PC)}>
            <PcSection pcKey={key.slice(PC.length)} />
          </Match>
          <Match when={true}>
            <HostSection {...props} hostId={key} last={() => last() === key} />
          </Match>
        </Switch>
      )}
    </For>
  )
}

const TONE: Record<HostStatus["tone"], string> = {
  ok: "text-own-ok",
  warn: "text-own-warn",
  danger: "text-own-danger",
  muted: "text-own-faint",
}

/** One section: its header, then its body while it is open. */
function Section(props: {
  readonly serverKey: string
  readonly name: string
  /** Short words while the server is not simply connected. */
  readonly note?: string
  readonly noteTestid?: string
  readonly status: { readonly symbol: string; readonly tone: HostStatus["tone"]; readonly label: string }
  readonly symbolTestid?: string
  readonly items: () => readonly MenuItem[]
  readonly menuLabel: string
  readonly menuTestid: string
  readonly headerTestid: string
  /** Without a header: this PC while nothing else is listed. */
  readonly headed: boolean
  /** `+` in the header. */
  readonly onNew?: () => void
  /** No list here: the header opens the server elsewhere. */
  readonly onOpen?: {
    readonly label: string
    readonly title: string
    readonly testid: string
    readonly run: () => void
  }
  /** The list; `top` is the height of the header that sticks over it. */
  readonly children?: (top: () => number) => JSX.Element
}) {
  const text = useServersText()
  const sidebar = useSidebarText()
  const scroller = useScroller()
  const ctl = useSidebar()
  let section!: HTMLElement
  let header: HTMLDivElement | undefined
  /** A search opens every section: what it finds is listed under its server. */
  const open = () => ctl.searching() || !serverCollapsed(props.serverKey)
  /** Mounted when first opened; folded later it stays, with its rows, focus and loads. */
  const mounted = createMemo<boolean>((was) => was || open() || props.serverKey === LOCAL, false)
  function toggle() {
    toggleServer(props.serverKey)
    // Folded while its header stuck to the top: the header stays there, the next section comes up under it.
    if (section.offsetTop < (scroller.element()?.scrollTop ?? 0)) scroller.to(section.offsetTop)
  }
  return (
    <section
      ref={section}
      aria-label={props.name}
      class="own-server"
      data-testid="server-section"
      data-server={props.serverKey}
    >
      <Show when={props.headed}>
        <div
          ref={header}
          class="own-server-head group sticky top-0 z-[1] flex min-h-9 items-center gap-1.5 bg-own-subtle pr-2.5 pl-2"
          data-testid={props.headerTestid}
          data-reorder="server"
          data-reorder-id={props.serverKey}
        >
          <button
            type="button"
            class="own-target flex h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-left text-[13px] select-none hover:bg-own-hover"
            aria-expanded={props.onOpen ? undefined : open()}
            aria-label={props.onOpen?.label ?? text("own.remote.toggle", { name: props.name })}
            title={props.onOpen?.title}
            data-testid={props.onOpen?.testid ?? "server-toggle"}
            data-reorder-handle=""
            aria-keyshortcuts="Control+Shift+ArrowUp Control+Shift+ArrowDown"
            onClick={() => (props.onOpen ? props.onOpen.run() : toggle())}
          >
            <Show
              when={props.onOpen}
              fallback={
                <span class="flex text-own-muted">
                  <Chevron open={open()} />
                </span>
              }
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                class="size-3 flex-none fill-none stroke-current stroke-2 text-own-muted"
              >
                <path d="M8 16L18 6M9.5 6H18v8.5" />
              </svg>
            </Show>
            {/* One line: the words go (to the hidden second one) before they are cut to a letter or two; the mark and
                the first row of the list say it too. */}
            <span class="flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden leading-5">
              <span class="flex h-5 max-w-full min-w-0 items-center gap-1.5">
                <span class="min-w-0 truncate font-semibold text-own-text">{props.name}</span>
                <span
                  role="img"
                  class={`flex-none leading-none ${TONE[props.status.tone]} ${/[●○]/.test(props.status.symbol) ? "text-[9px]" : "text-[12px]"}`}
                  aria-label={props.status.label}
                  title={props.status.label}
                  data-testid={props.symbolTestid}
                >
                  {props.status.symbol}
                </span>
              </span>
              <Show when={props.note}>
                <span
                  class="min-w-0 flex-[1_1_3.5em] truncate text-[12px] text-own-muted"
                  title={props.note}
                  data-testid={props.noteTestid}
                >
                  {props.note}
                </span>
              </Show>
            </span>
          </button>
          <Show when={props.onNew}>
            <button
              type="button"
              class="own-icon-button own-target size-6 opacity-70 group-hover:opacity-100 [&_svg]:size-3.5"
              aria-label={sidebar("own.sidebar.project.newSession", { name: props.name })}
              title={sidebar("own.sidebar.project.newSession", { name: props.name })}
              data-testid="server-new-session"
              onClick={() => props.onNew!()}
            >
              <Icon name="plus" />
            </button>
          </Show>
          <HostMenu
            label={props.menuLabel}
            items={() => {
              const moves = reorder()?.serverItems(props.serverKey) ?? []
              const own = props.items()
              return own.length && moves.length ? [...own, "separator", ...moves] : [...own, ...moves]
            }}
            class="own-icon-button own-target size-6 flex-none"
            testid={props.menuTestid}
          />
        </div>
      </Show>
      <Show when={props.children}>
        {(children) => (
          <div
            class="pb-1.5"
            hidden={!open() || folding() === "*"}
            data-testid={props.serverKey === LOCAL ? "local-group" : "host-body"}
          >
            <Show when={mounted()}>{children()(() => header?.offsetHeight ?? 0)}</Show>
          </div>
        )}
      </Show>
    </section>
  )
}

interface ListSectionProps extends SectionsProps {
  readonly last: Accessor<boolean>
}

function LocalSection(props: ListSectionProps & { readonly headed: boolean }) {
  const text = useServersText()
  const i18n = useI18n()
  const ctl = useSidebar()
  const connected = () => ctl.runtime.connection.status() === "connected"
  return (
    <Section
      serverKey={LOCAL}
      name={text("own.remote.group.local")}
      note={connected() ? undefined : text("own.remote.state.connecting")}
      status={
        connected()
          ? { symbol: "●", tone: "ok", label: text("own.remote.state.ready") }
          : { symbol: "◐", tone: "warn", label: text("own.remote.state.connecting") }
      }
      items={() => [
        { label: i18n.t("own.folder.open"), testid: "server-open-folder", onSelect: () => void openProject(LOCAL) },
      ]}
      menuLabel={text("own.remote.menu", { name: text("own.remote.group.local") })}
      menuTestid="server-menu"
      headerTestid="server-group-local"
      headed={props.headed}
      onNew={() => props.onNew(LOCAL)}
    >
      {(top) => (
        <>
          <Show when={!ctl.archiveView() && !ctl.searching()}>
            <OpenFolderButton serverKey={LOCAL} keys={props.current() === LOCAL} />
          </Show>
          {props.list(ctl.runtime, top, props.last)}
        </>
      )}
    </Section>
  )
}

/** What brings a host back, by its state: the section's first row while the host is not there. */
const FIX: Partial<
  Record<
    HostStatusKey,
    readonly [
      label: "reconnect" | "authenticate" | "checkHostKey" | "install" | "update" | "takeover",
      dialog?: "add" | "update" | "takeover",
    ]
  >
> = {
  disconnected: ["reconnect"],
  failed: ["reconnect"],
  authentication: ["authenticate"],
  hostKey: ["checkHostKey", "add"],
  needsInstall: ["install", "add"],
  incompatible: ["update", "update"],
  otherOwner: ["takeover", "takeover"],
}

function HostSection(props: ListSectionProps & { readonly hostId: string }) {
  const text = useServersText()
  const i18n = useI18n()
  const router = useRouter()
  const ctl = useSidebar()
  const store = () => remoteStore()!
  const host = () => store().state.hosts[props.hostId]
  const runtime = () => store().runtime(props.hostId)
  const live = () => (store().state.endpoints[props.hostId] ? runtime()?.connection.status() : undefined)
  const status = createMemo(() => {
    const view = host()
    return view ? hostStatus(view, live()) : undefined
  })
  const ready = () => status()?.key === "ready"
  const label = () => {
    const current = status()
    if (!current) return ""
    if (current.key === "authentication" && host()?.owner.clientId && host()?.owner.clientId !== store().clientId)
      return text("own.remote.elsewhere")
    return text(`own.remote.state.${current.key}`)
  }
  const connect = () =>
    void store()
      .connect(props.hostId)
      .catch(() => undefined)
  const fix = () => {
    const found = status() && FIX[status()!.key]
    if (!found) return undefined
    const [action, dialog] = found
    return {
      label: text(`own.remote.action.${action}`),
      run: () =>
        dialog
          ? openRemoteDialog({
              kind: dialog,
              hostId: props.hostId,
              ...(action === "checkHostKey" ? { hostKey: true } : {}),
            })
          : connect(),
    }
  }
  const items = (): MenuItem[] => {
    const view = host()
    const current = status()
    if (!view || !current) return []
    const list: MenuItem[] = []
    const liveNow = current.key === "ready"
    if (liveNow)
      list.push({
        label: text("own.remote.openFolder"),
        testid: "host-open-folder",
        onSelect: () => void openProject(props.hostId),
      })
    if (!liveNow)
      list.push({
        label: text(
          current.key === "authentication" ? "own.remote.action.authenticate" : "own.remote.action.reconnect",
        ),
        testid: "host-reconnect",
        onSelect: connect,
      })
    if (liveNow || current.key === "connecting")
      list.push({
        label: text("own.remote.action.disconnect"),
        testid: "host-disconnect",
        onSelect: () =>
          void store()
            .disconnect(props.hostId)
            .catch(() => undefined),
      })
    list.push({
      label: text("own.remote.action.checkHostKey"),
      testid: "host-check-key",
      onSelect: () => openRemoteDialog({ kind: "add", hostId: props.hostId, hostKey: true }),
    })
    if (current.key === "needsInstall")
      list.push({
        label: text("own.remote.action.install"),
        testid: "host-install",
        onSelect: () => openRemoteDialog({ kind: "add", hostId: props.hostId }),
      })
    if (current.key === "incompatible" || view.versions.skew)
      list.push({
        label: text("own.remote.action.update"),
        testid: "host-update",
        onSelect: () => openRemoteDialog({ kind: "update", hostId: props.hostId }),
      })
    if (liveNow)
      list.push({
        label: text("own.remote.action.drain"),
        testid: "host-drain",
        onSelect: () => openRemoteDialog({ kind: "drain", hostId: props.hostId }),
      })
    if (current.key === "otherOwner")
      list.push({
        label: text("own.remote.action.takeover"),
        testid: "host-takeover",
        onSelect: () => openRemoteDialog({ kind: "takeover", hostId: props.hostId }),
      })
    list.push("separator", {
      label: text("own.remote.action.details"),
      testid: "host-settings",
      onSelect: () => {
        selectHostPanel(props.hostId)
        router.navigate({ name: "settings", section: "remote" })
      },
    })
    list.push({
      label: text("own.remote.action.remove"),
      tone: "danger",
      testid: "host-remove",
      onSelect: () => openRemoteDialog({ kind: "forget", hostId: props.hostId }),
    })
    return list
  }
  return (
    <Show when={host()}>
      {(view) => (
        <div data-testid="host-group" data-host={props.hostId} data-stage={view().stage} data-status={status()?.key}>
          <Section
            serverKey={props.hostId}
            name={view().name}
            note={ready() ? undefined : label()}
            noteTestid="host-status"
            status={{ symbol: status()?.symbol ?? "○", tone: status()?.tone ?? "muted", label: label() }}
            symbolTestid="host-symbol"
            items={items}
            menuLabel={text("own.remote.menu", { name: view().name })}
            menuTestid="host-menu"
            headerTestid="host-header"
            headed
            onNew={ready() ? () => props.onNew(props.hostId) : undefined}
          >
            {(top) => (
              <>
                <Show when={!ctl.archiveView() && !ctl.searching()}>
                  <Show
                    when={ready()}
                    fallback={
                      <Show when={fix()}>
                        {(action) => (
                          <button
                            type="button"
                            class={SECTION_ROW}
                            data-testid="host-fix"
                            onClick={() => action().run()}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                              class="size-3.5 flex-none fill-none stroke-current stroke-[1.7]"
                            >
                              <path d="M19 12a7 7 0 11-2-4.9M19 4v4h-4" />
                            </svg>
                            <span class="min-w-0 truncate">{action().label}</span>
                          </button>
                        )}
                      </Show>
                    }
                  >
                    <OpenFolderButton serverKey={props.hostId} keys={props.current() === props.hostId} />
                  </Show>
                </Show>
                <Show when={runtime()}>
                  {(current) => (
                    <div
                      classList={{ "opacity-60": status()?.stale }}
                      data-testid="host-sessions"
                      data-stale={status()?.stale ? "true" : "false"}
                    >
                      {props.list(current(), top, props.last)}
                    </div>
                  )}
                </Show>
              </>
            )}
          </Section>
        </div>
      )}
    </Show>
  )
}

/** Another PC's own-web opens in its own window, so nothing of its sessions is listed here (08 §4.1). */
function PcSection(props: { readonly pcKey: string }) {
  const text = useRemotePcText()
  const store = () => remotePcStore()
  const pc = () =>
    store()
      ?.pcs()
      .find((item) => item.pcKey === props.pcKey)
  const open = () => store()?.open(props.pcKey)
  return (
    <Show when={pc()}>
      {(view) => {
        const label = () => text(`own.remotePc.state.${view().state}`)
        const items = (): MenuItem[] => [
          { label: text("own.remotePc.action.open"), testid: "remote-pc-menu-open", onSelect: open },
          ...(view().state === "reauth"
            ? [
                {
                  label: text("own.remotePc.action.reconnect"),
                  testid: "remote-pc-menu-reconnect",
                  onSelect: () => openRemotePcDialog({ kind: "add", pcKey: props.pcKey }),
                },
              ]
            : []),
          "separator",
          {
            label: text("own.remotePc.action.remove"),
            tone: "danger",
            testid: "remote-pc-menu-remove",
            onSelect: () => openRemotePcDialog({ kind: "remove", pcKey: props.pcKey }),
          },
        ]
        return (
          <div data-testid="remote-pc" data-pc={props.pcKey} data-state={view().state}>
            <Section
              serverKey={`${PC}${props.pcKey}`}
              name={view().name}
              note={view().state === "connected" ? undefined : label()}
              noteTestid="remote-pc-state"
              status={{ ...PC_STATUS[view().state], label: label() }}
              items={items}
              menuLabel={text("own.remotePc.menu", { name: view().name })}
              menuTestid="remote-pc-menu"
              headerTestid="remote-pc-header"
              headed
              onOpen={{
                label: text("own.remotePc.open", { name: view().name }),
                title: `${view().name} · ${label()}`,
                testid: "remote-pc-open",
                run: () => void open(),
              }}
            />
          </div>
        )
      }}
    </Show>
  )
}

const PC_STATUS = {
  checking: { symbol: "◌", tone: "muted" },
  connected: { symbol: "●", tone: "ok" },
  unreachable: { symbol: "○", tone: "muted" },
  reauth: { symbol: "!", tone: "warn" },
} as const

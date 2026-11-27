// Session row `⋯` menu (03 §19.11): 고정 / 고정 해제, 보관 / 보관 해제 (both `prompt` scope), the peer items of a team
// conversation (06 §9.4, 동료: `역할 바꾸기…` and `동료에서 빼기` on a peer, `동료로 등록…` in an area's folder;
// team/enable.ts `peerItems`, opening their panels in the area menu; `이 대화를 담당으로` for a conversation that may
// take its area's seat, dimmed with the reason on a second line while another task of the team runs), 세션 ID 복사, and
// `삭제…` in the danger color
// (19.11a, `admin` scope: the confirmation of manage-dialog.tsx). One popover per tree, anchored at
// the `⋯` button of the row that opened it (rows render only the button, R1). Popover API as the other first-chunk
// menus (`servers/menu.tsx`): top layer, light dismiss, Esc; ↑/↓/Home/End move; the first item gets focus. The `⋯`
// button is the popover's source, so pressing it again closes the menu instead of reopening it.
import { createEffect, createUniqueId, For, on, Show } from "solid-js"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { useShell } from "@/shell/context"
import { showToast } from "@/switcher/toast"
import { openPeerItem, PEER_ITEM_KEYS, peerItems, seatBlock, teamLabel } from "@/team/enable"
import { useSidebar } from "./context"
import type { FlagKey } from "./flags"
import { openSessionDelete } from "./manage-host"
import { rowKey } from "./model"
import { useSidebarText, type SidebarKey } from "./strings"

interface Item {
  readonly label: string
  readonly run: () => void
  readonly testid: string
  /** A rule above it. */
  readonly separated?: boolean
  readonly danger?: boolean
  /** Why the item cannot run now: it is dimmed, says so under its label and does nothing. */
  readonly blocked?: string
}

const FAILED: Record<FlagKey, readonly [on: SidebarKey, off: SidebarKey]> = {
  pinned: ["own.sidebar.pinFailed", "own.sidebar.unpinFailed"],
  archived: ["own.sidebar.archiveFailed", "own.sidebar.unarchiveFailed"],
}

export function RowMenu() {
  const ctl = useSidebar()
  const shell = useShell()
  const i18n = useI18n()
  const text = useSidebarText()
  const id = createUniqueId()
  let popover!: HTMLDivElement
  const buttons = () => [...popover.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
  const opened = () => popover.matches(":popover-open")

  createEffect(
    on(ctl.menu, (menu) => {
      if (!menu) {
        if (opened()) popover.hidePopover()
        return
      }
      if (!opened()) show(menu.anchor)
      place(menu.anchor)
      nextFrame(() => buttons()[0]?.focus())
    }),
  )

  function show(anchor: HTMLElement) {
    try {
      // SAFETY: `source` (Chromium 133+) makes the `⋯` button the invoker, exempt from light dismiss; older engines
      // ignore the option.
      ;(popover.showPopover as (options?: { source?: HTMLElement }) => void)({ source: anchor })
    } catch {
      popover.showPopover()
    }
  }

  function place(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect()
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    popover.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`
    popover.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`
  }

  const title = (sessionID: string) => ctl.row(sessionID)?.title || i18n.t("own.shell.untitled")

  async function toggle(sessionID: string, key: FlagKey, on: boolean) {
    const ok = await ctl.setFlag(sessionID, key, on)
    if (!ok) return void showToast({ message: text(FAILED[key][on ? 0 : 1]), tone: "danger" })
    if (key !== "archived") return
    if (!on) return void showToast({ message: text("own.sidebar.unarchived", { title: title(sessionID) }) })
    showToast({
      message: text("own.sidebar.archived", { title: title(sessionID) }),
      action: { label: text("own.sidebar.archivedUndo"), run: () => void toggle(sessionID, "archived", false) },
    })
  }

  function copy(sessionID: string) {
    void navigator.clipboard
      ?.writeText(sessionID)
      .then(() => showToast({ message: text("own.sidebar.copied") }))
      .catch(() => undefined)
  }

  const items = (): Item[] => {
    const menu = ctl.menu()
    if (!menu) return []
    const sessionID = menu.sessionID
    const archived = ctl.archived(sessionID)
    const pinned = ctl.pinned(sessionID)
    const peer = peerItems(ctl.runtime, { sessionID, directory: ctl.row(sessionID)?.directory })
    const flag = ctl.canFlag()
    return [
      // 03 §4.1.1 `분할해서 열기` (also Ctrl+click on the row): beside the focused pane.
      ...(shell.splitCapable()
        ? [
            {
              label: text("own.sidebar.openBeside"),
              testid: "row-open-beside",
              run: () => shell.openBeside({ name: "session", serverKey: ctl.serverKey, sessionID }),
            },
          ]
        : []),
      ...(archived || !flag
        ? []
        : [
            {
              label: text(pinned ? "own.sidebar.unpin" : "own.sidebar.pin"),
              testid: "row-pin",
              run: () => void toggle(sessionID, "pinned", !pinned),
            },
          ]),
      ...(flag
        ? [
            {
              label: text(archived ? "own.sidebar.unarchive" : "own.sidebar.archive"),
              testid: "row-archive",
              run: () => void toggle(sessionID, "archived", !archived),
            },
          ]
        : []),
      ...(peer
        ? peer.items.flatMap((item) => {
            const label = teamLabel(i18n.locale(), PEER_ITEM_KEYS[item])
            const run = () => openPeerItem(ctl.serverKey, peer, item, menu.anchor)
            const block = item === "seat" ? seatBlock(ctl.runtime.team, peer.teamID) : undefined
            const blocked = block && teamLabel(i18n.locale(), block)
            return label ? [{ label, testid: `row-peer-${item}`, run, blocked }] : []
          })
        : []),
      { label: text("own.sidebar.copyID"), testid: "row-copy-id", run: () => copy(sessionID), separated: true },
      ...(ctl.canDelete()
        ? [
            {
              label: text("own.sidebar.delete"),
              testid: "row-delete",
              separated: true,
              danger: true,
              run: () =>
                openSessionDelete({
                  serverKey: ctl.serverKey,
                  sessions: [{ id: sessionID, title: title(sessionID) }],
                  archivedOnly: archived,
                }),
            },
          ]
        : []),
    ]
  }

  function returnFocus(sessionID: string) {
    const row = document.querySelector<HTMLElement>(`[data-key="${CSS.escape(rowKey.session(sessionID))}"]`)
    row?.focus({ preventScroll: true })
  }

  return (
    <div
      ref={popover}
      id={id}
      popover="auto"
      role="menu"
      aria-label={ctl.menu() ? text("own.sidebar.rowMenu", { title: title(ctl.menu()!.sessionID) }) : undefined}
      class="m-0 min-w-[180px] rounded-lg border border-own-border bg-own-bg-raised p-1 text-[13px] text-own-text shadow-[var(--own-shadow-float)]"
      style={{ position: "fixed", inset: "auto" }}
      data-testid="row-menu"
      onToggle={(event) => {
        if (event.newState === "open") return
        const menu = ctl.menu()
        if (!menu) return
        const inside = popover.contains(document.activeElement) || document.activeElement === document.body
        ctl.closeMenu()
        if (inside) returnFocus(menu.sessionID)
      }}
      onKeyDown={(event) => {
        // The popover closes itself on Esc; keep the key from also closing the drawer around the sidebar.
        if (event.code === "Escape") return event.stopPropagation()
        const list = buttons()
        const index = list.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          event.code === "ArrowDown"
            ? (index + 1) % list.length
            : event.code === "ArrowUp"
              ? (index - 1 + list.length) % list.length
              : event.code === "Home"
                ? 0
                : event.code === "End"
                  ? list.length - 1
                  : -1
        if (next < 0) return
        event.preventDefault()
        list[next]?.focus()
      }}
    >
      <Show when={ctl.menu()}>
        {(menu) => (
          <For each={items()}>
            {(item, index) => (
              <>
                <Show when={index() > 0 && item.separated}>
                  <hr class="my-1 border-0 border-t border-own-border" />
                </Show>
                <button
                  type="button"
                  role="menuitem"
                  // aria-disabled, not disabled: a blocked item keeps keyboard focus so its reason is read.
                  aria-disabled={item.blocked ? true : undefined}
                  class={`flex w-full flex-col items-start rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-own-hover focus-visible:bg-own-hover ${item.danger ? "text-own-danger" : item.blocked ? "text-own-muted" : "text-inherit"}`}
                  data-testid={item.testid}
                  onClick={() => {
                    if (item.blocked) return
                    const sessionID = menu().sessionID
                    ctl.closeMenu()
                    returnFocus(sessionID)
                    item.run()
                  }}
                >
                  {item.label}
                  <Show when={item.blocked}>
                    <span class="text-[11.5px] text-own-muted" data-testid={`${item.testid}-blocked`}>
                      {item.blocked}
                    </span>
                  </Show>
                </button>
              </>
            )}
          </For>
        )}
      </Show>
    </div>
  )
}

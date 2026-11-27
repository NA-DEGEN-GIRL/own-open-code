// Work panel (03 §4.7): tabs 리뷰 / 파일 / 터미널 / 브라우저 / 계정·한도, and 팀 룸 on a team conversation (06 §9.9,
// src/team/room). Tab content is a lazy chunk loaded on first
// open (R5), stays mounted while hidden (terminal scrollback, browser tabs) and is told when it is not visible so it
// can stop rAF loops and observers. The 파일 tab is src/files through src/adapter/files.tsx (19.4). Tab badges (4.7):
// 리뷰 = files the last turn changed (review module, until the tab showed the session), 터미널 = running PTYs.
import { createEffect, For, lazy, Show, Suspense, type Component } from "solid-js"
import { BrowserTabBadge } from "@/browser/badge"
import type { ServerKey } from "@/data"
import { useI18n, type I18nKey } from "@/i18n"
import { routeServer } from "@/routing/routes"
import { reviewBadgeCount, reviewText, watchReviewTurns } from "@/review"
import { terminalRunning } from "@/terminal/intents"
import { useShell, type PanelTab } from "./context"
import { Icon } from "./icons"

export interface PanelTabProps {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}

/** Tab modules. Owners of review/files/terminal/browser replace their loader here when their module lands. */
const LOADERS: Record<PanelTab, () => Promise<{ default: Component<PanelTabProps & { tab: PanelTab }> }>> = {
  review: () => import("@/adapter/review"),
  files: () => import("@/adapter/files"),
  terminal: () => import("@/terminal/panel-tab"),
  browser: () => import("@/browser"),
  accounts: () => import("@/limits/panel-tab"),
  team: () => import("@/team/room/panel-tab"),
}
const CONTENT: Record<PanelTab, Component<PanelTabProps & { tab: PanelTab }>> = {
  review: lazy(LOADERS.review),
  files: lazy(LOADERS.files),
  terminal: lazy(LOADERS.terminal),
  browser: lazy(LOADERS.browser),
  accounts: lazy(LOADERS.accounts),
  team: lazy(LOADERS.team),
}

export const TAB_LABEL: Record<PanelTab, I18nKey> = {
  review: "own.panel.review",
  files: "own.panel.files",
  terminal: "own.panel.terminal",
  browser: "own.panel.browser",
  accounts: "own.panel.accounts",
  team: "own.panel.team",
}

export function WorkPanel() {
  const shell = useShell()
  const i18n = useI18n()
  const serverKey = () => {
    const route = shell.workspaceRoute()
    return routeServer(route)
  }
  const sessionID = () => {
    const route = shell.workspaceRoute()
    return route.name === "session" ? route.sessionID : undefined
  }
  createEffect(() => {
    if (shell.panelOpen()) shell.ensureOpened(shell.tab())
  })
  watchReviewTurns({ serverKey, sessionID })
  const badge = (tab: PanelTab): { readonly count: number; readonly label: string } | undefined => {
    if (tab === "review") {
      const id = sessionID()
      const count = id ? reviewBadgeCount(serverKey(), id) : undefined
      return count ? { count, label: reviewText(i18n.locale(), "own.review.badge", { count }) } : undefined
    }
    if (tab === "terminal") {
      const count = terminalRunning()
      return count ? { count, label: i18n.t("own.panel.terminalRunning", { n: count }) } : undefined
    }
    return undefined
  }
  const move = (event: KeyboardEvent) => {
    const tabs = shell.tabs()
    const index = tabs.indexOf(shell.tab())
    const delta = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0
    if (!delta || event.isComposing) return
    event.preventDefault()
    const next = tabs[(index + delta + tabs.length) % tabs.length]!
    shell.selectTab(next)
    document.getElementById(`own-tab-${next}`)?.focus()
  }
  return (
    <>
      <div class="own-panel-head">
        <div class="own-tabs" role="tablist" aria-label={i18n.t("own.panel.label")} onKeyDown={move}>
          <For each={shell.tabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="own-tab"
                id={`own-tab-${tab}`}
                aria-controls={`own-tabpanel-${tab}`}
                aria-selected={shell.tab() === tab}
                tabIndex={shell.tab() === tab ? 0 : -1}
                onClick={() => shell.selectTab(tab)}
              >
                {i18n.t(TAB_LABEL[tab])}
                <Show when={badge(tab)}>
                  {(value) => (
                    <span class="own-tab-badge" aria-label={value().label} data-testid={`tab-badge-${tab}`}>
                      {value().count}
                    </span>
                  )}
                </Show>
                <Show when={tab === "browser"}>
                  <BrowserTabBadge serverKey={serverKey} sessionID={sessionID} />
                </Show>
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="own-icon-button mr-1"
          aria-label={i18n.t("own.panel.close")}
          onClick={() => shell.closePanel()}
        >
          <Icon name="x" />
        </button>
      </div>
      <For each={shell.tabs()}>
        {(tab) => {
          const Content = CONTENT[tab]
          const visible = () => shell.panelOpen() && shell.tab() === tab
          return (
            <Show when={shell.opened().has(tab)}>
              <div
                role="tabpanel"
                class="own-tabpanel"
                id={`own-tabpanel-${tab}`}
                aria-labelledby={`own-tab-${tab}`}
                hidden={shell.tab() !== tab}
              >
                <Suspense fallback={<p class="own-placeholder">{i18n.t("own.shell.loading")}</p>}>
                  <Content tab={tab} serverKey={serverKey} sessionID={sessionID} visible={visible} />
                </Suspense>
              </div>
            </Show>
          )
        }}
      </For>
    </>
  )
}

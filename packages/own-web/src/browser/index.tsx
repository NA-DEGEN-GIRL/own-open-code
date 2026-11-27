// Work panel 브라우저 tab (03 §4.7, §18.17, 05 §8). Its own lazy chunk; the attachment itself lives in attach.tsx so
// the agent's tools work before this tab is ever opened. The pane is new code (03 §18.17 "새로 쓴다"); upstream's
// session/browser/pane.tsx was the behavioral reference.
//  - Tabs of the session (agent and user tabs on one row), address bar (IME-safe Enter), back/forward/reload, open in
//    the external browser.
//  - Agent activity (activity.ts): "● 에이전트가 조작 중 · 클릭 · e12" while the agent drives the session's browser, a
//    `●` on the tab it targets, and "멈추고 직접 조작": interrupts the turn and leaves the browser to the user. A tab the
//    user drives while the agent is active is marked as the user's (03 §18.17).
//  - The page is a native WebContentsView above the DOM: the surface element's bounds go to main once per frame
//    (ResizeObserver / window resize / any scroll → rAF, R-D11), multiplied by the window zoom (main works in
//    device-independent pixels × zoom).
//  - 4.7.2: while a portal overlay (dialog, menu, listbox) intersects the surface, the view is hidden and a capture of
//    it stands in; the view is also hidden whenever the tab or the page is not visible.
//  - Downloads (05 §8.4, downloads.ts): the session's list with `PC에 저장`; closing a tab that holds unsaved files
//    asks first ("저장하지 않은 파일 {n}개가 지워집니다"), because the shell deletes them with the tab.
//  - A conversation on an SSH host (05 §8.6) has the same pane: its `localhost` is the host's (the host's tunnel),
//    other sites load from this PC. A page that did not load (the proxy's 502, Chromium's error) and a host whose link
//    is down show why in the surface, in place of the view, with `다시 로드`; tabs come back when the link does.
//  - Tool-list rule (03 §18.15, 05 §8.7, 01 §10.1): a session created without the browser tools shows why, in the
//    pane's place, and never gets them back by being opened here; turning them on is the explicit
//    "이 세션에서 켜기", written by the router (`session.approval.set{browserTool:"on"}`, enable.ts).
//  - Split panes (03 §4.1.1): one panel per browser pane, each session's view at its own bounds, so several are on
//    screen at once. `frozen` (a pane divider being dragged) hides the view behind a still of it, like an overlay; a
//    click inside the native view, which the DOM never sees, comes back from the host (`onViewFocus`) and focuses
//    the pane whose surface holds it.
import "./browser.css"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { LOCAL, useData } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { enableReasonKey, usePolicyText } from "@/policy"
import { browserRemoved } from "@/policy/browser"
import type { PanelTab } from "@/shell/context"
import type { PanelTabProps } from "@/shell/work-panel"
import type { ActionKey } from "./activity"
import { normalizeAddress } from "./address"
import { windowAttachments, type SessionAttachment } from "./attachments"
import { formatBytes, windowDownloads, type PaneDownload } from "./downloads"
import { browserEnableWriter, createBrowserEnable, type SessionRules } from "./enable"
import { windowActivity } from "./registry"
import { useBrowserText, type BrowserKey } from "./strings"
import { browserPlatform, type BrowserPaneCommand, type BrowserTab } from "./types"

export { normalizeAddress } from "./address"

export interface BrowserPanelProps extends PanelTabProps {
  readonly tab: PanelTab
  /** Hide the native view behind a still of it (03 §4.1.1: a pane divider is being dragged). */
  readonly frozen?: () => boolean
  /** The user clicked inside this panel's native view (host `onViewFocus`). */
  readonly onViewFocus?: () => void
}

export default function BrowserPanel(props: BrowserPanelProps) {
  const host = useHost()
  const i18n = useI18n()
  const text = useBrowserText()
  const data = useData()
  const info = () => {
    const sessionID = props.sessionID()
    return sessionID ? data.get(props.serverKey())?.data.session.get(sessionID) : undefined
  }
  // Rule 1's creation deny (policy/browser.ts): the tools are not in this session's catalog.
  const removed = createMemo(() => {
    const current = info()
    return !!current && browserRemoved(current.permissions)
  })
  // Not before the session's rules are known, and never for a removed one: since 82bb5ff88a an attachment appends
  // `browser allow` to the session's rules, which would turn the tools on after all (rule 2, attach.tsx).
  const attachment = createMemo(() => {
    const sessionID = props.sessionID()
    const registry = windowAttachments()
    if (!sessionID || !registry || !info() || removed()) return undefined
    return registry.ensure(props.serverKey(), sessionID)
  })
  // An address typed in a session without the browser tools waits for "켜고 열기": the pane that replaces `Removed`
  // once the rules land opens it in a new tab. Kept here because `Removed` unmounts at that moment.
  const [queued, setQueued] = createSignal<{
    readonly sessionID: string
    readonly url: string
    readonly typed: string
  }>()
  const queuedFor = (sessionID: string) => {
    const current = queued()
    return current?.sessionID === sessionID ? current : undefined
  }
  return (
    <div class="own-browser" data-testid="tab-browser">
      <Show
        when={browserPlatform(host)}
        fallback={<p class="own-placeholder">{i18n.t("own.panel.browserOnlyDesktop")}</p>}
      >
        <Show
          when={props.sessionID()}
          fallback={
            <Inert
              testid="browser-no-session"
              placeholder={text("own.browserPane.address.noSession")}
              note={text("own.browserPane.noSession")}
            />
          }
        >
          <Show
            when={!removed()}
            fallback={
              <Removed
                serverKey={props.serverKey()}
                sessionID={props.sessionID()!}
                rules={info()?.permissions ?? undefined}
                queued={queuedFor(props.sessionID()!)}
                queue={(address) => setQueued(address && { sessionID: props.sessionID()!, ...address })}
              />
            }
          >
            <Show
              when={attachment()}
              keyed
              fallback={<Inert testid="browser-connecting" placeholder={text("own.browserPane.connecting")} />}
            >
              {(current) => (
                <Pane
                  attachment={current}
                  visible={props.visible}
                  frozen={props.frozen}
                  onViewFocus={props.onViewFocus}
                  open={() => queuedFor(current.sessionID)?.url}
                  opened={() => setQueued(undefined)}
                />
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

/**
 * The pane's frame where no browser opens yet (no session, still connecting): the address bar is there but read-only,
 * and its placeholder says why in one line.
 */
function Inert(props: { readonly testid: string; readonly placeholder: string; readonly note?: string }) {
  return (
    <div class="own-browser-pane" data-testid={props.testid}>
      <AddressBar placeholder={props.placeholder} inert />
      <div class="own-browser-surface">
        <Show when={props.note}>
          {(note) => (
            <div class="own-browser-empty">
              <p class="m-0">{note()}</p>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

function Pane(props: {
  readonly attachment: SessionAttachment
  readonly visible: () => boolean
  readonly frozen?: () => boolean
  readonly onViewFocus?: () => void
  /** An address typed before this pane could open it (`Removed` → "켜고 열기"): opened in a new tab on mount. */
  readonly open?: () => string | undefined
  readonly opened?: () => void
}) {
  const host = useHost()
  const data = useData()
  const text = useBrowserText()
  const attachment = props.attachment
  const sessionID = attachment.sessionID
  const state = attachment.state
  const runtime = () => data.get(attachment.serverKey)
  /** An SSH host whose link is down here: nothing can load, and the pane says so instead of a blank page. */
  const offline = () => attachment.serverKey !== LOCAL && runtime()?.connection.status() !== "connected"
  const tracker = () => windowActivity().get(attachment.serverKey)
  const phase = () => tracker()?.phase(sessionID) ?? "idle"
  const agentActive = () => phase() === "operating" || phase() === "recent"
  const lastCall = () => tracker()?.last(sessionID)
  const agentTab = () => (agentActive() ? tracker()?.agentTab(sessionID) : undefined)
  const turnRunning = () => runtime()?.data.session.status(sessionID) === "running"
  const [stopping, setStopping] = createSignal(false)
  const downloads = () => windowDownloads()?.list(attachment.serverKey, sessionID) ?? []
  const [closing, setClosing] = createSignal<{ readonly tabID: string; readonly count: number }>()
  const [saveNotice, setSaveNotice] = createSignal<BrowserKey>()
  const tabs = () => state().browser?.tabs ?? []
  const focused = createMemo<BrowserTab | undefined>(() => {
    const browser = state().browser
    if (!browser) return undefined
    return browser.tabs.find((tab) => tab.id === browser.focusedTabID) ?? browser.tabs[0]
  })
  const [failed, setFailed] = createSignal<string>()
  /** The focused tab's page did not load and is not loading again: the surface says why instead of the view. */
  const unloaded = () => {
    const tab = focused()
    return tab && !tab.loading && tab.loadError ? tab : undefined
  }
  const [zoom, setZoom] = createSignal(1)
  const [pageVisible, setPageVisible] = createSignal(document.visibilityState === "visible")
  const [covered, setCovered] = createSignal(false)
  const [still, setStill] = createSignal<string>()
  const frozen = () => !!props.frozen?.()
  /** Behind a still: an overlay intersects the surface, or a pane divider is being dragged. */
  const held = () => covered() || frozen()
  let surface: HTMLDivElement | undefined
  /** Bounds of the view as last placed on screen (window DIPs × zoom), for the host's view focus event. */
  let placed: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined
  let root: HTMLDivElement | undefined

  const send = (command: BrowserPaneCommand) => {
    setFailed(undefined)
    tracker()?.userCommand(sessionID, "tabID" in command ? command.tabID : focused()?.id)
    void attachment.command(command).catch((error: unknown) => {
      const message = reason(error)
      // A navigation superseded by a newer one (user typed again, agent navigated) is not a failure.
      if (!/ERR_ABORTED/.test(message)) setFailed(message)
    })
  }
  const withTab = (make: (tabID: string) => BrowserPaneCommand) => {
    const tab = focused()
    if (tab) send(make(tab.id))
  }
  // With no tab open, the address opens a new user tab (main creates it, then navigates).
  const go = (url: string) => {
    const tab = focused()
    send(tab ? { type: "navigate", tabID: tab.id, url } : { type: "tabs.open", url, focus: true })
  }
  // 8.4: the shell deletes a tab's downloads with the tab, so unsaved ones are named before it closes.
  const closeTab = (tabID: string) => {
    const unsaved = windowDownloads()?.unsaved(attachment.serverKey, sessionID, tabID) ?? []
    if (unsaved.length) return setClosing({ tabID, count: unsaved.length })
    send({ type: "tabs.close", tabID })
  }
  const closeAnyway = () => {
    const target = closing()
    setClosing(undefined)
    if (target) send({ type: "tabs.close", tabID: target.tabID })
  }
  const saveDownload = async (id: string) => {
    const store = windowDownloads()
    if (!store) return false
    setSaveNotice(undefined)
    const result = await store.save(id).catch(() => ({ ok: false as const, reason: "failed" as const }))
    if (result.ok) return true
    if (result.reason === "gone") setSaveNotice("own.browserPane.download.gone")
    else if (result.reason !== "canceled") setSaveNotice("own.browserPane.download.saveFailed")
    return false
  }
  const saveAndClose = async () => {
    const target = closing()
    const store = windowDownloads()
    if (!target || !store) return
    for (const entry of store.unsaved(attachment.serverKey, sessionID, target.tabID))
      if (!(await saveDownload(entry.download.id))) return
    closeAnyway()
  }
  // "멈추고 직접 조작": stop the turn first (the plugin cancels its pending browser request), then hand over.
  const takeover = async () => {
    if (stopping()) return
    setStopping(true)
    setFailed(undefined)
    try {
      if (turnRunning()) await runtime()?.client().session.interrupt({ sessionID })
      tracker()?.takeover(sessionID, focused()?.id)
    } catch (error) {
      setFailed(`${text("own.browserPane.agent.takeoverFailed")} ${error instanceof Error ? error.message : ""}`.trim())
    } finally {
      setStopping(false)
    }
  }

  // Window zoom: main expects bounds in CSS pixels × zoom factor (upstream pane.tsx does the same).
  const zoomControl = host.window?.zoom
  if (zoomControl) {
    void zoomControl
      .get()
      .then(setZoom)
      .catch(() => undefined)
    onCleanup(zoomControl.onChange(setZoom))
  }

  // Layout: coalesced to one message per frame, skipped when nothing changed.
  let frame = 0
  let last = ""
  const apply = () => {
    frame = 0
    const tab = focused()
    const shown = props.visible() && pageVisible() && !held() && !!tab && !!surface && !unloaded() && !offline()
    if (!shown || !tab || !surface) {
      if (last !== "hidden") attachment.setLayout(tab ? { tabID: tab.id, visible: false } : undefined)
      last = "hidden"
      placed = undefined
      return
    }
    const rect = surface.getBoundingClientRect()
    const factor = zoom()
    const bounds = {
      x: Math.round(rect.left * factor),
      y: Math.round(rect.top * factor),
      width: Math.max(0, Math.round(rect.width * factor)),
      height: Math.max(0, Math.round(rect.height * factor)),
    }
    const next = `${tab.id}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${window.devicePixelRatio}`
    if (next === last) return
    last = next
    placed = bounds
    attachment.setLayout({ tabID: tab.id, visible: true, bounds, background: background(surface) })
  }
  const sync = () => {
    if (!frame) frame = requestAnimationFrame(apply)
  }
  // The agent strip and banners move the surface without resizing the window.
  createEffect(on([focused, props.visible, pageVisible, covered, frozen, zoom, phase, () => !!banner(), offline], sync))
  // A divider drag starts: the still stands in before the view hides (the hide waits for the next frame).
  createEffect(
    on(
      frozen,
      (value) => {
        if (value && props.visible() && !covered()) void captureStill()
      },
      { defer: true },
    ),
  )

  // 4.7.2 overlap: portaled overlays are children of <body>; observe only that level (cheap during streaming).
  const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-own-overlay]'
  let checkFrame = 0
  const check = () => {
    checkFrame = 0
    if (!surface || !props.visible()) return setCovered(false)
    const rect = surface.getBoundingClientRect()
    const hit = [...document.body.querySelectorAll<HTMLElement>(OVERLAY)].some(
      (element) => !surface!.contains(element) && intersects(element.getBoundingClientRect(), rect),
    )
    if (hit === covered()) return
    if (hit) void captureStill()
    setCovered(hit)
  }
  const captureStill = async () => {
    const tab = focused()
    const blob = tab ? await attachment.capture(tab.id).catch(() => null) : null
    setStill((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return blob ? URL.createObjectURL(blob) : undefined
    })
  }
  createEffect(
    on(held, (value) => {
      if (value) return
      setStill((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return undefined
      })
    }),
  )

  onMount(() => {
    const resize = new ResizeObserver(sync)
    if (surface) resize.observe(surface)
    if (root) resize.observe(root)
    const overlays = new MutationObserver(() => {
      if (!checkFrame) checkFrame = requestAnimationFrame(check)
    })
    overlays.observe(document.body, { childList: true })
    const visibility = () => setPageVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("resize", sync)
    // Any scrolling ancestor (the panel, a narrow window) moves the surface; capture sees every scroller.
    window.addEventListener("scroll", sync, { capture: true, passive: true })
    // A click in the native view: the host reports the focused view's bounds; ours holds its centre.
    const stopFocus = browserPlatform(host)?.onViewFocus?.((bounds) => {
      const current = placed
      if (!current) return
      const x = bounds.x + bounds.width / 2
      const y = bounds.y + bounds.height / 2
      if (x >= current.x && x <= current.x + current.width && y >= current.y && y <= current.y + current.height)
        props.onViewFocus?.()
    })
    attachment.wake()
    // The command waits for the registration (host adapter), so it can go right away.
    const pending = props.open?.()
    if (pending) {
      props.opened?.()
      send({ type: "tabs.open", url: pending, focus: true })
    }
    sync()
    onCleanup(() => {
      stopFocus?.()
      resize.disconnect()
      overlays.disconnect()
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("resize", sync)
      window.removeEventListener("scroll", sync, { capture: true })
      cancelAnimationFrame(frame)
      cancelAnimationFrame(checkFrame)
      attachment.setLayout(undefined)
      const url = still()
      if (url) URL.revokeObjectURL(url)
    })
  })

  function banner() {
    const current = state()
    if (current.blocked === "replaced") return text("own.browserPane.replaced")
    if (current.blocked === "unsupported") return text("own.browserPane.unsupported")
    // The surface says it (`offline` below).
    if (offline()) return undefined
    if (current.suspended) return text("own.browserPane.suspended")
    if (failed()) return text("own.browserPane.failed")
    return undefined
  }

  return (
    <div
      class="own-browser-pane"
      ref={root}
      data-testid="browser-pane"
      data-attached={state().attached ? "" : undefined}
      data-agent={phase()}
    >
      <div class="own-browser-tabs" role="tablist" aria-label={text("own.browserPane.address")}>
        <For each={tabs()}>
          {(tab) => (
            <div class="own-browser-tab" role="presentation" data-active={tab.id === focused()?.id ? "" : undefined}>
              <button
                type="button"
                role="tab"
                class="own-browser-tab-label"
                aria-selected={tab.id === focused()?.id}
                title={tab.url}
                onClick={() => send({ type: "tabs.focus", tabID: tab.id })}
              >
                <Show when={tab.loading}>
                  <span class="own-browser-spinner" aria-label={text("own.browserPane.loading")} />
                </Show>
                <span class="own-browser-tab-title">
                  {tab.title || hostOf(tab.url) || text("own.browserPane.untitled")}
                </span>
                <Show when={agentTab() === tab.id}>
                  <span
                    class="own-browser-tab-agent"
                    data-testid="browser-tab-agent"
                    role="img"
                    aria-label={text("own.browserPane.agent.tab")}
                    title={text("own.browserPane.agent.tab")}
                  >
                    ●
                  </span>
                </Show>
                <Show when={tracker()?.touched(sessionID, tab.id)}>
                  <span
                    class="own-browser-tab-user"
                    data-testid="browser-tab-user"
                    title={text("own.browserPane.user.tab")}
                  >
                    {text("own.browserPane.user.mark")}
                  </span>
                </Show>
              </button>
              <button
                type="button"
                class="own-icon-button own-browser-tab-close"
                aria-label={text("own.browserPane.closeTab", { title: tab.title || hostOf(tab.url) })}
                onClick={() => closeTab(tab.id)}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.browserPane.newTab")}
          data-testid="browser-new-tab"
          onClick={() => send({ type: "tabs.open", focus: true })}
        >
          +
        </button>
      </div>
      <Show when={phase() !== "idle"}>
        <div class="own-browser-agent" role="status" data-testid="browser-agent" data-phase={phase()}>
          <Show
            when={phase() !== "takeover"}
            fallback={
              <>
                <span class="own-browser-agent-label" data-testid="browser-takeover-state">
                  {text("own.browserPane.agent.takeover")}
                </span>
                <button
                  type="button"
                  class="own-icon-button own-browser-agent-dismiss"
                  aria-label={text("own.browserPane.agent.dismiss")}
                  onClick={() => tracker()?.release(sessionID)}
                >
                  ×
                </button>
              </>
            }
          >
            <span class="own-browser-agent-dot" aria-hidden="true" />
            <span class="own-browser-agent-label">{text("own.browserPane.agent.operating")}</span>
            <Show when={lastCall()}>
              {(call) => (
                <span class="own-browser-agent-action" data-testid="browser-agent-action" title={call().detail}>
                  {text(ACTION_TEXT[call().action as ActionKey] ?? "own.browserPane.action.other")}
                  {call().detail ? ` · ${call().detail}` : ""}
                </span>
              )}
            </Show>
            <Show when={turnRunning()}>
              <button
                type="button"
                class="own-btn own-browser-takeover"
                data-size="sm"
                data-testid="browser-takeover"
                title={text("own.browserPane.agent.takeoverHint")}
                disabled={stopping()}
                onClick={() => void takeover()}
              >
                {text("own.browserPane.agent.takeoverButton")}
              </button>
            </Show>
          </Show>
        </div>
      </Show>
      <AddressBar
        tab={focused()}
        placeholder={text("own.browserPane.address.placeholder")}
        onGo={go}
        onNav={(type) => withTab((tabID) => ({ type, tabID }))}
      />
      <Show when={closing()}>
        {(target) => (
          <div class="own-browser-banner" role="alert" data-testid="browser-close-unsaved">
            <span>{text("own.browserPane.closeUnsaved", { n: target().count })}</span>
            <span class="own-browser-banner-actions">
              <button type="button" class="own-btn" data-size="sm" onClick={() => void saveAndClose()}>
                {text("own.browserPane.download.save")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-testid="browser-close-anyway"
                onClick={closeAnyway}
              >
                {text("own.browserPane.closeAnyway")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-variant="ghost"
                onClick={() => setClosing(undefined)}
              >
                {text("own.browserPane.closeCancel")}
              </button>
            </span>
          </div>
        )}
      </Show>
      <Show when={banner()}>
        {(message) => (
          <div class="own-browser-banner" role="status" title={failed()} data-error={failed()}>
            <span>{message()}</span>
            <Show when={state().blocked === "replaced"}>
              <button type="button" class="own-btn" data-size="sm" onClick={() => attachment.unblock()}>
                {text("own.browserPane.reconnect")}
              </button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={downloads().length}>
        <div
          class="own-browser-downloads"
          data-testid="browser-downloads"
          aria-label={text("own.browserPane.downloads")}
        >
          <For each={downloads()}>
            {(entry) => (
              <DownloadRow
                entry={entry}
                save={(id) => void saveDownload(id)}
                dismiss={(id) => windowDownloads()?.dismiss(id)}
              />
            )}
          </For>
          <p class="own-browser-note own-browser-downloads-note">
            {saveNotice() ? text(saveNotice()!) : text("own.browserPane.downloadsNote")}
          </p>
        </div>
      </Show>
      <div
        class="own-browser-surface"
        ref={surface}
        data-testid="browser-surface"
        data-zoom={zoom()}
        data-covered={covered() ? "" : undefined}
      >
        <Show when={offline()}>
          <div
            class="own-browser-empty own-browser-failure"
            role="alert"
            data-testid="browser-offline"
            data-status={runtime()?.connection.status()}
          >
            <p class="m-0 own-browser-failure-title">
              {text(
                runtime()?.connection.status() === "reconnecting"
                  ? "own.browserPane.offline.title"
                  : "own.browserPane.offline.waiting",
              )}
            </p>
            <p class="own-browser-note">
              {text("own.browserPane.offline.body", { host: runtime()?.entry()?.label ?? attachment.serverKey })}
            </p>
          </div>
        </Show>
        <Show when={!offline() && !held() && unloaded()}>
          {(tab) => (
            <div class="own-browser-empty own-browser-failure" role="alert" data-testid="browser-load-failed">
              <p class="m-0 own-browser-failure-title">{text("own.browserPane.loadFailed.title")}</p>
              <p class="own-browser-note">
                {attachment.serverKey === LOCAL || !viaHost(tab().url, runtime()?.entry()?.label)
                  ? text("own.browserPane.loadFailed.local", { address: hostOf(tab().url) || tab().url })
                  : text("own.browserPane.loadFailed.host", {
                      address: hostOf(tab().url) || tab().url,
                      host: runtime()?.entry()?.label ?? attachment.serverKey,
                    })}
              </p>
              <p class="own-browser-note own-browser-failure-code" data-testid="browser-load-error">
                {tab().loadError}
              </p>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-testid="browser-load-retry"
                onClick={() => send({ type: "reload", tabID: tab().id })}
              >
                {text("own.browserPane.reload")}
              </button>
            </div>
          )}
        </Show>
        <Show when={!offline() && !tabs().length}>
          <div class="own-browser-empty" data-testid="browser-empty">
            <p class="m-0">{text("own.browserPane.empty")}</p>
            <p class="own-browser-note">{text("own.browserPane.emptyHint")}</p>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => send({ type: "tabs.open", focus: true })}
            >
              {text("own.browserPane.newTab")}
            </button>
            <p class="own-browser-note">{text("own.browserPane.permissions")}</p>
          </div>
        </Show>
        <Show when={held() && tabs().length}>
          <div class="own-browser-still">
            <Show when={still()} fallback={<span>{text("own.browserPane.hidden")}</span>}>
              {(url) => <img src={url()} alt={text("own.browserPane.hidden")} />}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

/**
 * Back, forward, reload, the address field and 외부 브라우저 (03 §18.17), in every frame of the pane that has a browser
 * or explains why not. The field shows the focused tab's URL until the user types; Enter (never inside an IME
 * composition, 12장) hands `normalizeAddress`'s result to `onGo`, or says the address does not open. `inert`: nothing
 * opens here; the field stays focusable (a pane's focus lands on it) and its placeholder is the one-line reason.
 */
function AddressBar(props: {
  readonly tab?: BrowserTab
  readonly placeholder: string
  readonly inert?: boolean
  readonly onGo?: (url: string, typed: string) => void
  readonly onNav?: (type: "back" | "forward" | "reload" | "stop") => void
}) {
  const host = useHost()
  const text = useBrowserText()
  const [address, setAddress] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [refused, setRefused] = createSignal(false)
  createEffect(() => {
    const url = props.tab?.url ?? ""
    if (!editing()) setAddress(url === "about:blank" ? "" : url)
  })
  const go = () => {
    const typed = address().trim()
    const url = normalizeAddress(typed)
    if (!url) return setRefused(typed !== "")
    setEditing(false)
    props.onGo?.(url, typed)
  }
  return (
    <>
      <div class="own-browser-bar" data-inert={props.inert ? "" : undefined}>
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.browserPane.back")}
          disabled={!props.tab?.canGoBack}
          onClick={() => props.onNav?.("back")}
        >
          ←
        </button>
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.browserPane.forward")}
          disabled={!props.tab?.canGoForward}
          onClick={() => props.onNav?.("forward")}
        >
          →
        </button>
        <button
          type="button"
          class="own-icon-button"
          aria-label={props.tab?.loading ? text("own.browserPane.stop") : text("own.browserPane.reload")}
          disabled={!props.tab}
          onClick={() => props.onNav?.(props.tab?.loading ? "stop" : "reload")}
        >
          {props.tab?.loading ? "✕" : "⟳"}
        </button>
        <input
          class="own-browser-address"
          type="text"
          inputmode="url"
          enterkeyhint="go"
          spellcheck={false}
          autocomplete="off"
          aria-label={text("own.browserPane.address")}
          data-testid="browser-address"
          readOnly={props.inert}
          placeholder={props.placeholder}
          title={props.inert ? props.placeholder : undefined}
          value={address()}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onInput={(event) => {
            setRefused(false)
            setAddress(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            // 12장: never act on Enter while an IME composition is open.
            if (props.inert || event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
            event.preventDefault()
            go()
          }}
        />
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.browserPane.external")}
          disabled={!/^https?:/i.test(props.tab?.url ?? "")}
          onClick={() => {
            const url = props.tab?.url
            if (url) host.openExternal(url)
          }}
        >
          ↗
        </button>
      </div>
      <Show when={refused()}>
        <p class="own-browser-address-note" role="status" data-testid="browser-address-refused">
          {text("own.browserPane.address.refused")}
        </p>
      </Show>
    </>
  )
}

const DOWNLOAD_STATE: Record<PaneDownload["download"]["state"], BrowserKey> = {
  progressing: "own.browserPane.download.progressing",
  completed: "own.browserPane.download.completed",
  failed: "own.browserPane.download.failed",
  cancelled: "own.browserPane.download.cancelled",
  removed: "own.browserPane.download.removed",
}

function DownloadRow(props: {
  readonly entry: PaneDownload
  readonly save: (id: string) => void
  readonly dismiss: (id: string) => void
}) {
  const text = useBrowserText()
  const download = () => props.entry.download
  const status = () => {
    const current = download()
    if (current.saved && current.state !== "removed") return text("own.browserPane.download.saved")
    if (current.state === "progressing" && current.total > 0)
      return `${text("own.browserPane.download.progressing")} ${Math.floor((current.bytes / current.total) * 100)}%`
    return text(DOWNLOAD_STATE[current.state])
  }
  return (
    <div class="own-browser-download" data-testid="browser-download" data-state={download().state}>
      <span class="own-browser-download-name" title={download().name}>
        {download().name}
      </span>
      <span class="own-browser-download-meta">
        {formatBytes(download().bytes)} · {status()}
      </span>
      <button
        type="button"
        class="own-btn"
        data-size="sm"
        data-testid="browser-download-save"
        disabled={download().state !== "completed"}
        onClick={() => props.save(download().id)}
      >
        {text("own.browserPane.download.save")}
      </button>
      <button
        type="button"
        class="own-icon-button own-browser-download-dismiss"
        aria-label={text("own.browserPane.download.dismiss")}
        onClick={() => props.dismiss(download().id)}
      >
        ×
      </button>
    </div>
  )
}

const ACTION_TEXT: Record<ActionKey, BrowserKey> = {
  open: "own.browserPane.action.open",
  focus: "own.browserPane.action.focus",
  close: "own.browserPane.action.close",
  list: "own.browserPane.action.list",
  navigate: "own.browserPane.action.navigate",
  back: "own.browserPane.action.back",
  forward: "own.browserPane.action.forward",
  reload: "own.browserPane.action.reload",
  stop: "own.browserPane.action.stop",
  read: "own.browserPane.action.read",
  find: "own.browserPane.action.find",
  click: "own.browserPane.action.click",
  hover: "own.browserPane.action.hover",
  drag: "own.browserPane.action.drag",
  fill: "own.browserPane.action.fill",
  select: "own.browserPane.action.select",
  check: "own.browserPane.action.check",
  press: "own.browserPane.action.press",
  scroll: "own.browserPane.action.scroll",
  wait: "own.browserPane.action.wait",
  screenshot: "own.browserPane.action.screenshot",
  dialog: "own.browserPane.action.dialog",
  evaluate: "own.browserPane.action.evaluate",
  files: "own.browserPane.action.files",
  inspect: "own.browserPane.action.inspect",
  measure: "own.browserPane.action.measure",
  preview: "own.browserPane.action.preview",
  other: "own.browserPane.action.other",
}

/**
 * In the pane's place for a session created without the browser tools (03 §18.15 rule 3, 05 §8.7): why, and
 * "이 세션에서 켜기" when the server's router can switch them on for this session (enable.ts); otherwise the way to get
 * a session with them. Turning them on re-lists the tools: the session's next request carries the catalog once more
 * and the cached prefix stays, which the confirmation says before anything is written.
 * No browser opens without them, not even for the user's own tabs: main pages exist only inside an attachment, whose
 * grant appends `browser allow` to the session's rules (policy/browser.ts rule 2). So the address bar is live only
 * while the switch is offered: an address typed there asks the confirmation and opens once the tools are on
 * ("켜고 열기", `queue`); otherwise the read-only field says why in one line.
 */
function Removed(props: {
  readonly serverKey: string
  readonly sessionID: string
  readonly rules: SessionRules
  readonly queued?: { readonly typed: string }
  readonly queue: (address: { readonly url: string; readonly typed: string } | undefined) => void
}) {
  const text = useBrowserText()
  const policy = usePolicyText()
  const enable = createBrowserEnable({
    writer: () => browserEnableWriter(props.serverKey),
    sessionID: () => props.sessionID,
    rules: () => props.rules,
  })
  const view = enable.view
  const live = () => view() === "offer" || view() === "confirm"
  // Cancelled, or no switch any more (another rule, the mode became `custom`): the address never opens later.
  createEffect(() => {
    if (view() !== "confirm" && view() !== "busy" && view() !== "done") props.queue(undefined)
  })
  const placeholder = (): BrowserKey => {
    if (live()) return "own.browserPane.address.removedOffer"
    if (view() === "busy" || view() === "done") return "own.browserPane.address.enabling"
    if (view() === "blocked") return "own.browserPane.address.blocked"
    return "own.browserPane.address.removed"
  }
  return (
    <div class="own-browser-pane" data-testid="browser-removed-pane">
      <AddressBar
        placeholder={view() === "checking" ? "" : text(placeholder())}
        inert={!live()}
        onGo={(url, typed) => {
          props.queue({ url, typed })
          enable.ask()
        }}
      />
      <div class="own-browser-removed" data-testid="browser-removed" data-state={view()}>
        <p class="own-browser-removed-title">{text("own.browserPane.removed")}</p>
        <p class="own-browser-note">{text("own.browserPane.removedWhy")}</p>
        <Switch>
          {/* The same words as the conversation's notice (policy/notice.tsx). */}
          <Match when={enable.reason()}>
            {(why) => (
              <p
                class="own-browser-note"
                role="status"
                data-testid={why() === "blocked" ? "browser-enable-blocked" : "browser-enable-new"}
                data-reason={why()}
              >
                {policy(enableReasonKey(why()))}
              </p>
            )}
          </Match>
          <Match when={view() === "offer"}>
            <button type="button" class="own-btn" data-size="sm" data-testid="browser-enable" onClick={enable.ask}>
              {text("own.browserPane.enable")}
            </button>
          </Match>
          <Match when={view() === "confirm" || view() === "busy"}>
            <div
              class="own-browser-confirm"
              role="group"
              aria-label={text("own.browserPane.enable")}
              data-testid="browser-enable-confirm"
            >
              <Show when={props.queued}>
                {(address) => (
                  <p class="own-browser-note own-browser-confirm-address" data-testid="browser-enable-address">
                    {text("own.browserPane.enableOpen", { address: address().typed })}
                  </p>
                )}
              </Show>
              <p class="own-browser-note">{text("own.browserPane.enableConfirm")}</p>
              <div class="own-browser-confirm-actions">
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-testid="browser-enable-apply"
                  disabled={view() === "busy"}
                  onClick={() => void enable.apply()}
                >
                  {text(props.queued ? "own.browserPane.enableApplyOpen" : "own.browserPane.enableApply")}
                </button>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-variant="ghost"
                  disabled={view() === "busy"}
                  onClick={enable.cancel}
                >
                  {text("own.browserPane.enableCancel")}
                </button>
              </div>
            </div>
          </Match>
        </Switch>
        <Show when={enable.failed()}>
          <p class="own-browser-note" role="alert">
            {text("own.browserPane.enableFailed")}
          </p>
        </Show>
      </div>
    </div>
  )
}

/** Main's failure text: IPC defects arrive as the cause of a generic "Desktop IPC handler failed" error. */
function reason(error: unknown): string {
  // Deepest message in the cause chain (Effect wraps the original, e.g. "An error occurred in Effect.tryPromise").
  let current: unknown = error
  let message = error instanceof Error ? error.message : String(error)
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const value = current as { message?: unknown; cause?: unknown }
    if (typeof value.message === "string" && value.message) message = value.message
    current = value.cause
  }
  return message
}

/**
 * Whether an SSH host's pane loaded `url` through the host (05 §8.6): the machine's own names, or the host's name as
 * the sidebar shows it. Only for the failure's wording; main decides the route.
 */
function viaHost(url: string, label: string | undefined) {
  const host = URL.parse(url)?.hostname.toLowerCase() ?? ""
  return (
    /^(?:(?:[a-z\d-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/.test(host) || host === label?.toLowerCase()
  )
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

function intersects(a: DOMRect, b: DOMRect) {
  return a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** The surface's own background as RGBA, so the native view's corners and loading frame match the theme. */
function background(element: HTMLElement): [number, number, number, number] | undefined {
  const match = getComputedStyle(element).backgroundColor.match(/rgba?\(([^)]+)\)/)
  if (!match) return undefined
  const [r, g, b, a] = match[1]!.split(",").map((part) => Number.parseFloat(part.trim()))
  if (![r, g, b].every((value) => Number.isFinite(value))) return undefined
  return [r!, g!, b!, Math.round((Number.isFinite(a) ? a! : 1) * 255)]
}

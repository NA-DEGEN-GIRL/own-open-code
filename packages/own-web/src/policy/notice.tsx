// What the UI says about the browser tool (01 §10.1, 05 §8.7): on the new-session screen of a window without the
// browser pane (rule 1 will remove it), on a session whose catalog has it but this window cannot run it (desktop
// session opened on the web), and on a session that started without it (web session opened in the desktop app, in the
// pane's place). Small and in the first chunk: no kit, reads the session's rules from createData.
// A session that started without it, on the desktop, says what the browser pane says (03 §18.15 rule 3): that it can
// be turned on here and the cache stays, or the plain reason it cannot (browser/enable.ts `reason`, a light module).
// A paired device (05 §8.10.5; its host has `remotePane`) is not "a window without the pane": the PC's desktop app
// holds its conversations' browser. While that app runs there is nothing to say; while it does not, the notice says
// the app must be running; a conversation that started without the tools points to its browser view (⋯ > 브라우저),
// which offers the switch.
import { createMemo, Show } from "solid-js"
import {
  browserEnableWriter,
  createBrowserEnable,
  type BrowserEnableReason,
  type BrowserEnableView,
} from "@/browser/enable"
import { LOCAL, useData, type ServerKey } from "@/data"
import { useHost } from "@/host"
import { browserPaneHeld, browserToolState, type BrowserHost, type BrowserToolState } from "./browser"
import { usePolicyText, type PolicyKey } from "./strings"

/** The session's state, or `undefined` for a session that is not loaded yet. */
export function useSessionBrowserTool(sessionID: () => string | undefined, serverKey: () => ServerKey = () => LOCAL) {
  const data = useData()
  const host = useHost()
  return createMemo<BrowserToolState | undefined>(() => {
    const id = sessionID()
    const runtime = data.get(serverKey())
    const info = id ? runtime?.data.session.get(id) : undefined
    return info ? browserToolState(info.permissions, { browserPane: browserPaneHeld(host) }) : undefined
  })
}

/**
 * - No `sessionID` (new-session screen): explains rule 1 where the pane is not held (the web fallback; a device whose
 *   PC has no desktop app running); nothing on desktop, nor on a device whose PC runs the app.
 * - A session: `no-pane` → "open it in the desktop app" (01 §10.1 banner), on a device "the PC's desktop app must be
 *   running"; `removed` in a window with the pane → "started without it" (05 §8.7 rule 3) and what the browser pane
 *   says next: it can be turned on here, or why not; `removed` on a device → "started without it" and where its
 *   switch is. Nothing otherwise.
 */
export function BrowserToolNotice(props: { readonly sessionID?: string; readonly serverKey?: ServerKey }) {
  const host = useHost()
  const text = usePolicyText()
  const state = useSessionBrowserTool(
    () => props.sessionID,
    () => props.serverKey ?? LOCAL,
  )
  const message = createMemo(() => browserNoticeKey(host, props.sessionID ? { state: state() } : undefined))
  return (
    <Show when={message()}>
      {(key) => (
        <p
          class="m-0 flex items-start gap-1.5 text-[12px] leading-[16px] text-own-muted"
          role="note"
          title={text("own.policy.browser.why")}
          data-testid="browser-tool-notice"
          data-kind={key()}
        >
          <span aria-hidden="true">ⓘ</span>
          <Show
            when={key() === "own.policy.browser.startedWithout" && props.sessionID}
            fallback={<span>{text(key())}</span>}
          >
            {(sessionID) => (
              <Show
                when={!host.remotePane}
                fallback={
                  <span>
                    {text("own.policy.browser.startedWithout")} {text("own.policy.browser.enableInViewer")}
                  </span>
                }
              >
                <StartedWithout sessionID={sessionID()} serverKey={props.serverKey ?? LOCAL} />
              </Show>
            )}
          </Show>
        </p>
      )}
    </Show>
  )
}

/**
 * Which line the notice shows. `session` is absent on the new-session screen, else it carries the shown session's
 * state (`undefined` while the session is not loaded).
 */
export function browserNoticeKey(
  host: BrowserHost,
  session: { readonly state: BrowserToolState | undefined } | undefined,
): PolicyKey | undefined {
  const absent = host.remotePane ? "own.policy.browser.needDesktop" : undefined
  if (!session) return browserPaneHeld(host) ? undefined : (absent ?? "own.policy.browser.newWeb")
  if (session.state === "no-pane") return absent ?? "own.policy.browser.openInDesktop"
  if (session.state === "removed" && (host.capabilities.browserPane || host.remotePane))
    return "own.policy.browser.startedWithout"
  return undefined
}

/** "Started without it" and what follows it, from the same switch state the browser pane reads (its own check). */
function StartedWithout(props: { readonly sessionID: string; readonly serverKey: ServerKey }) {
  const data = useData()
  const text = usePolicyText()
  const enable = createBrowserEnable({
    writer: () => browserEnableWriter(props.serverKey),
    sessionID: () => props.sessionID,
    rules: () => data.get(props.serverKey)?.data.session.get(props.sessionID)?.permissions ?? undefined,
  })
  const detail = () => startedWithoutDetail(enable.view(), enable.reason())
  return (
    <span data-enable={enable.view()}>
      {text("own.policy.browser.startedWithout")}
      <Show when={detail()}>{(key) => ` ${text(key())}`}</Show>
    </span>
  )
}

/**
 * The sentence after "이 대화는 브라우저 도구 없이 시작했어요." on the desktop: the switch is offered (or under way) →
 * it can be turned on here and the cache stays; no switch → the plain reason; still asking → nothing yet.
 */
export function startedWithoutDetail(
  view: BrowserEnableView,
  reason: BrowserEnableReason | undefined,
): PolicyKey | undefined {
  if (view === "offer" || view === "confirm" || view === "busy" || view === "done")
    return "own.policy.browser.canEnable"
  return reason ? enableReasonKey(reason) : undefined
}

/** Why the browser tools cannot be turned on in this session, as the pane and the notice both say it. */
export function enableReasonKey(reason: BrowserEnableReason): PolicyKey {
  return `own.policy.browser.cannot.${reason}`
}

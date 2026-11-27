// Session view states of a remote session (04 §12.2, §17.7): the route stays, the view gets an overlay, the composer is
// disabled by the runtime's connection status (and covered here), drafts are kept. Nothing for local sessions or a
// live host.
import { Match, Show, Switch } from "solid-js"
import type { ServerKey } from "@/data"
import { openRemoteDialog, remoteStore } from "./active"
import { overlayKind } from "./state"
import { useServersText } from "./strings"
import "./servers.css"

export function RemoteSessionOverlay(props: { readonly serverKey: () => ServerKey }) {
  const text = useServersText()
  const store = remoteStore
  const hostId = () => props.serverKey()
  const host = () => store()?.state.hosts[hostId()]
  const kind = () => {
    const current = store()
    const view = host()
    if (!current || !view) return undefined
    const live = current.state.endpoints[hostId()] ? current.runtime(hostId())?.connection.status() : undefined
    return overlayKind(view, live, current.clientId)
  }
  const run = (action: () => Promise<unknown> | undefined) => void action()?.catch(() => undefined)
  const reconnect = () => run(() => store()?.connect(hostId()))
  return (
    <Show when={kind()}>
      {(current) => (
        <div
          class="absolute inset-0 z-[6] grid place-items-center bg-[color-mix(in_srgb,var(--own-bg)_82%,transparent)] p-6"
          role="status"
          aria-live="polite"
          data-testid="remote-overlay"
          data-kind={current()}
        >
          <div class="flex max-w-[440px] flex-col items-center gap-3 rounded-[var(--own-radius-card)] border border-own-border bg-own-bg px-6 py-5 text-center shadow-[var(--own-shadow-float)]">
            <p class="m-0 text-[14px] font-medium text-own-text" data-testid="remote-overlay-text">
              <Switch>
                <Match when={current() === "reconnecting"}>{text("own.remote.overlay.disconnected")}</Match>
                <Match when={current() === "paused"}>{text("own.remote.overlay.paused")}</Match>
                <Match when={current() === "authentication"}>{text("own.remote.overlay.authentication")}</Match>
                <Match when={current() === "elsewhere"}>{text("own.remote.elsewhere")}</Match>
                <Match when={current() === "hostKey" && host()?.detail === "changed"}>
                  {text("own.remote.overlay.hostKeyChanged")}
                </Match>
                <Match when={current() === "hostKey"}>{text("own.remote.hostKey.unknown")}</Match>
                <Match when={current() === "incompatible"}>{text("own.remote.overlay.incompatible")}</Match>
                <Match when={current() === "needsInstall"}>{text("own.remote.overlay.needsInstall")}</Match>
                <Match when={current() === "otherOwner"}>{text("own.remote.overlay.otherOwner")}</Match>
                <Match when={current() === "failed"}>{text("own.remote.overlay.failed")}</Match>
              </Switch>
            </p>
            <Show when={current() === "failed" && host()?.error}>
              {(error) => (
                <p class="m-0 text-[12.5px] text-own-muted" data-testid="remote-overlay-error">
                  {text(`own.remote.error.${error()}`)}
                </p>
              )}
            </Show>
            <p class="m-0 text-[12px] text-own-faint">{text("own.remote.overlay.draft")}</p>
            <div class="flex flex-wrap justify-center gap-2">
              <Switch>
                <Match when={current() === "paused" || current() === "failed"}>
                  <button
                    type="button"
                    class="own-remote-btn own-target"
                    data-variant="primary"
                    data-testid="remote-overlay-reconnect"
                    onClick={reconnect}
                  >
                    {text("own.remote.action.reconnect")}
                  </button>
                </Match>
                <Match when={current() === "authentication"}>
                  <button
                    type="button"
                    class="own-remote-btn own-target"
                    data-variant="primary"
                    data-testid="remote-overlay-authenticate"
                    onClick={() => run(() => store()?.retry(hostId()))}
                  >
                    {text("own.remote.action.authenticate")}
                  </button>
                </Match>
                <Match when={current() === "elsewhere"}>
                  <button
                    type="button"
                    class="own-remote-btn own-target"
                    data-testid="remote-overlay-retry"
                    onClick={reconnect}
                  >
                    {text("own.remote.action.retryHere")}
                  </button>
                </Match>
                <Match when={current() === "hostKey" && host()?.detail !== "changed"}>
                  <button
                    type="button"
                    class="own-remote-btn own-target"
                    data-variant="primary"
                    data-testid="remote-overlay-hostkey"
                    onClick={() => openRemoteDialog({ kind: "add", hostId: hostId(), hostKey: true })}
                  >
                    {text("own.remote.action.checkHostKey")}
                  </button>
                </Match>
                <Match when={current() === "incompatible"}>
                  <button
                    type="button"
                    class="own-remote-btn own-target"
                    data-variant="primary"
                    data-testid="remote-overlay-update"
                    onClick={() => openRemoteDialog({ kind: "update", hostId: hostId() })}
                  >
                    {text("own.remote.action.update")}
                  </button>
                </Match>
                <Match when={current() === "needsInstall"}>
                  <button
                    type="button"
                    class="own-remote-btn own-target"
                    data-variant="primary"
                    data-testid="remote-overlay-install"
                    onClick={() => openRemoteDialog({ kind: "add", hostId: hostId() })}
                  >
                    {text("own.remote.action.install")}
                  </button>
                </Match>
                <Match when={current() === "otherOwner"}>
                  <button
                    type="button"
                    class="own-remote-btn own-target"
                    data-testid="remote-overlay-takeover"
                    onClick={() => openRemoteDialog({ kind: "takeover", hostId: hostId() })}
                  >
                    {text("own.remote.action.takeover")}
                  </button>
                </Match>
              </Switch>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}

// Connection and instance states (03 §8): the reconnect strip, the "다시 연결됨" flash and the unmanaged-instance
// screen. Session banners (limits, auth, billing) belong to the transcript/limits owners.
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"

export function ConnectionBanner() {
  const data = useData()
  const i18n = useI18n()
  const connection = data.local().connection
  const [flash, setFlash] = createSignal(false)
  let dropped = false
  createEffect(
    on(connection.status, (status) => {
      if (status === "reconnecting") dropped = true
      if (status !== "connected" || !dropped) return
      dropped = false
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 2_000)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  return (
    <>
      <Show when={data.hostError()}>
        {(reason) => (
          <div class="own-banner" data-tone="danger" role="alert" data-testid="banner-host">
            {i18n.t("own.desktop.startFailed")} <span class="text-own-muted">{reason()}</span>
          </div>
        )}
      </Show>
      <Show when={connection.status() === "reconnecting"}>
        <div class="own-banner" role="status" data-testid="banner-offline">
          {i18n.t("own.banner.offline", { n: connection.attempt() })}
        </div>
      </Show>
      <Show when={flash()}>
        <div class="own-banner" data-tone="ok" role="status" data-testid="banner-reconnected">
          {i18n.t("own.banner.reconnected")}
        </div>
      </Show>
    </>
  )
}

/** 03 §8 "관리되지 않는 인스턴스": RPC `own.accounts` missing or `health.guard` is skew/unmanaged. */
export function UnmanagedScreen() {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  return (
    <Show when={own.state.status === "unmanaged"}>
      <div class="own-banner" data-tone="danger" role="alert" data-testid="banner-unmanaged">
        <span>{i18n.t("own.state.unmanaged")}</span> <code class="font-mono">own restart</code>{" "}
        <button
          type="button"
          class="own-button ml-2 h-7"
          onClick={() => void navigator.clipboard?.writeText("own restart")}
        >
          {i18n.t("own.state.copyCommand")}
        </button>{" "}
        <button type="button" class="own-button h-7" onClick={() => void own.resync()}>
          {i18n.t("own.state.retry")}
        </button>
      </div>
    </Show>
  )
}

// The device side of pairing (05 §13.5 흐름, 03 §8 "인증 필요" for `auth:"device"`), shown by the entry instead of the
// app when the gateway has no valid device credential for this browser:
// - opened from the PC's QR (`/auth/connect/<code>` → `/pair` with the claim cookie): "PC에서 승인을 기다립니다" and the
//   4-digit SAS, then — once the PC allows — the claim that sets the device cookie, and the app;
// - rejected, expired, rate limited: why, and what to do on the PC;
// - never paired, revoked or expired: 03 §8's text.
// The pending state is polled every 1.5 s while visible (no event stream without a credential; at most the 2-minute
// approval window). Nothing here reads or stores a token: the cookies are HttpOnly.
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { render } from "solid-js/web"
import { createI18n, I18nProvider, useI18n } from "@/i18n"
import "@/limits/kit.css"
import { claimPairing, forgetDevice, inOwnApp, pairingState, probeDevice, standalone, type PairingState } from "@/pwa/gateway"
import { seedColorScheme } from "@/shell/theme-default"
import { usePairingText } from "./strings"

type Reason = "device_unauthorized" | "device_revoked" | "device_expired"

export function showDevicePairing(root: HTMLElement, reason: Reason) {
  root.textContent = ""
  seedColorScheme()
  if (reason !== "device_unauthorized") forgetDevice()
  render(
    () => (
      <ThemeProvider>
        <I18nProvider value={createI18n()}>
          <DevicePairing reason={reason} />
        </I18nProvider>
      </ThemeProvider>
    ),
    root,
  )
}

function DevicePairing(props: { readonly reason: Reason }) {
  const text = usePairingText()
  const i18n = useI18n()
  const error = new URLSearchParams(location.search).get("e")
  const [state, setState] = createSignal<PairingState>({ state: "unknown" })
  const [paired, setPaired] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const poll = async () => {
    if (stopped) return
    const next = await pairingState()
    setState(next)
    if (next.state === "approved") {
      const ok = await claimPairing(standalone() ? "pwa" : "browser")
      if (ok) return void window.location.replace("/")
      setFailed(true)
      return
    }
    if (next.state === "pending" || next.state === "unknown") schedule()
  }
  const schedule = () => {
    clearTimeout(timer)
    if (document.visibilityState === "visible") timer = setTimeout(() => void poll(), 1500)
  }
  const visible = () => {
    if (document.visibilityState === "visible") void poll()
    else clearTimeout(timer)
  }
  onMount(() => {
    void poll()
    // A browser that is already paired and came here through a new QR: offer the app as well.
    void probeDevice().then((probe) => setPaired(probe.kind === "ok"))
    document.addEventListener("visibilitychange", visible)
  })
  onCleanup(() => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener("visibilitychange", visible)
  })

  const idle = () => {
    // Our apps pair natively (08 §3.5); a missing credential here means it expired or was revoked.
    if (inOwnApp()) return text("own.pairing.device.appUnpaired")
    if (error === "expired") return text("own.pairing.device.expired")
    if (error === "rate") return text("own.pairing.device.rate")
    if (props.reason === "device_unauthorized") return text("own.pairing.device.unpaired")
    return i18n.t("own.state.authDevice")
  }

  return (
    <main
      class="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col justify-center gap-4 px-5 py-8 text-own-text"
      style={{ "padding-top": "max(32px, env(safe-area-inset-top))", "padding-bottom": "max(32px, env(safe-area-inset-bottom))" }}
      data-testid="device-pairing"
      data-state={failed() ? "failed" : state().state}
    >
      <h1 class="m-0 text-[20px] font-semibold">{text("own.pairing.device.title")}</h1>
      <Switch fallback={<p class="m-0 text-[14px] leading-6" data-testid="device-pairing-message">{idle()}</p>}>
        <Match when={failed()}>
          <p class="m-0 text-[14px] leading-6" data-testid="device-pairing-message">{text("own.pairing.device.failed")}</p>
        </Match>
        <Match when={state().state === "pending" && state()} keyed>
          {(pending) => (
            <>
              <p class="m-0 text-[15px]" data-testid="device-pairing-message">{text("own.pairing.device.waiting")}</p>
              <div class="rounded-xl border border-own-border p-4 text-center">
                <p class="m-0 text-[12.5px] text-own-muted">{text("own.pairing.device.sas")}</p>
                <p class="m-0 font-mono text-[44px] font-semibold tracking-[0.3em]" data-testid="device-sas">
                  {(pending as { sas: string }).sas}
                </p>
              </div>
              <p class="m-0 text-[13px] text-own-muted">{text("own.pairing.device.sasNote")}</p>
            </>
          )}
        </Match>
        <Match when={state().state === "approved"}>
          <p class="m-0 text-[15px]" data-testid="device-pairing-message">{text("own.pairing.device.finishing")}</p>
        </Match>
        <Match when={state().state === "rejected" || state().state === "cancelled"}>
          <p class="m-0 text-[14px] leading-6" data-testid="device-pairing-message">{text("own.pairing.device.rejected")}</p>
        </Match>
        <Match when={state().state === "expired"}>
          <p class="m-0 text-[14px] leading-6" data-testid="device-pairing-message">{text("own.pairing.device.expired")}</p>
        </Match>
      </Switch>
      <Show when={paired()}>
        <button
          type="button"
          class="own-btn own-target self-start"
          data-size="sm"
          data-testid="device-open-app"
          onClick={() => window.location.replace("/")}
        >
          {text("own.pairing.device.open")}
        </button>
      </Show>
    </main>
  )
}

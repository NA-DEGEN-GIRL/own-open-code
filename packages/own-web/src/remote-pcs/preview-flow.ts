// 모바일 미리보기 in own-web (08 §4.3): what 설정 > 기기 shows for this PC's preview device, and the 만들기 flow.
// The flow asks the gateway for a link with one loopback route (`devices.pair.start{appRoute:"loopback"}`) and hands
// it straight to the shell (`host.mobilePreview.pair`). The link lives only in that call: it is never part of a state,
// so it is never shown, copied or drawn as a QR. Pairing then waits for the PC's own [허용] like any phone.
import { createSignal } from "solid-js"
import type { GatewayView } from "@/data"
import type { HostMobilePreview, MobilePreview, RemotePcError } from "@/host/types"

/** The Android app preset (pairing/settings.tsx TARGET_SCOPES.android): never the terminal. */
export const PREVIEW_SCOPES = ["read", "prompt", "switch"] as const
/** 7 days by default: a copied userData would carry a token that also works over the tailnet or direct routes. */
export const PREVIEW_EXPIRY_DAYS = ["7", "30"] as const

type Paired = Exclude<MobilePreview, { readonly state: "none" }>

export type PreviewView =
  | { readonly kind: "loading" }
  | { readonly kind: "off"; readonly reason: "gateway" | "app"; readonly device?: Paired }
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly device: Paired }
  | { readonly kind: "stale"; readonly device: Paired; readonly why: "reauth" | "mismatch" }

/**
 * The section's state: off while the gateway or its app listener is down (the preview needs both, on loopback only),
 * stale when the device is revoked, expired or paired with another key than the listener's now.
 */
export function previewView(preview: MobilePreview | undefined, gateway: GatewayView | undefined): PreviewView {
  if (!preview || !gateway) return { kind: "loading" }
  const device = preview.state === "none" ? undefined : preview
  if (gateway.state !== "listening") return { kind: "off", reason: "gateway", device }
  const app = gateway.app
  if (!app || app.state !== "listening") return { kind: "off", reason: "app", device }
  if (!device) return { kind: "none" }
  if (device.pcKey !== app.pcKey || device.pin !== app.pin) return { kind: "stale", device, why: "mismatch" }
  if (device.state === "reauth") return { kind: "stale", device, why: "reauth" }
  return { kind: "ready", device }
}

/** The shell's preview, then every change it pushes (paired, removed, state, window opened or closed). */
export function createPreviewStatus(api: HostMobilePreview) {
  const [preview, setPreview] = createSignal<MobilePreview>()
  // A change pushed while the first status is on its way is newer than that status.
  let changes = 0
  const off = api.onChange((next) => {
    changes++
    setPreview(next)
  })
  void api
    .status()
    .then((value) => {
      if (changes === 0) setPreview(value)
    })
    .catch(() => undefined)
  return { preview, dispose: off }
}

export type PreviewError = RemotePcError | "no_link"

export type PreviewStep =
  | { readonly step: "idle" }
  | { readonly step: "starting" }
  | { readonly step: "waiting"; readonly sas: string; readonly expiresAt: number }
  | { readonly step: "done" }
  | { readonly step: "failed"; readonly error: PreviewError; readonly detail?: string }

/** The gateway side (`devices.pair.start` with the loopback route, `devices.pair.cancel`), local RPC. */
export interface PreviewGateway {
  start(expiresDays: number): Promise<{ readonly pairingId: string; readonly appLink?: string | null }>
  cancel(pairingId: string): Promise<void>
}

export function createPreviewFlow(api: HostMobilePreview, gateway: PreviewGateway) {
  const [state, setState] = createSignal<PreviewStep>({ step: "idle" })
  // Every create and cancel moves this on: answers of an older attempt are dropped.
  let attempt = 0
  let pending: { readonly shell: string; readonly gateway: string } | undefined

  /** `replace`: 다시 만들기, the old device is removed first (revoked when the gateway answers). */
  async function create(expiresDays: number, replace = false) {
    const step = state().step
    if (step === "starting" || step === "waiting") return
    const mine = ++attempt
    setState({ step: "starting" })
    const result = await run(mine, expiresDays, replace).catch((error: unknown) => ({
      error: "failed" as const,
      detail: error instanceof Error ? error.message : String(error),
    }))
    if (mine !== attempt) return
    pending = undefined
    setState(result ? { step: "failed", error: result.error, detail: result.detail } : { step: "done" })
  }

  /** undefined when paired; else why not. */
  async function run(
    mine: number,
    expiresDays: number,
    replace: boolean,
  ): Promise<{ readonly error: PreviewError; readonly detail?: string } | undefined> {
    if (replace) await api.remove()
    const started = await gateway.start(expiresDays)
    if (mine !== attempt || !started.appLink) {
      void gateway.cancel(started.pairingId).catch(() => undefined)
      return { error: started.appLink ? "aborted" : "no_link" }
    }
    const paired = await api.pair(started.appLink)
    if (mine !== attempt || !paired.ok) {
      if (paired.ok) void api.cancelPairing(paired.pairingId).catch(() => undefined)
      void gateway.cancel(started.pairingId).catch(() => undefined)
      return paired.ok ? { error: "aborted" } : { error: paired.error, detail: paired.detail }
    }
    pending = { shell: paired.pairingId, gateway: started.pairingId }
    setState({ step: "waiting", sas: paired.sas, expiresAt: paired.expiresAt })
    const ended = await api.waitPairing(paired.pairingId)
    return ended.ok ? undefined : { error: ended.error, detail: ended.detail }
  }

  /** Stops waiting: the shell stops polling and the PC's request goes away. */
  function cancel() {
    attempt++
    if (pending) {
      void api.cancelPairing(pending.shell).catch(() => undefined)
      void gateway.cancel(pending.gateway).catch(() => undefined)
    }
    pending = undefined
    setState({ step: "idle" })
  }

  return { state, create, cancel }
}

// The `원격 PC 추가` flow (08 §3.5 from the app's side): link → the PC's confirmation number → the PC's [허용] → stored.
// The shell does the network work and keeps every secret; this only steps through its answers. The link is checked
// here first with the shell's own parser, so a bad paste is explained without a round trip (main checks it again).
import { createSignal } from "solid-js"
import type { HostRemotePcs, RemotePcError } from "@/host/types"
import { parsePairingLink } from "../../../own-desktop/src/shared/remote-pc"
import type { RemotePcDialogKey } from "./dialog-strings"

export type PairingStep =
  | { readonly step: "idle" }
  | { readonly step: "starting" }
  | {
      readonly step: "waiting"
      readonly pairingId: string
      readonly pcKey: string
      readonly name: string
      readonly sas: string
    }
  | { readonly step: "done"; readonly pcKey: string; readonly name: string }
  | { readonly step: "failed"; readonly error: RemotePcError; readonly detail?: string }

export function createPairingFlow(api: HostRemotePcs) {
  const [state, setState] = createSignal<PairingStep>({ step: "idle" })
  // Every start, cancel and reset moves this on: answers of an older attempt are dropped.
  let attempt = 0

  async function start(link: string) {
    const step = state().step
    if (step === "starting" || step === "waiting") return
    const mine = ++attempt
    if (!parsePairingLink(link).ok) return setState({ step: "failed", error: "invalid_link" })
    setState({ step: "starting" })
    const started = await api
      .pair(link.trim())
      .catch((error: unknown) => ({ ok: false as const, error: "failed" as const, detail: describe(error) }))
    if (mine !== attempt) {
      // Cancelled while the shell was opening it: the shell is already waiting for the PC, stop that too.
      if (started.ok) void api.cancelPairing(started.pairingId).catch(() => undefined)
      return
    }
    if (!started.ok) return setState({ step: "failed", error: started.error, detail: started.detail })
    setState({
      step: "waiting",
      pairingId: started.pairingId,
      pcKey: started.pcKey,
      name: started.name,
      sas: started.sas,
    })
    const result = await api
      .waitPairing(started.pairingId)
      .catch((error: unknown) => ({ ok: false as const, error: "failed" as const, detail: describe(error) }))
    if (mine !== attempt) return
    setState(
      result.ok
        ? { step: "done", pcKey: result.pcKey, name: result.name }
        : { step: "failed", error: result.error, detail: result.detail },
    )
  }

  /** Stops waiting (the shell stops polling the PC); back to the link. */
  function cancel() {
    const current = state()
    attempt++
    if (current.step === "waiting") void api.cancelPairing(current.pairingId).catch(() => undefined)
    setState({ step: "idle" })
  }

  return { state, start, cancel }
}

/** The dialog's message for a failure (main's codes; only `failed` shows its non-secret detail). */
export function pairingError(
  text: (key: RemotePcDialogKey, params: { readonly detail: string }) => string,
  step: PairingStep,
) {
  if (step.step !== "failed") return undefined
  return text(`own.remotePc.error.${step.error}`, { detail: step.detail ?? "—" })
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

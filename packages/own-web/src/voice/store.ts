// This PC's voice input settings (02 §3.9 `voice.get`), shared by every dictation button and the settings page. Read
// from the local service only: the keys and the minutes are this PC's, whatever server the session is on (a remote
// host answers `remote_managed`). Refreshed at most every 30 s when a button mounts or the window comes back, and at
// once after a settings change.
import { createRoot, createSignal } from "solid-js"
import type { OwnRpc } from "@/data/rpc"
import type { Voice } from "@own/protocol/voice"

const REFRESH_MS = 30_000

const state = createRoot(() => {
  const [view, setView] = createSignal<Voice.View>()
  const [unsupported, setUnsupported] = createSignal(false)
  return { view, setView, unsupported, setUnsupported }
})

let loading: Promise<void> | undefined
let loadedAt = Number.NEGATIVE_INFINITY

export const voiceView = state.view
/** The service has no `voice.*` methods (an older build). */
export const voiceUnsupported = state.unsupported

export function setVoiceView(view: Voice.View) {
  state.setView(view)
  state.setUnsupported(false)
  loadedAt = Date.now()
}

export function loadVoice(rpc: OwnRpc, options: { readonly force?: boolean } = {}) {
  if (!rpc.allowed("voice.get")) return Promise.resolve()
  if (loading) return loading
  if (!options.force && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve()
  loading = rpc
    .call("voice.get", {})
    .then(setVoiceView, (error: unknown) => {
      const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined
      if (type === "rpc.method_not_found" || type === "remote_managed") state.setUnsupported(true)
      state.setView(undefined)
    })
    .finally(() => {
      loading = undefined
      loadedAt = Date.now()
    })
  return loading
}

/** On, the selected service has its key, and this connection may spend minutes (`prompt`). */
export function voiceReady(view: Voice.View | undefined, rpc: Pick<OwnRpc, "allowed">) {
  if (!view?.enabled || !rpc.allowed("voice.transcribe")) return false
  return view.keys.some((key) => key.provider === view.provider && key.configured)
}

/** Tests: forget the cached view. */
export function resetVoiceStore() {
  state.setView(undefined)
  state.setUnsupported(false)
  loading = undefined
  loadedAt = Number.NEGATIVE_INFINITY
}

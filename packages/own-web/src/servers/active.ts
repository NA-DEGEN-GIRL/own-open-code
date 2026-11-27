// The window's RemoteStore and the SSH dialog requests, reachable without a shared provider: the shell mounts
// `<RemoteLayer />` once (it owns the store), the sidebar, header, session overlay, picker and settings read it here.
// Everything stays `undefined` in tests and windows that do not mount the layer, and every reader copes with that.
import { createRoot, createSignal } from "solid-js"
import type { RemoteStore } from "./store"

export type RemoteDialog =
  /** 04 §17.3 add-host flow; `hostId` resumes it for a host that is already listed (install, host-key check). */
  | { readonly kind: "add"; readonly hostId?: string; readonly hostKey?: boolean }
  /** 04 §17.4 remote folder picker. */
  | { readonly kind: "picker"; readonly hostId: string }
  /** 04 §6.4 update plan → confirm → execute. */
  | { readonly kind: "update"; readonly hostId: string }
  /** 04 §6.5 "현재 턴이 끝나면 중지". */
  | { readonly kind: "drain"; readonly hostId: string }
  /** 04 §6.7 forget plan → confirm → execute. */
  | { readonly kind: "forget"; readonly hostId: string }
  /** 04 §6.8 owner takeover plan → confirm → execute. */
  | { readonly kind: "takeover"; readonly hostId: string }

const state = createRoot(() => {
  const [store, setStore] = createSignal<RemoteStore>()
  const [dialog, setDialog] = createSignal<RemoteDialog>()
  return { store, setStore, dialog, setDialog }
})

/** The RemoteStore of this window, once `<RemoteLayer />` created it. */
export const remoteStore = state.store

export function registerRemoteStore(store: RemoteStore) {
  state.setStore(() => store)
  return () => {
    if (state.store() === store) state.setStore(undefined)
  }
}

/**
 * 03 §5.1 (2.2.6-own.16): the SSH host this browser last chose on the new-conversation screen's server choice
 * (`servers/new-chat.tsx` writes it), while that host is still listed; `새 대화` and Alt+N open its screen. This PC
 * otherwise.
 */
export function newChatHost() {
  try {
    const key = localStorage.getItem(NEW_CHAT)
    return key && state.store()?.state.hosts[key] ? key : undefined
  } catch {
    return undefined
  }
}

export const NEW_CHAT = "own.web.newChat"

export const remoteDialog = state.dialog

export function openRemoteDialog(request: RemoteDialog) {
  // The dialogs mount keyed on the request: a repeated `원격 폴더 열기` (double click, a click before the lazy chunk
  // showed it) must keep the open picker and its listing instead of making a new one.
  const current = state.dialog()
  if (request.kind === "picker" && current?.kind === "picker" && current.hostId === request.hostId) return
  state.setDialog(request)
}

export function closeRemoteDialog() {
  state.setDialog(undefined)
}

// The window's RemotePcStore and the 원격 PC dialog request, reachable without a provider: the shell mounts
// `<RemotePcLayer />` once (it owns the store, desktop hosts with `capabilities.remotePcs` only), the sidebar section
// reads it here. Everything stays `undefined` in hosts without 원격 PC and in tests that do not mount the layer.
import { createRoot, createSignal } from "solid-js"
import type { RemotePcStore } from "./store"

/** `add`: pair from a link (`pcKey` titles it as reconnecting that PC). `remove`: confirm forgetting a PC. */
export type RemotePcDialog =
  | { readonly kind: "add"; readonly pcKey?: string }
  | { readonly kind: "remove"; readonly pcKey: string }

const state = createRoot(() => {
  const [store, setStore] = createSignal<RemotePcStore>()
  const [dialog, setDialog] = createSignal<RemotePcDialog>()
  return { store, setStore, dialog, setDialog }
})

export const remotePcStore = state.store

export function registerRemotePcStore(store: RemotePcStore) {
  state.setStore(() => store)
  return () => {
    if (state.store() === store) state.setStore(undefined)
  }
}

export const remotePcDialog = state.dialog

export function openRemotePcDialog(request: RemotePcDialog) {
  state.setDialog(request)
}

export function closeRemotePcDialog() {
  state.setDialog(undefined)
}

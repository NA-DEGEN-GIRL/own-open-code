// The sidebar's server sections of this browser (03 §4.3): their order (the user's, else 이 PC, the SSH hosts and the
// other PCs as they were added) and which are folded. Per device: a phone lists its servers as it likes.
import { createSignal } from "solid-js"
import { LOCAL } from "@/data"
import { remotePcStore } from "@/remote-pcs/active"
import { arrangeKeys } from "@/sidebar/arrange"
import { remoteStore } from "./active"

const ORDER = "own.web.servers.order"
const COLLAPSED = "own.web.remote.collapsed"
/** Section keys of the other PCs: their `pcKey` with this in front (hosts and this PC use their server key). */
export const PC = "pc:"

const [order, setOrder] = createSignal<readonly string[]>(read(ORDER))
const [collapsed, setCollapsed] = createSignal<readonly string[]>(read(COLLAPSED))

/** SSH hosts are listed (03 §5.1: the new-conversation screen has its server choice then). */
export const hasRemoteHosts = () => (remoteStore()?.state.order.length ?? 0) > 0

/** Every section in the default order. */
const listed = () => [
  LOCAL,
  ...(remoteStore()?.state.order ?? []),
  ...(remotePcStore()?.pcs() ?? []).map((pc) => `${PC}${pc.pcKey}`),
]

/** The sections as shown. */
export const serverOrder = () => arrangeKeys(listed(), order())

/** The order the user set (empty: the default). */
export const arrangedServers = order

export function arrangeServers(next: readonly string[]) {
  setOrder(next)
  write(ORDER, next)
}

/** Folded; a lone section has no header to unfold it with. */
export const serverCollapsed = (key: string) => collapsed().includes(key) && listed().length > 1

export function toggleServer(key: string) {
  const next = collapsed().includes(key) ? collapsed().filter((item) => item !== key) : [...collapsed(), key]
  setCollapsed(next)
  write(COLLAPSED, next)
}

function read(key: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function write(key: string, value: readonly string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

// 내 브라우저 사용 (BRW), in the first chunk: how a conversation's rules read (like own-accounts `browseOf`), the
// window's last `browse.status` of this PC's service (the `⋯` item shows only while the setting is on) and which
// conversation's dialog is open. The writer is in switch.ts, which only the dialog's chunk loads.
import type { PermissionRule } from "@opencode/client"
import type { Approval, OwnBrowse } from "@own/protocol"
import { createSignal } from "solid-js"
import type { OwnRpc } from "@/data/rpc"

/** The rule pattern of every browse tool (`OwnBrowse.ACTIONS`; the protocol's value module stays out of this chunk). */
export const ACTIONS = "browse_*"

/** `on` only when the last rule whose action is exactly `browse_*` is the allow (own-accounts `browseOf`). */
export function browseOf(rules: ReadonlyArray<PermissionRule> | undefined): Approval.Browse {
  const last = (rules ?? []).findLast((rule) => rule.action === ACTIONS)
  return last !== undefined && last.resource === "*" && last.effect === "allow" ? "on" : "off"
}

/** The window's last `browse.status` of this PC's service (the `⋯` item shows only while the setting is on). */
const [status, setStatus] = createSignal<OwnBrowse.Status>()
export const browseStatus = status

/** Asks `browse.status` again; an older service (no such method) or a failure leaves the last answer. */
export async function refreshBrowseStatus(rpc: Pick<OwnRpc, "call" | "allowed">) {
  if (!rpc.allowed("browse.status")) return undefined
  const next = await rpc.call("browse.status", {}).catch(() => undefined)
  if (next) setStatus(next)
  return next
}

/** After `browse.set`: the answer is the new status. */
export function rememberBrowseStatus(next: OwnBrowse.Status) {
  setStatus(next)
}

/** The conversation whose dialog is open. */
const [dialog, setDialog] = createSignal<{ readonly sessionID: string }>()
export const browseDialog = dialog
export const openBrowseDialog = (request: { readonly sessionID: string }) => setDialog(request)
export const closeBrowseDialog = () => setDialog(undefined)

// The composer's notice of a Claude account's first request (02 §8.9, CW 2026-10-19): the router raises
// `claude_first_request` once per account on the service, for the tree's root. Only this lookup is in the first
// chunk; the notice itself (accounts/claude-first-request.tsx) loads when there is one to show. It never holds a send:
// the request is already on its way, `계속` closes it and `취소` stops the turn.
import { createSignal } from "solid-js"
import type { AlertEntry } from "@/data/own-store"

const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set())

/** The conversation's first-request alert that this page has not closed yet. */
export function firstRequestAlert(alerts: readonly AlertEntry[], sessionID: string, closed = dismissed()) {
  return alerts.find(
    (alert) => alert.code === "claude_first_request" && alert.sessionID === sessionID && !closed.has(alert.id),
  )
}

/** Closes a notice in every composer of this page (`계속`, or `취소` after stopping the turn). */
export function dismissFirstRequest(id: string) {
  setDismissed((current) => new Set([...current, id]))
}

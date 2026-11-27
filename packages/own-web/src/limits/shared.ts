// Small shared readers for the accounts/limits/settings chunks: the router policy (kind compaction defaults, default
// accounts per kind) and the OwnStore status line. `policy.get` has no change event (02 §9.3), so it is read once per
// store and refreshed by whoever writes it (`policy.set` answers carry the new policy).
import type { OwnAccounts } from "@own/protocol"
import { createSignal } from "solid-js"
import type { OwnStore } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import type { I18n } from "@/i18n"

export type PolicyState = OwnOutput<"policy.get">

const [policy, setPolicy] = createSignal<PolicyState>()
const loading = new WeakMap<OwnStore, Promise<void>>()

/** `policy.get` once per store; the accessor is shared by every chunk. */
export function loadPolicy(own: OwnStore, force = false) {
  const running = loading.get(own)
  if (running && !force) return running
  const next = own.rpc
    .call("policy.get", {})
    .then((output) => void setPolicy(output))
    .catch(() => void loading.delete(own))
  loading.set(own, next)
  return next
}

/** The stored policy after a `policy.set` answer; the store's new-session default accounts follow it (07 §2.2). */
export function updatePolicy(own: OwnStore, next: OwnOutput<"policy.set">["policy"]) {
  setPolicy((current) => (current ? { ...current, policy: next } : current))
  own.setDefaultAccounts(next.defaults.byKind)
}

export const policyState = policy

/** `policy.compaction` for compaction summaries; the RPC runs the first time a summary is actually rendered. */
export function createPolicyCache(own: OwnStore) {
  return () => {
    void loadPolicy(own)
    return policy()?.policy.compaction
  }
}

export function statusLine(i18n: I18n, status: OwnStore["state"]["status"]) {
  if (status === "unmanaged") return i18n.t("own.state.unmanaged")
  if (status === "unavailable") return i18n.t("own.lim.unavailable")
  return i18n.t("own.shell.loading")
}

export type Health = OwnAccounts.Health

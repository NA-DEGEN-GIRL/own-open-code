// Account identities as own.accounts lists them (`accounts.list`, own-accounts `Views.account`, imported read-only):
// a codex registry entry records only its guard fingerprint, which is its ChatGPT login (07 §5.4 R4); a siwc entry its
// client fingerprint and the login it recorded at sign-in (02 §3.2c). Team fixtures never hand-set a codex view's login.

import { Account, Kind, OwnID } from "@own/protocol"
import { Store } from "@own/runtime"
import { Views } from "../../../own-accounts/src/slots/views.js"

export function viewIdentity(kind: "codex" | "siwc", login: string) {
  const info: Account.Info = {
    id: Account.ID.make(`acc_${kind}_view`),
    kind,
    label: login,
    shortLabel: "C",
    color: "indigo",
    providerID: Kind.ProviderID.from(kind, "view"),
    cacheDomain: OwnID.CacheDomainID.make("cd_view"),
    quotaDomain: OwnID.QuotaDomainID.make("qd_view"),
    billing: "subscription",
    identity: kind === "codex" ? { fingerprint: login } : { fingerprint: `client:${login}`, login },
    autoSwitch: false,
    status: "ready",
  }
  return Views.account({ ...Store.emptyRegistry(), accounts: [info] }, info, []).identity
}

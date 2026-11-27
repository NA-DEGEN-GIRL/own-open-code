export * as LoginView from "./view.js"

import path from "node:path"
import type { Account, Registry } from "@own/protocol"
import type { Runtime } from "@own/runtime"
import { Views } from "../slots/views.js"

/**
 * The `Account.View` returned by the login and import RPCs: the same view `accounts.list` builds (SLOTS
 * `Views.account`), so a client can merge it into its list without a refetch.
 */
export function view(runtime: Runtime.Handle, registry: Registry.File, account: Account.Info): Account.View {
  return Views.account(registry, account, runtime.limits.list({ accountID: account.id }))
}

/** Whether two source paths name the same file (Windows paths are case-insensitive). */
export function samePath(a: string, b: string) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

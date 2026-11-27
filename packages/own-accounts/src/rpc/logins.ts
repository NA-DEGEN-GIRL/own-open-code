export * as LoginsRpc from "./logins.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: CREDENTIALS agent. Of all methods only `accounts.add.key` (here) and `accounts.update{replaceKey}` receive
 * a secret (02 §9.1).
 */
export type Methods =
  | "accounts.add.key"
  | "accounts.local.detect"
  | "accounts.add.chatgpt.start"
  | "accounts.add.chatgpt.status"
  | "accounts.add.chatgpt.complete"
  | "accounts.add.chatgpt.cancel"
  | "accounts.import.codex.list"
  | "accounts.import.codex.plan"
  | "accounts.import.codex.execute"
  | "accounts.import.keys.list"
  | "accounts.import.keys.plan"
  | "accounts.import.keys.execute"
  | "accounts.test"
  | "plugin.claudeAuth.importSubscription"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "accounts.add.key": (input, context) => modules.logins.addKey(input, context),
    "accounts.local.detect": (input, context) => modules.logins.localDetect(input, context),
    "accounts.add.chatgpt.start": (input, context) => modules.logins.chatgptStart(input, context),
    "accounts.add.chatgpt.status": (input, context) => modules.logins.chatgptStatus(input, context),
    "accounts.add.chatgpt.complete": (input, context) => modules.logins.chatgptComplete(input, context),
    "accounts.add.chatgpt.cancel": (input, context) => modules.logins.chatgptCancel(input, context),
    "accounts.import.codex.list": (input, context) => modules.logins.codexList(input, context),
    "accounts.import.codex.plan": (input, context) => modules.logins.codexPlan(input, context),
    "accounts.import.codex.execute": (input, context) => modules.logins.codexExecute(input, context),
    "accounts.import.keys.list": (input, context) => modules.logins.keysList(input, context),
    "accounts.import.keys.plan": (input, context) => modules.logins.keysPlan(input, context),
    "accounts.import.keys.execute": (input, context) => modules.logins.keysExecute(input, context),
    "accounts.test": (input, context) => modules.logins.test(input, context),
    "plugin.claudeAuth.importSubscription": (input, context) => modules.logins.claudeImport(input, context),
  }
}

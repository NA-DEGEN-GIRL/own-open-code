export * as SwitchRpc from "./switch.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: SWITCHING agent. Session methods arrive at the session's Location (02 §9.1); `policy.*` at the control one. */
export type Methods =
  | "session.binding"
  | "switch.estimate"
  | "switch.apply"
  | "switch.schedule"
  | "switch.cancel"
  | "switch.undo"
  | "switch.state"
  | "switch.waitReset"
  | "switch.setConfirmOverride"
  | "policy.get"
  | "policy.set"
  | "compaction.setSession"
  | "session.presence"
  | "session.approval.get"
  | "session.approval.set"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "session.binding": (input, context) => modules.switching.binding(input, context),
    "switch.estimate": (input, context) => modules.switching.estimate(input, context),
    "switch.apply": (input, context) => modules.switching.apply(input, context),
    "switch.schedule": (input, context) => modules.switching.schedule(input, context),
    "switch.cancel": (input, context) => modules.switching.cancel(input, context),
    "switch.undo": (input, context) => modules.switching.undo(input, context),
    "switch.state": (input, context) => modules.switching.state(input, context),
    "switch.waitReset": (input, context) => modules.switching.waitReset(input, context),
    "switch.setConfirmOverride": (input, context) => modules.switching.setConfirmOverride(input, context),
    "policy.get": (input, context) => modules.switching.policyGet(input, context),
    "policy.set": (input, context) => modules.switching.policySet(input, context),
    "compaction.setSession": (input, context) => modules.switching.compactionSet(input, context),
    "session.presence": (input, context) => modules.switching.presence(input, context),
    "session.approval.get": (input, context) => modules.switching.approvalGet(input, context),
    "session.approval.set": (input, context) => modules.switching.approvalSet(input, context),
  }
}

export * as DiagnosticsRpc from "./diagnostics.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: TELEMETRY agent. The opt-in wire evidence capture (P0-3a, 02 §7.8); `diagnostics.selfTest` is HEALTH's. */
export type Methods = "diagnostics.capture.start" | "diagnostics.capture.stop" | "diagnostics.capture.status"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "diagnostics.capture.start": (input, context) => modules.telemetry.capture.start(input, context),
    "diagnostics.capture.stop": (input, context) => modules.telemetry.capture.stop(input, context),
    "diagnostics.capture.status": (input, context) => modules.telemetry.capture.status(input, context),
  }
}

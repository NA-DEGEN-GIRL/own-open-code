export * as Guard from "./guard.js"

import type { OwnAccounts } from "@own/protocol"
import { Build } from "../build.js"

export interface Result {
  readonly guard: OwnAccounts.Guard
  /** Why the guard failed; shown in `health.warnings`. No secrets. */
  readonly reason?: string
}

/**
 * Guard 1 (01 §5.4, fail closed): the upstream app version must be the one this bundle was built against, and the
 * launcher's env marker must be set. On failure own-accounts registers neither slots nor hooks, only `health`.
 */
export function check(input: {
  readonly appVersion: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly expectedVersion?: string
  /** `remote` (04 §9.1 guard 1): also requires `OWN_REMOTE=1`, the marker of a remote service's managed env. */
  readonly mode?: "local" | "remote"
}): Result {
  const expected = input.expectedVersion ?? Build.EXPECTED_APP_VERSION
  if (input.appVersion !== expected)
    return { guard: "skew", reason: `app version ${input.appVersion} does not match build ${expected}` }
  if (input.env[Build.ENV_MARKER] !== "1") return { guard: "unmanaged", reason: `${Build.ENV_MARKER}=1 is not set` }
  if (input.mode === "remote" && input.env[Build.ENV_REMOTE] !== "1")
    return { guard: "unmanaged", reason: `${Build.ENV_REMOTE}=1 is not set (mode remote)` }
  return { guard: "ok" }
}

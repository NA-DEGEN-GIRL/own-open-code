// The device permissions of 설정 > 휴대폰·다른 PC (05 §13.5 table), apart from the page so the lists and the
// checkbox rule are testable without it (pairing.test.ts compares them with the protocol's).
import type { DeviceScope } from "@/data"

/** Every device scope in the protocol's order (`OwnRemote.DEVICE_SCOPES`): the rows of both forms. */
export const SCOPES: readonly DeviceScope[] = ["read", "prompt", "switch", "files", "terminal", "browser", "admin"]
/**
 * A new device's ticks (`OwnRemote.DEFAULT_DEVICE_SCOPES`). `browser` (05 §8.10.2) is never among them: pages the
 * pane is signed in to would leave the PC, so the user ticks it per device, here on the PC.
 */
export const DEFAULT_SCOPES: readonly DeviceScope[] = ["read", "prompt", "switch"]
/** Ticking one of these shows the lost-device warning. */
export const RISKY: ReadonlySet<DeviceScope> = new Set(["terminal", "admin"])

export type Target = "android" | "desktop" | "browser"

export const TARGET_SCOPES: Record<Target, readonly DeviceScope[]> = {
  android: DEFAULT_SCOPES,
  // 08 §4.1 "다른 PC" preset: a PC you sit at needs files. The terminal runs any command on this PC, so it stays an
  // opt-in the user ticks, which shows the risky-scope warning.
  desktop: ["read", "prompt", "switch", "files"],
  browser: DEFAULT_SCOPES,
}

/** A checkbox flipped. The last tick stays: a device with no permission is disconnected instead. */
export function toggleScope(current: ReadonlySet<DeviceScope>, scope: DeviceScope): ReadonlySet<DeviceScope> {
  const next = new Set(current)
  if (!next.delete(scope)) next.add(scope)
  return next.size === 0 ? current : next
}

/** What `devices.pair.start` and `devices.update` carry: the ticked scopes in the protocol's order. */
export function scopeList(scopes: ReadonlySet<DeviceScope>) {
  return SCOPES.filter((scope) => scopes.has(scope))
}

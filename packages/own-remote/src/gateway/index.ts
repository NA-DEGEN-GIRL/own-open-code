export { Gateway, type GatewayInput, type GatewayOptions } from "./gateway.js"
export { GatewayConfig } from "./config.js"
export { Devices } from "./devices.js"
export { Feed } from "./feed.js"
export { Pairing } from "./pairing.js"
export { Policy } from "./policy.js"
export { GatewayServer } from "./server.js"
export { ServiceTarget } from "@own/runtime"
export { Tailscale } from "./tailscale.js"
export { Web } from "./web.js"
export * as GatewaySlot from "./index.js"

import { Gateway, type GatewayInput } from "./gateway.js"

/**
 * Process-lifetime gateway per build (05 §13.4 "자리"), next to the SSH controller (04 §4.1): created by the first
 * own-remote instance in local mode, shared by every Location's instance, and kept while it is enabled even when no
 * instance holds it (the gateway pins itself, see `Gateway`). Disabled and unreferenced, it closes after the linger.
 */
interface Slot {
  readonly gateway: Gateway
  refs: number
  linger: ReturnType<typeof setTimeout> | undefined
}

export function key(buildId: string) {
  return Symbol.for(`own-open-code.remote-gateway/${buildId}`)
}

function slots() {
  return globalThis as unknown as Record<symbol, Slot | undefined>
}

export interface Handle {
  readonly gateway: Gateway
  release(): Promise<void>
}

export function acquire(input: GatewayInput, lingerSeconds = 30): Handle {
  const existing = slots()[key(input.buildId)]
  const slot: Slot = existing ?? { gateway: new Gateway(input), refs: 0, linger: undefined }
  slots()[key(input.buildId)] = slot
  if (slot.linger) clearTimeout(slot.linger)
  slot.linger = undefined
  slot.refs++
  void slot.gateway.start().catch(() => undefined)
  let released = false
  return {
    gateway: slot.gateway,
    release: async () => {
      if (released) return
      released = true
      slot.refs--
      if (slot.refs > 0) return
      const close = async () => {
        if (slot.refs > 0 || slot.gateway.settings.enabled) return
        if (slots()[key(input.buildId)] === slot) delete slots()[key(input.buildId)]
        await slot.gateway.close()
      }
      if (lingerSeconds === 0) return close()
      slot.linger = setTimeout(() => void close(), lingerSeconds * 1000)
      slot.linger.unref?.()
    },
  }
}

/** The gateway of a build in this process, if any (tests, diagnostics). */
export function peek(buildId: string) {
  return slots()[key(buildId)]?.gateway
}

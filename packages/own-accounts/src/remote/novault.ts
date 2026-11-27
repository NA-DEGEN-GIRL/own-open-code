export * as NoVault from "./novault.js"

import type { Vault } from "@own/runtime"

/**
 * The vault transport of a remote service (04 §9.1 "원격은 vault 없음"): every request fails, so nothing can ever be
 * stored or read there. Credentials reach a remote service only as broker leases held in memory (04 §8.5).
 */
export const transport: Vault.Transport = {
  request: () => Promise.reject(new Error("no vault in a remote own service")),
  close: () => Promise.resolve(),
}

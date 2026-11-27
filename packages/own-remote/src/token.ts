export * as Token from "./token.js"

import { createHmac } from "node:crypto"

/**
 * Server access tokens signed by own-remote with the remote service password (04 §12.1). The format is upstream's
 * session token (`packages/server/src/auth.ts:39-66`, surface entry `server-session-token`): `<expires seconds>.<
 * base64url HMAC(key, expires)>` with `key = HMAC(password, "opencode-session-v1")`. The remote server accepts any
 * such token whose expiry is in the future, in the password position of Basic auth. The password never leaves
 * own-remote; clients get only the token.
 */
export function sign(password: string, expiresAtMs: number) {
  const expires = String(Math.floor(expiresAtMs / 1000))
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  return `${expires}.${createHmac("sha256", key).update(expires).digest("base64url")}`
}

/** Expiry (ms) encoded in a token, or `undefined`. */
export function expiresAt(token: string) {
  const seconds = Number(token.split(".")[0])
  return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined
}

/** 12 h default, 8–24 h per host (04 §12.1). Re-signed when less than 1 h is left. */
export const REFRESH_BELOW_MS = 60 * 60 * 1000

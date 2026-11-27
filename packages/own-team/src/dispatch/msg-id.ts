export * as MsgID from "./msg-id.js"

import { SessionMessage } from "@opencode/schema/session-message"

/**
 * Deterministic message ids (06 §5.1 step 4, §5.6): `msg_` + the first 26 characters of the base32 SHA-256 of the
 * parts. A resend after a restart reuses the id, and core keeps the first admission whether the item is still pending
 * or already delivered (core session/inbox.ts:154-200). Core checks only the `msg_` prefix and orders the inbox by
 * seq (schema session-message.ts:23-29), so a hashed id is a valid id that sorts nowhere special.
 */

/** Crockford base32 in lower case (the ULID alphabet, as `@own/protocol` ids). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** The id of `parts` (joined with NUL, which no id contains), e.g. `of(teamID, "wake", seq)` for a team update. */
export function of(...parts: ReadonlyArray<string | number>) {
  const digest = new Bun.CryptoHasher("sha256").update(parts.join("\0")).digest()
  return SessionMessage.ID.make(`msg_${base32(digest).slice(0, 26)}`)
}

/** A main request's message id in the owner conversation it goes to: `msgID(dispatchID, ownerSessionID)`. */
export function dispatch(dispatchID: string, ownerSessionID: string) {
  return of(dispatchID, ownerSessionID)
}

/** Base32 of `bytes`, 5 bits per character, the last group padded with zero bits. */
export function base32(bytes: Uint8Array) {
  const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, "0")).join("")
  return Array.from(
    { length: Math.ceil(bits.length / 5) },
    (_, index) => ALPHABET[Number.parseInt(bits.slice(index * 5, index * 5 + 5).padEnd(5, "0"), 2)],
  ).join("")
}

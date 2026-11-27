export * as Prompt from "./prompt.js"

/**
 * Askpass prompt kinds (04 §14.2). OpenSSH marks only permission confirmations (agent key use, FIDO touch) with
 * `SSH_ASKPASS_PROMPT=confirm`; the first-contact host key question is a plain input prompt, so the kind is decided
 * from the text. A host key question must never be shown as a hidden password field.
 */
export type Kind = "hostKey" | "confirm" | "passphrase" | "password" | "other"

export interface Classified {
  readonly kind: Kind
  /** `SHA256:…` of a host key question. */
  readonly fingerprint?: string
  /** `ED25519`, `ECDSA`, `RSA`, … of a host key question. */
  readonly keyType?: string
}

const HOST_KEY = [/authenticity of host/i, /\(yes\/no(\/\[fingerprint\])?\)\?/i, /fingerprint is SHA256:/i]

export function classify(text: string, confirm: boolean): Classified {
  if (HOST_KEY.some((pattern) => pattern.test(text))) {
    const fingerprint = /SHA256:[A-Za-z0-9+/=]+/.exec(text)?.[0]
    const keyType = /\b([A-Z0-9-]+) key fingerprint is/i.exec(text)?.[1]?.toUpperCase()
    return {
      kind: "hostKey",
      ...(fingerprint ? { fingerprint } : {}),
      ...(keyType ? { keyType } : {}),
    }
  }
  if (confirm) return { kind: "confirm" }
  if (/Enter passphrase for key/i.test(text)) return { kind: "passphrase" }
  if (/password:\s*$/i.test(text)) return { kind: "password" }
  return { kind: "other" }
}

/**
 * What own-remote writes to ssh for an answer (04 §14.2, §16.2 `respond`). `hostKey` and `confirm` prompts only
 * take the literal `"trust"` from the UI and answer `yes`; any other string (including "yes") is refused, so a
 * typed value can never accept an unknown host key. `null` cancels.
 */
export function answer(kind: Kind, value: string | null): { readonly ok: true; readonly value: string | null } | {
  readonly ok: false
} {
  if (value === null) return { ok: true, value: null }
  if (kind === "hostKey" || kind === "confirm") return value === "trust" ? { ok: true, value: "yes" } : { ok: false }
  return { ok: true, value }
}

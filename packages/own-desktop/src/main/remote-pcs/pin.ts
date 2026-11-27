// Key pinning for 원격 PC partitions (08 §3.1 pin, §3.4 2). Every certificate a PC's partition sees is judged here and
// only here: the request must be for that PC's app host and the certificate's key must be the pinned one. Chromium's
// own verdict (CA chain, name, dates) is ignored either way, so neither a public CA nor Tailscale nor a DDNS provider
// can vouch for a PC. Electron-free so tests run under bun.
import { createHash, X509Certificate } from "node:crypto"
import { appHost } from "../../shared/remote-pc"

/** Accept for `setCertificateVerifyProc`. */
export const ACCEPT = 0
/** Reject (net::ERR_FAILED): the page or `ses.fetch` fails without an interstitial. */
export const REJECT = -2

/** base64url SHA-256 of the SubjectPublicKeyInfo DER of a PEM certificate; undefined when it does not parse. */
export function spkiPin(pem: string) {
  try {
    const spki = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })
    return createHash("sha256").update(spki).digest("base64url")
  } catch {
    return undefined
  }
}

/**
 * The verdict for one verification request of the partition of (`pcKey`, `pin`). Each partition trusts exactly one
 * pin for its whole life: the network service caches verdicts per certificate and Electron never drops them (setting
 * the proc again does not), so a pin that changes means another partition, never another verdict here.
 */
export function certificateVerdict(
  request: { readonly hostname: string; readonly pem: string },
  pcKey: string,
  pin: string,
) {
  if (request.hostname.toLowerCase() !== appHost(pcKey)) return REJECT
  return spkiPin(request.pem) === pin ? ACCEPT : REJECT
}

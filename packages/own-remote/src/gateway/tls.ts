export * as AppTls from "./tls.js"

import crypto from "node:crypto"
import { Schema } from "effect"
import type { Vault } from "@own/runtime"

/**
 * The app listener's identity (08 §3.1–3.2): one self-signed ECDSA P-256 certificate per gateway, named
 * `<pcKey>.ownpc.internal`. Apps trust only `pin` (base64url SHA-256 of the SubjectPublicKeyInfo), which they get from
 * the pairing QR, so neither a public CA, the DDNS provider nor Tailscale's control plane can stand in for this PC.
 * The private key lives in the vault (DPAPI, item `gateway-app-tls`), never in a plain file.
 */

export const VAULT_ID = "gateway-app-tls"
export const HOST_SUFFIX = ".ownpc.internal"
export const PC_KEY_PATTERN = /^[a-z2-7]{12}$/
const VALID_YEARS = 10

export interface Identity {
  readonly pcKey: string
  readonly keyPem: string
  readonly certPem: string
  readonly pin: string
  readonly createdAt: number
}

const Stored = Schema.Struct({
  version: Schema.Literal(1),
  pcKey: Schema.String.check(Schema.isPattern(PC_KEY_PATTERN)),
  keyPem: Schema.String,
  certPem: Schema.String,
  createdAt: Schema.Finite,
})
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))

export type LoadResult =
  | { readonly ok: true; readonly identity: Identity; readonly created: boolean }
  | { readonly ok: false; readonly problem: "vault_unavailable" }

/** The stored identity, or a new one written to the vault first (persist before use). */
export async function loadOrCreate(vault: Vault.Client, now = Date.now()): Promise<LoadResult> {
  const read = await vault.get(VAULT_ID)
  if (read.ok) {
    const stored = decodeStored(read.value)
    if (stored._tag === "Some") return { ok: true, identity: withPin(stored.value), created: false }
  }
  if (!read.ok && read.error !== "not_found") return { ok: false, problem: "vault_unavailable" }
  const identity = create(now)
  const value = JSON.stringify({
    version: 1,
    pcKey: identity.pcKey,
    keyPem: identity.keyPem,
    certPem: identity.certPem,
    createdAt: identity.createdAt,
  })
  const written = await vault.put(VAULT_ID, value, { keepPrev: true })
  if (!written.ok) return { ok: false, problem: "vault_unavailable" }
  return { ok: true, identity, created: true }
}

export function create(now = Date.now(), pcKey = newPcKey()): Identity {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const spki = pair.publicKey.export({ type: "spki", format: "der" })
  const from = new Date(now - 60 * 60 * 1000)
  const to = new Date(from)
  to.setUTCFullYear(to.getUTCFullYear() + VALID_YEARS)
  const der = certificate({ pcKey, spki, privateKey: pair.privateKey, from, to })
  return {
    pcKey,
    keyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certPem: pem("CERTIFICATE", der),
    pin: pinOfSpki(spki),
    createdAt: now,
  }
}

/** `<pcKey>.ownpc.internal`. */
export function hostOf(pcKey: string) {
  return `${pcKey}${HOST_SUFFIX}`
}

export function pinOfSpki(spki: Uint8Array) {
  return crypto.createHash("sha256").update(spki).digest("base64url")
}

export function pinOfCertificate(certPem: string) {
  return pinOfSpki(new crypto.X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" }))
}

function withPin(stored: typeof Stored.Type): Identity {
  return { pcKey: stored.pcKey, keyPem: stored.keyPem, certPem: stored.certPem, pin: pinOfCertificate(stored.certPem), createdAt: stored.createdAt }
}

/** 12 characters of RFC 4648 base32 (lowercase): DNS-label safe, 60 bits. */
export function newPcKey() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  return Array.from(crypto.randomBytes(12), (byte) => alphabet[byte & 31]).join("")
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal DER encoder for one self-signed X.509 v3 certificate (RFC 5280). Only what this certificate needs.

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
}

function certificate(input: {
  readonly pcKey: string
  readonly spki: Uint8Array
  readonly privateKey: crypto.KeyObject
  readonly from: Date
  readonly to: Date
}) {
  const algorithm = sequence(oid(OID.ecdsaWithSha256))
  const name = sequence(set(sequence(oid(OID.commonName), utf8(`own-open-code ${input.pcKey}`))))
  const serial = crypto.randomBytes(16)
  serial[0] = serial[0]! & 0x7f
  const extensions = sequence(
    extension(OID.subjectAltName, false, sequence(tagged(0x82, Buffer.from(hostOf(input.pcKey), "ascii")))),
    extension(OID.basicConstraints, true, sequence()),
    // digitalSignature
    extension(OID.keyUsage, true, tagged(0x03, Buffer.from([0x07, 0x80]))),
    extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
  )
  const tbs = sequence(
    tagged(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(time(input.from), time(input.to)),
    name,
    Buffer.from(input.spki),
    tagged(0xa3, extensions),
  )
  const signature = crypto.sign("sha256", tbs, { key: input.privateKey, dsaEncoding: "der" })
  return sequence(tbs, algorithm, tagged(0x03, Buffer.concat([Buffer.from([0]), signature])))
}

function extension(id: string, critical: boolean, value: Buffer) {
  return sequence(oid(id), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), tagged(0x04, value))
}

function tagged(tag: number, body: Buffer) {
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

function length(size: number) {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function sequence(...items: Buffer[]) {
  return tagged(0x30, Buffer.concat(items))
}

function set(...items: Buffer[]) {
  return tagged(0x31, Buffer.concat(items))
}

function integer(value: Buffer) {
  const trimmed = value.subarray(value.findIndex((byte, index) => byte !== 0 || index === value.length - 1))
  return tagged(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function utf8(value: string) {
  return tagged(0x0c, Buffer.from(value, "utf8"))
}

function oid(value: string) {
  const parts = value.split(".").map(Number)
  const body = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f]
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80)
    body.push(...chunk)
  }
  return tagged(0x06, Buffer.from(body))
}

/** UTCTime before 2050, GeneralizedTime after (RFC 5280 §4.1.2.5). */
function time(date: Date) {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14)
  return date.getUTCFullYear() < 2050 ? tagged(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tagged(0x18, Buffer.from(`${iso}Z`))
}

function pem(label: string, der: Buffer) {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

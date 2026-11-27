// Self-signed ECDSA P-256 certificates for the remote-PC tests, shaped like the gateway's app certificate
// (08 §3.2: CN=own-open-code <pcKey>, SAN DNS:<pcKey>.ownpc.internal). A minimal DER encoder, test-only.
import crypto from "node:crypto"

export interface TestCertificate {
  readonly certPem: string
  readonly keyPem: string
  /** base64url SHA-256 of the SubjectPublicKeyInfo DER, computed here independently of the code under test. */
  readonly pin: string
}

export function selfSigned(dnsName: string): TestCertificate {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const spki = pair.publicKey.export({ type: "spki", format: "der" })
  const algorithm = sequence(oid("1.2.840.10045.4.3.2"))
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8(`own-open-code ${dnsName}`))))
  const now = Date.now()
  const tbs = sequence(
    tagged(0xa0, integer(Buffer.from([2]))),
    // Positive and minimal: the first byte is 0x01–0x7f.
    integer(Buffer.from([1 + crypto.randomInt(127), ...crypto.randomBytes(7)])),
    algorithm,
    name,
    sequence(time(new Date(now - 60_000)), time(new Date(now + 86_400_000))),
    name,
    spki,
    tagged(0xa3, sequence(sequence(oid("2.5.29.17"), tagged(0x04, sequence(tagged(0x82, Buffer.from(dnsName))))))),
  )
  const signature = crypto.sign("sha256", tbs, { key: pair.privateKey, dsaEncoding: "der" })
  const der = sequence(tbs, algorithm, tagged(0x03, Buffer.concat([Buffer.from([0]), signature])))
  return {
    certPem: pem("CERTIFICATE", der),
    keyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pin: crypto.createHash("sha256").update(spki).digest("base64url"),
  }
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
  return tagged(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value)
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

function time(date: Date) {
  return tagged(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`))
}

function pem(label: string, der: Buffer) {
  const body = der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

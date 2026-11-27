// A gateway stand-in for the 원격 PC and 모바일 미리보기 tests: the app listener's native pairing endpoints over TLS
// with a test certificate (08 §3.5, §3.6, §3.6a), and the shell's pinned transport with Bun's fetch (through a
// CONNECT proxy, the certificate judged by certificateVerdict only). Test-only.
import net from "node:net"
import { RemotePcError, type Transport } from "../../src/main/remote-pcs/pairing"
import { ACCEPT, certificateVerdict } from "../../src/main/remote-pcs/pin"
import { appHost, appOrigin } from "../../src/shared/remote-pc"

export interface GatewayScript {
  /** States `/own/pairing` answers in turn (the last one repeats). */
  states: string[]
  connectStatus?: number
  token: string
  routes?: { pcKey: string; pin: string; name: string; routes: string[] }
}

export interface SeenRequest {
  readonly path: string
  readonly host: string | null
  readonly claim: string | null
  readonly auth: string | null
  readonly ua: string | null
}

/** The PC's app listener for `pcKey`, with one pairing code; `close` stops it. */
export function standInGateway(
  cert: { certPem: string; keyPem: string },
  script: GatewayScript,
  target: { readonly pcKey: string; readonly code: string },
) {
  const seen: SeenRequest[] = []
  let polls = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: cert.certPem, key: cert.keyPem },
    async fetch(req) {
      const url = new URL(req.url)
      const host = req.headers.get("host")
      seen.push({
        path: url.pathname,
        host,
        claim: req.headers.get("x-own-pairing"),
        auth: req.headers.get("authorization"),
        ua: req.headers.get("user-agent"),
      })
      if (host !== appHost(target.pcKey)) return new Response("misdirected", { status: 421 })
      if (url.pathname === `/auth/connect/${target.code}`) {
        if (!(req.headers.get("accept") ?? "").includes("application/json"))
          return new Response("apps only", { status: 403 })
        if (script.connectStatus) return Response.json({ type: "x" }, { status: script.connectStatus })
        return Response.json({
          claim: "claim-secret",
          sas: "4821",
          name: "Windows 앱",
          expiresAt: Date.now() + 120_000,
        })
      }
      if (url.pathname === "/own/pairing") {
        if (req.headers.get("x-own-pairing") !== "claim-secret") return Response.json({ state: "none" })
        return Response.json({ state: script.states[Math.min(polls++, script.states.length - 1)] })
      }
      if (url.pathname === "/own/pairing/claim" && req.method === "POST") {
        if (req.headers.get("x-own-pairing") !== "claim-secret") return Response.json({}, { status: 401 })
        return Response.json({ deviceId: "dev_app", token: script.token, expiresAt: 1_900_000_000_000 })
      }
      if (url.pathname === "/own/routes") {
        if (req.headers.get("authorization") !== `Bearer ${script.token}`) return Response.json({}, { status: 401 })
        return Response.json(script.routes)
      }
      if (url.pathname === "/own/device/revoke" && req.method === "POST") {
        if (req.headers.get("authorization") !== `Bearer ${script.token}`) return Response.json({}, { status: 401 })
        return Response.json({ deviceId: "dev_app", revoked: true })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { route: `127.0.0.1:${server.port}`, seen, close: () => server.stop(true) }
}

/**
 * The shell's transport (partition.ts transportFor) with Bun's fetch: the app origin through the CONNECT proxy, the
 * certificate judged by certificateVerdict (Bun calls checkServerIdentity once the chain is accepted, so the served
 * certificate is passed as its own CA), and network failures classified by what the proxy and the pin saw.
 */
export function pinnedTransport(
  proxyPort: number,
  cert: { certPem: string },
  target: { readonly pcKey: string; readonly pin: string; readonly userAgent?: string },
  flags: { unreachable: boolean },
) {
  let mismatch = false
  const transport: Transport = (path, init) => {
    flags.unreachable = false
    return fetch(`${appOrigin(target.pcKey)}${path}`, {
      method: init.method ?? "GET",
      headers: { ...init.headers, "user-agent": target.userAgent ?? "test OwnOpenCodeApp/1 (desktop)" },
      body: init.body,
      signal: init.signal,
      proxy: `http://127.0.0.1:${proxyPort}`,
      tls: {
        ca: cert.certPem,
        checkServerIdentity(hostname: string, peer: { raw: Buffer }) {
          const body = peer.raw
            .toString("base64")
            .match(/.{1,64}/g)!
            .join("\n")
          const pem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
          mismatch = certificateVerdict({ hostname, pem }, target.pcKey, target.pin) !== ACCEPT
          return mismatch ? new Error("pin mismatch") : undefined
        },
      },
    } as RequestInit).then(
      (response) => {
        // Bun hands a refused CONNECT back as the proxy's 502; Chromium fails the request (ERR_TUNNEL_CONNECTION_FAILED).
        if (flags.unreachable) throw new RemotePcError("unreachable")
        return response
      },
      () => {
        if (init.signal?.aborted) throw new RemotePcError("aborted")
        if (flags.unreachable) throw new RemotePcError("unreachable")
        if (mismatch) throw new RemotePcError("pin_mismatch")
        throw new RemotePcError("failed")
      },
    )
  }
  return transport
}

/** A port nothing listens on (refused at once). */
export async function closedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `127.0.0.1:${port}`
}

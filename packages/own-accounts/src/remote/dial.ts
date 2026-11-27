export * as Dial from "./dial.js"

import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Contract } from "../broker/contract.js"

/** Opens the stream to the local broker through the tunnel's `-R` forward (04 §7.4, §8.2). */
export type Dial = (endpoint: Contract.Endpoint) => Promise<net.Socket>

export const CONNECT_TIMEOUT_MS = 5_000

/** Production: the stream socket sshd created (`broker-<epoch>.sock`, 0600), or `127.0.0.1:<tcpPort>` (TCP fallback). */
export const system: Dial = (endpoint) =>
  open("socket" in endpoint ? { path: endpoint.socket } : { host: "127.0.0.1", port: endpoint.tcpPort })

/**
 * Tests only (plugin option `broker.dial: "placeholder"`): the fake-SSH harness cannot create a unix socket on
 * Windows, so its `-R` writes a placeholder file `{"fakeSocket":true,"tcp":<port>}` at the socket path (an MSYS path
 * such as `/tmp/own-1000/ab12cd34/broker-5.sock`) that names a local TCP relay to the broker listener.
 */
export const placeholder: Dial = async (endpoint) => {
  if (!("socket" in endpoint)) return system(endpoint)
  const text = await fs.readFile(windowsPath(endpoint.socket), "utf8")
  const value = JSON.parse(text) as { readonly fakeSocket?: boolean; readonly tcp?: number }
  if (value.fakeSocket !== true || typeof value.tcp !== "number") throw new Error("not a fake-SSH socket placeholder")
  return open({ host: "127.0.0.1", port: value.tcp })
}

/** MSYS path → Windows path (`/tmp/…` is the Windows temp directory, `/c/…` is `C:\…`). */
export function windowsPath(posix: string) {
  if (process.platform !== "win32") return posix
  if (posix === "/tmp" || posix.startsWith("/tmp/")) return path.join(os.tmpdir(), ...posix.slice(5).split("/").filter(Boolean))
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(posix)
  return match ? `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll("/", "\\")}` : posix
}

function open(options: net.NetConnectOpts) {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(options)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("broker connect timeout"))
    }, CONNECT_TIMEOUT_MS)
    socket.once("connect", () => {
      clearTimeout(timer)
      // Keeps a late error from becoming an uncaught exception before the channel attaches its own handler.
      socket.on("error", () => {})
      resolve(socket)
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    })
  })
}

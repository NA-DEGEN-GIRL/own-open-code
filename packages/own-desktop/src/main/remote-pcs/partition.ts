// What 원격 PC (service.ts, 08 §3.4) and 모바일 미리보기 (preview.ts, 08 §4.3) share: a PC's partition and a window that
// shows a PC's own-web.
//  - One Electron session per PC and pin (`persist:<prefix>-<pcKey>-<pin hash>`, store.ts partitionName). Every request
//    goes to the service's in-process CONNECT proxy (`<-loopback>`: loopback too, so a page cannot reach this PC's
//    services), every certificate is judged by that one pin (pin.ts), only notifications, sanitized clipboard writes
//    and the microphone (audio only, for that PC's voice input, 02 §3.9) are granted to the app origin, and the user
//    agent is the service's. Chromium caches certificate verdicts per partition and
//    Electron never drops them, so no pin ever shares a partition with another.
//  - The device token lives only in the partition's cookie store (`own_device`, HttpOnly, Secure, SameSite=Strict);
//    pairing, route checks and revocation are `ses.fetch` in that partition (the same proxy and pin).
//  - A window has no preload, context isolation and the sandbox, so the page cannot reach this shell's IPC. Anything
//    outside the app origin is refused in the window and opens in the system browser (http/https) only right after the
//    user's input there. WebRTC sends no UDP outside the proxy, and a download is saved only from the app origin and
//    only through a save dialog.
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { BrowserWindow, session, shell, type Session, type WebContents } from "electron"
import type log from "electron-log/main.js"
import { isRendererUrl } from "@opencode/desktop/src/main/windows/scheme"
import { appOrigin } from "../../shared/remote-pc"
import { audioOnlyCheck, audioOnlyRequest } from "../media-permission"
import { DEFAULT_WINDOW_BACKGROUND } from "../window-tone"
import { RemotePcError, type DeviceCredential, type Transport } from "./pairing"
import { ACCEPT, certificateVerdict } from "./pin"
import { partitionName, REMOVED_MARK, type PartitionPrefix } from "./store"

type Logger = ReturnType<typeof log.scope>

const DEVICE_COOKIE = "own_device"
const PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"])
/** How long the user's last input in a PC window lets a link open in the system browser (Chromium's 5 s). */
const ACTIVATION_MS = 5_000
/** Input that counts as the user's (Chromium's activation-triggering input): a press, not a move or a wheel. */
const ACTIVATING = new Set(["mouseDown", "keyDown", "rawKeyDown", "gestureTap", "touchEnd", "pointerDown"])

export interface PartitionOptions {
  readonly prefix: PartitionPrefix
  /** The service's CONNECT proxy (proxy.ts). */
  readonly proxyPort: () => Promise<number>
  /** The partition's user agent from Electron's default one. */
  readonly userAgent: (base: string) => string
  /** Title of the save dialog of a download from this PC's page. */
  readonly saveTitle: (pcKey: string) => string
  readonly logger: Logger
}

export type Partitions = ReturnType<typeof createPartitions>

export function createPartitions(options: PartitionOptions) {
  const logger = options.logger
  /** By partition name. */
  const sessions = new Map<string, Promise<Session>>()
  /** Partitions whose last certificate verdict was a reject; cleared by an accept or any response. */
  const mismatches = new Set<string>()
  /** The proxy found no route during the current request. */
  const unreachables = new Set<string>()

  /** The configured session of the partition of (`pcKey`, `pin`), made once per run. */
  function sessionFor(pcKey: string, pin: string) {
    const name = partitionName(pcKey, pin, options.prefix)
    const known = sessions.get(name)
    if (known) return known
    const made = configure(pcKey, pin, name)
    sessions.set(name, made)
    made.catch(() => sessions.delete(name))
    return made
  }

  async function configure(pcKey: string, pin: string, name: string) {
    const ses = session.fromPartition(`persist:${name}`)
    // `<-loopback>`: loopback goes through the proxy too (and gets 403) instead of Chromium's implicit bypass.
    await ses.setProxy({
      mode: "fixed_servers",
      proxyRules: `127.0.0.1:${await options.proxyPort()}`,
      proxyBypassRules: "<-loopback>",
    })
    // This partition's one pin and the app host, for its whole life (pin.ts).
    ses.setCertificateVerifyProc((request, callback) => {
      const verdict = certificateVerdict({ hostname: request.hostname, pem: request.certificate.data }, pcKey, pin)
      if (verdict === ACCEPT) mismatches.delete(name)
      if (verdict !== ACCEPT) {
        mismatches.add(name)
        logger.warn("certificate refused", {
          pcKey,
          hostname: request.hostname,
          fingerprint: request.certificate.fingerprint,
        })
      }
      callback(verdict)
    })
    ses.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(
        (PERMISSIONS.has(permission) ||
          audioOnlyRequest(permission, "mediaTypes" in details ? details.mediaTypes : undefined)) &&
          sameOrigin(details.requestingUrl, pcKey),
      ),
    )
    ses.setPermissionCheckHandler(
      (_contents, permission, origin, details) =>
        (PERMISSIONS.has(permission) || audioOnlyCheck(permission, details.mediaType)) && sameOrigin(origin, pcKey),
    )
    ses.setUserAgent(options.userAgent(ses.getUserAgent()))
    // Files from the PC's own pages (blob: URLs keep the app origin) go through the save dialog, never a silent write.
    ses.on("will-download", (event, item) => {
      if (!sameOrigin(item.getURL(), pcKey)) {
        event.preventDefault()
        logger.info("download refused", { pcKey })
        return
      }
      item.setSaveDialogOptions({ title: options.saveTitle(pcKey) })
    })
    return ses
  }

  /** The device token from the partition's cookie store; it leaves main only as `Authorization: Bearer` to the PC. */
  async function deviceToken(ses: Session, pcKey: string) {
    const cookies = await ses.cookies.get({ url: `${appOrigin(pcKey)}/`, name: DEVICE_COOKIE }).catch(() => [])
    return cookies[0]?.value
  }

  /** The claim's token straight into the partition's cookie store; the partition is in use (again) from here. */
  async function storeCredential(ses: Session, pcKey: string, credential: DeviceCredential) {
    await ses.cookies.set({
      url: `${appOrigin(pcKey)}/`,
      name: DEVICE_COOKIE,
      value: credential.token,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      expirationDate: Math.floor(credential.expiresAt / 1000),
    })
    await ses.cookies.flushStore()
    // A removal or a failed pairing earlier in this run may have marked this partition: it is in use again, keep it.
    if (ses.storagePath) await rm(path.join(ses.storagePath, REMOVED_MARK), { force: true }).catch(() => undefined)
  }

  function transportFor(ses: Session, pcKey: string, pin: string): Transport {
    const name = partitionName(pcKey, pin, options.prefix)
    return (target, init) => {
      unreachables.delete(pcKey)
      return ses
        .fetch(`${appOrigin(pcKey)}${target}`, {
          method: init.method ?? "GET",
          // The partition's user agent, stated explicitly for ses.fetch.
          headers: { ...init.headers, "user-agent": ses.getUserAgent() },
          body: init.body,
          signal: init.signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        })
        .then(
          (response) => {
            mismatches.delete(name)
            return response
          },
          (error: unknown) => {
            throw networkError(pcKey, name, error, init.signal)
          },
        )
    }
  }

  function networkError(pcKey: string, partition: string, error: unknown, signal: AbortSignal | undefined) {
    if (signal?.aborted) return new RemotePcError("aborted")
    if (unreachables.has(pcKey)) return new RemotePcError("unreachable")
    if (mismatches.has(partition)) return new RemotePcError("pin_mismatch")
    const message = error instanceof Error ? error.message : String(error)
    if (/ERR_(CERT|SSL|BAD_SSL)/i.test(message)) return new RemotePcError("pin_mismatch", message)
    if (/ERR_(TUNNEL|PROXY|CONNECTION|TIMED_OUT|NAME|ADDRESS|NETWORK|INTERNET|EMPTY_RESPONSE)/i.test(message))
      return new RemotePcError("unreachable", message)
    return new RemotePcError("failed", message)
  }

  /** Clears a partition nothing uses any more and marks its folder; the folder goes on the next start (store.ts). */
  async function retire(pcKey: string, pin: string) {
    const ses = await sessionFor(pcKey, pin)
    await Promise.all([ses.clearStorageData(), ses.clearCache(), ses.closeAllConnections()]).catch((error: unknown) =>
      logger.warn("partition clear failed", { pcKey, error: String(error) }),
    )
    // The session keeps its files open until this process exits, so the folder cannot go now.
    if (ses.storagePath)
      await writeFile(path.join(ses.storagePath, REMOVED_MARK), "").catch((error: unknown) =>
        logger.warn("partition mark failed", { pcKey, error: String(error) }),
      )
  }

  return {
    sessionFor,
    deviceToken,
    storeCredential,
    transportFor,
    retire,
    /** The proxy reached one of the PC's routes. */
    reached: (pcKey: string) => void unreachables.delete(pcKey),
    /** The proxy found no route of the PC. */
    unreachable: (pcKey: string) => void unreachables.add(pcKey),
    /** Why the page of (`pcKey`, `pin`) did not load: no route, or the certificate (anything else counts as a route). */
    loadFailure(pcKey: string, pin: string): "unreachable" | "reauth" {
      return unreachables.has(pcKey) || !mismatches.has(partitionName(pcKey, pin, options.prefix))
        ? "unreachable"
        : "reauth"
    },
  }
}

/** Web preferences of a window that shows a PC's own-web: no own preload, so the page has neither window.electron nor window.own. */
export function pageWebPreferences(ses: Session) {
  return { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false }
}

/**
 * The window rules of 08 §3.4 5: no UDP outside the proxy, links outside the app origin only to the system browser
 * and only right after the user's input in this window, and no beforeunload hold on closing.
 */
export function hardenWindow(contents: WebContents, pcKey: string, logger: Logger) {
  // WebRTC only through the proxy: no UDP that would bypass it or show this PC's addresses to the page.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
  // Electron gives these handlers no user-gesture flag, so the window keeps its own: a link leaves for the system
  // browser only within ACTIVATION_MS of the user's input here (like Chromium's transient activation). A page cannot
  // open pages there by itself.
  let activated = 0
  contents.on("input-event", (_event, input) => {
    if (ACTIVATING.has(input.type)) activated = Date.now()
  })
  const openUserLink = (url: string) => {
    if (Date.now() - activated <= ACTIVATION_MS) return openOutside(url)
    logger.info("external link without user input refused", { pcKey })
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url, pcKey)) openUserLink(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    if (sameOrigin(url, pcKey)) return
    event.preventDefault()
    openUserLink(url)
  })
  // A page's beforeunload never holds this window (Electron would cancel the close silently otherwise).
  contents.on("will-prevent-unload", (event) => event.preventDefault())
}

export function sameOrigin(url: string, pcKey: string) {
  return URL.canParse(url) && new URL(url).origin === appOrigin(pcKey)
}

/** `payload` on `channel` to every own-web window of this shell (never to a PC's window: those are no renderer URL). */
export function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    const contents = win.webContents
    if (win.isDestroyed() || contents.isDestroyed() || !isRendererUrl(contents.getURL())) continue
    contents.send(channel, payload)
  }
}

/** Shown in the window when the page cannot load; [다시 시도] is a link to the app origin (allowed in-window). */
export function problemPage(title: string, message: string, pcKey: string) {
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<style>:root{color-scheme:dark}body{margin:0;display:grid;place-items:center;height:100vh;background:${DEFAULT_WINDOW_BACKGROUND};color:#e6e6e6;font:14px/1.6 "Segoe UI","Malgun Gothic",sans-serif}
main{max-width:420px;padding:24px;text-align:center}h1{font-size:16px;margin:0 0 8px}p{margin:0 0 16px;color:#a0a0a0}
a{display:inline-block;padding:6px 14px;border-radius:8px;background:#2a2a2a;color:#e6e6e6;text-decoration:none}a:hover{background:#333}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p><a href="${appOrigin(pcKey)}/">다시 시도</a></main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function openOutside(url: string) {
  if (!URL.canParse(url)) return
  const protocol = new URL(url).protocol
  if (protocol !== "http:" && protocol !== "https:") return
  void shell.openExternal(url).catch(() => undefined)
}

// 원격 PC (08 §3.4–3.6, §4.1): other PCs' own-web, each in its own pinned window. Loaded on the first `own:remote-pcs.*`
// call (own-shell.ts registers the channels, remote-pcs/ipc.ts checks the sender and the input).
//  - One partition per PC and pin, `persist:ownpc-<pcKey>-<pin hash>`, set up by partition.ts: this service's
//    CONNECT proxy, the pin, the permissions, and the user agent ` OwnOpenCodeApp/1 (desktop)` (own-web skips its
//    service worker; the PC's SAS dialog names the device from it). A link that names a stored PC under another pin is
//    refused (key_changed): a PC with a new key also has a new pcKey. A removed PC's partition is deleted on the next
//    start.
//  - Pairing and route refresh are `ses.fetch` in that partition, so they get the same proxy and pin. The device
//    token goes from the claim response straight into the partition's cookie store; remote-pcs.json and the renderer
//    never see it.
//  - The window follows partition.ts (no preload, links outside only after the user's input, no UDP outside the
//    proxy); a download's save dialog names the PC.
import { randomUUID } from "node:crypto"
import path from "node:path"
import { app, BrowserWindow, type Session } from "electron"
import log from "electron-log/main.js"
import {
  OwnIpc,
  type OwnRemotePc,
  type OwnRemotePcError,
  type OwnRemotePcPairResult,
  type OwnRemotePcPairStart,
} from "../../preload/own-api"
import { appOrigin, parsePairingLink, type PairingLink } from "../../shared/remote-pc"
import { DEFAULT_WINDOW_BACKGROUND } from "../window-tone"
import {
  awaitApproval,
  claimDevice,
  fetchRoutes,
  openPairing,
  RemotePcError,
  revokeDevice,
  type Transport,
} from "./pairing"
import { broadcast, createPartitions, hardenWindow, pageWebPreferences, problemPage, sameOrigin } from "./partition"
import { createConnectProxy } from "./proxy"
import {
  loadRemotePcs,
  partitionName,
  purgeRemovedPartitions,
  keyChanged,
  saveRemotePcs,
  STORE_FILE,
  type RemotePcRecord,
} from "./store"

const logger = log.scope("remote-pc")
const USER_AGENT_SUFFIX = " OwnOpenCodeApp/1 (desktop)"
/** `/auth/connect/<code>` answers at once; a slow route list still fits. */
const OPEN_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 15_000
/** `POST /own/device/revoke` on removal; past this the PC is removed here without it (08 §3.6a). */
const REVOKE_TIMEOUT_MS = 5_000
/** A finished pairing's result stays readable this long (the renderer asks for it right after starting). */
const RESULT_TTL_MS = 60_000

type State = OwnRemotePc["state"]

interface Pairing {
  readonly link: PairingLink
  readonly controller: AbortController
  /** Its routes count for the proxy only while active. */
  active: boolean
  result: Promise<OwnRemotePcPairResult>
}

let records: RemotePcRecord[] = []
let loading: Promise<void> | undefined
let writing = Promise.resolve()
const states = new Map<string, State>()
const lastRoutes = new Map<string, string>()
const pairings = new Map<string, Pairing>()
const windows = new Map<string, BrowserWindow>()
const refreshing = new Map<string, Promise<void>>()

const partitions = createPartitions({
  prefix: "ownpc",
  proxyPort: () => proxy.port(),
  userAgent: (base) => `${base}${USER_AGENT_SUFFIX}`,
  saveTitle: (pcKey) => `${find(pcKey)?.name ?? pcKey}에서 받은 파일 저장`,
  logger,
})

const proxy = createConnectProxy({
  routes(pcKey) {
    const pairing = activePairings(pcKey)[0]
    return pairing ? pairing.link.routes : find(pcKey)?.routes
  },
  lastRoute: (pcKey) => lastRoutes.get(pcKey),
  connected(pcKey, route) {
    partitions.reached(pcKey)
    if (lastRoutes.get(pcKey) === route) return
    lastRoutes.set(pcKey, route)
    const record = find(pcKey)
    if (record && record.routes.includes(route)) replace({ ...record, lastRoute: route })
  },
  unreachable: partitions.unreachable,
})

export async function list(): Promise<readonly OwnRemotePc[]> {
  await load()
  // First look in this run: check each PC once (its window checks again on every load).
  for (const record of records) {
    if (states.has(record.pcKey)) continue
    states.set(record.pcKey, "checking")
    void refresh(record.pcKey)
  }
  return snapshot()
}

export async function pair(text: string): Promise<OwnRemotePcPairStart> {
  const parsed = parsePairingLink(text)
  if (!parsed.ok) return { ok: false, error: "invalid_link", detail: parsed.problem }
  await load()
  const link = parsed.link
  if (keyChanged(records, link)) {
    logger.warn("pairing refused: the link changes a stored PC's key", { pcKey: link.pcKey })
    return failure("key_changed")
  }
  // One pairing per PC: a newer link replaces a running one.
  activePairings(link.pcKey).forEach((pairing) => stop(pairing))
  const id = randomUUID()
  const controller = new AbortController()
  const pairing: Pairing = { link, controller, active: true, result: Promise.resolve(failure("aborted")) }
  // Registered before the first request: the proxy needs the link's routes.
  pairings.set(id, pairing)
  // The link's pin decides the partition: the stored PC's own (same pin), or a fresh one for a new PC.
  const started = await partitions
    .sessionFor(link.pcKey, link.pin)
    .then(async (ses) => {
      const transport = partitions.transportFor(ses, link.pcKey, link.pin)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)])
      return { ses, transport, opened: await openPairing(transport, link.code, signal) }
    })
    .catch((error: unknown) => errorOf(error, controller.signal))
  if (started instanceof RemotePcError) {
    end(id, pairing)
    logger.info("pairing refused", { pcKey: link.pcKey, error: started.code, detail: started.detail })
    void release(link)
    return failure(started.code, started.detail)
  }
  logger.info("pairing opened", { pcKey: link.pcKey, routes: link.routes.length })
  pairing.result = complete(started.ses, started.transport, pairing, started.opened.claim)
    .catch((error: unknown) => {
      const reason = errorOf(error, controller.signal)
      logger.info("pairing ended", { pcKey: link.pcKey, error: reason.code, detail: reason.detail })
      pairing.active = false
      void release(link)
      return failure(reason.code, reason.detail)
    })
    .finally(() => end(id, pairing))
  return {
    ok: true,
    pairingId: id,
    pcKey: link.pcKey,
    name: link.name,
    sas: started.opened.sas,
    expiresAt: started.opened.expiresAt,
  }
}

export function waitPairing(pairingId: string): Promise<OwnRemotePcPairResult> {
  return pairings.get(pairingId)?.result ?? Promise.resolve(failure("failed", "unknown pairing"))
}

export function cancelPairing(pairingId: string) {
  const pairing = pairings.get(pairingId)
  if (pairing) stop(pairing)
}

export async function open(pcKey: string) {
  await load()
  const record = find(pcKey)
  if (!record) return false
  const existing = windows.get(pcKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return true
  }
  const ses = await partitions.sessionFor(pcKey, record.pin)
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    title: windowTitle(record.name),
    backgroundColor: DEFAULT_WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    // 08 §3.4 5: no own preload, so the remote page has neither window.electron nor window.own.
    webPreferences: pageWebPreferences(ses),
  })
  windows.set(pcKey, win)
  const contents = win.webContents
  hardenWindow(contents, pcKey, logger)
  // The title names the PC; the remote page's own title would hide which PC this is.
  win.on("page-title-updated", (event) => event.preventDefault())
  contents.on("did-finish-load", () => {
    if (sameOrigin(contents.getURL(), pcKey)) void refresh(pcKey)
  })
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3: aborted by a newer navigation.
    if (!isMainFrame || code === -3 || !sameOrigin(url, pcKey)) return
    const state = partitions.loadFailure(pcKey, record.pin)
    logger.info("window load failed", { pcKey, code, description, state })
    setState(pcKey, state)
    const name = find(pcKey)?.name ?? pcKey
    void win.loadURL(problemPage(name, problemMessage(state), pcKey)).catch(() => undefined)
  })
  win.on("closed", () => {
    if (windows.get(pcKey) === win) windows.delete(pcKey)
    emit()
  })
  emit()
  void win.loadURL(`${appOrigin(pcKey)}/`).catch(() => undefined)
  return true
}

export async function remove(pcKey: string) {
  await load()
  activePairings(pcKey).forEach((pairing) => stop(pairing))
  // Only a known PC's partition is touched (never one made up from an arbitrary key).
  const record = find(pcKey)
  if (!record) return false
  closeWindow(pcKey)
  const ses = await partitions.sessionFor(pcKey, record.pin)
  // 08 §3.6a: the PC revokes this device first, while the record still gives the proxy its routes. A PC that does
  // not answer within REVOKE_TIMEOUT_MS is removed here anyway (its 설정 > 휴대폰·다른 PC still lists the device).
  const token = await partitions.deviceToken(ses, pcKey)
  const revoked = token
    ? await revokeDevice(
        partitions.transportFor(ses, pcKey, record.pin),
        token,
        AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      ).catch(() => false)
    : false
  await partitions.retire(pcKey, record.pin)
  records = records.filter((entry) => entry.pcKey !== pcKey)
  states.delete(pcKey)
  lastRoutes.delete(pcKey)
  partitions.reached(pcKey)
  await persist()
  emit()
  logger.info("removed", { pcKey, revoked })
  return true
}

// ---- pairing

async function complete(ses: Session, transport: Transport, pairing: Pairing, claim: string) {
  const signal = pairing.controller.signal
  const link = pairing.link
  await awaitApproval(transport, claim, { signal })
  const credential = await claimDevice(transport, claim, signal)
  await partitions.storeCredential(ses, link.pcKey, credential)
  // pair() checked once, at the start. A newer link for this PC stopped this pairing while it was past its last
  // request: the newer one stays. And a stored PC never changes its key, whatever finished in between. Either way the
  // caller releases this partition, and its cookie goes with it. No await from here to replace().
  signal.throwIfAborted()
  if (keyChanged(records, link)) throw new RemotePcError("key_changed")
  const previous = find(link.pcKey)
  const last = lastRoutes.get(link.pcKey)
  replace({
    pcKey: link.pcKey,
    name: link.name,
    pin: link.pin,
    routes: link.routes,
    lastRoute: last && link.routes.includes(last) ? last : undefined,
    deviceId: credential.deviceId,
    expiresAt: credential.expiresAt,
    addedAt: previous?.addedAt ?? Date.now(),
  })
  states.set(link.pcKey, "connected")
  // Paired again (always under the same key, refused above otherwise): sockets that carried the old credential go.
  if (previous) await ses.closeAllConnections().catch(() => undefined)
  await writing
  emit()
  logger.info("paired", { pcKey: link.pcKey, deviceId: credential.deviceId, again: !!previous })
  return { ok: true as const, pcKey: link.pcKey, name: link.name }
}

function stop(pairing: Pairing) {
  pairing.active = false
  pairing.controller.abort()
}

function end(id: string, pairing: Pairing) {
  pairing.active = false
  setTimeout(() => {
    if (pairings.get(id) === pairing) pairings.delete(id)
  }, RESULT_TTL_MS)
}

function activePairings(pcKey: string) {
  return [...pairings.values()].filter((pairing) => pairing.active && pairing.link.pcKey === pcKey)
}

/** After a pairing that did not happen: its partition goes too, unless the stored PC or a newer pairing uses it. */
function release(link: PairingLink) {
  if (find(link.pcKey)?.pin === link.pin) return
  if (activePairings(link.pcKey).some((pairing) => pairing.link.pin === link.pin)) return
  return partitions.retire(link.pcKey, link.pin)
}

function closeWindow(pcKey: string) {
  const win = windows.get(pcKey)
  // destroy(): no beforeunload prompt from the remote page.
  if (win && !win.isDestroyed()) win.destroy()
  windows.delete(pcKey)
}

function failure(error: OwnRemotePcError, detail?: string) {
  return detail ? { ok: false as const, error, detail } : { ok: false as const, error }
}

function errorOf(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return new RemotePcError("aborted")
  if (error instanceof RemotePcError) return error
  return new RemotePcError("failed", error instanceof Error ? error.message : String(error))
}

// ---- route refresh and state (08 §3.6)

function refresh(pcKey: string) {
  const running = refreshing.get(pcKey)
  if (running) return running
  const next = check(pcKey).finally(() => refreshing.delete(pcKey))
  refreshing.set(pcKey, next)
  return next
}

async function check(pcKey: string) {
  const record = find(pcKey)
  if (!record) return
  if (record.expiresAt <= Date.now()) return setState(pcKey, "reauth")
  const ses = await partitions.sessionFor(pcKey, record.pin)
  const token = await partitions.deviceToken(ses, pcKey)
  if (!token) return setState(pcKey, "reauth")
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const result = await fetchRoutes(partitions.transportFor(ses, pcKey, record.pin), token, signal).catch(
    (error: unknown) => errorOf(error, signal),
  )
  if (result instanceof RemotePcError) return setState(pcKey, result.code === "pin_mismatch" ? "reauth" : "unreachable")
  if (result.kind === "unauthorized") return setState(pcKey, "reauth")
  // Reached over the pinned connection; the gateway just has no routes to offer (app access being turned off).
  if (result.kind === "unavailable") return setState(pcKey, "connected")
  const current = find(pcKey)
  if (!current) return
  if (result.pcKey !== pcKey || result.pin !== current.pin) {
    // 08 §3.6: another key behind the same name changes nothing and asks for pairing again.
    logger.warn("routes from another pin; pairing again is needed", { pcKey })
    return setState(pcKey, "reauth")
  }
  const name = result.name || current.name
  const changed = name !== current.name || result.routes.join("\n") !== current.routes.join("\n")
  if (changed) {
    const last = current.lastRoute && result.routes.includes(current.lastRoute) ? current.lastRoute : undefined
    replace({ ...current, name, routes: result.routes, lastRoute: last })
    const win = windows.get(pcKey)
    if (win && !win.isDestroyed()) win.setTitle(windowTitle(name))
  }
  setState(pcKey, "connected", changed)
}

function setState(pcKey: string, state: State, force = false) {
  if (!force && states.get(pcKey) === state) return
  states.set(pcKey, state)
  emit()
}

function snapshot(): OwnRemotePc[] {
  const now = Date.now()
  return records.map((record) => {
    const win = windows.get(record.pcKey)
    return {
      pcKey: record.pcKey,
      name: record.name,
      state: record.expiresAt <= now ? "reauth" : (states.get(record.pcKey) ?? "checking"),
      addedAt: record.addedAt,
      expiresAt: record.expiresAt,
      open: !!win && !win.isDestroyed(),
    }
  })
}

/** The list to every own-web window of this shell (never to a remote PC's window). */
function emit() {
  broadcast(OwnIpc.remotePcsChanged, snapshot())
}

// ---- store

function storeFile() {
  return path.join(app.getPath("userData"), STORE_FILE)
}

function load() {
  loading ??= loadRemotePcs(storeFile()).then(async (loaded) => {
    records = loaded
    loaded.forEach((record) => {
      if (record.lastRoute) lastRoutes.set(record.pcKey, record.lastRoute)
    })
    // First call of this run, before any PC session exists: partitions retired in an earlier run go now.
    const purged = await purgeRemovedPartitions(
      path.join(app.getPath("userData"), "Partitions"),
      new Set(loaded.map((record) => partitionName(record.pcKey, record.pin))),
    )
    if (purged.length) logger.info("removed partitions deleted", { purged })
  })
  return loading
}

function find(pcKey: string) {
  return records.find((record) => record.pcKey === pcKey)
}

function replace(record: RemotePcRecord) {
  const index = records.findIndex((entry) => entry.pcKey === record.pcKey)
  records = index < 0 ? [...records, record] : records.map((entry, at) => (at === index ? record : entry))
  void persist()
}

/** Writes one after another, each the list as it is when its turn comes. */
function persist() {
  writing = writing
    .then(() => saveRemotePcs(storeFile(), records))
    .catch((error: unknown) => logger.warn("remote-pcs.json write failed", { error: String(error) }))
  return writing
}

// ---- window helpers

function windowTitle(name: string) {
  return `${name} — 다른 PC`
}

function problemMessage(state: State) {
  return state === "reauth"
    ? "PC의 인증서가 처음 연결할 때와 달라요. 연결을 멈췄어요. PC에서 새 링크를 만들어 다시 연결하세요."
    : "PC에 연결할 수 없어요. PC가 켜져 있고 Tailscale이나 포트 전달이 설정돼 있는지 확인하세요."
}

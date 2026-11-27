// 모바일 미리보기 (08 §4.3): this PC's own own-web as the Android app gets it, in one window of this shell. Loaded on
// the first `own:mobile-preview.*` call (own-shell.ts registers the channels, remote-pcs/ipc.ts checks the sender and
// the input).
//  - The preview is a normal `kind:"app"` device of this PC's gateway: own-web asks `devices.pair.start` for a link
//    with one loopback route (`appRoute:"loopback"`) and hands it only to `pair` here; the PC's own [허용] approves it
//    like any phone. Nothing approves it by itself.
//  - Its partition is `persist:ownpreview-<pcKey>-<pin hash>` (partition.ts), apart from a 원격 PC entry of the same
//    PC. It has its own CONNECT proxy that tunnels only this PC's pcKey to the stored loopback route (proxy.ts
//    singleRoute), so the page reaches nothing else, not even another 원격 PC. The device token lives only in the
//    partition's cookie store; mobile-preview.json and the renderer never see it.
//  - The window has no preload and the sandbox (partition.ts), a fixed size (the device's screen, scaled to fit), and
//    a menu: device presets, 회전, 키보드, 뒤로, 새로 고침, 라이트/다크, 개발자 도구, 지우기. The phone look comes from
//    emulation.ts through the window's in-process debugger, applied before the first load.
import { randomUUID } from "node:crypto"
import path from "node:path"
import { app, BrowserWindow, dialog, Menu, screen, type MenuItemConstructorOptions, type Session } from "electron"
import log from "electron-log/main.js"
import {
  OwnIpc,
  type OwnMobilePreview,
  type OwnMobilePreviewOrientation,
  type OwnMobilePreviewPreset,
  type OwnRemotePcError,
  type OwnRemotePcPairResult,
  type OwnRemotePcPairStart,
} from "../../preload/own-api"
import { appOrigin, formatRoute, parseRoute, type PairingLink } from "../../shared/remote-pc"
import { DEFAULT_WINDOW_BACKGROUND } from "../window-tone"
import {
  DEFAULT_PRESET,
  emulate,
  emulationCommands,
  fitScale,
  PRESET_IDS,
  PRESETS,
  previewUserAgent,
  screenSize,
  type ColorScheme,
  type EmulationState,
} from "./emulation"
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
import { createConnectProxy, singleRoute } from "./proxy"
import {
  loadMobilePreview,
  parsePreviewLink,
  partitionName,
  PREVIEW_FILE,
  purgeRemovedPartitions,
  saveMobilePreview,
  type MobilePreviewRecord,
} from "./store"

const logger = log.scope("mobile-preview")
const OPEN_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 15_000
/** `POST /own/device/revoke` on removal; past this the preview is removed here without it. */
const REVOKE_TIMEOUT_MS = 5_000
/** A finished pairing's result stays readable this long (the renderer asks for it right after starting). */
const RESULT_TTL_MS = 60_000

type State = Exclude<OwnMobilePreview["state"], "none">

interface Pairing {
  readonly id: string
  readonly link: PairingLink
  readonly controller: AbortController
  /** Its route counts for the proxy only while active. */
  active: boolean
  result: Promise<OwnRemotePcPairResult>
}

let record: MobilePreviewRecord | undefined
let loading: Promise<void> | undefined
let writing = Promise.resolve()
let state: State | undefined
let refreshing: Promise<void> | undefined
let win: BrowserWindow | undefined
/** The window's own view settings; a new window starts without keyboard and with the system scheme. */
let view: Pick<EmulationState, "keyboard" | "scheme"> = { keyboard: false, scheme: "system" }
const pairings = new Map<string, Pairing>()

const partitions = createPartitions({
  prefix: "ownpreview",
  proxyPort: () => proxy.port(),
  userAgent: () => previewUserAgent(process.versions.chrome),
  saveTitle: () => "모바일 미리보기에서 받은 파일 저장",
  logger,
})

const proxy = createConnectProxy(
  singleRoute(
    () => {
      const pairing = [...pairings.values()].find((entry) => entry.active)
      if (pairing) return { pcKey: pairing.link.pcKey, route: pairing.link.routes[0]! }
      return record && { pcKey: record.pcKey, route: record.route }
    },
    { connected: (pcKey) => partitions.reached(pcKey), unreachable: partitions.unreachable },
  ),
)

export async function status(): Promise<OwnMobilePreview> {
  await load()
  // First look in this run: check once (the window checks again on every load).
  if (record && !state) {
    state = "checking"
    void refresh()
  }
  return snapshot()
}

export async function pair(text: string): Promise<OwnRemotePcPairStart> {
  const parsed = parsePreviewLink(text)
  if (!parsed.ok) return failure("invalid_link", parsed.problem)
  await load()
  const link = parsed.link
  // 08 §3.5: this PC under another key is a forged or corrupt link; 지우기 first if the key really changed.
  if (record && record.pcKey === link.pcKey && record.pin !== link.pin) {
    logger.warn("pairing refused: the link changes the stored key", { pcKey: link.pcKey })
    return failure("key_changed")
  }
  // One pairing at a time: a newer link replaces a running one.
  pairings.forEach((pairing) => stop(pairing))
  const pairing: Pairing = {
    id: randomUUID(),
    link,
    controller: new AbortController(),
    active: true,
    result: Promise.resolve(failure("aborted")),
  }
  // Registered before the first request: the proxy needs the link's route.
  pairings.set(pairing.id, pairing)
  const signal = pairing.controller.signal
  const started = await partitions
    .sessionFor(link.pcKey, link.pin)
    .then(async (ses) => {
      const transport = partitions.transportFor(ses, link.pcKey, link.pin)
      return {
        ses,
        transport,
        opened: await openPairing(transport, link.code, AbortSignal.any([signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)])),
      }
    })
    .catch((error: unknown) => errorOf(error, signal))
  if (started instanceof RemotePcError) {
    end(pairing)
    logger.info("pairing refused", { error: started.code, detail: started.detail })
    void release(link)
    return failure(started.code, started.detail)
  }
  logger.info("pairing opened", { pcKey: link.pcKey })
  pairing.result = complete(started.ses, started.transport, pairing, started.opened.claim)
    .catch((error: unknown) => {
      const reason = errorOf(error, signal)
      logger.info("pairing ended", { error: reason.code, detail: reason.detail })
      pairing.active = false
      void release(link)
      return failure(reason.code, reason.detail)
    })
    .finally(() => end(pairing))
  return {
    ok: true,
    pairingId: pairing.id,
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

/** `port`: the app listener's (`gateway.status().app.port`); the stored route keeps its loopback address. */
export async function open(port: number) {
  await load()
  if (!record) return false
  const route = parseRoute(record.route)
  const moved = route && route.port !== port ? formatRoute({ host: route.host, port }) : undefined
  if (moved) {
    logger.info("app port moved", { from: record.route, to: moved })
    update({ ...record, route: moved })
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }
  const current = record
  const ses = await partitions.sessionFor(current.pcKey, current.pin)
  view = { keyboard: false, scheme: "system" }
  const scale = scaleFor(current)
  const size = screenSize(current)
  const next = new BrowserWindow({
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: windowTitle(current.preset),
    backgroundColor: DEFAULT_WINDOW_BACKGROUND,
    webPreferences: pageWebPreferences(ses),
  })
  win = next
  const contents = next.webContents
  hardenWindow(contents, current.pcKey, logger)
  next.setMenu(menu())
  next.on("page-title-updated", (event) => event.preventDefault())
  contents.on("did-finish-load", () => {
    if (sameOrigin(contents.getURL(), current.pcKey)) void refresh()
  })
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3: aborted by a newer navigation.
    if (!isMainFrame || code === -3 || !sameOrigin(url, current.pcKey)) return
    const failed = partitions.loadFailure(current.pcKey, current.pin)
    logger.info("window load failed", { code, description, state: failed })
    setState(failed)
    void next.loadURL(problemPage("모바일 미리보기", problemMessage(failed), current.pcKey)).catch(() => undefined)
  })
  // Electron documents that DevTools opening for the window detaches this debugger: the look comes back once it closes.
  contents.debugger.on("detach", () => {
    if (!next.isDestroyed()) contents.once("devtools-closed", () => void applyEmulation())
  })
  next.on("closed", () => {
    if (win === next) win = undefined
    emit()
  })
  emit()
  // Before the first load: own-web picks its host and reads `(pointer: coarse)` at startup.
  await applyEmulation()
  void next.loadURL(`${appOrigin(current.pcKey)}/`).catch(() => undefined)
  return true
}

export async function remove() {
  await load()
  pairings.forEach((pairing) => stop(pairing))
  const current = record
  if (!current) return false
  closeWindow()
  const ses = await partitions.sessionFor(current.pcKey, current.pin)
  // The gateway revokes the device first, while the record still gives the proxy its route. A gateway that does not
  // answer within REVOKE_TIMEOUT_MS (app access off) keeps the device listed in 설정 > 휴대폰·다른 PC until it expires.
  const token = await partitions.deviceToken(ses, current.pcKey)
  const revoked = token
    ? await revokeDevice(
        partitions.transportFor(ses, current.pcKey, current.pin),
        token,
        AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      ).catch(() => false)
    : false
  await partitions.retire(current.pcKey, current.pin)
  record = undefined
  state = undefined
  partitions.reached(current.pcKey)
  await persist()
  emit()
  logger.info("removed", { deviceId: current.deviceId, revoked })
  return true
}

// ---- pairing

async function complete(ses: Session, transport: Transport, pairing: Pairing, claim: string) {
  const signal = pairing.controller.signal
  const link = pairing.link
  await awaitApproval(transport, claim, { signal })
  const credential = await claimDevice(transport, claim, signal)
  await partitions.storeCredential(ses, link.pcKey, credential)
  // pair() checked once, at the start: a newer link stopped this one, or the stored key changed in between. Either
  // way the caller releases this partition, and its cookie goes with it. No await from here to update().
  signal.throwIfAborted()
  if (record && record.pcKey === link.pcKey && record.pin !== link.pin) throw new RemotePcError("key_changed")
  const previous = record
  update({
    pcKey: link.pcKey,
    pin: link.pin,
    route: link.routes[0]!,
    deviceId: credential.deviceId,
    expiresAt: credential.expiresAt,
    addedAt: Date.now(),
    preset: previous?.preset ?? DEFAULT_PRESET,
    orientation: previous?.orientation ?? "portrait",
  })
  state = "connected"
  // Another identity of this PC (its gateway made a new key): the old partition is of no use any more.
  if (previous && previous.pcKey !== link.pcKey) void partitions.retire(previous.pcKey, previous.pin)
  // Paired again under the same key: sockets that carried the old credential go, and an open window loads again.
  if (previous && previous.pcKey === link.pcKey) {
    await ses.closeAllConnections().catch(() => undefined)
    if (win && !win.isDestroyed()) win.webContents.reload()
  }
  await writing
  emit()
  logger.info("paired", { deviceId: credential.deviceId, again: !!previous })
  return { ok: true as const, pcKey: link.pcKey, name: link.name }
}

function stop(pairing: Pairing) {
  pairing.active = false
  pairing.controller.abort()
}

function end(pairing: Pairing) {
  pairing.active = false
  setTimeout(() => {
    if (pairings.get(pairing.id) === pairing) pairings.delete(pairing.id)
  }, RESULT_TTL_MS)
}

/** After a pairing that did not happen: its partition goes too, unless the stored preview or a newer pairing uses it. */
function release(link: PairingLink) {
  if (record && record.pcKey === link.pcKey && record.pin === link.pin) return
  const reused = [...pairings.values()].some(
    (pairing) => pairing.active && pairing.link.pcKey === link.pcKey && pairing.link.pin === link.pin,
  )
  if (reused) return
  return partitions.retire(link.pcKey, link.pin)
}

function failure(error: OwnRemotePcError, detail?: string) {
  return detail ? { ok: false as const, error, detail } : { ok: false as const, error }
}

function errorOf(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return new RemotePcError("aborted")
  if (error instanceof RemotePcError) return error
  return new RemotePcError("failed", error instanceof Error ? error.message : String(error))
}

// ---- state

function refresh() {
  refreshing ??= check().finally(() => (refreshing = undefined))
  return refreshing
}

async function check() {
  const current = record
  if (!current) return
  if (current.expiresAt <= Date.now()) return setState("reauth")
  const ses = await partitions.sessionFor(current.pcKey, current.pin)
  const token = await partitions.deviceToken(ses, current.pcKey)
  if (!token) return setState("reauth")
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const result = await fetchRoutes(partitions.transportFor(ses, current.pcKey, current.pin), token, signal).catch(
    (error: unknown) => errorOf(error, signal),
  )
  if (result instanceof RemotePcError) return setState(result.code === "pin_mismatch" ? "reauth" : "unreachable")
  if (result.kind === "unauthorized") return setState("reauth")
  // The routes themselves do not matter here: the preview always dials loopback.
  if (result.kind === "ok" && (result.pcKey !== current.pcKey || result.pin !== current.pin)) return setState("reauth")
  setState("connected")
}

function setState(next: State) {
  if (state === next) return
  state = next
  emit()
}

function snapshot(): OwnMobilePreview {
  if (!record) return { state: "none" }
  return {
    state: record.expiresAt <= Date.now() ? "reauth" : (state ?? "checking"),
    pcKey: record.pcKey,
    pin: record.pin,
    deviceId: record.deviceId,
    addedAt: record.addedAt,
    expiresAt: record.expiresAt,
    open: !!win && !win.isDestroyed(),
    preset: record.preset,
    orientation: record.orientation,
  }
}

/** The preview to every own-web window of this shell (never to the preview window or a 원격 PC's). */
function emit() {
  broadcast(OwnIpc.mobilePreviewChanged, snapshot())
}

// ---- the window

function closeWindow() {
  // destroy(): no beforeunload prompt from the page.
  if (win && !win.isDestroyed()) win.destroy()
  win = undefined
}

function scaleFor(current: Pick<MobilePreviewRecord, "preset" | "orientation">) {
  const area = (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay())
    .workAreaSize
  return fitScale(screenSize(current), area)
}

/** The stored device look plus the window's view settings, sent again in full; resizes the window to the screen. */
async function applyEmulation() {
  const current = record
  const target = win
  if (!current || !target || target.isDestroyed()) return
  const scale = scaleFor(current)
  const size = screenSize(current)
  target.setContentSize(Math.round(size.width * scale), Math.round(size.height * scale))
  target.setTitle(windowTitle(current.preset))
  const commands = emulationCommands({ ...current, ...view }, { chrome: process.versions.chrome, scale })
  await emulate(target.webContents, commands).catch((error: unknown) =>
    logger.warn("emulation failed", { error: String(error) }),
  )
}

function setLook(change: { readonly preset?: OwnMobilePreviewPreset; readonly orientation?: OwnMobilePreviewOrientation }) {
  if (!record) return
  update({ ...record, ...change })
  win?.setMenu(menu())
  emit()
  void applyEmulation()
}

function setView(change: Partial<typeof view>) {
  view = { ...view, ...change }
  win?.setMenu(menu())
  void applyEmulation()
}

/** The window's native menu (Korean only, like the 원격 PC window's texts, 08 §4.1). */
function menu() {
  const current = record
  const presets: MenuItemConstructorOptions[] = PRESET_IDS.map((id) => ({
    label: `${PRESETS[id].label} ${PRESETS[id].width}×${PRESETS[id].height}`,
    type: "radio",
    checked: current?.preset === id,
    click: () => setLook({ preset: id }),
  }))
  const schemes: Array<[ColorScheme, string]> = [
    ["system", "시스템 설정"],
    ["light", "라이트"],
    ["dark", "다크"],
  ]
  return Menu.buildFromTemplate([
    {
      label: "기기",
      submenu: [
        ...presets,
        { type: "separator" },
        {
          label: "회전",
          accelerator: "Ctrl+Shift+O",
          click: () => setLook({ orientation: current?.orientation === "landscape" ? "portrait" : "landscape" }),
        },
        {
          label: "키보드",
          type: "checkbox",
          checked: view.keyboard,
          accelerator: "Ctrl+K",
          click: () => setView({ keyboard: !view.keyboard }),
        },
      ],
    },
    {
      label: "보기",
      submenu: [
        {
          label: "뒤로",
          accelerator: "Alt+Left",
          click: () => {
            const history = win?.webContents.navigationHistory
            if (history?.canGoBack()) history.goBack()
          },
        },
        { label: "새로 고침", accelerator: "F5", click: () => win?.webContents.reload() },
        { type: "separator" },
        ...schemes.map(
          ([scheme, label]): MenuItemConstructorOptions => ({
            label,
            type: "radio",
            checked: view.scheme === scheme,
            click: () => setView({ scheme }),
          }),
        ),
        { type: "separator" },
        { label: "개발자 도구", accelerator: "F12", click: () => win?.webContents.openDevTools({ mode: "detach" }) },
      ],
    },
    {
      label: "미리보기",
      submenu: [{ label: "미리보기 기기 지우기…", click: () => void confirmRemove() }],
    },
  ])
}

async function confirmRemove() {
  const target = win
  if (!target || target.isDestroyed()) return
  const answer = await dialog.showMessageBox(target, {
    type: "question",
    buttons: ["지우기", "취소"],
    defaultId: 1,
    cancelId: 1,
    title: "모바일 미리보기",
    message: "미리보기 기기를 지울까요?",
    detail: "이 PC의 설정 > 휴대폰·다른 PC에서 이 미리보기 기기의 연결이 끊기고, 창과 저장된 로그인이 지워져요.",
  })
  if (answer.response === 0) await remove()
}

function windowTitle(preset: OwnMobilePreviewPreset) {
  const look = PRESETS[preset]
  return `모바일 미리보기 — ${look.label} ${look.width}×${look.height}`
}

function problemMessage(failed: State) {
  return failed === "reauth"
    ? "미리보기 기기의 연결이 끊겼어요(연결 끊기, 만료 또는 인증서 변경). 설정 > 휴대폰·다른 PC > 모바일 미리보기에서 다시 만드세요."
    : "이 PC의 앱 연결에 닿지 않아요. 설정 > 휴대폰·다른 PC에서 앱 연결이 켜져 있는지 확인하세요."
}

// ---- store

function storeFile() {
  return path.join(app.getPath("userData"), PREVIEW_FILE)
}

function load() {
  loading ??= loadMobilePreview(storeFile()).then(async (loaded) => {
    record = loaded
    // First call of this run, before any preview session exists: partitions retired in an earlier run go now.
    const purged = await purgeRemovedPartitions(
      path.join(app.getPath("userData"), "Partitions"),
      new Set(loaded ? [partitionName(loaded.pcKey, loaded.pin, "ownpreview")] : []),
      "ownpreview",
    )
    if (purged.length) logger.info("removed partitions deleted", { purged })
  })
  return loading
}

function update(next: MobilePreviewRecord) {
  record = next
  void persist()
}

/** Writes one after another, each the record as it is when its turn comes. */
function persist() {
  writing = writing
    .then(() => saveMobilePreview(storeFile(), record))
    .catch((error: unknown) => logger.warn("mobile-preview.json write failed", { error: String(error) }))
  return writing
}

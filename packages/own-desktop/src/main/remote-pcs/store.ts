// The 원격 PC list, `<userData>\remote-pcs.json` (08 §3.5 "PC 기록"), the 모바일 미리보기 device,
// `<userData>\mobile-preview.json` (08 §4.3), and the partitions' folder names. No device token here: it lives only in
// the partition's cookie store (Chromium encrypts cookies with DPAPI on Windows). Written atomically (temp file +
// rename), read once and validated at this boundary; entries that do not validate are dropped. Electron-free so tests
// run under bun.
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { OwnMobilePreviewOrientation, OwnMobilePreviewPreset } from "../../preload/own-api"
import {
  cleanName,
  cleanRoutes,
  isLoopbackRoute,
  parsePairingLink,
  PC_KEY,
  PIN,
  type LinkProblem,
  type PairingLink,
} from "../../shared/remote-pc"
import { DEFAULT_PRESET, PRESET_IDS } from "./emulation"

export interface RemotePcRecord {
  readonly pcKey: string
  readonly name: string
  readonly pin: string
  /** Preference order: tailnet first. Replaced by `GET /own/routes` while the pin stays the same (08 §3.6). */
  readonly routes: readonly string[]
  /** The route the last tunnel used; tried first. */
  readonly lastRoute?: string
  readonly deviceId: string
  /** Device credential expiry, epoch ms (the cookie expires with it). */
  readonly expiresAt: number
  readonly addedAt: number
}

export const STORE_FILE = "remote-pcs.json"

export async function loadRemotePcs(file: string): Promise<RemotePcRecord[]> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return []
  const records = Option.getOrElse(decodeList(text), () => [])
    .map(record)
    .filter((entry): entry is RemotePcRecord => entry !== undefined)
  // One record per PC; the first wins.
  return records.filter((entry, index) => records.findIndex((other) => other.pcKey === entry.pcKey) === index)
}

export async function saveRemotePcs(file: string, records: readonly RemotePcRecord[]) {
  await writeAtomic(file, `${JSON.stringify(records, null, 2)}\n`)
}

/**
 * `ownpc`: a 원격 PC (08 §3.4). `ownpreview`: this PC's own 모바일 미리보기 (08 §4.3), kept apart even when the same
 * PC is also stored as a 원격 PC: another user agent, another device token, another cookie store.
 */
export type PartitionPrefix = "ownpc" | "ownpreview"

/**
 * The partition of a PC under one pin: `<prefix>-<pcKey>-<first 16 hex of sha256(pin)>` (`persist:` + this; also the
 * folder name under `<userData>\Partitions`). A PC that gets a new key gets a new partition, so no certificate verdict
 * cached under the old pin can decide for the new one (pin.ts).
 */
export function partitionName(pcKey: string, pin: string, prefix: PartitionPrefix = "ownpc") {
  return `${prefix}-${pcKey}-${createHash("sha256").update(pin).digest("hex").slice(0, 16)}`
}

/**
 * Whether a link would change a stored PC's key (08 §3.5). A gateway that makes a new key also makes a new pcKey
 * (own-remote tls.ts), so the same pcKey under another pin is a forged or corrupt link. It is refused before any
 * request; the stored record, its partition and its cookie stay. The same pin pairs again.
 */
export function keyChanged(records: readonly RemotePcRecord[], link: { readonly pcKey: string; readonly pin: string }) {
  const stored = records.find((entry) => entry.pcKey === link.pcKey)
  return stored !== undefined && stored.pin !== link.pin
}

/**
 * Marker a partition folder gets once its storage is cleared and nothing uses it any more (the PC was removed or a
 * pairing under that pin failed). Electron keeps a session (and its open files) until the
 * process exits, so the folder itself goes on the next start, before any session opens it.
 */
export const REMOVED_MARK = ".own-removed"

/**
 * Deletes `<partitions>\<prefix>-…` folders that carry REMOVED_MARK, except the partitions in `keep` (the stored
 * records' current ones: only the marker goes). Each service purges its own prefix against its own records. Unmarked
 * folders are never touched, so an unreadable store file cannot wipe stored logins. Returns the deleted folder names.
 */
export async function purgeRemovedPartitions(
  partitions: string,
  keep: ReadonlySet<string>,
  prefix: PartitionPrefix = "ownpc",
) {
  const pattern = new RegExp(`^${prefix}-[a-z2-7]{12}(?:-[0-9a-f]{16})?$`)
  const names = await readdir(partitions).catch(() => [])
  const deleted = await Promise.all(
    names.map(async (name) => {
      if (!pattern.test(name)) return undefined
      const dir = path.join(partitions, name)
      const mark = path.join(dir, REMOVED_MARK)
      if (!(await stat(mark).catch(() => undefined))) return undefined
      if (keep.has(name)) return void (await rm(mark, { force: true }).catch(() => undefined))
      // Something else holding a file (a scanner): the marker stays and the next start tries again.
      const gone = await rm(dir, { recursive: true, force: true }).then(
        () => true,
        () => false,
      )
      return gone ? name : undefined
    }),
  )
  return deleted.filter((name): name is string => name !== undefined)
}

// ---- 모바일 미리보기 (08 §4.3)

/** This PC's own app identity as the preview paired with it; one record at most. */
export interface MobilePreviewRecord {
  readonly pcKey: string
  readonly pin: string
  /** The app listener on loopback (`127.0.0.1:<port>`); its port follows the gateway's (preview.ts `open`). */
  readonly route: string
  readonly deviceId: string
  readonly expiresAt: number
  readonly addedAt: number
  readonly preset: OwnMobilePreviewPreset
  readonly orientation: OwnMobilePreviewOrientation
}

export const PREVIEW_FILE = "mobile-preview.json"

/**
 * A preview link: a pairing link whose one route is this PC itself (`devices.pair.start{appRoute:"loopback"}`).
 * Anything else (a tailnet or DDNS route, a LAN address, several routes) is refused: the preview's proxy dials
 * loopback only.
 */
export function parsePreviewLink(
  text: string,
): { ok: true; link: PairingLink } | { ok: false; problem: LinkProblem | "loopback" } {
  const parsed = parsePairingLink(text)
  if (!parsed.ok) return parsed
  const routes = parsed.link.routes
  if (routes.length !== 1 || !isLoopbackRoute(routes[0]!)) return { ok: false, problem: "loopback" }
  return parsed
}

export async function loadMobilePreview(file: string): Promise<MobilePreviewRecord | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const entry = Option.getOrUndefined(decodePreview(text))
  if (!entry || !isLoopbackRoute(entry.route)) return undefined
  return {
    pcKey: entry.pcKey,
    pin: entry.pin,
    route: cleanRoutes([entry.route])[0]!,
    deviceId: entry.deviceId,
    expiresAt: entry.expiresAt,
    addedAt: entry.addedAt,
    preset: PRESET_IDS.find((id) => id === entry.preset) ?? DEFAULT_PRESET,
    orientation: entry.orientation === "landscape" ? "landscape" : "portrait",
  }
}

/** `undefined` deletes the file (the preview was removed). */
export async function saveMobilePreview(file: string, record: MobilePreviewRecord | undefined) {
  if (!record) return rm(file, { force: true })
  await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
}

/** Atomic: a crash leaves the previous file or the new one, never half of one. */
async function writeAtomic(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, "utf8")
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

const decodePreview = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      pcKey: Schema.String.check(Schema.isPattern(PC_KEY)),
      pin: Schema.String.check(Schema.isPattern(PIN)),
      route: Schema.String,
      deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      expiresAt: Schema.Finite,
      addedAt: Schema.Finite,
      preset: Schema.optional(Schema.Unknown),
      orientation: Schema.optional(Schema.Unknown),
    }),
  ),
)

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))

/** The fields a record cannot do without; the others fall back (no name: the pcKey, no times: 0, no last route). */
const decodeEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    pcKey: Schema.String.check(Schema.isPattern(PC_KEY)),
    pin: Schema.String.check(Schema.isPattern(PIN)),
    deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    routes: Schema.Array(Schema.Unknown),
    name: Schema.optional(Schema.Unknown),
    lastRoute: Schema.optional(Schema.Unknown),
    expiresAt: Schema.optional(Schema.Unknown),
    addedAt: Schema.optional(Schema.Unknown),
  }),
)

function record(value: unknown): RemotePcRecord | undefined {
  const entry = Option.getOrUndefined(decodeEntry(value))
  if (!entry) return undefined
  const routes = cleanRoutes(entry.routes.filter((route): route is string => typeof route === "string"))
  if (routes.length === 0) return undefined
  const expiresAt = typeof entry.expiresAt === "number" && Number.isFinite(entry.expiresAt) ? entry.expiresAt : 0
  const addedAt = typeof entry.addedAt === "number" && Number.isFinite(entry.addedAt) ? entry.addedAt : 0
  const lastRoute =
    typeof entry.lastRoute === "string" && routes.includes(entry.lastRoute) ? entry.lastRoute : undefined
  return {
    pcKey: entry.pcKey,
    name: (typeof entry.name === "string" ? cleanName(entry.name) : "") || entry.pcKey,
    pin: entry.pin,
    routes,
    lastRoute,
    deviceId: entry.deviceId,
    expiresAt,
    addedAt,
  }
}

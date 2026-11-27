// What a per-session draft keeps besides its text (03 §19.9 "세션별 초안 보존(이미지 포함)"): the mention chips and the
// ready attachments, in IndexedDB with image and file bytes as Blobs ("IndexedDB에 이미지 blob"). The text itself stays
// in composer/drafts.ts (localStorage, read synchronously when a session opens, so the box never flashes empty).
//
// Writes are debounced 500 ms per draft and run when the page is idle (03 §20.2 R6); a `data:` URI becomes a Blob only
// there, with the native base64 decoder when the browser has one. Reading turns Blobs back into `data:` URIs with
// FileReader (off the main thread). At most 50 drafts are kept; the oldest go first.
import type { ReadyAttachment } from "@/attachments"
import type { MentionChip } from "@/mentions"
import { idbStore, whenIdle, type KeyValueStore } from "./idb"
import { isChip } from "./model"

const DEBOUNCE_MS = 500
const MAX_DRAFTS = 50
const INDEX = "__index"
const CACHE = 24

export interface DraftExtras {
  readonly chips: readonly MentionChip[]
  readonly attachments: readonly ReadyAttachment[]
}

type StoredAttachment =
  | { readonly kind: "inline"; readonly name: string; readonly mime: string; readonly blob: Blob }
  | { readonly kind: "path"; readonly name: string; readonly mime: string; readonly path: string }

interface DraftRecord {
  readonly version: 1
  readonly savedAt: number
  readonly chips: readonly MentionChip[]
  readonly attachments: readonly StoredAttachment[]
}

export interface DraftExtrasStore {
  /** Remembers the draft's chips and attachments; written later (debounced, idle). Empty removes the record. */
  save(key: string, extras: DraftExtras): void
  /** The stored extras of a draft, or `undefined`. Pending writes of that draft win over the stored record. */
  load(key: string): Promise<DraftExtras | undefined>
  /** Writes everything pending now (blur, page hidden). */
  flush(): Promise<void>
}

export function createDraftExtras(
  store: KeyValueStore = idbStore("drafts"),
  now: () => number = Date.now,
): DraftExtrasStore {
  const pending = new Map<string, DraftExtras>()
  /** `data:` URI → Blob of recent conversions (restored drafts are saved again without decoding twice). */
  const blobs = new Map<string, Blob>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelIdle: (() => void) | undefined
  let writing: Promise<void> = Promise.resolve()

  const remember = (uri: string, blob: Blob) => {
    blobs.delete(uri)
    blobs.set(uri, blob)
    while (blobs.size > CACHE) blobs.delete(blobs.keys().next().value!)
  }

  const write = () => {
    timer = undefined
    cancelIdle = undefined
    const batch = [...pending]
    pending.clear()
    writing = writing.then(async () => {
      if (!batch.length) return
      const index = readIndex(await store.get(INDEX))
      for (const [key, extras] of batch) {
        const at = index.indexOf(key)
        if (at >= 0) index.splice(at, 1)
        if (!extras.chips.length && !extras.attachments.length) {
          await store.delete(key)
          continue
        }
        const record: DraftRecord = {
          version: 1,
          savedAt: now(),
          chips: extras.chips.map((chip) => ({ ...chip })),
          attachments: extras.attachments.map((item) => stored(item, remember, blobs)),
        }
        await store.set(key, record)
        index.push(key)
      }
      const dropped = index.splice(0, Math.max(0, index.length - MAX_DRAFTS))
      await Promise.all(dropped.map((key) => store.delete(key)))
      await store.set(INDEX, index)
    })
    return writing
  }

  const schedule = () => {
    clearTimeout(timer)
    cancelIdle?.()
    timer = setTimeout(() => (cancelIdle = whenIdle(() => void write())), DEBOUNCE_MS)
  }

  return {
    save(key, extras) {
      pending.set(key, { chips: [...extras.chips], attachments: [...extras.attachments] })
      schedule()
    },
    async load(key) {
      const waiting = pending.get(key)
      if (waiting) return waiting
      await writing
      const record = readRecord(await store.get(key))
      if (!record) return undefined
      const attachments = await Promise.all(
        record.attachments.map(async (item): Promise<ReadyAttachment | undefined> => {
          if (item.kind === "path") return item
          const uri = await dataUri(item.blob).catch(() => undefined)
          if (!uri) return undefined
          remember(uri, item.blob)
          return { kind: "inline", name: item.name, mime: item.mime, uri }
        }),
      )
      return { chips: record.chips, attachments: attachments.filter((item) => item !== undefined) }
    },
    async flush() {
      clearTimeout(timer)
      cancelIdle?.()
      await write()
    },
  }
}

function stored(
  item: ReadyAttachment,
  remember: (uri: string, blob: Blob) => void,
  cache: ReadonlyMap<string, Blob>,
): StoredAttachment {
  if (item.kind === "path") return { kind: "path", name: item.name, mime: item.mime, path: item.path }
  const known = cache.get(item.uri)
  const blob = known ?? blobFromDataUri(item.uri, item.mime)
  if (!known) remember(item.uri, blob)
  return { kind: "inline", name: item.name, mime: item.mime, blob }
}

/** `data:[mime][;base64],payload` → Blob (the attachment store writes base64 URIs from FileReader). */
export function blobFromDataUri(uri: string, fallbackMime: string) {
  const comma = uri.indexOf(",")
  const meta = comma > 5 ? uri.slice(5, comma) : ""
  const payload = comma >= 0 ? uri.slice(comma + 1) : ""
  const mime = meta.split(";", 1)[0] || fallbackMime
  if (!meta.endsWith(";base64")) return new Blob([decodeURIComponent(payload)], { type: mime })
  return new Blob([decodeBase64(payload)], { type: mime })
}

function decodeBase64(payload: string): Uint8Array<ArrayBuffer> {
  // Chromium 140+/Edge: native and fast; older engines: atob.
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }).fromBase64
  if (native) return native(payload)
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function dataUri(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => (typeof reader.result === "string" ? resolve(reader.result) : reject()))
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(blob)
  })
}

function readIndex(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** Shape check at the storage boundary: an old or foreign record reads as "nothing stored". */
function readRecord(value: unknown): DraftRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.chips) || !Array.isArray(record.attachments)) return undefined
  const attachments = record.attachments.flatMap((item: unknown): StoredAttachment[] => {
    if (typeof item !== "object" || item === null) return []
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== "string" || typeof entry.mime !== "string") return []
    if (entry.kind === "path" && typeof entry.path === "string")
      return [{ kind: "path", name: entry.name, mime: entry.mime, path: entry.path }]
    if (entry.kind === "inline" && entry.blob instanceof Blob)
      return [{ kind: "inline", name: entry.name, mime: entry.mime, blob: entry.blob }]
    return []
  })
  return {
    version: 1,
    savedAt: typeof record.savedAt === "number" ? record.savedAt : 0,
    chips: record.chips.filter(isChip),
    attachments,
  }
}

/** The app's draft extras store (one per window). */
export const draftExtras = createDraftExtras()

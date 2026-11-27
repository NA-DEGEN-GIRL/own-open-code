// Attachment store of one composer (03 §18.10): chips per draft (server + session, like drafts), the entry points
// (file picker, Ctrl+U, paste, drop), reading inline media, uploads with progress, and the
// prompt parts for sending. Uploads outlive a session switch: the chip stays with the draft it was added to.
//
// Performance (03 §20.2): no layout reads; upload progress reaches the store at most every 200 ms (R3, side surfaces
// ≤ 4 updates/s while a turn streams); thumbnails are object URLs (revoked on removal), never base64 in the DOM; inline
// media are read by FileReader (native, off the main thread) only when the route is inline.
import { abort } from "@opencode/util/abort"
import { batch, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import type { OwnHost } from "@/host"
import { onComposerRestore } from "./intents"
import {
  attachmentMime,
  isImage,
  promptParts,
  routeFor,
  uploadPath,
  type ModelInput,
  type PromptParts,
  type ReadyAttachment,
} from "./model"
import { serverTmp, upload } from "./upload"

const PROGRESS_MS = 200
const HEAD_BYTES = 4096

export type ChipState = "reading" | "uploading" | "ready" | "failed"

export interface Chip {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly mime: string
  /** Object URL of an image file, for the thumbnail and preview. */
  readonly thumb?: string
  readonly route: "inline" | "path" | "upload"
  /** An image sent as a path because the model cannot read images (03 §18.10). */
  readonly imageFallback: boolean
  readonly state: ChipState
  /** Uploaded bytes. */
  readonly loaded: number
  readonly ready?: ReadyAttachment
}

export type AttachmentNotice =
  | { readonly kind: "tooLarge"; readonly name: string; readonly size: number }
  | { readonly kind: "failed" | "readFailed"; readonly name: string }
  | { readonly kind: "duplicate" }

export interface AttachmentsInput {
  readonly host: OwnHost
  readonly runtime: () => ServerRuntime | undefined
  /** Server key of the draft (restore requests are matched on it). */
  readonly serverKey: () => string
  /** `undefined` on the new-session screen. */
  readonly sessionID: () => string | undefined
  /** Location for uploads: the session's directory, or the folder of the next new session. */
  readonly directory: () => string | undefined
  /** Input modalities of the model the message goes to; `undefined` while the model catalog is not loaded. */
  readonly input: () => ModelInput | undefined
  /** Loads the model catalog (the composer: the location's `model.sync`), awaited once when `input()` is unknown. */
  readonly loadInput?: () => Promise<unknown>
  readonly notify: (notice: AttachmentNotice) => void
}

export type Attachments = ReturnType<typeof createAttachments>

interface Pending {
  readonly controller: AbortController
}

export function createAttachments(input: AttachmentsInput) {
  const [state, setState] = createStore<{ drafts: Record<string, Chip[] | undefined> }>({ drafts: {} })
  const pending = new Map<string, Pending>()
  let sequence = 0
  const key = () => draftOf(input.serverKey(), input.sessionID())
  const list = () => state.drafts[key()] ?? []

  const patch = (draft: string, id: string, change: Partial<Chip>) =>
    setState(
      "drafts",
      draft,
      produce((chips) => {
        const index = chips?.findIndex((chip) => chip.id === id) ?? -1
        if (chips && index >= 0) chips[index] = { ...chips[index]!, ...change }
      }),
    )
  const push = (draft: string, chip: Chip) => setState("drafts", draft, (chips) => [...(chips ?? []), chip])

  async function add(files: readonly File[]) {
    const draft = key()
    const runtime = input.runtime()
    await Promise.all(files.map((file) => addOne(file, draft, runtime)))
  }

  async function addOne(file: File, draft: string, runtime: ServerRuntime | undefined) {
    const head = new Uint8Array(
      await file
        .slice(0, HEAD_BYTES)
        .arrayBuffer()
        .catch(() => new ArrayBuffer(0)),
    )
    const mime = attachmentMime(file.name, file.type, head)
    const nativePath = input.host.capabilities.nativeFilePaths ? input.host.files?.pathForFile?.(file) : undefined
    const route = routeFor({
      size: file.size,
      mime,
      input: await modalities(),
      local: runtime?.kind === "local",
      nativePath,
    })
    if (route.kind === "reject") return input.notify({ kind: "tooLarge", name: file.name, size: file.size })
    if (
      route.kind === "path" &&
      (state.drafts[draft] ?? []).some((chip) => chip.ready?.kind === "path" && chip.ready.path === route.path)
    )
      return input.notify({ kind: "duplicate" })
    const id = `att_${Date.now().toString(36)}_${(sequence++).toString(36)}`
    const chip: Chip = {
      id,
      name: file.name || "attachment",
      size: file.size,
      mime,
      thumb: isImage(mime) ? URL.createObjectURL(file) : undefined,
      route: route.kind,
      imageFallback: route.kind === "inline" ? false : route.imageFallback,
      state: route.kind === "path" ? "ready" : route.kind === "inline" ? "reading" : "uploading",
      loaded: 0,
      ready: route.kind === "path" ? { kind: "path", name: file.name, mime, path: route.path } : undefined,
    }
    push(draft, chip)
    if (route.kind === "inline") return readInline(draft, chip, file)
    if (route.kind === "upload") return uploadOne(draft, chip, file, runtime)
  }

  /** The model's input modalities; an unknown model (catalog not loaded yet) is loaded once, else reads text only. */
  async function modalities(): Promise<ModelInput> {
    const known = input.input()
    if (known) return known
    await input.loadInput?.().catch(() => undefined)
    return input.input() ?? { image: false, pdf: false }
  }
  async function readInline(draft: string, chip: Chip, file: File) {
    try {
      const uri = await dataUrl(file)
      patch(draft, chip.id, { state: "ready", ready: { kind: "inline", name: chip.name, mime: chip.mime, uri } })
    } catch {
      patch(draft, chip.id, { state: "failed" })
      input.notify({ kind: "readFailed", name: chip.name })
    }
  }

  async function uploadOne(draft: string, chip: Chip, file: File, runtime: ServerRuntime | undefined) {
    const directory = input.directory()
    const controller = new AbortController()
    pending.set(chip.id, { controller })
    let last = 0
    try {
      if (!runtime || directory === undefined) throw new Error("no server or folder for the upload")
      const tmp = await serverTmp(runtime)
      const path = await upload({
        runtime,
        directory,
        path: uploadPath(tmp, crypto.randomUUID(), chip.name),
        file,
        signal: controller.signal,
        onProgress: (loaded) => {
          const now = performance.now()
          if (now - last < PROGRESS_MS && loaded < file.size) return
          last = now
          patch(draft, chip.id, { loaded })
        },
      })
      patch(draft, chip.id, {
        state: "ready",
        loaded: file.size,
        ready: { kind: "path", name: chip.name, mime: chip.mime, path },
      })
    } catch (error) {
      if (controller.signal.aborted) return
      console.error("[own-web] attachment upload failed", error)
      patch(draft, chip.id, { state: "failed" })
      input.notify({ kind: "failed", name: chip.name })
    } finally {
      pending.delete(chip.id)
    }
  }

  function remove(id: string, draft = key()) {
    pending.get(id)?.controller.abort()
    const chip = state.drafts[draft]?.find((item) => item.id === id)
    if (chip?.thumb) URL.revokeObjectURL(chip.thumb)
    setState("drafts", draft, (chips) => chips?.filter((item) => item.id !== id))
  }

  /** After a send: the chips of that draft go away (the message carries them now). */
  function clear(draft = key()) {
    batch(() => (state.drafts[draft] ?? []).forEach((chip) => remove(chip.id, draft)))
  }

  /** Re-adds the attachments of a restored message (revert, queue `편집`) as ready chips. */
  function restore(draft: string, attachments: readonly ReadyAttachment[]) {
    const existing = state.drafts[draft] ?? []
    for (const attachment of attachments) {
      const duplicate = existing.some(
        (chip) =>
          (attachment.kind === "path" && chip.ready?.kind === "path" && chip.ready.path === attachment.path) ||
          (attachment.kind === "inline" && chip.ready?.kind === "inline" && chip.ready.uri === attachment.uri),
      )
      if (duplicate) continue
      push(draft, {
        id: `att_${Date.now().toString(36)}_${(sequence++).toString(36)}`,
        name: attachment.name,
        size: attachment.kind === "inline" ? approximateBytes(attachment.uri) : 0,
        mime: attachment.mime,
        thumb: attachment.kind === "inline" && isImage(attachment.mime) ? attachment.uri : undefined,
        route: attachment.kind === "inline" ? "inline" : "path",
        imageFallback: false,
        state: "ready",
        loaded: 0,
        ready: attachment,
      })
    }
  }
  onCleanup(
    onComposerRestore((detail) => {
      if (detail.ifDraft !== undefined) return
      const draft = draftOf(detail.serverKey, detail.sessionID)
      if (detail.mode === "replace") clear(draft)
      restore(draft, detail.attachments)
    }),
  )

  // ---- entry points ----

  /** `＋` and Ctrl+U: a hidden file input (the browser's picker; desktop passes paths through `pathForFile`). */
  function pick() {
    const element = document.createElement("input")
    element.type = "file"
    element.multiple = true
    element.addEventListener("change", () => void add([...(element.files ?? [])]), { once: true })
    element.click()
  }

  /** Paste: files and images on the clipboard become chips; plain text is left to the textarea. */
  function paste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.items ?? [])].flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [named(file)] : []
    })
    if (!files.length) return false
    event.preventDefault()
    void add(files)
    return true
  }

  /** Drop from the OS (files only; text drops stay the browser's). */
  function drop(transfer: DataTransfer | null) {
    const files = [...(transfer?.files ?? [])]
    if (!files.length) return false
    void add(files)
    return true
  }

  // ---- sending ----

  const uploading = () => list().some((chip) => chip.state === "reading" || chip.state === "uploading")

  /** Prompt parts of the current draft: ready chips only (failed ones are left out and stay visible). */
  function prepare(text: string): PromptParts {
    const ready = list().flatMap((chip) => (chip.state === "ready" && chip.ready ? [chip.ready] : []))
    return promptParts(text, ready)
  }

  onCleanup(() => {
    pending.forEach((item) => abort(item.controller))
    Object.values(state.drafts).forEach((chips) =>
      chips?.forEach((chip) => chip.thumb?.startsWith("blob:") && URL.revokeObjectURL(chip.thumb)),
    )
  })

  return {
    /** Chips of the current draft. */
    list,
    /** Chips of another draft (tests, the queue edit path). */
    of: (serverKey: string, sessionID: string | undefined) => state.drafts[draftOf(serverKey, sessionID)] ?? [],
    key,
    add,
    remove,
    clear,
    restore,
    pick,
    paste,
    drop,
    /** Sending waits while this is true (the composer disables send and says why). */
    uploading,
    prepare,
    /** Images that will go inline, for the token note (03 §18.10). */
    inlineImages: () => list().filter((chip) => chip.route === "inline" && isImage(chip.mime)).length,
    /** An image goes as a path because the model cannot read images. */
    imageFallback: () => list().some((chip) => chip.imageFallback),
  }
}

/** Draft key: one set of chips per server and session, `new` on the new-session screen. */
export function draftOf(serverKey: string, sessionID: string | undefined) {
  return `${serverKey}/${sessionID ?? "new"}`
}

function dataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => (typeof reader.result === "string" ? resolve(reader.result) : reject()))
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}

/** Pasted screenshots arrive as `image.png` every time; give them a readable, unique-ish name. */
function named(file: File) {
  if (file.name && file.name !== "image.png") return file
  return new File([file], clipboardName(file.type), { type: file.type, lastModified: file.lastModified })
}

function clipboardName(type: string) {
  const extension = type.split("/")[1]?.split("+")[0] || "png"
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")
  return `screenshot-${stamp}.${extension}`
}

function approximateBytes(uri: string) {
  const comma = uri.indexOf(",")
  return comma < 0 ? 0 : Math.floor(((uri.length - comma - 1) * 3) / 4)
}

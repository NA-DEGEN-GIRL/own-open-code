// Attachment pipeline decisions (03 §18.10), pure so they are unit-tested as tables. The store (store.ts) gathers the
// state, these decide, the store performs. Routes follow upstream `composer/attachments/attachments.ts` (re-written
// for own-web, not vendored): media the model reads natively travel inline with the prompt; everything else reaches
// the model as a path on the server — the file's own path when the host knows it and the server is local
// (`capabilities.nativeFilePaths`), otherwise an upload into the server's temp folder (`paths.tmp`).
import type { JsonValue, PromptFileAttachment, SessionInboxInfo, SessionMessageUser } from "@opencode/client"

/** 03 §18.10: one file above 25 MiB is refused (`own.attach.tooLarge`). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Upstream: the server rejects inline attachments above this size, so larger media take the path route. */
export const MAX_INLINE_BYTES = 20 * 1024 * 1024
/**
 * Core's per-image estimate (`IMAGE_TOKEN_ESTIMATE`, packages/core/src/session/compaction.ts:96). Core does not export
 * it (03 §18.10 "검증 항목"), so the value is mirrored here; `model.test.ts` pins it to the source.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_500

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const IMAGE_EXTENSIONS: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

export interface ModelInput {
  readonly image: boolean
  readonly pdf: boolean
}

/** Input modalities of a catalog model (`capabilities.input`); unknown models read text only. */
export function modelInput(capabilities: { readonly input: readonly string[] } | undefined): ModelInput {
  const input = capabilities?.input ?? []
  return { image: input.includes("image"), pdf: input.includes("pdf") }
}

export type Route =
  | { readonly kind: "reject"; readonly reason: "tooLarge" }
  /** Bytes inline with the prompt (`data:` URI), media the model reads natively. */
  | { readonly kind: "inline" }
  /** The file's own path on the local server (desktop `nativeFilePaths`). */
  | { readonly kind: "path"; readonly path: string; readonly imageFallback: boolean }
  /** Upload into `paths.tmp/uploads/<uuid>/<name>`, then the server path. */
  | { readonly kind: "upload"; readonly imageFallback: boolean }

export interface RouteInput {
  readonly size: number
  readonly mime: string
  readonly input: ModelInput
  /** The server shares this machine's filesystem and the host may pass file paths. */
  readonly local: boolean
  /** `host.files.pathForFile(file)` when the capability is on; empty for pasted/generated files. */
  readonly nativePath?: string | null
}

export function routeFor(input: RouteInput): Route {
  if (input.size > MAX_FILE_BYTES) return { kind: "reject", reason: "tooLarge" }
  const native = readsNatively(input.mime, input.input)
  if (native && input.size <= MAX_INLINE_BYTES) return { kind: "inline" }
  // An image the model cannot read goes as a path; the chip says so (own.attach.noImageModel).
  const imageFallback = isImage(input.mime) && !input.input.image
  if (input.local && input.nativePath) return { kind: "path", path: input.nativePath, imageFallback }
  return { kind: "upload", imageFallback }
}

export function readsNatively(mime: string, input: ModelInput) {
  if (IMAGE_MIMES.has(mime)) return input.image
  if (mime === "application/pdf") return input.pdf
  return false
}

export function isImage(mime: string) {
  return IMAGE_MIMES.has(mime)
}

/**
 * Text-like files normalize to `text/plain` so chips label them as text; images and PDFs keep their type (also when the
 * browser left it empty but the extension says so); other files keep a binary type unless the first bytes look like
 * text (no NUL, few control characters). `head` is at most the first 4 KiB.
 */
export function attachmentMime(name: string, type: string, head: Uint8Array) {
  const base = type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (IMAGE_MIMES.has(base) || base === "application/pdf") return base
  const suffix = extension(name)
  const byExtension = IMAGE_EXTENSIONS[suffix] ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!base || base === "application/octet-stream") && byExtension) return byExtension
  if (base.startsWith("text/") || TEXT_MIMES.has(base) || base.endsWith("+json") || base.endsWith("+xml"))
    return "text/plain"
  const binary = base || "application/octet-stream"
  if (head.some((byte) => byte === 0)) return binary
  const control = head.filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length
  if (head.length > 0 && control / head.length > 0.3) return binary
  return "text/plain"
}

function extension(name: string) {
  const index = name.lastIndexOf(".")
  return index === -1 ? "" : name.slice(index + 1).toLowerCase()
}

/**
 * The upload target (03 §18.10, upstream destination.ts): one directory per upload keeps the original name without
 * collisions. Separators and control characters in the name are replaced so the name cannot leave that directory.
 */
export function uploadPath(tmp: string, id: string, name: string) {
  const safe =
    name
      .replace(/[\\/]+/g, "_")
      .replace(/[\u0000-\u001f]/g, "")
      .replace(/^\.+$/, "_")
      .trim() || "attachment"
  return `${tmp.replace(/[\\/]+$/, "")}/uploads/${id}/${safe}`
}

/** 03 §7.5-style sizes: `212KB`, `3.4MB`, `25MiB` limits in the refusal text. */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10}MB`
}

// ---------------------------------------------------------------------------------------------------------------
// Prompt assembly

/** A chip that is ready to send. */
export type ReadyAttachment =
  | { readonly kind: "inline"; readonly name: string; readonly mime: string; readonly uri: string }
  | { readonly kind: "path"; readonly name: string; readonly mime: string; readonly path: string }

export interface PromptParts {
  readonly text: string
  readonly files: readonly { readonly uri: string; readonly name?: string }[]
  /** Passed as the prompt's `metadata` (JSON). */
  readonly metadata?: { [key: string]: JsonValue }
}

/**
 * Upstream `buildPromptRequest` + `formatAttachmentReference`: path references reach the model as text lines
 * (`Attached file: \`<path>\``) and the message UI through `metadata` (`displayText`, `attachments`, `comments`), the
 * shape session-ui and upstream read back (`readPromptPresentation`). Inline media go as `data:` URIs in `files`.
 */
export function promptParts(text: string, attachments: readonly ReadyAttachment[]): PromptParts {
  const paths = attachments.filter((item) => item.kind === "path")
  const inline = attachments.filter((item) => item.kind === "inline")
  if (!attachments.length) return { text, files: [] }
  const references = paths.map((item) => ({ name: item.name, mime: item.mime, path: item.path }))
  return {
    text: [...(text.trim() ? [text] : []), ...references.map((item) => `Attached file: \`${item.path}\``)].join("\n"),
    files: inline.map((item) => ({ uri: item.uri, name: item.name })),
    metadata: references.length ? { displayText: text, comments: [], attachments: references } : undefined,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Restoring a message into the composer (revert 18.7, queue edit 18.9)

export interface RestoredDraft {
  readonly text: string
  readonly attachments: readonly ReadyAttachment[]
}

type UserPayload = Extract<SessionInboxInfo, { type: "user" }>["payload"]

/** Text the user typed (`metadata.displayText`) and the attachments the composer added (inline files + paths). */
export function draftFrom(message: Pick<SessionMessageUser, "text" | "files" | "metadata"> | UserPayload) {
  const metadata = message.metadata as Record<string, unknown> | undefined
  const display = metadata?.["displayText"]
  const references = readReferences(metadata?.["attachments"])
  const text = typeof display === "string" ? display : stripReferences(message.text, references)
  const inline = (message.files ?? []).filter(isComposerFile).map(
    (file): ReadyAttachment => ({
      kind: "inline",
      name: file.name ?? "attachment",
      mime: file.mime,
      uri: `data:${file.mime};base64,${file.data}`,
    }),
  )
  const paths = references.map((item): ReadyAttachment => ({ kind: "path", ...item }))
  return { text, attachments: [...inline, ...paths] } satisfies RestoredDraft
}

/** Inline bytes the composer attached itself (not `@` mentions, not `file://` context). */
function isComposerFile(file: PromptFileAttachment) {
  return !file.mention && file.source.type === "inline"
}

function readReferences(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const entry = item as Record<string, unknown>
    return typeof entry.name === "string" && typeof entry.mime === "string" && typeof entry.path === "string"
      ? [{ name: entry.name, mime: entry.mime, path: entry.path }]
      : []
  })
}

function stripReferences(text: string, references: readonly { readonly path: string }[]) {
  if (!references.length) return text
  const lines = new Set(references.map((item) => `Attached file: \`${item.path}\``))
  return text
    .split("\n")
    .filter((line) => !lines.has(line))
    .join("\n")
}

/**
 * Payload for re-admitting a queued prompt (reorder): a stored file goes back by the URI it came from (a `file://`
 * path reference keeps its provenance, upstream 2db9c2e1b3 `storedFileUri`, as the TUI does); an inline one as a
 * `data:` URI.
 */
export function readmitFiles(payload: UserPayload) {
  return (payload.files ?? []).map((file) => ({
    uri: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
    name: file.name,
    description: file.description,
    mention: file.mention,
  }))
}

// File contents for the viewer (03 §19.4). `fs.read` answers the raw bytes (protocol `groups/fs.ts`, the server's
// mime by extension); this module decides how each kind is shown:
//   - text kinds (code, markdown, mermaid, svg, html, csv) are decoded once and handed to session-ui (pierre
//     highlights in its worker pool, markdown parses in its worker; 20.2 R4);
//   - media kinds (image, pdf, audio, video) never become base64 or strings. When the page and the server share an
//     origin and no header carries auth (Vite dev proxy, the web fallback's cookie), an image, audio or video element
//     loads the server URL itself (`'self'`). Otherwise (desktop's `oc://renderer`, SSH hosts with a token header) the
//     bytes are read and shown from a `blob:` URL (`img-src`, `media-src` and `frame-src blob:` in the page CSP).
//     A PDF is always read into a `blob:` URL: since upstream v2.2.6 (b3b02ae092) `fs.read` answers as a sandboxed
//     download (`content-disposition: attachment`), which a frame saves instead of showing.
import { artifactKind, artifactMime, type ArtifactKind } from "./upstream/artifact"

/** Text above this is not decoded until the user asks (pierre virtualizes past 500 KB, but tokenizing is slow). */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024
/** Media above this stays a placeholder (upstream MAX_MEDIA_BYTES). */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024
/** Markdown above this shows its source: the preview renders every block. */
export const MAX_MARKDOWN_PREVIEW = 1024 * 1024

const MEDIA = new Set<ArtifactKind>(["image", "pdf", "audio", "video"])
/** Kinds with a rendered preview and a source view (upstream `previewableKinds` without html and table). */
const PREVIEWABLE = new Set<ArtifactKind>(["markdown", "mermaid", "svg"])

export type ViewKind = ArtifactKind | "binary"

export type FileContent =
  | { readonly type: "text"; readonly kind: ViewKind; readonly text: string; readonly bytes: number }
  | {
      readonly type: "media"
      readonly kind: ViewKind
      readonly blob: Blob
      readonly bytes: number
      readonly hash: number
    }
  | { readonly type: "binary"; readonly bytes: number }
  | { readonly type: "large"; readonly kind: ViewKind; readonly bytes: number }

export function viewKind(path: string): ViewKind {
  return artifactKind(path)
}

export function isMedia(kind: ViewKind) {
  return kind !== "binary" && MEDIA.has(kind)
}

/** Media an element may load from the server URL itself (`mediaSource` "direct"); a frame cannot show a download. */
export function loadsDirect(kind: ViewKind) {
  return isMedia(kind) && kind !== "pdf"
}

export function isPreviewable(kind: ViewKind) {
  return kind !== "binary" && PREVIEWABLE.has(kind)
}

/** Bytes from `fs.read` → what the viewer shows. `force` decodes text above MAX_TEXT_BYTES (`그래도 보기`). */
export function decodeFile(path: string, bytes: Uint8Array, force = false): FileContent {
  const kind = viewKind(path)
  const size = bytes.byteLength
  if (kind === "font") return { type: "binary", bytes: size }
  if (isMedia(kind)) {
    if (size > MAX_MEDIA_BYTES) return { type: "large", kind, bytes: size }
    // Copied into a fresh buffer: the Blob must not keep a view of a larger shared buffer alive.
    return {
      type: "media",
      kind,
      blob: new Blob([bytes.slice()], { type: artifactMime(path) }),
      bytes: size,
      hash: sampledHash(bytes),
    }
  }
  // Text files never contain NUL; one in the first 8 KiB marks a binary (upstream `isBinaryBytes`).
  if (bytes.subarray(0, 8192).includes(0)) return { type: "binary", bytes: size }
  if (size > MAX_TEXT_BYTES && !force) return { type: "large", kind, bytes: size }
  return { type: "text", kind, text: new TextDecoder().decode(bytes), bytes: size }
}

/** Unchanged contents keep the viewer as it is when a refresh reads the file again. */
export function sameContent(a: FileContent | undefined, b: FileContent) {
  if (!a || a.type !== b.type || a.bytes !== b.bytes) return false
  if (a.type === "text" && b.type === "text") return a.text === b.text
  if (a.type === "media" && b.type === "media") return a.hash === b.hash
  return true
}

/** FNV-1a over at most 64 Ki evenly spaced bytes: a re-read image or PDF that did not change keeps its viewer. */
function sampledHash(bytes: Uint8Array) {
  const step = Math.max(1, Math.floor(bytes.byteLength / 65_536))
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.byteLength; index += step) hash = Math.imul(hash ^ bytes[index]!, 0x01000193)
  return hash >>> 0
}

/** How media elements get their bytes: the server URL (same origin, no auth header) or a `blob:` URL. */
export function mediaSource(
  entry: { readonly baseUrl: string; readonly headers?: unknown } | undefined,
  origin: string,
) {
  if (!entry || entry.headers) return "blob" as const
  return URL.canParse(entry.baseUrl) && new URL(entry.baseUrl).origin === origin
    ? ("direct" as const)
    : ("blob" as const)
}

/** The `fs.read` URL the generated client builds (`/api/fs/read/<segments>?location[directory]=…`). */
export function readUrl(baseUrl: string, directory: string, path: string) {
  const base = new URL(baseUrl)
  if (!base.pathname.endsWith("/")) base.pathname += "/"
  const url = new URL(`api/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`, base)
  url.searchParams.append("location[directory]", directory)
  return url.toString()
}

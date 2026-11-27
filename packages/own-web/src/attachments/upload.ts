// Upload into the server's temp folder (03 §18.10): `POST /api/experimental/fs/write?location[directory]=…&path=…`
// with the raw file as the body. XMLHttpRequest, because fetch cannot report upload progress (upstream
// destination.ts). The browser streams the File from disk; nothing is buffered in the page.
//
// Auth follows the connection (16.2): the dev proxy and desktop main inject it, the web fallback sends the same-origin
// cookie, a remote server entry adds its memory-only headers. own-web never builds an Authorization value itself.
import type { ServerRuntime } from "@/data"

export interface UploadInput {
  readonly runtime: ServerRuntime
  /** Location of the request (the session's directory); the target path is absolute and may lie outside it. */
  readonly directory: string
  readonly path: string
  readonly file: Blob
  readonly onProgress: (loaded: number) => void
  readonly signal: AbortSignal
}

export class UploadError extends Error {
  override readonly name = "UploadError"
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Resolves with the absolute path the server wrote. */
export function upload(input: UploadInput) {
  const entry = input.runtime.entry()
  if (!entry) return Promise.reject(new UploadError("server not connected"))
  const url = new URL("api/experimental/fs/write", entry.baseUrl.endsWith("/") ? entry.baseUrl : `${entry.baseUrl}/`)
  url.searchParams.set("location[directory]", input.directory)
  url.searchParams.set("path", input.path)
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", url)
    xhr.responseType = "json"
    xhr.setRequestHeader("content-type", "application/octet-stream")
    for (const [name, value] of Object.entries(entry.headers?.() ?? {})) xhr.setRequestHeader(name, value)
    xhr.upload.addEventListener("progress", (event) => input.onProgress(event.loaded))
    xhr.addEventListener("load", () => {
      const path = writtenPath(xhr.response)
      if (xhr.status !== 200 || !path) return reject(new UploadError(`upload failed (${xhr.status})`, xhr.status))
      input.onProgress(input.file.size)
      resolve(path)
    })
    xhr.addEventListener("error", () => reject(new UploadError("upload failed")))
    xhr.addEventListener("abort", () => reject(new DOMException("upload aborted", "AbortError")))
    if (input.signal.aborted) return reject(new DOMException("upload aborted", "AbortError"))
    input.signal.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(input.file)
  })
}

/** `{ location, data: { path } }` (FileSystem.Write in a Location response). */
function writtenPath(body: unknown) {
  if (typeof body !== "object" || body === null || !("data" in body)) return undefined
  const data = body.data
  if (typeof data !== "object" || data === null || !("path" in data)) return undefined
  return typeof data.path === "string" ? data.path : undefined
}

const tmpByRuntime = new WeakMap<ServerRuntime, Promise<string>>()

/** `paths.tmp` of the server (`GET /api/info`), once per runtime; a failure is retried on the next upload. */
export function serverTmp(runtime: ServerRuntime) {
  const cached = tmpByRuntime.get(runtime)
  if (cached) return cached
  const request = runtime
    .client()
    .server.info()
    .then((info) => info.paths.tmp)
  tmpByRuntime.set(runtime, request)
  request.catch(() => tmpByRuntime.delete(runtime))
  return request
}

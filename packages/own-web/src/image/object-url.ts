// Pictures the transcript shows from inline bytes (a user's attached image, an image card) go into `<img>` as `blob:`
// URLs instead of `data:` URIs. Chromium keeps every `data:` URI an image loaded for as long as the page lives: the
// URI string, about its whole length, stays in the renderer and neither GC nor memory pressure frees it. A long
// session with pictures grew the renderer by the size of every picture scrolled past (2026-11 huge-session bench,
// own/reports/big-session-2026-11.md §2.5). A `blob:` URL is short, and its bytes go once it is revoked.
//
// Rows remount as the transcript scrolls, so a picture keeps one URL while it is cached. The cache holds MAX pictures;
// an older one is revoked only once no `<img>` in the document shows it (a dialog opened from a row reuses the row's
// URL, and an `<img>` that has loaded keeps its picture after a revoke).

const MAX = 8
const DATA = /^data:([\w.+-]+\/[\w.+-]+);base64,/

const urls = new Map<string, string>()

/** A `blob:` URL showing a base64 `data:` URI, or `undefined` for any other URI. */
export function imageSrc(uri: string) {
  const known = urls.get(uri)
  if (known) {
    // Most recently used last.
    urls.delete(uri)
    urls.set(uri, known)
    return known
  }
  const match = DATA.exec(uri)
  if (!match) return
  const url = URL.createObjectURL(new Blob([Uint8Array.fromBase64(uri.slice(match[0].length))], { type: match[1] }))
  urls.set(uri, url)
  trim(uri)
  return url
}

function trim(current: string) {
  // Oldest first; the new picture and any still on screen stay, even past MAX.
  const stale = [...urls].filter(([uri, url]) => uri !== current && !document.querySelector(`img[src="${url}"]`))
  stale.slice(0, Math.max(0, urls.size - MAX)).forEach(([uri, url]) => {
    urls.delete(uri)
    URL.revokeObjectURL(url)
  })
}

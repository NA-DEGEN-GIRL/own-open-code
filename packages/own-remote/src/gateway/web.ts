export * as Web from "./web.js"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * own-web for devices (05 §13.4 "own-web 정적 서빙"): `app\<version>\web` of this install, served at `/` with the
 * service WebUi's CSP rule (`packages/cli/src/services/web-ui.ts`: the one inline script allowed by its hash), SPA
 * fallback to `index.html`, immutable caching for `_assets/`. The page is not a secret, so it is served before device
 * authentication (like the WebUi), and the app shows the pairing screen itself.
 *
 * `index.html` gets two tags on the way out: `<meta name="own-gateway">` (own-web picks its mobile host from it,
 * 05 §13.9 M1) and the PWA manifest link. The service worker and the manifest are only ever reachable here, never on
 * the local web fallback origin (05 §13.6 "서비스 워커").
 *
 * The user manual (`_assets/manual-<hash>.html`, own-web's build, 03 §4.3.1) is the one page the app shows in a frame
 * of its own origin: its CSP says `frame-ancestors 'self'` instead of `'none'`. Its scripts are files beside it.
 */

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

const INLINE_THEME = /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i

/** own-web's build of the user manual (src/manual/vite.ts). */
const MANUAL = /^_assets\/manual-[0-9a-f]+\.html$/

export function csp(hash = "", framed = false) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "frame-src 'self' blob:",
    // Everything a device reaches is this origin (`/srv/<serverKey>`); no other host, no loopback.
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    framed ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
  ].join("; ")
}

export function cspForHtml(body: string) {
  const match = INLINE_THEME.exec(body)
  return csp(match ? createHash("sha256").update(match[2] ?? "").digest("base64") : "")
}

/** Marks the page as served by the gateway and links the PWA manifest (non-script tags: the CSP hash is unchanged). */
export function inject(html: string) {
  const tags =
    '<meta name="own-gateway" content="1">' +
    '<link rel="manifest" href="/manifest.webmanifest">' +
    '<link rel="apple-touch-icon" href="/icons/icon-192.png">' +
    '<meta name="apple-mobile-web-app-capable" content="yes">'
  return html.includes("</head>") ? html.replace("</head>", `${tags}</head>`) : tags + html
}

export class Files {
  readonly root: string
  #index: { readonly mtime: number; readonly body: string } | undefined

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async available() {
    return (await fs.stat(path.join(this.root, "index.html")).catch(() => undefined))?.isFile() === true
  }

  /** A response for `GET`/`HEAD` of `pathname`, or `undefined` when the web build is missing. */
  async serve(pathname: string, method: string): Promise<Response | undefined> {
    const key = decodeSafe(pathname.replace(/^\/+/, ""))
    if (key === undefined) return new Response(null, { status: 400 })
    const file = key === "" ? undefined : this.#inside(key)
    const stat = file ? await fs.stat(file).catch(() => undefined) : undefined
    if (file && stat?.isFile()) {
      const name = path.basename(file)
      if (name === "index.html") return this.#html(method)
      const revalidate = name === "sw.js" || name === "manifest.webmanifest"
      const headers = {
        "content-type": MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
        "cache-control": revalidate ? "no-cache" : key.startsWith("_assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "content-security-policy": csp("", MANUAL.test(key)),
        "x-content-type-options": "nosniff",
        ...(name === "sw.js" ? { "service-worker-allowed": "/" } : {}),
      }
      if (method === "HEAD") return new Response(null, { headers })
      return new Response(Bun.file(file), { headers })
    }
    // Missing assets are 404s, not the app (a stale page must not execute HTML as a script).
    if (/^(_assets|icons)\//.test(key) || /\.[a-z0-9]{1,12}$/i.test(key)) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
    return this.#html(method)
  }

  async #html(method: string) {
    const file = path.join(this.root, "index.html")
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) return undefined
    if (!this.#index || this.#index.mtime !== stat.mtimeMs)
      this.#index = { mtime: stat.mtimeMs, body: inject(await fs.readFile(file, "utf8")) }
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": cspForHtml(this.#index.body),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    }
    return new Response(method === "HEAD" ? null : this.#index.body, { headers })
  }

  #inside(key: string) {
    const resolved = path.resolve(this.root, key)
    const relative = path.relative(this.root, resolved)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
    return resolved
  }
}

function decodeSafe(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.includes("\0") ? undefined : decoded
  } catch {
    return undefined
  }
}

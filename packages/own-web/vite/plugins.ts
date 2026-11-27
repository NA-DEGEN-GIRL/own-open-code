import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const themeScript = readFileSync(new URL("./theme-preload.js", import.meta.url), "utf8")
const THEME_TAG = '<script id="oc-theme-preload-script"></script>'
const INLINE_THEME = /<script\b[^>]*\bid=(["'])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i

/**
 * Inlines the theme preload script. It must stay the only inline script: the service WebUi CSP allows exactly the
 * hash of the script with id "oc-theme-preload-script" (packages/cli/src/services/web-ui.ts, 03 §13.1).
 */
export function themePreload(): Plugin {
  return {
    name: "own-web:theme-preload",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace(THEME_TAG, `<script id="oc-theme-preload-script">${themeScript}</script>`),
    },
  }
}

/**
 * Production CSP meta (05 §6.4 "렌더러 CSP"): the desktop `oc://renderer` handler sends no CSP, and the web fallback
 * gets the WebUi header CSP too; both apply. Dev skips it so Vite's HMR client keeps working.
 */
export function cspMeta(): Plugin {
  return {
    name: "own-web:csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const match = html.match(INLINE_THEME)
        if (!match) throw new Error("index.html lost the oc-theme-preload-script inline script")
        const inline = html.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi) ?? []
        if (inline.length !== 1)
          throw new Error(`index.html must have exactly one inline script, found ${inline.length}`)
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: { "http-equiv": "Content-Security-Policy", content: csp(sha256(match[2] ?? "")) },
              injectTo: "head-prepend",
            },
          ],
        }
      },
    },
  }
}

export function csp(scriptHash: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' 'sha256-${scriptHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    // 19.4: PDFs in the files tab (desktop reads them into a `blob:` URL; the web fallback uses a same-origin URL).
    "frame-src 'self' blob:",
    // Local service (desktop: absolute baseUrl) plus PTY WebSockets, and the SSH host endpoints (below).
    `connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* ${SSH_ENDPOINTS}`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ")
}

/**
 * SSH host endpoints (04 §7.3, §12.1, R1): own-remote binds each host's API tunnel (and so its PTY sockets) on
 * `127.0.<k>.2`, k = 1–250 (own-remote `Loopback.pickK`). CSP host-sources cannot wildcard an IP octet, so each one
 * is listed. `127.0.<k>.3` (dev forwards) is left out on purpose: those open outside the app (04 §7.6).
 */
const SSH_ENDPOINTS = Array.from(
  { length: 250 },
  (_, index) => `http://127.0.${index + 1}.2:* ws://127.0.${index + 1}.2:*`,
).join(" ")

function sha256(text: string) {
  return createHash("sha256").update(text).digest("base64")
}

/**
 * Build-time substitution of upstream modules (own/FORK.md §7 kind "substitute", recorded in own/ledger/vendored.yaml):
 * every import that resolves to a key (a repo-relative upstream file) gets our file instead, whatever the specifier
 * (`./markdown-cache` inside session-ui, `@opencode/session-ui/markdown-cache` in the adapter). A key that never
 * matched fails the production build, so an upstream move cannot silently drop the substitution. An `optional` key
 * may stay unmatched: a module only substituted files import, swapped in should an upstream importer appear.
 */
export function substitute(
  map: Readonly<Record<string, string>>,
  options: { readonly optional?: ReadonlyArray<string> } = {},
): Plugin {
  const root = fileURLToPath(new URL("../../..", import.meta.url))
  const targets = new Map(
    Object.entries(map).map(([source, target]) => [normalize(path.join(root, source)), path.join(root, target)]),
  )
  const names = [...targets.keys()].map((key) => path.basename(key).replace(/\.[jt]sx?$/, ""))
  const hits = new Set<string>((options.optional ?? []).map((source) => normalize(path.join(root, source))))
  let building = false
  return {
    name: "own-web:substitute",
    enforce: "pre",
    resolveId: {
      // Only specifiers that can name a key reach the handler (Rolldown hook filter).
      filter: { id: new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")) },
      async handler(source, importer, options) {
        if (!importer) return
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        const key = resolved ? normalize(resolved.id) : undefined
        const target = key ? targets.get(key) : undefined
        if (!key || !target || normalize(importer) === normalize(target)) return
        hits.add(key)
        return target
      },
    },
    configResolved(config) {
      building = config.command === "build"
    },
    buildEnd(error) {
      // Dev resolves lazily (a module may never be requested), so only a production build checks the keys.
      if (error || !building || this.meta.watchMode) return
      const missed = [...targets.keys()].filter((key) => !hits.has(key))
      if (missed.length) this.error(`own-web:substitute: no import resolved to ${missed.join(", ")} (upstream moved?)`)
    },
  }
}

function normalize(id: string) {
  return path.normalize(id.split("?")[0]!).toLowerCase()
}

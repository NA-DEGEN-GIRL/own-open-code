// Build step of the PWA (05 §13.9 M1 "PWA(설치, 오프라인 목록)"): emits `sw.js` (src/pwa/sw.ts, with the shell file
// list and a version), `manifest.webmanifest` and the icons into `dist/`. Only the own-remote gateway serves these
// files; the service WebUi (web fallback) never links them, and the desktop renderer never registers a worker.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { transformWithOxc, type Plugin } from "vite"
import { MANIFEST } from "./manifest.ts"

export function pwa(): Plugin {
  return {
    name: "own-web:pwa",
    apply: "build",
    // After Vite's HTML plugin has put the final index.html into the bundle.
    enforce: "post",
    async generateBundle(_options, bundle) {
      const html = bundle["index.html"]
      if (!html || html.type !== "asset") throw new Error("own-web:pwa: index.html is missing from the bundle")
      const source = typeof html.source === "string" ? html.source : new TextDecoder().decode(html.source)
      const assets = [...source.matchAll(/(?:src|href)="(\/_assets\/[^"]+)"/g)].map((match) => match[1]!)
      const shell = [...new Set(["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon.svg", ...assets])]
      const version = createHash("sha256").update(source).digest("hex").slice(0, 16)
      const code = readFileSync(new URL("./sw.ts", import.meta.url), "utf8")
      const compiled = await transformWithOxc(code, "sw.ts", { lang: "ts" })
      const worker = compiled.code
        .replace(/^\s*export\s*\{\s*\};?\s*$/m, "")
        .replaceAll("__OWN_SW_VERSION__", JSON.stringify(version))
        .replaceAll("__OWN_SW_SHELL__", JSON.stringify(shell))
      if (/__OWN_SW_/.test(worker) || /^\s*(export|import)\b/m.test(worker))
        throw new Error("own-web:pwa: sw.js must be a classic script with its placeholders replaced")
      this.emitFile({ type: "asset", fileName: "sw.js", source: worker })
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify(MANIFEST, null, 2) })
      this.emitFile({ type: "asset", fileName: "icons/icon.svg", source: iconSvg() })
      for (const size of [192, 512]) this.emitFile({ type: "asset", fileName: `icons/icon-${size}.png`, source: iconPng(size) })
    },
  }
}

const BACKGROUND = [0x08, 0x08, 0x08] as const
const ACCENT = [0x6e, 0xa8, 0xfe] as const

/** The mark: a ring and a dot on the dark background, inside the maskable safe zone (80 %). */
export function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#080808"/><circle cx="256" cy="256" r="120" fill="none" stroke="#6ea8fe" stroke-width="36"/><circle cx="256" cy="256" r="40" fill="#6ea8fe"/></svg>`
}

/** The same mark as a PNG (iOS home screens and older Android need raster icons). */
export function iconPng(size: number) {
  const scale = size / 512
  const rows: Buffer[] = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / scale - 256
      const dy = (y + 0.5) / scale - 256
      const distance = Math.hypot(dx, dy)
      const ring = Math.abs(distance - 120) <= 18
      const dot = distance <= 40
      const color = ring || dot ? ACCENT : BACKGROUND
      row[1 + x * 3] = color[0]
      row[2 + x * 3] = color[1]
      row[3 + x * 3] = color[2]
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer: Buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

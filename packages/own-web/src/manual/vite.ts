// Build step of the in-app user manual (03 §4.3.1): own/docs/manual/own-open-code-manual.html, one self-contained file
// (images inline), ships inside own-web's build, so every place that serves own-web serves it too, offline and
// read-only: the desktop renderer (`oc://renderer`, app\<ver>\web), the remote-access gateway (the same folder, for
// phones and other PCs) and the service's embedded web fallback. The file is emitted as
// `_assets/manual-<hash>.html`: the service WebUi serves only `_assets/` files and caches them for a year, so a new
// manual gets a new name. Its two inline scripts (theme, table of contents and search) move into
// `_assets/manual-<hash>-<n>.js` next to it, because the gateway's and the WebUi's CSP allow only same-origin scripts.
// The app reads the page's path from `import.meta.env.OWN_MANUAL_URL` ("" when the file is missing). The dev server
// serves the file as it is (no CSP there).
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

const SOURCE = fileURLToPath(new URL("../../../../own/docs/manual/own-open-code-manual.html", import.meta.url))
const DEV_PATH = "/__own-manual/manual.html"

export function manual(source = SOURCE): Plugin {
  let page: ReturnType<typeof splitManual> | undefined
  let command: "build" | "serve" = "build"
  return {
    name: "own-web:manual",
    config(_config, env) {
      command = env.command
      const exists = existsSync(source)
      if (exists && command === "build") page = splitManual(readFileSync(source, "utf8"))
      const url = !exists ? "" : command === "serve" ? DEV_PATH : `/_assets/${page!.name}`
      return { define: { "import.meta.env.OWN_MANUAL_URL": JSON.stringify(url) } }
    },
    configureServer(server) {
      server.middlewares.use(DEV_PATH, (_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8")
        response.end(readFileSync(source))
      })
    },
    generateBundle() {
      if (command !== "build" || !page) return
      this.emitFile({ type: "asset", fileName: `_assets/${page.name}`, source: page.html })
      for (const script of page.scripts)
        this.emitFile({ type: "asset", fileName: `_assets/${script.name}`, source: script.code })
    },
  }
}

/**
 * The manual with each inline `<script>` replaced by `<script src>` of a file beside it, named after the source's
 * hash. Order and timing stay the same (classic, synchronous scripts at the same place).
 */
export function splitManual(html: string) {
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 12)
  const scripts: Array<{ readonly name: string; readonly code: string }> = []
  const out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attributes: string, code: string) => {
    if (/\bsrc\s*=/i.test(attributes)) return whole
    const name = `manual-${hash}-${scripts.length}.js`
    scripts.push({ name, code })
    return `<script${attributes} src="${name}"></script>`
  })
  return { name: `manual-${hash}.html`, html: out, scripts }
}

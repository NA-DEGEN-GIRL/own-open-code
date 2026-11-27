// Vendored from packages/desktop/src/main/windows/protocol.ts @ bd55d4895f (MIT). See own/ledger/vendored.yaml
// own: the oc://renderer handler takes its root from a function asked on every request (upstream: one fixed string).
// The installed own-web is OWN_HOME\app\<version>\web, named by app\current.json since there is no app\current
// junction any more (01 §5.1), and a version switch (own update/rollback) must still reach the open windows on their
// next reload (01 §5.5 step 7), as the junction did when every request read through it. own-shell.ts registers this
// before upstream (first-wins: upstream's registerRendererProtocol is then a no-op), so the request bookkeeping that
// rendererAssetsServed() waits on (the main bundle delay, 05 §9.2 R-D12) lives here and index.ts waits on this copy.
// serve() and addDocumentPolicy() are upstream's; problems go to the console (upstream's reporter is not installed
// yet when the first window loads, and later reports are debug detail). Marked "own:".
import { net, protocol } from "electron"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { documentPolicyHeader, jsCallStacksDocumentPolicy } from "@opencode/desktop/src/main/windows/headers"
import { rendererHost, rendererProtocol } from "@opencode/desktop/src/main/windows/scheme"

const report = (level: "warning" | "error", message: string, data: Record<string, unknown>) =>
  console[level === "error" ? "error" : "warn"](message, data)

// Requests in flight and when the last one arrived. The entry module holds the main bundle back
// until the renderer's initial burst of asset requests has been answered, because this handler
// runs on the main thread and a 100 ms module evaluation would otherwise sit between the renderer
// and its HTML.
let inflight = 0
let served = 0
let lastRequest = 0

export function rendererAssetsServed(options: { quietMs: number; capMs: number }) {
  const start = Date.now()
  return new Promise<void>((resolve) => {
    const check = () => {
      const now = Date.now()
      if (now - start >= options.capMs) return resolve()
      if (served > 0 && inflight === 0 && now - lastRequest >= options.quietMs) return resolve()
      setTimeout(check, 5)
    }
    check()
  })
}

/**
 * own: registers the handler unless oc: is handled already. `root(document)` names the folder to serve from; it is
 * asked with `document: true` for an HTML page (a window's load or reload), where a root that follows the installed
 * version may move, and with `false` for everything else.
 */
export function registerRendererRoot(root: (document: boolean) => string) {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    inflight++
    lastRequest = Date.now()
    try {
      return await serve(request, root(isDocument(request.url)))
    } finally {
      inflight--
      served++
    }
  })
}

// own: an HTML page (the renderer's own document) rather than one of its assets.
function isDocument(value: string) {
  if (!URL.canParse(value)) return false
  const pathname = new URL(value).pathname.toLowerCase()
  return pathname === "/" || pathname.endsWith(".html")
}

async function serve(request: Request, rendererRoot: string) {
  const url = new URL(request.url)
  if (url.host !== rendererHost) {
    report("warning", "rejected host", { url: request.url })
    return new Response("Not found", { status: 404 })
  }

  const file = path.resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
  const rel = path.relative(rendererRoot, file)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    report("warning", "rejected path", { url: request.url, file })
    return new Response("Not found", { status: 404 })
  }

  try {
    const range = request.headers.get("range")
    const response = await net.fetch(pathToFileURL(file).toString(), { headers: range ? { range } : undefined })
    if (response.status >= 400) {
      report("error", "fetch failed", {
        url: request.url,
        file,
        status: response.status,
        statusText: response.statusText,
      })
    }
    return addDocumentPolicy(response, file)
  } catch (error) {
    report("error", "fetch error", { url: request.url, file, error })
    return new Response("Not found", { status: 404 })
  }
}

function addDocumentPolicy(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) return response
  const headers = new Headers(response.headers)
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

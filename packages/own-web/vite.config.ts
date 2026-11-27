import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type Plugin } from "vite"
import solid from "vite-plugin-solid"
import { resolveDevApi } from "./vite/dev-api.ts"
import { cspMeta, substitute, themePreload } from "./vite/plugins.ts"
import { manual } from "./src/manual/vite.ts"
import { pwa } from "./src/pwa/vite.ts"

// Copied from packages/app/vite.js (03 §16.1): Tailwind 4.3.3 expects a server that Vite's bundled dev hook does
// not provide.
const tailwind = tailwindcss()
const tailwindGenerate = tailwind.find((plugin) => plugin.name === "@tailwindcss/vite:generate:serve")
const tailwindHotUpdate = tailwindGenerate?.hotUpdate
if (tailwindGenerate && typeof tailwindHotUpdate === "function") {
  tailwindGenerate.hotUpdate = function (context) {
    if (!context.server) return
    return tailwindHotUpdate.call(this, context)
  }
}

// Also from packages/app/vite.js: the session-ui markdown worker imports these directly, so they stay unbundled in
// dev to keep worker startup stable (since v2.2 @pierre/highlights and marked: c2736fc9fa, f2735ef79b).
const workerDeps = ["@pierre/highlights", "marked"]
const bundleNestedWorkerDeps = {
  name: "own-web:bundle-nested-worker-deps",
  resolveId(id: string, importer?: string) {
    if (!importer || !importer.includes("node_modules")) return
    // Subpaths too (bdf757209f): a pre-bundle importing `<dep>/<path>` would otherwise keep a bare import.
    if (!workerDeps.some((dep) => id === dep || id.startsWith(`${dep}/`))) return
    try {
      return createRequire(importer).resolve(id)
    } catch {
      return
    }
  },
}

// Upstream's FileIcon loads its icons through `import.meta.glob` since #58444, and the dependency scan cannot parse a
// .tsx file that calls it (the limit upstream's vite.js names for its components lab). The scan then stopped with
// "Build failed", Vite found the dependencies only as pages loaded them, and a fresh dev server's first page got
// "504 (Outdated Optimize Dep)" while it optimized again. The icon imports nothing the scan does not find elsewhere.
const skipFileIconScan = {
  name: "own-web:skip-file-icon-scan",
  resolveId(id: string) {
    if (id === "@opencode/ui/file-icon") return { id, external: true }
  },
}

// PF1 (05 R-D12): the desktop renderer's files come over `oc://renderer`, one main-thread protocol round trip each,
// and the shell starts evaluating its main bundle once the page's first burst of requests has gone quiet
// (`rendererAssetsServed`, 40 ms). A chunk requested after that burst waits for the main thread. So everything the
// first render needs is requested with the page (measured on the packaged shell: −130 ms PF1 against lazy chunks):
//  - one chunk ("boot") with the initial graph (every module the entry reaches through static imports), like
//    upstream's desktop renderer (initialChunk, copied from packages/desktop/electron.vite.config.ts;
//    own/ledger/vendored.yaml);
//  - the desktop host (src/host/desktop.ts) and upstream's IPC client stay the dynamic chunks src/host imports, with
//    `modulepreload` links (`data-own-desktop`): fetched and compiled with the page, evaluated only when imported,
//    i.e. after the T0-0 rpcHash check (05 §5.5). Merged into the boot chunk, Rolldown would run the IPC client's top
//    level (listeners, the DesktopEvents request) with it, before that check and in web mode too. The web fallback
//    fetches the few KB and runs none of it; PF5 counts them apart (script/bundle-size.ts).
// Rolldown hands every chunk-name call a fresh context, so the graph is walked once per output (upstream v2.0.28).
const initialGraph = new Set<string>()
const initialChunk: Plugin = {
  name: "own-web:initial-chunk",
  renderStart() {
    const entries = [...this.getModuleIds()].filter((id) => this.getModuleInfo(id)?.isEntry)
    initialGraph.clear()
    entries.forEach((id) => initialGraph.add(id))
    // A Set's iterator also visits members added while iterating, so this reaches every static import.
    for (const id of initialGraph) this.getModuleInfo(id)?.importedIds.forEach((imported) => initialGraph.add(imported))
  },
}
const bootChunk = (id: string) => (initialGraph.has(id) ? "boot" : null)
const DESKTOP_CHUNKS = [
  /[\\/]own-web[\\/]src[\\/]host[\\/]desktop\.ts$/,
  /[\\/]desktop[\\/]src[\\/]renderer[\\/]ipc-client\.ts$/,
] as const

function preloadDesktopChunks(): Plugin {
  let base = "/"
  return {
    name: "own-web:preload-desktop-chunks",
    apply: "build",
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const chunks = Object.values(ctx.bundle ?? {}).filter((item) => item.type === "chunk")
        const files = DESKTOP_CHUNKS.map((pattern) => {
          const chunk = chunks.find((item) => item.moduleIds.some((id) => pattern.test(id)))
          if (!chunk) throw new Error(`own-web: no chunk carries ${pattern}`)
          if (
            chunk.isEntry ||
            chunk.name === "boot" ||
            chunk.moduleIds.some((id) => /[\\/]src[\\/]entry\.tsx$/.test(id))
          )
            throw new Error(`own-web: ${pattern} must stay a dynamic chunk of its own, not in the boot chunk`)
          return chunk.fileName
        })
        return [...new Set(files)]
          .filter((file) => !html.includes(`${base}${file}`))
          .map((file) => ({
            tag: "link",
            attrs: { rel: "modulepreload", crossorigin: true, href: `${base}${file}`, "data-own-desktop": true },
            injectTo: "head" as const,
          }))
      },
    },
  }
}

export default defineConfig(({ command }) => {
  const api = command === "serve" ? resolveDevApi() : undefined
  if (api)
    console.info(
      `[own-web] /api → ${api.url} (credentials: ${api.source})` +
        (api.source === "none" ? " — set OWN_WEB_API_URL/OWN_WEB_API_PASSWORD or start the local-channel service" : ""),
    )
  return {
    plugins: [
      // Upstream modules swapped at build time (own/ledger/vendored.yaml, kind "substitute").
      substitute({
        "packages/session-ui/src/components/markdown-cache.tsx":
          "packages/own-web/src/vendor/session-ui/markdown-cache.tsx",
        // The incremental streaming render (src/markdown/): the component and the worker client that starts
        // own-web's worker (upstream's plus the tail projection).
        "packages/session-ui/src/components/markdown.tsx": "packages/own-web/src/vendor/session-ui/markdown.tsx",
        "packages/session-ui/src/components/markdown-worker.ts":
          "packages/own-web/src/vendor/session-ui/markdown-worker.ts",
      }, { optional: ["packages/session-ui/src/components/markdown-worker.ts"] }),
      themePreload(),
      cspMeta(),
      preloadDesktopChunks(),
      initialChunk,
      // M1 (05 §13.9): sw.js, manifest and icons for the gateway origin only.
      pwa(),
      // 03 §4.3.1: the user manual (own/docs/manual) as `_assets/manual-<hash>.html`, offline in every build.
      manual(),
      ...(tailwind as Plugin[]),
      solid(),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    define: {
      // Dev only: the control location (02 §9.1) for global RPCs. Production hosts supply it (fragment or OwnHost).
      "import.meta.env.OWN_DEV_CONTROL_DIR": JSON.stringify(
        command === "serve" ? (process.env.OWN_WEB_CONTROL_DIR ?? "") : "",
      ),
    },
    worker: { format: "es" },
    optimizeDeps: {
      exclude: workerDeps,
      // packages/app/vite.js dropped its mermaid/katex pre-bundle when session-ui moved diagrams to Pele (06dc6a0c73).
      rolldownOptions: { plugins: [bundleNestedWorkerDeps, skipFileIconScan] },
    },
    server: {
      port: Number(process.env.OWN_WEB_PORT ?? 5173),
      proxy: api
        ? {
            "/api": {
              target: api.url,
              changeOrigin: true,
              ws: true,
              configure(proxy) {
                proxy.on("proxyReq", (request) => {
                  const authorization = api.authorization()
                  if (authorization) request.setHeader("authorization", authorization)
                })
                proxy.on("proxyReqWs", (request) => {
                  const authorization = api.authorization()
                  if (authorization) request.setHeader("authorization", authorization)
                })
              },
            },
          }
        : undefined,
    },
    preview: { port: Number(process.env.OWN_WEB_PREVIEW_PORT ?? 4173) },
    build: {
      // The service WebUi only serves assets from `_assets` (01 §6.1).
      assetsDir: "_assets",
      target: "esnext",
      sourcemap: true,
      modulePreload: { polyfill: false },
      // The boot chunk is the whole initial graph on purpose (PF1, above); PF5 gates its gzip size (script/bundle-size.ts).
      chunkSizeWarningLimit: 1024,
      rolldownOptions: {
        output: { codeSplitting: { groups: [{ name: bootChunk, priority: 10 }] } },
        experimental: { chunkOptimization: { mergeCommonChunks: false } },
      },
    },
  }
})

// Service worker of the gateway origin (05 §13.6 "서비스 워커", 13.7 오프라인). Built to `dist/sw.js` by
// src/pwa/vite.ts, served only by the own-remote gateway (never on the local web fallback origin, 01 §6.1).
//
// What it caches: the app shell only — `index.html`, the boot assets, the manifest and icons — so the installed app
// opens without a network and paints the session list own-web keeps in IndexedDB (titles, times, account chips; no
// messages, no secrets, 01 §6.3). It never caches or even looks at `/srv/*` (API, event streams), `/own/*` (device
// info, pairing) or `/auth/*`: those go to the network untouched, so no API answer, cookie or token ever lands in the
// Cache Storage. The shell is network-first with a version check: a new build's `sw.js` differs, installs, and drops
// the old cache.

// A module for the type checker only; the build strips this line and ships a classic worker script.
export {}

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request
  respondWith(response: Promise<Response> | Response): void
}
interface WorkerScope {
  readonly location: Location
  readonly clients: { claim(): Promise<void> }
  skipWaiting(): Promise<void>
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void
}

/** The worker global (typed here: the page's DOM lib has no service-worker types). */
const worker = globalThis as unknown as WorkerScope
/** Replaced at build time: a hash of the built index.html, and the shell files it references. */
declare const __OWN_SW_VERSION__: string
declare const __OWN_SW_SHELL__: string[]

const CACHE = `own-shell-${__OWN_SW_VERSION__}`
const NETWORK_TIMEOUT_MS = 4000
/** Never intercepted: the API relay (`/srv/<serverKey>/api/…`), gateway endpoints, pairing. App routes such as
 * `/srv/<serverKey>/s/<id>` are pages like any other. */
const BYPASS = /^\/(own|auth|api)(\/|$)|^\/srv\/[^/]+\/api(\/|$)/
const IMMUTABLE = /^\/(_assets|icons)\//

worker.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(__OWN_SW_SHELL__))
      .then(() => worker.skipWaiting()),
  )
})

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("own-shell-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => worker.clients.claim()),
  )
})

worker.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== worker.location.origin || BYPASS.test(url.pathname)) return
  if (request.mode === "navigate") return event.respondWith(page(request))
  if (IMMUTABLE.test(url.pathname) || url.pathname === "/manifest.webmanifest") return event.respondWith(asset(request))
})

/** Network first (a fresh shell when online), the cached shell when the network is gone or too slow. */
async function page(request: Request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS)
    if (response.ok && (response.headers.get("content-type") ?? "").startsWith("text/html"))
      await cache.put("/", response.clone())
    return response
  } catch {
    return (await cache.match("/")) ?? Response.error()
  }
}

/** Hashed assets never change: cache first, filled on first use (lazy chunks too). */
async function asset(request: Request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok && response.type === "basic") await cache.put(request, response.clone())
  return response
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

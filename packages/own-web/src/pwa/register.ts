// Registers the gateway origin's service worker (05 §13.6, src/pwa/sw.ts). Called by the mobile host only, so the
// desktop renderer and the local web fallback never get one (01 §6.1 "서비스 워커는 쓰지 않습니다" except here).
// Deferred to idle time: PF1's first paint does not wait for it. Not inside our apps (08 §3.4): the app shell comes
// from the PC each time, and Android's WebView refuses a worker on a certificate it was told to accept.
import { inOwnApp } from "./gateway"

export function registerServiceWorker() {
  if (import.meta.env.DEV || inOwnApp()) return
  if (typeof navigator !== "object" || !("serviceWorker" in navigator) || !globalThis.isSecureContext) return
  const register = () =>
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined)
  if (typeof requestIdleCallback === "function") requestIdleCallback(register, { timeout: 3000 })
  else setTimeout(register, 1000)
}

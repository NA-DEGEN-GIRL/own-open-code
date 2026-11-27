// own-web entry. T0 order (05 §6.3): host selection (desktop: rpcHash check + dynamic import), first render from
// the cached session list while the host resolves the service, theme applied → setChrome → ready.
// PF1: the saved list is read from here (perf/prefetch.ts), and the first render waits for nothing else.
// A shell of another contract gets the mismatch screen instead of the app (05 §5.5, host/mismatch.tsx).
import "./styles/index.css"
import { render } from "solid-js/web"
import { App } from "./app"
import { createDataLayer, LOCAL } from "./data"
import { createIndexedDbCache } from "./data/session-cache"
import { createHost } from "./host"
import { showShellMismatch } from "./host/mismatch"
import { DeviceAuthRequiredError, ShellMismatchError } from "./host/types"
import { loadEnglish, storedLocale, translate } from "./i18n"
import { markOnce } from "./perf/marks"
import { prefetched } from "./perf/prefetch"

markOnce("own:boot")
const root = document.getElementById("root")
if (!root) throw new Error("#root is missing from index.html")
const cache = prefetched(createIndexedDbCache(), LOCAL)
// Inside the Android app (08 §3.4 user agent): the back button and the system bars ask the page (host/app-bridge.ts).
if (/ OwnOpenCodeApp\/\d+ \(android\)/.test(navigator.userAgent)) void appBridge()

// English is its own chunk (src/i18n): the first paint waits for it only where English was chosen.
const english = storedLocale() === "en" ? loadEnglish() : undefined
createHost().then(
  async (host) => {
    if (english) await english
    return render(() => {
      const data = createDataLayer({ host, cache })
      return <App host={host} data={data} />
    }, root)
  },
  (error: unknown) => {
    if (error instanceof ShellMismatchError) return void showShellMismatch(root, error)
    // A gateway page without a device credential (05 §13.5): the pairing screen, its own chunk.
    if (error instanceof DeviceAuthRequiredError)
      return void import("./pairing/device-screen").then((screen) => screen.showDevicePairing(root, error.reason))
    const reason = error instanceof Error ? error.message : String(error)
    void Promise.resolve(english).then(() => {
      root.textContent = translate(storedLocale(), "own.state.hostFailed", { reason })
    })
  },
)

async function appBridge() {
  const { installAppBridge } = await import("./host/app-bridge")
  installAppBridge()
}

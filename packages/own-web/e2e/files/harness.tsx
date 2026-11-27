// Files harness: mounts the files tab module (e2e/files/kit.tsx = src/adapter/files.tsx) exactly as the work panel
// does (lazy import, PanelTabProps, `visible()`), on the production data path: web host → createDataLayer → Vite proxy
// → real server of e2e/files/backend.ts. It also installs the wiring the integrator adds to the shell: Ctrl+P
// (`file.open` → `requestQuickOpen()`) and the two window intents (`own:open-file`, `own:quick-open` → open the tab).
// `?host=desktop` wraps the web host with `openInApp` and recording `host.files.openPath/revealPath` (no real desktop).
// `window.__files` lets Playwright switch session, width and visibility and send open-file requests.
import "@/styles/index.css"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider, LOCAL } from "@/data"
import { FILE_INTENT, openFile, QUICK_OPEN_INTENT, requestQuickOpen } from "@/files"
import { HostProvider, type OwnHost } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { ShortcutProvider, useShortcut } from "@/keyboard"
import { COLOR_SCHEME_KEY, seedColorScheme } from "@/shell/theme-default"

const params = new URLSearchParams(location.search)
const [session, setSession] = createSignal(params.get("session") ?? undefined)
const [visible, setVisible] = createSignal(params.get("hidden") !== "1")
const [width, setWidth] = createSignal(Number(params.get("width") ?? 420))
const [opened, setOpened] = createSignal(params.get("open") !== "0")
const FilesTab = lazy(() => import("./kit"))
const calls: { readonly method: string; readonly args: readonly unknown[] }[] = []
const intents: string[] = []

declare global {
  interface Window {
    __files: {
      setSession(id: string): void
      setVisible(value: boolean): void
      setWidth(value: number): void
      openFile(path: string, line?: number, base?: string): void
      readonly calls: typeof calls
      readonly intents: typeof intents
    }
  }
}

window.__files = {
  setSession,
  setVisible,
  setWidth,
  openFile: (path, line, base) => openFile({ serverKey: LOCAL, sessionID: session()!, path, line, base }),
  calls,
  intents,
}

try {
  if (params.get("scheme")) localStorage.setItem(COLOR_SCHEME_KEY, params.get("scheme")!)
} catch {}
seedColorScheme()

function Harness() {
  // The shell's wiring (shell/shortcuts.tsx, shell/intents.tsx): Ctrl+P and the intents open the files tab.
  useShortcut("file.open", () => requestQuickOpen())
  onMount(() => {
    const show = (event: Event) => {
      intents.push(event.type)
      setOpened(true)
      setVisible(true)
    }
    window.addEventListener(FILE_INTENT, show)
    window.addEventListener(QUICK_OPEN_INTENT, show)
    onCleanup(() => {
      window.removeEventListener(FILE_INTENT, show)
      window.removeEventListener(QUICK_OPEN_INTENT, show)
    })
  })
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "8px" }}>
      <div
        class="own-tabpanel"
        data-testid="panel"
        style={{ width: `${width()}px`, height: "760px", flex: "none", display: "flex", "flex-direction": "column" }}
        hidden={!visible()}
      >
        <Show when={opened()}>
          <Suspense fallback={<p data-testid="chunk-loading">…</p>}>
            <FilesTab serverKey={() => LOCAL} sessionID={session} visible={visible} tab="files" />
          </Suspense>
        </Show>
      </div>
    </div>
  )
}

function desktopLike(host: OwnHost): OwnHost {
  const record =
    (method: string) =>
    async (...args: unknown[]) =>
      void calls.push({ method, args })
  return {
    ...host,
    capabilities: { ...host.capabilities, openInApp: true },
    files: { openPath: record("openPath"), revealPath: record("revealPath") },
  }
}

const web = createWebHost()
const host = params.get("host") === "desktop" ? desktopLike(web) : web
render(
  () => (
    <HostProvider value={host}>
      <ThemeProvider>
        <I18nProvider value={createI18n("ko")}>
          <DataProvider value={createDataLayer({ host })}>
            <ShortcutProvider>
              <Harness />
            </ShortcutProvider>
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  ),
  document.getElementById("root")!,
)

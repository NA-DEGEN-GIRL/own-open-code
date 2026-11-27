// Terminal harness for Playwright (dev server only): the providers of src/app.tsx (host, i18n, data layer, memory
// router, shortcuts, shell state) around the real terminal UI, talking to the real server's PTYs.
//   ?session=<id>          work panel tab (`terminal/panel-tab.tsx`), location from the session (18.6)
//   ?dir=<path>            explicit location
//   &placement=dock        the bottom dock (`terminal/dock.tsx`) instead of the tab
//   &hidden                start hidden (the panel tab mounted but not visible)
// `window.__terminalHarness` lets tests toggle visibility, resize the panel, switch sessions and read the shortcut log.
import "@/styles/index.css"
import { createSignal, lazy, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider, LOCAL } from "@/data"
import { HostProvider } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider, useShortcut } from "@/keyboard"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import { createShell, ShellProvider } from "@/shell/context"

const TerminalTab = lazy(() => import("@/terminal/panel-tab"))
const TerminalDock = lazy(() => import("@/terminal/dock"))
const Panel = lazy(() => import("@/terminal/panel").then((module) => ({ default: module.TerminalPanel })))

const params = new URLSearchParams(location.search)
const session = params.get("session") ?? undefined
const directory = params.get("dir") ?? undefined
const dock = params.get("placement") === "dock"
const host = createWebHost()
const log: string[] = []
const [visible, setVisible] = createSignal(!params.has("hidden"))
const [width, setWidth] = createSignal(480)
const [collapsed, setCollapsed] = createSignal(false)

// A fresh memory route per load: the harness URL decides the session.
try {
  sessionStorage.removeItem("own.web.terminal.harness.route")
  localStorage.removeItem("own.web.terminal.harness.route")
} catch {}

// The shell marks `own:panel-open:<tab>` when a tab first mounts (03 §20.3 T2); the harness mounts it at once.
performance.mark("own:panel-open:terminal")

render(() => {
  const data = createDataLayer({ host })
  const router = createMemoryRouter("own.web.terminal.harness.route")
  if (session) router.navigate({ name: "session", serverKey: LOCAL, sessionID: session })
  Object.assign(window, {
    __terminalHarness: {
      log,
      runtime: data.local(),
      setVisible,
      setWidth,
      collapsed,
      navigate: (sessionID: string) => router.navigate({ name: "session", serverKey: LOCAL, sessionID }),
    },
  })
  return (
    <HostProvider value={host}>
      <I18nProvider value={createI18n("ko")}>
        <DataProvider value={data}>
          <RouterProvider value={router}>
            <ShortcutProvider value={createShortcutRegistry()}>
              <ShellProvider value={createShell({ windowKey: "terminal-harness" })}>
                <Layout />
              </ShellProvider>
            </ShortcutProvider>
          </RouterProvider>
        </DataProvider>
      </I18nProvider>
    </HostProvider>
  )
}, document.getElementById("root")!)

function Layout() {
  const router = useRouter()
  // Stand-ins for the shell's handlers: palette (live in a terminal) and sidebar (the shell keeps Ctrl+B there).
  useShortcut("palette.open", () => void log.push("palette.open"))
  useShortcut("sidebar.toggle", () => void log.push("sidebar.toggle"))
  const serverKey = () => LOCAL
  const sessionID = () => {
    const route = router.route()
    return route.name === "session" ? route.sessionID : undefined
  }
  return (
    <div style={{ display: "flex", height: "100vh", "flex-direction": dock ? "column" : "row" }}>
      <main style={{ flex: "1", "min-width": "0", display: "flex", "flex-direction": "column", padding: "8px" }}>
        <p data-testid="route">{sessionID() ?? "none"}</p>
        <textarea data-testid="composer" aria-label="composer" style={{ height: "80px" }} />
        <Show when={dock && !collapsed()}>
          <div style={{ flex: "1" }} />
          <Suspense>
            <TerminalDock
              serverKey={serverKey}
              sessionID={sessionID}
              visible={visible}
              onCollapse={() => setCollapsed(true)}
            />
          </Suspense>
        </Show>
      </main>
      <Show when={!dock}>
        <aside
          data-testid="panel"
          hidden={!visible()}
          style={{ width: `${width()}px`, height: "100vh", display: "flex", "flex-direction": "column" }}
        >
          <Suspense>
            <Show
              when={directory}
              fallback={<TerminalTab serverKey={serverKey} sessionID={sessionID} visible={visible} />}
            >
              <DirectoryPanel directory={directory!} visible={visible} />
            </Show>
          </Suspense>
        </aside>
      </Show>
    </div>
  )
}

function DirectoryPanel(props: { readonly directory: string; readonly visible: () => boolean }) {
  return (
    <Panel
      serverKey={() => LOCAL}
      sessionID={() => undefined}
      directory={() => props.directory}
      visible={props.visible}
      placement="tab"
    />
  )
}

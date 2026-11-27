// Sidebar harness for Playwright (dev server only): the same providers as src/app.tsx (host, i18n, data layer,
// router, shortcuts, shell state) around `<Sidebar />`, and a main column that prints the route. A memory router
// keeps the harness URL, so reloads come back here (the path router would rewrite unknown paths to `/`). The folder
// flow (`폴더 열기…`, Ctrl+O) is the projects module's layer, mounted once as the shell does.
import "@/styles/index.css"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider } from "@/data"
import { HostProvider, type OwnHost } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { ProjectOpenerLayer } from "@/projects"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import { routePath } from "@/routing/routes"
import { createShell, ShellProvider, useShell } from "@/shell/context"
import { Sidebar } from "@/sidebar"

const root = document.getElementById("root")!
const web = createWebHost()
// `?wco` emulates the desktop title-bar band capability (4.2.1) for the band test.
const host: OwnHost = new URLSearchParams(location.search).has("wco")
  ? { ...web, capabilities: { ...web.capabilities, windowControlsOverlay: true } }
  : web

render(() => {
  const data = createDataLayer({ host })
  const router = createMemoryRouter("own.web.sidebar.harness.route")
  // Tests reach the local runtime to add records the fake backend cannot produce (subagent sessions).
  Object.assign(window, { __sidebarHarness: { runtime: data.local() } })
  return (
    <HostProvider value={host}>
      <I18nProvider value={createI18n("ko")}>
        <DataProvider value={data}>
          <RouterProvider value={router}>
            <ShortcutProvider value={createShortcutRegistry()}>
              <ShellProvider value={createShell({ windowKey: "harness" })}>
                <Layout />
              </ShellProvider>
            </ShortcutProvider>
          </RouterProvider>
        </DataProvider>
      </I18nProvider>
    </HostProvider>
  )
}, root)

function Layout() {
  const router = useRouter()
  const shell = useShell()
  return (
    <div class="own-app" data-testid="app" style={{ "--own-sidebar-w": "272px" }}>
      <aside class="own-sidebar" data-testid="sidebar">
        <Sidebar />
      </aside>
      <main class="own-main p-4" data-testid="main">
        <p data-testid="route">{routePath(router.route())}</p>
        <p data-testid="panel">{shell.panelOpen() ? `panel:${shell.tab()}` : "panel:closed"}</p>
        <input data-testid="elsewhere" aria-label="elsewhere" />
      </main>
      <ProjectOpenerLayer />
    </div>
  )
}

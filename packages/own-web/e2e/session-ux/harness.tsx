// Session-UX harness (dev server only): the same providers as src/app.tsx around the real `Sidebar` (pin/archive,
// 보관함, ID search, date groups; with the shell's delete dialogs, 19.11a), the real `Transcript` (it mounts `<SessionFind>`), the notes layer opened from a
// header button (as the header `⋯` → `대화 메모` will), and the 설정 > 일반 timeline row — wired the way the P7 report asks
// the integrator to wire them. `window.__ux` lets Playwright drive the server (create, prompt, fork, read metadata).
import "@/styles/index.css"
import "@/switcher/switcher.css"
import { ThemeProvider, useTheme } from "@opencode/ui/theme/context"
import { createEffect, onCleanup, untrack } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider, LOCAL, useData } from "@/data"
import { HostProvider } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { NotesLayer, openNotes } from "@/notes"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import { createShell, ShellProvider } from "@/shell/context"
import { SessionDeleteHost, Sidebar } from "@/sidebar"
import { Toasts } from "@/switcher/toast"
import { TimelineDetailSetting } from "@/timeline-settings/setting"
import { seedColorScheme } from "@/shell/theme-default"
import { Transcript } from "@/transcript"

const host = createWebHost()

function Layout() {
  const data = useData()
  const router = useRouter()
  const theme = useTheme()
  const runtime = () => data.local()
  const sessionID = () => {
    const route = router.route()
    return route.name === "session" ? route.sessionID : undefined
  }
  const session = () => {
    const id = sessionID()
    return id ? runtime().data.session.get(id) : undefined
  }

  createEffect(() => {
    const id = sessionID()
    const current = runtime()
    if (!id || current.connection.status() !== "connected") return
    untrack(() => void current.data.session.sync(id).catch(() => undefined))
    onCleanup(current.own.watchOpen(id))
  })

  const client = () => runtime().client()
  const ux = {
    ready: () => runtime().connection.status() === "connected" && runtime().own.state.status === "ready",
    async create(input: { title: string; providerID: string; model: string; directory: string }) {
      const info = await client().session.create({
        title: input.title,
        model: { providerID: input.providerID, id: input.model },
        location: { directory: input.directory },
      })
      runtime().data.session.remember(info)
      router.navigate({ name: "session", serverKey: LOCAL, sessionID: info.id })
      return info.id
    },
    open: (id: string) => router.navigate({ name: "session", serverKey: LOCAL, sessionID: id }),
    home: () => router.navigate({ name: "home" }),
    current: () => sessionID(),
    route: () => router.route(),
    prompt: (text: string, id = sessionID()!) =>
      runtime()
        .data.session.prompt({ sessionID: id, text })
        .then((item) => item.id),
    wait: (id = sessionID()!) => client().session.wait({ sessionID: id }),
    status: (id = sessionID()!) => runtime().data.session.status(id),
    fork: (id = sessionID()!) =>
      client()
        .session.fork({ sessionID: id })
        .then((info) => info.id),
    metadata: (id: string) =>
      client()
        .session.get({ sessionID: id })
        .then((info) => info.metadata ?? {}),
    projectOf: (id: string) =>
      client()
        .session.get({ sessionID: id })
        .then((info) => info.projectID),
    exists: (id: string) =>
      client()
        .session.get({ sessionID: id })
        .then(
          () => true,
          () => false,
        ),
    entries: (id: string) => client().session.instructions.entry.list({ sessionID: id }),
    title: (id: string) =>
      client()
        .session.get({ sessionID: id })
        .then((info) => info.title),
    setScheme: (scheme: "dark" | "light") => theme.setColorScheme(scheme),
    scheme: () => document.documentElement.getAttribute("data-color-scheme"),
  }
  Object.assign(window, { __ux: ux })

  return (
    <div class="own-app ux" data-testid="app" style={{ "--own-sidebar-w": "272px" }}>
      <aside class="own-sidebar" data-testid="sidebar">
        <Sidebar />
      </aside>
      <main class="ux-main" data-testid="main">
        <header class="ux-header">
          <b data-testid="ux-title">{session()?.title ?? "—"}</b>
          <span data-testid="route" class="ux-route">
            {sessionID() ?? "home"}
          </span>
          <button
            type="button"
            class="own-btn"
            data-testid="ux-notes"
            disabled={!sessionID()}
            onClick={() => openNotes({ serverKey: LOCAL, sessionID: sessionID()! })}
          >
            대화 메모
          </button>
        </header>
        <div class="ux-transcript">
          <Transcript serverKey={() => LOCAL} sessionID={sessionID} />
        </div>
        <section class="ux-settings" data-testid="ux-settings">
          <TimelineDetailSetting />
        </section>
      </main>
      <NotesLayer />
      <SessionDeleteHost />
      <Toasts />
      <style>{HARNESS_CSS}</style>
    </div>
  )
}

const HARNESS_CSS = `
.ux { display: grid; grid-template-columns: 272px 1fr; height: 100vh; background: var(--own-bg); color: var(--own-text); font-family: var(--own-font-sans); }
.ux .own-sidebar { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--own-border); background: var(--own-bg-subtle); }
.ux-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ux-header { display: flex; gap: 12px; align-items: center; height: 44px; padding: 0 16px; border-bottom: 1px solid var(--own-border); }
.ux-route { margin-left: auto; font-size: 11px; color: var(--own-text-faint); }
.ux-transcript { position: relative; display: flex; flex: 1; min-height: 0; }
.ux-settings { padding: 0 16px; border-top: 1px solid var(--own-border); }
`

// Dark by default, as the app seeds it before the theme provider starts (src/app.tsx).
seedColorScheme()
render(() => {
  const data = createDataLayer({ host })
  const router = createMemoryRouter(`own.web.session-ux.route`)
  return (
    <HostProvider value={host}>
      <ThemeProvider>
        <I18nProvider value={createI18n("ko")}>
          <DataProvider value={data}>
            <RouterProvider value={router}>
              <ShortcutProvider value={createShortcutRegistry()}>
                <ShellProvider value={createShell({ windowKey: "session-ux" })}>
                  <Layout />
                </ShellProvider>
              </ShortcutProvider>
            </RouterProvider>
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  )
}, document.getElementById("root")!)

// Requests harness for Playwright (dev server only): the app's providers (host, theme, i18n, data layer, router,
// shortcuts) around the requests module — header approval pill, the dock stack above a composer stand-in
// (`#own-composer-input`, where focus returns), the notification hook and 설정 > 승인·권한 — against the real server of
// e2e/backend.ts. `?upstream` also loads the transcript stylesheet (session-ui dock CSS), as in the running app.
// `window.__requestsHarness` lets tests read recorded OS notifications and opened URLs and fake window focus.
import "@/styles/index.css"
import "@/switcher/switcher.css"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createSignal, lazy, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider, LOCAL } from "@/data"
import { HostProvider, type OwnHost } from "@/host"
import type { HostNotification } from "@/host/types"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { ApprovalModePill, RequestDocks, RequestNotifications } from "@/requests"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import { routePath } from "@/routing/routes"
import { Toasts } from "@/switcher/toast"

const params = new URLSearchParams(location.search)
if (params.has("upstream")) await import("../../src/transcript/transcript.css")

const ApprovalSettings = lazy(() => import("@/requests/settings"))

const notifications: Omit<HostNotification, "onClick">[] = []
const clicks: (() => void)[] = []
const opened: string[] = []
const [focused, setFocused] = createSignal(true)
const web = createWebHost()
const host: OwnHost = {
  ...web,
  capabilities: { ...web.capabilities, osNotifications: "web" },
  window: { focus: () => undefined, show: () => undefined, isFocused: () => focused() },
  openExternal: (url) => void opened.push(url),
  notify(input) {
    notifications.push({ title: input.title, body: input.body, tag: input.tag })
    if (input.onClick) clicks.push(input.onClick)
  },
}

render(() => {
  const data = createDataLayer({ host })
  const router = createMemoryRouter("own.web.requests.harness.route")
  Object.assign(window, {
    __requestsHarness: {
      runtime: data.local(),
      notifications,
      opened,
      setFocused,
      clickLastNotification: () => clicks.at(-1)?.(),
      open: (sessionID: string) => router.navigate({ name: "session", serverKey: LOCAL, sessionID }),
      settings: () => router.navigate({ name: "settings", section: "approval" }),
      home: () => router.navigate({ name: "home" }),
    },
  })
  return (
    <HostProvider value={host}>
      <ThemeProvider>
        <I18nProvider value={createI18n("ko")}>
          <DataProvider value={data}>
            <RouterProvider value={router}>
              <ShortcutProvider value={createShortcutRegistry()}>
                <Layout />
              </ShortcutProvider>
            </RouterProvider>
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  )
}, document.getElementById("root")!)

function Layout() {
  const router = useRouter()
  const sessionID = () => {
    const route = router.route()
    return route.name === "session" ? route.sessionID : undefined
  }
  return (
    <div class="mx-auto flex min-h-screen max-w-[820px] flex-col gap-3 bg-own-bg p-4 text-own-text">
      <header class="own-header" data-testid="header">
        <b class="own-header-title" data-testid="route">
          {routePath(router.route())}
        </b>
        <ApprovalModePill serverKey={() => LOCAL} sessionID={sessionID} />
      </header>
      <Show when={router.route().name === "settings"}>
        <Suspense>
          <ApprovalSettings />
        </Suspense>
      </Show>
      <div class="mt-auto flex flex-col">
        <RequestDocks serverKey={() => LOCAL} sessionID={sessionID} />
        <label class="own-sr-only" for="own-composer-input">
          composer
        </label>
        <textarea
          id="own-composer-input"
          data-own-keys="composer"
          data-testid="composer"
          rows={3}
          class="w-full rounded-[14px] border border-own-border p-3"
        />
      </div>
      <RequestNotifications />
      <Toasts />
    </div>
  )
}

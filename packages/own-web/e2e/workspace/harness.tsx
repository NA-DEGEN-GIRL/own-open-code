// Workspace harness for Playwright (dev server only): the same providers as src/app.tsx (host, i18n, data layer,
// router, shortcuts) around the projects, mcp and policy modules, mounted the way the integrator is asked to mount
// them (ProjectOpenerLayer + McpLayer once, ProjectSelect and BrowserToolNotice on the new-session screen,
// ServerStatusPopover in the sidebar footer, the lazy MCP settings page for /settings/mcp). A memory router keeps the
// harness URL. Query switches emulate hosts: `?pane` (browserPane, the desktop), `?native=<dir>` (native folder
// dialog returning that folder; empty = cancelled; `&nativeDelay=<ms>` keeps it "opening" that long, like Windows' folder
// dialog, and `&nativeDelay=hold` until the spec calls `__workspaceHarness.answer()`), `?session=<id>` (open that
// session), `?mcp=<a,b>` (MCP servers that
// session's tool calls used), `?model=<provider>/<id>`
// (model of sessions the harness creates).
import "@/styles/index.css"
import { createEffect, createMemo, lazy, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider, LOCAL, useData } from "@/data"
import { HostProvider, useHost, type OwnHost } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { McpAuthBanner, McpLayer, ServerStatusPopover } from "@/mcp"
import { BrowserToolNotice, withBrowserPolicy } from "@/policy"
import { activeDirectory, OpenFolderButton, openProject, ProjectOpenerLayer, ProjectSelect } from "@/projects"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import { routePath } from "@/routing/routes"
import { newSessionTarget, targetFor } from "@/sidebar/target"

const McpSettings = lazy(() => import("@/mcp/settings"))

const params = new URLSearchParams(location.search)
const web = createWebHost()
const native = params.get("native")
const nativeDelay = params.get("nativeDelay")
/** Native dialogs the page asked for (single-flight checks). */
let picks = 0
/** Dialogs `nativeDelay=hold` keeps open until `answer()`. */
const held: Array<() => void> = []
const host: OwnHost = {
  ...web,
  capabilities: { ...web.capabilities, browserPane: params.has("pane"), nativeDirectoryPicker: native !== null },
  files:
    native === null
      ? undefined
      : {
          pickDirectory: async () => {
            picks++
            await (nativeDelay === "hold"
              ? new Promise<void>((resolve) => held.push(resolve))
              : new Promise((resolve) => setTimeout(resolve, Number(nativeDelay ?? 0))))
            return native || null
          },
        },
}

render(() => {
  const data = createDataLayer({ host })
  // Diagnostics for the specs (event log of the local server).
  const events: { type: string; directory?: string }[] = []
  data
    .local()
    .bus.listen((event) =>
      events.push({ type: event.type, directory: "location" in event ? event.location?.directory : undefined }),
    )
  Object.assign(window, {
    __workspaceHarness: {
      runtime: data.local(),
      events,
      picks: () => picks,
      answer: () => held.splice(0).forEach((resolve) => resolve()),
    },
  })
  const router = createMemoryRouter(`own.web.workspace.harness.${params.has("pane") ? "pane" : "web"}`)
  // `?session=<id>` opens that session (the same session seen from another kind of window).
  const opened = params.get("session")
  if (opened) router.navigate({ name: "session", serverKey: LOCAL, sessionID: opened })
  return (
    <HostProvider value={host}>
      <I18nProvider value={createI18n("ko")}>
        <DataProvider value={data}>
          <RouterProvider value={router}>
            <ShortcutProvider value={createShortcutRegistry()}>
              <Layout />
              <ProjectOpenerLayer />
              <McpLayer />
            </ShortcutProvider>
          </RouterProvider>
        </DataProvider>
      </I18nProvider>
    </HostProvider>
  )
}, document.getElementById("root")!)

function Layout() {
  const router = useRouter()
  const data = useData()
  const host = useHost()
  const runtime = data.local()
  const route = router.route
  // The project route's folder, else the newest session's (the composer's `newSessionDirectory` starts in the default
  // conversation folder there since 03 §5.1 DF; this harness keeps a project folder on screen for the picker tests).
  const newDirectory = createMemo(() => {
    const current = route()
    if (current.name === "project")
      return (
        targetFor(current.serverKey, current.projectID)?.directory ??
        runtime.sessions.state.projects[current.projectID]?.directory
      )
    return activeDirectory(runtime, current)
  })
  const sessionID = () => {
    const current = route()
    return current.name === "session" ? current.sessionID : undefined
  }
  createEffect(() => {
    const id = sessionID()
    if (id) void runtime.data.session.sync(id).catch(() => undefined)
  })

  /** What the composer does on the first send (integrator wiring: rule 1 of 01 §10.1 at creation). */
  async function createSession() {
    const directory = newDirectory()
    const [providerID, id] = (params.get("model") ?? "").split("/")
    if (!directory || !providerID || !id) return
    const created = await runtime
      .client()
      .session.create(
        withBrowserPolicy(
          { title: "하네스 세션", model: { providerID, id }, location: { directory } },
          host.capabilities,
        ),
      )
    runtime.data.session.remember(created)
    router.navigate({ name: "session", serverKey: runtime.key, sessionID: created.id })
  }

  return (
    <div class="flex min-h-screen flex-col gap-4 bg-own-bg p-4 text-own-text" data-testid="harness">
      <header class="flex flex-wrap items-center gap-3 text-[13px]">
        <span data-testid="route">{routePath(route())}</span>
        <span data-testid="target" class="font-mono">
          {newSessionTarget()?.directory ?? ""}
        </span>
        <button type="button" class="own-btn" data-testid="open-folder" onClick={() => openProject()}>
          폴더 열기…
        </button>
        <OpenFolderButton serverKey={LOCAL} keys />
        <button
          type="button"
          class="own-btn"
          data-testid="go-mcp"
          onClick={() => router.navigate({ name: "settings", section: "mcp" })}
        >
          MCP 설정
        </button>
        <button type="button" class="own-btn" data-testid="go-home" onClick={() => router.navigate({ name: "home" })}>
          홈
        </button>
      </header>
      <Show when={route().name === "home" || route().name === "project"}>
        <section class="flex flex-col gap-2 rounded-lg border border-own-border p-3" data-testid="new-session">
          <div class="flex items-center gap-2">
            <ProjectSelect directory={newDirectory} />
            <span class="font-mono text-[12px]" data-testid="new-directory">
              {newDirectory() ?? ""}
            </span>
          </div>
          <BrowserToolNotice />
          <button
            type="button"
            class="own-btn self-start"
            data-testid="create-session"
            onClick={() => void createSession()}
          >
            세션 만들기
          </button>
        </section>
      </Show>
      <Show when={sessionID()}>
        {(id) => (
          <section class="flex flex-col gap-2 rounded-lg border border-own-border p-3" data-testid="session">
            <BrowserToolNotice sessionID={id()} />
            <McpAuthBanner
              directory={runtime.data.session.get(id())?.location.directory}
              servers={params.get("mcp")?.split(",") ?? []}
            />
            <pre class="m-0 text-[11px]" data-testid="session-permissions">
              {JSON.stringify(runtime.data.session.get(id())?.permissions ?? null)}
            </pre>
          </section>
        )}
      </Show>
      <Show when={route().name === "settings"}>
        <section class="max-w-[760px]" data-testid="settings">
          <Suspense>
            <McpSettings directory={activeDirectory(runtime, route())} />
          </Suspense>
        </section>
      </Show>
      <footer class="mt-auto flex items-center gap-2 border-t border-own-border pt-2 text-[12px]">
        <ServerStatusPopover
          class="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-own-hover"
          testid="server-status"
        >
          <span class="size-[7px] rounded-full bg-own-ok" />이 PC
        </ServerStatusPopover>
      </footer>
    </div>
  )
}

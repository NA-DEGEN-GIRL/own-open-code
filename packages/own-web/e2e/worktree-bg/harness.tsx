// Worktree + background harness (dev server only): the providers of src/app.tsx around the worktree and background
// modules, wired the way the report asks the integrator to wire them:
//   - new-session screen: `<WorktreeSelect directory serverKey>` next to the project selector; `create()` resolves the
//     folder with `resolveNewSessionDirectory` before `session.create` (send stays locked while `worktreeCreating()`);
//   - session header `⋯`: `다른 작업 폴더로 옮기기…` → `openWorktreeMove`; the 작업 위치 of the session (`workPlace`);
//     `<RunningMenu>` after the title (03 §4.4);
//   - sidebar: the project's sessions split by `groupSessions` + `useProjectWorktrees` into `⑂` groups, `⧗` from
//     `backgroundCount`;
//   - composer: `<BackgroundDock>` at the bottom of the dock stack, the textarea inside `data-own-keys="composer"` (Alt+B);
//   - composer: `<LocationMissingNotice>` above it (03 §8 세션 폴더 없음), with `<ProjectOpenerLayer/>` for its picker;
//   - once: `<BackgroundHost/>`, `<WorktreeHost/>`, the toasts.
// `?scheme=light|dark` picks the color scheme (dark is the default). `window.__wt` lets Playwright drive it.
import "@/styles/index.css"
import "@/switcher/switcher.css"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js"
import { render } from "solid-js/web"
import { backgroundCount, BackgroundDock, BackgroundHost, RunningMenu } from "@/background"
import { createDataLayer, DataProvider, LOCAL, useData } from "@/data"
import { HostProvider } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider, useI18n } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { ProjectOpenerLayer } from "@/projects"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import { COLOR_SCHEME_KEY, seedColorScheme } from "@/shell/theme-default"
import { Toasts } from "@/switcher/toast"
import { Transcript } from "@/transcript"
import {
  canMoveSession,
  groupSessions,
  LocationMissingNotice,
  openWorktreeMove,
  resolveNewSessionDirectory,
  useProjectWorktrees,
  workPlace,
  worktreeCreating,
  WorktreeHost,
  worktreeName,
  WorktreeSelect,
} from "@/worktree"

const host = createWebHost()
const root = document.getElementById("root")!
const scheme = new URLSearchParams(location.search).get("scheme")
if (scheme === "light" || scheme === "dark") localStorage.setItem(COLOR_SCHEME_KEY, scheme)
else seedColorScheme()

interface Setup {
  readonly directory: string
  readonly projectID: string
  readonly providerID: string
  readonly model: string
}

function Harness() {
  const data = useData()
  const router = useRouter()
  const i18n = useI18n()
  const runtime = () => data.local()
  const serverKey = () => LOCAL
  const [setup, setSetup] = createSignal<Setup>()
  const sessionID = () => {
    const route = router.route()
    return route.name === "session" ? route.sessionID : undefined
  }
  const session = () => {
    const id = sessionID()
    return id ? runtime().data.session.get(id) : undefined
  }
  const [creating, setCreating] = createSignal(false)
  let input: HTMLTextAreaElement | undefined
  let newInput: HTMLTextAreaElement | undefined

  createEffect(() => {
    const id = sessionID()
    const current = runtime()
    if (!id || current.connection.status() !== "connected") return
    untrack(() => {
      void current.data.session.sync(id).catch(() => undefined)
      void current.data.session.pending.sync(id).catch(() => undefined)
    })
  })

  // ---- sidebar: the Git project's root sessions with ⑂ groups ----
  const worktrees = useProjectWorktrees(runtime, () => setup()?.projectID)
  const rows = createMemo(() => {
    const project = setup()?.projectID
    const index = runtime().sessions.state
    return index.order.flatMap((id) => {
      const row = index.sessions[id]
      if (!row || row.projectID !== project) return []
      return [{ id, title: row.title, directory: runtime().data.session.get(id)?.location.directory ?? row.directory }]
    })
  })
  const groups = createMemo(() => {
    const current = setup()
    return current ? groupSessions(current.directory, rows(), worktrees()) : { local: [], worktrees: [] }
  })

  // ---- new session (03 §5.1 + §19.3) ----
  async function create() {
    const current = setup()
    const text = newInput?.value.trim()
    if (!current || !text || creating() || worktreeCreating()) return
    setCreating(true)
    try {
      const folder = await resolveNewSessionDirectory(runtime(), current.directory, i18n.locale())
      if (!folder) return
      const info = await runtime()
        .client()
        .session.create({
          title: text,
          model: { providerID: current.providerID, id: current.model },
          location: { directory: folder },
          // The scripted shell tool runs without the approval dock in this suite.
          permissions: [{ action: "shell", resource: "*", effect: "allow" }],
        })
      runtime().data.session.remember(info)
      if (newInput) newInput.value = ""
      router.navigate({ name: "session", serverKey: LOCAL, sessionID: info.id })
    } finally {
      setCreating(false)
    }
  }

  async function send() {
    const id = sessionID()
    const text = input?.value.trim()
    if (!id || !text || !input) return
    input.value = ""
    const busy = runtime().data.session.status(id) === "running"
    await runtime()
      .data.session.prompt({ sessionID: id, text, delivery: busy ? "steer" : undefined })
      .catch(() => undefined)
  }

  const place = () => {
    const id = sessionID()
    const where = id ? workPlace(runtime(), id) : undefined
    if (!where) return "—"
    return where.kind === "local" ? "프로젝트 폴더" : `⑂ ${where.name}`
  }

  // ---- window.__wt (Playwright) ----
  const api = {
    ready: () => runtime().connection.status() === "connected" && runtime().own.state.status === "ready",
    setup: (value: Setup) => setSetup(value),
    open: (id: string) => router.navigate({ name: "session", serverKey: LOCAL, sessionID: id }),
    home: () => router.navigate({ name: "home" }),
    current: () => sessionID(),
    directory: (id = sessionID()!) => runtime().data.session.get(id)?.location.directory,
    status: (id = sessionID()!) => runtime().data.session.status(id),
    pending: (id = sessionID()!) =>
      runtime()
        .data.session.pending.list(id)
        .map((item) => item.type),
    prompt: (text: string) =>
      runtime()
        .data.session.prompt({ sessionID: sessionID()!, text })
        .then((item) => item.id),
    shells: (id = sessionID()!) =>
      runtime()
        .data.shell.listBySession(id)
        .map((shell) => ({ id: shell.id, status: shell.status, command: shell.command })),
    tools: (id = sessionID()!) =>
      runtime()
        .data.session.message.list(id)
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .flatMap((part) =>
          part.type === "tool"
            ? [
                {
                  name: part.name,
                  status: part.state.status,
                  meta: "metadata" in part.state ? part.state.metadata : {},
                },
              ]
            : [],
        ),
    worktrees: () => runtime().client().worktree.list({ projectID: setup()!.projectID }),
    background: (id = sessionID()!) => backgroundCount(runtime(), id),
    /** A session in any folder (the missing-folder test deletes it afterwards). */
    async createIn(directory: string, title: string) {
      const current = setup()!
      const info = await runtime()
        .client()
        .session.create({
          title,
          model: { providerID: current.providerID, id: current.model },
          location: { directory },
        })
      runtime().data.session.remember(info)
      return info.id
    },
  }
  Object.assign(window, { __wt: api })

  return (
    <div class="wt" data-testid="wt">
      <aside class="wt-side" data-testid="wt-side">
        <button type="button" class="wt-new" data-testid="wt-home" onClick={() => api.home()}>
          + 새 세션
        </button>
        <For each={groups().local}>{(row) => <SessionRow id={row.id} title={row.title} />}</For>
        <For each={groups().worktrees}>
          {(group) => (
            <div class="wt-group" data-testid="wt-group" title={group.directory}>
              <p class="wt-group-name">⑂ {worktreeName(group.directory)}</p>
              <For each={group.rows}>{(row) => <SessionRow id={row.id} title={row.title} />}</For>
            </div>
          )}
        </For>
      </aside>
      <main class="wt-main">
        <Show
          when={sessionID()}
          fallback={
            <section class="wt-home" data-testid="wt-new-session">
              <h2 class="wt-h">새 세션</h2>
              <textarea
                ref={newInput}
                class="wt-input"
                rows={3}
                placeholder="메시지를 입력하세요"
                data-testid="wt-new-input"
                data-own-keys="composer"
              />
              <div class="wt-bar">
                <WorktreeSelect directory={() => setup()?.directory} serverKey={serverKey()} />
                <span class="wt-grow" />
                <button
                  type="button"
                  class="wt-send"
                  data-testid="wt-create"
                  disabled={creating() || worktreeCreating() || !setup()}
                  onClick={() => void create()}
                >
                  ↵ 전송
                </button>
              </div>
            </section>
          }
        >
          <header class="wt-header" data-testid="wt-header">
            <b>{session()?.title ?? "—"}</b>
            <RunningMenu serverKey={serverKey} sessionID={sessionID} />
            <span class="wt-place" data-testid="wt-place" title={session()?.location.directory}>
              {place()}
            </span>
            <Show when={canMoveSession(runtime(), sessionID()!)}>
              <button
                type="button"
                class="wt-link"
                data-testid="wt-move"
                onClick={() => openWorktreeMove({ serverKey: LOCAL, sessionID: sessionID()! })}
              >
                다른 워크트리로 옮기기…
              </button>
            </Show>
            <span class="wt-status" data-testid="wt-status">
              {runtime().data.session.status(sessionID()!) === "running" ? "running" : "idle"}
            </span>
          </header>
          <div class="wt-transcript">
            <Transcript serverKey={serverKey} sessionID={sessionID} />
          </div>
          <div class="wt-bottom">
            <BackgroundDock serverKey={serverKey} sessionID={sessionID} />
            <LocationMissingNotice serverKey={serverKey} sessionID={sessionID} />
            <div class="wt-composer" data-own-keys="composer">
              <textarea
                ref={input}
                class="wt-input"
                rows={2}
                placeholder="메시지"
                data-testid="wt-input"
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return
                  event.preventDefault()
                  void send()
                }}
              />
            </div>
          </div>
        </Show>
      </main>
      <BackgroundHost />
      <WorktreeHost />
      <ProjectOpenerLayer shortcut={false} />
      <Toasts />
      <style>{HARNESS_CSS}</style>
    </div>
  )
}

function SessionRow(props: { readonly id: string; readonly title?: string }) {
  const data = useData()
  const router = useRouter()
  const background = () => backgroundCount(data.local(), props.id)
  return (
    <button
      type="button"
      class="wt-row"
      data-testid="wt-row"
      data-id={props.id}
      onClick={() => router.navigate({ name: "session", serverKey: LOCAL, sessionID: props.id })}
    >
      <span class="wt-row-title">{props.title ?? props.id}</span>
      <Show when={background() > 0}>
        <span class="wt-row-mark" data-testid="wt-row-background" title="백그라운드 작업만 도는 중">
          ⧗
        </span>
      </Show>
    </button>
  )
}

const HARNESS_CSS = `
.wt { display: grid; grid-template-columns: 260px 1fr; height: 100vh; background: var(--own-bg); color: var(--own-text); font-family: var(--own-font-sans); }
.wt-side { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-right: 1px solid var(--own-border); background: var(--own-bg-subtle); overflow: auto; font-size: 12.5px; }
.wt-new, .wt-row { display: flex; gap: 6px; align-items: center; text-align: left; padding: 6px 8px; border: 1px solid var(--own-border); border-radius: 6px; background: var(--own-bg-raised); color: inherit; font: inherit; cursor: pointer; }
.wt-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-row-mark { color: var(--own-text-muted); }
.wt-group { display: flex; flex-direction: column; gap: 4px; margin-left: 8px; }
.wt-group-name { margin: 6px 0 0; color: var(--own-text-faint); font-size: 11.5px; }
.wt-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.wt-home { width: min(720px, calc(100% - 32px)); margin: 18vh auto 0; }
.wt-h { margin: 0 0 12px; font-size: 18px; }
.wt-header { display: flex; gap: 12px; align-items: center; height: 44px; padding: 0 16px; border-bottom: 1px solid var(--own-border); }
.wt-place { color: var(--own-text-muted); font-size: 12px; }
.wt-link { border: 0; background: none; color: var(--own-accent-text); font: inherit; font-size: 12.5px; cursor: pointer; }
.wt-status { margin-left: auto; font-size: 11px; color: var(--own-text-faint); }
.wt-transcript { position: relative; display: flex; flex: 1; min-height: 0; }
.wt-bottom { padding: 8px 16px 12px; max-width: 800px; width: 100%; margin: 0 auto; }
.wt-composer, .wt-home .wt-input { border: 1px solid var(--own-border-strong); border-radius: 12px; padding: 8px; background: var(--own-bg-raised); }
.wt-input { width: 100%; border: 0; resize: none; background: var(--own-bg-raised); color: inherit; font: inherit; outline: none; box-sizing: border-box; }
.wt-bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.wt-grow { flex: 1; }
.wt-send { height: 30px; padding: 0 12px; border: 0; border-radius: 8px; background: var(--own-accent); color: var(--own-on-accent); font: inherit; cursor: pointer; }
.wt-send:disabled { opacity: 0.5; }
`

render(() => {
  const data = createDataLayer({ host })
  const router = createMemoryRouter("own.web.wtbg.harness.route")
  return (
    <HostProvider value={host}>
      <ThemeProvider>
        <I18nProvider value={createI18n("ko")}>
          <DataProvider value={data}>
            <RouterProvider value={router}>
              <ShortcutProvider value={createShortcutRegistry()}>
                <Harness />
              </ShortcutProvider>
            </RouterProvider>
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  )
}, root)

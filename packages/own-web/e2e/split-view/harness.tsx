// Split view harness for Playwright (dev server only): the real App (providers of src/app.tsx and the AppShell) on the
// web host against the real server, with a memory router so the spec can read the route.
// Query switches:
//   - `?pane`: the host has a browser pane (desktop capability) backed by a fake platform. Each registration reports one
//     tab; every layout the pane sends is kept per session in `__splitHarness.layouts` and drawn as a coloured box
//     where the native view would be (`data-testid="fake-view"`), so the spec and screenshots see which views are on
//     screen at once. `__splitHarness.focusView(sessionID)` reports a click inside that view, like main's view focus.
//     Every command the pane sends is kept in `__splitHarness.commands`; `tabs.open` and `navigate` change the fake
//     inventory the way main's do (a new focused tab, the tab's new URL). An address with `unreachable` in it does not
//     load: its tab reports `loadError` as main's page does for the proxy's empty 502 (05 §8.6); `reload` keeps it.
//   - `&empty`: registrations report no tabs (a session whose browser nobody opened yet).
//   - `?light`: start in the light theme.
import "@/styles/index.css"
import { createSignal, For, Show } from "solid-js"
import { render } from "solid-js/web"
import { App } from "@/app"
import type {
  BrowserPaneCommand,
  BrowserPaneEvent,
  BrowserPaneLayout,
  BrowserPanePlatform,
  BrowserPaneTarget,
  BrowserState,
} from "@/browser/types"
import { createDataLayer } from "@/data"
import type { OwnHost } from "@/host"
import { createWebHost } from "@/host/web"
import { createMemoryRouter } from "@/routing/router"

const params = new URLSearchParams(location.search)
if (params.has("light")) localStorage.setItem("opencode-color-scheme", "light")
const web = createWebHost()
const pane = params.has("pane")

const [layouts, setLayouts] = createSignal<Record<string, BrowserPaneLayout | undefined>>({})
const focusListeners = new Set<(bounds: { x: number; y: number; width: number; height: number }) => void>()
const registrations: { session: string; closed: boolean }[] = []
const commands: { session: string; command: BrowserPaneCommand }[] = []

const platform: BrowserPanePlatform & {
  onViewFocus(listener: (bounds: { x: number; y: number; width: number; height: number }) => void): () => void
} = {
  platform: "desktop",
  register(target: BrowserPaneTarget, listener: (event: BrowserPaneEvent) => void) {
    const record = { session: target.sessionID, closed: false }
    registrations.push(record)
    const tab = (id: string, url: string) => ({
      id,
      url,
      title: url.startsWith("https://example.test/") ? `페이지 ${target.sessionID.slice(-4)}` : "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      generation: 1,
      ...(url.includes("unreachable") ? { loadError: "502 Bad Gateway" } : {}),
    })
    let state: BrowserState = params.has("empty")
      ? { tabs: [], focusedTabID: null }
      : {
          tabs: [tab(`tab-${target.sessionID}`, `https://example.test/${target.sessionID.slice(-6)}`)],
          focusedTabID: `tab-${target.sessionID}`,
        }
    const emit = () => listener({ type: "state", state })
    queueMicrotask(emit)
    return {
      setLayout(layout) {
        setLayouts((current) => ({ ...current, [target.sessionID]: layout }))
      },
      async command(command) {
        commands.push({ session: target.sessionID, command })
        if (command.type === "tabs.open") {
          const id = `tab-${target.sessionID}-${state.tabs.length + 1}`
          state = { tabs: [...state.tabs, tab(id, command.url ?? "about:blank")], focusedTabID: id }
          emit()
        }
        if (command.type === "navigate") {
          state = {
            ...state,
            tabs: state.tabs.map((item) => (item.id === command.tabID ? tab(item.id, command.url) : item)),
          }
          emit()
        }
      },
      capture: async () => null,
      close() {
        record.closed = true
        setLayouts((current) => ({ ...current, [target.sessionID]: undefined }))
      },
    }
  },
  onViewFocus(listener) {
    focusListeners.add(listener)
    return () => focusListeners.delete(listener)
  },
}

const host: OwnHost = {
  ...web,
  capabilities: { ...web.capabilities, browserPane: pane },
  ...(pane ? { browser: platform } : {}),
}
const router = createMemoryRouter(`own.web.split.harness.${Date.now()}`)
const data = createDataLayer({ host })

Object.assign(window, {
  __splitHarness: {
    router,
    registrations,
    commands,
    /** Sessions whose fake native view is on screen now, with its bounds. */
    visible: () =>
      Object.entries(layouts())
        .filter((entry): entry is [string, BrowserPaneLayout] => !!entry[1]?.visible && !!entry[1].bounds)
        .map(([session, layout]) => ({ session, bounds: layout.bounds! })),
    focusView(sessionID: string) {
      const bounds = layouts()[sessionID]?.bounds
      if (bounds) focusListeners.forEach((listener) => listener(bounds))
    },
  },
})

render(
  () => (
    <>
      <App host={host} router={router} data={data} />
      <Show when={pane}>
        <For each={Object.entries(layouts()).filter((entry) => entry[1]?.visible && entry[1].bounds)}>
          {([session, layout]) => (
            <div
              data-testid="fake-view"
              data-session={session}
              style={{
                position: "fixed",
                left: `${layout!.bounds!.x}px`,
                top: `${layout!.bounds!.y}px`,
                width: `${layout!.bounds!.width}px`,
                height: `${layout!.bounds!.height}px`,
                "pointer-events": "none",
                "z-index": 5,
                background: "repeating-linear-gradient(135deg, #2d6cdf22 0 12px, #2d6cdf11 12px 24px)",
                outline: "2px solid #2d6cdf",
                display: "grid",
                "place-items": "center",
                color: "#2d6cdf",
                font: "600 13px system-ui",
              }}
            >
              네이티브 뷰 · {session.slice(-6)}
            </div>
          )}
        </For>
      </Show>
    </>
  ),
  document.getElementById("root")!,
)

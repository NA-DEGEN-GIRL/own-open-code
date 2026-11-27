// Shell-level shortcuts (03 §10). Feature shortcuts (switcher, palette, composer, dock, find) are registered by
// their modules with `useShortcut`; a key without a registered handler does nothing and is not prevented.
import { newChatHost } from "@/servers/active"
import { onCleanup } from "solid-js"
import { useHost } from "@/host"
import { toggleChatOnly } from "@/chat-view"
import { useData } from "@/data"
import { requestQuickOpen } from "@/files"
import { installFindPriority } from "@/find/priority"
import { useShortcut, useShortcuts } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { requestNewTerminal } from "@/terminal/intents"
import { useShell } from "./context"

export function ShellShortcuts() {
  const shell = useShell()
  const router = useRouter()
  const host = useHost()
  const data = useData()
  // 19.13: Ctrl+F reaches the transcript's find before session-ui's page-wide file find (find/priority.ts).
  onCleanup(installFindPriority(useShortcuts()))

  useShortcut("sidebar.toggle", () => shell.toggleSidebar())
  useShortcut("panel.toggle", () => shell.togglePanel())
  useShortcut("panel.review", () => shell.openTab("review", true))
  useShortcut("panel.files", () => shell.openTab("files", true))
  // 4.7.3: with the terminal under the conversation, Ctrl+` toggles that dock instead of the tab.
  useShortcut("panel.terminal", () =>
    shell.layout.state.terminalPlacement === "bottom" ? shell.toggleTerminalDock() : shell.openTab("terminal", true),
  )
  // Before the terminal chunk is mounted (it registers the same id while it is): open it, then ask for a new one.
  useShortcut("terminal.new", () => {
    shell.openTerminal()
    requestNewTerminal()
  })
  useShortcut("panel.accounts", () => shell.openTab("accounts", true))
  // 19.4 Ctrl+P: the files tab with the quick open box (the shell resolves `own:quick-open`, intents.tsx).
  useShortcut("file.open", () => requestQuickOpen())
  // 03 §10: not registered at all without a browser pane, so the key keeps its browser meaning.
  if (host.capabilities.browserPane) useShortcut("panel.browser", () => shell.openTab("browser", true))
  useShortcut("history.back", () => router.back())
  useShortcut("history.forward", () => router.forward())
  useShortcut("session.new", () => router.navigate({ name: "home", serverKey: newChatHost() }))
  useShortcut("settings.open", () => router.navigate({ name: "settings", section: "general", list: true }))
  useShortcut("shortcuts.help", () => router.navigate({ name: "settings", section: "shortcuts" }))
  // 4.5 대화 보기
  useShortcut("view.chatOnly", () => toggleChatOnly())
  useShortcut("session.previous", () => step(-1))
  useShortcut("session.next", () => step(1))
  // The zoom keys are ZoomLayer's (zoom.tsx), on hosts that zoom their windows; the web leaves them to the browser.

  function step(delta: number) {
    const route = router.route()
    const order = data.local().sessions.state.order
    if (!order.length) return
    const index = route.name === "session" ? order.indexOf(route.sessionID) : -1
    const next = order[Math.min(order.length - 1, Math.max(0, index + delta))]
    if (next) router.navigate({ name: "session", serverKey: "local", sessionID: next })
  }

  return null
}

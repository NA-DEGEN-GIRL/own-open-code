// Always-on part of the browser pane (05 §8.2), mounted by the shell only when the host has a pane and loaded as its
// own chunk. Keeps the window's attachments registered whether or not the 브라우저 tab was ever opened, so the agent's
// `browser.*` tools work in the session the user is looking at, on this PC and on an SSH host alike (05 §8.6):
//  - every session a split pane shows gets its attachment (03 §4.1.1): this PC's service by its own URL, an SSH host's
//    by its tunnel endpoint with the host's session token as the password (8.6; main uses it for that attachment only),
//    once its rules are known and unless it was created without the browser tools (05 §8.7 rule 1). Since 82bb5ff88a
//    an attachment appends `browser allow` to the session's rules while it lasts, so attaching such a session would
//    hand it the tools after all (rule 2): no attachment, no wake, for a session whose rules are unknown or removed;
//  - every session a paired device asks a pane for (05 §8.10.4, wanted.ts): the local own-remote's
//    `browser.pane.wanted{serverKey?, sessionID}` event, and its list of the same name at start and after every
//    reconnect. A phone opened the session's browser view, or is about to prompt it, and only this window can make the
//    attachment. The same two rules hold (a session this window has not loaded is read first), nothing writes session
//    rules, and nothing is shown or focused: the session need not be on screen here at all;
//  - per server (`serve`): the local service came back after a restart → every local attachment registers again (new
//    password, 8.2); an SSH host's endpoint came back, moved, or got a new token → that host's attachments register
//    again (its pane's stream ended with the link; main fixes the token at register time);
//  - a turn starting in a session wakes its attachment (upstream's browser model does the same): one the service
//    suspended while idle registers again, so the agent gets its browser tools back (since 82bb5ff88a the plugin
//    lists them only while a desktop is attached);
//  - main's `focus` event (the agent opened or focused a tab) shows that session's browser: in `나란히` its browser
//    pane beside the pane that shows the session (03 §4.1.1), in tabs the 브라우저 tab of the focused pane when the
//    panel is closed and the user is not typing (03 §18.17);
//  - the agent-activity tracker of each server (activity.ts: tab badge, "에이전트가 조작 중", takeover), which also
//    shows the browser the same way when the agent starts using it;
//  - 05 §7.2 close confirmation: only while a running session of this window holds a browser attachment with tabs,
//    the shell's close guard is up and `beforeunload` is registered (main asks [창 닫기] [취소]); otherwise closing
//    costs nothing;
//  - 05 §8.4 downloads (downloads.ts), when the shell reports them: placed with the session whose tab started them,
//    and marked gone when their tab leaves the inventory or the attachment closes (the shell deletes the files);
//  - 03 §18.15 rule 3: each server's router writes the per-session browser switch (enable.ts), so a session created
//    without the browser tools shows "이 세션에서 켜기" in the 브라우저 tab.
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, untrack } from "solid-js"
import { LOCAL, remoteEvent, useData, type ServerEntry, type ServerRuntime } from "@/data"
import { openFile } from "@/files"
import { useHost } from "@/host"
import { browserRemoved } from "@/policy/browser"
import { useRouter } from "@/routing/router"
import { remoteStore } from "@/servers/active"
import { useShell } from "@/shell/context"
import { createBrowserActivity } from "./activity"
import { closeGuardNeeded, createBrowserAttachments, setWindowAttachments, type SessionAttachment } from "./attachments"
import { createDownloadStore, setWindowDownloads } from "./downloads"
import { createRouterBrowserEnableWriter, setBrowserEnableWriter } from "./enable"
import { setWindowActivity, windowActivity } from "./registry"
import { browserPlatform } from "./types"
import { createWantedPanes } from "./wanted"

export default function BrowserAttach() {
  const host = useHost()
  const platform = browserPlatform(host)
  if (!platform) return null
  const data = useData()
  const router = useRouter()
  const shell = useShell()
  const [baseUrl, setBaseUrl] = createSignal<string>()
  void data.connecting.then((connection) => setBaseUrl(connection.baseUrl)).catch(() => undefined)

  const attachments = createBrowserAttachments({
    platform,
    // Local sidecar: exactly the host's baseUrl, no credentials (main adds Basic for that origin only, 03 §18.17).
    endpoint: (serverKey) => {
      if (serverKey !== LOCAL) return hostEndpoint(data.servers.get(serverKey))
      const url = baseUrl()
      return url ? { url } : undefined
    },
    focus: (serverKey, sessionID) => reveal({ serverKey, sessionID }),
    // 18.17 → 19.4: the pane's `preview` of a local file shows it in that session's files tab.
    preview: (serverKey, sessionID, path) => openFile({ serverKey, sessionID, path }),
  })
  setWindowAttachments(attachments)

  const local = data.local()
  // Rule 1 and 2 (header): only sessions whose rules are known and keep the browser tools.
  const attachable = (serverKey: string, sessionID: string) => {
    const info = data.get(serverKey)?.data.session.get(sessionID)
    return !!info && !browserRemoved(info.permissions)
  }
  // Every server's part (`serve`): this PC's at once, an SSH host's while its runtime exists.
  const served = new Map<string, () => void>([[LOCAL, serve(local)]])
  createEffect(() => {
    const keys = new Set(data.servers.list().map((server) => server.key))
    for (const key of keys) {
      const runtime = served.has(key) ? undefined : data.get(key)
      if (runtime)
        served.set(
          key,
          untrack(() => serve(runtime)),
        )
    }
    for (const [key, stop] of served)
      if (key !== LOCAL && !keys.has(key)) {
        stop()
        served.delete(key)
      }
  })
  // 05 §8.10.4. `browser.pane.wanted` is `local` scope: this PC's window may call it, a device never does. An SSH
  // host's session is read from that host's runtime, so it waits until the host is connected (the hub asks again).
  const wanted = createWantedPanes({
    wanted: async () => {
      const output = await data.remote.call("browser.pane.wanted", {})
      return [...output.sessionIDs.map((sessionID) => ({ serverKey: LOCAL, sessionID })), ...(output.hosts ?? [])]
    },
    known: (pane) => !!data.get(pane.serverKey)?.data.session.get(pane.sessionID),
    load: (pane) => data.get(pane.serverKey)?.data.session.sync(pane.sessionID) ?? Promise.resolve(),
    attachable: (pane) => attachable(pane.serverKey, pane.sessionID),
    attach: (pane) => attachments.ensure(pane.serverKey, pane.sessionID)?.wake(),
  })
  const stopWanted = local.bus.listen((raw) => {
    const event = remoteEvent(raw)
    if (event?.name === "browser.pane.wanted")
      void wanted.want({ serverKey: event.data.serverKey ?? LOCAL, sessionID: event.data.sessionID })
  })
  // Start and every reconnect: wishes whose event this window missed. Not before the endpoint is known (no
  // attachment can be made without it).
  createEffect(
    on(
      () => !!baseUrl() && local.connection.status() === "connected",
      (ready) => {
        if (ready) void wanted.refresh()
      },
    ),
  )
  // 03 §18.17: the agent starting to use the browser in a session on screen shows its browser (otherwise the tab badge
  // is enough). The `focus` event above covers tabs it opens or focuses.
  const phases = createMemo(
    () =>
      shell.paneSessions().map((session) => ({
        session,
        key: `${session.serverKey} ${session.sessionID}`,
        phase: windowActivity().get(session.serverKey)?.phase(session.sessionID) ?? "idle",
      })),
    [],
    {
      equals: (a, b) =>
        a.length === b.length && a.every((item, index) => item.key === b[index]?.key && item.phase === b[index]?.phase),
    },
  )
  createEffect(
    on(
      phases,
      (current, previous) => {
        const before = new Map((previous ?? []).map((item) => [item.key, item.phase]))
        for (const item of current)
          if (item.phase === "operating" && (before.get(item.key) ?? "idle") === "idle") reveal(item.session)
      },
      { defer: true },
    ),
  )

  const routed = () => {
    const route = router.route()
    return route.name === "session" ? attachments.get(route.serverKey, route.sessionID) : undefined
  }
  const downloads = platform.downloads
    ? createDownloadStore({
        downloads: platform.downloads,
        candidates: () => {
          const first = routed()
          return first ? [first, ...attachments.list().filter((item) => item !== first)] : attachments.list()
        },
      })
    : undefined
  setWindowDownloads(downloads)
  if (downloads) {
    // The shell deletes a tab's files with the tab page, and every page when a registration closes.
    const seen = new Map<SessionAttachment, ReadonlySet<string>>()
    createEffect(() => {
      for (const attachment of attachments.list()) {
        const state = attachment.state()
        const before = seen.get(attachment)
        const tabs = new Set(state.browser?.tabs.map((tab) => tab.id) ?? [])
        if (before)
          for (const id of before)
            if (!state.attached || !tabs.has(id)) downloads.tabClosed(attachment.serverKey, attachment.sessionID, id)
        if (state.attached) seen.set(attachment, tabs)
        else seen.delete(attachment)
      }
    })
  }
  onCleanup(() => {
    stopWanted()
    served.forEach((stop) => stop())
    served.clear()
    setWindowDownloads(undefined)
    downloads?.dispose()
    setWindowAttachments(undefined)
    attachments.dispose()
  })

  createEffect(() => {
    if (!baseUrl()) return
    // A session created without the browser tools (policy rule 1) gets no browser: nothing in it could use one, and
    // opening it here never turns the tools on (rule 2). Its rules load with its info; this runs again then.
    for (const session of shell.paneSessions())
      if (attachable(session.serverKey, session.sessionID))
        attachments.ensure(session.serverKey, session.sessionID)?.wake()
  })

  // 05 §7.2: ask before a close or reload only while it would break a running agent's browser work.
  // A memo: the guard (an IPC message and a listener) changes only when the answer does, not on every tab update.
  const guarded = createMemo(() =>
    closeGuardNeeded(
      attachments,
      (serverKey, sessionID) => data.get(serverKey)?.data.session.status(sessionID) === "running",
    ),
  )
  createEffect(() => {
    if (!guarded()) return
    // The shell holds a window close while the guard is up (no beforeunload round trip, 05 §7.2); `beforeunload`
    // covers the renderer's own reloads.
    platform.guardClose?.(true)
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", ask)
    onCleanup(() => {
      platform.guardClose?.(false)
      window.removeEventListener("beforeunload", ask)
    })
  })
  /**
   * One server's part of the window's browser (header): its agent-activity tracker, its router's browser switch, the
   * wake at a turn's start, and registering its attachments again when its endpoint came back. Returns the disposer.
   */
  function serve(runtime: ServerRuntime) {
    return createRoot((dispose) => {
      const key = runtime.key
      const activity = createBrowserActivity({
        bus: runtime.bus,
        turnRunning: (sessionID) => runtime.data.session.status(sessionID) === "running",
      })
      setWindowActivity(key, activity)
      const stopWake = runtime.bus.on("session.execution.started", (event) => {
        if (attachable(key, event.data.sessionID)) attachments.get(key, event.data.sessionID)?.wake()
      })
      const enableWriter = createRouterBrowserEnableWriter(runtime)
      setBrowserEnableWriter(key, enableWriter)
      // This PC's service restarted (a new password, 8.2). An SSH host's endpoint is known again after the link
      // dropped, moved, or carries a new token: main ended the host's attachments with the link and fixed the old token
      // at register time (8.2), so they register again.
      if (key === LOCAL)
        createEffect(
          on(
            () => runtime.connection.status(),
            (status, previous) => {
              if (status === "connected" && previous === "reconnecting") attachments.reset(key)
            },
            { defer: true },
          ),
        )
      if (key !== LOCAL) {
        const endpoint = createMemo(() => {
          const known = remoteStore()?.state.endpoints[key]
          return known ? `${known.url} ${known.tokenExpiresAt}` : undefined
        })
        createEffect(
          on(
            endpoint,
            (next, previous) => {
              if (next && next !== previous) attachments.reset(key)
            },
            { defer: true },
          ),
        )
      }
      onCleanup(() => {
        stopWake()
        setBrowserEnableWriter(key, undefined)
        enableWriter.dispose()
        setWindowActivity(key, undefined)
        activity.dispose()
      })
      return dispose
    })
  }

  /**
   * Shows a session's browser when a pane shows that session: `나란히` opens its browser pane (no focus change); tabs
   * switch the focused pane to 브라우저 only while the work panel is closed and the user is not typing.
   */
  function reveal(session: { readonly serverKey: string; readonly sessionID: string }) {
    const shown = shell
      .paneSessions()
      .some((item) => item.serverKey === session.serverKey && item.sessionID === session.sessionID)
    if (!shown) return
    if (shell.panes.mode() === "split" && shell.splitCapable()) return shell.revealBrowser(session)
    const route = router.route()
    if (route.name !== "session" || route.serverKey !== session.serverKey || route.sessionID !== session.sessionID)
      return
    if (shell.panelOpen() || typing()) return
    shell.revealBrowser(session)
  }

  return null
}

function typing() {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  return active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
}

/**
 * An SSH host's pane endpoint (05 §8.6): its tunnel's URL with the host's session token as the password, the token as
 * the window holds it (04 §12.1, the `Authorization` holder). Undefined until the host is connected here.
 */
function hostEndpoint(entry: ServerEntry | undefined) {
  const authorization = entry?.kind === "ssh" ? entry.headers?.().authorization : undefined
  if (!entry || !authorization?.startsWith("Basic ")) return undefined
  const password = atob(authorization.slice("Basic ".length)).slice("opencode:".length)
  return password ? { url: entry.baseUrl, username: "opencode", password } : undefined
}

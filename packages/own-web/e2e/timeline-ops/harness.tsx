// Timeline-ops harness (dev server only): the same providers as src/app.tsx around the real `Transcript` and the four
// modules of this suite, wired the way the report asks the integrator to wire them:
//   - composer area: `<QueuePanel>` (replacing QueueDock), `<AttachmentChips>`, `＋`, paste into the textarea, send with
//     `attachments.prepare(text)`, `own:composer-restore` → textarea; `<ChildSessionNotice>` instead of the input for
//     child sessions;
//   - main column: `<RevertBarSlot>`, `<SubagentStrip>`, `<AttachmentDropzone>` over transcript + composer;
//   - header: `<SubagentBreadcrumb>`; once: `<RevertHost>` and the toasts.
// The transcript is not wired to `actions.revert` here (that is the transcript owner's file), so each user message of
// the open session gets a `이 지점으로 복원` button in a side list. `window.__ops` lets Playwright drive the session
// (create, prompt, interrupt, a pending switch, approvals, file reads).
import "@/styles/index.css"
import "@/switcher/switcher.css"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { render } from "solid-js/web"
import {
  AttachButton,
  AttachmentChips,
  AttachmentDropzone,
  createAttachments,
  modelInput,
  onComposerRestore,
  restoredText,
  useAttachmentNotices,
} from "@/attachments"
import { busyDelivery, followUp } from "@/composer/send"
import { createDataLayer, DataProvider, LOCAL, useData } from "@/data"
import { HostProvider } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { createQueue, useQueueProblems } from "@/queue"
import { QueuePanel } from "@/queue/panel"
import { openRevertDialog, RevertBarSlot, RevertHost, useRevertCommands } from "@/revert"
import { userMessages } from "@/revert/model"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import { ChildRequestBadge, ChildSessionNotice, isChildSession, SubagentBreadcrumb, SubagentStrip } from "@/subagent"
import { modelInfo } from "@/switcher/labels"
import { Toasts } from "@/switcher/toast"
import { Transcript } from "@/transcript"

const host = createWebHost()
const root = document.getElementById("root")!

function Harness() {
  const data = useData()
  const router = useRouter()
  const runtime = () => data.local()
  const serverKey = () => LOCAL
  const sessionID = () => {
    const route = router.route()
    return route.name === "session" ? route.sessionID : undefined
  }
  const session = () => {
    const id = sessionID()
    return id ? runtime().data.session.get(id) : undefined
  }
  const directory = () => session()?.location.directory
  const child = () => isChildSession(runtime(), sessionID())
  const [held, setHeld] = createSignal<string[]>([])
  const [created, setCreated] = createSignal<{ id: string; title: string }[]>([])

  const attachments = createAttachments({
    host,
    runtime,
    serverKey,
    sessionID,
    directory,
    input: () => {
      const model = session()?.model
      const info = model ? modelInfo(runtime(), model, directory()) : undefined
      return info ? modelInput(info.capabilities) : undefined
    },
    loadInput: () => runtime().data.location.model.sync({ directory: directory() ?? "" }),
    notify: useAttachmentNotices(),
  })
  const queue = createQueue({ runtime, serverKey, sessionID, held, onProblem: useQueueProblems() })
  const commands = useRevertCommands()

  let input: HTMLTextAreaElement | undefined
  let main: HTMLElement | undefined
  onCleanup(
    onComposerRestore((detail) => {
      if (!input || detail.serverKey !== serverKey() || detail.sessionID !== sessionID()) return
      input.value = restoredText(input.value, detail)
    }),
  )

  // Open-session reads, as the composer and the transcript do (createData dedups them).
  createEffect(() => {
    const id = sessionID()
    const current = runtime()
    if (!id || current.connection.status() !== "connected") return
    untrack(() => {
      void current.data.session.sync(id).catch(() => undefined)
      void current.data.session.pending.sync(id).catch(() => undefined)
      void current.data.session.permission.sync(id).catch(() => undefined)
      void current.data.session.form.sync(id).catch(() => undefined)
    })
    onCleanup(current.own.watchOpen(id))
  })
  // The model catalog for image input and names.
  createEffect(() => {
    const dir = directory()
    if (dir && runtime().connection.status() === "connected")
      untrack(
        () =>
          void runtime()
            .data.location.model.sync({ directory: dir })
            .catch(() => undefined),
      )
  })

  const busy = () => {
    const id = sessionID()
    return id ? runtime().data.session.status(id) === "running" : false
  }
  const users = createMemo(() => {
    const id = sessionID()
    // Delivered user messages only (queued prompts are not messages yet), in creation order.
    return id ? userMessages(runtime().data.session.message.list(id), runtime().data.session.pending.list(id)) : []
  })

  async function send(modifier: boolean) {
    const id = sessionID()
    if (!id || !input || attachments.uploading()) return
    const parts = attachments.prepare(input.value)
    if (!parts.text.trim() && !parts.files.length) return
    const delivery = busy() ? busyDelivery(followUp.value(), modifier) : undefined
    input.value = ""
    attachments.clear()
    await runtime().data.session.prompt({
      sessionID: id,
      text: parts.text,
      files: parts.files,
      metadata: parts.metadata,
      delivery,
    })
  }

  // ---- window.__ops (Playwright) ----
  const ops = {
    ready: () => runtime().connection.status() === "connected" && runtime().own.state.status === "ready",
    async create(input: {
      title: string
      providerID: string
      model: string
      directory: string
      permissions?: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]
    }) {
      // Test sessions carry their permission rules from creation (e.g. `edit` allowed for the file-revert test).
      const info = await runtime()
        .client()
        .session.create({
          title: input.title,
          model: { providerID: input.providerID, id: input.model },
          location: { directory: input.directory },
          permissions: input.permissions,
        })
      runtime().data.session.remember(info)
      setCreated((list) => [...list, { id: info.id, title: input.title }])
      router.navigate({ name: "session", serverKey: LOCAL, sessionID: info.id })
      return info.id
    },
    open: (id: string) => router.navigate({ name: "session", serverKey: LOCAL, sessionID: id }),
    current: () => sessionID(),
    prompt: (text: string, delivery?: "steer" | "queue") =>
      runtime()
        .data.session.prompt({ sessionID: sessionID()!, text, delivery })
        .then((item) => item.id),
    interrupt: (id = sessionID()!) => runtime().client().session.interrupt({ sessionID: id }),
    /** Admits a manual compaction (queued behind the running turn) and returns its inbox id. */
    compact: (delivery: "steer" | "queue" = "queue") =>
      runtime()
        .client()
        .session.compact({ sessionID: sessionID()!, delivery })
        .then((item) => item.id),
    cancelInbox: (inboxID: string, id = sessionID()!) =>
      runtime().client().session.inbox.cancel({ sessionID: id, inboxID }),
    wait: (id = sessionID()!) => runtime().client().session.wait({ sessionID: id }),
    status: (id = sessionID()!) => runtime().data.session.status(id),
    pending: (id = sessionID()!) =>
      runtime()
        .data.session.pending.list(id)
        .map((item) => ({ id: item.id, type: item.type, delivery: item.delivery })),
    messages: (id = sessionID()!) =>
      runtime()
        .data.session.message.list(id)
        .map((message) => ({
          id: message.id,
          type: message.type,
          text: "text" in message ? message.text : "",
          files:
            message.type === "user" ? (message.files ?? []).map((file) => ({ name: file.name, mime: file.mime })) : [],
        })),
    revert: (id = sessionID()!) => runtime().data.session.get(id)?.revert,
    /** Tool calls of the session with their final state (diagnostics when a scripted tool misbehaves). */
    tools: (id = sessionID()!) =>
      runtime()
        .data.session.message.list(id)
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .flatMap((content) => (content.type === "tool" ? [{ name: content.name, state: content.state }] : [])),
    children: (id = sessionID()!) =>
      runtime()
        .data.session.family(id)
        .filter((item) => runtime().data.session.get(item)?.parentID === id),
    permissions: (id: string) => (runtime().data.session.permission.list(id) ?? []).map((item) => item.id),
    replyAll: async (id: string, decision: "once" | "reject" = "once") => {
      for (const request of runtime().data.session.permission.list(id) ?? [])
        await runtime().data.session.permission.reply({ sessionID: id, requestID: request.id, decision })
    },
    /** A pending switch (WAIT_SAFE) to another account while the session runs (02 §5.3). */
    async switchTo(providerID: string, model: string) {
      const id = sessionID()!
      const target = { providerID, id: model }
      const estimate = await runtime().rpc.call("switch.estimate", { sessionID: id, target })
      return runtime().rpc.call("switch.apply", {
        sessionID: id,
        estimateID: estimate.estimateID,
        target,
        strategy: "now",
        reason: "manual",
      })
    },
    switchState: (id = sessionID()!) => runtime().own.state.switchState[id]?.state,
    cancelSwitch: (id = sessionID()!) => runtime().rpc.call("switch.cancel", { sessionID: id }),
    /** Input modalities of the open session's model once the catalog is loaded (attachment routes depend on it). */
    modelInput: () => {
      const model = session()?.model
      return model ? modelInfo(runtime(), model, directory())?.capabilities.input : undefined
    },
    chips: () =>
      attachments.list().map((chip) => ({ name: chip.name, state: chip.state, route: chip.route, ready: chip.ready })),
    openRevert: (messageID: string) => openRevertDialog({ serverKey: LOCAL, sessionID: sessionID()!, messageID }),
    undo: () => commands.undo(LOCAL, sessionID()!),
    redo: () => commands.redo(LOCAL, sessionID()!),
    setFollowUp: (value: "steer" | "queue") => followUp.set(value),
  }
  Object.assign(window, { __ops: ops })

  return (
    <div class="ops" data-testid="ops">
      <aside class="ops-side">
        <For each={created()}>
          {(item) => (
            <button type="button" class="ops-session" data-testid="ops-session" onClick={() => ops.open(item.id)}>
              {item.title}
              <ChildRequestBadge serverKey={serverKey} sessionID={() => item.id} />
            </button>
          )}
        </For>
        <Show when={sessionID() && !child()}>
          <h3 class="ops-h">user messages</h3>
          <For each={users()}>
            {(message) => (
              <button
                type="button"
                class="ops-revert"
                data-testid="ops-revert"
                data-message-id={message.id}
                onClick={() => openRevertDialog({ serverKey: LOCAL, sessionID: sessionID()!, messageID: message.id })}
              >
                ↶ {message.type === "user" ? message.text.split("\n", 1)[0] : ""}
              </button>
            )}
          </For>
        </Show>
      </aside>
      <main class="ops-main" ref={main} data-testid="ops-main">
        <header class="ops-header" data-testid="ops-header">
          <Show when={child()} fallback={<b>{session()?.title ?? "—"}</b>}>
            <SubagentBreadcrumb serverKey={serverKey} sessionID={sessionID} />
          </Show>
          <span class="ops-status" data-testid="ops-status">
            {busy() ? "running" : "idle"}
          </span>
        </header>
        <div class="ops-transcript">
          <Transcript serverKey={serverKey} sessionID={sessionID} />
        </div>
        <div class="ops-bottom">
          <RevertBarSlot serverKey={serverKey} sessionID={sessionID} />
          <SubagentStrip serverKey={serverKey} sessionID={sessionID} />
          <QueuePanel queue={queue} onHeldCancel={(index) => setHeld((list) => list.filter((_, at) => at !== index))} />
          <Show when={!child()} fallback={<ChildSessionNotice serverKey={serverKey} sessionID={sessionID} />}>
            <div class="ops-composer">
              <AttachmentChips attachments={attachments} />
              <textarea
                ref={input}
                id="ops-input"
                data-testid="ops-input"
                rows={2}
                placeholder="메시지"
                onPaste={(event) => attachments.paste(event)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
                  event.preventDefault()
                  void send(event.ctrlKey || event.metaKey)
                }}
              />
              <div class="ops-bar">
                <AttachButton attachments={attachments} />
                <button
                  type="button"
                  data-testid="ops-send"
                  disabled={attachments.uploading()}
                  onClick={() => void send(false)}
                >
                  전송
                </button>
              </div>
            </div>
          </Show>
        </div>
      </main>
      <AttachmentDropzone attachments={attachments} target={() => main} enabled={() => !child()} />
      <RevertHost />
      <Toasts />
      <style>{HARNESS_CSS}</style>
    </div>
  )
}

const HARNESS_CSS = `
.ops { display: grid; grid-template-columns: 260px 1fr; height: 100vh; background: var(--own-bg); color: var(--own-text); font-family: var(--own-font-sans); }
.ops-side { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-right: 1px solid var(--own-border); overflow: auto; font-size: 12px; }
.ops-session, .ops-revert { display: flex; gap: 6px; align-items: center; text-align: left; padding: 4px 6px; border: 1px solid var(--own-border); border-radius: 6px; background: var(--own-bg-raised); cursor: pointer; }
.ops-h { margin: 8px 0 2px; font-size: 11px; color: var(--own-text-faint); }
.ops-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ops-header { display: flex; gap: 12px; align-items: center; height: 44px; padding: 0 16px; border-bottom: 1px solid var(--own-border); }
.ops-status { margin-left: auto; font-size: 11px; color: var(--own-text-faint); }
.ops-transcript { position: relative; display: flex; flex: 1; min-height: 0; }
.ops-bottom { padding: 8px 16px 12px; max-width: 800px; width: 100%; margin: 0 auto; }
.ops-composer { border: 1px solid var(--own-border-strong); border-radius: 12px; padding: 8px; background: var(--own-bg-raised); }
.ops-composer textarea { width: 100%; border: 0; resize: none; background: none; color: inherit; font: inherit; outline: none; }
.ops-bar { display: flex; gap: 8px; align-items: center; }
`

render(() => {
  const data = createDataLayer({ host })
  const router = createMemoryRouter("own.web.ops.harness.route")
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

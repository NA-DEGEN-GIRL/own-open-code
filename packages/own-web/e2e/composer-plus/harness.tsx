// Harness for the composer-plus e2e: the real providers (web host, i18n, data layer against the real server, memory
// router, shortcut registry, shell) and a composer wired to src/history, src/shellmode, src/skills and src/forking
// exactly as the integrator is asked to wire src/composer (report "wiring"): the text drafts of composer/drafts.ts
// swapped per session, `@`/`/` suggestions first, then the composer's IME machine, then ↑/↓ history, then shell mode
// keys; `!` consumed on input; sends recorded in the history; chips and attachments persisted per draft; the skills
// button, the running-shell chip, the compaction status and the fork host. Only what the tests read is on
// `window.__composerPlus`.
import "@/styles/index.css"
import "@/composer/composer.css"
import "@/switcher/switcher.css"
import { createEffect, createRoot, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { render } from "solid-js/web"
import {
  AttachButton,
  AttachmentChips,
  createAttachments,
  modelInput,
  onComposerRestore,
  restoredText,
  useAttachmentNotices,
  type ComposerRestoreDetail,
} from "@/attachments"
import { useCommandActions } from "@/commands"
import { createDrafts, draftKey } from "@/composer/drafts"
import { createComposerInput, type SubmitResult } from "@/composer/input"
import { busyDelivery } from "@/composer/send"
import { createDataLayer, DataProvider, LOCAL, useData, type ServerKey } from "@/data"
import { nextFrame } from "@/data/frame"
import { CompactionStatus, ForkHost, useForkCommands, useForkMenuItems } from "@/forking"
import { HistoryPosition, useComposerHistory, useDraftPersistence } from "@/history"
import { createHost, HostProvider, useHost } from "@/host"
import { createI18n, I18nProvider, useI18n } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider, useShortcut } from "@/keyboard"
import { createComposerSuggest, MentionChips, SuggestPopover, type ComposerSuggest } from "@/mentions"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import type { Route } from "@/routing/routes"
import { createShell, ShellProvider } from "@/shell/context"
import { createShellMode, shellAllowed, ShellModeHint, ShellRunChip, shellRuns, useShellModeText } from "@/shellmode"
import { SkillsButton } from "@/skills"
import { modelInfo } from "@/switcher/labels"
import { showToast, Toasts } from "@/switcher/toast"

interface Sent {
  readonly text: string
  readonly result: string
}

declare global {
  interface Window {
    __composerPlus?: {
      navigate(route: Route): void
      route(): Route
      chips(): unknown[]
      attachments(): { readonly name: string; readonly state: string; readonly route: string }[]
      sent: Sent[]
      ready(): boolean
      setScheme(scheme: "dark" | "light"): void
    }
  }
}

const host = await createHost()
// Owned roots, so the data layer's cleanups are registered (the page lives as long as the test).
const data = createRoot(() => createDataLayer({ host }))
const router = createRoot(() => createMemoryRouter("own.web.route.composer-plus"))
const drafts = createDrafts()

render(
  () => (
    <HostProvider value={host}>
      <I18nProvider value={createI18n("ko")}>
        <DataProvider value={data}>
          <RouterProvider value={router}>
            <ShortcutProvider value={createShortcutRegistry()}>
              <ShellProvider value={createShell({ windowKey: "composer-plus" })}>
                <Harness />
                <ForkHost />
                <Toasts />
              </ShellProvider>
            </ShortcutProvider>
          </RouterProvider>
        </DataProvider>
      </I18nProvider>
    </HostProvider>
  ),
  document.getElementById("root")!,
)

function Harness() {
  const data = useData()
  const router = useRouter()
  const route = () => router.route()
  const serverKey = (): ServerKey => {
    const current = route()
    return current.name === "session" || current.name === "project" ? current.serverKey : LOCAL
  }
  const sessionID = () => {
    const current = route()
    return current.name === "session" ? current.sessionID : undefined
  }
  createEffect(() => {
    const runtime = data.get(serverKey())
    const id = sessionID()
    if (!runtime || !id || runtime.connection.status() !== "connected") return
    untrack(() => {
      void runtime.data.session.sync(id).catch(() => undefined)
      void runtime.data.session.pending.sync(id).catch(() => undefined)
      void runtime.data.session.message.sync(id).catch(() => undefined)
    })
  })
  const sent: Sent[] = []
  let suggest: ComposerSuggest | undefined
  let attachmentList: () => { name: string; state: string; route: string }[] = () => []
  window.__composerPlus = {
    navigate: (next) => router.navigate(next),
    route,
    chips: () => [...(suggest?.chipList() ?? [])],
    attachments: () => attachmentList(),
    sent,
    ready: () => data.get(serverKey())?.connection.status() === "connected",
    setScheme: (scheme) => document.documentElement.setAttribute("data-color-scheme", scheme),
  }
  const menu = useForkMenuItems(serverKey, sessionID)
  return (
    <div style={{ "max-width": "760px", margin: "0 auto", padding: "16px" }}>
      <nav style={{ display: "flex", gap: "8px", "margin-bottom": "360px" }}>
        <For each={menu()}>
          {(item) => (
            <button
              type="button"
              class="own-cp-btn"
              data-testid={`menu-${item.id}`}
              disabled={item.disabled}
              onClick={() => item.run()}
            >
              {item.label}
            </button>
          )}
        </For>
      </nav>
      <ComposerPlus
        serverKey={serverKey}
        sessionID={sessionID}
        sent={sent}
        onSuggest={(value) => (suggest = value)}
        onAttachments={(list) => (attachmentList = list)}
      />
    </div>
  )
}

function ComposerPlus(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly sent: Sent[]
  readonly onSuggest: (suggest: ComposerSuggest) => void
  readonly onAttachments: (list: () => { name: string; state: string; route: string }[]) => void
}) {
  const data = useData()
  const router = useRouter()
  const i18n = useI18n()
  const hostContext = useHost()
  const shellText = useShellModeText()
  const [element, setElement] = createSignal<HTMLTextAreaElement>()
  const runtime = () => data.get(props.serverKey())
  const directory = () => {
    const current = runtime()
    const id = props.sessionID()
    if (!current || !id) return undefined
    return current.data.session.get(id)?.location.directory ?? current.sessions.directory(id)
  }
  const key = () => draftKey(props.serverKey(), props.sessionID())
  const busy = () => {
    const id = props.sessionID()
    return id ? runtime()?.data.session.status(id) === "running" : false
  }
  const child = () => {
    const id = props.sessionID()
    return id ? !!runtime()?.data.session.get(id)?.parentID : false
  }
  let sizing: (() => void) | undefined
  const resize = (textarea: HTMLTextAreaElement) => {
    sizing ??= nextFrame(() => {
      sizing = undefined
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, innerHeight * 0.4)}px`
    })
  }

  const attachments = createAttachments({
    host: hostContext,
    runtime,
    serverKey: props.serverKey,
    sessionID: props.sessionID,
    directory,
    input: () => {
      const current = runtime()
      const id = props.sessionID()
      const ref = current && id ? current.data.session.get(id)?.model : undefined
      const info = current && ref ? modelInfo(current, ref, directory()) : undefined
      return info ? modelInput(info.capabilities) : undefined
    },
    loadInput: () => {
      const current = runtime()
      const folder = directory()
      return current && folder !== undefined
        ? current.data.location.model.sync({ directory: folder })
        : Promise.resolve()
    },
    notify: useAttachmentNotices(),
  })
  props.onAttachments(() =>
    attachments.list().map((chip) => ({ name: chip.name, state: chip.state, route: chip.route })),
  )

  const restore = (text: string) => {
    const textarea = element()
    if (!textarea || input.composing() || textarea.value) return
    textarea.value = text
    changed(text)
  }
  const suggest = createComposerSuggest({
    element,
    draftKey: key,
    disabled: () => child() || shell.active(),
    context: () => {
      const current = runtime()
      return current
        ? { runtime: current, serverKey: props.serverKey(), sessionID: props.sessionID(), directory: directory() }
        : undefined
    },
    actions: useCommandActions({ restoreDraft: restore, overrides: useForkCommands() }),
  })
  props.onSuggest(suggest)

  const input = createComposerInput({
    element,
    submit: (text, modifier) => submit(text, modifier),
    busy,
    sendEmpty: () => attachments.list().length > 0,
    interrupt: () => {
      const id = props.sessionID()
      if (id) void runtime()?.client().session.interrupt({ sessionID: id })
    },
    cleared: () => {
      const textarea = element()
      if (textarea) resize(textarea)
      suggest.reset()
      shell.sync()
    },
  })
  /** The text changed without an `input` event. */
  const changed = (text: string) => {
    drafts.set(key(), text)
    const textarea = element()
    if (textarea) resize(textarea)
    suggest.reset()
    shell.sync()
  }
  const shell = createShellMode({
    element,
    draftKey: key,
    composing: input.composing,
    disabled: () => child() || !shellAllowed(runtime()),
    changed,
  })
  const history = useComposerHistory({
    element,
    composing: input.composing,
    mode: () => (shell.active() ? "shell" : "normal"),
    chips: suggest.chips,
    draftKey: key,
    changed,
  })
  useDraftPersistence({
    serverKey: props.serverKey,
    sessionID: props.sessionID,
    draftKey: key,
    element,
    chips: suggest.chips,
    attachments,
    text: drafts,
  })
  useShortcut("composer.shellMode", () => void shell.enter())
  useShortcut("composer.shellExit", () => shell.exit())

  // ---- text drafts per session (composer/index.tsx) ----
  let deferredLoad: string | undefined
  const load = (textarea: HTMLTextAreaElement, next: string) => {
    textarea.value = drafts.get(next)
    resize(textarea)
    suggest.reset()
    shell.sync()
  }
  createEffect(
    on(
      key,
      (next, previous) => {
        const textarea = element()
        if (!textarea) return
        if (previous !== undefined) {
          if (input.clearing()) drafts.delete(previous)
          else drafts.set(previous, textarea.value)
        }
        if (input.composing()) return void (deferredLoad = next)
        load(textarea, next)
      },
      { defer: true },
    ),
  )
  const applyRestore = (detail: ComposerRestoreDetail) => {
    const target = draftKey(detail.serverKey, detail.sessionID)
    const textarea = element()
    if (!textarea || target !== key()) return drafts.set(target, restoredText(drafts.get(target), detail))
    if (input.composing()) return
    textarea.value = restoredText(textarea.value, detail)
    changed(textarea.value)
  }
  onCleanup(onComposerRestore(applyRestore))
  onMount(() => {
    const textarea = element()
    if (textarea) load(textarea, key())
  })

  // ---- sending ----
  function submit(text: string, modifier: boolean): SubmitResult {
    const current = runtime()
    if (!current) return false
    const shellish = shell.active() || text.startsWith("!")
    const command = shell.command(text)
    if (shellish && command === undefined) return false
    if (command === undefined) {
      const chips = [...suggest.chipList()]
      const client = suggest.submitClient(text)
      if (client) {
        drafts.delete(key())
        history.record("normal", { text, chips })
        props.sent.push({ text, result: "client" })
        return client.after
      }
    }
    const id = props.sessionID()
    if (!id) return false
    if (command !== undefined) {
      const wasActive = shell.active()
      drafts.delete(key())
      history.record("shell", { text: command })
      shell.sent()
      void shellRuns(current)
        .run(id, command)
        .then((result) => {
          props.sent.push({ text, result: result.ok ? "shell" : "failed" })
          if (result.ok) return
          if (wasActive) shell.enter()
          restore(wasActive ? command : `!${command}`)
          showToast({ tone: "danger", message: shellText("own.shellmode.failed") })
        })
      return
    }
    if (attachments.uploading()) return false
    history.record("normal", { text, chips: [...suggest.chipList()] })
    const parts = attachments.list().length ? attachments.prepare(text) : undefined
    attachments.clear()
    drafts.delete(key())
    const delivery = busy() ? busyDelivery("steer", modifier) : undefined
    void suggest
      .send({ sessionID: id, text: parts?.text ?? text, delivery, draftKey: key(), attachments: parts })
      .then((result) => props.sent.push({ text, result }))
      .catch((error: unknown) => {
        console.error("[harness] send", error)
        props.sent.push({ text, result: "failed" })
        restore(text)
      })
  }

  const placeholder = () =>
    shell.visual() ? i18n.t("own.composer.placeholderShell") : i18n.t("own.composer.placeholder")

  return (
    <div class="own-cp">
      <div class="own-cp-inner">
        <div class="own-cp-box" data-shell={shell.visual() ? "" : undefined} data-testid="composer-box">
          <Show when={runtime() && props.sessionID()}>
            <ShellRunChip runtime={runtime()!} sessionID={props.sessionID()!} />
            <CompactionStatus runtime={runtime()!} sessionID={props.sessionID()!} />
          </Show>
          <AttachmentChips attachments={attachments} />
          <MentionChips suggest={suggest} />
          <SuggestPopover suggest={suggest} />
          <textarea
            id="own-composer-input"
            ref={setElement}
            data-own-keys="composer"
            rows={2}
            class="own-cp-text"
            placeholder={placeholder()}
            autocomplete="off"
            spellcheck={false}
            aria-autocomplete="list"
            aria-controls={suggest.visible() ? suggest.listbox : undefined}
            aria-activedescendant={suggest.activeDescendant()}
            onKeyDown={(event) => {
              if (suggest.keydown(event)) return
              if (input.keydown(event)) return
              if (history.keydown(event)) return
              shell.keydown(event)
            }}
            onKeyUp={(event) => {
              suggest.keyup(event)
              input.keyup(event)
            }}
            onCompositionStart={() => {
              input.compositionstart()
              suggest.compositionstart()
            }}
            onCompositionEnd={(event) => {
              input.compositionend()
              suggest.compositionend()
              if (deferredLoad !== undefined) {
                const next = deferredLoad
                deferredLoad = undefined
                const textarea = event.currentTarget
                nextFrame(() => load(textarea, next))
              }
            }}
            onInput={(event) => {
              input.input()
              shell.input(event)
              suggest.input()
              drafts.set(key(), event.currentTarget.value)
              resize(event.currentTarget)
            }}
            onPaste={(event) => attachments.paste(event)}
            onFocus={() => suggest.focus()}
            onBlur={() => suggest.blur()}
            onClick={() => suggest.click()}
          />
          <div class="own-cp-bar">
            <AttachButton attachments={attachments} />
            <SkillsButton
              runtime={runtime}
              sessionID={props.sessionID}
              directory={directory}
              addChip={suggest.addChip}
              disabled={() => shell.active() || child()}
            />
            <Show when={shell.visual()}>
              <span class="own-sw-tag own-cp-shell-tag" data-testid="shell-tag">
                {i18n.t("own.composer.shellMode")}
              </span>
            </Show>
            <span class="own-cp-grow" />
            <button
              type="button"
              class="own-cp-send"
              data-testid="composer-send"
              onClick={() => void input.sendNow(false)}
            >
              ↵ {i18n.t("own.composer.send")}
            </button>
          </div>
        </div>
        <HistoryPosition history={history} mode={() => (shell.active() ? "shell" : "normal")} />
        <ShellModeHint shell={shell} />
      </div>
    </div>
  )
}

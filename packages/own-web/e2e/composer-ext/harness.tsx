// Harness for the composer-ext e2e: the real providers (web host, i18n, data layer against the real server, memory
// router, shortcut registry, shell) and a composer textarea wired to src/mentions + src/commands exactly as the
// integrator is asked to wire src/composer (report "wiring requests"): suggestions get the keys first, the composer's
// own IME machine (`createComposerInput`) sends, `submitClient` before sending, `send` instead of
// `data.session.prompt`. Only what the tests read is exposed on `window.__harness`.
import "@/styles/index.css"
import "@/composer/composer.css"
import { createEffect, createSignal, untrack } from "solid-js"
import { render } from "solid-js/web"
import { useCommandActions } from "@/commands"
import { createComposerInput, type SubmitResult } from "@/composer/input"
import { busyDelivery } from "@/composer/send"
import { createDataLayer, DataProvider, LOCAL, useData, type ServerKey } from "@/data"
import { createHost, HostProvider } from "@/host"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { createComposerSuggest, MentionChips, SuggestPopover, type ComposerSuggest } from "@/mentions"
import { createMemoryRouter, RouterProvider, useRouter } from "@/routing/router"
import type { Route } from "@/routing/routes"
import { createShell, ShellProvider, useShell } from "@/shell/context"
import { switcherControl } from "@/switcher"
import { Toasts } from "@/switcher/toast"
import { newSessionDirectory } from "@/switcher/new-session"

interface Sent {
  readonly text: string
  readonly result: string
}

declare global {
  interface Window {
    __harness?: {
      navigate(route: Route): void
      route(): Route
      panel(): { readonly tab: string; readonly open: boolean }
      switcherOpen(): boolean
      chips(): unknown[]
      sent: Sent[]
      /** Handler time of every textarea event while suggestions are on (PF2-style: all events counted). */
      timings: number[]
      ready(): boolean
    }
  }
}

const host = await createHost()
const data = createDataLayer({ host })
const router = createMemoryRouter("own.web.route.composer-ext")
const root = document.getElementById("root")!

render(
  () => (
    <HostProvider value={host}>
      <I18nProvider value={createI18n("ko")}>
        <DataProvider value={data}>
          <RouterProvider value={router}>
            <ShortcutProvider value={createShortcutRegistry()}>
              <ShellProvider value={createShell({ windowKey: "composer-ext" })}>
                <Harness />
                <Toasts />
              </ShellProvider>
            </ShortcutProvider>
          </RouterProvider>
        </DataProvider>
      </I18nProvider>
    </HostProvider>
  ),
  root,
)

function Harness() {
  const data = useData()
  const router = useRouter()
  const shell = useShell()
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
    untrack(() => void runtime.data.session.sync(id).catch(() => undefined))
  })
  const sent: Sent[] = []
  const timings: number[] = []
  let suggest: ComposerSuggest | undefined
  window.__harness = {
    navigate: (next) => router.navigate(next),
    route,
    panel: () => ({ tab: shell.tab(), open: shell.panelOpen() }),
    switcherOpen: () => !!switcherControl.state.open,
    chips: () => [...(suggest?.chipList() ?? [])],
    sent,
    timings,
    ready: () => data.get(serverKey())?.connection.status() === "connected",
  }
  return (
    <ComposerExt
      serverKey={serverKey}
      sessionID={sessionID}
      onSuggest={(value) => (suggest = value)}
      sent={sent}
      timings={timings}
    />
  )
}

function ComposerExt(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly onSuggest: (suggest: ComposerSuggest) => void
  readonly sent: Sent[]
  readonly timings: number[]
}) {
  const data = useData()
  const router = useRouter()
  const [element, setElement] = createSignal<HTMLTextAreaElement>()
  const runtime = () => data.get(props.serverKey())
  const directory = () => {
    const current = runtime()
    const id = props.sessionID()
    if (!current) return undefined
    if (!id) return newSessionDirectory(current, router.route())
    return current.data.session.get(id)?.location.directory ?? current.sessions.directory(id)
  }
  const key = () => `${props.serverKey()}/${props.sessionID() ?? "home"}`
  const busy = () => {
    const id = props.sessionID()
    return id ? runtime()?.data.session.status(id) === "running" : false
  }
  const restore = (text: string) => {
    const textarea = element()
    if (!textarea || textarea.value) return
    textarea.value = text
  }
  const suggest = createComposerSuggest({
    element,
    context: () => {
      const current = runtime()
      return current
        ? { runtime: current, serverKey: props.serverKey(), sessionID: props.sessionID(), directory: directory() }
        : undefined
    },
    draftKey: key,
    actions: useCommandActions({ restoreDraft: restore }),
  })
  props.onSuggest(suggest)

  const input = createComposerInput({
    element,
    submit: (text, modifier) => submit(text, modifier),
    busy,
    // The next-frame clear after a send has no `input` event: the suggestions look again.
    cleared: () => suggest.reset(),
    interrupt: () => {
      const id = props.sessionID()
      if (id) void runtime()?.client().session.interrupt({ sessionID: id })
    },
  })

  function submit(text: string, modifier: boolean): SubmitResult {
    const client = suggest.submitClient(text)
    if (client) {
      props.sent.push({ text, result: "client" })
      return client.after
    }
    const id = props.sessionID()
    if (!id) return false
    const delivery = busy() ? busyDelivery("steer", modifier) : undefined
    void suggest
      .send({ sessionID: id, text, delivery, draftKey: key() })
      .then((result) => props.sent.push({ text, result }))
      .catch((error: unknown) => {
        console.error("[harness] send", error)
        props.sent.push({ text, result: "failed" })
        restore(text)
      })
  }

  const timed = (run: () => void) => {
    const started = performance.now()
    run()
    props.timings.push(performance.now() - started)
  }

  return (
    <div class="own-cp" style={{ "margin-top": "420px" }}>
      <div class="own-cp-inner">
        <div class="own-cp-box">
          <MentionChips suggest={suggest} />
          <SuggestPopover suggest={suggest} />
          <textarea
            id="own-composer-input"
            ref={setElement}
            data-own-keys="composer"
            rows={2}
            class="own-cp-text"
            aria-autocomplete="list"
            aria-controls={suggest.visible() ? suggest.listbox : undefined}
            aria-activedescendant={suggest.activeDescendant()}
            onKeyDown={(event) =>
              timed(() => {
                if (suggest.keydown(event)) return
                input.keydown(event)
              })
            }
            onKeyUp={(event) => {
              suggest.keyup(event)
              input.keyup(event)
            }}
            onCompositionStart={() =>
              timed(() => {
                input.compositionstart()
                suggest.compositionstart()
              })
            }
            onCompositionEnd={() =>
              timed(() => {
                input.compositionend()
                suggest.compositionend()
              })
            }
            onInput={() =>
              timed(() => {
                input.input()
                suggest.input()
              })
            }
            onFocus={() => suggest.focus()}
            onBlur={() => suggest.blur()}
            onClick={() => suggest.click()}
          />
        </div>
      </div>
    </div>
  )
}

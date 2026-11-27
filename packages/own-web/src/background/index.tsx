// Background jobs module entry (03 §19.7, [gap] 23; 01 §17.1 #23: `session.background`, `shell.*`):
//   - `BackgroundDock`: the dock row above the composer (03 §4.6 order: 권한 → 질문·폼 → 대기열 → 백그라운드).
//       `● 실행 중: bun test … [백그라운드로 Alt+B]` while the step runs a shell or subagent tool (what
//       `POST /api/session/:id/background` would move), and `⧗ 백그라운드 2 · …` with the list (lazy): each job's
//       `출력 보기` (터미널처럼, lazy viewer) or `열기 →` (subagent), and `종료`.
//       Registers `composer.background` (Alt+B, composer scope; Ctrl+B stays the sidebar, 03 §10 [gap] 32).
//   - `SendToBackgroundButton`: `백그라운드로` for a running shell/subagent tool card (03 §4.5).
//   - `BackgroundHost`: mount once; the finish toast/OS notification (03 §9) and the output viewer.
//   - `backgroundCount`: jobs of an idle session, for the sidebar's `⧗` (03 §7.6).
//   - `RunningMenu`: `작업 중 n ▾` in the session header, the running subagents and background shells to open or stop
//     (03 §4.4, running-menu.tsx).
//
// Wiring (integrator): composer dock stack `<RequestDocks/> <QueuePanel/> <BackgroundDock serverKey sessionID/>`;
// shell: `<BackgroundHost />` once (next to RevertHost); transcript tool cards: `<SendToBackgroundButton>` on running
// `shell`/`subagent` parts; sidebar row status: `⧗` when `backgroundCount(runtime, id) > 0` (priority 7.6).
// Strings: `./strings` (first chunk, exported here) and `./view-strings` (list + viewer, lazy; import it directly).
//
// Own modules that run commands through `shell.create` with a session id (19.2 git writes) set `metadata.source`
// so their shells are not listed as the session's background jobs and get no finish toast (model.ts isSessionShell).
import { createEffect, createRoot, createSignal, lazy, on, Show, Suspense } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { chordLabel, DEFAULT_KEYMAP, useShortcut } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { createBackground, requestBackground } from "./data"
import { openShellOutput, OutputHost } from "./host"
import { shortLabel } from "./model"
import { createBackgroundNotifier, type BackgroundDone } from "./notify"
import { backgroundText, useBackgroundText } from "./strings"
import "./dock.css"

export { backgroundCount, createBackground, requestBackground, type Background } from "./data"
export { closeShellOutput, openShellOutput, shellOutputOpen, type OutputRequest } from "./host"
export type { BackgroundDone } from "./notify"
export { collectTasks, scanHistory, type BackgroundTask, type BlockingTool } from "./model"
export { RunningMenu } from "./running-menu"
export { backgroundEn, backgroundKo, backgroundText, useBackgroundText, type BackgroundKey } from "./strings"

const Panel = lazy(() => import("./panel"))

const listRequests = createRoot(() => {
  const [count, setCount] = createSignal(0)
  return { count, bump: () => setCount((value) => value + 1) }
})

/** Opens the `⧗ 백그라운드` list of the session on screen (palette `background.list`); nothing without jobs. */
export function openBackgroundList() {
  listRequests.bump()
}

const SEND_KEY = () => chordLabel(DEFAULT_KEYMAP["composer.background"].chords[0])

export interface BackgroundDockProps {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}

/** `session.background` until the tool left the foreground (`requestBackground`); failures become a toast. */
async function sendToBackground(run: () => Promise<void>, reason: (error: unknown) => string) {
  try {
    await run()
  } catch (error) {
    showToast({ tone: "danger", message: reason(error) })
  }
}

export function BackgroundDock(props: BackgroundDockProps) {
  const data = useData()
  const text = useBackgroundText()
  const background = createBackground({
    runtime: () => data.get(props.serverKey()),
    serverKey: props.serverKey,
    sessionID: props.sessionID,
  })
  const [open, setOpen] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const count = () => background.tasks().length
  const blocking = () => background.blocking()
  const canSend = () => blocking().length > 0 && background.canAct() && !sending()

  createEffect(on(props.sessionID, () => setOpen(false), { defer: true }))
  createEffect(() => count() === 0 && setOpen(false))
  createEffect(on(listRequests.count, () => count() > 0 && setOpen(true), { defer: true }))

  async function send() {
    const current = background.target()
    if (!current || !canSend()) return
    setSending(true)
    await sendToBackground(background.send, (error) =>
      text("own.background.sendFailed", { reason: error instanceof Error ? error.message : String(error) }),
    )
    setSending(false)
  }

  // Alt+B in the composer (03 §10: only while a shell or subagent runs; otherwise the key passes through).
  useShortcut(
    "composer.background",
    () => {
      if (!canSend()) return false
      void send()
    },
    { when: canSend },
  )

  const summary = () =>
    background
      .tasks()
      .slice(0, 2)
      .map((task) => shortLabel(task.label, 28))
      .join(", ") + (count() > 2 ? ` · ${text("own.background.more", { n: count() - 2 })}` : "")

  return (
    <Show when={background.target() && (count() > 0 || blocking().length > 0)}>
      <section class="own-bj" aria-label={text("own.background.list")} data-testid="background-dock">
        <Show when={blocking().length > 0}>
          <div class="own-bj-row" data-testid="background-blocking">
            <span class="own-run-mark" aria-hidden="true" />
            <span class="own-bj-row-text" title={blocking()[0]?.label}>
              {text("own.background.running", {
                label: shortLabel(blocking()[0]?.label ?? text("own.background.kind.shell"), 48),
              })}
            </span>
            <Show when={background.canAct()}>
              <button
                type="button"
                class="own-bj-send"
                data-testid="background-send"
                title={text("own.background.sendTitle", { key: SEND_KEY() })}
                disabled={sending()}
                onClick={() => void send()}
              >
                {text("own.background.send")} <kbd class="own-bj-kbd">{SEND_KEY()}</kbd>
              </button>
            </Show>
          </div>
        </Show>
        <Show when={count() > 0}>
          <div class="own-bj-row">
            <button
              type="button"
              class="own-bj-toggle"
              aria-expanded={open()}
              aria-label={`${text("own.background.rowLabel", { n: count() })} — ${
                open() ? text("own.background.hide") : text("own.background.show")
              }`}
              data-testid="background-toggle"
              onClick={() => setOpen((value) => !value)}
            >
              <span aria-hidden="true">⧗</span> {text("own.background.row", { n: count() })}
            </button>
            <span class="own-bj-row-text own-bj-summary" title={summary()}>
              {summary()}
            </span>
            <span class="own-bj-caret" aria-hidden="true">
              {open() ? "▴" : "▾"}
            </span>
          </div>
          <Show when={open()}>
            <Suspense>
              <Panel background={background} serverKey={props.serverKey()} id={background.target()!.id} />
            </Suspense>
          </Show>
        </Show>
      </section>
    </Show>
  )
}

/**
 * `백그라운드로` on a running shell/subagent tool card (03 §4.5); the transcript shows it on running parts only and
 * passes `running` (the part's state is still `running`) so an early click is repeated until it took.
 */
export function SendToBackgroundButton(props: {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly running?: () => boolean
}) {
  const data = useData()
  const text = useBackgroundText()
  const [busy, setBusy] = createSignal(false)
  const runtime = () => data.get(props.serverKey)
  return (
    <Show when={runtime()?.rpc.can("prompt")}>
      <button
        type="button"
        class="own-bj-send"
        data-testid="tool-background"
        title={text("own.background.sendTitle", { key: SEND_KEY() })}
        disabled={busy()}
        onClick={async (event) => {
          event.stopPropagation()
          const current = runtime()
          if (!current) return
          setBusy(true)
          await sendToBackground(
            () => requestBackground(current, props.sessionID, () => props.running?.() ?? false),
            (error) =>
              text("own.background.sendFailed", { reason: error instanceof Error ? error.message : String(error) }),
          )
          setBusy(false)
        }}
      >
        {text("own.background.send")}
      </button>
    </Show>
  )
}

/** Mount once in the shell: the finish toast / OS notification (03 §9) and the output viewer host. */
export function BackgroundHost(props: { readonly onDone?: (item: BackgroundDone) => void }) {
  const data = useData()
  const host = useHost()
  const router = useRouter()
  const i18n = useI18n()
  createBackgroundNotifier({
    data,
    capability: host.capabilities.osNotifications,
    notify: host.notify ? (input) => host.notify?.(input) : undefined,
    hidden: () => document.visibilityState === "hidden",
    locale: i18n.locale,
    text: backgroundText.text,
    toast: showToast,
    openOutput: openShellOutput,
    onDone: (item) => props.onDone?.(item),
    openSession: (serverKey, sessionID) => {
      host.window?.show()
      router.navigate({ name: "session", serverKey, sessionID })
    },
  })
  return <OutputHost />
}

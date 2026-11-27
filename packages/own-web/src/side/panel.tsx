// The side panel (곁질문, 03 §4.4.2, lazy chunk): one side thread of a conversation, its answers streamed and rendered
// like the transcript, a follow-up box, `복사`, `대화에 넣기` and `멈추기`, and the conversation's earlier side threads.
// It sits beside the conversation (a sheet on a phone), so the composer keeps its draft, its queue and its steer, and
// the main run goes on. Everything is the service's (own.accounts `side.*`, 02 §9.7): the panel asks, follows the
// `side.delta` / `side.ended` events and reads the thread again after a missed event or a reconnect.
import type { OwnAccounts } from "@own/protocol"
import { Side } from "@own/protocol/side"
import { createSignal, createUniqueId, For, lazy, Match, onCleanup, onMount, Show, Suspense, Switch } from "solid-js"
import { useData } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { commitComposition, createImeEnter, isImeKey } from "@/ime/ime-enter"
import { copyText } from "@/ideas/actions"
import { eventCode } from "@/keyboard/chord"
import { Spinner } from "@/limits/kit"
import { showToast } from "@/switcher/toast"
import { formatTokens } from "@/transcript/format"
import type { OpenSideDetail } from "./intents"
import {
  applyDelta,
  applyEnded,
  askError,
  cachedShare,
  costText,
  insertText,
  running,
  type Thread,
  type Turn,
} from "./model"
import { useSideText } from "./strings"
import "./side.css"

const Markdown = lazy(() => import("@/adapter/side-markdown"))

type Summary = OwnAccounts.SideSummary

export default function SidePanel(props: { readonly detail: OpenSideDetail; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = useSideText()
  const heading = createUniqueId()
  const runtime = () => data.get(props.detail.serverKey)
  const sessionID = props.detail.sessionID
  const [thread, setThread] = createSignal<Thread>()
  const [threads, setThreads] = createSignal<readonly Summary[]>()
  const [view, setView] = createSignal<"thread" | "history">("thread")
  const [problem, setProblem] = createSignal<string>()
  const [asking, setAsking] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const opener = document.activeElement
  let area!: HTMLTextAreaElement

  const fail = (error: unknown) => {
    const shown =
      error instanceof OwnRpcError
        ? askError(error, Side.TURNS_MAX)
        : askError({ type: "other", message: error instanceof Error ? error.message : String(error) }, Side.TURNS_MAX)
    setProblem(text(shown.key, shown.params))
  }

  const reload = async (id: string) => {
    const current = runtime()
    if (!current) return
    const output = await current.rpc.call("side.get", { sessionID, threadID: id }).catch((error: unknown) => {
      fail(error)
      return undefined
    })
    if (output && thread()?.id === id) setThread(output.thread)
  }

  const list = async () => {
    const current = runtime()
    if (!current) return
    const output = await current.rpc.call("side.list", { sessionID }).catch((error: unknown) => {
      fail(error)
      return undefined
    })
    if (output) setThreads(output.threads)
  }

  const ask = async (question: string, fresh: boolean) => {
    const current = runtime()
    const trimmed = question.trim()
    if (!current || !trimmed || asking()) return
    const shown = thread()
    const follow = !fresh && shown && !running(shown) && shown.turns.length < Side.TURNS_MAX ? shown.id : undefined
    setAsking(true)
    setProblem(undefined)
    const output = await current.rpc
      .call("side.ask", { sessionID, question: trimmed, ...(follow ? { threadID: follow } : {}) })
      .catch((error: unknown) => {
        fail(error)
        return undefined
      })
    setAsking(false)
    if (!output) return
    setThread(output.thread)
    setView("thread")
    setDraft("")
    area.value = ""
  }

  const submit = () => void commitComposition(area, ime.composing()).then(() => ask(area.value, false))
  const ime = createImeEnter({ onEnter: submit })

  const stop = () => {
    const current = runtime()
    const shown = thread()
    if (current && shown) void current.rpc.call("side.cancel", { sessionID, threadID: shown.id }).catch(fail)
  }

  const insert = (turn: Turn) => {
    const current = runtime()
    if (!current) return
    // `queue`: it waits for the current work instead of steering it; an idle conversation takes it at once.
    void current.data.session
      .prompt({ sessionID, text: insertText(turn, i18n.locale()), delivery: "queue" })
      .then(
        () => showToast({ message: text("own.side.inserted") }),
        (error: unknown) =>
          showToast({ message: text("own.side.insertFailed", { reason: error instanceof Error ? error.message : String(error) }) }),
      )
  }

  const remove = (id: string) => {
    const current = runtime()
    if (!current) return
    void current.rpc
      .call("side.remove", { sessionID, threadID: id })
      .then(() => {
        if (thread()?.id === id) setThread(undefined)
        return list()
      })
      .catch(fail)
  }

  onMount(() => {
    const current = runtime()
    if (current) {
      const stops = [
        current.own.on("side.delta", (event) => {
          const shown = thread()
          if (event.data.sessionID !== sessionID || shown?.id !== event.data.threadID) return
          const next = applyDelta(shown, event.data)
          if (next === "gap") return void reload(shown.id)
          setThread(next)
        }),
        current.own.on("side.ended", (event) => {
          if (event.data.sessionID !== sessionID) return
          const shown = thread()
          if (threads()) void list()
          if (shown?.id !== event.data.threadID) return
          const next = applyEnded(shown, event.data)
          if (next === "gap") return void reload(shown.id)
          setThread(next)
        }),
        current.bus.listen((event) => {
          const shown = thread()
          if (event.type === "server.connected" && shown) void reload(shown.id)
        }),
      ]
      onCleanup(() => stops.forEach((stop) => stop()))
    }
    if (props.detail.question) void ask(props.detail.question, true)
    if (writable()) area.focus({ preventScroll: true })
  })
  onCleanup(() => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
  })

  const writable = () => !!runtime()?.rpc.allowed("side.ask")
  const usage = (turn: Turn) => {
    const tokens = turn.tokens
    if (!tokens) return undefined
    const share = cachedShare(tokens)
    const line = text("own.side.usage", {
      input: formatTokens(tokens.input + tokens.cacheRead + tokens.cacheWrite),
      share: share === undefined ? "—" : `${Math.round(share * 100)}%`,
      output: formatTokens(tokens.output + tokens.reasoning),
    })
    const cost = turn.cost
    if (!cost) return line
    return text("own.side.usageCost", { usage: line, cost: costText(cost) })
  }

  return (
    <section
      class="own-side"
      role="dialog"
      aria-labelledby={heading}
      data-testid="side-panel"
      onKeyDown={(event) => {
        if (eventCode(event) !== "Escape" || isImeKey(event)) return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
    >
      <header class="own-side-head">
        <b id={heading}>{text("own.side.title")}</b>
        <span class="own-side-faint">{text("own.side.where")}</span>
        <button
          type="button"
          class="own-btn own-side-tab"
          data-testid="side-history"
          aria-pressed={view() === "history"}
          onClick={() => {
            if (view() === "history") return setView("thread")
            setView("history")
            void list()
          }}
        >
          {view() === "history" ? text("own.side.back") : text("own.side.history")}
        </button>
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.side.close")}
          data-testid="side-close"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </header>
      <div class="own-side-body">
        <Switch>
          <Match when={view() === "history"}>
            <Show when={threads()} fallback={<p class="own-side-faint">{text("own.side.loading")}</p>}>
              {(rows) => (
                <Show when={rows().length > 0} fallback={<p class="own-side-faint">{text("own.side.historyEmpty")}</p>}>
                  <ul class="own-side-list" data-testid="side-list">
                    <For each={rows()}>
                      {(row) => (
                        <li class="own-side-row">
                          <button
                            type="button"
                            class="own-side-open"
                            data-testid="side-list-open"
                            onClick={() => {
                              setView("thread")
                              setThread(undefined)
                              setProblem(undefined)
                              void runtime()
                                ?.rpc.call("side.get", { sessionID, threadID: row.id })
                                .then((output) => setThread(output.thread))
                                .catch(fail)
                            }}
                          >
                            <span class="own-side-q">{row.question}</span>
                            <span class="own-side-faint">
                              {text(`own.side.status.${row.status}`)} · {new Date(row.updatedAt).toLocaleString(i18n.locale())}
                            </span>
                          </button>
                          <Show when={writable()}>
                            <button
                              type="button"
                              class="own-icon-button"
                              aria-label={text("own.side.remove")}
                              title={text("own.side.remove")}
                              data-testid="side-list-remove"
                              onClick={() => remove(row.id)}
                            >
                              ×
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </Show>
          </Match>
          <Match when={view() === "thread"}>
            <For each={thread()?.turns ?? []}>
              {(turn, index) => (
                <article class="own-side-turn" data-status={turn.status} data-testid="side-turn">
                  <p class="own-side-question">{turn.question}</p>
                  <Show
                    when={turn.answer}
                    fallback={
                      <p class="own-side-faint">
                        <Show when={turn.status === "running"} fallback={text("own.side.empty")}>
                          <Spinner /> {text("own.side.answering")}
                        </Show>
                      </p>
                    }
                  >
                    <div class="own-side-answer" data-testid="side-answer">
                      <Suspense fallback={<pre class="own-side-plain">{turn.answer}</pre>}>
                        <Markdown
                          text={turn.answer}
                          cacheKey={`${thread()?.id}:${index()}`}
                          streaming={turn.status === "running"}
                        />
                      </Suspense>
                    </div>
                  </Show>
                  <Show when={turn.finish === "tool-calls"}>
                    <p class="own-side-note">{text("own.side.toolStop")}</p>
                  </Show>
                  <Show when={turn.status === "cancelled"}>
                    <p class="own-side-note">{text("own.side.stopped")}</p>
                  </Show>
                  <Show when={turn.error}>
                    <p class="own-side-note" data-tone="danger" role="alert">
                      {turn.error}
                    </p>
                  </Show>
                  <footer class="own-side-turn-foot">
                    <span class="own-side-faint" data-testid="side-usage">
                      {usage(turn)}
                    </span>
                    <Show when={turn.status === "running"}>
                      <button type="button" class="own-btn" data-testid="side-stop" onClick={stop}>
                        {text("own.side.stop")}
                      </button>
                    </Show>
                    <Show when={turn.status !== "running" && turn.answer}>
                      <button
                        type="button"
                        class="own-btn"
                        data-testid="side-copy"
                        onClick={() =>
                          void copyText(turn.answer).then((ok) =>
                            showToast({ message: text(ok ? "own.side.copied" : "own.side.copyFailed") }),
                          )
                        }
                      >
                        {text("own.side.copy")}
                      </button>
                      <Show when={runtime()?.rpc.can("prompt")}>
                        <button
                          type="button"
                          class="own-btn"
                          title={text("own.side.insertHint")}
                          data-testid="side-insert"
                          onClick={() => insert(turn)}
                        >
                          {text("own.side.insert")}
                        </button>
                      </Show>
                    </Show>
                  </footer>
                </article>
              )}
            </For>
          </Match>
        </Switch>
        <Show when={problem()}>
          <p class="own-side-note" data-tone="danger" role="alert" data-testid="side-problem">
            {problem()}
          </p>
        </Show>
      </div>
      <Show when={writable()} fallback={<p class="own-side-note">{text("own.side.error.scope")}</p>}>
        <div class="own-side-form">
          <textarea
            ref={area}
            class="own-side-field"
            rows={2}
            maxLength={Side.QUESTION_MAX}
            aria-label={text("own.side.title")}
            placeholder={thread() ? text("own.side.placeholderMore") : text("own.side.placeholder")}
            data-testid="side-input"
            onInput={(event) => {
              ime.input()
              setDraft(event.currentTarget.value)
            }}
            onKeyDown={ime.listeners.onKeyDown}
            onKeyUp={ime.listeners.onKeyUp}
            onCompositionStart={ime.listeners.onCompositionStart}
            onCompositionEnd={ime.listeners.onCompositionEnd}
          />
          <div class="own-side-form-row">
            <span class="own-side-faint own-side-hint">{text("own.side.hint")}</span>
            <Show when={thread()}>
              <button
                type="button"
                class="own-btn"
                data-testid="side-new"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (draft().trim()) return void commitComposition(area, ime.composing()).then(() => ask(area.value, true))
                  setThread(undefined)
                  setProblem(undefined)
                  area.focus()
                }}
              >
                {text("own.side.new")}
              </button>
            </Show>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              data-testid="side-ask"
              disabled={asking() || !draft().trim()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={submit}
            >
              <Show when={asking()} fallback={text("own.side.ask")}>
                <Spinner /> {text("own.side.asking")}
              </Show>
            </button>
          </div>
        </div>
      </Show>
    </section>
  )
}

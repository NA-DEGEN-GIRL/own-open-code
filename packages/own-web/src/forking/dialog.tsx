// `메시지에서 포크` dialog (03 §19.12), a lazy chunk. Lists the session's user messages newest first (upstream
// `session/commands/fork-dialog.tsx`, re-written): the chosen message becomes the fork boundary (`fork{before}` copies
// everything before it) and goes into the new session's composer to be edited and sent. `전체 복제` forks the whole
// history. The notes say why a fork is cheap (it inherits the cache key, 02 §5.9(e)) with the cache state now.
//
// Keyboard: the search box keeps focus; ↑/↓ choose, Enter forks (the Enter that commits a Korean composition only
// commits, like the palette, 03 §12 rule 8 exception), Esc closes. Focus is trapped and returned (11장).
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { createImeEnter, isImeKey } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import { useRouter } from "@/routing/router"
import { cacheText, slotOf } from "@/switcher/labels"
import { currentRef } from "@/switcher/session"
import { showToast } from "@/switcher/toast"
import { forkSession } from "./fork"
import type { ForkRequest } from "./host"
import { filterMessages, forkableMessages, type ForkableMessage } from "./model"
import { useForkText } from "./strings"
import "./forking.css"

/** Rows drawn at once; searching reaches the rest. */
const VISIBLE = 200
/**
 * The smallest first page the data layer loads (SSH servers: 10 messages). The server hands out a cursor even at the
 * end of the history, so a shorter list is known to be complete and gets no `이전 메시지 더 불러오기`.
 */
const SMALLEST_PAGE = 10

export default function ForkDialog(props: { readonly request: ForkRequest; readonly onClose: () => void }) {
  const i18n = useI18n()
  const text = useForkText()
  const data = useData()
  const router = useRouter()
  const runtime = () => data.get(props.request.serverKey)
  const sessionID = props.request.sessionID
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal<string | undefined>(props.request.messageID)
  const [working, setWorking] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  /** A load that brought nothing: the history is complete. */
  const [exhausted, setExhausted] = createSignal(false)

  const all = createMemo(() => {
    const current = runtime()
    if (!current) return []
    return forkableMessages(current.data.session.message.list(sessionID), current.data.session.pending.list(sessionID))
  })
  const matches = createMemo(() => filterMessages(all(), query()))
  const shown = createMemo(() => matches().slice(0, VISIBLE))
  const active = createMemo(() => {
    const id = chosen()
    return shown().find((message) => message.id === id) ?? shown()[0]
  })
  const busy = () => runtime()?.data.session.status(sessionID) === "running"
  /** A fork creates a session: devices without the `prompt` scope may look but not fork. */
  const allowed = () => runtime()?.rpc.can("prompt") ?? false
  const more = () => {
    const current = runtime()
    if (!current || exhausted() || !current.data.session.message.more(sessionID)) return false
    return current.data.session.message.list(sessionID).length >= SMALLEST_PAGE
  }
  const cache = () => {
    const current = runtime()
    if (!current) return undefined
    const model = currentRef(current, sessionID)
    const snapshot = current.own.state.cache[sessionID]
    if (!model || !snapshot) return undefined
    return cacheText(
      i18n,
      slotOf(snapshot, model.providerID, current.own.state.binding[sessionID]?.accountID),
      snapshot.now,
    )
  }
  const formatter = new Intl.DateTimeFormat(i18n.locale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })

  let dialog: HTMLDivElement | undefined
  let search: HTMLInputElement | undefined
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => {
    search?.focus()
    const id = props.request.messageID
    if (id) requestAnimationFrame(() => document.getElementById(optionID(id))?.scrollIntoView({ block: "nearest" }))
    const current = runtime()
    // The transcript normally loaded the open session's messages; a dialog opened from elsewhere loads them here.
    if (current && !current.data.session.message.list(sessionID).length)
      void current.data.session.message.sync(sessionID).catch(() => undefined)
  })
  onCleanup(() => returnTo?.isConnected && returnTo.focus())

  async function fork(message: ForkableMessage | undefined) {
    const current = runtime()
    if (!current || working() || !allowed() || (message && message.pending)) return
    setWorking(true)
    const outcome = await forkSession({
      runtime: current,
      serverKey: props.request.serverKey,
      sessionID,
      before: message?.id,
    })
    setWorking(false)
    if (!outcome.ok) return showToast({ tone: "danger", message: text("own.fork.failed", { reason: outcome.reason }) })
    showToast({ message: text("own.fork.done") })
    props.onClose()
    router.navigate({ name: "session", serverKey: props.request.serverKey, sessionID: outcome.session.id })
    requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
  }

  async function loadMore() {
    const current = runtime()
    if (!current || loadingMore()) return
    setLoadingMore(true)
    const before = current.data.session.message.list(sessionID).length
    await current.data.session.message.loadMore(sessionID).catch(() => undefined)
    if (current.data.session.message.list(sessionID).length === before) setExhausted(true)
    setLoadingMore(false)
  }

  const enter = createImeEnter({ commitOnly: true, onEnter: () => void fork(active()) })

  function keydown(event: KeyboardEvent) {
    if (event.target === search && enter.keydown(event)) return
    if (isImeKey(event, enter.composing())) return
    const code = eventCode(event)
    if (code === "Tab" && dialog) return trapTab(event, dialog)
    if (event.target !== search || (code !== "ArrowDown" && code !== "ArrowUp")) return
    const list = shown()
    if (!list.length) return
    event.preventDefault()
    const index = list.findIndex((message) => message.id === active()?.id)
    const next = list[(index + (code === "ArrowDown" ? 1 : -1) + list.length) % list.length]!
    setChosen(next.id)
    document.getElementById(optionID(next.id))?.scrollIntoView({ block: "nearest" })
  }

  // Esc works wherever focus is (11장), never while composing.
  const escape = (event: KeyboardEvent) => {
    if (eventCode(event) !== "Escape" || isImeKey(event, enter.composing())) return
    event.stopPropagation()
    if (!working()) props.onClose()
  }
  document.addEventListener("keydown", escape, true)
  onCleanup(() => document.removeEventListener("keydown", escape, true))

  return (
    <Portal>
      <div class="own-fk-scrim" onClick={() => !working() && props.onClose()} />
      <div
        ref={dialog}
        class="own-fk-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-fk-title"
        aria-describedby="own-fk-body"
        data-testid="fork-dialog"
        onKeyDown={keydown}
      >
        <h2 id="own-fk-title" class="own-fk-title">
          ⑂ {text("own.fork.title")}
        </h2>
        <p id="own-fk-body" class="own-fk-body">
          {text("own.fork.body")}
        </p>
        <input
          ref={search}
          class="own-fk-search"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="own-fk-list"
          aria-activedescendant={active() ? optionID(active()!.id) : undefined}
          aria-label={text("own.fork.search")}
          placeholder={text("own.fork.search")}
          autocomplete="off"
          spellcheck={false}
          data-testid="fork-search"
          onKeyUp={(event) => enter.keyup(event)}
          onCompositionStart={() => enter.compositionstart()}
          onCompositionEnd={() => enter.compositionend()}
          onInput={(event) => {
            enter.input()
            setQuery(event.currentTarget.value)
          }}
        />
        <Show
          when={shown().length}
          fallback={
            <p class="own-fk-state" data-testid="fork-empty">
              {all().length ? text("own.fork.noMatch") : text("own.fork.empty")}
            </p>
          }
        >
          <ul id="own-fk-list" class="own-fk-list" role="listbox" aria-label={text("own.fork.title")}>
            <For each={shown()}>
              {(message) => (
                <li
                  id={optionID(message.id)}
                  class="own-fk-option"
                  role="option"
                  aria-selected={message.id === active()?.id}
                  aria-disabled={message.pending || undefined}
                  data-testid="fork-option"
                  data-message-id={message.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setChosen(message.id)}
                  onDblClick={() => void fork(message)}
                >
                  <span class="own-fk-text">{message.preview || "…"}</span>
                  <span class="own-fk-meta">
                    <Show when={message.attachments}>
                      <span>{text("own.fork.attachments", { n: message.attachments })}</span>
                    </Show>
                    <Show when={message.pending}>
                      <span class="own-fk-tag">{text("own.fork.pending")}</span>
                    </Show>
                    <time dateTime={new Date(message.created).toISOString()}>{formatter.format(message.created)}</time>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={more()}>
          <button type="button" class="own-fk-link" disabled={loadingMore()} onClick={() => void loadMore()}>
            {loadingMore() ? text("own.fork.loading") : text("own.fork.loadMore")}
          </button>
        </Show>
        <ul class="own-fk-notes">
          <li data-testid="fork-note-cache">
            {text("own.fork.cacheNote")}
            <Show when={cache()}>
              {(state) => (
                <span class="own-fk-cache" data-state={state().state}>
                  {` ${text("own.fork.cacheNow", { state: `${state().symbol} ${state().text}` })}`}
                </span>
              )}
            </Show>
          </li>
          <li>{text("own.fork.otherAccount")}</li>
          <Show when={busy()}>
            <li data-tone="warn">{text("own.fork.running")}</li>
          </Show>
          <Show when={active()?.pending}>
            <li data-tone="warn">{text("own.fork.pendingNote")}</li>
          </Show>
        </ul>
        <p class="own-fk-keys" aria-hidden="true">
          {text("own.fork.keys")}
        </p>
        <div class="own-fk-actions">
          <button type="button" class="own-fk-btn" disabled={working()} onClick={() => props.onClose()}>
            {text("own.fork.cancel")}
          </button>
          <span class="own-fk-grow" />
          <button
            type="button"
            class="own-fk-btn"
            disabled={working() || !allowed()}
            data-testid="fork-all"
            title={text("own.fork.bodyWhole")}
            onClick={() => void fork(undefined)}
          >
            {text("own.fork.copyAll")}
          </button>
          <button
            type="button"
            class="own-fk-btn"
            data-primary
            disabled={working() || !allowed() || !active() || !!active()?.pending}
            data-testid="fork-confirm"
            onClick={() => void fork(active())}
          >
            {working() ? text("own.fork.working") : text("own.fork.confirm")}
          </button>
        </div>
      </div>
    </Portal>
  )
}

function optionID(messageID: string) {
  return `own-fk-${messageID}`
}

/** Keeps Tab inside the dialog (11장 접근성: modal focus). */
function trapTab(event: KeyboardEvent, root: HTMLElement) {
  const items = [...root.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")].filter(
    (item) => !item.hasAttribute("disabled"),
  )
  const first = items[0]
  const last = items.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

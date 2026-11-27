// `이 지점으로 복원` dialog (03 §18.7), a lazy chunk:
//   이 메시지와 그 뒤의 턴 {n}개를 되감습니다.   [✓] 파일 변경도 되돌리기   [취소] [복원]
// plus, when they apply: the running turn is stopped first, queued messages are cancelled, the range holds an account
// switch (the current "모델 @ 계정" does not change), and the cold-point estimate from own.accounts (01 §17.1 #8, 02
// §4.7.4: after the commit the first request rebuilds the cache; up to the context of the boundary step is rewritten;
// the cache state of the current account comes from `cache.state`). The UI computes no cost (03 P10): tokens only.
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { heldMessages } from "@/transcript/held"
import { formatTokens } from "@/switcher/format"
import { cacheText, slotOf } from "@/switcher/labels"
import { currentRef } from "@/switcher/session"
import { showToast } from "@/switcher/toast"
import { sessionBusy, stageRevert } from "./actions"
import { boundaryContext, isPending, queuedUsers, switchInRange, turnsAfter } from "./model"
import type { RevertRequest } from "./host"
import { revertHeldText } from "./held-strings"
import { useRevertText } from "./strings"
import "./revert.css"

export default function RevertDialog(props: { readonly request: RevertRequest; readonly onClose: () => void }) {
  const i18n = useI18n()
  const text = useRevertText()
  const more = revertHeldText.use()
  const data = useData()
  const runtime = () => data.get(props.request.serverKey)
  const sessionID = props.request.sessionID
  const messageID = props.request.messageID
  const [files, setFiles] = createSignal(true)
  const [working, setWorking] = createSignal(false)
  // The open transcript's messages: a boundary far up is in its own pages, which the store does not hold.
  const held = heldMessages(props.request.serverKey, sessionID, messageID)
  const messages = () => held?.messages() ?? runtime()?.data.session.message.list(sessionID) ?? []
  /** Turns after the boundary that the view does not hold: the count is a lower bound. */
  const gap = () => held?.gapAfter(messageID) === true
  // Event-fed status can lag behind the server (overlapping executions); `session.active` settles it on open.
  const [activeOnServer, setActiveOnServer] = createSignal(false)
  const busy = () => runtime()?.data.session.status(sessionID) === "running" || activeOnServer()
  const pending = () => runtime()?.data.session.pending.list(sessionID) ?? []
  const turns = createMemo(() => turnsAfter(messages(), messageID, pending()))
  const waiting = () => isPending(pending(), messageID)
  const switched = createMemo(() => switchInRange(messages(), messageID))
  const queued = () => queuedUsers(pending())
  const rewrite = createMemo(() => boundaryContext(messages(), messageID))
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

  let dialog: HTMLDivElement | undefined
  let confirm: HTMLButtonElement | undefined
  let cancel: HTMLButtonElement | undefined
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => {
    ;(confirm && !confirm.disabled ? confirm : cancel)?.focus()
    const current = runtime()
    if (current)
      void sessionBusy({ runtime: current, serverKey: props.request.serverKey, sessionID }).then(setActiveOnServer)
  })
  onCleanup(() => returnTo?.isConnected && returnTo.focus())

  async function run() {
    const current = runtime()
    if (!current || working()) return
    setWorking(true)
    const outcome = await stageRevert(
      { runtime: current, serverKey: props.request.serverKey, sessionID },
      { messageID, message: messages().find((item) => item.id === messageID), files: files(), interrupt: busy() },
    )
    setWorking(false)
    if (!outcome.ok) {
      showToast({
        tone: "danger",
        message:
          outcome.reason === "busy"
            ? text("own.revertOps.busy")
            : outcome.reason === "pending"
              ? text("own.revertOps.pending")
              : text("own.revertOps.failed", { reason: outcome.reason }),
      })
      return
    }
    if (outcome.dropped > 0) showToast({ message: i18n.t("own.revert.queueDropped", { n: outcome.dropped }) })
    props.onClose()
  }

  // Esc works wherever focus is (the dialog may open from the palette with focus left outside, 11장).
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return
    event.stopPropagation()
    if (!working()) props.onClose()
  }
  document.addEventListener("keydown", escape, true)
  onCleanup(() => document.removeEventListener("keydown", escape, true))

  function keydown(event: KeyboardEvent) {
    if (event.key === "Tab" && dialog) trapTab(event, dialog)
  }

  return (
    <Portal>
      <div class="own-rv-scrim" onClick={() => !working() && props.onClose()} />
      <div
        ref={dialog}
        class="own-rv-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-rv-title"
        aria-describedby="own-rv-body"
        data-testid="revert-dialog"
        onKeyDown={keydown}
      >
        <h2 id="own-rv-title" class="own-rv-title">
          ↶ {i18n.t("own.revert.action")}
        </h2>
        <p id="own-rv-body" class="own-rv-body" data-testid="revert-dialog-body">
          {gap()
            ? more("own.revertOps.bodyMore", { n: turns() })
            : turns() > 0
              ? text("own.revertOps.body", { n: turns() })
              : text("own.revertOps.bodyLast")}
        </p>
        <label class="own-rv-check">
          <input
            type="checkbox"
            checked={files()}
            data-testid="revert-files"
            onChange={(event) => setFiles(event.currentTarget.checked)}
          />
          <span>{i18n.t("own.revert.withFiles")}</span>
        </label>
        <ul class="own-rv-notes">
          <Show when={waiting()}>
            <li data-tone="warn" data-testid="revert-note-pending">
              {text("own.revertOps.pending")}
            </li>
          </Show>
          <Show when={busy()}>
            <li data-tone="warn" data-testid="revert-note-running">
              {text("own.revertOps.running")}
            </li>
          </Show>
          <Show when={queued() > 0}>
            <li data-testid="revert-note-queue">{text("own.revertOps.queue", { n: queued() })}</li>
          </Show>
          <Show when={switched()}>
            <li data-tone="warn" data-testid="revert-note-switch">
              {i18n.t("own.revert.switchInRange")}
            </li>
          </Show>
          <li data-testid="revert-note-cold">
            <Show when={rewrite()} fallback={text("own.revertOps.coldPointPlain")}>
              {(tokens) => text("own.revertOps.coldPoint", { tokens: formatTokens(tokens()) })}
            </Show>
            <Show when={cache()}>
              {(state) => (
                <span class="own-rv-cache" data-state={state().state}>
                  {` · ${text("own.revertOps.cacheNow", { state: `${state().symbol} ${state().text}` })}`}
                </span>
              )}
            </Show>
          </li>
        </ul>
        <div class="own-rv-actions">
          <button ref={cancel} type="button" class="own-rv-btn" disabled={working()} onClick={() => props.onClose()}>
            {text("own.revertOps.cancel")}
          </button>
          <button
            ref={confirm}
            type="button"
            class="own-rv-btn"
            data-primary
            data-testid="revert-confirm"
            disabled={working() || !runtime() || waiting()}
            onClick={() => void run()}
          >
            {working()
              ? text("own.revertOps.working")
              : busy()
                ? text("own.revertOps.confirmStop")
                : text("own.revertOps.confirm")}
          </button>
        </div>
      </div>
    </Portal>
  )
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
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

// 복원 대기 띠 (03 §4.5, §18.7), a lazy chunk shown while a revert is staged, at the bottom of the conversation:
//   ↶ 복원 대기: 이 메시지 뒤 턴 3개와 파일 변경 5개를 되돌렸습니다 [복원 확정] [복원 취소] [변경 보기]
// `변경 보기` asks the review tab for `Session.revert.files` (window event, 18.5 owner) and also unfolds the file list
// here, so the bar is useful before the review tab handles the event. The rows after the boundary are dimmed by the
// transcript (`data-reverted`).
import { createMemo, createSignal, For, Show } from "solid-js"
import type { ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { heldMessages } from "@/transcript/held"
import { showToast } from "@/switcher/toast"
import { clearRevert, commitRevert } from "./actions"
import { requestRevertChanges } from "./events"
import { filesSummary, turnsAfter } from "./model"
import { revertHeldText } from "./held-strings"
import { useRevertText, type RevertKey } from "./strings"
import "./revert.css"

export interface RevertBarProps {
  readonly runtime: ServerRuntime
  readonly serverKey: string
  readonly sessionID: string
}

export default function RevertBar(props: RevertBarProps) {
  const i18n = useI18n()
  const text = useRevertText()
  const more = revertHeldText.use()
  const [working, setWorking] = createSignal<"commit" | "clear">()
  const [open, setOpen] = createSignal(false)
  const revert = () => props.runtime.data.session.get(props.sessionID)?.revert
  // The open transcript's messages: a boundary far up is in its own pages, which the store does not hold.
  const held = createMemo(() => {
    const boundary = revert()?.messageID
    return boundary ? heldMessages(props.serverKey, props.sessionID, boundary) : undefined
  })
  const turns = createMemo(() => {
    const boundary = revert()?.messageID
    const data = props.runtime.data
    const messages = held()?.messages() ?? data.session.message.list(props.sessionID)
    return boundary ? turnsAfter(messages, boundary, data.session.pending.list(props.sessionID)) : 0
  })
  /** Turns after the boundary that the view does not hold: the count is a lower bound. */
  const gap = () => {
    const boundary = revert()?.messageID
    return !!boundary && held()?.gapAfter(boundary) === true
  }
  const summary = createMemo(() => filesSummary(revert()?.files))
  const busy = () => props.runtime.data.session.status(props.sessionID) === "running"
  const target = () => ({ runtime: props.runtime, serverKey: props.serverKey, sessionID: props.sessionID })

  async function act(kind: "commit" | "clear") {
    if (working()) return
    setWorking(kind)
    const outcome = kind === "commit" ? await commitRevert(target()) : await clearRevert(target())
    setWorking(undefined)
    if (!outcome.ok)
      return showToast({
        tone: "danger",
        message:
          outcome.reason === "busy"
            ? text("own.revertOps.busy")
            : text("own.revertOps.failed", { reason: outcome.reason }),
      })
    showToast({ message: text(kind === "commit" ? "own.revertOps.committed" : "own.revertOps.cleared") })
  }

  function viewChanges() {
    const next = !open()
    setOpen(next)
    if (next)
      requestRevertChanges({ serverKey: props.serverKey, sessionID: props.sessionID, files: revert()?.files ?? [] })
  }

  return (
    <Show when={revert()}>
      <section class="own-rv-bar" role="region" aria-label={text("own.revertOps.bar")} data-testid="revert-bar">
        <div class="own-rv-bar-line">
          <span class="own-rv-bar-icon" aria-hidden="true">
            ↶
          </span>
          <span class="own-rv-bar-text" data-testid="revert-bar-text">
            {gap()
              ? more("own.revertOps.stagedMore", { turns: turns(), files: summary().count })
              : i18n.t("own.revert.staged", { turns: turns(), files: summary().count })}
          </span>
          <span class="own-rv-bar-actions">
            <button
              type="button"
              class="own-rv-btn"
              data-primary
              data-testid="revert-commit"
              title={text("own.revertOps.coldPointPlain")}
              disabled={!!working() || busy()}
              onClick={() => void act("commit")}
            >
              {i18n.t("own.revert.commit")}
            </button>
            <button
              type="button"
              class="own-rv-btn"
              data-testid="revert-clear"
              disabled={!!working() || busy()}
              onClick={() => void act("clear")}
            >
              {i18n.t("own.revert.clear")}
            </button>
            <button
              type="button"
              class="own-rv-link"
              data-testid="revert-view"
              aria-expanded={open()}
              onClick={viewChanges}
            >
              {open() ? text("own.revertOps.hide") : text("own.revertOps.view")}
            </button>
          </span>
        </div>
        <p class="own-rv-bar-hint">{text("own.revertOps.commitHint")}</p>
        <Show when={open()}>
          <Show when={summary().count > 0} fallback={<p class="own-rv-bar-hint">{text("own.revertOps.noFiles")}</p>}>
            <ul
              class="own-rv-files"
              data-testid="revert-files-list"
              aria-label={text("own.revertOps.filesTitle", { n: summary().count })}
            >
              <For each={revert()?.files ?? []}>
                {(file) => (
                  <li class="own-rv-file" data-status={file.status}>
                    <span class="own-rv-file-status">{text(`own.revertOps.status.${file.status}` as RevertKey)}</span>
                    <span class="own-rv-file-name" title={file.file}>
                      {file.file}
                    </span>
                    <span class="own-rv-file-count">
                      <Show when={file.additions}>
                        <span data-sign="plus">+{file.additions}</span>
                      </Show>
                      <Show when={file.deletions}>
                        <span data-sign="minus">−{file.deletions}</span>
                      </Show>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>
    </Show>
  )
}

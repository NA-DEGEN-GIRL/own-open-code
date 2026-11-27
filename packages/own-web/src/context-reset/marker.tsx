// The context reset's marker line (03 §4.5 "문맥 비우기 표시", core P-035), drawn for a completed compaction message
// with reason `reset`. It is never part of the model input. States (model.ts `markerState`):
//   active     ──── 여기부터 새 문맥 · 10월 24일 14:02 · [되돌리기] · [이전 대화 접기] ────
//   blocked    ──── 여기부터 새 문맥 · 그 뒤에 압축해서 되돌릴 수 없어요 · [이 지점 전으로 포크] ────
//   superseded ──── 여기부터 새 문맥(뒤에서 다시 비움) ────
//   undone     faint: 문맥 비우기를 되돌렸어요 · 14:05
// Folded, the active line says how many turns it hides (`이전 대화 3턴 · 모델은 보지 않아요 · [펼치기]`).
import { createMemo, Match, onCleanup, onMount, Show, Switch, type Accessor } from "solid-js"
import { forkSession } from "@/forking"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { useTranscript } from "@/transcript/context"
import { formatClock, formatClockFull } from "@/transcript/format"
import { fitSeps } from "@/transcript/seps-fit"
import { undoReset } from "./actions"
import { isFolded, setFold } from "./fold"
import { markerState, turnsBefore, type ResetMessage } from "./model"
import { useResetText } from "./strings"
import "./reset.css"

export default function ResetMarkerRow(props: {
  readonly message: Accessor<ResetMessage>
  readonly onSizeChange?: () => void
}) {
  const i18n = useI18n()
  const text = useResetText()
  const router = useRouter()
  const transcript = useTranscript()
  const runtime = transcript.runtime
  const sessionID = transcript.sessionID
  const id = () => props.message().id
  // The view's held messages: a reset far up is in its own pages, not in the store's list.
  const messages = transcript.messages
  const state = createMemo(() => markerState(messages(), id()))
  const session = () => runtime.data.session.get(sessionID)
  // Undo needs the prompt scope (it rewrites what the model gets) and no staged revert (core refuses it then).
  const undoable = () => state() === "active" && runtime.rpc.can("prompt") && !session()?.parentID && !session()?.revert
  const folded = () => isFolded(runtime.key, sessionID, id())
  const turns = createMemo(() => turnsBefore(messages()))
  const at = () => props.message().time.created
  const toggle = () => {
    setFold(runtime.key, sessionID, id(), !folded())
    props.onSizeChange?.()
  }
  const undo = () => void undoReset({ runtime, sessionID, resetID: id(), locale: i18n.locale(), toast: showToast })
  const forkBefore = async () => {
    const outcome = await forkSession({ runtime, serverKey: runtime.key, sessionID, before: id() })
    if (outcome.ok) router.navigate({ name: "session", serverKey: runtime.key, sessionID: outcome.session.id })
  }

  let row!: HTMLDivElement
  let seps!: HTMLSpanElement
  // A wrapped pill ends at its widest line (@/transcript/seps-fit, merge round 7).
  onMount(() => onCleanup(fitSeps(seps, row)))

  return (
    <div
      ref={row}
      class="own-marker own-reset"
      data-kind="reset"
      data-state={state()}
      data-testid="reset-marker"
      role="separator"
      aria-label={text("own.reset.marker")}
      title={state() === "undone" ? undefined : text("own.reset.markerTitle")}
    >
      {/* Unbreakable parts on styles/seps.css lines: a wrapped line never starts with `·` (merge round 7, as the
          switch marker). The buttons follow without one (`data-sep="none"`). */}
      <span class="own-marker-pill">
        <span ref={seps} class="own-seps">
          <span class="own-seps-in">
            <Switch>
              <Match when={state() === "undone"}>
                <span data-wrap data-testid="reset-undone">
                  {text("own.reset.undoneLine", { time: formatClock(i18n, props.message().undone ?? at()) })}
                </span>
              </Match>
              <Match when={state() === "superseded"}>
                <span data-wrap>{text("own.reset.superseded")}</span>
              </Match>
              <Match when={true}>
                <span>
                  <span aria-hidden="true">⊘</span> <b>{text("own.reset.marker")}</b>
                </span>
                <time dateTime={new Date(at()).toISOString()} title={formatClockFull(i18n, at())}>
                  {formatClock(i18n, at())}
                </time>
                <Show when={state() === "blocked"}>
                  <span data-wrap data-testid="reset-blocked">
                    {text("own.reset.blocked")}
                  </span>
                  <span data-sep="none">
                    <button
                      type="button"
                      class="own-marker-toggle"
                      data-testid="reset-fork-before"
                      onClick={forkBefore}
                    >
                      {text("own.reset.forkBefore")}
                    </button>
                  </span>
                </Show>
                <Show when={undoable()}>
                  <span data-sep="none">
                    <button type="button" class="own-marker-toggle own-target" data-testid="reset-undo" onClick={undo}>
                      {text("own.reset.undo")}
                    </button>
                  </span>
                </Show>
                <Show when={state() === "active" && turns() > 0}>
                  <Show
                    when={folded()}
                    fallback={
                      <span data-sep="none">
                        <button
                          type="button"
                          class="own-marker-toggle own-target"
                          data-testid="reset-fold"
                          onClick={toggle}
                        >
                          {text("own.reset.collapse")}
                        </button>
                      </span>
                    }
                  >
                    <span data-testid="reset-folded">{text("own.reset.collapsed", { n: turns() })}</span>
                    <span data-sep="none">
                      <button
                        type="button"
                        class="own-marker-toggle own-target"
                        data-testid="reset-unfold"
                        onClick={toggle}
                      >
                        {text("own.reset.expand")}
                      </button>
                    </span>
                  </Show>
                </Show>
              </Match>
            </Switch>
          </span>
        </span>
      </span>
    </div>
  )
}

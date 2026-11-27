// `≡ 대기 {n}` dock (03 §4.6, §18.9, 15.3 QueueDock): messages sent while a turn runs (the session inbox, kept current
// by `session.inbox.*` events), control items the router or core queued (a compaction before a switch, a move), and
// messages this window holds during a compact-then-switch. Each user row: delivery badge (press to switch 끼워 넣기 ↔
// 대기열), `메인이 보냄` / `팀이 보냄` on a main request of team mode (06 §5.2, shown without its envelope) or who sent an
// area message (`'세이브 v3' 담당이 보냄`, 5.8), first line, what happens to it (current account vs. after the pending
// switch, 02 §5.3 WAIT_SAFE), `지금 보내기` (queued rows), `편집`, `✕`. Queued rows reorder by dragging the handle or
// with ↑/↓ on it.
//
// Performance: rows are keyed by id (a store update moves rows instead of re-creating them); the drag measures the
// rows once when it starts and then only writes a transform (03 §20.2 R7).
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useI18n } from "@/i18n"
import { isMac } from "@/keyboard"
import { followUp } from "@/composer/send"
import { sendKey, sendKeyLabels } from "@/composer/send-key"
import type { Queue } from "./controller"
import { dropIndex, firstLine, moveTo, type QueueRow, type RowNote } from "./model"
import { useQueueText } from "./strings"
import "./queue.css"

export interface QueuePanelProps {
  readonly queue: Queue
  /** Drops a held message (compact-then-switch) before it is sent. */
  readonly onHeldCancel?: (index: number) => void
}

interface Drag {
  readonly id: string
  readonly from: number
  readonly startY: number
  readonly centers: readonly number[]
  readonly offset: number
  readonly to: number
}

export function QueuePanel(props: QueuePanelProps) {
  const i18n = useI18n()
  const text = useQueueText()
  const [drag, setDrag] = createSignal<Drag>()
  const [announce, setAnnounce] = createSignal("")
  const rows = () => props.queue.rows()
  const keys = createMemo(() => rows().map(rowKey), undefined, { equals: sameKeys })
  const rowByKey = createMemo(() => new Map(rows().map((row) => [rowKey(row), row] as const)))
  const count = () => rows().length
  const queued = () => props.queue.queued()
  const locked = () => props.queue.working()
  const reorderable = () => queued().length > 1 && !props.queue.revertStaged()
  let list: HTMLDivElement | undefined

  const note = (value: RowNote) => {
    switch (value.kind) {
      case "steerNow":
        return i18n.t("own.composer.queueSteerNote", { account: value.account })
      case "steerTurn":
        return text("own.queuePanel.steerTurn")
      case "afterSwitch":
        return i18n.t("own.queue.afterSwitch", { account: value.account })
      case "afterTurn":
        return i18n.t("own.composer.queueAfterTurn")
      case "parked":
        return text("own.queuePanel.parked")
    }
  }

  function startDrag(event: PointerEvent, id: string) {
    if (!reorderable() || locked() || event.button !== 0 || !list) return
    const handles = [...list.querySelectorAll<HTMLElement>("[data-queue-row][data-delivery='queue']")]
    const centers = handles.map((row) => {
      const box = row.getBoundingClientRect()
      return box.top + box.height / 2
    })
    const from = queued().indexOf(id)
    if (from < 0) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
    setDrag({ id, from, startY: event.clientY, centers, offset: 0, to: from })
  }
  function moveDrag(event: PointerEvent) {
    const current = drag()
    if (!current) return
    const offset = event.clientY - current.startY
    setDrag({
      ...current,
      offset,
      to: dropIndex(current.centers, current.from, current.centers[current.from]! + offset),
    })
  }
  function endDrag(cancelled: boolean) {
    const current = drag()
    setDrag(undefined)
    if (!current || cancelled || current.to === current.from) return
    void props.queue.reorder(moveTo(queued(), current.from, current.to))
    setAnnounce(text("own.queuePanel.moved", { n: current.to + 1 }))
  }
  function keyReorder(event: KeyboardEvent, id: string) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    if (!reorderable() || locked()) return
    const delta = event.key === "ArrowUp" ? -1 : 1
    const to = Math.max(0, Math.min(queued().length - 1, queued().indexOf(id) + delta))
    void props.queue.moveItem(id, delta)
    setAnnounce(text("own.queuePanel.moved", { n: to + 1 }))
  }
  const shift = (id: string) => {
    const current = drag()
    return current?.id === id ? current.offset : 0
  }
  const dropTarget = (id: string) => {
    const current = drag()
    if (!current || current.to === current.from) return undefined
    const index = queued().indexOf(id)
    if (index !== current.to) return undefined
    return current.to > current.from ? "after" : "before"
  }

  return (
    <Show when={count() > 0}>
      <div
        class="own-q"
        role="group"
        aria-label={i18n.t("own.queue.title", { n: count() })}
        aria-busy={locked()}
        data-testid="queue-panel"
      >
        <div class="own-q-head">
          <b>≡ {i18n.t("own.queue.title", { n: count() })}</b>
          <span class="own-q-hint">
            {text(followUp.value() === "steer" ? "own.queuePanel.defaultSteer" : "own.queuePanel.defaultQueue", {
              key: sendKeyLabels(sendKey.value()).send,
            })}
            {` · ${isMac ? "⌘" : "Ctrl"}+↑ ${i18n.t("own.queue.edit")}`}
          </span>
        </div>
        <div class="own-q-list" ref={list}>
          {/* Keyed on row ids: an inbox update moves row elements instead of re-creating them (no lost drag). */}
          <For each={keys()}>{(key) => <Show when={rowByKey().get(key)}>{(row) => <Row row={row} />}</Show>}</For>
        </div>
        <p class="own-sr-only" aria-live="polite">
          {announce()}
        </p>
      </div>
    </Show>
  )

  function Row(rowProps: { row: () => QueueRow }) {
    const user = () => kindOf(rowProps.row(), "user")
    const control = () => kindOf(rowProps.row(), "control")
    const held = () => kindOf(rowProps.row(), "held")
    return (
      <Switch>
        <Match when={user()}>
          {(row) => (
            <div
              class="own-q-row"
              data-queue-row
              data-testid="queue-row"
              data-delivery={row().delivery}
              data-dragging={drag()?.id === row().id ? "" : undefined}
              data-drop={dropTarget(row().id)}
              style={shift(row().id) ? { transform: `translateY(${shift(row().id)}px)` } : undefined}
            >
              <Show when={row().delivery === "queue" && reorderable()} fallback={<span class="own-q-grip-space" />}>
                <button
                  type="button"
                  class="own-q-grip"
                  data-testid="queue-handle"
                  aria-label={text("own.queuePanel.handle")}
                  title={text("own.queuePanel.handle")}
                  disabled={locked()}
                  onPointerDown={(event) => startDrag(event, row().id)}
                  onPointerMove={moveDrag}
                  onPointerUp={() => endDrag(false)}
                  onPointerCancel={() => endDrag(true)}
                  onKeyDown={(event) => keyReorder(event, row().id)}
                >
                  <span aria-hidden="true">⋮⋮</span>
                </button>
              </Show>
              <button
                type="button"
                class="own-q-badge"
                data-delivery={row().delivery}
                data-testid="queue-badge"
                title={i18n.t("own.composer.queueToggle")}
                disabled={locked()}
                onClick={() => void props.queue.toggle(row().id)}
              >
                {row().delivery === "steer" ? i18n.t("own.queue.steer") : i18n.t("own.queue.queue")}
              </button>
              <span class="own-q-text" title={row().text}>
                <Show when={row().source !== "user"}>
                  <span
                    class="mr-1.5 text-[11px] font-semibold text-own-muted"
                    data-testid="queue-source"
                    data-source={row().source}
                  >
                    {sourceText(text, row())}
                  </span>
                </Show>
                {firstLine(row().text)}
                <Show when={row().attachments > 0}>
                  <span class="own-q-meta">{text("own.queuePanel.attachments", { n: row().attachments })}</span>
                </Show>
              </span>
              <span class="own-q-note" data-testid="queue-note" data-note={row().note.kind}>
                {note(row().note)}
              </span>
              <span class="own-q-actions">
                <Show when={row().delivery === "queue"}>
                  <button
                    type="button"
                    class="own-q-link"
                    data-testid="queue-send-now"
                    disabled={locked()}
                    onClick={() => void props.queue.sendNow(row().id)}
                  >
                    {i18n.t("own.queue.sendNow")}
                  </button>
                </Show>
                <button
                  type="button"
                  class="own-q-link"
                  data-testid="queue-edit"
                  disabled={locked()}
                  onClick={() => void props.queue.edit(row().id)}
                >
                  {i18n.t("own.queue.edit")}
                </button>
                <button
                  type="button"
                  class="own-q-x"
                  data-testid="queue-cancel"
                  aria-label={i18n.t("own.composer.queueCancel")}
                  disabled={locked()}
                  onClick={() => void props.queue.cancel(row().id)}
                >
                  ×
                </button>
              </span>
            </div>
          )}
        </Match>
        <Match when={control()}>
          {(row) => (
            <div class="own-q-row" data-testid="queue-row" data-delivery={row().delivery} data-control={row().type}>
              <span class="own-q-grip-space" />
              <span class="own-q-badge" data-delivery="control">
                ⊟
              </span>
              <span class="own-q-text">
                {text(
                  row().type === "compaction"
                    ? "own.queuePanel.compaction"
                    : row().type === "reset"
                      ? "own.queuePanel.reset"
                      : "own.queuePanel.move",
                )}
              </span>
              {/* 18.9: a pending context reset is cancelled here; it never steers (03 §18.18). */}
              <Show when={row().type === "reset"}>
                <span class="own-q-actions">
                  <button
                    type="button"
                    class="own-q-x"
                    data-testid="queue-reset-cancel"
                    aria-label={i18n.t("own.composer.queueCancel")}
                    onClick={() => void props.queue.cancel(row().id)}
                  >
                    ×
                  </button>
                </span>
              </Show>
            </div>
          )}
        </Match>
        <Match when={held()}>
          {(row) => (
            <div class="own-q-row" data-testid="queue-row" data-delivery="held">
              <span class="own-q-grip-space" />
              <span class="own-q-badge" data-delivery="held">
                {i18n.t("own.composer.heldRow")}
              </span>
              <span class="own-q-text">{firstLine(row().text)}</span>
              <Show when={props.onHeldCancel}>
                {(cancel) => (
                  <span class="own-q-actions">
                    <button
                      type="button"
                      class="own-q-x"
                      aria-label={text("own.queuePanel.cancelHeld")}
                      onClick={() => cancel()(row().index)}
                    >
                      ×
                    </button>
                  </span>
                )}
              </Show>
            </div>
          )}
        </Match>
      </Switch>
    )
  }
}

function rowKey(row: QueueRow) {
  return row.kind === "held" ? `held:${row.index}` : `${row.kind}:${row.id}`
}

function sameKeys(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

function kindOf<Kind extends QueueRow["kind"]>(row: QueueRow, kind: Kind) {
  return row.kind === kind ? (row as Extract<QueueRow, { kind: Kind }>) : undefined
}

/** `메인이 보냄`, `팀이 보냄`, or who sent an area message (`'세이브 v3' 담당이 보냄`, 06 §5.8). */
function sourceText(text: ReturnType<typeof useQueueText>, row: Extract<QueueRow, { kind: "user" }>) {
  const sender = row.sender
  if (row.source === "area" && sender)
    return sender.label === undefined
      ? text("own.queuePanel.source.area", { area: sender.area })
      : text("own.queuePanel.source.peer", { area: sender.area, label: sender.label })
  return text(row.source === "main" ? "own.queuePanel.source.main" : "own.queuePanel.source.team")
}

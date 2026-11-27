// Worktree cleanup confirmation (03 §19.3 "정리(삭제)는 확인 대화상자"), a lazy chunk. Says what happens before it
// happens (P3): the folder and its working copy go, branches and commits stay; the command it amounts to; the
// sessions that live there (they cannot continue once the folder is gone — move them first). A running session there
// blocks the cleanup. When git refuses because of uncommitted changes (`WorktreeError{forceRequired}`), the dialog says
// so and offers `강제로 정리` (`force: true`), in the danger color.
//
// Removal guard (06 §10.4 #5, §8.6, TG13): on open the dialog asks own.accounts `worktree.inspect` what the removal
// would take along, and allows it only after an answer (fails closed with `다시 살피기`):
//   - another repository or worktree inside → refused, with their paths (git would delete their unsaved work too);
//   - an own lock (team mode) → the team view's job; this dialog never calls `worktree.remove`. For an area folder it
//     offers `영역 끝내기…` (06 §8.2, §8.6), which opens that area's menu at its 영역 끝내기 panel where this build of
//     own.team retires areas and this connection may;
//   - a scan that could not finish → refused with `다시 살피기`: it cannot rule out a repository inside (TI-3 (b));
//   - ignored files → the biggest 20 with sizes, their count and total; the confirm button names the size.
// Right before the removal the folder is inspected again (TI-3 (e), §8.6 step 3); when that no longer shows what was
// confirmed, nothing is removed and the dialog shows the new answer instead.
import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useData } from "@/data"
import { formatBytes } from "@/files/strings"
import { useI18n } from "@/i18n"
import { samePath } from "@/projects/path"
import { showToast } from "@/switcher/toast"
import { prepareTeamEntries, teamLabel } from "@/team/enable"
import { openAreaMenu } from "@/team/intents"
import { inspectWorktree, projectRef, removeWorktree } from "./api"
import type { RemoveRequest } from "./host"
import {
  isInside,
  removeCommand,
  removeGuard,
  sameInspection,
  shownPath,
  worktreeFailure,
  worktreeName,
  type WorktreeInspection,
} from "./model"
import { loadWorktrees } from "./state"
import { useWorktreePanelText } from "./panel-strings"
import "./panel.css"

export default function RemoveDialog(props: { readonly request: RemoveRequest; readonly onClose: () => void }) {
  const text = useWorktreePanelText()
  const i18n = useI18n()
  const data = useData()
  const id = createUniqueId()
  const runtime = () => data.get(props.request.serverKey)
  const directory = props.request.directory
  const label = worktreeName(directory)
  const [force, setForce] = createSignal(false)
  const [working, setWorking] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [inspection, setInspection] = createSignal<WorktreeInspection>()
  const [inspectFailure, setInspectFailure] = createSignal<string>()
  /** The inspection right before the removal differed from the confirmed one; the dialog now shows the new one. */
  const [changed, setChanged] = createSignal(false)
  const guard = () => removeGuard(inspection())
  const allowed = () => guard() === "ok" || guard() === "confirm-ignored"
  /**
   * The team area this folder is (finished ones too: `두기` keeps the folder and its lock) where 영역 끝내기 can run;
   * the main folder and other locked folders have none.
   */
  const retireTarget = createMemo(() => {
    const current = runtime()
    const team = current?.team
    if (!team?.has("reorg.retire") || !team.rpc.allowed("reorg.apply")) return undefined
    const entry = team.teamOfDirectory(directory)
    const area = entry?.order
      .map((areaID) => entry.areas[areaID])
      .find((item) => item !== undefined && samePath(item.directory, directory))
    return area ? { teamID: area.teamID, areaID: area.id } : undefined
  })
  const retireLabel = () => teamLabel(i18n.locale(), "own.team.areaMenu.retire")
  onMount(() => prepareTeamEntries(runtime()))

  function retire() {
    const area = retireTarget()
    if (!area) return
    props.onClose()
    openAreaMenu({ serverKey: props.request.serverKey, ...area, anchor: null, panel: "retire" })
  }

  const sessions = createMemo(() => {
    const current = runtime()
    if (!current) return []
    const index = current.sessions.state
    return index.order.flatMap((sessionID) => {
      const row = index.sessions[sessionID]
      if (!row || row.parentID) return []
      const where = current.data.session.get(sessionID)?.location.directory ?? row.directory
      return isInside(directory, where) ? [sessionID] : []
    })
  })
  const running = () => {
    const current = runtime()
    return !!current && sessions().some((sessionID) => current.data.session.status(sessionID) === "running")
  }

  /** Total ignored size for the notes and the button (only a complete scan is ever confirmed). */
  const ignoredSize = () => formatBytes(i18n.locale(), inspection()?.ignored.bytes ?? 0)
  const confirmLabel = () => {
    if (working()) return text("own.worktree.remove.working")
    const ignored = guard() === "confirm-ignored" && !!inspection()?.ignored.count
    if (force())
      return ignored
        ? text("own.worktree.remove.forceIgnored", { size: ignoredSize() })
        : text("own.worktree.remove.force")
    return ignored
      ? text("own.worktree.remove.confirmIgnored", { size: ignoredSize() })
      : text("own.worktree.remove.confirm")
  }

  function inspect() {
    const current = runtime()
    const project = current && projectRef(current, props.request.projectID)
    setInspection(undefined)
    setInspectFailure(undefined)
    setChanged(false)
    if (!current || !project) {
      setInspectFailure(text("own.worktree.remove.noRoot"))
      return
    }
    void inspectWorktree(current, project, directory).then(
      (result) => setInspection(result),
      (error: unknown) => setInspectFailure(error instanceof Error ? error.message : String(error)),
    )
  }

  let cancel: HTMLButtonElement | undefined
  let dialog: HTMLDivElement | undefined
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => {
    cancel?.focus()
    inspect()
  })
  onCleanup(() => returnTo?.isConnected && returnTo.focus())
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return
    event.stopPropagation()
    if (!working()) props.onClose()
  }
  document.addEventListener("keydown", escape, true)
  onCleanup(() => document.removeEventListener("keydown", escape, true))

  async function run() {
    const current = runtime()
    const project = current && projectRef(current, props.request.projectID)
    const confirmed = inspection()
    if (!current || !project || !confirmed || working() || running() || !allowed()) return
    setWorking(true)
    setFailure(undefined)
    setChanged(false)
    try {
      const again = await inspectWorktree(current, project, directory)
      if (!sameInspection(confirmed, again)) {
        setInspection(again)
        setChanged(true)
        return
      }
      await removeWorktree(current, props.request.projectID, directory, force())
      loadWorktrees(current, props.request.serverKey, props.request.projectID, true)
      showToast({ message: text("own.worktree.remove.done", { name: label }) })
      props.onClose()
    } catch (error) {
      const result = worktreeFailure(error)
      if (result.forceRequired && !force()) setForce(true)
      setFailure(result.message)
    } finally {
      setWorking(false)
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Tab" || !dialog) return
    const items = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")]
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

  return (
    <Portal>
      <div class="own-wt-scrim" onClick={() => !working() && props.onClose()} />
      <div
        ref={dialog}
        class="own-wt-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        data-testid="worktree-remove"
        data-guard={guard()}
        onKeyDown={keydown}
      >
        <h2 id={`${id}-title`} class="own-wt-title">
          {text("own.worktree.remove.title")}
        </h2>
        <p class="own-wt-here">
          <b>{text("own.worktree.group", { name: label })}</b>
          <span class="own-wt-path">{directory}</span>
        </p>
        <p id={`${id}-body`} class="own-wt-body">
          {text("own.worktree.remove.body")}
        </p>
        <ul class="own-wt-notes">
          <li class="own-wt-mono" data-testid="worktree-remove-command">
            {text("own.worktree.remove.command", { command: removeCommand(directory, force()) })}
          </li>
          <Show when={sessions().length}>
            <li data-tone="warn" data-testid="worktree-remove-sessions">
              {text("own.worktree.remove.sessions", { n: sessions().length })}
            </li>
          </Show>
          <Show when={running()}>
            <li data-tone="danger" data-testid="worktree-remove-running">
              {text("own.worktree.remove.running")}
            </li>
          </Show>
          <Show when={!inspection() && !inspectFailure()}>
            <li data-testid="worktree-remove-inspecting">{text("own.worktree.remove.inspecting")}</li>
          </Show>
          <Show when={inspectFailure()}>
            {(reason) => (
              <li data-tone="danger" role="alert" data-testid="worktree-remove-inspect-failed">
                {text("own.worktree.remove.inspectFailed", { reason: reason() })}
              </li>
            )}
          </Show>
          <Show when={inspection()}>
            {(current) => (
              <>
                <Show when={guard() === "refuse-nested"}>
                  <li data-tone="danger" role="alert" data-testid="worktree-remove-nested">
                    {text("own.worktree.remove.nested")}
                  </li>
                </Show>
                <Show when={guard() === "own-lock"}>
                  <li data-tone="warn" role="alert" data-testid="worktree-remove-own-lock">
                    {text("own.worktree.remove.ownLock", { reason: current().lock?.reason ?? "" })}
                  </li>
                </Show>
                <Show when={!current().ownLock && current().lock}>
                  {(lock) => (
                    <li data-tone="warn" data-testid="worktree-remove-locked">
                      {lock().reason
                        ? text("own.worktree.remove.lockedReason", { reason: lock().reason })
                        : text("own.worktree.remove.locked")}
                    </li>
                  )}
                </Show>
                <Show when={allowed() && current().ignored.count}>
                  <li data-tone="warn" data-testid="worktree-remove-ignored">
                    {text("own.worktree.remove.ignored", { n: current().ignored.count, size: ignoredSize() })}
                  </li>
                </Show>
                <Show when={guard() === "refuse-partial"}>
                  <li data-tone="danger" role="alert" data-testid="worktree-remove-partial">
                    {text("own.worktree.remove.partial")}
                  </li>
                </Show>
              </>
            )}
          </Show>
          <Show when={changed()}>
            <li data-tone="warn" role="alert" data-testid="worktree-remove-changed">
              {text("own.worktree.remove.changed")}
            </li>
          </Show>
          <Show when={force()}>
            <li data-tone="danger" data-testid="worktree-remove-dirty">
              {text("own.worktree.remove.dirty")}
            </li>
          </Show>
          <Show when={failure()}>
            {(message) => (
              <li data-tone="danger" role="alert">
                {text("own.worktree.remove.failed", { reason: message() })}
              </li>
            )}
          </Show>
        </ul>
        <Show when={guard() === "refuse-nested" && inspection()}>
          {(current) => (
            <ul class="own-wt-guard-list" data-testid="worktree-remove-nested-list">
              <For each={current().nested}>
                {(item) => (
                  <li class="own-wt-guard-row" title={item.path} data-testid="worktree-remove-nested-item">
                    <span class="own-wt-guard-path">{shownPath(directory, item.path)}</span>
                    <span class="own-wt-guard-meta">
                      {item.kind === "worktree"
                        ? text("own.worktree.remove.nestedWorktree")
                        : text("own.worktree.remove.nestedRepository")}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
        <Show when={allowed() && inspection()?.ignored.count ? inspection() : undefined}>
          {(current) => (
            <ul class="own-wt-guard-list" data-testid="worktree-remove-ignored-list">
              <For each={current().ignored.entries}>
                {(item) => (
                  <li class="own-wt-guard-row" title={item.path} data-testid="worktree-remove-ignored-item">
                    <span class="own-wt-guard-path">{item.path}</span>
                    <span class="own-wt-guard-meta">{formatBytes(i18n.locale(), item.bytes)}</span>
                  </li>
                )}
              </For>
              <Show when={current().ignored.truncated}>
                <li class="own-wt-guard-row own-wt-guard-more" data-testid="worktree-remove-ignored-more">
                  {text("own.worktree.remove.ignoredMore", {
                    n: current().ignored.count - current().ignored.entries.length,
                  })}
                </li>
              </Show>
            </ul>
          )}
        </Show>
        <div class="own-wt-actions">
          <Show when={inspectFailure() || guard() === "refuse-partial"}>
            <button type="button" class="own-wt-btn" data-testid="worktree-remove-retry" onClick={() => inspect()}>
              {text("own.worktree.remove.retry")}
            </button>
          </Show>
          <Show when={guard() === "own-lock" && retireTarget() ? retireLabel() : undefined}>
            {(label) => (
              <button
                type="button"
                class="own-wt-btn"
                aria-haspopup="dialog"
                data-testid="worktree-remove-retire"
                onClick={retire}
              >
                {label()}
              </button>
            )}
          </Show>
          <button ref={cancel} type="button" class="own-wt-btn" disabled={working()} onClick={() => props.onClose()}>
            {text("own.worktree.remove.cancel")}
          </button>
          <button
            type="button"
            class="own-wt-btn"
            data-danger
            data-testid="worktree-remove-confirm"
            disabled={working() || running() || !runtime() || !allowed()}
            onClick={() => void run()}
          >
            {confirmLabel()}
          </button>
        </div>
      </div>
    </Portal>
  )
}

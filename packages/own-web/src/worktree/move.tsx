// `다른 워크트리로 옮기기` dialog (03 §19.3), a lazy chunk. Destinations: the project folder (로컬) and the project's
// other worktrees, or a new worktree made from a base branch first. `POST /api/session/:id/move{directory, delivery}`
// queues a move item that core applies at the delivery boundary: while a turn runs, `현재 단계가 끝나면` (steer, the
// default) or `현재 턴이 끝나면` (queue); an idle session moves at once. `session.moved` then carries the new location:
// createData and the session index store it, and every later session call goes there (01 §15).
//
// What changes (P3): the working folder only — conversation, model @ account and approval mode stay. The move keeps the
// instruction epoch, so the cached prefix stays and destination instruction changes are appended to the next request
// (AGENTS.md "Session movement retains it"). Running shells stay where they started.
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useData } from "@/data"
import { samePath } from "@/projects/path"
import { showToast } from "@/switcher/toast"
import { createWorktree, moveSession, projectRef, rootLabelKey, syncProjects } from "./api"
import { BaseField } from "./base"
import type { MoveRequest } from "./host"
import { moveTargets, worktreeName, type MoveTarget } from "./model"
import { loadWorktrees, projectKey, worktreeChoices, worktreeList } from "./state"
import { useWorktreePanelText } from "./panel-strings"
import "./panel.css"

const NEW = "\u0000new"

export default function MoveDialog(props: { readonly request: MoveRequest; readonly onClose: () => void }) {
  const text = useWorktreePanelText()
  const data = useData()
  const name = createUniqueId()
  const runtime = () => data.get(props.request.serverKey)
  const sessionID = props.request.sessionID
  const info = () => runtime()?.data.session.get(sessionID)
  const row = () => runtime()?.sessions.state.sessions[sessionID]
  const directory = () => info()?.location.directory ?? row()?.directory
  const projectID = () => info()?.projectID ?? row()?.projectID
  const project = createMemo(() => {
    const current = runtime()
    const id = projectID()
    return current && id ? projectRef(current, id) : undefined
  })
  const key = () => {
    const id = projectID()
    return id ? projectKey(props.request.serverKey, id) : undefined
  }
  const list = () => {
    const current = key()
    return current ? worktreeList(current) : undefined
  }
  const targets = createMemo<MoveTarget[]>(() => {
    const root = project()?.root
    const here = directory()
    return root && here ? moveTargets(root, list()?.items ?? [], here) : []
  })
  const [target, setTarget] = createSignal<string>()
  const [base, setBase] = createSignal<string>()
  const [delivery, setDelivery] = createSignal<"steer" | "queue">("steer")
  const [working, setWorking] = createSignal(false)
  const running = () => runtime()?.data.session.status(sessionID) === "running"
  const shells = () =>
    runtime()
      ?.data.shell.listBySession(sessionID)
      .filter((shell) => shell.status === "running" && shell.metadata.source === undefined).length ?? 0

  createEffect(() => {
    const current = runtime()
    const id = projectID()
    if (!current || !id || current.connection.status() !== "connected") return
    untrack(() => {
      syncProjects(current)
      loadWorktrees(current, props.request.serverKey, id)
    })
  })
  // First destination preselected once the list is known; a new worktree when there is nowhere else to go.
  createEffect(() => {
    if (target() !== undefined || !list()?.items) return
    setTarget(targets()[0]?.directory ?? NEW)
  })

  let dialog: HTMLDivElement | undefined
  let cancel: HTMLButtonElement | undefined
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => cancel?.focus())
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
    const chosen = target()
    const ref = project()
    if (!current || !chosen || !ref || working()) return
    setWorking(true)
    const creatingKey = key()
    try {
      if (chosen === NEW) worktreeChoices.setCreating(creatingKey)
      const destination = chosen === NEW ? await createWorktree(current, ref, base()) : chosen
      if (chosen === NEW) worktreeChoices.setCreating(undefined)
      const label = samePath(destination, ref.root) ? text(rootKey()) : worktreeName(destination)
      // The toast for an applied move comes with `session.moved` (idle sessions move at once).
      const stop = current.bus.on("session.moved", (event) => {
        if (event.data.sessionID !== sessionID) return
        stop()
        showToast({ message: text("own.worktree.move.done", { name: label }) })
      })
      const busy = running()
      await moveSession(current, sessionID, destination, busy ? delivery() : undefined).catch((error: unknown) => {
        stop()
        throw error
      })
      if (busy)
        showToast({
          message: text(delivery() === "queue" ? "own.worktree.move.requestedTurn" : "own.worktree.move.requested", {
            name: label,
          }),
        })
      props.onClose()
    } catch (error) {
      worktreeChoices.setCreating(undefined)
      showToast({
        tone: "danger",
        message: text("own.worktree.move.failed", { reason: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      setWorking(false)
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== "Tab" || !dialog) return
    const items = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")].filter(
      (item) => !(item instanceof HTMLInputElement && item.type === "radio" && !item.checked),
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

  /** `메인 폴더` in a project with a team on, else `프로젝트 폴더`. */
  const rootKey = () => {
    const current = runtime()
    const ref = project()
    return current && ref ? rootLabelKey(current, ref.id) : "own.worktree.local"
  }
  const here = () => {
    const ref = project()
    const dir = directory()
    if (!dir) return ""
    return ref && samePath(dir, ref.root) ? text(rootKey()) : worktreeName(dir)
  }

  return (
    <Portal>
      <div class="own-wt-scrim" onClick={() => !working() && props.onClose()} />
      <div
        ref={dialog}
        class="own-wt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${name}-title`}
        aria-describedby={`${name}-body`}
        data-testid="worktree-move"
        onKeyDown={keydown}
      >
        <h2 id={`${name}-title`} class="own-wt-title">
          ⑂ {text("own.worktree.move.title")}
        </h2>
        <p id={`${name}-body`} class="own-wt-body">
          {text("own.worktree.move.body")}
        </p>
        <p class="own-wt-current" title={directory()} data-testid="worktree-move-current">
          {text("own.worktree.move.current")}: <b>{here()}</b>
        </p>
        <div class="own-wt-options own-wt-dialog-list" role="radiogroup" aria-label={text("own.worktree.place")}>
          <Show when={list()?.items} fallback={<p class="own-wt-empty">{text("own.worktree.loading")}</p>}>
            <Show when={!targets().length}>
              <p class="own-wt-empty">{text("own.worktree.move.none")}</p>
            </Show>
            <For each={targets()}>
              {(item) => (
                <label class="own-wt-option" title={item.directory} data-testid="worktree-move-target">
                  <input
                    type="radio"
                    name={name}
                    checked={target() === item.directory}
                    onChange={() => setTarget(item.directory)}
                  />
                  <span class="own-wt-option-text">
                    <span class="own-wt-option-title">
                      {item.kind === "local"
                        ? text(rootKey())
                        : text("own.worktree.group", { name: worktreeName(item.directory) })}
                    </span>
                    <span class="own-wt-option-hint own-wt-path">{item.directory}</span>
                  </span>
                </label>
              )}
            </For>
            <label class="own-wt-option" data-testid="worktree-move-new">
              <input type="radio" name={name} checked={target() === NEW} onChange={() => setTarget(NEW)} />
              <span class="own-wt-option-text">
                <span class="own-wt-option-title">{text("own.worktree.move.createNew")}</span>
              </span>
            </label>
            <Show when={target() === NEW && runtime() && project()}>
              <div class="own-wt-sub">
                <BaseField runtime={runtime()!} root={project()!.root} value={base()} onChange={setBase} />
              </div>
            </Show>
          </Show>
        </div>
        <Show when={running()}>
          <fieldset class="own-wt-field" data-testid="worktree-move-when">
            <legend class="own-wt-legend">{text("own.worktree.move.when")}</legend>
            <label class="own-wt-inline">
              <input
                type="radio"
                name={`${name}-when`}
                checked={delivery() === "steer"}
                onChange={() => setDelivery("steer")}
              />
              {text("own.worktree.move.steer")}
            </label>
            <label class="own-wt-inline">
              <input
                type="radio"
                name={`${name}-when`}
                checked={delivery() === "queue"}
                onChange={() => setDelivery("queue")}
              />
              {text("own.worktree.move.queue")}
            </label>
          </fieldset>
        </Show>
        <ul class="own-wt-notes">
          <li>{text("own.worktree.move.cache")}</li>
          <Show when={shells()}>{(count) => <li>{text("own.worktree.move.shells", { n: count() })}</li>}</Show>
        </ul>
        <div class="own-wt-actions">
          <button ref={cancel} type="button" class="own-wt-btn" disabled={working()} onClick={() => props.onClose()}>
            {text("own.worktree.move.cancel")}
          </button>
          <button
            type="button"
            class="own-wt-btn"
            data-primary
            data-testid="worktree-move-confirm"
            disabled={working() || !target() || !project() || !runtime()?.rpc.can("prompt")}
            onClick={() => void run()}
          >
            {working()
              ? target() === NEW
                ? project()?.start
                  ? text("own.worktree.creatingScript")
                  : text("own.worktree.creating")
                : text("own.worktree.move.working")
              : text("own.worktree.move.confirm")}
          </button>
        </div>
      </div>
    </Portal>
  )
}

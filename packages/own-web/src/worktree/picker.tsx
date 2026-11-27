// Content of the `⑂ 작업 위치` popover (03 §5.1, §19.3), a lazy chunk:
//   (•) 프로젝트 폴더 — 프로젝트 폴더에서 바로 작업해요 (메인 폴더 where a team is on)
//   ( ) 새 워크트리 — base branch + the project's startup script (`commands.start`, all new worktrees)
//   기존 워크트리: ( ) ⑂ calm-otter   세션 2   [정리…]
//   [목록 새로 고침]
// Clicking 로컬 or a worktree closes the popover; 새 워크트리 stays open for its options. One radio group: arrow keys
// move between the places without closing, Enter closes (11장).
// In a project with a team on, a new work folder is a new area (06 §8.8, §9.4), so parallel work is never split
// between the two: `새 워크트리` gives way to `새 영역`, which closes the picker and opens 영역 만들기 (team/create-area.tsx,
// team chunk, 2026-10-26: the same dialog as the team view's row) for `reorg.apply{teamID, proposal}`. It shows where
// this build of own.team makes areas and this connection may.
import { createEffect, createSignal, createUniqueId, For, onMount, Show, untrack } from "solid-js"
import type { ServerKey, ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { createImeEnter } from "@/ime/ime-enter"
import { showToast } from "@/switcher/toast"
import { teamLabel } from "@/team/enable"
import { openCreateArea } from "@/team/intents"
import { refreshWorktrees, saveStartScript, type ProjectRef } from "./api"
import { BaseField } from "./base"
import { openWorktreeRemove } from "./host"
import { effectiveChoice, isInside, otherWorktrees, worktreeName, type Choice } from "./model"
import { loadWorktrees, worktreeChoices, worktreeList } from "./state"
import { useWorktreePanelText } from "./panel-strings"
import "./panel.css"

export default function WorktreePicker(props: {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly project: ProjectRef
  readonly choiceKey: string
  readonly onDone: () => void
}) {
  const text = useWorktreePanelText()
  const i18n = useI18n()
  const name = createUniqueId()
  const list = () => worktreeList(props.choiceKey)
  const choice = () => effectiveChoice(worktreeChoices.get(props.choiceKey), list()?.items)
  const others = () => otherWorktrees(list()?.items ?? [], props.project.root)
  const [refreshing, setRefreshing] = createSignal(false)
  /** The project's team, when one is on (06 §8.8): new work folders are areas then. */
  const team = () => props.runtime.team.teamsOfProject(props.project.id)[0]
  /** `새 영역` where this connection may make areas (영역 만들기; basic on an older own.team), with its words once loaded. */
  const newArea = () => {
    const entry = team()
    if (!entry || props.runtime.team.createForm() === undefined) return undefined
    const label = teamLabel(i18n.locale(), "own.team.view.newArea")
    return label ? { teamID: entry.team.id, label } : undefined
  }

  createEffect(() => {
    if (props.runtime.connection.status() === "connected")
      untrack(() => loadWorktrees(props.runtime, props.serverKey, props.project.id))
  })
  // Whether a team is on is the registry's: read it once (a project menu may have already).
  onMount(() => props.runtime.team.ensure())

  let root: HTMLDivElement | undefined
  // Keyboard users land on the current place; arrow keys then move within the radio group (11장).
  onMount(() =>
    requestAnimationFrame(() => root?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus()),
  )

  const set = (next: Choice) => worktreeChoices.set(props.choiceKey, next)
  // A plain new worktree is not offered where a team is on: a remembered one falls back to 로컬.
  createEffect(() => {
    if (team() && choice().mode === "new") untrack(() => set({ mode: "local", base: choice().base }))
  })
  // A pointer pick of 로컬 or a worktree is final and closes; arrow keys only move the choice, Enter closes. The close
  // waits a task so the label's activation of its radio (after this handler) still records the choice; the radio's own
  // forwarded click has `detail` 0 and is not a second pick.
  const pick = (event: MouseEvent) => event.detail > 0 && setTimeout(props.onDone, 0)
  const confirm = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    props.onDone()
  }
  const sessionsIn = (directory: string) =>
    Object.values(props.runtime.sessions.state.sessions).filter(
      (row) => !row.parentID && isInside(directory, row.directory),
    ).length

  async function refresh() {
    setRefreshing(true)
    try {
      await refreshWorktrees(props.runtime, props.project.id)
      loadWorktrees(props.runtime, props.serverKey, props.project.id, true)
    } catch (error) {
      showToast({
        tone: "danger",
        message: text("own.worktree.loadFailed", { reason: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div ref={root} class="own-wt-picker" data-testid="worktree-picker">
      <div class="own-wt-options" role="radiogroup" aria-label={text("own.worktree.place")}>
        <label class="own-wt-option" data-testid="worktree-option-local" onClick={pick}>
          <input
            type="radio"
            name={name}
            checked={choice().mode === "local"}
            onChange={() => set({ mode: "local", base: choice().base })}
            onKeyDown={confirm}
          />
          <span class="own-wt-option-text">
            <span class="own-wt-option-title">{text(team() ? "own.worktree.home" : "own.worktree.local")}</span>
            <span class="own-wt-option-hint">{text(team() ? "own.worktree.homeHint" : "own.worktree.localHint")}</span>
          </span>
        </label>
        <Show
          when={team()}
          fallback={
            <label class="own-wt-option" data-testid="worktree-option-new">
              <input
                type="radio"
                name={name}
                checked={choice().mode === "new"}
                onChange={() => set({ mode: "new", base: choice().base })}
              />
              <span class="own-wt-option-text">
                <span class="own-wt-option-title">{text("own.worktree.new")}</span>
                <span class="own-wt-option-hint">{text("own.worktree.newHint")}</span>
              </span>
            </label>
          }
        >
          <Show when={newArea()}>
            {(area) => (
              <button
                type="button"
                class="own-wt-option w-full border-0 bg-transparent text-left text-inherit"
                aria-haspopup="dialog"
                data-testid="worktree-option-new-area"
                onClick={() => {
                  const teamID = area().teamID
                  props.onDone()
                  openCreateArea({ serverKey: props.serverKey, teamID })
                }}
              >
                <span class="own-wt-option-text">
                  <span class="own-wt-option-title">{area().label}</span>
                </span>
              </button>
            )}
          </Show>
        </Show>
        <Show when={!team() && choice().mode === "new"}>
          <div class="own-wt-sub">
            <BaseField
              runtime={props.runtime}
              root={props.project.root}
              value={choice().base}
              onChange={(base) => set({ mode: "new", base })}
            />
            <ScriptField runtime={props.runtime} project={props.project} />
          </div>
        </Show>
        <p class="own-wt-heading">{text("own.worktree.existing")}</p>
        <Show
          when={others().length}
          fallback={
            <p class="own-wt-empty">
              {list()?.error
                ? text("own.worktree.loadFailed", { reason: list()!.error! })
                : list()?.items
                  ? text("own.worktree.none")
                  : text("own.worktree.loading")}
            </p>
          }
        >
          <For each={others()}>
            {(item) => (
              <div class="own-wt-existing" data-testid="worktree-existing" data-directory={item.directory}>
                <label class="own-wt-option" title={item.directory} onClick={pick}>
                  <input
                    type="radio"
                    name={name}
                    checked={choice().mode === "existing" && choice().existing === item.directory}
                    onChange={() => set({ mode: "existing", existing: item.directory, base: choice().base })}
                    onKeyDown={confirm}
                  />
                  <span class="own-wt-option-text">
                    <span class="own-wt-option-title">
                      {text("own.worktree.group", { name: worktreeName(item.directory) })}
                    </span>
                    <span class="own-wt-option-hint own-wt-path">{item.directory}</span>
                  </span>
                  <Show when={sessionsIn(item.directory)}>
                    {(count) => <span class="own-wt-count">{text("own.worktree.sessions", { n: count() })}</span>}
                  </Show>
                </label>
                <Show when={props.runtime.rpc.can("prompt") && item.strategy}>
                  <button
                    type="button"
                    class="own-wt-link"
                    aria-label={text("own.worktree.cleanupNamed", { name: worktreeName(item.directory) })}
                    data-testid="worktree-cleanup"
                    onClick={() => {
                      props.onDone()
                      openWorktreeRemove({
                        serverKey: props.serverKey,
                        projectID: props.project.id,
                        directory: item.directory,
                      })
                    }}
                  >
                    {text("own.worktree.cleanup")}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="own-wt-foot">
        <button
          type="button"
          class="own-wt-link"
          disabled={refreshing()}
          data-testid="worktree-refresh"
          onClick={() => void refresh()}
        >
          {refreshing() ? text("own.worktree.refreshing") : text("own.worktree.refresh")}
        </button>
      </div>
    </div>
  )
}

/** The project's startup script (`commands.start`): saved explicitly, it applies to every new worktree (P3). */
function ScriptField(props: { readonly runtime: ServerRuntime; readonly project: ProjectRef }) {
  const text = useWorktreePanelText()
  const id = createUniqueId()
  const [saving, setSaving] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  let input: HTMLInputElement | undefined

  async function save() {
    if (!input || saving()) return
    setSaving(true)
    try {
      await saveStartScript(props.runtime, props.project.id, input.value)
      setDirty(false)
      showToast({ message: text("own.worktree.scriptSaved") })
    } catch (error) {
      showToast({
        tone: "danger",
        message: text("own.worktree.scriptFailed", { reason: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      setSaving(false)
    }
  }
  const ime = createImeEnter({ onEnter: () => void save() })

  return (
    <div class="own-wt-field">
      <label class="own-wt-legend" for={id}>
        {text("own.worktree.script")}
      </label>
      <div class="own-wt-script">
        <input
          ref={(element) => {
            input = element
            element.value = props.project.start ?? ""
          }}
          id={id}
          class="own-wt-input own-wt-mono"
          placeholder={text("own.worktree.scriptPlaceholder")}
          aria-describedby={`${id}-hint`}
          autocomplete="off"
          spellcheck={false}
          data-testid="worktree-script"
          onInput={(event) => {
            ime.input()
            setDirty(event.currentTarget.value.trim() !== (props.project.start ?? "").trim())
          }}
          onKeyDown={(event) => ime.keydown(event)}
          onKeyUp={(event) => ime.keyup(event)}
          onCompositionStart={() => ime.compositionstart()}
          onCompositionEnd={() => ime.compositionend()}
        />
        <button
          type="button"
          class="own-wt-btn"
          disabled={!dirty() || saving()}
          data-testid="worktree-script-save"
          onClick={() => void save()}
        >
          {text("own.worktree.scriptSave")}
        </button>
      </div>
      <p id={`${id}-hint`} class="own-wt-option-hint">
        {text("own.worktree.scriptHint")}
      </p>
    </div>
  )
}

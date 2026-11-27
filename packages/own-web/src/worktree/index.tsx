// Worktree flow module entry (03 §19.3, [gap] 19; 01 §17.1 #19: `worktree.*` + `session.move`, location rules §15):
//   - `WorktreeSelect`: `⑂ 작업 위치: 로컬 / 새 워크트리 / 기존 워크트리` on the new-session screen (5.1), next to the
//     project selector. Shown for Git projects only. The popover (lazy) has the base branch, the project's startup
//     script (`commands.start`, run by the server in each new worktree) and the existing worktrees with `정리…`.
//   - `resolveNewSessionDirectory`: the folder the next session is created in; creates the worktree when the choice
//     is `새 워크트리` (the server runs the startup script before it answers).
//   - `openWorktreeMove` (`다른 워크트리로 옮기기…`, session `⋯`), `openWorktreeRemove` (`정리…`), `WorktreeHost`.
//   - `LocationMissingNotice`, `noteLocationError`: 03 §8 세션 폴더 없음 above the composer (location-missing.tsx).
//   - `groupSessions`, `useProjectWorktrees`, `worktreeName`: the sidebar's `⑂ 브랜치 이름` groups (4.3);
//     `workPlace`: 작업 위치 (로컬/워크트리) for the session info drawer (5.6).
//
// Wiring (integrator): composer bar on the new-session screen `<WorktreeSelect directory={newDirectory}
// serverKey={serverKey}/>` after `<ProjectSelect>`; in `create()`, `const folder = await
// resolveNewSessionDirectory(current, newDirectory(), i18n.locale())` (undefined → restore the text and stop) before
// `data.session.create`, and keep send locked while `worktreeCreating()`; shell: `<WorktreeHost />` once; session
// `⋯` / palette: `다른 워크트리로 옮기기…` → `openWorktreeMove({serverKey, sessionID})` when `canMoveSession(...)`.
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  lazy,
  onCleanup,
  Show,
  Suspense,
  untrack,
} from "solid-js"
import { LOCAL, useData, type ServerKey, type ServerRuntime } from "@/data"
import type { Locale } from "@/i18n"
import { showToast } from "@/switcher/toast"
import { createWorktree, knownProjectID, projectRef, rootLabelKey, syncProjects } from "./api"
import { effectiveChoice, LOCAL_CHOICE, placeOf, worktreeName, type Choice } from "./model"
import { loadWorktrees, projectKey, worktreeChoices, worktreeList } from "./state"
import { useWorktreeText, worktreeText } from "./strings"
import "./select.css"

export { groupSessions, isInside, placeOf, worktreeName, type Choice, type Mode, type Place } from "./model"
export { canMoveSession, knownProjectID, moveSession, projectRef } from "./api"
export { openWorktreeMove, openWorktreeRemove, worktreeDialogOpen, WorktreeHost } from "./host"
export {
  LocationMissingNotice,
  locationMissing,
  MISSING_SEND,
  missingChoice,
  noteLocationError,
} from "./location-missing"
export { worktreeEn, worktreeKo, worktreeText, useWorktreeText, type WorktreeKey } from "./strings"

const Picker = lazy(() => import("./picker"))

/** True while a worktree is being created for a new session or a move (keep the composer's send locked). */
export const worktreeCreating = () => worktreeChoices.creating() !== undefined

/**
 * The folder a new session starts in (03 §5.1 + §19.3). `로컬` keeps the given folder (the project root when it was a
 * worktree); `기존 워크트리` returns that worktree; `새 워크트리` creates one from the project root at the chosen base.
 * Resolves `undefined` when creating failed (a toast said why): the caller restores the message and stops.
 */
export async function resolveNewSessionDirectory(runtime: ServerRuntime, directory: string, locale: Locale) {
  const projectID = knownProjectID(runtime, directory)
  const project = projectID ? projectRef(runtime, projectID) : undefined
  if (!projectID || !project || project.vcs !== "git") return directory
  const key = projectKey(runtime.key, projectID)
  const known = worktreeList(key)?.items
  const choice = effectiveChoice(worktreeChoices.get(key), known)
  if (choice.mode === "existing" && choice.existing) return choice.existing
  if (choice.mode === "local") {
    const place = placeOf(
      project.root,
      directory,
      known?.map((item) => item.directory),
    )
    return place.kind === "worktree" ? project.root : directory
  }
  worktreeChoices.setCreating(key)
  try {
    const created = await createWorktree(runtime, project, choice.base)
    showToast({ message: worktreeText.text(locale, "own.worktree.created", { name: worktreeName(created) }) })
    return created
  } catch (error) {
    showToast({
      tone: "danger",
      message: worktreeText.text(locale, "own.worktree.createFailed", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    })
    return undefined
  } finally {
    worktreeChoices.setCreating(undefined)
  }
}

/** The project's worktree folders (loaded once, current on `worktree.updated`) for the sidebar's `⑂` groups. */
export function useProjectWorktrees(runtime: () => ServerRuntime | undefined, projectID: () => string | undefined) {
  createEffect(() => {
    const current = runtime()
    const id = projectID()
    if (!current || !id || current.connection.status() !== "connected") return
    untrack(() => loadWorktrees(current, current.key, id))
  })
  return createMemo(() => {
    const current = runtime()
    const id = projectID()
    if (!current || !id) return undefined
    return worktreeList(projectKey(current.key, id))?.items?.map((item) => item.directory)
  })
}

/** 작업 위치 of a session (5.6): `로컬` or `워크트리 {name}`, with the branch when createData has it. */
export function workPlace(runtime: ServerRuntime, sessionID: string) {
  const info = runtime.data.session.get(sessionID)
  const row = runtime.sessions.state.sessions[sessionID]
  const directory = info?.location.directory ?? row?.directory
  const projectID = info?.projectID ?? row?.projectID
  if (!directory || !projectID) return undefined
  const root = projectRef(runtime, projectID)?.root
  const known = worktreeList(projectKey(runtime.key, projectID))?.items?.map((item) => item.directory)
  const place = placeOf(root, directory, known)
  if (place.kind === "local") return { kind: "local" as const, directory }
  const branch = runtime.data.location.vcs.info({ directory: place.directory })?.branch.current
  return { kind: "worktree" as const, directory: place.directory, name: worktreeName(place.directory, branch) }
}

export function WorktreeSelect(props: {
  /** The folder the next session would start in (composer: `newSessionDirectory`). */
  readonly directory: () => string | undefined
  readonly serverKey?: ServerKey
}) {
  const data = useData()
  const text = useWorktreeText()
  const id = createUniqueId()
  const serverKey = () => props.serverKey ?? LOCAL
  const runtime = () => data.get(serverKey())
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement

  createEffect(() => {
    const current = runtime()
    if (current?.connection.status() === "connected") untrack(() => syncProjects(current))
  })
  const projectID = createMemo(() => {
    const current = runtime()
    const directory = props.directory()
    return current && directory ? knownProjectID(current, directory) : undefined
  })
  const project = createMemo(() => {
    const current = runtime()
    const idValue = projectID()
    return current && idValue ? projectRef(current, idValue) : undefined
  })
  const key = () => {
    const idValue = projectID()
    return idValue ? projectKey(serverKey(), idValue) : undefined
  }
  const git = () => project()?.vcs === "git"
  const choice = (): Choice => {
    const current = key()
    return current ? effectiveChoice(worktreeChoices.get(current), worktreeList(current)?.items) : LOCAL_CHOICE
  }
  const creating = () => key() !== undefined && worktreeChoices.creating() === key()
  // An `기존 워크트리` choice is checked against the list before it is trusted (effectiveChoice).
  createEffect(() => {
    const current = runtime()
    const idValue = projectID()
    if (!current || !idValue || !git() || choice().mode !== "existing") return
    if (current.connection.status() === "connected") untrack(() => loadWorktrees(current, serverKey(), idValue))
  })

  const place = () => {
    if (creating()) return project()?.start ? text("own.worktree.creatingScript") : text("own.worktree.creating")
    const value = choice()
    if (value.mode === "new")
      return value.base ? text("own.worktree.newFrom", { base: value.base }) : text("own.worktree.new")
    if (value.mode === "existing" && value.existing) return worktreeName(value.existing)
    const current = runtime()
    const idValue = projectID()
    return text(current && idValue ? rootLabelKey(current, idValue) : "own.worktree.local")
  }

  // The content loads after opening, so the side is chosen by the room there is, not by the popover's height.
  function show() {
    popover.showPopover()
    setOpen(true)
    const rect = button.getBoundingClientRect()
    const below = innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const down = below >= 360 || below >= above
    popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popover.offsetWidth - 8))}px`
    popover.style.top = down ? `${rect.bottom + 4}px` : "auto"
    popover.style.bottom = down ? "auto" : `${innerHeight - rect.top + 4}px`
    popover.style.maxHeight = `${Math.max(160, down ? below : above)}px`
  }
  function close(focus = true) {
    if (!open()) return
    popover.hidePopover()
    setOpen(false)
    if (focus) button.focus()
  }
  // Light dismiss by hand (a manual popover): Esc never closes while an IME composes in the branch search (03 §12).
  const outside = (event: PointerEvent) => {
    const target = event.target as Node | null
    if (target && (popover.contains(target) || button.contains(target))) return
    close(false)
  }
  // Esc wherever focus is (a button that turned disabled drops focus to the body).
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    event.stopPropagation()
    close(popover.contains(document.activeElement) || document.activeElement === document.body)
  }
  createEffect(() => {
    if (!open()) return
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", escape, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("keydown", escape, true)
    })
  })

  return (
    <Show when={git()}>
      <button
        ref={button}
        type="button"
        class="own-wt-button"
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={id}
        aria-label={text("own.worktree.buttonLabel", { place: place() })}
        title={choice().mode === "existing" ? choice().existing : undefined}
        data-mode={choice().mode}
        data-busy={creating() ? "" : undefined}
        data-testid="worktree-select"
        onClick={() => (open() ? close() : show())}
      >
        <span aria-hidden="true">⑂</span>
        <span class="own-wt-button-text">{place()}</span>
        <span aria-hidden="true" class="own-wt-caret">
          ▾
        </span>
      </button>
      <div
        ref={popover}
        id={id}
        popover="manual"
        role="dialog"
        aria-label={text("own.worktree.place")}
        class="own-wt-pop"
        data-testid="worktree-popover"
      >
        <Show when={open() && runtime() && project()}>
          <Suspense fallback={<p class="own-wt-pop-loading">{text("own.worktree.loading")}</p>}>
            <Picker
              runtime={runtime()!}
              serverKey={serverKey()}
              project={project()!}
              choiceKey={key()!}
              onDone={() => close()}
            />
          </Suspense>
        </Show>
      </div>
    </Show>
  )
}

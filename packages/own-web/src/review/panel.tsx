// Work panel `리뷰` tab (03 §18.5, §4.7), a lazy chunk (20.2 R5) composed with the session-ui pieces by
// src/adapter/review.tsx (see kit.ts). Layout for the narrow panel, top to bottom:
//
//   [커밋 안 된 변경 ▾] [base: main ▾]              [나란히 | 한 줄로] [⟳]
//   변경 파일 3 · +130 −12                                    [목록 접기]
//    M src/router.ts                +42 −7        ← virtualized list (R2), ↑/↓/Home/End
//   ───────────────────────────────────────────────
//   session-ui SessionReviewV2 toolbar (1/3, ← →, show all lines) + SessionReviewFilePreviewV2 of one file
//
// Only the selected file's diff is mounted (file-level virtualization). pierre renders and highlights in its worker
// pool; patches over LARGE_PATCH_CHARS are trimmed in the review worker first. While the tab is hidden the preview is
// unmounted, the size observer is off and nothing is fetched (4.7 "숨긴 탭은 렌더링 작업을 멈춘다").
//
// 19.1 line comments: selecting lines in the preview opens session-ui's comment editor; comments are kept per session
// (comments.ts) and go with the next prompt (chips above the composer). `Ctrl+Shift+L` (`context.addSelection`) puts
// the selected lines into the composer as a file mention instead. The selection is read from the pierre `File` the
// preview renders (a thin wrapper around the kit's File records its `selectedLines`).
// 19.2 Git actions (src/git): the repository bar in `커밋 안 된 변경` / `브랜치 대 base`, the active file's actions in
// `커밋 안 된 변경`, each through the confirmation dock with the exact command line.
import type { FileDiffInfo } from "@opencode/client"
import "./review.css"
import { Dynamic } from "solid-js/web"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { I18nProvider } from "@opencode/ui/context/i18n"
import { createVirtualizer } from "@tanstack/solid-virtual"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import { uiI18nSource } from "@/adapter/ui-i18n"
import { useData, type ServerKey } from "@/data"
import { openFile } from "@/files"
import { createFileActions } from "@/files/actions"
import { useFilesText } from "@/files/strings"
import { gitRequest, takeGitRequest } from "@/git"
import { createGitActions, GitBar, GitDock, GitFileActions } from "@/git/actions"
import { createGitState } from "@/git/state"
import { useI18n } from "@/i18n"
import { chordLabel, chordOf, DEFAULT_KEYMAP, useShortcut, type ShortcutID } from "@/keyboard"
import { normalizeChord } from "@/keyboard/chord"
import { requestMention } from "@/mentions/intents"
import { showToast } from "@/switcher/toast"
import type { PanelTab } from "@/shell/context"
import type { PanelTabProps } from "@/shell/work-panel"
import { commentLines, onRemovedLines, reviewComments } from "./comments"
import { createReviewController, type ReviewController } from "./controller"
import type { ReviewKit, ReviewLineRange, ReviewPreviewComment, ReviewPreviewProps } from "./kit"
import {
  effectiveStyle,
  moveFile,
  needsLoad,
  splitPath,
  statusCode,
  tooLarge,
  TRIM_CONTEXT,
  type DiffStyle,
  type ReviewMode,
} from "./model"
import { prepareDiff, type PreparedDiff } from "./prepare"
import { reviewPrefs } from "./state"
import { useReviewText } from "./strings"

const ROW_HEIGHT = 28

/** The tab module the work panel loads (`LOADERS.review`), built from the session-ui kit by src/adapter/review.tsx. */
export function createReviewTab(kit: ReviewKit) {
  return function ReviewTab(props: PanelTabProps & { readonly tab?: PanelTab }) {
    return <ReviewPanel kit={kit} serverKey={props.serverKey} sessionID={props.sessionID} visible={props.visible} />
  }
}

export function ReviewPanel(props: {
  readonly kit: ReviewKit
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}) {
  const i18n = useI18n()
  const text = useReviewText()
  const controller = createReviewController(props)
  // The lines selected in the mounted preview (one file at a time), as its pierre File receives them.
  const [selection, setSelection] = createSignal<ReviewLineRange>()
  const TrackedFile = (fileProps: Record<string, unknown>) => {
    createEffect(() => {
      const range = fileProps.selectedLines as ReviewLineRange | null | undefined
      setSelection(range ? { start: range.start, end: range.end, side: range.side, endSide: range.endSide } : undefined)
    })
    onCleanup(() => setSelection(undefined))
    return <Dynamic component={props.kit.File} {...fileProps} />
  }
  return (
    <I18nProvider value={uiI18nSource(i18n.locale)}>
      <FileComponentProvider component={TrackedFile}>
        <Show
          when={props.sessionID()}
          fallback={
            <p class="own-review-state" data-testid="tab-review">
              {text("own.review.noSession")}
            </p>
          }
        >
          {(sessionID) => (
            <ReviewBody
              kit={props.kit}
              controller={controller}
              visible={props.visible}
              serverKey={props.serverKey}
              sessionID={sessionID}
              selection={selection}
            />
          )}
        </Show>
      </FileComponentProvider>
    </I18nProvider>
  )
}

function ReviewBody(props: {
  readonly kit: ReviewKit
  readonly controller: ReviewController
  readonly visible: () => boolean
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string
  readonly selection: () => ReviewLineRange | undefined
}) {
  const i18n = useI18n()
  const text = useReviewText()
  const data = useData()
  const review = props.controller
  const prefs = reviewPrefs.get()
  const [root, setRoot] = createSignal<HTMLElement>()
  const style = () => effectiveStyle(prefs.diffStyle, review.width())
  const narrowSplit = () => prefs.diffStyle === "split" && style() === "unified"
  const runtime = () => data.get(props.serverKey())

  // 19.2: Git actions for a Git folder, in the modes that compare with the working copy, on connections that may run
  // commands (a gateway device without the `prompt` scope only reads, 02 §9.1).
  const canWrite = () => review.git() && (runtime()?.rpc.can("prompt") ?? false)
  const gitBar = () => canWrite() && (review.mode() === "working" || review.mode() === "branch")
  const gitFile = () => canWrite() && review.mode() === "working"
  const gitState = createGitState({
    runtime,
    directory: review.directory,
    active: () => props.visible() && gitBar(),
    running: review.running,
  })
  const git = createGitActions({
    runtime,
    serverKey: props.serverKey,
    directory: review.directory,
    state: gitState,
    loadPatch: (file) => review.loadBounded(file),
    onChanged: () => review.refresh(),
  })
  const activeDiff = () => review.diffs().find((diff) => diff.file === review.active())
  // A confirmation belongs to the folder it was made for: another session's tab starts without it.
  createEffect(on(review.directory, () => git.close(), { defer: true }))
  // 19.15 palette `Git: 커밋…/푸시/PR 만들기`: the palette opened this tab in `커밋 안 된 변경`; once the repository
  // status is read, the same confirmation dock as the Git bar's button opens (nothing runs before the user confirms).
  createEffect(() => {
    const request = gitRequest()
    if (!request || request.serverKey !== props.serverKey() || request.sessionID !== props.sessionID()) return
    if (!props.visible() || !review.vcsReady()) return
    if (!canWrite()) return takeGitRequest(request.seq)
    if (!gitBar() || !gitState.status()) return
    // `gh` is looked up after the status; PR waits for that answer.
    if (request.action === "pr" && gitState.gh() === undefined) return
    untrack(() => {
      takeGitRequest(request.seq)
      if (request.action === "commit") git.commit()
      if (request.action === "push") git.push()
      if (request.action === "pr" && gitState.gh()) git.pr()
    })
  })
  // 18.5/19.5 per file: the files tab, the editor (desktop app or a `vscode://` link) and Explorer. Review paths are
  // repository-relative, so the actions resolve against the repository root.
  const fileActions = createFileActions({ serverKey: props.serverKey, directory: () => review.root() })
  const openable = () => {
    const file = review.active()
    const status = activeDiff()?.status
    return file && status !== "deleted" && review.mode() !== "reverted" ? file : undefined
  }

  // 19.1: the session's pending comments, as the preview draws them (mutable copies of the stored ones).
  const comments = createMemo<ReviewPreviewComment[]>(() =>
    reviewComments.list(props.serverKey(), props.sessionID()).map((comment) => ({
      id: comment.id,
      file: comment.file,
      selection: { ...comment.selection },
      comment: comment.comment,
    })),
  )
  const commentProps = (): Partial<ReviewPreviewProps> => ({
    comments: comments(),
    onLineComment: (comment) =>
      reviewComments.add(props.serverKey(), props.sessionID(), {
        file: comment.file,
        selection: comment.selection,
        comment: comment.comment,
        preview: comment.preview,
        mode: review.mode(),
        root: review.root(),
      }),
    onLineCommentUpdate: (comment) =>
      reviewComments.update(props.serverKey(), props.sessionID(), comment.id, comment.comment, comment.preview),
    onLineCommentDelete: (comment) => reviewComments.remove(props.serverKey(), props.sessionID(), comment.id),
    lineCommentActions: {
      moreLabel: text("own.review.comment.more"),
      editLabel: text("own.review.comment.edit"),
      deleteLabel: text("own.review.comment.delete"),
      saveLabel: text("own.review.comment.save"),
    },
    focusedComment: reviewComments.focus(props.serverKey(), props.sessionID()) ?? null,
    onFocusedCommentChange: (focus) => reviewComments.setFocus(props.serverKey(), props.sessionID(), focus),
  })

  /** Review paths are repository-relative; a mention is relative to the session's folder (or absolute). */
  const mentionPath = (file: string) => {
    const top = review.root()?.replaceAll("\\", "/").replace(/\/+$/, "")
    const folder = review.directory()?.replaceAll("\\", "/").replace(/\/+$/, "")
    if (!top || !folder || top === folder) return file
    const prefix = folder.startsWith(`${top}/`) ? folder.slice(top.length + 1) : undefined
    if (prefix !== undefined && file.startsWith(`${prefix}/`)) return file.slice(prefix.length + 1)
    return `${top}/${file}`
  }
  // 03 §10 `Ctrl+Shift+L` "선택 영역을 문맥에 추가": the selected lines become a file mention chip in the composer.
  const addSelection = () => {
    const range = props.selection()
    const file = review.active()
    if (!range || !file) return void showToast({ message: text("own.review.selection.none") })
    if (onRemovedLines(range)) return void showToast({ message: text("own.review.selection.removed") })
    const start = Math.min(range.start, range.end)
    const end = Math.max(range.start, range.end)
    requestMention({
      serverKey: props.serverKey(),
      sessionID: props.sessionID(),
      chip: { kind: "file", path: mentionPath(file), range: start === end ? { start } : { start, end } },
    })
    showToast({ message: text("own.review.selection.added", { file, lines: commentLines(range) }) })
  }
  optionalShortcut("context.addSelection", addSelection, { when: () => props.visible() })
  // Selecting lines opens session-ui's comment editor, whose textarea keeps its keys to itself (stopPropagation):
  // inside the tab the chord is taken in the capture phase, before the editor sees it.
  const addSelectionChords = DEFAULT_KEYMAP["context.addSelection"].chords.map(normalizeChord)
  createEffect(() => {
    const element = root()
    if (!element) return
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !addSelectionChords.includes(chordOf(event))) return
      event.preventDefault()
      event.stopPropagation()
      addSelection()
    }
    element.addEventListener("keydown", listener, true)
    onCleanup(() => element.removeEventListener("keydown", listener, true))
  })
  const addSelectionKey = () => chordLabel(DEFAULT_KEYMAP["context.addSelection"].chords[0]!)

  // 4.7: the split view needs 560 px. Observed only while the tab is visible.
  createEffect(() => {
    const element = root()
    if (!props.visible() || !element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) review.setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  const modeLabel = (mode: ReviewMode) => {
    if (mode === "working") return i18n.t("own.review.mode.working")
    if (mode === "branch")
      return i18n.t("own.review.mode.branch", { base: review.base() ?? text("own.review.baseUnknown") })
    if (mode === "lastTurn") return i18n.t("own.review.mode.lastTurn")
    if (mode === "session") return i18n.t("own.review.mode.session")
    return text("own.review.mode.reverted")
  }
  const branchOptions = () => {
    const list = review.branches() ?? []
    const current = review.base()
    return current && !list.includes(current) ? [current, ...list] : list
  }
  const emptyText = () => {
    const mode = review.mode()
    if (mode === "working") return text("own.review.empty.working")
    if (mode === "branch")
      return text("own.review.empty.branch", { base: review.base() ?? text("own.review.baseUnknown") })
    if (mode === "session") return text("own.review.empty.session")
    if (mode === "reverted") return text("own.review.empty.reverted")
    return text("own.review.empty.lastTurn")
  }
  const hasDiffs = () => props.visible() && review.diffs().length > 0

  return (
    <div ref={setRoot} class="own-review" data-testid="tab-review" data-style={style()}>
      <div class="own-review-bar">
        <select
          class="own-review-select"
          aria-label={text("own.review.modeLabel")}
          data-testid="review-mode"
          value={review.mode() ?? ""}
          disabled={review.modes().length === 0}
          onChange={(event) => review.selectMode(event.currentTarget.value as ReviewMode)}
        >
          {/* `selected` on the options too: the select's value is applied before its options exist. */}
          <For each={review.modes()}>
            {(mode) => (
              <option value={mode} selected={review.mode() === mode}>
                {modeLabel(mode)}
              </option>
            )}
          </For>
        </select>
        <Show when={review.mode() === "branch"}>
          <select
            class="own-review-select"
            aria-label={text("own.review.baseLabel")}
            data-testid="review-base"
            value={review.base() ?? ""}
            onChange={(event) => review.selectBase(event.currentTarget.value)}
          >
            <Show when={!review.base()}>
              <option value="" disabled selected>
                {text("own.review.basePick")}
              </option>
            </Show>
            <Show when={review.branches() === undefined || review.branches()!.length === 0}>
              <option value="" disabled>
                {text("own.review.baseLoading")}
              </option>
            </Show>
            <For each={branchOptions()}>
              {(branch) => (
                <option value={branch} selected={review.base() === branch}>
                  {text("own.review.base", { name: branch })}
                </option>
              )}
            </For>
          </select>
        </Show>
        <span class="own-review-grow" />
        <StyleSwitch
          value={prefs.diffStyle}
          label={text("own.review.view")}
          split={i18n.t("own.review.split")}
          unified={i18n.t("own.review.unified")}
          onChange={(value) => reviewPrefs.setDiffStyle(value)}
        />
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.review.refresh")}
          title={text("own.review.refresh")}
          data-testid="review-refresh"
          aria-busy={review.loading()}
          onClick={() => review.refresh()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 11-2.34-5.66M20 4v5h-5" />
          </svg>
        </button>
      </div>
      <Show when={gitBar()}>
        <GitBar git={git} state={gitState} />
      </Show>
      <GitDock git={git} directory={review.directory()} />
      <Show when={review.vcsReady() && !review.git()}>
        <p class="own-review-note" data-testid="review-novcs">
          {i18n.t("own.review.noVcs")}
          {/* 18.5 `Git 저장소 만들기` (upstream 41516c78c8): PC windows only; the gateway refuses it for devices. */}
          <Show when={review.canInitGit()}>
            {" "}
            <button
              type="button"
              class="own-review-link own-review-note-action"
              data-testid="review-git-init"
              title={text("own.review.gitInitTitle")}
              disabled={review.initializingGit()}
              aria-busy={review.initializingGit()}
              onClick={async () => {
                const result = await review.initGit()
                if (result.ok) return showToast({ message: text("own.review.gitInitDone") })
                if (result.reason !== "busy")
                  showToast({ tone: "danger", message: text("own.review.gitInitFailed", { reason: result.reason }) })
              }}
            >
              {text(review.initializingGit() ? "own.review.gitInitRunning" : "own.review.gitInit")}
            </button>
          </Show>
        </p>
      </Show>
      <Show when={review.running() && review.mode() === "lastTurn"}>
        <p class="own-review-note">{text("own.review.running")}</p>
      </Show>
      <Show when={narrowSplit()}>
        <p class="own-review-note" data-testid="review-split-narrow">
          {text("own.review.splitNarrow")}
        </p>
      </Show>
      <Show when={review.error() && review.diffs().length > 0}>
        <p class="own-review-note" data-tone="danger" role="alert">
          {text("own.review.error", { message: review.error()! })}
        </p>
      </Show>
      <Show when={review.diffs().length > 0}>
        <div class="own-review-summary" data-testid="review-summary">
          <span>{text("own.review.files", { count: review.summary().count })}</span>
          <span aria-hidden="true">·</span>
          <Stats additions={review.summary().additions} deletions={review.summary().deletions} />
          <span class="own-review-grow" />
          <button
            type="button"
            class="own-review-link"
            aria-expanded={review.listOpen()}
            aria-controls="own-review-list"
            data-testid="review-list-toggle"
            onClick={() => review.setListOpen(!review.listOpen())}
          >
            {review.listOpen() ? text("own.review.listHide") : text("own.review.listShow")}
          </button>
        </div>
        <Show when={review.listOpen()}>
          <FileList diffs={review.diffs()} active={review.active()} onSelect={(file) => review.selectFile(file)} />
        </Show>
      </Show>
      <Show when={gitFile() && review.active()}>
        {(file) => <GitFileActions git={git} state={gitState} file={file()} diff={activeDiff()} />}
      </Show>
      <Show when={openable()}>
        {(file) => (
          <ReviewFileLinks
            file={file()}
            actions={fileActions}
            onOpen={() =>
              openFile({ serverKey: props.serverKey(), sessionID: props.sessionID(), path: mentionPath(file()) })
            }
          />
        )}
      </Show>
      <Show when={hasDiffs() && comments().length === 0}>
        <p class="own-review-hint" data-testid="review-comment-hint">
          {text("own.review.comment.hint", { key: addSelectionKey() })}
        </p>
      </Show>
      <div class="own-review-preview" data-testid="review-preview" data-own-file-find="">
        <props.kit.Frame
          files={props.visible() ? review.files() : []}
          activeFile={review.active()}
          onSelectFile={(file) => review.selectFile(file)}
          diffStyle={style()}
          expandMode={prefs.expandMode}
          onExpandModeChange={(mode) => reviewPrefs.setExpandMode(mode)}
          hasDiffs={hasDiffs()}
          sidebarOpen={false}
          empty={
            <Show when={props.visible()}>
              <div class="own-review-empty" data-testid="review-empty">
                <Switch>
                  <Match when={review.error()}>
                    <p role="alert">{text("own.review.error", { message: review.error()! })}</p>
                    <button type="button" class="own-button" onClick={() => review.refresh()}>
                      {text("own.review.retry")}
                    </button>
                  </Match>
                  <Match when={review.needsBase()}>
                    <p data-testid="review-base-needed">{text("own.review.basePick")}</p>
                  </Match>
                  <Match when={!review.loaded()}>
                    <p class="own-review-state">{text("own.review.loading")}</p>
                  </Match>
                  <Match when={true}>
                    <props.kit.EmptyChanges />
                    <p class="own-review-state">{emptyText()}</p>
                  </Match>
                </Switch>
              </div>
            </Show>
          }
          preview={
            <Show when={review.active()} keyed>
              {(file) => (
                <FilePreview
                  kit={props.kit}
                  controller={review}
                  file={file}
                  style={style()}
                  expand={prefs.expandMode}
                  comments={commentProps}
                />
              )}
            </Show>
          }
        />
      </div>
    </div>
  )
}

/** The active file's `파일 탭에서 열기`, `에디터에서 열기` and `탐색기에서 보기` (03 §18.5, §19.5; gated in files/editor.ts). */
function ReviewFileLinks(props: {
  readonly file: string
  readonly actions: ReturnType<typeof createFileActions>
  readonly onOpen: () => void
}) {
  const text = useReviewText()
  const files = useFilesText()
  const editorUrl = () => props.actions.editorUrl(props.file)
  return (
    <div
      class="own-review-links"
      role="group"
      aria-label={text("own.review.fileActions", { file: props.file })}
      data-testid="review-file-links"
    >
      <button type="button" class="own-review-link" data-testid="review-open-files" onClick={() => props.onOpen()}>
        {text("own.review.openInFiles")}
      </button>
      <Switch>
        <Match when={props.actions.available().open?.kind === "app"}>
          <button
            type="button"
            class="own-review-link"
            data-testid="review-open-editor"
            onClick={() => void props.actions.openInEditor(props.file)}
          >
            {files("own.files.openInEditor")}
          </button>
        </Match>
        <Match when={editorUrl()}>
          {(url) => (
            <a class="own-review-link" data-testid="review-open-editor" href={url()}>
              {files("own.files.openInEditor")}
            </a>
          )}
        </Match>
      </Switch>
      <Show when={props.actions.available().reveal}>
        <button
          type="button"
          class="own-review-link"
          data-testid="review-reveal"
          onClick={() =>
            void props.actions.reveal(props.file).catch((error: unknown) =>
              showToast({
                message: files("own.files.openFailed", {
                  message: error instanceof Error ? error.message : String(error),
                }),
                tone: "danger",
              }),
            )
          }
        >
          {files("own.files.reveal")}
        </button>
      </Show>
    </div>
  )
}

function StyleSwitch(props: {
  readonly value: DiffStyle
  readonly label: string
  readonly split: string
  readonly unified: string
  readonly onChange: (value: DiffStyle) => void
}) {
  const options = () => [
    { value: "split" as const, label: props.split },
    { value: "unified" as const, label: props.unified },
  ]
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return
    event.preventDefault()
    const next = props.value === "split" ? "unified" : "split"
    props.onChange(next)
    const group = event.currentTarget as HTMLElement
    queueMicrotask(() => group.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus())
  }
  return (
    <div
      class="own-review-seg"
      role="radiogroup"
      aria-label={props.label}
      data-testid="review-style"
      onKeyDown={onKeyDown}
    >
      <For each={options()}>
        {(option) => (
          <button
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={props.value === option.value}
            tabIndex={props.value === option.value ? 0 : -1}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}

/** `+42 −7` (`−0` omitted, as in 18.5) with the 11장 label (`추가된 줄 42, 삭제된 줄 7`) for screen readers. */
function Stats(props: { readonly additions: number; readonly deletions: number }) {
  const text = useReviewText()
  return (
    <span
      class="own-review-stats"
      aria-label={text("own.review.lines", { added: props.additions, deleted: props.deletions })}
    >
      <span class="own-review-add" aria-hidden="true">
        +{props.additions}
      </span>
      <Show when={props.deletions > 0}>
        <span class="own-review-del" aria-hidden="true">
          −{props.deletions}
        </span>
      </Show>
    </span>
  )
}

function FileList(props: {
  readonly diffs: FileDiffInfo[]
  readonly active: string | undefined
  readonly onSelect: (file: string) => void
}) {
  const text = useReviewText()
  // Set after mount: before insertion Solid's cloned element belongs to the template document (no window), and
  // virtual-core would never observe its size.
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  const element = { list: undefined as HTMLDivElement | undefined }
  onMount(() => setScroller(element.list))
  const virtualizer = createVirtualizer({
    get count() {
      return props.diffs.length
    },
    getScrollElement: () => scroller() ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })
  const rowID = (index: number) => `own-review-file-${index}`
  const activeIndex = () => props.diffs.findIndex((diff) => diff.file === props.active)
  createEffect(
    on(activeIndex, (index) => {
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" })
    }),
  )
  const onKeyDown = (event: KeyboardEvent) => {
    const next = moveFile(
      props.diffs.map((diff) => diff.file),
      props.active,
      event.key,
    )
    if (!next) return
    event.preventDefault()
    props.onSelect(next)
  }
  const statusLabel = (status: FileDiffInfo["status"]) =>
    text(
      status === "added"
        ? "own.review.status.added"
        : status === "deleted"
          ? "own.review.status.deleted"
          : "own.review.status.modified",
    )
  return (
    <div
      ref={(list) => (element.list = list)}
      id="own-review-list"
      class="own-review-list"
      role="listbox"
      tabIndex={0}
      aria-label={text("own.review.list")}
      aria-activedescendant={activeIndex() >= 0 ? rowID(activeIndex()) : undefined}
      data-testid="review-list"
      onKeyDown={onKeyDown}
    >
      <div class="own-review-list-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>
          {(item) => {
            const diff = () => props.diffs[item.index]
            const path = () => splitPath(diff()?.file ?? "")
            return (
              <Show when={diff()}>
                {(current) => (
                  <div
                    id={rowID(item.index)}
                    role="option"
                    class="own-review-row"
                    aria-selected={current().file === props.active}
                    data-file={current().file}
                    style={{ transform: `translateY(${item.start}px)`, height: `${ROW_HEIGHT}px` }}
                    onClick={() => props.onSelect(current().file)}
                  >
                    <span
                      class="own-review-status"
                      data-status={current().status}
                      title={statusLabel(current().status)}
                    >
                      {statusCode(current().status)}
                      <span class="own-sr-only">{statusLabel(current().status)}</span>
                    </span>
                    <span class="own-review-path">
                      <bdi>
                        <span class="own-review-dir">{path().directory ? `${path().directory}/` : ""}</span>
                        <span class="own-review-name">{path().name}</span>
                      </bdi>
                    </span>
                    <Stats additions={current().additions} deletions={current().deletions} />
                  </div>
                )}
              </Show>
            )
          }}
        </For>
      </div>
    </div>
  )
}

/**
 * One file's diff. Server-capped patches are fetched again with 3 context lines; large patches are trimmed in the
 * worker; very large changes wait for "그래도 보기". Keyed by path, so a list refresh updates the mounted viewer.
 */
function FilePreview(props: {
  readonly kit: ReviewKit
  readonly controller: ReviewController
  readonly file: string
  readonly style: DiffStyle
  readonly expand: "expand" | "collapse"
  /** 19.1 line comment props of the preview. */
  readonly comments: () => Partial<ReviewPreviewProps>
}) {
  const text = useReviewText()
  const source = () => props.controller.diffs().find((diff) => diff.file === props.file)
  const [state, setState] = createStore({
    prepared: undefined as PreparedDiff | undefined,
    capped: false,
    forced: false,
  })
  const run = { token: 0 }
  const resolve = (diff: FileDiffInfo): PreparedDiff | Promise<PreparedDiff | undefined> => {
    if (!needsLoad(diff)) return prepareDiff(diff)
    return props.controller
      .loadBounded(diff.file)
      .then((loaded) => (loaded && !needsLoad(loaded) ? prepareDiff(loaded) : undefined))
  }
  createEffect(
    on([source, () => state.forced], ([diff, forced]) => {
      const token = ++run.token
      if (!diff || (tooLarge(diff) && !forced)) return setState({ prepared: undefined, capped: false })
      const result = resolve(diff)
      if (!(result instanceof Promise)) return setState({ prepared: result, capped: false })
      untrack(() => {
        if (state.prepared?.diff.file !== diff.file) setState("prepared", undefined)
      })
      void result.then((prepared) => {
        if (token === run.token) setState({ prepared, capped: prepared === undefined })
      })
    }),
  )
  const blocked = () => {
    const diff = source()
    return diff && tooLarge(diff) && !state.forced ? diff : undefined
  }
  return (
    <Switch fallback={<p class="own-review-state own-review-empty">{text("own.review.preparing")}</p>}>
      <Match when={blocked()}>
        {(diff) => (
          <div class="own-review-empty" data-testid="review-too-large">
            <p>{text("own.review.tooLarge", { count: diff().additions + diff().deletions })}</p>
            <button type="button" class="own-button" onClick={() => setState("forced", true)}>
              {text("own.review.renderAnyway")}
            </button>
          </div>
        )}
      </Match>
      <Match when={state.capped}>
        <p class="own-review-state own-review-empty" data-testid="review-capped">
          {text("own.review.capped")}
        </p>
      </Match>
      <Match when={state.prepared}>
        {(prepared) => (
          <>
            <Show when={prepared().trimmed}>
              <p class="own-review-note" data-testid="review-trimmed">
                {text("own.review.trimmed", { context: TRIM_CONTEXT })}
              </p>
            </Show>
            <Suspense fallback={<p class="own-review-state own-review-empty">{text("own.review.preparing")}</p>}>
              <props.kit.Preview
                file={props.file}
                diff={prepared().diff}
                diffStyle={props.style}
                expandMode={props.expand}
                comments={props.comments().comments}
                onLineComment={props.comments().onLineComment}
                onLineCommentUpdate={props.comments().onLineCommentUpdate}
                onLineCommentDelete={props.comments().onLineCommentDelete}
                lineCommentActions={props.comments().lineCommentActions}
                focusedComment={props.comments().focusedComment}
                onFocusedCommentChange={props.comments().onFocusedCommentChange}
              />
            </Suspense>
          </>
        )}
      </Match>
    </Switch>
  )
}

/**
 * `useShortcut` where a shortcut registry exists: harnesses that mount the tab alone (e2e/review) have no
 * <ShortcutProvider>, and the tab must not fail there.
 */
function optionalShortcut(id: ShortcutID, handler: () => void, options: { readonly when: () => boolean }) {
  try {
    useShortcut(id, handler, options)
  } catch {}
}

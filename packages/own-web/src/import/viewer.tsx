// 다른 도구의 대화: the read-only viewer (09 §3), a lazy chunk. `sessions.read` pages (20 turns) arrive as view messages
// and go through the production timeline (`adapter/session-ui`: createReactiveTimelineProjection, the session-ui row
// renderer and the vendored virtualizer, 03 §20.2 R2, PF3); nothing is sent to a model and no own session is made.
// The window of loaded turns grows at either end while scrolling and restarts at a turn the outline, a search hit or
// Ctrl+F jumps to. Around it: the band `읽기 전용 · <도구> 대화 · 원본 파일은 바꾸지 않습니다`, the header (tool and version,
// original model, folder or its missing mark, branch, period, turns, token estimate, compactions), the state tags
// (`진행 중일 수 있음`, `가져옴 → 열기`), the markers (`<도구>가 여기서 대화를 압축했습니다` between steps with the tool's
// summary, or the encrypted note of a Codex remote compaction; `되돌린 턴 N개`, `다른 갈래 N개`, sub-agent links that
// open this viewer), the outline panel (`읽는 중` until `outlineComplete`, 09 §2.8), Ctrl+F over the whole
// conversation (`sessions.search{ref}`, tool output included) and the actions: `이어서 하기` (I2, where offered; each
// user turn also offers `여기까지 이어서 하기`), `원본 위치 열기` (desktop, local connection: the tool's root folder) and
// `텍스트로 복사`.
import type { SessionMessageInfo, SessionStatus } from "@opencode/client"
import { abort } from "@opencode/util/abort"
import "@/transcript/transcript.css"
import "./import.css"
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
  Switch,
  type Accessor,
} from "solid-js"
import { createStore } from "solid-js/store"
import {
  createReactiveTimelineProjection,
  createSessionTimelineRowRenderer,
  SessionUiData,
  SessionUiShell,
  Timeline,
  TimelineRow,
} from "@/adapter/session-ui"
import { useData, type ImportSourceRef, type ServerKey, type ServerRuntime } from "@/data"
import { nextFrame } from "@/data/frame"
import { claimSessionFind } from "@/find/priority"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { useShortcut } from "@/keyboard"
import { copyText, createStatus, StatusLine, Tag } from "@/limits/kit"
import { RouteLink } from "@/routing/router"
import type { ImportRef, Route } from "@/routing/routes"
import { useShell } from "@/shell/context"
import { timelinePreset } from "@/timeline-settings"
import { timelineView } from "@/timeline-settings/detail"
import { buildCatalog } from "@/transcript/catalog"
import { formatTokens } from "@/transcript/format"
import { rowIndexes } from "@/transcript/rows"
import { createTimelineVirtualizer } from "@/vendor/timeline/virtualizer"
import { projectRef, syncProjects } from "@/worktree/api"
import { requestMigrate, viewerJump } from "./index"
import { SearchField } from "./list"
import {
  appendPage,
  compactionKinds,
  errorText,
  followOutline,
  lastModel,
  latestImport,
  mergeHits,
  outlineEntries,
  pageWindow,
  prependPage,
  previousPage,
  refKey,
  routeRef,
  TOOL_NAME,
  transcriptText,
  turnAnchor,
  turnIndex,
  versionRange,
  windowEnd,
  type Compacted,
  type Hit,
  type Outline,
  type OutlineEntry,
  type Page,
  type ReadOutput,
  type Summary,
  type ViewWindow,
} from "./model"
import { importGates, importStore } from "./store"
import { useImportText } from "./strings"

/** Turns per `sessions.read` page (09 §5.2 default). */
const PAGE = 20
/** `텍스트로 복사` reads the whole conversation in pages of the method's maximum. */
const COPY_PAGE = 100
/** Distance from either end of the timeline that reads the next page. */
const EDGE = 600
const OUTLINE_ROW = 30
const IDLE: SessionStatus = { type: "idle" }
const NO_SCROLL = { overflow: false, jump: false }

type Compaction = Extract<SessionMessageInfo, { type: "compaction" }>

export default function ImportViewer(props: {
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly sourceRef: ImportRef
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useImportText()
  return (
    <section class="own-import own-import-viewer" data-testid="import-viewer">
      <Show
        when={data.get(props.serverKey)}
        keyed
        fallback={<p class="own-placeholder">{text("own.otherTools.projectMissing")}</p>}
      >
        {(runtime) => {
          syncProjects(runtime)
          // The rows resolve paths against the conversation's folder, known with the first page.
          const [folder, setFolder] = createSignal("")
          // Every read names the project's folder: a device reaches the project's conversations only (09 §5.5).
          return (
            <Show
              when={projectRef(runtime, props.projectID)?.root}
              keyed
              fallback={<p class="own-placeholder">{text("own.otherTools.projectMissing")}</p>}
            >
              {(directory) => (
                <SessionUiShell locale={i18n.locale}>
                  <SessionUiData data={UI_DATA} directory={folder()} sessionID={refKey(props.sourceRef)}>
                    <Viewer
                      runtime={runtime}
                      serverKey={props.serverKey}
                      projectID={props.projectID}
                      directory={directory}
                      source={props.sourceRef}
                      onFolder={setFolder}
                    />
                  </SessionUiData>
                </SessionUiShell>
              )}
            </Show>
          )
        }}
      </Show>
    </section>
  )
}

/** Foreign models are not in the catalog, so rows show the ids the tool recorded; no own session is involved. */
const UI_DATA: SessionUiData = { provider: buildCatalog(), session: [], session_status: {}, session_diff: {} }

function Viewer(props: {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly projectID: string
  /** The project's folder, which the conversation must belong to (09 §5.5). */
  readonly directory: string
  readonly source: ImportRef
  readonly onFolder: (folder: string) => void
}) {
  const text = useImportText()
  const host = useHost()
  const shell = useShell()
  const runtime = props.runtime
  const store = importStore(runtime)
  void store.ensure()
  const gates = () => importGates(store.health(), runtime.imports.allowed)
  const ref = { kind: props.source.kind, rootID: props.source.rootID, id: props.source.id }
  // This PC's windows read any conversation the index knows (the `모든 폴더` view and its sub-agent links); a device
  // only the project's (09 §5.5).
  const reach = {
    directory: props.directory,
    ...(runtime.imports.allowed("sessions.read", { scope: "all" }) ? { scope: "all" as const } : {}),
  }
  const key = refKey(ref)
  let disposed = false
  onCleanup(() => (disposed = true))

  const [head, setHead] = createStore<{
    summary?: Summary
    outline?: Outline
    complete: boolean
    outlineFailed: boolean
    error?: string
  }>({ complete: false, outlineFailed: false })
  const [loaded, setLoaded] = createSignal<ViewWindow>()
  const [paging, setPaging] = createSignal(false)
  const [current, setCurrent] = createSignal<number>()

  async function read(from: number, count: number) {
    const output = await runtime.imports.call("sessions.read", { ref, ...reach, from, count })
    // SAFETY: the RPC carries SessionMessage.Info in its JSON form, which the client's SessionMessageInfo describes;
    // `Rpc.Output` names the decoded Type (dates as DateTime, branded ids) that never exists on this side.
    const messages = output.messages as unknown as SessionMessageInfo[]
    return { ...output, messages }
  }
  function apply(output: Pick<ReadOutput, "summary" | "outline" | "outlineComplete">) {
    setHead({ summary: output.summary, outline: output.outline, complete: head.complete || output.outlineComplete })
    props.onFolder(output.summary.cwd)
  }

  // The first page: at the turn a search hit asked for, else the beginning.
  const jump = viewerJump.take(props.source)
  onMount(() => void open(jump ?? 0, jump !== undefined))

  async function open(turn: number, reveal: boolean) {
    const page = await read(turn, PAGE).catch((error: unknown) => ({ error: errorText(text, error) }))
    if (disposed) return
    if ("error" in page) return setHead("error", page.error)
    apply(page)
    setLoaded(pageWindow(turn, page))
    if (!head.complete && !following) follow()
    nextFrame(() => {
      if (reveal) revealTurn(turn)
      edges()
    })
  }

  // The outline of a `.zst` conversation grows while own.import streams it (09 §2.8): asked again until complete.
  let following = false
  function follow() {
    following = true
    void followOutline({
      read: () => read(0, 1),
      apply,
      wait: waitVisible,
      stopped: () => disposed,
    }).then((result) => {
      following = false
      if (result === "failed") setHead("outlineFailed", true)
    })
  }

  async function extend(direction: "next" | "previous") {
    const now = loaded()
    if (!now || paging()) return
    const target =
      direction === "previous"
        ? previousPage(now, PAGE)
        : now.next === undefined
          ? undefined
          : { from: now.next, count: PAGE }
    if (!target) return
    setPaging(true)
    const page = await read(target.from, target.count).catch(() => undefined)
    setPaging(false)
    if (disposed || !page || loaded() !== now) return
    apply(page)
    setLoaded(direction === "next" ? appendPage(now, page) : prependPage(now, target.from, page))
    nextFrame(edges)
  }

  /** Reads on when the view is within EDGE of an end of the loaded turns (also right after a page that was short). */
  function edges() {
    const element = scroller()
    const now = loaded()
    if (!element || !now || paging()) return
    if (element.scrollTop < EDGE && now.start > 0) return void extend("previous")
    if (element.scrollHeight - element.scrollTop - element.clientHeight < EDGE && now.next !== undefined)
      void extend("next")
  }

  /** Shows a turn: in the window already, or in a new window that starts there. */
  async function goTo(turn: number) {
    setCurrent(turn)
    const now = loaded()
    if (now && turn >= now.start && turn < windowEnd(now)) return revealTurn(turn)
    const page = await read(turn, PAGE).catch(() => undefined)
    if (disposed || !page) return
    apply(page)
    setLoaded(pageWindow(turn, page))
    nextFrame(() => nextFrame(() => revealTurn(turn)))
  }
  function revealTurn(turn: number) {
    const now = loaded()
    const id = now ? turnAnchor(now, turn) : undefined
    if (id) reveal(id)
  }

  // Timeline (the production projection and rows; read only: no actions, idle status).
  const messages = createMemo(() => [...(loaded()?.messages ?? [])])
  const preset = createMemo(() => timelineView(timelinePreset()))
  const projection = createReactiveTimelineProjection({
    sessionMessages: messages,
    status: () => IDLE,
    reasoningMode: () => preset().reasoningMode,
    shellToolDefaultOpen: () => preset().shellToolDefaultOpen,
    editToolDefaultOpen: () => preset().editToolDefaultOpen,
    timelineDetail: () => preset().detail,
  })
  const rows = projection.rows
  const indexes = createMemo(() => rowIndexes(rows()))
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const kinds = createMemo(() => {
    const now = loaded()
    return now ? compactionKinds(now, head.outline ?? { checkpoints: [] }) : new Map<string, Compacted>()
  })
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  let reveal: (id: string, partID?: string) => void = () => {}
  const virtualized = createTimelineVirtualizer<TimelineRow.TimelineRow>({
    rowKey: TimelineRow.key,
    isGap: (row) => row._tag === "TurnGap",
    isUserMessage: (row) => row._tag === "UserMessage",
    partIndex: (partID) =>
      rows().findIndex(
        (row) => row._tag === "AssistantPart" && row.group.type === "part" && row.group.ref.partID === partID,
      ),
    active: () => true,
    sessionKey: () => `import:${props.serverKey}:${key}`,
    presentationKey: () => preset().presentationKey,
    projection: {
      activeMessageID: () => undefined,
      messageLastRowIndex: () => indexes().last,
      messageRowIndex: () => indexes().first,
      rowByKey,
      rows,
    },
    showHeader: () => false,
    // A read-only view never follows a tail: it opens at the top (or at a jump) and reads on as it scrolls.
    pinned: () => false,
    scroll: () => NO_SCROLL,
    onResumeScroll: () => {},
    setScrollRef: setScroller,
    setContentRef: () => {},
    onScheduleScrollState: () => {},
    onPin: () => {},
    onUnpin: () => {},
    onSelectionInteraction: () => {},
    onUserScroll: () => {},
    onHistoryScroll: () => edges(),
    setRevealMessage: (fn) => (reveal = fn),
  })
  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => key,
    status: () => IDLE,
    projection,
    presentation: () => undefined,
    reasoningMode: () => preset().reasoningMode,
    shellToolDefaultOpen: () => preset().shellToolDefaultOpen,
    editToolDefaultOpen: () => preset().editToolDefaultOpen,
    timelineDetail: () => preset().detail,
    disclosure: virtualized.disclosure,
    centered: () => false,
    padding: () => "",
  })
  const tool = () => TOOL_NAME[props.source.kind]

  // 이어서 하기 (I2, 09 §3 동작, §6): the whole conversation from the footer, or `여기까지 이어서 하기` up to a user turn.
  const resumable = () => gates().migrate && !!head.summary?.readable
  const turnOf = createMemo(() => {
    const now = loaded()
    return now ? turnIndex(now).turns : new Map<string, number>()
  })
  function migrate(upToTurn?: number) {
    const model = head.summary ? lastModel(head.summary) : undefined
    requestMigrate({
      serverKey: props.serverKey,
      projectID: props.projectID,
      directory: props.directory,
      ref: props.source,
      ...(upToTurn === undefined ? {} : { upToTurn }),
      ...(model ? { original: model } : {}),
      ...(head.complete && head.outline ? { turns: head.outline.turns.length } : {}),
    })
  }

  const renderRow = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    const initial = row()
    const message = initial._tag === "Notice" ? projection.messageByID().get(initial.messageID) : undefined
    const user = initial._tag === "UserMessage" ? initial.userMessageID : undefined
    return (
      <div class="own-row" data-row={initial._tag}>
        <Show
          when={message?.type === "compaction" ? message : undefined}
          fallback={<renderer.Row row={row} onSizeChange={onSizeChange} />}
        >
          {(compaction) => (
            <CompactionMarker
              message={compaction()}
              kind={kinds().get(compaction().id)}
              tool={tool()}
              open={virtualized.disclosure.value(`import-compaction:${compaction().id}`) === true}
              onToggle={(open) => {
                virtualized.disclosure.set(`import-compaction:${compaction().id}`, open)
                onSizeChange?.()
              }}
            />
          )}
        </Show>
        <Show when={user}>
          {(id) => (
            <ResumeHere
              turn={turnOf().get(id())}
              shown={resumable()}
              onSizeChange={onSizeChange}
              onResume={(turn) => migrate(turn)}
            />
          )}
        </Show>
      </div>
    )
  }
  /** Edits and writes mount after their size is known (the transcript's rule). */
  const deferred = (row: TimelineRow.TimelineRow) => {
    if (row._tag !== "AssistantPart" || row.group.type !== "part") return false
    const content = Timeline.resolveContent(projection.messageByID().get(row.group.ref.messageID), row.group.ref.partID)
    return content?.type === "tool" && ["edit", "write"].includes(content.name)
  }

  // Ctrl+F (09 §3 검색): the whole conversation on the server, tool output included.
  const [find, setFind] = createStore<{
    open: boolean
    query: string
    hits: Hit[]
    complete: boolean
    cursor?: string
    running: boolean
  }>({ open: false, query: "", hits: [], complete: true, running: false })
  const openFind = () => {
    if (!gates().search) return false
    setFind("open", true)
  }
  useShortcut("session.find", openFind)
  onCleanup(claimSessionFind(() => void openFind()))
  let findController: AbortController | undefined
  onCleanup(() => abort(findController))
  async function search(query: string, more: boolean) {
    findController?.abort()
    const words = query.trim().slice(0, 200)
    setFind({ query: words, ...(more ? {} : { hits: [], complete: true, cursor: undefined }) })
    if (!words) return setFind("running", false)
    const controller = new AbortController()
    findController = controller
    setFind("running", true)
    const output = await runtime.imports
      .call(
        "sessions.search",
        { ref, ...reach, query: words, limit: 50, ...(more && find.cursor ? { cursor: find.cursor } : {}) },
        { signal: controller.signal },
      )
      .catch(() => undefined)
    if (controller.signal.aborted) return
    setFind({
      running: false,
      hits: output ? (more ? mergeHits(find.hits, output.hits) : [...output.hits]) : find.hits,
      complete: output?.complete ?? true,
      cursor: output?.cursor,
    })
  }

  // Actions (09 §3 동작). Their outcome shows in the footer: the shell's toasts sit in the session view, which a page
  // such as this one hides.
  const status = createStatus()
  const localDesktop = () =>
    runtime.kind === "local" &&
    runtime.entry()?.auth !== "device" &&
    host.capabilities.openInApp &&
    !!host.files?.openPath &&
    gates().roots
  async function openSource() {
    status.clear()
    const roots = await runtime.imports.call("sources.list", {}).then(
      (output) => output.roots,
      () => [],
    )
    const root = roots.find((item) => item.rootID === props.source.rootID)
    const openPath = host.files?.openPath
    const opened =
      root && openPath
        ? await openPath(root.directory).then(
            () => true,
            () => false,
          )
        : false
    if (!opened) status.error(text("own.otherTools.view.openSourceFailed"))
  }
  const [copying, setCopying] = createSignal(false)
  async function copyAll() {
    if (copying()) return
    setCopying(true)
    status.clear()
    const all = async (from: number): Promise<SessionMessageInfo[]> => {
      const page: Page = await read(from, COPY_PAGE)
      return page.next === undefined ? [...page.messages] : [...page.messages, ...(await all(page.next))]
    }
    const messages = await all(0).catch(() => undefined)
    const summary = head.summary
    const copied =
      messages && summary
        ? await copyText(
            transcriptText({
              title: summary.title,
              header: text("own.otherTools.view.copyHeader", { tool: tool() }),
              messages,
              labels: {
                user: text("own.otherTools.view.copyUser"),
                assistant: text("own.otherTools.view.copyAssistant"),
                tool: text("own.otherTools.view.copyTool"),
                compaction: text("own.otherTools.view.copyCompaction"),
                reset: text("own.otherTools.view.copyReset"),
                resetUndone: text("own.otherTools.view.copyResetUndone"),
              },
            }),
          )
        : false
    setCopying(false)
    if (copied) return status.ok(text("own.otherTools.view.copied"))
    status.error(text("own.otherTools.view.copyFailed"))
  }

  // Wide windows show the outline beside the conversation; narrower ones lay it over the conversation on request.
  const [outlineShown, setOutlineShown] = createSignal(shell.tier() === "wide" || shell.tier() === "desk")
  const list = { name: "import" as const, serverKey: props.serverKey, projectID: props.projectID }

  return (
    <>
      <header class="own-import-head">
        <div class="own-import-title">
          <RouteLink to={list} class="own-btn" data-size="sm" data-testid="import-viewer-back">
            ← {text("own.otherTools.view.back")}
          </RouteLink>
          <h2 class="m-0 min-w-0 truncate text-[17px] font-semibold leading-7" data-testid="import-viewer-title">
            {head.summary?.title || text("own.otherTools.row.untitled")}
          </h2>
        </div>
        <p class="own-import-band" role="note" data-testid="import-viewer-band">
          {text("own.otherTools.view.band", { tool: tool() })}
        </p>
        <Show when={head.summary}>
          {(summary) => <ViewerHeader summary={summary()} outline={head.outline} complete={head.complete} />}
        </Show>
        <Show when={head.summary}>
          {(summary) => (
            <div class="own-import-tags" data-testid="import-viewer-tags">
              <Show when={summary().live}>
                <Tag tone="warn" title={text("own.otherTools.tag.liveHint")} testid="import-viewer-live">
                  {text("own.otherTools.tag.live")}
                </Tag>
              </Show>
              <Show when={latestImport(summary())}>
                {(imported) => (
                  <RouteLink
                    to={{ name: "session", serverKey: props.serverKey, sessionID: imported().sessionID }}
                    class="own-tag"
                    data-tone="accent"
                    data-testid="import-viewer-imported"
                  >
                    {text("own.otherTools.view.importedOpen")}
                  </RouteLink>
                )}
              </Show>
              <Show when={head.outline}>
                {(outline) => (
                  <ViewerMarkers outline={outline()} to={(target) => ({ ...list, ref: routeRef(target) })} />
                )}
              </Show>
            </div>
          )}
        </Show>
      </header>
      <Show when={find.open}>
        <div class="own-import-find" data-testid="import-viewer-find">
          <SearchField
            label={text("own.otherTools.view.find")}
            placeholder={text("own.otherTools.view.findPlaceholder")}
            clearLabel={text("own.otherTools.search.clear")}
            initial={find.query}
            delay={300}
            autofocus
            onQuery={(query) => void search(query, false)}
            onEscape={() => setFind("open", false)}
            testid="import-viewer-find-input"
          />
          <button
            type="button"
            class="own-icon-button own-target"
            aria-label={text("own.otherTools.view.findClose")}
            onClick={() => setFind("open", false)}
          >
            ×
          </button>
          <Show when={find.query}>
            <div class="own-import-find-results" role="list">
              <Show when={find.running}>
                <p class="m-0 text-own-muted" role="status">
                  {text("own.otherTools.search.searching")}
                </p>
              </Show>
              <Show when={!find.running && find.hits.length === 0}>
                <p class="m-0 text-own-muted">{text("own.otherTools.view.findNone")}</p>
              </Show>
              <For each={find.hits}>
                {(hit) => (
                  <button
                    type="button"
                    role="listitem"
                    class="own-import-hit"
                    data-testid="import-viewer-hit"
                    onClick={() => void goTo(hit.turn)}
                  >
                    <span class="own-num flex-none text-own-muted">
                      {text("own.otherTools.search.turn", { n: hit.turn + 1 })}
                    </span>
                    <span class="min-w-0 truncate">{hit.snippet}</span>
                  </button>
                )}
              </For>
              <Show when={!find.running && !find.complete && find.cursor}>
                <button type="button" class="own-btn" data-size="sm" onClick={() => void search(find.query, true)}>
                  {text("own.otherTools.search.partial")}
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
      <div class="own-import-body" data-outline={outlineShown() ? "" : undefined}>
        <div class="own-transcript-body own-import-timeline" data-testid="import-viewer-timeline">
          <Show
            when={!head.error}
            fallback={
              <p class="own-transcript-state" role="alert">
                {text("own.otherTools.view.failed", { reason: head.error ?? "" })}
              </p>
            }
          >
            <Show
              when={loaded()}
              fallback={
                <p class="own-transcript-state" role="status">
                  {text("own.otherTools.view.loading")}
                </p>
              }
            >
              <Show
                when={rows().length > 0}
                fallback={<p class="own-transcript-state">{text("own.otherTools.view.empty")}</p>}
              >
                <virtualized.View header={<div />} deferred={deferred} renderRow={renderRow} />
              </Show>
            </Show>
          </Show>
        </div>
        <Show when={outlineShown() && head.outline}>
          {(outline) => (
            <OutlinePanel
              outline={outline()}
              complete={head.complete}
              failed={head.outlineFailed}
              current={current()}
              onTurn={(turn) => void goTo(turn)}
              to={(target) => ({ ...list, ref: routeRef(target) })}
            />
          )}
        </Show>
      </div>
      <footer class="own-import-footer" data-testid="import-viewer-actions">
        <Show when={resumable()}>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            data-testid="import-viewer-resume"
            onClick={() => migrate()}
          >
            {text("own.otherTools.view.resume")}
          </button>
        </Show>
        <Show when={localDesktop()}>
          <button
            type="button"
            class="own-btn"
            data-testid="import-viewer-open-source"
            onClick={() => void openSource()}
          >
            {text("own.otherTools.view.openSource")}
          </button>
        </Show>
        <button
          type="button"
          class="own-btn"
          disabled={copying() || !head.summary}
          data-testid="import-viewer-copy"
          onClick={() => void copyAll()}
        >
          {text(copying() ? "own.otherTools.view.copying" : "own.otherTools.view.copy")}
        </button>
        <Show when={gates().search}>
          <button type="button" class="own-btn" onClick={() => void openFind()}>
            {text("own.otherTools.view.find")}
          </button>
        </Show>
        <StatusLine status={status} testid="import-viewer-status" />
        <button
          type="button"
          class="own-btn ml-auto"
          aria-pressed={outlineShown()}
          data-testid="import-viewer-outline-toggle"
          onClick={() => setOutlineShown(!outlineShown())}
        >
          {text(outlineShown() ? "own.otherTools.view.outlineHide" : "own.otherTools.view.outlineShow")}
        </button>
      </footer>
    </>
  )
}

/** Tool and version, original model, folder (or its missing mark), branch, period, turns, token estimate, compactions. */
function ViewerHeader(props: { readonly summary: Summary; readonly outline?: Outline; readonly complete: boolean }) {
  const i18n = useI18n()
  const text = useImportText()
  const items = createMemo(() => {
    const summary = props.summary
    const tool = TOOL_NAME[summary.ref.kind]
    const version = versionRange(summary.versions)
    const model = lastModel(summary)
    const outline = props.outline
    return [
      { key: "tool", label: version ? text("own.otherTools.view.tool", { tool, version }) : tool },
      ...(model ? [{ key: "model", label: text("own.otherTools.view.model", { model }) }] : []),
      summary.folderExists
        ? { key: "folder", label: text("own.otherTools.view.folder", { folder: summary.cwd }) }
        : { key: "folderMissing", label: text("own.otherTools.view.folderMissing", { folder: summary.cwd }) },
      ...(summary.branch
        ? [{ key: "branch", label: text("own.otherTools.view.branch", { branch: summary.branch }) }]
        : []),
      { key: "period", label: period(i18n.locale(), summary.createdAt, summary.updatedAt) },
      ...(outline
        ? [
            {
              key: "turns",
              label: text(props.complete ? "own.otherTools.view.turns" : "own.otherTools.view.turnsSoFar", {
                n: outline.turns.length,
              }),
            },
            { key: "tokens", label: text("own.otherTools.view.tokens", { tokens: formatTokens(outline.tokens) }) },
          ]
        : []),
      ...(summary.compactions > 0
        ? [{ key: "compactions", label: text("own.otherTools.view.compactions", { n: summary.compactions }) }]
        : []),
    ]
  })
  return (
    <p class="own-import-meta" data-testid="import-viewer-meta">
      <For each={items()}>
        {(item) => (
          <span data-item={item.key} title={item.key.startsWith("folder") ? props.summary.cwd : undefined}>
            {item.label}
          </span>
        )}
      </For>
    </p>
  )
}

/** `10월 1일 – 10월 3일`; one date when the conversation lasted a day; the year when it is not this year. */
function period(locale: string, from: number, to: number) {
  const thisYear = new Date().getFullYear()
  const sameYear = new Date(from).getFullYear() === thisYear && new Date(to).getFullYear() === thisYear
  const format = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
  const start = format.format(from)
  const end = format.format(to)
  return start === end ? start : `${start} – ${end}`
}

/** `되돌린 턴 N개`, `다른 갈래 N개`, `알 수 없는 형식 일부`, `앞부분은 다른 대화` (a link), `하위 에이전트 N개`. */
function ViewerMarkers(props: { readonly outline: Outline; readonly to: (ref: ImportSourceRef) => Route }) {
  const text = useImportText()
  return (
    <>
      <Show when={props.outline.rolledBack > 0}>
        <Tag tone="soft" testid="import-viewer-rolled-back">
          {text("own.otherTools.view.rolledBack", { n: props.outline.rolledBack })}
        </Tag>
      </Show>
      <Show when={props.outline.branches > 0}>
        <Tag tone="soft" testid="import-viewer-branches">
          {text("own.otherTools.view.branches", { n: props.outline.branches })}
        </Tag>
      </Show>
      <Show when={props.outline.unknownRecords > 0}>
        <Tag tone="dashed">{text("own.otherTools.view.unknown")}</Tag>
      </Show>
      <Show when={props.outline.base}>
        {(base) => (
          <RouteLink to={props.to(base())} class="own-tag" data-testid="import-viewer-base">
            {text("own.otherTools.view.base")}
          </RouteLink>
        )}
      </Show>
      <Show when={props.outline.children.length > 0}>
        <Tag tone="soft">{text("own.otherTools.view.subagents", { n: props.outline.children.length })}</Tag>
      </Show>
    </>
  )
}

/**
 * `<도구>가 여기서 대화를 압축했습니다` between the steps where the tool compacted (09 §3 자리 표시): `요약 보기` shows the
 * tool's summary; a Codex remote compaction has none to show (encrypted), only the user requests before it remain.
 */
function CompactionMarker(props: {
  readonly message: Compaction
  readonly kind: Compacted | undefined
  readonly tool: string
  readonly open: boolean
  readonly onToggle: (open: boolean) => void
}) {
  const text = useImportText()
  const encrypted = () => props.kind?.kind === "codex-remote"
  const summary = () => (props.message.status === "completed" ? props.message.summary.trim() : "")
  return (
    <div class="own-import-compaction" data-testid="import-compaction" data-kind={props.kind?.kind}>
      <div class="own-marker" data-kind="compaction" role="note">
        <span class="own-marker-pill">
          <span aria-hidden="true">⊟</span>
          <span>{text("own.otherTools.view.compacted", { tool: props.tool })}</span>
          <Show when={!encrypted()}>
            <button
              type="button"
              class="own-marker-toggle"
              aria-expanded={props.open}
              onClick={() => props.onToggle(!props.open)}
            >
              {text(props.open ? "own.otherTools.view.summaryHide" : "own.otherTools.view.summaryShow")}
            </button>
          </Show>
        </span>
      </div>
      <Show when={encrypted() && props.kind}>
        {(kind) => (
          <p class="own-import-compaction-note" data-testid="import-compaction-encrypted">
            {text("own.otherTools.view.encrypted", { n: kind().requests })}
          </p>
        )}
      </Show>
      <Show when={!encrypted() && props.open}>
        <pre class="own-import-compaction-summary" tabIndex={0}>
          {summary() || text("own.otherTools.view.summaryEmpty")}
        </pre>
      </Show>
    </div>
  )
}

/** `여기까지 이어서 하기` under a user turn (09 §3 동작): the dialog imports up to that turn only. */
function ResumeHere(props: {
  readonly turn: number | undefined
  readonly shown: boolean
  readonly onSizeChange?: () => void
  readonly onResume: (turn: number) => void
}) {
  const text = useImportText()
  const visible = () => props.shown && props.turn !== undefined
  // The button can appear after the row was measured (own.import's health answers later).
  createEffect(on(visible, () => props.onSizeChange?.(), { defer: true }))
  return (
    <Show when={visible()}>
      <div class="flex justify-end px-4 pt-0.5 pb-1">
        <button
          type="button"
          class="rounded-md px-1.5 py-0.5 text-[12px] text-own-muted hover:bg-own-hover hover:text-own-text"
          title={text("own.otherTools.view.resumeHereTitle", { n: (props.turn ?? 0) + 1 })}
          data-testid="import-viewer-resume-here"
          onClick={() => props.onResume(props.turn ?? 0)}
        >
          {text("own.otherTools.view.resumeHere")}
        </button>
      </div>
    </Show>
  )
}

/** The outline panel (virtual, fixed rows): turns, compaction places, sub-agent links, `읽는 중` while it streams. */
function OutlinePanel(props: {
  readonly outline: Outline
  readonly complete: boolean
  readonly failed: boolean
  readonly current: number | undefined
  readonly onTurn: (turn: number) => void
  readonly to: (ref: ImportSourceRef) => Route
}) {
  const text = useImportText()
  const entries = createMemo(() => outlineEntries(props.outline, props.complete, props.failed))
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  let element: HTMLDivElement | undefined
  onMount(() => setScroller(element))
  const virtualizer = createVirtualizer({
    get count() {
      return entries().length
    },
    getScrollElement: () => scroller() ?? null,
    estimateSize: () => OUTLINE_ROW,
    overscan: 10,
    get getItemKey() {
      const current = entries()
      return (index: number) => current[index]?.key ?? index
    },
  })
  return (
    <aside
      class="own-import-outline"
      aria-label={text("own.otherTools.view.outline")}
      data-testid="import-viewer-outline"
    >
      <h3 class="own-import-heading">{text("own.otherTools.view.outline")}</h3>
      <div ref={(value) => (element = value)} class="own-import-outline-scroll">
        <div class="own-import-rows" role="list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => (
              <Show when={entries()[item.index]}>
                {(entry) => (
                  <div
                    class="own-import-slot"
                    role="listitem"
                    style={{ transform: `translateY(${item.start}px)`, height: `${OUTLINE_ROW}px` }}
                  >
                    <OutlineRow entry={entry()} current={props.current} onTurn={props.onTurn} to={props.to} />
                  </div>
                )}
              </Show>
            )}
          </For>
        </div>
      </div>
    </aside>
  )
}

/**
 * One row of the outline panel. Reactive on `entry`: the virtual slot at an index keeps its row while the outline
 * grows, so the same row turns from `읽는 중` into the next turn once the stream reaches it.
 */
function OutlineRow(props: {
  readonly entry: OutlineEntry
  readonly current: number | undefined
  readonly onTurn: (turn: number) => void
  readonly to: (ref: ImportSourceRef) => Route
}) {
  const text = useImportText()
  return (
    <Switch>
      <Match when={props.entry.type === "turn" && props.entry}>
        {(entry) => (
          <button
            type="button"
            class="own-import-outline-turn"
            aria-current={props.current === entry().index ? "true" : undefined}
            title={entry().line}
            data-testid="import-outline-turn"
            onClick={() => props.onTurn(entry().index)}
          >
            <span class="min-w-0 truncate">
              {text("own.otherTools.view.outlineTurn", { n: entry().index + 1, line: entry().line })}
            </span>
            <Show when={entry().compactions > 0}>
              <span class="flex-none text-own-faint">⊟ {text("own.otherTools.view.outlineCompaction")}</span>
            </Show>
          </button>
        )}
      </Match>
      <Match when={props.entry.type === "child" && props.entry}>
        {(entry) => (
          <RouteLink to={props.to(entry().ref)} class="own-import-outline-child" data-testid="import-outline-child">
            {text("own.otherTools.view.outlineChild", { title: entry().title || entry().ref.id })}
          </RouteLink>
        )}
      </Match>
      <Match when={props.entry.type === "reading" || props.entry.type === "failed"}>
        <p
          class="own-import-outline-state"
          role="status"
          data-testid={props.entry.type === "reading" ? "import-outline-reading" : "import-outline-failed"}
        >
          {text(
            props.entry.type === "reading" ? "own.otherTools.view.outlineReading" : "own.otherTools.view.outlineFailed",
          )}
        </p>
      </Match>
    </Switch>
  )
}

/** Waits `ms`, and on while the page is hidden: nothing is asked for a view nobody sees (03 §20.2 R9). */
function waitVisible(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      if (document.visibilityState !== "hidden") return resolve()
      const shown = () => {
        if (document.visibilityState === "hidden") return
        document.removeEventListener("visibilitychange", shown)
        resolve()
      }
      document.addEventListener("visibilitychange", shown)
    }, ms)
  })
}

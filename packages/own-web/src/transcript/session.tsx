// One session's transcript (03 §4.5): session-ui projection and row renderer, the vendored virtualizer, own rows
// (turn footers) and own drawings of the switch/compaction notices. Performance contract (03 §20.2):
//   R1  the projection re-runs only when the message list changes shape; text deltas reach the row that shows them
//       (session-ui keeps the live content objects), footers and markers read only their own steps;
//   R2  only visible rows (+2 overscan) are mounted; measurements are cached per session for 16 sessions (PF7);
//   R3  events arrive once per frame (data layer EventBus), ledger/cache updates coalesced at 250 ms (OwnStore);
//   R4  markdown parses in session-ui's worker; diff/file viewers load lazily (adapter);
//   R8  only this session loads messages: 30 first, 20 per older page while scrolling up (16.4).
// Team mode (06 §9.6): a main request (`own.dispatch`) says `메인이 보냄` (or `팀이 보냄`) and shows its text without the
// envelope until `원문 보기`; a team update (`own.team.update`) in the team main folds to one line. Team words load
// with the first such row (shell/session-banners.tsx `useTeamWords`). A conversation without messages yet shows the
// folder's entry 4 (09 §6: conversations in other tools not imported yet), once per folder.
import type { SessionMessageAssistant, SessionMessageInfo, SessionStatus } from "@opencode/client/promise"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  Show,
  Suspense,
  untrack,
  type Accessor,
} from "solid-js"
import { createStore } from "solid-js/store"
import {
  createReactiveTimelineProjection,
  createSessionTimelineRowRenderer,
  getReadyMarkdown,
  SessionProgressIndicatorV2,
  SessionUiData,
  Timeline,
  TimelineRow,
} from "@/adapter/session-ui"
import { userPresentation } from "@/attachments"
import { chatView } from "@/chat-view"
import { useChatViewText } from "@/chat-view/strings"
import { openFile } from "@/files"
import { SessionFind } from "@/find"
import { useI18n } from "@/i18n"
import { useData } from "@/data"
import { ImportHint } from "@/import"
import { markAfterPaint } from "@/perf/marks"
import { continueTurn, pendingSteerActions, useQueueProblems } from "@/queue"
import { messageSender, messageSource, teamUpdateCounts, teamUpdateOf, type MessageSource } from "@/queue/model"
import { revertAction } from "@/revert"
import { ReviewChangesLink, withCommentPresentation } from "@/review"
import { useTeamWords } from "@/shell/session-banners"
import { showToast } from "@/switcher/toast"
import { presetRejection } from "@/subagent/model"
import { createToolAliases, unwrapped } from "./tool-alias"
import { PresetRejectedChip } from "@/subagent/rejected"
import type { TeamText } from "@/team/model"
import type { TeamKey } from "@/team/strings"
import { timelinePreset } from "@/timeline-settings"
import { timelineView } from "@/timeline-settings/detail"
import { createTimelineVirtualizer } from "@/vendor/timeline/virtualizer"
import { createCatalog } from "./catalog"
import { formatClock, formatClockFull } from "./format"
import { CompactionMarkerRow } from "./compaction-marker"
import { TranscriptContextProvider, useTranscript, type TranscriptContext, type TranscriptRuntime } from "./context"
import { responseBody } from "./error-body"
import { createFollow } from "./follow"
import { holdMessages } from "./held"
import { createHistory } from "./history"
import { endAt, MARGIN, span, STEP, WINDOW } from "./window"
import { TurnFooter } from "./footer"
import { createLedgerLines } from "./ledger"
import { signerOf, switchSigners } from "./signer"
import { foldedView, unfoldSession } from "@/context-reset/fold"
import ResetMarkerRow from "@/context-reset/marker"
import { beforeReset, isReset } from "@/context-reset/model"
import { markerText } from "./marker-strings"
import { markerIndex, sameCompaction, sameSwitch } from "./markers"
import { readMessages } from "./read"
import type { SwitchRecords } from "./records"
import {
  isFooter,
  pendingInputIDs,
  queuedCompactionIDs,
  rowIndexes,
  visibleMessages,
  withFooters,
  type FooterRow,
  type TranscriptRow,
} from "./rows"
import { resumable, stoppedForInactivity } from "./stall"
import { SwitchMarkerRow, switchTitle } from "./switch-marker"
import { fetchedHeavyFolder } from "./usage"
import { chatTimelineView, hiddenMeta } from "./view-filter"
import { NO_RESULTS, stateTexts, useWebSearchTitle, WebSearchLine, type SearchPart } from "@/websearch/card"
import { costOf } from "@/websearch/services"
import type { Card as ImageCard } from "@/image/line"

/** 06 §9.3 (2026-10-16): the empty team main's phrases, in the team chunk. */
const TeamMainStarter = lazy(() => import("@/team/starter"))
/** 02 §9.6 (IM): the line under an `image_generate` card, only for rows with one. */
const ImageLine = lazy(() => import("@/image/line"))
const FailClosedRow = lazy(() => import("./fail-closed"))

const BUSY: SessionStatus = { type: "busy" }
const IDLE: SessionStatus = { type: "idle" }
/** Child-session header (breadcrumb) height inside the scroll view. */
const HEADER_H = 48
/** Pages that may be pulled to find the user message of a truncated leading turn (upstream: 3). */
const LEADING_PAGES = 3

export interface SessionTranscriptProps {
  readonly runtime: TranscriptRuntime
  readonly sessionID: string
  readonly records: SwitchRecords
  /** The view is the current session of its server (cached views are detached, 03 PF7). */
  readonly selected: Accessor<boolean>
  /** Selected and not covered by a page: measure, follow and take new input. */
  readonly active: Accessor<boolean>
  readonly onNavigate: (sessionID: string) => void
  readonly sessionHref: (sessionID: string) => string
}

export function SessionTranscript(props: SessionTranscriptProps) {
  const i18n = useI18n()
  const runtime = props.runtime
  const data = runtime.data
  const id = props.sessionID
  const info = () => data.session.get(id)
  const directory = () => info()?.location.directory ?? runtime.sessions.directory(id)
  const connected = () => runtime.connection.status() === "connected"
  const catalog = createCatalog({ runtime, directory, connected })
  const status = createMemo<SessionStatus>(() => (data.session.status(id) === "running" ? BUSY : IDLE))
  const sessionStatus = new Proxy({} as Record<string, SessionStatus>, {
    get: (_, key) => (typeof key === "string" ? (data.session.status(key) === "running" ? BUSY : IDLE) : undefined),
  })
  const uiData: SessionUiData = {
    get provider() {
      return catalog.ui()
    },
    get session() {
      return data.session.list()
    },
    session_status: sessionStatus,
    session_diff: {},
  }

  // Loading (03 §16.4, R8). A reconnect invalidates createData's reads, so every `connected` of the selected view
  // re-syncs; a cached view re-syncs when it is selected again (createData skips reads that are still valid). The
  // message read is repeated when it dropped a step that started while it was in flight (read.ts).
  const [load, setLoad] = createStore({ settled: false })
  createEffect(
    on(
      () => connected() && props.selected(),
      (ok) => {
        if (!ok) return
        void Promise.all([data.session.sync(id), readMessages(data, id), data.session.pending.sync(id)])
          .then(() => enrichLeadingTurn())
          .catch((error: unknown) => console.warn("[own-web] transcript load failed", error))
          .finally(() => setLoad("settled", true))
      },
    ),
  )
  async function enrichLeadingTurn(pages = 0): Promise<void> {
    const messages = data.session.message.list(id)
    const assistant = messages.findIndex((message) => message.type === "assistant")
    const boundary = messages.findIndex((message) => message.type === "user" || message.type === "shell")
    const truncated = assistant !== -1 && (boundary === -1 || assistant < boundary)
    if (!truncated || pages >= LEADING_PAGES || !data.session.message.more(id)) return
    await data.session.message.loadMore(id)
    return enrichLeadingTurn(pages + 1)
  }
  const ready = () => data.session.message.list(id).length > 0 || load.settled

  // A complete `ses_…` id in an answer opens that session (upstream ffa4c4c730). The text may name a session of
  // another server or one that was deleted, so it is looked up on this server before the route changes (the session
  // view then loads it like any other).
  async function openReferenced(sessionID: string) {
    const found =
      data.session.get(sessionID) ??
      (await runtime
        .client()
        .session.get({ sessionID })
        .catch(() => undefined))
    if (!found) return void showToast({ message: i18n.t("own.transcript.sessionNotFound") })
    props.onNavigate(sessionID)
  }

  return (
    <Show
      when={directory()}
      fallback={
        <p class="own-transcript-state" role="status">
          {i18n.t("own.transcript.loading")}
        </p>
      }
    >
      {(dir) => (
        <SessionUiData
          data={uiData}
          directory={dir()}
          sessionID={id}
          shellRunning={(shellID) => !!data.shell.get(shellID)}
          shellOutput={(input) => runtime.client().shell.output(input)}
          onNavigateToSession={props.onNavigate}
          onSessionHref={props.sessionHref}
          openLocalFile={(path) => openFile({ serverKey: runtime.key, sessionID: id, path })}
          openSession={(sessionID) => void openReferenced(sessionID)}
        >
          <TranscriptBody {...props} status={status} ready={ready} catalog={catalog} directory={directory} />
        </SessionUiData>
      )}
    </Show>
  )
}

function TranscriptBody(
  props: SessionTranscriptProps & {
    readonly status: Accessor<SessionStatus>
    readonly ready: Accessor<boolean>
    readonly catalog: ReturnType<typeof createCatalog>
    readonly directory: Accessor<string | undefined>
  },
) {
  const i18n = useI18n()
  const words = useTeamWords()
  const runtime = props.runtime
  const own = runtime.own
  const data = runtime.data
  const id = props.sessionID
  const info = () => data.session.get(id)
  const connected = () => runtime.connection.status() === "connected"
  const servers = useData()
  /** The current team main of a team (not a replaced one): its empty conversation shows the starter phrases. */
  const teamMain = () => servers.get(runtime.key)?.team.isTeamMain(id) === true
  // 18.2 (WM): web search cards are titled with the service that answered and what it cost (ChatGPT로 검색 …).
  const server = () => servers.get(runtime.key)
  const aliases = createToolAliases({ webSearchTitle: useWebSearchTitle(server, props.directory) })

  // Cache and switch state of the open session (context meter, markers); a detached cached view lets go.
  createEffect(() => {
    if (props.selected()) onCleanup(own.watchOpen(id))
  })
  const ledger = createLedgerLines({
    own,
    sessionID: id,
    ready: () => own.state.status === "ready" && !!props.directory(),
  })

  // An inactive view keeps its last inputs (upstream `createTimelineCache` `select`): nothing re-projects while it is
  // detached or covered, and it catches up in one pass when it is shown again (03 §20.2 R8).
  // Equal values keep their identity, so re-activating an unchanged view does not re-run the projection (PF7).
  const frozen = <T,>(read: Accessor<T>, equals: (a: T, b: T) => boolean = Object.is) =>
    createMemo<T>((previous) => (props.active() ? read() : previous), read(), { equals })
  // A team update is a synthetic message without a description, which session-ui leaves out of the timeline. Once
  // delivered, its one-line summary becomes the description, so it is a notice that `TeamUpdateRow` draws (06 §9.6).
  // The copy is kept per message, so an unchanged list keeps its items (R1); the line follows the locale.
  const notices = new WeakMap<SessionMessageInfo, SessionMessageInfo>()
  const withTeamNotice = (message: SessionMessageInfo, queued: ReadonlySet<string>) => {
    if (message.type !== "synthetic" || message.description || queued.has(message.id)) return message
    const update = teamUpdateOf(message.metadata)
    const text = update && words()
    if (!update || !text) return message
    const description = updateLine(text, message.text, update.reasons)
    const known = notices.get(message)
    if (known?.type === "synthetic" && known.description === description) return known
    const notice = { ...message, description }
    notices.set(message, notice)
    return notice
  }
  // The store keeps the newest messages; older pages are this view's, bounded around the window (history.ts).
  const history = createHistory({
    read: (request) => runtime.client().message.list({ sessionID: id, ...request }),
    get: (messageID) => runtime.client().session.message.get({ sessionID: id, messageID }),
    tail: () => data.session.message.list(id),
    held: (messageID) => data.session.message.get(id, messageID) !== undefined,
    tailMore: () => data.session.message.more(id),
  })
  // The store drops live events for messages it does not hold: a page-only message they change is read again, and a
  // committed revert cuts the pages as it cut the store's list.
  onCleanup(
    data.listen(({ details }) => {
      if (details.type === "session.revert.committed")
        return void (details.data.sessionID === id && history.cut(details.data.to))
      if (details.type === "session.shell.ended")
        return void (
          details.data.sessionID === id &&
          history.refresh((message) => message.type === "shell" && message.shellID === details.data.shell.id)
        )
      if (!("assistantMessageID" in details.data) || details.data.sessionID !== id) return
      const target = details.data.assistantMessageID
      if (!data.session.message.get(id, target)) history.refresh((message) => message.id === target)
    }),
  )
  // The revert dialog and bar count the turns after a boundary the store may not hold.
  onCleanup(holdMessages(runtime.key, id, { messages: history.all, gapAfter: history.gapAfter }))
  // 4.5 `이전 대화 접기`: a folded context reset leaves the turns before it out (context-reset/fold.ts).
  const folded = createMemo(() => foldedView(runtime.key, id, history.source()))
  // A long transcript projects a window of it (window.ts): its newest message, unset while it is the tail.
  const [windowEnd, setWindowEnd] = createSignal<string>()
  /** Ends the window at `index` of the list; it stays off the tail while newer pages are still to be read. */
  const moveWindow = (index: number) => setWindowEnd(endAt(folded(), index, history.detached()))
  /** After a read: the view's pages beyond MARGIN of the window go (read again when the window comes back). */
  const trim = () => {
    const [start, end] = bounds()
    // `bounds` counts in the folded list, `keep` in the whole one: a folded reset leaves out what comes before it.
    const shift = history.source().length - folded().length
    history.keep(start - MARGIN + shift, end + MARGIN + shift)
  }
  // The store read its newest messages again (a reconnect) under a view at the tail: the pages no longer meet them.
  // A store list emptied by a committed revert is not a reread: the pages were cut with it and still meet it.
  createEffect(
    on(
      () => data.session.message.list(id)[0]?.id,
      (first) => {
        if (first !== undefined && untrack(windowEnd) === undefined && untrack(history.detached)) history.reset()
      },
      { defer: true },
    ),
  )
  // Its `[start, end)`, once per list or window change: scroll events read it, and finding the end message walks the
  // store's proxies.
  const bounds = createMemo(() => span(folded(), windowEnd()))
  const messages = frozen(() => {
    const pending = data.session.pending.list(id)
    const queued = new Set(pending.map((item) => item.id))
    const list = folded()
    // A copy: the projection then follows the list through this memo only, so a detached view stays still.
    return visibleMessages(list.slice(...bounds()), pending).map((message) =>
      aliases.wrap(withTeamNotice(message, queued)),
    )
  }, sameItems)
  const inputs = frozen(
    () => pendingInputIDs(data.session.pending.list(id)),
    (a, b) => a.size === b.size && [...a].every((item) => b.has(item)),
  )
  // A `/compact` (or `지금 압축`) admitted while the turn runs waits as `문맥 압축 대기 중` below it (2db9c2e1b3).
  const compactions = frozen(() => queuedCompactionIDs(data.session.pending.list(id)), sameItems)
  const status = frozen(props.status)
  // 19.14 `간단 / 보통 / 자세히` (설정 > 일반): session-ui's preset, its reasoning mode and tool default-open flags; the
  // chat view (4.5 대화 보기) hides thinking, tool and subagent rows on top of it.
  const view = frozen(() => chatTimelineView(timelineView(timelinePreset()), chatView()))
  const projection = createReactiveTimelineProjection({
    sessionMessages: messages,
    status,
    reasoningMode: () => view().reasoningMode,
    shellToolDefaultOpen: () => view().shellToolDefaultOpen,
    editToolDefaultOpen: () => view().editToolDefaultOpen,
    timelineDetail: () => view().detail,
    pendingInputIDs: inputs,
    queuedCompactionIDs: compactions,
  })
  const markers = createMemo(() => markerIndex(messages()))
  const stepBefore = createMemo(() => {
    const steps = messages().filter((message): message is SessionMessageAssistant => message.type === "assistant")
    return new Map(steps.slice(1).map((step, index) => [step.id, steps[index]!] as const))
  })

  // Rows: projection rows + a footer after every finished turn (the running turn gets its footer when it ends).
  const footers = new Map<string, FooterRow>()
  const working = (turnID: string) => status().type !== "idle" && projection.activeMessageID() === turnID
  const withFooter = (turnID: string) =>
    projection.messageByID().get(turnID)?.type === "user" &&
    !working(turnID) &&
    (projection.assistantMessagesByParent().get(turnID)?.length ?? 0) > 0
  const rows = createMemo<TranscriptRow[]>((previous) => withFooters(projection.rows(), withFooter, footers, previous))
  const indexes = createMemo(() => rowIndexes(rows()))
  const rowByKey = createMemo(() => new Map(rows().map((row) => [rowKey(row), row] as const)))

  const follow = createFollow({
    ready: props.ready,
    // A folded reset shows nothing older (the list starts at the reset).
    more: () => bounds()[0] > 0 || (folded() === history.source() && history.more()),
    loading: () => data.session.message.loading(id) || history.loading(),
    loadOlder: async () => {
      const [start, end] = bounds()
      if (start > 0) return void moveWindow(end - STEP)
      await history.older()
      // The page just read shows; the newer messages past the window stay (up to MARGIN of them).
      if (!follow.pinned()) moveWindow(WINDOW)
      trim()
    },
  })
  /**
   * Find (19.13) and message navigation seek a turn through the rows on screen: a turn outside the window is first
   * brought into it, about mid-window (the tail when it is that close), since moving the window by STEP per scroll is
   * far too slow for a jump across thousands of messages.
   */
  const reveal = (turnID: string, partID?: string) => {
    // A find match's part (`<messageID>:text:<n>`) may sit far down a long turn: keep it in the window too.
    const messageID = partID?.split(":", 1)[0] ?? turnID
    if (folded().some((message) => message.id === messageID)) return place(turnID, messageID)
    // A message this view dropped (or the store's, under pages far up): read its page again, then the turn's start.
    return history.around(messageID).then(async (found) => {
      // A later jump to the newest message, or another reveal, drops this one.
      const mark = history.mark()
      for (let page = 0; found && page < LEADING_PAGES && !folded().some((item) => item.id === turnID); page++)
        await history.older()
      if (found && history.mark() === mark) place(turnID, messageID)
    })
  }
  const place = (turnID: string, messageID: string) => {
    const list = folded()
    const at = list.findIndex((message) => message.id === turnID)
    const part = list.findIndex((message) => message.id === messageID)
    const [start, end] = bounds()
    // In the window already (pages read again after a jump never count as the tail).
    const inside = at >= start && Math.max(at, part) < end && (windowEnd() !== undefined || !history.detached())
    if (part < 0 || inside) return
    // Without the turn's start (a page that begins inside it), around the part.
    moveWindow(Math.max((at < 0 ? part : at) + WINDOW / 2, part + STEP))
    trim()
  }
  /** Near the bottom of a window short of the tail: move it toward the tail, reading newer pages past its end. */
  const newer = () => {
    const scroller = follow.scroller()
    if (windowEnd() === undefined || !scroller) return
    if (scroller.scrollHeight - scroller.scrollTop > scroller.clientHeight * 3) return
    const end = bounds()[1]
    if (end < folded().length || !history.detached()) return void moveWindow(end + STEP)
    void history.newer().then(() => {
      moveWindow(bounds()[1] + STEP)
      trim()
    })
  }
  // Detaching a cached view drops its scroll offset: remember it while still attached, restore it after the view is
  // attached again (a view that follows the tail re-pins itself instead).
  let savedTop: number | undefined
  createComputed(
    on(
      props.selected,
      (selected) => {
        const scroller = follow.scroller()
        if (!selected) {
          if (scroller?.isConnected) savedTop = scroller.scrollTop
          return
        }
        const top = savedTop
        if (top === undefined || follow.pinned()) return
        requestAnimationFrame(() => {
          const current = follow.scroller()
          if (current?.isConnected && !follow.pinned()) current.scrollTop = top
        })
      },
      { defer: true },
    ),
  )
  const child = () => !!info()?.parentID
  const pendingSteer = pendingSteerActions(runtime, id, useQueueProblems())
  const virtualized = createTimelineVirtualizer<TranscriptRow>({
    rowKey,
    isGap: (row) => row._tag === "TurnGap",
    isUserMessage: (row) => row._tag === "UserMessage",
    partIndex: (partID) =>
      rows().findIndex(
        (row) => row._tag === "AssistantPart" && row.group.type === "part" && row.group.ref.partID === partID,
      ),
    headerHeight: HEADER_H,
    active: props.active,
    sessionKey: () => `${runtime.key}/${id}`,
    presentationKey: () => view().presentationKey,
    projection: {
      activeMessageID: projection.activeMessageID,
      messageLastRowIndex: () => indexes().last,
      messageRowIndex: () => indexes().first,
      rowByKey,
      rows,
    },
    showHeader: child,
    pinned: follow.pinned,
    // An earlier window always offers `최신 메시지로`: new turns land past it, so its bottom is not the newest.
    scroll: () => (windowEnd() === undefined ? follow.scroll() : { ...follow.scroll(), jump: true }),
    onResumeScroll: () => {
      // From an earlier window the view's pages go with it, joined or not: the tail then projects the store's few newest
      // messages instead of a new 300-message window whose rows are built and measured anew (the jump took 55-80 ms
      // that way, 22-48 ms now; 2026-11 bench). They are read again on the way back up.
      if (windowEnd() !== undefined) history.reset()
      history.stop()
      setWindowEnd()
      follow.resume()
    },
    setScrollRef: follow.setScrollRef,
    setContentRef: follow.setContentRef,
    onScheduleScrollState: follow.scheduleScrollState,
    // Only the tail follows: the end of an earlier window moves the window instead (`newer`).
    onPin: () => windowEnd() === undefined && follow.pin(),
    onUnpin: follow.unpin,
    onSelectionInteraction: follow.selectionInteraction,
    onUserScroll: () => {},
    onHistoryScroll: () => {
      follow.onHistoryScroll()
      newer()
    },
    canRenderImmediately: (row, disclosed) => renderable(row, disclosed),
    setScrollToEnd: follow.setScrollToEnd,
  })
  const renderer = createSessionTimelineRowRenderer({
    sessionID: () => id,
    status,
    projection,
    // Attachments: the typed text and path references as cards (attachments module, 18.10), review line comments as
    // comment cards (19.1); `이 지점으로 복원` (18.7). A main request shows its text without the envelope until
    // `원문 보기` (06 §9.6, `DispatchRowView`).
    presentation: (message) => {
      const presentation = withCommentPresentation(message, userPresentation(message))
      if (messageSource(message.metadata) === "user" || virtualized.disclosure.value(dispatchKey(message.id)))
        return presentation
      return { ...presentation, displayText: OwnTeamText.unwrap(message.text) }
    },
    actions: {
      revert: revertAction(() => runtime.key),
      // 18.9: a pending steer's row offers `대기열로 옮기기` and `대기 메시지 취소` (upstream 2db9c2e1b3); not in a
      // child session (its parent steers it) or for a device without the prompt scope.
      get pending() {
        return child() || !runtime.rpc.can("prompt") ? undefined : pendingSteer
      },
    },
    reasoningMode: () => view().reasoningMode,
    shellToolDefaultOpen: () => view().shellToolDefaultOpen,
    editToolDefaultOpen: () => view().editToolDefaultOpen,
    timelineDetail: () => view().detail,
    disclosure: virtualized.disclosure,
    centered: () => false,
    padding: () => "",
  })
  const context: TranscriptContext = {
    runtime,
    sessionID: id,
    messages: history.all,
    projection,
    markers,
    status,
    ledger,
    stepBefore: (messageID) => stepBefore().get(messageID),
    records: props.records,
    catalog: props.catalog,
    disclosure: virtualized.disclosure,
  }

  // Rows that mount without waiting for a measurement pass (cold bottom mount, upstream `canRenderImmediately`).
  function renderable(row: TranscriptRow, disclosed: (key: string) => boolean | undefined) {
    if (isFooter(row) || row._tag === "TurnGap" || row._tag === "TurnDivider" || row._tag === "CompactionQueued")
      return true
    const byID = projection.messageByID()
    if (row._tag === "Notice") {
      const message = byID.get(row.messageID)
      if (message?.type === "model-switched" || message?.type === "compaction") return true
      return (
        (message?.type === "system" || message?.type === "synthetic") &&
        (message.description ?? message.text).length <= 1024
      )
    }
    if (row._tag === "UserMessage") {
      const message = byID.get(row.userMessageID)
      return (
        message?.type === "user" && message.text.length <= 1024 && !message.files?.length && !message.agents?.length
      )
    }
    if (row._tag !== "AssistantPart") return false
    if (row.group.type === "context") return row.group.refs.length <= 64 && !disclosed(`context:${row.group.key}`)
    if (row.group.type !== "part") return false
    const message = byID.get(row.group.ref.messageID)
    if (message?.type !== "assistant" || message.time.completed === undefined) return false
    const content = Timeline.resolveContent(message, row.group.ref.partID)
    if (content?.type === "reasoning") return !disclosed(row.group.ref.partID)
    return (
      content?.type === "text" &&
      content.text.length <= 1024 &&
      !!getReadyMarkdown({ raw: content.text, src: content.text }, `${row.group.ref.partID}:0:full`)
    )
  }

  const revertID = () => info()?.revert?.messageID
  // 4.5: the turns before the active context reset are dimmed like reverted ones (by position, model.ts).
  // The view's pages are older than the store's messages even while they do not meet.
  const resetBefore = createMemo(() => beforeReset(history.all()))
  /** 18.5: the last finished turn's footer carries `변경 3개 · 리뷰 →` (review module). */
  const lastTurnID = createMemo(() => rows().findLast(isFooter)?.userMessageID)
  const renderRow = (row: Accessor<TranscriptRow>, onSizeChange?: () => void) => {
    const initial = row()
    const reverted = () => {
      const from = revertID()
      return !!from && row().userMessageID >= from
    }
    const earlier = () => {
      const current = row()
      if (!resetBefore().has(current.userMessageID)) return false
      return !(current._tag === "Notice" && isReset(projection.messageByID().get(current.messageID)))
    }
    return (
      <div
        class="own-row"
        data-row={initial._tag}
        data-reverted={reverted() ? "" : undefined}
        data-before-reset={earlier() ? "" : undefined}
      >
        {isFooter(initial) ? (
          <>
            <TurnFooter turnID={initial.userMessageID} onSizeChange={onSizeChange} />
            <Show when={chatView().changes && lastTurnID() === initial.userMessageID}>
              <div class="own-turn-review">
                <ReviewChangesLink serverKey={runtime.key} sessionID={id} />
              </div>
            </Show>
            {/* 06 §4.14: team words load only for a turn that called team_need_paths. */}
            <Show
              when={
                chatView().changes &&
                fetchedHeavyFolder(projection.assistantMessagesByParent().get(initial.userMessageID) ?? []) &&
                words()
              }
            >
              {(text) => (
                <div class="own-turn-review text-own-muted" data-testid="turn-need-paths">
                  {text()("own.team.turn.needPaths")}
                </div>
              )}
            </Show>
          </>
        ) : (
          <>
            <TimelineRowView row={() => timelineRow(row())} onSizeChange={onSizeChange} />
            <SearchLineView row={() => timelineRow(row())} onSizeChange={onSizeChange} />
            <ImageLineView row={() => timelineRow(row())} onSizeChange={onSizeChange} />
          </>
        )}
      </div>
    )
  }

  /**
   * 18.2 (WM): under a row with web searches (a search card, or a group of reads and searches holding one), the line
   * that leads to 설정 > 웹 검색. A part's tool name never changes, so the row's searches are found untracked, once per
   * new row value; only their result state is followed, and a row without searches subscribes to nothing more.
   */
  function SearchLineView(rowProps: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) {
    const refs = createMemo(
      () => {
        const row = rowProps.row()
        return row._tag === "AssistantPart" ? untrack(() => searchRefs(row)) : []
      },
      [],
      { equals: (a, b) => sameItems(a.map((ref) => ref.partID), b.map((ref) => ref.partID)) },
    )
    const searches = createMemo<SearchPart[]>(() =>
      refs().map((ref) => searchPart(Timeline.resolveContent(projection.messageByID().get(ref.messageID), ref.partID))),
    )
    createEffect(on(() => refs().length > 0, () => rowProps.onSizeChange?.(), { defer: true }))
    return (
      <Show when={refs().length > 0}>
        <WebSearchLine
          server={server()}
          directory={props.directory()}
          searches={searches()}
          onSizeChange={rowProps.onSizeChange}
        />
      </Show>
    )
  }

  /**
   * 02 §9.6 (IM): under a row with `image_generate` calls, the line with the model, account, cost and image, or the
   * buttons to add a key. Found untracked like the searches; the line itself loads lazily.
   */
  function ImageLineView(rowProps: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) {
    const refs = createMemo(
      () => {
        const row = rowProps.row()
        if (row._tag !== "AssistantPart" || row.group.type === "file") return []
        const all = row.group.type === "part" ? [row.group.ref] : row.group.refs
        return untrack(() =>
          all.filter((ref) => {
            const content = Timeline.resolveContent(projection.messageByID().get(ref.messageID), ref.partID)
            return content?.type === "tool" && content.name === "image_generate"
          }),
        )
      },
      [],
      { equals: (a, b) => sameItems(a.map((ref) => ref.partID), b.map((ref) => ref.partID)) },
    )
    // Transcript pages carry no tool file bytes (`omitToolFileData`): the line reads its image's message on its own.
    const parts = createMemo(() =>
      refs().map((ref) => ({
        ...imagePart(Timeline.resolveContent(projection.messageByID().get(ref.messageID), ref.partID)),
        id: `${runtime.key}/${id}/${ref.messageID}/${ref.partID}`,
        read: () =>
          runtime
            .client()
            .session.message.get({ sessionID: id, messageID: ref.messageID })
            .then((message) => imagePart(Timeline.resolveContent(message, ref.partID)).image),
      })),
    )
    return (
      <Show when={refs().length > 0}>
        <Suspense>
          <ImageLine parts={parts()} onSizeChange={rowProps.onSizeChange} />
        </Suspense>
      </Show>
    )
  }

  /** The `websearch` tool parts of a row (a part row, or a context group's refs). */
  function searchRefs(row: TimelineRow.AssistantPart) {
    if (row.group.type === "file") return []
    const refs = row.group.type === "part" ? [row.group.ref] : row.group.refs
    return refs.filter((ref) => {
      const content = Timeline.resolveContent(projection.messageByID().get(ref.messageID), ref.partID)
      return content?.type === "tool" && content.name === "websearch"
    })
  }

  /**
   * Notices of `model-switched`/`compaction`, subagent calls the preset gate refused, main requests and team updates
   * get own drawings; every other row is session-ui's. A message's type and metadata never change, so the branch is
   * taken once per row.
   */
  function TimelineRowView(rowProps: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) {
    const initial = rowProps.row()
    const sessionUi = () => <renderer.Row row={rowProps.row} onSizeChange={rowProps.onSizeChange} />
    if (initial._tag === "AssistantPart" && initial.group.type === "context") return <ContextRowView {...rowProps} />
    if (initial._tag === "AssistantPart" && subagentRefs(initial).length) return <SplitRowView {...rowProps} />
    if (initial._tag === "UserMessage") {
      const user = projection.messageByID().get(initial.userMessageID)
      const source = user?.type === "user" ? messageSource(user.metadata) : "user"
      // 4.5 `날짜·시각` (UC 2026-10-18): when the prompt was sent, above it.
      const sent = user?.type === "user" ? user.time.created : undefined
      return (
        <>
          <Show when={chatView().clock && sent}>{(at) => <SentClock at={at()} />}</Show>
          {source === "user" ? (
            sessionUi()
          ) : (
            <DispatchRowView {...rowProps} messageID={initial.userMessageID} source={source} />
          )}
        </>
      )
    }
    if (initial._tag === "Error") return <ErrorRowView {...rowProps} />
    if (initial._tag !== "Notice") return sessionUi()
    const messageID = initial.messageID
    const message = createMemo(() => projection.messageByID().get(messageID))
    if (isTeamUpdate(message())) return <TeamUpdateRow messageID={messageID} onSizeChange={rowProps.onSizeChange} />
    if (message()?.type === "model-switched") {
      const marker = createMemo(() => markers().switches.get(messageID), undefined, { equals: sameSwitch })
      // 4.5 대화 보기: the chat view's `전환·압축 표시` hides own markers (rows stay, empty).
      return <Show when={chatView().markers && marker()}>{(current) => <SwitchMarkerRow marker={current} />}</Show>
    }
    if (message()?.type !== "compaction") return sessionUi()
    // 4.5 문맥 비우기 표시 (11 §7): the reset's own line, shown whatever `전환·압축 표시` says.
    const reset = message()
    if (isReset(reset)) {
      // The reset's `undone` changes when it is undone: read the projected message again.
      const current = () => {
        const value = message()
        return isReset(value) ? value : reset
      }
      return <ResetMarkerRow message={current} onSizeChange={rowProps.onSizeChange} />
    }
    const completed = createMemo(() => {
      const value = message()
      return value?.type === "compaction" && value.status === "completed" ? value : undefined
    })
    const marker = createMemo(() => markers().compactions.get(messageID), undefined, { equals: sameCompaction })
    return (
      <Show when={completed()} fallback={sessionUi()}>
        {(value) => (
          <Show when={chatView().markers}>
            <CompactionMarkerRow
              message={value}
              marker={marker}
              summary={sessionUi}
              onSizeChange={rowProps.onSizeChange}
            />
          </Show>
        )}
      </Show>
    )
  }

  /**
   * A context group (reads, greps … in the default `compact` preset) grows while the turn streams. It stays
   * session-ui's plain row until one of its parts is a `subagent` call or a team update, and only then draws through
   * {@link SplitRowView}. A part's tool name and a message's metadata never change, so they are read untracked, once
   * per new row value: a plain group subscribes to nothing beyond session-ui's row (03 §20.2 R1).
   */
  function ContextRowView(rowProps: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) {
    const split = createMemo(() => {
      const row = rowProps.row()
      return row._tag === "AssistantPart" && untrack(() => subagentRefs(row).length > 0 || updateRefs(row).length > 0)
    })
    return (
      <Show when={split()} fallback={<renderer.Row row={rowProps.row} onSizeChange={rowProps.onSizeChange} />}>
        <SplitRowView {...rowProps} />
      </Show>
    )
  }

  /**
   * 07 §5.4 거절 경로, §7.3: a subagent call the preset gate refused is a neutral chip, never a failure card. The default
   * `compact` preset groups subagent calls, so a context group keeps its other parts in session-ui's drawing and the
   * refused calls follow it as chips. It groups notices too: a team update (06 §9.6) is lifted out as its own line
   * before the group, since it is what started the main's run.
   */
  function SplitRowView(rowProps: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) {
    // A failed call never changes again: the same refused parts are the same chips.
    const refused = createMemo(() => refusedCalls(rowProps.row()), undefined, {
      equals: (a, b) =>
        sameItems(
          a.map((call) => call.partID),
          b.map((call) => call.partID),
        ),
    })
    const updates = createMemo(
      () => {
        const row = rowProps.row()
        return row._tag === "AssistantPart" ? updateRefs(row) : []
      },
      undefined,
      { equals: sameItems },
    )
    const lifted = () => refused().length > 0 || updates().length > 0
    const rest = createMemo(() => {
      const row = rowProps.row()
      if (!lifted() || row._tag !== "AssistantPart" || row.group.type !== "context") return undefined
      const out = new Set([...refused().map((call) => call.partID), ...updates()])
      const refs = row.group.refs.filter((ref) => !out.has(ref.partID))
      if (refs.length === 0) return undefined
      return new TimelineRow.AssistantPart({
        userMessageID: row.userMessageID,
        group: { ...row.group, refs },
        previousAssistantPart: row.previousAssistantPart,
        spacing: row.spacing,
      })
    })
    return (
      <Show when={lifted()} fallback={<renderer.Row row={rowProps.row} onSizeChange={rowProps.onSizeChange} />}>
        <For each={updates()}>
          {(messageID) => <TeamUpdateRow messageID={messageID} onSizeChange={rowProps.onSizeChange} />}
        </For>
        <Show when={rest()}>{(row) => <renderer.Row row={row} onSizeChange={rowProps.onSizeChange} />}</Show>
        <For each={refused()}>{(call) => <PresetRejectedChip rejection={call.rejection} />}</For>
      </Show>
    )
  }

  /** Team updates a context group holds (notice refs carry the message id as their part id). */
  function updateRefs(row: TimelineRow.AssistantPart) {
    if (row.group.type !== "context") return []
    return row.group.refs.flatMap((ref) =>
      ref.partID === ref.messageID && isTeamUpdate(projection.messageByID().get(ref.messageID)) ? [ref.messageID] : [],
    )
  }

  /**
   * 06 §9.6: a main request says who sent it (`메인이 보냄`, or `팀이 보냄` for the program's requests) and shows its
   * text without the envelope (the renderer's `presentation`); `원문 보기` shows the envelope as the owner read it. An
   * area message (5.8) names its sender (`'세이브 v3' 담당이 보냄`, `'세이브 v3' 동료 리뷰어의 답`), and notes that came
   * after the envelope are counted (`쪽지 1개 함께 옴`; 원문 보기 shows them).
   */
  function DispatchRowView(rowProps: {
    row: Accessor<TimelineRow.TimelineRow>
    onSizeChange?: () => void
    messageID: string
    source: Exclude<MessageSource, "user">
  }) {
    const key = dispatchKey(rowProps.messageID)
    const open = () => virtualized.disclosure.value(key) === true
    const message = () => {
      const found = projection.messageByID().get(rowProps.messageID)
      return found?.type === "user" ? found : undefined
    }
    const label = (text: TeamText) => {
      const sender = rowProps.source === "area" ? messageSender(message()?.metadata) : undefined
      if (!sender) return text(rowProps.source === "team" ? "own.team.sent.team" : "own.team.sent.main")
      if (sender.label === undefined)
        return text(sender.reply ? "own.team.sent.areaReply" : "own.team.sent.area", { area: sender.area })
      return text(sender.reply ? "own.team.sent.peerReply" : "own.team.sent.peer", {
        area: sender.area,
        label: sender.label,
      })
    }
    const notes = () => OwnTeamText.notes(message()?.text ?? "").length
    const toggle = () => {
      virtualized.disclosure.set(key, !open())
      rowProps.onSizeChange?.()
    }
    return (
      <>
        <Show when={words()}>
          {(text) => (
            <div
              class="flex items-center justify-end gap-2 px-4 pt-3 text-[12px] text-own-muted md:px-5"
              data-testid="dispatch-source"
              data-source={rowProps.source}
            >
              <span>{label(text())}</span>
              <Show when={notes() > 0}>
                <span data-testid="dispatch-notes">{text()("own.team.sent.notes", { n: notes() })}</span>
              </Show>
              <button type="button" class="own-marker-toggle" aria-expanded={open()} onClick={toggle}>
                {text()(open() ? "own.team.sent.hideOriginal" : "own.team.sent.showOriginal")}
              </button>
            </div>
          )}
        </Show>
        <renderer.Row row={rowProps.row} onSizeChange={rowProps.onSizeChange} />
      </>
    )
  }

  /**
   * 4.5: a failed turn's error card, and below it `응답 본문 보기` when core kept the provider's response body
   * (upstream c14a1f5acf: `error.response.body`), so the raw reason is there without opening logs. Closed by default.
   */
  function ErrorRowView(rowProps: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) {
    const error = createMemo(
      () => projection.assistantMessagesByParent().get(rowProps.row().userMessageID)?.at(-1)?.error,
    )
    // SLM: own stopped the turn before any model (an SSH host's sink, this PC's relay): its line, never the raw JSON.
    const ownStop = () => /"own_(?:broker_unavailable|local_relay|egress)"/.test(error()?.response?.body ?? "")
    const body = createMemo(() => {
      const failed = error()
      return failed && !ownStop() ? responseBody(failed.response?.body, failed.message) : undefined
    })
    // P-018: a stalled, timed-out or broken model stream on the newest turn can be picked up with a new prompt.
    const continuable = () =>
      resumable(error()) && rowProps.row().userMessageID === projection.activeMessageID() && status().type !== "busy"
    const key = `own-error-body:${rowProps.row().userMessageID}`
    const open = () => virtualized.disclosure.value(key) === true
    const toggle = () => {
      virtualized.disclosure.set(key, !open())
      rowProps.onSizeChange?.()
    }
    return (
      <>
        <Show when={ownStop()} fallback={<renderer.Row row={rowProps.row} onSizeChange={rowProps.onSizeChange} />}>
          <Suspense>
            <FailClosedRow
              row={rowProps.row}
              Row={renderer.Row}
              body={error()?.response?.body ?? ""}
              sessionID={id}
              runtime={runtime}
              onSizeChange={rowProps.onSizeChange}
            />
          </Suspense>
        </Show>
        <Show when={body()}>
          {(text) => (
            <div class="own-error-body" data-testid="error-body">
              <button type="button" class="own-marker-toggle" aria-expanded={open()} onClick={toggle}>
                {i18n.t(open() ? "own.transcript.errorBodyHide" : "own.transcript.errorBodyShow")}
              </button>
              <Show when={open()}>
                <pre class="own-error-body-text" tabIndex={0} aria-label={i18n.t("own.transcript.errorBody")}>
                  {text()}
                </pre>
              </Show>
            </div>
          )}
        </Show>
        <Show when={continuable()}>
          <ContinueTurn note={i18n.t("own.transcript.stalled")} />
        </Show>
      </>
    )
  }

  /** `이어서` (P-018): the queue module sends `계속` as a new prompt; it stays in the conversation. */
  function ContinueTurn(continueProps: { note: string }) {
    const [sending, setSending] = createSignal(false)
    const send = () => {
      setSending(true)
      continueTurn(runtime, id)
        .catch((error: unknown) => {
          console.warn("[own-web] continue failed", error)
          showToast({ message: i18n.t("own.transcript.continueFailed") })
        })
        .finally(() => setSending(false))
    }
    return (
      <div class="own-turn-continue" data-testid="turn-continue">
        <span>{continueProps.note}</span>
        <button type="button" class="own-marker-toggle" disabled={sending() || !connected()} onClick={send}>
          {i18n.t("own.transcript.continue")}
        </button>
      </div>
    )
  }

  /** 06 §9.6: a team update in the team main is one line, `팀 소식 · 반영 준비 1, 진행 중 1`; `원문 보기` shows it. */
  function TeamUpdateRow(rowProps: { messageID: string; onSizeChange?: () => void }) {
    const update = createMemo(() => {
      const message = projection.messageByID().get(rowProps.messageID)
      return message?.type === "synthetic" ? message : undefined
    })
    const key = `own-team-update:${rowProps.messageID}`
    const open = () => virtualized.disclosure.value(key) === true
    const toggle = () => {
      virtualized.disclosure.set(key, !open())
      rowProps.onSizeChange?.()
    }
    return (
      <Show when={update()}>
        {(message) => (
          <div data-testid="team-update">
            <div class="own-marker" data-kind="team-update" role="note">
              <span class="own-marker-pill">
                <span>{message().description}</span>
                <Show when={words()}>
                  {(text) => (
                    <button type="button" class="own-marker-toggle" aria-expanded={open()} onClick={toggle}>
                      {text()(open() ? "own.team.sent.hideOriginal" : "own.team.sent.showOriginal")}
                    </button>
                  )}
                </Show>
              </span>
            </div>
            <Show when={open()}>
              <pre class="m-0 whitespace-pre-wrap break-words px-4 pb-2 font-sans text-[12.5px] text-own-muted md:px-5">
                {message().text}
              </pre>
            </Show>
          </div>
        )}
      </Show>
    )
  }

  /** The `subagent` tool parts of a row: the only parts the preset gate can refuse. */
  function subagentRefs(row: TimelineRow.AssistantPart) {
    if (row.group.type === "file") return []
    const refs = row.group.type === "part" ? [row.group.ref] : row.group.refs
    return refs.filter((ref) => {
      const content = Timeline.resolveContent(projection.messageByID().get(ref.messageID), ref.partID)
      return content?.type === "tool" && content.name === "subagent"
    })
  }

  function refusedCalls(row: TimelineRow.TimelineRow) {
    if (row._tag !== "AssistantPart") return []
    return subagentRefs(row).flatMap((ref) => {
      const rejection = presetRejection(
        Timeline.resolveContent(projection.messageByID().get(ref.messageID), ref.partID),
      )
      return rejection ? [{ partID: ref.partID, rejection }] : []
    })
  }

  // "응답하는 중" below the rows while the turn has not started to show text (session-ui progress indicator).
  const showWorking = createMemo(() => {
    if (status().type !== "busy") return false
    const active = projection.activeMessageID()
    const assistant = active ? projection.assistantMessagesByParent().get(active)?.at(-1) : undefined
    if (assistant?.retry || assistant?.error) return false
    const content = assistant?.content.at(-1)
    return !(assistant?.time.completed === undefined && content?.type === "text" && /\S/.test(content.text))
  })

  createEffect(() => {
    if (props.ready() && rows().length > 0) markAfterPaint(`own:session-ready:${id}`)
  })

  const View = virtualized.View
  return (
    <TranscriptContextProvider value={context}>
      <div
        class="own-transcript-body"
        data-testid="transcript-body"
        data-session-id={id}
        data-pinned={follow.pinned() ? "" : undefined}
        data-hide={hiddenMeta(chatView())}
        aria-busy={status().type === "busy"}
      >
        <Show
          when={props.ready()}
          fallback={
            <p class="own-transcript-state" role="status">
              {i18n.t("own.transcript.loading")}
            </p>
          }
        >
          <Show
            when={rows().length > 0 || status().type === "busy"}
            fallback={
              // Scrolls by itself: the empty state's extras (the team main's phrases, the import hint) must never spill
              // over the composer below when the transcript is short (cards above the team main take its height).
              <div class="min-h-0 flex-1 overflow-y-auto" data-testid="transcript-empty">
                <p class="own-transcript-state">{i18n.t("own.transcript.empty")}</p>
                {/* 06 §9.3 (2026-10-16): the empty team main lists what the user can tell it (fills only). */}
                <Show when={teamMain()}>
                  <Suspense>
                    <TeamMainStarter serverKey={runtime.key} sessionID={id} />
                  </Suspense>
                </Show>
                {/* 09 §6 entry 4: a folder's conversations in other tools that are not imported yet, once. */}
                <Show when={info()?.projectID}>
                  {(projectID) => (
                    <div class="px-4">
                      <ImportHint serverKey={runtime.key} projectID={projectID()} directory={props.directory()} />
                    </div>
                  )}
                </Show>
              </div>
            }
          >
            <View
              header={<div class="own-transcript-header" style={{ height: `${HEADER_H}px` }} />}
              bottomSpacer={
                <>
                  <WorkingRow show={showWorking} />
                  {/* P-018: core stopped the turn for inactivity; its assistant only says "Step interrupted". */}
                  <Show when={status().type !== "busy" && stoppedForInactivity(data.session.message.list(id))}>
                    <div class="own-row">
                      <ContinueTurn note={i18n.t("own.transcript.inactivity")} />
                    </div>
                  </Show>
                </>
              }
              deferred={deferred}
              renderRow={renderRow}
            />
          </Show>
        </Show>
        {/* 19.13 Ctrl+F over this transcript (worker search), Ctrl+Alt+[ / ]. It seeks turns through the virtual list
            itself: handing over the virtualizer's `revealMessage` and `follow.unpin` broke far jumps (e2e/session-ux).
            `reveal` only moves the message window onto the turn. */}
        <SessionFind
          runtime={() => runtime}
          sessionID={() => id}
          active={props.active}
          scroller={follow.scroller}
          reveal={reveal}
          messages={history.all}
          covers={history.covers}
          more={history.more}
          loadingOlder={history.loading}
          loadOlder={history.older}
          onOpen={() => unfoldSession(runtime.key, id)}
        />
        <Announcer status={status} markers={markers} projection={projection} ready={props.ready} />
      </div>
    </TranscriptContextProvider>
  )

  function deferred(row: TranscriptRow) {
    if (isFooter(row) || row._tag !== "AssistantPart" || row.group.type !== "part") return false
    const content = Timeline.resolveContent(projection.messageByID().get(row.group.ref.messageID), row.group.ref.partID)
    return content?.type === "tool" && ["edit", "write"].includes(content.name)
  }
}

/** `10월 18일 오후 3:42` above a prompt; the seconds and the weekday in its tooltip (4.5 `날짜·시각`). */
function SentClock(props: { readonly at: number }) {
  const i18n = useI18n()
  const text = useChatViewText()
  return (
    <div class="own-clock" data-testid="message-clock">
      <time
        dateTime={new Date(props.at).toISOString()}
        title={text("own.clock.sent", { at: formatClockFull(i18n, props.at) })}
      >
        {formatClock(i18n, props.at)}
      </time>
    </div>
  )
}

function WorkingRow(props: { show: Accessor<boolean> }) {
  const i18n = useI18n()
  return (
    <div class="own-row own-working-row">
      <Show when={props.show()}>
        <div class="own-working" role="status" data-testid="transcript-working">
          <SessionProgressIndicatorV2 />
          <span>{i18n.t("own.transcript.working")}</span>
        </div>
      </Show>
    </div>
  )
}

/**
 * 03 §11: the transcript itself is not a live region (virtual rows come and go). A hidden `role="log"` gets the
 * finished replies (account and first sentence) and new switch markers only; streaming deltas are never announced.
 */
function Announcer(props: {
  status: Accessor<SessionStatus>
  markers: Accessor<ReturnType<typeof markerIndex>>
  projection: TranscriptContext["projection"]
  ready: Accessor<boolean>
}) {
  const i18n = useI18n()
  const context = useTranscript()
  const [log, setLog] = createStore<{ items: { id: number; text: string }[] }>({ items: [] })
  let next = 0
  const push = (text: string) => setLog("items", (items) => [...items.slice(-4), { id: next++, text }])
  const names = { own: context.runtime.own, i18n, providerName: context.catalog.providerName }

  let announced: string | undefined
  createEffect(
    on(
      () => props.status().type,
      (type, previous) => {
        if (previous !== "busy" || type !== "idle") return
        const turn = props.projection.activeMessageID()
        const assistant = turn ? props.projection.assistantMessagesByParent().get(turn)?.at(-1) : undefined
        const text = assistant?.content.findLast((content) => content.type === "text")?.text ?? ""
        // A run without a new answer (a compaction, an interrupted step) announces nothing again.
        if (!assistant || !text.trim() || assistant.id === announced) return
        announced = assistant.id
        // The account that signed the answer (SL 2026-10-26): several Claude accounts share one provider.
        const signer = signerOf(names, {
          sessionID: context.sessionID,
          providerID: assistant.model.providerID,
          line: context.ledger.line(assistant.id),
        })
        push(
          i18n.t("own.transcript.announceDone", {
            account: signer.display.label,
            text: firstSentence(text),
          }),
        )
      },
      { defer: true },
    ),
  )
  let known: Set<string> | undefined
  createEffect(() => {
    const switches = props.markers().switches
    if (!props.ready()) return
    if (!known) {
      known = new Set(switches.keys())
      return
    }
    switches.forEach((marker, messageID) => {
      if (known!.has(messageID)) return
      known!.add(messageID)
      // The accounts that signed the steps around it, as the marker names them (SL-8).
      const signers = switchSigners(names, context.sessionID, marker, context.ledger.line)
      const title = markerText.text(i18n.locale(), switchTitle(signers.kind))
      const variant = signers.kind === "variant"
      const from = variant ? (marker.from.variant ?? "default") : signers.from.display.label
      const to = variant ? (marker.to.variant ?? "default") : signers.to.display.label
      push(i18n.t("own.transcript.announceSwitch", { title, from, to }))
    })
  })
  return (
    <div class="own-sr-only" role="log" aria-live="polite" data-testid="transcript-announcer">
      <For each={log.items}>{(item) => <p>{item.text}</p>}</For>
    </div>
  )
}

function rowKey(row: TranscriptRow) {
  return isFooter(row) ? `own-footer:${row.userMessageID}` : TimelineRow.key(row)
}

/** Disclosure key of a main request's `원문 보기`. */
function dispatchKey(messageID: string) {
  return `own-dispatch:${messageID}`
}

function isTeamUpdate(message: SessionMessageInfo | undefined) {
  return message?.type === "synthetic" && teamUpdateOf(message.metadata) !== undefined
}

const UPDATE_KEYS: Readonly<Record<OwnTeamText.LineCount, TeamKey>> = {
  ready: "own.team.update.count.ready",
  blocked: "own.team.update.count.blocked",
  failed: "own.team.update.count.failed",
  waiting: "own.team.update.count.waiting",
  busy: "own.team.update.count.busy",
  done: "own.team.update.count.done",
  integrated: "own.team.update.count.integrated",
  undone: "own.team.update.count.undone",
  decided: "own.team.update.count.decided",
}

/** `팀 소식 · 반영 준비 1, 진행 중 1`; `팀 소식` alone when no area line has one of the counted words. */
function updateLine(text: TeamText, body: string, reasons: readonly string[]) {
  const counts = teamUpdateCounts(body, reasons)
  if (counts.length === 0) return text("own.team.update.title")
  return text("own.team.update.line", {
    summary: counts.map((count) => text(UPDATE_KEYS[count.kind], { n: count.n })).join(", "),
  })
}

function timelineRow(row: TranscriptRow): TimelineRow.TimelineRow {
  if (isFooter(row)) throw new Error("Expected a session-ui timeline row")
  return row
}

function firstSentence(text: string) {
  const line = text.trim().split(/\n/, 1)[0] ?? ""
  const end = line.search(/[.!?。！？](\s|$)/)
  const sentence = end >= 0 ? line.slice(0, end + 1) : line
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence
}

function sameItems<T>(a: readonly T[], b: readonly T[]) {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index]))
}

/** An `image_generate` call's result card (`metadata.ownImage`) and its image (the result's `data:` file part). */
function imagePart(content: unknown) {
  const state = (unwrapped(content) as { readonly state?: Record<string, unknown> } | undefined)?.state
  const metadata = state?.metadata as Record<string, unknown> | undefined
  const card = metadata?.ownImage as ImageCard | undefined
  const files = Array.isArray(state?.content) ? (state.content as ReadonlyArray<{ type?: unknown; uri?: unknown }>) : []
  const image = files.find((item) => item.type === "file" && typeof item.uri === "string" && item.uri.startsWith("data:image/"))
  return { ...(card ? { card } : {}), ...(image ? { image: image.uri as string } : {}) }
}

/** A search's service id (the store's own, not the card title) and whether core found nothing (`NO_RESULTS`). */
function searchPart(content: unknown): SearchPart {
  const part = unwrapped(content) as
    | {
        readonly state?: {
          readonly status?: string
          readonly metadata?: { readonly provider?: unknown }
          readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
        }
      }
    | undefined
  const state = part?.state
  const provider = state?.metadata?.provider
  const empty =
    state?.status === "completed" && !!state.content?.some((item) => item.type === "text" && item.text === NO_RESULTS)
  if (typeof provider !== "string") return { empty }
  // A multi-service search's text names the services that found its results (03 §18.2, MS).
  return costOf(provider) === "multi" ? { provider, empty, texts: stateTexts(state) } : { provider, empty }
}

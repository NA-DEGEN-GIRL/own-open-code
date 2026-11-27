// Composer module entry (03 §4.6, §5.1, §12, owner: composer). An IME-first `<textarea>` (never re-created: tiers,
// routes and sessions only swap its text, IME rule 5), the send path (steer/queue by the setting and Ctrl+Enter,
// `!` shell, new sessions on the home route, holding messages during a compact-then-switch), the pending-switch chip,
// and the toolbar: "모델 @ 계정" button, variant button, context meter and send/stop.
// P5 modules mounted here (integrator): the dock stack above the box in 4.6 order — permission/question/web search
// docks (src/requests, 18.1–18.2), then the queue panel (src/queue, 18.9); `@` mentions and `/` commands
// (src/mentions + src/commands, 18.12–18.13) get the textarea's keys first; attachments (src/attachments, 18.10):
// chips, `＋`/Ctrl+U, paste, drop over the session column; restore requests from revert and queue `편집`
// (`own:composer-restore`); a child session shows src/subagent's notice (18.11). The new-session screen adds the
// project selector (src/projects, 18.3) and the browser tool note (src/policy, 18.15); a new session is created with the
// browser rule of this window and gets the new-session approval mode (src/requests, 5.1) before its first prompt.
// P7 (integrator): the background dock after the queue (src/background, 19.7); `!` shell mode (src/shellmode) and ↑/↓
// history with chip/attachment draft persistence (src/history, 19.9) — keydown order: suggestions → IME machine →
// history → shell mode; the skills button (src/skills, 19.6); the running-shell chip and `압축 중…`/failure banner
// (src/forking, 19.12), `/fork` and `/compact` through forking; review line comments as chips, sent with the next
// prompt (src/review comments, 19.1); on the new-session screen `작업 위치` and the worktree it may create first
// (src/worktree, 19.3).
// T1 presets (07 §7.3, §5.1, §2.9): after the effort button the ultra switch (2026-10-10: right beside the effort it
// raises, with its `ⓘ` card), the speed button (02 §4.8; on the new-conversation screen it follows the target's
// offers and its pick is set before the first prompt), the preset button (`[프리셋: <이름> ▾]`, its choice is an area's
// preset in an owner conversation) and the running-subagents badge; the heavy/ultra banner above the text; a new
// session is bound to its start preset before its first prompt; the preset editor layer (lazy) renders
// `openPresetEditor` requests of the preset menu and the transcript's refusal chips.
// 보내는 키 (EM 2026-10-18, EM-10): `Ctrl+Enter로 보내기` (default) or `Enter로 보내기` (./send-key.ts) picks the keys the
// IME machine sends with; the placeholder (also shell mode's), `전송`'s tooltip, the running hint and the soft
// keyboard's Enter (`enterkeyhint`) follow it, and `▾` beside `전송` switches it (./send-key-menu.tsx).
// Contract kept by the shell: `data-own-keys="composer"` on the textarea (composer-scope shortcuts, Ctrl+B stays with
// text editing, 03 §10) and the `#own-composer-input` id.
import { hasRemoteHosts } from "@/servers/order"
import { createEffect, createMemo, createSignal, lazy, on, onCleanup, onMount, Show, Suspense, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import {
  AttachButton,
  AttachmentChips,
  AttachmentDropzone,
  createAttachments,
  draftOf,
  modelInput,
  onComposerRestore,
  restoredText,
  storeRestore,
  takeRestore,
  useAttachmentNotices,
  type ComposerRestoreDetail,
  type PromptParts,
  type ReadyAttachment,
} from "@/attachments"
import { BackgroundDock } from "@/background"
import { useCommandActions } from "@/commands"
import { useData, type ServerKey, type ServerRuntime } from "@/data"
import { nextFrame } from "@/data/frame"
import { CompactionStatus, useForkCommands } from "@/forking"
import { HistoryPosition, useComposerHistory, useDraftPersistence } from "@/history"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { useShortcut } from "@/keyboard"
import { createComposerSuggest, MentionChips, SuggestPopover, type MentionChip } from "@/mentions"
import { inputSampler } from "@/perf/event-timing"
import { BrowserToolNotice, browserPaneHeld, withBrowserPolicy } from "@/policy"
import { presetEditorRequest } from "@/presets/model"
import { ProjectSelect } from "@/projects"
import { defaultFolder, defaultFolderFailure, isDefaultFolder } from "@/projects/default-folder"
import { createQueue, useQueueProblems } from "@/queue"
import { harnessScreen, newSessionHarness } from "@/harness"
import { newSessionApproval, RequestDocks } from "@/requests"
import { useRevertCommands } from "@/revert"
import { openReview, ReviewCommentChips, reviewComments, withReviewComments, type ReviewComment } from "@/review"
import { useRouter } from "@/routing/router"
import { useShell } from "@/shell/context"
import { composerInputID, inFocusedPane, usePane } from "@/shell/pane-context"
import { createShellMode, shellAllowed, ShellModeHint, ShellRunChip, shellRuns, useShellModeText } from "@/shellmode"
import { SkillsButton } from "@/skills"
import { ChildSessionNotice } from "@/subagent"
import { DictationButton, projectHint } from "@/voice"
import { openSwitcher, PendingSwitchChip, showToast, switcherControl, type TargetRef } from "@/switcher"
import { formatTokens } from "@/switcher/format"
import { ensureCatalog, modelInfo } from "@/switcher/labels"
import {
  hostServes,
  newSessionDirectory,
  newSessionLoading,
  newSessionLookup,
  newSessionTarget,
} from "@/switcher/new-session"
import { stateOf } from "@/switcher/pending-chip"
import { continuingChildren } from "@/switcher/session"
import {
  LocationMissingNotice,
  MISSING_SEND,
  missingChoice,
  noteLocationError,
  resolveNewSessionDirectory,
  useWorktreeText,
  worktreeCreating,
  WorktreeSelect,
} from "@/worktree"
import { RunningBadge, SwitcherButton, UltraSwitch, VariantButton, type BindingView } from "./binding-button"
import { ContextMeter } from "./context-meter"
import { createDrafts, draftKey } from "./drafts"
import { createComposerInput, type SubmitResult } from "./input"
import { applyStartPreset, PresetBanner, PresetButton } from "./preset-button"
import { followUp, goneTarget, planSend, RESET_HELD, type SendPlan } from "./send"
import { sendKey, sendKeyLabels } from "./send-key"
import { SendKeyMenu } from "./send-key-menu"
import { useSendKeyText } from "./send-key-strings"
import { firstRequestAlert } from "./claude-first"
import { watchLimitFit, type LimitFold } from "./limit-fit"
import { SpeedButton } from "./speed-button"
import { startSpeed, takeNewSpeed } from "./speed-flow"
import { dropStart, pendingStart, takeStart, withStartMetadata } from "./start-intent"
import "./composer.css"

const PresetEditorLayer = lazy(() => import("@/presets/editor"))
// Shown only while something is queued, so it loads then (PF5 initial JS budget).
const ServerSelect = lazy(() => import("@/servers/new-chat"))
const QueuePanel = lazy(() => import("@/queue/panel").then((module) => ({ default: module.QueuePanel })))
const ClaudeFirstRequest = lazy(() =>
  import("@/accounts/claude-first-request").then((module) => ({ default: module.ClaudeFirstRequest })),
)
// 05 §20.5 (UPD): only a Claude Agent conversation of this PC loads it.
const ClaudeCodeNotice = lazy(() => import("@/tool-updates/notice"))
const WorktreeChatDock = lazy(() => import("@/worktree-chat/dock"))

export { followUp, type FollowUp } from "./send"
export { ContextMeter } from "./context-meter"

export interface ComposerProps {
  readonly serverKey: () => ServerKey
  /** `undefined` on the home route: the first send creates a session (5.1). */
  readonly sessionID: () => string | undefined
}

/** Auto height stops at 40 % of the viewport (03 §4.6). */
const MAX_HEIGHT_SHARE = 0.4

const drafts = createDrafts()

/** A message held during a compact-then-switch (03 §6.5) with the chips and attachments it was sent with. */
interface HeldMessage {
  readonly text: string
  readonly chips: readonly MentionChip[]
  readonly attachments?: PromptParts
}

/** Attachments and review comments (19.1) taken off a draft for a send, kept to put them back when the send fails. */
interface TakenAttachments {
  readonly parts: PromptParts
  readonly ready: readonly ReadyAttachment[]
  readonly draft: string
  readonly comments: readonly ReviewComment[]
}

export function Composer(props: ComposerProps) {
  // 03 §4.1.1: one composer per split pane; only the focused pane's textarea is `#own-composer-input`.
  const pane = usePane()
  const inputID = () => composerInputID(pane)
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  const host = useHost()
  const shellState = useShell()
  const [element, setElement] = createSignal<HTMLTextAreaElement>()
  const [local, setLocal] = createStore({
    /** Creating a session and writing its approval mode (03 §5.1 "전송 버튼을 잠근다"). */
    locked: false,
    /** Waiting for an SSH host to list the new session's model (04 §12.4): the box is read-only meanwhile. */
    hostWait: false,
    /** Messages held during a compact-then-switch, per session (03 §6.5). */
    held: {} as Record<string, HeldMessage[] | undefined>,
    /** Last `session.compaction.ended` per session, to retire the "압축을 요청했습니다" chip. */
    compactedAt: {} as Record<string, number | undefined>,
    /** Phone (03 §4.2): the folded tools (effort, ultra, speed, preset) are open under `⋯`. */
    more: false,
  })

  const runtime = () => data.get(props.serverKey())
  const session = () => {
    const id = props.sessionID()
    return id ? runtime()?.data.session.get(id) : undefined
  }
  const busy = () => {
    const id = props.sessionID()
    return id ? runtime()?.data.session.status(id) === "running" : false
  }
  const child = () => !!session()?.parentID
  const switchState = () => {
    const id = props.sessionID()
    return id ? runtime()?.own.state.switchState[id] : undefined
  }
  const connected = () => runtime()?.connection.status() === "connected"
  /** 02 §8.9: this conversation made the first request on its Claude account (the router's alert, once per account). */
  const firstRequest = () => {
    const id = props.sessionID()
    const current = runtime()
    return id && current ? firstRequestAlert(current.own.state.alerts, id) : undefined
  }
  /** Review line comments of the session waiting for the next prompt (19.1): they can be sent without text. */
  const hasComments = () => reviewComments.list(props.serverKey(), props.sessionID()).length > 0

  // ---- open-session subscriptions: binding, cache.state, switch.state, inbox (refcounted in the data layer) ----
  createEffect(() => {
    const current = runtime()
    const id = props.sessionID()
    if (!current || !id) return
    onCleanup(current.own.watchVisible([id]))
    onCleanup(current.own.watchOpen(id))
  })
  createEffect(() => {
    const current = runtime()
    const id = props.sessionID()
    if (!current || !id || current.connection.status() !== "connected") return
    // A session this window is creating is already known locally; its echo fills in the rest.
    if (untrack(() => current.data.session.creating(id))) return
    untrack(() => {
      void current.data.session.sync(id).catch(report)
      void current.data.session.pending.sync(id).catch(report)
    })
  })
  createEffect(() => {
    const current = runtime()
    if (!current) return
    onCleanup(
      current.bus.on("session.compaction.ended", (event) => setLocal("compactedAt", event.data.sessionID, Date.now())),
    )
  })
  // The root's preset view (07 §8.1 `session.preset.get`): the preset button, ultra, badge and banner read it. A child
  // follows its root's preset (07 §2.8) and shows none of them.
  createEffect(() => {
    const current = runtime()
    const id = props.sessionID()
    if (!current || !id || child()) return
    onCleanup(current.own.watchPreset(id))
  })

  // ---- the binding shown in the toolbar ----
  const newDirectory = createMemo(() => {
    const current = runtime()
    return current ? newSessionDirectory(current, router.route()) : undefined
  })
  /** What the screen's lookups read: none while the default conversation folder is not created yet (5.1). */
  const newLookup = createMemo(() => {
    const current = runtime()
    return current ? newSessionLookup(current, router.route()) : undefined
  })
  const newTarget = createMemo<TargetRef | undefined>(() => {
    const current = runtime()
    return current ? newSessionTarget(current, props.serverKey(), newDirectory()) : undefined
  })
  const view = createMemo<BindingView | undefined>(() => {
    const current = runtime()
    if (!current) return undefined
    const id = props.sessionID()
    if (!id) return { ref: newTarget() ?? null, builtin: false, unpinned: false }
    const bound = current.own.state.binding[id]
    if (bound) return { ref: bound.model, builtin: bound.builtin, unpinned: !bound.model }
    const model = current.data.session.get(id)?.model ?? current.sessions.state.sessions[id]?.model
    return model ? { ref: model, builtin: false, unpinned: false } : undefined
  })
  /** The folder lookups read: the session's (also before its info loaded, from the index), else the new screen's. */
  const directory = () => {
    const id = props.sessionID()
    if (!id) return newLookup()
    return session()?.location.directory ?? runtime()?.sessions.directory(id)
  }
  // 02 §3.3: a model registered without tools (a compat model whose server or user says so) gets no tool definitions,
  // so it only chats; the composer says so.
  const noTools = createMemo(() => {
    const current = runtime()
    const ref = view()?.ref
    return !!current && !!ref && modelInfo(current, ref, directory())?.capabilities.tools === false
  })

  // ---- attachments (18.10): per draft, like the text ----
  const attachments = createAttachments({
    host,
    runtime,
    serverKey: props.serverKey,
    sessionID: props.sessionID,
    directory,
    input: () => {
      const current = runtime()
      const ref = view()?.ref
      const info = current && ref ? modelInfo(current, ref, directory()) : undefined
      return info ? modelInput(info.capabilities) : undefined
    },
    loadInput: () => {
      const current = runtime()
      const folder = directory()
      return current && folder !== undefined
        ? current.data.location.model.sync({ directory: folder })
        : Promise.resolve(undefined)
    },
    notify: useAttachmentNotices(),
  })

  // ---- `@` mentions and `/` commands (18.12–18.13) ----
  const revert = useRevertCommands()
  const suggest = createComposerSuggest({
    element,
    draftKey: () => key(),
    disabled: () => child() || shellMode.active(),
    context: () => {
      const current = runtime()
      return current
        ? { runtime: current, serverKey: props.serverKey(), sessionID: props.sessionID(), directory: directory() }
        : undefined
    },
    actions: useCommandActions({
      restoreDraft: (text) => restore(text),
      // One implementation of /undo and /redo (the revert module's), /review opens the review tab of the session,
      // /terminal opens the terminal where the layout placed it (tab or bottom dock).
      overrides: {
        // `/fork` and `/compact`: the forking module (19.12: `압축 중…` chip and failure banner, pin/archive cleared).
        ...useForkCommands(),
        undo: async (context) => {
          if (context.sessionID) await revert.undo(context.serverKey, context.sessionID)
        },
        redo: async (context) => {
          if (context.sessionID) await revert.redo(context.serverKey, context.sessionID)
        },
        openTab: (tab, context) => {
          if (tab === "review" && context.sessionID)
            return openReview({ serverKey: context.serverKey, sessionID: context.sessionID })
          if (tab === "terminal") return shellState.openTerminal()
          shellState.openTab(tab)
        },
      },
    }),
  })

  // ---- queue/steer panel (18.9) ----
  const held = () => {
    const id = props.sessionID()
    return id ? (local.held[id] ?? []) : []
  }
  const queue = createQueue({
    runtime,
    serverKey: props.serverKey,
    sessionID: props.sessionID,
    held: () => held().map((message) => message.text),
    onProblem: useQueueProblems(),
  })

  // Model names for the toolbar: the catalog of the folder on screen, loaded when idle (and again after a reconnect).
  createEffect(() => {
    const current = runtime()
    if (!current || current.connection.status() !== "connected") return
    const folder = directory()
    untrack(() => ensureCatalog(current, folder))
  })

  // ---- drafts: swap the text per session, never while composing (rule 5) ----
  const key = () => draftKey(props.serverKey(), props.sessionID())
  let deferredLoad: string | undefined
  const load = (textarea: HTMLTextAreaElement, next: string) => {
    textarea.value = drafts.get(next)
    resize(textarea)
    // The text changed without an `input` event: an Esc-dismissed list must not stay closed for this draft.
    suggest.reset()
    shellMode.sync()
  }
  createEffect(
    on(
      key,
      (next, previous) => {
        const textarea = element()
        if (!textarea) return
        if (previous !== undefined) {
          if (input.clearing()) drafts.delete(previous)
          else drafts.set(previous, textarea.value)
        }
        if (input.composing()) return void (deferredLoad = next)
        load(textarea, next)
      },
      { defer: true },
    ),
  )
  // Revert and queue `편집` put a message back (`own:composer-restore`); the attachment store re-adds its chips itself.
  // Never while composing (rule 5): applied after the composition ends.
  let deferredRestore: ComposerRestoreDetail | undefined
  const applyRestore = (detail: ComposerRestoreDetail) => {
    const target = draftKey(detail.serverKey, detail.sessionID)
    const textarea = element()
    // 03 §4.1.1 split view: every pane's composer hears the request; the one showing the target applies it, and the
    // stored draft of a conversation no pane shows is written once.
    if (!textarea || target !== key())
      return storeRestore(detail, () => drafts.set(target, restoredText(drafts.get(target), detail)))
    takeRestore(detail)
    if (input.composing()) return void (deferredRestore = detail)
    const next = restoredText(textarea.value, detail)
    if (next === textarea.value) return
    textarea.value = next
    drafts.set(target, next)
    resize(textarea)
    suggest.reset()
    shellMode.sync()
  }
  onCleanup(onComposerRestore(applyRestore))

  // A first message another screen started (`start-intent.ts`, MH: `AI에게 설치 맡기기`): sent by itself once this
  // new-conversation screen knows its model and folder; dropped when the user changed the draft meanwhile.
  createEffect(() => {
    const serverKey = props.serverKey()
    if (props.sessionID() || !pendingStart(serverKey)) return
    // The draft lands through the restore event or the stored draft at mount, the folder and model a little later.
    const timer = setInterval(() => {
      const intent = pendingStart(serverKey)
      if (!intent) return clearInterval(timer)
      const textarea = element()
      if (!textarea || !connected() || local.locked || !newTarget() || newDirectory() === undefined) return
      if (textarea.value !== intent.text) {
        if (textarea.value.trim()) dropStart(serverKey)
        return
      }
      clearInterval(timer)
      void input.sendNow(false)
    }, 100)
    onCleanup(() => clearInterval(timer))
  })

  // The limit in `모델 @ 계정` folds by the room the toolbar has (./limit-fit.ts, UX 2026-10-27).
  const [limitFold, setLimitFold] = createSignal<LimitFold>(0)
  let bar: HTMLDivElement | undefined
  onMount(() => onCleanup(watchLimitFit(bar!, setLimitFold)))

  onMount(() => {
    const textarea = element()
    if (textarea) load(textarea, key())
    const hidden = () => document.visibilityState === "hidden" && drafts.flush()
    document.addEventListener("visibilitychange", hidden)
    onCleanup(() => document.removeEventListener("visibilitychange", hidden))
  })

  // 02 §4.7.7 (CC-14): the conversation shown here is being read while the page is visible and touched (lazy chunk).
  const presence = { stop: undefined as (() => void) | undefined, disposed: false }
  onMount(async () => {
    const { trackPresence } = await import("./presence")
    if (!presence.disposed) presence.stop = trackPresence({ rpc: () => runtime()?.own.rpc, sessionID: props.sessionID })
  })
  onCleanup(() => {
    presence.disposed = true
    presence.stop?.()
  })

  // Auto height reads layout, so it runs on the next frame, never inside the input handler (03 §20.2 R6).
  let sizing: (() => void) | undefined
  const resize = (textarea: HTMLTextAreaElement) => {
    sizing ??= nextFrame(() => {
      sizing = undefined
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, innerHeight * MAX_HEIGHT_SHARE)}px`
    })
  }

  // ---- sending ----
  const input = createComposerInput({
    element,
    submit: (text, modifier) => submit(text, modifier),
    busy,
    interrupt: () => void stop(),
    sendEmpty: () => attachments.list().length > 0 || hasComments(),
    sendKey: sendKey.value,
    cleared: () => {
      const textarea = element()
      if (textarea) resize(textarea)
      suggest.reset()
      shellMode.sync()
    },
  })

  /** The text changed without an `input` event (the consumed `!`, a history entry): save, resize, look again. */
  const changed = (text: string) => {
    drafts.set(key(), text)
    const textarea = element()
    if (textarea) resize(textarea)
    suggest.reset()
    shellMode.sync()
  }
  // ---- `!` shell mode (19.9): per draft; not in child sessions or on connections that may not prompt ----
  const shellMode = createShellMode({
    element,
    draftKey: key,
    composing: input.composing,
    disabled: () => child() || !shellAllowed(runtime()),
    changed,
  })
  const shellText = useShellModeText()
  const worktreeText = useWorktreeText()
  // ---- ↑/↓ history (19.9): a prompt list and a `!` command list; chips come back with an entry ----
  const history = useComposerHistory({
    element,
    composing: input.composing,
    mode: () => (shellMode.active() ? "shell" : "normal"),
    chips: suggest.chips,
    draftKey: key,
    changed,
  })
  // Chips and attachments (image bytes as Blobs) of each draft survive a reload (19.9, IndexedDB).
  useDraftPersistence({
    serverKey: props.serverKey,
    sessionID: props.sessionID,
    draftKey: key,
    element,
    chips: suggest.chips,
    attachments,
    text: drafts,
  })

  function plan(text: string, modifier: boolean): SendPlan {
    const current = runtime()
    const id = props.sessionID()
    return planSend({
      text,
      modifier,
      connected: connected(),
      session: id
        ? {
            busy: busy(),
            child: child(),
            switchState: switchState()?.state,
            main: current?.own.state.sessionPreset[id]?.main,
            resetPending: current?.data.session.pending.list(id).some((item) => item.type === "reset"),
          }
        : undefined,
      newSession: !newTarget()
        ? current && newSessionLoading(current)
          ? "loading"
          : "noTarget"
        : newDirectory() === undefined
          ? "noDirectory"
          : "ready",
      followUp: followUp.value(),
      shellMode: shellMode.active(),
      canPrompt: current?.rpc.can("prompt") ?? false,
      locked: local.locked || worktreeCreating(),
      attachments: attachments.list().length > 0 || hasComments(),
    })
  }

  function submit(text: string, modifier: boolean): SubmitResult {
    const current = runtime()
    if (!current) return false
    // A send a moment after the first paint of the folderless screen met `폴더를 먼저 여세요`: the default folder was
    // still on its way. It goes out once the folder is known, unless the text or the screen changed meanwhile.
    if (
      !props.sessionID() &&
      connected() &&
      router.route().name !== "project" &&
      newDirectory() === undefined &&
      defaultFolder(current).pending()
    ) {
      const from = JSON.stringify(router.route())
      void defaultFolder(current)
        .load()
        .then(() => {
          if (element()?.value === text && JSON.stringify(router.route()) === from) void input.sendNow(modifier)
        })
      return false
    }
    // The chips as they are now: the history entry keeps them (19.9); sending takes them off the draft.
    const chips = [...suggest.chipList()]
    // Client commands (`/new`, `/compact`, `/model`, `/undo` …) run here and never reach the server as text (18.13).
    const client = shellMode.active() ? undefined : suggest.submitClient(text)
    if (client) {
      drafts.delete(key())
      history.record("normal", { text, chips })
      return client.after
    }
    const next = plan(text, modifier)
    const id = props.sessionID()
    const draft = key()
    if ((next.kind === "prompt" || next.kind === "hold") && attachments.uploading()) {
      showToast({ message: i18n.t("own.composer.uploadingWait") })
      return false
    }
    switch (next.kind) {
      case "none":
        return false
      case "blocked":
        blocked(next.reason)
        return false
      // 07 §4.3: the main is gone. The draft stays and the switcher opens on the suggestion; nothing is sent.
      case "switch":
        openSwitcher({
          anchor: inFocusedPane('[data-testid="composer-switcher"]'),
          target: goneTarget(view()?.ref, next),
        })
        return false
      case "hold": {
        if (!id) return false
        drafts.delete(draft)
        history.record("normal", { text, chips })
        // Chips and attachments go with the held message, so it is sent as composed (a server command stays one).
        const message: HeldMessage = {
          text,
          chips: suggest.chips.take(draft),
          attachments: takeAttachments(text)?.parts,
        }
        setLocal("held", id, (list) => [...(list ?? []), message])
        showToast({ message: i18n.t("own.composer.heldToast") })
        return
      }
      case "shell": {
        const wasActive = shellMode.active()
        drafts.delete(draft)
        history.record("shell", { text: next.command })
        shellMode.sent()
        if (next.create) return () => void create(current, { shell: next.command, text, draft })
        void runShell(current, id!, next.command, text, wasActive)
        return
      }
      case "prompt": {
        drafts.delete(draft)
        history.record("normal", { text, chips })
        const taken = takeAttachments(text)
        if (next.create) return () => void create(current, { text, draft, taken })
        void prompt(current, id!, text, next, draft, taken)
        return
      }
    }
  }

  /**
   * The draft's attachments (18.10) and the session's review line comments (19.1) as prompt parts, taken off for the
   * send; `undefined` when there are neither.
   */
  function takeAttachments(text: string): TakenAttachments | undefined {
    const chips = attachments.list()
    const comments = reviewComments.take(props.serverKey(), props.sessionID())
    if (!chips.length && !comments.length) return undefined
    const taken = {
      parts: withReviewComments(chips.length ? attachments.prepare(text) : { text, files: [] }, {
        typed: text,
        comments,
      }),
      ready: chips.flatMap((chip) => (chip.ready ? [chip.ready] : [])),
      draft: draftOf(props.serverKey(), props.sessionID()),
      comments,
    }
    if (chips.length) attachments.clear()
    return taken
  }

  /** A failed send puts the attachments and the review comments back. */
  function giveBack(taken: TakenAttachments | undefined, sessionID: string | undefined) {
    if (!taken) return
    if (taken.ready.length) attachments.restore(taken.draft, taken.ready)
    if (sessionID) reviewComments.restore(props.serverKey(), sessionID, taken.comments)
  }

  function blocked(reason: Extract<SendPlan, { kind: "blocked" }>["reason"]) {
    if (reason === "offline") showToast({ message: i18n.t("own.composer.offline") })
    if (reason === "scope") showToast({ message: i18n.t("own.composer.scope") })
    if (reason === "loading") showToast({ message: i18n.t("own.composer.loading") })
    if (reason === "noTarget") showToast({ message: i18n.t("own.empty.accounts") })
    if (reason === "noDirectory") showToast({ message: i18n.t("own.composer.noDirectory") })
  }

  async function prompt(
    current: ServerRuntime,
    sessionID: string,
    text: string,
    next: Extract<SendPlan, { kind: "prompt" }>,
    draft: string,
    taken: TakenAttachments | undefined,
  ) {
    try {
      // 02 §5.3 method 3: an idle session with a pending switch applies it first, then prompts.
      const pending = next.applyPending ? stateOf(switchState(), "WAIT_SAFE") : undefined
      if (pending?.strategy === "now")
        await current.rpc
          .call("switch.apply", { sessionID, target: pending.target, strategy: "now", reason: pending.reason })
          .catch(report)
      // Mentions become prompt parts; `/name` of a server command goes to `session.command` (18.12–18.13). A prompt
      // queued only because a reset waits carries `RESET_HELD` (send.ts).
      await suggest.send({
        sessionID,
        text: taken?.parts.text ?? text,
        delivery: next.delivery,
        draftKey: draft,
        attachments: next.held
          ? { files: [], ...taken?.parts, metadata: { ...taken?.parts.metadata, [RESET_HELD]: true } }
          : taken?.parts,
      })
    } catch (error) {
      report(error)
      restore(text)
      giveBack(taken, sessionID)
      // 03 §8 세션 폴더 없음: the server's typed 404 shows the notice above the composer and says why.
      const folder = current.data.session.get(sessionID)?.location.directory ?? current.sessions.directory(sessionID)
      const missing = noteLocationError(current, folder, error)
      showToast({
        message: missing
          ? worktreeText(MISSING_SEND[missingChoice(current, sessionID)])
          : i18n.t("own.composer.sendFailed"),
        tone: "danger",
      })
    }
  }

  /** 19.9: `session.shell` records the command and its output without waking the agent; the chip shows it running. */
  async function runShell(
    current: ServerRuntime,
    sessionID: string,
    command: string,
    text: string,
    wasActive: boolean,
  ) {
    const result = await shellRuns(current).run(sessionID, command)
    if (result.ok) return
    report(result.error)
    if (wasActive) shellMode.enter()
    restore(text)
    showToast({ message: shellText("own.shellmode.failed"), tone: "danger" })
  }

  /**
   * 03 §5.1: create with the model always set, write the approval mode, bind the start preset (07 §5.1), set the
   * speed picked on this screen (02 §4.8), then the first prompt. The 에이전트 방식 the header pill shows (the one-time
   * pick, else the service's default, or Claude Agent 기본 on a Claude Agent model) goes into the new session's metadata
   * (10 §3.2), so its first request already uses it. Where no desktop holds the browser pane (the web fallback; a
   * paired device whose PC has no desktop app running, 05 §8.10.5) the session is created with the browser tool denied
   * (01 §17.1 #5, 05 §8.7 plan D; `withBrowserPolicy`). createData's `session.create` passes its input through to
   * `POST /api/session`, whose body has `permissions`.
   */
  async function create(
    current: ServerRuntime,
    first: {
      readonly text: string
      readonly shell?: string
      readonly draft: string
      readonly taken?: TakenAttachments
    },
  ) {
    const target = newTarget()
    const base = newDirectory()
    if (!target || base === undefined) return restore(first.text)
    setLocal("locked", true)
    // The screen the user sent from: one left during the folder steps below or the host wait is not pulled back to a
    // new session (MR12-5, decisions RL2-L3).
    const from = JSON.stringify(router.route())
    // 5.1 기본 대화 폴더: the first conversation without a project creates the folder. 19.3 `작업 위치`: the folder the
    // session starts in; `새 워크트리` creates it first (the server runs the project's startup script before it
    // answers). A failure was a toast already: put the message back and stop.
    const ready = isDefaultFolder(current, base) ? await prepareDefault(current) : base
    const folder = ready === undefined ? undefined : await resolveNewSessionDirectory(current, ready, i18n.locale())
    if (folder === undefined) {
      setLocal("locked", false)
      restore(first.text)
      if (first.taken?.ready.length) attachments.restore(first.taken.draft, first.taken.ready)
      return
    }
    // 04 §12.4 (MR11-1): an SSH host lists this PC's accounts only once its mirror arrived; wait for it. The box is
    // read-only meanwhile, and a user who leaves this screen is not pulled back to a new session (MR12-5).
    setLocal("hostWait", true)
    const served = await hostServes(current, target, folder, {
      onWait: () => showToast({ message: i18n.t("own.composer.hostWaiting") }),
      left: () => JSON.stringify(router.route()) !== from,
    }).finally(() => setLocal("hostWait", false))
    if (served === "left") {
      // Nothing is created. The text is in the input history (↑) and back in that screen's draft.
      setLocal("locked", false)
      drafts.set(first.draft, first.text)
      if (first.taken?.ready.length) attachments.restore(first.taken.draft, first.taken.ready)
      showToast({ message: i18n.t("own.composer.hostLeft") })
      return
    }
    if (served === "missing") {
      setLocal("locked", false)
      restore(first.text)
      if (first.taken?.ready.length) attachments.restore(first.taken.draft, first.taken.ready)
      showToast({ message: i18n.t("own.composer.hostNoModel"), tone: "danger" })
      return
    }
    // Before navigating: leaving this screen releases the target's speed offers the pick resolves on.
    const speed = takeNewSpeed(current.own, props.serverKey(), target)
    // A first message another screen started carries its own metadata and rules (MH's install job).
    const intent = takeStart(props.serverKey(), first.text)
    const metadata = withStartMetadata(
      newSessionHarness.metadata(props.serverKey(), harnessScreen(router.route()), target.providerID),
      intent,
    )
    const created = current.data.session.create(
      withBrowserPolicy(
        {
          model: { ...target },
          location: { directory: folder },
          ...(metadata ? { metadata } : {}),
          ...(intent && intent.permissions.length > 0 ? { permissions: [...intent.permissions] } : {}),
        },
        { browserPane: browserPaneHeld(host) },
      ),
    )
    router.navigate({ name: "session", serverKey: props.serverKey(), sessionID: created.id })
    try {
      await created.request
      // A phone (`prompt`) sets the mode picked here as this PC does (MUX-15, OwnRouting.scopeOf); `read` sets none.
      const approval = { sessionID: created.id, mode: newSessionApproval.value() }
      if (current.rpc.allowed("session.approval.set", approval))
        await current.rpc.call("session.approval.set", approval, { directory: folder }).catch(report)
      await applyStartPreset({
        runtime: current,
        local: data.local(),
        serverKey: props.serverKey(),
        sessionID: created.id,
        target,
        directory: folder,
      })
      // 02 §4.8 (2026-10-10): the speed picked on the new-conversation screen, else a fresh read of the view.
      await startSpeed(
        {
          runtime: current,
          serverKey: props.serverKey(),
          i18n,
          fastAck: () => data.local().rpc.call("plugin.claudeAuth.fastAck", {}),
        },
        created.id,
        speed,
      )
      switcherControl.remember(target)
      if (first.shell !== undefined) {
        const result = await shellRuns(current).run(created.id, first.shell)
        if (!result.ok) throw result.error
      } else
        await suggest.send({
          sessionID: created.id,
          text: first.taken?.parts.text ?? first.text,
          draftKey: first.draft,
          attachments: first.taken?.parts,
        })
    } catch (error) {
      report(error)
      restore(first.text)
      if (first.taken?.ready.length) attachments.restore(first.taken.draft, first.taken.ready)
      showToast({ message: i18n.t("own.composer.sendFailed"), tone: "danger" })
    } finally {
      setLocal("locked", false)
    }
  }

  /** The default conversation folder, created on its first use; `undefined` after a toast that says why it is not. */
  async function prepareDefault(current: ServerRuntime) {
    const view = await defaultFolder(current)
      .ensure()
      .catch((error: unknown) => {
        report(error)
        showToast({ message: defaultFolderFailure(i18n.locale(), error), tone: "danger" })
        return undefined
      })
    return view?.path
  }

  /** Puts a text back when the box is empty (failed send, 편집 of a queued message). Never while composing. */
  function restore(text: string) {
    const textarea = element()
    if (!textarea || input.composing() || textarea.value) return
    textarea.value = text
    drafts.set(key(), text)
    resize(textarea)
    shellMode.sync()
  }

  async function stop() {
    const current = runtime()
    const id = props.sessionID()
    if (!current || !id) return
    try {
      await current.client().session.interrupt({ sessionID: id })
    } catch (error) {
      report(error)
    }
  }

  // Held messages go out once the compact-then-switch finished (or was cancelled): `switch.recorded` moves the state
  // out of COMPACTING (03 §6.5 "붙잡아 둔 메시지를 보낸다").
  createEffect(() => {
    const current = runtime()
    if (!current) return
    for (const [sessionID, list] of Object.entries(local.held)) {
      if (!list?.length || current.own.state.switchState[sessionID]?.state === "COMPACTING") continue
      untrack(() => {
        const messages = [...list]
        setLocal("held", sessionID, [])
        void (async () => {
          // In order, one after the other: the router turns follow-ups of a busy session into `queue`.
          for (const message of messages)
            await suggest
              .send({
                sessionID,
                text: message.attachments?.text ?? message.text,
                chips: message.chips,
                attachments: message.attachments,
              })
              .catch(report)
        })()
      })
    }
  })

  // ---- shortcuts (composer scope, 03 §10) ----
  useShortcut("composer.focus", () => element()?.focus())
  useShortcut("composer.shellMode", () => shellMode.enter())
  useShortcut("composer.shellExit", () => shellMode.exit())
  useShortcut("composer.queueEditFirst", () => queue.editFirst())
  useShortcut("composer.attach", () => {
    if (child()) return false
    attachments.pick()
  })

  // ---- view state ----
  const children = () => {
    const current = runtime()
    const id = props.sessionID()
    return current && id ? continuingChildren(current, id) : 0
  }
  // 02 §8.10.12: every Claude Agent process is protected, so this conversation's claude waits for a free slot.
  const poolWait = () => {
    const pool = runtime()?.own.state.claudeAgentPool
    const id = props.sessionID()
    return pool && id && pool.waiting.some((item) => item.sessionID === id) ? pool : undefined
  }
  const compactionChip = () => {
    const current = runtime()
    const id = props.sessionID()
    const requested = current && id ? current.own.state.compactionRequested[id] : undefined
    if (!requested || !id) return undefined
    return requested.at > (local.compactedAt[id] ?? 0) ? requested : undefined
  }
  const sendKeyText = useSendKeyText()
  const keys = () => sendKeyLabels(sendKey.value())
  const placeholder = () => {
    if (child()) return i18n.t("own.child.composerDisabled")
    // A touch screen sends with the button: no key hint. In shell mode this placeholder replaces the send hint, so it
    // names the key under both choices; otherwise only Ctrl+Enter (the default) is named, Enter to send needs no hint.
    const touch = host.capabilities.touch
    if (shellMode.visual())
      return touch
        ? i18n.t("own.composer.placeholderShell")
        : sendKeyText("own.sendKey.placeholderShell", { send: keys().send })
    if (sendKey.value() === "modEnter" && !touch) return sendKeyText("own.sendKey.placeholder", { send: keys().send })
    return i18n.t("own.composer.placeholder")
  }
  // A touch screen (MUX): what a send does and where Stop is, not the keys of a keyboard it does not have.
  const hint = () => {
    const steer = followUp.value() === "steer"
    if (host.capabilities.touch)
      return i18n.t(steer ? "own.composer.hintBusySteerTouch" : "own.composer.hintBusyQueueTouch")
    return i18n.t(steer ? "own.composer.hintBusySteer" : "own.composer.hintBusyQueue", {
      send: keys().send,
      other: keys().other,
    })
  }

  return (
    <div class="own-cp" data-testid="composer" data-session-id={props.sessionID()} data-busy={busy() ? "" : undefined}>
      <div class="own-cp-inner">
        {/* Dock stack (4.6): what stops the turn first — permissions, questions, web search — then the queue. */}
        <RequestDocks serverKey={props.serverKey} sessionID={props.sessionID} />
        <Show when={queue.rows().length > 0}>
          <Suspense>
            <QueuePanel
              queue={queue}
              onHeldCancel={(index) => {
                const id = props.sessionID()
                if (id) setLocal("held", id, (list) => list?.filter((_, at) => at !== index))
              }}
            />
          </Suspense>
        </Show>
        {/* 19.7: `● 실행 중: … [백그라운드로 Alt+B]` and `⧗ 백그라운드 n` (after the queue, 4.6 order). */}
        <BackgroundDock serverKey={props.serverKey} sessionID={props.sessionID} />
        {/* 4.6.1: worktree conversations this one started, or the one that started it (metadata `own.worktreeChat`). */}
        <Show when={props.sessionID() && runtime()?.data.session.get(props.sessionID()!)?.metadata?.["own.worktreeChat"]}>
          <Suspense>
            <WorktreeChatDock serverKey={props.serverKey} sessionID={props.sessionID} />
          </Suspense>
        </Show>
        {/* 03 §8 세션 폴더 없음: the session's folder is gone; choose where it continues. */}
        <LocationMissingNotice serverKey={props.serverKey} sessionID={props.sessionID} />
        <div class="own-cp-box" data-shell={shellMode.visual() ? "" : undefined} data-child={child() ? "" : undefined}>
          <Show when={runtime() && props.sessionID()}>
            <PendingSwitchChip
              runtime={runtime()!}
              sessionID={props.sessionID()!}
              held={held().length}
              children={children()}
            />
          </Show>
          <Show when={poolWait()}>
            {(pool) => (
              <div class="own-sw-chip-line" role="status" data-testid="claude-agent-pool-wait">
                <span class="own-sw-chip-icon" aria-hidden="true">
                  ⧗
                </span>
                <span class="min-w-0 flex-1">
                  {i18n.t("own.composer.poolWait", { live: pool().live, cap: pool().cap })}
                </span>
              </div>
            )}
          </Show>
          {/* 05 §20.5 (UPD): this PC's Claude Code is older than the Claude Agent route needs or works best with. */}
          <Show when={view()?.ref?.providerID === "claude-agent" && runtime() === data.local() && !child()}>
            <Suspense>
              <ClaudeCodeNotice runtime={runtime()!} />
            </Suspense>
          </Show>
          {/* 02 §8.9 (CW): the first request on this Claude account may be billed as extra usage; it never holds a send. */}
          <Show when={firstRequest()}>
            {(alert) => (
              <Suspense>
                <ClaudeFirstRequest runtime={runtime()!} sessionID={props.sessionID()!} alertID={alert().id} />
              </Suspense>
            )}
          </Show>
          {/* 07 §5.1, §2.9: ultra's usage line, or a heavy preset's (and an owner's team worst case). */}
          <Show when={runtime() && props.sessionID() && !child()}>
            <PresetBanner runtime={runtime()!} sessionID={props.sessionID()!} view={view()} />
          </Show>
          <Show when={compactionChip()}>
            {(requested) => (
              <div class="own-sw-chip-line" role="status" data-testid="compaction-requested">
                <span class="own-sw-chip-icon" aria-hidden="true">
                  ⊟
                </span>
                <span class="min-w-0 flex-1">
                  {i18n.t("own.compact.due", { tokens: formatTokens(requested().triggerTokens) })}
                </span>
              </div>
            )}
          </Show>
          {/* 19.9 a running `!` command, 19.12 `압축 중…` or the compaction failure banner. */}
          <Show when={runtime() && props.sessionID()}>
            <ShellRunChip runtime={runtime()!} sessionID={props.sessionID()!} />
            <CompactionStatus runtime={runtime()!} sessionID={props.sessionID()!} />
          </Show>
          {/* 19.1 review line comments that go with the next message. */}
          <ReviewCommentChips serverKey={props.serverKey} sessionID={props.sessionID} />
          <AttachmentChips attachments={attachments} />
          <MentionChips suggest={suggest} />
          <label class="own-sr-only" for={inputID()}>
            {placeholder()}
          </label>
          <SuggestPopover suggest={suggest} />
          <textarea
            id={inputID()}
            ref={setElement}
            data-own-keys="composer"
            rows={2}
            class="own-cp-text"
            placeholder={placeholder()}
            readOnly={child() || local.hostWait}
            aria-disabled={child() || local.hostWait || undefined}
            autocomplete="off"
            spellcheck={false}
            enterkeyhint={sendKey.value() === "enter" ? "send" : "enter"}
            aria-autocomplete="list"
            aria-controls={suggest.visible() ? suggest.listbox : undefined}
            aria-activedescendant={suggest.activeDescendant()}
            onKeyDown={(event) => {
              // An open `@`/`/` list takes ↑ ↓ Tab Enter Esc first (IME-safe, 03 §12 rule 9).
              if (suggest.keydown(event)) return inputSampler.record(event)
              // Then the IME machine (Enter), then ↑/↓ history, then shell mode's Esc/Backspace on an empty box (19.9);
              // the history and shell mode never take a key of a composition.
              if (!input.keydown(event) && !history.keydown(event)) shellMode.keydown(event)
              inputSampler.record(event)
            }}
            onKeyUp={(event) => {
              suggest.keyup(event)
              input.keyup(event)
            }}
            onCompositionStart={(event) => {
              input.compositionstart()
              suggest.compositionstart()
              inputSampler.record(event)
            }}
            onCompositionEnd={(event) => {
              input.compositionend()
              suggest.compositionend()
              if (deferredLoad !== undefined) {
                const next = deferredLoad
                deferredLoad = undefined
                const textarea = event.currentTarget
                nextFrame(() => load(textarea, next))
              }
              if (deferredRestore) {
                const detail = deferredRestore
                deferredRestore = undefined
                nextFrame(() => applyRestore(detail))
              }
              inputSampler.record(event)
            }}
            onInput={(event) => {
              input.input()
              // `!` typed into an empty box (not during a composition) switches to shell mode and is consumed.
              shellMode.input(event)
              suggest.input()
              drafts.set(key(), event.currentTarget.value)
              resize(event.currentTarget)
              inputSampler.record(event)
            }}
            onPaste={(event) => {
              if (!child()) attachments.paste(event)
            }}
            onFocus={() => suggest.focus()}
            onBlur={() => suggest.blur()}
            onClick={() => suggest.click()}
          />
          <div
            ref={bar}
            class="own-cp-bar"
            data-more={local.more ? "" : undefined}
            data-new={props.sessionID() ? undefined : ""}
            data-fold={limitFold() || undefined}
            // The header's running-on pill is there (it shows for a bound session): the phone hides this toolbar's
            // button (composer.css).
            data-pill={props.sessionID() && runtime()?.own.state.binding[props.sessionID()!] ? "" : undefined}
          >
            <AttachButton attachments={attachments} disabled={child()} />
            {/* 19.6 `✦ 스킬`: the skill list (lazy popover), a chip for the next message or `바로 실행`. */}
            <SkillsButton
              runtime={runtime}
              sessionID={props.sessionID}
              directory={directory}
              addChip={suggest.addChip}
              disabled={() => child() || shellMode.active()}
            />
            {/* 03 §4.6 받아쓰기 (02 §3.9): the transcript goes in at the cursor, never sent; Ctrl+Alt+V to talk. */}
            <DictationButton
              target={element}
              shortcut="default"
              disabled={child}
              hint={() =>
                projectHint({
                  runtime: runtime(),
                  directory: directory(),
                  sessionID: props.sessionID(),
                  draft: element()?.value ?? "",
                })
              }
              testid="composer-voice"
            />
            <Show when={shellMode.visual()}>
              <span class="own-sw-tag own-cp-shell-tag" data-testid="shell-tag">
                {i18n.t("own.composer.shellMode")}
              </span>
            </Show>
            {/* New-session screen (5.1, 18.3, 19.3): the folder the next session starts in, then 작업 위치. */}
            <Show when={!props.sessionID()}>
              {/* 5.1 (2.2.6-own.16): which server the conversation starts on, while SSH hosts exist. */}
              <Show when={hasRemoteHosts()}>
                <ServerSelect serverKey={props.serverKey()} phone={shellState.mode().sidebarMode === "list"} />
              </Show>
              <ProjectSelect
                directory={newDirectory}
                serverKey={props.serverKey()}
                phone={() => shellState.mode().sidebarMode === "list"}
              />
              <WorktreeSelect directory={newDirectory} serverKey={props.serverKey()} />
              {/* Where on the first line, who and how on the second (the 2026-10-10 review: no stray wrap). */}
              <span class="own-cp-break" aria-hidden="true" />
            </Show>
            <Show when={runtime()}>
              {(current) => (
                <>
                  <SwitcherButton
                    runtime={current()}
                    view={view()}
                    sessionID={props.sessionID()}
                    disabled={child()}
                    fold={limitFold()}
                  />
                  <VariantButton
                    runtime={current()}
                    serverKey={props.serverKey()}
                    sessionID={props.sessionID()}
                    view={view()}
                  />
                  {/* 07 §7.3 (2026-10-10): `울트라 ○` right after the effort it raises, then `속도`, `[프리셋: <이름> ▾]`
                      and `하위 에이전트 2/3 실행 중 · 이 메시지 5개`. A child follows its root and shows none of them. */}
                  <Show when={!child()}>
                    <UltraSwitch runtime={current()} sessionID={props.sessionID()} view={view()} />
                    {/* 02 §4.8: `속도: 표준 | Fast | Ultrafast`, a root session's own; on the new-conversation screen
                        the target's offers and a pending choice. */}
                    <SpeedButton
                      runtime={current()}
                      serverKey={props.serverKey()}
                      sessionID={props.sessionID()}
                      target={props.sessionID() ? undefined : newTarget()}
                    />
                    <PresetButton
                      runtime={current()}
                      serverKey={props.serverKey()}
                      sessionID={props.sessionID()}
                      view={view()}
                    />
                    <RunningBadge runtime={current()} sessionID={props.sessionID()} />
                    {/* A narrow composer only (a phone, or the sidebar and the work panel open, 03 §4.6): opens the folded tools. */}
                    <button
                      type="button"
                      class="own-cp-tool own-cp-more"
                      data-testid="composer-more"
                      aria-expanded={local.more}
                      aria-label={i18n.t("own.composer.moreTools")}
                      title={i18n.t("own.composer.moreTools")}
                      onClick={() => setLocal("more", !local.more)}
                    >
                      <span aria-hidden="true" class="own-ico own-ico-more" />
                    </button>
                  </Show>
                </>
              )}
            </Show>
            <span class="own-cp-grow" />
            <Show when={runtime() && props.sessionID()}>
              <ContextMeter runtime={runtime()!} sessionID={props.sessionID()!} />
            </Show>
            <Show
              when={busy()}
              fallback={
                <span class="own-cp-send-group">
                  <button
                    type="button"
                    class="own-cp-send"
                    data-testid="composer-send"
                    disabled={!connected() || local.locked || worktreeCreating() || child()}
                    title={
                      connected()
                        ? i18n.t("own.composer.sendTitle", { send: keys().send, newline: keys().newline })
                        : i18n.t("own.composer.offline")
                    }
                    onClick={() => void input.sendNow(false)}
                  >
                    <span aria-hidden="true">↵</span> {i18n.t("own.composer.send")}
                  </button>
                  <SendKeyMenu />
                </span>
              }
            >
              <button
                type="button"
                class="own-cp-send own-cp-stop"
                data-testid="composer-stop"
                title={i18n.t("own.composer.stopHint")}
                onClick={() => void stop()}
              >
                <span aria-hidden="true">■</span> {i18n.t("own.composer.stop")}
              </button>
            </Show>
          </div>
        </div>
        {/* 19.9: which history entry is on screen, and what a shell-mode send does. */}
        <HistoryPosition history={history} mode={() => (shellMode.active() ? "shell" : "normal")} />
        <ShellModeHint shell={shellMode} />
        <Show when={busy() && !child()}>
          <p class="own-cp-hint" data-testid="composer-hint">
            {hint()}
          </p>
        </Show>
        <Show when={child()}>
          <ChildSessionNotice serverKey={props.serverKey} sessionID={props.sessionID} />
        </Show>
        <Show when={noTools() && !child()}>
          <div class="own-cp-note">
            <p
              class="m-0 flex items-start gap-1.5 text-[12px] leading-[16px] text-own-muted"
              role="note"
              data-testid="composer-no-tools"
            >
              <span aria-hidden="true">ⓘ</span>
              <span>{i18n.t("own.composer.noTools")}</span>
            </p>
          </div>
        </Show>
        {/* 18.15: on the new-session screen of a window without the browser pane, what the next session gets. */}
        <Show when={!props.sessionID()}>
          <div class="own-cp-note">
            <BrowserToolNotice serverKey={props.serverKey()} />
          </div>
        </Show>
      </div>
      <AttachmentDropzone
        attachments={attachments}
        target={() => element()?.closest<HTMLElement>(".own-session") ?? undefined}
        enabled={() => !child()}
      />
      {/* 07 §7.1, §7.3: `새 프리셋…`, `편집…` and `[하위 에이전트에 추가…]` open the editor (a lazy chunk). */}
      <Show when={presetEditorRequest()}>
        <Suspense>
          <PresetEditorLayer />
        </Suspense>
      </Show>
    </div>
  )
}

function report(error: unknown) {
  console.error("[own-web] composer", error)
}

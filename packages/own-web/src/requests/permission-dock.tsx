// Permission dock (03 §18.1; rewritten on session-ui DockPrompt after packages/app/src/session/requests/
// session-permission-dock.tsx with own strings and keys). The header says what is asked: the command (monospace,
// folded when long), the files with their change counts and a diff preview, or the URL. `한 번 허용` (Enter) /
// `항상 허용` (Ctrl+Enter, the saved scope written under it) / `거절…` (Esc opens an optional reason for the agent;
// Esc on an empty reason denies without one). Keys act only while the dock has focus; it never takes focus itself.
import type { PermissionReply } from "@opencode/client"
import { ProtectedPaths } from "@own/protocol/protected-paths"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData, type ServerKey } from "@/data"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { commitComposition, createImeEnter } from "@/ime/ime-enter"
import {
  actionKind,
  alwaysScope,
  fetchDetail,
  filePreviews,
  folds,
  patchLines,
  quoted,
  subjects,
  type FilePreview,
} from "./describe"
import { composing, frameRef, Head, isEnterKey, isEscapeKey, Kbd, MOD_ENTER, titleID } from "./dock-parts"
import type { RequestItem, RequestModel } from "./model"
import { useRequestsText, type RequestsText } from "./strings"
import { DockPrompt } from "@/adapter/dock-prompt"
import { formatBytes } from "@/files/strings"

type PermissionItem = Extract<RequestItem, { kind: "permission" }>

export function PermissionDock(props: {
  readonly item: PermissionItem
  readonly model: RequestModel
  readonly serverKey: ServerKey
  readonly onDone: (hadFocus: boolean) => void
}) {
  const i18n = useI18n()
  const text = useRequestsText()
  const id = titleID()
  const request = () => props.item.request
  const kind = createMemo(() => actionKind(request().action))
  const busy = () => props.model.busy(props.item.key)
  const data = useData()
  // 05 §13.5 "권한 응답은 한 번만": a paired device may allow once or reject; "always" is saved on the PC only (the
  // gateway refuses it anyway). A command naming a protected path asks every time (01 §13 PP), so its card has none.
  const alwaysAllowed = () =>
    data.get(props.serverKey)?.entry()?.auth !== "device" && !ProtectedPaths.isShellNote(request().message)
  const [rejecting, setRejecting] = createSignal(false)
  const [folded, setFolded] = createSignal(true)
  let root: HTMLDivElement | undefined
  let reason: HTMLInputElement | undefined

  const title = () =>
    kind() === "other"
      ? text("own.requests.title.other", { action: request().action })
      : text(`own.requests.title.${kind() as Exclude<ReturnType<typeof kind>, "other">}`)

  async function decide(decision: PermissionReply, message?: string) {
    const hadFocus = !!root?.contains(document.activeElement)
    if (await props.model.decide(request(), decision, message)) props.onDone(hadFocus)
  }

  function openReject() {
    setRejecting(true)
    nextFrame(() => reason?.focus())
  }

  function closeReject() {
    setRejecting(false)
    root?.focus()
  }

  async function sendReject() {
    if (!reason) return
    await commitComposition(reason, ime.composing())
    await decide("reject", reason.value.trim() || undefined)
  }

  const ime = createImeEnter({ onEnter: () => void sendReject() })

  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || composing(event)) return
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    if (isEnterKey(event) && mod) {
      event.preventDefault()
      return void decide(alwaysAllowed() ? "always" : "once")
    }
    // Enter on a focused button clicks it; on the dock itself it allows once.
    if (isEnterKey(event) && target === event.currentTarget && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.shiftKey) return
      event.preventDefault()
      return void decide("once")
    }
    if (isEscapeKey(event) && !rejecting()) {
      event.preventDefault()
      event.stopPropagation()
      openReject()
    }
  }

  return (
    <DockPrompt
      kind="permission"
      ref={(element) => {
        root = element
        frameRef(id, `Enter ${MOD_ENTER} Escape`)(element)
        element.dataset.testid = "permission-dock"
        element.dataset.action = request().action
      }}
      onKeyDown={keydown}
      header={<Head id={id} kind="permission" title={title()} origin={props.item.origin} serverKey={props.serverKey} />}
      footer={
        <Show
          when={rejecting()}
          fallback={
            <>
              <div class="own-rq-actions">
                <button
                  type="button"
                  class="own-rq-btn"
                  data-variant="ghost"
                  data-testid="permission-reject"
                  disabled={busy()}
                  aria-keyshortcuts="Escape"
                  onClick={openReject}
                >
                  {i18n.t("own.perm.reject")} <Kbd keys="esc" />
                </button>
                <Show when={alwaysAllowed()}>
                  <button
                    type="button"
                    class="own-rq-btn"
                    data-testid="permission-always"
                    disabled={busy()}
                    aria-keyshortcuts={MOD_ENTER}
                    aria-describedby={`${id}-scope`}
                    onClick={() => void decide("always")}
                  >
                    {i18n.t("own.perm.always")} <Kbd keys="modEnter" />
                  </button>
                </Show>
                <button
                  type="button"
                  class="own-rq-btn"
                  data-variant="primary"
                  data-testid="permission-once"
                  disabled={busy()}
                  aria-keyshortcuts="Enter"
                  onClick={() => void decide("once")}
                >
                  {i18n.t("own.perm.once")} <Kbd keys="enter" />
                </button>
              </div>
              {/* What `항상 허용` would cover: without that button (a phone, MUX) the line described nothing on screen. */}
              <Show when={alwaysAllowed()}>
                <p class="own-rq-scope" id={`${id}-scope`} data-testid="permission-scope">
                  {scopeText(text, request())}
                </p>
              </Show>
            </>
          }
        >
          <div class="own-rq-reason" data-testid="permission-reason">
            <label class="own-sr-only" for={`${id}-reason`}>
              {i18n.t("own.perm.rejectReason")}
            </label>
            <input
              ref={reason}
              id={`${id}-reason`}
              class="own-rq-input"
              data-testid="permission-reason-input"
              placeholder={i18n.t("own.perm.rejectReason")}
              autocomplete="off"
              spellcheck={false}
              disabled={busy()}
              onKeyDown={(event) => {
                if (ime.keydown(event)) return
                if (!isEscapeKey(event)) return
                event.preventDefault()
                event.stopPropagation()
                // 03 §18.1: Esc twice denies without a reason; with text typed, Esc only closes the reason.
                if (!event.currentTarget.value.trim()) return void decide("reject")
                closeReject()
              }}
              onKeyUp={(event) => ime.keyup(event)}
              onCompositionStart={() => ime.compositionstart()}
              onCompositionEnd={() => ime.compositionend()}
              onInput={() => ime.input()}
            />
            <p class="own-rq-note">{text("own.requests.rejectHint")}</p>
            <p class="own-rq-note">{text("own.requests.rejectEffect")}</p>
            <Show when={props.model.siblings(request()) > 0}>
              <p class="own-rq-warn" data-testid="permission-reject-others">
                {text("own.requests.rejectOthers", { n: props.model.siblings(request()) })}
              </p>
            </Show>
            <div class="own-rq-actions">
              <button type="button" class="own-rq-btn" data-variant="ghost" disabled={busy()} onClick={closeReject}>
                {text("own.requests.rejectCancel")}
              </button>
              <button
                type="button"
                class="own-rq-btn"
                data-variant="danger"
                data-testid="permission-reject-send"
                disabled={busy()}
                onClick={() => void sendReject()}
              >
                {text("own.requests.rejectSend")}
              </button>
            </div>
          </div>
        </Show>
      }
    >
      <Show when={kind() === "shell"}>
        <Command lines={subjects(request())} folded={folded()} onToggle={() => setFolded((value) => !value)} />
      </Show>
      <Show when={kind() === "edit"}>
        <Files request={request()} />
      </Show>
      <Show when={kind() === "webfetch"}>
        <For each={subjects(request())}>
          {(url) => (
            <p class="own-rq-url m-0" data-testid="permission-url">
              {url}
            </p>
          )}
        </For>
        <Show when={fetchDetail(request())}>
          {(detail) => (
            <p class="own-rq-note" data-testid="permission-fetch-detail">
              {[
                detail().method,
                detail().headers.length > 0 && text("own.requests.fetchHeaders", { names: detail().headers.join(", ") }),
                detail().bytes !== undefined &&
                  text("own.requests.fetchBody", { size: formatBytes(i18n.locale(), detail().bytes ?? 0) }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </Show>
      </Show>
      <Show when={kind() !== "shell" && kind() !== "edit" && kind() !== "webfetch" && subjects(request()).length > 0}>
        <Command lines={subjects(request())} folded={folded()} onToggle={() => setFolded((value) => !value)} />
      </Show>
      <Show when={request().message}>{(message) => <p class="own-rq-note">{message()}</p>}</Show>
    </DockPrompt>
  )
}

function Command(props: {
  readonly lines: readonly string[]
  readonly folded: boolean
  readonly onToggle: () => void
}) {
  const text = useRequestsText()
  const joined = () => props.lines.join("\n")
  const long = () => folds(joined())
  return (
    <>
      <pre class="own-rq-code" data-testid="permission-command" data-folded={long() && props.folded ? "" : undefined}>
        {joined()}
      </pre>
      <Show when={long()}>
        <button type="button" class="own-rq-link self-start" aria-expanded={!props.folded} onClick={props.onToggle}>
          {props.folded
            ? `${text("own.requests.expand")} (${text("own.requests.lines", { n: joined().split("\n").length })})`
            : text("own.requests.collapse")}
        </button>
      </Show>
    </>
  )
}

/** Edit requests: each file with `+a −d`; `변경 보기` shows the patch core attached (no diff engine here). */
function Files(props: { readonly request: PermissionItem["request"] }) {
  const text = useRequestsText()
  const previews = createMemo(() => filePreviews(props.request))
  const [open, setOpen] = createStore<Record<string, boolean | undefined>>({})
  return (
    <Show
      when={previews().length > 0}
      fallback={
        <ul class="own-rq-files">
          <For each={subjects(props.request)}>
            {(path) => (
              <li class="own-rq-file">
                <span class="own-rq-path">{path}</span>
              </li>
            )}
          </For>
        </ul>
      }
    >
      <ul class="own-rq-files" data-testid="permission-files">
        <For each={previews()}>
          {(file) => (
            <li class="own-rq-file">
              <span class="own-rq-path">{file.file}</span>
              <span class="own-rq-stat">{text("own.requests.diff", { add: file.additions, del: file.deletions })}</span>
              <Show when={file.patch}>
                <button
                  type="button"
                  class="own-rq-link"
                  aria-expanded={open[file.file] === true}
                  data-testid="permission-diff-toggle"
                  onClick={() => setOpen(file.file, (value) => !value)}
                >
                  {open[file.file] ? text("own.requests.diffHide") : text("own.requests.diffShow")}
                </button>
              </Show>
              <Show when={open[file.file]}>
                <Patch file={file} />
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function Patch(props: { readonly file: FilePreview }) {
  const text = useRequestsText()
  const lines = createMemo(() => patchLines(props.file.patch))
  return (
    <pre class="own-rq-diff w-full" data-testid="permission-diff">
      <For each={lines().shown}>{(line) => <span data-line={lineKind(line)}>{line || " "}</span>}</For>
      <Show when={lines().hidden > 0}>
        <span data-line="hunk">{text("own.requests.diffTruncated", { n: lines().hidden })}</span>
      </Show>
    </pre>
  )
}

function lineKind(line: string) {
  if (line.startsWith("@@")) return "hunk"
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "del"
  return "ctx"
}

function scopeText(text: RequestsText, request: PermissionItem["request"]) {
  const scope = alwaysScope(request)
  const kind = actionKind(request.action)
  const noun =
    kind === "other" ? text("own.requests.noun.other", { action: request.action }) : text(`own.requests.noun.${kind}`)
  if (scope.kind === "none") return text("own.requests.always.none")
  if (scope.kind === "all") return text("own.requests.always.all", { noun })
  if (scope.kind === "shell") return text("own.requests.always.shell", { patterns: quoted(scope.patterns) })
  return text("own.requests.always.patterns", { noun, patterns: quoted(scope.patterns) })
}

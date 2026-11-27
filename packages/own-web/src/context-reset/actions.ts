// 문맥 비우기 actions (03 §18.18, 11 §7): reset (`POST /api/session/:id/reset`), cancel a pending reset and undo the
// newest one (`DELETE /api/session/:id/reset/:resetID`, core P-035). Loaded on first use (lazy chunk, PF5). The
// transcript reads the marker again after a reset or an undo (data/server.ts), since neither comes with a message event.
import type { SessionInboxInfo } from "@opencode/client/promise"
import { childViews, shellDirectory, stopShell } from "@/background/data"
import { RESET_HELD } from "@/composer/send"
import type { ServerRuntime } from "@/data"
import { storedLocale, translate, type Locale } from "@/i18n"
import { formatTokens } from "@/switcher/format"
import { dismissToast, showToast, type ToastInput } from "@/switcher/toast"
import { hasContext, pendingReset, undoCost } from "./model"
import { resetText, type ResetKey } from "./strings"

/** What undo needs of a server: the transcript's narrow runtime has it. */
export interface UndoDeps {
  readonly runtime: Pick<ServerRuntime, "client" | "data" | "own">
  readonly sessionID: string
  readonly locale: Locale
  /** Shows a toast; `showToast` returns its id, which `dismiss` closes. */
  readonly toast: (input: ToastInput) => number | void
  readonly dismiss?: (id: number) => void
}

export interface ResetDeps extends UndoDeps {
  readonly runtime: ServerRuntime
}

/** How long a toast with an undo stays (03 §9: undo toasts 8 s). */
const UNDO_TOAST_MS = 8_000
/** The content blocks an Anthropic breakpoint looks back over for an earlier cache entry (02 §6.3 lookbackOK). */
const ANTHROPIC_LOOKBACK = 20

/**
 * `/reset-context`, the `⋯` item and the palette command. Idle: core applies the reset at once, ahead of anything a
 * stop left parked, and the toast offers `되돌리기`. Busy: it waits for the turn (the queue dock shows it with `취소`)
 * and the toast offers to stop the turn now. Which of the two happened is read back from the server's inbox, not from
 * this window's status. A staged revert is committed by the reset, so that asks first. `text`
 * (`/reset-context <text>`) is queued right after the reset, so it starts the fresh context.
 */
export async function resetContext(deps: ResetDeps & { readonly text?: string; readonly confirmed?: boolean }) {
  const runtime = deps.runtime
  const sessionID = deps.sessionID
  const words = (key: ResetKey, params?: Readonly<Record<string, string | number>>) =>
    resetText.text(deps.locale, key, params)
  const session = runtime.data.session.get(sessionID)
  if (session?.parentID) return void deps.toast({ message: words("own.reset.child") })
  if (!runtime.data.session.message.list(sessionID).length)
    await runtime.data.session.message.sync(sessionID).catch(() => undefined)
  const pending = pendingReset(runtime.data.session.pending.list(sessionID))
  if (!pending && !deps.text && !hasContext(runtime.data.session.message.list(sessionID)))
    return void deps.toast({ message: words("own.reset.already") })
  if (session?.revert && !deps.confirmed)
    return void deps.toast({
      message: words("own.reset.revertStaged"),
      action: { label: words("own.reset.anyway"), run: () => void resetContext({ ...deps, confirmed: true }) },
    })
  try {
    const client = runtime.client()
    const admitted = await client.session.reset.create({ sessionID })
    if (deps.text) await runtime.data.session.prompt({ sessionID, text: deps.text, delivery: "queue" })
    const waiting = await client.session.inbox.list({ sessionID }).then(
      (items) => items.some((item) => item.id === admitted.id),
      () => runtime.data.session.status(sessionID) === "running",
    )
    if (waiting) return waitingToast(deps, admitted.id)
    deps.toast({
      message: words(runtime.team.areaOfSession(sessionID) ? "own.reset.doneTeam" : "own.reset.done"),
      action: { label: words("own.reset.undo"), run: () => void undoReset({ ...deps, resetID: admitted.id }) },
      duration: UNDO_TOAST_MS,
    })
    backgroundNotice(deps)
  } catch (error) {
    console.error("[own-web] context reset", error)
    deps.toast({ message: words(problem(error) ?? "own.reset.failed"), tone: "danger" })
  }
}

/**
 * `이 턴이 끝나면 문맥을 비워요 · [중단하고 지금 비우기]`. The toast closes once the reset applies (or is cancelled):
 * its action would then stop a turn of the new context.
 */
function waitingToast(deps: ResetDeps, resetID: string) {
  const runtime = deps.runtime
  const id = deps.toast({
    message: resetText.text(deps.locale, "own.reset.queued"),
    action: {
      label: resetText.text(deps.locale, "own.reset.interruptNow"),
      run: () => void interruptNow(runtime, deps.sessionID, resetID).catch(() => undefined),
    },
    duration: UNDO_TOAST_MS,
  })
  const settled = (event: { readonly data: { readonly inboxID: string } }) => {
    if (event.data.inboxID !== resetID) return
    offs.forEach((off) => off())
    if (id !== undefined) (deps.dismiss ?? dismissToast)(id)
  }
  const offs = [runtime.bus.on("session.inbox.delivered", settled), runtime.bus.on("session.inbox.cancelled", settled)]
  // The toast is gone by then on its own.
  setTimeout(() => offs.forEach((off) => off()), UNDO_TOAST_MS)
}

/**
 * `중단하고 지금 비우기`: the stop applies the waiting reset at once, ahead of everything still pending (core, 11 §7.2).
 * After a stop queued prompts stay parked (upstream), so what was sent after the reset (`/reset-context <text>`, and
 * every send while it waited, which the composer queues) is steered first and resumes in the new context. A prompt
 * queued before the reset stays parked like any queue after a stop, now in the new context. Read from the server, not
 * this window: when the reset has applied meanwhile (the turn ended), the turn now running is the new context's own,
 * and nothing is stopped.
 */
async function interruptNow(runtime: ServerRuntime, sessionID: string, resetID: string) {
  const client = runtime.client()
  const waiting = () => client.session.inbox.list({ sessionID })
  const pending = await waiting()
  const at = pending.findIndex((item) => item.id === resetID)
  if (at < 0) return
  await Promise.all(
    pending
      .slice(at + 1)
      .flatMap((item) =>
        item.type === "user" && item.delivery === "queue"
          ? [client.session.inbox.update({ sessionID, inboxID: item.id, delivery: "steer" })]
          : [],
      ),
  )
  if (!(await waiting()).some((item) => item.id === resetID)) return
  await client.session.interrupt({ sessionID, resume: true })
}

/**
 * A reset cancelled while it waited (the queue dock's `✕`, `되돌리기`, `비우기 취소하고 압축`, another client), with
 * `after` the pending items from it on: the messages a composer queued only because it waited (`RESET_HELD`) are
 * steered, so they reach the running turn as they would have without the reset (03 §18.18). Each window holding that
 * session's queue does it (a repeated steer changes nothing). What was queued on purpose (`/reset-context <text>`, the
 * other-delivery key, the queue setting) stays queued.
 */
export function released(client: ServerRuntime["client"], sessionID: string, after: readonly SessionInboxInfo[]) {
  return Promise.allSettled(
    after.flatMap((item) =>
      item.type === "user" && item.delivery === "queue" && item.payload.metadata?.[RESET_HELD] === true
        ? [client().session.inbox.update({ sessionID, inboxID: item.id, delivery: "steer" })]
        : [],
    ),
  )
}

/**
 * A reset applied while a compaction is pending, admitted before it (a stop, an idle reset, a parked queue) or behind it
 * (another client's `/compact`, own.accounts): core settles that compaction as not needed (cancelled after the reset,
 * 11 §7.2), so its chip goes without a failure. This says why, naming the session (`title`), since it may be any
 * session this window tracks. `data/server.ts` calls it when such a reset delivers.
 */
export function compactionSettled(title?: string) {
  const locale = storedLocale()
  showToast({
    message: resetText.text(locale, "own.reset.compactSettled", {
      title: title || translate(locale, "own.shell.untitled"),
    }),
  })
}

/**
 * `/compact` and `지금 압축` while a reset waits (03 §18.18): the reset empties what a compaction would summarize, so
 * nothing is admitted and the toast offers to cancel the reset and compact instead.
 */
export function compactBehindReset(deps: UndoDeps & { readonly resetID: string; readonly compact: () => void }) {
  const words = (key: ResetKey) => resetText.text(deps.locale, key)
  deps.toast({
    message: words("own.reset.compactWaiting"),
    action: {
      label: words("own.reset.compactInstead"),
      run: () =>
        void deps.runtime
          .client()
          .session.reset.undo({ sessionID: deps.sessionID, resetID: deps.resetID })
          .then(deps.compact, () => deps.toast({ message: words("own.reset.undoFailed"), tone: "danger" })),
    },
    duration: UNDO_TOAST_MS,
  })
}

/**
 * Background jobs still running after the reset (03 §18.18, §19.7): their results come from before it, so core admits
 * them as passive notices that start no turn and ride with the next message (11 §7.2). The second toast lists them and
 * offers to stop them.
 */
function backgroundNotice(deps: ResetDeps) {
  const runtime = deps.runtime
  const shells = runtime.data.shell
    .listBySession(deps.sessionID)
    .filter((shell) => shell.status === "running" && shell.metadata.source === undefined)
  const children = childViews(runtime, deps.sessionID).filter((child) => child.running)
  const names = [...shells.map((shell) => shell.command), ...children.map((child) => child.title ?? child.id)]
  if (names.length === 0) return
  deps.toast({
    message: resetText.text(deps.locale, "own.reset.background", { n: names.length, names: names.join(", ") }),
    action: {
      label: resetText.text(deps.locale, "own.reset.backgroundStop"),
      run: () =>
        void Promise.allSettled([
          ...shells.map((shell) =>
            stopShell(runtime, runtime.key, shell.id, shellDirectory(runtime, shell.id, deps.sessionID)),
          ),
          ...children.map((child) => runtime.client().session.interrupt({ sessionID: child.id })),
        ]),
    },
    duration: UNDO_TOAST_MS,
  })
}

/**
 * `되돌리기` (03 §18.18): a pending reset is cancelled (also while the turn runs); a delivered one is undone while it
 * is the newest boundary and the session is idle. A running turn is stopped only after asking. When the restored
 * context reaches the auto-compaction point or the slot's cache is cold, it asks first (spec principle P3).
 */
export async function undoReset(
  deps: UndoDeps & {
    readonly resetID: string
    /** The user confirmed the cost (or stopping the turn). */
    readonly confirmed?: boolean
  },
): Promise<void> {
  const runtime = deps.runtime
  const sessionID = deps.sessionID
  const words = (key: ResetKey, params?: Readonly<Record<string, string | number>>) =>
    resetText.text(deps.locale, key, params)
  const client = runtime.client()
  const pending = pendingReset(runtime.data.session.pending.list(sessionID))
  if (pending?.id === deps.resetID) {
    await client.session.reset.undo({ sessionID, resetID: deps.resetID }).then(
      () => deps.toast({ message: words("own.reset.cancelled") }),
      () => deps.toast({ message: words("own.reset.undoFailed"), tone: "danger" }),
    )
    return
  }
  const running = runtime.data.session.status(sessionID) === "running"
  if (running && !deps.confirmed)
    return void deps.toast({
      message: words("own.reset.undoRunning"),
      action: {
        label: words("own.reset.undoInterrupt"),
        run: () =>
          void client.session
            .interrupt({ sessionID })
            .then(() => client.session.wait({ sessionID }))
            .catch(() => undefined)
            .then(() => undoReset({ ...deps, confirmed: true })),
      },
      duration: UNDO_TOAST_MS,
    })
  const view = runtime.own.state.cache[sessionID]
  const slot = view?.slots[0]
  const kind = Object.values(runtime.own.state.accounts).find(
    (account) => account.providerID === slot?.providerID,
  )?.kind
  const cost = deps.confirmed
    ? undefined
    : undoCost({
        messages: runtime.data.session.message.list(sessionID),
        resetID: deps.resetID,
        trigger: view?.compaction?.triggerTokens,
        lifetime: slot?.warmUntil ? slot.warmUntil - slot.lastReqAt : undefined,
        lookback: kind === "anth" || kind === "claude-sub" ? ANTHROPIC_LOOKBACK : undefined,
        now: Date.now(),
      })
  if (cost?.ask)
    return void deps.toast({
      message: words(cost.ask === "compacts" ? "own.reset.undoCompacts" : "own.reset.undoCold", {
        tokens: formatTokens(cost.tokens),
      }),
      action: { label: words("own.reset.undoConfirm"), run: () => void undoReset({ ...deps, confirmed: true }) },
      duration: UNDO_TOAST_MS,
    })
  try {
    await client.session.reset.undo({ sessionID, resetID: deps.resetID })
    deps.toast({ message: words("own.reset.undone") })
  } catch (error) {
    console.error("[own-web] undo context reset", error)
    deps.toast({ message: words(problem(error) ?? undoProblem(error)), tone: "danger" })
  }
}

/** The 409 core answers names why (`superseded`, `revert`, `undone`); a busy session is a 409 too. */
function undoProblem(error: unknown): ResetKey {
  const message = error instanceof Error ? error.message : ""
  if (error instanceof Error && error.name === "SessionBusyError") return "own.reset.undoRunning"
  if (message.includes("(superseded)")) return "own.reset.undoBlocked"
  if (message.includes("(revert)")) return "own.reset.undoRevert"
  if (message.includes("(undone)")) return "own.reset.undoneAlready"
  return "own.reset.undoFailed"
}

/**
 * What a failure the client reported itself (no declared error body) says. A server that predates P-035 has no reset
 * route: a bare 404 (`UnsupportedContentType` on a declared 404, `UnexpectedStatus` 404) or 405 is `unsupported`.
 * 401 and 403 are a permission problem (the connection lacks the `prompt` scope, 05 §13.5); a 5xx, a gateway error or
 * no answer at all is the connection. `undefined` for a declared error, which the caller reads.
 */
export function problem(error: unknown): ResetKey | undefined {
  if (!(error instanceof Error) || error.name !== "ClientError" || !("reason" in error)) return undefined
  if (error.reason === "UnsupportedContentType") return "own.reset.unsupported"
  if (error.reason === "Transport") return "own.reset.offline"
  if (error.reason !== "UnexpectedStatus") return undefined
  const status = error.cause instanceof Object && "status" in error.cause ? error.cause.status : undefined
  if (status === 404 || status === 405) return "own.reset.unsupported"
  if (status === 401 || status === 403) return "own.reset.forbidden"
  return typeof status === "number" && status >= 500 ? "own.reset.offline" : undefined
}

// Session delete confirmation (03 §19.11a), a lazy chunk. Says what happens before it happens (P3): permanent, the
// title (or the titles of a selection), subagent conversations go too, files stay, running sessions are stopped first
// (core `Session.remove` interrupts and waits, manage.ts). `취소` has the focus. A team's current main, owner or peer
// blocks it (06 TI-5); until own.team's registry answered the button waits. Afterwards a toast says what was deleted,
// and a route on a deleted session goes home.
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useData } from "@/data"
import { nextFrame } from "@/data/frame"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { sessionFlags } from "./flags"
import type { DeleteRequest } from "./manage-host"
import { deleteSessions, teamHeld } from "./manage"
import { useSidebarText } from "./strings"

/** Titles listed for a selection; the rest is counted. */
const LISTED = 6

export default function DeleteDialog(props: { readonly request: DeleteRequest; readonly onClose: () => void }) {
  const data = useData()
  const router = useRouter()
  const text = useSidebarText()
  const runtime = () => data.get(props.request.serverKey)
  const sessions = props.request.sessions
  const one = sessions.length === 1 && !props.request.emptyArchive
  const [working, setWorking] = createSignal(false)
  const [settled, setSettled] = createSignal(0)
  let cancel: HTMLButtonElement | undefined

  onMount(() => {
    runtime()?.team.ensure()
    nextFrame(() => cancel?.focus())
  })

  const checking = () => {
    const load = runtime()?.team.state.load
    return load === "idle" || load === "loading"
  }
  const held = createMemo(() => {
    const current = runtime()
    return current ? sessions.filter((session) => teamHeld(current, session.id)) : []
  })
  const running = () => {
    const current = runtime()
    return (
      !!current &&
      sessions.some(
        (session) =>
          current.data.session.status(session.id) === "running" ||
          current.sessions.state.sessions[session.id]?.status === "busy",
      )
    )
  }
  const archived = () => sessions.every((session) => sessionFlags(props.request.serverKey)?.archived(session.id))
  const blocked = () => held().length > 0 || checking()

  const title = () => {
    if (props.request.emptyArchive) return text("own.sidebar.emptyArchiveTitle")
    return one ? text("own.sidebar.deleteTitle") : text("own.sidebar.deleteTitleMany", { n: sessions.length })
  }
  const body = () => {
    if (props.request.emptyArchive) return text("own.sidebar.emptyArchiveBody", { n: sessions.length })
    return one
      ? text("own.sidebar.deleteBody", { title: sessions[0]!.title })
      : text("own.sidebar.deleteBodyMany", { n: sessions.length })
  }

  function close() {
    if (!working()) props.onClose()
  }

  async function run() {
    const current = runtime()
    if (!current || working() || blocked()) return
    setWorking(true)
    const result = await deleteSessions(
      current.client(),
      sessions.map((session) => session.id),
      { progress: setSettled, archivedOnly: props.request.archivedOnly },
    )
    const gone = new Set(result.deleted)
    const flags = sessionFlags(props.request.serverKey)
    result.deleted.forEach((id) => flags?.forget(id))
    // A route on a deleted session (or on one of its subagents) has nothing left to show.
    const route = router.route()
    if (route.name === "session" && route.serverKey === props.request.serverKey) {
      const parent = current.data.session.get(route.sessionID)?.parentID
      if (gone.has(route.sessionID) || (parent !== undefined && gone.has(parent))) router.navigate({ name: "home" })
    }
    if (result.deleted.length)
      showToast({
        message:
          result.deleted.length === 1 && one
            ? text("own.sidebar.deleted", { title: sessions[0]!.title })
            : text("own.sidebar.deletedMany", { n: result.deleted.length }),
      })
    if (result.failed.length)
      showToast({
        message: text("own.sidebar.deleteFailed", { n: result.failed.length, reason: result.failed[0]!.reason }),
        tone: "danger",
      })
    if (result.skipped.length) {
      showToast({ message: text("own.sidebar.deleteSkipped", { n: result.skipped.length }) })
      // This device's archive list was behind: read those sessions' flags again.
      result.skipped.forEach(
        (sessionID) =>
          void current
            .client()
            .session.get({ sessionID })
            .then((info) => flags?.ingest(sessionID, info.metadata))
            .catch(() => undefined),
      )
    }
    props.request.onDone?.(result.deleted)
    setWorking(false)
    props.onClose()
  }

  return (
    <Dialog
      open
      title={title()}
      onClose={close}
      testid="session-delete"
      footer={
        <>
          <button
            ref={cancel}
            type="button"
            class="own-btn"
            autofocus
            disabled={working()}
            data-testid="session-delete-cancel"
            onClick={close}
          >
            {text("own.sidebar.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="danger"
            disabled={working() || blocked()}
            data-testid="session-delete-confirm"
            onClick={() => void run()}
          >
            <Show when={working()}>
              <Spinner />
            </Show>
            {working()
              ? text("own.sidebar.deleting", { done: settled(), n: sessions.length })
              : one
                ? text("own.sidebar.deleteConfirm")
                : text("own.sidebar.deleteConfirmMany", { n: sessions.length })}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-2" data-testid="session-delete-body">
        <p class="m-0 font-medium">{body()}</p>
        <Show when={!one}>
          <ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-own-muted" data-testid="session-delete-list">
            <For each={sessions.slice(0, LISTED)}>{(session) => <li class="truncate">{session.title}</li>}</For>
            <Show when={sessions.length > LISTED}>
              <li>{`… +${sessions.length - LISTED}`}</li>
            </Show>
          </ul>
        </Show>
        <ul class="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[12.5px] text-own-muted">
          <li>{text("own.sidebar.deleteChildren")}</li>
          <li>{text("own.sidebar.deleteFiles")}</li>
          <Show when={running()}>
            <li data-testid="session-delete-running">{text("own.sidebar.deleteRunning")}</li>
          </Show>
        </ul>
        <Show when={held().length > 0}>
          <Notice tone="danger" testid="session-delete-team">
            {text("own.sidebar.deleteTeam")}
          </Notice>
        </Show>
        <Show when={!held().length && checking()}>
          <p class="m-0 text-[12.5px] text-own-faint" role="status">
            {text("own.sidebar.teamChecking")}
          </p>
        </Show>
        <Show when={one && !archived()}>
          <p class="m-0 text-[12.5px] text-own-muted" data-testid="session-delete-archive-hint">
            {text("own.sidebar.deleteArchiveHint")}
          </p>
        </Show>
      </div>
    </Dialog>
  )
}

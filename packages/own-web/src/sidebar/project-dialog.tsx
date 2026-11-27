// Project dialogs (03 §19.11a), a lazy chunk.
// - `프로젝트 목록에서 삭제…`: counts the project's root sessions on the server (archived ones included), then asks with
//   a strong confirm: what goes (n sessions with their subagent conversations, permanently), what stays (the files
//   and folders on disk, with the folder shown), and a check box naming the count before the danger button works.
//   Running sessions are stopped first (core). `취소` has the focus.
// - Both modes wait for own.team's registry and refuse a project with a team on (06 TI-5): the dialog says why and
//   offers `팀 모드 끄기…` (06 §3.8's own dialog) where this build and connection may turn it off. A `프로젝트 보관`
//   that only waited for the registry goes ahead once it says no team is on.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createEffect, createResource, createSignal, lazy, on, onMount, Show, Suspense } from "solid-js"
import { useData } from "@/data"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { prepareTeamEntries, teamLabel } from "@/team/enable"
import type { ProjectRequest } from "./manage-host"
import { deleteSessions, projectSessions, projectTeam } from "./manage"
import { runProjectArchive } from "./project-actions"
import { useSidebarText } from "./strings"

const DisableDialog = lazy(() => import("@/team/confirm").then((module) => ({ default: module.DisableDialog })))

export default function ProjectDialog(props: { readonly request: ProjectRequest; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  const text = useSidebarText()
  const request = props.request
  const runtime = () => data.get(request.serverKey)
  const [disabling, setDisabling] = createSignal<OwnTeam.TeamID>()
  const [working, setWorking] = createSignal(false)
  const [settled, setSettled] = createSignal(0)
  const [ack, setAck] = createSignal(false)
  const team = () => {
    const current = runtime()
    return current ? projectTeam(current, request.projectID, request.git) : { kind: "unknown" as const }
  }
  const [sessions] = createResource(
    () => (request.mode === "delete" ? runtime() : undefined),
    (current) => projectSessions(current.client(), request.projectID),
  )
  const count = () => sessions()?.length ?? 0
  const running = () => {
    const current = runtime()
    return (
      !!current &&
      (sessions() ?? []).some(
        (info) =>
          current.data.session.status(info.id) === "running" ||
          current.sessions.state.sessions[info.id]?.status === "busy",
      )
    )
  }
  /** `팀 모드 끄기…` where this build of own.team turns teams off and this connection may (06 §9.2). */
  const canDisable = () => {
    const current = runtime()
    return (
      !!current &&
      current.team.has("enable") &&
      current.team.rpc.allowed("disable") &&
      teamLabel(i18n.locale(), "own.team.menu.disable") !== undefined
    )
  }
  /** The team to turn off from here (`팀 모드 끄기…`), when one is on and that is possible. */
  const offTeam = () => {
    const current = team()
    // SAFETY: `projectTeam` answers ids from own.team's registry (`teamsOfProject`, `team.list`), team ids already.
    return current.kind === "on" && canDisable() ? (current.teamID as OwnTeam.TeamID) : undefined
  }
  let cancel: HTMLButtonElement | undefined

  onMount(() => {
    prepareTeamEntries(runtime())
    nextFrame(() => cancel?.focus())
  })

  // A `프로젝트 보관` that waited for own.team's registry goes ahead once it says no team is on.
  createEffect(
    on(
      () => team().kind,
      (kind) => {
        const current = runtime()
        if (request.mode !== "archive" || kind !== "off" || !current) return
        props.onClose()
        void runProjectArchive(current, request, true, text)
      },
    ),
  )

  function close() {
    if (!working()) props.onClose()
  }

  async function remove() {
    const current = runtime()
    const infos = sessions()
    if (!current || !infos || working() || !ack() || team().kind !== "off") return
    setWorking(true)
    const result = await deleteSessions(
      current.client(),
      infos.map((info) => info.id),
      { progress: setSettled },
    )
    const route = router.route()
    const gone = new Set(result.deleted)
    if (
      (route.name === "project" && route.serverKey === request.serverKey && route.projectID === request.projectID) ||
      (route.name === "session" && route.serverKey === request.serverKey && gone.has(route.sessionID))
    )
      router.navigate({ name: "home" })
    if (result.deleted.length)
      showToast({ message: text("own.sidebar.project.deleted", { name: request.name, n: result.deleted.length }) })
    if (result.failed.length)
      showToast({
        message: text("own.sidebar.deleteFailed", { n: result.failed.length, reason: result.failed[0]!.reason }),
        tone: "danger",
      })
    setWorking(false)
    props.onClose()
  }

  const blockedView = () => team().kind !== "off"

  return (
    <Show
      when={!disabling()}
      fallback={
        <Suspense>
          <DisableDialog serverKey={request.serverKey} teamID={disabling()!} onClose={props.onClose} />
        </Suspense>
      }
    >
      <Dialog
        open
        title={
          request.mode === "delete"
            ? text("own.sidebar.project.deleteTitle", { name: request.name })
            : text("own.sidebar.project.blockedTitle", { name: request.name })
        }
        onClose={close}
        testid="project-manage"
        footer={
          <>
            <button
              ref={cancel}
              type="button"
              class="own-btn"
              autofocus
              disabled={working()}
              data-testid="project-manage-cancel"
              onClick={close}
            >
              {text("own.sidebar.cancel")}
            </button>
            <Show when={offTeam()}>
              {(teamID) => (
                <button
                  type="button"
                  class="own-btn"
                  data-testid="project-manage-team-off"
                  onClick={() => setDisabling(teamID())}
                >
                  {text("own.sidebar.project.teamOff")}
                </button>
              )}
            </Show>
            <Show when={request.mode === "delete"}>
              <button
                type="button"
                class="own-btn"
                data-variant="danger"
                disabled={working() || !ack() || blockedView() || !count()}
                data-testid="project-manage-confirm"
                onClick={() => void remove()}
              >
                <Show when={working()}>
                  <Spinner />
                </Show>
                {working()
                  ? text("own.sidebar.deleting", { done: settled(), n: count() })
                  : text("own.sidebar.project.deleteConfirm", { n: count() })}
              </button>
            </Show>
          </>
        }
      >
        <div class="flex flex-col gap-2" data-testid="project-manage-body" data-team={team().kind}>
          <Show when={team().kind === "on"}>
            <Notice tone="warn" testid="project-manage-team">
              {text("own.sidebar.project.team")}
            </Notice>
          </Show>
          <Show when={team().kind === "unknown"}>
            <p class="m-0 text-[12.5px] text-own-faint" role="status" data-testid="project-manage-checking">
              {runtime()?.team.state.load === "unavailable"
                ? text("own.sidebar.project.teamUnknown")
                : text("own.sidebar.teamChecking")}
            </p>
          </Show>
          <Show when={request.mode === "delete" && !blockedView()}>
            <Show
              when={!sessions.loading}
              fallback={<p class="m-0 text-own-muted">{text("own.sidebar.project.counting")}</p>}
            >
              <Show
                when={!sessions.error}
                fallback={
                  <Notice tone="danger">
                    {text("own.sidebar.project.listFailed", {
                      name: request.name,
                      reason: sessions.error instanceof Error ? sessions.error.message : String(sessions.error),
                    })}
                  </Notice>
                }
              >
                <p class="m-0 font-medium" data-testid="project-manage-count" data-count={count()}>
                  {count()
                    ? text("own.sidebar.project.deleteBody", { n: count() })
                    : text("own.sidebar.project.nothing", { name: request.name })}
                </p>
                <ul class="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[12.5px] text-own-muted">
                  <li data-testid="project-manage-disk">
                    {text("own.sidebar.project.deleteDisk", { directory: request.directory ?? request.name })}
                  </li>
                  <Show when={running()}>
                    <li>{text("own.sidebar.deleteRunning")}</li>
                  </Show>
                  <li>{text("own.sidebar.project.deleteHint")}</li>
                </ul>
                <Show when={count() > 0}>
                  <label class="mt-1 flex items-start gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      class="mt-1"
                      checked={ack()}
                      disabled={working()}
                      data-testid="project-manage-ack"
                      onChange={(event) => setAck(event.currentTarget.checked)}
                    />
                    <span>{text("own.sidebar.project.deleteAck", { n: count() })}</span>
                  </label>
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </Dialog>
    </Show>
  )
}

// Project header `⋯`. For every project, Git or not: `다른 도구의 대화…` (09 §6 entry 2), which opens the list of the
// conversations Codex and Claude Code left for the project, where own.import is there and this connection may list
// (import/store.ts asks its `health` once the session list was painted and the page is idle). For Git projects only
// (06 §9.2): `팀 모드 켜기` while no team is on, else `팀 보기`, `영역 만들기…` (2026-10-26, team/create-area.tsx, lazy),
// `팀 구성 다시 보기` (8.1), `결정 적기` (6.6), `모두 멈추기` / `다시 시작` (5.3), `메인 새 대화` (6.5), `팀 설정` (9.8)
// and `팀 모드 끄기` (3.8). Each item shows only where this build of own.team has its feature (`health.features`) and
// this connection its scope. A gateway device therefore never sees enable, disable or the review (`admin`). `팀 구성
// 다시 보기` opens its card (team/reorg.tsx, lazy: the main's proposal, applied at once), `결정 적기` its dialog
// (team/decide.tsx, lazy) and `팀 모드 끄기` its own (team/confirm.tsx, lazy): `[그대로 두고 끄기]`, and `[끝난 영역
// 정리하고 끄기]` where the build has `cleanup`. The team strings load with the team chunk, and the team items appear
// once they and own.team's health are there. The sidebar row mounts it (T1.26). Clicks and keys stay inside, so they
// do not fold the project row or move the tree's focus.
//
// 03 §19.11a, every project: `프로젝트 보관` (`prompt` scope; at once with a `보관 취소` toast, or through the project
// dialog while own.team has not answered or a team is on) and `프로젝트 목록에서 삭제…` (`admin` scope, the project
// dialog). In the `보관함` view the menu holds `프로젝트 복원` only, for a project archived as a whole. Before them (03 §4.3.1, src/discover): `새 워크트리에서 새 세션`
// for a Git project outside a team, and for a project that is not a Git repository the note on why it has neither.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createEffect, createSignal, lazy, Show, Suspense, untrack } from "solid-js"
import { useData, type ServerKey, type ServerRuntime } from "@/data"
import { joinGroups, projectMenuExtras } from "@/discover/menus"
import { explorerEntries } from "@/explorer"
import { useI18n, type Locale } from "@/i18n"
import { importStore, openImport } from "@/import"
import { useRouter } from "@/routing/router"
import type { Route } from "@/routing/routes"
import { HostMenu, type MenuItem } from "@/servers/menu"
import { showToast } from "@/switcher/toast"
import { canEnableTeam, failed, pauseTeam, prepareTeamEntries, teamLabel, useEnableTeam } from "@/team/enable"
import { openCreateArea, openTeamSettings, openTeamView } from "@/team/intents"
import type { TeamEntry } from "@/team/store"
import type { TeamKey } from "@/team/strings"
import { projectRef, syncProjects } from "@/worktree/api"
import { openProjectManage } from "./manage-host"
import { projectTeam } from "./manage"
import { useSidebar } from "./context"
import { runProjectArchive } from "./project-actions"
import { reorder } from "./reorder-api"
import { useSidebarText } from "./strings"

const DisableDialog = lazy(() => import("@/team/confirm").then((module) => ({ default: module.DisableDialog })))
const DecideDialog = lazy(() => import("@/team/decide"))
const ReorgReview = lazy(() => import("@/team/reorg"))

/** The `reorg.apply` actions of a T3 build: its `reorg.propose` answers (06 §8.1) once they are there. */
const REVIEW: readonly OwnTeam.Feature[] = ["reorg.split", "reorg.merge", "reorg.retire", "reorg.convert"]

export function ProjectMenu(props: {
  readonly serverKey: ServerKey
  readonly projectID: string
  /** The project's name, for the button's label. */
  readonly name: string
  /** The project row's folder (its canonical root). */
  readonly directory?: string
  /** The `보관함` view lists this project (19.11a): only `프로젝트 복원`, and only when `restorable`. */
  readonly archiveView?: boolean
  /** Sessions of this project were archived with it (`프로젝트 보관`). */
  readonly restorable?: boolean
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useSidebarText()
  const enableTeam = useEnableTeam()
  const router = useRouter()
  const ctl = useSidebar()
  const [disabling, setDisabling] = createSignal<OwnTeam.TeamID>()
  const [deciding, setDeciding] = createSignal<OwnTeam.TeamID>()
  const [reviewing, setReviewing] = createSignal<OwnTeam.TeamID>()
  const runtime = () => data.get(props.serverKey)
  const git = () => {
    const current = runtime()
    return current !== undefined && projectRef(current, props.projectID)?.vcs === "git"
  }
  // A Git project row is a place to start team mode: read own.team's health and the project list once.
  createEffect(() => {
    const current = runtime()
    if (!current) return
    untrack(() => syncProjects(current))
    if (git()) untrack(() => prepareTeamEntries(current))
  })
  // 09 §6 entry 2: own.import's `health` (once per server, deferred until the list was painted), asked again after a
  // reconnect.
  createEffect(() => {
    const current = runtime()
    if (current?.connection.status() === "connected") untrack(() => importStore(current).prepare())
  })

  const items = (): MenuItem[] => {
    if (props.archiveView) return restoreItems()
    // 03 §19.5 `탐색기에서 열기` for the project's folder, where the host can (the desktop app).
    const explorer = explorerEntries()?.projectItems(runtime(), props.serverKey, props.directory, i18n.locale())
    // 03 §4.3 순서와 고정: 고정, 위로·아래로 이동, 기본 순서로 되돌리기 (./reorder.ts, lazy).
    const order = reorder()?.projectItems(ctl, props.projectID, props.name) ?? []
    return joinGroups(importItems(), teamItems(), discoverItems(), explorer ?? [], order, manageItems())
  }

  const project = () => ({
    serverKey: props.serverKey,
    projectID: props.projectID,
    name: props.name,
    directory: props.directory,
    git: git(),
  })

  /** 19.11a `프로젝트 보관` (`prompt`, like every session flag write) and `프로젝트 목록에서 삭제…` (`admin`). */
  const manageItems = (): MenuItem[] => {
    const current = runtime()
    if (!current) return []
    return [
      ...(current.rpc.can("prompt")
        ? [
            {
              label: text("own.sidebar.project.archive"),
              onSelect: () => archive(current),
              testid: "project-menu-archive",
            },
          ]
        : []),
      ...(current.rpc.can("admin")
        ? [
            {
              label: text("own.sidebar.project.delete"),
              onSelect: () => openProjectManage({ ...project(), mode: "delete" }),
              testid: "project-menu-delete",
              tone: "danger" as const,
            },
          ]
        : []),
    ]
  }

  /** At once when no team is on; the dialog waits for own.team's registry or says why a team blocks it. */
  function archive(current: ServerRuntime) {
    if (projectTeam(current, props.projectID, git()).kind !== "off")
      return openProjectManage({ ...project(), mode: "archive" })
    void runProjectArchive(current, project(), true, text)
  }

  const restoreItems = (): MenuItem[] => {
    const current = runtime()
    if (!current || !props.restorable || !current.rpc.can("prompt")) return []
    return [
      {
        label: text("own.sidebar.project.restore"),
        onSelect: () => void runProjectArchive(current, project(), false, text),
        testid: "project-menu-restore",
      },
    ]
  }

  /** 03 §4.3.1: `새 워크트리에서 새 세션`, or why a project that is not a Git repository has no team or worktree items. */
  const discoverItems = (): MenuItem[] => {
    const current = runtime()
    if (!current) return []
    const context = {
      runtime: current,
      serverKey: props.serverKey,
      projectID: props.projectID,
      locale: i18n.locale(),
      navigate: (route: Route) => router.navigate(route),
    }
    return projectMenuExtras(context, props.directory)
  }

  /** `다른 도구의 대화…` (09 §6 entry 2): every project, where own.import is there and this connection may list. */
  const importItems = (): MenuItem[] => {
    const current = runtime()
    if (!current || !props.directory || importStore(current).available() !== true) return []
    return [
      {
        label: i18n.t("own.otherTools.menu"),
        onSelect: () => openImport({ serverKey: props.serverKey, projectID: props.projectID }),
        testid: "project-menu-import",
      },
    ]
  }

  const teamItems = (): MenuItem[] => {
    const current = runtime()
    const directory = props.directory
    if (!current || !directory || !git()) return []
    const locale = i18n.locale()
    const label = (key: TeamKey) => teamLabel(locale, key)
    const team = current.team
    const entry = team.teamOfDirectory(directory) ?? team.teamsOfProject(props.projectID)[0]
    if (!entry) {
      const enable = label("own.team.enable")
      return enable && canEnableTeam(current, { directory, projectID: props.projectID })
        ? [
            {
              label: enable,
              onSelect: () => void enableTeam({ serverKey: props.serverKey, directory }),
              testid: "project-menu-team-enable",
            },
          ]
        : []
    }
    const teamID = entry.team.id
    const choices = pauseChoices(entry)
    const pausable = team.has("pause") && team.rpc.allowed("team.pause")
    const entries: Array<{
      readonly key: TeamKey
      readonly run: () => void
      readonly testid: string
      readonly when: boolean
      readonly danger?: true
    }> = [
      {
        key: "own.team.menu.view",
        run: () => openTeamView({ serverKey: props.serverKey, projectID: props.projectID }),
        testid: "project-menu-team-view",
        when: true,
      },
      {
        key: "own.team.menu.createArea",
        run: () => openCreateArea({ serverKey: props.serverKey, teamID }),
        testid: "project-menu-team-create-area",
        when: team.createForm() !== undefined,
      },
      {
        key: "own.team.menu.review",
        run: () => setReviewing(teamID),
        testid: "project-menu-team-review",
        when: REVIEW.some((feature) => team.has(feature)) && team.rpc.allowed("reorg.propose"),
      },
      {
        key: "own.team.menu.decide",
        run: () => setDeciding(teamID),
        testid: "project-menu-team-decide",
        when: team.has("decisions") && team.rpc.allowed("decisions.add"),
      },
      {
        key: "own.team.menu.pauseAll",
        run: () => void pauseTeam(current, teamID, true, locale),
        testid: "project-menu-team-pause",
        when: pausable && choices.stop,
      },
      {
        key: "own.team.menu.resumeAll",
        run: () => void pauseTeam(current, teamID, false, locale),
        testid: "project-menu-team-resume",
        when: pausable && choices.resume,
      },
      {
        key: "own.team.menu.mainRotate",
        run: () => void rotateMain(current, teamID, locale),
        testid: "project-menu-team-rotate",
        when: team.has("rotate") && team.rpc.allowed("main.rotate"),
      },
      {
        key: "own.team.menu.settings",
        run: () => openTeamSettings({ serverKey: props.serverKey, teamID }),
        testid: "project-menu-team-settings",
        when: team.has("settings"),
      },
      {
        key: "own.team.menu.disable",
        run: () => setDisabling(teamID),
        testid: "project-menu-team-disable",
        when: team.has("enable") && team.rpc.allowed("disable"),
        danger: true,
      },
    ]
    return entries.flatMap((item): MenuItem[] => {
      const text = item.when ? label(item.key) : undefined
      if (!text) return []
      return [
        ...(item.danger ? ["separator" as const] : []),
        { label: text, onSelect: item.run, testid: item.testid, ...(item.danger ? { tone: "danger" as const } : {}) },
      ]
    })
  }

  // Solid hands events of the portaled dialog to this spot too: none of them may reach the row or the tree.
  return (
    <span class="contents" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <Show when={items().length > 0}>
        <HostMenu
          label={
            // The team strings load for Git projects only; the others take the same words from the first chunk.
            (git() ? teamLabel(i18n.locale(), "own.team.menu.label", { project: props.name }) : undefined) ??
            i18n.t("own.otherTools.projectMenu", { project: props.name })
          }
          items={items}
          testid="project-menu"
        />
      </Show>
      <Show when={disabling()}>
        {(teamID) => (
          <Suspense>
            <DisableDialog serverKey={props.serverKey} teamID={teamID()} onClose={() => setDisabling(undefined)} />
          </Suspense>
        )}
      </Show>
      <Show when={deciding()}>
        {(teamID) => (
          <Suspense>
            <DecideDialog serverKey={props.serverKey} teamID={teamID()} onClose={() => setDeciding(undefined)} />
          </Suspense>
        )}
      </Show>
      <Show when={reviewing()}>
        {(teamID) => (
          <Suspense>
            <ReorgReview serverKey={props.serverKey} teamID={teamID()} onClose={() => setReviewing(undefined)} />
          </Suspense>
        )}
      </Show>
    </span>
  )
}

/**
 * Which of 모두 멈추기 / 다시 시작 apply (06 §5.3). Stopping needs an area that is not finished and has no Main 멈춤.
 * Resuming needs an area that 모두 멈추기 paused (`"all"`): areas the user paused stay paused.
 */
export function pauseChoices(entry: Pick<TeamEntry, "areas" | "order">) {
  const areas = entry.order.flatMap((id) => entry.areas[id] ?? []).filter((area) => area.state !== "retired")
  return {
    stop: areas.some((area) => area.paused === false),
    resume: areas.some((area) => area.paused === "all"),
  }
}

/** 메인 새 대화 (06 §6.5): `main.rotate`, then says it started. */
function rotateMain(runtime: ServerRuntime, teamID: OwnTeam.TeamID, locale: Locale) {
  return runtime.team.rpc.call("main.rotate", { teamID }).then(
    () => {
      const started = teamLabel(locale, "own.team.mainRotate.started")
      if (started) showToast({ message: started })
    },
    (error: unknown) => failed(locale, error),
  )
}

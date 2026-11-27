// The project row's quick actions (03 §4.3.1), after the project name:
// - `팀`: a team that is on shows it always and opens the team view (06 §9.4). Where team mode can start, the button
//   shows on hover (always on touch and on the project on screen) and opens the `팀 모드 켜기…` dialog at once (06
//   §9.2, 2026-10-16: its lead says what turning on does, so no popover comes first). A project that is not a Git
//   repository gets a dimmed button that says why instead of nothing.
// - `⑂`: the project's worktrees (19.3) with `새 세션` in each, `새 워크트리에서 새 세션` and `다른 워크트리로 옮기기…`
//   for the conversation on screen; dimmed with the same explanation for a project that is not a Git repository.
// - Where this connection may make the folder a repository (06 §3.0, `local`), both dimmed buttons open a short menu
//   instead of a toast: the explanation and `Git 저장소로 만들기…` (git-init.tsx). The 기본 대화 폴더 stays a plain
//   folder (03 §5.1): its explanation says so and its menu offers `프로젝트 폴더 열기…` (menus.ts `notGitAction`).
// What a connection cannot do is left out (model.ts). Clicks and keys stay inside, so they do not fold the row or move
// the tree's focus.
import { createEffect, createMemo, Match, Show, Switch, untrack } from "solid-js"
import { LOCAL, useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { HostMenu, type MenuItem } from "@/servers/menu"
import { Icon } from "@/shell/icons"
import { showToast } from "@/switcher/toast"
import { useEnableTeam } from "@/team/enable"
import { openTeamView } from "@/team/intents"
import { syncProjects } from "@/worktree/api"
import { loadWorktrees } from "@/worktree/state"
import { notGitAction, worktreeMenuItems } from "./menus"
import { notGitFeatureNote, teamEntry, worktreeEntry } from "./model"
import { useDiscoverText } from "./strings"

/** Shown on hover, keyboard focus inside the row, the project on screen, and always on touch screens. */
const REVEAL =
  "hidden group-hover:inline-flex group-focus-within:inline-flex group-aria-[current=page]:inline-flex [[data-touch]_&]:inline-flex"
/** A small bordered pill; on touch screens (44 px targets, 4.2.2) a plain button like the row's `+`. */
const PILL =
  "own-target [@media(pointer:coarse)]:border-transparent h-5 flex-none items-center gap-1 rounded border border-own-border bg-transparent px-1.5 text-[10.5px] leading-4 font-normal text-own-muted hover:bg-own-hover hover:text-own-text [&_svg]:size-3 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.8]"
const DIMMED = "opacity-60"

export function ProjectActions(props: {
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly name: string
  /** The project row's folder (its canonical root). */
  readonly directory?: string
}) {
  const data = useData()
  const router = useRouter()
  const i18n = useI18n()
  const text = useDiscoverText()
  const enableTeam = useEnableTeam()
  const runtime = () => data.get(props.serverKey)
  // The project list says Git or not; own.team's health says whether team mode exists here (read once per server). The
  // local service carries own.team; another server is asked for its Git projects only (the project `⋯` does the same),
  // since a server without own.team answers 400, which the browser logs.
  createEffect(() => {
    const current = runtime()
    if (!current || current.connection.status() !== "connected") return
    const git = current.data.project.get(props.projectID)?.vcs === "git"
    untrack(() => {
      syncProjects(current)
      if (current.key === LOCAL || git) current.team.ensure()
    })
  })
  const team = createMemo(() => {
    const current = runtime()
    return current ? teamEntry(current, { projectID: props.projectID, directory: props.directory }) : undefined
  })
  const worktree = createMemo(() => {
    const current = runtime()
    return current ? worktreeEntry(current, props.projectID) : undefined
  })
  const place = () => ({ projectID: props.projectID, directory: props.directory })
  /** `Git 저장소로 만들기…`, or `프로젝트 폴더 열기…` in the 기본 대화 폴더; absent where neither applies. */
  const action = createMemo(() => {
    const current = runtime()
    return current
      ? notGitAction({
          runtime: current,
          serverKey: props.serverKey,
          locale: i18n.locale(),
          place: place(),
          testid: "project",
        })
      : undefined
  })
  /** Why the dimmed button does nothing here (the 기본 대화 폴더 has its own words). */
  const note = (feature: "team" | "worktree") => {
    const current = runtime()
    return current
      ? text(notGitFeatureNote(current, place(), feature))
      : text(feature === "team" ? "own.discover.notGit.team" : "own.discover.notGit.worktree")
  }
  /** The dimmed buttons' menu: why, and the action. */
  const notGitItems = (feature: "team" | "worktree"): MenuItem[] => {
    const item = action()
    return [{ note: note(feature) }, ...(item ? [item] : [])]
  }
  const sessionID = () => {
    const route = router.route()
    return route.name === "session" && route.serverKey === props.serverKey ? route.sessionID : undefined
  }
  const worktreeItems = (): MenuItem[] => {
    const current = runtime()
    if (!current) return []
    return worktreeMenuItems({
      runtime: current,
      serverKey: props.serverKey,
      projectID: props.projectID,
      locale: i18n.locale(),
      navigate: (route) => router.navigate(route),
      sessionID: sessionID(),
    })
  }

  return (
    <span
      class="contents font-normal"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Switch>
        <Match when={team()?.kind === "view"}>
          <button
            type="button"
            tabindex={-1}
            class={`inline-flex ${PILL}`}
            title={text("own.discover.team.view")}
            data-testid="project-team-badge"
            onClick={() => openTeamView({ serverKey: props.serverKey, projectID: props.projectID })}
          >
            {text("own.discover.team")}
          </button>
        </Match>
        <Match when={team()?.kind === "enable" && team()}>
          {(entry) => (
            <button
              type="button"
              tabindex={-1}
              class={`${REVEAL} ${PILL}`}
              title={text("own.discover.team.enableHint")}
              aria-label={text("own.discover.team.menu", { project: props.name })}
              aria-haspopup="dialog"
              data-testid="project-team-button"
              onClick={() => {
                const current = entry()
                if (current.kind === "enable")
                  void enableTeam({ serverKey: props.serverKey, directory: current.directory })
              }}
            >
              <Icon name="team" />
              {text("own.discover.team")}
            </button>
          )}
        </Match>
        <Match when={team()?.kind === "notGit" && action()}>
          <HostMenu
            label={text("own.discover.team.menu", { project: props.name })}
            title={note("team")}
            class={`${REVEAL} ${PILL} ${DIMMED}`}
            state="not-git"
            trigger={
              <>
                <Icon name="team" />
                {text("own.discover.team")}
              </>
            }
            items={() => notGitItems("team")}
            testid="project-team-button"
          />
        </Match>
        <Match when={team()?.kind === "notGit"}>
          <button
            type="button"
            tabindex={-1}
            aria-disabled="true"
            class={`${REVEAL} ${PILL} ${DIMMED}`}
            title={note("team")}
            data-testid="project-team-button"
            data-state="not-git"
            onClick={() => showToast({ message: note("team") })}
          >
            <Icon name="team" />
            {text("own.discover.team")}
          </button>
        </Match>
      </Switch>
      <Show when={worktree()}>
        {(kind) => (
          <Show
            when={kind() === "menu"}
            fallback={
              <Show
                when={action()}
                fallback={
                  <button
                    type="button"
                    tabindex={-1}
                    aria-disabled="true"
                    class={`${REVEAL} ${PILL} ${DIMMED}`}
                    aria-label={text("own.discover.worktree")}
                    title={note("worktree")}
                    data-testid="project-worktree-button"
                    data-state="not-git"
                    onClick={() => {
                      // A server asked only for its Git projects so far: its own.team may offer Git 저장소로 만들기.
                      runtime()?.team.ensure()
                      showToast({ message: note("worktree") })
                    }}
                  >
                    <Icon name="branch" />
                  </button>
                }
              >
                <HostMenu
                  label={text("own.discover.worktree.menu", { project: props.name })}
                  title={note("worktree")}
                  class={`${REVEAL} ${PILL} ${DIMMED}`}
                  state="not-git"
                  trigger={<Icon name="branch" />}
                  items={() => notGitItems("worktree")}
                  testid="project-worktree-button"
                />
              </Show>
            }
          >
            <HostMenu
              label={text("own.discover.worktree.menu", { project: props.name })}
              title={text("own.discover.worktree")}
              class={`${REVEAL} ${PILL}`}
              trigger={<Icon name="branch" />}
              onOpen={() => {
                const current = runtime()
                if (current) loadWorktrees(current, props.serverKey, props.projectID)
              }}
              items={worktreeItems}
              testid="project-worktree-button"
            />
          </Show>
        )}
      </Show>
    </span>
  )
}

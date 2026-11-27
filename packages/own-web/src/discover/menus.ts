// Menu items of the discoverability entry points (03 §4.3.1), shared by the project row's `[팀]` and `⑂` buttons, the
// project header `⋯`, the session `⋯` and the first-run hints. Every action is the owning module's: the worktree choice
// and the new-session screen (src/worktree, 19.3), `다른 워크트리로 옮기기…` (`openWorktreeMove`), `Git 저장소로
// 만들기…` (git-init.tsx, 06 §3.0), `폴더 열기…` (src/projects/opener.ts). Nothing here creates a worktree by itself: the
// new-session screen does when the first message is sent, as from the composer's `⑂ 작업 위치`.
import type { ServerKey, ServerRuntime } from "@/data"
import { translate, type Locale } from "@/i18n"
import type { Route } from "@/routing/routes"
import type { MenuItem } from "@/servers/menu"
import { setNewSessionTarget } from "@/sidebar/target"
import { isDefaultFolder } from "@/projects/default-folder"
import { openProject } from "@/projects/opener"
import { baseName } from "@/projects/path"
import { canMoveSession, openWorktreeMove, projectRef, worktreeName, worktreeText } from "@/worktree"
import { otherWorktrees, type Choice } from "@/worktree/model"
import { projectKey, worktreeChoices, worktreeList } from "@/worktree/state"
import { openGitInit } from "./git-init"
import { gitInitEntry, notGitNote, worktreeEntry, type ProjectPlace } from "./model"
import { discoverText, type DiscoverKey } from "./strings"

export interface MenuContext {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly locale: Locale
  readonly navigate: (route: Route) => void
  /** The conversation on screen, for `다른 워크트리로 옮기기…` when it belongs to this project. */
  readonly sessionID?: string
}

/**
 * The `⑂` menu (19.3): a new session in each existing worktree, a new session in a new worktree, and moving the
 * conversation on screen when it is a root conversation of this project. Reads the list `loadWorktrees` keeps.
 */
export function worktreeMenuItems(context: MenuContext): MenuItem[] {
  const runtime = context.runtime
  const project = projectRef(runtime, context.projectID)
  if (!project) return []
  const say = (key: DiscoverKey, params?: Record<string, string>) => discoverText.text(context.locale, key, params)
  const list = worktreeList(projectKey(context.serverKey, context.projectID))
  const existing = list?.items ? otherWorktrees(list.items, project.root) : undefined
  const sessionID = context.sessionID
  const info = sessionID ? runtime.data.session.get(sessionID) : undefined
  const row = sessionID ? runtime.sessions.state.sessions[sessionID] : undefined
  const movable =
    sessionID !== undefined &&
    (info?.projectID ?? row?.projectID) === context.projectID &&
    canMoveSession(runtime, sessionID)
  return [
    { note: say("own.discover.worktree.about") },
    ...(existing === undefined
      ? [{ note: worktreeText.text(context.locale, "own.worktree.loading") }]
      : existing.length === 0
        ? [{ note: say("own.discover.worktree.none"), testid: "worktree-menu-none" }]
        : existing.map(
            (item): MenuItem => ({
              label: say("own.discover.worktree.openIn", {
                name: worktreeName(
                  item.directory,
                  runtime.data.location.vcs.info({ directory: item.directory })?.branch.current,
                ),
              }),
              onSelect: () => startIn(context, { mode: "existing", existing: item.directory }),
              testid: "worktree-menu-open",
            }),
          )),
    "separator",
    {
      label: translate(context.locale, "own.palette.p7.worktreeNew"),
      onSelect: () => startIn(context, { mode: "new", base: worktreeChoices.get(key(context))?.base }),
      testid: "worktree-menu-new",
    },
    ...(movable && sessionID
      ? [
          {
            label: worktreeText.text(context.locale, "own.worktree.move.action"),
            onSelect: () => openWorktreeMove({ serverKey: context.serverKey, sessionID }),
            testid: "worktree-menu-move",
          } satisfies MenuItem,
        ]
      : []),
  ]
}

/**
 * Additions to the project header `⋯` and the session `⋯` (a group of their own; the caller separates it): `새 워크트리에서
 * 새 세션` for a Git project outside a team, and for a project that is not a Git repository the note that says why
 * team mode and worktrees are missing, with {@link notGitAction} under it (06 §3.0).
 */
export function projectMenuExtras(context: MenuContext, directory: string | undefined): MenuItem[] {
  const runtime = context.runtime
  const place = { projectID: context.projectID, directory }
  const note = notGitNote(runtime, place)
  if (note) {
    // No conversation: the one on screen may belong to another project, and the dialog's `팀 모드 켜기…` would start
    // from it.
    const action = notGitAction({
      runtime,
      serverKey: context.serverKey,
      locale: context.locale,
      place,
      testid: "menu",
    })
    return [{ note: discoverText.text(context.locale, note), testid: "menu-not-git" }, ...(action ? [action] : [])]
  }
  if (worktreeEntry(runtime, context.projectID) !== "menu") return []
  return [
    {
      label: translate(context.locale, "own.palette.p7.worktreeNew"),
      onSelect: () => startIn(context, { mode: "new", base: worktreeChoices.get(key(context))?.base }),
      testid: "menu-worktree-new",
    },
  ]
}

/**
 * The session `⋯` of a root conversation in a project that is not a Git repository: why team mode and worktrees are
 * missing there (the menu has neither `팀 모드 켜기` nor `다른 워크트리로 옮기기…`), and under it the same action as the
 * project `⋯` ({@link notGitAction}) for the conversation's project folder, so the way out is where the user looks.
 */
export function sessionMenuExtras(
  runtime: ServerRuntime,
  serverKey: ServerKey,
  locale: Locale,
  sessionID: string,
): MenuItem[] {
  const info = runtime.data.session.get(sessionID)
  const row = runtime.sessions.state.sessions[sessionID]
  const projectID = info?.projectID ?? row?.projectID
  if (info?.parentID || row?.parentID || !projectID) return []
  const place = { projectID, directory: projectRef(runtime, projectID)?.root }
  const note = notGitNote(runtime, place)
  if (!note) return []
  const action = notGitAction({ runtime, serverKey, locale, place, sessionID, testid: "session-menu" })
  return [
    "separator",
    { note: discoverText.text(locale, note), testid: "session-menu-not-git" },
    ...(action ? [action] : []),
  ]
}

/**
 * What follows the not-Git note in a menu: `Git 저장소로 만들기…` where {@link gitInitEntry} allows it (06 §3.0), or
 * `프로젝트 폴더 열기…` in the 기본 대화 폴더, which stays a plain folder (03 §5.1). Absent otherwise, and the note stands
 * alone: this server's own.team has no `git-init` (an older service, or a server without own.team), the connection
 * has no `local` scope (a phone or another PC through the gateway: the folder is not theirs to write, like upstream
 * `vcs.init`), or the project list and own.team's health have not answered yet. `testid` prefixes the item's id.
 */
export function notGitAction(input: {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly locale: Locale
  readonly place: ProjectPlace
  /** The conversation the menu belongs to: the dialog's `팀 모드 켜기…` then starts from it, as its own `⋯` does. */
  readonly sessionID?: string
  readonly testid: string
}): Extract<MenuItem, { readonly label: string }> | undefined {
  const folder = gitInitEntry(input.runtime, input.place)
  if (folder)
    return {
      label: discoverText.text(input.locale, "own.discover.gitInit.action"),
      onSelect: () =>
        openGitInit({
          serverKey: input.serverKey,
          directory: folder,
          projectID: input.place.projectID,
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        }),
      testid: `${input.testid}-git-init`,
    }
  if (!isDefaultFolder(input.runtime, input.place.directory)) return undefined
  return {
    label: discoverText.text(input.locale, "own.discover.defaultFolder.open"),
    onSelect: () => void openProject(input.serverKey),
    testid: `${input.testid}-open-folder`,
  }
}

/** Menu groups with a separator between the ones that have items. */
export function joinGroups(...groups: ReadonlyArray<readonly MenuItem[]>): MenuItem[] {
  return groups.filter((group) => group.length > 0).flatMap((group, index) => (index ? ["separator", ...group] : group))
}

const key = (context: MenuContext) => projectKey(context.serverKey, context.projectID)

/** The new-session screen of the project with the worktree choice set; the first message creates or uses it. */
export function startIn(context: MenuContext, choice: Choice) {
  const project = projectRef(context.runtime, context.projectID)
  worktreeChoices.set(key(context), choice)
  if (project)
    setNewSessionTarget({
      serverKey: context.serverKey,
      projectID: context.projectID,
      directory: project.root,
      name: baseName(project.root),
    })
  context.navigate({ name: "project", serverKey: context.serverKey, projectID: context.projectID })
  requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
}

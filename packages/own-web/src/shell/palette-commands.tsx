// Palette commands of the P7 feature modules (03 §19.15 "팔레트에 터미널·리뷰·워크트리·패널 탭·… 명령"), registered once
// by the shell with `usePaletteCommands` (palette/registry.ts): the feature modules export their actions and this
// component lists them for the session or project on screen. Built-in commands (panels, pages, compact, fork,
// export, terminal, theme…) are the palette's own; anything that only registers a shortcut (find, quick open, message
// navigation, Alt+B) appears there automatically. Every command only opens the module's own confirmation or dialog,
// except `팀 모드 켜기` (06 §9.2), which starts without a dialog and shows progress toasts. It appears for a Git project
// once own.team's health and the team strings are there (the palette asks for both when it opens). `다른 도구의 대화
// 열기` (09 §6 entry 3) opens the import list of the project on screen, Git or not, once own.import's health says it
// is there and this connection may list (asked when the palette opens). 19.11a: `보관함 보기` everywhere, `세션 삭제…`
// (`admin`, a root session; the confirmation of the sidebar's delete dialog), and the `session.archive` shortcut
// (Ctrl+Alt+Backspace by default), which the `보관` / `보관 해제` command shows. 03 §4.3.1: `팀 보기`, the not-Git explanations of
// the team and worktree commands, `처음 안내 다시 보기`, `설명서 열기`, and Korean words (`팀 모드`, `작업 폴더`) on them.
import { useQuitCommands } from "@/app-quit"
import { openBackgroundList } from "@/background"
import { LOCAL, useData, type ServerKey } from "@/data"
import { openGitInit } from "@/discover/git-init"
import { notGitAction } from "@/discover/menus"
import { explorerEntries } from "@/explorer"
import {
  gitInitEntry,
  hintsClosed,
  notGitFeatureNote,
  setHintsClosed,
  teamEntry,
  worktreeEntry,
} from "@/discover/model"
import { discoverText, type DiscoverKey } from "@/discover/strings"
import { forkText, openForkDialog } from "@/forking"
import { gitText, requestGitAction, type GitRequestAction } from "@/git"
import { translate, useI18n } from "@/i18n"
import { importStore, openImport } from "@/import"
import { manualBase, openManual, type ManualPlace } from "@/manual"
import { useShortcut } from "@/keyboard"
import { openNotes } from "@/notes"
import { usePaletteCommands, type PaletteCommand } from "@/palette"
import { baseName } from "@/projects/path"
import { openReview } from "@/review"
import { useRouter } from "@/routing/router"
import { routePath, routeServer } from "@/routing/routes"
import { useShell } from "@/shell/context"
import { openSessionDelete, setSidebarArchiveView, useSessionFlagActions } from "@/sidebar"
import { openSide } from "@/side"
import { openSkills, skillsText } from "@/skills"
import { showToast } from "@/switcher/toast"
import { canEnableTeam, prepareTeamEntries, teamLabel, useEnableTeam } from "@/team/enable"
import { openTeamView } from "@/team/intents"
import {
  canMoveSession,
  knownProjectID,
  openWorktreeMove,
  openWorktreeRemove,
  projectRef,
  workPlace,
  worktreeText,
} from "@/worktree"
import { projectKey, worktreeChoices } from "@/worktree/state"

const GIT_ACTIONS: readonly GitRequestAction[] = ["commit", "push", "pr"]
/** Words people type for team mode and worktrees (03 §4.3.1), in both languages. */
const TEAM_WORDS = ["team", "team mode", "팀", "팀 모드", "팀모드"]
const MANUAL_WORDS = ["manual", "help", "guide", "docs", "설명서", "도움말", "사용법", "안내서"]
const MANUAL_COMMANDS: ReadonlyArray<{
  readonly place: ManualPlace
  readonly label?: DiscoverKey
  readonly words: readonly string[]
}> = [
  { place: "top", words: [] },
  { place: "team", label: "own.discover.manual.team", words: TEAM_WORDS },
  { place: "shortcuts", label: "own.discover.manual.shortcuts", words: ["shortcuts", "keys", "단축키"] },
]
const WORKTREE_WORDS = ["작업 폴더", "작업폴더", "워크트리", "worktree", "work folder", "branch", "브랜치"]
const GIT_LABEL = { commit: "own.git.commit", push: "own.git.push", pr: "own.git.pr" } as const

export function PaletteFeatureCommands() {
  const data = useData()
  const router = useRouter()
  const i18n = useI18n()
  const flags = useSessionFlagActions()
  const enableTeam = useEnableTeam()
  const shell = useShell()
  // 05 §7.3: `앱 종료`, `완전 종료…` and Ctrl+Q, desktop only.
  useQuitCommands()

  /** The open root session this window may flag (`prompt`), with its title; `undefined` elsewhere. */
  function flaggable() {
    const route = router.route()
    if (route.name !== "session") return undefined
    const runtime = data.get(route.serverKey)
    if (!runtime?.rpc.can("prompt")) return undefined
    const info = runtime.data.session.get(route.sessionID)
    const row = runtime.sessions.state.sessions[route.sessionID]
    if (info?.parentID ?? row?.parentID) return undefined
    const state = flags.state(route.serverKey, route.sessionID)
    if (!state) return undefined
    const title = info?.title ?? row?.title ?? i18n.t("own.shell.untitled")
    return { serverKey: route.serverKey, sessionID: route.sessionID, archived: state.archived, title }
  }

  // 19.11a: archive (or unarchive) the open session from the keyboard, with the same toast and `보관 취소`.
  useShortcut("session.archive", () => {
    const target = flaggable()
    if (!target) return false
    void flags.toggle(target.serverKey, target.sessionID, "archived", !target.archived, target.title)
  })

  /** The `보관함` view in the sidebar (opened first; on the phone tier the list screen). */
  function showArchive() {
    if (!shell.sidebarOpen()) shell.toggleSidebar()
    if (shell.mode().sidebarMode === "list" && routePath(router.route()) !== "/") router.navigate({ name: "home" })
    setSidebarArchiveView(true)
  }

  usePaletteCommands(() => {
    const route = router.route()
    const serverKey: ServerKey = routeServer(route)
    const runtime = data.get(serverKey)
    if (!runtime) return []
    const locale = i18n.locale()
    const other = locale === "ko" ? "en" : "ko"
    const sessionID = route.name === "session" ? route.sessionID : undefined
    const info = sessionID ? runtime.data.session.get(sessionID) : undefined
    const row = sessionID ? runtime.sessions.state.sessions[sessionID] : undefined
    const directory = info?.location.directory ?? row?.directory
    const projectID =
      route.name === "project"
        ? route.projectID
        : (info?.projectID ?? row?.projectID ?? knownProjectID(runtime, directory ?? ""))
    const project = projectID ? projectRef(runtime, projectID) : undefined
    const git = project?.vcs === "git"
    const canPrompt = runtime.rpc.can("prompt")
    const child = !!(info?.parentID ?? row?.parentID)
    const title = info?.title ?? row?.title ?? i18n.t("own.shell.untitled")
    const commands: PaletteCommand[] = [
      {
        id: "sidebar.archive",
        group: "navigate",
        title: flags.label("own.sidebar.archiveOpen"),
        keywords: ["archive", "보관함", "trash"],
        run: () => showArchive(),
      },
      // 03 §4.1.1: this window's workspace view (split right/down and closing are shortcut commands, keymap `pane.*`).
      ...(shell.splitCapable()
        ? [
            {
              id: "pane.mode",
              group: "view",
              title: i18n.t(shell.panes.mode() === "split" ? "own.pane.mode.tabs" : "own.pane.mode.split"),
              keywords: ["split view tabs side by side panes", "분할 나란히 탭 화면 나누기"],
              run: () => shell.setPaneMode(shell.panes.mode() === "split" ? "tabs" : "split"),
            } satisfies PaletteCommand,
          ]
        : []),
    ]

    // 19.2: the review tab's Git bar actions, each through its confirmation dock.
    if (sessionID && git && canPrompt)
      for (const action of GIT_ACTIONS)
        commands.push({
          id: `git.${action}`,
          group: "git",
          title: gitText(locale, GIT_LABEL[action]),
          keywords: [gitText(other, GIT_LABEL[action]), "git", action],
          run: () => {
            openReview({ serverKey, sessionID, mode: "working" })
            requestGitAction({ serverKey, sessionID, action })
          },
        })

    // 19.3: a new session in a new worktree, moving this one, cleaning up the worktree it runs in.
    if (git && projectID && canPrompt) {
      commands.push({
        id: "worktree.new",
        group: "worktree",
        title: i18n.t("own.palette.p7.worktreeNew"),
        keywords: ["worktree", worktreeText.text(other, "own.worktree.new"), ...WORKTREE_WORDS],
        run: () => {
          const key = projectKey(serverKey, projectID)
          worktreeChoices.set(key, { mode: "new", base: worktreeChoices.get(key)?.base })
          router.navigate({ name: "project", serverKey, projectID })
          requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
        },
      })
      if (sessionID && canMoveSession(runtime, sessionID))
        commands.push({
          id: "worktree.move",
          group: "worktree",
          title: worktreeText.text(locale, "own.worktree.move.action"),
          keywords: ["worktree", worktreeText.text(other, "own.worktree.move.action"), ...WORKTREE_WORDS],
          run: () => openWorktreeMove({ serverKey, sessionID }),
        })
      const place = sessionID ? workPlace(runtime, sessionID) : undefined
      if (place?.kind === "worktree")
        commands.push({
          id: "worktree.remove",
          group: "worktree",
          title: i18n.t("own.palette.p7.worktreeRemove"),
          detail: place.name,
          keywords: ["worktree", "remove", ...WORKTREE_WORDS],
          run: () => openWorktreeRemove({ serverKey, projectID, directory: place.directory }),
        })
    }

    // 06 §9.2: the conversation's folder becomes the main folder; on a project page the server picks one (3.2).
    const teamDirectory = directory ?? project?.root
    if (git && teamDirectory) {
      // Reads health and loads the strings outside this computation; the command appears when both are there.
      queueMicrotask(() => prepareTeamEntries(runtime))
      const title = teamLabel(locale, "own.team.enable")
      if (title && canEnableTeam(runtime, { directory: teamDirectory, projectID, sessionID }))
        commands.push({
          id: "team.enable",
          group: "project",
          title,
          keywords: [teamLabel(other, "own.team.enable") ?? "", ...TEAM_WORDS],
          run: () => void enableTeam({ serverKey, directory: teamDirectory, sessionID }),
        })
    }

    // 03 §4.3.1: `팀 보기` for a project with a team on; for a project that is not a Git repository, the team and
    // worktree commands that would be here say why they are missing (a toast, with the menus' way out: `Git 저장소로
    // 만들기…`, or `프로젝트 폴더 열기…` in the 기본 대화 폴더) instead of being absent.
    if (projectID) {
      // own.team's health says whether team mode exists here: the local service carries it (another server is asked
      // for its Git projects above); read once per server, outside this computation.
      if (runtime.key === LOCAL) queueMicrotask(() => runtime.team.ensure())
      const place = { projectID, directory: project?.root }
      const team = teamEntry(runtime, place)
      const explain = (feature: "team" | "worktree") => {
        const way = notGitAction({ runtime, serverKey, locale, place, testid: "palette" })
        showToast({
          message: discoverText.text(locale, notGitFeatureNote(runtime, place, feature)),
          ...(way ? { action: { label: way.label, run: way.onSelect } } : {}),
        })
      }
      if (team?.kind === "view")
        commands.push({
          id: "team.view",
          group: "project",
          title: discoverText.text(locale, "own.discover.team.view"),
          keywords: [discoverText.text(other, "own.discover.team.view"), ...TEAM_WORDS],
          run: () => openTeamView({ serverKey, projectID }),
        })
      if (team?.kind === "notGit")
        commands.push({
          id: "team.notGit",
          group: "project",
          title: discoverText.text(locale, "own.discover.notGit.palette.team"),
          detail: project ? baseName(project.root) : undefined,
          keywords: [discoverText.text(other, "own.discover.notGit.palette.team"), ...TEAM_WORDS],
          run: () => explain("team"),
        })
      if (worktreeEntry(runtime, projectID) === "notGit")
        commands.push({
          id: "worktree.notGit",
          group: "worktree",
          title: discoverText.text(locale, "own.discover.notGit.palette.worktree"),
          detail: project ? baseName(project.root) : undefined,
          keywords: [discoverText.text(other, "own.discover.notGit.palette.worktree"), "worktree", ...WORKTREE_WORDS],
          run: () => explain("worktree"),
        })
      // 06 §3.0: the folder becomes a Git repository on the service that owns it.
      const folder = gitInitEntry(runtime, place)
      if (folder)
        commands.push({
          id: "project.gitInit",
          group: "project",
          title: discoverText.text(locale, "own.discover.gitInit.palette"),
          detail: baseName(folder),
          keywords: [
            discoverText.text(other, "own.discover.gitInit.palette"),
            "git init",
            "깃",
            "저장소",
            "repository",
            ...TEAM_WORDS,
            ...WORKTREE_WORDS,
          ],
          run: () => openGitInit({ serverKey, directory: folder, projectID }),
        })
    }
    // 03 §4.3.1: the in-app user manual, and its chapters for team mode and shortcuts.
    if (manualBase())
      commands.push(
        ...MANUAL_COMMANDS.map(
          (entry): PaletteCommand => ({
            id: `manual.${entry.place}`,
            group: "navigate",
            title: entry.label
              ? discoverText.text(locale, "own.discover.manual.chapter", {
                  chapter: discoverText.text(locale, entry.label),
                })
              : discoverText.text(locale, "own.discover.manual.open"),
            keywords: [
              entry.label
                ? discoverText.text(other, "own.discover.manual.chapter", {
                    chapter: discoverText.text(other, entry.label),
                  })
                : discoverText.text(other, "own.discover.manual.open"),
              ...MANUAL_WORDS,
              ...entry.words,
            ],
            run: () => openManual(entry.place),
          }),
        ),
      )
    if (hintsClosed())
      commands.push({
        id: "discover.hints",
        group: "view",
        title: discoverText.text(locale, "own.discover.hints.reopen"),
        keywords: [discoverText.text(other, "own.discover.hints.reopen"), "tips help 도움말 안내 팁"],
        run: () => {
          setHintsClosed(false)
          router.navigate({ name: "home" })
        },
      })

    // 09 §6 entry 3: the project on screen, Git or not.
    if (projectID) {
      const imports = importStore(runtime)
      queueMicrotask(() => imports.prepare())
      if (imports.available() === true)
        commands.push({
          id: "import.open",
          group: "project",
          title: i18n.t("own.otherTools.palette"),
          detail: project ? baseName(project.root) : undefined,
          keywords: [translate(other, "own.otherTools.palette"), "import", "codex", "claude", "가져오기"],
          run: () => openImport({ serverKey, projectID }),
        })
    }

    // 05 §8.8: the workspace `노트` tab (project notes), the same as the workspace header's `노트` button.
    commands.push({
      id: "notes.workspace",
      group: "notes",
      title: i18n.t("own.palette.p7.projectNotes"),
      keywords: [translate(other, "own.palette.p7.projectNotes"), "note", "notes", "노트"],
      run: () => shell.openNotes(),
    })

    // 03 §19.5: `탐색기에서 열기` for the open conversation's working folder, where the host can (the desktop app).
    commands.push(
      ...(explorerEntries()?.commands(runtime, serverKey, directory ?? project?.root, locale) ?? []),
    )

    if (!sessionID) return commands

    // 03 §4.4.2 곁질문: the side panel of this conversation, where this connection may ask.
    if (runtime.rpc.allowed("side.ask"))
      commands.push({
        id: "side.ask",
        group: "session",
        title: locale === "en" ? "Side question…" : "곁질문…",
        keywords: ["btw"],
        run: () => openSide({ serverKey, sessionID }),
      })

    // 19.12: the fork dialog (the whole-session fork and compact are built-in commands).
    if (canPrompt)
      commands.push({
        id: "session.forkFrom",
        group: "sessionOps",
        title: forkText(locale, "own.fork.fromMessage"),
        keywords: [forkText(other, "own.fork.fromMessage"), "fork"],
        run: () => openForkDialog({ serverKey, sessionID }),
      })
    // 19.10 `대화 메모` of this conversation; the workspace `노트` tab (project notes, 05 §8.8) is `notes.workspace`.
    commands.push({
      id: "notes.open",
      group: "sessionOps",
      title: i18n.t("own.palette.p7.notes"),
      keywords: [translate(other, "own.palette.p7.notes"), "memo", "메모"],
      run: () => openNotes({ serverKey, sessionID }),
    })
    // 19.11 (through the sidebar's flag store of this server)
    const state = child ? undefined : flags.state(serverKey, sessionID)
    if (state && !state.archived)
      commands.push({
        id: "session.pin",
        group: "sessionOps",
        title: flags.label(state.pinned ? "own.sidebar.unpin" : "own.sidebar.pin"),
        keywords: ["pin", "고정"],
        run: () => void flags.toggle(serverKey, sessionID, "pinned", !state.pinned, title),
      })
    if (state && canPrompt)
      commands.push({
        id: "session.archive",
        group: "sessionOps",
        title: flags.label(state.archived ? "own.sidebar.unarchive" : "own.sidebar.archive"),
        keywords: ["archive", "보관"],
        shortcut: "session.archive",
        run: () => void flags.toggle(serverKey, sessionID, "archived", !state.archived, title),
      })
    if (!child && runtime.rpc.can("admin"))
      commands.push({
        id: "session.delete",
        group: "sessionOps",
        title: flags.label("own.sidebar.deleteSession"),
        keywords: ["delete", "remove", "삭제", "지우기"],
        run: () =>
          openSessionDelete({ serverKey, sessions: [{ id: sessionID, title }], archivedOnly: state?.archived }),
      })
    // 19.7 / 19.6: the composer's background list and skills popover of this session.
    commands.push({
      id: "background.list",
      group: "sessionOps",
      title: i18n.t("own.palette.p7.background"),
      keywords: ["background", "백그라운드"],
      run: () => openBackgroundList(),
    })
    if (!child)
      commands.push({
        id: "skills.open",
        group: "sessionOps",
        title: skillsText(locale, "own.skills.open"),
        keywords: ["skills", "skill", skillsText(other, "own.skills.open")],
        run: () => openSkills(),
      })
    return commands
  })

  return null
}

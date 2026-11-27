// Session header `⋯` (03 §4.4: 포크, 이 메시지에서 포크, 압축, 압축 내용 보기 (§4.5), 내보내기, 노트, 고정, 보관,
// 에이전트 방식 바꾸기…, 삭제; 19.3 `다른 작업 폴더로 옮기기…`;
// 01 §10.2 `이 세션에서 컴퓨터 사용…`; 06 §9.2 `팀 모드 켜기`, §9.5 the `메인 멈춤` switch of an owner conversation, and the
// peer items (동료): `동료로 등록…` in an area's folder, `역할 바꾸기…` and `동료에서 빼기` on a peer, in the area menu;
// `이 대화를 담당으로` (6.8) for a conversation that may take its area's seat, whose confirm is an area menu panel;
// 03 §4.3.1 the not-Git note with `Git 저장소로 만들기…` (06 §3.0); on the phone also 프로젝트 노트, 아이디어 노트 and 설정).
// Each item is the owning module's action: forking (19.12), commands (`/export`), notes (19.10), the sidebar's pin and
// archive flags (19.11), worktree (19.3), team mode (src/team/enable.ts), computer use (src/computer). Items a
// connection cannot use are left out (the forking module's `prompt` scope rule, `canMoveSession`, own.team's scopes
// and `health.features`; `삭제…` (19.11a) needs `admin` and a root session), and pin/archive wait for the sidebar's
// flag store of that server (and need `prompt`). Opening the menu asks
// own.team's health and loads the team strings once; the team items appear when both are there.
import { useBrowseMenu } from "@/browse"
import { useCommandActions } from "@/commands"
import { openCompactions } from "@/compactions"
import { useCompactionsText } from "@/compactions/strings"
import { useComputerMenu } from "@/computer"
import { useData, type ServerKey, type ServerRuntime } from "@/data"
import { sessionMenuExtras } from "@/discover/menus"
import { explorerEntries } from "@/explorer"
import { useForkMenuItems } from "@/forking"
import { requestHarnessMenu } from "@/harness"
import { useI18n } from "@/i18n"
import { openIdeas } from "@/ideas"
import { useIdeasText } from "@/ideas/strings"
import { openNotes } from "@/notes"
import { HostMenu, type MenuItem } from "@/servers/menu"
import { openSessionDelete, useSessionFlagActions } from "@/sidebar"
import {
  canEnableTeam,
  openPeerItem,
  pauseArea,
  PEER_ITEM_KEYS,
  peerItems,
  prepareTeamEntries,
  teamLabel,
  useEnableTeam,
} from "@/team/enable"
import { canMoveSession, openWorktreeMove, useWorktreeText } from "@/worktree"
import { createSignal } from "solid-js"
import { useShell } from "./context"
import type { LazyMenu } from "./session-menu-lazy"

export function SessionMenu(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const shell = useShell()
  const i18n = useI18n()
  const fork = useForkMenuItems(props.serverKey, props.sessionID)
  const actions = useCommandActions()
  const flags = useSessionFlagActions()
  const worktree = useWorktreeText()
  const computer = useComputerMenu(props.serverKey, props.sessionID)
  const browse = useBrowseMenu(props.serverKey, props.sessionID)
  const enableTeam = useEnableTeam()
  const compactions = useCompactionsText()
  const ideas = useIdeasText()
  // 문맥 비우기 (03 §18.18) and a device's 브라우저 (05 §8.10): their items come with a lazy chunk, loaded when the menu
  // first opens (session-menu-lazy.ts).
  const [lazy, setLazy] = createSignal<LazyMenu>()

  const items = (): MenuItem[] => {
    const runtime = data.get(props.serverKey())
    const sessionID = props.sessionID()
    if (!runtime || !sessionID) return []
    const serverKey = props.serverKey()
    const child = !!runtime.data.session.get(sessionID)?.parentID
    const title =
      runtime.data.session.get(sessionID)?.title ??
      runtime.sessions.state.sessions[sessionID]?.title ??
      i18n.t("own.shell.untitled")
    const context = { runtime, serverKey, sessionID, directory: runtime.sessions.directory(sessionID) }
    const state = child || !runtime.rpc.can("prompt") ? undefined : flags.state(serverKey, sessionID)
    const more = lazy()?.({ data, shell, runtime, sessionID, locale: i18n.locale() })
    return [
      ...fork()
        .filter((item) => !item.disabled)
        .map((item) => ({ label: item.label, onSelect: () => item.run(), testid: `session-menu-${item.id}` })),
      // 03 §4.5 (UC 2026-10-18): what the model gets instead of the older messages; reading only, any connection.
      {
        label: compactions("own.compactions.open"),
        onSelect: () => openCompactions({ serverKey, sessionID }),
        testid: "session-menu-compactions",
      },
      ...(more?.reset ?? []),
      ...(more?.side ?? []),
      "separator",
      {
        label: i18n.t("own.header.export"),
        onSelect: () => void actions.exportSession(context),
        testid: "session-menu-export",
      },
      {
        label: i18n.t("own.header.notes"),
        onSelect: () => openNotes({ serverKey, sessionID }),
        testid: "session-menu-notes",
      },
      ...(more?.browser ?? []),
      // The phone (MUX) and an unfolded foldable (Fold8): the lone 대화 tab strip is hidden, so the project notebook
      // opens from here (4.2 phone tier).
      ...(shell.handheld()
        ? [
            {
              label: i18n.t("own.shell.notes.dock"),
              onSelect: () => {
                shell.openNotes()
                shell.selectWorkspaceTab("notes")
              },
              testid: "session-menu-project-notes",
            },
            // S23 pass: the header's bulb and gear left a handheld conversation header (styles/shell.css).
            { label: ideas("own.ideas.title"), onSelect: () => openIdeas("board"), testid: "session-menu-ideas" },
            {
              label: i18n.t("own.nav.settings"),
              onSelect: () => shell.togglePage({ name: "settings", section: "general", list: true }),
              testid: "session-menu-settings",
            },
          ]
        : []),
      ...(state && !state.archived
        ? [
            {
              label: flags.label(state.pinned ? "own.sidebar.unpin" : "own.sidebar.pin"),
              onSelect: () => void flags.toggle(serverKey, sessionID, "pinned", !state.pinned, title),
              testid: "session-menu-pin",
            },
          ]
        : []),
      ...(state
        ? [
            {
              label: flags.label(state.archived ? "own.sidebar.unarchive" : "own.sidebar.archive"),
              onSelect: () => void flags.toggle(serverKey, sessionID, "archived", !state.archived, title),
              testid: "session-menu-archive",
            },
          ]
        : []),
      // 10 §3.8: the 에이전트 방식 menu, also when the header pill is hidden on a narrow header.
      ...(!child && runtime.harness.allowed("session.set")
        ? [
            {
              label: i18n.t("own.harness.sessionMenu"),
              onSelect: () => requestHarnessMenu(serverKey, sessionID),
              testid: "session-menu-harness",
            },
          ]
        : []),
      ...teamItems(runtime, serverKey, sessionID, context.directory),
      ...computer.items(),
      ...browse.items(),
      ...(canMoveSession(runtime, sessionID)
        ? [
            {
              label: worktree("own.worktree.move.action"),
              onSelect: () => openWorktreeMove({ serverKey, sessionID }),
              testid: "session-menu-move",
            },
          ]
        : []),
      // 03 §19.5: `탐색기에서 열기` for the conversation's working folder, where the host can (the desktop app).
      ...(explorerEntries()?.sessionItems(runtime, serverKey, context.directory, i18n.locale()) ?? []),
      // 03 §4.3.1: a project that is not a Git repository says why the team and worktree items are missing, with
      // `Git 저장소로 만들기…` (06 §3.0) where this connection may, or `프로젝트 폴더 열기…` in the 기본 대화 폴더.
      ...sessionMenuExtras(runtime, serverKey, i18n.locale(), sessionID),
      ...(!child && runtime.rpc.can("admin")
        ? [
            "separator" as const,
            {
              label: flags.label("own.sidebar.delete"),
              onSelect: () =>
                openSessionDelete({
                  serverKey,
                  sessions: [{ id: sessionID, title }],
                  archivedOnly: flags.state(serverKey, sessionID)?.archived,
                }),
              testid: "session-menu-delete",
              tone: "danger" as const,
            },
          ]
        : []),
    ]
  }

  /**
   * 06 §9.2 `팀 모드 켜기` for a root conversation outside a team; 9.5 `메인 멈춤` for the area's current owner; the peer
   * items (team/enable.ts `peerItems`).
   */
  function teamItems(
    runtime: ServerRuntime,
    serverKey: ServerKey,
    sessionID: string,
    directory: string | undefined,
  ): MenuItem[] {
    const locale = i18n.locale()
    const projectID =
      runtime.data.session.get(sessionID)?.projectID ?? runtime.sessions.state.sessions[sessionID]?.projectID
    const enable = teamLabel(locale, "own.team.enable")
    const place = runtime.team.areaOfSession(sessionID)
    const area = place?.areaID && !place.previous ? runtime.team.area(place.teamID, place.areaID) : undefined
    const pause =
      area && runtime.team.has("pause") && runtime.team.rpc.allowed("area.pause")
        ? teamLabel(locale, area.paused ? "own.team.action.pauseOff" : "own.team.action.pauseOn")
        : undefined
    const peer = peerItems(runtime, { sessionID, directory })
    return [
      ...(enable && directory && canEnableTeam(runtime, { directory, projectID, sessionID })
        ? [
            {
              label: enable,
              onSelect: () => void enableTeam({ serverKey, directory, sessionID }),
              testid: "session-menu-team-enable",
            },
          ]
        : []),
      ...(area && pause
        ? [
            {
              label: pause,
              onSelect: () => void pauseArea(runtime, { teamID: area.teamID, areaID: area.id }, !area.paused, locale),
              testid: "session-menu-team-pause",
            },
          ]
        : []),
      ...(peer
        ? peer.items.flatMap((item) => {
            const label = teamLabel(locale, PEER_ITEM_KEYS[item])
            return label
              ? [{ label, onSelect: () => openPeerItem(serverKey, peer, item), testid: `session-menu-peer-${item}` }]
              : []
          })
        : []),
    ]
  }

  return (
    <HostMenu
      label={i18n.t("own.header.more")}
      items={items}
      onOpen={() => {
        if (!lazy()) void import("./session-menu-lazy").then((module) => setLazy(() => module.lazyMenuItems))
        computer.prepare()
        browse.prepare()
        prepareTeamEntries(data.get(props.serverKey()))
      }}
      testid="session-menu"
    />
  )
}

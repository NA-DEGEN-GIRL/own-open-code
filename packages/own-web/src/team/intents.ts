// Cross-screen requests of the team screens (06 §9): the area menu (header pill, area rows), the team view (main
// session pill, project menu), settings 팀 (the summary card's auto-allow `[바꾸기]`), the switcher for an area's
// model (`모델 바꾸기…`), since 2026-10-16 the `팀 모드 켜기…` dialog (every enable entry point) and since 2026-10-26
// the `영역 만들기…` dialog (the team view's row, the project menu, the worktree picker's `새 영역`). The module that owns each screen registers its handler on `teamIntents.<kind>`; a request made
// before that handler exists (a lazy chunk still loading) waits here and goes to the handler when it registers. Only
// the latest request of a kind waits.
import type { OwnTeam } from "@own/protocol/rpc-team"
import type { ServerKey } from "@/data"
import type { EnableRequest } from "./enable"

export interface AreaTarget {
  readonly serverKey: ServerKey
  /** Area ids are unique within a team only (06 §2.4). */
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  /** The element the menu or popover opens at; absent: the handler picks one. */
  readonly anchor?: HTMLElement | null
  /**
   * Open the area menu at this panel (`retire`: 영역 끝내기, `recreate`: 다시 만들기, `registerPeer`: 동료로 등록… of
   * `sessionID`, `editPeer` / `removePeer`: 역할 바꾸기… / 동료에서 빼기 of the peer `peer`, `addPeer`: 동료 추가…, from
   * the result card of an area the user created, `seat`: the confirm of 이 대화를 담당으로 for `sessionID`); absent:
   * the menu itself.
   */
  readonly panel?: "retire" | "recreate" | "registerPeer" | "editPeer" | "removePeer" | "addPeer" | "seat"
  /** 동료로 등록…: the conversation to register. 이 대화를 담당으로: the conversation that takes the seat. */
  readonly sessionID?: string
  /** 역할 바꾸기… / 동료에서 빼기: the peer's key in the area (`Peer.key`). */
  readonly peer?: string
}

export interface TeamViewTarget {
  readonly serverKey: ServerKey
  readonly projectID: string
}

/** 영역 만들기 (06 §9.4, 2026-10-26): the team the new area goes into. */
export interface CreateAreaTarget {
  readonly serverKey: ServerKey
  readonly teamID: OwnTeam.TeamID
}

export interface TeamSettingsTarget {
  readonly serverKey?: ServerKey
  readonly teamID?: OwnTeam.TeamID
}

/** One kind of request: the screen that answers it registers once (the last registration wins). */
export interface TeamIntentChannel<T> {
  send(request: T): void
  /** Takes requests from now on, starting with the one that waited; the release leaves a newer handler in place. */
  register(handler: (request: T) => void): () => void
}

function channel<T>(): TeamIntentChannel<T> {
  const slot: { handler?: (request: T) => void; held?: T } = {}
  return {
    send(request) {
      if (slot.handler) return slot.handler(request)
      slot.held = request
    },
    register(handler) {
      slot.handler = handler
      const held = slot.held
      slot.held = undefined
      if (held) handler(held)
      return () => {
        if (slot.handler === handler) slot.handler = undefined
      }
    },
  }
}

export const teamIntents = {
  areaMenu: channel<AreaTarget>(),
  teamView: channel<TeamViewTarget>(),
  teamSettings: channel<TeamSettingsTarget>(),
  areaSwitcher: channel<AreaTarget>(),
  enableDialog: channel<EnableRequest>(),
  createArea: channel<CreateAreaTarget>(),
}

/** The area's `⋯` menu (06 §9.4): from the owner and peer headers' pill, the area rows and the peer items. */
export function openAreaMenu(target: AreaTarget) {
  teamIntents.areaMenu.send(target)
}

/** The project's team view in the sidebar (06 §9.4): from the main session's pill and the project menu. */
export function openTeamView(target: TeamViewTarget) {
  teamIntents.teamView.send(target)
}

/** Settings 팀 (06 §9.8), on the given team when one is named. */
export function openTeamSettings(target: TeamSettingsTarget = {}) {
  teamIntents.teamSettings.send(target)
}

/** The switcher on an area's model (`모델 바꾸기…`, 06 §10.1): `팀과 같게` on top, lists filtered by the team's R4. */
export function openSwitcherForArea(target: AreaTarget) {
  teamIntents.areaSwitcher.send(target)
}

/** 팀 모드 켜기… (06 §9.2, 2026-10-16): the goal dialog, mounted by the sidebar like the area menu. */
export function openEnableDialog(request: EnableRequest) {
  teamIntents.enableDialog.send(request)
}

/** 영역 만들기… (06 §9.4, 2026-10-26): the dialog, mounted by the sidebar like the area menu. */
export function openCreateArea(target: CreateAreaTarget) {
  teamIntents.createArea.send(target)
}

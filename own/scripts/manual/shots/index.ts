// The capture groups, in run order (PLAN.md §4.2 worlds, §6 shots).
import type { Endpoints, Shot } from "../lib/ctx"
import type { WorldPaths } from "../lib/privacy"
import type { World } from "../lib/world"
import { EMPTY, bootEmpty, emptyPaths } from "./empty"
import { MAIN, bootMain, mainPaths } from "./main"
import { DESKTOP_SHOTS, PANE_SHOTS, bootDesktop, bootPane } from "./desktop"
import { GATEWAY, bootGateway, gatewayPaths } from "./gateway"
import { REMOTE, bootRemote, remotePaths } from "./remote"
import { TEAM, bootTeam } from "./team"
import { UPDATES_MAIN, UPDATES_TEAM } from "./updates"
import { UPDATES2_MAIN } from "./updates2"
import { UPDATES3_MAIN } from "./updates3"

export interface Group {
  readonly name: string
  readonly title: string
  boot(): Promise<World<Endpoints>>
  paths(state: never): WorldPaths
  readonly shots: ReadonlyArray<Shot<never>>
}

/**
 * The team story in order: 17-peer adds a peer to 게임 로직, so it runs before 17-retire ends that area (a whole T run
 * used to stop at 17-peer with `area not found`).
 */
const TEAM_SHOTS = TEAM.flatMap((shot) =>
  shot.id === "17-retire" ? [...UPDATES_TEAM.filter((item) => item.id === "17-peer"), shot] : [shot],
)

export const GROUPS: ReadonlyArray<Group> = [
  { name: "M", title: "주 데모(space-game)", boot: () => bootMain(), paths: mainPaths, shots: [...MAIN, ...UPDATES_MAIN, ...UPDATES2_MAIN, ...UPDATES3_MAIN] },
  { name: "E", title: "계정 0개 첫 화면", boot: bootEmpty, paths: emptyPaths, shots: EMPTY },
  { name: "T", title: "팀 모드", boot: bootTeam, paths: mainPaths, shots: [...TEAM_SHOTS, ...UPDATES_TEAM.filter((item) => item.id !== "17-peer")] },
  { name: "R", title: "SSH 원격", boot: bootRemote, paths: remotePaths, shots: REMOTE },
  { name: "G", title: "휴대폰·다른 PC", boot: bootGateway, paths: gatewayPaths, shots: GATEWAY },
  { name: "D", title: "데스크톱 셸: 모바일 미리보기", boot: bootDesktop, paths: gatewayPaths, shots: DESKTOP_SHOTS },
  { name: "B", title: "데스크톱 셸: 브라우저 패인", boot: bootPane, paths: mainPaths, shots: PANE_SHOTS },
]

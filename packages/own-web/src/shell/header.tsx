// Session header (03 §4.4). On desktop it rides the WCO band (4.2.1); on the web it is a 52 px row. Right side: the
// team pill of a team session (06 §9.5), the running-on pill, the computer-use chip of a session that has it on
// (01 §10.2), the approval-mode pill (18.8; on the new-session screen it edits the new-session default, 5.1),
// theme toggle, the settings button (4.3.1), the session `⋯` menu (session-menu.tsx) and the panel toggle; the session-info drawer is not built yet
// (the context meter sits in the composer toolbar). After the title: the running menu (`작업 중 n ▾`, the running
// subagents and background shells, src/background/running-menu.tsx) and the Git branch/status chip (19.15).
// A subagent session's title slot is the breadcrumb of every ancestor (18.11). A conversation own.import imported
// carries `<Codex|Claude Code>에서 가져옴` after the title (09 §4.7, from its session metadata); the badge opens the
// import details (origin, time, mode, summarizer, redactions, `원본 보기`), a lazy chunk of src/import.
// A crowded conversation header gives way in a fixed order (the computer chip, the team pill, the approval pill) so the
// running-on pill keeps its account whole (./header-fit.ts).
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createMemo, createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { RunningMenu } from "@/background"
import { ChatViewMenu } from "@/chat-view"
import { ComputerChip } from "@/computer"
import { importOrigin, useData, type ServerKey, type TeamStore } from "@/data"
import { SettingsButton } from "@/discover/settings-button"
import { GitStatusChip } from "@/git"
import { IdeasButton } from "@/ideas"
import { useI18n } from "@/i18n"
import { HarnessPill } from "@/harness"
import { ApprovalModePill } from "@/requests"
import { useRouter } from "@/routing/router"
import { routeServer } from "@/routing/routes"
import { ServerBadge } from "@/servers"
import { isChildSession, SubagentBreadcrumb } from "@/subagent"
import { RunningOnPill } from "@/switcher"
import { openAreaMenu, openTeamView } from "@/team/intents"
import type { TeamText } from "@/team/model"
import type { TeamKey } from "@/team/strings"
import { SessionTitle } from "@/transcript"
import { useShell } from "./context"
import { watchHeaderFit } from "./header-fit"
import { Icon } from "./icons"
import { useTeamWords } from "./session-banners"
import { SessionMenu } from "./session-menu"
import { ThemeToggle } from "./theme-toggle"

const OriginDetails = lazy(() => import("@/import/dialog").then((module) => ({ default: module.OriginDetails })))

export function SessionHeader() {
  const shell = useShell()
  const router = useRouter()
  const i18n = useI18n()
  const route = router.route
  const sessionID = () => {
    const current = route()
    return current.name === "session" ? current.sessionID : undefined
  }
  const serverKey = () => {
    const current = route()
    return routeServer(current)
  }
  const data = useData()
  const child = () => isChildSession(data.get(serverKey()), sessionID())
  /** The phone's conversation list (`/`, 4.2): the one screen without a back button. */
  const phoneList = () => {
    const current = route()
    return current.name === "home" && !current.serverKey
  }
  /** The session view or the new-session screen (home, a project), not a page. */
  const workspace = () => {
    const name = route().name
    return name === "session" || name === "home" || name === "project"
  }
  const title = () => {
    const current = route()
    if (current.name === "accounts") return i18n.t("own.accounts.title")
    if (current.name === "accountsAdd") return i18n.t("own.page.accountsAdd")
    if (current.name === "limits") return i18n.t("own.page.limits")
    if (current.name === "settings") return i18n.t("own.page.settings")
    if (current.name === "import") return i18n.t("own.otherTools.title")
    return i18n.t("own.shell.newSessionTitle")
  }
  // What gives way in a crowded conversation header, by the room it has (./header-fit.ts, MR7-17).
  let header: HTMLElement | undefined
  onMount(() => onCleanup(watchHeaderFit(header!)))
  return (
    <header ref={header} class="own-header" data-testid="header" data-route={route().name}>
      {/* The phone: every screen but its conversation list (`/`) goes back to it, a server's new-conversation screen too. */}
      <Show when={shell.mode().sidebarMode === "list" && !phoneList()}>
        <button
          type="button"
          class="own-icon-button own-target"
          aria-label={i18n.t("own.shell.back")}
          data-testid="header-back"
          onClick={() => router.navigate({ name: "home" })}
        >
          <Icon name="left" />
        </button>
      </Show>
      <Show when={shell.mode().sidebarMode !== "list"}>
        <button
          type="button"
          class="own-icon-button own-target"
          aria-label={i18n.t("own.shell.sidebarToggle")}
          aria-pressed={shell.sidebarOpen()}
          data-testid="sidebar-toggle"
          onClick={() => shell.toggleSidebar()}
        >
          <Icon name={shell.mode().sidebarMode === "drawer" ? "menu" : "sidebar"} />
        </button>
      </Show>
      <Show when={!workspace()}>
        <button
          type="button"
          class="own-button own-target"
          data-testid="return-to-chat"
          onClick={() => shell.selectWorkspaceTab("chat")}
        >
          {i18n.t("own.shell.backToChat")}
        </button>
      </Show>
      <h1 class="own-header-title m-0 text-[14px]" data-testid="header-title">
        {/* Session routes: the title, or the breadcrumb of a child session (4.4, 18.11). */}
        <Show when={route().name === "session"} fallback={title()}>
          <Show when={child()} fallback={<SessionTitle serverKey={serverKey} sessionID={sessionID} />}>
            <SubagentBreadcrumb serverKey={serverKey} sessionID={sessionID} />
          </Show>
        </Show>
      </h1>
      {/* 4.4: `작업 중 2 ▾`, the running subagents and background shells (the parent's, in a subagent). */}
      <Show when={route().name === "session"}>
        <RunningMenu serverKey={serverKey} sessionID={sessionID} />
      </Show>
      {/* 19.15 [gap] 30: `⑂ main · ±3` next to the title; opens the review tab. */}
      <Show when={route().name === "session"}>
        <GitStatusChip serverKey={serverKey} sessionID={sessionID} />
      </Show>
      {/* 09 §4.7: `Codex에서 가져옴` on an imported conversation. */}
      <Show when={route().name === "session"}>
        <ImportBadge serverKey={serverKey} sessionID={sessionID} />
      </Show>
      {/* 4.4 / 04 §12.5: remote sessions and projects carry the host badge (hover: user@host:path). */}
      <Show when={workspace()}>
        <ServerBadge serverKey={serverKey} sessionID={sessionID} />
      </Show>
      {/* 06 §9.5: `영역: <이름> · 담당` or `· 동료(<이름>)` (area menu), or `팀 메인 · 영역 n개` (team view). */}
      <Show when={route().name === "session"}>
        <TeamPill serverKey={serverKey} sessionID={sessionID} />
      </Show>
      <RunningOnPill serverKey={serverKey} sessionID={sessionID} />
      {/* 01 §10.2: a session with computer use on shows it, its activity and the Stop button. */}
      <Show when={route().name === "session"}>
        <ComputerChip serverKey={serverKey} sessionID={sessionID} />
      </Show>
      {/* 10 §3.8: `Codex 방식` / `OpenCode 기본`; on the new-conversation screen, the one-time pick. */}
      <Show when={workspace()}>
        <HarnessPill serverKey={serverKey} sessionID={sessionID} />
      </Show>
      <Show when={workspace()}>
        <ApprovalModePill serverKey={serverKey} sessionID={sessionID} />
      </Show>
      {/* 4.5 대화 보기: which meta information the transcript shows (`대화만 보기`). */}
      <Show when={route().name === "session"}>
        <ChatViewMenu />
      </Show>
      {/* 03 §4.4.1: the global idea notes (아이디어 노트), on every screen and tier. */}
      <IdeasButton />
      <ThemeToggle />
      {/* 03 §4.3.1: settings on every screen and tier (Ctrl+,). */}
      <SettingsButton />
      {/* 4.4 `⋯`: fork, compact, export, notes, pin/archive, move to another worktree. */}
      <Show when={route().name === "session"}>
        <SessionMenu serverKey={serverKey} sessionID={sessionID} />
      </Show>
      {/* Pages hide the work panel (03 §5.7), so the toggle shows with the conversation only. */}
      <Show when={workspace()}>
        <button
          type="button"
          class="own-icon-button own-target"
          aria-label={i18n.t("own.panel.toggle")}
          aria-pressed={shell.panelOpen()}
          data-testid="panel-toggle"
          onClick={() => shell.togglePanel()}
        >
          <Icon name="panel" />
        </button>
      </Show>
    </header>
  )
}

/** `<도구>에서 가져옴` (09 §4.7): read from the session metadata; the details load on the first press. */
function ImportBadge(props: { readonly serverKey: () => ServerKey; readonly sessionID: () => string | undefined }) {
  const data = useData()
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const info = () => {
    const sessionID = props.sessionID()
    return sessionID ? data.get(props.serverKey())?.data.session.get(sessionID) : undefined
  }
  const origin = createMemo(() => importOrigin(info()?.metadata))
  return (
    <Show when={origin()}>
      {(current) => (
        <>
          <button
            type="button"
            class="own-target inline-flex h-7 shrink-0 items-center rounded-full border border-own-border px-2.5 text-[12px] text-own-muted hover:bg-own-hover"
            title={i18n.t("own.otherTools.badgeHint")}
            aria-haspopup="dialog"
            data-testid="import-badge"
            data-kind={current().kind}
            onClick={() => setOpen(true)}
          >
            <span class="max-w-[14rem] truncate">
              {i18n.t("own.otherTools.badge", { tool: i18n.t(`own.otherTools.tool.${current().kind}`) })}
            </span>
          </button>
          <Show when={open()}>
            <Suspense>
              <OriginDetails
                serverKey={props.serverKey()}
                projectID={info()?.projectID}
                origin={current()}
                onClose={() => setOpen(false)}
              />
            </Suspense>
          </Show>
        </>
      )}
    </Show>
  )
}

/** The header pill of a team session (06 §9.5). */
export type TeamPillView =
  | {
      readonly kind: "area"
      /**
       * `영역: <이름> · 담당`, `· 메인 멈춤` while Main 멈춤 is on, `· 지난 대화` for a replaced owner conversation,
       * `· 동료(<이름>)` for an area peer.
       */
      readonly key: Extract<
        TeamKey,
        "own.team.pill.owner" | "own.team.pill.paused" | "own.team.pill.previous" | "own.team.pill.peer"
      >
      readonly teamID: OwnTeam.TeamID
      readonly areaID: OwnTeam.AreaID
      readonly area: string
      /** An area peer's name (`Peer.label`). */
      readonly peer?: string
    }
  /** `팀 메인 · 영역 n`: the areas that are not finished. */
  | { readonly kind: "main"; readonly projectID: string; readonly areas: number }

/**
 * The pill for a session the registry knows (a metadata hint or a child session shows none): an owner's or a peer's
 * area, opening the area menu, or the current team main, opening the team view. A replaced main conversation gets no
 * pill. A peer's pill names it and stays the same under Main 멈춤 (the owner's says it).
 */
export function teamPill(team: TeamStore, sessionID: string): TeamPillView | undefined {
  const place = team.placeOf(sessionID)
  const entry = place && !place.hint ? team.team(place.teamID) : undefined
  if (!place || !entry) return undefined
  if (place.role === "main") {
    if (place.previous) return undefined
    const areas = entry.order.filter((id) => {
      const area = entry.areas[id]
      return area !== undefined && area.state !== "retired"
    }).length
    return { kind: "main", projectID: entry.team.projectID, areas }
  }
  const area = place.areaID ? entry.areas[place.areaID] : undefined
  if (!area) return undefined
  if (place.role === "peer") {
    const peer = area.peers?.find((item) => item.key === place.key)
    if (!peer) return undefined
    return {
      kind: "area",
      key: "own.team.pill.peer",
      teamID: area.teamID,
      areaID: area.id,
      area: area.name,
      peer: peer.label,
    }
  }
  const key = place.previous
    ? "own.team.pill.previous"
    : area.paused === false
      ? "own.team.pill.owner"
      : "own.team.pill.paused"
  return { kind: "area", key, teamID: area.teamID, areaID: area.id, area: area.name }
}

function TeamPill(props: { readonly serverKey: () => ServerKey; readonly sessionID: () => string | undefined }) {
  const data = useData()
  const words = useTeamWords()
  const pill = createMemo(() => {
    const runtime = data.get(props.serverKey())
    const sessionID = props.sessionID()
    return runtime && sessionID ? teamPill(runtime.team, sessionID) : undefined
  })
  function open(current: TeamPillView, anchor: HTMLElement) {
    if (current.kind === "main") return openTeamView({ serverKey: props.serverKey(), projectID: current.projectID })
    openAreaMenu({ serverKey: props.serverKey(), teamID: current.teamID, areaID: current.areaID, anchor })
  }
  // A crowded header drops the first words (./header-fit.ts step 2): what the short form leaves out of the whole text,
  // `팀 메인 · ` or `영역: `, so `영역 3개` and `cl-perf · 담당` remain. The short form ends every whole text
  // (team-banners.test.ts); one that did not would keep its whole text.
  const label = (text: TeamText, current: TeamPillView) => {
    // One parameter set for both keys (a union of the two literals would not be a string record).
    const params: Readonly<Record<string, string | number>> =
      current.kind === "main"
        ? { n: current.areas }
        : { area: current.area, ...(current.peer === undefined ? {} : { label: current.peer }) }
    const full = text(current.kind === "main" ? "own.team.pill.main" : current.key, params)
    const short = text(current.kind === "main" ? "own.team.pill.mainShort" : `${current.key}Short`, params)
    return { full, lead: full.endsWith(short) ? full.slice(0, full.length - short.length) : "" }
  }
  const paused = (current: TeamPillView) => current.kind === "area" && current.key === "own.team.pill.paused"
  return (
    <Show when={pill()}>
      {(current) => (
        <Show when={words()}>
          {(text) => {
            const view = createMemo(() => label(text(), current()))
            return (
              <button
                type="button"
                class="own-target inline-flex h-7 shrink-0 items-center rounded-full border border-own-border px-2.5 text-[12px] text-own-muted hover:bg-own-hover data-[paused]:border-own-warn data-[paused]:text-own-warn"
                data-testid="team-pill"
                data-kind={current().kind}
                data-paused={paused(current()) ? "" : undefined}
                aria-haspopup={current().kind === "area" ? "menu" : undefined}
                aria-label={view().full}
                title={view().full}
                onClick={(event) => open(current(), event.currentTarget)}
              >
                <span class="max-w-[14rem] truncate">
                  <span class="own-give-lead">{view().lead}</span>
                  {view().full.slice(view().lead.length)}
                </span>
              </button>
            )
          }}
        </Show>
      )}
    </Show>
  )
}

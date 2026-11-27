// Sidebar rows (03 §4.3): pinned group and project headers (with the project `⋯` menu, 06 §9.2), date header, `⑂`
// header (with `팀 모드 켜기`), two-line session row (with its `⋯` menu button and, on hover, its `보관` / `보관 해제`
// button, 19.11; in the archive's selection mode a check mark instead, and a click selects, 19.11a), one-line subagent
// row, "more" row, and the loading skeleton. The team view's rows (06 §9.4): `허락 기다리는 것 n개` and its requests, `팀 알림 n개`
// and its notices (9.7), area rows (stopped ones with `찾을 수 없음` and the like, a missing folder with `[끝내기]`, 8.8;
// the retire signal `끝낼 수 있음`, 8.1), `이 영역의 다른 대화 n` and
// `팀에 넣지 않은 작업 폴더 n` (folders the team could take in with `팀에 넣기`); team mains, owners and area peers
// (`리뷰어 · 동료`, listed after the owner) are session rows with their role, account usage (`quota.snapshot`),
// preset and `데스크톱 사용 중`. Every row reads only
// its own id's slice (R1) and has a fixed height (R7, windowing). Team words come from the team chunk
// (team/view-model.ts), loaded before any team row exists. An open project ends with `다른 도구의 대화 · 새 N개 ›`
// (09 §6 entry 1): the project row asks for N (import/store.ts, after the list paint and when idle), the tree adds
// the row while N > 0.
import { Preset } from "@own/protocol/preset"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { useData } from "@/data"
import { ProjectActions } from "@/discover/project-actions"
import { useI18n } from "@/i18n"
import { importEntryCount, importSidebarShown, importStore } from "@/import"
import { windowValue } from "@/limits/display"
import { coming } from "@/limits/format"
import type { WindowView } from "@/limits/windows"
import { openPresetEditor } from "@/presets/model"
import { presetByID, presetName } from "@/presets/session-view"
import { usePresetsBootText } from "@/presets/boot-strings"
import { useProjectsText } from "@/projects/strings"
import { describeRequest } from "@/requests/notify"
import { subjects } from "@/requests/describe"
import { useRequestsText } from "@/requests/strings"
import { RouteLink } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { useShell } from "@/shell/context"
import { relativeTime } from "@/shell/format"
import { Icon } from "@/shell/icons"
import { SESSION_DRAG_TYPE } from "@/shell/pane-layout"
import { namedVariant } from "@/switcher/labels"
import { showToast } from "@/switcher/toast"
import { canEnableTeam, failed, teamLabel, useEnableTeam } from "@/team/enable"
import { openAreaMenu, openCreateArea } from "@/team/intents"
import type { StatusTone, TeamText } from "@/team/model"
import { teamTitle } from "@/team/title"
import { AccountChip } from "./chip"
import { useSidebar } from "./context"
import { useSessionFlagActions } from "./flag-actions"
import { sidebarDensity } from "./local-state"
import {
  baseName,
  foldKey,
  HOME_GROUP,
  levelOf,
  PINNED_GROUP,
  STATUS_SYMBOL,
  switchNote,
  type DateBucket,
  type MeterLevel,
  type RowStatus,
} from "./model"
import { ProjectMenu } from "./project-menu"
import { useSidebarText } from "./strings"
import type { TreeApi } from "./tree"

const STATUS_CLASS: Record<RowStatus, string> = {
  waiting: "font-extrabold text-own-accent-text",
  error: "font-extrabold text-own-danger",
  // The still running mark (shell.css): drawn over the glyph, which stays for text and copying.
  running: "own-run-glyph",
  pending: "text-own-warn",
  revert: "text-own-muted",
  background: "text-own-muted",
  unread: "text-own-accent-text text-[14px]",
  idle: "text-own-faint",
}

export function StatusMark(props: { readonly status: RowStatus }) {
  const text = useSidebarText()
  return (
    <span
      class={`inline-block w-2.5 flex-none text-center text-[10px] leading-none ${STATUS_CLASS[props.status]}`}
      role="img"
      aria-label={text(`own.sidebar.status.${props.status}`)}
      data-testid="status-mark"
    >
      {STATUS_SYMBOL[props.status]}
    </span>
  )
}

const ROW =
  "flex w-full flex-col justify-center rounded-lg no-underline text-own-text outline-offset-[-2px] hover:bg-own-hover [contain:content]"
const ACTIVE = "bg-own-raised shadow-[0_0_0_1px_var(--own-border-strong)] hover:bg-own-raised"

export function ProjectRow(props: { readonly rowKey: string; readonly projectID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const text = useSidebarText()
  const projectText = useProjectsText()
  const view = createMemo(() => ctl.project(props.projectID))
  /** 03 §5.1: the default conversation folder's group reads `폴더 없는 대화`; its path stays in the tooltip. */
  const label = () => (view().defaultFolder ? projectText("own.project.defaultFolderGroup") : view().name)
  const open = () => ctl.searching() || !ctl.collapsed(props.projectID)
  const count = () => ctl.tree().counts[props.projectID] ?? 0
  const pinnedProject = () => !ctl.archiveView() && ctl.pinnedProject(props.projectID)
  /** 19.11a: in the `보관함` view, a project archived as a whole (`프로젝트 복원`). */
  const restorable = () => ctl.archiveView() && ctl.projectRestorable(props.projectID)
  // 09 §6 entry 1: an open project (not a search result) counts its conversations in other tools that are not
  // imported yet, unless 설정 > 다른 도구 > 사이드바에 보이기 is off.
  createEffect(() => {
    const directory = view().directory
    if (!directory || ctl.searching() || ctl.archiveView() || !open() || !importSidebarShown()) return
    untrack(() => importStore(ctl.runtime).watch(props.projectID, directory))
  })
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-posinset={ctl.tree().positions.get(props.rowKey)?.[0]}
      aria-setsize={ctl.tree().positions.get(props.rowKey)?.[1]}
      aria-expanded={open()}
      aria-current={ctl.isActiveProject(props.projectID) ? "page" : undefined}
      tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
      data-key={props.rowKey}
      data-project-id={props.projectID}
      data-testid="project-row"
      data-reorder="project"
      aria-keyshortcuts="Control+Shift+ArrowUp Control+Shift+ArrowDown"
      data-reorder-id={props.projectID}
      data-default-folder={view().defaultFolder ? "" : undefined}
      title={view().directory}
      class="group mt-1.5 flex cursor-pointer items-center gap-1.5 rounded-md pr-0.5 pl-1.5 text-[12px] font-semibold text-own-muted select-none outline-offset-[-2px] hover:bg-own-hover"
      classList={{ "text-own-text": ctl.isActiveProject(props.projectID) }}
      style={{ height: `${ctl.height(props.rowKey) - 6}px` }}
      onClick={() => {
        if (!ctl.searching()) ctl.prefs.toggleProject(props.projectID)
      }}
    >
      <Chevron open={open()} />
      <Show when={pinnedProject()}>
        <span role="img" aria-label={text("own.sidebar.pinnedMark")} class="flex-none" data-testid="project-pinned">
          <PinIcon class="size-3" />
        </span>
      </Show>
      <span class="min-w-0 truncate">{label()}</span>
      <Show when={restorable()}>
        <span
          class="flex-none rounded border border-own-border px-1 text-[10.5px] leading-4 font-normal text-own-muted"
          data-testid="project-archived-tag"
        >
          {text("own.sidebar.project.archivedTag")}
        </span>
      </Show>
      {/* 03 §4.3.1: `[팀]` (06 §9.4) or `팀 모드 켜기…`, and the `⑂` worktree menu (19.3), or why a project without Git
          has neither. */}
      <Show when={!ctl.archiveView()}>
        <ProjectActions
          serverKey={ctl.serverKey}
          projectID={props.projectID}
          name={label()}
          directory={view().directory}
        />
      </Show>
      <span
        class="own-num ml-auto flex-none font-normal text-own-faint"
        aria-label={text("own.sidebar.project.sessions", { n: count() })}
      >
        {count()}
      </span>
      <button
        type="button"
        tabindex={-1}
        class="own-icon-button own-target size-6 opacity-70 group-hover:opacity-100 [&_svg]:size-3.5"
        aria-label={text("own.sidebar.project.newSession", { name: label() })}
        title={text("own.sidebar.project.newSession", { name: label() })}
        data-testid="project-new-session"
        onClick={(event) => {
          event.stopPropagation()
          ctl.newSessionIn(props.projectID)
        }}
      >
        <Icon name="plus" />
      </button>
      {/* 06 §9.2: the project `⋯` (team items for Git projects; for the others why team mode and worktrees are missing). */}
      <span class="flex flex-none items-center font-normal [&_button[aria-haspopup=menu]]:size-6">
        <ProjectMenu
          serverKey={ctl.serverKey}
          projectID={props.projectID}
          name={label()}
          directory={view().directory}
          archiveView={ctl.archiveView()}
          restorable={restorable()}
        />
      </span>
    </div>
  )
}

/** The team strings in the window's language once the team chunk is there (team/view-model.ts). */
function useTeamWords() {
  const ctl = useSidebar()
  const i18n = useI18n()
  return (): TeamText | undefined => ctl.teamView()?.words(i18n.locale())
}

/** 19.11 `고정됨`: pinned root sessions of every project, folded like a project. */
export function PinnedGroupRow(props: { readonly rowKey: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const text = useSidebarText()
  const open = () => !ctl.prefs.collapsed(PINNED_GROUP)
  const count = () => ctl.tree().counts[PINNED_GROUP] ?? 0
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-posinset={ctl.tree().positions.get(props.rowKey)?.[0]}
      aria-setsize={ctl.tree().positions.get(props.rowKey)?.[1]}
      aria-expanded={open()}
      tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
      data-key={props.rowKey}
      data-testid="pinned-group"
      class="mt-1.5 flex cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1.5 text-[12px] font-semibold text-own-muted select-none outline-offset-[-2px] hover:bg-own-hover"
      style={{ height: `${ctl.height(props.rowKey) - 6}px` }}
      onClick={() => ctl.prefs.toggleProject(PINNED_GROUP)}
    >
      <Chevron open={open()} />
      <PinIcon class="size-3 flex-none" />
      <span class="min-w-0 truncate">{text("own.sidebar.group.pinned")}</span>
      <span
        class="own-num ml-auto flex-none font-normal text-own-faint"
        aria-label={text("own.sidebar.project.sessions", { n: count() })}
      >
        {count()}
      </span>
    </div>
  )
}

/** The `보관함` box (19.11): the footer button, the archive header and the hover `보관` button. */
export function ArchiveIcon(props: { readonly class?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" class={`fill-none stroke-current stroke-[1.6] ${props.class ?? ""}`}>
      <path d="M3.5 5.5h17v4h-17zM5 9.5v9h14v-9M10 13h4" />
    </svg>
  )
}

/** `보관 해제`: the box with an arrow out of it. */
export function UnarchiveIcon(props: { readonly class?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" class={`fill-none stroke-current stroke-[1.6] ${props.class ?? ""}`}>
      <path d="M3.5 5.5h17v4h-17zM5 9.5v9h14v-9M12 17v-5M9.5 14.5L12 12l2.5 2.5" />
    </svg>
  )
}

export function PinIcon(props: { readonly class?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" class={`fill-none stroke-current stroke-[1.8] ${props.class ?? ""}`}>
      <path d="M8.5 3.5h7M10 3.5v5.5L7 12.5h10L14 9V3.5M12 12.5V20" />
    </svg>
  )
}

export function DateRow(props: { readonly rowKey: string; readonly bucket: DateBucket }) {
  const ctl = useSidebar()
  const text = useSidebarText()
  return (
    <div
      role="none"
      aria-hidden="true"
      class="flex items-end px-2.5 pb-0.5 text-[11px] text-own-faint"
      style={{ height: `${ctl.height(props.rowKey)}px` }}
      data-testid="date-row"
    >
      {text(`own.sidebar.group.${props.bucket}`)}
    </div>
  )
}

/**
 * `⑂ name` over the sessions of one worktree of the project (03 §4.3, 19.3); a label like the date rows. Where team
 * mode can start (06 §9.2) it offers `팀 모드 켜기` with this folder as the main folder. Inside a team view it is a work
 * folder the team leaves out: one the team could take in offers `팀에 넣기` (`area.adopt`, 8.8) where this build of
 * own.team adopts and this connection may; the others stay a label.
 */
export function WorktreeRow(props: {
  readonly rowKey: string
  readonly projectID: string
  readonly directory: string
}) {
  const ctl = useSidebar()
  const i18n = useI18n()
  const words = useTeamWords()
  const enableTeam = useEnableTeam()
  const [adopting, setAdopting] = createSignal(false)
  const enable = () => {
    if (ctl.teamProject(props.projectID)) return undefined
    const label = teamLabel(i18n.locale(), "own.team.enable")
    const place = { directory: props.directory, projectID: props.projectID }
    return label && canEnableTeam(ctl.runtime, place) ? label : undefined
  }
  /** The team that could take this folder in, and the button's words. */
  const adopt = () => {
    const teamID = ctl.teamView()?.adopt({
      project: ctl.teamProject(props.projectID),
      directory: props.directory,
      has: (feature) => ctl.team.has(feature),
      allowed: (method) => ctl.team.rpc.allowed(method),
    })
    const entry = teamID ? ctl.team.team(teamID) : undefined
    const label = words()?.("own.team.action.adopt")
    return entry && label ? { teamID: entry.team.id, label } : undefined
  }
  async function take(teamID: OwnTeam.TeamID) {
    if (adopting()) return
    setAdopting(true)
    await ctl.team.rpc.call("area.adopt", { teamID, directory: props.directory }).then(
      () => {
        const started = words()?.("own.team.adopt.running", { folder: baseName(props.directory) })
        if (started) showToast({ message: started })
      },
      (error: unknown) => failed(i18n.locale(), error),
    )
    setAdopting(false)
  }
  const button = "ml-auto flex-none rounded px-1 leading-4 text-own-muted hover:bg-own-hover hover:text-own-text"
  return (
    <div
      role="none"
      aria-hidden={enable() || adopt() ? undefined : "true"}
      class="group flex min-w-0 items-end gap-1 px-2.5 pb-0.5 text-[11px] text-own-muted"
      style={{ height: `${ctl.height(props.rowKey)}px` }}
      title={props.directory}
      data-testid="worktree-row"
    >
      <span aria-hidden="true">⑂</span>
      <span class="min-w-0 truncate">{ctl.worktreeLabel(props.directory)}</span>
      <Show when={enable()}>
        {(label) => (
          <button
            type="button"
            tabindex={-1}
            class={button}
            classList={{ "opacity-0 group-hover:opacity-100 focus-visible:opacity-100": !ctl.touch }}
            data-testid="worktree-team-enable"
            onClick={() => void enableTeam({ serverKey: ctl.serverKey, directory: props.directory })}
          >
            {label()}
          </button>
        )}
      </Show>
      <Show when={adopt()}>
        {(choice) => (
          <button
            type="button"
            tabindex={-1}
            class={button}
            disabled={adopting()}
            data-testid="worktree-team-adopt"
            onClick={() => void take(choice().teamID)}
          >
            {choice().label}
          </button>
        )}
      </Show>
    </div>
  )
}

export function SessionRow(props: { readonly rowKey: string; readonly sessionID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const shell = useShell()
  const i18n = useI18n()
  const text = useSidebarText()
  const id = props.sessionID
  const status = createMemo(() => ctl.status(id))
  const chip = createMemo(() => ctl.chip(id))
  const title = () =>
    teamTitle(ctl.row(id)?.title, ctl.teamRole(id)?.role, i18n.locale()) || i18n.t("own.shell.untitled")
  const compact = () => sidebarDensity() === "compact"
  const count = () => ctl.childCount(id)
  const expanded = () => ctl.prefs.expanded(id)
  const model = createMemo(() => {
    const ref = ctl.model(id)
    return ref ? ctl.modelName(ref, ctl.row(id)?.directory) : undefined
  })
  const note = createMemo(() => {
    const value = switchNote(ctl.switchState(id))
    if (!value) return undefined
    const account = ctl.accountOn(id, value.target.providerID, value.accountID)?.label ?? value.target.providerID
    if (value.kind === "scheduled") return text("own.sidebar.switch.scheduled", { account })
    return text("own.sidebar.switch.pending", { model: ctl.modelName(value.target), account })
  })
  const pinned = () => ctl.pinned(id)
  const archived = () => ctl.archived(id)
  const menuOpen = () => ctl.menu()?.sessionID === id
  const level = () => levelOf(props.rowKey, ctl.tree().levels)
  const team = useTeamSession(id)
  const flagActions = useSessionFlagActions()
  const selecting = () => ctl.selecting()
  /** 19.11: the hover `보관` / `보관 해제` button next to `⋯` (pointer devices; touch keeps the `⋯` menu). */
  const quickArchive = () => !ctl.touch && !selecting() && ctl.canFlag()
  let menuButton: HTMLButtonElement | undefined
  let wrapper!: HTMLDivElement
  // 19.11a: in the archive's selection mode a click (or Enter/Space, which the tree turns into a click) selects the
  // row instead of opening it. Captured here, before the link's own handler.
  onMount(() => {
    const pick = (event: MouseEvent) => {
      if (!selecting()) return
      event.preventDefault()
      event.stopPropagation()
      ctl.toggleSelected(id)
    }
    wrapper.addEventListener("click", pick, true)
    onCleanup(() => wrapper.removeEventListener("click", pick, true))
  })
  return (
    <div ref={wrapper} role="none" class="group relative" style={{ height: `${ctl.height(props.rowKey)}px` }}>
      <RouteLink
        to={{ name: "session", serverKey: ctl.serverKey, sessionID: id }}
        // 03 §4.1.1: Ctrl+click opens the session in a split pane beside the focused one (Shift+click keeps the
        // browser's new window); a row dragged onto a pane opens there or beside it.
        onClick={(event) => {
          if (selecting() || !(event.ctrlKey || event.metaKey) || event.shiftKey || !shell.splitCapable()) return
          event.preventDefault()
          shell.openBeside({ name: "session", serverKey: ctl.serverKey, sessionID: id })
        }}
        draggable={!selecting()}
        onDragStart={(event) => {
          event.dataTransfer?.setData(SESSION_DRAG_TYPE, JSON.stringify({ serverKey: ctl.serverKey, sessionID: id }))
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyLink"
        }}
        role="treeitem"
        aria-level={level()}
        aria-haspopup={selecting() ? undefined : "menu"}
        aria-selected={selecting() ? ctl.isSelected(id) : undefined}
        onContextMenu={(event) => {
          // Right click, the Menu key and Shift+F10 open the row menu (19.11) instead of the browser's.
          event.preventDefault()
          if (menuButton && !selecting()) ctl.openMenu(id, menuButton)
        }}
        aria-posinset={ctl.tree().positions.get(props.rowKey)?.[0]}
        aria-setsize={ctl.tree().positions.get(props.rowKey)?.[1]}
        aria-current={ctl.isActive(id) ? "page" : undefined}
        aria-expanded={count() > 0 && !ctl.searching() ? expanded() : undefined}
        tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
        data-key={props.rowKey}
        data-session-id={id}
        data-status={status()}
        data-testid="session-row"
        data-team-role={team()?.role}
        class={`${ROW} h-full px-2 pl-2.5`}
        classList={{ [ACTIVE]: ctl.isActive(id) }}
        style={{ "padding-left": level() > 2 ? `${10 + (level() - 2) * 14}px` : undefined }}
      >
        <span
          class="flex min-w-0 items-center gap-[7px]"
          classList={{ "pr-11": ctl.touch, "group-hover:pr-7 group-focus-within:pr-7": quickArchive() }}
        >
          <Show when={selecting()}>
            <span
              aria-hidden="true"
              class="flex size-3.5 flex-none items-center justify-center rounded-[3px] border text-[10px] leading-none"
              classList={{
                "border-own-accent bg-own-accent text-own-on-accent": ctl.isSelected(id),
                "border-own-border-strong": !ctl.isSelected(id),
              }}
              data-testid="row-check"
            >
              {ctl.isSelected(id) ? "✓" : ""}
            </span>
          </Show>
          <StatusMark status={status()} />
          <Show when={pinned() && ctl.searching()}>
            <span role="img" aria-label={text("own.sidebar.pinnedMark")} class="flex-none text-own-faint">
              <PinIcon class="size-3" />
            </span>
          </Show>
          <Show when={team()?.role === "main" && team()?.label}>
            {(label) => (
              <span class="flex-none text-[11.5px] font-semibold text-own-muted" data-testid="team-role">
                {label()}
              </span>
            )}
          </Show>
          <span class="min-w-0 flex-1 truncate text-[13.5px]" title={title()} data-testid="session-title">
            {title()}
          </span>
          <Show when={team()?.role === "main" && team()?.desktop}>
            <DesktopTag />
          </Show>
          <Show when={archived() && !ctl.archiveView()}>
            <span
              class="flex-none rounded border border-own-border px-1 text-[10.5px] leading-4 text-own-muted"
              data-testid="archived-tag"
            >
              {text("own.sidebar.tag.archived")}
            </span>
          </Show>
          <Show when={compact()}>
            <AccountChip view={chip()} compact />
          </Show>
          <span
            class="own-num flex-none text-[11.5px] text-own-faint"
            classList={{
              "group-hover:invisible group-focus-within:invisible": !ctl.touch,
              invisible: menuOpen() && !ctl.touch,
            }}
          >
            {relativeTime(i18n, minuteNow(), ctl.updated(id))}
          </span>
        </span>
        <Show when={!compact()}>
          <span
            class="mt-1 ml-[17px] flex min-w-0 items-center gap-1.5 text-[12px] text-own-muted"
            classList={{ "pr-10": count() > 0 }}
          >
            <AccountChip view={chip()} />
            <Show when={team()?.usage}>{(usage) => <Usage {...usage()} />}</Show>
            <Show when={model()}>
              <span class="min-w-0 truncate" data-testid="model-name">
                {team()?.effort ? `${model()} · ${team()!.effort}` : model()}
              </span>
            </Show>
            <Show when={team()?.extra}>
              {(extra) => (
                <span class="min-w-0 truncate" classList={{ "text-own-faint": extra().faint }} data-testid="team-extra">
                  · {extra().text}
                </span>
              )}
            </Show>
            <Show when={note()}>
              <span class="min-w-0 truncate text-own-faint" data-testid="switch-note">
                {note()}
              </span>
            </Show>
          </span>
        </Show>
      </RouteLink>
      <Show when={quickArchive()}>
        <button
          type="button"
          tabindex={-1}
          class="own-icon-button own-target absolute size-6 [&_svg]:size-3.5"
          classList={{
            "right-8": !compact() || count() === 0 || ctl.searching(),
            "right-[68px]": compact() && count() > 0 && !ctl.searching(),
            "top-1": !compact(),
            "top-1/2 -translate-y-1/2": compact(),
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100": !menuOpen(),
          }}
          aria-label={text(archived() ? "own.sidebar.unarchiveRow" : "own.sidebar.archiveRow", { title: title() })}
          title={text(archived() ? "own.sidebar.unarchive" : "own.sidebar.archive")}
          data-testid="row-archive-button"
          onClick={(event) => {
            event.stopPropagation()
            void flagActions.toggle(ctl.serverKey, id, "archived", !archived(), title())
          }}
        >
          <Show when={archived()} fallback={<ArchiveIcon />}>
            <UnarchiveIcon />
          </Show>
        </button>
      </Show>
      <Show when={!selecting()}>
        <button
          ref={menuButton}
          type="button"
          tabindex={-1}
          class="own-icon-button own-target absolute size-6"
          classList={{
            "right-1": !compact() || count() === 0 || ctl.searching(),
            // One-line rows keep the subagent toggle at the right edge.
            "right-10": compact() && count() > 0 && !ctl.searching(),
            "top-1": !compact(),
            "top-1/2 -translate-y-1/2": compact(),
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100": !ctl.touch && !menuOpen(),
            "bg-own-hover": menuOpen(),
          }}
          aria-label={text("own.sidebar.rowMenu", { title: title() })}
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          data-testid="row-menu-button"
          onClick={(event) => {
            event.stopPropagation()
            if (menuOpen()) ctl.closeMenu()
            else if (menuButton) ctl.openMenu(id, menuButton)
          }}
        >
          <span aria-hidden="true" class="own-ico own-ico-more" />
        </button>
      </Show>
      <Show when={count() > 0 && !ctl.searching() && !selecting()}>
        <button
          type="button"
          tabindex={-1}
          class="own-num absolute right-1.5 bottom-1.5 flex h-5 items-center gap-0.5 rounded px-1 text-[11px] text-own-muted hover:bg-own-hover hover:text-own-text"
          title={expanded() ? text("own.sidebar.children.hide") : text("own.sidebar.children.show", { n: count() })}
          aria-label={
            expanded() ? text("own.sidebar.children.hide") : text("own.sidebar.children.show", { n: count() })
          }
          data-testid="children-toggle"
          onClick={() => ctl.prefs.toggleChildren(id)}
        >
          <Chevron open={expanded()} />
          {count()}
        </button>
      </Show>
    </div>
  )
}

/**
 * The role word before a team main's title, left out when the title already says it: the main's default title is
 * `팀 메인` (own-team sessions/main.ts), which read `메인 팀 메인`.
 */
export function roleLabel(title: string | undefined, label: string) {
  return title?.toLowerCase().includes(label.toLowerCase()) ? undefined : label
}

/**
 * What a team main, owner or peer row adds (06 §9.4, §10.3): the role, the account's usage, the effort, and for the
 * main its preset (`프리셋 평소대로`, dimmed for `평소대로`) and `데스크톱 사용 중`, for an owner the main requests that
 * wait, for an area peer its name and the word (`리뷰어 · 동료`).
 */
function useTeamSession(sessionID: string) {
  const ctl = useSidebar()
  const i18n = useI18n()
  const words = useTeamWords()
  const names = usePresetsBootText()
  return createMemo(() => {
    const place = ctl.teamRole(sessionID)
    const text = words()
    if (!place || !text) return undefined
    const variant = ctl.model(sessionID)?.variant
    const common = {
      // The model's default effort is left out (team/model.ts `RunningOn`).
      effort: namedVariant(variant),
      usage: ctl.usage(sessionID),
    }
    if (place.role === "main") {
      const preset = ctl.runtime.own.state.sessionPreset[sessionID]?.preset
      return {
        ...common,
        role: "main" as const,
        label: roleLabel(teamTitle(ctl.row(sessionID)?.title, place.role, i18n.locale()), text("own.team.role.main")),
        extra: preset && {
          text: text("own.team.preset.short", { name: presetName(preset, names("own.preset.builtin")) }),
          faint: Preset.isBuiltin(preset.id),
        },
        desktop: ctl.leaseRoot() === sessionID,
      }
    }
    if (place.role === "peer") {
      const label = ctl.team.peerOf(sessionID)?.peer.label
      return {
        ...common,
        role: "peer" as const,
        label: text("own.team.peer.word"),
        extra: label === undefined ? undefined : { text: text("own.team.peer.row", { label }), faint: false },
        desktop: false,
      }
    }
    const waiting = place.areaID ? (ctl.team.team(place.teamID)?.waiting[place.areaID] ?? 0) : 0
    return {
      ...common,
      role: "owner" as const,
      label: text("own.team.role.owner"),
      extra: waiting > 0 ? { text: text("own.team.status.waiting", { n: waiting }), faint: false } : undefined,
      desktop: false,
    }
  })
}

/** `데스크톱 사용 중`: the row's conversation holds own.computer's desktop lease (cu-review "Team mode"). */
function DesktopTag() {
  const text = useSidebarText()
  return (
    <span
      class="flex-none rounded border border-own-accent px-1 text-[10.5px] leading-4 text-own-accent-text"
      title={text("own.sidebar.team.desktopHint")}
      data-testid="desktop-tag"
    >
      {text("own.sidebar.team.desktop")}
    </span>
  )
}

const USAGE: Record<MeterLevel, string> = { ok: "text-own-muted", warn: "text-own-warn", danger: "text-own-danger" }

/** `5시간 남음 38%` beside an account chip: the account's tightest window (06 §10.3, 설정 > 일반 > 한도 표시). */
function Usage(props: { readonly item: WindowView; readonly level: MeterLevel }) {
  const text = useSidebarText()
  const i18n = useI18n()
  return (
    <span class={`own-num flex-none text-[11.5px] ${USAGE[props.level]}`} data-testid="account-usage">
      {text("own.sidebar.team.usage", { window: props.item.label, value: windowValue(i18n, props.item) })}
    </span>
  )
}

export function ChildRow(props: { readonly rowKey: string; readonly sessionID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const shell = useShell()
  const i18n = useI18n()
  const id = props.sessionID
  const level = () => levelOf(props.rowKey, ctl.tree().levels)
  const info = () => ctl.runtime.data.session.get(id)
  const status = createMemo(() => ctl.childStatus(id))
  const chip = createMemo(() => ctl.chip(id))
  const strong = createMemo(() => {
    const own = chip()
    const parentID = info()?.parentID
    if (own.kind !== "account" || !parentID) return false
    const parent = ctl.chip(parentID)
    return parent.kind === "account" && parent.account.id !== own.account.id
  })
  const title = () => info()?.title || info()?.agent || i18n.t("own.shell.untitled")
  return (
    <div role="none" style={{ height: `${ctl.height(props.rowKey)}px` }}>
      <RouteLink
        to={{ name: "session", serverKey: ctl.serverKey, sessionID: id }}
        // 03 §4.1.1: Ctrl+click opens the session in a split pane beside the focused one (Shift+click keeps the
        // browser's new window); a row dragged onto a pane opens there or beside it.
        onClick={(event) => {
          if (!(event.ctrlKey || event.metaKey) || event.shiftKey || !shell.splitCapable()) return
          event.preventDefault()
          shell.openBeside({ name: "session", serverKey: ctl.serverKey, sessionID: id })
        }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer?.setData(SESSION_DRAG_TYPE, JSON.stringify({ serverKey: ctl.serverKey, sessionID: id }))
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyLink"
        }}
        role="treeitem"
        aria-level={level()}
        aria-current={ctl.isActive(id) ? "page" : undefined}
        tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
        data-key={props.rowKey}
        data-session-id={id}
        data-status={status()}
        data-testid="child-row"
        class={`${ROW} h-full pr-2`}
        classList={{ [ACTIVE]: ctl.isActive(id) }}
        style={{ "padding-left": `${16 + (level() - 2) * 12}px` }}
      >
        <span class="flex min-w-0 items-center gap-1.5 text-[12.5px] text-own-muted">
          <StatusMark status={status()} />
          <span class="min-w-0 flex-1 truncate" title={title()}>
            {title()}
          </span>
          <AccountChip view={chip()} strong={strong()} compact />
        </span>
      </RouteLink>
    </div>
  )
}

export function MoreRow(props: { readonly rowKey: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const i18n = useI18n()
  const text = useSidebarText()
  return (
    <div
      role="treeitem"
      aria-level={1}
      tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
      data-key={props.rowKey}
      data-testid="more-row"
      class="flex cursor-pointer items-center justify-center rounded-lg text-[12px] text-own-muted outline-offset-[-2px] hover:bg-own-hover hover:text-own-text"
      style={{ height: `${ctl.height(props.rowKey)}px` }}
      aria-busy={!ctl.archiveView() && ctl.index.state.loading}
      onClick={() => ctl.loadMore()}
    >
      {ctl.archiveView()
        ? text("own.sidebar.archiveMore")
        : ctl.index.state.loading
          ? i18n.t("own.shell.loading")
          : text("own.sidebar.more")}
    </div>
  )
}

/**
 * `다른 도구의 대화 · 새 N개 ›` (09 §6 entry 1) after an open project's rows: N conversations Codex or Claude Code left
 * for the project that are not imported yet. Opens the import list (a lazy page). The tree lists the row only while N
 * is above 0, so it leaves once everything is imported, the setting is off or own.import is not there (or not
 * allowed on this connection).
 */
export function ImportEntryRow(props: { readonly rowKey: string; readonly projectID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const i18n = useI18n()
  return (
    <div role="none" style={{ height: `${ctl.height(props.rowKey)}px` }}>
      <RouteLink
        to={{ name: "import", serverKey: ctl.serverKey, projectID: props.projectID }}
        role="treeitem"
        aria-level={levelOf(props.rowKey, ctl.tree().levels)}
        tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
        data-key={props.rowKey}
        data-testid="import-entry"
        title={i18n.t("own.otherTools.entryHint")}
        class="flex h-full items-center gap-1 rounded-lg pr-2 pl-[27px] text-[12px] text-own-muted no-underline outline-offset-[-2px] hover:bg-own-hover hover:text-own-text"
      >
        <span class="min-w-0 truncate">
          {i18n.t("own.otherTools.entry", { n: importEntryCount(ctl.runtime, props.projectID) })}
        </span>
        <span aria-hidden="true" class="flex-none">
          ›
        </span>
      </RouteLink>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Team view (06 §9.4)

const TONE: Record<StatusTone, string> = {
  idle: "text-own-faint",
  working: "text-own-accent-text",
  attention: "font-semibold text-own-warn",
  waiting: "text-own-warn",
  ready: "text-own-ok",
  done: "text-own-muted",
  error: "font-semibold text-own-danger",
  paused: "text-own-warn",
}

/** The fold mark of every row that folds: server sections, projects, the pinned group, the team's groups. */
export function Chevron(props: { readonly open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      class="size-3 flex-none fill-none stroke-current stroke-2 transition-transform motion-reduce:transition-none"
      classList={{ "-rotate-90": !props.open }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

/** A one-line folding row of the team view: `허락 기다리는 것 n개`, `이 영역의 다른 대화 n`, `팀에 넣지 않은 작업 폴더 n`. */
function TeamGroupRow(props: {
  readonly rowKey: string
  readonly tree: TreeApi
  readonly open: boolean
  readonly label: string
  readonly onToggle: () => void
  readonly testid: string
  readonly attention?: boolean
}) {
  const ctl = useSidebar()
  const level = () => levelOf(props.rowKey, ctl.tree().levels)
  return (
    <div
      role="treeitem"
      aria-level={level()}
      aria-expanded={props.open}
      tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
      data-key={props.rowKey}
      data-testid={props.testid}
      class="flex cursor-pointer items-center gap-1.5 rounded-md pr-2 text-[12px] text-own-muted select-none outline-offset-[-2px] hover:bg-own-hover"
      classList={{ "font-semibold text-own-accent-text": props.attention }}
      style={{ height: `${ctl.height(props.rowKey)}px`, "padding-left": `${10 + (level() - 2) * 14}px` }}
      onClick={() => props.onToggle()}
    >
      <Chevron open={props.open} />
      <span class="min-w-0 truncate">{props.label}</span>
    </div>
  )
}

/** `허락 기다리는 것 n개` (06 §9.4, §10.1): the permission requests of every team conversation, answered in one place. */
export function TeamRequestsRow(props: {
  readonly rowKey: string
  readonly projectID: string
  readonly tree: TreeApi
}) {
  const ctl = useSidebar()
  const words = useTeamWords()
  const fold = foldKey.requests(props.projectID)
  return (
    <TeamGroupRow
      rowKey={props.rowKey}
      tree={props.tree}
      open={!ctl.prefs.collapsed(fold)}
      label={words()?.("own.team.view.permissions", { n: ctl.tree().counts[props.rowKey] ?? 0 }) ?? ""}
      onToggle={() => ctl.prefs.toggleProject(fold)}
      testid="team-requests-row"
      attention
    />
  )
}

/**
 * Notices that ask for the user (a repair, a stopped area, an integration waiting for the user's files, 7.2): the
 * group row stands out while one is listed (9.7).
 */
const NOTICE_ATTENTION: ReadonlySet<string> = new Set([
  "preset.repair",
  "area.broken",
  "link.blocked",
  "link.copy.dirty",
  "integration.waiting",
])

/** `팀 알림 n개` (06 §9.4, §9.7): the team's notices, open by default, until each one is closed. */
export function TeamNoticesRow(props: { readonly rowKey: string; readonly projectID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const words = useTeamWords()
  const fold = foldKey.notices(props.projectID)
  const attention = () => {
    const shown = new Set(ctl.teamProject(props.projectID)?.notices)
    return ctl.team.state.notices.some((item) => shown.has(item.id) && NOTICE_ATTENTION.has(item.kind))
  }
  return (
    <TeamGroupRow
      rowKey={props.rowKey}
      tree={props.tree}
      open={!ctl.prefs.collapsed(fold)}
      label={words()?.("own.team.view.notices", { n: ctl.tree().counts[props.rowKey] ?? 0 }) ?? ""}
      onToggle={() => ctl.prefs.toggleProject(fold)}
      testid="team-notices-row"
      attention={attention()}
    />
  )
}

/**
 * One notice (06 §9.7, §10.1): its words, then where it comes from and when. The row opens the area's owner (or the
 * team main). A repair offers `고치기`, which opens its preset in the editor (07 §7.1); `×` or Delete closes it.
 */
export function TeamNoticeRow(props: { readonly rowKey: string; readonly noticeID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const data = useData()
  const i18n = useI18n()
  const text = useSidebarText()
  const words = useTeamWords()
  const compact = () => sidebarDensity() === "compact"
  const notice = () => ctl.team.state.notices.find((item) => item.id === props.noticeID)
  const area = () => {
    const current = notice()
    return current?.areaID ? ctl.team.area(current.teamID, current.areaID) : undefined
  }
  const line = createMemo(() => {
    const current = notice()
    const view = ctl.teamView()
    if (!current || !view) return current?.text ?? ""
    return view.notice(i18n.locale(), current, area()?.name, minuteNow())
  })
  const where = () =>
    text("own.sidebar.team.notice", {
      where: area()?.name ?? words()?.("own.team.view.noticeTeam") ?? "",
      time: relativeTime(i18n, minuteNow(), notice()?.at ?? minuteNow()),
    })
  const repair = () => {
    const current = notice()
    const presetID = current?.kind === "preset.repair" ? current.data?.presetID : undefined
    return typeof presetID === "string" ? presetByID(data.local().own.state.presetGroups, presetID) : undefined
  }
  function openConversation() {
    const current = notice()
    if (!current) return
    const sessionID = area()?.owner.sessionID ?? ctl.team.team(current.teamID)?.team.main.sessionID
    if (sessionID) ctl.open(sessionID)
  }
  function close() {
    const keys = ctl.keys()
    const at = keys.indexOf(props.rowKey)
    // The next row stays after this one leaves (another notice or the team main), so focus moves there.
    const next = keys[at + 1] ?? keys[at - 1]
    const focused = document.activeElement?.closest("[data-key]")?.getAttribute("data-key") === props.rowKey
    ctl.team.dismiss(props.noticeID)
    if (focused && next) props.tree.focus(next)
  }
  const button =
    "rounded-md border border-own-border bg-own-bg px-1.5 text-[11.5px] leading-5 text-own-text hover:bg-own-hover"
  return (
    <div
      role="none"
      class="relative"
      style={{ height: `${ctl.height(props.rowKey)}px` }}
      data-kind={notice()?.kind}
      data-testid="team-notice"
    >
      <div
        role="treeitem"
        aria-level={levelOf(props.rowKey, ctl.tree().levels)}
        aria-keyshortcuts="Delete"
        tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
        data-key={props.rowKey}
        data-testid="team-notice-row"
        class={`${ROW} h-full cursor-pointer pr-2 pl-6`}
        onClick={openConversation}
        onKeyDown={(event) => {
          if (event.key !== "Delete") return
          event.preventDefault()
          close()
        }}
      >
        <span class="flex min-w-0 items-center gap-[7px]" classList={{ "pr-[84px]": !!repair(), "pr-7": !repair() }}>
          <span
            aria-hidden="true"
            class="inline-block w-2.5 flex-none text-center text-[10px] leading-none"
            classList={{
              "text-own-warn": NOTICE_ATTENTION.has(notice()?.kind ?? ""),
              "text-own-muted": !NOTICE_ATTENTION.has(notice()?.kind ?? ""),
            }}
          >
            ●
          </span>
          <span class="min-w-0 flex-1 truncate text-[13px]" title={line()} data-testid="team-notice-text">
            {line()}
          </span>
        </span>
        <Show when={!compact()}>
          <span class="mt-1 ml-[17px] min-w-0 truncate text-[11.5px] text-own-muted" data-testid="team-notice-where">
            {where()}
          </span>
        </Show>
      </div>
      <span
        class="absolute right-1 flex gap-1"
        classList={{ "top-1": !compact(), "top-1/2 -translate-y-1/2": compact() }}
      >
        <Show when={repair()}>
          {(preset) => (
            <button
              type="button"
              tabindex={-1}
              class={button}
              data-testid="team-notice-fix"
              onClick={() => openPresetEditor({ group: preset().group, presetID: preset().id })}
            >
              {text("own.sidebar.team.noticeFix")}
            </button>
          )}
        </Show>
        <button
          type="button"
          tabindex={-1}
          class="own-icon-button own-target size-6"
          aria-label={text("own.sidebar.team.noticeClose")}
          title={text("own.sidebar.team.noticeClose")}
          data-testid="team-notice-close"
          onClick={close}
        >
          <span aria-hidden="true" class="text-[13px] leading-none">
            ×
          </span>
        </button>
      </span>
    </div>
  )
}

/**
 * One waiting request: where it comes from (`메인`, the area) and what it asks (`셸 명령`), the command or path, and
 * `한 번 허용` / `거절`. The row opens the conversation whose dock shows the request in full (`항상 허용`, a reason).
 */
export function TeamRequestRow(props: {
  readonly rowKey: string
  readonly sessionID: string
  readonly requestID: string
  readonly tree: TreeApi
}) {
  const ctl = useSidebar()
  const text = useSidebarText()
  const requests = useRequestsText()
  const words = useTeamWords()
  const compact = () => sidebarDensity() === "compact"
  const request = () => ctl.request(props.sessionID, props.requestID)
  const root = createMemo(() => ctl.rootOf(props.sessionID))
  const where = createMemo(() => {
    const place = ctl.teamRole(root())
    if (place?.role === "main") return words()?.("own.team.main") ?? ""
    const area = place?.areaID ? ctl.team.area(place.teamID, place.areaID) : undefined
    return area?.name ?? ctl.row(root())?.title ?? ""
  })
  const line = () => {
    const current = request()
    if (!current) return where()
    return text("own.sidebar.team.request", {
      where: where(),
      what: describeRequest(requests, { permission: current }),
    })
  }
  const subject = () => {
    const current = request()
    return current ? subjects(current).join(" · ") : ""
  }
  async function reply(decision: "once" | "reject") {
    if (!(await ctl.answer(props.sessionID, props.requestID, decision)))
      showToast({ message: requests("own.requests.failed"), tone: "danger" })
  }
  const button =
    "own-team-req-btn rounded-md border border-own-border bg-own-bg px-1.5 text-[11.5px] leading-5 text-own-text hover:bg-own-hover disabled:opacity-50"
  return (
    <div role="none" class="relative" style={{ height: `${ctl.height(props.rowKey)}px` }}>
      <div
        role="treeitem"
        aria-level={levelOf(props.rowKey, ctl.tree().levels)}
        tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
        data-key={props.rowKey}
        data-session-id={props.sessionID}
        data-testid="team-request-row"
        class={`${ROW} h-full cursor-pointer pr-2 pl-6`}
        onClick={() => ctl.open(root())}
      >
        <span class="own-team-req-line flex min-w-0 items-center gap-[7px] pr-[118px]">
          <StatusMark status="waiting" />
          <span class="min-w-0 flex-1 truncate text-[13px]" title={line()}>
            {line()}
          </span>
        </span>
        <Show when={!compact() && subject()}>
          <span
            class="own-team-req-subject mt-1 ml-[17px] min-w-0 truncate font-mono text-[11.5px] text-own-muted"
            title={subject()}
          >
            {subject()}
          </span>
        </Show>
      </div>
      <span
        class="absolute right-1 flex gap-1"
        classList={{ "top-1": !compact(), "top-1/2 -translate-y-1/2": compact() }}
      >
        <button
          type="button"
          tabindex={-1}
          class={button}
          disabled={ctl.answering(props.requestID)}
          data-testid="team-request-allow"
          onClick={() => void reply("once")}
        >
          {text("own.sidebar.team.allow")}
        </button>
        <button
          type="button"
          tabindex={-1}
          class={button}
          disabled={ctl.answering(props.requestID)}
          data-testid="team-request-reject"
          onClick={() => void reply("reject")}
        >
          {text("own.sidebar.team.reject")}
        </button>
      </span>
    </div>
  )
}

/**
 * An area row (06 §9.4): `cl-cu · 컴퓨터 사용 · 담당` with its status word, then the short path, `메인: …` and
 * `프리셋: …` (dimmed for `평소대로`), and `데스크톱 사용 중` when a conversation of the area holds the desktop lease.
 * `끝낼 수 있음` rides beside the status word while the service marks the area retirable (8.1); an area whose folder is
 * gone offers `[끝내기]` (8.8), which opens the area menu at 영역 끝내기. It folds its conversations; its `⋯` (also
 * right click) opens the area menu (team/area-menu.tsx).
 */
export function AreaRow(props: {
  readonly rowKey: string
  readonly teamID: string
  readonly areaID: string
  readonly tree: TreeApi
}) {
  const ctl = useSidebar()
  const data = useData()
  const i18n = useI18n()
  const text = useSidebarText()
  const names = usePresetsBootText()
  const fold = foldKey.area(props.teamID, props.areaID)
  const open = () => !ctl.prefs.collapsed(fold)
  const compact = () => sidebarDensity() === "compact"
  const entry = () => ctl.team.team(props.teamID)
  const area = () => entry()?.areas[props.areaID]
  const view = createMemo(() => {
    const team = entry()
    const current = area()
    const model = ctl.teamView()
    if (!team || !current || !model) return undefined
    const main = current.main?.model
    const preset = presetByID(data.local().own.state.presetGroups, current.preset)
    return model.areaRow(model.words(i18n.locale()), current, {
      home: team.team.home.directory,
      waiting: team.waiting[current.id] ?? 0,
      main: main && {
        model: ctl.modelName(main, current.directory),
        effort: namedVariant(main.variant),
        account: ctl.accountOn(current.owner.sessionID, main.providerID)?.label,
      },
      preset: {
        name: preset ? presetName(preset, names("own.preset.builtin")) : current.preset,
        builtin: Preset.isBuiltin(current.preset),
      },
      now: minuteNow(),
      time: (at) => coming(i18n, minuteNow(), at),
      retire: ctl.team.has("reorg.retire") && ctl.team.rpc.allowed("reorg.apply"),
      recreate: ctl.team.has("reorg.new") && ctl.team.rpc.allowed("reorg.apply"),
    })
  })
  const desktop = () => {
    const root = ctl.leaseRoot()
    const team = entry()
    if (!root || !team) return false
    const slot = ctl.teamProject(team.team.projectID)?.slot(root, ctl.row(root)?.directory ?? "")
    return (slot?.kind === "owner" || slot?.kind === "peer" || slot?.kind === "area") && slot.areaID === props.areaID
  }
  let menuButton!: HTMLButtonElement
  const menu = () => {
    const current = area()
    if (current)
      openAreaMenu({ serverKey: ctl.serverKey, teamID: current.teamID, areaID: current.id, anchor: menuButton })
  }
  /**
   * `[다시 만들기]` and `[끝내기]` of a missing folder (8.8): the area menu at 다시 만들기 or 영역 끝내기
   * (team/area-menu.tsx reads `panel`).
   */
  const openPanel = (panel: "recreate" | "retire") => {
    const current = area()
    if (!current) return
    openAreaMenu({ serverKey: ctl.serverKey, teamID: current.teamID, areaID: current.id, anchor: menuButton, panel })
  }
  return (
    <div role="none" class="group relative" style={{ height: `${ctl.height(props.rowKey)}px` }}>
      <div
        role="treeitem"
        aria-level={levelOf(props.rowKey, ctl.tree().levels)}
        aria-expanded={open()}
        aria-haspopup="menu"
        tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
        data-key={props.rowKey}
        data-area-id={props.areaID}
        data-tone={view()?.status.tone}
        data-testid="area-row"
        title={area()?.directory}
        class={`${ROW} h-full cursor-pointer pr-2 pl-1.5 select-none`}
        onClick={() => ctl.prefs.toggleProject(fold)}
        onContextMenu={(event) => {
          event.preventDefault()
          menu()
        }}
      >
        <span class="flex min-w-0 items-center gap-1.5" classList={{ "pr-7": !ctl.touch, "pr-11": ctl.touch }}>
          <Chevron open={open()} />
          {/* 별칭 (2026-11-27): `민지 · ` gives way first, so a narrow sidebar keeps the area's own name. */}
          <span class="flex min-w-0 flex-1 text-[13px] font-medium">
            <Show when={view()?.alias}>
              {(alias) => (
                <span class="min-w-0 shrink-[999] truncate whitespace-pre" data-testid="area-alias">
                  {`${alias()} · `}
                </span>
              )}
            </Show>
            <span class="min-w-0 truncate" data-testid="area-label">
              {view()?.label}
            </span>
          </span>
          <span
            class={`min-w-0 flex-none truncate text-[11.5px] ${TONE[view()?.status.tone ?? "idle"]}`}
            data-testid="area-status"
          >
            {[view()?.status.word, view()?.status.waiting].filter(Boolean).join(" · ")}
          </span>
          <Show when={view()?.retirable}>
            {(badge) => (
              <span
                class="flex-none rounded border border-own-border px-1 text-[10.5px] leading-4 text-own-muted"
                data-testid="area-retirable"
              >
                {badge()}
              </span>
            )}
          </Show>
          <Show when={view()?.recreate}>
            {(label) => (
              <button
                type="button"
                tabindex={-1}
                class="flex-none rounded px-1 text-[11px] leading-4 text-own-muted hover:bg-own-hover hover:text-own-text"
                aria-label={text("own.sidebar.team.recreate", { area: area()?.name ?? props.areaID })}
                aria-haspopup="dialog"
                data-testid="area-recreate"
                onClick={(event) => {
                  event.stopPropagation()
                  openPanel("recreate")
                }}
              >
                {label()}
              </button>
            )}
          </Show>
          <Show when={view()?.finish}>
            {(label) => (
              <button
                type="button"
                tabindex={-1}
                class="flex-none rounded px-1 text-[11px] leading-4 text-own-muted hover:bg-own-hover hover:text-own-text"
                aria-label={text("own.sidebar.team.finish", { area: area()?.name ?? props.areaID })}
                aria-haspopup="dialog"
                data-testid="area-finish"
                onClick={(event) => {
                  event.stopPropagation()
                  openPanel("retire")
                }}
              >
                {label()}
              </button>
            )}
          </Show>
        </span>
        <Show when={!compact()}>
          <span class="mt-1 ml-[18px] flex min-w-0 items-center gap-1 pr-1 text-[12px] text-own-muted">
            <Show when={view()?.userMade}>
              {(mark) => (
                <span class="flex-none text-own-accent-text" data-testid="area-user-made">
                  {mark()} ·
                </span>
              )}
            </Show>
            <span class="min-w-0 truncate" data-testid="area-line">
              {view() ? `${view()!.path} · ${view()!.main}` : ""}
            </span>
            <span
              class="max-w-[50%] min-w-0 flex-none truncate"
              classList={{ "text-own-faint": view()?.builtin }}
              data-testid="area-preset"
              data-builtin={view()?.builtin ? "" : undefined}
            >
              · {view()?.preset}
            </span>
            <Show when={desktop()}>
              <DesktopTag />
            </Show>
          </span>
        </Show>
      </div>
      <button
        ref={menuButton}
        type="button"
        tabindex={-1}
        class="own-icon-button own-target absolute right-1 size-6"
        classList={{
          "top-1": !compact(),
          "top-1/2 -translate-y-1/2": compact(),
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100": !ctl.touch,
        }}
        aria-label={text("own.sidebar.team.areaMenu", { area: area()?.name ?? props.areaID })}
        aria-haspopup="menu"
        data-testid="area-menu-button"
        onClick={(event) => {
          event.stopPropagation()
          menu()
        }}
      >
        <span aria-hidden="true" class="own-ico own-ico-more" />
      </button>
    </div>
  )
}

/** `이 영역의 다른 대화 n` / `메인 폴더의 다른 대화 n` (06 §9.4): folded by default. */
export function TeamOthersRow(props: {
  readonly rowKey: string
  readonly teamID: string
  readonly areaID: string
  readonly tree: TreeApi
}) {
  const ctl = useSidebar()
  const text = useSidebarText()
  const words = useTeamWords()
  const fold = foldKey.others(props.teamID, props.areaID)
  const n = () => ctl.tree().counts[props.rowKey] ?? 0
  return (
    <TeamGroupRow
      rowKey={props.rowKey}
      tree={props.tree}
      open={ctl.prefs.expanded(fold)}
      label={
        props.areaID === HOME_GROUP
          ? text("own.sidebar.team.homeOthers", { n: n() })
          : (words()?.("own.team.otherConversations", { n: n() }) ?? "")
      }
      onToggle={() => ctl.prefs.toggleChildren(fold)}
      testid="team-others-row"
    />
  )
}

/**
 * `팀에 넣지 않은 작업 폴더 n` (06 §9.4): the project's other work folders, folded by default, after the areas. While
 * folded with a folder the team could take in, it offers `[팀에 넣기]`, which opens it: each such folder's row takes
 * that folder in (8.8).
 */
export function TeamOutsideRow(props: { readonly rowKey: string; readonly projectID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const words = useTeamWords()
  const fold = foldKey.outside(props.projectID)
  const open = () => ctl.prefs.expanded(fold)
  const adopt = () => {
    const project = ctl.teamProject(props.projectID)
    const view = ctl.teamView()
    if (open() || !project || !view) return undefined
    const offered = project.unadopted.some((item) =>
      view.adopt({
        project,
        directory: item.directory,
        has: (feature) => ctl.team.has(feature),
        allowed: (method) => ctl.team.rpc.allowed(method),
      }),
    )
    return offered ? words()?.("own.team.action.adopt") : undefined
  }
  return (
    <div role="none" class="relative" style={{ height: `${ctl.height(props.rowKey)}px` }}>
      <TeamGroupRow
        rowKey={props.rowKey}
        tree={props.tree}
        open={open()}
        label={words()?.("own.team.view.unadopted", { n: ctl.tree().counts[props.rowKey] ?? 0 }) ?? ""}
        onToggle={() => ctl.prefs.toggleChildren(fold)}
        testid="team-outside-row"
      />
      <Show when={adopt()}>
        {(label) => (
          <button
            type="button"
            tabindex={-1}
            class="absolute top-1/2 right-1 -translate-y-1/2 rounded px-1 text-[11px] leading-4 text-own-muted hover:bg-own-hover hover:text-own-text"
            data-testid="team-outside-adopt"
            onClick={() => ctl.prefs.toggleChildren(fold)}
          >
            {label()}
          </button>
        )}
      </Show>
    </div>
  )
}

/** `영역 만들기…` after a team's areas (06 §9.4, 2026-10-26): the dialog of team/create-area.tsx. */
export function TeamCreateRow(props: { readonly rowKey: string; readonly teamID: string; readonly tree: TreeApi }) {
  const ctl = useSidebar()
  const words = useTeamWords()
  return (
    <div
      role="treeitem"
      aria-level={levelOf(props.rowKey, ctl.tree().levels)}
      tabindex={props.tree.isTabStop(props.rowKey) ? 0 : -1}
      data-key={props.rowKey}
      data-testid="team-create-row"
      class="flex cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-2.5 text-[12px] text-own-muted select-none outline-offset-[-2px] hover:bg-own-hover hover:text-own-text"
      style={{ height: `${ctl.height(props.rowKey)}px` }}
      onClick={() => {
        const team = ctl.team.team(props.teamID)
        if (team) openCreateArea({ serverKey: ctl.serverKey, teamID: team.team.id })
      }}
    >
      <Icon name="plus" class="size-3 flex-none fill-none stroke-current stroke-2" />
      <span class="min-w-0 truncate">{words()?.("own.team.view.createArea") ?? ""}</span>
    </div>
  )
}

/** 4.3: drawn when there is neither a saved list nor a server answer yet. */
export function SkeletonRows() {
  const i18n = useI18n()
  return (
    <div class="flex flex-col gap-1 px-2 pt-2" data-testid="sidebar-skeleton" aria-busy="true">
      <span class="own-sr-only" role="status">
        {i18n.t("own.shell.loading")}
      </span>
      <For each={[0.72, 0.55, 0.64, 0.48, 0.6]}>
        {(width) => (
          <div class="flex h-[52px] flex-col justify-center gap-2 px-2.5" aria-hidden="true">
            <span class="h-2.5 rounded bg-own-hover" style={{ width: `${width * 100}%` }} />
            <span class="ml-[17px] h-2 w-2/5 rounded bg-own-hover" />
          </div>
        )}
      </For>
    </div>
  )
}

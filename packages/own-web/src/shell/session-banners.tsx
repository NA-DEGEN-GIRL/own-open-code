// Banners of the session on screen that come from other modules (03 §8): a linked Codex login whose old-app source
// went stale (5.4.2, the accounts module's `CodexStaleBanner`, loaded lazily with the accounts chunk only when shown),
// a Sign in with ChatGPT account at its usage limit (5.4, `UsageLimitBanner`, lazy the same way), a DeepSeek account
// out of balance (402: 충전 or switch, `DsBalanceBanner`, lazy the same way), a ChatGPT subscription account at its
// limit that holds reset credits (`리셋권 쓰기` opens the dialog) or a Claude account at its limit (the claude.ai link),
// both with `다른 계정으로 전환…` (6.6, 7.1.1, `LimitReachedBanner`, lazy with the limits summary), "MCP 인증 필요" for
// MCP servers the session's tool calls used (18.14, `McpAuthBanner`) and the browser tool note of a session this
// window cannot run it for (18.15, `BrowserToolNotice`). "인수로 바꾸기" leads to the accounts page, where the
// takeover dialog lives.
// Team mode (06 §9.3, §9.5): Main 멈춤 with the main requests it holds back, the stop button's Main 멈춤, another
// conversation in an area's folder or an area peer (동료) there (and the owner working on a main request there), a
// replaced owner conversation, a conversation the area's seat moved away from (6.8: 담당 대화로 가기, 다시 담당으로),
// once per older conversation of the main folder the pointer to 팀 메인, and on a conversation own moved after its
// folder (8.8, metadata `own.team.moved`) that it cannot go back to a point before the move (4.14, 9.7). None of them
// blocks input. The registry is read once a top-level session of the local service (or a hinted team session
// elsewhere) is on screen; team words (team/strings.ts) load only when a team banner or the header's team pill
// shows. An owner conversation also shows its area's latest integration (06 §7, §9.7: progress, waiting, conflict,
// failure, applied with undo and upload) until `닫기`; the team main shows integrations with its result cards
// (team/summary.tsx). The card is in the team chunk (team/integrate.tsx), loaded only when the area has an
// integration.
// Other tools' conversations (09 §4.7, §6): a conversation own.import imported says once, on its first screen (until
// a turn of its own), `Codex 대화 41턴을 가져왔습니다 · 요약에서 이어갑니다` (UI only, from its metadata); a folder's
// empty new conversation shows entry 4, `이 폴더에 아직 가져오지 않은 … 대화 N개가 있습니다 · 보기`, once per folder.
// Web search (18.2, WM 2026-10-19): a conversation whose searches went to a free keyless service while the server lists
// the user's ChatGPT service shows the one-time hint `웹 검색이 무료 서비스(…)로 가고 있어요 · ChatGPT 구독으로 바꿀까요?`
// (websearch/hint.tsx, lazy) until it is closed or answered.
// MCP on hosts (04 §13, MH): a host conversation says once per set of servers that this PC has MCP servers the host
// could install right away (mcp/host-hint.tsx, lazy), with `설치…` and `닫기`.
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  Match,
  on,
  onCleanup,
  Show,
  Suspense,
  Switch,
  untrack,
  type Accessor,
} from "solid-js"
import type { OwnTeam } from "@own/protocol/rpc-team"
import {
  importOrigin,
  LOCAL,
  TEAM_META,
  useData,
  type ImportOrigin,
  type ServerKey,
  type SessionPlace,
  type TeamStore,
} from "@/data"
import { useI18n } from "@/i18n"
import { ImportHint } from "@/import"
import { tightest } from "@/limits/windows"
import { McpAuthBanner } from "@/mcp"
import { BrowserToolNotice } from "@/policy"
import { samePath } from "@/projects/path"
import { messageSource } from "@/queue/model"
import { useRouter } from "@/routing/router"
import { remoteStore } from "@/servers/active"
import { newSessionDirectory } from "@/switcher/new-session"
import { showToast } from "@/switcher/toast"
import { openAreaMenu } from "@/team/intents"
import type { TeamText } from "@/team/model"
import type { teamText } from "@/team/strings"
import { minuteNow } from "./clock"
import { useShell } from "./context"
import { mcpServersUsed } from "./mcp-used"
import { TeamResultSlot } from "./notifications"
import { hintDismissed, isKeyless, webSearchUsed } from "@/websearch/used"

const CodexStaleBanner = lazy(() =>
  import("@/accounts/codex-import").then((module) => ({ default: module.CodexStaleBanner })),
)
const UsageLimitBanner = lazy(() =>
  import("@/accounts/chatgpt-login").then((module) => ({ default: module.UsageLimitBanner })),
)
const DsBalanceBanner = lazy(() =>
  import("@/accounts/ds-balance").then((module) => ({ default: module.DsBalanceBanner })),
)
const LimitReachedBanner = lazy(() =>
  import("@/limits/reset-credits").then((module) => ({ default: module.LimitReachedBanner })),
)
const IntegrationCard = lazy(() => import("@/team/integrate"))
const WebSearchHint = lazy(() => import("@/websearch/hint"))
/** 04 §13 "MCP" (MH): a host conversation's line when this PC has servers the host could install. */
const McpHostHint = lazy(() => import("@/mcp/host-hint"))

export function SessionBanners(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const router = useRouter()
  const own = () => data.get(props.serverKey())?.own
  createEffect(() => {
    const store = own()
    const sessionID = props.sessionID()
    if (store && sessionID) onCleanup(store.watchVisible([sessionID]))
  })
  const bound = () => {
    const sessionID = props.sessionID()
    const model = sessionID ? own()?.state.binding[sessionID]?.model : undefined
    return model ? data.local().own.accountFor(model.providerID) : undefined
  }
  const stale = () => {
    const account = bound()
    if (!account) return undefined
    // The rule of accounts/model.ts `isCodexStale`, inline so the first chunk does not pull the accounts model.
    const linked = account.connection.method === "codex-linked" || account.connection.source?.mode === "linked"
    return linked && account.status === "auth_failed" ? account : undefined
  }
  // accounts/chatgpt-plan.ts `USAGE_LIMIT_CODE`, inline for the same reason: the router names the code in
  // `account.status{reason}` (02 §3.2c), and the banner leaves with the next `ready`.
  const usageLimited = () => {
    const account = bound()
    return account?.kind === "siwc" &&
      data.local().own.state.statusReason[account.id] === "subscription_sharing_usage_limit_exceeded"
      ? account
      : undefined
  }
  // accounts/ds-balance.tsx `BALANCE_CODE`, inline for the same reason: DeepSeek's 402 (insufficient balance).
  const balanceOut = () => {
    const account = bound()
    return account?.kind === "ds" && data.local().own.state.statusReason[account.id] === "status_402"
      ? account
      : undefined
  }
  // 7.1.1: the conversation's ChatGPT subscription (with reset credits) or Claude account leads with a used-up window
  // for its model (limits/windows `tightest`, as the composer's button ranks them). The banner stays while its 리셋권
  // dialog is open (`held`): the redeem refills the windows and may use the last credit, and the dialog then shows how
  // it went.
  const [held, setHeld] = createSignal<string>()
  const limitReached = () => {
    const sessionID = props.sessionID()
    const model = sessionID ? own()?.state.binding[sessionID]?.model : undefined
    const account = bound()
    const state = data.local().own.state
    if (!account || !model) return undefined
    if (held() === account.id) return account
    // A Claude account of either route gets the Claude note and the switcher (CAG-53: the Claude Agent route too).
    const claude = account.kind === "claude-sub" || account.kind === "claude-agent"
    if (account.kind === "codex" ? !state.resetCredits[account.id]?.availableCount : !claude) return undefined
    return tightest(state.quota[account.id] ?? [], minuteNow(), model.id)?.status === "exhausted" ? account : undefined
  }
  const directory = () => {
    const sessionID = props.sessionID()
    return sessionID ? data.get(props.serverKey())?.data.session.get(sessionID)?.location.directory : undefined
  }
  // Recomputed when the message list changes shape, not on text deltas (tool names and inputs are read once set).
  const mcpServers = createMemo(
    () => {
      const sessionID = props.sessionID()
      const runtime = data.get(props.serverKey())
      return sessionID && runtime ? mcpServersUsed(runtime.data.session.message.list(sessionID)) : []
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((name, index) => name === b[index]) },
  )
  // Like the MCP servers: the services the conversation's searches used, recomputed when the list changes shape.
  const searched = createMemo(
    () => {
      const sessionID = props.sessionID()
      const runtime = data.get(props.serverKey())
      return sessionID && runtime && !hintDismissed() ? webSearchUsed(runtime.data.session.message.list(sessionID)) : []
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) },
  )
  return (
    <>
      <TeamResultSlot serverKey={props.serverKey} sessionID={props.sessionID} />
      <Show when={stale()}>
        {(account) => (
          <div class="px-4 pt-2">
            <Suspense>
              <CodexStaleBanner
                account={account()}
                serverKey={props.serverKey()}
                sessionID={props.sessionID()}
                onTakeover={() => router.navigate({ name: "accounts" })}
              />
            </Suspense>
          </div>
        )}
      </Show>
      <Show when={usageLimited()}>
        {(account) => (
          <div class="px-4 pt-2">
            <Suspense>
              <UsageLimitBanner accountID={account().id} serverKey={props.serverKey()} sessionID={props.sessionID()} />
            </Suspense>
          </div>
        )}
      </Show>
      <Show when={balanceOut()}>
        {(account) => (
          <div class="px-4 pt-2">
            <Suspense>
              <DsBalanceBanner account={account().label} serverKey={props.serverKey()} sessionID={props.sessionID()} />
            </Suspense>
          </div>
        )}
      </Show>
      <Show when={limitReached()}>
        {(account) => (
          <div class="px-4 pt-2">
            <Suspense>
              <LimitReachedBanner
                accountID={account().id}
                serverKey={props.serverKey()}
                sessionID={props.sessionID()!}
                onDialog={(open) => setHeld(open ? account().id : undefined)}
              />
            </Suspense>
          </div>
        )}
      </Show>
      <Show when={props.sessionID() && (mcpServers().length > 0 || undefined)}>
        <div class="px-4 pt-2">
          <McpAuthBanner directory={directory()} servers={mcpServers()} />
        </div>
      </Show>
      <Show when={!hintDismissed() && searched().some(isKeyless) && props.sessionID()}>
        {(sessionID) => (
          <div class="px-4 pt-2 empty:hidden">
            <Suspense>
              <WebSearchHint serverKey={props.serverKey()} sessionID={sessionID()} used={searched()} />
            </Suspense>
          </div>
        )}
      </Show>
      <Show
        when={
          props.sessionID() &&
          remoteStore()?.isHost(props.serverKey()) &&
          data.local().rpc.allowed("mcp.hosts.send") &&
          props.serverKey()
        }
      >
        {(hostId) => (
          <div class="px-4 pt-2 empty:hidden">
            <Suspense>
              <McpHostHint hostId={hostId()} />
            </Suspense>
          </div>
        )}
      </Show>
      <TeamBanners serverKey={props.serverKey} sessionID={props.sessionID} />
      <OwnerIntegration serverKey={props.serverKey} sessionID={props.sessionID} />
      <Show when={props.sessionID()}>
        {(sessionID) => (
          <div class="own-session-note px-4 pt-1.5 empty:hidden">
            <BrowserToolNotice sessionID={sessionID()} serverKey={props.serverKey()} />
          </div>
        )}
      </Show>
      <ImportedLine serverKey={props.serverKey} sessionID={props.sessionID} />
      <FolderImportHint />
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Other tools' conversations (09 §4.7, §6)

/**
 * The first screen of an imported conversation: whether to show its one line. Once its messages are there, until it
 * has a user turn of its own (sent after the import; imported turns keep their original, earlier times).
 */
export function importedLine(
  origin: Pick<ImportOrigin, "importedAt"> | undefined,
  messages: readonly SessionMessageInfo[],
) {
  if (!origin || messages.length === 0) return false
  return !messages.some((message) => message.type === "user" && message.time.created > origin.importedAt)
}

function ImportedLine(props: { readonly serverKey: () => ServerKey; readonly sessionID: () => string | undefined }) {
  const data = useData()
  const i18n = useI18n()
  const origin = createMemo(() => {
    const sessionID = props.sessionID()
    const session = sessionID ? data.get(props.serverKey())?.data.session : undefined
    const current = sessionID && session ? importOrigin(session.get(sessionID)?.metadata) : undefined
    return current && sessionID && importedLine(current, session?.message.list(sessionID) ?? []) ? current : undefined
  })
  return (
    <Show when={origin()}>
      {(current) => (
        <p class="m-0 px-4 pt-1.5 text-[12.5px] text-own-muted" role="note" data-testid="import-first-line">
          {i18n.t(current().mode === "summary" ? "own.otherTools.first.summary" : "own.otherTools.first.full", {
            tool: i18n.t(`own.otherTools.tool.${current().kind}`),
            n: current().turns,
          })}
        </p>
      )}
    </Show>
  )
}

/** Entry 4 on a folder's new conversation (the project route without a session). */
function FolderImportHint() {
  const shell = useShell()
  const data = useData()
  const project = createMemo(
    () => {
      const route = shell.workspaceRoute()
      if (route.name !== "project") return undefined
      const runtime = data.get(route.serverKey)
      return {
        serverKey: route.serverKey,
        projectID: route.projectID,
        directory: runtime && newSessionDirectory(runtime, route),
      }
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  )
  return (
    <Show when={project()} keyed>
      {(current) => (
        <div class="px-4 pt-2 empty:hidden">
          <ImportHint serverKey={current.serverKey} projectID={current.projectID} directory={current.directory} />
        </div>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Team banners (06 §9.3, §9.5)

interface AreaRef {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
}

/** A team banner of the session on screen. */
export type TeamBanner =
  /**
   * Main 멈춤 holds main requests back: `n` = the outbox plus main requests parked in the owner's queue (9.4). `0`
   * only for a conversation that took the seat by a move (6.8): it says Main 멈춤 is on before anything waits.
   * `direct`: the user works with the area (`Area.directWork`), the button hands it back to main.
   */
  | (AreaRef & { readonly kind: "paused"; readonly n: number; readonly direct?: boolean })
  /** The owner's stop button turned Main 멈춤 on (5.3). */
  | (AreaRef & { readonly kind: "pausedByStop" })
  /** A replaced owner conversation; `owner` is the conversation the area continues in. */
  | (AreaRef & { readonly kind: "previous"; readonly owner?: string })
  /**
   * A conversation the area's seat moved away from (6.8): `owner` holds the seat now; `again` where this connection
   * may give the seat back to this conversation.
   */
  | (AreaRef & { readonly kind: "seatLeft"; readonly owner?: string; readonly again: boolean })
  /** Another conversation in an area's folder: main requests wait while it works (5.1). */
  | (AreaRef & { readonly kind: "sameFolder"; readonly owner?: string })
  /**
   * An area peer (동료) in place of `sameFolder`: the main may send it requests, one main request at a time per folder
   * (5.1). `area` and `label` name the area and the peer.
   */
  | (AreaRef & { readonly kind: "peer"; readonly area: string; readonly label: string; readonly owner?: string })
  /** The owner works on a main request in that folder now; `paused` hides `[메인 멈춤]`. */
  | (AreaRef & { readonly kind: "ownerWorking"; readonly owner: string; readonly paused: boolean })
  /** An older conversation of the main folder, once (9.3): team tools live in the team main. */
  | { readonly kind: "home"; readonly teamID: OwnTeam.TeamID; readonly main: string }
  /** own moved this conversation after its folder (8.8): going back to a point before the move fails (4.14). */
  | { readonly kind: "moved" }

/** What the session data knows, for {@link teamBanners}. */
export interface TeamFacts {
  readonly session: (
    sessionID: string,
  ) => { readonly parentID?: string; readonly directory?: string; readonly moved?: boolean } | undefined
  /** Main requests (`own.dispatch` items) parked in a session's queue. */
  readonly parked: (sessionID: string) => number
  readonly running: (sessionID: string) => boolean
  /** The session's last run ended at the user's stop (its latest idle marker says `interrupted`). */
  readonly stopped: (sessionID: string) => boolean
  /** The session's latest delivered user message is a main request. */
  readonly onMainRequest: (sessionID: string) => boolean
  /** The main folder's banner was already shown for this conversation. */
  readonly homeSeen: (teamID: OwnTeam.TeamID, sessionID: string) => boolean
}

/**
 * The team banners of a top-level session (9.5): roles come from the registry (a metadata hint shows nothing), the
 * folder from the session. An owner gets Main 멈춤 (the stop button's, or with the requests it holds back); a
 * replaced owner the way to the new conversation; one the seat moved away from the way to the owner and back to the
 * seat; an area peer (동료) what it is instead of the same-folder note; any
 * other conversation in an area's folder the same-folder note; a peer and the others also the owner working on a
 * main request there; an older conversation of the main folder the one-time pointer to 팀 메인 (9.3). A conversation
 * own moved after its folder (8.8) says first that it cannot go back past the move (4.14), whatever its role.
 */
export function teamBanners(team: TeamStore, sessionID: string, facts: TeamFacts): TeamBanner[] {
  const session = facts.session(sessionID)
  if (!session?.directory || session.parentID) return []
  return [
    ...(session.moved ? [{ kind: "moved" as const }] : []),
    ...placeBanners(team, sessionID, session.directory, facts),
  ]
}

function placeBanners(team: TeamStore, sessionID: string, directory: string, facts: TeamFacts): TeamBanner[] {
  const place = team.placeOf(sessionID)
  if (place?.hint) return []
  if (place?.role === "owner") return ownerBanners(team, place, sessionID, facts)
  if (place?.role === "peer") return peerBanners(team, sessionID, facts)
  if (place?.role === "main" && !place.previous) return []
  const found = team.areaOfDirectory(directory)
  if (found) return folderBanners(found.area, facts)
  const home = team.teamOfDirectory(directory)?.team
  if (!home || !samePath(home.home.directory, directory) || facts.homeSeen(home.id, sessionID)) return []
  return [{ kind: "home", teamID: home.id, main: home.main.sessionID }]
}

/** The move mark own.team writes (`OwnTeam.MovedMeta`, 8.8), when the session metadata has it. */
function movedMark(metadata: SessionInfo["metadata"] | undefined) {
  const value = metadata?.[TEAM_META.moved]
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.at === "number"
}

function ownerBanners(team: TeamStore, place: SessionPlace, sessionID: string, facts: TeamFacts): TeamBanner[] {
  const area = place.areaID ? team.area(place.teamID, place.areaID) : undefined
  if (!area) return []
  const ref = { teamID: area.teamID, areaID: area.id }
  const owner = area.owner.sessionID ?? undefined
  // The item's own conditions (team/enable.ts `peerItems`): the feature, the scope and an active area.
  const again = team.has("seat") && team.rpc.allowed("area.seat") && area.state === "active"
  if (place.previous && place.why === "seat") return [{ kind: "seatLeft", ...ref, owner, again }]
  if (place.previous) return [{ kind: "previous", ...ref, owner }]
  if (area.paused === "user" && facts.stopped(sessionID)) return [{ kind: "pausedByStop", ...ref }]
  const n = (team.team(place.teamID)?.waiting[area.id] ?? 0) + facts.parked(sessionID)
  // 직접 작업 (2026-11-14): the user works here, so main requests wait until the user hands the area back.
  if (area.paused === false && area.directWork) return [{ kind: "paused", ...ref, n, direct: true }]
  if (area.paused === false) return []
  // Nothing waits: the pill alone says Main 멈춤. A conversation that took the seat by a move did not turn it on and
  // has no request that shows it yet, so its banner says so and turns it off in one click (5.3, 6.8), until the
  // user writes in it (one-way).
  const last = area.owner.previous.at(-1)
  return n > 0 || (last?.why === "seat" && (area.direct?.at ?? 0) <= last.endedAt)
    ? [{ kind: "paused", ...ref, n }]
    : []
}

/** A conversation in an area's folder that is not one of its owners or peers (`placeOf` names those). */
function folderBanners(area: OwnTeam.AreaView, facts: TeamFacts): TeamBanner[] {
  const ref = { teamID: area.teamID, areaID: area.id }
  return [{ kind: "sameFolder", ...ref, owner: area.owner.sessionID ?? undefined }, ...ownerWorking(area, facts)]
}

/** An area peer (동료): what it is, and the owner working on a main request in the folder. */
function peerBanners(team: TeamStore, sessionID: string, facts: TeamFacts): TeamBanner[] {
  const found = team.peerOf(sessionID)
  if (!found) return []
  const area = found.area
  return [
    {
      kind: "peer",
      teamID: area.teamID,
      areaID: area.id,
      area: area.name,
      label: found.peer.label,
      owner: area.owner.sessionID ?? undefined,
    },
    ...ownerWorking(area, facts),
  ]
}

/** The area's owner works on a main request in its folder now (5.1): another conversation there waits for it. */
function ownerWorking(area: OwnTeam.AreaView, facts: TeamFacts): TeamBanner[] {
  const owner = area.owner.sessionID ?? undefined
  if (owner === undefined || !facts.running(owner) || !facts.onMainRequest(owner)) return []
  return [{ kind: "ownerWorking", teamID: area.teamID, areaID: area.id, owner, paused: area.paused !== false }]
}

const [teamCatalog, setTeamCatalog] = createSignal<typeof teamText>()
let teamCatalogLoading = false

/**
 * The team words for the header pill, these banners and the transcript's team rows. Reading the accessor loads
 * team/strings.ts the first time, so only a team session pulls it in (06 §9.8: team screens stay out of the first
 * chunk, PF5); `undefined` until it has loaded.
 */
export function useTeamWords(): Accessor<TeamText | undefined> {
  const i18n = useI18n()
  return () => {
    const catalog = teamCatalog()
    if (catalog) return (key, params) => catalog.text(i18n.locale(), key, params)
    if (!teamCatalogLoading) {
      teamCatalogLoading = true
      void loadTeamCatalog().catch((error: unknown) => {
        teamCatalogLoading = false
        console.error("[own-web] team strings failed to load", error)
      })
    }
    return undefined
  }
}

async function loadTeamCatalog() {
  const { teamText } = await import("@/team/strings")
  setTeamCatalog(() => teamText)
}

function TeamBanners(props: { readonly serverKey: () => ServerKey; readonly sessionID: () => string | undefined }) {
  const data = useData()
  const router = useRouter()
  const words = useTeamWords()
  const runtime = () => data.get(props.serverKey())
  // The local service carries own.team; another server is asked once one of its sessions says it is a team session
  // (a server without own.team answers 400, which the browser logs). The registry then follows the events.
  createEffect(() => {
    const current = runtime()
    const sessionID = props.sessionID()
    const info = sessionID ? current?.data.session.get(sessionID) : undefined
    if (!current || !sessionID || !info || info.parentID) return
    untrack(() => {
      if (current.key === LOCAL || current.team.placeOf(sessionID)) current.team.ensure()
    })
  })
  // The session store keeps the metadata of its last read (`session.metadata.updated` does not reach it): when own.team
  // marks the conversation on screen as moved (8.8), it is read again so the banner shows without a reload.
  createEffect(() => {
    const current = runtime()
    const sessionID = props.sessionID()
    if (!current || !sessionID) return
    onCleanup(
      current.bus.on("session.metadata.updated", (event) => {
        const session = current.data.session
        if (event.data.sessionID !== sessionID || !movedMark(event.data.metadata)) return
        if (movedMark(session.get(sessionID)?.metadata)) return
        session.invalidate(sessionID)
        void session.sync(sessionID).catch((error: unknown) => console.warn("[own-web] session failed to load", error))
      }),
    )
  })
  // The main folder's banner key this view showed: it stays until ✕ or [열기], and only this view shows it.
  const [shown, setShown] = createSignal<string>()
  createEffect(on(props.sessionID, () => setShown(undefined), { defer: true }))
  const homeKey = (teamID: string, sessionID: string) => `${props.serverKey()}|${teamID}|${sessionID}`

  // Equal banners keep their rows: registry events and message updates recompute them often.
  const banners = createMemo(
    () => {
      const current = runtime()
      const sessionID = props.sessionID()
      if (!current || !sessionID) return []
      const session = current.data.session
      return teamBanners(current.team, sessionID, {
        session: (id) => {
          const info = session.get(id)
          return (
            info && { parentID: info.parentID, directory: info.location.directory, moved: movedMark(info.metadata) }
          )
        },
        parked: (id) =>
          session.pending
            .list(id)
            .filter((item) => item.type === "user" && messageSource(item.payload.metadata) !== "user").length,
        running: (id) => session.status(id) === "running",
        stopped: (id) => {
          const idle = session.message.list(id).findLast((message) => message.type === "idle")
          return idle?.type === "idle" && idle.outcome === "interrupted"
        },
        onMainRequest: (id) => {
          const pending = new Set(session.pending.list(id).map((item) => item.id))
          const user = session.message
            .list(id)
            .findLast((message) => message.type === "user" && !pending.has(message.id))
          return user?.type === "user" && messageSource(user.metadata) !== "user"
        },
        homeSeen: (teamID, id) => shown() !== homeKey(teamID, id) && seenHomes().has(homeKey(teamID, id)),
      })
    },
    [],
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  )
  createEffect(() => {
    const home = banners().find((banner) => banner.kind === "home")
    const sessionID = props.sessionID()
    if (!home || !sessionID) return
    const key = homeKey(home.teamID, sessionID)
    untrack(() => {
      if (shown() === key) return
      rememberHome(key)
      setShown(key)
    })
  })
  // Whether the owner of this folder works on a main request needs its latest messages (one page, once).
  createEffect(() => {
    const current = runtime()
    const owner = banners().find((banner) => banner.kind === "sameFolder" || banner.kind === "peer")?.owner
    if (!current || !owner || current.data.session.status(owner) !== "running") return
    void current.data.session.message
      .sync(owner)
      .catch((error: unknown) => console.warn("[own-web] owner messages failed to load", error))
  })

  const pausable = () => runtime()?.team.rpc.allowed("area.pause") === true
  const pause = (banner: AreaRef, on: boolean) =>
    void runtime()
      ?.team.rpc.call("area.pause", { teamID: banner.teamID, areaID: banner.areaID, on })
      .catch((error: unknown) => failed(error))
  async function failed(error: unknown) {
    const { errorText } = await import("@/team/model")
    const text = words()
    showToast({ message: text ? errorText(text, error) : String(error), tone: "danger" })
  }
  const open = (sessionID: string) => router.navigate({ name: "session", serverKey: props.serverKey(), sessionID })
  const button = "rounded-md border border-own-border px-2 py-0.5 hover:bg-own-hover"

  return (
    <Show when={banners().length > 0 && words()}>
      {(text) => (
        <div class="flex flex-col gap-1.5 px-4 pt-2">
          <For each={banners()}>
            {(banner) => (
              <div
                class="flex flex-wrap items-center gap-2 rounded-lg border border-own-border bg-own-subtle px-3 py-2 text-[12.5px]"
                role="status"
                data-testid="team-banner"
                data-kind={banner.kind}
              >
                <Switch>
                  <Match when={banner.kind === "paused" && banner}>
                    {(current) => (
                      <>
                        <span class="min-w-0 flex-1">
                          {text()(
                            `own.team.banner.${current().direct ? "direct" : "paused"}${current().n > 0 ? "" : "Quiet"}`,
                            { n: current().n },
                          )}
                        </span>
                        <Show when={pausable()}>
                          <button type="button" class={button} onClick={() => pause(current(), false)}>
                            {text()(`own.team.action.${current().direct ? "handBack" : "pauseOff"}`)}
                          </button>
                        </Show>
                        <Show when={current().n > 0}>
                          <button
                            type="button"
                            class={button}
                            aria-haspopup="menu"
                            onClick={(event) =>
                              openAreaMenu({
                                serverKey: props.serverKey(),
                                teamID: current().teamID,
                                areaID: current().areaID,
                                anchor: event.currentTarget,
                              })
                            }
                          >
                            {text()("own.team.action.view")}
                          </button>
                        </Show>
                      </>
                    )}
                  </Match>
                  <Match when={banner.kind === "pausedByStop" && banner}>
                    {(current) => (
                      <>
                        <span class="min-w-0 flex-1">{text()("own.team.banner.pausedByStop")}</span>
                        <Show when={pausable()}>
                          <button type="button" class={button} onClick={() => pause(current(), false)}>
                            {text()("own.team.action.pauseOff")}
                          </button>
                        </Show>
                      </>
                    )}
                  </Match>
                  <Match when={banner.kind === "previous" && banner}>
                    {(current) => (
                      <>
                        <span class="min-w-0 flex-1">{text()("own.team.banner.previous")}</span>
                        <Show when={current().owner}>
                          {(owner) => (
                            <button type="button" class={button} onClick={() => open(owner())}>
                              {text()("own.team.action.goToNew")}
                            </button>
                          )}
                        </Show>
                      </>
                    )}
                  </Match>
                  <Match when={banner.kind === "seatLeft" && banner}>
                    {(current) => (
                      <>
                        <span class="min-w-0 flex-1">{text()("own.team.banner.seatLeft")}</span>
                        <Show when={current().owner}>
                          {(owner) => (
                            <button
                              type="button"
                              class={button}
                              data-testid="team-banner-owner"
                              onClick={() => open(owner())}
                            >
                              {text()("own.team.action.goToOwner")}
                            </button>
                          )}
                        </Show>
                        <Show when={current().again && props.sessionID()}>
                          {(sessionID) => (
                            <button
                              type="button"
                              class={button}
                              aria-haspopup="dialog"
                              data-testid="team-banner-seat"
                              onClick={(event) =>
                                openAreaMenu({
                                  serverKey: props.serverKey(),
                                  teamID: current().teamID,
                                  areaID: current().areaID,
                                  panel: "seat",
                                  sessionID: sessionID(),
                                  anchor: event.currentTarget,
                                })
                              }
                            >
                              {text()("own.team.action.seatAgain")}
                            </button>
                          )}
                        </Show>
                      </>
                    )}
                  </Match>
                  <Match when={banner.kind === "sameFolder"}>
                    <span class="min-w-0 flex-1">{text()("own.team.banner.sameFolder")}</span>
                  </Match>
                  <Match when={banner.kind === "peer" && banner}>
                    {(current) => (
                      <span class="min-w-0 flex-1">
                        {text()("own.team.banner.peer", { area: current().area, label: current().label })}
                      </span>
                    )}
                  </Match>
                  <Match when={banner.kind === "moved"}>
                    <span class="min-w-0 flex-1">{text()("own.team.banner.moved")}</span>
                  </Match>
                  <Match when={banner.kind === "ownerWorking" && banner}>
                    {(current) => (
                      <>
                        <span class="min-w-0 flex-1">{text()("own.team.banner.ownerWorking")}</span>
                        <button type="button" class={button} onClick={() => open(current().owner)}>
                          {text()("own.team.action.openOwner")}
                        </button>
                        <Show when={!current().paused && pausable()}>
                          <button type="button" class={button} onClick={() => pause(current(), true)}>
                            {text()("own.team.action.pauseOn")}
                          </button>
                        </Show>
                      </>
                    )}
                  </Match>
                  <Match when={banner.kind === "home" && banner}>
                    {(current) => (
                      <>
                        <span class="min-w-0 flex-1">{text()("own.team.banner.home")}</span>
                        <button
                          type="button"
                          class={button}
                          onClick={() => {
                            setShown(undefined)
                            open(current().main)
                          }}
                        >
                          {text()("own.team.action.open")}
                        </button>
                        <button
                          type="button"
                          class="rounded-md px-1.5 py-0.5 text-own-muted hover:bg-own-hover"
                          aria-label={text()("own.team.action.close")}
                          onClick={() => setShown(undefined)}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </Match>
                </Switch>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

/** Integration cards closed in this window: one stays closed, and the area's next integration shows again. */
const [closedIntegrations, setClosedIntegrations] = createSignal<ReadonlySet<string>>(new Set())

/**
 * The latest integration of an owner conversation's area (06 §7, §9.7) above it, until `닫기`; an undone one is not
 * shown. Registry roles only: a replaced owner, a metadata hint and other conversations of the folder show none.
 */
function OwnerIntegration(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const shown = createMemo(() => {
    const team = data.get(props.serverKey())?.team
    const sessionID = props.sessionID()
    const place = sessionID ? team?.placeOf(sessionID) : undefined
    if (!team || place?.role !== "owner" || place.previous || place.hint || !place.areaID) return undefined
    const latest = team.integrationOf(place.teamID, place.areaID)
    if (!latest || latest.state === "undone" || closedIntegrations().has(latest.integrationID)) return undefined
    return latest.integrationID
  })
  return (
    <Show when={shown()} keyed>
      {(integrationID) => (
        <div class="px-4 pt-2" data-testid="owner-integration">
          <Suspense>
            <IntegrationCard
              serverKey={props.serverKey()}
              integrationID={integrationID}
              onClose={() => setClosedIntegrations((closed) => new Set([...closed, integrationID]))}
            />
          </Suspense>
        </div>
      )}
    </Show>
  )
}

/** Conversations that showed the main folder's banner (`<server>|<team>|<session>`), per viewer, newest last. */
const HOME_SEEN_KEY = "own.team.homeBanner"
const HOME_SEEN_LIMIT = 200
let homes: Set<string> | undefined

function seenHomes() {
  homes ??= new Set(readHomes())
  return homes
}

function readHomes(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HOME_SEEN_KEY) ?? "[]")
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
  } catch {
    return []
  }
}

function rememberHome(key: string) {
  const seen = seenHomes()
  seen.add(key)
  try {
    localStorage.setItem(HOME_SEEN_KEY, JSON.stringify([...seen].slice(-HOME_SEEN_LIMIT)))
  } catch {}
}

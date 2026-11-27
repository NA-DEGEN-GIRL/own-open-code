// TeamStore (06 §9, §2.7): the own.team registry of one server as the screens show it. Every ServerRuntime has one
// (`runtime.team`, with its typed client at `runtime.team.rpc`).
// - Like the ComputerStore it asks nothing until a screen needs it (`ensure`, `load`): a service without own.team
//   answers 400 (`rpc.unavailable`), which the browser logs in every window. From then on every `server.connected`
//   reads `health`, `team.list` and `team.get` of each team that is on (06 §2.7 calls all go to the control location).
// - The leader's `rpc.own.team.*` events, de-duplicated by `eventId`, keep it current: `area.changed` patches the
//   area's status and Main 멈춤 at once, `outbox.changed` the outbox size, `integration.changed` the latest integration
//   of each area (06 §7: an older one's change never replaces a newer one), `op.*` the op progress and the pending
//   confirms, `notice` the notice list. Every registry write bumps the team's `rev`: a newer `rev` reloads that team
//   (coalesced), and a `team.get` answer older than what the store holds is dropped.
// - The team view lists notices until `닫기` (`dismiss`), and `account.moved` drops the team's `account.waiting` it ends
//   (06 §9.4, §9.7, §10.1). One-shot notices (a followed record, a found folder) live in the window that heard them.
//   Notices the service holds open (`team.get` `notices`: a repair, a stopped area, a waiting integration, kept link
//   copies) also come back after a reload, and leave once a later answer no longer holds them (the cause is gone).
// - Roles come from the registry (06 §9.4). Session metadata `own.team` is a hint only while the registry has not
//   answered for that team, and never for child sessions, which copy their parent's metadata (06 §2.8). An area peer
//   (동료, `area.peers`) is a role of the registry only: the metadata own.team writes on a peer it created is no hint.
// - The retire suggestion of an area (`AreaView.retirable`, 06 §8.1, §9.7) leaves this window with `[무시]`
//   (`ignoreRetire`); a later quiet period (another `since`) suggests it again.
import type { JsonValue, SessionInfo } from "@opencode/client"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { EventBus } from "@/data/events"
import { createKeyedCoalescer } from "@/data/frame"
import {
  TEAM_META,
  teamEvent,
  type TeamEvent,
  type TeamEventName,
  type TeamOutput,
  type TeamRpc,
} from "@/data/team-rpc"
import { samePath } from "@/projects/path"

/**
 * - `idle`: nothing asked yet; `loading`: the first read is on its way; `ready`: the registry is loaded;
 * - `unmanaged`: own.team answered but its guard failed (`reason` = the guard value);
 * - `missing`: no own.team on this server (no plugin, an older service); `unavailable`: another failure (`reason`).
 */
export type TeamLoad = "idle" | "loading" | "ready" | "unmanaged" | "missing" | "unavailable"

/** A team that is on, as `team.get` returned it plus what events changed since. */
export interface TeamEntry {
  team: OwnTeam.Team
  areas: Record<string, OwnTeam.AreaView>
  /** Area ids in registry order. */
  order: string[]
  /** Outbox size per area. */
  waiting: Record<string, number>
  /** The running or waiting op. */
  op: OwnTeam.Op | null
  pending: OwnTeam.Confirm[]
}

/** What `op.progress` and `op.done` said about an op (progress toasts, result cards). */
export interface OpProgress {
  readonly teamID: string
  /** `wait`: why the step waits now (RH-20, `op.progress{wait}`). */
  steps: Record<string, { readonly state: OwnTeam.StepState; readonly text: string; readonly wait?: OwnTeam.StepWait }>
  last?: { readonly stepID: string; readonly text: string }
  done?: {
    readonly state: OwnTeam.OpState
    readonly summary: OwnTeam.Summary | null
    readonly undoable: boolean
    readonly pending: number
  }
}

export interface TeamNotice {
  readonly id: string
  readonly at: number
  readonly teamID: string
  readonly areaID?: string
  readonly kind: OwnTeam.NoticeKind
  /** The service's own wording, used when own-web has none for the data it got. */
  readonly text: string
  readonly data?: Readonly<Record<string, string | number | boolean>>
}

/** An area's latest integration as `integration.changed` announced it (06 §7); its card reads the rest. */
export interface AreaIntegration {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly integrationID: OwnTeam.IntegrationID
  readonly state: OwnTeam.IntegrationState
}

export interface TeamState {
  load: TeamLoad
  reason?: string
  health?: OwnTeam.Health
  /** `team.list`: every team of this server, on or off. */
  list: OwnTeam.TeamListItem[]
  /** Teams that are on, by team id. */
  teams: Record<string, TeamEntry>
  /** By `<teamID>|<areaID>` (area ids are unique within a team only): the area's latest integration. */
  integrations: Record<string, AreaIntegration>
  /** By op id, the last {@link OP_LIMIT}. */
  ops: Record<string, OpProgress>
  /** Newest first, at most {@link NOTICE_LIMIT}. */
  notices: TeamNotice[]
  /** By `<teamID>|<areaID>`: the `retirable.since` of a retire suggestion the user ignored in this window. */
  ignored: Record<string, number>
}

/** A session's place in a team (06 §9.4). */
export interface SessionPlace {
  readonly teamID: OwnTeam.TeamID
  /** `peer`: an area peer (동료), a root conversation the area's registry lists in `peers`. */
  readonly role: "main" | "owner" | "peer"
  /** Owners and peers only. */
  readonly areaID?: OwnTeam.AreaID
  /** Peers only: the peer's key in its area (`Peer.key`). */
  readonly key?: string
  /** A replaced conversation (`지난 대화`): no longer the team's main or the area's owner. Never for a peer. */
  readonly previous: boolean
  /** An earlier owner only: how its time as the owner ended (`seat`: the seat moved onto another conversation). */
  readonly why?: OwnTeam.OwnerEnded
  /** Read from session metadata because the registry has not answered for this team yet. */
  readonly hint: boolean
}

const RELOAD_MS = 250
const SEEN_LIMIT = 1024
const OP_LIMIT = 64
const NOTICE_LIMIT = 50
/** Coalescer key of a full reload (a team the store does not know yet). */
const ALL = ""
/** The RPC is not there: no own.team plugin, or one without this method. */
const MISSING = new Set(["rpc.unavailable", "rpc.method_not_found"])
const TEAM_ID_PATTERN = /^tm_[0-9a-f]{12}$/
const AREA_ID_PATTERN = /^ar_[a-z0-9][a-z0-9-]{0,31}$/

type Listener = (event: TeamEvent) => void

export function createTeamStore(input: {
  readonly rpc: TeamRpc
  readonly bus: Pick<EventBus, "listen">
  /** What the session data knows of a session: its parent and its metadata (the `own.team` hint). */
  readonly session?: (sessionID: string) => Pick<SessionInfo, "parentID" | "metadata"> | undefined
  /** `ensure` asks at once only while the event stream is up; otherwise the next `server.connected` does. */
  readonly connected?: () => boolean
  /** Tests shorten the reload window. */
  readonly reloadMs?: number
}) {
  const [state, setState] = createStore<TeamState>({
    load: "idle",
    list: [],
    teams: {},
    integrations: {},
    ops: {},
    notices: [],
    ignored: {},
  })
  const seen = new Set<string>()
  /** Notices the user closed in this window (`noticeKey`): an open one `team.get` answers again stays closed. */
  const dismissed = new Set<string>()
  /** Per team, the `noticeKey`s of the notices its last `team.get` answer held open. */
  const held = new Map<string, Set<string>>()
  const listeners = new Map<TeamEventName, Set<Listener>>()
  // Something needed the registry: every later `server.connected` and every unknown team reloads it.
  let wanted = false
  // A newer resync wins over an older one still on its way.
  let generation = 0

  const reloads = createKeyedCoalescer<string>(input.reloadMs ?? RELOAD_MS, (keys) =>
    keys.forEach((key) => void (key === ALL ? resync() : reload(key))),
  )

  /** Session id → its place, rebuilt when the registry changes. */
  const places = createMemo(() => new Map(Object.values(state.teams).flatMap(placesOf)))

  async function resync() {
    wanted = true
    const mine = ++generation
    setState("load", (load) => (load === "ready" ? load : "loading"))
    try {
      const health = await input.rpc.call("health", {})
      if (mine !== generation) return
      setState("health", reconcile(health))
      if (health.guard !== "ok") {
        setState({ load: "unmanaged", reason: health.guard })
        return
      }
      const list = await input.rpc.call("team.list", {})
      const on = list.teams.filter((item) => item.state === "on")
      const answers = await Promise.allSettled(on.map((item) => input.rpc.call("team.get", { directory: item.home })))
      if (mine !== generation) return
      const kept = new Set<string>(on.map((item) => item.id))
      batch(() => {
        setState("list", reconcile([...list.teams], { key: "id" }))
        setState(
          "teams",
          produce((teams) =>
            Object.keys(teams)
              .filter((id) => !kept.has(id))
              .forEach((id) => delete teams[id]),
          ),
        )
        answers.forEach((answer) => (answer.status === "fulfilled" ? applyGet(answer.value) : report(answer.reason)))
        setState({ load: "ready", reason: undefined })
      })
    } catch (error) {
      if (mine !== generation) return
      const type = errorType(error)
      setState({ load: MISSING.has(type) ? "missing" : "unavailable", reason: type })
    }
  }

  function reload(teamID: string) {
    const known = state.teams[teamID]
    if (!known) return resync()
    return input.rpc.call("team.get", { directory: known.team.home.directory }).then((output) => {
      // The team's records are gone (the undo of the enable that made it): no team is on there anymore.
      if (output.team?.id !== teamID)
        setState(
          "teams",
          produce((teams) => void delete teams[teamID]),
        )
      applyGet(output)
    }, report)
  }

  /** A `team.get` answer, unless the store already holds a newer revision of that team. */
  function applyGet(output: TeamOutput<"team.get">) {
    const team = output.team
    if (!team) return
    const known = state.teams[team.id]
    if (known && known.team.rev > team.rev) return
    if (team.state !== "on") {
      setState(
        "teams",
        produce((teams) => void delete teams[team.id]),
      )
      return
    }
    setState(
      "teams",
      team.id,
      reconcile({
        team,
        areas: Object.fromEntries(output.areas.map((area) => [area.id, area])),
        order: output.areas.map((area) => area.id),
        waiting: { ...output.waiting },
        op: output.op,
        pending: [...output.pending],
      }),
    )
    if (output.notices) opened(team.id, output.notices)
  }

  /**
   * Notices the service still holds open (`team.get` `notices`: a repair until it is fixed, a stopped area, a waiting
   * integration, an account wait while it lasts), so a window opened after the event shows them too. One already
   * listed (the same words) or one the user closed in this window is not added again. One the previous answer held and
   * this one does not has ended on the service: it leaves the list, with the event that announced it.
   */
  function opened(teamID: string, open: ReadonlyArray<OwnTeam.OpenNotice>) {
    const keys = new Set(open.map((notice) => noticeKey(teamID, notice)))
    const ended = new Set([...(held.get(teamID) ?? [])].filter((key) => !keys.has(key)))
    held.set(teamID, keys)
    const fresh = open.filter(
      (notice) =>
        !dismissed.has(noticeKey(teamID, notice)) &&
        !state.notices.some(
          (item) => item.id === notice.id || noticeKey(item.teamID, item) === noticeKey(teamID, notice),
        ),
    )
    if (fresh.length === 0 && ended.size === 0) return
    setState("notices", (notices) =>
      [
        ...fresh.map((notice) => ({
          id: notice.id,
          at: notice.at,
          teamID,
          areaID: notice.areaID,
          kind: notice.kind,
          text: notice.text,
          data: notice.data,
        })),
        ...notices.filter((item) => !ended.has(noticeKey(item.teamID, item))),
      ]
        .toSorted((a, b) => b.at - a.at)
        .slice(0, NOTICE_LIMIT),
    )
  }

  function schedule(key: string) {
    if (wanted) reloads.push(key, key)
  }

  function track(opID: string, teamID: string, change: (op: OpProgress) => void) {
    setState(
      "ops",
      produce((ops) => {
        change((ops[opID] ??= { teamID, steps: {} }))
        const oldest = Object.keys(ops)[0]
        if (Object.keys(ops).length > OP_LIMIT && oldest !== undefined) delete ops[oldest]
      }),
    )
  }

  function apply(event: TeamEvent) {
    switch (event.name) {
      case "team.changed": {
        const known = state.teams[event.data.teamID]
        if (!known || event.data.rev > known.team.rev) schedule(known ? event.data.teamID : ALL)
        break
      }
      case "area.changed": {
        const data = event.data
        const known = state.teams[data.teamID]
        if (!known) {
          schedule(ALL)
          break
        }
        if (known.areas[data.areaID])
          setState("teams", data.teamID, "areas", data.areaID, { status: data.status, paused: data.paused })
        if (data.rev > known.team.rev || !known.areas[data.areaID]) schedule(data.teamID)
        break
      }
      case "outbox.changed":
        if (state.teams[event.data.teamID])
          setState("teams", event.data.teamID, "waiting", event.data.areaID, event.data.waiting)
        break
      case "integration.changed": {
        const data = event.data
        const key = areaKey(data.teamID, data.areaID)
        const known = state.integrations[key]
        // Ids are ULIDs: a later integration sorts after an earlier one, so an older one's change (its undo) stays out.
        if (known && known.integrationID > data.integrationID) break
        setState("integrations", key, {
          teamID: data.teamID,
          areaID: data.areaID,
          integrationID: data.integrationID,
          state: data.state,
        })
        break
      }
      case "op.progress": {
        const data = event.data
        track(data.opID, data.teamID, (op) => {
          op.steps[data.stepID] = { state: data.state, text: data.text, ...(data.wait ? { wait: data.wait } : {}) }
          op.last = { stepID: data.stepID, text: data.text }
        })
        break
      }
      case "op.done": {
        const data = event.data
        track(data.opID, data.teamID, (op) => {
          op.done = { state: data.state, summary: data.summary, undoable: data.undoable, pending: data.pending }
        })
        // The op is no longer running and its confirms may be gone: the registry says what is left.
        if (state.teams[data.teamID]) schedule(data.teamID)
        break
      }
      case "op.confirm": {
        const { eventId: _eventId, origin: _origin, ...confirm } = event.data
        if (!state.teams[confirm.teamID]) {
          schedule(ALL)
          break
        }
        setState("teams", confirm.teamID, "pending", (pending) => [
          ...pending.filter((item) => item.opID !== confirm.opID || item.stepID !== confirm.stepID),
          confirm,
        ])
        break
      }
      case "notice": {
        const data = event.data
        // The move ended the wait it announced; the same notice heard before (its open copy from `team.get`) gives way.
        const key = noticeKey(data.teamID, data)
        const ended = (item: TeamNotice) =>
          (data.kind === "account.moved" && item.teamID === data.teamID && item.kind === "account.waiting") ||
          noticeKey(item.teamID, item) === key
        setState("notices", (notices) =>
          [
            {
              id: data.eventId,
              at: event.created,
              teamID: data.teamID,
              areaID: data.areaID,
              kind: data.kind,
              text: data.text,
              data: data.data,
            },
            ...notices.filter((item) => !ended(item)),
          ].slice(0, NOTICE_LIMIT),
        )
        break
      }
    }
    listeners.get(event.name)?.forEach((listener) => {
      try {
        listener(event)
      } catch (error) {
        console.error("[own-web] own.team event listener failed", event.name, error)
      }
    })
  }

  /** The registry's place for a session, else the metadata hint of a root session whose team it has not seen. */
  function placeOf(sessionID: string): SessionPlace | undefined {
    const known = places().get(sessionID)
    if (known) return known
    const info = input.session?.(sessionID)
    if (!info || info.parentID) return undefined
    const meta = hintOf(info.metadata?.[TEAM_META.session])
    if (!meta || state.teams[meta.teamID] || state.list.some((item) => item.id === meta.teamID)) return undefined
    return { ...meta, previous: false, hint: true }
  }

  const stop = input.bus.listen((raw) => {
    if (raw.type === "server.connected") {
      if (wanted) void resync()
      return
    }
    // Plugins load in the background since upstream v2.4.0 (#63814): own.team may register after the first read.
    if (raw.type === "plugin.updated") {
      if (wanted && state.load === "missing") void resync()
      return
    }
    const event = teamEvent(raw)
    if (!event) return
    const id = event.data.eventId
    if (seen.has(id)) return
    seen.add(id)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!)
    apply(event)
  })

  return {
    state,
    rpc: input.rpc,
    /** Reads the registry now (and on every later `server.connected`). */
    resync,
    /** {@link resync} once, when nothing asked yet. */
    ensure() {
      if (state.load !== "idle") return
      wanted = true
      if (input.connected?.() ?? true) void resync()
    },
    /** `team.get` for a folder: its team when it is on, `undefined` when there is none. Errors go to the caller. */
    async load(directory: string) {
      wanted = true
      const output = await input.rpc.call("team.get", { directory })
      applyGet(output)
      return output.team ? state.teams[output.team.id] : undefined
    },
    /** `닫기` on a notice in the team view: it leaves the list, and an open one on the service stays closed here. */
    dismiss(noticeID: string) {
      const closed = state.notices.find((item) => item.id === noticeID)
      if (closed) dismissed.add(noticeKey(closed.teamID, closed))
      setState("notices", (notices) => notices.filter((item) => item.id !== noticeID))
    },
    /** `[무시]` on a retire suggestion (06 §9.7): hidden in this window until the area is quiet for another period. */
    ignoreRetire(teamID: string, areaID: string, since: number) {
      setState("ignored", areaKey(teamID, areaID), since)
    },
    /**
     * The areas to suggest finishing (06 §8.1, §9.7), in registry order: active, marked retirable by the service, and
     * not ignored in this window for that quiet period. A signal only: nothing retires by itself.
     */
    retireCandidates(teamID: string): OwnTeam.AreaView[] {
      const entry = state.teams[teamID]
      if (!entry) return []
      return entry.order.flatMap((id) => {
        const area = entry.areas[id]
        const since = area?.retirable?.since
        if (!area || area.state !== "active" || since === undefined) return []
        return state.ignored[areaKey(teamID, id)] === since ? [] : [area]
      })
    },
    /** This build of own.team has the feature (`health.features`); clients hide actions without it. */
    has: (feature: OwnTeam.Feature) => state.health?.features.includes(feature) ?? false,
    /**
     * How much of 영역 만들기 (06 §9.4) this own.team takes, where the connection may apply: `full` with `area-edit`
     * (an area's own model, 에이전트 방식 and the user-made mark came with it, 2026-10-26); `basic` on an older one that
     * only makes areas (`reorg.new`), which would drop those without a word, so the dialog asks for the name, the role
     * and a new folder only, as its 새 영역 did (2026-10-27); `undefined`: no 영역 만들기.
     */
    createForm: (): "full" | "basic" | undefined => {
      if (!input.rpc.allowed("reorg.apply")) return undefined
      const features = state.health?.features ?? []
      if (features.includes("area-edit")) return "full"
      return features.includes("reorg.new") ? "basic" : undefined
    },
    team: (teamID: string): TeamEntry | undefined => state.teams[teamID],
    area: (teamID: string, areaID: string) => state.teams[teamID]?.areas[areaID],
    /** The area's latest integration this window heard of (06 §7, §9.7), whatever its state. */
    integrationOf: (teamID: string, areaID: string): AreaIntegration | undefined =>
      state.integrations[areaKey(teamID, areaID)],
    placeOf,
    /** The team's current main conversation (not a replaced one). */
    isTeamMain(sessionID: string) {
      const place = placeOf(sessionID)
      return place?.role === "main" && !place.previous
    },
    /** The area a session is (or was, `previous`) the owner of. */
    areaOfSession(sessionID: string) {
      const place = placeOf(sessionID)
      return place?.role === "owner" ? place : undefined
    },
    /** The area peer (동료) a session is, with its area: the registry's `area.peers` only. */
    peerOf(sessionID: string) {
      const place = places().get(sessionID)
      if (place?.role !== "peer" || !place.areaID) return undefined
      const area = state.teams[place.teamID]?.areas[place.areaID]
      const peer = area?.peers?.find((item) => item.key === place.key)
      return area && peer ? { area, peer } : undefined
    },
    /** The team whose main folder or one of whose area folders is `directory`. */
    teamOfDirectory(directory: string) {
      return Object.values(state.teams).find(
        (entry) =>
          samePath(entry.team.home.directory, directory) ||
          entry.order.some((id) => {
            const area = entry.areas[id]
            return area !== undefined && samePath(area.directory, directory)
          }),
      )
    },
    /** The area whose folder is `directory`: its owner, earlier owners and other conversations there (5.4). */
    areaOfDirectory(directory: string) {
      return Object.values(state.teams)
        .flatMap((team) =>
          team.order.flatMap((id) => {
            const area = team.areas[id]
            return area && area.state !== "retired" && samePath(area.directory, directory) ? [{ team, area }] : []
          }),
        )
        .at(0)
    },
    /** Teams of a project: clones of one remote share the project id but each has its own team (06 §3.2). */
    teamsOfProject(projectID: string) {
      return Object.values(state.teams).filter((entry) => entry.team.projectID === projectID)
    },
    /** Events after de-duplication by `eventId`. */
    on<E extends TeamEventName>(name: E, listener: (event: TeamEvent<E>) => void) {
      const set = listeners.get(name) ?? new Set<Listener>()
      listeners.set(name, set)
      // SAFETY: `apply` only calls listeners registered under the event's own name.
      const erased = listener as Listener
      set.add(erased)
      return () => void set.delete(erased)
    },
    /** Runs the coalesced reloads now (tests, teardown). */
    flush: () => reloads.flush(),
    dispose() {
      stop()
      reloads.dispose()
      listeners.clear()
    },
  }
}

export type TeamStore = ReturnType<typeof createTeamStore>

function placesOf(entry: TeamEntry): Array<[string, SessionPlace]> {
  const teamID = entry.team.id
  const main = (previous: boolean): SessionPlace => ({ teamID, role: "main", previous, hint: false })
  // First, so a main or an owner wins if the registry ever listed one as a peer too (own.team refuses that).
  const peers = entry.order.flatMap((id): Array<[string, SessionPlace]> => {
    const area = entry.areas[id]
    if (!area) return []
    return (area.peers ?? []).map((peer): [string, SessionPlace] => [
      peer.sessionID,
      { teamID, role: "peer", areaID: area.id, key: peer.key, previous: false, hint: false },
    ])
  })
  const owners = entry.order.flatMap((id): Array<[string, SessionPlace]> => {
    const area = entry.areas[id]
    if (!area) return []
    const owner = (previous: boolean): SessionPlace => ({
      teamID,
      role: "owner",
      areaID: area.id,
      previous,
      hint: false,
    })
    // Earlier owners first, so the current owner wins if an id were listed twice.
    return [
      ...area.owner.previous.map((item): [string, SessionPlace] => [item.sessionID, { ...owner(true), why: item.why }]),
      ...[area.owner.pending, area.owner.sessionID].flatMap(
        (sessionID): Array<[string, SessionPlace]> => (sessionID ? [[sessionID, owner(false)]] : []),
      ),
    ]
  })
  return [
    ...peers,
    ...entry.team.main.previous.map((sessionID): [string, SessionPlace] => [sessionID, main(true)]),
    [entry.team.main.sessionID, main(false)],
    ...owners,
  ]
}

/** The session metadata own.team writes under `TEAM_META.session` (`OwnTeam.SessionMeta`), when it has that shape. */
function hintOf(value: JsonValue | undefined): Pick<SessionPlace, "role" | "teamID" | "areaID"> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const role = value.role
  const teamID = value.teamID
  const areaID = value.areaID
  if (role !== "main" && role !== "owner") return undefined
  if (typeof teamID !== "string" || !TEAM_ID_PATTERN.test(teamID)) return undefined
  if (role === "owner" && (typeof areaID !== "string" || !AREA_ID_PATTERN.test(areaID))) return undefined
  return {
    role,
    // SAFETY: the ids matched the patterns of `OwnTeam.TeamID` and `OwnTeam.AreaID` just above.
    teamID: teamID as OwnTeam.TeamID,
    areaID: role === "owner" ? (areaID as OwnTeam.AreaID) : undefined,
  }
}

function errorType(error: unknown) {
  if (typeof error === "object" && error !== null && "type" in error && typeof error.type === "string")
    return error.type
  return error instanceof Error ? error.name : "unknown"
}

function report(error: unknown) {
  console.error("[own-web] own.team request failed", error)
}

/** The key of an area across the server's teams (area ids are unique within a team only, 06 §2.4). */
function areaKey(teamID: string, areaID: string) {
  return `${teamID}|${areaID}`
}

/** A notice's identity across its event and its open copy in `team.get`: team, kind, area and words. */
function noticeKey(teamID: string, notice: Pick<TeamNotice, "kind" | "areaID" | "text">) {
  return JSON.stringify([teamID, notice.kind, notice.areaID ?? "", notice.text])
}

export * as Peers from "./peer.js"

import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Outbox } from "../dispatch/dispatch.js"
import { Adopt } from "../ops/adopt.js"
import { AreaCreate } from "../ops/area-create.js"
import { Areas } from "../registry/area.js"
import { Cursor } from "../report/cursor.js"
import { Digest } from "../report/digest.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import { Permissions } from "../tools/permissions.js"
import { RoleInstructions } from "./instructions.js"
import { MainSession } from "./main.js"

/**
 * Area peers (동료, 06 §1.2, §2.4, §2.7, approved 2026-10-09): root conversations of an area's folder the main may send
 * requests to besides the owner. The registry decides the role by session id only (`Locate.session`), never by
 * metadata, and children are never peers.
 *
 * - **Registered** (`area.peer.add{sessionID}`, 동료로 등록…): a root conversation of the area's folder that is no
 *   main or owner conversation of the team, checked against the team's R4 (`same_company_subscription`). Its model
 *   and preset stay the user's; its log is followed from its watermark on (like an adopted owner, 3.7), and the team
 *   allows and the role entry `own.team.peer.role` go on together at its first main request ({@link attach}, one
 *   delta).
 * - **Created** (`area.peer.add{create}`, 동료 추가…): a new conversation in the area's folder on the area main (else
 *   the team main's Ref) with the owner's allows, the area preset with the team context and the peer role from the
 *   start (delta 0). The record is written first, so a retry after a crash adopts the session made before.
 *
 * Peers get exactly the owner's allows (`Permissions.rules("owner")`), so a team session's catalog is the same; the
 * tools narrow what a peer may do (`tools/owner.ts`). {@link edit} rewrites an attached peer's role entry; {@link
 * remove} detaches it and cancels the main requests that waited for it (a team note tells the main); the conversation
 * stays the user's. 팀에서 빼기, 끄기 and 되돌리기 detach every attached peer of the area ({@link detachAll}).
 */

export function create(services: Services.Context): Services.Peers {
  /** Peers whose role entry this controller brought (or is bringing) up to date (`team:area:session`). */
  const current = new Set<string>()
  /** Per team, how often `stale` ran: a write that read the registry before one does not count as up to date. */
  const stamps = new Map<string, number>()
  return {
    role: async (input) => {
      // 06 §6.2, §5.8: an attached peer gets the current text once per controller (and again after `stale`), before
      // its next request goes (`put` skips an equal value).
      const stamp = stamps.get(input.teamID) ?? 0
      const [team, area] = await Promise.all([
        services.registry.teams.get(input.teamID),
        services.registry.areas.get(input.teamID, input.areaID),
      ])
      const peer = area ? of(area).find((item) => item.key === input.key) : undefined
      if (!team || !area || !peer?.attached) return
      const key = `${team.id}:${area.id}:${peer.sessionID}`
      if (current.has(key)) return
      current.add(key)
      const put = await RoleInstructions.put(services, {
        sessionID: peer.sessionID,
        directory: area.directory,
        key: RoleInstructions.PEER,
        value: RoleInstructions.peer({
          team,
          area,
          peer,
          blocks: await RoleInstructions.blocks(services.kv, services.log, team.id),
        }),
      })
      if (!put.ok || (stamps.get(team.id) ?? 0) !== stamp) current.delete(key)
      if (!put.ok)
        services.log.warn("peer_role_update_failed", { teamID: team.id, areaID: area.id, message: put.message })
    },
    stale: async (input) => {
      // 2026-11-14: `directTell` or the peer block changed: every peer (of the area) is written again by `role`.
      stamps.set(input.teamID, (stamps.get(input.teamID) ?? 0) + 1)
      const prefix = input.areaID === undefined ? `${input.teamID}:` : `${input.teamID}:${input.areaID}:`
      for (const key of [...current].filter((item) => item.startsWith(prefix))) current.delete(key)
    },
    add: (input) => add(services, input),
    edit: (input) => edit(services, input),
    remove: (input) => remove(services, input),
    attach: (input) => attach(services, input),
    detach: (input) => detachAll(services, input),
  }
}

/** The area's peers (none on records written before peers). */
export function of(area: Pick<OwnTeam.Area, "peers">): ReadonlyArray<OwnTeam.Peer> {
  return area.peers ?? []
}

/** The peer `name` means: its key, else its label (the main's `team_dispatch{member}` may use either). */
export function find(area: Pick<OwnTeam.Area, "peers">, name: string) {
  const peers = of(area)
  const wanted = label(name).toLowerCase()
  return peers.find((peer) => peer.key === name) ?? peers.find((peer) => peer.label.toLowerCase() === wanted)
}

/** `동료 리뷰어`: how the team update and the tools name a peer. */
export function title(peer: Pick<OwnTeam.Peer, "label">) {
  return `${OwnTeamText.PEER} ${peer.label}`
}

/** The conversation title of a created peer. */
export function sessionTitle(area: Pick<OwnTeam.Area, "name">, peer: Pick<OwnTeam.Peer, "label">) {
  return `${area.name} · ${title(peer)}`
}

// ---------------------------------------------------------------------------------------------------------------
// area.peer.add

async function add(
  services: Services.Context,
  input: Services.PeerAdd,
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView; readonly peer: OwnTeam.Peer }>> {
  const found = await place(services, input)
  if (!found.ok) return found
  if (found.area.state === "broken")
    return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
      areaID: found.area.id,
      why: found.area.broken?.why ?? "identity",
    })
  const wanted = "create" in input ? input.create : input
  const fields = { label: label(wanted.label), role: wanted.role.trim() }
  const valid = check(found.area, fields)
  if (!valid.ok) return valid
  if ("create" in input) return created(services, found.team, found.area, fields)
  return registered(services, found.team, found.area, { ...fields, sessionID: input.sessionID })
}

/** 동료로 등록…: a root conversation of the area's folder, as it is (its model and preset stay the user's). */
async function registered(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  input: { readonly sessionID: SessionID; readonly label: string; readonly role: string },
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView; readonly peer: OwnTeam.Peer }>> {
  const session = await services.http.session.get({ sessionID: input.sessionID, directory: team.home.directory })
  if (!session.ok)
    return session.status === 404
      ? Services.failure("not_found", "대화를 찾을 수 없어요", { what: "session", id: input.sessionID })
      : Services.failure("internal_error", `대화를 읽지 못했어요: ${session.message}`, {})
  if (session.value.parentID !== undefined) return invalid("child")
  const [role, where, areas] = await Promise.all([
    services.locate.session(input.sessionID),
    services.locate.directory(session.value.location.directory),
    services.registry.areas.list(team.id),
  ])
  if (role?.role === "main" || role?.role === "previous-main") return invalid("main")
  if (
    role?.role === "owner" ||
    areas.some((item) => item.state !== "retired" && item.owner.pending === input.sessionID)
  )
    return invalid("owner")
  // Not an owner any more: said as what it is, not as the owner it was. A conversation the user moved the seat off
  // (담당 대화 바꾸기) is a plain conversation of its area again, so it may be a peer: a peer made the owner and
  // moved back would otherwise never be one again. One that 새 대화로 이어가기 ended stays refused.
  if (
    role?.role === "previous-owner" &&
    (role.area.id !== area.id ||
      !role.area.owner.previous.some((item) => item.sessionID === input.sessionID && item.why === "seat"))
  )
    return invalid("previous")
  if (role?.role === "peer") return invalid("peer")
  if (where?.team.id !== team.id || where.area?.id !== area.id) return invalid("elsewhere")
  const other = await Outbox.rival(services, team, area, input.sessionID)
  if (other === undefined)
    return Services.failure("internal_error", "이 대화의 계정을 지금 확인할 수 없어요. 잠시 뒤 다시 하세요", {})
  if (other) return refused(services, session.value.model)
  // Its history before the registration is the user's: the peer's log is followed from here on (3.7's adopted owner).
  const mark = await Adopt.watermark(services, { sessionID: input.sessionID, directory: area.directory })
  if (!mark.ok) return Services.failure("internal_error", `대화 기록을 읽지 못했어요: ${mark.message}`, {})
  return write(
    services,
    team,
    area,
    (current) => ({
      key: key(current, input.label),
      sessionID: input.sessionID,
      label: input.label,
      role: input.role,
      attached: false,
      origin: "registered",
      at: services.clock.now(),
    }),
    mark.seq,
  )
}

/** 동료 추가…: a new conversation in the area's folder, attached from the start. */
async function created(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  input: { readonly label: string; readonly role: string },
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView; readonly peer: OwnTeam.Peer }>> {
  const sessionID = SessionID.create()
  // Written ahead (6.2 step 3's rule): a retry after a crash adopts the session this one makes.
  const recorded = await write(services, team, area, (current) => ({
    key: key(current, input.label),
    sessionID,
    label: input.label,
    role: input.role,
    attached: false,
    origin: "created",
    at: services.clock.now(),
  }))
  if (!recorded.ok) return recorded
  const attached = await attach(services, { teamID: team.id, areaID: area.id, key: recorded.peer.key })
  if (!attached.ok)
    return Services.failure(
      "internal_error",
      `동료 대화를 준비하지 못했습니다: ${attached.message}. 메인이 요청을 보낼 때 다시 준비합니다`,
      {},
    )
  const current = await services.registry.areas.get(team.id, area.id)
  const peer = current ? of(current).find((item) => item.sessionID === sessionID) : undefined
  return { ok: true, area: Areas.view(current ?? recorded.current), peer: peer ?? recorded.peer }
}

/**
 * Adds the peer `make` builds from the area as it is now, in the team's write section (the checks run again there, so
 * two registrations never share a label or a conversation). `seq`: the conversation's log watermark, written first.
 */
async function write(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  make: (current: OwnTeam.Area) => OwnTeam.Peer,
  seq?: number,
): Promise<
  Services.Result<{ readonly area: OwnTeam.AreaView; readonly peer: OwnTeam.Peer; readonly current: OwnTeam.Area }>
> {
  return services.write(team.id, async () => {
    const current = await services.registry.areas.get(team.id, area.id)
    if (!current || current.state === "retired")
      return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: area.id })
    const made = make(current)
    if (of(current).some((item) => item.sessionID === made.sessionID)) return invalid("peer")
    const valid = check(current, made)
    if (!valid.ok) return valid
    if (seq !== undefined) await Cursor.set(services.kv, made.sessionID, seq)
    // The area's direct mark of this very conversation (a former owner, or a conversation of the folder the user
    // wrote in) is the peer's from now on: the owner never shows `사용자가 직접 대화함` for a peer's talk.
    const { direct, ...rest } = current
    const moved = direct?.sessionID === made.sessionID
    const peer: OwnTeam.Peer = moved ? { ...made, direct: { at: direct.at } } : made
    // A conversation that left the seat (담당 대화 바꾸기) is listed as the peer it is now, not as an earlier owner
    // too: the swap drops the entry the same way when such a conversation takes the seat again.
    const previous = current.owner.previous.filter((item) => item.sessionID !== peer.sessionID)
    const next: OwnTeam.Area = {
      ...(moved ? rest : current),
      ...(previous.length === current.owner.previous.length ? {} : { owner: { ...current.owner, previous } }),
      peers: [...of(current), peer],
    }
    await AreaCreate.save(services, next)
    return { ok: true, area: Areas.view(next), peer, current: next }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// area.peer.edit / area.peer.remove

async function edit(
  services: Services.Context,
  input: Parameters<Services.Peers["edit"]>[0],
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView }>> {
  const found = await place(services, input)
  if (!found.ok) return found
  const peer = of(found.area).find((item) => item.key === input.key)
  if (!peer) return gone(input.key)
  const next = {
    ...peer,
    ...(input.label === undefined ? {} : { label: label(input.label) }),
    ...(input.role === undefined ? {} : { role: input.role.trim() }),
  }
  const others = { ...found.area, peers: of(found.area).filter((item) => item.key !== peer.key) }
  const valid = check(others, next, false)
  if (!valid.ok) return valid
  const written = await services.write(found.team.id, async () => {
    const current = await services.registry.areas.get(found.team.id, found.area.id)
    const stored = current ? of(current).find((item) => item.key === peer.key) : undefined
    if (!current || !stored) return undefined
    const changed: OwnTeam.Area = {
      ...current,
      peers: of(current).map((item) =>
        item.key === peer.key ? { ...item, label: next.label, role: next.role } : item,
      ),
    }
    await AreaCreate.save(services, changed)
    return { area: changed, peer: { ...stored, label: next.label, role: next.role } }
  })
  if (!written) return gone(input.key)
  // An attached peer reads its role from the entry: one delta, only when the text changed.
  if (written.peer.attached) {
    const role = await RoleInstructions.put(services, {
      sessionID: written.peer.sessionID,
      directory: found.area.directory,
      key: RoleInstructions.PEER,
      value: RoleInstructions.peer({
        team: found.team,
        area: written.area,
        peer: written.peer,
        blocks: await RoleInstructions.blocks(services.kv, services.log, found.team.id),
      }),
    })
    if (!role.ok) return role
  }
  return { ok: true, area: Areas.view(written.area) }
}

async function remove(
  services: Services.Context,
  input: Parameters<Services.Peers["remove"]>[0],
): Promise<Services.Result<{ readonly area: OwnTeam.AreaView }>> {
  const found = await place(services, input)
  if (!found.ok) return found
  const peer = of(found.area).find((item) => item.key === input.key)
  if (!peer) return gone(input.key)
  if (peer.attached) {
    const detached = await detach(services, found.area, peer)
    if (!detached.ok) return detached
  }
  const written = await services.write(found.team.id, async () => {
    const current = await services.registry.areas.get(found.team.id, found.area.id)
    if (!current) return undefined
    const rest = of(current).filter((item) => item.key !== peer.key)
    const changed: OwnTeam.Area = { ...current, peers: rest.length === 0 ? undefined : rest }
    await AreaCreate.save(services, changed)
    return changed
  })
  if (!written) return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: found.area.id })
  await cancelled(services, found.area, peer)
  return { ok: true, area: Areas.view(written) }
}

/** The main requests that waited for a removed peer are cancelled; a team note tells the main (no wake, 5.6). */
async function cancelled(services: Services.Context, area: OwnTeam.Area, peer: OwnTeam.Peer) {
  const waiting = (await services.registry.dispatches.waiting(area.teamID, area.id)).filter(
    (item) => item.to === peer.key,
  )
  const admit = services.features().admit
  const done = await Promise.all(
    waiting.map(async (item) => ({
      item,
      cancelled: await admit.cancel({ teamID: area.teamID, areaID: area.id, dispatchID: item.id }),
    })),
  )
  const notes = Digest.reorganized({
    skipped: [],
    // Area messages to the peer were cancelled too; the note lists main requests only (an asker gets a notice, 5.8).
    cancelled: done.flatMap((entry) =>
      entry.cancelled.ok && Fold.request(entry.item)
        ? [{ area: `${area.name} ${title(peer)}`, text: entry.item.task ?? entry.item.text }]
        : [],
    ),
  })
  const at = services.clock.now()
  for (const text of [`${area.name}: ${title(peer)}을(를) 동료에서 뺐습니다`, ...notes])
    await services.features().digest.add(area.teamID, Fold.entry({ at, reason: "reorganized", areaID: area.id, text }))
}

// ---------------------------------------------------------------------------------------------------------------
// Attaching and detaching

/**
 * 5.1 step 3 for a peer. A registered one: the owner's allows (`Permissions.write`, then own.accounts'
 * `session.approval.set{mode}` with its mode) and the `own.team.peer.role` entry, nothing else of the conversation (its
 * model, preset and history stay). A created one: its session (adopted when it is there), approval, the area preset
 * with the team context, and the role entry.
 */
export async function attach(
  services: Services.Context,
  input: Parameters<Services.Peers["attach"]>[0],
): Promise<Services.Result> {
  const found = await place(services, input)
  if (!found.ok) return found
  const peer = of(found.area).find((item) => item.key === input.key)
  if (!peer) return gone(input.key)
  if (peer.attached) return { ok: true }
  const area = found.area
  const where = { sessionID: peer.sessionID, directory: area.directory }
  const call = input.signal === undefined ? undefined : { signal: input.signal }
  const value = RoleInstructions.peer({
    team: found.team,
    area,
    peer,
    blocks: await RoleInstructions.blocks(services.kv, services.log, found.team.id),
  })
  if (peer.origin === "created") {
    const model = area.main?.model ?? (await services.features().main.model(found.team.id))
    if (!model) return Services.failure("internal_error", "팀 메인의 모델을 알 수 없어요", {})
    // 2026-10-26: a created peer starts on the 에이전트 방식 of the area's owner conversation.
    const owner = area.owner.sessionID
    const harness =
      owner === null
        ? undefined
        : await MainSession.harnessOf(services, { sessionID: owner, directory: area.directory })
    const opened = await MainSession.open(services, {
      sessionID: peer.sessionID,
      directory: area.directory,
      model,
      title: sessionTitle(area, peer),
      meta: { role: "peer", teamID: found.team.id, areaID: area.id },
      ...(harness === undefined ? {} : { harness }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (!opened.ok) return opened
    const prepared = await MainSession.prepare(services, {
      teamID: found.team.id,
      // The gate judges a peer like the owner of its area (07 §5.4).
      role: "owner",
      sessionID: peer.sessionID,
      directory: area.directory,
      model: opened.model,
      approval: MainSession.APPROVAL,
      presetID: area.preset,
      entries: [{ key: RoleInstructions.PEER, value }],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (!prepared.ok) return prepared
    return mark(services, area, peer, true)
  }
  const session = await services.http.session.get(where, call)
  if (!session.ok)
    return session.status === 404
      ? Services.failure("not_found", "동료 대화를 찾을 수 없어요", { what: "session", id: peer.sessionID })
      : Services.failure("internal_error", `동료 대화를 읽지 못했어요: ${session.message}`, {})
  const allowed = await Permissions.write(services, { ...where, role: "owner" })
  if (!allowed.ok) return allowed
  const role = await RoleInstructions.put(services, {
    ...where,
    key: RoleInstructions.PEER,
    value,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!role.ok) return role
  return mark(services, area, peer, true)
}

/** Every attached peer of the area loses what {@link attach} gave it; the records stay (팀에서 빼기, 끄기, 되돌리기). */
export async function detachAll(
  services: Services.Context,
  input: Parameters<Services.Peers["detach"]>[0],
): Promise<Services.Result> {
  const area = await services.registry.areas.get(input.teamID, input.areaID)
  if (!area) return { ok: true }
  const results = await Promise.all(
    of(area)
      .filter((peer) => peer.attached)
      .map((peer) => detach(services, area, peer, input.signal)),
  )
  return results.find((result) => !result.ok) ?? { ok: true }
}

/**
 * One peer: the team allows (only when the session has them), the role entry (only when it is there) and, for a
 * created peer, its binding's team context; then `attached: false`. A conversation that is gone has nothing to lose.
 */
async function detach(
  services: Services.Context,
  area: OwnTeam.Area,
  peer: OwnTeam.Peer,
  signal?: AbortSignal,
): Promise<Services.Result> {
  const where = { sessionID: peer.sessionID, directory: area.directory }
  const instance = services.instance(area.directory)
  if (!instance) return Services.failure("internal_error", "이 폴더의 팀 서비스가 아직 준비되지 않았어요", {})
  const session = await instance.ctx.session.get({ sessionID: peer.sessionID }).catch(() => undefined)
  if (!session) return mark(services, area, peer, false)
  const actions: ReadonlySet<string> = new Set(Object.values(Permissions.ACTIONS))
  if ((session.permissions ?? []).some((rule) => actions.has(rule.action))) {
    const written = await Permissions.write(services, { ...where, role: null })
    if (!written.ok) return written
  }
  const call = signal === undefined ? undefined : { signal }
  const entries = await services.http.instructions.list(where, call)
  if (!entries.ok) return Services.failure("internal_error", `대화의 지시 항목을 읽지 못했어요: ${entries.message}`, {})
  if (entries.value.some((entry) => entry.key === RoleInstructions.PEER)) {
    const removed = await services.http.instructions.remove({ ...where, key: RoleInstructions.PEER }, call)
    if (!removed.ok) return Services.failure("internal_error", `동료 역할을 떼지 못했어요: ${removed.message}`, {})
  }
  if (peer.origin === "created") {
    const view = await services.accounts.presetGet({ sessionID: peer.sessionID }, { directory: area.directory })
    const preset = view.ok ? view.value.preset : null
    if (view.ok && view.value.binding?.team !== undefined && preset) {
      const cleared = await services.accounts.presetApply(
        { sessionID: peer.sessionID, presetID: preset.id, team: null },
        { directory: area.directory },
      )
      if (!cleared.ok) services.log.warn("peer_team_context_kept", { sessionID: peer.sessionID, type: cleared.type })
    }
  }
  return mark(services, area, peer, false)
}

/** Writes `attached` of the peer (the same conversation only). */
async function mark(
  services: Services.Context,
  area: OwnTeam.Area,
  peer: OwnTeam.Peer,
  attached: boolean,
): Promise<Services.Result> {
  await services.write(area.teamID, async () => {
    const current = await services.registry.areas.get(area.teamID, area.id)
    const stored = current ? of(current).find((item) => item.key === peer.key) : undefined
    if (!current || stored?.sessionID !== peer.sessionID || stored.attached === attached) return
    await AreaCreate.save(services, {
      ...current,
      peers: of(current).map((item) => (item.key === peer.key ? { ...item, attached } : item)),
    })
  })
  return { ok: true }
}

/**
 * Drops `sessionID` from every area's peers but `except` (대화 옮기기: a peer conversation moved into another area's
 * folder is no peer there; nothing of the session is written, the registry then refuses its team tools).
 */
export async function drop(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly sessionID: string; readonly except?: OwnTeam.AreaID },
) {
  await services.write(input.teamID, async () => {
    const areas = await services.registry.areas.list(input.teamID)
    for (const area of areas) {
      if (area.id === input.except || !of(area).some((peer) => peer.sessionID === input.sessionID)) continue
      const rest = of(area).filter((peer) => peer.sessionID !== input.sessionID)
      await AreaCreate.save(services, { ...area, peers: rest.length === 0 ? undefined : rest })
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

/** The team (on) and the area (not retired) of a peer method. */
async function place(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID },
): Promise<Services.Result<{ readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired" || area.state === "retiring")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  return { ok: true, team, area }
}

/**
 * Label taken by another peer of the area, role text over 1,024 characters (as the wire counts), or the area's peer
 * limit (`limit` when `adding`).
 */
function check(
  area: Pick<OwnTeam.Area, "peers">,
  peer: { readonly label: string; readonly role: string },
  adding = true,
): Services.Result {
  if (peer.label === "" || peer.label.length > OwnTeam.PEER_LABEL_MAX) return invalid("label")
  if (peer.role.length > OwnTeam.PEER_ROLE_MAX) return invalid("role")
  const taken = of(area).some((item) => item.label.toLowerCase() === peer.label.toLowerCase())
  if (taken) return invalid("label")
  if (adding && of(area).length >= OwnTeam.PEER_MAX) return invalid("limit")
  return { ok: true }
}

/**
 * A key unique in the area from the label's ASCII letters and digits (`리뷰어` has none: `peer`, `peer-2`, …; the
 * slug rule of new areas, 9.4).
 */
function key(area: Pick<OwnTeam.Area, "peers">, text: string) {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "peer"
  const taken = new Set(of(area).map((peer) => peer.key))
  const free = (index: number): string => {
    const candidate = index === 1 ? base : `${base}-${index}`
    return taken.has(candidate) ? free(index + 1) : candidate
  }
  return free(1)
}

/** One line, outer spaces trimmed. */
function label(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

type Why = (typeof OwnTeam.errors)["peer_invalid"]["Type"]["why"]

function invalid(why: Why) {
  return Services.failure("peer_invalid", PEER_INVALID[why], { why })
}

function gone(key: string) {
  return Services.failure("not_found", "그런 동료가 없어요", { what: "session", id: key })
}

/** A registered conversation on another subscription of the team main's company (10.1 R4): its account, if known. */
async function refused(services: Services.Context, model: Model.Ref | undefined) {
  const listed = await services.accounts.accountsList()
  const account =
    listed.ok && model ? listed.value.accounts.find((item) => item.providerID === model.providerID) : undefined
  if (account) return Services.failure("same_company_subscription", RIVAL, { accountID: account.id })
  return Services.failure("internal_error", "이 대화의 계정을 확인할 수 없어요. 모델을 고른 뒤 다시 등록하세요", {})
}

export const RIVAL = "이 대화는 팀 메인과 같은 회사의 다른 구독 계정을 씁니다. 동료로 쓰려면 그 대화의 계정을 바꾸세요"

const PEER_INVALID: Readonly<Record<Why, string>> = {
  child: "하위 대화는 동료로 등록하지 않습니다",
  main: "팀 메인은 동료가 될 수 없습니다",
  owner: "영역 담당 대화는 동료가 될 수 없습니다",
  previous: "전에 담당이던 대화는 동료로 등록할 수 없습니다",
  peer: "이미 동료로 등록된 대화입니다",
  elsewhere: "이 영역의 폴더에 있는 대화만 동료로 등록할 수 있습니다",
  label: "이름이 비었거나 이 영역의 다른 동료와 같습니다",
  role: "역할은 1,024자 이하로 적으세요",
  limit: `한 영역의 동료는 ${OwnTeam.PEER_MAX}개까지입니다`,
}

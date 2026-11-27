export * as SafePoint from "./safe-point.js"

import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Identity } from "../git/identity.js"
import type { SessionHttp } from "./http.js"
import type { Services } from "../services.js"

/**
 * Safe points (06 §8.4): nobody works in an area folder (or the home). Every root session placed in the folder by the
 * longest path prefix (owner, owner being created, previous owners, conversations the user opened) and their children
 * count. Checks that never wake a Location come first, in this order: `session.active`, the owner's inbox (the main's
 * for the home), pending permission requests, other own work on the folder, a git operation in progress. The queues
 * are read before `session.active` (RH-20): input leaves a queue only when a running drain takes it, so a session that
 * is not active after its queue was read holds only parked input there, and input woken between the two reads finds
 * its session active. Forms and running shells, and for the extended safe point (release, cone set, convert, move,
 * remove) ptys, are read only when that folder's Location is already alive: a Location that is not up has none, and
 * asking would start it (5.5). A shell or a pty that holds the folder outlived the run that started it (a dev server,
 * a watcher, a terminal): the answer names it (`shells`, RH-20), and `stop` ends it when the user asks.
 * Main 멈춤 is not part of it (TI-13 is a separate rule).
 *
 * Ops run one per team (`busy`), so the op that asks is the only one: "other own work" is work outside ops, a main
 * request being prepared and sent (`during`). Any answer the service cannot give counts as "not safe".
 */

/** Root sessions of the folder read for permission requests and forms, newest first (older ones hold none). */
const RECENT = 20

/**
 * How long queued input of a session counts as work without a run. Input admitted with a wake starts its run as it is
 * admitted (core `SessionRunCoordinator.wake` registers the execution in the same step), so input still waiting in the
 * queue of a session that is not running this long after its admission came without one (`resume: false`: own.harness'
 * notice of a harness switch, the result of the user's shell command) and waits for the next prompt (RH-15). A wait
 * for such input never ends: what would deliver it is the request or the handoff that waits for this safe point.
 */
export const WAKE_MS = 10_000

/** Git dir entries of an operation that stopped half way (06 §3.2). */
const OPERATIONS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_START"]

export function create(services: Services.Context): Services.SafePoint {
  return { check: (input) => check(services, input) }
}

/** Own work on a folder outside ops, per controller: `teamID` or `teamID:areaID` keys. */
const working = new WeakMap<object, Set<string>>()

/** Runs `run` as own work on the folder of `areaID` (the home when absent): its safe point answers `own` meanwhile. */
export async function during<T>(
  services: Services.Base,
  folder: { readonly teamID: string; readonly areaID?: string },
  run: () => Promise<T>,
): Promise<T> {
  const set = working.get(services) ?? new Set<string>()
  working.set(services, set)
  const key = keyOf(folder)
  set.add(key)
  return run().finally(() => set.delete(key))
}

/**
 * Sessions in `session.active` placed in the folder of `areaID` (the home when absent) by the longest path prefix
 * (`Locate.directory`); `undefined` when the service could not tell. Neither call wakes a Location.
 */
export async function active(
  services: Services.Base,
  team: OwnTeam.Team,
  areaID: string | undefined,
  call?: SessionHttp.Call,
): Promise<ReadonlyArray<SessionID> | undefined> {
  const ids = await services.http.session.active(call)
  if (!ids.ok) return undefined
  const placed = await Promise.all(
    [...ids.value].map(async (id) => {
      const session = await services.http.session.get({ sessionID: id, directory: team.home.directory }, call)
      if (!session.ok) return gone(session) === false ? null : undefined
      const place = await services.locate.directory(session.value.location.directory)
      return place?.team.id === team.id && place.area?.id === areaID ? SessionID.make(id) : null
    }),
  )
  if (placed.includes(undefined)) return undefined
  return placed.filter((id): id is SessionID => typeof id === "string")
}

async function check(
  services: Services.Context,
  input: Parameters<Services.SafePoint["check"]>[0],
): Promise<Services.Safe> {
  const team = await services.registry.teams.get(input.teamID)
  const area = input.areaID === undefined ? undefined : await services.registry.areas.get(input.teamID, input.areaID)
  if (!team || (input.areaID !== undefined && !area)) return unsafe("own")
  const folder = area?.directory ?? team.home.directory
  const call = input.signal ? { signal: input.signal } : undefined

  // An area peer's queue counts like the owner's (동료): a main request there is the folder's next run.
  const peers = (area?.peers ?? []).map((peer) => peer.sessionID)
  const inboxes = input.parked
    ? []
    : area
      ? [...new Set(present([area.owner.sessionID, area.owner.pending, ...peers, ...(input.also ?? [])]))]
      : [team.main.sessionID]
  // The queues first, then `session.active` (RH-20, see above).
  const lists = await Promise.all(
    inboxes.map((sessionID) => services.http.inbox.list({ sessionID, directory: folder }, call)),
  )
  const now = services.clock.now()
  const busy = await active(services, team, input.areaID, call)
  if (busy === undefined || busy.length > 0) return unsafe("session", busy)
  const queued = await blocking(inboxes, async (sessionID) => {
    const listed = lists[inboxes.indexOf(sessionID)]
    if (!listed) return undefined
    return listed.ok ? listed.value.some((item) => runs(item, now)) : gone(listed)
  })
  if (queued) return unsafe("inbox", queued)

  const roots = await services.http.session.list(
    { directory: folder, parentID: null, order: "desc", limit: RECENT },
    call,
  )
  if (!roots.ok) return unsafe("permission")
  const known = area
    ? [area.owner.sessionID, area.owner.pending, ...area.owner.previous.map((item) => item.sessionID), ...peers]
    : [team.main.sessionID, ...team.main.previous]
  const sessions = [...new Set([...present(known), ...roots.value.data.map((session) => SessionID.make(session.id))])]
  const asking = await blocking(sessions, async (sessionID) => {
    const listed = await services.http.permission.list({ sessionID, directory: folder }, call)
    return listed.ok ? listed.value.length > 0 : gone(listed)
  })
  if (asking) return unsafe("permission", asking)

  if (working.get(services)?.has(keyOf(input))) return unsafe("own")
  if (!(await gitIdle(area?.gitDir ?? folder, area === undefined))) return unsafe("git")

  const live = services.instance(folder)
  if (!live || !Identity.same(live.directory, folder)) return { ok: true }

  const forms = await blocking(sessions, async (sessionID) => {
    const listed = await services.http.form.list({ sessionID, directory: folder }, call)
    return listed.ok ? listed.value.length > 0 : gone(listed)
  })
  if (forms) return unsafe("form", forms)

  const shells = await services.http.shell.list({ directory: folder }, call)
  if (!shells.ok) return unsafe("shell")
  const running = shells.value.filter((shell) => shell.status === "running")
  if (running.length > 0) {
    // The shell tool tags its shells with the session that started them.
    const holding = running.map((shell): Services.Holding => {
      const id = shell.metadata?.sessionID
      const sessionID = typeof id === "string" && id.startsWith("ses") ? SessionID.make(id) : undefined
      return {
        id: shell.id,
        command: shell.command ?? "",
        kind: "shell",
        directory: folder,
        ...(sessionID ? { sessionID } : {}),
      }
    })
    return unsafe("shell", present(holding.map((item) => item.sessionID)), holding)
  }

  if (!input.extended) return { ok: true }
  const ptys = await services.http.pty.list({ directory: folder }, call)
  if (!ptys.ok) return unsafe("pty")
  const terminals = ptys.value.filter((pty) => pty.status === "running")
  if (terminals.length > 0)
    return unsafe(
      "pty",
      [],
      terminals.map((pty) => ({
        id: pty.id,
        command: pty.command ?? pty.title ?? "",
        kind: "pty" as const,
        directory: folder,
      })),
    )
  return { ok: true }
}

/**
 * 명령 멈추고 진행 (RH-20): ends the commands and closes the terminals a safe point named (`Safe.shells`), each in its
 * folder's Location (`fallback` for one that does not name it). The number it ended; one already gone counts as ended.
 */
export async function stop(services: Services.Base, fallback: string, shells: ReadonlyArray<Services.Holding>) {
  const ended = await Promise.all(
    shells.map(async (shell) => {
      const directory = shell.directory ?? fallback
      const removed =
        shell.kind === "pty"
          ? await services.http.pty.remove({ directory, id: shell.id })
          : await services.http.shell.remove({ directory, id: shell.id })
      if (!removed.ok && removed.status !== 404)
        services.log.warn("safe_point_stop_failed", { directory, id: shell.id, kind: shell.kind, type: removed.type })
      return removed.ok || removed.status === 404
    }),
  )
  const count = ended.filter(Boolean).length
  services.log.info("safe_point_stopped", { directory: fallback, count, asked: shells.length })
  return count
}

/**
 * Whether a queued item of a session that is not running is work that starts a run (8.4). A context reset is not: it
 * delivers without a model call (06 §6.1). Nor is a passive notice (`beforeReset`, core P-035) or input older than
 * {@link WAKE_MS}: both start no turn and ride with the next input. An item without its admission time counts.
 */
export function runs(item: SessionHttp.InboxView, now: number) {
  if (item.type === "reset" || item.payload.beforeReset) return false
  if (item.time === undefined) return true
  // Outside [0, WAKE_MS) is parked (RH-20): a wall clock stepped back after the admission must not make a parked
  // notice work until it catches up; the queues are read before `session.active`, so a young item that was woken
  // shows its session active anyway.
  const age = now - item.time.created
  return age >= 0 && age < WAKE_MS
}

/**
 * Input in a queue that is the user's or the team's work, not a notice (RH-20): what the user typed (`type: user`), a
 * main request, an area message or a notice of the team (`own.dispatch`), or an own.team request (`own.team.request`).
 * A rotation that passes a safe point with such input parked in the old owner's queue hands over by the program: a
 * warm handoff turn would run that input first, in a conversation about to be replaced (6.2: it stays there). A
 * request of the op that asks (`opID`: its own handoff request sent before a restart) is not.
 */
export function work(item: SessionHttp.InboxView, opID?: string) {
  const metadata = item.payload.metadata
  const request = metadata?.[OwnTeam.REQUEST_META]
  if (opID !== undefined && Option.getOrUndefined(decodeRequest(request))?.opID === opID) return false
  return item.type === "user" || metadata?.[OwnTeam.DISPATCH_META] !== undefined || request !== undefined
}

const decodeRequest = Schema.decodeUnknownOption(Schema.Struct({ opID: Schema.String }))

function unsafe(
  why: Services.SafeWhy,
  sessionIDs: ReadonlyArray<SessionID> = [],
  shells?: ReadonlyArray<Services.Holding>,
): Services.Safe {
  return { ok: false, why, sessionIDs, ...(shells === undefined ? {} : { shells }) }
}

function keyOf(folder: { readonly teamID: string; readonly areaID?: string }) {
  return folder.areaID === undefined ? folder.teamID : `${folder.teamID}:${folder.areaID}`
}

function present<T>(values: ReadonlyArray<T | null | undefined>) {
  return values.filter((value): value is T => value !== null && value !== undefined)
}

/** A removed session (404) holds nothing; any other failure is an answer the service could not give. */
function gone(failure: { readonly status: number | null }) {
  return failure.status === 404 ? false : undefined
}

/** The sessions for which `test` holds; an answer the service could not give blocks with no ids (fail closed). */
async function blocking(
  sessionIDs: ReadonlyArray<SessionID>,
  test: (sessionID: SessionID) => Promise<boolean | undefined>,
): Promise<ReadonlyArray<SessionID> | undefined> {
  const answers = await Promise.all(sessionIDs.map(test))
  if (answers.includes(undefined)) return []
  const found = sessionIDs.filter((_, index) => answers[index])
  return found.length > 0 ? found : undefined
}

/** No rebase, merge, cherry-pick, revert or bisect stopped half way in the worktree (06 §3.2). */
async function gitIdle(location: string, observe: boolean) {
  const gitDir = observe
    ? await Identity.observe(location).then((found) => (found.ok ? found.gitDir : undefined))
    : location
  if (gitDir === undefined) return false
  return !OPERATIONS.some((name) => fs.existsSync(path.join(gitDir, name)))
}

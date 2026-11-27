// OS notification hook point for requests (03 §9 "권한·질문 필요" and "하위 에이전트의 권한 요청"): the host sends it
// (`host.notify`, `capabilities.osNotifications`: HTML5 Notification on web and desktop, Web Push later). Only when
// the window is hidden or unfocused — the dock and the sidebar `?` already show it otherwise — and at most once per
// session and kind within 10 s (05 §7.4). Clicking opens the top session of the tree, whose dock shows the request.
// No timers (PF8): merging compares timestamps.
// Team mode (06 §9.4, §10.1): the requests of a team's conversations (the team main, its owners and their subagents)
// merge into one notification per team, and its click also opens the team view, whose `허락 기다리는 것 n개` answers
// them in one place. `describeRequest` names a request there too. A team step that waits for the user's confirm
// (06 §9.7: a large download, `반영하기 전에 묻기`) joins the same per-team notification, in the service's words; its
// click opens the team main, whose card holds the confirm (a gateway device sees it there as view-only).
import type { FormInfo, PermissionRequest } from "@opencode/client"
import { createEffect, onCleanup } from "solid-js"
import type { DataLayer, ServerKey, ServerRuntime, TeamStore } from "@/data"
import type { TeamEvent } from "@/data/team-rpc"
import type { HostNotification, OsNotifications } from "@/host/types"
import { openTeamView } from "@/team/intents"
import { actionKind, formFlavor, mcpInfo } from "./describe"
import { GLOBAL_FORMS } from "./model"
import type { RequestsText } from "./strings"

export const MERGE_MS = 10_000

export function shouldNotify(input: {
  readonly capability: OsNotifications
  readonly available: boolean
  readonly hidden: boolean
  readonly focused: boolean
}) {
  return input.capability !== "none" && input.available && (input.hidden || !input.focused)
}

/** `true` when a notification for `key` may go out now; later ones within `windowMs` merge into it. */
export function createMerger(windowMs = MERGE_MS, now: () => number = Date.now) {
  const last = new Map<string, number>()
  return (key: string) => {
    const at = now()
    const previous = last.get(key)
    if (previous !== undefined && at - previous < windowMs) return false
    last.set(key, at)
    for (const [other, time] of last) if (at - time >= windowMs) last.delete(other)
    return true
  }
}

/** What the request is about, for the notification body. */
export function describeRequest(
  text: RequestsText,
  request: { readonly permission: Pick<PermissionRequest, "action"> } | { readonly form: Pick<FormInfo, "metadata"> },
) {
  if ("permission" in request) {
    const kind = actionKind(request.permission.action)
    return kind === "other"
      ? text("own.requests.noun.other", { action: request.permission.action })
      : text(`own.requests.noun.${kind}`)
  }
  const flavor = formFlavor(request.form)
  if (flavor === "websearch") return text("own.requests.noun.websearch")
  if (flavor === "mcp") return text("own.requests.form.mcp", { server: mcpInfo(request.form).server })
  return text("own.requests.form.question")
}

export interface NotifierInput {
  readonly data: DataLayer
  readonly capability: OsNotifications
  readonly notify?: (input: HostNotification) => void
  readonly focused: () => boolean
  readonly text: RequestsText
  readonly open: (serverKey: ServerKey, sessionID: string) => void
}

export function createRequestNotifier(input: NotifierInput) {
  const merge = createMerger()
  const allowed = () =>
    shouldNotify({
      capability: input.capability,
      available: input.notify !== undefined,
      hidden: document.visibilityState === "hidden",
      focused: input.focused(),
    })

  async function send(serverKey: ServerKey, runtime: ServerRuntime, sessionID: string, what: () => string) {
    if (!allowed() || !input.notify) return
    if (sessionID === GLOBAL_FORMS) {
      if (!merge(`${serverKey}:global`)) return
      return input.notify({
        title: input.text("own.requests.notify.title"),
        body: what(),
        tag: `own:approval:${serverKey}`,
      })
    }
    const session = runtime.data.session
    if (!session.get(sessionID)) await session.sync(sessionID).catch(() => undefined)
    const parentOf = (id: string) => session.get(id)?.parentID
    let root = rootOf(sessionID, parentOf)
    // Unknown ancestors load one level at a time (subagents of subagents); a failed read keeps the last known one.
    while (!session.get(root)) {
      await session.sync(root).catch(() => undefined)
      const next = session.get(root) ? rootOf(root, parentOf) : root
      if (next === root) break
      root = next
    }
    const team = teamOf(runtime.team, root)
    const group = team ? `team:${team.teamID}` : root
    if (!merge(`${serverKey}:${group}`)) return
    const title =
      session.get(root)?.title ?? runtime.sessions.state.sessions[root]?.title ?? session.get(sessionID)?.title ?? root
    input.notify({
      title: input.text(root === sessionID ? "own.requests.notify.title" : "own.requests.notify.child"),
      body: input.text("own.requests.notify.body", { session: title, what: what() }),
      tag: `own:approval:${serverKey}:${group}`,
      onClick: () => {
        input.open(serverKey, root)
        if (team) openTeamView({ serverKey, projectID: team.projectID })
      },
    })
  }

  /** A team step waits for the user's confirm: one notification per team with its requests, opening the team main. */
  function confirming(serverKey: ServerKey, runtime: ServerRuntime, confirm: TeamEvent<"op.confirm">["data"]) {
    if (!allowed() || !input.notify) return
    if (!merge(`${serverKey}:team:${confirm.teamID}`)) return
    const main = runtime.team.team(confirm.teamID)?.team.main.sessionID
    const title = main
      ? (runtime.data.session.get(main)?.title ?? runtime.sessions.state.sessions[main]?.title)
      : undefined
    input.notify({
      title: input.text("own.requests.notify.title"),
      body: title ? input.text("own.requests.notify.body", { session: title, what: confirm.text }) : confirm.text,
      tag: `own:approval:${serverKey}:team:${confirm.teamID}`,
      onClick: main ? () => input.open(serverKey, main) : undefined,
    })
  }

  createEffect(() => {
    if (input.capability === "none" || !input.notify) return
    for (const entry of input.data.servers.list()) {
      const runtime = input.data.get(entry.key)
      if (!runtime) continue
      onCleanup(
        runtime.bus.on("permission.asked", (event) => {
          void send(entry.key, runtime, event.data.sessionID, () =>
            describeRequest(input.text, { permission: event.data }),
          )
        }),
      )
      onCleanup(
        runtime.bus.on("form.created", (event) => {
          const form = event.data.form
          void send(entry.key, runtime, form.sessionID, () => describeRequest(input.text, { form }))
        }),
      )
      onCleanup(runtime.team.on("op.confirm", (event) => confirming(entry.key, runtime, event.data)))
    }
  })
}

/**
 * The team a root conversation works for (06 §9.4): the current team main or an area's current owner, as the registry
 * knows them (a metadata hint or an earlier conversation is not the team's). Its requests merge per team.
 */
export function teamOf(team: Pick<TeamStore, "placeOf" | "team">, rootID: string) {
  const place = team.placeOf(rootID)
  const entry = place && !place.hint && !place.previous ? team.team(place.teamID) : undefined
  return entry ? { teamID: entry.team.id, projectID: entry.team.projectID } : undefined
}

/** The top known ancestor: a subagent's request opens the parent session, whose dock shows it (03 §18.1). */
export function rootOf(sessionID: string, parentOf: (sessionID: string) => string | undefined) {
  const seen = new Set<string>()
  let id = sessionID
  for (let parent = parentOf(id); parent && !seen.has(parent); parent = parentOf(id)) {
    seen.add(id)
    id = parent
  }
  return id
}

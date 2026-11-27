export * as Wake from "./wake.js"

import { OwnTeam } from "@own/protocol"
import { MsgID } from "../dispatch/msg-id.js"
import { Talk } from "../dispatch/talk.js"
import type { Services } from "../services.js"
import { Digest } from "./digest.js"
import { Fold } from "./fold.js"

/**
 * Waking the main (06 §5.6): a team update is a `session.synthetic` in the main session (`delivery: "queue"`, so it
 * comes after the user's turn and starts an idle main) with id `MsgID.of(teamID, "wake", seq)`, metadata
 * `own.team.update {seq, reasons}` and `source: "own.team"`. Waking entries are debounced 30 s; nothing new goes in
 * while an update is undelivered in the main inbox (`session.inbox.list`), and its `delivered` event lets the next one
 * go; past 12 an hour updates wait for the window and the user is told once. The send is write-ahead (`pending` with
 * its id), so a restart sends the same message again and core keeps the first admission. Timers are not state: they
 * are computed again from KV `digest` whenever the controller resumes (06 §2.6 (c)). A team update that went in wakes
 * the main, so the team's waiting integration is tried again then (06 §7.2 기다림과 다시 시도).
 */

export function create(services: Services.Context): Services.Wake {
  const log = services.log.child("wake")
  const timers = new Map<string, () => void>()
  const state = { closed: false }

  const arm = (teamID: OwnTeam.TeamID, at: number | undefined) => {
    timers.get(teamID)?.()
    timers.delete(teamID)
    if (at === undefined || state.closed) return
    timers.set(
      teamID,
      services.clock.schedule(at - services.clock.now(), () => {
        timers.delete(teamID)
        void send(services, teamID)
          .then((sent) => {
            if (sent.woke)
              void services
                .features()
                .integrate.retry(teamID)
                .catch((error: unknown) => log.warn("integrate_retry_failed", { teamID, error }))
            return sent.again === undefined ? plan(teamID) : arm(teamID, sent.again)
          })
          .catch((error: unknown) => {
            log.warn("wake_failed", { teamID, error })
            arm(teamID, services.clock.now() + Fold.RETRY_MS)
          })
      }),
    )
  }

  /** Arms the team's timer from the stored digest (or clears it when nothing waits or the team is off). */
  const plan = async (teamID: OwnTeam.TeamID) => {
    const team = await services.registry.teams.get(teamID)
    if (!team || team.state !== "on") return arm(teamID, undefined)
    arm(teamID, Fold.due(await Digest.load(services.kv, teamID)))
  }

  return {
    request: (teamID) => {
      void plan(teamID).catch((error: unknown) => log.warn("wake_plan_failed", { teamID, error }))
    },
    resume: async () => {
      const teams = await services.registry.teams.list()
      await Promise.all(teams.filter((team) => team.state === "on").map((team) => plan(team.id)))
    },
    close: async () => {
      state.closed = true
      for (const cancel of timers.values()) cancel()
      timers.clear()
    },
  }
}

/**
 * Sends the team update when it is due, in the team's write section. `again`: when to look again (absent: plan from the
 * stored digest); `woke`: the update went into the main inbox.
 */
async function send(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
): Promise<{ readonly again?: number; readonly woke: boolean }> {
  return services.write(teamID, async () => {
    const team = await services.registry.teams.get(teamID)
    if (!team || team.state !== "on") return { woke: false }
    const now = services.clock.now()
    const stored = await Digest.load(services.kv, teamID)
    const at = Fold.due(stored)
    if (at === undefined) return { woke: false }
    if (at > now) return { again: at, woke: false }
    const main = { sessionID: team.main.sessionID, directory: team.home.directory }
    const inbox = await services.http.inbox.list(main)
    if (!inbox.ok) {
      services.log.warn("wake_inbox_failed", { teamID, type: inbox.type, message: inbox.message })
      return { again: now + Fold.RETRY_MS, woke: false }
    }
    const undelivered = inbox.value
      .filter((item) => item.payload.metadata?.[OwnTeam.UPDATE_META] !== undefined)
      .map((item) => item.id)
    const looked = Fold.inbox(stored, { sessionID: main.sessionID, undelivered, now })
    if (looked.state !== stored) await Digest.save(services.kv, looked.state)
    // Ours still undelivered: `checked` was written, so the plan looks again after CHECK_MS; someone else's: look then.
    if (looked.wait) return looked.state.pending ? { woke: false } : { again: now + Fold.CHECK_MS, woke: false }
    const until = Fold.limit(looked.state.sent, now)
    if (until !== undefined) {
      if (looked.state.limited?.until !== until) {
        await Digest.save(services.kv, { ...looked.state, limited: { until } })
        services.log.info("wake_limited", { teamID, until })
        services.notices.publish({
          teamID,
          kind: "wake.limited",
          text: `팀 소식이 한 시간에 ${Fold.PER_HOUR}번을 넘어 ${Talk.clock(until)}까지 모아 둬요. 메인은 team_status로 지금 소식을 볼 수 있어요.`,
          data: { until },
        })
      }
      return { again: until, woke: false }
    }
    const retry = looked.retry
    const seq = retry ? retry.seq : looked.state.seq + 1
    const reasons = Fold.reasons(looked.state)
    const upTo = Math.max(retry?.upTo ?? -1, ...looked.state.entries.map((item) => item.n))
    const pending: Fold.Pending = {
      seq,
      msgID: retry ? retry.msgID : MsgID.of(teamID, "wake", seq),
      sessionID: main.sessionID,
      at: now,
      sent: false,
      upTo,
    }
    const ahead = { ...looked.state, seq, pending }
    await Digest.save(services.kv, ahead)
    // The audit lines of area messages it carries (06 §5.8) are marked told once it went in.
    const talk = Talk.last(await Talk.load(services.kv, teamID))
    const text = await Digest.update(services, { team, state: ahead, seq, reasons, talk })
    const sent = await services.http.session.synthetic({
      ...main,
      id: pending.msgID,
      text,
      metadata: { [OwnTeam.UPDATE_META]: { seq, reasons }, source: OwnTeam.PROMPT_SOURCE },
      delivery: "queue",
    })
    if (!sent.ok) {
      services.log.warn("wake_send_failed", { teamID, seq, type: sent.type, message: sent.message })
      return { again: now + Fold.RETRY_MS, woke: false }
    }
    await Digest.save(
      services.kv,
      Fold.told(
        { ...ahead, pending: { ...pending, sent: true }, sent: [...Fold.recent(ahead.sent, now), now], limited: null },
        upTo,
      ),
    )
    const lines = await Talk.load(services.kv, teamID)
    if (talk > lines.told) await Talk.save(services.kv, teamID, Talk.told(lines, talk))
    services.log.info("wake_sent", { teamID, seq, reasons })
    return { woke: true }
  })
}

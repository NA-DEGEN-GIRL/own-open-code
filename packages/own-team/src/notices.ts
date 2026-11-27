export * as Notices from "./notices.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import type { Hub } from "./hub.js"
import type { Log } from "./log.js"
import { Keys } from "./registry/keys.js"

/**
 * Plain-language notices for the team view and the phone feed (`rpc.own.team.notice`, 06 §2.7): `account.waiting`,
 * `paths.added`, `rotation.done`, `area.broken`, … `text` is the Korean line own-web shows when it has no wording of
 * its own; `data` carries the values a client words the notice with.
 *
 * Notices about a state that lasts (a `preset.repair` until the preset is fixed, `account.waiting` while its move
 * waits) are also kept open in KV `notices:<teamID>` ({@link Publisher.keep}), which `team.get` answers, so a window
 * opened later, or after a restart, still shows them; an event alone reaches only the windows open at the time.
 */
export interface Notice {
  readonly teamID: OwnTeam.TeamID
  readonly areaID?: OwnTeam.AreaID
  readonly kind: OwnTeam.NoticeKind
  readonly text: string
  readonly data?: Readonly<Record<string, string | number | boolean>>
}

export interface Publisher {
  publish(notice: Notice): void
  /** The team's open notices, oldest first (`team.get` `notices`). */
  open(teamID: OwnTeam.TeamID): Promise<ReadonlyArray<OwnTeam.OpenNotice>>
  /**
   * Keeps exactly `open` as the team's open notices of `kind`, each with an `id` that stays while it is open; one
   * already open keeps its `at`. Written in the team's mutex, only on a change; nothing is published.
   */
  keep(teamID: OwnTeam.TeamID, kind: OwnTeam.NoticeKind, open: ReadonlyArray<OwnTeam.OpenNotice>): Promise<void>
}

export interface Store {
  readonly kv: Keys.Store
  /** The team's mutex (`Services.Base.write`). */
  readonly write: <T>(teamID: string, section: () => Promise<T>) => Promise<T>
}

const decode = Schema.decodeUnknownOption(Schema.Array(OwnTeam.OpenNotice))
const encode = Schema.encodeSync(Schema.Array(OwnTeam.OpenNotice))

export function create(hub: Hub.Bus, log: Log.Logger, store: Store): Publisher {
  const read = async (teamID: string) =>
    Option.getOrElse(decode(await store.kv.get(Keys.notices(teamID))), () => [] as ReadonlyArray<OwnTeam.OpenNotice>)
  return {
    publish: (notice) => {
      log.info("notice", { teamID: notice.teamID, areaID: notice.areaID, kind: notice.kind })
      hub.publish({
        name: "notice",
        data: {
          teamID: notice.teamID,
          kind: notice.kind,
          text: notice.text,
          ...(notice.areaID === undefined ? {} : { areaID: notice.areaID }),
          ...(notice.data === undefined ? {} : { data: notice.data }),
        },
      })
    },
    open: read,
    keep: (teamID, kind, open) =>
      store.write(teamID, async () => {
        const current = await read(teamID)
        const kept = open.map((notice) => current.find((item) => item.id === notice.id && item.kind === kind) ?? notice)
        const next = [...current.filter((item) => item.kind !== kind), ...kept].toSorted((a, b) => a.at - b.at)
        if (JSON.stringify(next) === JSON.stringify(current)) return
        if (next.length === 0) return store.kv.remove(Keys.notices(teamID))
        await store.kv.set(Keys.notices(teamID), Keys.toJson(encode(next)))
      }),
  }
}

// The area peer methods (동료, 06 §2.7, approved 2026-10-09): `area.peer.add|edit|remove` are registered through the
// portable definition, answer from their group through the peers feature (which later voice tools call the same way),
// return the feature's failures as declared errors (`peer_invalid`, `same_company_subscription`, a team that is off)
// and an undeclared one as `internal_error`, and `health` lists the `peers` feature. Fake contexts over one world, the
// real @own/runtime on a temp OWN_HOME, a manual clock; fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam } from "@own/protocol"
import { Log } from "../../src/log.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import {
  TEAM_ID,
  World,
  area,
  boot,
  buildId,
  call,
  controller,
  managedEnv,
  team,
  tempHome,
  type Registered,
} from "../support/context.js"

const restore = managedEnv()
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  restore()
})

const UNKNOWN_TEAM = "tm_000000000000"
const UI = OwnTeam.AreaID.make("ar_ui")
const SESSION = SessionID.make("ses_review000000000000000000001")
const PEER: OwnTeam.Peer = {
  key: "peer",
  sessionID: SESSION,
  label: "리뷰어",
  role: "읽고 짚는다",
  attached: false,
  origin: "registered",
  at: 1,
}

function invoke(handlers: TeamRpc.Handlers, method: string, input: unknown) {
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const loose = handlers as unknown as Registered["handlers"]
  return call({ definition: { methods: {} }, handlers: loose, emitted: [], disposed: false }, method, input)
}

describe("area.peer.* in the plugin", () => {
  test("registered through the portable definition, answering from the peers feature; health lists `peers`", async () => {
    await using home = await tempHome()
    const booted = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: buildId("peers-rpc"), lingerSeconds: 0, logLevel: "error" },
    })
    cleanups.push(booted.cleanup)
    const registered = booted.registrations[0]!
    const answers = {
      add: await call(registered, "area.peer.add", {
        teamID: UNKNOWN_TEAM,
        areaID: UI,
        create: { label: "시뮬레이터", role: "" },
      }),
      edit: await call(registered, "area.peer.edit", { teamID: UNKNOWN_TEAM, areaID: UI, key: "peer", role: "x" }),
      remove: await call(registered, "area.peer.remove", { teamID: UNKNOWN_TEAM, areaID: UI, key: "peer" }),
    }
    expect(answers).toMatchObject({
      add: { type: "not_found", data: { what: "team" } },
      edit: { type: "not_found", data: { what: "team" } },
      remove: { type: "not_found", data: { what: "team" } },
    })
    const health = (await call(registered, "health", {})) as OwnTeam.Health
    expect(health.features).toContain("peers")
    expect(new Set(health.features).size).toBe(health.features.length)
    await booted.cleanup()
  })

  test("the feature's failures are declared errors; an undeclared one is internal_error; success answers the area", async () => {
    const home = await tempHome()
    cleanups.push(() => home[Symbol.asyncDispose]())
    const seen: unknown[] = []
    const h = controller(new World(), {
      directory: home.root,
      clock: manual(),
      features: {
        peers: (services) => ({
          add: async (input) => {
            seen.push(input)
            if ("create" in input) return Services.failure("peer_invalid", "label", { why: "label" })
            return Services.failure("same_company_subscription", "rival", { accountID: Account.ID.make("acc_x") })
          },
          edit: async () =>
            Services.failure("busy", "not for this method", {
              teamID: TEAM_ID,
              opID: OwnTeam.OpID.create(),
              kind: "reorg",
            }),
          remove: async () => {
            const current = await services.registry.areas.get(TEAM_ID, UI)
            return { ok: true, area: current! }
          },
          attach: async () => ({ ok: true }),
          detach: async () => ({ ok: true }),
        }),
      },
    })
    cleanups.push(h.close)
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team({ home: home.root }))
      await h.services.registry.areas.put({
        ...area({ slug: "ui", directory: path.join(home.root, "ui") }),
        peers: [PEER],
      })
    })
    const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: Log.silent })
    expect(
      await invoke(handlers, "area.peer.add", { teamID: TEAM_ID, areaID: UI, create: { label: "a", role: "" } }),
    ).toMatchObject({ type: "peer_invalid", data: { why: "label" } })
    expect(
      await invoke(handlers, "area.peer.add", {
        teamID: TEAM_ID,
        areaID: UI,
        sessionID: SESSION,
        label: "a",
        role: "",
      }),
    ).toMatchObject({ type: "same_company_subscription", data: { accountID: "acc_x" } })
    expect(await invoke(handlers, "area.peer.edit", { teamID: TEAM_ID, areaID: UI, key: "peer" })).toMatchObject({
      type: "internal_error",
      message: "not for this method",
    })
    expect(await invoke(handlers, "area.peer.remove", { teamID: TEAM_ID, areaID: UI, key: "peer" })).toMatchObject({
      area: { id: UI, peers: [PEER] },
    })
    expect(seen).toEqual([
      { teamID: TEAM_ID, areaID: UI, create: { label: "a", role: "" } },
      { teamID: TEAM_ID, areaID: UI, sessionID: SESSION, label: "a", role: "" },
    ])
  })
})

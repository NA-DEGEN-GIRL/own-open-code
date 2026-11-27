// The own.team registry (06 §2.4): the exact KV keys, team ids from the git common dir, revisions, request order and
// pruning, removing a team, records that do not decode, and where sessions and folders belong (06 §2.8, §5.4).

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Dispatches } from "../src/registry/dispatch.js"
import { Keys } from "../src/registry/keys.js"
import { Teams } from "../src/registry/team.js"
import { Texts } from "../src/report/texts.js"
import { manual } from "./support/clock.js"
import {
  MAIN_SESSION,
  OLD_OWNER,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  controller,
  team,
  tempHome,
} from "./support/context.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})

async function setup() {
  const home = await tempHome()
  homes.push(home)
  const world = new World()
  const clock = manual()
  const harness = controller(world, { directory: home.root, clock })
  return { home: home.root, world, clock, ...harness }
}

function dispatch(input: {
  readonly areaID: OwnTeam.AreaID
  readonly seq: number
  readonly state?: OwnTeam.Dispatch["state"]
  readonly createdAt?: number
}): OwnTeam.Dispatch {
  return {
    id: OwnTeam.DispatchID.create(),
    teamID: TEAM_ID,
    areaID: input.areaID,
    seq: input.seq,
    from: "main",
    kind: "task",
    text: `request ${input.seq}`,
    state: input.state ?? "waiting",
    createdAt: input.createdAt ?? 0,
  }
}

describe("keys", () => {
  test("are exactly the 06 §2.4 keys", () => {
    expect(Keys.team("tm_0123456789ab")).toBe("team:tm_0123456789ab")
    expect(Keys.area("tm_0123456789ab", "ar_ui")).toBe("area:tm_0123456789ab:ar_ui")
    expect(Keys.dispatch("tm_0123456789ab", "ar_ui", 42)).toBe("dispatch:tm_0123456789ab:ar_ui:0000000042")
    expect(Keys.op("tm_0123456789ab", "op_X")).toBe("op:tm_0123456789ab:op_X")
    expect(Keys.integration("tm_0123456789ab", "ig_X")).toBe("ig:tm_0123456789ab:ig_X")
    expect(Keys.digest("tm_0123456789ab")).toBe("digest:tm_0123456789ab")
    expect(Keys.cursor("ses_a")).toBe("cursor:ses_a")
    expect(Keys.decision("tm_0123456789ab", 7)).toBe("decision:tm_0123456789ab:0007")
    expect(Keys.proposal("tm_0123456789ab", "rp_X")).toBe("proposal:tm_0123456789ab:rp_X")
  })

  test("a team id is tm_ + 12 hex of the common dir's real path, whatever its spelling", async () => {
    await using home = await tempHome()
    const common = path.join(home.root, "repo", ".git")
    fs.mkdirSync(common, { recursive: true })
    const id = Teams.id(common)
    expect(id).toMatch(/^tm_[0-9a-f]{12}$/)
    expect(Teams.id(`${common}${path.sep}`)).toBe(id)
    expect(Teams.id(path.join(home.root, "repo", ".", ".git"))).toBe(id)
    if (process.platform === "win32") expect(Teams.id(common.toUpperCase())).toBe(id)
    expect(Teams.id(path.join(home.root, "other", ".git"))).not.toBe(id)
    expect(Teams.records({ id, commonDir: common })).toBe(path.join(common, "own", "team", id))
  })
})

describe("records", () => {
  test("team and area writes raise the team rev; requests keep seq order and are pruned after 7 days", async () => {
    const h = await setup()
    const registry = h.services.registry
    const first = await h.services.write(TEAM_ID, () => registry.teams.put(team({ home: h.home })))
    expect(first.rev).toBe(0)
    expect((await h.services.write(TEAM_ID, () => registry.teams.put(first))).rev).toBe(1)
    const ui = area({ slug: "ui", directory: path.join(h.home, "ui") })
    expect(await h.services.write(TEAM_ID, () => registry.areas.put(ui))).toBe(2)
    expect((await registry.teams.get(TEAM_ID))?.rev).toBe(2)
    expect(h.world.kv.has("area:tm_0123456789ab:ar_ui")).toBe(true)

    expect(await registry.dispatches.next(TEAM_ID, ui.id)).toBe(0)
    const requests = [
      dispatch({ areaID: ui.id, seq: 10 }),
      dispatch({ areaID: ui.id, seq: 2 }),
      dispatch({ areaID: ui.id, seq: 3, state: "sent" }),
    ]
    await h.services.write(TEAM_ID, () => Promise.all(requests.map((item) => registry.dispatches.put(item))))
    expect((await registry.dispatches.list(TEAM_ID, ui.id)).map((item) => item.seq)).toEqual([2, 3, 10])
    expect((await registry.dispatches.waiting(TEAM_ID)).map((item) => item.seq)).toEqual([2, 10])
    expect(Object.entries(await registry.dispatches.counts(TEAM_ID))).toEqual([["ar_ui", 2]])
    expect(await registry.dispatches.next(TEAM_ID, ui.id)).toBe(11)
    expect((await registry.dispatches.find(TEAM_ID, requests[1]!.id))?.seq).toBe(2)
    // Requests do not raise the team rev (the outbox has its own event).
    expect((await registry.teams.get(TEAM_ID))?.rev).toBe(2)

    expect(await registry.dispatches.prune(TEAM_ID, Dispatches.KEEP_MS)).toBe(0)
    expect(await registry.dispatches.prune(TEAM_ID, Dispatches.KEEP_MS + 1)).toBe(1)
    expect((await registry.dispatches.list(TEAM_ID)).map((item) => item.seq)).toEqual([2, 10])
    await h.close()
  })

  test("removing an area removes its whole texts and stretch, so an area of the same slug starts clean", async () => {
    const h = await setup()
    const registry = h.services.registry
    const ui = area({ slug: "ui", directory: path.join(h.home, "ui") })
    const item = { kind: "ready", text: "다 됐어요", at: 1 }
    await h.services.write(TEAM_ID, async () => {
      await registry.teams.put(team({ home: h.home }))
      await registry.areas.put(ui)
      await Texts.save(h.services.kv, TEAM_ID, ui.id, Texts.report(undefined, item))
      await Texts.saveStretch(h.services.kv, TEAM_ID, ui.id, Texts.append(undefined, 1, item))
    })
    await h.services.write(TEAM_ID, () => registry.areas.remove(TEAM_ID, ui.id))
    await h.services.write(TEAM_ID, () => registry.areas.put(ui))
    expect(await Texts.load(h.services.kv, h.services.log, TEAM_ID, ui.id)).toBeUndefined()
    expect(await Texts.loadStretch(h.services.kv, h.services.log, TEAM_ID, ui.id)).toBeUndefined()
    await h.close()
  })

  test("records that do not decode are skipped, and removing a team removes only its records", async () => {
    const h = await setup()
    const registry = h.services.registry
    await h.services.write(TEAM_ID, async () => {
      await registry.teams.put(team({ home: h.home }))
      await registry.areas.put(area({ slug: "ui", directory: path.join(h.home, "ui") }))
      await registry.dispatches.put(dispatch({ areaID: OwnTeam.AreaID.make("ar_ui"), seq: 0 }))
    })
    h.world.kv.set("team:tm_ffffffffffff", { id: "not a team" })
    h.world.kv.set("op:tm_0123456789ab:op_x", { steps: "nope" })
    h.world.kv.set("digest:tm_0123456789ab", { pending: [] })
    h.world.kv.set("digest:tm_0123456789abc", { other: true })
    expect((await registry.teams.list()).map((item) => item.id)).toEqual([TEAM_ID])
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])

    await h.services.write(TEAM_ID, () => registry.teams.remove(TEAM_ID))
    expect([...h.world.kv.keys()].sort()).toEqual(["digest:tm_0123456789abc", "team:tm_ffffffffffff"])
    await h.close()
  })
})

describe("locate", () => {
  test("roles come from the registry's session ids, never from metadata", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team({ home: h.home }))
      await h.services.registry.areas.put(area({ slug: "ui", directory: path.join(h.home, "ui") }))
    })
    expect(await h.services.locate.session(MAIN_SESSION)).toMatchObject({ role: "main", team: { id: TEAM_ID } })
    expect(await h.services.locate.session(OWNER_SESSION)).toMatchObject({ role: "owner", area: { id: "ar_ui" } })
    expect(await h.services.locate.session(OLD_OWNER)).toMatchObject({ role: "previous-owner", area: { id: "ar_ui" } })
    // A child of the owner copies its metadata and permissions, but its id is in no registry slot.
    expect(await h.services.locate.session("ses_child0000000000000000000001")).toBeUndefined()
    await h.close()
  })

  test("a folder belongs to the deepest team folder that contains it", async () => {
    const h = await setup()
    const nested = path.join(h.home, ".worktrees", "nested")
    fs.mkdirSync(path.join(nested, "src"), { recursive: true })
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team({ home: h.home }))
      await h.services.registry.areas.put(area({ slug: "nested", directory: nested }))
      await h.services.registry.areas.put({
        ...area({ slug: "gone", directory: path.join(h.home, "gone") }),
        state: "retired",
      })
    })
    expect(await h.services.locate.directory(path.join(nested, "src"))).toMatchObject({ area: { id: "ar_nested" } })
    const atHome = await h.services.locate.directory(path.join(h.home, ".worktrees"))
    expect(atHome?.team.id).toBe(TEAM_ID)
    expect(atHome?.area).toBeUndefined()
    // A retired area's folder is the home's again.
    expect((await h.services.locate.directory(path.join(h.home, "gone")))?.area).toBeUndefined()
    expect(await h.services.locate.directory(path.dirname(h.home))).toBeUndefined()
    await h.close()
  })
})

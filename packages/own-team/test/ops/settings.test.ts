// Writing 설정 `팀` (`ops/settings.ts`, 2026-11-14): the policy keys over the team's, the 팀 지시문 blocks normalised
// (`\r\n` → `\n`, trimmed; null, empty or the default text resets), the breaker lines the wire refuses also after
// trimming, and what the role texts need afterwards: `direct.sweep` when the hold goes off, `main.refresh` for the hold
// or the main block, `owner.stale` for the hold, the tell or the owner block, `peers.stale` for the tell or the peer
// block. The features are the real ones with these four calls recorded; the RPC reads back what `settings.get` shows.

import { afterAll, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Direct } from "../../src/dispatch/direct.js"
import { TeamSettings } from "../../src/ops/settings.js"
import { Keys } from "../../src/registry/keys.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { SettingsRpc } from "../../src/rpc/settings.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { MainSession } from "../../src/sessions/main.js"
import { OwnerSession } from "../../src/sessions/owner.js"
import { Peers } from "../../src/sessions/peer.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller, team, tempHome } from "../support/context.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})

async function setup(input: { readonly directHold?: boolean } = {}) {
  const home = await tempHome()
  homes.push(home)
  const calls: string[] = []
  const h = controller(new World(), {
    directory: home.root,
    clock: manual(),
    features: {
      direct: (services) => ({
        ...Direct.create(services),
        sweep: async (teamID) => void calls.push(`direct.sweep ${teamID}`),
      }),
      main: (services) => ({
        ...MainSession.create(services),
        refresh: async () => {
          calls.push("main.refresh")
          return { ok: true }
        },
      }),
      owner: (services) => ({
        ...OwnerSession.create(services),
        stale: async () => void calls.push("owner.stale"),
      }),
      peers: (services) => ({ ...Peers.create(services), stale: async () => void calls.push("peers.stale") }),
    },
  })
  await h.services.write(TEAM_ID, () =>
    h.services.registry.teams.put(team({ home: home.root, ...(input.directHold === undefined ? {} : input) })),
  )
  const write = async (patch: OwnTeam.SettingsPatch) => {
    calls.length = 0
    return TeamSettings.write(h.services, TEAM_ID, patch)
  }
  const stored = () => h.services.kv.get(Keys.instructions(TEAM_ID))
  return { ...h, calls, write, stored }
}

describe("what the role texts need after a save", () => {
  test("directHold on → off: hand-backs first, then the main's text now and the owners' before their next request", async () => {
    const h = await setup({ directHold: true })
    expect(await h.write({ policy: { directHold: false } })).toMatchObject({ ok: true })
    expect(h.calls).toEqual([`direct.sweep ${TEAM_ID}`, "main.refresh", "owner.stale"])
    // off → on holds nothing yet: no sweep.
    await h.write({ policy: { directHold: true } })
    expect(h.calls).toEqual(["main.refresh", "owner.stale"])
    await h.close()
  })

  test("an absent directHold reads as on: writing true changes nothing, writing false sweeps", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      const current = (await h.services.registry.teams.get(TEAM_ID))!
      const { directHold: _directHold, ...policy } = current.policy
      await h.services.registry.teams.put({ ...current, policy })
    })
    await h.write({ policy: { directHold: true } })
    expect(h.calls).toEqual([])
    await h.write({ policy: { directHold: false } })
    expect(h.calls).toEqual([`direct.sweep ${TEAM_ID}`, "main.refresh", "owner.stale"])
    await h.close()
  })

  test("directTell: owners and peers; each block: its own role; an equal save and other keys: nothing", async () => {
    const h = await setup()
    await h.write({ policy: { directTell: "always" } })
    expect(h.calls).toEqual(["owner.stale", "peers.stale"])
    await h.write({ policy: { directTell: "always", askDiskBytes: 1 } })
    expect(h.calls).toEqual([])
    await h.write({ instructions: { main: "- 짧게 답한다." } })
    expect(h.calls).toEqual(["main.refresh"])
    await h.write({ instructions: { owner: "- 짧게 답한다.", peer: "- 짧게 답한다." } })
    expect(h.calls).toEqual(["owner.stale", "peers.stale"])
    // The same blocks again (the main's with Windows line breaks and blanks around it) change nothing.
    await h.write({ instructions: { main: "  - 짧게 답한다.\r\n" } })
    expect(h.calls).toEqual([])
    await h.write({ patterns: [] })
    expect(h.calls).toEqual([])
    await h.close()
  })
})

describe("the 팀 지시문 blocks", () => {
  test("normalised before they are stored: `\\r\\n` → `\\n`, trimmed", async () => {
    const h = await setup()
    await h.write({ instructions: { owner: "\r\n  - 보고는 영어로 한다.\r\n- 커밋 글도 영어로 쓴다.  \r\n" } })
    expect(await h.stored()).toEqual({ owner: "- 보고는 영어로 한다.\n- 커밋 글도 영어로 쓴다." })
    await h.close()
  })

  test("null, an empty block and the default text each reset the role; absent keys stay; no block left removes the key", async () => {
    const h = await setup()
    await h.write({ instructions: { main: "- a", owner: "- b", peer: "- c" } })
    expect(await h.stored()).toEqual({ main: "- a", owner: "- b", peer: "- c" })
    await h.write({ instructions: { main: null } })
    expect(await h.stored()).toEqual({ owner: "- b", peer: "- c" })
    await h.write({ instructions: { owner: "  \r\n " } })
    expect(await h.stored()).toEqual({ peer: "- c" })
    await h.write({ instructions: { peer: `${RoleInstructions.STANDARD.peer}\r\n` } })
    expect(await h.stored()).toBeUndefined()
    expect(h.calls).toEqual(["peers.stale"])
    await h.close()
  })

  test("a block whose line would start with a breaker once trimmed is refused; nothing is written", async () => {
    const h = await setup()
    await h.write({ instructions: { main: "- 그대로 둔다." } })
    for (const breaker of OwnTeam.INSTRUCTION_BREAKERS) {
      const refused = await h.write({ policy: { askDiskBytes: 7 }, instructions: { main: `  ${breaker}x` } })
      expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("'</context>'") })
      expect(h.calls).toEqual([])
    }
    expect(await h.stored()).toEqual({ main: "- 그대로 둔다." })
    expect((await h.services.registry.teams.get(TEAM_ID))?.policy.askDiskBytes).toBe(OwnTeam.POLICY.askDiskBytes)
    await h.close()
  })

  test("the wire refuses the breaker lines and 2,001 characters (the schema the RPC decodes with)", () => {
    const decode = (main: string) => OwnTeam.SettingsPatch.makeOption({ instructions: { main } })
    expect(decode("a".repeat(2_000))._tag).toBe("Some")
    expect(decode("a".repeat(2_001))._tag).toBe("None")
    for (const breaker of OwnTeam.INSTRUCTION_BREAKERS) expect(decode(`- 좋다\n${breaker}x`)._tag).toBe("None")
  })
})

describe("settings.get / settings.set", () => {
  test("the policy with its defaults filled in, 팀 지시문 per role, and the features", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      const current = (await h.services.registry.teams.get(TEAM_ID))!
      const { directHold: _directHold, ...policy } = current.policy
      await h.services.registry.teams.put({ ...current, policy })
    })
    await h.write({ instructions: { peer: "- 리뷰는 목록으로 쓴다." } })
    const team = (await h.services.registry.teams.get(TEAM_ID))!
    const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: h.services.log })
    // SAFETY (test): every handler takes its method's input and `{signal, error}`.
    const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
    const rpc = (method: string, input: unknown) =>
      loose[method]!(input, {
        signal: new AbortController().signal,
        error: (type: string, message: string, data: unknown) => ({ type, message, data }),
      })
    const got = await rpc("settings.get", { teamID: TEAM_ID })
    expect(got).toEqual({
      policy: { ...team.policy, directHold: true, directTell: "judge" },
      commands: team.commands,
      patterns: team.patterns,
      instructions: RoleInstructions.view(team, { peer: "- 리뷰는 목록으로 쓴다." }),
    })
    expect(Schema.decodeUnknownOption(OwnTeam.TeamSettings)(got)._tag).toBe("Some")
    // settings.set: an older client's maxAreas decodes away before it gets here; instructions are written.
    expect(await rpc("settings.set", { teamID: TEAM_ID, patch: { instructions: { peer: null } } })).toMatchObject({
      team: { id: TEAM_ID },
    })
    expect(await h.stored()).toBeUndefined()
    expect(SettingsRpc.FEATURES).toEqual(["settings", "direct", "instructions"])
    await h.close()
  })
})

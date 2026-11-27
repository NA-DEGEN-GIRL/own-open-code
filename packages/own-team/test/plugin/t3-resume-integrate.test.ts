// TI-11 for an integration with the `.assets` check (06 §8.5, §4.10): every step's result lost once (kit in
// `t3-resume/kit.ts`); the asset command runs once whichever step's result was lost.

import { describe, expect } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { IntegrateOp } from "../../src/integrate/op.js"
import { Areas } from "../../src/registry/area.js"
import { git } from "../fixtures/repo.js"
import { TEAM_ID } from "../support/context.js"
import { counter, eachStep, makeArea, ownRefs, worktrees } from "./t3-resume/kit.js"

describe("resume after each step (06 §8.5, TI-11)", () => {
  const engine = { runs: () => 0, command: { argv: ["unused"] } as OwnTeam.Command }
  // Steps 0-7 with the heavy-list measurement of K (5½), then 8-9.
  eachStep("an integration with the .assets check: steps 0-7 and 8-9; the asset command runs once", 8, {
    prepare: async (fx, booted) => {
      const made = counter(fx.box)
      engine.runs = made.runs
      engine.command = made.command
      const record = (await booted.services.registry.teams.get(TEAM_ID))!
      await booted.services.write(TEAM_ID, () =>
        booted.services.registry.teams.put({
          ...record,
          commands: { setup: null, code: [], assets: [made.command] },
        }),
      )
      await makeArea(fx, booted.services, "ui", {
        commit: true,
        files: { "assets/textures/rock.bin": "rock 2\n" },
      })
    },
    start: async (_fx, booted) => {
      const started = await booted.services
        .features()
        .integrate.start({ teamID: TEAM_ID, areaID: Areas.id("ui"), by: "user", tip: true })
      if (!started.ok) throw new Error(started.message)
      return started.opID
    },
    check: async (fx, booted, op) => {
      const integrationID = String(op.steps[0]?.args.integrationID)
      const integration = await IntegrateOp.get(booted.services, TEAM_ID, integrationID)
      expect(integration).toMatchObject({ state: "done", verify: { assets: { ok: true } } })
      expect(engine.runs()).toBe(1)
      expect(git(fx.home, ["rev-parse", "HEAD"]).trim()).toBe(String(integration?.candidate))
      // Integrate markers go once the target moved on; the asset folder is made once.
      expect(ownRefs(fx.home)).toEqual([])
      expect(worktrees(fx.home).filter((line) => line.endsWith("/.assets"))).toHaveLength(1)
    },
  })
})

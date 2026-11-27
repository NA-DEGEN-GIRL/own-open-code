// TI-11 at every step (06 §8.3, §8.5; TG12 "resume at every step"): an op stopped right after one step's effect, before
// its result was written, is continued by the next controller (a new acquire over the same KV and folders), which
// observes that step again and goes on. This file: 변환 and `link-shared` at their one step, and the first `.assets`
// asking before it is made. 끝내기, 묶기, 나누기 and the `.assets` check of an integration are in `t3-resume-*.test.ts`
// (one file per op, so `--parallel` spreads them); the shared kit is `t3-resume/kit.ts`. Fake values only.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Shared } from "../../src/assets/shared.js"
import { Controller } from "../../src/controller.js"
import { IntegrateOp } from "../../src/integrate/op.js"
import { Areas } from "../../src/registry/area.js"
import { Keys } from "../../src/registry/keys.js"
import { git, write } from "../fixtures/repo.js"
import { TEAM_ID } from "../support/context.js"
import {
  SLOW,
  apply,
  areaOf,
  boot,
  counter,
  eachStep,
  fixture,
  makeArea,
  ownRefs,
  type Booted,
  type Fixture,
} from "./t3-resume/kit.js"

describe("resume after each step (06 §8.5, TI-11)", () => {
  eachStep("변환: the conversion to a code-only folder", 1, {
    prepare: async (fx, booted) => {
      await makeArea(fx, booted.services, "lab", { shape: "full" })
    },
    start: apply({ ops: [{ op: "convert", area: "lab", shape: "code" }] }),
    check: async (_fx, booted) => {
      const lab = await areaOf(booted.services, "lab")
      expect(lab?.shape).toBe("code")
      expect(git(lab!.directory, ["config", "--get", "index.sparse"]).trim()).toBe("true")
      expect(fs.existsSync(path.join(lab!.directory, "assets"))).toBe(false)
      expect(git(lab!.directory, ["status", "--porcelain"]).trim()).toBe("")
    },
  })

  eachStep(
    "link-shared: the shared folder's link in an area",
    1,
    {
      prepare: async (fx, booted) => {
        write(fx.home, { "weights/model.bin": "weights\n" })
        await makeArea(fx, booted.services, "ui", { owner: true })
      },
      start: async (_fx, booted) => {
        const started = await booted.services.runner.start({
          teamID: TEAM_ID,
          kind: "reorg",
          by: "user",
          steps: [Shared.linkSpec({ areaID: Areas.id("ui") })],
        })
        if (!started.ok) throw new Error("busy")
        return started.op.id
      },
      check: async (fx, booted) => {
        const ui = await areaOf(booted.services, "ui")
        const record = (await booted.services.registry.teams.get(TEAM_ID))!
        expect(await Shared.inspect(ui!.directory, record.shared)).toEqual([{ name: "weights", state: "linked" }])
        const exclude = fs.readFileSync(path.join(fx.home, ".git", "info", "exclude"), "utf8")
        expect(exclude.split(/\r?\n/).filter((line) => line === "/weights")).toHaveLength(1)
        expect(fs.readFileSync(path.join(ui!.directory, "weights", "model.bin"), "utf8")).toBe("weights\n")
      },
    },
    {
      setup: {
        team: (record: OwnTeam.Team): OwnTeam.Team => ({
          ...record,
          // Recorded as protected; no ACL is applied in this test (06 §4.11 test rule).
          shared: [{ name: "weights", target: path.join(record.home.directory, "weights"), protect: Shared.PROTECT }],
        }),
      },
    },
  )
})

describe("the first .assets asks before it is made (06 §4.10, §0.3)", () => {
  /** A team whose asset check would make `.assets` over `askDiskBytes`, and the area's commit to a heavy folder. */
  async function heavy(fx: Fixture, booted: Booted) {
    const made = counter(fx.box)
    const record = (await booted.services.registry.teams.get(TEAM_ID))!
    await booted.services.write(TEAM_ID, () =>
      booted.services.registry.teams.put({
        ...record,
        commands: { setup: null, code: [], assets: [made.command] },
        policy: { ...record.policy, askDiskBytes: 1 },
      }),
    )
    await makeArea(fx, booted.services, "ui", { commit: true, files: { "assets/textures/rock.bin": "rock 2\n" } })
    const started = await booted.services
      .features()
      .integrate.start({ teamID: TEAM_ID, areaID: Areas.id("ui"), by: "user", tip: true })
    if (!started.ok) throw new Error(started.message)
    return { ...started, runs: made.runs }
  }

  /** The team's ops once there are `count` of them and none runs (real time): each next op starts after one ends. */
  async function quiet(booted: Booted, count: number) {
    const deadline = Date.now() + 240_000
    for (;;) {
      const ops = await booted.services.journal.list(TEAM_ID)
      if (ops.length >= count && ops.every((op) => op.state !== "running")) return ops
      if (Date.now() > deadline) throw new Error(`${ops.length} ops, still running or fewer than ${count}`)
      await Bun.sleep(25)
    }
  }

  test(
    "steps 0-6 run alone, step 7 asks in the next op, and steps 8-9 follow the confirmed check",
    async () => {
      const fx = await fixture()
      const booted = boot(fx)
      await booted.services.write(TEAM_ID, () => booted.services.registry.teams.put(fx.record))
      const started = await heavy(fx, booted)
      const asked = await quiet(booted, 2)
      expect(asked.map((op) => op.steps.map((step) => step.kind))).toEqual([
        [
          IntegrateOp.KIND.start,
          IntegrateOp.KIND.merge,
          IntegrateOp.KIND.refs,
          IntegrateOp.KIND.heavy,
          IntegrateOp.KIND.verify,
        ],
        [IntegrateOp.KIND.assets],
      ])
      const step = asked[1]!.steps[0]!
      expect(step).toMatchObject({ mode: "confirm", state: "needs_confirm" })
      expect(step.confirm?.text).toContain("처음 만들까요")
      // Nothing was made before the answer; the target has not moved.
      expect(fs.existsSync(path.join(fx.record.worktreeRoot, ".assets"))).toBe(false)
      expect(git(fx.home, ["rev-parse", "HEAD"]).trim()).toBe(fx.base)
      expect(
        await booted.rpc("op.confirm", {
          opID: asked[1]!.id,
          stepID: step.id,
          choice: "do",
          nonce: step.confirm?.nonce,
        }),
      ).toMatchObject({ op: { state: "done" } })
      const ops = await quiet(booted, 3)
      expect(ops.map((op) => [op.steps.map((item) => item.kind), op.state])).toEqual([
        [
          [
            IntegrateOp.KIND.start,
            IntegrateOp.KIND.merge,
            IntegrateOp.KIND.refs,
            IntegrateOp.KIND.heavy,
            IntegrateOp.KIND.verify,
          ],
          "done",
        ],
        [[IntegrateOp.KIND.assets], "done"],
        [["integrate-advance", "integrate-after"], "done"],
      ])
      const integration = await IntegrateOp.get(booted.services, TEAM_ID, started.integrationID)
      expect(integration).toMatchObject({ state: "done", verify: { assets: { ok: true } } })
      expect(started.runs()).toBe(1)
      expect(git(fx.home, ["rev-parse", "HEAD"]).trim()).toBe(String(integration?.candidate))
    },
    SLOW,
  )

  test(
    "두기 ends the integration (failed, assets) with its markers removed and a note for the main, no wake",
    async () => {
      const fx = await fixture()
      const booted = boot(fx)
      await booted.services.write(TEAM_ID, () => booted.services.registry.teams.put(fx.record))
      const started = await heavy(fx, booted)
      const asked = await quiet(booted, 2)
      const step = asked[1]!.steps[0]!
      await booted.rpc("op.confirm", {
        opID: asked[1]!.id,
        stepID: step.id,
        choice: "skip",
        nonce: step.confirm?.nonce,
      })
      const deadline = Date.now() + 60_000
      // The team note is the last thing the stop writes.
      while (!(await booted.services.features().digest.render({ teamID: TEAM_ID })).includes(Controller.DECLINED)) {
        if (Date.now() > deadline) throw new Error("the integration did not end")
        await Bun.sleep(25)
      }
      expect(await IntegrateOp.get(booted.services, TEAM_ID, started.integrationID)).toMatchObject({
        state: "failed",
        failure: "assets",
      })
      expect(ownRefs(fx.home)).toEqual([])
      expect(started.runs()).toBe(0)
      expect(fs.existsSync(path.join(fx.record.worktreeRoot, ".assets"))).toBe(false)
      expect(git(fx.home, ["rev-parse", "HEAD"]).trim()).toBe(fx.base)
      expect(await booted.services.features().digest.render({ teamID: TEAM_ID })).toContain(Controller.DECLINED)
      expect(fx.backend.synthetic).toEqual([])
    },
    SLOW,
  )

  test(
    "a controller that stopped between steps 0-6 and step 7 is followed by the next one, which asks",
    async () => {
      const fx = await fixture()
      const first = boot(fx)
      await first.services.write(TEAM_ID, () => first.services.registry.teams.put(fx.record))
      const started = await heavy(fx, first)
      const asked = await quiet(first, 2)
      expect(asked).toHaveLength(2)
      await first.close()
      // As if the process ended before the next op was written: only steps 0-6's op is in the journal.
      fx.world.kv.delete(Keys.op(TEAM_ID, asked[1]!.id))
      const second = boot(fx)
      await second.controller.resume()
      const again = await quiet(second, 2)
      expect(again.map((op) => op.steps.map((step) => [step.kind, step.state]))).toEqual([
        asked[0]!.steps.map((step) => [step.kind, step.state]),
        [[IntegrateOp.KIND.assets, "needs_confirm"]],
      ])
      expect((await IntegrateOp.get(second.services, TEAM_ID, started.integrationID))?.state).toBe("running")
    },
    SLOW,
  )
})

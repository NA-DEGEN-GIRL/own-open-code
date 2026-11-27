// The source binding of an integration (06 §2.9, §7.1): a voice plan shows the area's branch tip and binds its SHA.
// `IntegrateOp.plan` and the integrate feature's `start` with that `source` run when C is still it (every integrate
// step is in the op), and answer `conflict{ref, expected, actual}` with no op when the tip moved or a candidate came
// in between. Temp fixture repositories, a manual clock and fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Advance } from "../../src/integrate/advance.js"
import { IntegrateOp } from "../../src/integrate/op.js"
import { integrate, save } from "../fixtures/integrate.js"
import { temp } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller } from "../support/context.js"

const SLOW = 180_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const box = temp("own-team-source-")
  cleanups.push(box.dispose)
  const fx = integrate(path.join(box.root, "repo"))
  const h = controller(new World(), { directory: fx.home, clock: manual() })
  cleanups.push(h.close)
  // `ask`: the advance waits for its confirm, so the op stays where the test can see it.
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put({ ...fx.team, policy: { ...OwnTeam.POLICY, mergeLocal: "ask" } })
    await h.services.registry.areas.put(fx.area)
  })
  return { fx, h }
}

describe("integration source binding (06 §2.9)", () => {
  test(
    "the shown tip runs with every integrate step; a moved tip or a new candidate is a conflict with no op",
    async () => {
      const s = await setup()
      const area = s.fx.area
      const shown = save(area.directory, { "src/area.ts": "area\n" }, "first")
      const planned = await IntegrateOp.plan(s.h.services, { teamID: TEAM_ID, areaID: area.id, tip: true })
      expect(planned).toMatchObject({ ok: true, source: shown, subjects: ["first"] })

      // The tip moves after it was shown.
      const moved = save(area.directory, { "src/area.ts": "area 2\n" }, "second")
      expect(
        await IntegrateOp.plan(s.h.services, { teamID: TEAM_ID, areaID: area.id, tip: true, source: shown }),
      ).toMatchObject({ ok: false, error: "conflict", data: { ref: area.branch, expected: shown, actual: moved } })
      const integrate = s.h.services.features().integrate
      expect(
        await integrate.start({ teamID: TEAM_ID, areaID: area.id, by: "user", tip: true, source: shown }),
      ).toMatchObject({ ok: false, error: "conflict", data: { expected: shown, actual: moved } })
      expect(await s.h.services.journal.list(TEAM_ID)).toEqual([])

      // A candidate reported in between is another C as well.
      await s.h.services.write(TEAM_ID, () =>
        s.h.services.registry.areas.put({ ...area, candidate: { sha: shown, at: 1, text: "준비" } }),
      )
      expect(
        await integrate.start({ teamID: TEAM_ID, areaID: area.id, by: "user", tip: true, source: moved }),
      ).toMatchObject({ ok: false, error: "conflict", data: { expected: moved, actual: shown } })
      await s.h.services.write(TEAM_ID, () => s.h.services.registry.areas.put(area))

      // C is still what was shown: the op runs with every step of 0-9 (no check is skipped for a voice plan).
      const started = await integrate.start({ teamID: TEAM_ID, areaID: area.id, by: "user", tip: true, source: moved })
      if (!started.ok) throw new Error(started.message)
      const op = await until(async () => {
        const found = await s.h.services.journal.get(TEAM_ID, started.opID)
        return found?.state === "waiting" || found?.state === "failed" || found?.state === "done" ? found : undefined
      })
      expect(op).toMatchObject({ kind: "integrate", by: "user", state: "waiting" })
      const kinds = op.steps.map((step) => step.kind)
      for (const kind of Object.values(IntegrateOp.KIND)) expect(kinds).toContain(kind)
      expect(kinds).toContain(Advance.STEP)
      expect(await IntegrateOp.get(s.h.services, TEAM_ID, started.integrationID)).toMatchObject({ source: moved })
    },
    SLOW,
  )
})

/** Waits (real time) until `check` answers something. */
async function until<T>(check: () => Promise<T | undefined>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(50)
  }
}

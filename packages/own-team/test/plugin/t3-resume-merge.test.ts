// TI-11 for 묶기 (06 §8.5): every step's result lost once (kit in `t3-resume/kit.ts`).

import { describe, expect } from "bun:test"
import fs from "node:fs"
import { git } from "../fixtures/repo.js"
import { apply, areaOf, eachStep, makeArea, ownRefs } from "./t3-resume/kit.js"

describe("resume after each step (06 §8.5, TI-11)", () => {
  eachStep(
    "묶기: begin, merge into A, handoff, attach, outbox, archive, retire and B's removal",
    8,
    {
      prepare: async (fx, booted) => {
        await makeArea(fx, booted.services, "ui", { owner: true, commit: true })
        await makeArea(fx, booted.services, "save", { owner: true, commit: true })
      },
      start: apply({ ops: [{ op: "merge", area: "ui", from: "save" }] }),
      check: async (fx, booted, op) => {
        const save = await areaOf(booted.services, "save")
        expect(save?.state).toBe("retired")
        expect(fs.existsSync(save!.directory)).toBe(false)
        // One K: the merge commit A moved to, recorded once.
        const k = git(fx.home, ["rev-parse", "refs/heads/ui"]).trim()
        expect(git(fx.home, ["rev-list", "--count", "--merges", "refs/heads/ui"]).trim()).toBe("1")
        expect(ownRefs(fx.home).toSorted()).toEqual(
          ["base", "candidate", "source"].map((name) => `refs/own/integrate/${op.id}-save/${name}`),
        )
        expect(git(fx.home, ["rev-parse", `refs/own/integrate/${op.id}-save/candidate`]).trim()).toBe(k)
        expect(git((await areaOf(booted.services, "ui"))!.directory, ["rev-parse", "HEAD"]).trim()).toBe(k)
        expect(fx.owners).toEqual([])
        expect(fx.backend.synthetic).toEqual([])
      },
    },
    { atLeast: true },
  )
})

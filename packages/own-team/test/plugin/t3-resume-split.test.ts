// TI-11 for 나누기 (06 §8.5): every step's result lost once (kit in `t3-resume/kit.ts`).

import { describe, expect } from "bun:test"
import { git } from "../fixtures/repo.js"
import { apply, areaOf, eachStep, makeArea, ownRefs, worktrees } from "./t3-resume/kit.js"

describe("resume after each step (06 §8.5, TI-11)", () => {
  eachStep("나누기: begin, handoff, branch, worktree, record and the new owner", 6, {
    prepare: async (fx, booted) => {
      await makeArea(fx, booted.services, "ui", { owner: true, commit: true })
    },
    start: apply({ ops: [{ op: "split", area: "ui", slug: "ui-two", name: "화면 둘" }] }),
    check: async (fx, booted) => {
      const two = await areaOf(booted.services, "ui-two")
      expect(two?.state).toBe("active")
      expect(fx.owners).toEqual([String(two!.owner.sessionID)])
      expect(git(fx.home, ["rev-parse", "refs/heads/ui-two"]).trim()).toBe(
        git(fx.home, ["rev-parse", "refs/heads/ui"]).trim(),
      )
      expect(worktrees(fx.home).filter((line) => line.endsWith("/ui-two"))).toHaveLength(1)
      expect(ownRefs(fx.home)).toEqual([])
      expect(fx.backend.synthetic).toEqual([])
    },
  })
})

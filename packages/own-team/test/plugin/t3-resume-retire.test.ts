// TI-11 for 끝내기 (06 §8.5): every step's result lost once (kit in `t3-resume/kit.ts`).

import { describe, expect } from "bun:test"
import fs from "node:fs"
import { apply, areaOf, eachStep, makeArea, ownRefs, worktrees } from "./t3-resume/kit.js"

describe("resume after each step (06 §8.5, TI-11)", () => {
  eachStep("끝내기: begin (the safe point), keep, check, outbox, archive, mark and the removal", 7, {
    prepare: async (fx, booted) => {
      await makeArea(fx, booted.services, "api", { owner: true, commit: true, merged: true })
    },
    start: apply({ ops: [{ op: "retire", area: "api" }] }),
    check: async (fx, booted) => {
      const api = await areaOf(booted.services, "api")
      expect(api?.state).toBe("retired")
      expect(fs.existsSync(api!.directory)).toBe(false)
      expect(ownRefs(fx.home)).toEqual([])
      expect(worktrees(fx.home)).toHaveLength(1)
      expect(fx.backend.sessions.get(api!.owner.sessionID!)?.metadata["own.archived"]).toBe(true)
      expect(fx.owners).toEqual([])
      expect(fx.backend.synthetic).toEqual([])
    },
  })
})

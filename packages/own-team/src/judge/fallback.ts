export * as JudgeFallback from "./fallback.js"

import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { Measure } from "../git/measure.js"
import { JudgePrompt } from "./prompt.js"
import { JudgeValidate } from "./validate.js"

/**
 * The rule-based proposal (06 §3.4) used when the judge call fails twice (no answer, or an answer that does not
 * decode, V1). Deterministic:
 *
 *   heavy     folders of at least 50 MB that are mostly binary (≥ 0.8) or mostly LFS (`Measure.ruleBasedHeavy`)
 *   areas     candidates with a named branch and activity (3.4) are adopted, each with its most recent root session
 *   main      always new (enable makes it before judging)
 *   commands  the lock file's install command as setup; `typecheck`, `check`, `test`, `lint` as code checks
 *
 * The result is a proposal like the judge's and goes through the same V-rules.
 */

export const NOTES = "판단 호출이 답하지 않아 규칙으로 정했어요."

/** Code checks the fallback picks, in this order. */
const CHECKS = ["typecheck", "check", "test", "lint"] as const

export function propose(input: {
  readonly facts: JudgeValidate.Facts
  readonly rows: ReadonlyArray<Measure.Row>
}): OwnTeam.Proposal {
  const facts = input.facts
  const rows = new Map(input.rows.map((row) => [row.dir, row]))
  const code = CHECKS.flatMap((name) =>
    facts.commands.filter((candidate) => candidate.kind === "code" && candidate.name.endsWith(` ${name}`)),
  )
  return {
    version: 1,
    target: facts.target,
    heavy: Measure.ruleBasedHeavy(input.rows).map((dir) => ({ dir, why: why(rows.get(dir)) })),
    areas: facts.worktrees
      .filter((item) => item.class === "candidate" && item.active && item.branch !== null)
      .map((item) => {
        const name = path.posix.basename(item.path.replaceAll("\\", "/"))
        return {
          slug: JudgeValidate.slugify(name),
          name,
          adopt: { worktree: item.path, branch: item.branch, owner: item.sessions[0] ?? null },
          create: null,
        }
      }),
    commands: {
      setup: facts.commands.find((candidate) => candidate.kind === "setup")?.name ?? null,
      code: [...new Set(code.map((candidate) => candidate.name))],
      assets: [],
    },
    notes: NOTES,
  }
}

function why(row: Measure.Row | undefined) {
  if (!row) return "규칙: 큰 바이너리 폴더"
  if (row.bytes > 0 && row.lfsBytes * 2 >= row.bytes) return `규칙: LFS ${JudgePrompt.size(row.lfsBytes)}`
  const share = row.binaryRatio === null ? "" : ` · 바이너리 ${Math.round(row.binaryRatio * 100)}%`
  return `규칙: ${JudgePrompt.size(row.bytes)}${share}`
}

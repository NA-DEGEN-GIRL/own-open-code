// The rule-based proposal (06 §3.4): heavy folders by size and binary or LFS share, active named candidates adopted
// with their latest conversation, the install command and the code checks from the candidates; the V-rules accept it.

import { describe, expect, test } from "bun:test"
import type { Measure } from "../../src/git/measure.js"
import { JudgeFallback } from "../../src/judge/fallback.js"
import { JudgeValidate } from "../../src/judge/validate.js"

const MB = 1024 ** 2

function row(dir: string, bytes: number, extra: Partial<Measure.Row> = {}): Measure.Row {
  return {
    dir,
    depth: dir === "" ? 0 : dir.split("/").length,
    files: 10,
    gitBytes: bytes,
    lfsBytes: 0,
    lfsMissing: 0,
    bytes,
    bigFiles: 0,
    binaryRatio: 0,
    extensions: [],
    ...extra,
  }
}

function worktree(path: string, extra: Partial<JudgeValidate.Worktree> = {}): JudgeValidate.Worktree {
  return {
    path,
    class: "candidate",
    nested: false,
    branch: "x",
    head: "a".repeat(40),
    active: false,
    changes: 0,
    ahead: 0,
    sessions: [],
    updated: null,
    sparse: false,
    ...extra,
  }
}

const ROWS = [
  row("Assets", 900 * MB, { binaryRatio: 0.9 }),
  row("Assets/Textures", 600 * MB, { binaryRatio: 1 }),
  row("Assets/Models", 200 * MB, { lfsBytes: 200 * MB, binaryRatio: null }),
  row("Assets/Scripts", 100 * MB, { binaryRatio: 0.1 }),
  row("Content", 60 * MB, { binaryRatio: 0.95 }),
  row("src", 30 * MB, { binaryRatio: 0 }),
]

const FACTS: JudgeValidate.Facts = {
  target: "main",
  worktrees: [
    worktree("D:/w/home", { class: "home", branch: "main", active: true }),
    worktree("D:/w/.worktrees/cl-cu", { branch: "own-computer-use", active: true, sessions: ["ses_new", "ses_old"] }),
    worktree("D:/w/.worktrees/detached", { branch: null, active: true }),
    worktree("D:/w/.worktrees/local-model", { branch: "local-model-dev" }),
    worktree("D:/w/.claude/worktrees/x", { class: "other-tool", branch: "claude/x", active: true }),
  ],
  branches: ["main", "own-computer-use", "local-model-dev", "claude/x"],
  trees: new Set(["Assets", "Assets/Textures", "Assets/Models", "Assets/Scripts", "Content", "src"]),
  direct: { "": { files: 1, bytes: 1 }, src: { files: 100, bytes: 1 }, "Assets/Textures": { files: 10, bytes: 1 } },
  ignored: [],
  commands: [
    { name: "bun install", kind: "setup", command: { argv: ["bun", "install"] } },
    { name: "bun run build", kind: "code", command: { argv: ["bun", "run", "build"] } },
    { name: "bun run test", kind: "code", command: { argv: ["bun", "run", "test"] } },
    { name: "bun run typecheck", kind: "code", command: { argv: ["bun", "run", "typecheck"] } },
  ],
  retirable: new Set(),
  areas: [],
  mainSessionID: "ses_main",
}

describe("rule-based proposal", () => {
  test("heavy folders, adopted active branches, setup and checks, and a note", () => {
    const proposal = JudgeFallback.propose({ facts: FACTS, rows: ROWS })
    expect(proposal.heavy?.map((item) => item.dir)).toEqual(["Assets/Models", "Assets/Textures", "Content"])
    expect(proposal.heavy?.find((item) => item.dir === "Assets/Models")?.why).toBe("규칙: LFS 200 MB")
    expect(proposal.heavy?.find((item) => item.dir === "Content")?.why).toBe("규칙: 60 MB · 바이너리 95%")
    expect(proposal.areas).toEqual([
      {
        slug: "cl-cu",
        name: "cl-cu",
        adopt: { worktree: "D:/w/.worktrees/cl-cu", branch: "own-computer-use", owner: "ses_new" },
        create: null,
      },
    ])
    expect(proposal.commands).toEqual({ setup: "bun install", code: ["bun run typecheck", "bun run test"], assets: [] })
    expect(proposal.notes).toBe(JudgeFallback.NOTES)
  })

  test("passes the V-rules unchanged", () => {
    const validated = JudgeValidate.validate(JudgeFallback.propose({ facts: FACTS, rows: ROWS }), FACTS)
    expect(validated.rejected).toEqual([])
    expect(validated.heavy).toHaveLength(3)
    expect(validated.adopt.map((area) => [area.slug, area.owner, area.shape])).toEqual([["cl-cu", "ses_new", "full"]])
    expect(validated.commands.setup).toEqual({ argv: ["bun", "install"] })
    expect(validated.create).toEqual([])
  })

  test("a small code repository gets no heavy folders, no areas and no commands it does not have", () => {
    const proposal = JudgeFallback.propose({
      facts: { ...FACTS, worktrees: [FACTS.worktrees[0]!], commands: [] },
      rows: [row("src", 5 * MB)],
    })
    expect(proposal).toMatchObject({ heavy: [], areas: [], commands: { setup: null, code: [], assets: [] } })
  })
})

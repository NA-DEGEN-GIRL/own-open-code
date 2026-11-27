// The judge's answer and the V-rules (06 §3.4, §3.5): V1 decodes the text, V2–V13 drop, fix or truncate items over
// facts the program observed. One test per rule.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { OwnTeam } from "@own/protocol"
import { Classify } from "../../src/git/classify.js"
import { JudgeSchema } from "../../src/judge/schema.js"
import { JudgeValidate } from "../../src/judge/validate.js"
import { area } from "../support/context.js"

const HEAD = "a".repeat(40)

function worktree(
  path: string,
  kind: Classify.Class,
  extra: Partial<JudgeValidate.Worktree> = {},
): JudgeValidate.Worktree {
  return {
    path,
    class: kind,
    nested: false,
    branch: null,
    head: HEAD,
    active: false,
    changes: 0,
    ahead: 0,
    sessions: [],
    updated: null,
    sparse: false,
    ...extra,
  }
}

const WORKTREES = [
  worktree("D:/w/home", "home", { branch: "main", sessions: ["ses_home"] }),
  worktree("D:/#p/primary", "primary", { branch: "dev" }),
  worktree("D:/w/home/.claude/worktrees/x", "other-tool", { branch: "claude/x", nested: true }),
  worktree("D:/#p/hashed", "hash-path", { branch: "hashed" }),
  worktree("D:/w/gone", "prunable", { branch: "gone" }),
  worktree("D:/w/active", "candidate", {
    branch: "feat",
    active: true,
    ahead: 3,
    changes: 2,
    sessions: ["ses_new", "ses_old"],
  }),
  worktree("D:/w/sparse", "candidate", { branch: "sparse-one", active: true, sparse: true }),
  worktree("D:/w/idle", "candidate", { branch: "idle" }),
  worktree("D:/w/merged", "candidate", { branch: "merged" }),
]

function facts(extra: Partial<JudgeValidate.Facts> = {}): JudgeValidate.Facts {
  return {
    target: "main",
    worktrees: WORKTREES,
    branches: ["main", "dev", "feat", "sparse-one", "idle", "merged", "claude/x", "hashed", "gone", "taken"],
    trees: new Set(["src", "src/app", "docs", "Assets", "Assets/Textures", "Assets/Textures/UI", "Assets/Audio"]),
    direct: {
      "": { files: 2, bytes: 100 },
      src: { files: 10, bytes: 1_000 },
      "src/app": { files: 10, bytes: 1_000 },
      docs: { files: 5, bytes: 500 },
      Assets: { files: 1, bytes: 10 },
      "Assets/Textures": { files: 100, bytes: 10_000_000 },
      "Assets/Textures/UI": { files: 20, bytes: 1_000_000 },
      "Assets/Audio": { files: 50, bytes: 5_000_000 },
    },
    ignored: ["node_modules", "datasets", "data/cache"],
    commands: [
      { name: "bun install", kind: "setup", command: { argv: ["bun", "install"] } },
      { name: "bun run typecheck", kind: "code", command: { argv: ["bun", "run", "typecheck"] } },
      { name: "bun run test", kind: "code", command: { argv: ["bun", "run", "test"] } },
    ],
    retirable: new Set([Classify.key("D:/w/merged")]),
    areas: [],
    mainSessionID: "ses_main",
    ...extra,
  }
}

function proposal(extra: Partial<OwnTeam.Proposal> = {}): OwnTeam.Proposal {
  return { version: 1, ...extra }
}

const create = (slug: string, name = slug) => ({ slug, name, create: { from: "main" }, adopt: null })
const adopt = (slug: string, worktreePath: string, extra: { branch?: string; owner?: string } = {}) => ({
  slug,
  name: slug,
  adopt: { worktree: worktreePath, ...extra },
  create: null,
})

function rejectedItems(validated: JudgeValidate.Validated) {
  return validated.rejected.map((item) => item.item)
}

describe("V1 decode", () => {
  test("cuts the JSON object out of prose and code fences", () => {
    const parsed = JudgeSchema.parse(
      'Here is my proposal:\n```json\n{ "version": 1, "areas": [], "notes": "작은 일입니다" }\n```\nDone.',
    )
    expect(parsed).toEqual({ ok: true, proposal: { version: 1, areas: [], notes: "작은 일입니다" } })
  })

  test("a wrong shape lists the issues for the retry; no object at all is an error too", () => {
    const wrong = JudgeSchema.parse('{ "version": 2, "areas": "two" }')
    expect(wrong.ok).toBe(false)
    if (wrong.ok) return
    expect(wrong.errors.length).toBeGreaterThan(0)
    expect(wrong.errors.some((error) => error.includes("version") || error.includes("areas"))).toBe(true)
    expect(JudgeSchema.parse("영역은 0개가 좋겠습니다.")).toEqual({ ok: false, errors: ["답에 JSON 객체가 없습니다"] })
    expect(JudgeSchema.parse("{ not json }").ok).toBe(false)
  })
})

describe("V-rules", () => {
  test("V2: folders, branches and sessions must be in the inventory", () => {
    const validated = JudgeValidate.validate(
      proposal({
        areas: [
          adopt("ghost", "D:/w/ghost"),
          adopt("wrong-branch", "D:/w/active", { branch: "other" }),
          adopt("wrong-owner", "D:/w/active", { owner: "ses_elsewhere" }),
          adopt("ok", "d:\\W\\Active", { owner: "ses_old" }),
        ],
        leave: [{ worktree: "D:/w/nowhere", why: "x" }],
        suggest: [{ kind: "convert", worktree: "D:/w/nowhere", why: "x" }],
      }),
      facts(),
    )
    expect(rejectedItems(validated)).toEqual(["areas/0", "areas/1", "areas/2", "leave/0", "suggest/0"])
    expect(validated.adopt).toHaveLength(1)
    expect(validated.adopt[0]).toMatchObject({ worktree: "D:/w/active", branch: "feat", owner: "ses_old" })
  })

  test("V3: the main worktree, another tool's folder, a # path, a gone one and the home go to leave", () => {
    const validated = JudgeValidate.validate(
      proposal({
        areas: [
          adopt("a", "D:/#p/primary"),
          adopt("b", "D:/w/home/.claude/worktrees/x"),
          adopt("c", "D:/#p/hashed"),
          adopt("d", "D:/w/gone"),
          adopt("e", "D:/w/home"),
        ],
      }),
      facts(),
    )
    expect(validated.adopt).toEqual([])
    expect(validated.leave.map((item) => item.worktree)).toEqual([
      "D:/#p/primary",
      "D:/w/home/.claude/worktrees/x",
      "D:/#p/hashed",
      "D:/w/gone",
      "D:/w/home",
    ])
    expect(validated.leave.every((item) => item.why.startsWith("팀에 넣지 않는 폴더"))).toBe(true)
  })

  test("V4: a folder, branch or session in one area only; the main session is never an owner", () => {
    const validated = JudgeValidate.validate(
      proposal({
        areas: [
          adopt("first", "D:/w/active"),
          adopt("second", "D:/w/active"),
          adopt("main-owner", "D:/w/home", { owner: "ses_main" }),
        ],
      }),
      facts({
        worktrees: [
          ...WORKTREES.filter((item) => item.class !== "home"),
          worktree("D:/w/home", "candidate", {
            branch: "main",
            sessions: ["ses_main"],
          }),
        ],
      }),
    )
    expect(validated.adopt.map((area) => area.slug)).toEqual(["first"])
    expect(validated.rejected.map((item) => item.why)).toEqual([
      "이미 다른 영역에 있어요",
      "팀 메인 대화는 담당이 될 수 없어요",
    ])
    // An area of the team already holds its folder, branch and owner too.
    const again = JudgeValidate.validate(
      proposal({ areas: [adopt("x", "D:/w/idle")] }),
      facts({ areas: [{ slug: "idle", directory: "D:/w/idle", branch: "idle", owner: null }] }),
    )
    expect(again.adopt).toEqual([])
  })

  test("no area limit (V5 removed 2026-11-14): seven new areas are all kept, beside adopted and existing ones", () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((slug) => create(slug))
    const validated = JudgeValidate.validate(
      proposal({ areas: [adopt("x", "D:/w/active"), adopt("y", "D:/w/sparse"), ...seven] }),
      facts(),
    )
    expect(validated.adopt).toHaveLength(2)
    expect(validated.create.map((area) => area.slug)).toEqual(["a", "b", "c", "d", "e", "f", "g"])
    expect(validated.rejected).toEqual([])
    const existing = [1, 2, 3, 4, 5, 6].map((n) => ({
      slug: `old-${n}`,
      directory: `D:/t/old-${n}`,
      branch: `old-${n}`,
      owner: null,
    }))
    expect(JudgeValidate.validate(proposal({ areas: seven }), facts({ areas: existing })).create).toHaveLength(7)
  })

  test("V6: slugs are fixed, unique in the team, and a taken branch or folder gets -2", () => {
    const validated = JudgeValidate.validate(
      proposal({
        areas: [
          create("Inventory UI!", "인벤토리 화면"),
          create("inventory-ui"),
          create("taken"),
          create("", "세이브"),
          create("a-very-long-slug-that-goes-past-thirty-two-characters"),
          create("folder"),
        ],
      }),
      facts({ taken: ["Folder"] }),
    )
    expect(validated.create.map((area) => area.slug)).toEqual([
      "inventory-ui",
      "inventory-ui-2",
      "taken-2",
      "area",
      "a-very-long-slug-that-goes-past",
      "folder-2",
    ])
    expect(validated.create.every((area) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(area.slug))).toBe(true)
  })

  test("V7: heavy folders are trees of the target, not the root, outer first; a tiny cone warns", () => {
    const validated = JudgeValidate.validate(
      proposal({
        heavy: [
          { dir: "Assets/Textures/UI", why: "inside" },
          { dir: "/", why: "root" },
          { dir: "", why: "root" },
          { dir: "Missing", why: "not a tree" },
          { dir: "../outside", why: "escape" },
          { dir: "./Assets/Textures/", why: "그림" },
        ],
        areas: [{ ...create("ui"), needs: ["Assets/Textures/UI", "src", "Nope"] }],
      }),
      facts(),
    )
    expect(validated.heavy).toEqual([{ dir: "Assets/Textures", why: "그림" }])
    expect(validated.create[0]?.needs).toEqual(["Assets/Textures/UI"])
    expect(validated.warnings).toEqual([])
    expect(rejectedItems(validated)).toEqual([
      "heavy/1",
      "heavy/2",
      "heavy/4",
      "heavy/3",
      "heavy/0",
      "areas/0/needs/1",
      "areas/0/needs/2",
    ])
    const tiny = JudgeValidate.validate(
      proposal({ heavy: [{ dir: "src", why: "" }] }),
      facts({ direct: { "": { files: 0, bytes: 0 }, src: { files: 1_000, bytes: 1 }, docs: { files: 5, bytes: 1 } } }),
    )
    expect(tiny.warnings).toEqual(["V7: 코드 전용 범위가 전체 파일의 1% 미만입니다"])
  })

  test("V8: shared folders are ignored folders of the home and never tool caches", () => {
    const validated = JudgeValidate.validate(
      proposal({
        shared: [
          { dir: "datasets", why: "학습 데이터" },
          { dir: "data/cache/models", why: "가중치" },
          { dir: "node_modules", why: "의존성" },
          { dir: "src", why: "추적되는 폴더" },
        ],
      }),
      facts(),
    )
    expect(validated.shared.map((item) => item.dir)).toEqual(["datasets", "data/cache/models"])
    expect(rejectedItems(validated)).toEqual(["shared/2", "shared/3"])
  })

  test("V9: full only for an adopted full folder; plain without heavy folders", () => {
    const heavy = [{ dir: "Assets/Textures", why: "그림" }]
    const validated = JudgeValidate.validate(
      proposal({
        heavy,
        areas: [
          { ...create("new"), shape: "full" },
          { ...adopt("full-one", "D:/w/active"), shape: "code" },
          { ...adopt("sparse", "D:/w/sparse"), shape: "full" },
        ],
      }),
      facts(),
    )
    expect(validated.create.map((area) => area.shape)).toEqual(["code"])
    expect(validated.adopt.map((area) => area.shape)).toEqual(["full", "code"])
    const plain = JudgeValidate.validate(proposal({ areas: [{ ...create("new"), shape: "full" }] }), facts())
    expect(plain.create[0]?.shape).toBe("plain")
  })

  test("V10: commands only by name from the candidate list", () => {
    const validated = JudgeValidate.validate(
      proposal({
        commands: {
          setup: "bun install",
          code: ["bun run typecheck", "rm -rf /", "bun run typecheck", " bun run test "],
          assets: ["unity -batchmode"],
        },
      }),
      facts(),
    )
    expect(validated.commands).toEqual({
      setup: { argv: ["bun", "install"] },
      code: [{ argv: ["bun", "run", "typecheck"] }, { argv: ["bun", "run", "test"] }],
      assets: [],
    })
    expect(rejectedItems(validated)).toEqual(["commands/code/1", "commands/assets/0"])
    expect(JudgeValidate.validate(proposal({ commands: { setup: "curl x | sh" } }), facts()).commands.setup).toBeNull()
  })

  test("V11: suggestions are confirm-only in the plan; areas are auto", () => {
    const validated = JudgeValidate.validate(
      proposal({
        areas: [create("new"), adopt("old", "D:/w/active")],
        suggest: [{ kind: "convert", worktree: "D:/w/idle", why: "9 GB 절약" }],
      }),
      facts(),
    )
    expect(validated.plan.steps).toEqual([
      { item: "areas/1", kind: "area-adopt", mode: "auto", areaID: OwnTeam.AreaID.make("ar_old") },
      { item: "areas/0", kind: "area-create", mode: "auto", areaID: OwnTeam.AreaID.make("ar_new") },
      { item: "suggest/0", kind: "suggest-convert", mode: "confirm" },
    ])
  })

  test("V12: names 40, goals 1,000, notes 400 characters, without control characters; cut texts end in …", () => {
    const validated = JudgeValidate.validate(
      proposal({
        areas: [
          { ...create("long", "가".repeat(60)), goal: "목표\u0007줄\n바꿈" + "나".repeat(1_200) },
          { ...create("whole"), goal: "😀".repeat(1_000) },
        ],
        heavy: [{ dir: "Assets/Textures", why: "이유".repeat(150) }],
        notes: `알림\u0000${"다".repeat(500)}`,
      }),
      facts(),
    )
    const area = validated.create[0]
    expect([...(area?.name ?? "")]).toHaveLength(40)
    expect(area?.name.endsWith("…")).toBe(false)
    expect(area?.goal.startsWith("목표 줄 바꿈")).toBe(true)
    expect([...(area?.goal ?? "")]).toHaveLength(JudgeValidate.LIMITS.goal)
    expect(area?.goal.endsWith("나…")).toBe(true)
    // 1,000 code points stay whole; a cut never splits a surrogate pair.
    expect(validated.create[1]?.goal).toBe("😀".repeat(1_000))
    expect(validated.notes.startsWith("알림 다")).toBe(true)
    expect([...validated.notes]).toHaveLength(400)
    expect(validated.notes.endsWith("다…")).toBe(true)
    expect([...(validated.heavy[0]?.why ?? "")]).toHaveLength(JudgeValidate.LIMITS.why)
    expect(validated.heavy[0]?.why.endsWith("…")).toBe(true)
    expect(/[\u0000-\u001f]/.test(validated.notes + (area?.goal ?? ""))).toBe(false)
    expect(JudgeValidate.clean("😀".repeat(5), 3, true)).toBe("😀😀…")
  })

  test("V13: an active folder is never left quietly; retire only when the program verified it", () => {
    const validated = JudgeValidate.validate(
      proposal({
        leave: [
          { worktree: "D:/w/active", why: "그냥 둠" },
          { worktree: "D:/w/idle", why: "main과 같음" },
        ],
        suggest: [
          { kind: "retire", worktree: "D:/w/idle", why: "끝난 것 같음" },
          { kind: "retire", worktree: "D:/w/merged", why: "모두 반영됨" },
        ],
      }),
      facts(),
    )
    expect(validated.leave).toEqual([{ worktree: "D:/w/idle", why: "main과 같음" }])
    expect(validated.unadopted.map((item) => item.path)).toEqual(["D:/w/active", "D:/w/sparse"])
    expect(validated.suggest).toEqual([{ kind: "retire", worktree: "D:/w/merged", why: "모두 반영됨" }])
    expect(rejectedItems(validated)).toEqual(["leave/0", "suggest/0"])
    // Adopting an active folder takes it off the card list.
    const adopted = JudgeValidate.validate(proposal({ areas: [adopt("feat", "D:/w/active")] }), facts())
    expect(adopted.unadopted.map((item) => item.path)).toEqual(["D:/w/sparse"])
  })

  test("adopt and create are exclusive, and create.from names main or an earlier area", () => {
    const validated = JudgeValidate.validate(
      proposal({
        areas: [
          { slug: "both", name: "both", adopt: { worktree: "D:/w/active" }, create: { from: "main" } },
          { slug: "none", name: "none" },
          { ...create("first"), create: { from: "master" } },
          { ...create("second"), create: { from: "first" } },
          { ...create("third"), create: { from: "later" } },
          create("later"),
        ],
      }),
      facts({ target: "master" }),
    )
    expect(validated.create.map((area) => [area.slug, area.from])).toEqual([
      ["first", "main"],
      ["second", "first"],
      ["later", "main"],
    ])
    expect(rejectedItems(validated)).toEqual(["areas/0", "areas/1", "areas/4"])
  })
})

describe("reorganize: what only the user sets (영역 만들기, 2026-10-26)", () => {
  const MAIN = Schema.decodeUnknownSync(Model.Ref)({ providerID: "anthropic", id: "claude-opus" })
  const op = {
    op: "new" as const,
    slug: "monster-assets",
    name: "몬스터 에셋",
    goal: "몬스터 그림".repeat(30),
    main: MAIN,
    harness: { id: "codex" as const, prompt: "own" as const },
    userMade: true as const,
  }
  const row = { slug: "sim", name: "시뮬레이션", adopt: { worktree: "D:/w/active" }, userMade: true as const }
  const reorgFacts = (inventory?: JudgeValidate.Facts): JudgeValidate.ReorgFacts => ({
    target: "main",
    areas: [],
    heavy: [],
    ...(inventory === undefined ? {} : { inventory }),
  })

  test("a new area keeps its model, 에이전트 방식 and mark for the user; its whole role is kept", () => {
    const made = JudgeValidate.reorganize(proposal({ ops: [op] }), reorgFacts(), "user")
    expect(made.actions).toEqual([
      {
        item: "ops/0",
        action: "new",
        slug: "monster-assets",
        name: "몬스터 에셋",
        goal: op.goal,
        needs: [],
        from: "main",
        main: MAIN,
        harness: { id: "codex", prompt: "own" },
        userMade: true,
      },
    ])
  })

  test("the main keeps only the mark (a standing role, 2026-11-14); the judge sets none of them", () => {
    const main = JudgeValidate.reorganize(proposal({ ops: [op] }), reorgFacts(), "main").actions[0]
    expect(main).toMatchObject({ action: "new", slug: "monster-assets", userMade: true })
    expect(main && "main" in main).toBe(false)
    expect(main && "harness" in main).toBe(false)
    const judge = JudgeValidate.reorganize(proposal({ ops: [op] }), reorgFacts(), "auto").actions[0]
    expect(judge).toMatchObject({ action: "new", slug: "monster-assets" })
    expect(judge && "main" in judge).toBe(false)
    expect(judge && "harness" in judge).toBe(false)
    expect(judge && "userMade" in judge).toBe(false)
  })

  test("a role of 1,000 characters is kept; the user's or the main's over it is refused with the count, the judge's cut", () => {
    const at = (goal: string) => ({ ...op, goal })
    const split = (goal: string) => ({ op: "split" as const, area: "ui", slug: "ui-two", name: "둘", goal })
    const facts = { ...reorgFacts(), areas: [area({ slug: "ui", directory: "D:/w/ui" })] }
    for (const by of ["user", "main"] as const) {
      const kept = JudgeValidate.reorganize(proposal({ ops: [at("가".repeat(1_000))] }), reorgFacts(), by)
      expect(kept.actions[0], by).toMatchObject({ goal: "가".repeat(1_000) })
      const long = JudgeValidate.reorganize(
        proposal({ ops: [at("가".repeat(1_001)), split("나".repeat(1_200))] }),
        facts,
        by,
      )
      expect(long.actions, by).toEqual([])
      expect(long.rejected, by).toEqual([
        { item: "ops/0", why: "역할은 1,000자까지예요(지금 1,001자)" },
        { item: "ops/1", why: "역할은 1,000자까지예요(지금 1,200자)" },
      ])
    }
    const judge = JudgeValidate.reorganize(
      proposal({ ops: [at("가".repeat(1_001)), split("나".repeat(1_200))] }),
      facts,
      "auto",
    )
    expect(judge.rejected).toEqual([])
    for (const action of judge.actions) {
      const goal = action.action === "new" || action.action === "split" ? action.goal : ""
      expect([...goal]).toHaveLength(JudgeValidate.LIMITS.goal)
      expect(goal.endsWith("…")).toBe(true)
    }
  })

  test("no area limit for a reorganization either: seven new areas and a split are all planned", () => {
    const facts = { ...reorgFacts(), areas: [area({ slug: "ui", directory: "D:/w/ui" })] }
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((slug) => ({ op: "new" as const, slug, name: slug }))
    const made = JudgeValidate.reorganize(
      proposal({ ops: [...seven, { op: "split", area: "ui", slug: "ui-two", name: "둘" }] }),
      facts,
      "main",
    )
    expect(made.rejected).toEqual([])
    expect(made.actions.map((action) => `${action.action}`)).toEqual([...seven.map(() => "new"), "split"])
  })

  test("an adopt row carries the mark only for the user", () => {
    const user = JudgeValidate.reorganize(proposal({ areas: [row] }), reorgFacts(facts()), "user")
    expect(user.actions).toMatchObject([{ item: "areas/0", action: "adopt", userMade: true }])
    const main = JudgeValidate.reorganize(proposal({ areas: [row] }), reorgFacts(facts()), "main")
    expect(main.actions).toMatchObject([{ item: "areas/0", action: "adopt" }])
    expect(main.actions[0] && "userMade" in main.actions[0]).toBe(false)
  })

  test("the user's own adopt row is the area of the typed name, its record name after the folder (06 §8.2)", () => {
    const user = JudgeValidate.reorganize(proposal({ areas: [row] }), reorgFacts(facts()), "user")
    expect(user.actions).toMatchObject([
      { action: "adopt", adopt: { slug: "sim", name: "시뮬레이션", subtitle: "", worktree: "D:/w/active" } },
    ])
    // The main's or the judge's row (or one without the mark) keeps 3.7: the folder's name, the given name below it.
    for (const [by, areas] of [
      ["main", [row]],
      ["user", [{ ...row, userMade: undefined }]],
    ] as const) {
      const made = JudgeValidate.reorganize(proposal({ areas }), reorgFacts(facts()), by)
      expect(made.actions, by).toMatchObject([{ action: "adopt", adopt: { name: "active", subtitle: "시뮬레이션" } }])
    }
  })

  test("a conversation move the main wrote stays a suggestion whoever runs it (V11, 2026-10-27)", () => {
    const move = { op: "move" as const, sessionID: "ses_user0000000000000000000001", area: "ui" }
    const areas = [area({ slug: "ui", directory: "D:/w/ui" })]
    const facts = { ...reorgFacts(), areas }
    const main = JudgeValidate.reorganize(proposal({ ops: [move] }), facts, "main")
    expect(main.actions).toEqual([])
    expect(main.rejected).toEqual([{ item: "ops/0", why: JudgeValidate.MOVE_REFUSED }])
    expect(main.suggest).toMatchObject([{ kind: "move", area: "ui" }])
    expect(JudgeValidate.reorganize(proposal({ ops: [move] }), facts, "user").actions).toMatchObject([
      { item: "ops/0", action: "move", areaID: "ar_ui" },
    ])
  })
})

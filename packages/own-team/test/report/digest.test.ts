// The digest and team_report (06 §5.4–5.6, §2.8): the team update worded from the registry and the fold (status
// words, the owner's latest report, direct user talk with its 담당 요약, Main 멈춤 with waiting requests, `할 일:`),
// an owner's view of its own area with a team summary, the 2k-token bound, `team_status` without side effects, the
// predicted conflicts between areas (`반영 때 충돌 예상`, kept per SHA pair, never waking), and `team_report`
// (progress and done folded, ready checked for uncommitted tracked changes and recorded as the candidate, blocked and
// ready waking, only from the current owner).

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { OwnTeam } from "@own/protocol"
import type { Hub } from "../../src/hub.js"
import { Direct } from "../../src/dispatch/direct.js"
import { Talk } from "../../src/dispatch/talk.js"
import { Merge } from "../../src/integrate/merge.js"
import { Digest } from "../../src/report/digest.js"
import { DIRTY, ReportEvents } from "../../src/report/events.js"
import { Fold } from "../../src/report/fold.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { ReportTool } from "../../src/tools/report.js"
import { StatusTool } from "../../src/tools/status.js"
import { Texts } from "../../src/report/texts.js"
import { manual } from "../support/clock.js"
import {
  MAIN_SESSION,
  OLD_OWNER,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  controller,
  team,
  tempHome,
} from "../support/context.js"
import { type FakeService, start } from "../support/service.js"
import { commit, git, init, temp, write } from "../fixtures/repo.js"

const services: FakeService[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterAll(async () => {
  for (const service of services) await service.stop()
  for (const cleanup of cleanups) await cleanup()
})

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)
const MINUTE = 60_000
/** Git fixtures start several processes (slow on Windows). */
const SLOW = 120_000
const INVENTORY = OwnTeam.AreaID.make("ar_inventory")
const SAVE = OwnTeam.AreaID.make("ar_save")
const DOCS = OwnTeam.AreaID.make("ar_docs")
const SAVE_OWNER = SessionID.make("ses_owner000000000000000000002")
const DOCS_OWNER = SessionID.make("ses_owner000000000000000000003")
const USER_TALK = SessionID.make("ses_user0000000000000000000001")

async function setup(input: { readonly home?: string } = {}) {
  const home = await tempHome()
  cleanups.push(() => home[Symbol.asyncDispose]())
  const root = input.home ?? home.root
  const world = new World()
  const clock = manual(T0)
  const service = start()
  services.push(service)
  const inboxes = new Map<string, unknown[]>()
  const messages = new Map<string, unknown[]>()
  for (const id of [MAIN_SESSION, OWNER_SESSION, SAVE_OWNER, DOCS_OWNER, USER_TALK]) {
    service.routes.set(`GET /api/session/${id}/inbox`, () => Response.json({ data: inboxes.get(id) ?? [] }))
    service.routes.set(`GET /api/session/${id}/message`, () =>
      Response.json({ data: messages.get(id) ?? [], cursor: {} }),
    )
  }
  const harness = controller(world, { directory: root, clock, source: service.source })
  await harness.services.write(TEAM_ID, async () => {
    await harness.services.registry.teams.put(team({ home: root }))
  })
  await harness.controller.resume()
  return { world, clock, service, inboxes, messages, root, ...harness }
}

type Harness = Awaited<ReturnType<typeof setup>>

async function putArea(h: Harness, value: OwnTeam.Area) {
  await h.services.write(TEAM_ID, () => h.services.registry.areas.put(value))
}

async function putDispatch(
  h: Harness,
  input: {
    readonly areaID: OwnTeam.AreaID
    readonly seq: number
    readonly sentAt?: number
    readonly owner?: SessionID
  },
) {
  const id = OwnTeam.DispatchID.create()
  await h.services.write(TEAM_ID, () =>
    h.services.registry.dispatches.put({
      id,
      teamID: TEAM_ID,
      areaID: input.areaID,
      seq: input.seq,
      from: "main",
      kind: "task",
      text: "일",
      state: input.sentAt === undefined ? "waiting" : "sent",
      ...(input.sentAt === undefined || input.owner === undefined
        ? {}
        : {
            sentTo: {
              sessionID: input.owner,
              msgID: SessionMessage.ID.make(`msg_${id.slice(3).toLowerCase()}`),
              at: input.sentAt,
            },
          }),
      createdAt: input.sentAt ?? T0,
    }),
  )
}

async function fold(h: Harness, change: (state: Fold.State) => Fold.State) {
  await h.services.write(TEAM_ID, async () =>
    Digest.save(h.services.kv, change(await Digest.load(h.services.kv, TEAM_ID))),
  )
}

/** Three areas as in the 06 §5.6 example: ready, talked to directly under Main 멈춤, working. */
async function example(h: Harness) {
  await putArea(h, {
    ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
    name: "인벤토리 화면",
    status: { kind: "ready", at: T0 + MINUTE, text: "" },
    candidate: { sha: "b".repeat(40), at: T0 + MINUTE, text: "정렬 수정과 테스트 3개" },
  })
  await putArea(h, {
    ...area({ slug: "save", directory: path.join(h.root, "save") }),
    name: "세이브 v3",
    owner: { sessionID: SAVE_OWNER, previous: [], attached: true },
    paused: "user",
    direct: { at: T0 + 5 * MINUTE, sessionID: USER_TALK },
  })
  await putArea(h, {
    ...area({ slug: "docs", directory: path.join(h.root, "docs") }),
    name: "문서",
    owner: { sessionID: DOCS_OWNER, previous: [], attached: true },
    status: { kind: "busy", at: T0, text: "" },
  })
  await putDispatch(h, { areaID: INVENTORY, seq: 0, sentAt: T0, owner: OWNER_SESSION })
  await putDispatch(h, { areaID: SAVE, seq: 0 })
  await putDispatch(h, { areaID: DOCS, seq: 0, sentAt: T0, owner: DOCS_OWNER })
  h.inboxes.set(SAVE_OWNER, [
    {
      id: "msg_parked",
      sessionID: SAVE_OWNER,
      type: "user",
      delivery: "queue",
      payload: { text: "<dispatch>", metadata: { [OwnTeam.DISPATCH_META]: { id: "dp_x" } } },
    },
  ])
  await fold(h, (state) =>
    Fold.report(
      Fold.report(state, { areaID: INVENTORY, kind: "ready", text: "정렬 수정과 테스트 3개", at: T0 + MINUTE }),
      { areaID: SAVE, kind: "progress", text: "필드 이름을 snake_case로 바꿈", at: T0 + 6 * MINUTE },
    ),
  )
  h.clock.advance(12 * MINUTE)
}

describe("the team update text (06 §5.6)", () => {
  // 2026-11-14: the 담당 요약 of a direct talk only with `directTell: "always"` (the summary test below); with the
  // default the owner's report after the talk stays on the line (the fixture team holds no direct work).
  test("the main's view: each area's state, report, direct talk, Main 멈춤 and waiting requests, then 할 일", async () => {
    const h = await setup()
    await example(h)
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(text.split("\n")).toEqual([
      "영역 3개 · 맡긴 일 3개 중 1개 끝남",
      "- 문서: 작업 중(12분째)",
      '- 인벤토리 화면: 반영 준비됨 · 담당: "정렬 수정과 테스트 3개"',
      `- 세이브 v3: 쉬는 중 · 담당: "필드 이름을 snake_case로 바꿈" · 사용자가 직접 대화함(${Talk.clock(T0 + 5 * MINUTE)}) · 메인 멈춤 · 요청 2개 기다림`,
      '할 일: 인벤토리 화면 반영 가능 → team_integrate("inventory")',
    ])
    await h.close()
  })

  test("an owner's view: its own area and a one-line team summary, no other areas and no 할 일", async () => {
    const h = await setup()
    await example(h)
    const text = await h.services.features().digest.render({ teamID: TEAM_ID, areaID: SAVE })
    expect(text.split("\n")).toEqual([
      "팀: 영역 3개 · 반영 준비됨 1 · 작업 중 1 · 쉬는 중 1 · 맡긴 일 3개 중 1개 끝남",
      `- 세이브 v3: 쉬는 중 · 담당: "필드 이름을 snake_case로 바꿈" · 사용자가 직접 대화함(${Talk.clock(T0 + 5 * MINUTE)}) · 메인 멈춤 · 요청 2개 기다림`,
    ])
    await h.close()
  })

  test("the owner's note (담당 메모) is in no digest text: `team_status` says it once, on its roster line", async () => {
    const h = await setup()
    const peer: OwnTeam.Peer = {
      key: "reviewer",
      sessionID: SessionID.make("ses_peer0000000000000000000001"),
      label: "리뷰어",
      role: "보안 위주로 읽는다",
      attached: true,
      origin: "registered",
      at: T0,
    }
    await putArea(h, {
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      owner: { sessionID: OWNER_SESSION, previous: [], attached: true, note: "화면을 만들고 반영을 맡는다" },
      peers: [peer],
    })
    const render = h.services.features().digest.render
    for (const viewer of [undefined, {}, { peer: "reviewer" }])
      expect(
        (await render({ teamID: TEAM_ID, areaID: INVENTORY, ...(viewer ? { viewer } : {}) })).split("\n").slice(0, 3),
      ).toEqual(["팀: 영역 1개 · 쉬는 중 1", "- inventory: 쉬는 중", "  · 동료 리뷰어: 쉬는 중"])
    expect(await render({ teamID: TEAM_ID })).not.toContain("화면을 만들고")
    await h.close()
  })

  test("without a report after the direct talk, the summary is the start of that conversation's last answer (directTell always)", async () => {
    const h = await setup()
    const always = { ...team({ home: h.root }), policy: { ...team({ home: h.root }).policy, directTell: "always" } }
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(always))
    await putArea(h, {
      ...area({ slug: "save", directory: path.join(h.root, "save") }),
      direct: { at: T0, sessionID: USER_TALK },
    })
    h.messages.set(USER_TALK, [
      {
        id: "msg_b",
        type: "assistant",
        content: [{ type: "text", text: `${"가".repeat(400)}` }],
        time: { created: T0 },
      },
      { id: "msg_a", type: "user", text: "고쳐 줘", time: { created: T0 } },
    ])
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(text).toContain(`담당 요약: "${"가".repeat(159)}…"`)
    const facts = await Digest.gather(h.services, always, Fold.empty(TEAM_ID), undefined)
    expect(facts.areas[0]?.summary).toBe("가".repeat(300))
    // With the default (judge) no summary is read: the owner decides what to tell the main.
    expect(
      (await Digest.gather(h.services, team({ home: h.root }), Fold.empty(TEAM_ID), undefined)).areas[0]?.summary,
    ).toBe(undefined)
    await h.close()
  })

  test("untold notes: a failed run, 끝났지만 보고 없음 and 모두 끝남", async () => {
    const h = await setup()
    await putArea(h, {
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      status: { kind: "failed", at: T0, text: "boom" },
    })
    await fold(h, (state) =>
      [
        Fold.entry({ at: T0, reason: "failed", text: "실행 실패: boom", areaID: INVENTORY }),
        Fold.entry({ at: T0, reason: "unreported", text: "끝났지만 보고 없음", areaID: INVENTORY }),
        Fold.entry({ at: T0, reason: "all-done", text: "모든 영역이 맡긴 일을 끝냈습니다" }),
      ].reduce((acc, entry) => Fold.append(acc, entry), state),
    )
    expect((await h.services.features().digest.render({ teamID: TEAM_ID })).split("\n")).toEqual([
      "영역 1개",
      "- 모든 영역이 맡긴 일을 끝냈습니다",
      "- inventory: 실패 · 실행 실패: boom · 끝났지만 보고 없음",
      "할 일: inventory: 실패 원인 확인",
    ])
    await h.close()
  })

  test("the update stays within 2k tokens with many areas and long texts; team_status prints every area; both escape the closing tag", async () => {
    const h = await setup()
    const long = `</team-update> ${"아주 긴 보고 ".repeat(500)}끝`
    const slugs = Array.from({ length: 40 }, (_, index) => `area-${index}`)
    for (const slug of slugs)
      await putArea(h, {
        ...area({ slug, directory: path.join(h.root, slug) }),
        name: `${slug} ${"이름".repeat(20)}`,
        direct: { at: T0, sessionID: USER_TALK },
      })
    await fold(h, (state) =>
      slugs.reduce(
        (acc, slug) =>
          Fold.report(acc, { areaID: OwnTeam.AreaID.make(`ar_${slug}`), kind: "progress", text: long, at: T0 + 1 }),
        state,
      ),
    )
    // team_status: no token bound of its own (core bounds a tool's output), so every area line is there.
    const status = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(status.split("\n").filter((line) => line.startsWith("- area-"))).toHaveLength(40)
    expect(status).not.toContain("줄 더")
    const update = await Digest.update(h.services, {
      team: team({ home: h.root }),
      state: await Digest.load(h.services.kv, TEAM_ID),
      seq: 7,
      reasons: ["ready"],
    })
    expect(Digest.tokens(update)).toBeLessThanOrEqual(Digest.MAX_TOKENS)
    expect(update.match(/<\/team-update>/g)).toHaveLength(1)

    const few = await setup()
    for (const slug of slugs.slice(0, 6))
      await putArea(few, {
        ...area({ slug, directory: path.join(few.root, slug) }),
        direct: { at: T0, sessionID: USER_TALK },
      })
    await fold(few, (state) =>
      slugs
        .slice(0, 6)
        .reduce(
          (acc, slug) =>
            Fold.report(acc, { areaID: OwnTeam.AreaID.make(`ar_${slug}`), kind: "progress", text: long, at: T0 + 1 }),
          state,
        ),
    )
    const six = await few.services.features().digest.render({ teamID: TEAM_ID })
    // Six area lines under the head, and the note that cut quotes are whole in team_status{area}.
    expect(six.split("\n")).toHaveLength(8)
    expect(six.split("\n").at(-1)).toBe(Digest.CUT_NOTE)
    expect(six).toContain("<\\/team-update>")
    await h.close()
    await few.close()
  })

  test("adding a waking entry plans the wake; a fold does not", async () => {
    const h = await setup()
    await h.services.features().digest.add(TEAM_ID, Fold.entry({ at: T0, reason: "progress", text: "" }))
    expect(Fold.due(await Digest.load(h.services.kv, TEAM_ID))).toBeUndefined()
    await h.services.features().digest.add(TEAM_ID, Fold.entry({ at: T0, reason: "blocked", text: "" }))
    expect(Fold.due(await Digest.load(h.services.kv, TEAM_ID))).toBe(T0 + Fold.DEBOUNCE_MS)
    await h.close()
  })
})

describe("area messages in the main's update (06 §5.8)", () => {
  test("the audit lines come after 할 일 and never wake; fit drops them first; a sent update marks them told", async () => {
    const h = await setup()
    await putArea(h, {
      ...area({ slug: "inventory", directory: path.join(h.root, "inv") }),
      name: "인벤토리 화면",
      status: { kind: "blocked", at: T0, text: "" },
    })
    await fold(h, (state) =>
      Fold.append(state, Fold.entry({ at: T0, areaID: INVENTORY, reason: "blocked", text: "결정이 필요합니다" })),
    )
    await h.services.write(TEAM_ID, async () =>
      Talk.save(
        h.services.kv,
        TEAM_ID,
        [1, 2].reduce(
          (state, index) =>
            Talk.line(state, { at: T0 + index, text: `'인벤토리 화면' → '세이브 v3 담당' 물음: "${index}"` }),
          Talk.empty(),
        ),
      ),
    )
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    const lines = text.split("\n")
    const todo = lines.findIndex((line) => line.startsWith("할 일:"))
    expect(lines.slice(todo + 1)).toEqual([
      "영역 메시지 2건:",
      `  · ${Talk.clock(T0 + 1)} '인벤토리 화면' → '세이브 v3 담당' 물음: "1"`,
      `  · ${Talk.clock(T0 + 2)} '인벤토리 화면' → '세이브 v3 담당' 물음: "2"`,
    ])
    expect(lines.filter((line) => line.startsWith("- ")).map((line) => line.includes("물음"))).not.toContain(true)
    // Over budget: the talk lines go before anything the main acts on.
    const facts = await Digest.gather(
      h.services,
      team({ home: h.root }),
      await Digest.load(h.services.kv, TEAM_ID),
      undefined,
    )
    const tight = Digest.fit(facts, Digest.tokens(lines.slice(0, todo + 1).join("\n")) + 20)
    expect(tight).toContain("할 일:")
    expect(tight).not.toContain("영역 메시지 2건:")
    // An update that carried them up to line 0 leaves the second for the next one.
    await h.services.write(TEAM_ID, async () =>
      Talk.save(h.services.kv, TEAM_ID, Talk.told(await Talk.load(h.services.kv, TEAM_ID), 0)),
    )
    expect(await h.services.features().digest.render({ teamID: TEAM_ID })).toContain("영역 메시지 1건:")
    await h.close()
  })
})

describe("team_status (06 §2.8)", () => {
  test("the main gets the whole team or one area, an owner its own area; nothing is written", async () => {
    const h = await setup()
    await example(h)
    const before = JSON.stringify([...h.world.kv.entries()])
    const main = { role: "main" as const, team: team({ home: h.root }), sessionID: MAIN_SESSION }
    const whole = await StatusTool.run(h.services, main, {})
    expect(whole.text).toContain("할 일:")
    expect(whole.text).toContain("사용자가 직접 대화함")
    expect(whole.text).toContain("메인 멈춤 · 요청 2개 기다림")
    const one = await StatusTool.run(h.services, main, { area: "save" })
    // The digest's excerpt of its report, marked: the report predates the area's whole texts (2026-11-14).
    expect(one.text.split("\n").slice(2)).toEqual([
      `담당 보고(progress, ${Talk.clock(T0 + 6 * MINUTE)})(전문 없음):`,
      "필드 이름을 snake_case로 바꿈",
    ])
    const saveArea = await h.services.registry.areas.get(TEAM_ID, SAVE)
    if (!saveArea) throw new Error("no area")
    const owner = await StatusTool.run(
      h.services,
      { role: "owner", team: team({ home: h.root }), area: saveArea, sessionID: SAVE_OWNER },
      { area: "inventory" },
    )
    // An owner's view adds the other areas (06 §5.8, 2026-10-16); the main's view of one area stays as it was.
    expect(owner.text.startsWith(`${one.text.split("\n").slice(0, 2).join("\n")}\n다른 영역:\n`)).toBe(true)
    expect(owner.text).not.toContain("인벤토리 화면:")
    expect(JSON.stringify([...h.world.kv.entries()])).toBe(before)
    await h.close()
  })
})

describe("predicted conflicts (06 §5.6 반영 때 충돌 예상)", () => {
  /** A repository whose `main` has `src/a.ts`, `src/b.ts` and `README.md`; each branch commits its files on it. */
  async function withBranches(branches: Record<string, Record<string, string>>) {
    const tmp = temp("own-team-conflict-")
    cleanups.push(tmp.dispose)
    const repo = init(path.join(tmp.root, "repo"))
    write(repo, { "src/a.ts": "export const a = 1\n", "src/b.ts": "export const b = 1\n", "README.md": "# app\n" })
    commit(repo, "base")
    for (const [branch, files] of Object.entries(branches)) {
      git(repo, ["checkout", "-q", "-b", branch, "main"])
      write(repo, files)
      commit(repo, branch)
    }
    git(repo, ["checkout", "-q", "main"])
    const h = await setup({ home: repo })
    for (const slug of Object.keys(branches)) await putArea(h, area({ slug, directory: path.join(repo, slug) }))
    return { h, repo }
  }

  test(
    "pairs of areas ahead of the target that conflict share one line in the update and team_status; nothing is written or woken",
    async () => {
      const { h, repo } = await withBranches({
        inventory: { "src/a.ts": "export const a = 2\n" },
        save: { "src/a.ts": "export const a = 3\n", "src/b.ts": "export const b = 3\n" },
        docs: { "README.md": "# docs\n" },
      })
      // An area with no commits of its own (its branch is the target's) and one whose branch is gone take no part.
      git(repo, ["branch", "old", "main"])
      await putArea(h, area({ slug: "old", directory: path.join(repo, "old") }))
      await putArea(h, area({ slug: "gone", directory: path.join(repo, "gone") }))
      const listed = await Merge.ahead({
        repo: path.join(repo, ".git"),
        target: "main",
        branches: ["docs", "gone", "inventory", "old", "save"],
      })
      expect(listed.ok ? [...listed.tips.keys()].toSorted() : listed).toEqual(["docs", "inventory", "save"])
      const before = JSON.stringify([...h.world.kv.entries()])
      expect((await h.services.features().digest.render({ teamID: TEAM_ID })).split("\n")).toEqual([
        "영역 5개",
        "- docs: 쉬는 중",
        "- gone: 쉬는 중",
        "- inventory: 쉬는 중",
        "- old: 쉬는 중",
        "- save: 쉬는 중",
        "반영 때 충돌 예상: inventory ↔ save(src/a.ts)",
      ])
      const update = await Digest.update(h.services, {
        team: team({ home: repo }),
        state: await Digest.load(h.services.kv, TEAM_ID),
        seq: 1,
        reasons: ["ready"],
      })
      expect(update).toContain("\n반영 때 충돌 예상: inventory ↔ save(src/a.ts)\n")
      // An owner sees only the pairs with its own area.
      const save = await h.services.features().digest.render({ teamID: TEAM_ID, areaID: SAVE })
      expect(save.split("\n").at(-1)).toBe("반영 때 충돌 예상: inventory ↔ save(src/a.ts)")
      expect(await h.services.features().digest.render({ teamID: TEAM_ID, areaID: DOCS })).not.toContain(
        Digest.CONFLICT,
      )
      expect(JSON.stringify([...h.world.kv.entries()])).toBe(before)
      expect(Fold.due(await Digest.load(h.services.kv, TEAM_ID))).toBeUndefined()
      expect(git(repo, ["status", "--porcelain"])).toBe("")

      // Kept per SHA pair: a new commit on docs is checked again.
      git(repo, ["checkout", "-q", "docs"])
      write(repo, { "src/a.ts": "export const a = 4\n" })
      commit(repo, "docs touches a")
      git(repo, ["checkout", "-q", "main"])
      const lines = async () => (await h.services.features().digest.render({ teamID: TEAM_ID })).split("\n")
      expect((await lines()).at(-1)).toBe(
        "반영 때 충돌 예상: docs ↔ inventory(src/a.ts) · docs ↔ save(src/a.ts) · inventory ↔ save(src/a.ts)",
      )
      // Once inventory is in the target, save conflicts with the target, not with an area (7.3 handles that).
      git(repo, ["merge", "-q", "--ff-only", "inventory"])
      expect((await lines()).at(-1)).toBe("반영 때 충돌 예상: docs ↔ save(src/a.ts)")
      await h.close()
    },
    SLOW,
  )

  test(
    "one text asks at most NEW_PAIRS new pairs; the line names five pairs and counts the rest",
    async () => {
      const slugs = ["p1", "p2", "p3", "p4", "p5"]
      const { h, repo } = await withBranches(
        Object.fromEntries(
          slugs.map((slug) => [slug, { "src/a.ts": `export const a = "${slug}"\n`, "src/b.ts": `// ${slug}\n` }]),
        ),
      )
      const line = async () => (await h.services.features().digest.render({ teamID: TEAM_ID })).split("\n").at(-1)
      const named =
        "p1 ↔ p2(src/a.ts 외 1개) · p1 ↔ p3(src/a.ts 외 1개) · p1 ↔ p4(src/a.ts 외 1개) · p1 ↔ p5(src/a.ts 외 1개) · p2 ↔ p3(src/a.ts 외 1개)"
      expect(Digest.NEW_PAIRS).toBe(6)
      expect(await line()).toBe(`반영 때 충돌 예상: ${named} 외 1쌍`)
      expect(await line()).toBe(`반영 때 충돌 예상: ${named} 외 5쌍`)
      const tips = slugs.map((slug) => git(repo, ["rev-parse", `refs/heads/${slug}`]).trim())
      const attrs = git(repo, ["rev-parse", "refs/heads/main"]).trim()
      expect(
        tips.every((a, index) =>
          tips.slice(index + 1).every((b) => Merge.predicted({ repo: path.join(repo, ".git"), attrs, a: b, b: a })),
        ),
      ).toBe(true)
      await h.close()
    },
    SLOW,
  )
})

describe("team_report (06 §5.5)", () => {
  async function withRepo() {
    const tmp = temp("own-team-report-")
    cleanups.push(tmp.dispose)
    const repo = init(path.join(tmp.root, "repo"))
    write(repo, { "src/a.ts": "export const a = 1\n" })
    commit(repo, "base")
    git(repo, ["checkout", "-q", "-b", "inventory"])
    write(repo, { "src/a.ts": "export const a = 2\n" })
    commit(repo, "sort fix")
    const h = await setup({ home: repo })
    await putArea(h, area({ slug: "inventory", directory: repo }))
    const changes: Hub.Outgoing[] = []
    h.services.hub.subscribe((event) => {
      if (event.name === "area.changed") changes.push(event)
    })
    return { h, repo, changes }
  }

  const report = (h: Harness, kind: Fold.ReportKind, text: string, sessionID = OWNER_SESSION) =>
    h.services.features().events.report({ teamID: TEAM_ID, areaID: INVENTORY, sessionID, kind, text })

  test("progress and done fold without waking and leave the status", async () => {
    const h = await setup()
    await putArea(h, { ...area({ slug: "inventory", directory: h.root }), status: { kind: "busy", at: T0, text: "" } })
    expect(await report(h, "progress", "절반 함")).toMatchObject({ ok: true, text: "팀 소식에 적었습니다." })
    expect(await report(h, "done", "끝")).toMatchObject({ ok: true })
    const state = await Digest.load(h.services.kv, TEAM_ID)
    expect(state.entries.map((item) => [item.reason, item.wake])).toEqual([
      ["progress", false],
      ["done", false],
    ])
    expect(Fold.area(state, INVENTORY).reports).toMatchObject({ progress: { text: "절반 함" }, done: { text: "끝" } })
    expect(Fold.due(state)).toBeUndefined()
    expect((await h.services.registry.areas.get(TEAM_ID, INVENTORY))?.status.kind).toBe("busy")
    await h.close()
  })

  test(
    "ready refuses uncommitted tracked changes and changes nothing",
    async () => {
      const { h, repo } = await withRepo()
      write(repo, { "src/a.ts": "export const a = 3\n", "notes.txt": "untracked is fine\n" })
      const before = JSON.stringify([...h.world.kv.entries()])
      const refused = await report(h, "ready", "다 됨")
      expect(refused).toMatchObject({ ok: false, error: "dirty", data: { count: 1, paths: ["src/a.ts"] } })
      expect(refused.ok ? "" : refused.message.startsWith(DIRTY)).toBe(true)
      expect(JSON.stringify([...h.world.kv.entries()])).toBe(before)
      // Through the tool the owner reads the sentence.
      const current = await h.services.registry.areas.get(TEAM_ID, INVENTORY)
      if (!current) throw new Error("no area")
      const answer = await ReportTool.run(
        h.services,
        { role: "owner", team: team({ home: repo }), area: current, sessionID: OWNER_SESSION },
        { kind: "ready", text: "다 됨" },
      )
      expect(answer).toMatchObject({ ok: false, error: "dirty" })
      expect(answer.text.startsWith(DIRTY)).toBe(true)
      await h.close()
    },
    SLOW,
  )

  test(
    "a changed link copy is uncommitted too (06 §4.12)",
    async () => {
      const { h, repo } = await withRepo()
      write(repo, { "link.txt": "target\n" })
      commit(repo, "link copy")
      await putArea(h, { ...area({ slug: "inventory", directory: repo }), linkCopies: { "link.txt": "c".repeat(40) } })
      expect(await report(h, "ready", "다 됨")).toMatchObject({
        ok: false,
        error: "dirty",
        data: { paths: ["link.txt"] },
      })
      const blob = git(repo, ["hash-object", "link.txt"]).trim()
      await putArea(h, { ...area({ slug: "inventory", directory: repo }), linkCopies: { "link.txt": blob } })
      expect(await report(h, "ready", "다 됨")).toMatchObject({ ok: true })
      await h.close()
    },
    SLOW,
  )

  test(
    "ready records the branch tip as the candidate, sets 반영 준비됨 and wakes the main",
    async () => {
      const { h, repo, changes } = await withRepo()
      write(repo, { "notes.txt": "untracked\n" })
      const tip = git(repo, ["rev-parse", "refs/heads/inventory"]).trim()
      expect(await report(h, "ready", "정렬 수정과 테스트 3개")).toMatchObject({
        ok: true,
        text: "반영 후보로 적고 메인에게 알렸습니다.",
      })
      const stored = await h.services.registry.areas.get(TEAM_ID, INVENTORY)
      expect(stored?.candidate).toEqual({ sha: tip, at: T0, text: "정렬 수정과 테스트 3개" })
      expect(stored?.status).toMatchObject({ kind: "ready", at: T0 })
      expect(changes.map((event) => event.name === "area.changed" && event.data.status.kind)).toEqual(["ready"])
      const state = await Digest.load(h.services.kv, TEAM_ID)
      expect(Fold.reasons(state)).toEqual(["ready"])
      expect(Fold.due(state)).toBe(T0 + Fold.DEBOUNCE_MS)
      expect(await h.services.features().digest.render({ teamID: TEAM_ID })).toContain(
        '- inventory: 반영 준비됨 · 담당: "정렬 수정과 테스트 3개" (main보다 커밋 1개 앞섬)',
      )
      await h.close()
    },
    SLOW,
  )

  test(
    "ready with assets marks the candidate for the engine run (4.10); other kinds ignore it; team_integrate keeps it",
    async () => {
      const { h, repo } = await withRepo()
      const tip = git(repo, ["rev-parse", "refs/heads/inventory"]).trim()
      const stored = async () => (await h.services.registry.areas.get(TEAM_ID, INVENTORY))?.candidate
      const tool = async (input: typeof ReportTool.Input.Type) => {
        const current = await h.services.registry.areas.get(TEAM_ID, INVENTORY)
        if (!current) throw new Error("no area")
        return ReportTool.run(
          h.services,
          { role: "owner", team: team({ home: repo }), area: current, sessionID: OWNER_SESSION },
          input,
        )
      }
      expect(await tool({ kind: "progress", text: "에셋 손봄", assets: true })).toMatchObject({ ok: true })
      expect(await stored()).toBeUndefined()
      expect(await tool({ kind: "ready", text: "엔진에서 다시 가져와야 합니다", assets: true })).toMatchObject({
        ok: true,
        text: "반영 후보로 적고 메인에게 알렸습니다.",
      })
      expect(await stored()).toEqual({ sha: tip, at: T0, text: "엔진에서 다시 가져와야 합니다", assets: true })
      // The owner's team_integrate at the same tip keeps the report and its mark (the integration reads it).
      expect(
        await ReportEvents.ready(h.services, { teamID: TEAM_ID, areaID: INVENTORY, sessionID: OWNER_SESSION }),
      ).toEqual({ ok: true, sha: tip })
      expect((await stored())?.assets).toBe(true)
      // A later ready without it takes the mark away.
      expect(await tool({ kind: "ready", text: "다시 됨" })).toMatchObject({ ok: true })
      expect(await stored()).toEqual({ sha: tip, at: T0, text: "다시 됨" })
      await h.close()
    },
    SLOW,
  )

  test(
    "blocked sets 막힘 and wakes; reports from a previous owner or another session are refused",
    async () => {
      const { h } = await withRepo()
      expect(await report(h, "blocked", "결정 필요")).toMatchObject({ ok: true })
      expect((await h.services.registry.areas.get(TEAM_ID, INVENTORY))?.status.kind).toBe("blocked")
      expect(Fold.reasons(await Digest.load(h.services.kv, TEAM_ID))).toEqual(["blocked"])
      expect(await report(h, "progress", "옛 대화", OLD_OWNER)).toMatchObject({
        ok: false,
        error: "not_found",
        message: "이 대화는 더 이상 이 영역의 담당이 아닙니다",
      })
      expect(await report(h, "progress", "?", SessionID.make("ses_other000000000000000000001"))).toMatchObject({
        ok: false,
      })
      await h.services.write(TEAM_ID, async () => {
        const current = await h.services.registry.teams.get(TEAM_ID)
        if (current) await h.services.registry.teams.put({ ...current, state: "off" })
      })
      expect(await report(h, "progress", "꺼짐")).toMatchObject({ ok: false, error: "team_off" })
      await h.close()
    },
    SLOW,
  )
  test(
    "while direct work holds the area its reports and a peer's go whole into the stretch and wake nobody (2026-11-14)",
    async () => {
      const { h, repo } = await withRepo()
      const peer: OwnTeam.Peer = {
        key: "reviewer",
        sessionID: SessionID.make("ses_peer0000000000000000000001"),
        label: "리뷰어",
        role: "",
        attached: true,
        origin: "created",
        at: T0,
      }
      const since = T0 - 10 * MINUTE
      await putArea(h, {
        ...area({ slug: "inventory", directory: repo }),
        directWork: { since, at: T0 },
        peers: [peer],
      })
      const long = `${"가".repeat(5_999)}끝`
      expect(await report(h, "progress", "첫 진행")).toMatchObject({ ok: true, text: "팀 소식에 적었습니다." })
      expect(await report(h, "progress", long)).toMatchObject({ ok: true })
      expect(await report(h, "blocked", "어느 쪽으로 할지 정해야 합니다")).toEqual({
        ok: true,
        text: ReportEvents.QUIET.blocked,
      })
      expect(await report(h, "ready", "정렬 수정")).toEqual({ ok: true, text: ReportEvents.QUIET.ready })
      expect(
        await h.services.features().events.report({
          teamID: TEAM_ID,
          areaID: INVENTORY,
          sessionID: peer.sessionID,
          peer: peer.key,
          kind: "blocked",
          text: "리뷰에서 막힘",
        }),
      ).toEqual({ ok: true, text: ReportEvents.QUIET.blocked })
      const state = await Digest.load(h.services.kv, TEAM_ID)
      expect(state.entries.map((item) => [item.reason, item.wake])).toEqual([
        ["progress", false],
        ["progress", false],
        ["blocked", false],
        ["ready", false],
        ["blocked", false],
      ])
      expect(Fold.due(state)).toBeUndefined()
      expect(Fold.area(state, INVENTORY).stretch).toEqual({
        since,
        n: 5,
        kinds: { progress: 2, blocked: 2, ready: 1 },
        last: "리뷰에서 막힘",
      })
      const stretch = await Texts.loadStretch(h.services.kv, h.services.log, TEAM_ID, INVENTORY)
      expect(stretch?.since).toBe(since)
      expect(stretch?.items.map((item) => [item.kind, item.text, item.peer])).toEqual([
        ["progress", "첫 진행", undefined],
        ["progress", long, undefined],
        ["blocked", "어느 쪽으로 할지 정해야 합니다", undefined],
        ["ready", "정렬 수정", undefined],
        ["blocked", "리뷰에서 막힘", "reviewer"],
      ])
      // The candidate and the status are recorded as ever; the digest keeps excerpts, the area's texts the whole.
      const stored = await h.services.registry.areas.get(TEAM_ID, INVENTORY)
      expect(stored?.status.kind).toBe("ready")
      expect(stored?.candidate?.text).toBe("정렬 수정")
      const texts = await Texts.load(h.services.kv, h.services.log, TEAM_ID, INVENTORY)
      expect(texts?.reports.find((item) => item.kind === "progress" && item.peer === undefined)?.text).toBe(long)
      expect(state.entries[1]?.text).toBe(`${"가".repeat(Fold.EXCERPT)}…`)
      // The main's line: direct work and the count, no report quote, nothing to do.
      const text = await h.services.features().digest.render({ teamID: TEAM_ID })
      expect(text.split("\n").find((line) => line.startsWith("- inventory:"))).toBe(
        `- inventory: 반영 준비됨 · 직접 작업 중(${Talk.clock(since)}부터) · 모아 둔 보고 5개`,
      )
      expect(text).not.toContain("할 일:")
      await h.close()
    },
    SLOW,
  )

  test("a report of an area without direct work keeps no stretch; one sent a request it serves wakes as ever", async () => {
    const h = await setup()
    await putArea(h, area({ slug: "inventory", directory: h.root }))
    expect(await report(h, "blocked", "결정 필요")).toEqual({
      ok: true,
      text: "메인에게 알렸습니다. 메인의 답을 기다리세요.",
    })
    expect(Fold.area(await Digest.load(h.services.kv, TEAM_ID), INVENTORY).stretch).toBeUndefined()
    expect(await Texts.loadStretch(h.services.kv, h.services.log, TEAM_ID, INVENTORY)).toBeUndefined()
    // Held, but a main request went to the owner a moment ago (not folded yet): it serves it, so blocked wakes.
    const g = await setup()
    await putArea(g, { ...area({ slug: "inventory", directory: g.root }), directWork: { since: T0, at: T0 } })
    await putDispatch(g, { areaID: INVENTORY, seq: 1, sentAt: T0, owner: OWNER_SESSION })
    expect(await report(g, "blocked", "결정 필요")).toEqual({
      ok: true,
      text: "메인에게 알렸습니다. 메인의 답을 기다리세요.",
    })
    const state = await Digest.load(g.services.kv, TEAM_ID)
    expect(state.entries.map((item) => [item.reason, item.wake])).toEqual([["blocked", true]])
    expect(Fold.area(state, INVENTORY).stretch?.n).toBe(1)
    await h.close()
    await g.close()
  })

  test("a peer serving the main's request reports to the main while the owner is held; its own work stays quiet", async () => {
    const h = await setup()
    const peer: OwnTeam.Peer = {
      key: "reviewer",
      sessionID: SessionID.make("ses_peer0000000000000000000001"),
      label: "리뷰어",
      role: "",
      attached: true,
      origin: "created",
      at: T0,
    }
    await putArea(h, {
      ...area({ slug: "inventory", directory: h.root }),
      directWork: { since: T0 - MINUTE, at: T0 - MINUTE },
      peers: [peer],
    })
    const peerReport = (text: string) =>
      h.services.features().events.report({
        teamID: TEAM_ID,
        areaID: INVENTORY,
        sessionID: peer.sessionID,
        peer: peer.key,
        kind: "blocked",
        text,
      })
    // Nothing of the main's went to the peer: its block is the user's direct work, kept for the hand-back.
    expect(await peerReport("내 일에서 막힘")).toEqual({ ok: true, text: ReportEvents.QUIET.blocked })
    // The main's request went to the peer a moment ago (not folded yet): the peer serves it, so its block wakes.
    await putDispatch(h, { areaID: INVENTORY, seq: 1, sentAt: T0, owner: peer.sessionID })
    expect(await peerReport("리뷰에서 결정 필요")).toEqual({
      ok: true,
      text: "메인에게 알렸습니다. 메인의 답을 기다리세요.",
    })
    const state = await Digest.load(h.services.kv, TEAM_ID)
    expect(state.entries.map((item) => [item.reason, item.wake])).toEqual([
      ["blocked", false],
      ["blocked", true],
    ])
    await h.close()
  })

  test("a 6,000-character report is whole in the area's texts and an excerpt of 1,000 code points with … in the digest", async () => {
    const h = await setup()
    await putArea(h, area({ slug: "inventory", directory: h.root }))
    const long = "😀".repeat(6_000)
    expect(await report(h, "done", long)).toMatchObject({ ok: true })
    const texts = await Texts.load(h.services.kv, h.services.log, TEAM_ID, INVENTORY)
    expect(texts?.reports).toEqual([{ kind: "done", text: long, at: T0 }])
    const kept = Fold.area(await Digest.load(h.services.kv, TEAM_ID), INVENTORY).reports.done?.text ?? ""
    expect(Array.from(kept)).toHaveLength(Fold.EXCERPT + 1)
    expect(kept.endsWith("😀…")).toBe(true)
    await h.close()
  })
})

describe('사용자 부탁 (06 §5.5, 2026-10-16): team_report{kind:"relay"}', () => {
  const PEER = SessionID.make("ses_peer0000000000000000000001")
  const reviewer: OwnTeam.Peer = {
    key: "reviewer",
    sessionID: PEER,
    label: "리뷰어",
    role: "",
    attached: true,
    origin: "created",
    at: T0,
  }

  test("an owner's relay wakes the main and leaves the area's status, its fold and its open request alone", async () => {
    const h = await setup()
    const busy: OwnTeam.Area = {
      ...area({ slug: "inventory", directory: h.root }),
      status: { kind: "busy", at: T0, text: "" },
    }
    await putArea(h, busy)
    await putDispatch(h, { areaID: INVENTORY, seq: 1, sentAt: T0, owner: OWNER_SESSION })
    const before = Fold.area(await Digest.load(h.services.kv, TEAM_ID), INVENTORY)
    const answer = await ReportTool.run(
      h.services,
      { role: "owner", team: team({ home: h.root }), area: busy, sessionID: OWNER_SESSION },
      { kind: "relay", text: "테스트 부분은 따로 떼 줘" },
    )
    expect(answer).toEqual({ ok: true, text: ReportTool.RELAYED })
    const state = await Digest.load(h.services.kv, TEAM_ID)
    expect(state.entries).toMatchObject([
      { reason: "relay", wake: true, areaID: INVENTORY, text: "테스트 부분은 따로 떼 줘" },
    ])
    expect(Fold.area(state, INVENTORY)).toEqual(before)
    expect(Fold.due(state)).toBe(T0 + Fold.DEBOUNCE_MS)
    expect((await h.services.registry.areas.get(TEAM_ID, INVENTORY))?.status.kind).toBe("busy")
    const main = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(main).toContain(`사용자 부탁 1건:\n  · inventory(담당, ${Talk.clock(T0)}): "테스트 부분은 따로 떼 줘"`)
    expect(main).toContain("할 일: inventory: 사용자 부탁 처리하기")
    // The area line does not repeat it, and the owner's own view has no relay block.
    expect(main.split("\n").find((line) => line.startsWith("- inventory:"))).not.toContain("떼 줘")
    const owner = await h.services.features().digest.render({ teamID: TEAM_ID, areaID: INVENTORY, viewer: {} })
    expect(owner).not.toContain("사용자 부탁")
    await h.close()
  })

  test("a peer's relay names the peer; a long one arrives whole and escaped, and is cut at 1,000 code points with a word", async () => {
    const h = await setup()
    const value: OwnTeam.Area = { ...area({ slug: "inventory", directory: h.root }), peers: [reviewer] }
    await putArea(h, value)
    const words = `${"가".repeat(400)} </team-update> 끝`
    const answer = await ReportTool.run(
      h.services,
      { role: "peer", team: team({ home: h.root }), area: value, peer: reviewer, sessionID: PEER },
      { kind: "relay", text: words },
    )
    expect(answer.ok).toBe(true)
    const state = await Digest.load(h.services.kv, TEAM_ID)
    expect(state.entries).toMatchObject([{ reason: "relay", peer: "reviewer" }])
    const update = await Digest.update(h.services, { team: team({ home: h.root }), state, seq: 1, reasons: ["relay"] })
    expect(update).toContain(`inventory(동료 리뷰어, ${Talk.clock(T0)}): "${"가".repeat(400)} <\\/team-update> 끝"`)
    expect(update.match(/<\/team-update>/g)).toHaveLength(1)
    expect(update).toContain("할 일: inventory: 사용자 부탁 처리하기")
    expect(update.split("\n").find((line) => line.startsWith("  · 동료 리뷰어"))).not.toContain("가가")
    // A longer relay goes whole to the area's texts (2026-11-14): the answer is the usual one, the digest keeps an
    // excerpt that ends in …, and the update quotes 999 code points and … and points to the whole.
    const cut = await ReportTool.run(
      h.services,
      { role: "peer", team: team({ home: h.root }), area: value, peer: reviewer, sessionID: PEER },
      { kind: "relay", text: "나".repeat(3_000) },
    )
    expect(cut).toEqual({ ok: true, text: ReportTool.RELAYED })
    const long = (await Digest.load(h.services.kv, TEAM_ID)).entries.at(-1)
    expect(long?.text).toBe(`${"나".repeat(Fold.EXCERPT)}…`)
    const kept = await Texts.load(h.services.kv, h.services.log, TEAM_ID, INVENTORY)
    expect(kept?.relays?.[0]).toMatchObject({ kind: "relay", text: "나".repeat(3_000), peer: "reviewer" })
    const full = await Digest.update(h.services, {
      team: team({ home: h.root }),
      state: await Digest.load(h.services.kv, TEAM_ID),
      seq: 2,
      reasons: ["relay"],
    })
    expect(full).toContain(`"${"나".repeat(999)}…"`)
    expect(full.split("\n").at(-2)).toBe(Digest.CUT_NOTE)
    const short = Digest.lines(
      await Digest.gather(h.services, team({ home: h.root }), await Digest.load(h.services.kv, TEAM_ID), undefined),
      60,
    )
    expect(short.join("\n")).toContain(`"${"나".repeat(299)}…"`)
    // By code points: an emoji at the cut stays whole, here and in the main's update.
    await ReportTool.run(
      h.services,
      { role: "peer", team: team({ home: h.root }), area: value, peer: reviewer, sessionID: PEER },
      { kind: "relay", text: `a${"😀".repeat(1_200)}` },
    )
    const emoji = (await Digest.load(h.services.kv, TEAM_ID)).entries.at(-1)?.text ?? ""
    expect(Array.from(emoji)).toHaveLength(Fold.EXCERPT + 1)
    expect(emoji.endsWith("😀…")).toBe(true)
    const quoted = await Digest.update(h.services, {
      team: team({ home: h.root }),
      state: await Digest.load(h.services.kv, TEAM_ID),
      seq: 3,
      reasons: ["relay"],
    })
    expect(quoted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    // Nothing to pass on is refused, and wakes nobody.
    expect(
      await ReportTool.run(
        h.services,
        { role: "peer", team: team({ home: h.root }), area: value, peer: reviewer, sessionID: PEER },
        { kind: "relay", text: "   " },
      ),
    ).toEqual({ ok: false, text: ReportTool.RELAY_EMPTY })
    expect((await Digest.load(h.services.kv, TEAM_ID)).entries).toHaveLength(3)
    // A peer may relay, and the refusal of `ready` names relay among what a peer may use.
    expect(
      await ReportTool.run(
        h.services,
        { role: "peer", team: team({ home: h.root }), area: value, peer: reviewer, sessionID: PEER },
        { kind: "ready", text: "다 됨" },
      ),
    ).toEqual({ ok: false, text: OwnerTools.PEER_REFUSED })
    expect(OwnerTools.PEER_REFUSED).toContain('"relay"')
    await h.close()
  })
})

describe("direct work and long texts in the main's update (2026-11-14)", () => {
  const PEER_SESSION = SessionID.make("ses_peer0000000000000000000001")
  const reviewer: OwnTeam.Peer = {
    key: "reviewer",
    sessionID: PEER_SESSION,
    label: "리뷰어",
    role: "",
    attached: true,
    origin: "created",
    at: T0,
  }

  test("a held area's line: direct work since when and the reports kept, no report quote, no failure note, no 할 일", async () => {
    const h = await setup()
    // Hold on: the owner's old direct-talk mark is never printed.
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.root, directHold: true })))
    await putArea(h, {
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      status: { kind: "blocked", at: T0 + 3 * MINUTE, text: "" },
      direct: { at: T0 + 4 * MINUTE, sessionID: OWNER_SESSION },
      directWork: { since: T0, at: T0 + 4 * MINUTE },
      peers: [reviewer],
    })
    await putArea(h, {
      ...area({ slug: "save", directory: path.join(h.root, "save") }),
      owner: { sessionID: SAVE_OWNER, previous: [], attached: true },
      status: { kind: "blocked", at: T0, text: "" },
    })
    await fold(h, (state) =>
      [
        Fold.entry({ at: T0 + MINUTE, areaID: INVENTORY, reason: "failed", text: "실행 실패: boom", wake: false }),
        Fold.entry({ at: T0 + MINUTE, areaID: INVENTORY, reason: "seated", text: "담당이 바뀜" }),
      ].reduce(
        (acc, entry) => Fold.append(acc, entry),
        [
          { kind: "progress", text: "버튼 색" },
          { kind: "blocked", text: "어느 쪽?" },
        ].reduce(
          (acc, item) => Fold.stretch(acc, { areaID: INVENTORY, since: T0, kind: item.kind, excerpt: item.text }),
          Fold.peerReport(
            Fold.report(state, { areaID: INVENTORY, kind: "blocked", text: "어느 쪽?", at: T0 + 3 * MINUTE }),
            { areaID: INVENTORY, key: "reviewer", kind: "blocked", text: "리뷰 막힘", at: T0 + 3 * MINUTE },
          ),
        ),
      ),
    )
    const lines = (await h.services.features().digest.render({ teamID: TEAM_ID })).split("\n")
    expect(lines.find((line) => line.startsWith("- inventory:"))).toBe(
      `- inventory: 막힘 · 직접 작업 중(${Talk.clock(T0)}부터) · 모아 둔 보고 2개 · 담당이 바뀜`,
    )
    // Other areas keep their 할 일; the held one, its peer's blocked included, has none.
    expect(lines.find((line) => line.startsWith(Digest.TODO))).toBe("할 일: save: 담당의 보고를 읽고 정하기")
    // An owner sees the other area's direct work in one word.
    const save = await h.services.features().digest.render({ teamID: TEAM_ID, areaID: SAVE, viewer: {} })
    expect(save.split("\n").find((line) => line.startsWith("  · inventory(inventory)"))).toContain(
      " · 사용자와 직접 작업 중 · ",
    )
    expect(save).not.toContain("사용자가 직접 대화함")
    await h.close()
  })

  test("a held area's waiting request says direct work holds it; its integration made before the stretch waits too", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.root, directHold: true })))
    await putArea(h, {
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      directWork: { since: T0 + 10 * MINUTE, at: T0 + 10 * MINUTE },
    })
    await putDispatch(h, { areaID: INVENTORY, seq: 1 })
    const gathered = await Digest.gather(
      h.services,
      team({ home: h.root, directHold: true }),
      await Digest.load(h.services.kv, TEAM_ID),
      undefined,
    )
    const integration = (createdAt: number): OwnTeam.Integration => ({
      id: OwnTeam.IntegrationID.create(),
      teamID: TEAM_ID,
      areaID: INVENTORY,
      state: "waiting",
      target: "main",
      source: "c".repeat(40),
      verify: {},
      createdAt,
    })
    const shown = (made: number) =>
      Digest.lines(
        {
          ...gathered,
          now: T0 + 20 * MINUTE,
          areas: gathered.areas.map((item) => ({
            ...item,
            held: { why: "paused" as const, since: T0 + 15 * MINUTE, cause: { direct: true as const } },
            integration: integration(made),
          })),
        },
        Digest.RELAY_QUOTE.full,
      ).filter((line) => line.startsWith("- inventory:"))
    const before = shown(T0)
    expect(before).toContain("- inventory: 반영 기다림 · 직접 작업 중이라 기다림")
    expect(before.find((line) => line.includes("메인 요청"))).toContain(
      "메인 요청 1개 기다림(사용자가 직접 작업 중이라 기다림 · 5분째)",
    )
    // One the user started during the stretch is not held by it.
    expect(shown(T0 + 12 * MINUTE)).toContain("- inventory: 반영 기다림")
    await h.close()
  })

  test("the hand-back line shows although a request was sent after it, and its pointer survives the 160 clip", async () => {
    const h = await setup()
    await putArea(h, area({ slug: "inventory", directory: path.join(h.root, "inventory") }))
    const summary: Fold.StretchSummary = {
      since: T0,
      until: T0 + 30 * MINUTE,
      n: 3,
      kinds: { ready: 1, progress: 2 },
      last: "가".repeat(150),
    }
    const line = Direct.handed(summary, { why: "handed", area: "inventory", candidate: true, ahead: 2, dirty: true })
    await fold(h, (state) =>
      Fold.append(state, Fold.entry({ at: T0 + 30 * MINUTE, areaID: INVENTORY, reason: "handed", text: line })),
    )
    await putDispatch(h, { areaID: INVENTORY, seq: 1, sentAt: T0 + 31 * MINUTE, owner: OWNER_SESSION })
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    const shown = text.split("\n").find((item) => item.startsWith("- inventory:")) ?? ""
    expect(shown).toContain("사용자가 직접 작업을 마치고 넘김(")
    expect(shown).toContain('전문: team_status{area:"inventory"}')
    expect(text.split("\n").at(-1)).toBe(Digest.CUT_NOTE)
    // The short pass quotes 60: the pointer is cut there, and the note names where the whole is.
    const short = Digest.lines(
      await Digest.gather(h.services, team({ home: h.root }), await Digest.load(h.services.kv, TEAM_ID), undefined),
      60,
    )
    expect(short.at(-1)).toBe(Digest.CUT_NOTE)
    expect(Digest.CUT_NOTE).toContain("team_status{area}")
    await h.close()
  })

  test(
    "forty ready areas: the update keeps 할 일 within its share, counts the rest, and ends with the cut note",
    async () => {
      const h = await setup()
      const slugs = Array.from({ length: 40 }, (_, index) => `area-${index}`)
      for (const slug of slugs)
        await putArea(h, {
          ...area({ slug, directory: path.join(h.root, slug) }),
          name: `${slug} ${"보스".repeat(8)}`,
          status: { kind: "ready", at: T0, text: "" },
          candidate: { sha: "c".repeat(40), at: T0, text: "후보" },
        })
      await fold(h, (state) =>
        slugs.reduce(
          (acc, slug) =>
            Fold.report(acc, {
              areaID: OwnTeam.AreaID.make(`ar_${slug}`),
              kind: "ready",
              text: Fold.excerpt("긴 보고 ".repeat(400)),
              at: T0 + 1,
            }),
          state,
        ),
      )
      const update = await Digest.update(h.services, {
        team: team({ home: h.root }),
        state: await Digest.load(h.services.kv, TEAM_ID),
        seq: 1,
        reasons: ["ready"],
      })
      expect(Digest.tokens(update)).toBeLessThanOrEqual(Digest.MAX_TOKENS)
      const lines = update.split("\n").slice(1, -1)
      const todo = lines.findIndex((line) => line.startsWith(Digest.TODO))
      expect(todo).toBeGreaterThan(0)
      expect(lines[todo]).toMatch(/ · 외 \d+개: team_status로 모두 보세요$/)
      expect(Digest.tokens(lines[todo] ?? "")).toBeLessThanOrEqual(Digest.TODO_TOKENS + 20)
      const areas = lines.flatMap((line, index) => (line.startsWith("- area-") ? [index] : []))
      expect(areas.length).toBeGreaterThan(0)
      expect(areas.length).toBeLessThan(40)
      expect(Math.max(...areas)).toBeLessThan(todo)
      expect(lines).toContain(Digest.CUT_NOTE)
      expect(lines.at(-1)).toMatch(/^… \d+줄 더: team_status로 모두 보세요$/)

      // Three such areas fit: every item is listed and nothing is counted.
      const few = await setup()
      for (const slug of slugs.slice(0, 3))
        await putArea(few, {
          ...area({ slug, directory: path.join(few.root, slug) }),
          status: { kind: "ready", at: T0, text: "" },
          candidate: { sha: "c".repeat(40), at: T0, text: "후보" },
        })
      const small = await Digest.update(few.services, {
        team: team({ home: few.root }),
        state: await Digest.load(few.services.kv, TEAM_ID),
        seq: 1,
        reasons: ["ready"],
      })
      expect(small).not.toContain("외 ")
      expect(small).not.toContain("줄 더")
      await h.close()
      await few.close()
    },
    SLOW,
  )

  test("a 1,000-character role: team_status of the area prints it whole; the whole team and the update quote 80", async () => {
    const h = await setup()
    const goal = "보".repeat(1_000)
    await putArea(h, { ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }), goal })
    const render = h.services.features().digest.render
    expect(await render({ teamID: TEAM_ID, areaID: INVENTORY })).toContain(`역할 "${goal}"`)
    const quote = `역할 "${"보".repeat(Digest.ROLE_QUOTE - 1)}…"`
    expect(await render({ teamID: TEAM_ID })).toContain(quote)
    const update = await Digest.update(h.services, {
      team: team({ home: h.root }),
      state: await Digest.load(h.services.kv, TEAM_ID),
      seq: 1,
      reasons: ["ready"],
    })
    expect(update).toContain(quote)
    await h.close()
  })
})

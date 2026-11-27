// The roster line of `team_status` (담당 메모, 2026-11-12): an area with at least one peer names its owner first, with
// the user's note about it, then each peer with its key and role, in the main's whole-team view (the area's name
// first), in the main's view of one area and in the own view of the owner and of each peer; an area without peers has
// no roster and never shows the note. Notes and roles are cut to 120 code points; labels and keys never are. The
// main's view of one area also lists the folder's other root conversations: one that was the owner before is among
// them with `전 담당` unless it is archived. The registry is the fake one; the sessions come from a fake own service
// on 127.0.0.1; fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Talk } from "../../src/dispatch/talk.js"
import { Undo } from "../../src/ops/undo.js"
import { Keys } from "../../src/registry/keys.js"
import { Digest } from "../../src/report/digest.js"
import { Fold } from "../../src/report/fold.js"
import { Texts } from "../../src/report/texts.js"
import { StatusTool } from "../../src/tools/status.js"
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

const services: FakeService[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterAll(async () => {
  for (const service of services) await service.stop()
  for (const cleanup of cleanups) await cleanup()
})

const T0 = Date.UTC(2026, 10, 12, 3, 0, 0)
const REVIEWER = SessionID.make("ses_peer0000000000000000000001")
const TESTER = SessionID.make("ses_peer0000000000000000000002")
const SAVE_OWNER = SessionID.make("ses_owner000000000000000000002")

const reviewer: OwnTeam.Peer = {
  key: "reviewer",
  sessionID: REVIEWER,
  label: "리뷰어",
  role: "보안 위주로 읽는다",
  attached: true,
  origin: "registered",
  at: T0,
}

const tester: OwnTeam.Peer = {
  key: "tester",
  sessionID: TESTER,
  label: "테스트 담당",
  role: "",
  attached: true,
  origin: "created",
  at: T0,
}

async function setup() {
  const home = await tempHome()
  cleanups.push(() => home[Symbol.asyncDispose]())
  const service = start()
  services.push(service)
  const harness = controller(new World(), { directory: home.root, clock: manual(T0), source: service.source })
  await harness.services.write(TEAM_ID, async () => {
    await harness.services.registry.teams.put(team({ home: home.root }))
  })
  await harness.controller.resume()
  const put = async (value: OwnTeam.Area) => {
    await harness.services.write(TEAM_ID, () => harness.services.registry.areas.put(value))
    return value
  }
  const main = { role: "main" as const, team: team({ home: home.root }), sessionID: MAIN_SESSION }
  return { root: home.root, service, put, main, ...harness }
}

/** A session as `GET /api/session` lists it. */
function session(input: {
  readonly id: string
  readonly directory: string
  readonly title?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly archived?: number
}) {
  return {
    id: input.id,
    projectID: "prj_test",
    ...(input.title === undefined ? {} : { title: input.title }),
    location: { directory: input.directory },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    time: { created: T0, updated: T0, ...(input.archived === undefined ? {} : { archived: input.archived }) },
  }
}

describe("the roster line (담당 메모, 2026-11-12)", () => {
  test("the main's whole-team view has one per area with a peer, the owner first; an area without peers has none", async () => {
    const h = await setup()
    await h.put({
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      name: "인벤토리 화면",
      owner: { sessionID: OWNER_SESSION, previous: [], attached: true, note: "화면을 만들고\n  반영을 맡는다" },
      peers: [reviewer, tester],
    })
    // No peer: the goal says what the owner does, so the note is not shown.
    await h.put({
      ...area({ slug: "save", directory: path.join(h.root, "save") }),
      owner: { sessionID: SAVE_OWNER, previous: [], attached: true, note: "혼자 쓰는 메모" },
    })
    // A peer and no note: the owner is named alone.
    await h.put({
      ...area({ slug: "docs", directory: path.join(h.root, "docs") }),
      owner: { sessionID: null, previous: [], attached: false },
      peers: [reviewer],
    })
    await h.put({
      ...area({ slug: "gone", directory: path.join(h.root, "gone") }),
      state: "retired",
      owner: { sessionID: null, previous: [], attached: false, note: "끝난 영역의 메모" },
      peers: [reviewer],
    })
    const whole = await StatusTool.run(h.services, h.main, {})
    const rosters = whole.text.split("\n").filter((line) => line.includes("대화: "))
    expect(rosters).toEqual([
      'docs 대화: 담당, 리뷰어(reviewer) 역할 "보안 위주로 읽는다"',
      '인벤토리 화면 대화: 담당 메모 "화면을 만들고 반영을 맡는다", 리뷰어(reviewer) 역할 "보안 위주로 읽는다", 테스트 담당(tester)',
    ])
    expect(whole.text).not.toContain("혼자 쓰는 메모")
    expect(whole.text).not.toContain("끝난 영역의 메모")
    // The main's digest itself (the `<team-update>` text) carries no roster and no note.
    const update = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(update).not.toContain("대화: ")
    expect(update).not.toContain("담당 메모")
    expect(update).not.toContain("화면을 만들고")
    await h.close()
  })

  test("the main's view of one area, the owner's view and each peer's view end with their area's roster", async () => {
    const h = await setup()
    const inventory = await h.put({
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      owner: { sessionID: OWNER_SESSION, previous: [], attached: true, note: "화면을 만든다" },
      peers: [reviewer, tester],
    })
    const save = await h.put({
      ...area({ slug: "save", directory: path.join(h.root, "save") }),
      owner: { sessionID: SAVE_OWNER, previous: [], attached: true, note: "혼자 쓰는 메모" },
    })
    const line = '대화: 담당 메모 "화면을 만든다", 리뷰어(reviewer) 역할 "보안 위주로 읽는다", 테스트 담당(tester)'
    const one = await StatusTool.run(h.services, h.main, { area: "inventory" })
    expect(one.text.split("\n").at(-1)).toBe(line)
    const owner = await StatusTool.run(
      h.services,
      { role: "owner", team: h.main.team, area: inventory, sessionID: OWNER_SESSION },
      {},
    )
    expect(owner.text.split("\n").at(-1)).toBe(line)
    const peer = await StatusTool.run(
      h.services,
      { role: "peer", team: h.main.team, area: inventory, peer: tester, sessionID: TESTER },
      {},
    )
    expect(peer.text.split("\n").at(-1)).toBe(line)
    // The note is said once: the roster line is the only place of an own view that has it.
    for (const view of [one, owner, peer]) {
      expect(view.text.split("화면을 만든다")).toHaveLength(2)
      expect(view.text.split("담당 메모")).toHaveLength(2)
    }
    // The other area's roster is not in an own view; an area without peers has neither a roster nor its note.
    const alone = await StatusTool.run(
      h.services,
      { role: "owner", team: h.main.team, area: save, sessionID: SAVE_OWNER },
      {},
    )
    expect(alone.text).not.toContain("대화: ")
    expect(alone.text).not.toContain("혼자 쓰는 메모")
    expect((await StatusTool.run(h.services, h.main, { area: "save" })).text).not.toContain("혼자 쓰는 메모")
    await h.close()
  })

  test("the whole-team view cuts a note and a role to 120 code points with …; a view of one area prints them whole", async () => {
    const h = await setup()
    const label = "가".repeat(OwnTeam.PEER_LABEL_MAX)
    const inventory = await h.put({
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      owner: { sessionID: OWNER_SESSION, previous: [], attached: true, note: `${"😀".repeat(120)}끝` },
      peers: [
        { ...reviewer, label, role: "나".repeat(1_024) },
        { ...tester, role: "다".repeat(120) },
      ],
    })
    expect(StatusTool.PEER_ROLE_QUOTE).toBe(120)
    const whole = await StatusTool.run(h.services, h.main, {})
    expect(whole.text.split("\n").at(-1)).toBe(
      `inventory 대화: 담당 메모 "${"😀".repeat(119)}…", ${label}(reviewer) 역할 "${"나".repeat(119)}…", 테스트 담당(tester) 역할 "${"다".repeat(120)}"`,
    )
    // 2026-11-14: one area (the main's view, or an owner's or a peer's own view) prints them whole.
    const line = `대화: 담당 메모 "${"😀".repeat(120)}끝", ${label}(reviewer) 역할 "${"나".repeat(1_024)}", 테스트 담당(tester) 역할 "${"다".repeat(120)}"`
    const one = await StatusTool.run(h.services, h.main, { area: "inventory" })
    expect(one.text.split("\n").at(-1)).toBe(line)
    const owner = await StatusTool.run(
      h.services,
      { role: "owner", team: h.main.team, area: inventory, sessionID: OWNER_SESSION },
      {},
    )
    expect(owner.text.split("\n").at(-1)).toBe(line)
    await h.close()
  })

  test("the viewed area's role is printed whole; the whole-team view quotes 80 code points", async () => {
    const h = await setup()
    const goal = `${"보스 규칙과 연출 ".repeat(110)}끝`.slice(0, 1_000)
    const inventory = await h.put({ ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }), goal })
    await h.put(area({ slug: "save", directory: path.join(h.root, "save") }))
    const flat = goal.replace(/\s+/g, " ").trim()
    const role = (text: string) => text.split("\n").find((line) => line.startsWith("- inventory:")) ?? ""
    expect(role((await StatusTool.run(h.services, h.main, { area: "inventory" })).text)).toContain(`역할 "${flat}"`)
    const own = await StatusTool.run(
      h.services,
      { role: "owner", team: h.main.team, area: inventory, sessionID: OWNER_SESSION },
      {},
    )
    expect(role(own.text)).toContain(`역할 "${flat}"`)
    const team = role((await StatusTool.run(h.services, h.main, {})).text)
    expect(team).toContain(`역할 "${Array.from(flat).slice(0, 79).join("")}…"`)
    await h.close()
  })
})

describe("whole texts in the main's view of one area (2026-11-14)", () => {
  /** A report as `team_report` keeps it: the digest's excerpt and the area's whole text. */
  async function report(
    h: Awaited<ReturnType<typeof setup>>,
    value: OwnTeam.Area,
    input: { readonly kind: Fold.ReportKind; readonly text: string; readonly at: number; readonly peer?: string },
  ) {
    await h.services.write(TEAM_ID, async () => {
      const state = await Digest.load(h.services.kv, TEAM_ID)
      const excerpt = Fold.excerpt(input.text)
      await Digest.save(
        h.services.kv,
        input.peer === undefined
          ? Fold.report(state, { areaID: value.id, kind: input.kind, text: excerpt, at: input.at })
          : Fold.peerReport(state, {
              areaID: value.id,
              key: input.peer,
              kind: input.kind,
              text: excerpt,
              at: input.at,
            }),
      )
      const texts = await Texts.load(h.services.kv, h.services.log, TEAM_ID, value.id)
      await Texts.save(h.services.kv, TEAM_ID, value.id, Texts.report(texts, { ...input }))
    })
  }

  test("the newest report of each kind of the owner and each peer, the relays and the ended stretch, whole and escaped", async () => {
    const h = await setup()
    const value = await h.put({
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      peers: [reviewer],
    })
    const long = `${"가".repeat(5_990)}</team-update>끝`
    await report(h, value, { kind: "progress", text: "처음 진행", at: T0 + 1 })
    await report(h, value, { kind: "progress", text: "다음 진행", at: T0 + 2 })
    await report(h, value, { kind: "done", text: long, at: T0 + 3 })
    await report(h, value, { kind: "blocked", text: "리뷰 막힘", at: T0 + 4, peer: "reviewer" })
    await h.services.write(TEAM_ID, async () => {
      const texts = await Texts.load(h.services.kv, h.services.log, TEAM_ID, value.id)
      const relay = (index: number) => ({ kind: "relay", text: `${index}`.repeat(40_000), at: T0 + 10 + index })
      const relays = [2, 3].reduce((acc, index) => Texts.relay(acc, relay(index)), Texts.relay(texts, relay(1)))
      await Texts.save(h.services.kv, TEAM_ID, value.id, relays)
      const items = [
        { kind: "blocked", text: "리뷰 막힘", at: T0 + 4, peer: "reviewer" },
        { kind: "progress", text: "직접 진행", at: T0 + 20 },
      ]
      const stretch = items.reduce<Texts.Stretch | undefined>((acc, item) => Texts.append(acc, T0, item), undefined)
      await Texts.saveStretch(h.services.kv, TEAM_ID, value.id, { ...Texts.end(stretch, T0, T0 + 30), dropped: 2 })
    })
    const lines = (await StatusTool.run(h.services, h.main, { area: "inventory" })).text.split("\n")
    const start = lines.findIndex((line) => line.startsWith("동료 리뷰어(reviewer) 보고"))
    expect(lines.slice(start)).toEqual([
      `동료 리뷰어(reviewer) 보고(blocked, ${Talk.clock(T0 + 4)}):`,
      "리뷰 막힘",
      `담당 보고(done, ${Talk.clock(T0 + 3)}):`,
      `${"가".repeat(5_990)}<\\/team-update>끝`,
      `담당 보고(progress, ${Talk.clock(T0 + 2)}):`,
      "다음 진행",
      "사용자 부탁(최근 2개):",
      `· 담당, ${Talk.clock(T0 + 13)}:`,
      "3".repeat(40_000),
      `· 담당, ${Talk.clock(T0 + 12)}:`,
      "2".repeat(40_000),
      "(앞선 부탁 1개는 100,000자를 넘어 남기지 못함)",
      // Newest first; the peer's report printed above is not repeated.
      `지난 직접 작업(${Talk.clock(T0)}~${Talk.clock(T0 + 30)}) 보고 2개:`,
      `· 담당 progress, ${Talk.clock(T0 + 20)}:`,
      "직접 진행",
      "(앞선 보고 2개는 한 번의 직접 작업에 남기는 100,000자를 넘어 남기지 못함)",
      '대화: 담당, 리뷰어(reviewer) 역할 "보안 위주로 읽는다"',
    ])
    // The digest keeps an excerpt that says it was cut; the update points to the whole.
    const update = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(update).toContain(`"${"가".repeat(159)}…"`)
    expect(update.split("\n").at(-1)).toBe(Digest.CUT_NOTE)
    await h.close()
  })

  test("the next stretch's first report keeps the handed one readable until that one is handed back", async () => {
    const h = await setup()
    const value = await h.put(area({ slug: "inventory", directory: path.join(h.root, "inventory") }))
    await h.services.write(TEAM_ID, async () => {
      const handed = Texts.end(Texts.append(undefined, T0, { kind: "blocked", text: "넘긴 막힘", at: T0 + 1 }), T0, T0 + 10)
      const next = Texts.append(handed, T0 + 100, { kind: "progress", text: "새 진행", at: T0 + 101 })
      await Texts.saveStretch(h.services.kv, TEAM_ID, value.id, next)
    })
    const lines = (await StatusTool.run(h.services, h.main, { area: "inventory" })).text.split("\n")
    const start = lines.findIndex((line) => line.startsWith("직접 작업 중 보고"))
    expect(lines.slice(start, start + 6)).toEqual([
      `직접 작업 중 보고 1개(${Talk.clock(T0 + 100)}부터):`,
      `· 담당 progress, ${Talk.clock(T0 + 101)}:`,
      "새 진행",
      `지난 직접 작업(${Talk.clock(T0)}~${Talk.clock(T0 + 10)}) 보고 1개:`,
      `· 담당 blocked, ${Talk.clock(T0 + 1)}:`,
      "넘긴 막힘",
    ])
    await h.close()
  })

  test("a live stretch says since when; an area without its whole texts shows the digest's excerpts, marked", async () => {
    const h = await setup()
    const value = await h.put({
      ...area({ slug: "inventory", directory: path.join(h.root, "inventory") }),
      directWork: { since: T0, at: T0 + 5 },
    })
    await h.services.write(TEAM_ID, async () => {
      const state = await Digest.load(h.services.kv, TEAM_ID)
      await Digest.save(
        h.services.kv,
        Fold.report(state, { areaID: value.id, kind: "ready", text: "예전 보고의 앞부분", at: T0 - 1 }),
      )
      await Texts.saveStretch(
        h.services.kv,
        TEAM_ID,
        value.id,
        Texts.append(undefined, T0, { kind: "progress", text: "버튼 색을 바꿈", at: T0 + 3 }),
      )
    })
    const lines = (await StatusTool.run(h.services, h.main, { area: "inventory" })).text.split("\n")
    const start = lines.findIndex((line) => line.startsWith("담당 보고"))
    expect(lines.slice(start)).toEqual([
      `담당 보고(ready, ${Talk.clock(T0 - 1)})(전문 없음):`,
      "예전 보고의 앞부분",
      `직접 작업 중 보고 1개(${Talk.clock(T0)}부터):`,
      `· 담당 progress, ${Talk.clock(T0 + 3)}:`,
      "버튼 색을 바꿈",
    ])
    // An invalid stored value reads as absent (and is logged).
    await h.services.write(TEAM_ID, () => h.services.kv.set(Keys.report(TEAM_ID, value.id), { reports: 3 }))
    const again = (await StatusTool.run(h.services, h.main, { area: "inventory" })).text
    expect(again).toContain("(전문 없음):")
    await h.close()
  })

  test("more than eight other conversations: eight named, the rest counted", async () => {
    const h = await setup()
    const directory = path.join(h.root, "inventory")
    await h.put(area({ slug: "inventory", directory }))
    h.service.routes.set("GET /api/session", () =>
      Response.json({
        data: Array.from({ length: 11 }, (_, index) =>
          session({ id: `ses_other${String(index).padStart(20, "0")}`, directory, title: `대화 ${index}` }),
        ),
        cursor: {},
      }),
    )
    const last = (await StatusTool.run(h.services, h.main, { area: "inventory" })).text.split("\n").at(-1) ?? ""
    expect(last.startsWith("이 영역의 다른 대화(동료로 등록되지 않음): ")).toBe(true)
    expect(last.split("(ses_other").length - 1).toBe(8)
    expect(last.endsWith(" 외 3개")).toBe(true)
    await h.close()
  })
})

describe("the other conversations of an area (담당 대화 바꾸기)", () => {
  test("a previous owner that is not archived is listed with 전 담당; an archived one, the owner and a peer are not", async () => {
    const h = await setup()
    const directory = path.join(h.root, "inventory")
    const seated = SessionID.make("ses_owner000000000000000000009")
    const rotated = SessionID.make("ses_owner000000000000000000008")
    await h.put({
      ...area({ slug: "inventory", directory }),
      owner: {
        sessionID: OWNER_SESSION,
        attached: true,
        previous: [
          { sessionID: OLD_OWNER, endedAt: T0, why: "user" },
          { sessionID: rotated, endedAt: T0, why: "fresh" },
          { sessionID: seated, endedAt: T0, why: "seat" },
        ],
      },
      peers: [reviewer],
    })
    h.service.routes.set("GET /api/session", (request) =>
      request.query.directory === directory && request.query.parentID === "null"
        ? Response.json({
            data: [
              session({ id: "ses_other00000000000000000001", directory, title: "사용자가  따로\n연 대화" }),
              session({ id: seated, directory, title: "예전 담당 대화" }),
              session({ id: OLD_OWNER, directory, title: "보관된 담당", metadata: { [Undo.ARCHIVED]: true } }),
              session({ id: rotated, directory, title: "코어가 보관한 담당", archived: T0 }),
              session({ id: OWNER_SESSION, directory, title: "지금 담당" }),
              session({ id: REVIEWER, directory, title: "리뷰어 대화" }),
              session({ id: MAIN_SESSION, directory, title: "메인" }),
            ],
            cursor: {},
          })
        : Response.json({ data: [], cursor: {} }),
    )
    const one = await StatusTool.run(h.services, h.main, { area: "inventory" })
    expect(one.text.split("\n").slice(-2)).toEqual([
      '대화: 담당, 리뷰어(reviewer) 역할 "보안 위주로 읽는다"',
      '이 영역의 다른 대화(동료로 등록되지 않음): "사용자가 따로 연 대화"(ses_other000), "예전 담당 대화"(ses_owner000, 전 담당)',
    ])
    await h.close()
  })
})

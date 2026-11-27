// No area limit (2026-11-14, AL-1, AL-3): the team main's `team_reorganize` makes any number of areas, and only a
// proposal that makes more than `JudgeValidate.BATCH` (4) new areas at once (`new`, `split`, `areas[].create`) first
// answers a plan whose first line names them all; the user's next message runs the whole proposal. A preview says so.
// A `new` op with `userMade: true` (a standing role the user asked to keep, AL-9) makes a 내가 정한 영역. A team on a
// temp git home, a fake own service, a manual clock; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { JudgeValidate } from "../../src/judge/validate.js"
import { ReorganizeTool } from "../../src/tools/reorganize.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"
import { type VoiceTeam, approve, voiceTeam } from "../support/voice.js"

const SLOW = 600_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** core's `session.create` of the owner each new area gets, and own.accounts' approval mode, so new areas complete. */
function creates(h: VoiceTeam) {
  h.world.accounts.set("session.approval.set", (call) => ({ mode: (call as { mode: string }).mode, patched: [] }))
  h.backend.service.routes.set("POST /api/session", (request) => {
    const body = request.body as {
      readonly id: string
      readonly location: { readonly directory: string }
      readonly metadata?: Readonly<Record<string, unknown>>
    }
    h.backend.add(body.id, body.location.directory, "담당")
    return Response.json({
      data: {
        id: body.id,
        projectID: "prj_test",
        title: "담당",
        location: { directory: body.location.directory },
        time: { created: 1, updated: 1 },
        metadata: body.metadata ?? {},
      },
    })
  })
}

const NAMES = ["맵 공방", "아이템 공방", "형상공방", "몬스터", "NPC 오디오", "MUD", "보스 담당"]
const SLUGS = ["map", "items", "shapes", "monsters", "npc-audio", "mud", "boss"]

function news(count: number, extra: { readonly userMade?: true } = {}) {
  return SLUGS.slice(0, count).map((slug, index) => ({ op: "new", slug, name: NAMES[index], ...extra }))
}

async function created(h: VoiceTeam) {
  return (await h.services.registry.areas.list(TEAM_ID)).filter((area) => area.origin === "created")
}

describe("team_reorganize without an area limit", () => {
  test(
    "four new areas are made at once; five plan first, make nothing, and the user's next message makes all five",
    async () => {
      const h = await voiceTeam({ cleanups })
      creates(h)
      const reorganize = h.tool(ReorganizeTool.NAME)
      expect(JudgeValidate.BATCH).toBe(4)

      const four = await reorganize(MAIN_SESSION, { proposal: { version: 1, ops: news(4) } })
      expect(four.plan).toBeUndefined()
      expect(four).toMatchObject({ ok: true })
      expect((await created(h)).map((area) => `${area.id}`).toSorted()).toEqual([
        "ar_items",
        "ar_map",
        "ar_monsters",
        "ar_shapes",
      ])

      const proposal = {
        version: 1,
        ops: ["a", "b", "c", "d", "e"].map((slug) => ({ op: "new", slug: `more-${slug}`, name: `더 ${slug}` })),
      }
      const before = await h.snapshot()
      const { plan, done } = await approve(h, MAIN_SESSION, ReorganizeTool.NAME, { proposal })
      expect(plan.text.split("\n")[0]).toBe(ReorganizeTool.PLAN_MANY(["더 a", "더 b", "더 c", "더 d", "더 e"], 0))
      expect(plan.text).toContain(ReorganizeTool.PLAN_ITEMS)
      expect(plan.text).not.toContain("사용자가 정한 영역이 됩니다")
      expect(before.areas).toHaveLength(4)
      expect(done).toMatchObject({ ok: true })
      expect(await h.settled(String(done.opID))).toMatchObject({ kind: "reorg", by: "user" })
      expect(await created(h)).toHaveLength(9)
    },
    SLOW,
  )

  test(
    "four new areas and a split are five: a plan; a preview of five says it plans first",
    async () => {
      const h = await voiceTeam({ cleanups })
      await h.makeArea("ui", { commit: true })
      const reorganize = h.tool(ReorganizeTool.NAME)
      const before = await h.snapshot()
      h.backend.turn(MAIN_SESSION)
      const split = await reorganize(MAIN_SESSION, {
        proposal: { version: 1, ops: [...news(4), { op: "split", area: "ui", slug: "ui-sort", name: "정렬" }] },
      })
      expect(split).toMatchObject({ ok: true, plan: true })
      expect(split.text.split("\n")[0]).toBe(ReorganizeTool.PLAN_MANY([...NAMES.slice(0, 4), "정렬"], 0))
      const preview = await reorganize(MAIN_SESSION, { proposal: { version: 1, ops: news(5) }, preview: true })
      expect(preview).toMatchObject({ ok: true, preview: true })
      expect(preview.text).toContain(ReorganizeTool.PREVIEW_MANY(5))
      const small = await reorganize(MAIN_SESSION, { proposal: { version: 1, ops: news(4) }, preview: true })
      expect(small.text).not.toContain(ReorganizeTool.PREVIEW_MANY(4))
      expect(await h.snapshot()).toEqual(before)
    },
    SLOW,
  )

  test(
    "seven standing roles the user asked for: the plan says all seven become 사용자가 정한 영역, and the yes makes them so",
    async () => {
      const h = await voiceTeam({ cleanups })
      creates(h)
      const { plan, done } = await approve(h, MAIN_SESSION, ReorganizeTool.NAME, {
        proposal: { version: 1, ops: news(7, { userMade: true }) },
      })
      const lines = plan.text.split("\n")
      expect(lines[0]).toBe(ReorganizeTool.PLAN_MANY(NAMES, 7))
      expect(lines[0]).toContain("그중 7개는 사용자가 정한 영역이 됩니다.")
      expect(lines).toContain(`- 새 영역 '보스 담당'을(를) 만듭니다 · 새 작업 폴더${ReorganizeTool.MINE}`)
      expect(plan.text).not.toContain("상한")
      expect(done).toMatchObject({ ok: true })
      expect(await h.settled(String(done.opID))).toMatchObject({ kind: "reorg", by: "user" })
      const areas = await created(h)
      expect(areas.map((area) => `${area.id}`).toSorted()).toEqual(SLUGS.map((slug) => `ar_${slug}`).toSorted())
      expect(areas.every((area) => area.userMade !== undefined)).toBe(true)
    },
    SLOW,
  )
})

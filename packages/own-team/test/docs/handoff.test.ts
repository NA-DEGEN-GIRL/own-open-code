// Handoff documents (06 §6.2 step 2, §6.4): `team_handoff{text}` and the program handoff write
// `areas/<slug>/handoff.md` in the team records folder (8 KB advised, cut at 64 KB on a UTF-8 boundary) and record
// `{file, hash, at}` in the area; the program handoff reads the records, git and the old conversation only (no LLM
// call). A real git fixture in a temp folder, a fake loopback service and fake own.accounts answers.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Hash } from "@own/runtime"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Handoff } from "../../src/docs/handoff.js"
import { Teams } from "../../src/registry/team.js"
import { Tools } from "../../src/tools/index.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { manual } from "../support/clock.js"
import { OLD_OWNER, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"
import { commit, f1, git, head, temp, write } from "../fixtures/repo.js"

// Each test makes a git fixture (several git processes, slow on Windows).
setDefaultTimeout(60_000)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_ui")

/** An answer longer than the 2 KB a program handoff quotes. */
const ANSWER = `정렬 수정을 마쳤습니다. ${"남은 일은 테스트 정리입니다. ".repeat(200)}`

function routes(service: FakeService, folder: string) {
  service.routes.set(`GET /api/session/${OWNER_SESSION}`, () =>
    Response.json({ data: session({ id: OWNER_SESSION, directory: folder }) }),
  )
  service.routes.set(`GET /api/session/${OWNER_SESSION}/message`, () =>
    Response.json({
      data: [
        { id: "msg_2", type: "user", text: "고마워요" },
        { id: "msg_1", type: "assistant", content: [{ type: "text", text: ANSWER }] },
      ],
      cursor: {},
    }),
  )
}

async function setup(input: { readonly state?: "on" | "off" } = {}) {
  const box = temp("own-team-handoff-")
  cleanups.push(() => box.dispose())
  const repo = f1(box.root)
  const folder = path.join(box.root, "home-team", "ui")
  git(repo.home, ["worktree", "add", "-q", "-b", "ui", folder])
  const gitDir = git(folder, ["rev-parse", "--absolute-git-dir"]).trim()
  // The area's branch: one commit ahead of main, then main moves one ahead too, and one file is left uncommitted.
  write(folder, { "src/app/sort.ts": "export const sort = (a: number[]) => a.toSorted()\n" })
  commit(folder, "fix sort by rarity")
  write(repo.home, { "docs/guide.md": "guide 2\n" })
  commit(repo.home, "docs on main")
  write(folder, { "src/app/main.ts": "export const main = 'edited'\n" })
  const service = start()
  cleanups.push(() => service.stop())
  routes(service, folder)
  const world = new World()
  const clock = manual()
  const h = controller(world, { directory: repo.home, clock, source: service.source })
  cleanups.push(() => h.close())
  const record: OwnTeam.Area = {
    ...area({ slug: "ui", directory: folder }),
    name: "인벤토리 화면",
    goal: "정렬 버그와 UI",
    gitDir,
    base: { sha: repo.head, at: 0 },
    cone: { extra: { "Assets/Textures": { reason: "텍스처 확인", at: 0, bytes: 3 * 1024 * 1024 } }, kept: {} },
  }
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home: repo.home, state: input.state }))
    await h.services.registry.areas.put(record)
  })
  return { ...h, clock, service, home: repo.home, folder, record }
}

describe("write and read (06 §6.2 step 2, §6.4)", () => {
  test("writes areas/<slug>/handoff.md in the team records folder and records its hash", async () => {
    const h = await setup()
    const text = "# 인계: 인벤토리 화면 (2026-10-02, 담당 대화 #2)\n## 목표\n정렬\n"
    const written = await h.services.features().handoff.write({ teamID: TEAM_ID, areaID: UI, text, by: "owner" })
    const team = await h.services.registry.teams.get(TEAM_ID)
    const file = path.join(Teams.records(team!), "areas", "ui", "handoff.md")
    expect(written).toEqual({ ok: true, file, hash: Hash.sha256(text) })
    expect(file.startsWith(path.join(h.home, ".git", "own", "team", TEAM_ID))).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toBe(text)
    expect((await h.services.registry.areas.get(TEAM_ID, UI))?.handoff).toEqual({
      file,
      hash: Hash.sha256(text),
      at: h.clock.now(),
    })
    expect(h.published.some((event) => event.name === "area.changed" && event.data.areaID === UI)).toBe(true)
    expect(await h.services.features().handoff.read({ teamID: TEAM_ID, areaID: UI })).toBe(text)
  })

  test("a document over 64 KB keeps its first 64 KB, cut between characters", async () => {
    const h = await setup()
    const text = "가".repeat(30_000)
    const written = await h.services.features().handoff.write({ teamID: TEAM_ID, areaID: UI, text, by: "owner" })
    if (!written.ok) throw new Error(written.message)
    const stored = fs.readFileSync(written.file, "utf8")
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(Handoff.MAX_BYTES)
    expect(stored).toBe("가".repeat(Math.floor(Handoff.MAX_BYTES / 3)))
    expect(written.hash).toBe(Hash.sha256(stored))
    expect(Handoff.truncate("a가b", 2)).toBe("a")
    expect(Handoff.truncate("a가b", 4)).toBe("a가")
    expect(Handoff.truncate("short", Handoff.MAX_BYTES)).toBe("short")
  })

  test("no document yet reads as undefined; unknown areas and a team that is off are refused", async () => {
    const h = await setup()
    expect(await h.services.features().handoff.read({ teamID: TEAM_ID, areaID: UI })).toBeUndefined()
    expect(
      await h.services
        .features()
        .handoff.write({ teamID: TEAM_ID, areaID: OwnTeam.AreaID.make("ar_none"), text: "x", by: "owner" }),
    ).toMatchObject({ ok: false, error: "not_found", data: { what: "area" } })
    const off = await setup({ state: "off" })
    expect(
      await off.services.features().handoff.write({ teamID: TEAM_ID, areaID: UI, text: "x", by: "owner" }),
    ).toMatchObject({ ok: false, error: "team_off" })
  })
})

describe("the program handoff (06 §6.2 step 2): records, git and the last answer, no LLM call", () => {
  test("requests, reports, branch state, changed files, fetched folders and the first 2 KB of the last answer", async () => {
    const h = await setup()
    const sentAt = h.clock.now()
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.dispatches.put({
        id: OwnTeam.DispatchID.create(),
        teamID: TEAM_ID,
        areaID: UI,
        seq: 0,
        from: "main",
        kind: "task",
        task: "정렬 버그",
        text: "인벤토리 정렬이 희귀도를 무시합니다.\nItemSorter를 고치세요.",
        state: "sent",
        sentTo: { sessionID: OWNER_SESSION, msgID: MsgID.dispatch("dp_x", OWNER_SESSION), at: sentAt },
        createdAt: sentAt,
      })
      await h.services.registry.dispatches.put({
        id: OwnTeam.DispatchID.create(),
        teamID: TEAM_ID,
        areaID: UI,
        seq: 1,
        from: "main",
        kind: "task",
        text: "다음 일",
        state: "waiting",
        createdAt: sentAt,
      })
    })
    h.clock.advance(60_000)
    const reported = await h.services.features().events.report({
      teamID: TEAM_ID,
      areaID: UI,
      sessionID: OWNER_SESSION,
      kind: "done",
      text: "정렬 수정과 테스트 3개",
    })
    expect(reported).toMatchObject({ ok: true })

    const made = await h.services.features().handoff.program({ teamID: TEAM_ID, areaID: UI })
    if (!made.ok) throw new Error(made.message)
    const text = made.text
    expect(text.split("\n")[0]).toBe(Handoff.title(h.record, h.clock.now()))
    expect(text.split("\n")[0]).toMatch(/^# 인계: 인벤토리 화면 \(\d{4}-\d{2}-\d{2}, 담당 대화 #2\)$/)
    for (const heading of ["## 목표", "## 지금 상태", "## 끝낸 것", "## 남은 것", "## 결정과 이유", "## 주의"])
      expect(text).toContain(heading)
    expect(text).toContain("## 받은 큰 파일 폴더")
    expect(text).toContain("정렬 버그와 UI")
    expect(text).toContain("- 줄기: ui · main 대비 커밋 1개 앞섬, 1개 뒤처짐")
    expect(text).toContain(`- 마지막 커밋: ${head(h.folder).slice(0, 7)}`)
    expect(text).toContain("fix sort by rarity")
    expect(text).toContain("git diff --stat main...ui\n")
    expect(text).toContain("src/app/sort.ts")
    expect(text).not.toContain("docs/guide.md |")
    expect(text).toContain("- 커밋 안 된 변경: 파일 1개")
    expect(text).toContain('team_report(kind:"blocked")')
    expect(text).toContain("done (")
    expect(text).toContain("정렬 수정과 테스트 3개")
    expect(text).toContain("마지막 메인 요청 (")
    expect(text).toContain("인벤토리 정렬이 희귀도를 무시합니다. ItemSorter를 고치세요.")
    expect(text).toContain("기다리는 메인 요청 1개")
    expect(text).toContain("- Assets/Textures: 텍스처 확인 (3 MB)")
    const quoted = text.split("## 지난 담당의 마지막 답 (앞 2 KB)\n")[1] ?? ""
    expect(quoted.startsWith("> 정렬 수정을 마쳤습니다.")).toBe(true)
    const answer = quoted
      .split("\n")
      .filter((line) => line.startsWith("> "))
      .map((line) => line.slice(2))
      .join("\n")
    expect(Buffer.byteLength(answer, "utf8")).toBeLessThanOrEqual(Handoff.ANSWER_BYTES)
    expect(Buffer.byteLength(answer, "utf8")).toBeGreaterThan(Handoff.ANSWER_BYTES - 4)
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(Handoff.MAX_BYTES)
    expect(h.service.requests.some((request) => request.path.endsWith("/generate"))).toBe(false)
  })

  test("for a conversation that was there already and takes the seat (6.8), nothing in the note calls it new", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.dispatches.put({
        id: OwnTeam.DispatchID.create(),
        teamID: TEAM_ID,
        areaID: UI,
        seq: 0,
        from: "main",
        kind: "task",
        text: "다음 일",
        state: "waiting",
        createdAt: h.clock.now(),
      })
    })
    const made = await h.services.features().handoff.program({ teamID: TEAM_ID, areaID: UI, seat: true })
    if (!made.ok) throw new Error(made.message)
    expect(made.text).toContain("사용자가 이 대화를 이 영역의 담당으로 정했습니다")
    expect(made.text).toContain("- 기다리는 메인 요청 1개는 이 대화에 갑니다.")
    // The uncommitted change may be the reader's own work from before it took the seat.
    expect(made.text).toContain(
      '- 작업 폴더에 커밋 안 된 변경이 1개 있습니다. 이 대화가 만든 것도, 지난 담당 대화가 만든 것도 있을 수 있습니다. 누가 만들었는지 모르는 변경은 커밋·되돌리기·stash·덮어쓰기를 하지 말고 team_report(kind:"blocked")로 알리세요.',
    )
    expect(made.text).not.toContain("새 담당 대화")
    expect(made.text).not.toContain("이번 요청에서 만든 것이 아니면")
    // A rotation's note is as it was.
    const rotated = await h.services.features().handoff.program({ teamID: TEAM_ID, areaID: UI })
    if (!rotated.ok) throw new Error(rotated.message)
    expect(rotated.text).toContain("- 기다리는 메인 요청 1개는 새 담당 대화에 갑니다.")
    expect(rotated.text).toContain("이번 요청에서 만든 것이 아니면")
  })

  test("an area without requests, reports or folders says so", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, UI)
      if (current) await h.services.registry.areas.put({ ...current, cone: { extra: {}, kept: {} }, goal: "" })
    })
    h.service.routes.delete(`GET /api/session/${OWNER_SESSION}/message`)
    const made = await h.services.features().handoff.program({ teamID: TEAM_ID, areaID: UI })
    if (!made.ok) throw new Error(made.message)
    expect(made.text).toContain("(적힌 목표 없음)")
    expect(made.text).toContain("(보고 없음)")
    expect(made.text).toContain("(보낸 메인 요청 없음)")
    expect(made.text).not.toContain("## 지난 담당의 마지막 답")
    expect(made.text.split("## 받은 큰 파일 폴더\n")[1]?.startsWith("(없음)")).toBe(true)
  })

  test("area messages and notices sent after a main request never crowd it out of 남은 것 (06 §5.8)", async () => {
    const h = await setup()
    const at = h.clock.now()
    const base = { teamID: TEAM_ID, areaID: UI, state: "sent" as const }
    const sentTo = (id: string, offset: number) => ({
      sessionID: OWNER_SESSION,
      msgID: MsgID.dispatch(id, OWNER_SESSION),
      at: at + offset,
    })
    await h.services.write(TEAM_ID, async () => {
      const request = OwnTeam.DispatchID.create()
      await h.services.registry.dispatches.put({
        ...base,
        id: request,
        seq: 0,
        from: "main",
        kind: "task",
        text: "정렬을 고치세요",
        sentTo: sentTo(request, 0),
        createdAt: at,
      })
      for (const seq of [1, 2, 3]) {
        const id = OwnTeam.DispatchID.create()
        await h.services.registry.dispatches.put({
          ...base,
          id,
          seq,
          ...(seq === 3
            ? { from: "team" as const, kind: "notice" as const }
            : { from: "area" as const, kind: "ask" as const, sender: { areaID: UI, area: "세이브 v3" } }),
          text: `영역 메시지 ${seq}`,
          sentTo: sentTo(id, seq),
          createdAt: at + seq,
        })
      }
      await h.services.registry.dispatches.put({
        ...base,
        id: OwnTeam.DispatchID.create(),
        seq: 4,
        from: "area",
        kind: "ask",
        sender: { areaID: UI, area: "세이브 v3" },
        text: "기다리는 물음",
        state: "waiting",
        createdAt: at + 4,
      })
    })
    const made = await h.services.features().handoff.program({ teamID: TEAM_ID, areaID: UI })
    if (!made.ok) throw new Error(made.message)
    expect(made.text).toContain("마지막 메인 요청 (")
    expect(made.text).toContain("정렬을 고치세요")
    expect(made.text).not.toContain("영역 메시지")
    expect(made.text).not.toContain("기다리는 메인 요청")
  })
})

describe("team_handoff (06 §2.8)", () => {
  const tool = Tools.DEFINITIONS.find((item) => item.name === "handoff")!

  test("the area's owner writes the document; the reply advises 8 KB and says when it was cut", async () => {
    const h = await setup()
    const short = await tool.execute(h.services, OWNER_SESSION, { text: "# 인계: 인벤토리 화면\n## 목표\n정렬" })
    expect(short).toMatchObject({ ok: true, text: "인계 문서를 저장했습니다." })
    expect(short.hash).toBe(Hash.sha256("# 인계: 인벤토리 화면\n## 목표\n정렬"))
    const long = await tool.execute(h.services, OWNER_SESSION, { text: "a".repeat(9_000) })
    expect(long).toMatchObject({ ok: true, bytes: 9_000 })
    expect(long.text).toContain("8 KB")
    const huge = await tool.execute(h.services, OWNER_SESSION, { text: "가".repeat(30_000) })
    expect(huge).toMatchObject({ ok: true })
    expect(huge.text).toContain("64 KB")
    expect(fs.statSync(String(huge.file)).size).toBeLessThanOrEqual(Handoff.MAX_BYTES)
  })

  test("a replaced owner, the main and other sessions cannot write it", async () => {
    const h = await setup()
    expect(await tool.execute(h.services, OLD_OWNER, { text: "x" })).toEqual({
      ok: false,
      text: OwnerTools.PREVIOUS_OWNER,
    })
    expect(
      await tool.execute(h.services, SessionID.make("ses_other00000000000000000001"), { text: "x" }),
    ).toMatchObject({ ok: false })
    expect((await h.services.registry.areas.get(TEAM_ID, UI))?.handoff).toBeNull()
  })
})

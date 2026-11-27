// Decision records (06 §6.6, §2.4, §2.7 decisions.list/add, §12.2 Q3): `decisions/NNNN-<slug>.md` in the team
// records folder `<common dir>/own/team/<teamID>/`, numbered in the team's mutex, indexed in KV
// `decision:<teamID>:<NNNN>`, never written under the main folder; with `commitDecisions` on, the result carries the
// copy and the instruction for the main to commit it there. A git fixture in a temp folder and the real controller
// (registry, mutex, digest) on a manual clock; no network.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Decisions } from "../../src/docs/decisions.js"
import { Keys } from "../../src/registry/keys.js"
import { Digest } from "../../src/report/digest.js"
import { Teams } from "../../src/registry/team.js"
import { DecisionsRpc } from "../../src/rpc/decisions.js"
import type { Services } from "../../src/services.js"
import { DecideTool } from "../../src/tools/decide.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"
import { commit, files, init, status, temp, write } from "../fixtures/repo.js"

// The fixture runs a few git processes (slow on Windows).
setDefaultTimeout(60_000)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_inventory-ui")
const SAVE = OwnTeam.AreaID.make("ar_save-v3")
/** Noon UTC: the same calendar day in every time zone from UTC-11 to UTC+11. */
const NOON = Date.UTC(2026, 9, 2, 12, 0, 0)

async function setup(input: { readonly state?: "on" | "off"; readonly commitDecisions?: boolean } = {}) {
  const box = temp("own-team-decisions-")
  cleanups.push(() => box.dispose())
  const home = init(path.join(box.root, "home"))
  write(home, { "README.md": "readme\n" })
  commit(home, "init")
  const clock = manual(NOON)
  const h = controller(new World(), { directory: home, clock })
  cleanups.push(() => h.close())
  const record: OwnTeam.Team = {
    ...team({ home, state: input.state }),
    policy: { ...OwnTeam.POLICY, commitDecisions: input.commitDecisions ?? false },
  }
  // Areas without an owner conversation, so rendering a team update reads nothing over HTTP.
  const owned = (slug: string, name: string): OwnTeam.Area => ({
    ...area({ slug, directory: path.join(box.root, "home-team", slug) }),
    name,
    owner: { sessionID: null, previous: [], attached: true },
  })
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(record)
    await h.services.registry.areas.put(owned("inventory-ui", "인벤토리 화면"))
    await h.services.registry.areas.put(owned("save-v3", "세이브 v3"))
  })
  return { ...h, clock, home, folder: path.join(Teams.records(record), "decisions") }
}

type Harness = Awaited<ReturnType<typeof setup>>

function add(h: Harness, input: Partial<Decisions.AddInput> & { readonly title: string }) {
  return Decisions.add(h.services, { teamID: TEAM_ID, body: "", source: "main", ...input })
}

function rpc(services: Services.Context) {
  // SAFETY (test): each handler takes its method's input and `{signal, error}`; `error` returns what it answers.
  const loose = DecisionsRpc.handlers(services) as unknown as Record<
    string,
    (input: unknown, context: unknown) => Promise<unknown>
  >
  return (method: DecisionsRpc.Methods, input: unknown) =>
    loose[method]!(input, {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    })
}

describe("records (06 §6.6)", () => {
  test("writes decisions/NNNN-<slug>.md in the team records folder with the header, and indexes it", async () => {
    const h = await setup()
    const added = await add(h, {
      title: "Use snake_case for save fields",
      body: "세이브 파일의 필드 이름은 snake_case로 씁니다.\n이유: 옛 세이브와 맞추기 위해서입니다.\n\n",
      areas: [SAVE, UI, SAVE],
    })
    if (!added.ok) throw new Error(added.message)
    const file = path.join(h.home, ".git", "own", "team", TEAM_ID, "decisions", "0001-use-snake-case.md")
    expect(added.path).toBe(file)
    expect(added.record).toEqual({
      number: 1,
      title: "Use snake_case for save fields",
      file: "decisions/0001-use-snake-case.md",
      at: NOON,
      source: "main",
      areas: [SAVE, UI],
    })
    expect(added.commit).toBeUndefined()
    expect(fs.readFileSync(file, "utf8")).toBe(
      [
        "# 결정 기록 0001: Use snake_case for save fields",
        "",
        "- 번호: 0001",
        "- 날짜: 2026-10-02",
        "- 출처: 메인이 적음",
        "- 관련 영역: 세이브 v3 (ar_save-v3), 인벤토리 화면 (ar_inventory-ui)",
        "",
        "세이브 파일의 필드 이름은 snake_case로 씁니다.",
        "이유: 옛 세이브와 맞추기 위해서입니다.",
        "",
      ].join("\n"),
    )
    expect(await h.services.kv.get(Keys.decision(TEAM_ID, 1))).toEqual(
      Keys.toJson(Schema.encodeSync(OwnTeam.DecisionRecord)(added.record)),
    )
    expect(await Decisions.list(h.services, TEAM_ID)).toEqual({ ok: true, items: [added.record] })
  })

  test("a user's record without areas or body has the short header; a title on several lines becomes one line", async () => {
    const h = await setup()
    const added = await add(h, { title: "  세이브   형식은\n v3로\t고정  ", source: "user" })
    if (!added.ok) throw new Error(added.message)
    expect(added.record.title).toBe("세이브 형식은 v3로 고정")
    expect(added.record.file).toBe("decisions/0001-v3.md")
    expect(fs.readFileSync(added.path, "utf8")).toBe(
      [
        "# 결정 기록 0001: 세이브 형식은 v3로 고정",
        "",
        "- 번호: 0001",
        "- 날짜: 2026-10-02",
        "- 출처: 사용자가 적음",
        "- 관련 영역: 없음",
        "",
      ].join("\n"),
    )
  })

  test("concurrent adds get sequential numbers through the team mutex; the list is in number order", async () => {
    const h = await setup()
    const titles = Array.from({ length: 8 }, (_, index) => `choice ${index + 1}`)
    const added = await Promise.all(titles.map((title) => add(h, { title })))
    const records = added.map((item) => {
      if (!item.ok) throw new Error(item.message)
      return item.record
    })
    expect(records.map((record) => record.number).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // Each file carries its own number, and no two records share a file.
    for (const record of records) {
      expect(record.file).toBe(`decisions/${String(record.number).padStart(4, "0")}-choice-${record.title.slice(7)}.md`)
      expect(fs.readFileSync(path.join(h.folder, path.basename(record.file)), "utf8")).toStartWith(
        `# 결정 기록 ${String(record.number).padStart(4, "0")}: ${record.title}\n`,
      )
    }
    expect(fs.readdirSync(h.folder).toSorted()).toEqual(records.map((record) => path.basename(record.file)).toSorted())
    const listed = await Decisions.list(h.services, TEAM_ID)
    expect(listed.ok && listed.items.map((record) => record.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect((await h.services.kv.scan(Keys.prefix.decisions(TEAM_ID))).map((entry) => entry.key)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((number) => Keys.decision(TEAM_ID, number)),
    )
  })

  test("numbers continue after files kept from an earlier team record and after the highest index entry", async () => {
    const h = await setup()
    // Undoing enable removes the index but keeps the records folder.
    fs.mkdirSync(h.folder, { recursive: true })
    fs.writeFileSync(path.join(h.folder, "0007-old-choice.md"), "# 결정 기록 0007: old choice\n")
    fs.writeFileSync(path.join(h.folder, "notes.txt"), "not a record\n")
    const first = await add(h, { title: "after the old files" })
    expect(first.ok && first.record.number).toBe(8)
    await h.services.kv.set(
      Keys.decision(TEAM_ID, 12),
      Keys.toJson(
        Schema.encodeSync(OwnTeam.DecisionRecord)({
          number: 12,
          title: "indexed only",
          file: "decisions/0012-indexed-only.md",
          at: NOON,
          source: "user",
          areas: [],
        }),
      ),
    )
    const second = await add(h, { title: "after the index" })
    expect(second.ok && second.record.number).toBe(13)
    const listed = await Decisions.list(h.services, TEAM_ID)
    // The list is the index; files without an entry are not listed.
    expect(listed.ok && listed.items.map((record) => record.number)).toEqual([8, 12, 13])
  })

  test("a failed file write leaves no index entry and uses no number", async () => {
    const h = await setup()
    const failed = await Decisions.add(
      {
        ...h.services,
        files: {
          write: async () => {
            throw new Error("disk full")
          },
          names: Decisions.files.names,
        },
      },
      { teamID: TEAM_ID, title: "lost", body: "", source: "main" },
    )
    expect(failed).toMatchObject({ ok: false, error: "internal_error" })
    expect(failed.ok ? "" : failed.message).toContain("disk full")
    expect(await h.services.kv.scan(Keys.prefix.decisions(TEAM_ID))).toEqual([])
    const next = await add(h, { title: "kept" })
    expect(next.ok && next.record.number).toBe(1)
  })

  test("an unknown team or area, a team that is off and a blank title are refused; nothing is written", async () => {
    const h = await setup()
    expect(
      await Decisions.add(h.services, {
        teamID: OwnTeam.TeamID.make("tm_000000000000"),
        title: "x",
        body: "",
        source: "main",
      }),
    ).toMatchObject({
      ok: false,
      error: "not_found",
      data: { what: "team", id: "tm_000000000000" },
    })
    expect(await add(h, { title: "x", areas: [UI, OwnTeam.AreaID.make("ar_gone")] })).toMatchObject({
      ok: false,
      error: "not_found",
      data: { what: "area", id: "ar_gone" },
    })
    expect(await add(h, { title: " \n\t " })).toMatchObject({ ok: false, error: "unsupported" })
    expect(fs.existsSync(h.folder)).toBe(false)
    expect(await h.services.kv.scan(Keys.prefix.decisions(TEAM_ID))).toEqual([])

    const off = await setup({ state: "off" })
    expect(await add(off, { title: "x" })).toMatchObject({ ok: false, error: "team_off", data: { teamID: TEAM_ID } })
    expect(fs.existsSync(off.folder)).toBe(false)
    // Listing works for a team that is off; an unknown team is not found.
    expect(await Decisions.list(off.services, TEAM_ID)).toEqual({ ok: true, items: [] })
    expect(await Decisions.list(off.services, OwnTeam.TeamID.make("tm_000000000000"))).toMatchObject({
      ok: false,
      error: "not_found",
    })
  })
})

describe("file names and limits", () => {
  test("the slug is at most three ASCII words of the title, lower case; `decision` when there are none", () => {
    expect(Decisions.slug("Use snake_case for save fields")).toBe("use-snake-case")
    expect(Decisions.slug("필드 이름은 snake_case")).toBe("snake-case")
    expect(Decisions.slug("세이브 형식 결정")).toBe(Decisions.FALLBACK_SLUG)
    expect(Decisions.slug("Café déjà vu")).toBe("cafe-deja-vu")
    expect(Decisions.slug("ＡＰＩ v2 ‒ keep")).toBe("api-v2-keep")
    expect(Decisions.slug("Supercalifragilisticexpialidocious API")).toBe("supercalifragili-api")
    expect(Decisions.slug("../../etc/passwd")).toBe("etc-passwd")
    expect(Decisions.slug("a b c d e").split("-")).toHaveLength(Decisions.SLUG_WORDS)
    expect(Decisions.name(4, "Pick Bun")).toBe("0004-pick-bun.md")
    expect(Decisions.name(12_345, "x")).toBe("12345-x.md")
  })

  test("titles over 200 and bodies over 65,536 characters are refused where they arrive", () => {
    const valid = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
      Option.isSome(Schema.decodeUnknownOption(schema)(value))
    const rpcInput = OwnTeam.Definition.methods["decisions.add"].input
    const base = { teamID: TEAM_ID, title: "t", body: "" }
    expect(valid(rpcInput, { ...base, title: "가".repeat(200), body: "b".repeat(65_536) })).toBe(true)
    expect(valid(rpcInput, { ...base, title: "가".repeat(201) })).toBe(false)
    expect(valid(rpcInput, { ...base, title: "" })).toBe(false)
    expect(valid(rpcInput, { ...base, body: "b".repeat(65_537) })).toBe(false)
    expect(valid(DecideTool.Input, { title: "가".repeat(200), body: "b".repeat(65_536) })).toBe(true)
    expect(valid(DecideTool.Input, { title: "가".repeat(201), body: "" })).toBe(false)
    expect(valid(DecideTool.Input, { title: "t", body: "b".repeat(65_537) })).toBe(false)
  })

  test("the judge gets the newest titles as `NNNN 제목`, oldest first", async () => {
    const h = await setup()
    for (const title of ["first", "second", "third"]) await add(h, { title })
    expect(await Decisions.titles(h.services, TEAM_ID)).toEqual(["0001 first", "0002 second", "0003 third"])
    expect(await Decisions.titles(h.services, TEAM_ID, 2)).toEqual(["0002 second", "0003 third"])
    expect(await Decisions.titles(h.services, TEAM_ID, 0)).toEqual([])
  })
})

describe("commitDecisions (06 §12.2 Q3)", () => {
  test("off: nothing is written under the main folder and there is no copy", async () => {
    const h = await setup()
    const added = await add(h, { title: "keep records out of the repo", body: "기록은 팀 기록 폴더에만 둡니다." })
    expect(added.ok && added.commit).toBeUndefined()
    expect(status(h.home)).toBe("")
    expect(files(h.home)).toEqual(["README.md"])
  })

  test("on: the result carries the copy and the instruction for the main; the program still writes nothing there", async () => {
    const h = await setup({ commitDecisions: true })
    const added = await add(h, { title: "Pick Bun for scripts", body: "스크립트는 Bun으로 씁니다." })
    if (!added.ok) throw new Error(added.message)
    expect(added.commit).toEqual({
      directory: h.home,
      path: "docs/decisions/0001-pick-bun-for.md",
      text: fs.readFileSync(added.path, "utf8"),
      instruction: expect.any(String),
    })
    const instruction = added.commit?.instruction ?? ""
    expect(instruction).toContain(h.home)
    expect(instruction).toContain(added.path)
    expect(instruction).toContain("git add -- docs/decisions/0001-pick-bun-for.md")
    expect(instruction).toContain("그 파일만 커밋하세요")
    expect(instruction).toContain('"결정 기록 0001"')
    expect(status(h.home)).toBe("")
    expect(files(h.home)).toEqual(["README.md"])
  })
})

describe("decisions.* RPC (06 §2.7)", () => {
  test("the group implements `decisions`", () => {
    expect(DecisionsRpc.FEATURES).toEqual(["decisions"])
  })

  test("결정 적기 writes a user record and folds a decision line into the main's next team update (no wake)", async () => {
    const h = await setup()
    const call = rpc(h.services)
    expect(await call("decisions.add", { teamID: TEAM_ID, title: "필드 이름은 snake_case", body: "이유는 …" })).toEqual(
      {
        number: 1,
        file: "decisions/0001-snake-case.md",
      },
    )
    expect(await call("decisions.add", { teamID: TEAM_ID, title: "second", body: "" })).toEqual({
      number: 2,
      file: "decisions/0002-second.md",
    })
    const listed = await call("decisions.list", { teamID: TEAM_ID })
    expect(listed).toEqual({
      items: [
        {
          number: 1,
          title: "필드 이름은 snake_case",
          file: "decisions/0001-snake-case.md",
          at: NOON,
          source: "user",
          areas: [],
        },
        { number: 2, title: "second", file: "decisions/0002-second.md", at: NOON, source: "user", areas: [] },
      ],
    })
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    const lines = text.split("\n").filter((line) => OwnTeamText.countOf(line) === "decided")
    const file = path.join(h.folder, "0001-snake-case.md")
    expect(lines).toEqual([
      OwnTeamText.decisionLine({ number: 1, title: "필드 이름은 snake_case", source: "user", detail: `내용: ${file}` }),
      OwnTeamText.decisionLine({
        number: 2,
        title: "second",
        source: "user",
        detail: `내용: ${path.join(h.folder, "0002-second.md")}`,
      }),
    ])
    // A user's decision never wakes the main (06 §5.6): the folded entries do not wake.
    const state = await Digest.load(h.services.kv, TEAM_ID)
    expect(state.entries.map((item) => [item.reason, item.wake])).toEqual([
      ["decided", false],
      ["decided", false],
    ])
  })

  test("with commitDecisions on, the team update note tells the main to commit the copy", async () => {
    const h = await setup({ commitDecisions: true })
    await rpc(h.services)("decisions.add", { teamID: TEAM_ID, title: "Pick Bun", body: "" })
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    const line = text.split("\n").find((item) => OwnTeamText.countOf(item) === "decided")
    expect(line).toStartWith(
      '- 결정 기록 0001(사용자가 적음): "Pick Bun" · 결정 기록 사본을 프로젝트에 남기는 설정이 켜져',
    )
    expect(line).toContain("docs/decisions/0001-pick-bun.md")
    expect(status(h.home)).toBe("")
  })

  test("declared errors: an unknown team, a team that is off", async () => {
    const h = await setup({ state: "off" })
    const call = rpc(h.services)
    expect(await call("decisions.add", { teamID: TEAM_ID, title: "x", body: "" })).toMatchObject({
      type: "team_off",
      data: { teamID: TEAM_ID },
    })
    expect(await call("decisions.list", { teamID: "tm_000000000000" })).toMatchObject({
      type: "not_found",
      data: { what: "team", id: "tm_000000000000" },
    })
    expect(await call("decisions.add", { teamID: "tm_000000000000", title: "x", body: "" })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
  })
})

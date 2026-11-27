// TG10 진행 중 프로젝트 받아들이기, TG15 (adopt items), TG9 (adopted items) and TG16 (adopted sessions) on a real
// server (06 §3.6, §3.7, §8.8, §10.1, §11.3; 07 §5.4). The project is F4 (`fixtures/f4-layout.ts`): a `#` primary
// worktree, the home with five nested `.worktrees\` folders of mixed activity, two `.claude\worktrees\`, another
// tool's folder, a detached HEAD with unique commits and a stopped merge, two stashes, modified and untracked files,
// an ignored fake `node_modules`. Conversations per folder: the home and cl-cu on ChatGPT 01 (the team's account; cl-cu
// with a preset that is not its group's ★), cl-perf (in a subfolder) on ChatGPT 02, cl-siwc on the Sign in with
// ChatGPT account of ChatGPT 01's login, computer-use on the Claude subscription slot. The judge adopts those four
// folders (`[propose-areas adopt …]`).
//
// - Enabling changes nothing outside the team and no file in the adopted folders; the home and the areas are locked,
//   the detached commits get a keep ref, each folder's newest conversation (by the longest folder prefix) is its
//   owner, unattached; no conversation's instructions, rules, preset binding, tools or catalog change (TG16 delta 0).
// - Area mains: each conversation keeps its Ref and preset, except ChatGPT 02 (another subscription of the team's
//   company): 팀과 같게 with the ★ and an R4 line on the card. The siwc account of ChatGPT 01's login is the same
//   subscription and the Claude slot another company: both kept.
// - The first main request attaches (delta 1: the catalog changes once, the conversation continues, a hold ref keeps
//   the folder's uncommitted work after direct talk); ChatGPT 02's conversation continues on the team account in a new
//   conversation from a program handoff without one ChatGPT 02 request; the Claude conversation continues as it is.
// - A nested area whose `.git` is removed is `broken` at the next reconcile; its release and integration are refused
//   and the home is not touched.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam, Preset } from "@own/protocol"
import { instructionEntries, type ModelRef } from "../../../own-accounts/test/e2e-kit"
import { TeamHome } from "../../src/ops/home.js"
import { Areas } from "../../src/registry/area.js"
import { Keys } from "../../src/registry/keys.js"
import { Worktree } from "../../src/git/worktree.js"
import { f4, type F4 } from "../fixtures/f4-layout.js"
import { git, status } from "../fixtures/repo.js"
import {
  ACCOUNT,
  BOOT_TIMEOUT,
  CLAUDE,
  MODEL,
  SLOT,
  active,
  catalogUpdates,
  codexIdentity,
  enableTeam,
  mainRequests,
  opEnd,
  ops,
  pin,
  presetOf,
  same,
  savePreset,
  sessionRows,
  siwcModel,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { catalog, catalogHashes, files, kv, ofSession, sessionLog, toolBytes, toolsHash, worktrees } from "./inspect.js"

const STEP_TIMEOUT = 300_000
const SIWC = { slug: "tms1", model: siwcModel("tms1") } as const
const AREA = {
  cu: Areas.id("cl-cu"),
  perf: Areas.id("cl-perf"),
  siwc: Areas.id("cl-siwc"),
  computerUse: Areas.id("computer-use"),
}
const ADOPTED = ["cl-cu", "cl-perf", "cl-siwc", "computer-use"] as const

interface Conversations {
  readonly home: string
  readonly cu: string
  readonly perf: string
  readonly siwc: string
  readonly claude: string
}

interface Team {
  readonly server: TeamServer
  readonly repo: F4
  readonly sessions: Conversations
  /** The non-★ preset of cl-cu's conversation. */
  readonly review: Preset.ID
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly op: OwnTeam.Op
  /** Every conversation's state right before the enable (rules, entries, binding, approval mode). */
  readonly before: Readonly<Record<string, Durable>>
  /** Outside folders and adopted folders right before the enable. */
  readonly folders: Readonly<Record<string, Snapshot>>
  readonly stashes: string
}

interface Durable {
  readonly rules: string
  readonly entries: string
  readonly binding: string
  readonly mode: unknown
}

describe("TG10/TG15/TG9/TG16: enabling on F4 adopts the folders in progress (real server)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const layout: { repo?: F4 } = {}
    const server = await startTeamServer({
      name: "adopt",
      claude: true,
      siwc: [{ slug: SIWC.slug, of: "01" }],
      project: (root) => {
        layout.repo = f4(root)
        return layout.repo.home
      },
    })
    const repo = required(layout.repo)
    const review = await savePreset(server, "다른 회사 리뷰", "codex", {
      "own-review": [pin(ACCOUNT.deepseek, MODEL.deepseek.id)],
    })
    const create = (title: string, directory: string, model: ModelRef) =>
      server.createSession({ title, directory, model })
    const sessions: Conversations = {
      home: await create("메인 폴더 대화", repo.home, MODEL["01"]),
      cu: await create("컴퓨터 사용 대화", repo.nested["cl-cu"], MODEL["01"]),
      // In a subfolder: the longest prefix is cl-perf, not the home around it.
      perf: await create("성능 대화", path.join(repo.nested["cl-perf"], "packages", "own-web"), MODEL["02"]),
      siwc: await create("siwc 대화", repo.nested["cl-siwc"], SIWC.model),
      claude: await create("Claude 대화", repo.nested["computer-use"], CLAUDE.model),
    }
    await server.accounts("session.preset.apply", { sessionID: sessions.cu, presetID: review }, repo.nested["cl-cu"])
    // History before adoption (the siwc slot's endpoint is a 404 fake, so that conversation stays empty).
    await server.turn(sessions.cu, "받아들이기 전 대화")
    await server.turn(sessions.perf, "다른 계정의 대화")
    await server.turn(sessions.claude, "Claude 구독의 대화")
    const directories = {
      [sessions.home]: repo.home,
      [sessions.cu]: repo.nested["cl-cu"],
      [sessions.perf]: repo.nested["cl-perf"],
      [sessions.siwc]: repo.nested["cl-siwc"],
      [sessions.claude]: repo.nested["computer-use"],
    }
    const before = Object.fromEntries(
      await Promise.all(
        Object.entries(directories).map(async ([id, directory]) => [id, await durable(server, id, directory)] as const),
      ),
    )
    const folders = Object.fromEntries(outside(repo).map((directory) => [directory, snapshot(directory)]))
    const stashes = git(repo.primary, ["stash", "list"])

    const enabled = await enableTeam(server, {
      hint: `[propose-areas adopt ${ADOPTED.join(" ")}]`,
      sessionID: sessions.home,
    })
    const team = required(enabled.view.team ?? undefined)
    state.team = {
      server,
      repo,
      sessions,
      review,
      teamID: team.id,
      main: team.main.sessionID,
      op: enabled.op,
      before,
      folders,
      stashes,
    }
  }, BOOT_TIMEOUT * 2)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "nothing outside the team changes; the home and the areas are locked; the detached commits are kept",
    async () => {
      const team = required(state.team)
      const repo = team.repo
      expect(team.op.state).toBe("done")
      expect(team.op.steps.filter((step) => step.state !== "done")).toEqual([])
      expect(team.op.steps.filter((step) => step.kind === "adopt.register")).toHaveLength(ADOPTED.length)
      for (const [directory, before] of Object.entries(team.folders)) expect(snapshot(directory)).toEqual(before)
      expect(git(repo.primary, ["stash", "list"])).toBe(team.stashes)
      expect(fs.readFileSync(path.join(repo.home, "node_modules", "pkg", "data.bin"), "utf8")).toBe("y".repeat(5_000))

      const view = await team.server.team("team.get", { directory: repo.home })
      const record = required(view.team ?? undefined)
      expect(record.home).toMatchObject({ linked: true, chosenBy: "session" })
      expect(same(record.home.directory, repo.home)).toBe(true)
      const listed = worktrees(repo.primary)
      const lock = (directory: string) => listed.find((entry) => same(entry.path, directory))?.locked ?? null
      expect(lock(repo.home)).toBe(TeamHome.reason(team.teamID))
      for (const [areaID, name] of [
        [AREA.cu, "cl-cu"],
        [AREA.perf, "cl-perf"],
        [AREA.siwc, "cl-siwc"],
        [AREA.computerUse, "computer-use"],
      ] as const)
        expect(lock(repo.nested[name])).toBe(Worktree.lockReason(areaID))
      expect(lock(repo.locked)).toBe("kept by the user")
      for (const directory of [repo.primary, repo.codex, repo.detached, repo.hash, repo.nested["local-model"]])
        expect(lock(directory)).toBeNull()

      // TI-8: the detached HEAD's unique commits are kept although the folder stays outside the team.
      const detached = git(repo.detached, ["rev-parse", "HEAD"]).trim()
      expect(git(repo.primary, ["rev-parse", `refs/own/keep/${detached}`]).trim()).toBe(detached)
      expect(record.external.find((item) => same(item.directory, repo.primary))?.why).toBe("primary")
      expect(record.external.find((item) => same(item.directory, repo.codex))?.why).toBe("other-tool")
      expect(record.external.find((item) => same(item.directory, repo.detached))?.why).toBe("left")
    },
    STEP_TIMEOUT,
  )

  test(
    "the areas keep their folders' conversations, Refs and presets; ChatGPT 02 alone becomes 팀과 같게 with an R4 line",
    async () => {
      const team = required(state.team)
      const repo = team.repo
      const view = await team.server.team("team.get", { directory: repo.home })
      expect(view.areas.map((area) => area.id).toSorted()).toEqual(Object.values(AREA).toSorted())
      for (const area of view.areas) {
        expect(area).toMatchObject({ origin: "adopted", state: "active", paused: false, shape: "plain" })
        expect(area.owner.attached).toBe(false)
        expect(area.owner.previous).toEqual([])
        expect(area.cone).toEqual({ extra: {}, kept: {} })
      }
      const byID = (id: OwnTeam.AreaID) => required(view.areas.find((area) => area.id === id))
      // The longest folder prefix: the conversation in cl-perf's subfolder is cl-perf's owner.
      expect(byID(AREA.cu)).toMatchObject({ name: "cl-cu", branch: "own-computer-use" })
      expect<unknown>(byID(AREA.cu).owner.sessionID).toBe(team.sessions.cu)
      expect<unknown>(byID(AREA.perf).owner.sessionID).toBe(team.sessions.perf)
      expect<unknown>(byID(AREA.siwc).owner.sessionID).toBe(team.sessions.siwc)
      expect<unknown>(byID(AREA.computerUse).owner.sessionID).toBe(team.sessions.claude)
      expect(byID(AREA.cu).base.sha).toBe(repo.base)

      // ChatGPT 01 with a preset that is not its group's ★: both stay.
      expect(byID(AREA.cu).main).toMatchObject({ model: { providerID: SLOT["01"] }, chosenBy: "adopted" })
      expect(byID(AREA.cu).preset).toBe(team.review)
      // ChatGPT 02: another subscription of the team's company (R4): 팀과 같게 with the group's ★.
      expect(byID(AREA.perf).main).toBeUndefined()
      expect(byID(AREA.perf).preset).toBe(Preset.builtinID("codex"))
      // One ChatGPT login's siwc account is the team's subscription; the Claude slot is another company: both kept.
      expect(byID(AREA.siwc).main).toMatchObject({ model: { providerID: SIWC.model.providerID }, chosenBy: "adopted" })
      expect(byID(AREA.siwc).preset).toBe(Preset.builtinID("siwc"))
      expect(byID(AREA.computerUse).main).toMatchObject({
        model: { providerID: CLAUDE.model.providerID },
        chosenBy: "adopted",
      })
      expect(byID(AREA.computerUse).preset).toBe(Preset.builtinID("claude-sub"))

      // The card: the four adopted areas, the R4 line, the active folder left out (V13), the keep ref.
      const lines = team.op.summary?.lines ?? []
      expect(
        lines.flatMap((line) => (line.kind === "area" ? [`${line.areaID}:${line.change}`] : [])).toSorted(),
      ).toEqual(
        Object.values(AREA)
          .map((id) => `${id}:adopted`)
          .toSorted(),
      )
      expect<unknown>(lines).toContainEqual({ kind: "r4", areaID: AREA.perf, accountID: ACCOUNT["02"] })
      const left = lines.flatMap((line) => (line.kind === "unadopted" ? [line] : []))
      expect(left.map((line) => same(line.directory, repo.detached))).toEqual([true])
      expect(left[0]).toMatchObject({ ahead: 2 })
      expect(lines.some((line) => line.kind === "ref")).toBe(true)
      expect(lines.some((line) => line.kind === "skipped")).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "enabling wrote nothing to a conversation: rules, instruction entries, preset bindings and modes; cursors set",
    async () => {
      const team = required(state.team)
      const repo = team.repo
      const directories = {
        [team.sessions.home]: repo.home,
        [team.sessions.cu]: repo.nested["cl-cu"],
        [team.sessions.perf]: repo.nested["cl-perf"],
        [team.sessions.siwc]: repo.nested["cl-siwc"],
        [team.sessions.claude]: repo.nested["computer-use"],
      }
      for (const [id, directory] of Object.entries(directories))
        expect(await durable(team.server, id, directory)).toEqual(required(team.before[id]))
      // The owners' cursors start at their logs' newest seq: their history before adoption is never team news.
      const stored = kv(team.server.server.paths.database)
      for (const id of [team.sessions.cu, team.sessions.perf, team.sessions.claude]) {
        const log = await sessionLog(team.server.server, id, { directory: directories[id] })
        expect(stored[Keys.cursor(id)]).toBe(required(log.seq))
      }
    },
    STEP_TIMEOUT,
  )

  test(
    "TG16 delta 0 at enable and 1 at the first main request: cl-cu's catalog changes once, the conversation goes on",
    async () => {
      const team = required(state.team)
      const repo = team.repo
      const fakes = team.server.fakes
      const id = team.sessions.cu
      // Direct talk after the enable: the same tools and catalog as before it, no team tool.
      await team.server.turn(id, "켠 뒤의 대화")
      const plain = ofSession(fakes.codex.requests, id)
      expect(new Set(plain.map(toolsHash)).size).toBe(1)
      expect(new Set(plain.map(toolBytes)).size).toBe(1)
      expect(catalogHashes(plain).size).toBe(1)
      expect(catalog(required(plain[0])) ?? "").not.toContain("tools.team.")
      const seen = plain.length

      await team.server.turn(team.main, "[dispatch cl-cu [report progress 이어서 합니다]]")
      await settled(team, id, 1)
      const area = await areaOf(team, AREA.cu)
      // Attached in place: the same conversation, no rotation, its Ref and its preset.
      expect(area.owner).toMatchObject({ sessionID: id, attached: true, previous: [] })
      expect(ops(db(team), team.teamID).filter((op) => op.kind === "rotate")).toEqual([])
      expect(rowOf(team, id).model).toMatchObject({ providerID: SLOT["01"] })
      expect((await presetOf(team.server, id, repo.nested["cl-cu"])).binding?.presetID).toBe(team.review)
      const rules = rowOf(team, id).permission
      expect(rules.slice(0, 2)).toEqual([
        { action: "team.owner", resource: "*", effect: "allow" },
        { action: "team.member", resource: "*", effect: "allow" },
      ])
      expect((await instructionEntries(team.server.server, id)).map((entry) => entry.key)).toContain("own.team.role")
      expect((await team.server.accounts("session.approval.get", { sessionID: id }, repo.nested["cl-cu"])).mode).toBe(
        required(team.before[id]).mode,
      )
      // Delta 1: the system prompt's catalog (the cached prefix) and the tool definitions stay; the attach reaches the
      // model once, as core's catalog update message with the team tools in the first request after it.
      const after = ofSession(fakes.codex.requests, id).slice(seen)
      expect(after.length).toBeGreaterThan(0)
      expect(catalogHashes([...plain, ...after]).size).toBe(1)
      expect(new Set([...plain, ...after].map(toolsHash)).size).toBe(1)
      expect(new Set([...plain, ...after].map(toolBytes)).size).toBe(1)
      expect(plain.flatMap(catalogUpdates)).toEqual([])
      const updates = after.flatMap(catalogUpdates)
      expect(new Set(updates).size).toBe(1)
      expect(catalogUpdates(required(after[0]))).toEqual([required(updates[0])])
      // The team namespace comes in that update. Since upstream v2.4 an update shows the listings that fit its budget
      // (descriptions up to 2,000 characters) in path order and points to `search(...)` for the rest; `team.report`,
      // late in that order, may be among them.
      expect(updates[0]).toMatch(/^- team \(\d+ tools/m)
      expect(updates[0]).toContain("tools.team.area(")
      if (!updates[0]?.includes("tools.team.report(")) expect(updates[0]).toContain("search(")
      // TI-1: direct talk since the last request and 9 uncommitted files: a hold ref was made before the request.
      const holds = git(repo.primary, ["for-each-ref", "--format=%(refname)", `refs/own/hold/${AREA.cu}/`]).trim()
      expect(holds.split("\n").filter(Boolean)).toHaveLength(1)
      expect(status(repo.nested["cl-cu"])).toBe(required(team.folders[repo.nested["cl-cu"]]).status)
    },
    STEP_TIMEOUT,
  )

  test(
    "the R4 exception: ChatGPT 02's conversation continues on the team account, ChatGPT 02 runs nothing for the team",
    async () => {
      const team = required(state.team)
      const fakes = team.server.fakes
      const old = team.sessions.perf
      const two = () => fakes.codex.requests.filter((request) => request.identity === codexIdentity("02")).length
      const before = two()
      await team.server.turn(team.main, "[dispatch cl-perf [report progress 팀 계정으로 이어서]]")
      const rotation = await waitValue(
        async () =>
          ops(db(team), team.teamID).find((op) => op.kind === "rotate" && op.areaID === AREA.perf) ?? undefined,
        "no rotation for cl-perf",
        STEP_TIMEOUT,
      )
      expect((await opEnd(team.server, rotation.id)).state).toBe("done")
      const area = await waitValue(
        async () => {
          const found = await areaOf(team, AREA.perf)
          return found.owner.sessionID !== old && found.owner.pending === undefined ? found : undefined
        },
        "cl-perf never got its new owner",
        STEP_TIMEOUT,
      )
      const next = required(area.owner.sessionID ?? undefined)
      await settled(team, next, 1)
      expect(area.owner).toMatchObject({ previous: [{ sessionID: old, why: "r4" }], attached: true })
      // The program wrote the handoff; no turn ran on ChatGPT 02 before or during the move.
      expect(fs.existsSync(required(area.handoff?.file))).toBe(true)
      expect(two()).toBe(before)
      expect(rowOf(team, next).model).toMatchObject({ providerID: SLOT["01"] })
      expect(rowOf(team, old).metadata["own.archived"]).toBe(true)
      expect(await mainRequests(team.server, old)).toEqual([])
      expect(ofSession(fakes.codex.requests, next).map((request) => request.identity)).not.toContain(
        codexIdentity("02"),
      )
    },
    STEP_TIMEOUT,
  )

  test(
    "the Claude subscription's conversation is attached and continues on the Claude slot",
    async () => {
      const team = required(state.team)
      const id = team.sessions.claude
      const before = ofSession(team.server.fakes.anthropic.requests, id).length
      await team.server.turn(team.main, "[dispatch computer-use [report progress 클로드로 이어서]]")
      await settled(team, id, 1)
      expect((await areaOf(team, AREA.computerUse)).owner).toMatchObject({ sessionID: id, attached: true })
      expect(rowOf(team, id).model).toMatchObject({ providerID: CLAUDE.model.providerID })
      expect(ofSession(team.server.fakes.anthropic.requests, id).length).toBeGreaterThan(before)
    },
    STEP_TIMEOUT,
  )

  test(
    "a nested area whose .git was removed is broken; release and integration are refused; the home is untouched",
    async () => {
      const team = required(state.team)
      const repo = team.repo
      const folder = repo.nested["computer-use"]
      const home = homeSnapshot(repo.home)
      fs.rmSync(path.join(folder, ".git"), { force: true })
      // Reconcile runs after an owner's run ends (8.8 "안전 지점마다").
      await team.server.turn(team.sessions.cu, "맞추기 계기")
      const broken = await waitValue(
        async () => {
          const area = await areaOf(team, AREA.computerUse)
          return area.state === "broken" ? area : undefined
        },
        "the area never became broken",
        STEP_TIMEOUT,
      )
      expect(broken.broken?.why).toBe("identity")
      const release = await team.server.rpc(OwnTeam.ID, "area.paths", {
        teamID: team.teamID,
        areaID: AREA.computerUse,
        release: ["src"],
      })
      expect(release).toMatchObject({ status: 400, type: "broken" })
      const integrate = await team.server.rpc(OwnTeam.ID, "area.integrate", {
        teamID: team.teamID,
        areaID: AREA.computerUse,
      })
      expect(integrate).toMatchObject({ status: 400, type: "broken" })
      // The cone checks after the next runs leave the broken folder alone, and the home is as it was.
      await team.server.turn(team.sessions.cu, "다시 맞추기 계기")
      expect(homeSnapshot(repo.home)).toEqual(home)
      expect((await areaOf(team, AREA.computerUse)).state).toBe("broken")
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** What enabling must not change in a conversation (06 §3.7, TG10, TG16). */
async function durable(server: TeamServer, sessionID: string, directory: string): Promise<Durable> {
  const row = required(sessionRows(server.server.paths.database).find((item) => item.id === sessionID))
  const [entries, view, approval] = await Promise.all([
    instructionEntries(server.server, sessionID),
    presetOf(server, sessionID, directory),
    server.accounts("session.approval.get", { sessionID }, directory),
  ])
  return {
    rules: JSON.stringify(row.permission),
    entries: JSON.stringify(entries),
    binding: JSON.stringify(view.binding),
    mode: approval.mode,
  }
}

interface Snapshot {
  readonly head: string
  readonly branch: string
  readonly status: string
  readonly files: ReadonlyArray<string>
}

/** HEAD, the branch, the status and the files on disk of a folder (06 TG10 "팀 밖 변화 0"). */
function snapshot(directory: string): Snapshot {
  return {
    head: git(directory, ["rev-parse", "HEAD"]).trim(),
    branch: git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    status: status(directory),
    files: files(directory),
  }
}

/** The home without its nested folders (they are areas or outside folders of their own). */
function homeSnapshot(home: string) {
  const own = snapshot(home)
  return { ...own, files: own.files.filter((file) => !file.startsWith(".worktrees/")) }
}

/** The folders TG10 watches: outside the team, the adopted ones and the one nobody adopted. */
function outside(repo: F4) {
  return [
    repo.primary,
    ...repo.claude,
    repo.codex,
    repo.hash,
    repo.locked,
    repo.detached,
    repo.otherClone,
    repo.nested["cl-cu"],
    repo.nested["cl-perf"],
    repo.nested["cl-siwc"],
    repo.nested["computer-use"],
    repo.nested["local-model"],
  ]
}

/** Waits until `sessionID` holds `count` main requests and is idle again. */
async function settled(team: Team, sessionID: string, count: number) {
  await until(
    async () =>
      (await mainRequests(team.server, sessionID)).length >= count && !(await active(team.server)).has(sessionID),
    `${sessionID} never ran ${count} main request(s)`,
    STEP_TIMEOUT,
  )
  await team.server.server.waitIdle(sessionID)
}

async function areaOf(team: Team, areaID: OwnTeam.AreaID) {
  const view = await team.server.team("team.get", { directory: team.repo.home })
  return required(view.areas.find((area) => area.id === areaID))
}

function rowOf(team: Team, sessionID: string) {
  return required(sessionRows(db(team)).find((row) => row.id === sessionID))
}

function db(team: Team) {
  return team.server.server.paths.database
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}

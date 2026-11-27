// Live check of how the team main splits work (design 8.4, rpg-fit-final 3.5 Phase A and B) on the user's local model
// server alone (02 §3.3a, team-kit `local`): no cloud account, no forwarder, no stored key. The project is a generated
// fake repository of a real game repository's shape (fixtures/rpg-skeleton.ts: registries, seam and stamped files, `AGENTS.md` hand
// rules, H folders of generated binary) in ONE work folder: no linked worktree, its branches kept.
//
// Every case starts a fresh server and team the same way: the fixture, a main conversation on the local model with
// full approval, `enable` without a goal (Phase A: what enable made). Then one case (`--case`, `A` when left out):
//
//   A    nothing more: the areas enable made (expected 0), the heavy list, the commands and the judge's notes
//   B1   "…어떻게 나눌지 먼저 상의하자."     good: a `preview: true` plan, subject-named areas, boss first, seam,
//        registry and stamped files named; no area made before the user answers
//   B2   the same, ending "알아서 나눠서 시작해."   good: acts without asking; 1-4 areas
//   B3   "MUD 외형 상점에 정렬 기능 하나만 넣어줘."   good: no area
//   B4   the standing set (= team-talk L12)     good: a plan of 7 `new` ops with `userMade: true`; after "응" all seven
//        exist as 사용자가 정한 영역; none is named after a stale branch
//   B5   "보스 A와 보스 B를 동시에 만들자."   good: one area, or two with an explicit order on the seam files
//   B6   "이 프로젝트 팀을 알아서 짜줘."     good: asks, or says no split is needed
//
// Every case records the team tools the main called (`team_reorganize`, preview or not), whether any conversation ran
// `git worktree add` or wrote `WORKTREES.md` (the repository's hand rule, which team mode replaces), the areas' names,
// branches and `userMade`, and the minutes per area. The checks say what a good split does; the run records what it
// saw, and a model that misses one is a result, not an error.
//
//   bun script/live/team-split.ts [--case A|B1|B2|B3|B4|B5|B6] [--out <dir>] [--heavy-mib <n>] [--keep]
//   bun script/live/team-split.ts --fixture-only [--out <dir>] [--heavy-mib <n>]   builds the fixture; no server, no model
//
// Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { opEnd } from "../../../own-team/test/e2e/harness.ts"
import { NAME, rpgSkeleton } from "./fixtures/rpg-skeleton.js"
import { say, settled, startLiveTeam, teamToolCalls } from "./team-kit.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-split"))
const HEAVY_MIB = Number(option("heavy-mib") ?? "50")
const LOCAL_URL = (process.env.OWN_LIVE_LOCAL_URL ?? "http://localhost:64644/v1").replace(/\/+$/, "")
const LOCAL_MODEL = process.env.OWN_LIVE_LOCAL_MODEL ?? "local-flash-model-q4-0001"
/** A turn is over once nothing ran for this long (the team update follows 30 s after a report). */
const QUIET = 45_000
const TURN_TIMEOUT = 30 * 60_000

const EPISODE =
  "새 균열 보스 '모래왕'을 만들 거야. 보스 본체(규칙·모델·연출), 보스 드랍 아이템 외형(3D·아이콘), 아이템 VFX, 균열 맵 이야기 물건이 필요해."
const STANDING = "맵 공방, 아이템 공방, 형상공방, 몬스터, NPC 오디오, MUD, 보스 담당을 계속 두고 싶어. 팀을 그렇게 짜줘."

/** The cases and their prompts in the owner's voice; `yes` is the user's next message when the main answered a plan. */
export const CASES = {
  A: { prompts: [] },
  B1: { prompts: [`${EPISODE} 어떻게 나눌지 먼저 상의하자.`] },
  B2: { prompts: [`${EPISODE} 알아서 나눠서 시작해.`] },
  B3: { prompts: ["MUD 외형 상점에 정렬 기능 하나만 넣어줘."] },
  B4: { prompts: [STANDING], yes: "응, 그렇게 만들어 줘." },
  B5: { prompts: ["보스 A와 보스 B를 동시에 만들자."] },
  B6: { prompts: ["이 프로젝트 팀을 알아서 짜줘."] },
} as const satisfies Record<string, { readonly prompts: ReadonlyArray<string>; readonly yes?: string }>
type Case = keyof typeof CASES

const CASE = (option("case") ?? "A") as Case
if (!(CASE in CASES)) {
  console.log(`unknown --case ${option("case")}: one of ${Object.keys(CASES).join(", ")}`)
  process.exit(1)
}

if (args.includes("--fixture-only")) {
  fs.mkdirSync(OUT, { recursive: true })
  const begun = Date.now()
  const built = rpgSkeleton(fs.mkdtempSync(path.join(OUT, "fixture-")), { heavyMiB: HEAVY_MIB })
  console.log(JSON.stringify({ ...built, seconds: Math.round((Date.now() - begun) / 1000) }))
  process.exit(0)
}

const served = await fetch(`${LOCAL_URL}/models`, { signal: AbortSignal.timeout(10_000) })
  .then((response) => response.ok)
  .catch(() => false)
if (!served) {
  console.log("local model is off: live check not run")
  process.exit(0)
}

const live = await startLiveTeam({
  name: `live-split-${CASE.toLowerCase()}`,
  out: OUT,
  keep: args.includes("--keep"),
  fixture: (base) => rpgSkeleton(base, { heavyMiB: HEAVY_MIB }).home,
  local: { url: LOCAL_URL, model: LOCAL_MODEL },
})
const team = live.team
const started = Date.now()
const checks: Array<{ readonly name: string; readonly ok: boolean; readonly seen?: unknown }> = []
const check = (name: string, ok: boolean, seen?: unknown) => {
  checks.push({ name, ok, ...(seen === undefined ? {} : { seen }) })
  live.note({ step: "check", name, ok, ...(seen === undefined ? {} : { seen }) })
}
const result: Record<string, unknown> = { case: CASE, model: LOCAL_MODEL, heavyMiB: HEAVY_MIB, checks }
try {
  await run(CASE)
} catch (error) {
  live.note({ step: "error", error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) })
  result.error = error instanceof Error ? error.message : String(error)
} finally {
  result.minutes = Math.round((Date.now() - started) / 60_000)
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2))
  console.table(checks.map((item) => ({ check: item.name, ok: item.ok })))
  await live.stop(started)
}

async function run(name: Case) {
  const local = live.local
  if (!local) throw new Error("no local model account")
  const project = team.project!
  const worktreesBefore = fs.readFileSync(path.join(project, "WORKTREES.md"), "utf8")
  const enabling = await team.createSession({ model: local.model, directory: project, title: `${NAME} team` })
  await team.accounts("session.approval.set", { sessionID: enabling, mode: "full" }, project)
  const enableBegun = Date.now()
  const enabled = await team.team("enable", { directory: project, sessionID: SessionID.make(enabling) })
  const enableOp = await opEnd(team, enabled.opID, { timeoutMs: 30 * 60_000 })
  const view = await team.team("team.get", { directory: project })
  if (!view.team) throw new Error("the team was not enabled")
  const teamID = view.team.id
  const mainID = view.team.main.sessionID
  await team.accounts("session.approval.set", { sessionID: mainID, mode: "full" }, project)
  const phaseA = {
    seconds: Math.round((Date.now() - enableBegun) / 1000),
    state: enableOp.state,
    areas: view.areas.map((area) => area.name),
    heavy: view.team.heavy.dirs,
    commands: view.team.commands,
    notes: enableOp.summary?.lines,
  }
  result.phaseA = phaseA
  live.note({ step: "phase A", ...phaseA })
  check("A: enable made no area", view.areas.length === 0, phaseA.areas)
  check(
    "A: src, server and scripts are never heavy",
    !view.team.heavy.dirs.some((dir) => /^(src|server|scripts)(\/|$)/.test(dir)),
    view.team.heavy.dirs,
  )
  check("A: public is not taken whole", !view.team.heavy.dirs.includes("public"), view.team.heavy.dirs)

  const spec = CASES[name]
  const begun = Date.now()
  for (const [index, text] of spec.prompts.entries()) {
    await say(live, mainID, project, `${name} prompt ${index + 1}`, text)
    await settled(live, QUIET, TURN_TIMEOUT)
  }
  const planned = await teamToolCalls(live, mainID, project)
  if ("yes" in spec && planned.some((call) => /plan\\?"?\s*:\s*true/.test(call.state))) {
    await say(live, mainID, project, `${name} yes`, spec.yes)
    await settled(live, QUIET, TURN_TIMEOUT)
  }
  const calls = await teamToolCalls(live, mainID, project)
  const areas = await live.areasOf(teamID)
  const minutes = Math.max(1, Math.round((Date.now() - begun) / 60_000))
  const worktreeAdds = await shellWorktreeAdds([
    { sessionID: mainID, directory: project },
    ...areas.flatMap((area) =>
      area.owner.sessionID === null ? [] : [{ sessionID: area.owner.sessionID, directory: area.directory }],
    ),
  ])
  const outcome = {
    tools: calls.map((call) => call.tool),
    previews: calls.filter((call) => call.tool === "team_reorganize" && /preview\\?"?\s*:\s*true/.test(call.state))
      .length,
    areas: areas.map((area) => ({ name: area.name, branch: area.branch, role: area.goal, userMade: area.userMade !== undefined })),
    minutesPerArea: areas.length === 0 ? null : Math.round((minutes / areas.length) * 10) / 10,
    worktreeAdds,
    worktreesEdited: fs.readFileSync(path.join(project, "WORKTREES.md"), "utf8") !== worktreesBefore,
    answer: (await live.answer(mainID, project)).slice(0, 2000),
  }
  result.phaseB = outcome
  live.note({ step: name, ...outcome })
  check("tools: no `git worktree add` by shell", worktreeAdds.length === 0, worktreeAdds)
  check("tools: WORKTREES.md left alone", !outcome.worktreesEdited)
  const stale = areas.filter((area) => /^codex\//.test(area.branch))
  check("no area on a stale branch", stale.length === 0, stale.map((area) => area.branch))
  const reorganized = outcome.tools.includes("team_reorganize")
  if (name === "B1") {
    check("B1: a preview plan", outcome.previews > 0, outcome.tools)
    check("B1: nothing made before the answer", areas.length === 0, outcome.areas)
    check("B1: seam or registry files named", /WorldBossScript|WorldEvents|items\.ts|ui\.en|types\.ts/.test(outcome.answer))
  }
  if (name === "B2") {
    check("B2: acts with team_reorganize", reorganized, outcome.tools)
    check("B2: 1-4 areas", areas.length >= 1 && areas.length <= 4, outcome.areas)
  }
  if (name === "B3") check("B3: no area", areas.length === 0, outcome.areas)
  if (name === "B4") {
    check("B4: seven areas", areas.length === 7, outcome.areas)
    check("B4: all 사용자가 정한 영역", areas.length > 0 && areas.every((area) => area.userMade !== undefined), outcome.areas)
    check("B4: no limit sentence", !/최대|상한|까지만 만들/.test(outcome.answer))
  }
  if (name === "B5") check("B5: one area, or two with an order", areas.length <= 2, outcome.areas)
  if (name === "B6") check("B6: asks or makes nothing", areas.length === 0, outcome.areas)
}

/** `git worktree add` in any shell call of the given conversations. */
async function shellWorktreeAdds(sessions: ReadonlyArray<{ readonly sessionID: string; readonly directory: string }>) {
  const found = await Promise.all(
    sessions.map(async (session) =>
      (await live.history(session.sessionID, session.directory)).flatMap((message) =>
        ((message.content as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((part) => part.type === "tool")
          // The call's input only: its output may quote the repository's own rule (AGENTS.md names the command).
          .map((part) => JSON.stringify((part.state as { input?: unknown } | undefined)?.input ?? {}))
          .filter((input) => /git\s+worktree\s+add/.test(input))
          .map((state) => state.slice(0, 300)),
      ),
    ),
  )
  return found.flat()
}

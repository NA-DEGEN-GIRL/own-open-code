// Live team-mode test (own-team, own/docs/06): a real team on real models. own.accounts, own.team and own.harness run
// on a source server through own-team's e2e harness (`startTeamServer`); the team's accounts are the harness's seeded
// ones with fake credentials, and their endpoints point at the live forwarder, which puts in the real credentials and
// forwards to the official endpoints only: ChatGPT 01, the Anthropic key from set-key.ps1, DeepSeek. Any other ChatGPT
// account is refused (one subscription per company and team, 07 §5.4).
//
// What the user would do in the app is done here through the same RPCs:
//   1. a fixture repository (textkit) and a main conversation on GPT-6; `enable` with the goal, then the goal as the
//      discussion draft to the team main and a yes, so the main splits the work into areas (since 2026-10-16 the
//      enable judge makes no area from the goal alone), each a worktree with an owner conversation
//   2. each area pinned to a provider and harness: GPT-6 · codex, Claude · pi, DeepSeek · opencode
//   3. round 1: the main dispatches one module per area; owners are told to give part of it to a sub-agent
//   4. between the rounds, inside each area: a model change and a compaction
//   5. round 2: one more function per area, then the main integrates every area into the target
//   6. checks: `bun test` in the main folder after integration, the models and harnesses each owner ran, sub-agents and
//      compactions. Permission asks are answered (git-destructive ones rejected), confirms done, questions cancelled,
//      and each is logged.
//
//   bun script/live/team.ts [--out <dir>] [--keep] [--setup-only]     (--setup-only: stop after step 2)
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnTeam } from "@own/protocol/rpc-team"
import { integrations, opEnd } from "../../../own-team/test/e2e/harness.ts"
import { MODELS, bunTest, gitFixture, settleSplit, startLiveTeam, type ModelKey } from "./team-kit.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-team"))

/** Each area's provider and harness, and what happens inside it between the rounds (in order). */
const PLAN: ReadonlyArray<{
  readonly model: ModelKey
  readonly harness: OwnHarness.HarnessID
  readonly between: ReadonlyArray<"compact" | ModelKey>
}> = [
  { model: "gpt", harness: "codex", between: ["claude", "compact"] },
  { model: "claude", harness: "pi", between: ["compact", "gpt"] },
  { model: "deepseek", harness: "opencode", between: ["compact", "claude"] },
]

const HINT =
  "textkit gets three independent modules, one area each: csv (src/csv.ts with test/csv.test.ts), dates " +
  "(src/dates.ts with test/dates.test.ts) and stats (src/stats.ts with test/stats.test.ts). The main folder only " +
  "integrates. `bun test` checks everything."

const ROUND_1 = [
  "You lead this team. Build the three modules README.md plans, one per area (csv, dates, stats); read README.md and",
  "call tools.team.status inside `execute` to see the areas.",
  "Send each area one request with tools.team.dispatch. Each request must say:",
  "- what to build: csv → parseCsv(text): string[][] (RFC 4180: quoted fields, doubled quotes, CRLF, no trailing empty",
  "  row); dates → addBusinessDays(iso, n) on YYYY-MM-DD strings, weekends skipped, RangeError for a negative or",
  "  fractional n; stats → mean, median and mode of number[], RangeError on an empty array",
  "- that the owner hands part of the work (for example the tests) to a sub-agent and checks what comes back",
  "- to run `bun test`, commit on the area's branch, and report `ready` with tools.team.report",
  "Do not write the modules yourself and do not integrate yet. After dispatching, wait for the reports, then tell me",
  "briefly where each area stands.",
].join("\n")

const ROUND_2 = [
  "Second round. Send each area one more request with tools.team.dispatch:",
  "- csv: stringifyCsv(rows: string[][]): string, the inverse of parseCsv (quote fields with commas, quotes or",
  "  newlines), with round-trip tests",
  "- dates: businessDaysBetween(a, b): number of business days from a (exclusive) to b (inclusive), RangeError when b",
  "  is before a",
  "- stats: percentile(xs, p) with linear interpolation, RangeError for an empty array or p outside 0..100",
  "Same rules as before: part of the work to a sub-agent, `bun test`, commit, report `ready`.",
  "When every area reported ready, integrate each area into the target with tools.team.integrate, then tell me what",
  "went in and whether the checks passed.",
].join("\n")

const live = await startLiveTeam({ name: "live-team", out: OUT, keep: args.includes("--keep"), fixture })
const team = live.team
const started = Date.now()
try {
  const project = team.project!
  const main = await team.createSession({ model: MODELS.gpt, directory: project, title: "textkit team" })
  await team.accounts("session.approval.set", { sessionID: main, mode: "full" }, project)
  const enabled = await team.team("enable", { directory: project, sessionID: SessionID.make(main), hint: HINT })
  const op = await opEnd(team, enabled.opID, { timeoutMs: 15 * 60_000 })
  live.note({ step: "enable", state: op.state, steps: op.steps.map((step) => `${step.kind}:${step.state}`) })
  const view = await team.team("team.get", { directory: project })
  if (!view.team) throw new Error("the team was not enabled")
  const teamID = view.team.id
  const mainID = view.team.main.sessionID
  await team.accounts("session.approval.set", { sessionID: mainID, mode: "full" }, project)
  const areas = await settleSplit(live, teamID, mainID, HINT)

  const plans = new Map(areas.map((area, index) => [area.id, PLAN[index % PLAN.length]!]))
  for (const area of areas) await live.pin(teamID, area, MODELS[plans.get(area.id)!.model], plans.get(area.id)!.harness)
  if (args.includes("--setup-only")) {
    for (const area of await live.areasOf(teamID))
      live.note({
        step: "setup",
        area: area.name,
        owner: await live.conversation(area.owner.sessionID!, area.directory),
      })
    throw new Error("setup only")
  }

  await team.server.prompt(mainID, ROUND_1)
  await live.round(teamID, mainID, "round 1", (areas) => areas.every((area) => area.status.kind === "ready"))

  for (const area of await live.areasOf(teamID)) {
    const plan = plans.get(area.id)!
    for (const action of plan.between) {
      if (action === "compact") await live.compact(teamID, area.id)
      else await live.pin(teamID, await live.areaOf(teamID, area.id), MODELS[action], plan.harness)
    }
  }

  await team.server.prompt(mainID, ROUND_2)
  await live.round(teamID, mainID, "round 2", (areas) =>
    areas.every((area) => {
      const done = integrations(team.server.paths.database, teamID).filter((item) => item.areaID === area.id)
      return done.length > 0 && done.every((item) => item.state === "done" || item.state === "undone")
    }),
  )
  await report(teamID, mainID)
} catch (error) {
  live.note({ step: "error", error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) })
} finally {
  await live.stop(started)
}

/** What happened, read back from the server and the folders. */
async function report(teamID: OwnTeam.TeamID, mainID: string) {
  const project = team.project!
  const test = bunTest(project)
  const counts = { pass: test.pass, fail: test.fail }
  const gitLog = Bun.spawnSync(["git", "log", "--oneline", "--graph", "-20"], { cwd: project }).stdout.toString()
  const areas = await Promise.all(
    (await live.areasOf(teamID)).map(async (area) => {
      const owners = [...area.owner.previous.map((item) => item.sessionID), area.owner.sessionID].filter(
        (id) => id !== null,
      )
      const sessions = await Promise.all(owners.map((id) => live.conversation(id, area.directory)))
      return {
        area: area.name,
        directory: area.directory,
        status: area.status.kind,
        integrations: integrations(team.server.paths.database, teamID)
          .filter((item) => item.areaID === area.id)
          .map((item) => item.state),
        owners: sessions,
      }
    }),
  )
  const result = {
    tests: counts,
    gitLog,
    main: await live.conversation(mainID, project),
    areas,
    asked: live.log.filter((entry) => entry.step === "permission" || entry.step === "confirm" || entry.step === "form"),
  }
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2))
  live.note({ step: "result", tests: counts })
  console.log(gitLog)
  console.table(
    areas.flatMap((area) =>
      area.owners.map((owner) => ({
        area: area.area,
        harness: owner.harness,
        models: owner.models.join(" → "),
        tools: Object.entries(owner.tools)
          .map(([tool, count]) => `${tool}×${count}`)
          .join(" "),
        subagents: owner.children,
        compactions: owner.compactions,
        integrated: area.integrations.join(","),
      })),
    ),
  )
}

/** textkit: a README that plans the modules, AGENTS.md, a smoke test, on `main` with one commit. */
function fixture(base: string) {
  return gitFixture(base, "textkit", {
    "package.json": JSON.stringify({ name: "textkit", type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "README.md": [
      "# textkit",
      "",
      "Small text utilities in TypeScript, no dependencies. Planned modules:",
      "",
      "- `src/csv.ts`: CSV parsing and writing (RFC 4180)",
      "- `src/dates.ts`: business-day arithmetic on `YYYY-MM-DD` strings",
      "- `src/stats.ts`: statistics over `number[]`",
      "",
      "Each module has its tests in `test/<module>.test.ts` (bun:test). `bun test` runs them all.",
      "",
    ].join("\n"),
    "AGENTS.md": [
      "- TypeScript, ES modules, no dependencies. Export plain functions.",
      "- Tests use `bun:test` and live in `test/`. Run `bun test` before you report.",
      "- Throw `RangeError` for invalid arguments, with a short message.",
      "",
    ].join("\n"),
    "src/index.ts": 'export const version = "0.1.0"\n',
    "test/smoke.test.ts":
      'import { expect, test } from "bun:test"\nimport { version } from "../src/index"\n\ntest("version", () => expect(version).toBe("0.1.0"))\n',
    ".gitignore": "node_modules/\n",
  })
}

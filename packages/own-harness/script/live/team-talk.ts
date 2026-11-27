// Live team-mode run of the 2026-10-16 team work (06 §5.8 area messages, §6.3 상의하고 나누기, §8.1 reorganization in
// plain words, §5.5 relay) on real models, through the same RPCs and prompts the app uses (team-kit.ts):
//   1. a fixture (ledgerkit) whose modules share a contract only the money area decides: the rounding rule of
//      fractional cents and the amount format. A test in the main folder checks the contract once all are there.
//   2. `enable` with the goal the enable dialog sends (`hint`), which makes no area by itself since 2026-10-16
//   3. talk it over: the goal as the enable dialog's discussion draft to the team main, which shows a split (ideally
//      with `team_reorganize{preview: true}`); the user agrees and the main makes the areas
//   4. regroup in plain words: the user asks to join report into invoice (a merge; a plan the user answers if asked);
//      then each area is pinned to a provider and harness
//   5. round 1: the main dispatches; invoice is told to ask money directly (team_message ask) and to watch its ready
//      report; money answers (reply). Nothing of it should wake the main.
//   6. relay: the user asks the invoice owner for something only the main can do (a new area later)
//   7. round 2: the main integrates every ready area; `bun test` in the main folder must run the contract test
//   Checks come from durable state: area-message dispatch records, the talk audit lines, integrations, the main's tool
//   calls (preview, reorganize, relay) and `bun test`.
//
//   bun script/live/team-talk.ts [--out <dir>] [--keep]
//
// With `--local` it runs the 2.2.6-own.3 cases instead (직접 작업, areas without a limit, area scope, whole reports;
// design 8.4 L1-L19) on the user's local model server alone, a fresh team per case (team-talk-direct.ts):
//   bun script/live/team-talk.ts --local [--case L1,L2,…|all] [--out <dir>]
//   bun script/live/team-talk.ts --local --fixture-only [--out <dir>]    builds the fixture; no server, no model
//   bun script/live/team-talk.ts --direct --model gpt|claude [--case …]   the same cases on ChatGPT 01 or the
//                                                                        Anthropic key (2026-11-17)
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnTeam } from "@own/protocol/rpc-team"
import { dispatches, integrations, opEnd, until } from "../../../own-team/test/e2e/harness.ts"
import { kv } from "../../../own-team/test/e2e/inspect.ts"
import { MODELS, bunTest, gitFixture, say, settleSplit, startLiveTeam, type ModelKey } from "./team-kit.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-team-talk"))
const TURN_TIMEOUT = 20 * 60_000

/** Each area's provider and harness by the module it holds; an area named otherwise takes the next row. */
const PLAN: ReadonlyArray<{
  readonly match: RegExp
  readonly model: ModelKey
  readonly harness: OwnHarness.HarnessID
}> = [
  { match: /money/i, model: "claude", harness: "codex" },
  { match: /invoice/i, model: "deepseek", harness: "opencode" },
  { match: /report/i, model: "gpt", harness: "pi" },
]

const GOAL =
  "ledgerkit에 모듈 세 개를 만들어요: money(금액 파싱·서식·반올림), invoice(청구서 합계와 세금), report(청구서 텍스트 출력). " +
  "모듈마다 영역 하나씩이면 좋겠어요. 메인 폴더는 반영만 해요."

const REGROUP = "생각해 보니 report는 invoice와 한 영역이 좋겠어요. report 영역을 invoice 영역에 합쳐 주세요."

const ROUND_1 = [
  "이제 일을 맡겨 주세요. 영역마다 tools.team.dispatch로 요청을 하나씩 보내세요.",
  '- money: README.md의 money 절대로 parseMoney, formatMoney, roundCents를 만들어요. 반올림 규칙(half-up 또는 half-even)과 formatMoney의 천 단위 구분 여부는 money 담당이 정하고 src/money.ts 맨 위 주석에 적어요. 당신이 대신 정하지 마세요. 다른 영역이 물어 오면 team_message(kind: "reply")로 답하라고 적어 주세요.',
  '- invoice(report 포함): README.md의 invoice·report 절대로 tax와 renderInvoice를 만들어요. money의 코드는 반영 전이라 이 폴더에 없으니 import하지 말고 같은 규칙을 직접 구현해요. 규칙을 짐작하지 말고 money 영역에 team_message(kind: "ask")로 직접 물어서 맞추고, money가 ready가 되면 알림을 받도록 team_message(kind: "watch", on: "ready")를 걸라고 적어 주세요.',
  "- 모든 영역: 일의 일부(예: 테스트)를 하위 에이전트에게 맡기고 결과를 확인해요. bun test를 돌리고 영역 브랜치에 커밋한 뒤 tools.team.report로 ready를 보고해요.",
  "모듈을 직접 만들지 말고 아직 반영하지 마세요. 요청을 보낸 뒤 보고를 기다렸다가 영역마다 어디까지 됐는지 짧게 알려 주세요.",
].join("\n")

const RELAY =
  "팀 메인에게 전해 주세요: 반영이 끝나면 다음에 cli 영역을 새로 만들어 명령줄 도구를 붙이고 싶어요. 지금 만들지는 말고, 이 영역에서 직접 하지도 마세요."

const ROUND_2 = [
  "준비된 영역을 모두 tools.team.integrate로 대상에 반영하고, 무엇이 들어갔는지와 검사가 통과했는지 알려 주세요.",
  "cli 영역은 아직 만들지 마세요.",
].join("\n")

if (args.includes("--local") || args.includes("--direct")) {
  const { runDirect } = await import("./team-talk-direct.js")
  await runDirect(args)
  process.exit(0)
}

const live = await startLiveTeam({ name: "live-talk", out: OUT, keep: args.includes("--keep"), fixture })
const team = live.team
const started = Date.now()
try {
  const project = team.project!
  const viewed = await team.createSession({ model: MODELS.gpt, directory: project, title: "ledgerkit team" })
  await team.accounts("session.approval.set", { sessionID: viewed, mode: "full" }, project)
  const enabled = await team.team("enable", { directory: project, sessionID: SessionID.make(viewed), hint: GOAL })
  const op = await opEnd(team, enabled.opID, { timeoutMs: 15 * 60_000 })
  live.note({ step: "enable", state: op.state, steps: op.steps.map((step) => `${step.kind}:${step.state}`) })
  const view = await team.team("team.get", { directory: project })
  if (!view.team) throw new Error("the team was not enabled")
  const teamID = view.team.id
  const mainID = view.team.main.sessionID
  await team.accounts("session.approval.set", { sessionID: mainID, mode: "full" }, project)
  live.note({ step: "enabled", main: mainID, areas: view.areas.length })

  const split = await settleSplit(live, teamID, mainID, GOAL)
  live.note({ step: "split", main: await calls(mainID, project) })

  const named = (areas: ReadonlyArray<OwnTeam.AreaView>, pattern: RegExp) =>
    areas.find((area) => pattern.test(`${area.branch} ${area.name}`))
  const both = named(split, /invoice/i) !== undefined && named(split, /report/i) !== undefined
  if (!both) live.note({ step: "regroup", skipped: "no invoice and report areas" })
  if (both) {
    await say(live, mainID, project, "regroup", REGROUP)
    // A proposal that ends an area answers a plan first and runs after the user's next message (06 §2.9 V-f).
    if ((await live.areasOf(teamID)).length === split.length)
      await say(live, mainID, project, "regroup-yes", "네, 그렇게 진행해 주세요.")
    const regrouped = await live.round(
      teamID,
      mainID,
      "regroup-wait",
      (areas) => areas.length < split.length,
      15 * 60_000,
    )
    live.note({ step: "regroup", done: regrouped, main: await calls(mainID, project) })
  }

  const areas = await live.areasOf(teamID)
  for (const [index, area] of areas.entries()) {
    const plan = PLAN.find((row) => row.match.test(`${area.branch} ${area.name}`)) ?? PLAN[index % PLAN.length]!
    await live.pin(teamID, area, MODELS[plan.model], plan.harness)
  }

  await team.server.prompt(mainID, ROUND_1)
  await live.round(teamID, mainID, "round 1", (areas) => areas.every((area) => area.status.kind === "ready"))
  live.note({ step: "round 1", talk: talk(teamID) })

  const invoice = named(await live.areasOf(teamID), /invoice/i)
  if (invoice?.owner.sessionID) {
    const mainBefore = (await live.history(mainID, project)).length
    await say(live, invoice.owner.sessionID, invoice.directory, "relay", RELAY)
    // A relay wakes the main (06 §5.5): its update arrives as a turn of its own.
    const woke = await until(
      async () => (await live.history(mainID, project)).length > mainBefore,
      "the relay did not wake the main",
      TURN_TIMEOUT,
    ).then(
      () => true,
      () => false,
    )
    if (woke) await team.server.waitIdle(mainID)
    live.note({ step: "relay", woke, main: (await live.answer(mainID, project)).slice(0, 1500) })
  }

  await team.server.prompt(mainID, ROUND_2)
  await live.round(teamID, mainID, "round 2", (areas) =>
    areas
      .filter((area) => !/cli/i.test(area.branch))
      .every((area) => {
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

/** Area messages from durable state: ask/reply dispatch records, open asks, watches, held notes and the audit lines. */
function talk(teamID: OwnTeam.TeamID) {
  const records = dispatches(team.server.paths.database, teamID).filter((item) => item.from === "area")
  const state = kv(team.server.paths.database)[`talk:${teamID}`] as
    | { notes: unknown[]; watches: unknown[]; open: unknown[]; lines: Array<{ text: string }> }
    | undefined
  return {
    asks: records.filter((item) => item.kind === "ask").length,
    replies: records.filter((item) => item.kind === "reply").length,
    states: records.map((item) => `${item.kind}:${item.state}`),
    open: state?.open.length ?? 0,
    watches: state?.watches.length ?? 0,
    notes: state?.notes.length ?? 0,
    lines: (state?.lines ?? []).map((line) => line.text.slice(0, 200)),
  }
}

/** The team tools a conversation called, read from its tool parts (Code Mode `tools.team__x` or a direct `team_x`). */
async function calls(sessionID: string, directory: string) {
  const parts = (await live.history(sessionID, directory)).flatMap((message) =>
    ((message.content as Array<Record<string, unknown>> | undefined) ?? []).filter((part) => part.type === "tool"),
  )
  const text = parts.map((part) => JSON.stringify(part.state ?? part))
  const count = (pattern: RegExp) => text.filter((item) => pattern.test(item)).length
  return {
    preview: count(/reorganize[\s\S]*preview\\?"?\s*:\s*true/),
    reorganize: count(/team(__|[._])reorganize/),
    dispatch: count(/team(__|[._])dispatch/),
    integrate: count(/team(__|[._])integrate/),
    message: count(/team(__|[._])message/),
    relay: count(/kind\\?"?\s*:\s*\\?"relay/),
  }
}

/** What happened, read back from the server and the folders. */
async function report(teamID: OwnTeam.TeamID, mainID: string) {
  const project = team.project!
  const test = bunTest(project)
  const areas = await Promise.all(
    (await live.areasOf(teamID)).map(async (area) => {
      const owners = [...area.owner.previous.map((item) => item.sessionID), area.owner.sessionID].filter(
        (id) => id !== null,
      )
      return {
        area: area.branch,
        status: area.status.kind,
        integrations: integrations(team.server.paths.database, teamID)
          .filter((item) => item.areaID === area.id)
          .map((item) => item.state),
        owners: await Promise.all(
          owners.map(async (id) => ({
            ...(await live.conversation(id, area.directory)),
            calls: await calls(id, area.directory),
          })),
        ),
      }
    }),
  )
  const result = {
    tests: { pass: test.pass, fail: test.fail, skip: test.skip, contract: /contract/.test(test.output) },
    gitLog: Bun.spawnSync(["git", "log", "--oneline", "--graph", "-25"], { cwd: project }).stdout.toString(),
    main: { ...(await live.conversation(mainID, project)), calls: await calls(mainID, project) },
    talk: talk(teamID),
    areas,
    asked: live.log.filter((entry) => entry.step === "permission" || entry.step === "confirm" || entry.step === "form"),
  }
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(OUT, "bun-test.txt"), test.output)
  live.note({ step: "result", tests: result.tests, talk: result.talk, main: result.main.calls })
  console.log(result.gitLog)
  console.table(
    areas.flatMap((area) =>
      area.owners.map((owner) => ({
        area: area.area,
        harness: owner.harness,
        models: owner.models.join(" → "),
        message: owner.calls.message,
        relay: owner.calls.relay,
        subagents: owner.children,
        integrated: area.integrations.join(","),
      })),
    ),
  )
}

/**
 * ledgerkit: README plans three modules that meet in integer cents. The money area decides the rounding rule and the
 * format; the contract test runs once money, invoice and report are all in the folder, and skips before.
 */
function fixture(base: string) {
  return gitFixture(base, "ledgerkit", {
    "package.json":
      JSON.stringify({ name: "ledgerkit", type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "README.md": [
      "# ledgerkit",
      "",
      "Small invoice utilities in TypeScript, no dependencies. Amounts cross module boundaries as integer cents.",
      "",
      "## money (`src/money.ts`, `test/money.test.ts`)",
      '- `parseMoney(text: string): number` — `"12.34"` → `1234`, `"-0.50"` → `-50`; `RangeError` for anything else.',
      "- `formatMoney(cents: number): string` — the inverse of `parseMoney` for every value it returns.",
      "- `roundCents(x: number): number` — rounds a fractional number of cents to an integer.",
      "- The money area decides the rounding rule of `roundCents` (half-up or half-even) and whether `formatMoney` writes",
      "  thousands separators, and writes both in a comment at the top of `src/money.ts`. Nothing else records them.",
      "",
      "## invoice (`src/invoice.ts`, `test/invoice.test.ts`)",
      "- `tax(subtotalCents: number, rateBps: number): number` — `subtotalCents * rateBps / 10000`, rounded exactly like",
      "  money's `roundCents`. Must not import `src/money.ts` (areas work in parallel), so it implements the same rule.",
      "",
      "## report (`src/report.ts`, `test/report.test.ts`)",
      "- `renderInvoice(lines: {description: string, cents: number}[], rateBps: number): string` — one line per item,",
      "  then `Subtotal`, `Tax` and `Total`, every amount written exactly like money's `formatMoney`. Must not import",
      "  `src/money.ts` either.",
      "",
      "`test/contract.test.ts` checks that the three agree once they are all in one folder. `bun test` runs everything.",
      "",
    ].join("\n"),
    "AGENTS.md": [
      "- TypeScript, ES modules, no dependencies. Export plain functions.",
      "- Tests use `bun:test` and live in `test/`. Run `bun test` before you report.",
      "- Throw `RangeError` for invalid arguments, with a short message.",
      "- Do not edit `test/contract.test.ts`.",
      "",
    ].join("\n"),
    "test/contract.test.ts": [
      'import { expect, test } from "bun:test"',
      'import { existsSync } from "node:fs"',
      'import path from "node:path"',
      "",
      'const src = (name: string) => path.join(import.meta.dir, "..", "src", `${name}.ts`)',
      'const all = ["money", "invoice", "report"].every((name) => existsSync(src(name)))',
      "",
      'test.skipIf(!all)("contract: invoice rounds like money, report formats like money", async () => {',
      '  const money = await import(src("money"))',
      '  const invoice = await import(src("invoice"))',
      '  const report = await import(src("report"))',
      "  for (const subtotal of [5, 15, 25, 35, 125, 135, 1_234_565])",
      "    expect(invoice.tax(subtotal, 1000)).toBe(money.roundCents((subtotal * 1000) / 10000))",
      '  const text = report.renderInvoice([{ description: "Widget", cents: 123_456_789 }], 1000)',
      "  expect(text).toContain(money.formatMoney(123_456_789))",
      "  expect(text).toContain(money.formatMoney(invoice.tax(123_456_789, 1000)))",
      "})",
      "",
    ].join("\n"),
    "test/smoke.test.ts": 'import { expect, test } from "bun:test"\n\ntest("smoke", () => expect(1 + 1).toBe(2))\n',
    ".gitignore": "node_modules/\n",
  })
}

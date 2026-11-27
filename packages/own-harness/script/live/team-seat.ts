// Live check of 담당 대화 바꾸기 (`area.seat`, own/docs/06) with real conversations on the user's local model server
// alone (02 §3.3a): no cloud account is called, no forwarder is started and no stored key is read (team-kit `local`).
// A server that does not answer ends the run at once with one line.
//
// What the user would do in the app is done through the same RPCs. Every case starts the same way: a fixture
// repository (wordkit), a main conversation on the local model, `enable`, and two areas made the way 영역 만들기 does
// (`reorg.apply`, the user's action): words and numbers. Then one case (`--case`, `plain` when left out):
//
//   plain   request 1 to words' owner conversation A; the user opens a second conversation B in words' folder and moves
//           the seat onto it; request 2 without a word about the change; the old seat is asked to report to the team;
//           the seat goes back to A; request 3
//   busy    the seat is moved onto B while A is in the middle of request 1: the op waits, A finishes and reports, B
//           gets the seat and request 2
//   queued  the main sends words two requests in a row, so the second waits behind the first (one request at a time for
//           a folder); the seat is moved while A works on the first: the second goes once, to B
//   peer    words gets an owner note and two peers (동료) with role notes; the main sends the first peer a request and
//           reads team_status; that peer is made the owner; team_status again; the owner of numbers asks words
//   rotate  A to B as in plain, request 2, then 새 대화로 이어가기 (`area.rotate`) on the seated owner B; request 3 goes
//           to the fresh conversation
//
// Read back after each step: the op's steps, the area's owner record, the conversations' permission rules and
// instruction entries, the dispatch records (which conversation each request was sent to), the conversations' messages
// and tool calls, and what the local server was really sent (team-kit's recording proxy). A model that cannot follow
// the team tools is a result too: every check is recorded with what was seen, and the run goes on where it can.
//
//   bun script/live/team-seat.ts [--case plain|busy|queued|peer|rotate] [--out <dir>]
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol/rpc-team"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { instructionEntries } from "../../../own-accounts/test/e2e-kit"
import { RoleInstructions } from "../../../own-team/src/sessions/instructions.js"
import { Permissions } from "../../../own-team/src/tools/permissions.js"
import {
  active,
  dispatches,
  dispatchOf,
  reorganize,
  opEnd,
  sessionRows,
  waitValue,
} from "../../../own-team/test/e2e/harness.ts"
import { inbox, kv } from "../../../own-team/test/e2e/inspect.ts"
import { bunTest, gitFixture, say, startLiveTeam } from "./team-kit.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const CASES = ["plain", "busy", "queued", "peer", "rotate"] as const
const CASE = CASES.find((name) => name === (option("case") ?? "plain"))
if (CASE === undefined) {
  console.log(`unknown --case ${option("case")}: one of ${CASES.join(", ")}`)
  process.exit(1)
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-seat"))
const LOCAL_URL = (process.env.OWN_LIVE_LOCAL_URL ?? "http://localhost:64644/v1").replace(/\/+$/, "")
const LOCAL_MODEL = process.env.OWN_LIVE_LOCAL_MODEL ?? "local-flash-model-q4-0001"

const REQUEST_TIMEOUT = 25 * 60_000
const OP_TIMEOUT = 20 * 60_000
/**
 * A request is over once nothing moved for this long: no conversation ran, no request waited, and no report waited for
 * the main's next team update (own-team sends one 30 s after the last report).
 */
const QUIET = 45_000
/** The line the main reads about a move in its next team update (own-team `sessions/seat.ts`). */
const SEATED = "담당이 사용자가 고른 다른 대화로 바뀌었습니다"

const HINT =
  "wordkit gets two independent modules, one area each: words (src/words.ts with test/words.test.ts) and numbers " +
  "(src/numbers.ts with test/numbers.test.ts). `bun test` checks everything."

const LEAD = "You lead this team. It has two areas, `words` and `numbers`."
const TASKS = {
  countWords:
    "`export function countWords(text: string): number` in src/words.ts (words are separated by whitespace; an empty " +
    "or blank string has 0 words), with tests in test/words.test.ts",
  longestWord:
    "`export function longestWord(text: string): string` in src/words.ts (the first of the longest words; an empty " +
    "or blank string gives an empty string), with tests in test/words.test.ts",
  capitalize:
    "`export function capitalize(text: string): string` in src/words.ts (the first letter of every word in upper " +
    "case, the rest unchanged), with tests in test/words.test.ts",
}
const OWNER_WORK =
  "tell the owner to write the code and the tests, run `bun test`, commit on the area's branch, and then report " +
  "`ready` with the team report tool (team_report)"

const RULES = [
  "Rules for this request: send it with the team dispatch tool (team_dispatch; inside `execute` it is",
  `tools.team.dispatch) to the area \`words\` only, as one request. In its text, ${OWNER_WORK}.`,
  "Do not write the code yourself, send nothing to `numbers`, and do not integrate. When the report has",
  "arrived, tell me in one or two sentences where the area stands.",
].join("\n")

const REQUESTS = {
  first: [`${LEAD} The area \`words\` needs ${TASKS.countWords}.`, RULES].join("\n"),
  second: [`Next task for the area \`words\`: add ${TASKS.longestWord}.`, RULES].join("\n"),
  third: [`One more task for the area \`words\`: add ${TASKS.capitalize}.`, RULES].join("\n"),
  /** Two requests in one turn of the main, so the second waits in the area's outbox behind the first. */
  pair: [
    `${LEAD} The area \`words\` gets two tasks, as two separate requests:`,
    `1. ${TASKS.countWords}.`,
    `2. ${TASKS.longestWord}.`,
    "Rules: send both now, one right after the other, each with its own call of the team dispatch tool (team_dispatch;",
    "inside `execute` it is tools.team.dispatch) to the area `words`. Do not wait for a report between the two calls",
    "and do not merge the tasks into one request. The second request waits in the area's outbox until the first is",
    `done; that is expected. In each text, ${OWNER_WORK}.`,
    "Do not write the code yourself, send nothing to `numbers`, do not integrate, and send neither request again",
    "later. When both reports have arrived, tell me in one or two sentences where the area stands.",
  ].join("\n"),
  /** The main's first request to a peer, which is what attaches the peer's role (06 §5.1). */
  review: (member: string) =>
    [
      `The user registered a peer conversation in the area \`words\`: member \`${member}\`. Send that peer one request`,
      `with the team dispatch tool (team_dispatch with area \`words\` and member \`${member}\`): read src/words.ts and`,
      "test/words.test.ts, change no file, and report `done` with the team report tool (team_report), naming in",
      "one sentence one case the tests do not cover yet. Send nothing to the owner of `words` and nothing to `numbers`.",
      "When the report has arrived, tell me in one sentence what it said.",
    ].join("\n"),
  /** A request to numbers whose owner has to ask words: the ask is what must reach the new seat. */
  ask: [
    "Now one request for the area `numbers` only (team_dispatch with area `numbers`). Its owner writes no code. It",
    "asks the area `words` a question with the team message tool (team_message with kind `ask` and to `words`; inside",
    "`execute` it is tools.team.message): which functions does src/words.ts export now, and what does each return",
    "for an empty string? The reply comes back to it as a new turn. When it has the reply, it reports `done` with",
    "the team report tool (team_report), giving the reply in one sentence. Send nothing to `words` yourself. When",
    "that report has arrived, tell me in one sentence what `words` answered.",
  ].join("\n"),
}
const NUDGE = (area: string) =>
  `No request reached the area \`${area}\`. Call the team dispatch tool now (team_dispatch, or tools.team.dispatch ` +
  `inside \`execute\`) with area \`${area}\` and the task I gave you.`

const OPEN =
  "Read README.md and src/words.ts if it exists, and tell me in two sentences what this folder holds. Change nothing."
const PROBE = [
  "Send the team a progress report now with the text `old seat probe`: use team_report if you have it. If you do not,",
  "try it once anyway through `execute` with exactly this code:",
  'return await tools.team.report({ kind: "progress", text: "old seat probe" })',
  "Then tell me in one line what came back. Do nothing else.",
].join("\n")
/** The roster line the main's team_status has for an area with peers (own-team `tools/status.ts`). */
const ROSTER = "words 대화:"
const STATUS = [
  "Call the team status tool now (team_status; inside `execute` it is tools.team.status) with no arguments. Then",
  `quote, word for word and alone on a line of its own, the line of its result that starts with \`${ROSTER}\`. If the`,
  "result has no such line, answer `NO ROSTER LINE`. Do nothing else.",
].join("\n")
const OWNER_NOTE = "Builds the features of words"
const PEERS = {
  reviewer: "Reads the changes of words and names what the tests miss; writes no feature",
  tester: "Adds edge-case tests only",
}

const served = await fetch(`${LOCAL_URL}/models`, { signal: AbortSignal.timeout(10_000) })
  .then((response) => response.ok)
  .catch(() => false)
if (!served) {
  console.log("local model is off: live check not run")
  process.exit(0)
}

const live = await startLiveTeam({
  name: `live-seat-${CASE}`,
  out: OUT,
  keep: false,
  fixture,
  local: { url: LOCAL_URL, model: LOCAL_MODEL },
})
const team = live.team
const started = Date.now()
const checks: Array<{ readonly name: string; readonly ok: boolean; readonly seen?: unknown }> = []
const check = (name: string, ok: boolean, seen?: unknown) => {
  checks.push({ name, ok, ...(seen === undefined ? {} : { seen }) })
  live.note({ step: "check", name, ok, ...(seen === undefined ? {} : { seen }) })
}
const result: Record<string, unknown> = { case: CASE, model: LOCAL_MODEL, checks }
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

/** What a case does while the main's request is under way, once: `when` reads this request's records. */
interface Side {
  readonly when: (mine: ReadonlyArray<OwnTeam.Dispatch>, busy: ReadonlySet<string>) => boolean
  readonly run: () => Promise<unknown>
}

async function run(name: (typeof CASES)[number]) {
  const local = live.local
  if (!local) throw new Error("no local model account")
  const project = team.project!
  const database = team.server.paths.database
  live.note({ step: "local", case: name, model: local.model, levels: local.levels })

  const enabling = await team.createSession({ model: local.model, directory: project, title: "wordkit team" })
  await team.accounts("session.approval.set", { sessionID: enabling, mode: "full" }, project)
  const enableBegun = Date.now()
  const enabled = await team.team("enable", { directory: project, sessionID: SessionID.make(enabling), hint: HINT })
  const enableOp = await opEnd(team, enabled.opID, { timeoutMs: 15 * 60_000 })
  const enableSeconds = seconds(enableBegun)
  live.note({
    step: "enable",
    state: enableOp.state,
    seconds: enableSeconds,
    steps: enableOp.steps.map((step) => `${step.kind}:${step.state}${step.note ? ` (${step.note})` : ""}`),
  })
  const view = await team.team("team.get", { directory: project })
  if (!view.team) throw new Error("the team was not enabled")
  const teamID = view.team.id
  const mainID = view.team.main.sessionID
  await team.accounts("session.approval.set", { sessionID: mainID, mode: "full" }, project)

  const makeBegun = Date.now()
  const made = await opEnd(
    team,
    await reorganize(team, teamID, [
      { op: "new", slug: "words", name: "words", goal: "src/words.ts and its tests", userMade: true },
      { op: "new", slug: "numbers", name: "numbers", goal: "src/numbers.ts and its tests", userMade: true },
    ]),
    { timeoutMs: 15 * 60_000 },
  )
  const areas = await live.areasOf(teamID)
  live.note({
    step: "areas",
    state: made.state,
    seconds: seconds(makeBegun),
    areas: areas.map((area) => ({ name: area.name, branch: area.branch, owner: area.owner.sessionID })),
  })
  result.setup = { enable: enableSeconds, areas: seconds(makeBegun) }
  const wordsID = areas.find((area) => area.name === "words")?.id
  const numbers = areas.find((area) => area.name === "numbers")
  if (wordsID === undefined || numbers === undefined || areas.length !== 2)
    throw new Error("the two areas were not made")
  const words = () => live.areaOf(teamID, wordsID)
  const folder = (await words()).directory

  /** The main's requests to an area (words when not named), in the order they were made. */
  const requestsOf = (areaID: string = wordsID) =>
    dispatches(database, teamID).filter((item) => item.areaID === areaID && item.from === "main")
  /** What waits for the main's next team update (KV `digest:<teamID>`, own-team `report/fold.ts`). */
  const digest = () =>
    (
      kv(database)[`digest:${teamID}`] as
        | {
            readonly entries: ReadonlyArray<{
              readonly reason: string
              readonly areaID?: string
              readonly wake: boolean
            }>
          }
        | undefined
    )?.entries ?? []
  /** The team requests a conversation holds: the user messages with the `own.dispatch` metadata. */
  const received = async (sessionID: string, directory: string = folder) =>
    (await live.history(sessionID, directory)).filter(
      (message) =>
        message.type === "user" &&
        typeof message.metadata === "object" &&
        message.metadata !== null &&
        OwnTeam.DISPATCH_META in message.metadata,
    )
  /** A conversation's tool calls, oldest first, each with its whole state as text. */
  const toolParts = async (sessionID: string, directory: string) =>
    (await live.history(sessionID, directory)).flatMap((message) =>
      ((message.content as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((part) => part.type === "tool")
        .map((part) => ({ tool: String(part.name), state: JSON.stringify(part.state) })),
    )
  /** A conversation's team tool calls, oldest first: the tool, what it was given and what came back (clipped). */
  const teamCalls = async (sessionID: string, directory: string) =>
    (await toolParts(sessionID, directory))
      .filter(
        (part) =>
          part.tool.startsWith("team_") || (part.tool === "execute" && /tools\.team\b|\bteam\./.test(part.state)),
      )
      .map((part) => ({ tool: part.tool, state: part.state.slice(0, 1200) }))
  /** What a conversation holds of the team: its team allows, its role entries, and whether it was archived. */
  const holds = async (sessionID: string) => {
    const row = sessionRows(database).find((item) => item.id === sessionID)
    return {
      rules: (row?.permission ?? []).filter((rule) => String(rule.action).startsWith("team.")),
      entries: (await instructionEntries(team.server, sessionID))
        .map((entry) => String(entry.key))
        .filter((key) => key.startsWith("own.team")),
      archived: row?.metadata["own.archived"] !== undefined,
      model: row?.model ?? null,
    }
  }
  /** The chat requests the local server got for a conversation since `since`. */
  const sentToModel = (sessionID: string, since: number) =>
    fs
      .readFileSync(path.join(OUT, "local-bodies.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { at: number; session?: string; body: Record<string, unknown> })
      .filter((line) => line.session === sessionID && line.at >= since)
  /** The team updates the main got, oldest first. */
  const updates = async () =>
    (await live.history(mainID, project))
      .filter((message) => message.type === "synthetic" && String(message.text).includes("<team-update"))
      .map((message) => String(message.text))

  /**
   * The user's message to the team main, until nothing ran for {@link QUIET} after a main request went to the area (or
   * the main stopped without sending one, or the time ran out). One reminder when the main sent nothing. `side` runs
   * once beside it, as the user's click in the middle of the work.
   */
  const drive = async (
    name: string,
    text: string,
    options: { readonly areaID?: string; readonly area?: string; readonly side?: Side } = {},
  ) => {
    const held = requestsOf(options.areaID).length
    const begun = Date.now()
    const mark = { sentAt: 0, quietSince: 0, nudged: false, timeout: false }
    const side: { done?: Promise<unknown> } = {}
    await team.server.prompt(mainID, text)
    for (;;) {
      await Bun.sleep(options.side !== undefined && side.done === undefined ? 1_000 : 5_000)
      const mine = requestsOf(options.areaID).slice(held)
      const sent = mine.find((item) => item.sentTo !== undefined)
      if (sent && mark.sentAt === 0) {
        mark.sentAt = Date.now()
        live.note({ step: name, sentTo: sent.sentTo?.sessionID, seconds: seconds(begun) })
      }
      const busy = await active(team)
      if (options.side !== undefined && side.done === undefined && options.side.when(mine, busy)) {
        live.note({ step: name, side: "started", seconds: seconds(begun) })
        // A failure is kept and thrown when the request is over, so the request's own records are still read.
        side.done = options.side.run().then(
          () => undefined,
          (error: unknown) => error,
        )
      }
      const moving =
        busy.size > 0 ||
        dispatches(database, teamID).some((item) => item.state === "waiting") ||
        digest().some((entry) => entry.wake)
      mark.quietSince = moving ? 0 : mark.quietSince || Date.now()
      if (Date.now() - begun > REQUEST_TIMEOUT) {
        mark.timeout = true
        break
      }
      if (mark.quietSince === 0 || Date.now() - mark.quietSince < QUIET) continue
      if (mine.length > 0 || mark.nudged) break
      mark.nudged = true
      mark.quietSince = 0
      live.note({ step: name, nudge: true, answer: (await live.answer(mainID, project)).slice(0, 600) })
      await team.server.prompt(mainID, NUDGE(options.area ?? "words"))
    }
    const failed = await side.done
    if (failed !== undefined) throw failed
    const mine = requestsOf(options.areaID).slice(held)
    const outcome = {
      seconds: seconds(begun),
      untilSent: mark.sentAt === 0 ? null : Math.round((mark.sentAt - begun) / 1000),
      nudged: mark.nudged,
      timeout: mark.timeout,
      side: options.side === undefined ? undefined : side.done !== undefined,
      requests: mine.map((item) => ({
        id: item.id,
        state: item.state,
        to: item.to,
        sentTo: item.sentTo?.sessionID,
        sentAfter: item.sentTo === undefined ? null : Math.round((item.sentTo.at - begun) / 1000),
        text: item.text.slice(0, 400),
      })),
      mainAnswer: (await live.answer(mainID, project)).slice(0, 800),
    }
    live.note({ step: name, done: true, seconds: outcome.seconds })
    return { begun, mine, outcome }
  }

  /** What stands in words' folder: the test run, the commits, and which of the tasks' functions the module exports. */
  const built = () => {
    const tests = bunTest(folder)
    const source = fs.existsSync(path.join(folder, "src/words.ts"))
      ? fs.readFileSync(path.join(folder, "src/words.ts"), "utf8")
      : ""
    return {
      tests: { pass: tests.pass, fail: tests.fail },
      exports: Object.keys(TASKS).filter((task) => new RegExp(`export (async )?function ${task}\\b`).test(source)),
      commits: Bun.spawnSync(["git", "log", "--oneline", "-8"], { cwd: folder }).stdout.toString().trim().split("\n"),
    }
  }

  /** One request of the main to words' owner, and the checks every such request gets. */
  const request = async (
    name: string,
    text: string,
    options: { readonly expected?: string; readonly other?: string; readonly side?: Side } = {},
  ) => {
    const before = {
      other: options.other === undefined ? 0 : (await live.history(options.other, folder)).length,
      calls: options.expected === undefined ? 0 : (await teamCalls(options.expected, folder)).length,
    }
    const driven = await drive(name, text, options.side === undefined ? {} : { side: options.side })
    const sent = driven.mine.find((item) => item.sentTo !== undefined)
    const receiver = sent?.sentTo?.sessionID
    const area = await words()
    const outcome = {
      ...driven.outcome,
      status: `${area.status.kind}: ${area.status.text}`.slice(0, 200),
      // Only this request's calls: a seat that held the area before has older reports in its history.
      receiverCalls:
        receiver === undefined
          ? []
          : (await teamCalls(receiver, folder)).slice(receiver === options.expected ? before.calls : 0).slice(-4),
      ...built(),
    }
    result[name] = outcome
    check(`${name}: the main sent words one request`, driven.mine.length === 1 && sent !== undefined, outcome.requests)
    check(
      `${name}: it went to the area's seat`,
      receiver !== undefined && receiver === (options.expected ?? area.owner.sessionID),
      {
        receiver,
        seat: area.owner.sessionID,
      },
    )
    check(
      `${name}: the seat reported with a team tool`,
      outcome.receiverCalls.some((call) => /team[._]report/.test(call.tool + call.state)),
      outcome.receiverCalls,
    )
    if (options.other !== undefined)
      check(
        `${name}: the other conversation got nothing`,
        (await live.history(options.other, folder)).length === before.other,
        { before: before.other, after: (await live.history(options.other, folder)).length },
      )
    check(`${name}: bun test passes in the area's folder`, outcome.tests.pass > 0 && outcome.tests.fail === 0, {
      pass: outcome.tests.pass,
      fail: outcome.tests.fail,
    })
    return { begun: driven.begun, sent, receiver }
  }

  /** An op to its end, with the second each step was done at; `sample` sees every reading, about five a second. */
  const follow = async (
    name: string,
    opID: string,
    begun: number,
    sample?: (op: OwnTeam.Op, done: number) => Promise<void>,
  ) => {
    const steps: Record<string, number> = {}
    const op = await waitValue(
      async () => {
        const current = (await team.team("op.get", { opID: OwnTeam.OpID.make(opID) })).op
        const done = current.steps.filter((step) => step.state === "done" && steps[step.kind] === undefined)
        done.forEach((step) => (steps[step.kind] = (Date.now() - begun) / 1000))
        await sample?.(current, done.length)
        return current.state === "running" || current.state === "waiting" ? undefined : current
      },
      `${name}: the op did not end`,
      OP_TIMEOUT,
    )
    return { op, steps }
  }

  /**
   * 담당 대화 바꾸기: the button's RPC, then the op to its end. `working` is the click while the old seat is in the
   * middle of a turn: what the op, the old seat, the owner record and the area's requests showed on the way is kept
   * (one line per change), and the checks read that the op waited and that nothing was sent meanwhile.
   */
  const move = async (name: string, to: string, from: string, mode: { readonly working?: boolean } = {}) => {
    const before = {
      main: (await live.history(mainID, project)).length,
      target: await holds(to),
      sent: requestsOf().filter((item) => item.sentTo !== undefined).length,
    }
    const begun = Date.now()
    const asked = await team.team("area.seat", { teamID, areaID: wordsID, sessionID: SessionID.make(to) })
    const trace: Array<Record<string, unknown>> = []
    const seen = { last: "", early: false, sent: false, reported: false }
    const followed = await follow(
      name,
      asked.opID,
      begun,
      mode.working
        ? async (op, done) => {
            const busy = await active(team)
            const area = await words()
            const box = await team.team("outbox.list", { teamID, areaID: wordsID })
            const wait = op.steps.find((step) => step.wait !== undefined)
            const sample = {
              op: op.state,
              done: op.steps.filter((step) => step.state === "done").map((step) => step.kind),
              wait: wait === undefined ? null : `${wait.kind}: ${wait.wait?.why} (${wait.wait?.text})`,
              oldSeatWorks: busy.has(from),
              owner: area.owner.sessionID === from ? "old" : area.owner.sessionID === to ? "new" : "other",
              requests: requestsOf().map(
                (item) =>
                  `${item.state}${item.sentTo?.sessionID === from ? " to old" : item.sentTo?.sessionID === to ? " to new" : ""}`,
              ),
              outbox: box.why ?? null,
            }
            const running = op.state === "running" || op.state === "waiting"
            if (done > 0 && busy.has(from)) seen.early = true
            if (running && requestsOf().filter((item) => item.sentTo !== undefined).length > before.sent)
              seen.sent = true
            if (done > 0 && op.steps[0]?.state === "done" && !seen.reported)
              seen.reported = (await teamCalls(from, folder)).some((call) => /team[._]report/.test(call.state))
            const key = JSON.stringify(sample)
            if (key !== seen.last) trace.push({ at: Math.round((Date.now() - begun) / 100) / 10, ...sample })
            seen.last = key
          }
        : undefined,
    )
    const op = followed.op
    const steps = followed.steps
    const area = await words()
    const now = { target: await holds(to), old: await holds(from) }
    result[name] = {
      seconds: seconds(begun),
      steps,
      op: op.steps.map((step) => `${step.kind}:${step.state}${step.note ? ` (${step.note})` : ""}`),
      owner: area.owner,
      main: area.main,
      peers: area.peers,
      target: now.target,
      old: now.old,
      ...(mode.working ? { trace } : {}),
    }
    live.note({ step: name, state: op.state, seconds: seconds(begun), steps })
    if (mode.working) {
      const first = trace[0]
      check(
        `${name}: the op waited at the safe point while the old seat worked`,
        first !== undefined &&
          first.op === "running" &&
          String(first.wait).startsWith("seat.wait: safe-point") &&
          first.oldSeatWorks === true &&
          first.owner === "old" &&
          (first.done as ReadonlyArray<string>).length === 0,
        first,
      )
      check(
        `${name}: no step ended before the old seat's turn did, and the old seat had reported by then`,
        !seen.early && seen.reported && steps["seat.wait"] !== undefined,
        { early: seen.early, reported: seen.reported, wait: steps["seat.wait"] },
      )
      check(`${name}: no request was sent while the op held the area`, !seen.sent, trace)
    }
    check(
      `${name}: the op ended done, every step done`,
      op.state === "done" && op.steps.every((step) => step.state === "done"),
      op.steps.map((step) => `${step.kind}:${step.state}`),
    )
    check(
      `${name}: the area's owner is the chosen conversation, the old one listed as 'seat'`,
      area.owner.sessionID === to &&
        area.owner.attached &&
        area.owner.previous.at(-1)?.sessionID === from &&
        area.owner.previous.at(-1)?.why === "seat" &&
        area.owner.release === undefined,
      area.owner,
    )
    check(
      `${name}: the chosen conversation holds the owner's allows, role and take-over entries`,
      JSON.stringify(now.target.rules) === JSON.stringify(Permissions.rules("owner")) &&
        now.target.entries.includes(RoleInstructions.OWNER) &&
        now.target.entries.includes(RoleInstructions.HANDOFF),
      now.target,
    )
    check(
      `${name}: the old conversation holds no team allow and no owner role, and is not archived`,
      now.old.rules.length === 0 && !now.old.entries.includes(RoleInstructions.OWNER) && !now.old.archived,
      now.old,
    )
    check(
      `${name}: the chosen conversation kept its model, and the area shows it`,
      JSON.stringify(now.target.model) === JSON.stringify(before.target.model) &&
        JSON.stringify(area.main?.model) === JSON.stringify(now.target.model),
      { conversation: now.target.model, area: area.main },
    )
    // The old seat's report of a move made mid-turn wakes the main by itself, so only the line is read then.
    const line = digest().some((entry) => entry.reason === "seated" && entry.areaID === wordsID && !entry.wake)
    const told = (await updates()).some((text) => text.includes(SEATED))
    if (mode.working)
      check(`${name}: the change is one line for the main's team update, and wakes nobody by itself`, line || told, {
        digest: digest(),
      })
    if (!mode.working)
      check(
        `${name}: the main was not woken; one line waits for its next team update`,
        (await live.history(mainID, project)).length === before.main && line,
        { messages: [before.main, (await live.history(mainID, project)).length], digest: digest() },
      )
    return begun
  }

  /** What the new seat's first request carried: the team's take-over note, and the owner role in what the model got. */
  const tookOver = async (name: string, seat: string, since: number, held: number) => {
    const area = await words()
    const got = (await received(seat)).slice(held)
    const notes = OwnTeamText.notes(String(got[0]?.text ?? ""))
    check(
      `${name}: the request came with the team's take-over note`,
      notes.some((note) => note.includes(`이 대화가 '${area.name}' 영역의 담당을 다른 대화에서 넘겨받았다.`)),
      notes,
    )
    const bodies = sentToModel(seat, since).map((line) => JSON.stringify(line.body.messages))
    check(
      `${name}: the model was sent the owner role and the take-over note`,
      bodies.some((body) => body.includes(`# 영역 담당 역할 (own.team): ${area.name}`)) &&
        bodies.some((body) => body.includes("영역의 담당을 다른 대화에서 넘겨받았다")),
      { requests: bodies.length },
    )
    // The line comes with the main's next team update; a main that looks with team_status before that reads it there.
    const told = (await updates()).filter((text) => text.includes(SEATED)).map((text) => text.slice(0, 600))
    const looked = (await toolParts(mainID, project)).filter((part) => part.state.includes(SEATED)).length
    check(`${name}: the main read the change in a team update or in team_status`, told.length > 0 || looked > 0, {
      update: told.at(-1) ?? null,
      statusCalls: looked,
    })
  }

  /** words' owner conversation, which the area got when it was made. */
  const seated = async () => {
    const sessionID = (await words()).owner.sessionID
    if (sessionID === null) throw new Error("words has no owner conversation")
    await team.accounts("session.approval.set", { sessionID, mode: "full" }, folder)
    return sessionID
  }
  /** The user's own conversation in words' folder: made, talked to once, and no part of the team. */
  const open = async (label: string, title: string) => {
    const sessionID = await team.createSession({ model: local.model, directory: folder, title })
    await team.accounts("session.approval.set", { sessionID, mode: "full" }, folder)
    const begun = Date.now()
    const answer = await say(live, sessionID, folder, `open ${label}`, OPEN)
    const before = await holds(sessionID)
    result[`open ${label}`] = { seconds: seconds(begun), answer: answer.slice(0, 600), before }
    check(`${label} is an ordinary conversation before the move`, before.rules.length === 0, before)
    return sessionID
  }

  const plain = async () => {
    // Request 1: the first owner conversation A.
    const seatA = await seated()
    await request("request 1", REQUESTS.first, { expected: seatA })
    // The user's second conversation in the area's folder.
    const seatB = await open("B", "words: second conversation")

    // A → B, then request 2 without a word about it.
    const heldB = (await received(seatB)).length
    const moved = await move("move A to B", seatB, seatA)
    const second = await request("request 2", REQUESTS.second, { expected: seatB, other: seatA })
    if (second.receiver === seatB) await tookOver("request 2", seatB, moved, heldB)
    check(
      "request 2: the main's request did not mention the change",
      !/seat|conversation|담당|대화/i.test(second.sent?.text ?? ""),
      second.sent?.text.slice(0, 400),
    )

    // The old seat is an ordinary conversation: told to report to the team anyway, it has no tool that reaches it.
    const probeBegun = Date.now()
    const statusBefore = JSON.stringify((await words()).status)
    const probed = await say(live, seatA, folder, "old seat probe", PROBE)
    const probeCalls = (await teamCalls(seatA, folder)).filter((call) => call.state.includes("old seat probe"))
    const probeSent = sentToModel(seatA, probeBegun)
    result.probe = { seconds: seconds(probeBegun), answer: probed.slice(0, 600), calls: probeCalls }
    check(
      "the old seat has no team tool in its tool list, and was told its owner role no longer applies",
      probeSent.length > 0 &&
        probeSent.every((line) => !/"team_/.test(JSON.stringify(line.body.tools ?? []))) &&
        probeSent.every((line) =>
          JSON.stringify(line.body.messages).includes(
            `The context under \\"${RoleInstructions.OWNER}\\" no longer applies`,
          ),
        ),
      { requests: probeSent.length, tools: (probeSent[0]?.body.tools as Array<unknown> | undefined)?.length },
    )
    check(
      "the old seat's try reached nobody: no report in the team, the area's state as it was",
      probeCalls.every((call) => !call.state.includes('\\"ok\\": true')) &&
        !JSON.stringify(digest()).includes("old seat probe") &&
        !JSON.stringify(await live.history(mainID, project)).includes("old seat probe") &&
        JSON.stringify((await words()).status) === statusBefore,
      { answer: probed.slice(0, 300), calls: probeCalls },
    )
    check("the old seat's attempt changed nothing: words still belongs to B", (await words()).owner.sessionID === seatB)

    // B → A, then request 3.
    const heldA = (await received(seatA)).length
    const back = await move("move B to A", seatA, seatB)
    const third = await request("request 3", REQUESTS.third, { expected: seatA, other: seatB })
    if (third.receiver === seatA) await tookOver("request 3", seatA, back, heldA)
    return { A: { id: seatA, directory: folder }, B: { id: seatB, directory: folder } }
  }

  // The click comes while the old seat is in the middle of the request: nothing is interrupted, the op waits.
  const busy = async () => {
    const seatA = await seated()
    const seatB = await open("B", "words: second conversation")
    const heldB = (await received(seatB)).length
    const mark = { moved: 0 }
    const heldUpdates = (await updates()).length
    const first = await request("request 1", REQUESTS.first, {
      expected: seatA,
      other: seatB,
      side: {
        when: (mine, working) => mine.some((item) => item.sentTo?.sessionID === seatA) && working.has(seatA),
        run: async () => {
          mark.moved = await move("move A to B", seatB, seatA, { working: true })
        },
      },
    })
    check("the move was asked for while A worked on request 1", mark.moved > 0, { receiver: first.receiver })
    const reported = (await updates()).slice(heldUpdates).filter((text) => /reason="[^"]*ready/.test(text))
    check(
      "request 1: A's report reached the main in a team update",
      reported.length > 0,
      reported.map((text) => text.slice(0, 600)),
    )
    const second = await request("request 2", REQUESTS.second, { expected: seatB, other: seatA })
    if (second.receiver === seatB) await tookOver("request 2", seatB, mark.moved, heldB)
    return { A: { id: seatA, directory: folder }, B: { id: seatB, directory: folder } }
  }

  // Two requests in a row: the second waits in the outbox behind the first, and the seat moves before its turn.
  const queued = async () => {
    const seatA = await seated()
    const seatB = await open("B", "words: second conversation")
    const heldB = (await received(seatB)).length
    const mark = { moved: 0 }
    const driven = await drive("requests 1+2", REQUESTS.pair, {
      side: {
        when: (mine, working) =>
          mine.length === 2 &&
          mine.some((item) => item.sentTo?.sessionID === seatA) &&
          mine.some((item) => item.state === "waiting") &&
          working.has(seatA),
        run: async () => {
          mark.moved = await move("move A to B", seatB, seatA, { working: true })
        },
      },
    })
    const [one, two] = driven.mine
    const got = {
      A: (await received(seatA)).map(dispatchOf),
      B: (await received(seatB)).map(dispatchOf),
    }
    const calls = { A: (await teamCalls(seatA, folder)).slice(-4), B: (await teamCalls(seatB, folder)).slice(-4) }
    const left = [...inbox(database, seatA), ...inbox(database, seatB)].filter((row) =>
      JSON.stringify(row.payload).includes(OwnTeam.DISPATCH_META),
    )
    const stands = built()
    result["requests 1+2"] = { ...driven.outcome, got, calls, left: left.length, ...stands }
    check("requests 1+2: the main sent words two requests", driven.mine.length === 2, driven.outcome.requests)
    check("the move was asked for while A worked and the second request waited", mark.moved > 0, {
      side: driven.outcome.side,
    })
    check(
      "the first request went to A, and the one that waited went to B",
      one?.state === "sent" &&
        one.sentTo?.sessionID === seatA &&
        two?.state === "sent" &&
        two.sentTo?.sessionID === seatB,
      driven.outcome.requests,
    )
    check(
      "each request was delivered once: the first only to A, the second only to B",
      one !== undefined &&
        two !== undefined &&
        got.A.filter((id) => id === one.id).length === 1 &&
        got.B.filter((id) => id === two.id).length === 1 &&
        !got.A.includes(two.id) &&
        !got.B.includes(one.id),
      got,
    )
    check("no team request is left in either conversation's queue", left.length === 0, left)
    check(
      "both seats reported with a team tool",
      calls.A.some((call) => /team[._]report/.test(call.tool + call.state)) &&
        calls.B.some((call) => /team[._]report/.test(call.tool + call.state)),
      calls,
    )
    check(
      "both tasks stand in the area's folder and bun test passes",
      stands.exports.includes("countWords") &&
        stands.exports.includes("longestWord") &&
        stands.tests.pass > 0 &&
        stands.tests.fail === 0,
      stands,
    )
    if (two?.sentTo?.sessionID === seatB) await tookOver("request 2", seatB, mark.moved, heldB)
    return { A: { id: seatA, directory: folder }, B: { id: seatB, directory: folder } }
  }

  // An area with an owner note and two peers; the first peer is made the owner.
  const peer = async () => {
    const seatA = await seated()
    await request("request 1", REQUESTS.first, { expected: seatA })
    const seatP = await open("P", "words: review conversation")
    const seatQ = await team.createSession({ model: local.model, directory: folder, title: "words: test conversation" })
    const reviewer = await team.team("area.peer.add", {
      teamID,
      areaID: wordsID,
      sessionID: SessionID.make(seatP),
      label: "reviewer",
      role: PEERS.reviewer,
    })
    const tester = await team.team("area.peer.add", {
      teamID,
      areaID: wordsID,
      sessionID: SessionID.make(seatQ),
      label: "tester",
      role: PEERS.tester,
    })
    await team.team("area.edit", { teamID, areaID: wordsID, note: OWNER_NOTE })
    const keys = { reviewer: reviewer.peer.key, tester: tester.peer.key }
    live.note({ step: "peers", keys, note: (await words()).owner.note })

    /** The main's team_status, read from the tool's own result, and what the main quoted of it. */
    const roster = async (name: string, expected: string, gone?: string) => {
      const held = (await toolParts(mainID, project)).length
      const begun = Date.now()
      const answer = await say(live, mainID, project, name, STATUS)
      const calls = (await toolParts(mainID, project)).slice(held)
      // The result is JSON inside JSON: line ends and quotes come back from however many levels of escaping.
      const lines = calls
        .flatMap((call) => call.state.replaceAll(/\\+n/g, "\n").replaceAll(/\\+"/g, '"').split("\n"))
        .filter((line) => line.includes(ROSTER))
      result[name] = { seconds: seconds(begun), answer: answer.slice(0, 800), lines, calls: calls.length }
      check(
        `${name}: team_status gave the main the roster line`,
        lines.some((line) => line.includes(expected)) &&
          (gone === undefined || lines.every((line) => !line.includes(gone))),
        { expected, lines },
      )
      check(`${name}: the main quoted the line as it was`, answer.includes(expected), answer.slice(0, 600))
    }

    // The peer's first main request attaches its allows and its role.
    const heldA = (await live.history(seatA, folder)).length
    const review = await drive("request to the peer", REQUESTS.review(keys.reviewer))
    const asPeer = await holds(seatP)
    const peerCalls = (await teamCalls(seatP, folder)).slice(-4)
    result["request to the peer"] = { ...review.outcome, holds: asPeer, calls: peerCalls }
    check(
      "request to the peer: the main sent one request to the member, and it went to the peer's conversation",
      review.mine.length === 1 && review.mine[0]?.to === keys.reviewer && review.mine[0].sentTo?.sessionID === seatP,
      review.outcome.requests,
    )
    check(
      "request to the peer: the peer holds the team allows and the peer role",
      asPeer.rules.length > 0 &&
        asPeer.entries.includes(RoleInstructions.PEER) &&
        !asPeer.entries.includes(RoleInstructions.OWNER),
      asPeer,
    )
    check(
      "request to the peer: the peer reported with a team tool, and the owner got nothing",
      peerCalls.some((call) => /team[._]report/.test(call.tool + call.state)) &&
        (await live.history(seatA, folder)).length === heldA,
      peerCalls,
    )
    await roster(
      "status before",
      `${ROSTER} 담당 메모 "${OWNER_NOTE}", reviewer(${keys.reviewer}) 역할 "${PEERS.reviewer}", tester(${keys.tester}) 역할 "${PEERS.tester}"`,
    )

    // 이 대화를 담당으로 on the peer.
    const heldP = (await received(seatP)).length
    const moved = await move("move A to P", seatP, seatA)
    const after = await words()
    const asOwner = await holds(seatP)
    check(
      "move A to P: the peer's record is gone and the other peer's stays",
      JSON.stringify((after.peers ?? []).map((item) => item.key)) === JSON.stringify([keys.tester]),
      after.peers,
    )
    check(
      "move A to P: the conversation lost the peer role and holds the owner role",
      !asOwner.entries.includes(RoleInstructions.PEER) && asOwner.entries.includes(RoleInstructions.OWNER),
      asOwner,
    )
    check("move A to P: the owner note stays with the seat", after.owner.note === OWNER_NOTE, after.owner.note)
    await roster(
      "status after",
      `${ROSTER} 담당 메모 "${OWNER_NOTE}", tester(${keys.tester}) 역할 "${PEERS.tester}"`,
      `reviewer(${keys.reviewer})`,
    )

    // The other area's owner asks words: the ask goes to the new seat, and its reply comes back.
    const seatN = numbers.owner.sessionID
    if (seatN === null) throw new Error("numbers has no owner conversation")
    await team.accounts("session.approval.set", { sessionID: seatN, mode: "full" }, numbers.directory)
    const heldOld = (await live.history(seatA, folder)).length
    const heldCalls = (await teamCalls(seatP, folder)).length
    const asked = await drive("ask from numbers", REQUESTS.ask, { areaID: numbers.id, area: "numbers" })
    const talk = dispatches(database, teamID).filter((item) => item.from === "area")
    const asks = talk.filter((item) => item.areaID === wordsID && item.kind === "ask")
    const replies = talk.filter((item) => item.areaID === numbers.id && item.kind === "reply")
    const calls = {
      numbers: (await teamCalls(seatN, numbers.directory)).slice(-6),
      seat: (await teamCalls(seatP, folder)).slice(heldCalls),
    }
    result["ask from numbers"] = {
      ...asked.outcome,
      asks: asks.map((item) => ({ state: item.state, sentTo: item.sentTo?.sessionID, text: item.text.slice(0, 400) })),
      replies: replies.map((item) => ({
        state: item.state,
        sentTo: item.sentTo?.sessionID,
        text: item.text.slice(0, 600),
      })),
      calls,
      seatAnswer: (await live.answer(seatP, folder)).slice(0, 600),
    }
    check(
      "ask from numbers: the main sent numbers one request, and its owner asked words with the team message tool",
      asked.mine.length === 1 &&
        asked.mine[0]?.sentTo?.sessionID === seatN &&
        calls.numbers.some((call) => /team[._]message/.test(call.tool + call.state)),
      { requests: asked.outcome.requests, calls: calls.numbers },
    )
    check(
      "ask from numbers: the ask was sent once, to the new seat, and the old seat got nothing",
      asks.length === 1 &&
        asks[0]?.state === "sent" &&
        asks[0].sentTo?.sessionID === seatP &&
        (await live.history(seatA, folder)).length === heldOld,
      asks.map((item) => ({ state: item.state, sentTo: item.sentTo?.sessionID })),
    )
    check(
      "ask from numbers: the reply went back to the owner of numbers, which reported",
      replies.length === 1 &&
        replies[0]?.sentTo?.sessionID === seatN &&
        calls.numbers.some((call) => /team[._]report/.test(call.tool + call.state)),
      { replies: replies.map((item) => ({ state: item.state, sentTo: item.sentTo?.sessionID })), calls: calls.numbers },
    )
    if (asks[0]?.sentTo?.sessionID === seatP) await tookOver("ask from numbers", seatP, moved, heldP)
    const bodies = sentToModel(seatP, moved).map((line) => JSON.stringify(line.body.messages))
    check(
      "ask from numbers: the new seat's model was told its peer role no longer applies",
      bodies.some((body) => body.includes(`The context under \\"${RoleInstructions.PEER}\\" no longer applies`)),
      { requests: bodies.length },
    )
    return {
      A: { id: seatA, directory: folder },
      P: { id: seatP, directory: folder },
      N: { id: seatN, directory: numbers.directory },
    }
  }

  // 새 대화로 이어가기 on an owner that got the seat by a move.
  const rotate = async () => {
    const seatA = await seated()
    await request("request 1", REQUESTS.first, { expected: seatA })
    const seatB = await open("B", "words: second conversation")
    const heldB = (await received(seatB)).length
    const moved = await move("move A to B", seatB, seatA)
    const second = await request("request 2", REQUESTS.second, { expected: seatB, other: seatA })
    if (second.receiver === seatB) await tookOver("request 2", seatB, moved, heldB)

    const known = new Set(sessionRows(database).map((row) => String(row.id)))
    const heldParts = (await toolParts(seatB, folder)).length
    const heldMain = (await live.history(mainID, project)).length
    const begun = Date.now()
    const asked = await team.team("area.rotate", { teamID, areaID: wordsID })
    const followed = await follow("rotate", asked.opID, begun)
    const area = await words()
    const seatC = area.owner.sessionID
    if (seatC === null) throw new Error("words has no owner conversation after the rotation")
    await team.accounts("session.approval.set", { sessionID: seatC, mode: "full" }, folder)
    const now = { fresh: await holds(seatC), old: await holds(seatB), first: await holds(seatA) }
    // The handoff the seated owner was asked for: its own call of the team handoff tool, with the document's start.
    const handoff = (await toolParts(seatB, folder))
      .slice(heldParts)
      .filter((part) => /team[._]handoff/.test(part.tool + part.state))
      .map((part) => ({ tool: part.tool, state: part.state.slice(0, 1200) }))
    result.rotate = {
      seconds: seconds(begun),
      steps: followed.steps,
      op: followed.op.steps.map((step) => `${step.kind}:${step.state}${step.note ? ` (${step.note})` : ""}`),
      owner: area.owner,
      main: area.main,
      ...now,
      handoff,
      oldAnswer: (await live.answer(seatB, folder)).slice(0, 600),
      mainGrew: (await live.history(mainID, project)).length - heldMain,
      digest: digest(),
    }
    live.note({ step: "rotate", state: followed.op.state, seconds: seconds(begun), steps: followed.steps })
    check(
      "rotate: the op ended done, every step done",
      followed.op.state === "done" && followed.op.steps.every((step) => step.state === "done"),
      followed.op.steps.map((step) => `${step.kind}:${step.state}${step.note ? ` (${step.note})` : ""}`),
    )
    check(
      "rotate: the seated owner wrote the handoff itself with the team handoff tool",
      handoff.length > 0 && followed.op.steps.some((step) => step.kind === "rotate.handoff" && step.state === "done"),
      { calls: handoff.length, step: followed.op.steps.find((step) => step.kind === "rotate.handoff")?.note },
    )
    check(
      "rotate: a new conversation holds the seat; the first seat and the rotated one are listed in that order",
      !known.has(seatC) &&
        area.owner.pending === undefined &&
        area.owner.release === undefined &&
        JSON.stringify(area.owner.previous.slice(-2).map((item) => item.sessionID)) ===
          JSON.stringify([seatA, seatB]) &&
        area.owner.previous.at(-2)?.why === "seat" &&
        area.owner.previous.at(-1)?.why === "user",
      area.owner,
    )
    check(
      "rotate: the new conversation holds the owner's allows, the owner role and a handoff",
      JSON.stringify(now.fresh.rules) === JSON.stringify(Permissions.rules("owner")) &&
        now.fresh.entries.includes(RoleInstructions.OWNER) &&
        now.fresh.entries.includes(RoleInstructions.HANDOFF),
      now.fresh,
    )
    check(
      "rotate: the rotated conversation was archived; the first seat stays an ordinary conversation",
      now.old.archived && !now.first.archived && now.first.rules.length === 0,
      { old: now.old, first: now.first },
    )
    check(
      "rotate: the new conversation is on the model the seat brought, the local one",
      JSON.stringify(now.fresh.model) === JSON.stringify(now.old.model) &&
        JSON.stringify(area.main?.model) === JSON.stringify(now.fresh.model) &&
        JSON.stringify(now.fresh.model).includes(LOCAL_MODEL),
      { fresh: now.fresh.model, old: now.old.model, area: area.main },
    )

    const third = await request("request 3", REQUESTS.third, { expected: seatC, other: seatB })
    const sent = sentToModel(seatC, begun)
    const bodies = sent.map((line) => JSON.stringify(line.body.messages))
    result["request 3 model"] = {
      requests: sent.length,
      models: [...new Set(sent.map((line) => String(line.body.model)))],
      efforts: [...new Set(sent.map((line) => String(line.body.reasoning_effort)))],
      handoffs: [...new Set(bodies.flatMap((body) => body.match(/# 인계: words \([^)]*\)/g) ?? []))],
    }
    check(
      "request 3: the model of the new conversation was sent the owner role and the handoff",
      third.receiver === seatC &&
        bodies.some((body) => body.includes("# 영역 담당 역할 (own.team): words")) &&
        bodies.some((body) => body.includes("# 인계: words")),
      result["request 3 model"],
    )
    check(
      "request 3: every model request of the new conversation named the local model",
      sent.length > 0 && sent.every((line) => line.body.model === LOCAL_MODEL),
      result["request 3 model"],
    )
    return {
      A: { id: seatA, directory: folder },
      B: { id: seatB, directory: folder },
      C: { id: seatC, directory: folder },
    }
  }

  const seats: Record<string, { readonly id: string; readonly directory: string }> = await {
    plain,
    busy,
    queued,
    peer,
    rotate,
  }[name]()

  // Nothing but the local server was called: the proxy saw every model request of the run.
  const calls = fs
    .readFileSync(path.join(OUT, "local.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => String(line.path).endsWith("/chat/completions"))
  result.model = {
    name: LOCAL_MODEL,
    requests: calls.length,
    promptTokens: calls.reduce((sum, line) => sum + Number(line.promptTokens ?? 0), 0),
    completionTokens: calls.reduce((sum, line) => sum + Number(line.completionTokens ?? 0), 0),
    longest: Math.max(0, ...calls.map((line) => Number(line.seconds ?? 0))),
    closedEarly: calls.filter((line) => line.closedEarly === true).length,
  }
  check(
    "every model request named the local model, carried no key and was answered",
    calls.length > 0 &&
      calls.every((line) => line.model === LOCAL_MODEL && line.authorization === false && line.status === 200),
    result.model,
  )
  result.requests = dispatches(database, teamID).map((item) => ({
    area: item.areaID,
    seq: item.seq,
    from: item.from,
    kind: item.kind,
    to: item.to,
    state: item.state,
    sentTo: item.sentTo?.sessionID,
    text: item.text.slice(0, 300),
  }))
  result.ids = { main: mainID, ...Object.fromEntries(Object.entries(seats).map(([key, seat]) => [key, seat.id])) }
  result.conversations = {
    main: await live.conversation(mainID, project),
    ...Object.fromEntries(
      await Promise.all(
        Object.entries(seats).map(async ([key, seat]) => [key, await live.conversation(seat.id, seat.directory)]),
      ),
    ),
  }
  result.asked = live.log.filter(
    (entry) => entry.step === "permission" || entry.step === "confirm" || entry.step === "form",
  )
}

function seconds(since: number) {
  return Math.round((Date.now() - since) / 1000)
}

/** wordkit: a README that plans the two modules, AGENTS.md and a smoke test, on `main` with one commit. */
function fixture(base: string) {
  return gitFixture(base, "wordkit", {
    "package.json": JSON.stringify({ name: "wordkit", type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "README.md": [
      "# wordkit",
      "",
      "Small text and number helpers in TypeScript, no dependencies. Planned modules:",
      "",
      "- `src/words.ts`: helpers over the words of a text",
      "- `src/numbers.ts`: helpers over `number[]`",
      "",
      "Each module has its tests in `test/<module>.test.ts` (bun:test). `bun test` runs them all.",
      "",
    ].join("\n"),
    "AGENTS.md": [
      "- TypeScript, ES modules, no dependencies. Export plain functions.",
      "- Tests use `bun:test` and live in `test/`. Run `bun test` before you report.",
      "",
    ].join("\n"),
    "test/smoke.test.ts": [
      'import { expect, test } from "bun:test"',
      "",
      'test("the repository runs tests", () => {',
      "  expect(1 + 1).toBe(2)",
      "})",
      "",
    ].join("\n"),
    ".gitignore": "node_modules\n",
  })
}

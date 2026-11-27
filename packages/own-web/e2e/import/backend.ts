// 다른 도구의 대화 e2e backend (09 §6, §7.4 IG1, IG5, IG8–IG10 on screen). Run by this suite's Playwright webServer
// (playwright.config.ts) or by hand: `bun e2e/import/backend.ts`.
//
// The real upstream server from source with own-accounts and own-import (own-team off), booted by own-team's e2e
// harness (packages/own-team/test/e2e/harness.ts, imported read-only) with `importer: true`: own-import loads last with
// `roots` naming the synthetic Codex and Claude Code stores below, and the server's CODEX_HOME and CLAUDE_CONFIG_DIR
// name empty folders of the harness's temp root, so nothing reads this PC's `~/.codex` or `~/.claude`. Every model
// call goes to the harness's local fakes (one fake Codex backend with ChatGPT 01, 02 and 03, a fake DeepSeek and a
// fake Anthropic, both metered keys) and the Claude subscription slot (`claude: true`: a fake of the bundled
// claude-auth, its `anthropic` provider pointed at the fake Anthropic), answered by own-team's directive responder
// (packages/own-team/test/e2e/directives.ts, read-only) with one addition in front of it: core's compaction request (a
// summary helper's, 09 §4.4) gets {@link SUMMARY}, in core's template, after the delay the inspect server's
// `POST /summary?delay=<ms>` set (the slow mode of migrate.spec.ts's cancel and restore). The stores are
// written with own-import's fixture builders (packages/own-import/test/fixtures, read-only: synthetic records from the
// documented formats, never cut from a real store) once the server is up (own-import reads nothing before the first
// list, 09 §2.3):
//   - Codex (`state_5.sqlite` naming three threads, the rest found by the file scan): `설치기 고치기` (a `\\?\` cwd), a
//     `.zst` rollout of 21 turns (`설치기 성능 기록`: an encrypted remote compaction inside turn 2, `북극곰` only in a
//     tool output of turn 16, and a last turn of six tool outputs of hashes zstd hardly shrinks, so its outline is
//     still streaming when the first page arrives), one written "now" (its mtime lies ahead, so it stays `진행 중일 수
//     있음` however long the suite runs), one in the linked worktree, a thread the DB names whose rollout is gone
//     (`읽을 수 없음`), 130 turns that all mention `체크리스트` (more than one `sessions.search` answer holds: `계속
//     찾기`), a sub-agent of the first, an archived thread and a `codex exec` run;
//   - Claude Code: `Claude 설치기 리뷰` (an automatic compaction right after a tool result, mid-turn, with Claude Code's
//     summary wording), `오래된 Claude 대화` in the second clone, 25½ days old (Q3: `5일 뒤 원본이 지워질 수 있음`), one
//     whose folder is gone (`폴더 없음`), and one in the non-Git folder;
//   - a third, not yet configured Codex root (`extra`) with one conversation, which the spec adds in 설정 > 다른 도구;
//   - I2 (migrate.spec.ts), in a project of their own so the I1 lists and counts never change when they are imported:
//     `이어가기: 작은 대화` (two short turns: it fits every window), `이어가기: 큰 대화` (40 turns of large tool
//     output: it fits a 1M window but not GPT-5.3 Codex Spark's 100k), `이어가기: 원격 압축 대화` (a Codex remote
//     compaction after 30 such turns, two short ones after it: with Spark the fill crosses the boundary) and the
//     Claude Code `이어가기: Claude 대화`.
// The projects: a Git repository (`작업/installer`) with a linked worktree that core never records, a second clone of
// its root commit under a `#` folder (one Project ID in core), a non-Git folder (`메모`), its own project, and the I2
// repository `작업/이어가기`. One own conversation in each clone and in the non-Git folder makes core record those
// folders, nothing sent to a model; in `이어가기` two conversations run one turn each, on ChatGPT 02 and then ChatGPT 01
// (the folder's last model, so the I2 dialog starts there), after the fake set every ChatGPT account's usage (03 too,
// which runs nothing): ChatGPT 02 has the most left, so it carries `추천` (02 §5.10) while it is not the default
// (09 §4.5, IG9), whenever the usage poll reads the accounts.
// The inspect server (`state.inspect`, 127.0.0.1): `GET /requests` lists the model requests each fake received so far
// (`{identity, model, compaction}`, oldest first), `POST /summary?delay=<ms>` sets the summary delay, `POST /turn` runs
// one turn in `이어가기 작업` (a turn end for the notification check), `GET /usage-polls` names the accounts whose
// usage the poller read (the own account ids, in order), and `GET /sessions` names the root sessions
// own.import made (imported ones with their metadata, the helpers) and its running jobs.
// own-web runs through Vite dev (no HMR), `/api` proxied with server-side Basic auth (03 §16.2).
// Fake credentials only; every listener binds 127.0.0.1; the stores and the harness's temp root live under this
// suite's temp folder (playwright.config.ts: `checkoutTmp`) and are removed when the backend stops (stdin closed,
// SIGINT, SIGTERM). Playwright ends its webServer on Windows by killing the process tree, so the next start removes an
// earlier run's leftovers first. Run from a path without '#'.
import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { startViteDev } from "../vite-dev"
import { OwnImport } from "@own/protocol/rpc-import"
import { removeTree, requestItems, type RecordedRequest, type Reply } from "../../../own-accounts/test/e2e-kit"
import {
  harnessSummary,
  session,
  SUMMARY_BODY,
  text,
  toolUse,
  write,
  type SessionInput,
} from "../../../own-import/test/fixtures/claude"
import { compactionItem, rollout, spawnSource, threadId, userItem } from "../../../own-import/test/fixtures/codex"
import { codexRollout, stateDb, writeJsonl } from "../../../own-import/test/fixtures/make"
import { responder } from "../../../own-team/test/e2e/directives"
import { ACCOUNT, CHATGPT, MODEL, startTeamFakes, startTeamServer } from "../../../own-team/test/e2e/harness"
import { checkoutTmp } from "../gateway/support"

export const IMPORT_PORT = Number(process.env.OWN_WEB_IMPORT_E2E_PORT ?? 5781)
/** Set by playwright.config.ts (this process runs with TEMP pointed there, so it is never computed again here). */
export const IMPORT_TMP = process.env.OWN_WEB_IMPORT_E2E_TMP ?? checkoutTmp("own-web-import-e2e")
export const STATE_FILE = path.join(IMPORT_TMP, "backend.json")

/** The harness names its temp root `own-team-e2e-<name>-…` under the OS temp folder (this suite's TEMP). */
const NAME = "web-import"
const ROOTS = path.join(IMPORT_TMP, "roots")
/** In every conversation's first prompt: it must never reach OWN_HOME, the index file or the page's storage (IG10). */
const MARK = "ig10-import-ui-3c9e71"
const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const CLAUDE_VERSION = "2.1.288"
/** Claude Code session ids (file names): UUIDs, as the scan accepts. */
const CLAUDE = {
  review: "0b9e2a4c-6a7d-4c4e-9d1e-7a0000000001",
  old: "0b9e2a4c-6a7d-4c4e-9d1e-7a0000000002",
  gone: "0b9e2a4c-6a7d-4c4e-9d1e-7a0000000003",
  memo: "0b9e2a4c-6a7d-4c4e-9d1e-7a0000000004",
  resume: "0b9e2a4c-6a7d-4c4e-9d1e-7a0000000005",
} as const
const TITLES = {
  fix: "설치기 고치기",
  zst: "설치기 성능 기록",
  live: "지금 진행 중인 대화",
  worktree: "worktree에서 성능 조정",
  missing: "지워진 rollout",
  long: "배포 체크리스트 1번 항목을 확인해 줘",
  child: "하위 작업: 테스트 로그 정리",
  archived: "보관한 대화",
  exec: "codex exec 자동 실행",
  extra: "더한 뿌리의 대화",
  review: "Claude 설치기 리뷰",
  old: "오래된 Claude 대화",
  gone: "지워진 폴더의 대화",
  memo: "메모 정리 대화",
} as const
/** The I2 conversations (09 §4, migrate.spec.ts): their first requests, which the list shows as titles. */
const RESUME = {
  small: "이어가기: 작은 대화",
  big: "이어가기: 큰 대화",
  remote: "이어가기: 원격 압축 대화",
  claude: "이어가기: Claude 대화",
} as const
/** Turns of the I2 Codex conversations; `remote` holds its remote compaction after `remoteBefore` of them. */
const RESUME_TURNS = { small: 2, big: 40, remote: 32, remoteBefore: 30 } as const
/** Characters of each tool output of `이어가기: 큰 대화` (about a quarter as many tokens). */
const BIG_OUTPUT = 25_000
const REMOTE_OUTPUT = 35_000
/** How core's compaction request asks for its template (packages/core/src/session/compaction.ts `SUMMARY_TEMPLATE`). */
const SUMMARY_PROMPT = "You MUST use this format for your response"
/** The summary every compaction request gets: core takes a reply only in its template. */
const SUMMARY = [
  "## Objective",
  "- 이어가기 e2e 요약: 큰 대화의 앞부분을 요약했습니다.",
  "",
  "## Next Move",
  "1. (none)",
].join("\n")
/**
 * The usage the fake reports for every ChatGPT account (percent used of the 5 hours and the week): ChatGPT 02 has the
 * most left. Every account has its own, so `추천` stays on 02 whenever the backend's usage poll reads them: 03 runs no
 * turn, and with the fake's default 0 % it took `추천` about 50 s after boot.
 */
const USAGE = {
  "01": { primary: 40, secondary: 10 },
  "02": { primary: 5, secondary: 2 },
  "03": { primary: 60, secondary: 15 },
} as const satisfies Record<keyof typeof CHATGPT, { readonly primary: number; readonly secondary: number }>
/** own.import's hidden summary helper session title (packages/own-import/src/render/store.ts `HELPER_TITLE`). */
const HELPER_TITLE = "Import summary"

/** The delay of the next summaries (`POST /summary?delay=<ms>`). */
const control = { summaryDelay: 0 }

for (const entry of await fsp.readdir(IMPORT_TMP, { withFileTypes: true }).catch(() => []))
  if (entry.isDirectory() && entry.name.startsWith(`own-team-e2e-${NAME}-`))
    await fsp.rm(path.join(IMPORT_TMP, entry.name), { recursive: true, force: true }).catch(() => undefined)
await fsp.rm(ROOTS, { recursive: true, force: true })
const roots = {
  base: ROOTS,
  codex: path.join(ROOTS, "도구 기록", "codex"),
  claude: path.join(ROOTS, "도구 기록", "claude"),
  extra: path.join(ROOTS, "예전 프로필", "codex"),
}
await Promise.all([roots.codex, roots.claude, roots.extra].map((folder) => fsp.mkdir(folder, { recursive: true })))

const fakes = startTeamFakes({ responder: responder({ before: summaryReply }) })
const holder: { folders?: Folders } = {}
const team = await startTeamServer({
  name: NAME,
  team: false,
  importer: true,
  claude: true,
  fakes,
  importOptions: { roots: { codex: [roots.codex], claude: [roots.claude] } },
  project: (base) => {
    holder.folders = folders(base)
    return holder.folders.first
  },
}).catch(async (error: unknown) => {
  await fakes.stop()
  throw error
})
const built = holder.folders
if (built === undefined) throw new Error("the project builder did not run")
const seeded = await seed(built).catch(async (error: unknown) => {
  await team.stop()
  await fakes.stop()
  await fsp.rm(ROOTS, { recursive: true, force: true })
  throw error
})

// The ChatGPT group's default model as the user picks it: this backend has no Codex model list, and the price rule
// (07 §2.2 codex ③) chooses GPT-5.6 Cyber since v2.2.1's template, whose window the large conversation does not fit.
const defaults = await team.rpc("own.accounts", "presets.defaults.set", {
  group: "codex",
  defaultModel: { id: MODEL["01"].id },
})
if (defaults.status !== 200) throw new Error(`presets.defaults.set: ${defaults.status} ${defaults.message}`)
const password = atob(team.server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: team.server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: team.control,
})
const dev = await startViteDev({ port: IMPORT_PORT, hmr: false })
const inspect = startInspect()

const state = {
  dev: `http://127.0.0.1:${IMPORT_PORT}`,
  inspect: `http://127.0.0.1:${inspect.port}`,
  control: team.control,
  ownHome: team.ownHome,
  roots,
  folders: built,
  sessions: seeded.sessions,
  projects: seeded.projects,
  titles: TITLES,
  mark: MARK,
  /** I2 (migrate.spec.ts): the `이어가기` project's conversations and the accounts the dialog names. */
  resume: {
    titles: RESUME,
    turns: RESUME_TURNS,
    helperTitle: HELPER_TITLE,
    accounts: {
      "01": { id: ACCOUNT["01"], label: "ChatGPT 01" },
      "02": { id: ACCOUNT["02"], label: "ChatGPT 02" },
      "03": { id: ACCOUNT["03"], label: "ChatGPT 03" },
      deepseek: { id: ACCOUNT.deepseek, label: "DeepSeek" },
      claude: { id: ACCOUNT.claude },
    },
    /**
     * The ChatGPT model whose window the large conversation does not fit: the smallest Codex window (272k input) since
     * upstream v2.1 dropped gpt-5.5 and older, spark included, for ChatGPT accounts (as own-import's e2e).
     */
    small: { id: "gpt-5.6-cyber", name: "GPT-5.6 Cyber" },
    /** What the fake attributes ChatGPT 01's requests to. */
    identity: `codex:${CHATGPT["01"].accountID}`,
  },
  /** What the screens must show for the main project (folder scope) and the non-Git one. */
  expect: {
    fresh: 8,
    rows: 9,
    codex: 6,
    claude: 3,
    notGitFresh: 1,
    /** `오래된 Claude 대화`: Claude Code's 30-day cleanup, 25 days after its last record. */
    expiresIn: 5,
    /** `Claude 설치기 리뷰`: two days and an hour old, so only its tooltip names the cleanup. */
    reviewDays: 28,
    zstTurns: 21,
    /** The 1-based turn of `북극곰` in the `.zst` conversation. */
    polarTurn: 16,
  },
}
await fsp.mkdir(IMPORT_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_IMPORT_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await inspect.stop(true)
  await dev.close().catch(() => undefined)
  await team.stop()
  await fakes.stop()
  await removeTree(ROOTS)
  await fsp.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

/**
 * Writes the stores (own-import reads nothing before the first list, 09 §2.3, so after the boot is in time) and one own
 * conversation in each clone and in the non-Git folder: core records a folder for its project once a conversation
 * there resolved its Location (09 §2.2).
 */
async function seed(input: Folders) {
  await writeStores(input)
  const sessions = {
    first: await team.createSession({ title: "설치기 작업", directory: input.first }),
    second: await team.createSession({ title: "두 번째 clone 작업", directory: input.second }),
    notGit: await team.createSession({ title: "메모 정리", directory: input.notGit }),
    ...(await resumeSessions(input.resume)),
  }
  const projects = {
    main: { id: await projectOf(sessions.first), name: path.basename(input.first) },
    notGit: { id: await projectOf(sessions.notGit), name: path.basename(input.notGit) },
    resume: { id: await projectOf(sessions.resume), name: path.basename(input.resume) },
  }
  if (projects.main.id !== (await projectOf(sessions.second))) throw new Error("the two clones are not one project")
  return { sessions, projects }
}

/**
 * The `이어가기` folder's conversations (see the file header): one turn on ChatGPT 02, then one on ChatGPT 01, after
 * the fake set their usage, so both accounts show their limits and ChatGPT 01 is the folder's last model. Nothing
 * else of the suite runs before them, so these are the only model requests the fakes answered at the start.
 */
async function resumeSessions(directory: string) {
  for (const id of ["01", "02", "03"] as const) fakes.codex.setUsage(CHATGPT[id].accountID, USAGE[id])
  const browse = await team.createSession({ title: "이어가기 둘러보기", directory, model: MODEL["02"] })
  await team.turn(browse, "안녕하세요")
  const resume = await team.createSession({ title: "이어가기 작업", directory, model: MODEL["01"] })
  await team.turn(resume, "안녕하세요")
  return { browse, resume }
}

// ---------------------------------------------------------------------------------------------------------------
// The project folders

interface Folders {
  /** The repository's main folder, under a Hangul folder. */
  readonly first: string
  /** A linked worktree of `first` that no own conversation uses (found through `git worktree list`). */
  readonly worktree: string
  /** A clone of the same root commit under a `#` folder. */
  readonly second: string
  /** A folder below `first` that does not exist (`폴더 없음`). */
  readonly missing: string
  /** A folder outside any repository: a project of its own. */
  readonly notGit: string
  /** The I2 repository (migrate.spec.ts): a project of its own. */
  readonly resume: string
}

/** Builds {@link Folders} below the harness's `base` (synchronous: the harness's project builder). */
function folders(base: string): Folders {
  const first = path.join(base, "작업", "installer")
  const second = path.join(base, "#Projects", "installer")
  const notGit = path.join(base, "메모")
  const resume = path.join(base, "작업", "이어가기")
  fs.mkdirSync(path.join(first, "src"), { recursive: true })
  fs.mkdirSync(path.dirname(second), { recursive: true })
  fs.mkdirSync(notGit, { recursive: true })
  fs.mkdirSync(resume, { recursive: true })
  fs.writeFileSync(path.join(first, "README.md"), "installer fixture\n")
  fs.writeFileSync(path.join(first, "src", "index.ts"), "export {}\n")
  fs.writeFileSync(path.join(notGit, "notes.md"), "메모\n")
  fs.writeFileSync(path.join(resume, "README.md"), "resume fixture\n")
  git(first, "init", "-q")
  git(first, "add", ".")
  git(first, "commit", "-q", "-m", "root")
  git(base, "clone", "-q", first, second)
  const worktree = path.join(first, ".worktrees", "perf")
  git(first, "worktree", "add", "-q", "-b", "perf", worktree)
  git(resume, "init", "-q")
  git(resume, "add", ".")
  git(resume, "commit", "-q", "-m", "root")
  return { first, worktree, second, missing: path.join(first, "removed-folder"), notGit, resume }
}

/** Git with a fixed identity, no signing and no hooks: no user configuration is read for the commit or changed. */
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=own-web import e2e",
      "-c",
      "user.email=e2e@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      "-c",
      `core.hooksPath=${path.join(cwd, ".no-hooks")}`,
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
}

async function projectOf(sessionID: string) {
  const info = (await team.server.call("GET", `/api/session/${sessionID}`)) as {
    readonly data?: { readonly projectID?: unknown }
  }
  const id = info.data?.projectID
  if (typeof id !== "string") throw new Error(`session ${sessionID} has no project: ${JSON.stringify(info)}`)
  return id
}

// ---------------------------------------------------------------------------------------------------------------
// The stores (see the file header)

async function writeStores(input: Folders) {
  const verbatim = `\\?\${input.first}`
  const fix = await codex(1, oneTurn(verbatim, 1, NOW - 3 * HOUR, "설치기를 고쳐 줘", "설치기를 고쳤습니다."))
  const zst = await codex(2, zstRecords(input.first, NOW - 5 * HOUR), { zst: true })
  const src = path.join(input.first, "src")
  await codex(3, oneTurn(src, 3, NOW - MINUTE, TITLES.live, "작업 중입니다."), { mtime: NOW + 12 * HOUR })
  await codex(4, oneTurn(input.worktree, 4, NOW - DAY, TITLES.worktree, "worktree에서 쟀습니다."))
  await codex(7, longRecords(input.first, NOW - 2 * DAY))
  await codex(
    8,
    rollout({ start: NOW - 3 * HOUR + MINUTE })
      .meta({ id: threadId(8), cwd: input.first, source: spawnSource(threadId(1)) })
      .user(TITLES.child)
      .assistant("로그를 정리했습니다.")
      .records(),
  )
  await codex(9, oneTurn(input.first, 9, NOW - 4 * DAY, TITLES.archived, "보관 전에 마쳤습니다."), { archived: true })
  await codex(
    10,
    rollout({ start: NOW - 6 * HOUR })
      .meta({ id: threadId(10), cwd: input.first, source: "exec" })
      .user(TITLES.exec)
      .assistant("자동 실행을 마쳤습니다.")
      .records(),
  )
  await codex(11, oneTurn(input.first, 11, NOW - 7 * HOUR, TITLES.extra, "더한 뿌리에서 읽었습니다."), {
    root: roots.extra,
  })
  // I2 (migrate.spec.ts): an hour or two old, so none is `진행 중일 수 있음`, and newer than every I1 conversation but
  // `지금 진행 중인 대화`, so I1's `모든 폴더` groups keep their order at the end of the list.
  const small = await codex(12, smallRecords(input.resume, NOW - 70 * MINUTE))
  const big = await codex(13, bigRecords(input.resume, NOW - 2 * HOUR))
  const remote = await codex(14, remoteRecords(input.resume, NOW - 80 * MINUTE))
  // The state DB names two threads of the I1 project, one whose rollout file is gone and the I2 ones (their model
  // shows as `원래: gpt-5.5`); the scan finds the others (09 §2.3).
  const gone = codexRollout(roots.codex, { id: threadId(5), at: NOW - 8 * HOUR })
  stateDb(roots.codex, {
    keepOpen: false,
    threads: [
      row(1, fix, input.first, TITLES.fix, NOW - 3 * HOUR),
      row(2, zst, input.first, TITLES.zst, NOW - 5 * HOUR),
      row(5, gone, input.first, TITLES.missing, NOW - 8 * HOUR),
      row(12, small, input.resume, RESUME.small, NOW - 70 * MINUTE),
      row(13, big, input.resume, RESUME.big, NOW - 2 * HOUR),
      row(14, remote, input.resume, RESUME.remote, NOW - 80 * MINUTE),
    ],
  })

  await claude(review(input.first))
  await claude(simple({ cwd: input.second, id: CLAUDE.old, start: NOW - 25.5 * DAY }, TITLES.old))
  await claude(simple({ cwd: input.missing, id: CLAUDE.gone, start: NOW - 3 * DAY }, TITLES.gone))
  await claude(simple({ cwd: input.notGit, id: CLAUDE.memo, start: NOW - DAY }, TITLES.memo))
  await claude(simple({ cwd: input.resume, id: CLAUDE.resume, start: NOW - 90 * MINUTE }, RESUME.claude))
}

/** `이어가기: 작은 대화`: two short turns with a shell call each; it fits every window. */
function smallRecords(cwd: string, start: number) {
  return rollout({ start })
    .meta({ id: threadId(12), cwd, branch: "main" })
    .turnContext({ model: "gpt-5.5", cwd, turnId: "small-0" })
    .user(RESUME.small)
    .assistant("테스트를 먼저 돌려 보겠습니다.", "commentary")
    .call("shell", { command: ["bun", "test"] }, "call_small_0")
    .output("call_small_0", "3 pass")
    .assistant("테스트가 통과했습니다.")
    .user("커밋 상태도 봐 줘")
    .call("shell", { command: ["git", "status"] }, "call_small_1")
    .output("call_small_1", "nothing to commit")
    .assistant("커밋할 것이 없습니다.")
    .records()
}

/**
 * `이어가기: 큰 대화`: {@link RESUME_TURNS}.big turns, each with a tool output of {@link BIG_OUTPUT} characters (about
 * 260k tokens in all): more than GPT-5.6 Cyber's 231,200 ceiling (09 §4.3 `does_not_fit`), little for a 1M one.
 */
function bigRecords(cwd: string, start: number) {
  const builder = rollout({ start })
    .meta({ id: threadId(13), cwd, branch: "main" })
    .turnContext({ model: "gpt-5.5", cwd, turnId: "big-0" })
  Array.from({ length: RESUME_TURNS.big }, (_, index) => index).forEach((index) =>
    builder
      .user(index === 0 ? RESUME.big : `측정 ${index}번을 돌려 줘`)
      .call("shell", { command: ["bun", "run", "bench", `--case=${index}`] }, `call_big_${index}`)
      .output(`call_big_${index}`, filler(index))
      .assistant(`측정 ${index}번을 마쳤습니다.`),
  )
  return builder.records()
}

/** ASCII output of `size` characters, different for every `seed`. */
function filler(seed: number, size = BIG_OUTPUT) {
  return `bench ${seed}: ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(size / 27))}`.slice(0, size)
}

/**
 * `이어가기: 원격 압축 대화`: Codex compacted remotely after {@link RESUME_TURNS}.remoteBefore turns of large tool output
 * (its summary is encrypted, 09 §4.1), then two short turns, {@link REMOTE_OUTPUT} characters each before it (about 275k
 * tokens). For a window it does not fit (GPT-5.6 Cyber), `그대로 이어가기`
 * fills across the boundary and puts the rest in a checkpoint without an LLM call (09 §4.3 `codex-remote`).
 */
function remoteRecords(cwd: string, start: number) {
  const before = Array.from({ length: RESUME_TURNS.remoteBefore }, (_, index) =>
    index === 0 ? RESUME.remote : `원격 압축 전 요청 ${index}`,
  )
  const builder = rollout({ start })
    .meta({ id: threadId(14), cwd, branch: "main" })
    .turnContext({ model: "gpt-5.5", cwd, turnId: "remote-0" })
  before.forEach((prompt, index) =>
    builder
      .user(prompt)
      .call("shell", { command: ["bun", "test", `--shard=${index}`] }, `call_remote_${index}`)
      .output(`call_remote_${index}`, filler(100 + index, REMOTE_OUTPUT))
      .assistant(`요청 ${index}을 마쳤습니다.`),
  )
  builder.compacted("", [...before.map((prompt) => userItem(prompt)), compactionItem()])
  Array.from({ length: RESUME_TURNS.remote - RESUME_TURNS.remoteBefore }, (_, index) => index).forEach((index) =>
    builder.user(`원격 압축 뒤 요청 ${index}`).assistant(`원격 압축 뒤 답 ${index}`),
  )
  return builder.records()
}

/**
 * Writes Codex thread `n` where Codex keeps it (the date folder of its first record); its mtime is its last record's
 * time unless `mtime` says otherwise.
 */
function codex(
  n: number,
  records: ReadonlyArray<{ readonly timestamp?: string }>,
  options: {
    readonly zst?: boolean
    readonly archived?: boolean
    readonly mtime?: number
    readonly root?: string
  } = {},
) {
  const at = Date.parse(records[0]?.timestamp ?? "")
  const last = Date.parse(records.at(-1)?.timestamp ?? "")
  return writeJsonl(
    codexRollout(options.root ?? roots.codex, { id: threadId(n), at, zst: options.zst, archived: options.archived }),
    records,
    { mtime: new Date(options.mtime ?? last) },
  )
}

function row(n: number, file: string, cwd: string, title: string, at: number) {
  return {
    id: threadId(n),
    rollout_path: file,
    cwd,
    title,
    model: "gpt-5.5",
    created_at_ms: at - HOUR,
    updated_at_ms: at,
  }
}

/** One turn from `start`: the prompt (with {@link MARK}), a shell call and its output, the answer. */
function oneTurn(cwd: string, n: number, start: number, prompt: string, answer: string) {
  const turn = `turn-${n}-0`
  return rollout({ start })
    .meta({ id: threadId(n), cwd, branch: "main" })
    .turnContext({ model: "gpt-5.5", cwd, turnId: turn })
    .user(`${prompt} ${MARK}`)
    .assistant("확인해 보겠습니다.", "commentary")
    .call("shell", { command: ["bun", "test"] }, `call_${n}_0`)
    .output(`call_${n}_0`, `${n} pass`)
    .assistant(answer)
    .records()
}

/**
 * The `.zst` conversation: 21 turns; Codex compacted remotely inside turn 2 (after its tool output, before the answer
 * that continues it); `북극곰` only in turn 16's tool output; the last turn holds six tool outputs of hashes (about
 * 2.4 MB that zstd hardly shrinks, so the file is read in many chunks), so the outline keeps streaming after the
 * first page (20 turns) was answered (09 §2.8).
 */
function zstRecords(cwd: string, start: number) {
  const builder = rollout({ start })
    .meta({ id: threadId(2), cwd, branch: "main" })
    .turnContext({ model: "gpt-5.5", cwd, turnId: "zst-0" })
    .user(`zst 대화: 설치기 성능을 재 줘 ${MARK}`)
    .assistant("설치 단계를 하나씩 재 보겠습니다.", "commentary")
    .call("shell", { command: ["bun", "run", "bench"] }, "call_zst_0")
    .output("call_zst_0", "설치 12.4 s")
    .assistant("설치에 12.4초가 걸립니다.")
    .user("느린 단계를 찾아 줘")
    .call("shell", { command: ["bun", "run", "bench", "--steps"] }, "call_zst_1")
    .output("call_zst_1", "압축 해제 9.1 s")
    .compacted("", [
      userItem(`zst 대화: 설치기 성능을 재 줘 ${MARK}`),
      userItem("느린 단계를 찾아 줘"),
      compactionItem(),
    ])
    .assistant("압축 뒤에 이어서: 압축 해제가 가장 느립니다.")
  Array.from({ length: 18 }, (_, index) => index + 2).forEach((step) =>
    builder
      .user(`설치 단계 ${step}을 재 줘`)
      .assistant(`단계 ${step}을 재겠습니다.`, "commentary")
      .call("shell", { command: ["bun", "run", "bench", `--step=${step}`] }, `call_zst_${step}`)
      .output(`call_zst_${step}`, step === 15 ? "단계 15: 북극곰 캐시 2.1 s" : `단계 ${step}: ${step / 10} s`)
      .assistant(`단계 ${step} 측정을 마쳤습니다.\n다음 단계로 넘어갑니다.`),
  )
  builder.user("마지막: 전체 설치 로그를 읽어 줘")
  Array.from({ length: 6 }, (_, index) => index).forEach((part) =>
    builder
      .custom("read_log", `part ${part}`, `call_zst_log_${part}`)
      .customOutput(`call_zst_log_${part}`, noise(part)),
  )
  return builder.assistant("로그를 다 읽었습니다.").records()
}

/** About 400 KB of sha256 hex lines, different for every `part`. */
function noise(part: number) {
  return Array.from({ length: 6_000 }, (_, index) =>
    createHash("sha256").update(`${part}:${index}`).digest("hex"),
  ).join("\n")
}

/** 130 turns that all mention `체크리스트`: a content search over the folder answers in more than one part. */
function longRecords(cwd: string, start: number) {
  const builder = rollout({ start }).meta({ id: threadId(7), cwd, branch: "main" })
  Array.from({ length: 130 }, (_, index) => index + 1).forEach((item) =>
    builder
      .user(`배포 체크리스트 ${item}번 항목을 확인해 줘${item === 1 ? ` ${MARK}` : ""}`)
      .assistant(`${item}번 항목을 확인했습니다.`),
  )
  return builder.records()
}

/**
 * `Claude 설치기 리뷰`: Claude Code compacted automatically right after a tool result (mid-turn, 09 §2.6), kept the
 * call and its result (`preservedSegment`) and wrote its summary with the harness wording own-import strips.
 */
function review(cwd: string) {
  const input: SessionInput = {
    cwd,
    id: CLAUDE.review,
    version: CLAUDE_VERSION,
    branch: "main",
    start: NOW - 2 * DAY - HOUR,
  }
  const built = session(input)
  built.user(`설치기 리팩터링을 해 줘 ${MARK}`)
  built.assistant([text("리팩터링을 시작합니다.")], { id: "msg_FAKE_UI01" })
  built.user("문서도 고쳐 줘")
  built.assistant([toolUse("toolu_FAKE_UI01", "Bash", { command: "bun test" })], { id: "msg_FAKE_UI02" })
  const head = built.last ?? ""
  const tail = built.result("toolu_FAKE_UI01", "2 pass", { toolUseResult: { stdout: "2 pass", stderr: "" } })
  built.boundary({ logicalParent: tail, preserved: { head, tail } })
  built.summary(harnessSummary(SUMMARY_BODY, `C:\\Users\\fixture\\.claude\\projects\\fixture\\${CLAUDE.review}.jsonl`))
  built.assistant([text("압축 뒤에 이어서 문서를 고칩니다.")], { id: "msg_FAKE_UI03" })
  built.user("고마워")
  built.assistant([text("천만에요.")], { id: "msg_FAKE_UI04" })
  built.meta({ type: "custom-title", customTitle: TITLES.review })
  return { input, built }
}

/** A short Claude Code conversation titled `title`. */
function simple(base: { readonly cwd: string; readonly id: string; readonly start: number }, title: string) {
  const input: SessionInput = { ...base, version: CLAUDE_VERSION, branch: "main" }
  const built = session(input)
  built.user(`${title}: 요약해 줘 ${MARK}`)
  built.assistant([text(`${title}을 요약했습니다.`)], { id: `msg_FAKE_${base.id.slice(-4)}` })
  built.meta({ type: "custom-title", customTitle: title })
  return { input, built }
}

/** Writes a Claude Code conversation; its mtime is its last record's time. */
function claude(conversation: { readonly input: SessionInput; readonly built: ReturnType<typeof session> }) {
  const stamps = conversation.built
    .records()
    .flatMap((record) => (typeof record.timestamp === "string" ? [Date.parse(record.timestamp)] : []))
  return write(roots.claude, conversation.input, conversation.built, { mtime: new Date(Math.max(...stamps)) })
}

// ---------------------------------------------------------------------------------------------------------------
// The fakes' summary and the inspect server (see the file header)

/** Core's compaction request gets {@link SUMMARY} after the set delay; anything else goes to the directive responder. */
function summaryReply(request: RecordedRequest): Reply | undefined {
  if (!request.body.includes(SUMMARY_PROMPT)) return undefined
  return { type: "text", text: SUMMARY, ...(control.summaryDelay > 0 ? { delayMs: control.summaryDelay } : {}) }
}

function startInspect() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // `POST /turn` waits for a whole turn.
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/requests") return Response.json(modelRequests())
      if (request.method === "POST" && url.pathname === "/summary") {
        const delay = Number(url.searchParams.get("delay") ?? "0")
        control.summaryDelay = Number.isFinite(delay) && delay > 0 ? delay : 0
        return Response.json(control)
      }
      if (request.method === "POST" && url.pathname === "/turn") {
        await team.turn(seeded.sessions.resume, "알림 확인")
        return Response.json({ sessionID: seeded.sessions.resume })
      }
      if (request.method === "GET" && url.pathname === "/sessions") return Response.json(await importSessions())
      if (request.method === "GET" && url.pathname === "/usage-polls") return Response.json(usagePolls())
      return new Response("not found", { status: 404 })
    },
  })
}

/** The own accounts whose usage the backend's poller read from the fake (`wham/usage`), in order. */
function usagePolls() {
  const ids = ["01", "02", "03"] as const
  return fakes.codex.usagePolls.flatMap((polled) =>
    ids.filter((id) => CHATGPT[id].accountID === polled).map((id) => ACCOUNT[id]),
  )
}

/** Every fake's model requests so far, oldest first: not a token refresh, a handshake or a usage poll. */
function modelRequests() {
  const listed = (requests: ReadonlyArray<RecordedRequest>) =>
    requests
      .filter((request) => request.model !== undefined && requestItems(request).length > 0)
      .map((request) => ({
        identity: request.identity ?? null,
        model: request.model ?? null,
        compaction: request.body.includes(SUMMARY_PROMPT),
      }))
  return {
    codex: listed(fakes.codex.requests),
    deepseek: listed(fakes.deepseek.requests),
    anthropic: listed(fakes.anthropic.requests),
  }
}

const decodeRoots = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.optional(Schema.String),
        metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  }),
)

/** The root sessions own.import made (archived ones too), split into imported ones and helpers, and its jobs. */
async function importSessions() {
  const listed = Option.getOrUndefined(
    decodeRoots(await team.server.call("GET", "/api/session", { query: { parentID: "null", limit: "500" } })),
  )
  const marked = (listed?.data ?? []).flatMap((item) => {
    const meta = OwnImport.decodeMetadata(item.metadata)
    return meta === undefined ? [] : [{ id: item.id, title: item.title ?? "", meta }]
  })
  const jobs = await team.rpc(OwnImport.ID, "jobs.list")
  return {
    imported: marked.flatMap((item) =>
      OwnImport.isHelper(item.meta)
        ? []
        : [
            {
              id: item.id,
              title: item.title,
              sourceID: item.meta.sourceID,
              mode: item.meta.mode,
              checkpoint: item.meta.checkpoint,
              turns: item.meta.turns,
              storedFull: item.meta.storedFull,
            },
          ],
    ),
    helpers: marked.flatMap((item) => (OwnImport.isHelper(item.meta) ? [{ id: item.id, title: item.title }] : [])),
    jobs: jobs.output,
  }
}

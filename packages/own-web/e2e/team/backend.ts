// Team screens e2e backend (06 §11.2 own-web e2e, TG20). Run by this suite's Playwright webServer
// (playwright.config.ts) or by hand: `bun e2e/team/backend.ts`.
//
// The real upstream server from source with own-accounts, own-team and own-computer-use (driver "fake": an in-memory
// desktop, never this PC's), booted by own-team's e2e harness (packages/own-team/test/e2e/harness.ts, imported
// read-only). Every model call goes to the harness's local fakes (one fake Codex backend with ChatGPT 01, 02 and 03,
// a fake DeepSeek and a fake Anthropic, both metered API keys), answered by own-team's directive responder
// (packages/own-team/test/e2e/directives.ts, read-only), with two additions in front of it:
//   - the judge's answer (06 §3.4): two new areas from `main`, `web` (화면) and `api` (서버), with the large-file
//     folder `media` left out of their folders, so `큰 파일 폴더 가져오기…` has something to fetch;
//   - `[computer-shot]`: a Code Mode screenshot of the fake desktop and a pointer move on it, so the conversation that
//     sent it holds the desktop lease for a while (the team view's `데스크톱 사용 중`).
// The project is own-team's F1 code repository plus `media/` (four 256 KB binary files). Seeds: two conversations in
// the project's folder on ChatGPT 01 (`웹 작업`, where team mode is turned on, and `예전 대화`, an older one that gets
// the main folder's one-time banner), and two presets of the DeepSeek group for `프리셋 바꾸기…`: `DeepSeek 기본`, and
// `ChatGPT 02 리뷰`, whose review role is pinned to ChatGPT 02, which a team on ChatGPT 01 cannot use (R4, 06 §10.1).
//
// The T2 specs (t2-*.spec.ts) each turn team mode on in a project of their own next to it, with a conversation on
// ChatGPT 01 in its main folder, and the judge answers by the main folder its request names:
//   - `shop` (t2-adopt): three work folders under `.worktrees` with a conversation each: `cl-perf` on ChatGPT 02 (the
//     team's R4 line), `cl-review` on DeepSeek with the preset `검토 묶음`, both adopted, and `cl-x` on Anthropic with
//     four changes not in a save point, left out (`팀에 넣지 않은 작업 폴더`);
//   - `calc` (t2-integrate): one new area `ui` (`입력 정리`) from `main`, and `bun run check` (a script that waits four
//     seconds, so a check is seen running) as the team's check command;
//   - `memo` (t2-settings): no area; 새 영역 makes one.
// Their conversations are made before F1's, so F1's project stays the newest one in the list team.spec.ts reads.
//
// The T3 specs (t3-*.spec.ts) have projects of their own too:
//   - `atelier` (t3-reorg): the judge makes four areas from `main` (`화면` ui, `서버` api, `문서` docs, `실험` lab) with
//     the large-file folder `media` left out, proposes the ignored folder `data` as a shared folder (its read-only
//     confirm, 4.11) and `bun run check` as the asset check command (4.10). A second judge call (팀 구성 다시 보기, 8.1)
//     renames `ui` to `화면 손질`, retires `docs` and suggests finishing `api`. Its conversations: `아틀리에 작업`, where
//     team mode is turned on, and `예전 메모`, which 대화 옮기기 moves;
//   - `relay` (t3-remote): no area; `원격 작업` on ChatGPT 01 and `원격 프리셋` on DeepSeek, opened through the fake
//     SSH hosts below;
//   - `bios-mod` (t3-gitinit): not a Git repository (Git 저장소로 만들기, 06 §3.0): code, a `node_modules` folder the
//     proposed .gitignore leaves out and a 1.5 MB binary image the first commit leaves out unless picked;
//     `바이오스 작업` on ChatGPT 01;
//   - `rom-notes` (t3-gitinit, from the conversation `⋯`): another plain folder of two text files; `롬 메모` on
//     ChatGPT 01;
//   - `quest` (t3-areas, 2026-10-26): a small game repository the judge makes no area for; the user sets the areas up
//     by hand (영역 만들기) and the main merges two of them after the user's yes; `게임 작업` on ChatGPT 01;
//   - `depot` (t3-seat, 2026-11-12): one new area `stock` (`재고 화면`) from `main`; `창고 작업` on ChatGPT 01. The
//     spec opens the conversations the area's seat moves onto in the area's folder itself.
//
// Fake SSH hosts for a remote own.team (04 §12.1, 06 §4.13), both on the device stand-in's port: `/srv/<host>/api/*`
// is relayed to this one server (a remote service of the same build), so the host's own.team is the real one, except
// that `enable` answers `lfs_missing` until `hosts.tools.ensure` put the large-file tool on that host. `h-e2ehost` is a
// current host: the upload succeeds and its own.accounts lists the presets as its mirror of this PC's. `h-e2eold` is an
// older one: the upload fails (`tool_hash_mismatch`) and its `presets.list` has no stored preset (no mirror yet). The
// PC page reaches them through a fake own.remote at `/own-e2e/remote/<method>` (`hosts.list`, `resolve`, `catalog.get`,
// `heartbeat`, `hosts.tools.ensure`); t3-remote.spec.ts routes the page's own.remote calls there, so the other specs
// never see a host. `GET /own-e2e/calls` lists what reached the hosts and the fake own.remote.
//
// own-web is served twice from one Vite dev server (no HMR, so edits elsewhere never reload a page under a test):
//   - the PC page: `http://127.0.0.1:<port>`, `/api` proxied to the server with server-side Basic auth (03 §16.2);
//   - a device page: `http://127.0.0.1:<port + 1>`, a stand-in for the own-remote gateway's device surface (05 §13.4):
//     the page with `<meta name="own-gateway">` (own-web picks its mobile host from it), `GET /own/device` naming a
//     paired phone with the `read`, `prompt` and `switch` scopes (never `local`) and the service PC's name (`pc`), and
//     `/srv/local/api/*` relayed to the server (and the fake hosts' `/srv/<host>/api/*`, above). It checks no device
//     credential: it exists only for the view-only notices of gateway devices (06 §9.8) and the fake hosts.
// Fake credentials only; every listener binds 127.0.0.1; the temp root is removed on exit (and leftovers of an
// earlier run that Playwright killed are removed at start). Run from a path without '#'.
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { proposal, responder, turn } from "../../../own-team/test/e2e/directives"
import { MODEL, startTeamFakes, startTeamServer } from "../../../own-team/test/e2e/harness"
import { commit, f1, git, init, write } from "../../../own-team/test/fixtures/repo"

export const TEAM_PORT = Number(process.env.OWN_WEB_TEAM_E2E_PORT ?? 5761)
export const DEVICE_PORT = TEAM_PORT + 1
/** The service PC's name the device stand-in reports, as the gateway does with `os.hostname()` (06 §9.8). */
const SERVICE_PC = "E2E-작업PC"
export const TEAM_TMP = process.env.OWN_WEB_TEAM_E2E_TMP ?? path.join(os.tmpdir(), "own-web-team")
export const STATE_FILE = path.join(TEAM_TMP, "backend.json")

/** The harness names its temp root `own-team-e2e-<name>-…` under the OS temp folder (this suite's TEMP). */
const NAME = "web-team"
/** The fixed instructions of the judge call (own-team `judge/prompt.ts`). */
const JUDGE = "너는 팀 모드의 판단을 맡는다"
const AREAS = [
  { slug: "web", name: "화면", goal: "화면 다듬기" },
  { slug: "api", name: "서버", goal: "서버 정리" },
] as const
const HEAVY = "media"
/** The T2 specs' projects (see the file header), by their main folder's name. */
const T2 = { adopt: "shop", integrate: "calc", settings: "memo" } as const
/** The work folders of `shop`: adopted by the judge, and the one it leaves out. */
const ADOPTED = [
  { slug: "cl-perf", name: "성능 조정", goal: "장바구니 속도" },
  { slug: "cl-review", name: "결제 검토", goal: "결제 흐름 검토" },
] as const
const LEFT = "cl-x"
/** `calc`'s area, and its check command: a script that waits, so a running check shows on the card. */
const CALC_AREA = { slug: "ui", name: "입력 정리", goal: "입력 화면 정리" } as const
const CHECK = "bun run check"
const SHOT = "[computer-shot]"
/** A screenshot, then a pointer move on it: looking needs no lease, moving takes the desktop lease (own-computer-use). */
const DRIVE = "await tools.computer.screenshot({}); return await tools.computer.mouse_move({ coordinate: [120, 80] })"
/** The T3 specs' projects (see the file header), by their main folder's name. */
const T3 = {
  reorg: "atelier",
  remote: "relay",
  gitInit: "bios-mod",
  gitMenu: "rom-notes",
  areas: "quest",
  seat: "depot",
} as const
/** `depot`'s area, whose owner seat t3-seat moves. */
const DEPOT_AREA = { slug: "stock", name: "재고 화면", goal: "재고 화면 다듬기" } as const
const ATELIER = [
  { slug: "ui", name: "화면", goal: "화면 다듬기" },
  { slug: "api", name: "서버", goal: "서버 정리" },
  { slug: "docs", name: "문서", goal: "문서 정리" },
  { slug: "lab", name: "실험", goal: "실험 정리" },
] as const
/** `atelier`'s ignored folder the judge proposes to share (4.11). */
const SHARED = "data"
/** `atelier`'s asset check command (4.10), from the program's candidate list (V10: `package.json` + `bun.lock`). */
const ASSETS = "bun run check"
/** The reorganization judge call (own-team judge/prompt.ts `reorganize`). */
const REORG = "팀 구성을 어떻게 바꿀지"
/** The fake SSH hosts (see the file header); host ids follow own-remote's `h-<6–8 characters>`. */
const HOSTS = {
  "h-e2ehost": { name: "e2e 원격", mirror: true, upload: true },
  "h-e2eold": { name: "e2e 옛 원격", mirror: false, upload: false },
} as const
type HostID = keyof typeof HOSTS
/** The session token the fake own.remote's `resolve` gives (own-web sends it as Basic auth to the host). */
const HOST_TOKEN = "e2e-host-token-0001"
/** The release's pinned git-lfs version a successful upload reports. */
const LFS_VERSION = "3.8.0"

// Playwright may end this process without the graceful stop on Windows: remove what an earlier run left behind.
for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []))
  if (entry.isDirectory() && entry.name.startsWith(`own-team-e2e-${NAME}-`))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)

/** What reached the fake own.remote and the fake hosts (`GET /own-e2e/calls`). */
const calls = {
  /** `hosts.tools.ensure`, by host, in order. */
  ensure: new Array<string>(),
  /** RPC calls that reached a host: `<host> <rpc id>/<method>`, in order. */
  hosts: new Array<string>(),
}
/** Hosts the large-file tool was uploaded to. */
const tooled = new Set<HostID>()

/** Call ids of the screenshots this backend asked for: a follow-up holding only that result ends the turn. */
const shots = new Set<string>()
const fakes = startTeamFakes({
  responder: responder({
    before: (request) => {
      const current = turn(request)
      if (request.body.includes(JUDGE))
        return { type: "text", text: JSON.stringify(judgedFor(current.user, request.body.includes(REORG))) }
      // The answer after the screenshot takes 15 s: the run, and with it the desktop lease, lasts until it ends
      // (computer-use CUU-1 releases the lease when a run ends), so TG20 can see who holds the desktop.
      if (current.call !== undefined && shots.has(current.call))
        return { type: "text", text: "화면을 확인했습니다.", delayMs: 15_000 }
      if (current.done > 0) return undefined
      if (!current.user.includes(SHOT)) return undefined
      const id = `call_shot_${shots.size + 1}`
      shots.add(id)
      return { type: "tool-call", id, name: "execute", input: { code: DRIVE } }
    },
  }),
})

/** The T2 and T3 projects' folders, built with F1 in the server's temp root. */
const folders = { shop: "", calc: "", memo: "", atelier: "", relay: "", plain: "", notes: "", quest: "", depot: "" }
const team = await startTeamServer({
  name: NAME,
  fakes,
  computerUse: true,
  project: (base) => {
    const home = f1(base).home
    write(
      home,
      Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [`${HEAVY}/clip-${index + 1}.bin`, crypto.randomBytes(256 * 1024)]),
      ),
    )
    commit(home, "media")
    folders.shop = shop(base)
    folders.calc = calc(base)
    folders.memo = memo(base)
    folders.atelier = atelier(base)
    folders.relay = relay(base)
    folders.plain = plain(base)
    folders.notes = notes(base)
    folders.quest = quest(base)
    folders.depot = depot(base)
    return home
  },
})
const project = team.project!
const worktree = (name: string) => path.join(folders.shop, ".worktrees", name)

async function accounts(method: string, input: unknown, directory?: string) {
  const result = await team.rpc("own.accounts", method, input, directory)
  if (result.status !== 200)
    throw new Error(`own.accounts ${method}: ${result.status} ${result.type} ${result.message}`)
  return result.output as Record<string, unknown>
}

// The T2 projects' conversations first (see the file header).
const t2 = {
  adopt: {
    home: folders.shop,
    seed: await team.createSession({ title: "가게 작업", model: MODEL["01"], directory: folders.shop }),
    folders: { perf: worktree("cl-perf"), review: worktree("cl-review"), left: worktree(LEFT) },
    sessions: {
      perf: await team.createSession({ title: "성능 대화", model: MODEL["02"], directory: worktree("cl-perf") }),
      review: await team.createSession({ title: "검토 대화", model: MODEL.deepseek, directory: worktree("cl-review") }),
      left: await team.createSession({ title: "실험 대화", model: MODEL.anthropic, directory: worktree(LEFT) }),
    },
  },
  integrate: {
    home: folders.calc,
    seed: await team.createSession({ title: "계산 작업", model: MODEL["01"], directory: folders.calc }),
  },
  settings: {
    home: folders.memo,
    seed: await team.createSession({ title: "메모 작업", model: MODEL["01"], directory: folders.memo }),
  },
}
// The T3 projects' conversations, also before F1's.
const t3 = {
  reorg: {
    home: folders.atelier,
    seed: await team.createSession({ title: "아틀리에 작업", model: MODEL["01"], directory: folders.atelier }),
    older: await team.createSession({ title: "예전 메모", model: MODEL["01"], directory: folders.atelier }),
    areas: ATELIER,
    heavy: HEAVY,
    shared: SHARED,
  },
  remote: {
    home: folders.relay,
    seed: await team.createSession({ title: "원격 작업", model: MODEL["01"], directory: folders.relay }),
    presets: await team.createSession({ title: "원격 프리셋", model: MODEL.deepseek, directory: folders.relay }),
    hosts: Object.fromEntries(Object.entries(HOSTS).map(([id, host]) => [id, host.name])),
    lfs: LFS_VERSION,
  },
  gitInit: {
    home: folders.plain,
    seed: await team.createSession({ title: "바이오스 작업", model: MODEL["01"], directory: folders.plain }),
  },
  gitMenu: {
    home: folders.notes,
    seed: await team.createSession({ title: "롬 메모", model: MODEL["01"], directory: folders.notes }),
  },
  areas: {
    home: folders.quest,
    seed: await team.createSession({ title: "게임 작업", model: MODEL["01"], directory: folders.quest }),
  },
  seat: {
    home: folders.depot,
    seed: await team.createSession({ title: "창고 작업", model: MODEL["01"], directory: folders.depot }),
    area: DEPOT_AREA.name,
  },
}
await accounts(
  "session.preset.apply",
  {
    sessionID: t2.adopt.sessions.review,
    presetID: await savePreset({
      name: "검토 묶음",
      group: "ds",
      workers: { mode: "same", roles: {} },
      delegation: "on-request",
    }),
  },
  t2.adopt.folders.review,
)

const seed = await team.createSession({ title: "웹 작업", model: MODEL["01"], directory: project })
const older = await team.createSession({ title: "예전 대화", model: MODEL["01"], directory: project })
const presets = {
  deepseek: await savePreset({
    name: "DeepSeek 기본",
    group: "ds",
    workers: { mode: "same", roles: {} },
    delegation: "on-request",
  }),
  clash: await savePreset({
    name: "ChatGPT 02 리뷰",
    group: "ds",
    workers: {
      mode: "by-role",
      roles: {
        "own-review": { targets: [{ pin: { account: "acc_tm02", model: MODEL["02"].id } }], effort: "inherit" },
      },
    },
    delegation: "on-request",
  }),
}

// RH-51: the first page asks own.accounts about every listed conversation at its folder, so on a fresh backend it
// booted all those Locations at once (every plugin each): run alone under load that took a minute and more
// (`session.binding` 10–59 s, `/api/model` 41 s or a 503), past the specs' first waits (team.spec's transcript in 60 s,
// t3-gitinit's dialog in 30 s). They are booted here, a few at a time, before the port answers.
const locations = [...new Set([project, ...Object.values(folders), ...Object.values(t2.adopt.folders)])]
for (let index = 0; index < locations.length; index += 3)
  await Promise.all(
    locations.slice(index, index + 3).map(async (directory) => {
      const result = await team.rpc("own.accounts", "health", {}, directory)
      if (result.status !== 200) throw new Error(`own.accounts health at ${directory}: ${result.status} ${result.type}`)
    }),
  )

const password = atob(team.server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: team.server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: team.control,
})
const dev = await startViteDev({ port: TEAM_PORT, hmr: false })
const device = startDevice()

const state = {
  dev: `http://127.0.0.1:${TEAM_PORT}`,
  device: `http://127.0.0.1:${DEVICE_PORT}`,
  pc: SERVICE_PC,
  control: team.control,
  project,
  seed,
  older,
  heavy: HEAVY,
  areas: AREAS,
  accounts: { "01": "acc_tm01", "02": "acc_tm02", "03": "acc_tm03", deepseek: "acc_tmds", anthropic: "acc_tman" },
  models: MODEL,
  presets,
  t2,
  t3,
}
await fs.mkdir(TEAM_TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_TEAM_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await device.stop(true)
  await dev.close().catch(() => undefined)
  await team.stop()
  await fakes.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

// ---------------------------------------------------------------------------------------------------------------

/**
 * The judge's answer for the project whose main folder the request names (`메인 폴더: <dir>`, own-team judge/prompt.ts);
 * `reorganize`: the call of 팀 구성 다시 보기 (8.1).
 */
function judgedFor(prompt: string, reorganize: boolean) {
  const home = /^메인 폴더: (.+)$/m.exec(prompt)?.[1]?.trim() ?? ""
  const name = home.replaceAll("\\", "/").split("/").at(-1)
  if (name === T3.reorg) return reorganize ? reviewed() : atelierAreas()
  if (name === T3.remote || name === T3.areas) return proposal(0)
  if (name === T2.adopt)
    return {
      version: 1,
      areas: ADOPTED.map((area) => ({
        ...area,
        shape: "code",
        adopt: { worktree: worktree(area.slug), branch: area.slug },
        create: null,
      })),
      notes: "지금 있는 작업 폴더 두 개를 받아들입니다.",
    }
  if (name === T2.settings) return proposal(0)
  if (name === T3.seat) {
    const one = proposal(1, [DEPOT_AREA.slug])
    return { ...one, areas: one.areas.map((area) => ({ ...area, name: DEPOT_AREA.name, goal: DEPOT_AREA.goal })) }
  }
  if (name !== T2.integrate) return judged()
  const base = proposal(1, [CALC_AREA.slug])
  return {
    ...base,
    commands: { code: [CHECK] },
    areas: base.areas.map((area) => ({ ...area, name: CALC_AREA.name, goal: CALC_AREA.goal })),
  }
}

/** The judge's answer: the two areas of {@link AREAS}, made from `main`, without {@link HEAVY} in their folders. */
function judged() {
  const base = proposal(
    AREAS.length,
    AREAS.map((area) => area.slug),
  )
  return {
    ...base,
    heavy: [{ dir: HEAVY, why: "e2e 큰 파일 폴더" }],
    areas: base.areas.map((area, index) => ({ ...area, name: AREAS[index]!.name, goal: AREAS[index]!.goal })),
  }
}

/**
 * `atelier`'s areas (t3-reorg): {@link ATELIER} from `main`, light folders without {@link HEAVY}; the ignored {@link SHARED}
 * as a shared folder and {@link ASSETS} as the asset check command.
 */
function atelierAreas() {
  return {
    version: 1,
    heavy: [{ dir: HEAVY, why: "e2e 큰 파일 폴더" }],
    shared: [{ dir: SHARED, why: "e2e 공유 데이터" }],
    commands: { assets: [ASSETS] },
    areas: ATELIER.map((area) => ({ ...area, shape: "code", adopt: null, create: { from: "main" } })),
    notes: `영역 ${ATELIER.length}개를 만듭니다.`,
  }
}

/**
 * 팀 구성 다시 보기 on `atelier` (8.1): rename `ui`, retire `docs` (Main 멈춤 in the spec, so it is skipped) and suggest
 * finishing `api` (its work is in the project's main code by then, V13).
 */
function reviewed() {
  return {
    version: 1,
    ops: [
      { op: "rename", area: "ui", name: "화면 손질", why: "화면 손질만 남음" },
      { op: "retire", area: "docs", why: "문서 정리 끝남" },
    ],
    suggest: [{ kind: "retire", area: "api", why: "반영 끝남" }],
    notes: "화면 영역의 이름을 바꾸고 끝난 영역을 정리해요.",
  }
}

/**
 * `atelier` (t3-reorg): a `check` script run by Bun, `media/` (two 512 KB binary files) as the large-file folder, and
 * the ignored `data/` (not in the repository) that the judge proposes to share.
 */
function atelier(base: string) {
  const home = init(path.join(base, T3.reorg))
  write(home, {
    ".gitignore": "node_modules/\ndist/\ndata/\n",
    "README.md": "# atelier\n",
    "package.json": `${JSON.stringify({ name: "atelier", private: true, scripts: { check: "bun check.ts" } }, null, 2)}\n`,
    "bun.lock": "{}\n",
    "check.ts": "console.log('ok')\n",
    "src/ui.ts": "export const ui = 1\n",
    "src/api.ts": "export const api = 1\n",
    "docs/guide.md": "# guide\n",
    "lab/notes.md": "# notes\n",
    ...Object.fromEntries(
      Array.from({ length: 2 }, (_, index) => [`${HEAVY}/take-${index + 1}.bin`, crypto.randomBytes(512 * 1024)]),
    ),
  })
  commit(home, "atelier")
  write(home, { [`${SHARED}/sample.csv`]: "id,value\n1,2\n" })
  return home
}

/** `bios-mod` (t3-gitinit): a folder that is not a Git repository (06 §3.0). */
function plain(base: string) {
  const home = path.join(base, T3.gitInit)
  write(home, {
    "README.md": "# bios-mod\n",
    "src/patch.c": "int patch(void) { return 0; }\n",
    "node_modules/left-pad/index.js": "module.exports = 1\n",
    // A NUL-filled image: binary by git's test, over the 1 MB line (flagged, left out unless picked).
    "bios/BOARD.CAP": Buffer.alloc(1536 * 1024, 0),
  })
  return home
}

/** `rom-notes` (t3-gitinit, the conversation `⋯`): another folder that is not a Git repository. */
function notes(base: string) {
  const home = path.join(base, T3.gitMenu)
  write(home, { "README.md": "# rom-notes\n", "notes/fan-curve.txt": "50C 30%\n70C 60%\n" })
  return home
}

/** `quest` (t3-areas): a small game repository (monsters, items and a simulation). */
function quest(base: string) {
  const home = init(path.join(base, T3.areas))
  write(home, {
    "README.md": "# quest\n",
    "package.json": '{ "name": "quest" }\n',
    "src/monsters.ts": "export const monsters = [] as string[]\n",
    "src/items.ts": "export const items = [] as string[]\n",
    "sim/run.ts": "export const seed = 7\n",
  })
  commit(home, "quest")
  return home
}

/** `depot` (t3-seat): a small stock-keeping repository. */
function depot(base: string) {
  const home = init(path.join(base, T3.seat))
  write(home, {
    "README.md": "# depot\n",
    "package.json": '{ "name": "depot" }\n',
    "src/stock.ts": "export const stock = [] as string[]\n",
  })
  commit(home, "depot")
  return home
}

/** `relay` (t3-remote): a small code repository. */
function relay(base: string) {
  const home = init(path.join(base, T3.remote))
  write(home, { "README.md": "# relay\n", "package.json": '{ "name": "relay" }\n', "src/relay.ts": "export {}\n" })
  commit(home, "relay")
  return home
}

/**
 * `shop` (t2-adopt): a main folder on `main` and three work folders under its `.worktrees` (ignored), each on its own
 * record: `cl-perf` and `cl-review` one save point ahead, `cl-x` with two changed and two new files.
 */
function shop(base: string) {
  const home = init(path.join(base, T2.adopt))
  write(home, {
    ".gitignore": ".worktrees/\n",
    "README.md": "# shop\n",
    "package.json": '{ "name": "shop" }\n',
    "src/cart.ts": "export const cart = 1\n",
    "src/pay.ts": "export const pay = 1\n",
  })
  commit(home, "shop")
  const at = (name: string) => path.join(home, ".worktrees", name)
  for (const name of [...ADOPTED.map((area) => area.slug), LEFT])
    git(home, ["worktree", "add", "-q", "-b", name, at(name)])
  write(at("cl-perf"), { "src/cart.ts": "export const cart = 2\n" })
  commit(at("cl-perf"), "장바구니 빠르게")
  write(at("cl-review"), { "src/pay.ts": "export const pay = 2\n" })
  commit(at("cl-review"), "결제 검토")
  write(at(LEFT), {
    "README.md": "# shop x\n",
    "src/cart.ts": "export const cart = 3\n",
    "idea-1.md": "1\n",
    "idea-2.md": "2\n",
  })
  return home
}

/** `calc` (t2-integrate): a `check` script that waits four seconds, run by Bun (the lock file picks the runner). */
function calc(base: string) {
  const home = init(path.join(base, T2.integrate))
  write(home, {
    "README.md": "# calc\n",
    "package.json": `${JSON.stringify({ name: "calc", private: true, scripts: { check: "bun check.ts" } }, null, 2)}\n`,
    "bun.lock": "{}\n",
    "check.ts": "await Bun.sleep(4000)\n",
    "src/add.ts": "export const add = (a: number, b: number) => a + b\n",
    "src/view.ts": "export const view = 1\n",
  })
  commit(home, "calc")
  return home
}

/** `memo` (t2-settings): a small code repository. */
function memo(base: string) {
  const home = init(path.join(base, T2.settings))
  write(home, { "README.md": "# memo\n", "package.json": '{ "name": "memo" }\n', "src/note.ts": "export {}\n" })
  commit(home, "memo")
  return home
}

/** `presets.set` through own.accounts; returns the saved preset's id. */
async function savePreset(preset: Readonly<Record<string, unknown>>) {
  const saved = await accounts("presets.set", {
    preset: { caps: { concurrent: 3, perMessage: 6, perSession: null }, ultraCaps: null, ...preset },
  })
  const info = saved.preset as { readonly id?: unknown } | undefined
  if (typeof info?.id !== "string") throw new Error(`presets.set returned no id: ${JSON.stringify(saved)}`)
  return info.id
}

/** Hop-by-hop and body-framing headers the device stand-in does not copy. */
const DROPPED = new Set(["host", "connection", "content-length", "transfer-encoding", "content-encoding"])

/** The gateway's device surface for own-web (see the file header); no device credential is checked. */
function startDevice() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: DEVICE_PORT,
    // Event streams stay open with long quiet stretches.
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/own/device")
        return Response.json({
          deviceId: "dev_e2e_phone",
          name: "e2e 휴대폰",
          kind: "browser",
          scopes: ["read", "prompt", "switch"],
          servers: { mode: "all" },
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          controlDir: team.control,
          pc: SERVICE_PC,
        })
      if (url.pathname === "/own/servers")
        return Response.json({
          servers: [
            { serverKey: "local", name: "local", baseUrl: "/srv/local", controlDir: team.control, state: "ready" },
          ],
        })
      if (url.pathname === "/own-e2e/calls") return Response.json(calls)
      const remote = /^\/own-e2e\/remote\/([\w.]+)$/.exec(url.pathname)
      if (remote) return fakeRemote(remote[1] ?? "", request)
      const relay = /^\/srv\/([\w-]+)(\/api\/.*)$/.exec(url.pathname)
      const key = relay?.[1]
      const host = isHost(key) ? key : undefined
      if (relay && key !== "local" && !host) return new Response("no such server", { status: 404 })
      const answered = host === undefined ? undefined : hostAnswer(host, relay?.[2] ?? "", request)
      if (answered) return answered
      const target = relay
        ? new URL(`${relay[2]}${url.search}`, team.server.url)
        : new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${TEAM_PORT}`)
      const headers = new Headers(
        [...request.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase())),
      )
      if (relay) headers.set("authorization", team.server.authorization)
      const answer = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
      })
      const copied = [...answer.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase()))
      if (host && !HOSTS[host].mirror && relay?.[2] === "/api/rpc/own.accounts/presets.list" && answer.ok)
        return Response.json(unmirrored(await answer.json()), { status: answer.status, headers: copied })
      if (relay || !(answer.headers.get("content-type") ?? "").includes("text/html"))
        return new Response(answer.body, { status: answer.status, headers: copied })
      const page = (await answer.text()).replace("<head>", '<head><meta name="own-gateway" content="1">')
      return new Response(page, { status: answer.status, headers: copied })
    },
  })
}

function isHost(key: string | undefined): key is HostID {
  return key !== undefined && Object.hasOwn(HOSTS, key)
}

/** What a fake host answers itself: own.team `enable` before the large-file tool is there (06 §4.13). */
function hostAnswer(host: HostID, rest: string, request: Request) {
  const rpc = /^\/api\/rpc\/([^/]+)\/([^/]+)$/.exec(rest)
  if (!rpc || request.method !== "POST") return undefined
  calls.hosts.push(`${host} ${rpc[1]}/${rpc[2]}`)
  if (rpc[1] !== "own.team" || rpc[2] !== "enable" || tooled.has(host)) return undefined
  return rpcError(request, "lfs_missing", "git-lfs is not on the host", { tool: "git-lfs", version: null })
}

/** An older host's `presets.list`: groups without stored presets (it does not mirror this PC's yet, 07 §8.1 원격). */
function unmirrored(body: unknown) {
  const output = (body as { readonly output?: { readonly groups?: ReadonlyArray<Record<string, unknown>> } }).output
  return {
    output: {
      ...output,
      groups: (output?.groups ?? []).map((group) => {
        const presets = (group.presets as ReadonlyArray<{ readonly id: string }> | undefined) ?? []
        const kept = presets.filter((preset) => preset.id.startsWith("builtin:"))
        const star = typeof group.star === "string" && group.star.startsWith("builtin:") ? { star: group.star } : {}
        return {
          ...Object.fromEntries(Object.entries(group).filter((entry) => entry[0] !== "star")),
          ...star,
          presets: kept,
        }
      }),
    },
  }
}

/** The local own.remote of the PC page, for the fake hosts (see the file header). */
async function fakeRemote(method: string, request: Request) {
  const body = (await request.json().catch(() => ({}))) as { readonly input?: { readonly hostId?: string } }
  const hostId = body.input?.hostId
  if (method === "hosts.list")
    return Response.json({ output: { revision: 1, hosts: Object.keys(HOSTS).map(hostView) } })
  if (method === "heartbeat") return Response.json({ output: {} })
  if (!isHost(hostId)) return rpcError(request, "host_not_found", "no such host", { hostId: hostId ?? "" })
  if (method === "resolve")
    return Response.json({
      output: {
        url: `http://127.0.0.1:${DEVICE_PORT}/srv/${hostId}`,
        token: HOST_TOKEN,
        tokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        epoch: 1,
        controlDir: team.control,
        home: team.root,
      },
    })
  if (method === "catalog.get")
    return Response.json({ output: { epoch: 1, fetchedAt: null, projects: [], sessions: [] } })
  if (method !== "hosts.tools.ensure")
    return rpcError(request, "rpc.method_not_found", `own.remote ${method} is not part of this fake`)
  calls.ensure.push(hostId)
  if (!HOSTS[hostId].upload)
    return rpcError(request, "tool_hash_mismatch", "the bundled git-lfs does not match its pin", {
      tool: "git-lfs",
      expected: "a".repeat(64),
      actual: "b".repeat(64),
    })
  const present = tooled.has(hostId)
  // An upload takes a moment: long enough for the page's progress toast to be seen.
  if (!present) await Bun.sleep(1500)
  tooled.add(hostId)
  return Response.json({ output: { state: present ? "present" : "uploaded", version: LFS_VERSION } })
}

/** One `hosts.list` row of a fake host (own-protocol `OwnRemote.HostView`): connected and ready. */
function hostView(id: string) {
  const host = isHost(id) ? HOSTS[id] : undefined
  return {
    id,
    alias: null,
    name: host?.name ?? id,
    target: "e2e@127.0.0.1",
    stage: "ready",
    paused: false,
    error: null,
    detail: "",
    platform: { os: "linux", arch: "x64", target: "linux-x64", libc: "glibc" },
    hostIdentity: null,
    identityChanged: false,
    versions: { local: "e2e", remoteRunning: "e2e", remoteStaged: [], skew: false },
    autoConnect: true,
    loopback: "127.0.0.1",
    localPort: DEVICE_PORT,
    epoch: 1,
    accounts: { mode: "all" },
    leaseSeconds: 3600,
    failClosedGraceSeconds: 60,
    tokenTtlHours: 24,
    projectConfig: "disabled",
    shellEnv: "login",
    warnings: [],
    broker: {
      state: "connected",
      mode: "normal",
      proto: 1,
      leasesActive: 0,
      lastPushAt: null,
      spoolBacklog: 0,
      gaps: 0,
      clockSkewMs: null,
      sourceStale: [],
    },
    sessions: { active: null },
    events: { state: "subscribed", catalogEpoch: 1, catalogFetchedAt: null },
    pendingSettings: false,
    owner: { clientId: null },
    upstreamOpencodeDetected: false,
  }
}

/** A declared RPC error as the server sends it (HTTP 400 `RpcError`), readable by a page on another origin. */
function rpcError(request: Request, type: string, message: string, data?: unknown) {
  return Response.json(
    { _tag: "RpcError", type, message, ...(data === undefined ? {} : { data }) },
    {
      status: 400,
      headers: {
        "access-control-allow-origin": request.headers.get("origin") ?? "*",
        "access-control-allow-credentials": "true",
        vary: "Origin",
      },
    },
  )
}

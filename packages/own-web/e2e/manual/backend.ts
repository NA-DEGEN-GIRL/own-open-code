// Demo backend for the user manual's screenshots (own/docs/manual/PLAN.md §4). Started by own/scripts/manual/capture.ts
// with `bun e2e/manual/backend.ts` from packages/own-web (the harness, Vite and Playwright resolve from here), or by
// hand. Every account, conversation and folder is made up; every model call goes to a local fake provider.
//
// Worlds (OWN_MANUAL_WORLD):
//   - `main` (default): the real upstream server from source with own-accounts, own-team, the Claude subscription slot
//     (a fake of the bundled claude-auth) and own-computer-use (driver "fake": an in-memory desktop, never this
//     PC's), booted by own-team's e2e harness (packages/own-team/test/e2e/harness.ts, imported read-only). Accounts:
//     `ChatGPT 01`, `02`, `03` (linked old-app profiles answered by one fake Codex backend), `DeepSeek` and `Anthropic`
//     (metered fake keys)
//     and `Claude 구독` (the slot). Projects (git repositories with local settings only, author `Demo User`):
//     `space-game`, `billing-service`, and with OWN_MANUAL_TEAM=1 also `shop-app` (work folders to adopt).
//     With OWN_MANUAL_LANG=ko|en (the README's pictures) it also loads own-harness and adds a local model account, and
//     `en` writes the demo texts in English (english.ts).
//   - `empty`: the same server with own-accounts only and no account, so the first screen asks for one; a fake ChatGPT
//     sign-in issuer (device code) and a fake old app (two ChatGPT profiles and one DeepSeek key) for the add flows.
//
// Model answers come from a scripted responder: a user text that contains a script's key gets that script's tool calls
// (own-team's directive replies) and then its Korean answer, so the transcript shows plain prompts. Team requests use
// own-team's directive responder; the team judge gets this file's area proposal.
//
// own-web is served through Vite dev on OWN_MANUAL_PORT (no HMR) with `/api` proxied with server-side Basic auth, and a
// phone stand-in on OWN_MANUAL_PORT + 1 (the page with `<meta name="own-gateway">`, `GET /own/device`: a paired phone,
// like e2e/team/backend.ts). The stand-in also serves `POST /manual/<action>` for the capture script (fake usage,
// balance, a removed folder). Fake credentials only; every listener binds 127.0.0.1; the temp root (under TEMP) is
// removed on exit. Run from a path without '#'.
//
// OWN_MANUAL_GATEWAY=1 (main world): own-remote's real gateway too, serving the own-web build in OWN_MANUAL_GATEWAY_WEB
// with the app listener on loopback (memory vault, no Tailscale or portproxy probe), so a real Android app reaches the
// demo world through `adb reverse` and a loopback pairing link (`POST /manual/app-link`; the PC's 허용 stays a click in
// 설정 > 기기). It also adds a Claude Agent account (own-team's fake `claude`) and a `로컬 모델` local model account, for the
// phone's account rows. The mobile UX audit uses it (own/reports/mobile-ux-2026-11-06).
//
// OWN_MANUAL_BROWSER=1 (main world; the phone suite sets it): own-remote's real gateway on OWN_MANUAL_PORT + 2 with one
// really paired device behind the phone stand-in, for the browser pane on a device (05 §8.10). The stand-in then
// answers `GET /own/device` with that device's scopes as the gateway holds them (so `devices.update` on the PC side
// changes what the page reads), relays the viewer socket `/own/browser/local/<sessionID>` to the gateway with the
// device's cookie, and lets a test add an event to the page's event stream (`POST /manual/event`: the agent's browser
// calls, which need a desktop shell this world does not run). The desktop shell is played by the test itself: RPC
// `own.remote` `browser.host.*` on the dev origin (`local` scope).
import crypto from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import {
  anthropicProvider,
  opencodeConfig,
  removeTree,
  startFakeAnthropic,
  startFakeChatGPTAuth,
  startFakeCodex,
  startFakeOpenAIChat,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type RecordedRequest,
  type Reply,
} from "../../../own-accounts/test/e2e-kit"
import { startFakeMcpRegistry } from "../../../own-accounts/test/e2e-kit/fakes/mcp-registry"
import { FAKE_MCP_STDIO } from "../../../own-accounts/test/e2e-kit/fakes/mcp-stdio"
import { hashSecret } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { createLegacyApp, writeLegacyDeepSeek } from "../../../own-accounts/test/e2e-kit/fixtures/legacy-keys"
import { REPO_ROOT } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { session, text, toolUse } from "../../../own-import/test/fixtures/claude"
import { rollout, threadId } from "../../../own-import/test/fixtures/codex"
import { claudeSession, codexRollout, stateDb, writeJsonl } from "../../../own-import/test/fixtures/make"
import { claudeSkill, codexSkill, pluginSkill, skillFolder, skillMd } from "../../../own-import/test/fixtures/skills"
import { parse, reply, responder, turn, TITLE_PROMPT } from "../../../own-team/test/e2e/directives"
import { CHATGPT, CLAUDE, DEEPSEEK, MODEL, startTeamServer, type TeamFakes } from "../../../own-team/test/e2e/harness"
import { commit, git, init, write } from "../../../own-team/test/fixtures/repo"
import { ENGLISH, WORDS } from "./english"

const WORLD = process.env.OWN_MANUAL_WORLD === "empty" ? "empty" : "main"
const TEAM = process.env.OWN_MANUAL_TEAM === "1"
/** The README's pictures (own/scripts/readme): own-harness and a local model too, in Korean or English (english.ts). */
const README = process.env.OWN_MANUAL_LANG !== undefined
const EN = process.env.OWN_MANUAL_LANG === "en"
const L = (text: string) => (EN ? (WORDS[text] ?? text) : text)
const GATEWAY = WORLD === "main" && process.env.OWN_MANUAL_GATEWAY === "1"
const BROWSER = WORLD === "main" && !GATEWAY && process.env.OWN_MANUAL_BROWSER === "1"
const PORT = Number(process.env.OWN_MANUAL_PORT ?? 6301)
const DEVICE_PORT = PORT + 1
const TMP = process.env.OWN_MANUAL_TMP ?? path.join(os.tmpdir(), "own-manual")
const STATE_FILE = path.join(TMP, `backend-${WORLD}${TEAM ? "-team" : ""}.json`)
const RATECARDS = path.join(REPO_ROOT, "own/config/ratecards.default.json")
/** The PC name the phone stand-in reports (the gateway sends `os.hostname()`). */
const PC = "DEMO-PC"
const NAME = `manual-${WORLD}${TEAM ? "team" : ""}`
/** The gateway's registration file: the demo server's URL and password, written once the world is up. */
const REGISTRATION = path.join(TMP, `gateway-${NAME}.json`)

/** The team judge's instructions (own-team `judge/prompt.ts`) and the reorganization call's. */
const JUDGE = "너는 팀 모드의 판단을 맡는다"
const REORG = "팀 구성을 어떻게 바꿀지"
/** Core's compaction prompt (core/src/session/compaction.ts): the summary must use the template headings. */
const COMPACTION = "You MUST use this format for your response"
const SHOT = "[computer-shot]"
const DRIVE = "await tools.computer.screenshot({}); return await tools.computer.mouse_move({ coordinate: [120, 80] })"

// Remove what an earlier run that was killed left behind.
for (const entry of await fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []))
  if (entry.isDirectory() && entry.name.startsWith(`own-team-e2e-${NAME}-`))
    await fs.rm(path.join(os.tmpdir(), entry.name), { recursive: true, force: true }).catch(() => undefined)

// ---------------------------------------------------------------------------------------------------------------
// Scripts: what the fake model does for a demo prompt (its key is a part of the prompt).

export interface Script {
  readonly key: string
  /** own-team directives run one per model request, before the answer. */
  readonly steps?: string
  readonly answer: string
  /** The first reply waits this long (a turn that is still running when a screenshot is taken). */
  readonly delayMs?: number
  /** Only in a team main's or an area owner's conversation (own-team's role instructions name them). */
  readonly role?: keyof typeof ROLES
  /** Code Mode steps (`execute`), one per model request, instead of `steps` (the browser pane's agent, 19장). */
  readonly code?: ReadonlyArray<string>
  /**
   * One core `subagent` call with this `model` argument (`#max`, `<pool key>`, …) instead of `steps`; the answer after
   * it waits a minute, so a refusal chip still offers its button while the shot is taken (14장).
   */
  readonly subagent?: string
}

/** How own-team's role instructions start (own-team `sessions/instructions.ts`). */
const ROLES = { main: "# 팀 메인 역할 (own.team)", owner: "# 영역 담당 역할 (own.team)" } as const

const ENEMY_AI = [
  "import { grid, type Cell } from './game'",
  "",
  L("// 적이 벽을 피해 플레이어에게 가는 가장 짧은 길(A* 탐색)"),
  "export function nextStep(from: Cell, to: Cell): Cell {",
  "  const path = grid.findPath(from, to, { avoid: 'wall', diagonal: false })",
  "  return path[1] ?? from",
  "}",
  "",
].join("\n")

const RULES = ["export const enemySpeed = 2", "export const enemyAvoidsWalls = true", ""].join("\n")
/** The demo page the browser pane's agent opens (served by this backend's phone stand-in, see {@link site}). */
const SITE = `http://${README ? "localhost" : "127.0.0.1"}:${DEVICE_PORT}/manual/site/`
const FIND_TAB = `const { tabs } = await tools.browser.tabs.list({})
const tab = tabs.find((item) => item.url.startsWith(${JSON.stringify(SITE)}))
if (!tab) throw new Error("no scoreboard tab: " + JSON.stringify(tabs))`
/** The element reference of a `find` result line (`@e12 [button] …`). */
const REF = (role: string) => `/@(e\\d+) \\[${role}\\]/.exec(found.content)?.[1]`

const KOREAN: ReadonlyArray<Script> = [
  // Worktree conversations (the README's pictures): the parent starts two, one ends and wakes it, the other keeps on.
  { key: "<worktree-chat", answer: "`격자 스폰`이 끝났어요. 바뀐 점을 보고 합칠지 알려 주세요. `물결 스폰`은 아직 작업 중이에요." },
  {
    key: "두 가지 방법을 각각",
    steps: `[tool worktree.start ${JSON.stringify({
      tasks: [
        { name: "spawn-grid", title: "격자 스폰", task: "빈 격자 칸에서 생기게 해 줘" },
        { name: "spawn-waves", title: "물결 스폰", task: "물결 단위로 생기게 해 줘" },
      ],
    })}]`,
    answer: "작업 폴더 두 개에서 대화를 따로 시작했어요. 끝나면 여기서 비교해 드릴게요.",
  },
  {
    key: "빈 격자 칸에서",
    answer: "적이 벽이 아닌 칸에서만 생기게 했어요.",
  },
  { key: "물결 단위로", answer: "적이 세 물결로 나뉘어 나와요.", delayMs: 900_000 },
  // 곁질문 (the README's pictures).
  {
    key: "A* 말고 다른 방법",
    answer: [
      "작은 맵이면 **BFS(너비 우선 탐색)** 로도 충분해요.",
      "",
      "- 칸마다 비용이 같아서 결과는 A*와 같아요.",
      "- 적이 많아지면 플레이어에서 한 번만 퍼뜨리는 **흐름장**이 더 빨라요.",
    ].join("\n"),
  },
  {
    key: "벽에 자꾸 부딪혀요",
    steps: `[write src/enemy-ai.ts ${ENEMY_AI}]`,
    answer: [
      "적 AI가 벽을 피해 가도록 경로 탐색을 고쳤어요.",
      "",
      "- `src/enemy-ai.ts`: 한 칸씩 직진하던 방식을 **A\\* 길찾기**로 바꿨어요.",
      "- 벽(`wall`) 칸은 지나가지 않고, 대각선 이동은 막았어요.",
      "",
      "게임을 다시 실행해서 적이 모서리에서 멈추지 않는지 확인해 보세요.",
    ].join("\n"),
  },
  {
    key: "고친 부분을 짧게",
    answer: [
      "바뀐 점은 세 가지예요.",
      "",
      "1. 적은 매 턴 플레이어까지의 **가장 짧은 길**을 다시 계산해요.",
      "2. 길의 첫 칸으로만 움직이니까 벽 앞에서 제자리걸음을 하지 않아요.",
      "3. 길이 없으면(완전히 막힘) 그 자리에서 기다려요.",
      "",
      "```ts",
      "const path = grid.findPath(from, to, { avoid: 'wall' })",
      "```",
    ].join("\n"),
  },
  {
    key: "맵 데이터를 정리",
    answer: "맵 데이터 40개 중 빈 칸이 많은 3개를 합치고, 같은 타일 묶음은 하나로 줄였어요.",
  },
  {
    key: "이 로그를 요약해 줘",
    answer: [
      "로그 6,000줄을 훑어봤어요.",
      "",
      "- 모든 요청이 `status=ok`로 끝났고 재시도는 없었어요.",
      "- 지연 시간은 0–900ms 사이에 고르게 퍼져 있어요. 튀는 값은 없어요.",
      "- `worker=3`과 `worker=5`가 조금 더 바빴어요.",
      "",
      "지금은 따로 고칠 곳이 보이지 않아요.",
    ].join("\n"),
  },
  {
    key: "레벨 에디터에서 타일",
    answer: [
      "레벨 에디터에서 타일을 지울 때 **실행 취소 기록에 빈 칸이 두 번 쌓이는** 문제가 있었어요.",
      "",
      "`src/game.ts`의 `eraseTile`이 지운 뒤에 한 번 더 기록하고 있었어요. 기록을 한 번만 남기도록 고치면 돼요.",
    ].join("\n"),
  },
  {
    key: "HUD를 더 보기 좋게",
    answer: [
      "HUD를 이렇게 다듬으면 좋아요.",
      "",
      "- 체력 막대를 화면 왼쪽 위로 옮기고 글자를 조금 키워요.",
      "- 점수는 오른쪽 위, 남은 적 수는 그 아래에 둬요.",
      "- 어두운 배경에서도 보이게 글자에 얇은 테두리를 넣어요.",
    ].join("\n"),
  },
  {
    key: "효과음 파일 이름",
    answer: "효과음 파일 이름을 `sfx-<동작>.ogg` 꼴로 맞추고, 볼륨은 설정 파일 한곳에서 관리하도록 정리할게요.",
  },
  {
    key: "시작 메뉴 문구",
    answer: "시작 메뉴 문구를 `게임 시작`, `이어하기`, `설정`, `나가기` 네 개로 짧게 줄였어요.",
  },
  {
    key: "결제 웹훅이 실패",
    answer: [
      "결제 웹훅이 실패하면 **1분, 5분, 30분** 뒤에 다시 보내도록 했어요.",
      "",
      "세 번 모두 실패하면 관리자 알림을 남기고 멈춰요. 같은 이벤트가 두 번 처리되지 않게 이벤트 ID로 중복을 막았어요.",
    ].join("\n"),
  },
  {
    key: "바뀐 파일을 확인",
    steps: "[shell git status --short]",
    answer: "`src/enemy-ai.ts` 하나만 바뀌었어요. 아직 커밋하지 않은 상태예요.",
  },
  {
    key: "적 스폰 위치",
    answer: "적이 벽 안에서 생기지 않도록 스폰 위치를 빈 칸 중에서만 고르게 할게요.",
    delayMs: 20_000,
  },
  {
    key: "하위 에이전트로 나눠",
    steps:
      "[subagent explore 적 AI 코드에서 길찾기 함수를 찾아 줘] [subagent explore HUD 코드를 찾아 줘] [subagent explore 네트워크 코드를 찾아 줘] [subagent explore 레벨 데이터를 찾아 줘]",
    answer: "네 곳을 나눠서 살펴봤어요.",
  },
  // Team mode (world T): the user's request to the team main, and what each area's owner does with its part.
  {
    key: "세 영역에 일을 나눠",
    role: "main",
    steps:
      "[dispatch ui HUD 글자 크기를 키우고 체력 막대를 왼쪽 위로 옮겨 주세요] [dispatch core 적 이동 규칙을 정리하고 끝나면 반영 준비를 알려 주세요] [dispatch net 로비 최대 인원을 6명으로 늘려 주세요]",
    answer: "세 영역에 일을 나눠 맡겼어요. 화면은 HUD, 게임 로직은 적 이동 규칙, 네트워크는 로비를 맡아요.",
  },
  {
    // Still working while the screenshots of the team view are taken.
    key: "체력 막대를 왼쪽 위로 옮겨 주세요",
    role: "owner",
    answer: "HUD 글자를 키우고 체력 막대를 왼쪽 위로 옮겼어요.",
    delayMs: 900_000,
  },
  {
    key: "끝나면 반영 준비를 알려 주세요",
    role: "owner",
    steps: `[write src/rules.ts ${RULES}] [shell git add -A && git commit -q -m "적 이동 규칙 정리"] [report ready 적 이동 규칙을 src/rules.ts 한곳으로 모았습니다]`,
    answer: "적 이동 규칙을 `src/rules.ts`로 모으고 반영 준비를 알렸어요.",
  },
  {
    key: "로비 최대 인원을 6명으로",
    role: "owner",
    answer: "로비 최대 인원을 6명으로 늘렸어요.",
  },
  // The desktop app's browser pane (19장): the demo scoreboard page this backend serves (`/manual/site/`).
  {
    key: "점수판 페이지를 열고",
    code: [
      `const tab = await tools.browser.tabs.open({ url: ${JSON.stringify(SITE)} })
await tools.browser.snapshot({ tabID: tab.id })
return { tabID: tab.id }`,
      `${FIND_TAB}
const found = await tools.browser.find({ tabID: tab.id, text: ${JSON.stringify(L("새 게임"))} })
const ref = ${REF("button")}
if (!ref) throw new Error("no button: " + found.content)
await tools.browser.click({ tabID: tab.id, ref })
await tools.browser.wait({ tabID: tab.id, condition: "text", text: ${JSON.stringify(L("게임 시작!"))}, timeoutMs: 30000 })
return "started"`,
    ],
    answer: "점수판을 열고 '새 게임'을 눌렀어요. 게임이 시작됐어요.",
  },
  {
    key: "점수 파일을 내려받아",
    code: [
      `${FIND_TAB}
const found = await tools.browser.find({ tabID: tab.id, text: ${JSON.stringify(L("점수 내려받기"))} })
const ref = ${REF("link")}
if (!ref) throw new Error("no link: " + found.content)
await tools.browser.click({ tabID: tab.id, ref })
let files = []
for (let attempt = 0; attempt < 60; attempt++) {
  files = (await tools.browser.files.list({ tabID: tab.id })).files
  if (files.some((file) => file.state === "completed")) break
}
return { files }`,
    ],
    answer: "점수 파일(scores.csv)을 내려받았어요. 브라우저 패인의 다운로드 목록에서 PC에 저장할 수 있어요.",
  },
  {
    key: "결과 화면이 뜰 때까지",
    code: [
      `${FIND_TAB}
await tools.browser.navigate({ tabID: tab.id, url: ${JSON.stringify(`${SITE}slow`)} })
// One wait is at most 30 s: the agent keeps waiting for a few minutes.
for (let attempt = 0; attempt < 10; attempt++) {
  const done = await tools.browser
    .wait({ tabID: tab.id, condition: "text", text: "끝났습니다", timeoutMs: 30000 })
    .then(() => true, () => false)
  if (done) return "done"
}
return "still waiting"`,
    ],
    answer: "기다리던 결과 화면이 나타나지 않았어요.",
  },
  {
    key: "리뷰는 최대로",
    subagent: "#max",
    answer: "강도를 높음으로 낮춰서 리뷰를 다시 맡길게요.",
  },
  {
    key: "메모장",
    steps: SHOT,
    answer: "메모장 화면을 확인했어요.",
  },
]

export const SCRIPTS: ReadonlyArray<Script> = EN
  ? KOREAN.map((item) => ({ ...item, ...ENGLISH[item.key] }))
  : KOREAN

const SUMMARY = [
  "## Objective",
  "- space-game의 서버 로그를 분석하고 문제를 찾는다.",
  "",
  "## Decisions",
  "- 로그 6,000줄 모두 정상(status=ok), 재시도 없음.",
  "",
  "## Work State",
  "### Completed",
  "- 로그 요약",
  "",
  "### Active",
  "- 없음",
  "",
  "## Next Move",
  "1. 다음 요청을 기다린다.",
].join("\n")

/** Call ids this responder made: the user text they serve and the step they performed. */
const calls = new Map<string, { readonly user: string; readonly step: number }>()
/** Call ids of the computer screenshots: a follow-up holding only that result ends the turn. */
const shots = new Set<string>()
const fallback = responder()

function scripted(request: RecordedRequest): Reply | undefined {
  if (request.body.includes(TITLE_PROMPT)) return { type: "text", text: L("새 작업") }
  if (request.body.includes(COMPACTION)) return { type: "text", text: SUMMARY }
  const current = turn(request)
  if (request.body.includes(JUDGE))
    return { type: "text", text: JSON.stringify(judged(current.user, request.body.includes(REORG))) }
  if (current.call !== undefined && shots.has(current.call)) return { type: "text", text: "메모장 화면을 확인했어요." }
  const known = current.user === "" && current.call !== undefined ? calls.get(current.call) : undefined
  const user = known?.user ?? current.user
  const script = SCRIPTS.find(
    (item) => user.includes(item.key) && (known || !item.role || current.system.includes(ROLES[item.role])),
  )
  if (!script) return fallback(request)
  const step = known ? known.step + 1 : current.done
  const wait = step === 0 && script.delayMs ? { delayMs: script.delayMs } : {}
  if (script.code) {
    const code = script.code[step]
    if (code === undefined) return { type: "text", text: script.answer, deltas: 12 }
    const id = `call_manual_${calls.size + 1}`
    calls.set(id, { user, step })
    return { type: "tool-call", id, name: "execute", input: { code: code.trim() }, eventDelayMs: 5 }
  }
  if (script.subagent !== undefined) {
    if (step > 0) return { type: "text", text: script.answer, deltas: 12, delayMs: 60_000 }
    const id = `call_manual_${calls.size + 1}`
    calls.set(id, { user, step })
    return {
      type: "tool-call",
      id,
      name: "subagent",
      input: {
        agent: "own-review",
        description: "길찾기 변경 검토",
        prompt: "길찾기 변경을 검토해 줘",
        model: script.subagent,
      },
    }
  }
  if (script.steps === SHOT) {
    if (step > 0) return { type: "text", text: script.answer }
    const id = `call_shot_${shots.size + 1}`
    shots.add(id)
    return { type: "tool-call", id, name: "execute", input: { code: DRIVE }, ...wait }
  }
  const next = parse(script.steps ?? "")[step]
  if (!next) return { type: "text", text: script.answer, deltas: 12, ...wait }
  const answer = reply(next, current.tools)
  if (answer.type !== "tool-call") return answer
  const id = `call_manual_${calls.size + 1}`
  calls.set(id, { user, step })
  return { ...answer, id, ...wait }
}

// ---------------------------------------------------------------------------------------------------------------
// Team judge: areas of `space-game` (화면 ui, 게임 로직 core, 네트워크 net) without the large-file folder `assets`,
// and the adopted work folders of `shop-app`.

const AREAS = [
  { slug: "ui", name: L("화면"), goal: L("HUD와 메뉴 다듬기") },
  { slug: "core", name: L("게임 로직"), goal: L("적 AI와 규칙 정리") },
  { slug: "net", name: L("네트워크"), goal: L("로비와 매칭 안정화") },
] as const
const HEAVY = "assets"
const CHECK = "bun run check"

function judged(prompt: string, reorganize: boolean) {
  const home = /^메인 폴더: (.+)$/m.exec(prompt)?.[1]?.trim() ?? ""
  const name = home.replaceAll("\\", "/").split("/").at(-1)
  if (reorganize)
    return {
      version: 1,
      ops: [{ op: "rename", area: "ui", name: "화면 손질", why: "HUD 손질만 남음" }],
      suggest: [{ kind: "retire", area: "net", why: "로비 작업 끝남" }],
      notes: "화면 영역의 이름을 바꾸고 끝난 영역을 정리해요.",
    }
  if (name === "shop-app")
    return {
      version: 1,
      areas: [
        { slug: "cl-cart", name: "장바구니", goal: "장바구니 속도" },
        { slug: "cl-search", name: "검색", goal: "검색 정확도" },
      ].map((area) => ({
        ...area,
        shape: "code",
        adopt: { worktree: path.join(home, ".worktrees", area.slug), branch: area.slug },
        create: null,
      })),
      notes: "지금 있는 작업 폴더 두 개를 받아들여요.",
    }
  return {
    version: 1,
    heavy: [{ dir: HEAVY, why: L("그림과 소리 파일(큰 파일)") }],
    commands: { code: [CHECK] },
    areas: AREAS.map((area) => ({ ...area, shape: "code", adopt: null, create: { from: "main" } })),
    notes: L(`영역 ${AREAS.length}개를 만들어요.`),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fakes. Usage does not move with requests: the capture script sets the numbers it shows.

function startFakes(): TeamFakes {
  const cache = { minTokens: 0, blockTokens: 32 }
  const codex = startFakeCodex({ cache, responder: scripted, usagePerRequest: { primary: 0, secondary: 0 } })
  const deepseek = startFakeOpenAIChat({ cache, responder: scripted })
  const anthropic = startFakeAnthropic({ cache, responder: scripted })
  const tokens = {
    "01": codex.login(CHATGPT["01"]),
    "02": codex.login(CHATGPT["02"]),
    "03": codex.login(CHATGPT["03"]),
  }
  return {
    codex,
    deepseek,
    anthropic,
    tokens,
    stop: async () => {
      await Promise.all([codex.stop(), deepseek.stop(), anthropic.stop()])
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Projects

/**
 * `git init` with own-team's fixture settings, then the demo author. The fixture's empty hooks folder (`.no-hooks`
 * next to the repository) moves out of the folder of projects, so the folder picker lists only the projects.
 */
function repo(dir: string) {
  init(dir)
  const hooks = path.join(path.dirname(dir), "..", ".no-hooks")
  mkdirSync(hooks, { recursive: true })
  rmSync(path.join(path.dirname(dir), ".no-hooks"), { recursive: true, force: true })
  git(dir, ["config", "user.name", "Demo User"])
  git(dir, ["config", "user.email", "demo@example.com"])
  git(dir, ["config", "core.hooksPath", hooks.replaceAll("\\", "/")])
  return dir
}

function spaceGame(base: string) {
  const home = repo(path.join(base, "space-game"))
  write(home, {
    ".gitignore": "node_modules/\n.cache/\n",
    "README.md": "# space-game\n\n작은 우주 슈팅 게임이에요. `bun run dev`로 실행해요.\n",
    "package.json": `${JSON.stringify({ name: "space-game", private: true, scripts: { dev: "bun src/game.ts", check: "bun check.ts" } }, null, 2)}\n`,
    "bun.lock": "{}\n",
    "check.ts": "await Bun.sleep(4000)\nconsole.log('검사 통과')\n",
    "src/game.ts": [
      "export type Cell = { x: number; y: number }",
      "",
      "export const grid = {",
      "  width: 40,",
      "  height: 24,",
      "  findPath(from: Cell, to: Cell, _options: { avoid: string; diagonal?: boolean }): Cell[] {",
      "    return [from, to]",
      "  },",
      "}",
      "",
      "export function eraseTile(cell: Cell) {",
      "  history.push(cell)",
      "  history.push(cell)",
      "}",
      "",
      "const history: Cell[] = []",
      "",
    ].join("\n"),
    "src/enemy-ai.ts": [
      "import { type Cell } from './game'",
      "",
      L("// 적이 플레이어 쪽으로 한 칸씩 직진한다"),
      "export function nextStep(from: Cell, to: Cell): Cell {",
      "  return { x: from.x + Math.sign(to.x - from.x), y: from.y + Math.sign(to.y - from.y) }",
      "}",
      "",
    ].join("\n"),
    "src/ui/hud.ts": "export function drawHud(score: number, hp: number) {\n  return `HP ${hp} · 점수 ${score}`\n}\n",
    "src/net/lobby.ts": "export const lobby = { maxPlayers: 4 }\n",
    ...Object.fromEntries(
      ["ship.png", "enemy.png", "music.ogg", "explosion.ogg"].map((name) => [
        `${HEAVY}/${name}`,
        crypto.randomBytes(256 * 1024),
      ]),
    ),
  })
  commit(home, "space-game 시작")
  write(home, { ".cache/build/bundle.js": crypto.randomBytes(64 * 1024), ".cache/thumbs/ship.webp": "x" })
  return home
}

function billingService(base: string) {
  const home = repo(path.join(base, "billing-service"))
  write(home, {
    "README.md": "# billing-service\n",
    "package.json": '{ "name": "billing-service" }\n',
    "src/webhook.ts": "export function retry() {}\n",
  })
  commit(home, "billing-service 시작")
  return home
}

/** `shop-app`: three work folders under `.worktrees`, `cl-x` with changes not in a save point. */
function shopApp(base: string) {
  const home = repo(path.join(base, "shop-app"))
  write(home, {
    ".gitignore": ".worktrees/\n",
    "README.md": "# shop-app\n",
    "package.json": '{ "name": "shop-app" }\n',
    "src/cart.ts": "export const cart = 1\n",
    "src/search.ts": "export const search = 1\n",
  })
  commit(home, "shop-app 시작")
  const at = (name: string) => path.join(home, ".worktrees", name)
  for (const name of ["cl-cart", "cl-search", "cl-x"]) git(home, ["worktree", "add", "-q", "-b", name, at(name)])
  write(at("cl-cart"), { "src/cart.ts": "export const cart = 2\n" })
  commit(at("cl-cart"), "장바구니 빠르게")
  write(at("cl-search"), { "src/search.ts": "export const search = 2\n" })
  commit(at("cl-search"), "검색 정확도")
  write(at("cl-x"), { "README.md": "# shop-app x\n", "src/cart.ts": "export const cart = 3\n", "idea.md": "1\n" })
  return home
}

/**
 * `pixel-art` (main world only): a plain folder, not a Git repository (17장's `Git 저장소로 만들기…`): a dependency
 * folder the proposed .gitignore leaves out, a 12 MB recording and a 1.5 MB binary the dialog leaves out by default.
 */
function pixelArt(base: string) {
  const home = path.join(base, "pixel-art")
  write(home, {
    "README.md": "# pixel-art\n\n게임에 쓸 도트 그림과 효과음을 모아 두는 폴더예요.\n",
    "package.json": '{ "name": "pixel-art", "private": true }\n',
    "src/export.ts": "export function exportSprites() {}\n",
    "node_modules/sharp/package.json": '{ "name": "sharp" }\n',
    "sprites/hero.psd": new Uint8Array(1_536_000),
    "sounds/theme-demo.wav": new Uint8Array(12 * 1024 * 1024).fill(7),
  })
  return home
}

// ---------------------------------------------------------------------------------------------------------------

async function mainWorld() {
  const fakes = startFakes()
  const folders = { billing: "", shop: "", pixel: "" }
  // 21장: the Codex and Claude Code stores own-import reads (main world only), written once the project exists.
  const tools = TEAM ? undefined : await toolsFolder()
  // 10장 찾아서 설치 (SM): own.accounts asks a fake MCP Registry with made-up servers, never the real one.
  const registry = tools ? startFakeMcpRegistry({ remote: "https://mcp.demo-org.example.com" }) : undefined
  const team = await startTeamServer({
    name: NAME,
    fakes,
    computerUse: true,
    claude: true,
    // The phone check (MUX) also lists a Claude Agent account (the team harness' fake `claude`) and a local model.
    ...(GATEWAY ? { claudeAgent: true, plugins: (ownHome: string) => [gatewayPlugin(ownHome)] } : {}),
    ...(BROWSER ? { plugins: (ownHome: string) => [gatewayPlugin(ownHome)] } : {}),
    // Over HTTP the fake sees whole requests, so a turn shows how much of it was cached.
    ...(README ? { codexTransport: "http" as const } : {}),
    // The scripted tool calls are OpenCode's own (`patch`), so the demo's conversations keep that harness.
    ...(README
      ? {
          plugins: () => [
            { package: path.join(REPO_ROOT, "packages/own-harness"), options: { default: "opencode" } },
          ],
        }
      : {}),
    ...(tools
      ? {
          importer: true,
          importOptions: {
            roots: { codex: [tools.codex], claude: [tools.claude] },
            // 10장's skills sources (SK2): a made-up codex-multi-provider control center in the demo home.
            controlCenter: tools.controlCenter,
          },
        }
      : {}),
    // The Claude slot's provider with Opus 5.5 too (its Fast mode is billed as extra usage, 16장).
    config: {
      providers: {
        anthropic: anthropicProvider(fakes.anthropic, {
          apiKey: CLAUDE.key,
          models: [CLAUDE.model.id, "claude-opus-5-5"],
        }),
      },
    },
    accountsOptions: {
      ratecardsSeed: RATECARDS,
      // 10장 MCP 가져오기 (SM): own.accounts reads the demo home's Codex and Claude Code settings, never this PC's.
      ...(tools ? { codexHome: tools.codex, claudeHome: tools.home } : {}),
      endpoints: {
        codex: fakes.codex.baseURL,
        oauthIssuer: fakes.codex.url,
        chatgpt: `${fakes.codex.url}/backend-api`,
        openai: `${fakes.codex.url}/v1`,
        deepseek: fakes.deepseek.baseURL,
        anthropic: fakes.anthropic.baseURL,
        ...(registry ? { mcpRegistry: registry.url } : {}),
      },
    },
    project: (base) => {
      const home = spaceGame(base)
      folders.billing = billingService(base)
      if (TEAM) folders.shop = shopApp(base)
      if (!TEAM) folders.pixel = pixelArt(base)
      return home
    },
  })
  const project = team.project!
  // The old app's profiles get the names a user gives them (the harness names them `team-01` …), then a restart so
  // own.accounts reads them again.
  const aliases: Record<string, string> = { "team-01": L("회사 Plus"), "team-02": L("개인 백업"), "team-03": L("가족 공유") }
  for (const file of [path.join(team.ownHome, "accounts.json"), path.join(team.root, "control-center", "state.json")]) {
    const text = await Bun.file(file).text()
    await Bun.write(
      file,
      Object.entries(aliases).reduce((out, [from, to]) => out.replaceAll(`"${from}"`, JSON.stringify(to)), text),
    )
  }
  // 20장: two more Claude subscription accounts beside the slot's own (02 §8.7), as `Claude 계정 추가` leaves them: a
  // folder under OWN_HOME\claude-accounts with a made-up login file (no real login; nothing signs with them here).
  if (!TEAM) {
    const file = path.join(team.ownHome, "accounts.json")
    const registry = (await Bun.file(file).json()) as Record<string, unknown>
    const added = [
      { id: "acc_claude_work", label: L("회사 Max"), short: "C2", color: "amber", email: "work@example.com" },
      { id: "acc_claude_home", label: L("개인 Pro"), short: "C3", color: "teal", email: "home@example.com" },
    ].map((account) => {
      const folder = path.join(team.ownHome, "claude-accounts", account.id)
      mkdirSync(folder, { recursive: true })
      write(folder, { ".credentials.json": '{"demo":true}\n' })
      const key = path.resolve(folder)
      return {
        accountID: account.id,
        key: process.platform === "win32" ? key.toLowerCase() : key,
        configDir: folder,
        label: account.label,
        shortLabel: account.short,
        color: account.color,
        managed: true,
        email: account.email,
        addedAt: new Date().toISOString(),
      }
    })
    await Bun.write(file, `${JSON.stringify({ ...registry, claudeAccounts: added }, null, 2)}\n`)
  }
  await team.restart()
  const rpc = async (method: string, input: unknown, directory?: string) => {
    const result = await team.rpc("own.accounts", method, input, directory)
    if (result.status !== 200)
      throw new Error(`own.accounts ${method}: ${result.status} ${result.type} ${result.message}`)
    return result.output as Record<string, unknown>
  }

  // Limits: ChatGPT 01 has room, 02 is getting tight, 03 is used up (its first request is refused); the Claude
  // subscription's 5-hour window is a third used, DeepSeek has a prepaid balance (polled), both API keys a budget.
  fakes.codex.setUsage(CHATGPT["01"].accountID, { primary: 42, secondary: 18 })
  fakes.codex.setUsage(CHATGPT["02"].accountID, { primary: 81, secondary: 34 })
  fakes.codex.setUsage(CHATGPT["03"].accountID, { primary: 100, secondary: 57 })
  // 02 §7.1.1: 03 holds two reset credits; its refused request reads the count (03 §7.1.1 리셋권). Nothing redeems one.
  const day = 86_400_000
  fakes.codex.setResetCredits(CHATGPT["03"].accountID, [
    {
      id: "credit-demo-weekly",
      granted_at: new Date(Date.now() - 3 * day).toISOString(),
      expires_at: new Date(Date.now() + 9 * day).toISOString(),
      title: "Full reset (Weekly + 5 hr)",
    },
    { id: "credit-demo-open", granted_at: new Date(Date.now() - day).toISOString(), expires_at: null },
  ])
  const now = Math.floor(Date.now() / 1000)
  fakes.anthropic.setUnified(hashSecret(CLAUDE.key), {
    status: "allowed",
    fiveHourUtilization: 0.35,
    sevenDayUtilization: 0.12,
    fiveHourReset: now + 3 * 3600 + 20 * 60,
    sevenDayReset: now + 4 * 86400,
  })
  fakes.deepseek.setBalance(hashSecret(DEEPSEEK.key), { available: true, currency: "USD", total: "7.42" })
  await rpc("accounts.update", { accountID: "acc_tmds", budget: { monthlyUSD: 5 }, pollBalance: true })
  await rpc("accounts.update", { accountID: "acc_tman", budget: { monthlyUSD: 20 } })
  await rpc("accounts.update", { accountID: CLAUDE.accountID, label: L("Claude 구독") })

  const session = (title: string, model: object, directory = project) =>
    team.createSession({ title: L(title), model: model as (typeof MODEL)["01"], directory })
  const sessions: Record<string, string> = {}
  if (folders.pixel) sessions.pixel = await session("스프라이트 내보내기", MODEL["01"], folders.pixel)
  // Oldest first: the sidebar lists the newest on top. The used-up account learns its state from a refused request
  // (a conversation left waiting on the limit); the last turn runs on ChatGPT 01, the new-session default.
  sessions.webhook = await session(
    "결제 웹훅 재시도",
    { providerID: MODEL.anthropic.providerID, id: "claude-opus-5-5" },
    folders.billing,
  )
  await team.turn(sessions.webhook, L("결제 웹훅이 실패하면 다시 보내도록 고쳐 줘"))
  if (TEAM) {
    const at = (name: string) => path.join(folders.shop, ".worktrees", name)
    sessions.shop = await session("가게 정리", MODEL["01"], folders.shop)
    sessions.cart = await session("장바구니 속도", MODEL["01"], at("cl-cart"))
    sessions.search = await session("검색 정확도", MODEL["02"], at("cl-search"))
    sessions.idea = await session("실험 아이디어", MODEL.anthropic, at("cl-x"))
  }
  sessions.sound = await session("효과음 정리", MODEL["03"])
  await team.server.prompt(sessions.sound, L("효과음 파일 이름을 정리해 줘"))
  sessions.menu = await session("메뉴 문구 다듬기", MODEL["02"])
  await team.turn(sessions.menu, L("시작 메뉴 문구를 짧게 다듬어 줘"))
  sessions.hud = await session("HUD 다듬기", { providerID: CLAUDE.model.providerID, id: "claude-opus-5-5" })
  await team.turn(sessions.hud, L("HUD를 더 보기 좋게 다듬을 방법을 알려 줘"))
  sessions.level = await session("레벨 에디터 버그", MODEL.deepseek)
  await team.turn(sessions.level, L("레벨 에디터에서 타일을 지우면 실행 취소가 두 번 필요해요. 원인을 찾아 줘"))
  sessions.map = await session("맵 데이터 정리", MODEL["01"])
  await team.turn(sessions.map, MEDIUM_PROMPT)
  sessions.log = await session("긴 로그 분석", MODEL["01"])
  await team.turn(sessions.log, LONG_PROMPT)
  sessions.fresh = await session("새 대화", MODEL["01"])
  sessions.enemy = await session("적 AI 길찾기 고치기", MODEL["01"])
  await team.turn(sessions.enemy, L("적 AI가 벽에 자꾸 부딪혀요. 길찾기를 고쳐 줄래요?"))
  await team.turn(sessions.enemy, L("고친 부분을 짧게 설명해 줘"))
  // Team mode works from save points: the team world starts with the main folder's change saved.
  if (TEAM) commit(project, "적 AI 길찾기 고치기")
  if (tools) await writeToolStores(tools, project)
  // 10장 설정 > MCP 서버 (SM): one server added in the app (the e2e kit's fake stdio server), tested once so the list
  // shows its tools.
  if (tools) {
    const view = await rpc("mcp.save", {
      name: "files",
      scope: { type: "global" },
      transport: {
        type: "local",
        command: "bun",
        args: [tools.mcp, "read_file", "list_files", "search_files"],
        env: [],
      },
    })
    const added = (view.servers as ReadonlyArray<{ readonly id: string }>)[0]!
    await rpc("mcp.test", { id: added.id, directory: project })
  }

  // Presets: the ChatGPT group's ★ from the `가볍게 나눠 쓰기` starter, and `리뷰는 Claude로` (review on the Claude
  // subscription, then DeepSeek); the DeepSeek group's `DeepSeek 기본`.
  const suggested = await rpc("presets.suggest", { group: "codex", template: "light-split" })
  const light = await savePreset({ ...(suggested.draft as object), name: L("가볍게 나눠 쓰기"), group: "codex" })
  const review = await savePreset({
    name: L("리뷰는 Claude로"),
    group: "codex",
    workers: {
      mode: "by-role",
      roles: {
        explore: { targets: [{ rel: "lighter" }], effort: "inherit" },
        "own-review": {
          targets: [
            { pin: { account: CLAUDE.accountID, model: CLAUDE.model.id } },
            { pin: { account: "acc_tmds", model: MODEL.deepseek.id } },
          ],
          effort: "inherit",
        },
      },
    },
    delegation: "when-useful",
  })
  const deepseek = await savePreset({
    name: L("DeepSeek 기본"),
    group: "ds",
    workers: { mode: "same", roles: {} },
    delegation: "on-request",
  })
  await rpc("presets.defaults.set", {
    group: "codex",
    star: light,
    defaultModel: { id: MODEL["01"].id },
    ...(README ? {} : { lighter: { mainModelID: MODEL["01"].id, model: "gpt-5.3-codex-spark" } }),
  })
  await rpc("presets.defaults.set", { group: "ds", star: deepseek })

  await rpc("session.preset.apply", { sessionID: sessions.enemy, presetID: light }, project)

  async function savePreset(preset: Readonly<Record<string, unknown>>) {
    const saved = await rpc("presets.set", {
      preset: { caps: { concurrent: 3, perMessage: 6, perSession: null }, ultraCaps: null, ...preset },
    })
    const id = (saved.preset as { id?: string } | undefined)?.id
    if (!id) throw new Error(`presets.set returned no id: ${JSON.stringify(saved)}`)
    return id
  }

  // DeepSeek's balance comes from the leader's poller (once a minute): wait for the first reading.
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const snapshot = await rpc("quota.snapshot", { accountIDs: ["acc_tmds"] })
    const windows = (snapshot.windows ?? []) as ReadonlyArray<{ readonly kind?: string }>
    if (windows.some((window) => window.kind === "balance")) break
    await Bun.sleep(2000)
  }

  const password = atob(team.server.authorization.slice("Basic ".length)).slice("opencode:".length)
  Object.assign(process.env, {
    OWN_WEB_API_URL: team.server.url,
    OWN_WEB_API_PASSWORD: password,
    OWN_WEB_CONTROL_DIR: team.control,
  })
  const gateway = GATEWAY ? await startGateway(team, password) : undefined
  const browser = BROWSER ? await startBrowserGateway(team, password) : undefined
  // A local model server (no key, `billing: "local"`) for the phone's account rows and switcher (MUX).
  const local = GATEWAY || README ? startFakeOpenAIChat({ anonymous: true, models: ["qwen3-coder"], responder: scripted }) : undefined
  if (local)
    await rpc("accounts.add.key", {
      kind: "compat",
      label: L("로컬 모델"),
      options: {
        baseURL: local.baseURL,
        local: { format: "chat" },
        models: [{ id: "qwen3-coder", contextLimit: 131_072, outputLimit: 32_000 }],
      },
    })
  return {
    control: team.control,
    root: team.root,
    rpc: team.rpc,
    fakes,
    state: {
      root: team.root,
      control: team.control,
      demo: path.dirname(project),
      home: team.server.paths.home,
      project,
      projects: { space: project, billing: folders.billing, shop: folders.shop, pixel: folders.pixel },
      sessions,
      presets: { light, review, deepseek },
      accounts: {
        "01": "acc_tm01",
        "02": "acc_tm02",
        "03": "acc_tm03",
        deepseek: "acc_tmds",
        anthropic: "acc_tman",
        claude: CLAUDE.accountID,
      },
      chatgpt: CHATGPT,
      models: { ...MODEL, claude: CLAUDE.model },
      areas: AREAS,
      // For the desktop shell's registration (a temp state home): the demo server and its random test password.
      server: { url: team.server.url, password },
      ownHome: team.ownHome,
      // The other tools' stores live in this home (`.codex`, `.claude`): shown as the demo user's home.
      toolsHome: tools?.home,
      // The capture shows the added Claude accounts as after the local patch (own/scripts/manual/lib/claude.ts).
      claudePatched: !TEAM,
      ...(gateway ? { gateway } : {}),
      // The stand-in's device as the gateway knows it (`devices.update{deviceId, scopes}` grants it `browser`).
      ...(browser ? { browser } : {}),
    },
    stop: async () => {
      await team.stop()
      await fakes.stop()
      await local?.stop()
      registry?.stop()
      if (tools) await removeTree(tools.base).catch(() => undefined)
    },
  }
}

/** own-remote with its gateway (OWN_MANUAL_GATEWAY=1): the app listener on loopback, nothing outside this PC probed. */
function gatewayPlugin(ownHome: string) {
  // The browser world's pages come from Vite through the stand-in: its gateway only needs a web root to exist.
  const webRoot = BROWSER ? path.join(TMP, `gateway-web-${NAME}`) : process.env.OWN_MANUAL_GATEWAY_WEB
  if (!webRoot) throw new Error("OWN_MANUAL_GATEWAY=1 needs OWN_MANUAL_GATEWAY_WEB (an own-web build with sw.js)")
  if (BROWSER) {
    mkdirSync(webRoot, { recursive: true })
    void Bun.write(path.join(webRoot, "index.html"), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  }
  return {
    package: path.join(REPO_ROOT, "packages/own-remote"),
    options: {
      home: ownHome,
      // own-team's harness names its plugins' build this way (test/e2e/harness.ts).
      buildId: `e2e-team-${NAME.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}-${process.pid}`,
      version: "2.2.5-own.0",
      lingerSeconds: 0,
      gateway: {
        registration: REGISTRATION,
        webRoot,
        tailscaleCommand: null,
        portproxyCommand: null,
        vault: "memory",
        appLoopbackRoute: true,
      },
    },
  }
}

/** Writes the registration the gateway relays with, then turns the gateway and its app listener on (two-step plan). */
async function startGateway(
  team: { readonly server: { readonly url: string; readonly pid: number }; readonly rpc: TeamRpc },
  password: string,
) {
  await Bun.write(
    REGISTRATION,
    JSON.stringify({ id: "manual", version: "local", url: team.server.url, pid: team.server.pid, password }),
  )
  const call = async (method: string, input: unknown) => {
    const result = await team.rpc("own.remote", method, input)
    if (result.status !== 200)
      throw new Error(`own.remote ${method}: ${result.status} ${result.type} ${result.message}`)
    return result.output as Record<string, unknown>
  }
  const configure = async (input: unknown) => {
    const plan = await call("gateway.configure.plan", input)
    await call("gateway.configure.execute", { nonce: plan.nonce })
  }
  // Never the defaults (28539, 28540): the user's own service may listen there.
  await configure({ port: PORT + 2 })
  await configure({ app: { enabled: true, port: PORT + 3 } })
  const app = (await call("gateway.status", {})).app as { readonly port: number; readonly pcKey: string }
  gatewayRpc = call
  return { port: PORT + 2, appPort: app.port, pcKey: app.pcKey }
}

/** The stand-in's device at the real gateway: what authenticates it there. */
let paired: { readonly origin: string; readonly headers: Readonly<Record<string, string>> } | undefined

/**
 * OWN_MANUAL_BROWSER=1: the gateway's browser listener on loopback and one device paired through the real HTTP flow
 * (the link, the confirmation number, the PC's approval, the claim), with a phone's default scopes: `browser` stays
 * off until a test grants it, as on a real PC.
 */
async function startBrowserGateway(
  team: { readonly server: { readonly url: string; readonly pid: number }; readonly rpc: TeamRpc },
  password: string,
) {
  await Bun.write(
    REGISTRATION,
    JSON.stringify({ id: "manual", version: "local", url: team.server.url, pid: team.server.pid, password }),
  )
  const call = async (method: string, input: unknown) => {
    const result = await team.rpc("own.remote", method, input)
    if (result.status !== 200)
      throw new Error(`own.remote ${method}: ${result.status} ${result.type} ${result.message}`)
    return result.output as Record<string, unknown>
  }
  // Never the default (28539): the user's own service may listen there.
  const plan = await call("gateway.configure.plan", { port: PORT + 2 })
  await call("gateway.configure.execute", { nonce: plan.nonce })
  gatewayRpc = call
  const started = await call("devices.pair.start", {
    name: `${PC}${L("의 휴대폰")}`,
    scopes: ["read", "prompt", "switch"],
    servers: { mode: "all" },
    expiresDays: 7,
  })
  const origin = new URL(String(started.url)).origin
  const opened = await fetch(String(started.url), { redirect: "manual" })
  const pairing = /own_pairing=([^;]+)/.exec(opened.headers.getSetCookie().join("\n"))?.[1]
  if (!pairing) throw new Error(`browser gateway: no pairing cookie (${opened.status})`)
  const cookie = `own_pairing=${pairing}`
  const status = (await (await fetch(`${origin}/own/pairing`, { headers: { cookie } })).json()) as { readonly sas: string }
  await call("devices.pair.approve", { pairingId: started.pairingId, sas: status.sas })
  const claimed = await fetch(`${origin}/own/pairing/claim`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "browser" }),
  })
  const token = /own_device=([^;]+)/.exec(claimed.headers.getSetCookie().join("\n"))?.[1]
  const device = (await claimed.json()) as { readonly deviceId?: string }
  if (!token || !device.deviceId) throw new Error(`browser gateway: the claim failed (${claimed.status})`)
  paired = { origin, headers: { cookie: `own_device=${token}`, origin } }
  return { port: PORT + 2, origin, deviceId: device.deviceId }
}

type TeamRpc = (
  id: string,
  method: string,
  input?: unknown,
  directory?: string,
) => Promise<{ readonly status: number; readonly output?: unknown; readonly type?: string; readonly message?: string }>
let gatewayRpc: ((method: string, input: unknown) => Promise<Record<string, unknown>>) | undefined

/**
 * A temp home with empty `.codex` and `.claude` folders: own-import's only roots in the main world, and own.accounts'
 * Codex and Claude Code homes for MCP 가져오기. `mcp` is a copy of the e2e kit's fake stdio MCP server in that home, so
 * the demo's servers show a path of the demo user's.
 */
async function toolsFolder() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `own-team-e2e-${NAME}-tools-`)))
  const home = path.join(base, "home")
  const folders = {
    base,
    home,
    codex: path.join(home, ".codex"),
    claude: path.join(home, ".claude"),
    mcp: path.join(home, "mcp", "demo-mcp.ts"),
    controlCenter: path.join(home, "codex-multi-provider", "control-center"),
    elsewhere: path.join(home, "shared-skills"),
  }
  await Promise.all(
    [folders.codex, folders.claude, path.dirname(folders.mcp)].map((folder) => fs.mkdir(folder, { recursive: true })),
  )
  await fs.copyFile(FAKE_MCP_STDIO, folders.mcp)
  return folders
}

/**
 * Three Codex conversations and one Claude Code conversation that were held in `space-game` before own opened it
 * (21장's list, viewer and `이어서 하기`). Synthetic records from own-import's fixture builders, an hour to three days
 * old so none is `진행 중일 수 있음`; the Codex state DB gives the titles.
 */
async function writeToolStores(
  tools: {
    readonly home: string
    readonly codex: string
    readonly claude: string
    readonly mcp: string
    readonly controlCenter: string
    readonly elsewhere: string
  },
  cwd: string,
) {
  // 10장 MCP 가져오기 (SM): a Codex server with a value, a Claude Code server and an old SSE one (made-up values).
  await Bun.write(
    path.join(tools.codex, "config.toml"),
    [
      "[mcp_servers.docs-search]",
      'command = "bun"',
      `args = [${JSON.stringify(tools.mcp)}, "search_docs", "read_page"]`,
      "[mcp_servers.docs-search.env]",
      'DOCS_API_KEY = "demo-docs-key-0000-AbCd"',
      "",
    ].join("\n"),
  )
  await Bun.write(
    path.join(tools.home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "issue-tracker": {
          command: "bun",
          args: [tools.mcp, "list_issues", "create_issue"],
          env: { TRACKER_TOKEN: "demo-tracker-token-0000-EfGh" },
        },
        "old-sse": { type: "sse", url: "https://mcp.example.com/sse" },
      },
    }),
  )
  // 10장's skills import: one skill of each source and status the `가져오기` tab shows (made-up skills). SK2: two
  // codex-multi-provider accounts (`work` holds the same release-notes, `side` another one, version 2.0.0) and a
  // skill linked in from a folder outside the roots, waiting for its checkbox.
  const releaseNotes = {
    "SKILL.md": skillMd(
      "release-notes",
      "커밋 기록으로 릴리스 노트 초안을 씁니다",
      "version: 1.2.0\nlicense: MIT\n",
      [
        "# 릴리스 노트 쓰기",
        "",
        "1. 지난 태그 뒤의 커밋을 모아요: `python scripts/collect.py`",
        "2. **기능**, **수정**, **문서**로 나눠 한 줄씩 적어요.",
        "3. 사용자에게 보이는 변화만 남겨요.",
        "",
      ].join("\n"),
    ),
    "scripts/collect.py": "print('release notes')\n",
  }
  const accounts = ["01", "02"].map((id) => path.join(tools.controlCenter, "profiles", id, "codex"))
  await Bun.write(
    path.join(tools.controlCenter, "state.json"),
    JSON.stringify({
      version: 1,
      profiles: [
        { id: "01", alias: "work" },
        { id: "02", alias: "side" },
      ],
    }),
  )
  const outside = await skillFolder(path.join(tools.elsewhere, "3d-assets"), {
    "SKILL.md": skillMd("3d-assets", "게임에 쓸 3D 에셋을 만듭니다"),
    "models/cube.obj": "v 0 0 0\n",
  })
  await fs.mkdir(path.join(tools.codex, "skills"), { recursive: true })
  await fs.symlink(outside, path.join(tools.codex, "skills", "3d-assets"), "junction")
  await Promise.all([
    codexSkill(tools.codex, "release-notes", { files: releaseNotes }),
    codexSkill(accounts[0]!, "release-notes", { files: releaseNotes }),
    codexSkill(accounts[1]!, "release-notes", {
      files: {
        "SKILL.md": skillMd("release-notes", "릴리스 노트를 표로 씁니다", "version: 2.0.0\n"),
        "scripts/collect.py": "print('release notes 2')\n",
      },
    }),
    codexSkill(tools.codex, "imagegen", {
      system: true,
      yaml: "policy:\n  allow_implicit_invocation: false\n",
      files: { "SKILL.md": skillMd("imagegen", "그림 파일을 만들 때 씁니다") },
    }),
    claudeSkill(tools.claude, "code-review", {
      "SKILL.md": skillMd("code-review", "바뀐 코드를 체크리스트로 리뷰합니다"),
      "checklist.md": "# 체크리스트\n",
    }),
    pluginSkill(tools.claude, {
      market: "demo-market",
      plugin: "writing",
      name: "writing-rules",
      installed: true,
      files: { "SKILL.md": skillMd("writing-rules", "문서를 쓸 때 지킬 규칙") },
    }),
    pluginSkill(tools.claude, {
      market: "demo-market",
      plugin: "plugin-dev",
      name: "hook-development",
      installed: false,
      files: {
        "SKILL.md": skillMd(
          "hook-development",
          "훅을 만드는 방법",
          "allowed-tools: Read\n",
          "Run ${CLAUDE_PLUGIN_ROOT}/x.sh\n",
        ),
      },
    }),
  ])
  const now = Date.now()
  const hour = 3_600_000
  const codex = async (n: number, records: ReadonlyArray<{ readonly timestamp?: string }>) => {
    const at = Date.parse(records[0]?.timestamp ?? "")
    const last = Date.parse(records.at(-1)?.timestamp ?? "")
    return writeJsonl(codexRollout(tools.codex, { id: threadId(n), at }), records, { mtime: new Date(last) })
  }
  const bullet = await codex(
    1,
    rollout({ start: now - 2 * hour })
      .meta({ id: threadId(1), cwd, branch: "main" })
      .turnContext({ model: "gpt-5.5", cwd, turnId: "bullet-0" })
      .user("총알이 얇은 벽을 뚫고 지나가요. 충돌 판정을 고쳐 줘")
      .assistant("충돌을 검사하는 코드를 먼저 찾아볼게요.", "commentary")
      .call("shell", { command: ["rg", "-n", "collide", "src"] }, "call_bullet_0")
      .output("call_bullet_0", "src/game.ts:42:export function collide(a: Body, b: Body) {")
      .assistant(
        "총알이 빠르면 한 프레임에 벽을 건너뛰어서 생기는 문제예요. 이동 경로를 잘게 나눠 검사하도록 `collide`를 고쳤어요.",
      )
      .user("테스트도 돌려 줘")
      .call("shell", { command: ["bun", "test"] }, "call_bullet_1")
      .output("call_bullet_1", "12 pass\n0 fail")
      .assistant("테스트 12개가 모두 통과했어요.")
      .records(),
  )
  const scores = await codex(
    2,
    rollout({ start: now - 26 * hour })
      .meta({ id: threadId(2), cwd, branch: "main" })
      .turnContext({ model: "gpt-5.5", cwd, turnId: "scores-0" })
      .user("점수판을 파일 대신 SQLite에 저장하도록 바꿔 줘")
      .assistant("점수 저장 부분을 `src/scores.ts` 하나로 모으고 SQLite 테이블에 쓰도록 바꿨어요.")
      .user("예전 점수 파일도 옮겨 줄래?")
      .call("shell", { command: ["bun", "run", "migrate-scores"] }, "call_scores_0")
      .output("call_scores_0", "옮긴 점수 128개")
      .assistant("예전 점수 128개를 새 테이블로 옮겼어요.")
      .records(),
  )
  const lobby = await codex(
    3,
    rollout({ start: now - 74 * hour })
      .meta({ id: threadId(3), cwd, branch: "main" })
      .turnContext({ model: "gpt-5.5", cwd, turnId: "lobby-0" })
      .user("로비 접속이 가끔 끊겨요. 원인을 찾아 줘")
      .assistant(
        "재접속할 때 이전 연결을 닫지 않아서 같은 방에 두 번 들어가는 경우가 있어요. 닫고 다시 붙도록 고쳤어요.",
      )
      .records(),
  )
  stateDb(tools.codex, {
    keepOpen: false,
    threads: [
      { file: bullet, n: 1, title: "총알이 벽을 뚫는 문제", at: now - 2 * hour },
      { file: scores, n: 2, title: "점수판 저장 방식 정리", at: now - 26 * hour },
      { file: lobby, n: 3, title: "로비 접속 끊김", at: now - 74 * hour },
    ].map((row) => ({
      id: threadId(row.n),
      rollout_path: row.file,
      cwd,
      title: row.title,
      model: "gpt-5.5",
      created_at_ms: row.at,
      updated_at_ms: row.at + 60_000,
    })),
  })

  const id = "5ca1ab1e-0000-4000-8000-000000000001"
  const boss = session({ cwd, id, version: "2.1.288", branch: "main", start: now - 5 * hour })
  boss.user("보스가 공격 세 가지를 번갈아 쓰게 설계해 줘")
  boss.assistant([text("돌진, 탄막, 소환을 차례로 쓰고 체력이 절반 아래면 간격을 줄이는 방식을 제안할게요.")], {
    id: "msg_DEMO_BOSS1",
    model: "claude-opus-5-5",
  })
  boss.user("그대로 만들고 테스트해 줘")
  boss.assistant([toolUse("toolu_DEMO_BOSS1", "Bash", { command: "bun test src/boss" })], {
    id: "msg_DEMO_BOSS2",
    model: "claude-opus-5-5",
  })
  boss.result("toolu_DEMO_BOSS1", "8 pass", { toolUseResult: { stdout: "8 pass", stderr: "" } })
  boss.assistant([text("보스 패턴을 `src/boss.ts`에 넣었고 테스트 8개가 통과했어요.")], {
    id: "msg_DEMO_BOSS3",
    model: "claude-opus-5-5",
  })
  boss.meta({ type: "custom-title", customTitle: "보스 공격 패턴 설계" })
  const stamps = boss
    .records()
    .flatMap((record) => (typeof record.timestamp === "string" ? [Date.parse(record.timestamp)] : []))
  await writeJsonl(claudeSession(tools.claude, cwd, id), boss.records(), { mtime: new Date(Math.max(...stamps)) })
}

async function emptyWorld() {
  const codex = startFakeCodex({})
  const deepseek = startFakeOpenAIChat({})
  const auth = startFakeChatGPTAuth({ codex })
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `own-team-e2e-${NAME}-`)))
  const legacy = await createLegacyApp(path.join(base, "legacy"))
  await writeCodexMultiProviderProfiles(legacy.controlCenter, [
    { id: "03", alias: "회사 Plus", tokens: codex.login({ accountID: "acct-demo-work", plan: "plus" }) },
    { id: "05", alias: "개인 백업", tokens: codex.login({ accountID: "acct-demo-home", plan: "plus" }) },
  ])
  await writeLegacyDeepSeek(legacy, { key: "sk-demo-legacy-deepseek-0001", seal: "fake" })
  const demo = path.join(base, "project")
  const project = spaceGame(demo)
  billingService(demo)
  const server = await startOpencodeServer({
    root: path.join(base, "server"),
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) =>
      opencodeConfig({
        providers: {},
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: {
              home: paths.ownHome,
              buildId: `own-manual-empty-${process.pid}`,
              vault: "memory",
              ratecardsSeed: RATECARDS,
              endpoints: {
                codex: codex.baseURL,
                oauthIssuer: auth.url,
                chatgpt: `${codex.url}/backend-api`,
                openai: `${codex.url}/v1`,
                deepseek: deepseek.baseURL,
              },
              codexImportRoot: legacy.controlCenter,
            },
          },
        ],
      }),
  })
  const control = path.join(server.paths.ownHome, "control")
  await fs.mkdir(control, { recursive: true })
  const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
  Object.assign(process.env, {
    OWN_WEB_API_URL: server.url,
    OWN_WEB_API_PASSWORD: password,
    OWN_WEB_CONTROL_DIR: control,
  })
  return {
    control,
    root: base,
    rpc: undefined,
    fakes: undefined,
    state: { root: base, control, demo, home: server.paths.home, project, projects: { space: project } },
    stop: async () => {
      await server.stop()
      await Promise.allSettled([codex.stop(), deepseek.stop(), auth.stop()])
      await removeTree(base).catch(() => undefined)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Phone stand-in and the capture script's controls.

const DROPPED = new Set(["host", "connection", "content-length", "transfer-encoding", "content-encoding"])

/** One viewer socket of the page, relayed to the gateway (OWN_MANUAL_BROWSER=1). */
interface ViewerRelay {
  readonly upstream: WebSocket
  /** What the gateway sent before the page's side was open. */
  readonly early: Array<string | ArrayBuffer>
  client?: Bun.ServerWebSocket<ViewerRelay>
}

/**
 * The page's viewer socket, relayed with the stand-in's device cookie. The gateway is asked first: what it refuses
 * before the upgrade (no `browser` scope, an unknown session) fails the page's handshake too, as on a real gateway.
 */
async function relayViewer(request: Request, server: Bun.Server<ViewerRelay>, url: URL) {
  if (!paired) return new Response("no gateway", { status: 404 })
  const upstream = new WebSocket(`${paired.origin.replace(/^http/, "ws")}${url.pathname}`, {
    headers: paired.headers,
  } as never)
  upstream.binaryType = "arraybuffer"
  const data: ViewerRelay = { upstream, early: [] }
  upstream.onmessage = (event) => {
    const message = event.data as string | ArrayBuffer
    if (data.client) data.client.send(message)
    else data.early.push(message)
  }
  const opened = await new Promise<boolean>((resolve) => {
    upstream.onopen = () => resolve(true)
    upstream.onclose = () => resolve(false)
    upstream.onerror = () => resolve(false)
  })
  if (!opened) return new Response("refused", { status: 403 })
  // 1005 and 1006 are not codes a server may send.
  upstream.onclose = (event) =>
    data.client?.close(event.code === 1005 || event.code === 1006 ? 1011 : event.code, event.reason)
  if (server.upgrade(request, { data })) return undefined
  upstream.close()
  return new Response("not a socket", { status: 426 })
}

/** The page's event streams (`GET /srv/local/api/event`), so `POST /manual/event` can add a frame to them. */
const eventStreams = new Set<(frame: string) => void>()

function tapEvents(body: ReadableStream<Uint8Array>) {
  const encoder = new TextEncoder()
  const reader = body.getReader()
  const waiting: string[] = []
  // A frame is added only between the server's own frames (each ends with an empty line).
  const state = { whole: true }
  const sink: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
  const push = (frame: string) => {
    if (state.whole) sink.controller?.enqueue(encoder.encode(frame))
    else waiting.push(frame)
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      sink.controller = controller
      eventStreams.add(push)
    },
    async pull(controller) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) {
        eventStreams.delete(push)
        return controller.close()
      }
      controller.enqueue(next.value)
      state.whole = next.value.at(-1) === 10 && next.value.at(-2) === 10
      if (state.whole) waiting.splice(0).forEach(push)
    },
    cancel() {
      eventStreams.delete(push)
      return reader.cancel()
    },
  })
}

function startDevice() {
  return Bun.serve<ViewerRelay>({
    hostname: "127.0.0.1",
    port: DEVICE_PORT,
    idleTimeout: 0,
    websocket: {
      open(socket) {
        socket.data.client = socket
        socket.data.early.splice(0).forEach((message) => socket.send(message))
        if (socket.data.upstream.readyState > 1) socket.close(1011)
      },
      message: (socket, message) => socket.data.upstream.send(message),
      close: (socket) => socket.data.upstream.close(),
    },
    fetch: async (request, server) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/own/browser/") && request.headers.get("upgrade")?.toLowerCase() === "websocket")
        return relayViewer(request, server, url)
      if (url.pathname.startsWith("/manual/site/")) return site(url.pathname.slice("/manual/site/".length))
      if (url.pathname.startsWith("/manual/")) return control(url.pathname.slice("/manual/".length), request)
      // With a real gateway behind it the device has the scopes the gateway holds (a refusal passes through).
      const real =
        paired && url.pathname === "/own/device"
          ? await fetch(`${paired.origin}/own/device`, { headers: paired.headers })
          : undefined
      if (real && !real.ok)
        return new Response(real.body, { status: real.status, headers: { "content-type": "application/json" } })
      if (url.pathname === "/own/device")
        return Response.json({
          deviceId: "dev_demo_phone",
          name: `${PC}${L("의 휴대폰")}`,
          kind: "browser",
          scopes: real
            ? ((await real.json()) as { readonly scopes: readonly string[] }).scopes
            : ["read", "prompt", "switch"],
          servers: { mode: "all" },
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          controlDir: world.control,
          pc: PC,
        })
      if (url.pathname === "/own/servers")
        return Response.json({
          servers: [
            { serverKey: "local", name: "local", baseUrl: "/srv/local", controlDir: world.control, state: "ready" },
          ],
        })
      const relay = /^\/srv\/local(\/api\/.*)$/.exec(url.pathname)
      const target = relay
        ? new URL(`${relay[1]}${url.search}`, process.env.OWN_WEB_API_URL)
        : new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${PORT}`)
      const headers = new Headers(
        [...request.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase())),
      )
      if (relay) headers.set("authorization", `Basic ${btoa(`opencode:${process.env.OWN_WEB_API_PASSWORD}`)}`)
      const answer = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
      })
      const copied = [...answer.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase()))
      if (BROWSER && relay && answer.body && (answer.headers.get("content-type") ?? "").includes("text/event-stream"))
        return new Response(tapEvents(answer.body), { status: answer.status, headers: copied })
      if (relay || !(answer.headers.get("content-type") ?? "").includes("text/html"))
        return new Response(answer.body, { status: answer.status, headers: copied })
      const page = (await answer.text()).replace("<head>", '<head><meta name="own-gateway" content="1">')
      return new Response(page, { status: answer.status, headers: copied })
    },
  })
}

/** The scoreboard page of 19장: `새 게임` starts a game after a while, `slow` never says it is done. */
function site(rest: string) {
  if (rest === "scores.csv")
    return new Response(`rank,name,score\n1,${L("별빛")},12480\n2,${L("혜성")},11020\n3,${L("은하")},9870\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="scores.csv"',
      },
    })
  const style = [
    'body{font:16px "Malgun Gothic",sans-serif;background:#0b1020;color:#e8ecff;margin:0;padding:32px}',
    "h1{font-size:26px;margin:0 0 16px}table{border-collapse:collapse;min-width:360px}",
    "td,th{padding:8px 14px;border-bottom:1px solid #26305a;text-align:left}",
    "button{margin-top:18px;padding:8px 16px;border-radius:8px;border:0;background:#5b7cff;color:#fff;font-size:15px}",
    "a{color:#9fb4ff}#state{margin-top:14px;color:#ffd479}",
  ].join("")
  const start = "document.getElementById('state').textContent"
  const body =
    rest === "slow"
      ? "<h1>결과 집계 중…</h1><p>잠시만 기다려 주세요.</p>"
      : [
          `<h1>🚀 ${L("우주 게임 점수판")}</h1><table><tr><th>${L("순위")}</th><th>${L("이름")}</th><th>${L("점수")}</th></tr>`,
          `<tr><td>1</td><td>${L("별빛")}</td><td>12,480</td></tr><tr><td>2</td><td>${L("혜성")}</td><td>11,020</td></tr>`,
          `<tr><td>3</td><td>${L("은하")}</td><td>9,870</td></tr></table>`,
          `<button onclick="${start}='${L("게임 준비 중…")}';setTimeout(()=>${start}='${L("게임 시작!")}',25000)">${L("새 게임")}</button>`,
          `<p id="state"></p><p><a href="scores.csv" download>${L("점수 내려받기")}</a></p>`,
        ].join("")
  return new Response(
    `<!doctype html><html lang="${EN ? "en" : "ko"}"><meta charset="utf-8"><title>${L("우주 게임 점수판")}</title><style>${style}</style>${body}</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )
}

async function control(action: string, request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const fakes = world.fakes
  if (action === "usage" && fakes) {
    const id = String(body.id) as keyof typeof CHATGPT
    fakes.codex.setUsage(CHATGPT[id].accountID, body.usage as { primary?: number; secondary?: number })
    return Response.json({ ok: true })
  }
  if (action === "balance" && fakes) {
    fakes.deepseek.setBalance(String(body.domain), body.balance as never)
    return Response.json({ ok: true })
  }
  if (action === "enqueue" && fakes) {
    const provider = String(body.provider) as "codex" | "deepseek" | "anthropic"
    fakes[provider].enqueue(body.reply as Reply)
    return Response.json({ ok: true })
  }
  if (action === "deepseek-domains" && fakes)
    return Response.json({ domains: [...new Set(fakes.deepseek.requests.map((item) => item.identity))] })
  if (action === "remove-folder") {
    const target = path.resolve(String(body.path))
    if (!target.startsWith(path.resolve(world.root) + path.sep))
      return Response.json({ ok: false, error: "outside the demo root" }, { status: 400 })
    await removeTree(target)
    return Response.json({ ok: true })
  }
  if (action === "save") {
    // A save point in a demo folder (an area's work the screenshots integrate), never outside the demo root.
    const dir = path.resolve(String(body.dir))
    if (!dir.startsWith(path.resolve(world.root) + path.sep))
      return Response.json({ ok: false, error: "outside the demo root" }, { status: 400 })
    write(dir, body.files as Record<string, string>)
    commit(dir, String(body.message ?? "change"))
    return Response.json({ ok: true })
  }
  if (action === "app-link" && gatewayRpc) {
    // A loopback pairing link for an Android app behind `adb reverse` (the PC still has to press 허용).
    const started = await gatewayRpc("devices.pair.start", {
      name: String(body.name ?? "모바일 점검 휴대폰"),
      scopes: ["read", "prompt", "switch"],
      servers: { mode: "all" },
      expiresDays: 7,
      appRoute: "loopback",
    })
    return Response.json({ link: started.appLink })
  }
  if (action === "event" && BROWSER) {
    // One server event for the page (`{type, data}`), as the service would frame it.
    const frame = `data: ${JSON.stringify({ id: `evt_manual${Date.now()}`, created: Date.now(), ...(body.event as object) })}\n\n`
    eventStreams.forEach((push) => push(frame))
    return Response.json({ ok: true, streams: eventStreams.size })
  }
  if (action === "rpc" && world.rpc) {
    const result = await world.rpc(String(body.id), String(body.method), body.input, body.directory as string)
    return Response.json(result)
  }
  return Response.json({ ok: false, error: `unknown action ${action}` }, { status: 404 })
}

/** About 40k tokens: a conversation in the middle band of the switch policy (20k–100k, the apply button's price). */
const MEDIUM_PROMPT = [
  L("맵 데이터를 정리해 줘."),
  ...Array.from(
    { length: 3_200 },
    (_, line) =>
      `map=${line % 40} tile=${(line * 13) % 64} x=${line % 40} y=${(line * 7) % 24} kind=${line % 3 ? "floor" : "wall"}`,
  ),
].join("\n")

/** About 118k tokens by the fakes' and core's chars/4 estimate (own-web dev service's long prompt). */
const LONG_PROMPT = [
  L("이 로그를 요약해 줘."),
  ...Array.from(
    { length: 6_000 },
    (_, line) =>
      `[${String(line).padStart(5, "0")}] worker=${line % 7} status=ok latency=${(line * 37) % 900}ms path=/api/match/${line}/state retry=0`,
  ),
].join("\n")

// ---------------------------------------------------------------------------------------------------------------

const world = WORLD === "empty" ? await emptyWorld() : await mainWorld()

const dev = await startViteDev({ port: PORT, hmr: false })
const device = startDevice()

const state = {
  world: WORLD,
  dev: `http://127.0.0.1:${PORT}`,
  device: `http://127.0.0.1:${DEVICE_PORT}`,
  pc: PC,
  ...world.state,
}
await fs.mkdir(TMP, { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_MANUAL_READY ${JSON.stringify(state)}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await device.stop(true)
  await dev.close().catch(() => undefined)
  await world.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

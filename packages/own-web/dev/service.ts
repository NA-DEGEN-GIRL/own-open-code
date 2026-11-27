// Development service for own-web (integrator, P3): the real upstream server from source with own.accounts, own.team
// and own.telemetry (packages/own-accounts/test/e2e-kit), fake providers and a fake old-app profile, so every screen
// has data without a real account:
//
//   fake OpenAI Responses (x-ratelimit-* headers)  ← chunking proxy (one answer → many deltas, visible streaming)
//   fake ChatGPT Codex backend + fake ChatGPT OAuth issuer (device login, x-codex-* 5 h / 7 d windows)
//   fake codex-multi-provider control center (2 profiles) = `codexImportRoot` (never the real old-app profiles)
//
// Accounts are created through RPC exactly as the UI does (02 §9): "Alpha" and "Bravo" (oai keys), "개인 Pro"
// (codex, device login against the fake issuer). A few sessions are seeded across two project folders, and one
// codex turn runs so the limits surfaces have measured windows. Fake credentials only; everything lives in one temp
// root that `stop()` removes.
//
// Plugin order is the release order (06 §2.6, 09 §5.1): own.accounts, own.remote (`remote`), own.team in the third
// slot, own.telemetry, then own.import (own.computer-use, when a config loads it, goes before own.import) and own.harness
// last (`harness`). own.team, own.import and own.accounts' preset guidance reach the service over self-HTTP through the
// local channel's registration file, written into the temp root after the boot like the installed service writes it
// (ServiceTarget.Service).
//
// own.import reads synthetic Codex and Claude Code stores in the temp root (`importRoots`), written with own-import's
// test fixtures after the boot, for the workspace and the second project. It reads this PC's real `~/.codex` and
// `~/.claude` (`$CODEX_HOME`, `$CLAUDE_CONFIG_DIR`) only when OWN_IMPORT_REAL_ROOTS=1, and never writes there. The same
// synthetic roots hold a few skills for the skills popover's `가져오기` tab (09 §9): Codex (one bundled, converted),
// Claude Code, an installed plugin and a marketplace copy that does not fit own.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startFakeChatGPTAuth } from "../../own-accounts/test/e2e-kit/fakes/chatgpt-auth"
import { startFakeCodex } from "../../own-accounts/test/e2e-kit/fakes/codex"
import { startFakeOpenAIResponses } from "../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { parseSse, sseResponse, type RecordedRequest, type Reply } from "../../own-accounts/test/e2e-kit/fakes/shared"
import { writeCodexMultiProviderProfiles } from "../../own-accounts/test/e2e-kit/fixtures/codex-multi-provider"
import { opencodeConfig } from "../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer, type ModelRef } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { claudeSession, codexRollout, writeJsonl } from "../../own-import/test/fixtures/make"
import { claudeSkill, codexSkill, pluginSkill, skillMd } from "../../own-import/test/fixtures/skills"
import { registrationPath } from "../vite/dev-api"

export const MODEL = "gpt-5.5"
/** The device login's model: ChatGPT accounts run no gpt-5.5 and older since upstream v2.1 (Codex's filter). */
export const CODEX_MODEL = "gpt-5.6-sol"

// Fake credentials only.
const KEYS = {
  alpha: "sk-proj-ownDevAlphaFakeKey000000000000000001",
  bravo: "sk-proj-ownDevBravoFakeKey000000000000000002",
}
const DEVICE = { accountID: "acct-own-dev-device", userID: "user-own-dev", email: "dev@example.test", plan: "pro" }
const LEGACY = [
  { id: "03", alias: "회사 Plus", account: { accountID: "acct-own-dev-legacy-work", plan: "plus" } },
  { id: "05", alias: "개인 백업", account: { accountID: "acct-own-dev-legacy-home", plan: "plus" } },
] as const

export interface DevServiceOptions {
  /** Pause between streamed answer chunks (default 30 ms, about 30 chunks/s). */
  readonly chunkDelayMs?: number
  /** Extra child environment, e.g. `OPENCODE_WEB_APP` for the P-002 check. */
  readonly env?: Readonly<Record<string, string>>
  readonly printLogs?: boolean
  /** Seed sessions and the codex turn (default true). */
  readonly seed?: boolean
  /**
   * Also load own.remote (local mode, no hosts) like a release config (own-accounts, own-remote, own-telemetry): the
   * sidebar's `hosts.list` then answers instead of failing with 400 for a missing RPC. No ~/.ssh, no Tailscale probe.
   */
  readonly remote?: boolean
  /**
   * Also load own.harness last, as a release config lists it (own-accounts `plugins/inventory.ts`): the app's startup
   * `own.harness list` then answers instead of failing with 400 for a missing RPC, and new top-level sessions get its
   * default harness (codex).
   */
  readonly harness?: boolean
}

export interface DevAccount {
  readonly id: string
  readonly providerID: string
  readonly label: string
}

export type DevService = Awaited<ReturnType<typeof startDevService>>

export async function startDevService(options: DevServiceOptions = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-web-dev-")))
  const legacyRoot = path.join(root, "legacy-control-center")
  const responses = startFakeOpenAIResponses({
    models: [MODEL],
    rateLimits: { requests: 500, tokens: 400_000 },
    responder: reply,
  })
  const proxy = chunkingProxy(responses.url, options.chunkDelayMs ?? 30)
  const codex = startFakeCodex({ responder: reply })
  const auth = startFakeChatGPTAuth({ codex })
  await writeCodexMultiProviderProfiles(
    legacyRoot,
    LEGACY.map((profile) => ({ id: profile.id, alias: profile.alias, tokens: codex.login(profile.account) })),
  )
  const realImport = process.env.OWN_IMPORT_REAL_ROOTS === "1"
  const fixtureRoots = { codex: path.join(root, "import", "codex"), claude: path.join(root, "import", "claude") }
  const importRoots = realImport
    ? {
        codex: [process.env.CODEX_HOME || path.join(os.homedir(), ".codex")],
        claude: [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")],
      }
    : { codex: [fixtureRoots.codex], claude: [fixtureRoots.claude] }

  const server = await startOpencodeServer({
    env: { OWN_OPEN_CODE: "1", ...options.env },
    printLogs: options.printLogs,
    config: (paths) =>
      opencodeConfig({
        providers: {},
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: {
              home: paths.ownHome,
              buildId: `own-web-dev-${process.pid}`,
              vault: "memory",
              ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
              endpoints: { openai: `${proxy.url}/v1`, codex: codex.baseURL, oauthIssuer: auth.url },
              // Never the real old-app control center (02 §3.2a): a fake profile tree in this temp root.
              codexImportRoot: legacyRoot,
            },
          },
          ...(options.remote
            ? [
                {
                  package: path.join(REPO_ROOT, "packages/own-remote"),
                  options: {
                    home: paths.ownHome,
                    buildId: `own-web-dev-${process.pid}`,
                    lingerSeconds: 0,
                    sshDir: path.join(root, "ssh"),
                    gateway: { tailscaleCommand: null },
                  },
                },
              ]
            : []),
          {
            package: path.join(REPO_ROOT, "packages/own-team"),
            options: { home: paths.ownHome, buildId: `own-web-dev-${process.pid}` },
          },
          {
            package: path.join(REPO_ROOT, "packages/own-telemetry"),
            options: { home: paths.ownHome, buildId: `own-web-dev-${process.pid}` },
          },
          // After the others but own.harness (09 §5.1). `roots` replaces both default roots, so own.import reads only
          // `importRoots`.
          {
            package: path.join(REPO_ROOT, "packages/own-import"),
            options: { home: paths.ownHome, buildId: `own-web-dev-${process.pid}`, roots: importRoots },
          },
          ...(options.harness ? [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }] : []),
        ],
      }),
  })
  // The launcher creates the empty control directory (02 §9.1).
  const control = path.join(server.paths.ownHome, "control")
  const secondProject = path.join(root, "projects", "billing-service")
  await Promise.all([fs.mkdir(control, { recursive: true }), fs.mkdir(secondProject, { recursive: true })])
  // own.import reads its roots only on the first list, so writing them after the boot is in time.
  if (!realImport) await writeImportStores({ ...fixtureRoots, workspace: server.paths.workspace, secondProject })
  const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
  // `service-local.json` under the server's XDG_STATE_HOME (in the temp root): the self-HTTP target of own.team.
  const registration = registrationPath({ XDG_STATE_HOME: path.dirname(server.paths.state) })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await Bun.write(registration, JSON.stringify({ url: server.url, password }))

  async function rpc(method: string, input: unknown, directory = control) {
    const response = await server.request("POST", `/api/rpc/own.accounts/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const body = (await response.json()) as { output?: Record<string, unknown> }
    if (!response.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
    return body.output ?? {}
  }

  const accountOf = (output: Record<string, unknown>, label: string): DevAccount => {
    const account = output.account as { id: string; providerID: string }
    return { id: account.id, providerID: account.providerID, label }
  }
  const alpha = accountOf(await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: KEYS.alpha }), "Alpha")
  const bravo = accountOf(await rpc("accounts.add.key", { kind: "oai", label: "Bravo", key: KEYS.bravo }), "Bravo")
  const started = await rpc("accounts.add.chatgpt.start", { method: "device" })
  auth.approve(String(started.userCode), DEVICE)
  await until(async () => {
    const status = await rpc("accounts.add.chatgpt.status", { attemptID: started.attemptID })
    return status.phase === "authorized" ? true : undefined
  })
  const device = accountOf(
    await rpc("accounts.add.chatgpt.complete", { attemptID: started.attemptID, label: "개인 Pro" }),
    "개인 Pro",
  )
  const ref = (account: DevAccount): ModelRef => ({
    providerID: account.providerID,
    id: account === device ? CODEX_MODEL : MODEL,
  })
  await server.waitForModels([alpha, bravo, device].map(ref))

  const sessions: { id: string; title: string; account: string; directory: string }[] = []
  if (options.seed !== false) {
    // 5 h window at 42 %, 7 d at 18 % before the seeded codex turn, so the limits tab shows real bars.
    codex.setUsage(DEVICE.accountID, { primary: 41, secondary: 17.9 })
    // "긴 문맥 세션" carries about 125k tokens of context, so switching it away crosses the 100k dialog threshold of
    // the default policy (03 §6.2) and opens the cost dialog.
    const plan = [
      { title: "계정 라우터 RPC 설계", account: alpha, directory: server.paths.workspace, prompts: SEED_PROMPTS },
      { title: "결제 웹훅 재시도", account: bravo, directory: secondProject, prompts: SEED_PROMPTS.slice(0, 1) },
      {
        title: "Codex 한도 확인",
        account: device,
        directory: server.paths.workspace,
        prompts: SEED_PROMPTS.slice(0, 1),
      },
      { title: "긴 문맥 세션", account: alpha, directory: server.paths.workspace, prompts: [LONG_PROMPT] },
      { title: "own-web 뼈대", account: alpha, directory: server.paths.workspace, prompts: [] },
    ]
    for (const item of plan) {
      const session = await server.createSession({
        title: item.title,
        model: ref(item.account),
        directory: item.directory,
      })
      for (const text of item.prompts) {
        await server.call("POST", `/api/session/${session.id}/prompt`, { body: { text }, directory: item.directory })
        await server.call("POST", `/api/experimental/session/${session.id}/wait`, { directory: item.directory })
      }
      sessions.push({ id: session.id, title: item.title, account: item.account.label, directory: item.directory })
    }
  }

  return {
    root,
    server,
    /** Server password, for the Vite proxy and the temp root's registration file only (never in state files). */
    password,
    control,
    workspace: server.paths.workspace,
    secondProject,
    legacyRoot,
    /** The roots own.import reads: synthetic stores in the temp root unless OWN_IMPORT_REAL_ROOTS=1. */
    importRoots,
    model: MODEL,
    accounts: { alpha, bravo, device },
    legacy: LEGACY.map((profile) => ({ id: profile.id, alias: profile.alias })),
    sessions,
    fakes: { responses, codex, auth },
    rpc,
    async stop() {
      await server.stop()
      await Promise.allSettled([responses.stop(), codex.stop(), auth.stop(), proxy.stop(true)])
      await removeTree(root).catch(() => undefined)
    },
  }
}

const SEED_PROMPTS = ["전환 비용 추정이 어떻게 계산되는지 설명해 줘", "캐시가 식으면 어떤 차이가 있어?"]
/** About 118k tokens by the fakes' and core's chars/4 estimate. */
const LONG_PROMPT = [
  "이 로그를 요약해 줘.",
  ...Array.from(
    { length: 6_000 },
    (_, line) =>
      `[${String(line).padStart(5, "0")}] worker=${line % 7} status=ok latency=${(line * 37) % 900}ms path=/api/session/${line}/prompt retry=0`,
  ),
].join("\n")

/**
 * The conversations of the synthetic stores: per tool two in the workspace and one in the second project, one Codex
 * rollout compressed (`.jsonl.zst`, like Codex's older files). Text only, no secrets.
 */
const IMPORT_CONVERSATIONS = [
  {
    kind: "codex",
    project: "workspace",
    title: "가져오기 목록 화면 초안",
    turns: [
      {
        user: "own-web에 다른 도구 대화 목록을 붙이려면 어디부터 보면 돼?",
        tool: {
          command: "rg --files src/sidebar",
          output: "src/sidebar/rows.tsx\nsrc/sidebar/flags.ts\nsrc/sidebar/search.tsx\n",
        },
        answer: "사이드바의 `rows.tsx`와 `flags.ts`부터 보세요. 목록 줄과 표시가 거기 있습니다.",
      },
      { user: "목록의 둘째 줄에는 뭘 보여 줘?", answer: "첫 실제 사용자 요청을 120자까지 보여 줍니다." },
    ],
  },
  {
    kind: "codex",
    project: "workspace",
    title: "한도 막대 잘림 고치기",
    zst: true,
    turns: [
      {
        user: "5시간 창 막대가 100%를 넘으면 잘리게 해 줘",
        tool: {
          command: 'rg -n "primary" src/limits',
          output: "src/limits/bars.tsx:41:  const primary = window.used\n",
        },
        answer: "`bars.tsx`에서 너비를 `Math.min(used, 100)`으로 묶었습니다.",
      },
    ],
  },
  {
    kind: "codex",
    project: "second",
    title: "웹훅 재시도 간격",
    turns: [{ user: "결제 웹훅 재시도 간격을 지수로 바꿔 줘", answer: "1, 2, 4, 8분 간격으로 네 번 다시 보냅니다." }],
  },
  {
    kind: "claude-code",
    project: "workspace",
    title: "세션 가져오기 설계 검토",
    turns: [
      {
        user: "09 문서의 옮기기 방식 두 가지를 요약해 줘",
        tool: {
          command: "rg -n '^### 4.3' own/docs",
          output: "own/docs/09-session-import.md:404:### 4.3 방식과 판정\n",
        },
        answer:
          "`그대로`는 창이 허락하는 만큼 원문을 옮기고, `요약`은 앞부분을 한 번 요약한 뒤 최근 부분을 원문으로 둡니다.",
      },
      { user: "보조 세션은 언제 지워?", answer: "요약이 끝나고 새 세션이 활성화될 때 지웁니다." },
    ],
  },
  {
    kind: "claude-code",
    project: "workspace",
    title: "테마 토큰 정리",
    turns: [
      {
        user: "피드백 색 토큰을 버튼에 쓰면 안 되는 이유가 뭐야?",
        answer: "의미가 다른 역할을 빌려 쓰면 테마가 바뀔 때 함께 바뀌기 때문입니다.",
      },
    ],
  },
  {
    kind: "claude-code",
    project: "second",
    title: "웹훅 서명 검증",
    turns: [
      {
        user: "웹훅 서명 검증 순서를 알려 줘",
        answer: "본문 원문으로 HMAC을 계산한 뒤 시간 비교가 일정한 함수로 비교합니다.",
      },
    ],
  },
] as const

/**
 * Writes {@link IMPORT_CONVERSATIONS} into the two roots with own-import's fixture layouts (09 §2.5–§2.6 records), and
 * the Codex titles into `session_index.jsonl` (`{id, thread_name, updated_at}`, the latest line of an id wins).
 */
async function writeImportStores(input: {
  readonly codex: string
  readonly claude: string
  readonly workspace: string
  readonly secondProject: string
}) {
  const written = await Promise.all(
    IMPORT_CONVERSATIONS.map(async (conversation, index) => {
      const cwd = conversation.project === "second" ? input.secondProject : input.workspace
      const start = Date.UTC(2026, 9, 1 + index, 9)
      const turns: ReadonlyArray<ImportTurn> = conversation.turns
      // Stamped with the last record's time: a file written just now would look like a live conversation (09 §2.5).
      const mtime = new Date(start + turns.length * 4 * 20_000)
      const serial = String(index + 1).padStart(12, "0")
      const codex = conversation.kind === "codex"
      const id = codex ? `019a0d00-0000-7000-8000-${serial}` : `5d0e1c2a-0000-4000-8000-${serial}`
      await writeJsonl(
        codex
          ? codexRollout(input.codex, { id, at: start, zst: "zst" in conversation })
          : claudeSession(input.claude, cwd, id),
        codex ? codexRecords(id, cwd, start, turns) : claudeRecords(id, cwd, start, conversation.title, turns),
        { mtime },
      )
      return { codex, id, title: conversation.title, mtime }
    }),
  )
  await writeSkills(input)
  await writeJsonl(
    path.join(input.codex, "session_index.jsonl"),
    written
      .filter((thread) => thread.codex)
      .map((thread) => ({ id: thread.id, thread_name: thread.title, updated_at: thread.mtime.toISOString() })),
  )
}

/** Synthetic skills of the two roots (09 §9.1): one of each source and status the import view shows. */
async function writeSkills(input: { readonly codex: string; readonly claude: string }) {
  await Promise.all([
    codexSkill(input.codex, "release-notes", { files: { "scripts/collect.py": "print('release notes')\n" } }),
    codexSkill(input.codex, "imagegen", { system: true, yaml: "policy:\n  allow_implicit_invocation: false\n" }),
    claudeSkill(input.claude, "code-review", { "checklist.md": "# Checklist\n" }),
    pluginSkill(input.claude, { market: "dev-market", plugin: "hookify", name: "writing-rules", installed: true }),
    pluginSkill(input.claude, {
      market: "dev-market",
      plugin: "plugin-dev",
      name: "hook-development",
      installed: false,
      files: {
        "SKILL.md": skillMd(
          "hook-development",
          "Write hooks",
          "allowed-tools: Read\n",
          "Run ${CLAUDE_PLUGIN_ROOT}/x.sh\n",
        ),
      },
    }),
  ])
}

interface ImportTurn {
  readonly user: string
  readonly tool?: { readonly command: string; readonly output: string }
  readonly answer: string
}

/** A Codex rollout: `session_meta`, an injected `<environment_context>` message, then per turn its context and items. */
function codexRecords(id: string, cwd: string, start: number, turns: ReadonlyArray<ImportTurn>) {
  const item = (step: number, type: string, payload: Record<string, unknown>) => ({
    timestamp: new Date(start + step * 20_000).toISOString(),
    type,
    payload,
  })
  const message = (role: "user" | "assistant", text: string) => ({
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  })
  return [
    item(0, "session_meta", {
      id,
      timestamp: new Date(start).toISOString(),
      cwd,
      originator: "codex_cli_rs",
      cli_version: "0.153.0",
      source: "cli",
      model_provider: "openai",
    }),
    item(0, "response_item", message("user", `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`)),
    ...turns.flatMap((turn, index) => {
      const step = index * 4 + 1
      const call = `call_dev_${index + 1}`
      return [
        item(step, "turn_context", { cwd, model: MODEL, approval_policy: "on-request" }),
        item(step, "response_item", message("user", turn.user)),
        ...(turn.tool
          ? [
              item(step + 1, "response_item", {
                type: "function_call",
                name: "shell",
                arguments: JSON.stringify({ command: ["bash", "-lc", turn.tool.command] }),
                call_id: call,
              }),
              item(step + 2, "response_item", {
                type: "function_call_output",
                call_id: call,
                output: turn.tool.output,
              }),
            ]
          : []),
        item(step + 3, "response_item", { ...message("assistant", turn.answer), phase: "final_answer" }),
      ]
    }),
  ]
}

/** A Claude Code session: one `parentUuid` chain of user and assistant records, then its `custom-title`. */
function claudeRecords(sessionId: string, cwd: string, start: number, title: string, turns: ReadonlyArray<ImportTurn>) {
  const assistant = (id: string, content: ReadonlyArray<Record<string, unknown>>) => ({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content,
      usage: { input_tokens: 1_200, output_tokens: 80 },
    },
  })
  const chain = turns.flatMap((turn, index) => [
    { type: "user", message: { role: "user", content: turn.user } },
    ...(turn.tool
      ? [
          assistant(`msg_dev_${index + 1}_tool`, [
            { type: "tool_use", id: `toolu_dev_${index + 1}`, name: "Bash", input: { command: turn.tool.command } },
          ]),
          {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: `toolu_dev_${index + 1}`, content: turn.tool.output }],
            },
          },
        ]
      : []),
    assistant(`msg_dev_${index + 1}`, [{ type: "text", text: turn.answer }]),
  ])
  const uuid = (n: number) => `7a1b2c3d-${sessionId.slice(-4)}-4000-a000-${String(n).padStart(12, "0")}`
  return [
    ...chain.map((record, n) => ({
      ...record,
      uuid: uuid(n + 1),
      parentUuid: n === 0 ? null : uuid(n),
      sessionId,
      cwd,
      timestamp: new Date(start + n * 20_000).toISOString(),
      version: "2.1.30",
      gitBranch: "main",
      isSidechain: false,
      userType: "external",
    })),
    { type: "custom-title", customTitle: title, sessionId },
  ]
}

let answers = 0

/** Model replies: a title for title requests, a template summary for compaction, otherwise a Korean markdown answer. */
function reply(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "새 작업 세션" }
  // core/src/session/compaction.ts: the summary must use the template headings.
  if (request.body.includes("You MUST use this format for your response")) return { type: "text", text: SUMMARY }
  answers++
  return { type: "text", text: answer(answers) }
}

const SUMMARY = [
  "## Objective",
  "- own-web 개발 서비스에서 계정 라우터 화면을 확인한다.",
  "",
  "## Decisions",
  "- 가짜 provider만 쓴다.",
  "",
  "## Work State",
  "### Completed",
  "- 계정 추가, 세션 시드",
  "",
  "### Active",
  "- 전환 흐름 확인",
  "",
  "## Next Move",
  "1. 한도 탭 확인",
].join("\n")

function answer(n: number) {
  return [
    `답변 #${n}입니다. 전환 비용은 **다음 요청에서 새로 써야 하는 입력 토큰**으로 추정합니다.`,
    "",
    "1. 같은 계정·같은 모델로 돌아가면 캐시가 살아 있는 동안 앞부분을 재사용합니다.",
    "2. 다른 계정으로 옮기면 캐시 도메인이 달라서 문맥 전체를 다시 씁니다.",
    "3. 압축한 뒤 옮기면 요약만 새로 쓰므로 첫 요청이 훨씬 작아집니다.",
    "",
    "```ts",
    "const cost = contextTokens * (1 - cacheHitRatio) * inputPrice",
    "```",
    "",
    "한도가 거의 찬 계정은 추천하지 않고, 리셋 시각과 함께 보여 줍니다. 이 답변은 개발용 가짜 provider가 만든 문장입니다.",
  ].join("\n")
}

/**
 * The e2e-kit fake streams a whole answer as one `response.output_text.delta`. This proxy re-emits each delta as
 * word-sized pieces with a pause, so streaming is visible in the UI; everything else passes through unchanged.
 */
function chunkingProxy(target: string, delayMs: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const headers = new Headers(request.headers)
      headers.delete("host")
      const upstream = await fetch(`${target}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      })
      const responseHeaders = Object.fromEntries(
        [...upstream.headers].filter(([name]) => name !== "content-length" && name !== "content-encoding"),
      )
      if (!upstream.headers.get("content-type")?.includes("text/event-stream"))
        return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders })
      const events = parseSse(await upstream.text()).flatMap((event) => {
        const data = event.data as { type?: string; delta?: string }
        if (data?.type !== "response.output_text.delta" || typeof data.delta !== "string") return [event]
        return (data.delta.match(/\S+\s*|\s+/g) ?? [data.delta]).map((delta) => ({
          ...event,
          data: { ...data, delta },
        }))
      })
      return sseResponse(events, { headers: responseHeaders, eventDelayMs: delayMs })
    },
  })
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() > deadline) throw new Error("own-web dev service: timed out")
    await Bun.sleep(200)
  }
}

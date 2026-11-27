// Claude Agent on the accounts page and in the add flow (02 §8.10, CAG 2026-10-31): the card's state, plan and identity
// lines, when an account's login is polled, the route's refusals in the screen's words, the kind's place and mark, that
// setup, login, removal and the folder split are this PC's (`local`) and never touch a token, and (phase 2) the switch
// suggestion of the 계정·한도 tab, which never moves anything by itself.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { Account } from "@own/protocol"
import { OwnRouting } from "@own/protocol/rpc-routing"
import { OwnRpcError } from "@/data/rpc"
import { createI18n, translate } from "@/i18n"
import type { FeatureText } from "@/queue/text"
import { suggest } from "@/limits/claude-agent-suggest"
import { NOTICE } from "@/settings/claude-to-claude-notice"
import { KIND_ORDER } from "@/switcher/picker"
import { agentFailure, agentIdentity, agentPlan, agentState, awaitingLogin } from "./claude-agent"
import {
  CLAUDE_CODE_SETUP_URL,
  claudeAgentEn,
  claudeAgentKo,
  claudeAgentText,
  type ClaudeAgentKey,
} from "./claude-agent-strings"
import { compactionSummary, pageSections, providerIcon } from "./model"

const i18n = createI18n("ko")
const text: FeatureText<ClaudeAgentKey> = (key, params) => claudeAgentText.text("ko", key, params)

function agent(status: Account.Status, details: Partial<NonNullable<Account.View["claudeAgent"]>> = {}) {
  return {
    status,
    claudeAgent: { folder: "C:\\own\\claude-agent\\accounts\\acc_ca", loggedIn: true, cli: true, ...details },
  } as Pick<Account.View, "status" | "claudeAgent">
}

function status(input: {
  readonly cli?: string | null
  readonly loggedIn?: boolean | null
  readonly login?: "idle" | "waiting" | "logged_in" | "failed" | "timeout"
  readonly loginAccount?: string
}) {
  return {
    accounts:
      input.loggedIn === null
        ? []
        : [
            { accountID: "acc_ca", folder: "C:\\own\\ca", loggedIn: input.loggedIn ?? false, default: true },
            { accountID: "acc_cb", folder: "C:\\own\\cb", loggedIn: true, default: false },
          ],
    cli: input.cli === undefined ? "C:\\bin\\claude.exe" : input.cli,
    login: input.login ?? "idle",
    ...(input.loginAccount === undefined ? {} : { loginAccount: input.loginAccount }),
  } as unknown as Parameters<typeof awaitingLogin>[0]
}

describe("Claude Agent card", () => {
  test("state: no Claude Code, login needed, ready", () => {
    expect(agentState(agent("misconfigured", { cli: false }))).toBe("cli")
    expect(agentState(agent("ready", { cli: false }))).toBe("cli")
    expect(agentState(agent("needs_reauth", { loggedIn: false }))).toBe("login")
    expect(agentState(agent("ready", { loggedIn: false }))).toBe("login")
    expect(agentState(agent("ready"))).toBe("ready")
    expect(text(`own.claudeAgent.state.${agentState(agent("ready"))}`)).toBe("준비됨")
    expect(text(`own.claudeAgent.state.${agentState(agent("needs_reauth"))}`)).toBe("로그인 필요")
    expect(text(`own.claudeAgent.state.${agentState(agent("misconfigured"))}`)).toBe("Claude Code 없음")
  })

  test("plan and identity: `Max 요금제`, `API 키` for a login without a plan, nothing while unknown", () => {
    expect(agentPlan(text, "max")).toBe("Max 요금제")
    expect(agentPlan(text, null)).toBe("API 키")
    expect(agentPlan(text, undefined)).toBeUndefined()
    expect(agentIdentity(text, agent("ready", { email: "na***@gmail.com", plan: "pro" }))).toBe(
      "na***@gmail.com · Pro 요금제",
    )
    expect(agentIdentity(text, agent("needs_reauth", { loggedIn: false }))).toBe("")
  })

  test("an account's login is polled while one can still arrive, and never without Claude Code or a folder", () => {
    expect(awaitingLogin(status({ loggedIn: false }), "acc_ca")).toBe(true)
    expect(awaitingLogin(status({ loggedIn: true, login: "waiting", loginAccount: "acc_ca" }), "acc_ca")).toBe(true)
    // Another account's open window is not this account's login.
    expect(awaitingLogin(status({ loggedIn: true, login: "waiting", loginAccount: "acc_cb" }), "acc_ca")).toBe(false)
    expect(awaitingLogin(status({ loggedIn: true, login: "logged_in" }), "acc_ca")).toBe(false)
    expect(awaitingLogin(status({ cli: null, loggedIn: false }), "acc_ca")).toBe(false)
    expect(awaitingLogin(status({ loggedIn: null }), "acc_ca")).toBe(false)
  })

  test("refusals in the screen's words", () => {
    const failure = (error: unknown) => agentFailure(i18n, text, error)
    expect(failure(new OwnRpcError("claude_account_unavailable", "x", { reason: "busy" }))).toBe(
      "로그인 창이 이미 열려 있어요. 그 창에서 로그인을 마치세요.",
    )
    expect(failure(new OwnRpcError("claude_account_unavailable", "x", { reason: "cli_missing" }))).toBe(
      text("own.claudeAgent.cliMissing"),
    )
    expect(failure(new OwnRpcError("remote_managed", "x", { method: "claudeAgent.login" }))).toBe(
      "이 화면은 이 PC에서만 쓸 수 있어요.",
    )
    expect(failure(new OwnRpcError("account_not_found", "x"))).toBe(translate("ko", "own.acct.err.notFound"))
    // 02 §8.10 폴더 나누기: why a folder cannot move, and a folder whose conversation is running.
    expect(failure(new OwnRpcError("claude_account_unavailable", "x", { reason: "claude_code" }))).toBe(
      "Claude Code가 쓰는 폴더라 옮길 수 없어요",
    )
    expect(failure(new OwnRpcError("session_busy", "x", { sessionIDs: [] }))).toBe(
      "이 폴더의 대화가 도는 중이에요. 끝난 뒤에 다시 해 보세요.",
    )
  })

  test("the terminal login for 명령 프롬프트 and for PowerShell (manual 20.8)", () => {
    expect(text("own.claudeAgent.login.cmd")).toBe("명령 프롬프트(cmd)에서")
    expect(text("own.claudeAgent.login.powershell")).toBe("PowerShell에서")
  })

  test("every Korean line has its English one; the guide is Claude Code's setup page", () => {
    expect(Object.keys(claudeAgentEn).sort()).toEqual(Object.keys(claudeAgentKo).sort())
    expect(CLAUDE_CODE_SETUP_URL).toBe("https://code.claude.com/docs/en/setup")
    expect(text("own.claudeAgent.intro.login")).toBe(
      "로그인은 Claude Code가 직접 해요. own은 비밀번호나 토큰을 보지 않아요.",
    )
    expect(text("own.claudeAgent.login.terminal")).toBe("터미널에서 직접 하려면 이 명령을 실행해요.")
  })
})

describe("Claude Agent as an account kind", () => {
  test("its own section after the API kinds, beside the Claude slot, with Anthropic's mark", () => {
    expect(KIND_ORDER.slice(-2)).toEqual(["claude-agent", "claude-sub"])
    expect(providerIcon("claude-agent")).toBe("anthropic")
    expect(translate("ko", "own.acct.kind.claude-agent")).toBe("Claude Agent")
    expect(translate("ko", "own.switcher.kind.claude-agent")).toBe("Claude Agent")
    const accounts = [
      { id: "acc_ca", kind: "claude-agent" },
      { id: "acc_key", kind: "anth" },
    ] as unknown as Account.View[]
    expect(pageSections(accounts).map((section) => section.kind)).toEqual(["anth", "claude-agent"])
  })

  test("compaction takes the kind default and the account setting (CAG-50), unlike the fixed Claude slot", () => {
    expect(compactionSummary("claude-agent", { triggerPercent: 40 }, undefined)).toMatchObject({
      source: "own.compact.source.account",
      percent: 40,
    })
    expect(compactionSummary("claude-agent", null, { "claude-agent": { triggerPercent: 60 } })).toMatchObject({
      source: "own.compact.source.kind",
      percent: 60,
    })
    expect(compactionSummary("claude-agent", null, undefined)).toMatchObject({ source: "own.compact.source.v2", percent: 85 })
    expect(compactionSummary("claude-sub", { triggerPercent: 40 }, undefined)).toMatchObject({
      source: "own.compact.source.v2",
      percent: 85,
    })
  })

  test("setup, login, removal and the folder split are this PC's (`local`); the screens never touch a token", async () => {
    for (const method of ["claudeAgent.setup", "claudeAgent.login", "claudeAgent.remove", "claudeAgent.folders.assign"] as const)
      expect(OwnRouting.MethodScope[method]).toBe("local")
    expect(OwnRouting.MethodScope["claudeAgent.session.set"]).toBe("switch")
    const source = await Bun.file(path.join(import.meta.dir, "claude-agent.tsx")).text()
    expect(source).toContain('own.rpc.allowed("claudeAgent.setup")')
    expect(source).toContain('own.rpc.allowed("claudeAgent.login")')
    for (const word of ["credentials.json", "accessToken", "refreshToken", "Bearer", "autoSwitch"])
      expect(source).not.toContain(word)
    // The page keeps Claude Agent out of the generic sections (API-key actions) and loads its section lazily.
    const page = await Bun.file(path.join(import.meta.dir, "index.tsx")).text()
    expect(page).toContain('new Set(["claude-sub", "claude-agent"])')
    expect(page).toContain('import("./claude-agent")')
    const add = await Bun.file(path.join(import.meta.dir, "add-account.tsx")).text()
    expect(add).toContain('import("./claude-agent")')
    expect(add).not.toMatch(/from "\.\/claude-agent"/)
  })
})

describe("Claude Agent phase 2: suggestions and the one-time notice", () => {
  const view = (id: string, status: Account.Status = "ready") =>
    ({ id, kind: "claude-agent", label: id.toUpperCase(), status }) as unknown as Account.View
  const window = (accountID: string, id: string, usedPercent: number, state = "ok") =>
    ({ accountID, id, kind: "rolling_quota", label: id === "claude.5h" ? "5시간" : "주간", usedPercent, status: state }) as never

  test("a window at 85 % or exhausted suggests the other account with the most room; nothing else does", () => {
    const accounts = [view("a"), view("b"), view("c"), view("d", "needs_reauth")]
    const quota: Record<string, never[]> = {
      a: [window("a", "claude.5h", 87), window("a", "claude.7d", 40)],
      b: [window("b", "claude.5h", 30)],
      c: [window("c", "claude.5h", 12)],
      d: [window("d", "claude.5h", 0)],
    }
    const found = suggest("a", accounts, (id) => quota[id])
    expect<string | undefined>(found?.other.id).toBe("c")
    expect(found?.window.id).toBe("claude.5h")
    expect(found?.full).toBe(false)
    expect(found?.room).toBe(12)
    // Below the line: no suggestion. An exhausted other account is never one.
    expect(suggest("a", accounts, (id) => (id === "a" ? [window("a", "claude.5h", 60)] : quota[id]))).toBeUndefined()
    const full: Record<string, never[]> = {
      ...quota,
      a: [window("a", "claude.7d", 100, "exhausted")],
      c: [window("c", "claude.5h", 5, "exhausted")],
    }
    const exhausted = suggest("a", accounts, (id) => full[id])
    expect(exhausted?.full).toBe(true)
    expect<string | undefined>(exhausted?.other.id).toBe("b")
    expect(
      text("own.claudeAgent.suggest", { window: "5시간", percent: "87%", account: "C", other: "12%" }),
    ).toBe("5시간 87% · C는 12%예요")
    expect(text("own.claudeAgent.suggestNote")).toContain("자동으로 옮기지 않아요")
  })

  test("an account without a five-hour window (verified Ultra, 02 §7.1.2) is weighed by its week, and its week is the room", () => {
    const accounts = [view("a"), view("b"), view("c")]
    const quota: Record<string, never[]> = {
      // The conversation's own account has no five hours: its week nearing the line suggests a move.
      a: [window("a", "claude.7d", 90)],
      b: [window("b", "claude.5h", 30), window("b", "claude.7d", 10)],
      c: [window("c", "claude.7d", 20)],
    }
    const found = suggest("a", accounts, (id) => quota[id])
    expect(found?.window.id).toBe("claude.7d")
    expect<string | undefined>(found?.other.id).toBe("c")
    expect(found?.room).toBe(20)
    // Before, an account without a five-hour figure came last whatever its week.
    const busy: Record<string, never[]> = { ...quota, c: [window("c", "claude.7d", 50)] }
    expect<string | undefined>(suggest("a", accounts, (id) => busy[id])?.other.id).toBe("b")
  })

  test("the one-time notice says the switch is off and where to turn it back on", () => {
    expect(NOTICE.ko).toContain("Claude 계정 사이 자동 전환을 껐어요")
    expect(NOTICE.ko).toContain("설정 > 전환 정책 > Claude 계정 사이")
    const path = (["own.settings.policy", "own.set.claudeToClaude"] as const).map((key) => translate("en", key))
    expect(NOTICE.en).toContain(`Settings > ${path.join(" > ")}`)
  })
})

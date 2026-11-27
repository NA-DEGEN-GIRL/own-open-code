// Several Claude accounts on the accounts page and in the switcher (02 §8.7, 2026-10-10): the switcher's names, which
// cards the Claude section adds, the decided Korean strings verbatim, and that the login actions are this PC's only
// (`local` methods) and never handle a token. The plugin ships with the app (02 §8.2, 2026-10-18).
import { describe, expect, test } from "bun:test"
import { claudeAccountsText } from "./claude-accounts-strings"
import path from "node:path"
import type { Account } from "@own/protocol"
import { OwnRouting } from "@own/protocol/rpc-routing"
import { createI18n, translate } from "@/i18n"
import { claudeSlotText } from "./claude-slot-strings"
import { addedClaudeAccounts } from "./claude-accounts"
import { claudeAccountName } from "./claude-name"
import { NOTICE_ITEMS } from "./claude-notice"
import { claudeRefreshEn, claudeRefreshKo, claudeRefreshReason, claudeRefreshText } from "./claude-refresh-strings"
import { claudeSharedEn, claudeSharedKo, claudeSharedText } from "./claude-shared-strings"

const i18n = createI18n("ko")

function view(id: string, kind: Account.View["kind"], label: string): Account.View {
  return { id, kind, label } as unknown as Account.View
}

describe("Claude accounts in the switcher and on the accounts page", () => {
  test("`Claude · {label}`, the slot's own plain; other kinds keep their label", () => {
    expect(claudeAccountName(i18n, view("acc_claude_slot", "claude-sub", "Claude"))).toBe("Claude")
    expect(claudeAccountName(i18n, view("acc_two", "claude-sub", "업무"))).toBe("Claude · 업무")
    expect(claudeAccountName(i18n, view("acc_x", "codex", "개인 Pro"))).toBe("개인 Pro")
  })

  test("a label that already starts with `Claude` is shown as it is, never `Claude · Claude 구독`", () => {
    expect(claudeAccountName(i18n, view("acc_claude_slot", "claude-sub", "Claude 구독"))).toBe("Claude 구독")
    expect(claudeAccountName(i18n, view("acc_two", "claude-sub", "Claude Max · na***@…"))).toBe("Claude Max · na***@…")
    // Only the word: a label that merely begins with the letters keeps the prefix.
    expect(claudeAccountName(i18n, view("acc_three", "claude-sub", "Claudette"))).toBe("Claude · Claudette")
  })

  test("the section adds a card for every Claude account but the slot's own", () => {
    const accounts = [
      view("acc_claude_slot", "claude-sub", "Claude"),
      view("acc_codex", "codex", "Pro"),
      view("acc_two", "claude-sub", "둘"),
      view("acc_three", "claude-sub", "셋"),
    ]
    expect(addedClaudeAccounts(accounts).map((item) => String(item.id))).toEqual(["acc_two", "acc_three"])
  })

  test("the decided strings, verbatim", () => {
    expect(claudeAccountsText.text("ko", "own.claude.accounts.add")).toBe("Claude 계정 추가")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.addBody")).toBe(
      "PC에 열린 창에서 Claude Code 로그인이 시작돼요. 브라우저에서 로그인만 마치세요. 앱은 비밀번호나 토큰을 보지 않아요.",
    )
    expect(claudeAccountsText.text("ko", "own.claude.accounts.waiting")).toBe("로그인 기다리는 중… (창을 닫으면 취소돼요)")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.added", { label: "Claude Max · na***@…" })).toBe(
      "추가했어요: Claude Max · na***@…",
    )
    expect(claudeAccountsText.text("ko", "own.claude.accounts.duplicate")).toBe("이미 추가된 계정이에요.")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.import")).toBe("이 PC의 기존 Claude Code 로그인 가져오기")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.found", { email: "na***@…", folder: "C:\\Users\\me\\.claude" })).toBe(
      "찾은 로그인: na***@… (C:\\Users\\me\\.claude)",
    )
    expect(claudeAccountsText.text("ko", "own.claude.accounts.cliMissing")).toBe(
      "Claude Code가 설치되어 있지 않아요. PowerShell에서 직접 설치한 뒤 다시 누르세요: irm https://claude.ai/install.ps1 | iex (또는 npm install -g @anthropic-ai/claude-code)",
    )
    expect(claudeAccountsText.text("ko", "own.claude.accounts.pcOnly")).toBe("로그인 추가는 이 PC의 창에서만 할 수 있어요.")
    expect(claudeSlotText.text("ko", "own.claude.accounts.summary", { n: 3 })).toBe("Claude 구독 계정: 3개")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.remove")).toBe("계정 빼기…")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.removeFolder")).toBe("로그인 폴더도 지우기")
  })

  test("the risk notice is information: it names the app's patched copy, always on, and the detection risk", () => {
    expect(NOTICE_ITEMS.some((item) => item.includes("앱에 넣어 함께 배포하고 늘 켜 둡니다"))).toBe(true)
    expect(
      NOTICE_ITEMS.some((item) => item.includes("Claude 계정을 연결하기 전에는 아무 요청도 보내지 않습니다")),
    ).toBe(true)
    expect(NOTICE_ITEMS.some((item) => item.includes("자동으로 바꾸는 것은 Anthropic이 쉽게 알아챌 수 있고"))).toBe(
      true,
    )
    expect(NOTICE_ITEMS.some((item) => item.includes("계정 1개만 씁니다"))).toBe(false)
  })

  test("login, import and removal are this PC's (`local`); the cards never touch a token", async () => {
    for (const method of [
      "plugin.claudeAuth.accounts.add.plan",
      "plugin.claudeAuth.accounts.add.execute",
      "plugin.claudeAuth.accounts.detect",
      "plugin.claudeAuth.accounts.remove.execute",
    ] as const)
      expect(OwnRouting.MethodScope[method]).toBe("local")
    const source = await Bun.file(path.join(import.meta.dir, "claude-accounts.tsx")).text()
    expect(source).toContain('own.rpc.allowed("plugin.claudeAuth.accounts.add.plan")')
    expect(source).toContain('claudeAccountsText.text(i18n.locale(), "own.claude.accounts.pcOnly")')
    for (const word of ["credentials.json", "accessToken", "refreshToken", "Bearer"]) expect(source).not.toContain(word)
    // The plugin ships with the app (02 §8.2, 2026-10-18): no install, patch, uninstall or consent from the cards.
    const slot = await Bun.file(path.join(import.meta.dir, "claude-slot.tsx")).text()
    for (const method of ["install", "uninstall", "patch.plan", "patch.execute", 'ack"'])
      expect(source + slot).not.toContain(`plugin.claudeAuth.${method}`)
    expect(slot).not.toContain("noticeHash()")
    // 02 §8.8: the automatic switch's toast comes from the router's alert of the conversation.
    const pill = await Bun.file(path.join(import.meta.dir, "..", "switcher", "pill.tsx")).text()
    expect(pill).toContain('event.data.code === "claude_account_switched" && event.data.sessionID === sessionID')
  })

  test("an account whose login is gone offers `다시 로그인`, and the bundle's state is said", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "claude-accounts.tsx")).text()
    expect(source).toContain('data-testid="claude-account-relogin"')
    // Signing in again runs the same login for the account's own folder (`accountID`).
    expect(source).toContain("target ? { accountID: target.id } : {}")
    expect(source).toContain("load(props.account)")
    expect(source).toContain('testid="claude-bundle-modified"')
    expect(source).toContain('testid="claude-bundle-restart"')
    // RestartButton reads the launcher's answer.
    const restart = source.slice(source.indexOf("function RestartButton"))
    expect(restart).toContain('restarted.refused === "session_running"')
    expect(restart).toContain('i18n.t("own.desktop.launcherRefused")')
    // The cards' limits use the shared display (설정 > 일반 > 한도 표시).
    expect(source).toContain("<AccountLimits")
    expect(source).not.toContain("LimitMeterGroup")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.relogin")).toBe("다시 로그인")
    expect(claudeAccountsText.text("ko", "own.claude.accounts.needsLogin")).toBe(
      "이 계정의 로그인이 없거나 만료됐어요 — [다시 로그인]을 누르세요.",
    )
    expect(translate("ko", "own.claude.builtIn.tag")).toBe("앱에 포함 · 항상 켜짐")
  })

  // 02 §8.7 (CS, 2026-10-22): account 1 on Claude Code's own login is read only; `다시 로그인` moves it to an own login.
  test("Claude Code's own login: the card says it stops, and `다시 로그인` explains and moves it", async () => {
    const text = claudeSharedText.text
    // Review finding 2: plain words that it stops while Claude Code is idle, and the real fix.
    expect(text("ko", "own.claude.shared.note")).toBe(
      "Claude Code가 쉬고 있으면 몇 시간마다 멈춰요 · own 전용 로그인으로 바꾸면 own이 직접 갱신해요",
    )
    // CS re-review (e): the remedy is one request in Claude Code (an idle Claude Code never refreshes), never waiting.
    expect(text("ko", "own.claude.shared.stale", { account: "AC-01" })).toBe(
      "AC-01은 Claude Code와 같은 로그인을 쓰는데, 그 로그인이 만료돼 멈췄어요. Claude Code에서 요청을 한 번 보내면 Claude Code가 새로 고쳐서 다시 돼요. 멈추지 않게 하려면 own 전용 로그인으로 바꾸세요. Claude Code도 로그아웃됐다면 Claude Code에서 /login을 하세요.",
    )
    for (const key of ["own.claude.shared.stale", "own.claude.shared.note"] as const)
      expect(text("ko", key, { account: "AC-01" })).not.toContain("기다려")
    // Review finding 4: a move signed into another Claude account changes nothing.
    expect(text("ko", "own.claude.shared.mismatch")).toBe(
      "다른 Claude 계정으로 로그인했어요 · 같은 계정으로 다시 로그인하거나 계정을 새로 추가하세요",
    )
    expect(text("ko", "own.claude.shared.addNew")).toBe("새 계정으로 추가")
    expect(text("ko", "own.claude.shared.stale", { account: "Claude" })).toStartWith("Claude는 ")
    expect(text("ko", "own.claude.shared.move")).toBe("own 전용 로그인으로 바꾸기")
    expect(text("ko", "own.claude.shared.moveTitle", { account: "AC-01" })).toBe("own 전용 로그인으로 바꾸기: AC-01")
    expect(
      text("ko", "own.claude.shared.moveBody", { account: "AC-01", folder: "C:\\Users\\me\\.claude" }),
    ).toStartWith("AC-01은 Claude Code의 로그인(C:\\Users\\me\\.claude)을 함께 써서 이 앱이 새로 고치지 않아요.")
    expect(text("ko", "own.claude.shared.moved", { label: "AC-01" })).toBe("own 전용 로그인으로 바꿨어요: AC-01")
    // Every string has its English, and they live outside the first chunk's catalogs (PF5).
    expect(Object.keys(claudeSharedEn).sort()).toEqual(Object.keys(claudeSharedKo).sort())
    expect(translate("ko", "own.switcher.unusable.shared")).toBe(
      "Claude Code에서 요청을 한 번 보내거나 own 전용 로그인으로 바꿔요",
    )
    const slot = await Bun.file(path.join(import.meta.dir, "claude-slot.tsx")).text()
    expect(slot).toContain("<ClaudeSharedLogin")
    expect(slot).toContain('account()?.status === "needs_reauth" && !account()?.claude?.stale')
    const source = await Bun.file(path.join(import.meta.dir, "claude-accounts.tsx")).text()
    expect(source).toContain('data-testid="claude-shared-move"')
    // CS re-review (f): any read-only card (a junction, a link, the source's folder), not only account 1's.
    const card = source.slice(
      source.indexOf("export function ClaudeAccountCard"),
      source.indexOf("export function ClaudeSharedLogin"),
    )
    expect(card).toContain("<Show when={props.account.claude?.shared}>")
    expect(card).toContain("<ClaudeSharedLogin")
    expect(card).toContain('props.account.status === "needs_reauth" && !props.account.claude?.stale')
    // The limits panel says the same instead of `다시 로그인 필요`.
    const panel = await Bun.file(path.join(import.meta.dir, "..", "limits", "panel-tab.tsx")).text()
    expect(panel.indexOf('if (account.claude?.stale) return "own.switcher.unusable.shared"')).toBeGreaterThan(-1)
    expect(panel.indexOf("account.claude?.stale")).toBeLessThan(panel.indexOf('"own.lim.status.needsReauth"'))
    // Review finding 6: the plan decides once it arrived (a shared folder is never logged into), not the view's flag.
    expect(source).not.toContain("plan()?.move ??")
    expect(source).toContain("current === undefined ? account()?.claude?.shared === true : current.move === true")
    expect(source).toContain('data-testid="claude-account-add-new"')
    expect(NOTICE_ITEMS[5]).toContain("이 앱은 그 로그인을 읽기만 하고 새로 고치지 않습니다")
    expect(NOTICE_ITEMS[5]).toContain("Claude Code가 쉬고 있으면 토큰이 만료될 때마다(몇 시간마다) 멈춥니다")
  })

  // 02 §8.7 (CR, 2026-10-26): an account own refreshes says what its last refresh came to, on every Claude card.
  test("the refresh line: a failed refresh names what the endpoint said and asks for 다시 로그인; a passing one is a note", async () => {
    const text = claudeRefreshText.text
    const ko = (key: keyof typeof claudeRefreshKo) => text("ko", key)
    const reason = (refresh: Account.ClaudeRefresh) => claudeRefreshReason(refresh, ko)
    expect(
      text("ko", "own.claude.refresh.failed", {
        reason: reason({ state: "failed", status: 400, error: "invalid_grant" }),
      }),
    ).toBe("로그인을 새로 고치지 못했어요(HTTP 400 invalid_grant) · 다시 로그인하세요.")
    expect(text("ko", "own.claude.refresh.failed", { reason: reason({ state: "failed", status: 403 }) })).toBe(
      "로그인을 새로 고치지 못했어요(HTTP 403) · 다시 로그인하세요.",
    )
    expect(
      text("ko", "own.claude.refresh.retrying", {
        reason: reason({ state: "retrying", status: 429, error: "rate_limit_error" }),
      }),
    ).toBe("로그인 새로 고침이 잠시 막혔어요(HTTP 429 rate_limit_error) · 다음 요청에서 다시 해요")
    expect(reason({ state: "retrying", reason: "timeout" })).toBe("시간 초과")
    expect(reason({ state: "retrying", reason: "network" })).toBe("연결 실패")
    expect(reason({ state: "failed", reason: "no_refresh_token" })).toBe("새로 고침 토큰 없음")
    // An expired token nobody tried to refresh yet is no error: the first request refreshes it.
    expect(ko("own.claude.refresh.due")).toBe("로그인 토큰이 만료됐어요 · 다음 요청에서 새로 고쳐요")
    expect(Object.keys(claudeRefreshEn).sort()).toEqual(Object.keys(claudeRefreshKo).sort())
    // Both cards show it; a failed refresh replaces the generic login notice with its own words and 다시 로그인.
    const source = await Bun.file(path.join(import.meta.dir, "claude-accounts.tsx")).text()
    const card = source.slice(
      source.indexOf("export function ClaudeAccountCard"),
      source.indexOf("export function ClaudeRefreshLine"),
    )
    expect(card).toContain("<ClaudeRefreshLine")
    expect(card).toContain("!refreshFailed(props.account)")
    const line = source.slice(source.indexOf("export function ClaudeRefreshLine"))
    expect(line).toContain('testid="claude-refresh-failed"')
    expect(line).toContain('data-testid="claude-refresh-relogin"')
    expect(line).toContain('data-testid="claude-refresh-retrying"')
    expect(line).toContain('data-testid="claude-refresh-due"')
    const slot = await Bun.file(path.join(import.meta.dir, "claude-slot.tsx")).text()
    expect(slot).toContain("<ClaudeRefreshLine")
    expect(slot).toContain("!refreshFailed(account())")
  })

  test("설정 > 전환 정책 has the Claude-to-Claude switch, `자동` or `끄기` only", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "..", "settings", "policy.tsx")).text()
    expect(source).toContain("patch({ autoSwitch: { claudeToClaude: mode } })")
    expect(source).toContain('(["auto", "off"] as const)')
    // CAG-5 (2026-10-31): a policy without the field shows `끄기`, as the backend reads it.
    expect(source).toContain('claudeToClaude ?? "off"')
    expect(translate("ko", "own.set.claudeToClaude")).toBe("Claude 계정 사이")
  })
})

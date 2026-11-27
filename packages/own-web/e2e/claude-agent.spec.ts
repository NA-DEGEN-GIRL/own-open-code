// Claude Agent (02 §8.10, CAG 2026-10-31) in Edge, with the `own.accounts` RPC mocked in the page (03 §16.5 "계정
// 추가(모의 RPC)"): the add-account card and its flow (setup, Claude Code missing, the login window with polling, the
// terminal commands for 명령 프롬프트 and PowerShell, a busy window), and the accounts page's section with its cards,
// limits and actions; phase 2: two accounts, the default, another account added, and the folder split between the
// Claude subscription and Claude Agent. The real backend serves the page; nothing here reaches it with a Claude Agent
// method.
import { expect, test, type Page, type Route } from "@playwright/test"
import { watchErrors } from "./support"

const NOW = Date.now()
const FOLDER = "C:\\fake\\own\\claude-agent\\accounts\\acc_01J9AGENT0000000000000000"
const COMMAND =
  'set "CLAUDE_CONFIG_DIR=C:\\fake\\own\\claude-agent\\accounts\\acc_01J9AGENT" && claude auth login --claudeai'
const POWERSHELL =
  "$env:CLAUDE_CONFIG_DIR = 'C:\\fake\\own\\claude-agent\\accounts\\acc_01J9AGENT'; & 'claude' auth login --claudeai"
const ACCOUNT_ID = "acc_01J9AGENT0000000000000000"
const SECOND_ID = "acc_01J9AGENTSECOND0000000000"

type Handler = (input: Record<string, unknown>) => object | undefined

/** Answers one `own.accounts` method in the page with a fixed output or a handler of the call's input. */
async function mock(page: Page, method: string, answer: object | Handler) {
  const escaped = method.replaceAll(".", "\\.")
  await page.route(new RegExp(`/api/rpc/own\\.accounts/${escaped}(\\?|$)`), async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as { input?: Record<string, unknown> }
    const result = typeof answer === "function" ? (answer as Handler)(body.input ?? {}) : answer
    if (result === undefined) return route.continue()
    return route.fulfill({ json: { output: result } })
  })
}

/** A declared RPC error as the server sends it (HTTP 400 `RpcError`). */
async function rpcError(page: Page, method: string, error: { type: string; data: object }) {
  const escaped = method.replaceAll(".", "\\.")
  await page.route(new RegExp(`/api/rpc/own\\.accounts/${escaped}(\\?|$)`), (route) =>
    route.fulfill({ status: 400, json: { _tag: "RpcError", message: error.type, ...error } }),
  )
}

function status(input: {
  readonly cli?: boolean
  readonly account?: boolean
  readonly loggedIn?: boolean
  readonly login?: "idle" | "waiting" | "logged_in" | "failed" | "timeout"
  readonly created?: boolean
}) {
  const cli = input.cli ?? true
  return {
    accounts:
      input.account === false
        ? []
        : [
            {
              accountID: ACCOUNT_ID,
              folder: FOLDER,
              label: null,
              shortLabel: "CA",
              loggedIn: input.loggedIn ?? false,
              default: true,
              commands: cli ? { cmd: COMMAND, powershell: POWERSHELL } : null,
              ...(input.loggedIn ? { email: "na***@gmail.com", plan: "max" } : {}),
            },
          ],
    cli: cli ? "C:\\fake\\claude.exe" : null,
    login: input.login ?? "idle",
    ...(input.login === "waiting" || input.login === "logged_in" ? { loginAccount: ACCOUNT_ID } : {}),
    ...(input.created ? { created: ACCOUNT_ID } : {}),
  }
}

function agentAccount(patch: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    kind: "claude-agent",
    label: "Claude Agent",
    shortLabel: "CA",
    color: "violet",
    providerID: "claude-agent",
    billing: "subscription",
    status: "ready",
    autoSwitch: false,
    thirdParty: false,
    readOnly: true,
    connection: { type: "oauth", method: "claude-code" },
    claudeAgent: { folder: FOLDER, loggedIn: true, email: "na***@gmail.com", cli: true, plan: "max", checked: NOW },
    ...patch,
  }
}

function claudeWindow(id: string, label: string, usedPercent: number, windowMinutes: number) {
  return {
    accountID: ACCOUNT_ID,
    providerID: "claude-agent",
    scope: "account",
    kind: "rolling_quota",
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: NOW - 30_000,
    id,
    label,
    usedPercent,
    windowMinutes,
    resetAt: NOW + windowMinutes * 30_000,
  }
}

const unexpected = (errors: readonly string[]) =>
  errors.filter((error) => !/Failed to load resource|net::|status of 400/.test(error))

test.beforeEach(async ({ page }) => {
  // Never let the add grid read the real old-app control center.
  await mock(page, "accounts.import.codex.list", { available: false, sources: [] })
})

test.describe("add account: Claude Agent", () => {
  test("the card, setup, the login window with polling, the terminal command (mocked)", async ({ page }) => {
    const errors = watchErrors(page)
    const server = { logins: 0, polls: 0, loggedIn: false, waitingSince: -1, setup: false }
    const setups: unknown[] = []
    await mock(page, "claudeAgent.setup", (input) => {
      setups.push(input)
      server.setup = true
      return status({ created: true })
    })
    await mock(page, "claudeAgent.login", () => {
      server.logins += 1
      server.waitingSince = server.polls
      return status({ login: "waiting" })
    })
    await mock(page, "claudeAgent.status", () => {
      // Before setup the route has no account: the flow makes the first one.
      if (!server.setup) return status({ account: false })
      server.polls += 1
      // The login lands in the browser a few polls after the window opened.
      if (server.waitingSince >= 0 && server.polls - server.waitingSince >= 2) server.loggedIn = true
      return server.loggedIn
        ? status({ loggedIn: true, login: "logged_in" })
        : status({ login: server.waitingSince >= 0 ? "waiting" : "idle" })
    })
    await page.goto("/accounts/add")
    const card = page.locator('[data-testid=add-type-grid] [data-choice="claude-agent"]')
    await expect(card).toContainText("Claude Agent")
    await expect(card).toContainText("내 PC에 설치된 Claude Code를 그대로 써요")
    await expect(card).toContainText("구독")
    // The user's own, unmodified Claude Code: no 비공식 badge (the Claude subscription card before it keeps its own).
    await expect(card).not.toContainText("비공식")
    const cards = await page
      .locator("[data-testid=add-type-grid] [data-choice]")
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-choice")))
    expect(cards.indexOf("claude-agent")).toBe(cards.indexOf("claude-sub") + 1)
    await card.click()

    const dialog = page.getByTestId("add-account-dialog")
    await expect(dialog.locator("h2").first()).toHaveText("Claude Agent")
    const flow = dialog.getByTestId("claude-agent-flow")
    await expect(flow.getByTestId("claude-agent-intro")).toContainText(
      "로그인은 Claude Code가 직접 해요. own은 비밀번호나 토큰을 보지 않아요.",
    )
    await expect(flow.getByTestId("claude-agent-intro")).toContainText("기존 Claude 구독(비공식 연결)과 섞이지 않아요")
    await expect(flow.getByTestId("claude-agent-intro")).toContainText("계정 전환은 손으로만 해요")
    await expect(flow.getByTestId("claude-agent-folder")).toContainText(FOLDER)
    expect(setups).toEqual([{ add: false }])
    // Manual 20.8: the command for 명령 프롬프트 and the one for PowerShell, each under its shell's name.
    const box = flow.getByTestId("claude-agent-command")
    await expect(box).toContainText("터미널에서 직접 하려면 이 명령을 실행해요.")
    await expect(box.locator('[data-shell="cmd"]')).toContainText("명령 프롬프트(cmd)에서")
    await expect(flow.getByTestId("claude-agent-command-cmd")).toHaveText(COMMAND)
    await expect(box.locator('[data-shell="powershell"]')).toContainText("PowerShell에서")
    await expect(flow.getByTestId("claude-agent-command-powershell")).toHaveText(POWERSHELL)
    await expect(flow.getByTestId("claude-agent-logged-in")).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath("claude-agent-login.png") })

    await flow.getByTestId("claude-agent-login-open").click()
    await expect(flow.getByTestId("claude-agent-login-waiting")).toHaveText("로그인 기다리는 중…")
    await expect(flow.getByTestId("claude-agent-login-open")).toBeDisabled()
    await expect(flow.getByTestId("claude-agent-logged-in")).toHaveText("로그인했어요: na***@gmail.com · Max 요금제", {
      timeout: 20_000,
    })
    expect(server.logins).toBe(1)
    await expect(flow.getByTestId("claude-agent-command")).toHaveCount(0)
    await expect(flow.getByTestId("claude-agent-new-session")).toHaveText("이 계정으로 새 대화")
    await page.screenshot({ path: test.info().outputPath("claude-agent-logged-in.png") })
    // Logged in: the polling stops.
    const polled = server.polls
    await page.waitForTimeout(3_500)
    expect(server.polls).toBe(polled)
    await flow.getByTestId("claude-agent-close").click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/accounts$/)
    expect(unexpected(errors)).toEqual([])
  })

  test("without Claude Code: the guide and 다시 확인, which sets the folder up once it is found (mocked)", async ({
    page,
  }) => {
    const server = { installed: false, setups: 0 }
    await mock(page, "claudeAgent.setup", () => {
      server.setups += 1
      return server.installed ? status({ created: true }) : status({ cli: false, account: false })
    })
    await mock(page, "claudeAgent.status", () =>
      server.installed ? status({ account: false }) : status({ cli: false, account: false }),
    )
    await page.goto("/accounts/add")
    await page.locator('[data-testid=add-type-grid] [data-choice="claude-agent"]').click()
    const flow = page.getByTestId("claude-agent-flow")
    const missing = flow.getByTestId("claude-agent-cli-missing")
    await expect(missing).toContainText(
      "이 PC에서 Claude Code를 찾지 못했어요. Claude Code를 설치한 뒤 다시 확인하세요.",
    )
    await expect(missing.getByTestId("claude-agent-setup-link")).toHaveText("Claude Code 설치 방법 보기")
    await expect(flow.getByTestId("claude-agent-login-panel")).toHaveCount(0)
    await missing.getByTestId("claude-agent-recheck").click()
    await expect(missing).toBeVisible()
    server.installed = true
    await missing.getByTestId("claude-agent-recheck").click()
    await expect(flow.getByTestId("claude-agent-login-panel")).toBeVisible()
    await expect(flow.getByTestId("claude-agent-folder")).toContainText(FOLDER)
    // Without Claude Code no folder is made; once it is found, the first account.
    expect(server.setups).toBe(1)
  })

  test("a login window already open is said in plain words (mocked)", async ({ page }) => {
    const setups: unknown[] = []
    await mock(page, "claudeAgent.setup", (input) => {
      setups.push(input)
      return status({ created: true })
    })
    // An account still waiting for its login is the one the flow signs in: no new folder.
    await mock(page, "claudeAgent.status", status({}))
    await rpcError(page, "claudeAgent.login", { type: "claude_account_unavailable", data: { reason: "busy" } })
    await page.goto("/accounts/add")
    await page.locator('[data-testid=add-type-grid] [data-choice="claude-agent"]').click()
    const flow = page.getByTestId("claude-agent-flow")
    await flow.getByTestId("claude-agent-login-open").click()
    await expect(flow.getByTestId("claude-agent-login-status")).toHaveText(
      "로그인 창이 이미 열려 있어요. 그 창에서 로그인을 마치세요.",
    )
    await expect(flow.getByTestId("claude-agent-login-failed")).toHaveCount(0)
    expect(setups).toEqual([])
  })
})

test.describe("accounts page: Claude Agent", () => {
  test("its own section: identity, state, folder, limits, actions; never a generic API section (mocked)", async ({
    page,
  }) => {
    const errors = watchErrors(page)
    await mock(page, "accounts.list", { revision: 990, accounts: [agentAccount()] })
    await mock(page, "quota.snapshot", {
      windows: [
        claudeWindow("claude.5h", "5시간", 42, 300),
        claudeWindow("claude.7d", "주간", 18, 10_080),
        claudeWindow("claude.7d_opus", "주간 · Opus", 7, 10_080),
      ],
    })
    const refreshes: unknown[] = []
    await mock(page, "claudeAgent.limits.refresh", (input) => {
      refreshes.push(input)
      return { windows: [], plan: "max" }
    })
    const removals: unknown[] = []
    await mock(page, "claudeAgent.remove", (input) => {
      removals.push(input)
      return { folderDeleted: true, movedSessions: [] }
    })
    const waiting = [{ sessionID: "ses_waiting", since: 1 }]
    await mock(page, "claudeAgent.status", {
      ...status({ loggedIn: true }),
      pool: { live: 3, cap: 8, over: 0, spares: 0, waiting },
    })
    const poolSets: unknown[] = []
    await mock(page, "claudeAgent.pool.set", (input) => {
      poolSets.push(input)
      return { live: 3, cap: 4, over: 0, spares: 0, waiting }
    })
    await page.goto("/accounts")
    const section = page.getByTestId("claude-agent-section")
    await expect(section.locator("h2")).toHaveText("Claude Agent")
    await expect(page.locator('[data-testid=provider-section][data-kind="claude-agent"]')).toHaveCount(0)
    const card = section.locator(`[data-testid=claude-agent-card][data-account-id="${ACCOUNT_ID}"]`)
    await expect(card).toHaveAttribute("data-state", "ready")
    await expect(card.getByTestId("claude-agent-state")).toHaveText("준비됨")
    await expect(card.getByTestId("claude-agent-identity")).toHaveText("na***@gmail.com · Max 요금제")
    await expect(card.getByTestId("claude-agent-folder")).toContainText(FOLDER)
    await expect(card.getByTestId("limit-summary")).toBeVisible()
    await expect(card).toContainText("자동 전환 없음 · 계정은 손으로만 바꿔요")
    // None of an API key card's actions, and no automatic switching to turn on.
    await expect(card.getByTestId("account-menu")).toHaveCount(0)
    await expect(card).not.toContainText("자동 전환 허용")
    await expect(card).not.toContainText("키 교체")
    await page.screenshot({ path: test.info().outputPath("claude-agent-card.png") })

    // 02 §8.10.12: the live claude processes against the cap, and the cap changed by hand.
    const pool = section.getByTestId("claude-agent-pool")
    await expect(pool).toContainText("실행 중인 Claude 3/8")
    await expect(pool).toContainText("자리를 기다리는 대화 1개")
    await pool.getByTestId("claude-agent-pool-edit").click()
    const poolDialog = page.getByTestId("claude-agent-pool-dialog")
    await poolDialog.getByTestId("claude-agent-pool-processes").fill("4")
    await poolDialog.getByTestId("claude-agent-pool-save").click()
    await expect(poolDialog).toHaveCount(0)
    expect(poolSets).toEqual([{ processes: 4, spares: 0 }])
    await expect(pool).toContainText("실행 중인 Claude 3/4")

    await card.getByTestId("claude-agent-limits").click()
    await expect(card.getByTestId("claude-agent-card-status")).toHaveText("한도를 새로 읽었어요.")
    expect(refreshes).toEqual([{ accountID: ACCOUNT_ID }])

    await card.getByTestId("claude-agent-remove").click()
    const dialog = page.getByTestId("claude-agent-remove-dialog")
    await expect(dialog).toContainText("Claude Agent 계정 빼기: Claude Agent")
    await expect(dialog.getByTestId("claude-agent-remove-folder")).toBeChecked()
    await expect(dialog).toContainText(FOLDER)
    await dialog.getByTestId("claude-agent-remove-confirm").click()
    await expect(dialog).toHaveCount(0)
    expect(removals).toEqual([{ accountID: ACCOUNT_ID, deleteFolder: true }])
    expect(unexpected(errors)).toEqual([])
  })

  test("signed out and without Claude Code: the state says so and 로그인 opens the login step (mocked)", async ({
    page,
  }) => {
    await mock(page, "accounts.list", {
      revision: 991,
      accounts: [
        agentAccount({
          status: "needs_reauth",
          claudeAgent: { folder: FOLDER, loggedIn: false, cli: true },
        }),
        agentAccount({
          id: "acc_01J9AGENTNOCLI00000000000",
          label: "Claude Agent 2",
          status: "misconfigured",
          claudeAgent: { folder: FOLDER, loggedIn: false, cli: false },
        }),
      ],
    })
    await mock(page, "quota.snapshot", { windows: [] })
    await mock(page, "claudeAgent.status", status({}))
    await page.goto("/accounts")
    const out = page.locator(`[data-testid=claude-agent-card][data-account-id="${ACCOUNT_ID}"]`)
    await expect(out.getByTestId("claude-agent-state")).toHaveText("로그인 필요")
    await expect(out.getByTestId("claude-agent-limits")).toBeDisabled()
    const none = page.locator('[data-testid=claude-agent-card][data-account-id="acc_01J9AGENTNOCLI00000000000"]')
    await expect(none.getByTestId("claude-agent-state")).toHaveText("Claude Code 없음")
    await expect(none.getByTestId("claude-agent-cli-missing")).toBeVisible()
    await out.getByTestId("claude-agent-login").click()
    const dialog = page.getByTestId("claude-agent-login-dialog")
    await expect(dialog).toContainText("Claude Agent 로그인: Claude Agent")
    await expect(dialog.getByTestId("claude-agent-command-cmd")).toHaveText(COMMAND)
    await expect(dialog.getByTestId("claude-agent-command-powershell")).toHaveText(POWERSHELL)
    await expect(dialog.getByTestId("claude-agent-login-open")).toBeEnabled()
    // A phone-width page keeps the card inside the screen.
    await page.setViewportSize({ width: 390, height: 844 })
    await dialog.getByTestId("dialog-close").click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })
})

test.describe("accounts page: two Claude Agent accounts (phase 2)", () => {
  test("the default, another account, and the folder split between the two routes (mocked)", async ({ page }) => {
    const errors = watchErrors(page)
    const second = agentAccount({
      id: SECOND_ID,
      label: "Claude Agent 2",
      shortLabel: "CA2",
      color: "teal",
      claudeAgent: { folder: `${FOLDER}2`, loggedIn: true, cli: true, plan: "pro", default: false, transcripts: "broken" },
    })
    await mock(page, "accounts.list", {
      revision: 992,
      accounts: [
        agentAccount({ claudeAgent: { folder: FOLDER, loggedIn: true, cli: true, plan: "max", default: true } }),
        second,
      ],
    })
    await mock(page, "quota.snapshot", { windows: [] })
    const defaults: unknown[] = []
    await mock(page, "claudeAgent.default.set", (input) => {
      defaults.push(input)
      return { accountID: SECOND_ID }
    })
    const setups: unknown[] = []
    await mock(page, "claudeAgent.setup", (input) => {
      setups.push(input)
      return status({ created: true })
    })
    await mock(page, "claudeAgent.status", status({}))
    const folders = {
      moved: false,
      list: () => [
        {
          folder: FOLDER,
          route: "claude-agent",
          accountID: ACCOUNT_ID,
          label: "Claude Agent",
          loggedIn: true,
          movable: true,
        },
        {
          folder: "C:\\fake\\own\\claude-accounts\\acc_01J9AUTH",
          route: folders.moved ? "claude-agent" : "claude-auth",
          accountID: "acc_01J9AUTH00000000000000000",
          label: "AC-02",
          loggedIn: true,
          movable: true,
        },
        {
          folder: "C:\\Users\\someone\\.claude",
          route: "claude-auth",
          accountID: "acc_claude_slot",
          label: "AC-01",
          loggedIn: true,
          movable: false,
          reason: "slot",
        },
      ],
    }
    await mock(page, "claudeAgent.folders.list", () => ({ folders: folders.list() }))
    const assigned: unknown[] = []
    await mock(page, "claudeAgent.folders.assign", (input) => {
      assigned.push(input)
      folders.moved = true
      return { accountID: "acc_01J9MOVED0000000000000000", route: "claude-agent", folder: FOLDER }
    })
    await page.goto("/accounts")
    const section = page.getByTestId("claude-agent-section")
    const first = section.locator(`[data-testid=claude-agent-card][data-account-id="${ACCOUNT_ID}"]`)
    const other = section.locator(`[data-testid=claude-agent-card][data-account-id="${SECOND_ID}"]`)
    await expect(first.getByTestId("claude-agent-default")).toHaveText("새 대화의 기본")
    await expect(first.getByTestId("claude-agent-make-default")).toHaveCount(0)
    await expect(other.getByTestId("claude-agent-default")).toHaveCount(0)
    // A broken transcript link is said on its card.
    await expect(other.getByTestId("claude-agent-transcripts-broken")).toContainText("대화 기록 연결이 끊겼어요")
    await other.getByTestId("claude-agent-make-default").click()
    await expect(other.getByTestId("claude-agent-card-status")).toHaveText("새 대화는 Claude Agent 2로 시작해요.")
    expect(defaults).toEqual([{ accountID: SECOND_ID }])

    await section.getByTestId("claude-agent-add").click()
    const add = page.getByTestId("claude-agent-add-dialog")
    await expect(add).toContainText("다른 Claude 계정으로 로그인할 폴더를 하나 더 만들어요.")
    await expect(add.getByTestId("claude-agent-login-open")).toBeEnabled()
    expect(setups).toEqual([{ add: true }])
    await add.getByTestId("dialog-close").click()

    const split = section.getByTestId("claude-agent-folders")
    await split.locator("summary").click()
    await expect(split).toContainText("한 폴더는 한 길에서만 써요.")
    const rows = split.getByTestId("claude-agent-folder-row")
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(2)).toContainText("Claude 구독의 계정 1이라 옮길 수 없어요")
    await expect(rows.nth(2).getByTestId("claude-agent-folder-move")).toHaveCount(0)
    await expect(rows.nth(0).getByTestId("claude-agent-folder-move")).toHaveText("Claude 구독으로 옮기기")
    await rows.nth(1).getByTestId("claude-agent-folder-move").click()
    await expect(split.getByTestId("claude-agent-folders-status")).toHaveText(
      "AC-02의 폴더를 Claude Agent로 옮겼어요. 그 안의 로그인은 그대로예요.",
    )
    expect(assigned).toEqual([{ accountID: "acc_01J9AUTH00000000000000000", route: "claude-agent" }])
    await expect(rows.nth(1)).toHaveAttribute("data-route", "claude-agent")
    await page.screenshot({ path: test.info().outputPath("claude-agent-two-accounts.png"), fullPage: true })
    expect(unexpected(errors)).toEqual([])
  })
})

/** An account's compaction view as `accounts.list` sends it for the route (CAG-50): its setting over its models. */
function agentCompaction(setting: Record<string, unknown> | null) {
  const percent = typeof setting?.triggerPercent === "number" ? setting.triggerPercent : undefined
  const trigger = percent === undefined ? 170_000 : (percent / 100) * 200_000
  return {
    setting,
    effective: ["opus", "sonnet", "haiku"].map((modelID) => ({
      modelID,
      windowTokens: 200_000,
      triggerTokens: trigger,
      source: setting ? "account" : "v2",
    })),
  }
}

test.describe("auto-compaction settings: Claude Agent accounts (CAG-50)", () => {
  test("each account row takes its own setting, never 'account not found'; the card shows it (mocked)", async ({
    page,
  }) => {
    const errors = watchErrors(page)
    const settings = new Map<string, Record<string, unknown> | null>([
      [ACCOUNT_ID, null],
      [SECOND_ID, null],
    ])
    const accounts = () => [
      agentAccount({ compaction: agentCompaction(settings.get(ACCOUNT_ID) ?? null) }),
      agentAccount({
        id: SECOND_ID,
        label: "Claude Agent 2",
        shortLabel: "CA2",
        claudeAgent: { folder: FOLDER, loggedIn: true, email: "so***@gmail.com", cli: true },
        compaction: agentCompaction(settings.get(SECOND_ID) ?? null),
      }),
    ]
    await mock(page, "accounts.list", () => ({ revision: 995, accounts: accounts() }))
    await mock(page, "quota.snapshot", { windows: [] })
    await mock(page, "claudeAgent.status", status({ loggedIn: true }))
    const updates: Record<string, unknown>[] = []
    await mock(page, "accounts.update", (input) => {
      updates.push(input)
      const accountID = String(input.accountID)
      if (!input.dryRun) settings.set(accountID, (input.compaction as Record<string, unknown> | null) ?? null)
      const account = accounts().find((item) => item.id === accountID)
      return { account, compactionImpact: { sessions: [] } }
    })
    await page.goto("/settings/compaction")
    const view = page.getByTestId("settings-compaction")
    // The route has a kind row of its own; the Claude slot keeps its fixed one.
    await expect(view.locator('[data-testid=compaction-kind-row][data-kind="claude-agent"]')).toBeVisible()
    const row = view.locator(`[data-testid=compaction-account-row][data-account-id="${ACCOUNT_ID}"]`)
    const other = view.locator(`[data-testid=compaction-account-row][data-account-id="${SECOND_ID}"]`)
    await expect(row).toContainText("(모델 한도)")
    await expect(view.getByTestId("compaction-error")).toHaveCount(0)
    await row.getByRole("radio", { name: "직접 정하기" }).click()
    await row.getByTestId("compaction-percent").fill("40")
    await row.getByTestId("compaction-save").click()
    await expect(page.getByTestId("compaction-status")).toContainText("다음 단계부터 적용돼요.")
    await expect(view.getByTestId("compaction-error")).toHaveCount(0)
    expect(updates.map((item) => [item.accountID, item.dryRun ?? false])).toEqual([
      [ACCOUNT_ID, true],
      [ACCOUNT_ID, false],
    ])
    expect(updates[1]?.compaction).toMatchObject({ triggerPercent: 40 })
    // The mocked server sends no `accounts.changed`: a reload reads the stored setting back.
    await page.reload()
    await expect(row).toContainText("(계정)")
    await expect(other).toContainText("(모델 한도)")
    await page.screenshot({ path: test.info().outputPath("claude-agent-compaction.png"), fullPage: true })

    // The account card names its compaction and links to its row.
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=claude-agent-card][data-account-id="${ACCOUNT_ID}"]`)
    await expect(card.getByTestId("account-compaction")).toContainText("40%")
    await card.getByTestId("account-compaction").getByRole("button").click()
    await expect(page.getByTestId("settings-compaction")).toBeVisible()
    await expect(
      page.locator(`[data-testid=compaction-account-row][data-account-id="${ACCOUNT_ID}"]`),
    ).toBeInViewport()
    expect(unexpected(errors)).toEqual([])
  })
})

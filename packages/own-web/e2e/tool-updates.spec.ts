// 설정 > 업데이트 (05 §20, UPD 2026-11-04) in Edge, with the `tools.*` methods of `own.accounts` (and own.remote's host
// list and update plan) mocked in the page: the statuses and reasons, the update card with the exact command and its
// source, nothing run before `실행`, the streamed output and the version after it, a start Windows refused, the manual
// steps of programs own does not update, the `새 버전 확인` switch, an SSH host whose own differs (own.remote's host
// update card, not executed), the one-line notice of a Claude Agent conversation, and the running card (UCP): the time
// and the native updater's download size, closing it and following the same update again, the ten-minute hint, the
// hour's stop and an install without a download size (npm). The real backend serves the page;
// no tools.* call reaches it, so no program on this PC is ever run and no update happens.
import { expect, test, type Page, type Route } from "@playwright/test"
import { backend, watchErrors } from "./support"

type Handler = (input: Record<string, unknown>) => object | undefined

const CLAUDE = "C:\\Users\\me\\.local\\bin\\claude.exe"
const SOURCE = "https://docs.claude.com/en/docs/claude-code/setup"

async function mock(page: Page, rpc: string, method: string, answer: object | Handler, calls?: string[]) {
  const escaped = `${rpc}/${method}`.replaceAll(".", "\\.")
  await page.route(new RegExp(`/api/rpc/${escaped}(\\?|$)`), async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as { input?: Record<string, unknown> }
    calls?.push(`${method} ${JSON.stringify(body.input ?? {})}`)
    const result = typeof answer === "function" ? (answer as Handler)(body.input ?? {}) : answer
    if (result === undefined) return route.continue()
    return route.fulfill({ json: { output: result } })
  })
}

function claude(patch: Record<string, unknown> = {}) {
  return {
    id: "claude-code",
    path: CLAUDE,
    installed: "2.1.282",
    latest: "2.1.320",
    minimum: "2.1.248",
    recommended: "2.1.301",
    status: "recommended",
    why: "claude_sdk",
    threshold: "2.1.301",
    update: { type: "run", argv: [CLAUDE, "update"], command: "claude update", source: SOURCE },
    ...patch,
  }
}

function view(input: { readonly claude?: object; readonly checkLatest?: boolean; readonly job?: object } = {}) {
  const checkLatest = input.checkLatest ?? true
  const latest = (value: string) => (checkLatest ? value : null)
  return {
    checkLatest,
    checkedAt: Date.now() - 5 * 60_000,
    failed: [],
    items: [
      input.claude ?? claude({ latest: latest("2.1.320") }),
      {
        id: "git",
        path: "C:\\Program Files\\Git\\cmd\\git.exe",
        installed: "2.55.0.windows.3",
        latest: latest("2.56.0.windows.1"),
        minimum: "2.40",
        recommended: "2.42",
        status: checkLatest ? "recommended" : "current",
        ...(checkLatest ? { why: "newer" } : {}),
        update: {
          type: "manual",
          why: "elevation",
          command: "git update-git-for-windows",
          source: "https://gitforwindows.org/",
        },
      },
      {
        id: "git-lfs",
        path: "C:\\Program Files\\Git\\mingw64\\bin\\git-lfs.exe",
        installed: "3.7.1",
        latest: latest("3.8.1"),
        recommended: "3.8.1",
        status: "recommended",
        why: "lfs_security",
        threshold: "3.8.1",
        update: {
          type: "manual",
          why: "bundled",
          command: "git update-git-for-windows",
          source: "https://gitforwindows.org/",
        },
      },
      {
        id: "gh",
        path: "C:\\Program Files\\GitHub CLI\\gh.exe",
        installed: "2.101.0",
        latest: latest("2.101.0"),
        status: "current",
        update: {
          type: "manual",
          why: "elevation",
          command: "winget upgrade --id GitHub.cli -e",
          source: "https://github.com/cli/cli#installation",
        },
      },
      {
        id: "ripgrep",
        path: null,
        installed: null,
        latest: null,
        recommended: "15.1.0",
        status: "current",
        why: "own_copy",
        threshold: "15.1.0",
        update: { type: "manual", why: "not_installed", source: "https://github.com/BurntSushi/ripgrep/releases/latest" },
      },
    ],
    servers: [{ label: "Ollama", url: "http://127.0.0.1:11434", version: "0.12.6" }],
    hostGitLfs: "3.8.1",
    ...(input.job ? { job: input.job } : {}),
  }
}

const PLAN = {
  nonce: "nonce-tool-update-000001",
  expiresAt: Date.now() + 300_000,
  component: "claude-code",
  command: "claude update",
  argv: [CLAUDE, "update"],
  source: SOURCE,
  installed: "2.1.282",
  latest: "2.1.320",
}

function job(patch: Record<string, unknown>) {
  return {
    id: "job-1",
    component: "claude-code",
    command: "claude update",
    state: "running",
    startedAt: Date.now(),
    elapsed: 0,
    exitCode: null,
    before: "2.1.282",
    after: null,
    output: "",
    from: 0,
    length: 0,
    ...patch,
  }
}

function host(patch: Record<string, unknown> = {}) {
  return {
    id: "h_devbox",
    alias: "devbox",
    name: "devbox",
    target: "devbox",
    stage: "incompatible",
    paused: true,
    error: "version_skew",
    detail: "",
    platform: null,
    hostIdentity: null,
    identityChanged: false,
    versions: { local: "2.2.5-own.2", remoteRunning: "2.2.5-own.1", remoteStaged: [], skew: true },
    autoConnect: false,
    loopback: "127.0.3.2",
    localPort: 24_817,
    epoch: 1,
    accounts: { mode: "all" },
    leaseSeconds: 900,
    failClosedGraceSeconds: 300,
    tokenTtlHours: 12,
    projectConfig: "disabled",
    shellEnv: "login",
    warnings: [],
    broker: {
      state: "unavailable",
      mode: null,
      proto: 1,
      leasesActive: 0,
      lastPushAt: null,
      spoolBacklog: 0,
      gaps: 0,
      clockSkewMs: null,
      sourceStale: [],
    },
    sessions: { active: null },
    events: { state: "off", catalogEpoch: 0, catalogFetchedAt: null },
    pendingSettings: false,
    owner: { clientId: null },
    upstreamOpencodeDetected: false,
    ...patch,
  }
}

const ignorable = (errors: string[]) =>
  errors.filter((error) => !/Failed to load resource|net::|status of 400|own\.remote/.test(error))

test.beforeEach(async ({ page }) => {
  await mock(page, "own.accounts", "accounts.import.codex.list", { available: false, sources: [] })
})

test.describe("설정 > 업데이트", () => {
  test("lists each program with its versions, status and reason; manual ones show their steps", async ({ page }) => {
    const errors = watchErrors(page)
    await mock(page, "own.accounts", "tools.view", view())
    await page.goto("/settings/updates")
    const items = page.getByTestId("updates-item")
    await expect(items).toHaveCount(5)
    const row = (id: string) => page.locator(`[data-testid=updates-item][data-id="${id}"]`)

    await expect(row("claude-code").getByTestId("updates-status")).toHaveText("업데이트 권장")
    await expect(row("claude-code").getByTestId("updates-versions")).toHaveText("설치됨 2.1.282 · 최신 2.1.320")
    await expect(row("claude-code").getByTestId("updates-why")).toContainText("Claude Code 2.1.301보다 오래됐어요")
    await expect(row("claude-code").getByTestId("updates-path")).toContainText(CLAUDE)
    await expect(row("claude-code").getByTestId("updates-update")).toBeVisible()

    // Git for all users: no button, the command to copy and the official page.
    await expect(row("git").getByTestId("updates-update")).toHaveCount(0)
    await expect(row("git").getByTestId("updates-manual")).toHaveAttribute("data-why", "elevation")
    await expect(row("git").getByTestId("updates-manual")).toContainText("관리자 권한이 필요해요")
    await expect(row("git").getByTestId("updates-command")).toHaveText("git update-git-for-windows")
    await expect(row("git-lfs").getByTestId("updates-manual")).toContainText("Git을 업데이트하면 같이 바뀌어요")
    await expect(row("git-lfs").getByTestId("updates-why")).toContainText("CVE 4건")
    await expect(row("gh").getByTestId("updates-status")).toHaveText("최신")
    await expect(row("gh").getByTestId("updates-manual")).toHaveCount(0)
    await expect(row("ripgrep").getByTestId("updates-why")).toContainText("ripgrep 15.1.0 사본")

    await expect(page.getByTestId("updates-server")).toHaveText("Ollama · http://127.0.0.1:11434 · 버전 0.12.6")
    await expect(page.getByTestId("updates-checked")).toHaveText("마지막 확인: 5분 전")
    expect(ignorable(errors)).toEqual([])
  })

  test("업데이트: the card shows the exact command and source, runs only on 실행, streams and reads the version after", async ({
    page,
  }) => {
    const calls: string[] = []
    const polls = { count: 0 }
    const state = { updated: false }
    await mock(page, "own.accounts", "tools.view", () =>
      state.updated
        ? view({ claude: claude({ installed: "2.1.320", status: "current", why: undefined, threshold: undefined }) })
        : view(),
    )
    await mock(page, "own.accounts", "tools.update.plan", PLAN, calls)
    await mock(page, "own.accounts", "tools.update.execute", job({ output: "Checking for updates...\n", length: 24 }), calls)
    await mock(
      page,
      "own.accounts",
      "tools.update.status",
      (input) => {
        polls.count += 1
        if (polls.count < 2) return job({ from: input.from, output: "Downloading 2.1.320...\n", length: 47 })
        state.updated = true
        return job({
          state: "done",
          exitCode: 0,
          after: "2.1.320",
          from: input.from,
          output: "Updated to 2.1.320\n",
          length: 66,
          endedAt: Date.now(),
        })
      },
      calls,
    )
    await page.goto("/settings/updates")
    await page.locator('[data-id="claude-code"] [data-testid=updates-update]').click()
    const dialog = page.getByTestId("tool-update-dialog")
    await expect(dialog.getByTestId("tool-update-command")).toHaveText("claude update")
    await expect(dialog.getByTestId("tool-update-argv")).toHaveText(`${CLAUDE} update`)
    await expect(dialog.getByTestId("tool-update-source")).toHaveText(SOURCE)
    await expect(dialog.getByTestId("tool-update-versions")).toHaveText("2.1.282 → 2.1.320")
    expect(calls.filter((call) => call.startsWith("tools.update.execute"))).toEqual([])

    await dialog.getByTestId("tool-update-run").click()
    await expect(dialog.getByTestId("tool-update-result")).toHaveText("끝났어요. 지금 버전: 2.1.320")
    await expect(dialog.getByTestId("tool-update-output")).toHaveText(
      "Checking for updates...\nDownloading 2.1.320...\nUpdated to 2.1.320\n",
    )
    expect(calls.filter((call) => call.startsWith("tools.update.execute"))).toEqual([
      `tools.update.execute {"nonce":"${PLAN.nonce}"}`,
    ])
    // Each poll asks from the length it has.
    expect(calls.filter((call) => call.startsWith("tools.update.status"))).toEqual([
      'tools.update.status {"id":"job-1","from":24}',
      'tools.update.status {"id":"job-1","from":47}',
    ])
    await dialog.getByTestId("tool-update-cancel").click()
    await expect(page.locator('[data-id="claude-code"] [data-testid=updates-status]')).toHaveText("최신")
  })

  test("while it runs: the time and the download so far; closing leaves it running and 진행 보기 follows it", async ({
    page,
  }) => {
    const calls: string[] = []
    const run = { started: false, closed: false, done: false, polls: 0 }
    const started = "Current version: 2.1.282\nChecking for updates to latest version...\nUpdating to 2.1.319...\n"
    const downloading = (from: unknown, bytes: number, elapsed: number) =>
      job({ from, output: "", length: started.length, elapsed, download: { version: "2.1.319", bytes } })
    await mock(page, "own.accounts", "tools.view", () =>
      run.done
        ? view({ claude: claude({ installed: "2.1.319", status: "current", why: undefined, threshold: undefined }) })
        : view(run.started ? { job: downloading(0, 200_000_000, 100_000) } : {}),
    )
    await page.route(/\/api\/rpc\/own\.accounts\/tools\.update\.plan(\?|$)/, (route: Route) => {
      calls.push("tools.update.plan")
      if (!run.started) return route.fulfill({ json: { output: { ...PLAN, latest: "2.1.319" } } })
      return route.fulfill({
        status: 400,
        json: { _tag: "RpcError", type: "tool_busy", message: "another update is running", data: { id: "job-1" } },
      })
    })
    await mock(
      page,
      "own.accounts",
      "tools.update.execute",
      () => {
        run.started = true
        return job({ output: started, length: started.length })
      },
      calls,
    )
    await mock(
      page,
      "own.accounts",
      "tools.update.status",
      (input) => {
        if (!run.closed) return downloading(input.from, 128_000_000, 72_000)
        run.polls += 1
        const resumed = { output: started, length: started.length, elapsed: 150_000 }
        if (input.from === 0) return job({ ...resumed, download: { version: "2.1.319", bytes: 300_000_000 } })
        if (run.polls < 6) return downloading(input.from, 300_000_000, 150_000)
        run.done = true
        return job({
          state: "done",
          exitCode: 0,
          after: "2.1.319",
          from: input.from,
          output: "Successfully updated from 2.1.282 to version 2.1.319\n",
          length: started.length + 52,
          elapsed: 182_000,
          endedAt: Date.now(),
          download: { version: "2.1.319", bytes: 344_807_072 },
        })
      },
      calls,
    )
    await page.goto("/settings/updates")
    await page.locator('[data-id="claude-code"] [data-testid=updates-update]').click()
    const dialog = page.getByTestId("tool-update-dialog")
    await dialog.getByTestId("tool-update-run").click()
    await expect(dialog.getByTestId("tool-update-progress")).toHaveText("내려받는 중 · 128 MB · 1분 12초")
    await expect(dialog.getByTestId("tool-update-note")).toContainText("큰 업데이트는 몇 분 걸릴 수 있어요")
    await expect(dialog.getByTestId("tool-update-note")).toContainText("이 창을 닫아도 업데이트는 계속돼요")
    await expect(dialog.getByTestId("tool-update-slow")).toHaveCount(0)
    await expect(dialog.getByTestId("tool-update-output")).toHaveText(started)

    // Closed while it runs: nothing is stopped, and the row offers the running update again.
    run.closed = true
    await dialog.getByTestId("tool-update-cancel").click()
    await expect(dialog).toHaveCount(0)
    const button = page.locator('[data-id="claude-code"] [data-testid=updates-update]')
    await expect(button).toHaveText("진행 보기")
    await button.click()
    await expect(dialog.getByTestId("tool-update-attached")).toHaveText(
      "이미 실행 중인 업데이트예요. 이어서 보여 드려요: claude update",
    )
    await expect(dialog.getByTestId("tool-update-progress")).toHaveText("내려받는 중 · 300 MB · 2분 30초")
    await expect(dialog.getByTestId("tool-update-run")).toHaveCount(0)
    await expect(dialog.getByTestId("tool-update-result")).toHaveText("끝났어요. 지금 버전: 2.1.319")
    await expect(dialog.getByTestId("tool-update-elapsed")).toHaveText("걸린 시간 3분 2초 · 내려받은 크기 345 MB")
    await expect(dialog.getByTestId("tool-update-output")).toHaveText(
      `${started}Successfully updated from 2.1.282 to version 2.1.319\n`,
    )
    // One start only; the card opened again followed it from the start.
    expect(calls.filter((call) => call.startsWith("tools.update.execute"))).toHaveLength(1)
    expect(calls).toContain('tools.update.status {"id":"job-1","from":0}')
    await dialog.getByTestId("tool-update-cancel").click()
    await expect(page.locator('[data-id="claude-code"] [data-testid=updates-status]')).toHaveText("최신")
  })

  test("after ten minutes the card says how to tell it still moves; after an hour own stopped it and says so", async ({
    page,
  }) => {
    const polls = { count: 0 }
    await mock(page, "own.accounts", "tools.view", view())
    await mock(page, "own.accounts", "tools.update.plan", PLAN)
    await mock(page, "own.accounts", "tools.update.execute", job({ output: "Updating to 2.1.319...\n", length: 23 }))
    await mock(page, "own.accounts", "tools.update.status", (input) => {
      polls.count += 1
      if (polls.count < 4) return job({ from: input.from, length: 23, elapsed: 11 * 60_000 + 5_000 })
      return job({
        state: "failed",
        timedOut: true,
        exitCode: 1,
        after: "2.1.282",
        from: input.from,
        length: 23,
        elapsed: 60 * 60_000,
        endedAt: Date.now(),
      })
    })
    await page.goto("/settings/updates")
    await page.locator('[data-id="claude-code"] [data-testid=updates-update]').click()
    await page.getByTestId("tool-update-run").click()
    await expect(page.getByTestId("tool-update-progress")).toHaveText("실행 중 · 11분 5초")
    await expect(page.getByTestId("tool-update-slow")).toContainText("10분이 넘었어요")
    await expect(page.getByTestId("tool-update-slow")).toContainText("60분이 지나도 끝나지 않으면 own이 멈춰요")
    await expect(page.getByTestId("tool-update-result")).toHaveText(
      "60분이 지나도 끝나지 않아 own이 멈췄어요. 출력을 확인하고 터미널에서 직접 실행해 보세요.",
    )
    await expect(page.getByTestId("tool-update-elapsed")).toHaveText("걸린 시간 1시간 0분")
    await expect(page.getByTestId("tool-update-slow")).toHaveCount(0)
  })

  test("without a download size (npm) the card shows the time; a failure shows its exit code and output", async ({
    page,
  }) => {
    const polls = { count: 0 }
    await mock(page, "own.accounts", "tools.view", view())
    await mock(page, "own.accounts", "tools.update.plan", PLAN)
    await mock(page, "own.accounts", "tools.update.execute", job({ output: "", length: 0 }))
    await mock(page, "own.accounts", "tools.update.status", (input) => {
      polls.count += 1
      if (polls.count < 4) return job({ from: input.from, length: 0, elapsed: 45_000 })
      if (polls.count < 7) return job({ from: input.from, length: 0, elapsed: 46_000, exitCode: 1 })
      return job({
        state: "failed",
        exitCode: 1,
        after: "2.1.282",
        from: input.from,
        output: "npm error code EACCES\n",
        length: 22,
        elapsed: 47_000,
        endedAt: Date.now(),
      })
    })
    await page.goto("/settings/updates")
    await page.locator('[data-id="claude-code"] [data-testid=updates-update]').click()
    await page.getByTestId("tool-update-run").click()
    await expect(page.getByTestId("tool-update-progress")).toHaveText("실행 중 · 45초")
    await expect(page.getByTestId("tool-update-progress")).not.toHaveAttribute("data-download")
    // Exited: its version is read again before the result.
    await expect(page.getByTestId("tool-update-progress")).toHaveText("실행이 끝났어요. 버전을 다시 읽는 중…")
    await expect(page.getByTestId("tool-update-result")).toHaveText(
      "실패했어요(종료 코드 1). 출력을 확인하고 직접 실행해 보세요.",
    )
    await expect(page.getByTestId("tool-update-elapsed")).toHaveText("걸린 시간 47초")
    await expect(page.getByTestId("tool-update-output")).toHaveText("npm error code EACCES\n")
  })

  test("a start Windows refused is shown as blocked, with nothing retried", async ({ page }) => {
    const calls: string[] = []
    await mock(page, "own.accounts", "tools.view", view())
    await mock(page, "own.accounts", "tools.update.plan", PLAN)
    await mock(
      page,
      "own.accounts",
      "tools.update.execute",
      job({ state: "blocked", after: "2.1.282", output: "spawn EUNKNOWN\n", length: 15, endedAt: Date.now() }),
      calls,
    )
    await mock(page, "own.accounts", "tools.update.status", () => job({ state: "blocked" }), calls)
    await page.goto("/settings/updates")
    await page.locator('[data-id="claude-code"] [data-testid=updates-update]').click()
    await page.getByTestId("tool-update-run").click()
    await expect(page.getByTestId("tool-update-result")).toContainText("Windows가 실행을 막았어요")
    await expect(page.getByTestId("tool-update-output")).toHaveText("spawn EUNKNOWN\n")
    // Nothing ran, so no time is shown.
    await expect(page.getByTestId("tool-update-elapsed")).toHaveCount(0)
    expect(calls).toHaveLength(1)
    await expect(page.getByTestId("tool-update-run")).toHaveCount(0)
  })

  test("새 버전 확인 off hides the newest versions; 지금 확인 reads again", async ({ page }) => {
    const calls: string[] = []
    const switched = { off: false }
    await mock(page, "own.accounts", "tools.view", () => view({ checkLatest: !switched.off }), calls)
    await mock(
      page,
      "own.accounts",
      "tools.settings.set",
      (input) => {
        switched.off = input.checkLatest === false
        return view({ checkLatest: !switched.off })
      },
      calls,
    )
    await page.goto("/settings/updates")
    await expect(page.getByTestId("updates-item")).toHaveCount(5)
    await page.getByTestId("updates-check").getByText("끔").click()
    await expect(page.getByTestId("updates-checked")).toHaveText("새 버전 확인을 꺼 둬서 최신 버전은 보이지 않아요")
    await expect(page.locator('[data-id="git"] [data-testid=updates-versions]')).toHaveText(
      "설치됨 2.55.0.windows.3 · 최신 버전 모름",
    )
    expect(calls).toContain('tools.settings.set {"checkLatest":false}')
    await page.getByTestId("updates-refresh").click()
    await expect.poll(() => calls.filter((call) => call === 'tools.view {"refresh":true}').length).toBe(1)
  })

  test("an SSH host whose own differs offers own's host update, never another command", async ({ page }) => {
    const calls: string[] = []
    await mock(page, "own.accounts", "tools.view", view())
    await mock(page, "own.remote", "hosts.list", { revision: 1, hosts: [host()] })
    await mock(
      page,
      "own.remote",
      "update.plan",
      {
        nonce: "nonce-host-update-0000001",
        expiresAt: Date.now() + 300_000,
        from: "2.2.5-own.1",
        to: "2.2.5-own.2",
        staged: false,
        activeSessions: [],
        backup: { bytes: 1024 },
        needBytes: 1024,
        freeBytes: 1_000_000,
      },
      calls,
    )
    await mock(page, "own.remote", "update.execute", {}, calls)
    await page.goto("/settings/updates")
    const row = page.getByTestId("updates-host")
    await expect(row).toContainText("호스트의 own 2.2.5-own.1 · 이 PC 2.2.5-own.2")
    await expect(row).toContainText("필요")
    await expect(page.getByTestId("updates-hosts")).toContainText("git-lfs 3.8.1")
    await row.getByTestId("updates-host-update").click()
    await expect.poll(() => calls).toContain('update.plan {"hostId":"h_devbox"}')
    expect(calls.filter((call) => call.startsWith("update.execute"))).toEqual([])
  })

  test("a Claude Agent conversation on an old Claude Code shows one line with 업데이트", async ({ page }) => {
    const session = backend().sessions[0]!
    await mock(page, "own.accounts", "tools.view", view())
    await mock(page, "own.accounts", "tools.update.plan", PLAN)
    await mock(page, "own.accounts", "session.binding", (input) => ({
      bindings: ((input.sessionIDs as string[] | undefined) ?? []).map((sessionID) => ({
        sessionID,
        model: { providerID: "claude-agent", id: "sonnet" },
        accountID: null,
        builtin: false,
        thirdParty: false,
        home: null,
        switch: { state: "STEADY" },
      })),
    }))
    await page.goto(`/s/${session.id}`)
    const notice = page.getByTestId("claude-code-update-notice")
    await expect(notice).toContainText("Claude Code 2.1.282:")
    await expect(notice).toHaveAttribute("data-why", "claude_sdk")
    await notice.getByTestId("claude-code-update-open").click()
    await expect(page.getByTestId("tool-update-command")).toHaveText("claude update")
    await page.getByTestId("tool-update-cancel").click()
    await notice.getByTestId("claude-code-update-dismiss").click()
    await expect(notice).toHaveCount(0)
  })

  test("a conversation on another provider and a current Claude Code show no line", async ({ page }) => {
    const session = backend().sessions[1]!
    await mock(page, "own.accounts", "tools.view", view({ claude: claude({ installed: "2.1.320", status: "current", why: undefined }) }))
    await page.goto(`/s/${session.id}`)
    await expect(page.getByTestId("composer")).toBeVisible()
    await expect(page.getByTestId("claude-code-update-notice")).toHaveCount(0)
  })
})

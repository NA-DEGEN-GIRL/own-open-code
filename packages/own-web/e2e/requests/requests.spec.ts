// Requests module against the real server with own.accounts (03 §18.1 권한 dock, §18.2 질문·폼·웹 검색 동의, §18.8 승인
// 모드와 저장된 규칙, §9 알림). Requests are created the way core creates them — `POST …/permission` (Permission.ask:
// pending until answered), `POST …/form` (Form.ask), the "global" owner for MCP elicitations — and subagents are
// sessions imported with `parentID`, so no model run is needed. Every test makes its own sessions.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { backend, watchErrors } from "../support"

const state = backend()
const HARNESS = "/e2e/requests/harness.html"

interface Harness {
  readonly notifications: { title: string; body?: string; tag?: string }[]
  readonly opened: string[]
  setFocused(value: boolean): void
  clickLastNotification(): void
  open(sessionID: string): void
  settings(): void
  home(): void
}

declare global {
  interface Window {
    __requestsHarness: Harness
  }
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  if (!response.ok()) throw new Error(`${response.url()}: ${response.status()} ${await response.text()}`)
  return (await response.json()) as T
}

/** `permissions` here is test setup acting as another client; own-web itself never writes session rules. */
async function createSession(
  request: APIRequestContext,
  title: string,
  permissions?: { action: string; resource: string; effect: string }[],
) {
  const created = await json<{ data: { id: string } }>(
    await request.post("/api/session", {
      data: {
        title,
        model: { providerID: state.account.providerID, id: state.model },
        location: { directory: state.workspace },
        ...(permissions ? { permissions } : {}),
      },
    }),
  )
  return created.data.id
}

async function rpc<T>(request: APIRequestContext, method: string, input: unknown) {
  const body = await json<{ output: T }>(
    await request.post(`/api/rpc/own.accounts/${method}`, {
      data: { input },
      params: { "location[directory]": state.workspace },
    }),
  )
  return body.output
}

/** A subagent session: the parent exported and imported again under a new id with `parentID` (explore by default). */
async function importChild(request: APIRequestContext, parentID: string, agent = "explore") {
  const exported = await json<{ data: { info: Record<string, unknown> } }>(
    await request.get(`/api/experimental/session/${parentID}/export`),
  )
  const id = `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`
  await json(
    await request.post("/api/experimental/session/import", {
      data: {
        info: { ...exported.data.info, id, parentID, agent, title: `라우터 조사 (@${agent} subagent)` },
        messages: [],
        location: { directory: state.workspace },
      },
    }),
  )
  return id
}

async function ask(
  request: APIRequestContext,
  sessionID: string,
  body: { action: string; resources: string[]; save?: string[]; metadata?: Record<string, unknown>; agent?: string },
) {
  const created = await json<{ data: { id: string; effect: string } }>(
    await request.post(`/api/session/${sessionID}/permission`, { data: body }),
  )
  return created.data
}

async function pending(request: APIRequestContext, sessionID: string) {
  return (await json<{ data: { id: string }[] }>(await request.get(`/api/session/${sessionID}/permission`))).data
}

async function createForm(request: APIRequestContext, sessionID: string, body: Record<string, unknown>) {
  const created = await json<{ data: { id: string } }>(
    await request.post(`/api/session/${sessionID}/form`, {
      data: body,
      params: sessionID === "global" ? { "location[directory]": state.workspace } : undefined,
    }),
  )
  return created.data.id
}

async function formState(request: APIRequestContext, sessionID: string, formID: string) {
  const detail = await json<{ data: { state: { status: string; answer?: Record<string, unknown> } } }>(
    await request.get(`/api/session/${sessionID}/form/${formID}`, {
      params: sessionID === "global" ? { "location[directory]": state.workspace } : undefined,
    }),
  )
  return detail.data.state
}

async function sessionRules(request: APIRequestContext, sessionID: string) {
  const info = await json<{ data?: { permissions?: { action: string; resource: string; effect: string }[] } }>(
    await request.get(`/api/session/${sessionID}`),
  )
  return info.data?.permissions ?? []
}

async function openHarness(page: Page, sessionID?: string, query = "") {
  await page.goto(`${HARNESS}${query}`)
  await page.waitForFunction(() => !!window.__requestsHarness)
  if (sessionID) await page.evaluate((id) => window.__requestsHarness.open(id), sessionID)
}

/** Brings the folded request whose summary contains `text` to the front (03 §18.1 `다른 요청 n개`). */
async function bringToFront(page: Page, text: string) {
  await expect(page.getByTestId("request-dock")).toBeVisible()
  if (await page.getByTestId("request-title").filter({ hasText: text }).count()) return
  await page.getByTestId("request-more").click()
  await page.getByTestId("request-more-row").filter({ hasText: text }).click()
  await expect(page.getByTestId("request-title")).toHaveText(text)
}

/** Enter during a real Chromium composition (CDP), the order the Windows IME produces in Edge (A2, 03 §12). */
async function composeAndEnter(page: Page, text: string) {
  const cdp = await page.context().newCDPSession(page)
  for (let end = 1; end <= text.length; end++)
    await cdp.send("Input.imeSetComposition", { text: text.slice(0, end), selectionStart: end, selectionEnd: end })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await cdp.detach()
}

// MCP elicitations belong to the directory, not a session: one left pending by an earlier run would join every dock.
test.beforeEach(async ({ request }) => {
  const location = { "location[directory]": state.workspace }
  const listed = await json<{ data: { id: string; sessionID: string }[] }>(
    await request.get("/api/form", { params: location }),
  )
  for (const form of listed.data.filter((item) => item.sessionID === "global"))
    await request.delete(`/api/session/global/form/${form.id}`, { params: location })
})

test.describe("permission dock (03 §18.1)", () => {
  test("shell request: shown without taking focus, keyboard only, pill reads 묻기", async ({ page, request }) => {
    const errors = watchErrors(page)
    const sessionID = await createSession(request, "권한 dock 키보드")
    await rpc(request, "session.approval.set", { sessionID, mode: "ask" })
    await openHarness(page, sessionID)
    await expect(page.getByTestId("approval-pill")).toHaveAttribute("data-mode", "ask")
    await expect(page.getByTestId("approval-pill")).toHaveText(/묻기/)

    const composer = page.getByTestId("composer")
    await composer.focus()
    await page.keyboard.type("draft")
    const asked = await ask(request, sessionID, {
      action: "shell",
      resources: ["bun test --filter router"],
      save: ["bun test *"],
    })
    expect(asked.effect).toBe("ask")

    const dock = page.getByTestId("permission-dock")
    await expect(dock).toBeVisible()
    await expect(dock.getByTestId("request-title")).toHaveText("셸 명령 실행 승인")
    await expect(dock.getByTestId("permission-command")).toHaveText("bun test --filter router")
    await expect(dock.getByTestId("permission-scope")).toHaveText(
      '이 프로젝트에서 "bun test *" 명령은 다시 묻지 않아요',
    )
    // The dock never steals focus from a user who is typing.
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue("draft")

    await page.keyboard.press("Control+Shift+Enter")
    await expect(dock).toBeFocused()
    const reply = page.waitForRequest((item) => item.url().includes(`/permission/${asked.id}/reply`))
    await page.keyboard.press("Enter")
    expect((await reply).postDataJSON()).toEqual({ decision: "once" })
    await expect(dock).toHaveCount(0)
    await expect.poll(() => pending(request, sessionID)).toEqual([])
    // Keyboard flow: focus goes back to the composer when nothing else waits.
    await expect(composer).toBeFocused()
    expect(errors).toEqual([])
  })

  test("항상 허용 saves the request's pattern; 설정 lists it and 취소 makes core ask again", async ({
    page,
    request,
  }) => {
    const sessionID = await createSession(request, "항상 허용 규칙")
    await rpc(request, "session.approval.set", { sessionID, mode: "ask" })
    const pattern = `pnpm lint-${Date.now()} *`
    const command = pattern.replace(" *", " --fix")
    await ask(request, sessionID, { action: "shell", resources: [command], save: [pattern] })
    await openHarness(page, sessionID)
    const dock = page.getByTestId("permission-dock")
    await expect(dock.getByTestId("permission-scope")).toContainText(`"${pattern}" 명령은 다시 묻지 않아요`)
    await dock.focus()
    await page.keyboard.press("Control+Enter")
    await expect(dock).toHaveCount(0)

    const saved = async () =>
      (
        await json<{ data: { id: string; action: string; resource: string }[] }>(
          await request.get("/api/permission/saved"),
        )
      ).data
    await expect.poll(async () => (await saved()).some((rule) => rule.resource === pattern)).toBe(true)
    // The saved rule answers the next matching request by itself.
    expect((await ask(request, sessionID, { action: "shell", resources: [command], save: [pattern] })).effect).toBe(
      "allow",
    )

    await page.evaluate(() => window.__requestsHarness.settings())
    const row = page.getByTestId("saved-rule").filter({ hasText: pattern })
    await expect(row).toBeVisible()
    await expect(row).toContainText("셸 명령")
    await row.getByTestId("saved-rule-remove").click()
    await expect(row).toHaveCount(0)
    await expect(page.getByTestId("toast").last()).toContainText("규칙을 취소했어요")
    await expect.poll(async () => (await saved()).some((rule) => rule.resource === pattern)).toBe(false)
    expect((await ask(request, sessionID, { action: "shell", resources: [command], save: [pattern] })).effect).toBe(
      "ask",
    )
  })

  test("거절… sends the reason (IME Enter sends once); Esc on an empty reason denies without one", async ({
    page,
    request,
  }) => {
    const sessionID = await createSession(request, "거절 사유")
    await rpc(request, "session.approval.set", { sessionID, mode: "ask" })
    await ask(request, sessionID, { action: "shell", resources: ["rm -rf build"], save: ["rm *"] })
    await ask(request, sessionID, { action: "shell", resources: ["git push"], save: ["git push *"] })
    await openHarness(page, sessionID)
    const dock = page.getByTestId("permission-dock")
    await expect(dock.getByTestId("permission-command")).toHaveText("rm -rf build")
    await expect(page.getByTestId("request-more")).toHaveText(/다른 요청 1개/)

    // 다른 요청: bring the second one to the front and back.
    await page.getByTestId("request-more").click()
    await page.getByTestId("request-more-row").click()
    await expect(dock.getByTestId("permission-command")).toHaveText("git push")
    await page.getByTestId("request-more").click()
    await page.getByTestId("request-more-row").click()
    await expect(dock.getByTestId("permission-command")).toHaveText("rm -rf build")

    await page.keyboard.press("Control+Shift+Enter")
    await page.keyboard.press("Escape")
    const input = page.getByTestId("permission-reason-input")
    await expect(input).toBeFocused()
    await expect(page.getByTestId("permission-reject-others")).toHaveText(
      "거절하면 이 대화에서 기다리는 다른 요청 1개도 함께 거절돼요",
    )
    const replies: unknown[] = []
    page.on("request", (item) => {
      if (item.url().includes("/reply")) replies.push(item.postDataJSON())
    })
    await composeAndEnter(page, "빌드 폴더는 지우지 마세요")
    await expect(dock).toHaveCount(0)
    // Core rejects the other pending request of the session together (permission.ts:276-292).
    await expect.poll(() => pending(request, sessionID)).toEqual([])
    expect(replies).toEqual([{ decision: "reject", message: "빌드 폴더는 지우지 마세요" }])

    const third = await ask(request, sessionID, { action: "shell", resources: ["curl example.test"], save: ["curl *"] })
    await expect(dock).toBeVisible()
    await page.keyboard.press("Control+Shift+Enter")
    const reply = page.waitForRequest((item) => item.url().includes(`/permission/${third.id}/reply`))
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("permission-reason-input")).toBeFocused()
    await page.keyboard.press("Escape")
    expect((await reply).postDataJSON()).toEqual({ decision: "reject" })
    await expect(dock).toHaveCount(0)
  })

  test("webfetch shows the URL large; other actions show their resources", async ({ page, request }) => {
    // Core allows external directories by default since upstream 36a38058fb (v2.0.28 sync), so this session asks.
    const sessionID = await createSession(request, "webfetch 승인", [
      { action: "webfetch", resource: "**", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ])
    const url = "https://example.test/docs/router?lang=ko"
    expect((await ask(request, sessionID, { action: "webfetch", resources: [url], save: ["*"] })).effect).toBe("ask")
    const outside = "D:/other-project/*"
    const external = await ask(request, sessionID, {
      action: "external_directory",
      resources: [outside],
      save: ["D:/other-project/*"],
    })
    expect(external.effect).toBe("ask")
    await openHarness(page, sessionID)
    const dock = page.getByTestId("permission-dock")
    await expect(dock.getByTestId("request-title")).toHaveText("웹 페이지 가져오기 승인")
    await expect(dock.getByTestId("permission-url")).toHaveText(url)
    await expect(dock.getByTestId("permission-scope")).toHaveText(
      "이 프로젝트에서 웹 페이지 가져오기는 다시 묻지 않아요",
    )
    await dock.getByTestId("permission-once").click()
    await expect(dock.getByTestId("request-title")).toHaveText("작업 폴더 밖 접근 승인")
    await expect(dock.getByTestId("permission-command")).toHaveText(outside)
    await expect(dock.getByTestId("permission-scope")).toHaveText(
      '이 프로젝트에서 "D:/other-project/*" 작업 폴더 밖 접근은 다시 묻지 않아요',
    )
    await dock.getByTestId("permission-once").click()
    await expect(dock).toHaveCount(0)
  })

  test("edit request: files, change counts and the patch preview; 열기 → opens the subagent", async ({
    page,
    request,
  }) => {
    const parentID = await createSession(request, "하위 에이전트 요청")
    const childID = await importChild(request, parentID)
    // The router PATCHes the parent and its unfinished children (children copy rules only at creation).
    const set = await rpc<{ patched: string[] }>(request, "session.approval.set", { sessionID: parentID, mode: "ask" })
    expect(set.patched).toEqual([parentID, childID])
    const asked = await ask(request, childID, {
      action: "edit",
      agent: "build",
      resources: ["src/router.ts"],
      save: ["*"],
      metadata: {
        files: [
          {
            file: "src/router.ts",
            patch:
              'Index: src/router.ts\n===\n--- a\n+++ b\n@@ -8,3 +8,4 @@\n import { Effect } from "effect"\n+import { estimate } from "./estimate"\n-const x = 1\n+const x = estimate()\n',
            additions: 2,
            deletions: 1,
            status: "modified",
          },
        ],
      },
    })
    expect(asked.effect).toBe("ask")

    await openHarness(page, parentID)
    const dock = page.getByTestId("permission-dock")
    await expect(dock.getByTestId("request-title")).toHaveText("파일 편집 승인")
    await expect(dock.getByTestId("request-origin")).toContainText('하위 에이전트 "explore"의 요청')
    await expect(dock.getByTestId("permission-files")).toContainText("src/router.ts")
    await expect(dock.getByTestId("permission-files")).toContainText("+2 −1")
    await expect(dock.getByTestId("permission-scope")).toHaveText("이 프로젝트에서 파일 편집은 다시 묻지 않아요")
    await dock.getByTestId("permission-diff-toggle").click()
    const diff = dock.getByTestId("permission-diff")
    await expect(diff).toContainText('+import { estimate } from "./estimate"')
    await expect(diff.locator('[data-line="del"]')).toHaveText("-const x = 1")
    await expect(diff).not.toContainText("Index:")

    await dock.getByTestId("request-open-child").click()
    await expect(page.getByTestId("route")).toHaveText(`/srv/local/s/${childID}`)
    // In the subagent's own view the request has no origin line.
    await expect(dock.getByTestId("request-title")).toHaveText("파일 편집 승인")
    await expect(dock.getByTestId("request-origin")).toHaveCount(0)
    await dock.getByTestId("permission-once").click()
    await expect(dock).toHaveCount(0)
    await expect.poll(() => pending(request, childID)).toEqual([])
  })
})

test.describe("question and form dock (03 §18.2)", () => {
  test("question tool: option, multi choice, custom answer; IME Enter on the last field sends once", async ({
    page,
    request,
  }) => {
    const sessionID = await createSession(request, "질문 dock")
    const formID = await createForm(request, sessionID, {
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "msg_e2e", id: "call_e2e" } },
      fields: [
        {
          key: "q0",
          title: "DB",
          description: "어떤 DB를 쓸까요?",
          type: "string",
          options: [
            { value: "SQLite", label: "SQLite (Recommended)", description: "파일 하나" },
            { value: "Postgres", label: "Postgres" },
          ],
          custom: true,
        },
        {
          key: "q1",
          title: "기능",
          description: "무엇을 켤까요?",
          type: "multiselect",
          options: [
            { value: "cache", label: "캐시" },
            { value: "log", label: "로그" },
          ],
          custom: true,
        },
      ],
    })
    await openHarness(page, sessionID)
    const dock = page.getByTestId("form-dock")
    await expect(dock.getByTestId("request-title")).toHaveText("질문 2개")
    await dock.getByTestId("form-option").filter({ hasText: "Postgres" }).click()
    await dock.getByTestId("form-option").filter({ hasText: "로그" }).click()
    await dock.locator('[data-field="q1"]').getByTestId("form-custom").click()
    const custom = dock.locator('[data-field="q1"]').getByTestId("form-custom-input")
    await expect(custom).toBeFocused()
    // Korean IME: Enter during the composition commits it and sends once (last field → send, 03 §12 rule 8).
    const replies: string[] = []
    page.on("request", (item) => {
      if (item.url().includes(`/form/${formID}/reply`)) replies.push(item.method())
    })
    await composeAndEnter(page, "감사 기록")
    await expect(dock).toHaveCount(0)
    expect(replies).toEqual(["POST"])
    await expect
      .poll(() => formState(request, sessionID, formID))
      .toEqual({ status: "answered", answer: { q0: "Postgres", q1: ["log", "감사 기록"] } })
  })

  test("MCP elicitation (global owner): required text, integer range, yes/no; Ctrl+Enter sends", async ({
    page,
    request,
  }) => {
    const sessionID = await createSession(request, "MCP 요청")
    const server = `linear-${Date.now()}`
    const title = `MCP 서버 "${server}"의 요청`
    const formID = await createForm(request, "global", {
      title: `${server} is requesting input`,
      metadata: { kind: "mcp-elicitation", server, message: "팀과 개수를 고르세요" },
      fields: [
        { key: "team", title: "팀", type: "string", required: true },
        { key: "count", title: "개수", type: "integer", minimum: 1, maximum: 5 },
        { key: "confirm", title: "확인", type: "boolean" },
      ],
    })
    await openHarness(page, sessionID)
    // Elicitations belong to the directory, so every session there shows them (other specs may have left some).
    await bringToFront(page, title)
    const dock = page.getByTestId("form-dock").filter({ hasText: title })
    await expect(dock).toBeVisible()
    await expect(dock).toContainText("팀과 개수를 고르세요")
    await dock.getByTestId("form-submit").click()
    await expect(dock.getByRole("alert")).toHaveText("필수 항목을 채우세요")
    await dock.locator('[data-field="team"] input').fill("플랫폼")
    await dock.locator('[data-field="count"] input').fill("9")
    await dock.getByTestId("form-submit").click()
    await expect(dock.locator('[data-field="count"]')).toContainText("1–5")
    await dock.locator('[data-field="count"] input').fill("3")
    await dock.getByTestId("form-boolean").click()
    await dock.locator('[data-field="team"] input').focus()
    await page.keyboard.press("Control+Enter")
    await expect(dock).toHaveCount(0)
    await expect
      .poll(() => formState(request, "global", formID))
      .toEqual({ status: "answered", answer: { team: "플랫폼", count: 3, confirm: true } })
  })

  test("web search consent: allow; 다른 검색 서비스 answers core's second form", async ({ page, request }) => {
    const sessionID = await createSession(request, "웹 검색 동의")
    const consent = {
      title: "Web Search",
      metadata: { kind: "websearch.provider" },
      fields: [
        {
          key: "choice",
          description: "Allow OpenCode to search the web for up-to-date information?",
          type: "string",
          required: true,
          custom: false,
          options: [
            { value: "allow", label: "Allow search via Exa" },
            { value: "choose", label: "Choose another provider" },
            { value: "disable", label: "Disable web search" },
          ],
        },
      ],
    }
    const first = await createForm(request, sessionID, consent)
    await openHarness(page, sessionID)
    const dock = page.getByTestId("websearch-dock")
    await expect(dock.getByTestId("request-title")).toHaveText("웹 검색에 쓸 검색 서비스를 고르세요")
    // A one-time choice of this server, not a permission the approval mode covers (03 §18.2).
    await expect(dock).toContainText("승인 모드(전체 허용 포함)와 따로 이 서버에서 한 번만 고르는 설정")
    await expect(dock).toContainText("검색어가 고른 검색 서비스로 전송돼요.")
    await expect(dock.getByTestId("websearch-allow")).toContainText(/Exa.*검색 허용/)
    await expect(dock).toContainText("모든 대화에서 웹 검색이 꺼져요.")
    await expect(dock).toContainText("답하지 않고 닫으면 이번 웹 검색 호출은 실패해요.")
    // WM (2026-10-19): without a ChatGPT service the card says what one would give, and links to 설정 > 웹 검색.
    await expect(dock.getByTestId("websearch-no-chatgpt")).toHaveText(
      "ChatGPT 계정을 연결하면 ChatGPT 구독으로 검색할 수 있어요.",
    )
    await expect(dock.getByTestId("websearch-settings")).toHaveText("웹 검색 설정 열기 →")
    await expect(dock.getByTestId("websearch-allow-chatgpt")).toHaveCount(0)
    await dock.getByTestId("websearch-allow").click()
    await expect
      .poll(() => formState(request, sessionID, first))
      .toEqual({ status: "answered", answer: { choice: "allow" } })
    await expect(dock).toHaveCount(0)

    const again = await createForm(request, sessionID, consent)
    await dock.getByTestId("websearch-choose").click()
    await dock.getByTestId("websearch-providers").getByRole("radio", { name: "Parallel" }).click()
    await dock.getByTestId("websearch-choose-send").click()
    await expect
      .poll(() => formState(request, sessionID, again))
      .toEqual({ status: "answered", answer: { choice: "choose" } })
    // Core now asks the second form; the dock answers it with the service chosen above.
    const provider = await createForm(request, sessionID, {
      title: "Choose a web search provider",
      metadata: { kind: "websearch.provider" },
      fields: [
        {
          key: "provider",
          description: "Choose a provider for web search.",
          type: "string",
          required: true,
          custom: false,
          options: [
            { value: "exa", label: "Exa" },
            { value: "parallel", label: "Parallel" },
          ],
        },
      ],
    })
    await expect
      .poll(() => formState(request, sessionID, provider))
      .toEqual({ status: "answered", answer: { provider: "parallel" } })
    await expect(dock).toHaveCount(0)
  })

  test("a service list with ChatGPT puts it first, recommended and picked (WM 2026-10-19)", async ({
    page,
    request,
  }) => {
    const sessionID = await createSession(request, "웹 검색 ChatGPT 먼저")
    const form = await createForm(request, sessionID, {
      title: "Choose a web search provider",
      metadata: { kind: "websearch.provider" },
      fields: [
        {
          key: "provider",
          description: "Choose a provider for web search.",
          type: "string",
          required: true,
          custom: false,
          options: [
            { value: "exa", label: "Exa" },
            { value: "own-chatgpt", label: "ChatGPT" },
            { value: "parallel", label: "Parallel" },
          ],
        },
      ],
    })
    await openHarness(page, sessionID)
    const dock = page.getByTestId("websearch-dock")
    const radios = dock.getByTestId("websearch-providers").getByRole("radio")
    await expect(radios.first()).toContainText("ChatGPT")
    await expect(radios.first()).toContainText("추천")
    await expect(radios.first()).toHaveAttribute("aria-checked", "true")
    await expect(dock.getByTestId("websearch-no-chatgpt")).toHaveCount(0)
    // Another pick stays picked (the preselection is once per form).
    await radios.filter({ hasText: "Parallel" }).click()
    await expect(radios.filter({ hasText: "Parallel" })).toHaveAttribute("aria-checked", "true")
    await radios.first().click()
    await dock.getByTestId("websearch-submit").click()
    await expect
      .poll(() => formState(request, sessionID, form))
      .toEqual({ status: "answered", answer: { provider: "own-chatgpt" } })
  })
})

test.describe("approval modes and notifications (03 §18.8, §9)", () => {
  test("읽기 전용 writes ** deny rules to the parent and its subagent; 전체 허용 asks once", async ({
    page,
    request,
  }) => {
    const parentID = await createSession(request, "승인 모드")
    const childID = await importChild(request, parentID)
    await rpc(request, "session.approval.set", { sessionID: parentID, mode: "ask" })
    await openHarness(page, parentID)
    const pill = page.getByTestId("approval-pill")
    await expect(pill).toHaveAttribute("data-mode", "ask")

    await pill.click()
    const menu = page.getByTestId("approval-menu")
    await expect(menu.getByTestId("approval-children")).toHaveText("실행 중인 하위 에이전트 1개에도 적용해요")
    await menu.getByTestId("approval-mode-read-only").click()
    await expect(page.getByTestId("toast").last()).toContainText("읽기 전용")
    await expect(page.getByTestId("toast").last()).toContainText("하위 에이전트 1개에도 적용")
    await expect(pill).toHaveAttribute("data-mode", "read-only")
    for (const id of [parentID, childID]) {
      const rules = await sessionRules(request, id)
      expect(rules).toContainEqual({ action: "edit", resource: "**", effect: "deny" })
      expect(rules).toContainEqual({ action: "shell", resource: "**", effect: "deny" })
      // Tools stay listed: never a `resource:"*"` deny, never a wildcard action (01 §17.1 #9).
      expect(rules.filter((rule) => rule.resource === "*" && rule.effect === "deny")).toEqual([])
      expect(rules.filter((rule) => rule.action === "*")).toEqual([])
    }
    // 읽기 전용: shell requests are denied by the rules and never reach the dock.
    expect((await ask(request, parentID, { action: "shell", resources: ["touch x"], save: ["touch *"] })).effect).toBe(
      "deny",
    )
    await expect(page.getByTestId("permission-dock")).toHaveCount(0)

    await page.getByTestId("composer").focus()
    await page.keyboard.press("Control+Shift+A")
    await expect(menu).toBeVisible()
    await menu.getByTestId("approval-mode-full").click()
    await expect(menu.getByTestId("approval-confirm")).toContainText("따로 막아 주는 장치(샌드박스)는 없어요")
    await expect(pill).toHaveAttribute("data-mode", "read-only")
    await menu.getByTestId("approval-confirm-full").click()
    await expect(pill).toHaveAttribute("data-mode", "full")
    await expect(pill).toHaveText(/전체 허용/)
    const rules = await sessionRules(request, parentID)
    const allow = rules.findIndex(
      (rule) => rule.action === "shell" && rule.resource === "**" && rule.effect === "allow",
    )
    const lastDeny = rules.findLastIndex((rule) => rule.effect === "deny")
    expect(allow).toBeGreaterThanOrEqual(0)
    // Protected-path denies come after the allows, or they would be lifted (03 §18.8).
    expect(lastDeny).toBeGreaterThan(allow)
  })

  test("new-session default mode from the pill and 설정 > 승인·권한", async ({ page, request }) => {
    await openHarness(page)
    const pill = page.getByTestId("approval-pill")
    await expect(pill).toHaveAttribute("data-mode", "ask")
    await pill.click()
    const menu = page.getByTestId("approval-menu")
    await expect(menu).toContainText("새 대화의 기본 승인 모드")
    await menu.getByTestId("approval-mode-read-only").click()
    await expect(pill).toHaveAttribute("data-mode", "read-only")
    expect(await page.evaluate(() => localStorage.getItem("own.web.approval.newSession"))).toBe("read-only")

    await page.evaluate(() => window.__requestsHarness.settings())
    await expect(page.getByTestId("settings-approval-read-only")).toHaveAttribute("aria-checked", "true")
    await page.getByTestId("settings-approval-full").click()
    await expect(page.getByTestId("settings-approval-confirm")).toBeVisible()
    await page.getByTestId("settings-approval-confirm").getByRole("button", { name: "전체 허용으로 바꾸기" }).click()
    await expect(page.getByTestId("settings-approval-full")).toHaveAttribute("aria-checked", "true")
    // 웹 검색 moved to its own page (설정 > 웹 검색, 03 §18.2, WM 2026-10-19; e2e/websearch): this page names the
    // service in use (none here: no ChatGPT account, nothing chosen) and links there.
    const websearch = page.getByTestId("settings-websearch-link")
    await expect(websearch).toContainText("검색 서비스 고르기는 웹 검색 페이지에 있어요.")
    await expect(websearch.getByTestId("settings-websearch-link-now")).toHaveText("지금 쓰는 서비스: 아직 정하지 않았어요")
    await expect(websearch.getByTestId("settings-websearch-open")).toBeVisible()
    // `multi` (MS): what 여러 서비스 함께 would ask, own's default here (no ChatGPT account: core's keyless services).
    expect(await rpc(request, "websearch.get", {})).toEqual({
      keys: {},
      multi: { services: ["exa", "firecrawl", "parallel", "tavily", "tinyfish"], custom: false },
    })
  })

  test("OS notification only while unfocused, merged per session, opens the parent", async ({ page, request }) => {
    const parentID = await createSession(request, "알림 부모 세션")
    // explore is a read-only role whose shell is always denied (07 §2.4), so this child is a general subagent.
    const childID = await importChild(request, parentID, "general")
    await rpc(request, "session.approval.set", { sessionID: parentID, mode: "ask" })
    await openHarness(page)
    // Focused window: the dock and the sidebar show it, no OS notification.
    await ask(request, parentID, { action: "shell", resources: ["echo focused"], save: ["echo *"] })
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.__requestsHarness.notifications.length)).toBe(0)

    await page.evaluate(() => window.__requestsHarness.setFocused(false))
    await ask(request, childID, { action: "shell", resources: ["rg router"], save: ["rg *"] })
    await expect
      .poll(() => page.evaluate(() => window.__requestsHarness.notifications))
      .toEqual([
        {
          title: "하위 에이전트가 승인을 기다려요",
          body: "알림 부모 세션 · 셸 명령",
          tag: `own:approval:local:${parentID}`,
        },
      ])
    // Same session within 10 s: merged.
    await ask(request, parentID, { action: "shell", resources: ["echo again"], save: ["echo *"] })
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.__requestsHarness.notifications.length)).toBe(1)

    await page.evaluate(() => window.__requestsHarness.clickLastNotification())
    await expect(page.getByTestId("route")).toHaveText(`/srv/local/s/${parentID}`)
    await expect(page.getByTestId("permission-dock")).toBeVisible()
    await expect(page.getByTestId("request-more")).toHaveText(/다른 요청 [2-9]개/)
  })
})

test("dock looks the same with the session-ui stylesheet loaded (transcript chunk)", async ({ page, request }) => {
  const sessionID = await createSession(request, "스타일 비교")
  await rpc(request, "session.approval.set", { sessionID, mode: "ask" })
  await ask(request, sessionID, { action: "shell", resources: ["bun run build"], save: ["bun run *"] })
  const measure = async () => {
    const dock = page.getByTestId("permission-dock")
    await expect(dock).toBeVisible()
    return dock.evaluate((element) => {
      const style = (selector: string) => {
        const target = element.querySelector(selector) ?? element
        const computed = getComputedStyle(target)
        return [computed.padding, computed.borderRadius, computed.marginTop, computed.backgroundColor].join(" ")
      }
      return {
        root: style('[data-component="dock-prompt"]'),
        body: style('[data-slot="permission-body"]'),
        footer: style('[data-slot="permission-footer"]'),
        height: Math.round(element.getBoundingClientRect().height),
      }
    })
  }
  await openHarness(page, sessionID)
  const plain = await measure()
  await openHarness(page, sessionID, "?upstream")
  // The session-ui dock rules are in the page now (layered, like the app's transcript chunk).
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.styleSheets].some((sheet) => {
          try {
            return [...sheet.cssRules].some((rule) => rule.cssText.includes('[data-slot="permission-footer"]'))
          } catch {
            return false
          }
        }),
      ),
    )
    .toBe(true)
  const withUpstream = await measure()
  expect(withUpstream).toEqual(plain)
})

test("a question dock keeps own's font with the session-ui stylesheet loaded", async ({ page, request }) => {
  const sessionID = await createSession(request, "질문 글꼴")
  await createForm(request, sessionID, {
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_font", id: "call_font" } },
    fields: [{ key: "q0", title: "DB", type: "string", options: [{ value: "SQLite", label: "SQLite" }] }],
  })
  // session-ui's question frame sets `--v2-font-family-sans` (Inter); own's docks use --own-font-sans (Pretendard).
  const font = async () => {
    const dock = page.getByTestId("form-dock")
    await expect(dock).toBeVisible()
    return dock.evaluate((element) => ({
      root: getComputedStyle(element).fontFamily,
      option: getComputedStyle(element.querySelector('[data-testid="form-option"]') ?? element).fontFamily,
    }))
  }
  await openHarness(page, sessionID)
  const plain = await font()
  await openHarness(page, sessionID, "?upstream")
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.styleSheets].some((sheet) => {
          try {
            return [...sheet.cssRules].some((rule) => rule.cssText.includes('[data-kind="question"]'))
          } catch {
            return false
          }
        }),
      ),
    )
    .toBe(true)
  const withUpstream = await font()
  expect(withUpstream).toEqual(plain)
  expect(withUpstream.root).toContain("Pretendard")
})

// Last: `POST /api/location/reload` rebuilds every loaded location of the server, so it runs only in the isolated
// requests suite (e2e/requests/playwright.config.ts), never next to other specs sharing the backend.
test("another client's location.reload cancels pending requests; the dock says so (03 §8)", async ({
  page,
  request,
}) => {
  test.skip(!process.env.OWN_WEB_REQUESTS_E2E_TMP, "reloads every location: isolated requests suite only")
  const sessionID = await createSession(request, "설정 다시 불러오기")
  await rpc(request, "session.approval.set", { sessionID, mode: "ask" })
  await ask(request, sessionID, { action: "shell", resources: ["sleep 1"], save: ["sleep *"] })
  await openHarness(page, sessionID)
  await expect(page.getByTestId("permission-dock")).toBeVisible()
  expect((await request.post("/api/location/reload")).ok()).toBe(true)
  await expect(page.getByTestId("permission-dock")).toHaveCount(0)
  await expect(page.getByTestId("toast").last()).toHaveText(
    /설정을 다시 불러와 대기 중이던 승인 요청이 취소되었어요\./,
  )
  await expect.poll(() => pending(request, sessionID)).toEqual([])
})

// Composer and "모델 @ 계정" switcher against the real server with own.accounts (03 §4.6, §5.2, §6.2–6.3, §5.8.5,
// §12). The spec makes its own session and a second API-key account (Zeta, fake key) through the API and removes both
// at the end; every policy or session setting a test changes is put back, so other specs see the seeded state.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { backend, useSendKey, watchErrors } from "./support"

const state = backend()
const ZETA_KEY = "sk-proj-ownWebE2eComposerFakeKey00000009"
const session = { id: "", title: "컴포저 e2e" }

type Output = Record<string, unknown> & {
  readonly accounts?: { id: string; label: string; providerID: string; status: string }[]
}

async function rpc(request: APIRequestContext, method: string, input: unknown, directory = state.control) {
  const response = await request.post(`/api/rpc/own.accounts/${method}`, {
    data: { input },
    params: { "location[directory]": directory },
  })
  const body = (await response.json()) as { output?: Output }
  if (!response.ok()) throw new Error(`${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

async function userTexts(request: APIRequestContext, sessionID: string) {
  const response = await request.get(`/api/session/${sessionID}/message`)
  // A session created a moment ago may not be readable yet: poll again.
  if (!response.ok()) return []
  const body = (await response.json()) as { data: { type: string; text?: string }[] }
  return body.data.flatMap((message) => (message.type === "user" && message.text ? [message.text] : []))
}

async function openSession(page: Page) {
  await page.goto(`/srv/local/s/${session.id}`)
  await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Alpha")
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
}

/**
 * Enter during a real Chromium composition (CDP), the order the Windows IME produces in Edge (A2, 03 §12). `modifiers`
 * as CDP has them (2 Ctrl): Ctrl+Enter sends under the default `Ctrl+Enter로 보내기`, Enter under `Enter로 보내기`.
 */
async function composeAndEnter(page: Page, text: string, modifiers = 0) {
  const cdp = await page.context().newCDPSession(page)
  await page.locator("#own-composer-input").focus()
  for (let end = 1; end <= text.length; end++)
    await cdp.send("Input.imeSetComposition", { text: text.slice(0, end), selectionStart: end, selectionEnd: end })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    modifiers,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    modifiers,
    windowsVirtualKeyCode: 13,
  })
  await cdp.detach()
}

let zetaID: string | undefined
let confirm: unknown

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  const created = await request.post("/api/session", {
    data: {
      title: session.title,
      model: { providerID: state.account.providerID, id: state.model },
      location: { directory: state.workspace },
    },
  })
  expect(created.ok()).toBe(true)
  const info = (await created.json()) as { id?: string; data?: { id: string } }
  session.id = info.data?.id ?? info.id ?? ""
  const added = (await rpc(request, "accounts.add.key", {
    kind: "oai",
    label: "Zeta",
    key: ZETA_KEY,
    color: "teal",
  })) as {
    account: { id: string }
  }
  zetaID = added.account.id
  const policy = (await rpc(request, "policy.get", {})) as { policy: { thresholds: { confirm: unknown } } }
  confirm = policy.policy.thresholds.confirm
})

test.afterAll(async ({ request }) => {
  await rpc(request, "policy.set", { patch: { thresholds: { confirm } } }).catch(() => undefined)
  if (session.id) await request.delete(`/api/session/${session.id}`)
  if (!zetaID) return
  const plan = (await rpc(request, "accounts.remove.plan", { accountID: zetaID, mode: "delete" })) as { nonce: string }
  await rpc(request, "accounts.remove.execute", { nonce: plan.nonce })
  zetaID = undefined
})

test.describe("composer (03 §4.6, §12)", () => {
  test("a Korean composition sent with Ctrl+Enter (the default) goes exactly once and empties the box", async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page)
    await openSession(page)
    const text = `안녕 조합 ${Date.now() % 10_000}`
    await composeAndEnter(page, text, 2)
    await expect(page.locator("#own-composer-input")).toHaveValue("")
    await expect.poll(() => userTexts(request, session.id)).toContain(text)
    await page.waitForTimeout(500)
    expect((await userTexts(request, session.id)).filter((item) => item === text)).toHaveLength(1)
    // The turn ran on the fake provider: the context meter now shows the router's numbers (03 §4.4).
    await expect(page.getByTestId("context-meter")).toHaveAttribute("data-mode", "router")
    await expect(page.getByTestId("context-meter")).toHaveAttribute("aria-label", /^문맥 \d+k, 창 922k 중/)
    expect(errors.filter((error) => /composer|switcher|own-cp|own-sw/i.test(error))).toEqual([])
  })

  test("under Enter로 보내기 a Korean composition committed by Enter sends exactly once", async ({ page, request }) => {
    await useSendKey(page, "enter")
    await openSession(page)
    await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
    const text = `엔터 조합 ${Date.now() % 10_000}`
    await composeAndEnter(page, text)
    await expect(page.locator("#own-composer-input")).toHaveValue("")
    await expect.poll(() => userTexts(request, session.id)).toContain(text)
    await page.waitForTimeout(500)
    expect((await userTexts(request, session.id)).filter((item) => item === text)).toHaveLength(1)
  })

  test("Shift+Enter is a newline; the send button sends the whole text", async ({ page, request }) => {
    await openSession(page)
    const composer = page.locator("#own-composer-input")
    await composer.focus()
    const stamp = Date.now() % 10_000
    await page.keyboard.type(`첫 줄 ${stamp}`)
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("둘째 줄")
    await expect(composer).toHaveValue(`첫 줄 ${stamp}\n둘째 줄`)
    await page.getByTestId("composer-send").click()
    await expect(composer).toHaveValue("")
    await expect.poll(() => userTexts(request, session.id)).toContain(`첫 줄 ${stamp}\n둘째 줄`)
  })

  test("drafts stay with their session when switching sessions", async ({ page }) => {
    await openSession(page)
    const composer = page.locator("#own-composer-input")
    await composer.fill("세션 3의 초안")
    await page.getByTestId("session-list").getByText(state.sessions[1]!.title).click()
    await expect(page.getByTestId("header-title")).toHaveText(state.sessions[1]!.title)
    await expect(composer).toHaveValue("")
    await page.getByTestId("session-list").getByText(session.title).click()
    await expect(composer).toHaveValue("세션 3의 초안")
    await composer.fill("")
  })
})

test.describe("switcher (03 §5.2, §6.2)", () => {
  test("Ctrl+. opens the popover on the current account and model; search, keyboard and Esc", async ({ page }) => {
    await openSession(page)
    const composer = page.locator("#own-composer-input")
    await composer.focus()
    await page.keyboard.press("Control+Period")
    const popover = page.getByTestId("switcher")
    await expect(popover).toBeVisible()
    const search = page.getByTestId("switcher-search")
    await expect(search).toBeFocused()
    await expect(popover.locator('[data-testid="switcher-account"][aria-selected="true"]')).toContainText("Alpha")
    await expect(popover.locator('[data-testid="switcher-model"][aria-selected="true"]')).toContainText("GPT-5.5")
    await expect(page.getByTestId("switcher-cost")).toHaveText("현재 사용 중")
    // Search keeps the input element and filters only the lists (IME rule 5).
    await search.evaluate((element) => ((element as HTMLInputElement & { __mark?: number }).__mark = 7))
    await page.keyboard.type("Zeta")
    await expect(popover.getByTestId("switcher-account")).toHaveCount(1)
    await expect(popover.getByTestId("switcher-account")).toContainText("Zeta")
    expect(await search.evaluate((element) => (element as HTMLInputElement & { __mark?: number }).__mark)).toBe(7)
    await expect(search).toHaveAttribute("aria-activedescendant", /own-sw-a-/)
    await page.keyboard.press("Escape")
    await expect(popover).toHaveCount(0)
    await expect(composer).toBeFocused()
  })

  test("a cheap switch applies at once with an undo toast; undo goes back (03 §6.2)", async ({ page }) => {
    await openSession(page)
    await page.getByTestId("composer-switcher").click()
    await expect(page.getByTestId("switcher-search")).toBeFocused()
    // What the conversation has: the primary button only closes, so no 취소 stands beside it (UX 2026-10-26).
    const footer = page.getByTestId("switcher-apply").locator("xpath=..")
    await expect(page.getByTestId("switcher-apply")).toHaveText("닫기")
    await expect(footer.getByRole("button", { name: "취소", exact: true })).toHaveCount(0)
    await page.keyboard.press("ArrowDown")
    await expect(page.locator('[data-testid="switcher-account"][aria-selected="true"]')).toContainText("Zeta")
    await expect(footer.getByRole("button", { name: "취소", exact: true })).toBeVisible()
    await expect(page.getByTestId("switcher-cost")).toContainText("전환 비용 ≈ 캐시 재작성")
    await expect(page.getByTestId("switcher-apply")).toHaveAttribute("data-level", "immediate")
    await page.keyboard.press("Enter")
    const toast = page.getByTestId("toast").filter({ hasText: "Zeta로 전환됨" })
    await expect(toast).toBeVisible()
    await expect(page.getByTestId("running-on")).toHaveText("GPT-5.5 @ Zeta")
    await expect(page.getByTestId("composer-switcher-label")).toHaveText("GPT-5.5 @ Zeta")
    await toast.getByRole("button", { name: "되돌리기" }).click()
    await expect(page.getByTestId("toast").filter({ hasText: "되돌렸어요" })).toBeVisible()
    await expect(page.getByTestId("running-on")).toHaveText("GPT-5.5 @ Alpha")
  })

  test("an expensive switch opens the cost dialog; options follow the router, confirm applies (03 §6.3)", async ({
    page,
    request,
  }) => {
    // Every switch asks: the thresholds come from the router policy, never from the UI (03 §6.2).
    await rpc(request, "policy.set", {
      patch: { thresholds: { confirm: { silentBelowTokens: 0, dialogAtTokens: 0 } } },
    })
    await openSession(page)
    await page.keyboard.press("Control+Period")
    await expect(page.getByTestId("switcher-search")).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByTestId("switcher-apply")).toHaveAttribute("data-level", "dialog")
    await expect(page.getByTestId("switcher-apply")).toHaveText("적용…")
    await page.keyboard.press("Enter")
    const dialog = page.getByTestId("switch-dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("heading")).toHaveText("계정 전환: Alpha → Zeta")
    const strategies = await dialog
      .locator('[role="radio"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-strategy")))
    expect(strategies).toEqual(["now", "compact-then-switch", "cold-point", "new-session"])
    await expect(dialog.getByTestId("switch-option-now")).toHaveAttribute("aria-checked", "true")
    await expect(dialog.getByTestId("switch-option-now")).toBeFocused()
    // Fork lives under 더 보기.
    await dialog.getByRole("button", { name: /더 보기/ }).click()
    await expect(dialog.getByTestId("switch-option-fork")).toBeVisible()
    // Arrow keys move between enabled options only; Tab stays inside (focus trap).
    await dialog.getByTestId("switch-option-now").focus()
    await page.keyboard.press("ArrowDown")
    await expect(dialog.getByTestId("switch-option-compact-then-switch")).toBeFocused()
    await page.keyboard.press("ArrowUp")
    for (let index = 0; index < 12; index++) await page.keyboard.press("Tab")
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    // Cold point (the source is warm): the router schedules it and the composer shows the chip until cancelled.
    const cold = dialog.getByTestId("switch-option-cold-point")
    await expect(cold).toHaveAttribute("aria-disabled", "false")
    await expect(cold).toContainText("다음 압축 직후 또는 약")
    await cold.click()
    await expect(page.getByTestId("switch-dialog-confirm")).toHaveText("캐시가 식은 뒤 전환")
    await page.getByTestId("switch-dialog-confirm").click()
    const chip = page.getByTestId("pending-switch")
    await expect(chip).toHaveAttribute("data-state", "SCHEDULED")
    await expect(chip).toContainText("Zeta로 전환")
    await expect(chip).toContainText("지금 보내면 Alpha로 실행돼요")
    await chip.getByRole("button", { name: "취소" }).click()
    await expect(chip).toHaveCount(0)
    await expect(page.getByTestId("running-on")).toHaveText("GPT-5.5 @ Alpha")
    // Now switch at once through the dialog.
    await page.keyboard.press("Control+Period")
    await page.keyboard.press("ArrowDown")
    await expect(page.getByTestId("switcher-apply")).toHaveAttribute("data-level", "dialog")
    await page.keyboard.press("Enter")
    await expect(dialog).toBeVisible()
    await dialog.getByTestId("switch-option-now").click()
    await page.getByTestId("switch-dialog-confirm").click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("running-on")).toHaveText("GPT-5.5 @ Zeta")
    await expect(page.getByTestId("toast").filter({ hasText: "Zeta로 전환됨" })).toBeVisible()
    // Back to Alpha through the dialog again, then restore the policy.
    await page.keyboard.press("Control+Period")
    await page.keyboard.press("ArrowUp")
    await expect(page.locator('[data-testid="switcher-account"][aria-selected="true"]')).toContainText("Alpha")
    await expect(page.getByTestId("switcher-apply")).toHaveAttribute("data-level", "dialog")
    await page.keyboard.press("Enter")
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("running-on")).toHaveText("GPT-5.5 @ Zeta")
    await page.keyboard.press("Control+Period")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Enter")
    await page.getByTestId("switch-dialog-confirm").click()
    await expect(page.getByTestId("running-on")).toHaveText("GPT-5.5 @ Alpha")
    await rpc(request, "policy.set", { patch: { thresholds: { confirm } } })
  })
})

test.describe("context meter (03 §4.4, §5.8.3, §5.8.5)", () => {
  test("popover actions; the session value is range-checked, saved, and draws a second tick", async ({
    page,
    request,
  }) => {
    await openSession(page)
    const meter = page.getByTestId("context-meter")
    await expect(meter).toHaveAttribute("data-mode", "router")
    await expect(meter.locator(".own-cp-ring-mark")).toHaveCount(1)
    await meter.click()
    const popover = page.getByTestId("context-meter-popover")
    await expect(popover).toContainText("자동 압축 784k (모델 한도)")
    await expect(popover.getByTestId("compact-now")).toBeVisible()
    await popover.getByTestId("compact-session-settings").click()
    const dialog = page.getByTestId("session-compaction")
    await expect(dialog).toBeVisible()
    await dialog.getByRole("radio").nth(1).check()
    const field = dialog.getByTestId("session-compaction-input")
    await field.fill("999,999")
    await dialog.getByTestId("session-compaction-save").click()
    await expect(dialog.getByRole("alert")).toHaveText("계정·모델 지점(784k)보다 늦게 둘 수 없어요")
    await field.fill("200,000")
    await page.keyboard.press("Enter")
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("toast").filter({ hasText: "이 대화 압축 설정을 저장했어요" })).toBeVisible()
    await expect(meter.locator(".own-cp-ring-mark")).toHaveCount(2)
    await expect(meter).toHaveAttribute("title", /이 대화: 200k에서 압축/)
    // Put it back (router call from the test: `compaction.setSession{null}`).
    await rpc(request, "compaction.setSession", { sessionID: session.id, triggerTokens: null }, state.workspace)
    await expect(meter.locator(".own-cp-ring-mark")).toHaveCount(1)
  })
})

test.describe("new session (03 §5.1)", () => {
  test("the home composer uses the switcher's target and creates the session on the first send", async ({
    page,
    request,
  }) => {
    await page.goto("/")
    await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Alpha")
    await page.getByTestId("composer-switcher").click()
    await expect(page.getByTestId("switcher-cost")).toHaveText("새 대화 — 전환 비용 없음")
    await page.keyboard.press("ArrowDown")
    await expect(page.locator('[data-testid="switcher-account"][aria-selected="true"]')).toContainText("Zeta")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("switcher")).toHaveCount(0)
    // The screen without a project starts in the default conversation folder (03 §5.1), where no conversation ran
    // yet: the model is Zeta's group default, not the model of a conversation in another folder (07 §2.2).
    await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Zeta")
    const text = `새 세션 첫 메시지 ${Date.now() % 10_000}`
    await page.locator("#own-composer-input").fill(text)
    await page.keyboard.press("Control+Enter")
    await expect(page).toHaveURL(/\/srv\/local\/s\/ses_/)
    const created = new URL(page.url()).pathname.split("/").at(-1)!
    try {
      await expect.poll(() => userTexts(request, created)).toContain(text)
      const info = (await (await request.get(`/api/session/${created}`)).json()) as {
        data: { model?: { providerID: string; id: string }; location: { directory: string } }
      }
      const zeta = (await rpc(request, "accounts.list", {})).accounts?.find((account) => account.id === zetaID)
      expect(info.data.model?.providerID).toBe(zeta?.providerID)
      const folder = (await rpc(request, "conversationFolder.get", {})) as { path?: string }
      expect(info.data.location.directory.toLowerCase()).toBe(folder.path?.toLowerCase())
      // The approval mode was written before the first prompt (03 §5.1): the router reports its own bundle.
      const approval = (await rpc(request, "session.approval.get", { sessionID: created }, folder.path)) as {
        mode: string
      }
      expect(approval.mode).toBe("ask")
    } finally {
      await request.delete(`/api/session/${created}`)
    }
  })
})

test("in English the composer stays on one line at its full width, and the page says it is English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("own.web.locale", "en"))
  await page.setViewportSize({ width: 1366, height: 800 })
  await page.goto(`/srv/local/s/${state.sessions[0]!.id}`)
  await expect(page.getByTestId("transcript-body")).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  const panel = page.getByTestId("panel")
  if (await panel.isVisible()) await page.getByTestId("panel-toggle").first().click()
  await expect(panel).toBeHidden()
  const bar = page.locator(".own-cp-bar").first()
  await expect(bar).toContainText("Send")
  // The row's controls: `Send` beside the rest, not below them (`Speed: Standard` pushed it to a second line).
  await expect
    .poll(() =>
      bar.evaluate((element) => {
        const send = element.querySelector(".own-cp-send")!.getBoundingClientRect()
        const first = element.querySelector("button")!.getBoundingClientRect()
        return Math.abs(send.top + send.height / 2 - (first.top + first.height / 2)) <= 4
      }),
    )
    .toBe(true)
  // The sidebar's footer shows the connection's word whole or only its dot, never a part of the word.
  const word = page.getByTestId("server-status").locator("span").last()
  const shown = await word.evaluate((element) => {
    const box = element.parentElement!.getBoundingClientRect()
    const text = element.getBoundingClientRect()
    return { right: text.right <= box.right + 0.5, below: text.top >= box.bottom - 0.5 }
  })
  expect(shown.right || shown.below).toBe(true)
  // The switcher: the account's name keeps its whole text beside its chips and its cache.
  await page.keyboard.press("Control+.")
  const name = page.locator(".own-sw-account[aria-selected=true] .own-sw-name")
  await expect(name).toBeVisible()
  expect(await name.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
})

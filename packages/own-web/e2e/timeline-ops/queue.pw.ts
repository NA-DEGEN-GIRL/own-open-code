// 03 §18.9 대기열·끼워 넣기 패널 against the real server: messages sent while a turn runs (Enter = 끼워 넣기 by default,
// Ctrl+Enter = 대기열, 4.6), rows in delivery order with their notes, the badge toggle, reorder by keyboard and by
// dragging (queued rows only), 지금 보내기, 편집 (back into the composer), ✕; and the WAIT_SAFE interplay (02 §5.3): while
// a switch waits for the turn to end the router queues follow-ups and the rows say which account runs them.
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { createSession, openHarness, ops, opsState, shots } from "./support"

test.describe.configure({ mode: "serial" })

async function send(page: Page, text: string, queue = false) {
  const input = page.getByTestId("ops-input")
  await input.fill(text)
  await input.press(queue ? "Control+Enter" : "Enter")
  await expect(page.getByTestId("queue-panel")).toContainText(text)
}

const rowTexts = (page: Page, delivery?: "steer" | "queue") =>
  page
    .getByTestId("queue-row")
    .filter(delivery ? { has: page.locator(`[data-testid="queue-badge"][data-delivery="${delivery}"]`) } : {})
    .locator(".own-q-text")
    .allTextContents()

test("rows, notes, toggle, reorder (keys and drag), send now, edit, cancel", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "대기열 테스트")
  await ops(page, "prompt", "[slow 90] 오래 걸리는 작업")
  await expect.poll(() => ops(page, "status")).toBe("running")

  await send(page, "끼워 넣을 말")
  await send(page, "대기 하나", true)
  await send(page, "대기 둘", true)
  await send(page, "대기 셋", true)
  const panel = page.getByTestId("queue-panel")
  await expect(panel).toContainText("≡ 대기 4")
  // The head names the composer's keys (the default `Ctrl+Enter로 보내기`); this harness input keeps its own.
  await expect(panel).toContainText("실행 중 Ctrl+Enter: 끼워 넣기")
  await expect(page.getByTestId("queue-row").first()).toHaveAttribute("data-delivery", "steer")
  await expect(page.getByTestId("queue-row").first().getByTestId("queue-note")).toHaveText("이번 턴에 끼워 넣음")
  expect(await rowTexts(page, "queue")).toEqual(["대기 하나", "대기 둘", "대기 셋"])
  await expect(page.getByTestId("queue-row").nth(1).getByTestId("queue-note")).toHaveText("턴이 끝나면 보냄")
  await page.screenshot({ path: path.join(shots(), "queue-01-rows.png") })

  // Keyboard reorder on the handle: "대기 셋" two up.
  const handle = (text: string) => page.getByTestId("queue-row").filter({ hasText: text }).getByTestId("queue-handle")
  await handle("대기 셋").focus()
  await page.keyboard.press("ArrowUp")
  await expect.poll(() => rowTexts(page, "queue")).toEqual(["대기 하나", "대기 셋", "대기 둘"])
  await handle("대기 셋").focus()
  await page.keyboard.press("ArrowUp")
  await expect.poll(() => rowTexts(page, "queue")).toEqual(["대기 셋", "대기 하나", "대기 둘"])
  expect((await ops<{ delivery: string }[]>(page, "pending")).filter((item) => item.delivery === "queue")).toHaveLength(
    3,
  )

  // Drag "대기 둘" to the top.
  const from = await handle("대기 둘").boundingBox()
  const to = await handle("대기 셋").boundingBox()
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to!.x + to!.width / 2, to!.y + 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => rowTexts(page, "queue")).toEqual(["대기 둘", "대기 셋", "대기 하나"])

  // Badge: 끼워 넣기 → 대기열 (and back).
  const steerRow = page.getByTestId("queue-row").filter({ hasText: "끼워 넣을 말" })
  await steerRow.getByTestId("queue-badge").click()
  await expect(steerRow).toHaveAttribute("data-delivery", "queue")
  await steerRow.getByTestId("queue-badge").click()
  await expect(steerRow).toHaveAttribute("data-delivery", "steer")

  // 지금 보내기: a queued row steers.
  const oneRow = page.getByTestId("queue-row").filter({ hasText: "대기 하나" })
  await oneRow.getByTestId("queue-send-now").click()
  await expect(oneRow).toHaveAttribute("data-delivery", "steer")

  // 편집: cancelled on the server, the text goes back into the (empty) composer.
  await page.getByTestId("queue-row").filter({ hasText: "대기 셋" }).getByTestId("queue-edit").click()
  await expect(page.getByTestId("ops-input")).toHaveValue("대기 셋")
  await expect(page.getByTestId("queue-row").filter({ hasText: "대기 셋" })).toHaveCount(0)

  // ✕ cancels.
  await page.getByTestId("queue-row").filter({ hasText: "대기 둘" }).getByTestId("queue-cancel").click()
  await expect(page.getByTestId("queue-row").filter({ hasText: "대기 둘" })).toHaveCount(0)
  await expect(panel).toContainText("≡ 대기 2")
  await page.screenshot({ path: path.join(shots(), "queue-02-after-edits.png") })

  await ops(page, "interrupt")
  await expect.poll(() => ops(page, "status")).toBe("idle")
  expect(errors).toEqual([])
})

test("WAIT_SAFE: follow-ups queue behind the pending switch; rows name the account that runs them", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const state = opsState()
  await createSession(page, "전환 대기 테스트")
  await ops(page, "prompt", "[slow 90] 긴 작업")
  await expect.poll(() => ops(page, "status")).toBe("running")
  await send(page, "지금 계정으로 끼워 넣기")

  await ops(page, "switchTo", state.accounts.bravo.providerID, state.model)
  await expect.poll(() => ops(page, "switchState")).toBe("WAIT_SAFE")
  // Enter still means steer, but the router turns a busy session's follow-up into `queue` while the switch waits.
  await send(page, "전환 뒤에 할 일")
  const after = page.getByTestId("queue-row").filter({ hasText: "전환 뒤에 할 일" })
  await expect(after).toHaveAttribute("data-delivery", "queue")
  await expect(after.getByTestId("queue-note")).toHaveText("전환 뒤 Bravo로 실행")
  const now = page.getByTestId("queue-row").filter({ hasText: "지금 계정으로 끼워 넣기" })
  await expect(now.getByTestId("queue-note")).toHaveText("지금 계정(Alpha)으로 실행")
  await page.screenshot({ path: path.join(shots(), "queue-03-wait-safe.png") })

  await ops(page, "cancelSwitch")
  await expect.poll(() => ops(page, "switchState")).not.toBe("WAIT_SAFE")
  await expect(after.getByTestId("queue-note")).toHaveText("턴이 끝나면 보냄")
  await ops(page, "interrupt")
  expect(errors).toEqual([])
})

test("in the transcript a pending steer moves to the queue or is withdrawn; a queued compaction waits below the turn", async ({
  page,
}) => {
  const errors = await openHarness(page)
  await createSession(page, "끼워 넣기 행 테스트")
  await ops(page, "prompt", "[slow 90] 오래 걸리는 작업")
  await expect.poll(() => ops(page, "status")).toBe("running")
  const pendingMessage = (text: string) =>
    page.locator('[data-component="user-message"][data-pending]').filter({ hasText: text })

  // 18.9 (upstream 2db9c2e1b3): the steer's own row says it waits and offers the dock's two actions, in its bubble's
  // menu since upstream v2.2.6 (ae0fde771d).
  const steerAction = async (text: string, action: string) => {
    // The chevron shows (and takes the pointer) while the bubble itself is hovered.
    await pendingMessage(text).locator('[data-slot="user-message-text"]').hover()
    await pendingMessage(text).getByRole("button", { name: "메시지 메뉴" }).click()
    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem")).toContainText([action])
    await expect(menu.getByRole("menuitem", { name: "이 지점으로 복원" })).toHaveCount(0)
    return menu.getByRole("menuitem", { name: action })
  }
  await send(page, "대기열로 옮길 말")
  await expect(pendingMessage("대기열로 옮길 말")).toContainText("끼워 넣기 대기")
  const toQueue = await steerAction("대기열로 옮길 말", "대기열로 옮기기")
  await page.screenshot({ path: path.join(shots(), "queue-04-pending-steer.png") })
  await toQueue.click()
  const moved = page.getByTestId("queue-row").filter({ hasText: "대기열로 옮길 말" })
  await expect(moved).toHaveAttribute("data-delivery", "queue")
  // A queued prompt waits in the dock only.
  await expect(page.locator('[data-component="user-message"]').filter({ hasText: "대기열로 옮길 말" })).toHaveCount(0)

  await send(page, "지울 말")
  await (await steerAction("지울 말", "대기 메시지 취소")).click()
  await expect(page.getByTestId("queue-row").filter({ hasText: "지울 말" })).toHaveCount(0)
  await expect(page.locator('[data-component="user-message"]').filter({ hasText: "지울 말" })).toHaveCount(0)

  // 4.5: a compaction admitted while the turn runs is a divider below it until it starts.
  const compaction = await ops<string>(page, "compact", "queue")
  const queued = page.locator('[data-row="CompactionQueued"]')
  await expect(queued).toContainText("문맥 압축 대기 중")
  await page.screenshot({ path: path.join(shots(), "queue-05-compaction-queued.png") })
  await ops(page, "cancelInbox", compaction)
  await expect(queued).toHaveCount(0)

  await moved.getByTestId("queue-cancel").click()
  await expect(moved).toHaveCount(0)
  await ops(page, "interrupt")
  await expect.poll(() => ops(page, "status")).toBe("idle")
  expect(errors).toEqual([])
})

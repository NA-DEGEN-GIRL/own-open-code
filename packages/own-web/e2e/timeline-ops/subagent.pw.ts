// 03 §18.11 하위 에이전트(자식 세션) 화면 against the real server: the parent runs the `subagent` tool, the child asks for
// a shell approval (a child request the parent must show, 18.1 [gap] 1): the parent's strip and the session button get
// a `? 1` badge, `열기 →` opens the child with the breadcrumb and the disabled composer (`하위 에이전트 세션은 부모 세션이
// 제어합니다`, `부모 대화로`), and answering the request lets both finish.
import path from "node:path"
import { expect, test } from "@playwright/test"
import { createSession, idle, openHarness, ops, shots } from "./support"

test("child request badge, open the child, breadcrumb and disabled composer, back to the parent", async ({ page }) => {
  const errors = await openHarness(page)
  const parentID = await createSession(page, "계정 라우터 RPC 설계", {
    // `묻기` for shell (what the router's approval mode writes, 18.8); children copy these rules when created.
    permissions: [
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "shell", resource: "**", effect: "ask" },
    ],
  })
  await ops(page, "prompt", "[subagent] 라우터 설정을 조사해 줘")
  await expect.poll(async () => (await ops<string[]>(page, "children", parentID)).length, { timeout: 30_000 }).toBe(1)
  const [childID] = await ops<string[]>(page, "children", parentID)
  await expect
    .poll(
      async () =>
        (await ops<string[]>(page, "permissions", childID)).length === 1 ||
        JSON.stringify({ tools: await ops(page, "tools", childID), messages: await ops(page, "messages", childID) }),
      { timeout: 30_000 },
    )
    .toBe(true)

  // Parent view: the strip lists the waiting child; the session button carries the family's badge.
  const strip = page.getByTestId("subagent-strip")
  await expect(strip).toBeVisible()
  const row = strip.getByTestId("subagent-row")
  await expect(row).toHaveAttribute("data-session-id", childID!)
  await expect(row).toContainText("하위 에이전트 general")
  await expect(row.getByTestId("child-request-badge")).toHaveText("? 1")
  await expect(
    page.getByTestId("ops-session").filter({ hasText: "계정 라우터 RPC 설계" }).getByTestId("child-request-badge"),
  ).toHaveText("? 1")
  await page.screenshot({ path: path.join(shots(), "subagent-01-parent.png") })

  // Open the child: breadcrumb, disabled composer, its own waiting request, the way back.
  await row.getByTestId("subagent-open").click()
  await expect.poll(() => ops(page, "current")).toBe(childID)
  const crumbs = page.getByTestId("subagent-breadcrumb")
  await expect(crumbs).toHaveText(/계정 라우터 RPC 설계\s*›\s*하위 에이전트 general/)
  await expect(crumbs.getByRole("button", { name: "계정 라우터 RPC 설계" })).toBeVisible()
  const notice = page.getByTestId("child-notice")
  await expect(notice).toContainText("하위 에이전트 대화는 부모 대화가 제어해요")
  await expect(notice).toContainText("승인·질문 1개")
  await expect(page.getByTestId("ops-input")).toHaveCount(0)
  await page.screenshot({ path: path.join(shots(), "subagent-02-child.png") })
  await notice.getByTestId("child-back").click()
  await expect.poll(() => ops(page, "current")).toBe(parentID)
  await expect(page.getByTestId("ops-header")).toContainText("계정 라우터 RPC 설계")

  // Breadcrumb parent link works too.
  await page.getByTestId("subagent-open").click()
  await crumbs.getByRole("button", { name: "계정 라우터 RPC 설계" }).click()
  await expect.poll(() => ops(page, "current")).toBe(parentID)

  // Answering the child's request lets the child and then the parent finish; the strip goes away.
  await ops(page, "replyAll", childID)
  await idle(page, childID)
  await idle(page, parentID)
  await expect(strip).toHaveCount(0)
  await expect(page.getByTestId("child-request-badge")).toHaveCount(0)
  expect(errors).toEqual([])
})

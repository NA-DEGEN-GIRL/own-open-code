// Transcript additions ported from upstream v2.0.24 (03 §4.5) against the real server: the provider's response body
// of a failed turn (c14a1f5acf) and session ids in an answer that open that session (ffa4c4c730).
import path from "node:path"
import { expect, test } from "@playwright/test"
import { createSession, idle, openHarness, ops, shots } from "./support"

test.describe.configure({ mode: "serial" })

test("a failed turn offers the provider's response body, closed until asked", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "실패 본문 테스트")
  await ops(page, "prompt", "[fail-400] 거절될 요청")
  await idle(page)
  const body = page.getByTestId("error-body")
  const show = body.getByRole("button", { name: "응답 본문 보기" })
  await expect(show).toHaveAttribute("aria-expanded", "false")
  await expect(body.locator("pre")).toHaveCount(0)
  await show.click()
  await expect(body.locator("pre")).toContainText('"code": "own_e2e_refused"')
  await expect(body.getByRole("button", { name: "응답 본문 접기" })).toHaveAttribute("aria-expanded", "true")
  await page.screenshot({ path: path.join(shots(), "transcript-01-error-body.png") })
  expect(errors).toEqual([])
})

test("a turn own stopped on an SSH host says why in Korean with its way out, never the raw JSON (SLM)", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "own이 멈춘 턴")
  // An older host's sink: the bare body becomes the update line, no `응답 본문 보기`.
  await ops(page, "prompt", "[fail-own-old] git init")
  await idle(page)
  const card = page.locator('[data-kind="session-error-card"]').last()
  await expect(card).toContainText("이 PC의 로컬 모델이라면 이 SSH 서버에서 바로 쓸 수 없어요")
  await expect(card).not.toContainText("own_broker_unavailable")
  const old = page.getByTestId("fail-closed").last()
  await expect(old).toHaveAttribute("data-code", "legacy")
  await expect(old.getByRole("button", { name: "다른 모델로 바꾸기" })).toBeVisible()
  await expect(old.getByRole("button", { name: "SSH 원격 호스트 설정" })).toBeVisible()
  await expect(page.getByTestId("error-body")).toHaveCount(0)
  // The PC relay's refusal: its own line and the host settings.
  await ops(page, "prompt", "[fail-own-local] 다시")
  await idle(page)
  await expect(page.locator('[data-kind="session-error-card"]').last()).toContainText(
    "이 로컬 모델은 이 SSH 서버에서 쓰지 않게 되어 있어요",
  )
  await expect(page.getByTestId("fail-closed").last()).toHaveAttribute("data-code", "host_scope")
  await expect(page.getByTestId("error-body")).toHaveCount(0)
  await page.screenshot({ path: path.join(shots(), "transcript-03-fail-closed.png") })
  expect(errors).toEqual([])
})

test("a session id in an answer is a link that opens that session", async ({ page }) => {
  const errors = await openHarness(page)
  const target = await createSession(page, "링크 대상 세션")
  await createSession(page, "링크를 담은 세션")
  // The scripted model repeats the prompt: the answer names the first session.
  await ops(page, "prompt", target)
  await idle(page)
  const link = page.locator(`button.markdown-session-link[data-session-id="${target}"]`)
  // Upstream's session reference reads `@ses_…` since v2.4.0.
  await expect(link).toHaveText(`@${target}`)
  await link.click()
  await expect(page.getByTestId("ops-header")).toContainText("링크 대상 세션")
  expect(await ops(page, "current")).toBe(target)
  expect(errors).toEqual([])
})

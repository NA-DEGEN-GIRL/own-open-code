// 설정 > 자동 압축 > 자리를 비운 사이 압축 (02 §4.7.7, 03 §5.8.4, CC 2026-10-24) against the real server with
// own.accounts, in the real app: off at first, with each provider's cache lifetime and the break-even line; 켜기 is
// stored on the service (`policy.get`) and kept over a reload; 끄기 turns it back off. When it fires is own-accounts'
// test (packages/own-accounts/test/switching/idle-compaction.test.ts). The setting is off before and after.
import { expect, test, type APIRequestContext } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()

interface PolicyView {
  readonly policy: { readonly compaction?: { readonly idle?: { readonly enabled: boolean } } }
}

async function rpc<T>(request: APIRequestContext, method: string, input: unknown = {}) {
  const response = await request.post(`/api/rpc/own.accounts/${method}`, {
    data: { input },
    params: { "location[directory]": state.control },
  })
  const body = (await response.json()) as { output?: T }
  if (!response.ok()) throw new Error(`${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output as T
}

const stored = async (request: APIRequestContext) =>
  (await rpc<PolicyView>(request, "policy.get")).policy.compaction?.idle?.enabled ?? false

const off = (request: APIRequestContext) =>
  rpc(request, "policy.set", { patch: { compaction: { idle: { enabled: false } } } })

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  await off(request)
})

test.afterAll(async ({ request }) => {
  await off(request).catch(() => undefined)
})

test("off at first, the lifetimes and the break-even; 켜기 kept over a reload, then 끄기", async ({ page, request }) => {
  const errors = watchErrors(page)
  await page.goto("/settings/compaction")
  const section = page.getByTestId("idle-compaction-settings")
  await section.scrollIntoViewIfNeeded()
  await expect(section.locator("h2")).toHaveText("자리를 비운 사이 압축")
  const mode = section.getByTestId("idle-compaction-mode")
  await expect(mode.locator('[data-value="off"]')).toHaveAttribute("aria-checked", "true")
  await expect(section).toContainText("기본은 꺼져 있어요.")
  const ttl = section.getByTestId("idle-compaction-ttl")
  await expect(ttl).toContainText("OpenAI API 키(GPT-5.6 이후)")
  await expect(ttl).toContainText("30분 · 약 29분 30초 뒤에 압축")
  await expect(ttl).toContainText("5분 · 지금은 안 함")
  await expect(section.getByTestId("idle-compaction-break-even")).toContainText("16%")
  // The away wait is policy.awayDetect's (10 minutes by default), as the service applies it (CC-16).
  await expect(section.getByTestId("idle-compaction-present")).toContainText("마지막으로 만진 뒤 10분이 지나야")
  expect(await stored(request)).toBe(false)

  await mode.locator('[data-value="on"]').click()
  await expect(section.getByTestId("idle-compaction-status")).toHaveText("저장했어요.")
  expect(await stored(request)).toBe(true)
  await page.reload()
  const again = page.getByTestId("idle-compaction-mode")
  await again.scrollIntoViewIfNeeded()
  await expect(again.locator('[data-value="on"]')).toHaveAttribute("aria-checked", "true")

  await again.locator('[data-value="off"]').click()
  await expect(page.getByTestId("idle-compaction-status")).toHaveText("저장했어요.")
  expect(await stored(request)).toBe(false)
  expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
})

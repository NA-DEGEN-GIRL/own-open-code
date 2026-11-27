// 설정 > 출력 상한 (03 §5.7.4, 02 §4.9) against the real server with own.accounts, in the real app: the page starts on
// the default (이 값을 넘기지 않기 256,000, `기본`), refuses a number out of range, stores a new number with Enter, switches
// to 출력 상한 보내지 않기 at once (the number kept), reads the service again after a reload, and `기본으로` clears the
// stored setting. What each provider then receives is the own-accounts real-server test
// (packages/own-accounts/test/auth/output-limit.e2e.test.ts). The setting is cleared before and after.
import { expect, test, type APIRequestContext } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()

interface PolicyView {
  readonly policy: { readonly outputLimit?: { readonly mode: string; readonly maxTokens: number } }
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
  (await rpc<PolicyView>(request, "policy.get")).policy.outputLimit ?? null

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  await rpc(request, "policy.set", { patch: { outputLimit: null } })
})

test.afterAll(async ({ request }) => {
  await rpc(request, "policy.set", { patch: { outputLimit: null } }).catch(() => undefined)
})

test("모델·계정 lists 출력 상한 after 자동 압축 and before 웹 검색, with its hint and the manual link", async ({
  page,
}) => {
  await page.goto("/settings/output")
  const models = page.getByTestId("settings-group-models")
  await expect(models.getByTestId("settings-nav-output")).toBeVisible()
  const links = await models
    .locator('[data-testid^="settings-nav-"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")))
  expect(links).toEqual([
    "settings-nav-presets",
    "settings-nav-policy",
    "settings-nav-compaction",
    "settings-nav-output",
    "settings-nav-websearch",
    "settings-nav-image",
  ])
  const link = page.getByTestId("settings-nav-output")
  await expect(link).toHaveAttribute("aria-current", "page")
  await expect(link).toContainText("출력 상한")
  await expect(link).toHaveAttribute("title", "한 번 답할 때 넘지 않을 양")
  await expect(page.locator(".own-settings-title")).toHaveText("출력 상한")
  await expect(page.getByTestId("manual-link")).toHaveAttribute("data-place", "output")
})

test("the default, a refused number, a new number, 보내지 않기 kept over a reload, and 기본으로", async ({
  page,
  request,
}) => {
  const errors = watchErrors(page)
  await page.goto("/settings/output")
  const view = page.getByTestId("settings-output-limit")
  await expect(view.getByTestId("output-limit-lead")).toHaveText(
    "한 번 답할 때 생각과 답을 합쳐 넘지 않을 양이에요. 문맥 창(읽을 수 있는 양)과는 달라요.",
  )
  const cap = view.getByTestId("output-limit-cap")
  const omit = view.getByTestId("output-limit-omit")
  const input = view.getByTestId("output-limit-input")
  const status = view.getByTestId("output-limit-status")
  await expect(cap).toBeChecked()
  await expect(view.getByTestId("output-limit-cap-label")).toHaveText("이 값을 넘기지 않기")
  await expect(view.getByTestId("output-limit-omit-label")).toHaveText("출력 상한 보내지 않기")
  await expect(view.getByTestId("output-limit-default")).toHaveText("기본")
  await expect(input).toHaveValue("256,000")
  await expect(view.getByTestId("output-limit-reset")).toBeDisabled()
  await expect(view).toContainText("Claude는 회사 API가 값을 꼭 요구해서 32,000을 보내요")
  await expect(view).toContainText("생각을 끄면 서버 기본값 8K가 너무 짧아 65,536을 보내요")

  // Out of range: the note says so, saving refuses, nothing is stored.
  await input.fill("4,000")
  await expect(input).toHaveAttribute("aria-invalid", "true")
  await expect(view).toContainText("4,096에서 1,000,000 사이의 숫자로 넣어 주세요.")
  await view.getByTestId("output-limit-save").click()
  await expect(status).toHaveText("4,096에서 1,000,000 사이의 숫자로 넣어 주세요.")
  expect(await stored(request)).toBeNull()

  // DeepSeek V4's whole output, with Enter.
  await input.fill("393216")
  await input.press("Enter")
  await expect(status).toHaveText("저장했어요. 다음 요청부터 적용돼요.")
  await expect(input).toHaveValue("393,216")
  await expect(view.getByTestId("output-limit-default")).toHaveCount(0)
  expect(await stored(request)).toEqual({ mode: "cap", maxTokens: 393_216 })

  // 보내지 않기 saves at once and keeps the number for later.
  await omit.check()
  await expect(status).toHaveText("저장했어요. 다음 요청부터 적용돼요.")
  await expect(input).toBeDisabled()
  expect(await stored(request)).toEqual({ mode: "omit", maxTokens: 393_216 })
  await page.reload()
  await expect(omit).toBeChecked()
  await expect(input).toHaveValue("393,216")

  await cap.check()
  await expect(input).toBeEnabled()
  expect(await stored(request)).toEqual({ mode: "cap", maxTokens: 393_216 })

  await view.getByTestId("output-limit-reset").click()
  await expect(status).toHaveText("기본값(256,000을 넘기지 않기)으로 되돌렸어요.")
  await expect(input).toHaveValue("256,000")
  await expect(view.getByTestId("output-limit-default")).toBeVisible()
  expect(await stored(request)).toBeNull()
  expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
})

test("375 px: the page fits the phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/settings/output")
  await expect(page.getByTestId("settings-output-limit")).toBeVisible()
  await expect(page.getByTestId("output-limit-input")).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: "e2e/test-results/output-limit-375.png", fullPage: true })
})

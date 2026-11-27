// 설정 > 이미지 만들기 (03 §5.7.5, decisions IS) against the real server with own.accounts, in the real app: the page
// sits in 모델·계정 after 웹 검색 with its hint and manual link, holds everything the image tool's part of 컴퓨터 사용
// (실험) held, stores the switch and a default through `policy.set`, and 컴퓨터 사용 (실험) keeps only a link to it.
// The default selects' opened lists read in both themes: each option carries the theme's text and background (IS:
// Chromium draws an opened list in the options' colors, and a select without a background of its own drew its light
// dark-theme text on white). The switch and the setting are restored after.
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()

interface PolicyView {
  readonly policy: { readonly imageGenerate?: boolean; readonly image?: { readonly quality?: string } }
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

const policy = async (request: APIRequestContext) => (await rpc<PolicyView>(request, "policy.get")).policy

async function colorScheme(page: Page, scheme: "dark" | "light") {
  await page.evaluate((value) => {
    localStorage.setItem("opencode-color-scheme", value)
    window.dispatchEvent(new StorageEvent("storage", { key: "opencode-color-scheme", newValue: value }))
  }, scheme)
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme)
}

test.describe.configure({ mode: "serial" })

const restore = async (request: APIRequestContext) =>
  rpc(request, "policy.set", { patch: { imageGenerate: false, image: { quality: "auto" } } })

test.beforeAll(async ({ request }) => {
  await restore(request)
})

test.afterAll(async ({ request }) => {
  await restore(request).catch(() => undefined)
})

test("모델·계정 lists 이미지 만들기 after 웹 검색, with its hint and the manual link", async ({ page }) => {
  await page.goto("/settings/websearch")
  const models = page.getByTestId("settings-group-models")
  await expect(models.getByTestId("settings-nav-image")).toBeVisible()
  const links = await models
    .locator('[data-testid^="settings-nav-"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")))
  expect(links.slice(-2)).toEqual(["settings-nav-websearch", "settings-nav-image"])
  const link = models.getByTestId("settings-nav-image")
  await expect(link).toContainText("이미지 만들기")
  await expect(link).toHaveAttribute("title", "모델의 이미지 도구: API 키 순서, Codex 구독")
  await link.click()
  await expect(page).toHaveURL(/\/settings\/image$/)
  await expect(link).toHaveAttribute("aria-current", "page")
  await expect(page.locator(".own-settings-title")).toHaveText("이미지 만들기")
  await expect(page.getByTestId("manual-link")).toHaveAttribute("data-place", "image")
  // 에이전트's 컴퓨터 사용 (실험) stays where it was.
  await expect(page.getByTestId("settings-group-agent").getByTestId("settings-nav-experimental")).toBeVisible()
})

test("the page holds the whole image tool; the switch and a default quality are stored", async ({ page, request }) => {
  const errors = watchErrors(page)
  await page.goto("/settings/image")
  const view = page.getByTestId("settings-image-tool")
  await expect(view.getByText("모델에 이미지 만들기 도구 주기")).toBeVisible()
  for (const id of [
    "image-tool-toggle",
    "image-family-auto",
    "image-family-flare",
    "image-family-sunburst",
    "image-family-gpt-image-2",
    "image-quality",
    "image-size",
    "image-use-keys",
    "image-add-key",
    "image-codex-fallback",
    "image-codex-terms",
  ])
    await expect(view.getByTestId(id), id).toBeVisible()
  for (const heading of ["모델 (API 키)", "OpenAI API 키 순서"])
    await expect(view.getByRole("heading", { name: heading, exact: true })).toBeVisible()
  await expect(view.getByText("Codex 구독으로 대신 만들기", { exact: true })).toBeVisible()
  // The old section heading is gone: the page's own title names it.
  await expect(view.getByRole("heading", { name: "이미지 만들기 도구" })).toHaveCount(0)

  const toggle = view.getByTestId("image-tool-toggle")
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(view.getByTestId("image-tool-status")).toContainText("켰어요")
  await expect.poll(async () => (await policy(request)).imageGenerate).toBe(true)
  await toggle.uncheck()
  await expect(view.getByTestId("image-tool-status")).toContainText("껐어요")
  await expect.poll(async () => (await policy(request)).imageGenerate ?? false).toBe(false)

  await view.getByTestId("image-quality").selectOption("low")
  await expect(view.getByTestId("image-tool-status")).toContainText("저장했어요")
  await expect.poll(async () => (await policy(request)).image?.quality).toBe("low")
  await page.reload()
  await expect(page.getByTestId("image-quality")).toHaveValue("low")

  // 이미지 설정 열기's twin: the key form opens from here.
  await page.getByTestId("image-add-key").click()
  await expect(page).toHaveURL(/\/accounts\/add\/oai$/)
  // Plugins this backend does not load (own.team, own.remote, own.import) answer 400 to the shell's probes.
  expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
})

test("컴퓨터 사용 (실험) keeps only a link to the new page", async ({ page }) => {
  await page.goto("/settings/experimental")
  await expect(page.getByTestId("settings-experimental")).toBeVisible()
  await expect(page.getByTestId("settings-image-tool")).toHaveCount(0)
  const moved = page.getByTestId("settings-image-moved")
  await expect(moved).toHaveText("이미지 만들기 도구는 설정 > 이미지 만들기로 옮겼어요 →")
  await moved.click()
  await expect(page).toHaveURL(/\/settings\/image$/)
  await expect(page.getByTestId("settings-image-tool")).toBeVisible()
})

test("a conversation's 이미지 설정 열기 opens the page", async ({ page, request }) => {
  // A conversation whose image call found no account (IM-13): the first session exported and imported again under a
  // new id with that one call.
  const exported = (await (await request.get(`/api/experimental/session/${state.sessions[0]!.id}/export`)).json()) as {
    data: { info: Record<string, unknown> & { model: unknown; time: { created: number } } }
  }
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 26)
  const id = `ses_${suffix}`
  const at = exported.data.info.time.created + 1_000
  const response = await request.post("/api/experimental/session/import", {
    data: {
      info: { ...exported.data.info, id, title: "이미지 계정 없음" },
      messages: [
        { id: `msg_${suffix}_000001`, type: "user", text: "아이콘을 그려 줘", time: { created: at } },
        {
          id: `msg_${suffix}_000002`,
          type: "assistant",
          agent: "build",
          model: exported.data.info.model,
          content: [
            {
              type: "tool",
              id: "call_image_none",
              name: "image_generate",
              state: {
                status: "completed",
                input: { prompt: "an icon" },
                content: [{ type: "text", text: "No account can make images right now." }],
                metadata: {
                  ownImage: {
                    status: "unavailable",
                    steps: [
                      { route: "key", accountID: "acc_none", label: "회사 키", outcome: "skipped", why: "꺼 뒀어요" },
                    ],
                  },
                },
              },
              time: { created: at + 200, ran: at + 250, completed: at + 300 },
            },
          ],
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
          finish: "stop",
          time: { created: at + 100, streamed: at + 300, completed: at + 400 },
        },
      ],
      location: { directory: state.workspace },
    },
  })
  expect(response.ok(), await response.text()).toBe(true)
  await page.goto(`/srv/local/s/${id}`)
  const line = page.getByTestId("image-line")
  await expect(line).toHaveAttribute("data-status", "unavailable")
  await line.getByTestId("image-line-settings").click()
  await expect(page).toHaveURL(/\/settings\/image$/)
  await expect(page.getByTestId("settings-image-tool")).toBeVisible()
})

test("the default selects and their lists read in the dark and the light theme", async ({ page }, info) => {
  await page.goto("/settings/image")
  const view = page.getByTestId("settings-image-tool")
  await expect(view.getByTestId("image-quality")).toBeVisible()
  for (const scheme of ["dark", "light"] as const) {
    await colorScheme(page, scheme)
    const colors = await view.locator("select").evaluateAll((selects) => {
      // WCAG relative luminance and contrast of two computed `rgb(…)` colors.
      const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
      const luminance = (color: string) => {
        const [r, g, b] = channels(color).map((value) => {
          const c = value / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const contrast = (a: string, b: string) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
        return (high! + 0.05) / (low! + 0.05)
      }
      return selects.map((select) => {
        const style = getComputedStyle(select)
        const options = Array.from((select as HTMLSelectElement).options).map((option) => {
          const own = getComputedStyle(option)
          return {
            text: own.color,
            background: own.backgroundColor,
            contrast: contrast(own.color, own.backgroundColor),
          }
        })
        return {
          scheme: style.colorScheme,
          background: style.backgroundColor,
          contrast: contrast(style.color, style.backgroundColor),
          options,
        }
      })
    })
    expect(colors).toHaveLength(2)
    for (const select of colors) {
      expect(select.scheme, scheme).toBe(scheme)
      // An opaque field (own-input), not the preflight's transparent one.
      expect(select.background, scheme).not.toBe("rgba(0, 0, 0, 0)")
      expect(select.contrast, scheme).toBeGreaterThanOrEqual(4.5)
      for (const option of select.options) {
        expect(option.background, scheme).not.toBe("rgba(0, 0, 0, 0)")
        expect(option.contrast, `${scheme} ${option.text} on ${option.background}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // The opened list is the browser's own window, out of a screenshot's reach; a list box draws the same options in
    // the page, kept as the picture of each theme.
    const quality = view.getByTestId("image-quality")
    await quality.evaluate((select: HTMLSelectElement) => {
      select.size = 4
      select.style.height = "auto"
    })
    await quality.screenshot({ path: path.join(info.outputDir, `image-quality-list-${scheme}.png`) })
    await quality.evaluate((select: HTMLSelectElement) => {
      select.size = 0
      select.style.height = ""
    })
  }
  await colorScheme(page, "dark")
})

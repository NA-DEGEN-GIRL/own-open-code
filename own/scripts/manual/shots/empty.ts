// Group E: no account yet (the first screen and the add flows), with a fake ChatGPT sign-in and a fake old app
// (codex-multi-provider profiles `회사 Plus` and `개인 백업`, one saved DeepSeek key). Nothing is added: each flow stops
// at the screen the manual shows.
import type { Locator, Page } from "../lib/browser"
import type { Ctx, Endpoints, Shot } from "../lib/ctx"
import { start } from "../lib/world"

export interface EmptyState extends Endpoints {
  readonly root: string
  readonly control: string
  readonly demo: string
  readonly home: string
  readonly project: string
}

export const emptyPaths = (state: EmptyState) => ({ demo: state.demo, home: state.home, root: state.root })

export function bootEmpty() {
  return start<EmptyState>(
    "empty",
    {
      script: "e2e/manual/backend.ts",
      env: { OWN_MANUAL_WORLD: "empty", OWN_MANUAL_PORT: "6311" },
      ready: "OWN_MANUAL_READY",
    },
    emptyPaths,
  )
}

type C = Ctx<EmptyState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<EmptyState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

/** The add-account dialog on its type grid. */
async function addDialog(ctx: C) {
  const page = await ctx.page({ path: "/accounts/add" })
  const grid = tid(page, "add-type-grid")
  await grid.waitFor()
  await page.waitForTimeout(600)
  return { page, dialog: page.getByRole("dialog").filter({ has: grid }), grid }
}

export const EMPTY: ReadonlyArray<Shot<EmptyState>> = [
  shot("03-empty", async (ctx) => {
    const page = await ctx.page()
    const empty = tid(page, "accounts-empty")
    await empty.waitFor()
    await page.waitForTimeout(800)
    await ctx.shoot(page, "03-empty", { marks: [empty.getByText("계정 추가", { exact: true })] })
  }),
  shot("03-add-types", async (ctx) => {
    const opened = await addDialog(ctx)
    await ctx.shoot(opened.page, "03-add-types", {
      clip: opened.dialog,
      marks: [
        opened.grid.getByRole("button").filter({ hasText: "ChatGPT 구독" }).first(),
        opened.grid.getByRole("button").filter({ hasText: "이전 앱에서 가져오기" }).first(),
      ],
    })
  }),
  shot("03-add-key", async (ctx) => {
    const opened = await addDialog(ctx)
    await opened.grid.getByRole("button").filter({ hasText: "DeepSeek" }).first().click()
    const form = tid(opened.page, "api-key-form")
    await form.waitFor()
    await field(form, "key-label").fill("DeepSeek")
    await field(form, "key-secret").fill("sk-demo-0000000000000000000000000000")
    await opened.page.waitForTimeout(400)
    const dialog = opened.page.getByRole("dialog").filter({ has: form })
    await ctx.shoot(opened.page, "03-add-key", { clip: dialog, marks: [tid(form, "key-submit")] })
  }),
  shot("03-chatgpt-code", async (ctx) => {
    const opened = await addDialog(ctx)
    await opened.grid.getByRole("button").filter({ hasText: "ChatGPT 구독" }).first().click()
    await tid(opened.page, "chatgpt-start").click()
    const code = tid(opened.page, "chatgpt-code")
    await code.waitFor({ timeout: 30_000 })
    await opened.page.waitForTimeout(600)
    // The demo's sign-in issuer is a local fake: its button shows the real address the app opens.
    await opened.page.evaluate(() => {
      for (const element of document.querySelectorAll("button, a"))
        for (const node of element.childNodes)
          if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.includes("/codex/device"))
            node.nodeValue = node.nodeValue.replace(/http:\/\/127\.0\.0\.1:\d+/, "https://auth.openai.com")
    })
    const dialog = opened.page.getByRole("dialog").filter({ has: code })
    await ctx.shoot(opened.page, "03-chatgpt-code", {
      clip: dialog,
      marks: [code, dialog.getByText(/auth\.openai\.com\/codex\/device/).first()],
    })
  }),
  shot("03-import-legacy", async (ctx) => {
    const opened = await addDialog(ctx)
    await opened.grid.getByRole("button").filter({ hasText: "이전 앱에서 가져오기" }).first().click()
    const list = tid(opened.page, "codex-list")
    await list.waitFor({ timeout: 30_000 })
    await opened.page.waitForTimeout(800)
    const dialog = opened.page.getByRole("dialog").filter({ has: list })
    await ctx.shoot(opened.page, "03-import-legacy", {
      clip: dialog,
      marks: [
        dialog.getByText(/^연결 \(권장\)/).first(),
        dialog.getByText(/^인수 — /).first(),
        tid(dialog, "legacy-key-row").first(),
      ],
    })
  }),
]

/** A text field by its test id: the input itself or the input inside it. */
function field(scope: Locator, id: string) {
  return scope.locator(`input[data-testid=${id}], [data-testid=${id}] input, textarea[data-testid=${id}]`).first()
}

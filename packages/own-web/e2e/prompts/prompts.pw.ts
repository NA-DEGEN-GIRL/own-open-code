// 설정 > 에이전트 방식 (10 §3.11) end to end: view what Codex 방식 sends GPT-5.5 (part by part, searchable, own's
// changes), start 내 지시문 from 개선판, edit and save it, pick it on a new conversation's pill and check the request
// the fake received carries it as the base instructions, then 기본으로 되돌리기 and check the same conversation's next
// request carries 개선판 (for GPT-5.5, Codex's template) again. `비교` puts 원본 beside 개선판 (and 개선판 beside 내
// 지시문) part by part, with own's reasons under the changed runs, and `자세히` opens the manual at that change (its
// chapter when this build's manual lacks it). Then 비교's whitespace marks, its folds from the keyboard alone and
// across a 승인 모드 switch, a blank line added beside an edited line, the characters that render as nothing (each a
// glyph named with its code point), a real Ctrl+C that keeps a no-break space, the contrast of its marks and labels in
// both themes, and its layout at the app's widths. `하위 에이전트` shows, on every tab, the delegation tool as the service
// sends it, a child's first line and what comes back.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test"
import { ALLOWED } from "../ui-audit/allowlist"
import { Audit, emulateWindowControls, line, WINDOW_BUTTONS } from "../ui-audit/audit"

const STATE = path.join(process.env.OWN_WEB_PROMPTS_E2E_TMP ?? "", "backend.json")
const state = JSON.parse(fs.readFileSync(STATE, "utf8")) as {
  readonly dev: string
  readonly requests: string
  readonly account: { readonly providerID: string }
  readonly model: string
}
const CUSTOM = "E2E-내지시문: answer in one short Korean sentence."
/** Screenshots for a look at the page (not compared): `<tmp>/shots`. */
const SHOTS = path.join(process.env.OWN_WEB_PROMPTS_E2E_TMP ?? "", "shots")
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })

type Body = { readonly input?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }> }

/** The base instructions (the first developer message) of the request that carried `text`. */
async function baseOf(text: string) {
  const bodies = (await (await fetch(state.requests)).json()) as ReadonlyArray<Body>
  const body = bodies.findLast((entry) => JSON.stringify(entry.input ?? []).includes(text))
  const first = body?.input?.[0]?.content
  return Array.isArray(first) ? (first[0] as { readonly text?: string } | undefined)?.text : undefined
}

async function openPage(page: Page) {
  await page.goto("/settings/harness")
  const root = page.getByTestId("settings-harness")
  await expect(root.getByTestId("prompt-preview")).toBeVisible()
  return root
}

test("view → edit → save → a conversation uses it → reset", async ({ page }) => {
  const root = await openPage(page)
  // The service's defaults: Codex 방식, 개선판.
  await expect(root.getByTestId("prompt-harness").getByRole("radio", { name: "Codex 방식" })).toHaveAttribute(
    "aria-checked",
    "true",
  )
  await expect(root.getByTestId("prompt-variant").getByRole("radio", { name: "개선판" })).toHaveAttribute(
    "aria-checked",
    "true",
  )
  // The model a new conversation would start on, not the service's first model (OpenCode's free one). From 설정 that
  // is a conversation in the 기본 대화 폴더 (DF-9), so the account's group default, whichever model its catalog names.
  await expect(root.getByTestId("prompt-model")).toHaveValue(new RegExp(`^${state.account.providerID}/`))
  await root.getByTestId("prompt-model").selectOption(`${state.account.providerID}/${state.model}`)
  const part = (kind: string) => root.locator(`[data-testid="prompt-part"][data-kind="${kind}"]`)
  const base = part("base").getByTestId("prompt-part-text")
  await expect(base).toContainText("You are Codex")
  await expect(part("base")).toContainText("내 지시문으로 바꿀 수 있어요")
  await expect(part("permissions")).toContainText("이 앱이 만들어요")
  await expect(root.getByTestId("prompt-tools")).toContainText("exec_command")
  // A GPT model of Codex's catalog: 개선판 sends Codex's text, nothing is changed for it.
  await expect(root.getByTestId("prompt-changes")).toContainText("이 모델에는 고친 곳이 없어요")
  await expect(root.getByTestId("prompt-changes-others")).toBeVisible()
  await shot(page, "1-view")

  // Search highlights in the text and counts.
  await root.getByTestId("prompt-search").fill("apply_patch")
  await expect(root.getByTestId("prompt-search-count")).toHaveText(/^\d+곳$/)
  await expect(base.locator("mark").first()).toHaveText("apply_patch")
  await shot(page, "2-search")
  await root.getByTestId("prompt-search").fill("")

  // 내 지시문: none saved yet, so the page shows 개선판 and offers the starting texts.
  await root.getByTestId("prompt-variant").getByRole("radio", { name: "내 지시문" }).click()
  await expect(root.getByTestId("prompt-custom-missing")).toBeVisible()
  await root.getByTestId("prompt-custom-from-own").click()
  const editor = root.getByTestId("prompt-custom-text")
  await expect(editor).toHaveValue(/^You are Codex/)
  await editor.fill(CUSTOM)
  await root.getByTestId("prompt-custom-save").click()
  await expect(page.getByText("내 지시문을 저장했어요")).toBeVisible()
  await expect(root.getByTestId("prompt-custom-missing")).toHaveCount(0)
  await expect(base).toHaveText(CUSTOM)
  await shot(page, "3-saved")
  await expect(root.getByTestId("prompt-custom-cache")).toHaveText(
    "다음 요청부터 바뀌어요. 내 지시문을 쓰는 대화는 그때 대화 앞부분 캐시를 한 번 새로 써요.",
  )

  // A new conversation on 내 지시문, picked on its pill.
  await page.goto("/")
  await page.getByTestId("project-row").first().getByTestId("project-new-session").click()
  const pill = page.getByTestId("harness-pill")
  await pill.click()
  const menu = page.getByTestId("harness-menu")
  await menu.getByTestId("harness-prompt-custom").click()
  await expect(pill).toHaveAttribute("data-prompt", "custom")
  await expect(pill).toContainText("내 지시문")
  const composer = page.locator("#own-composer-input")
  await composer.fill("첫 질문이에요")
  await composer.press("Control+Enter")
  await expect(page).toHaveURL(/\/srv\/local\/s\//)
  const conversation = page.url()
  await expect.poll(() => baseOf("첫 질문이에요"), { timeout: 30_000 }).toBe(CUSTOM)
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })

  // 기본으로 되돌리기: the text is deleted after a confirmation.
  const again = await openPage(page)
  // The pick of the first visit, remembered on this device.
  await expect(again.getByTestId("prompt-model")).toHaveValue(`${state.account.providerID}/${state.model}`)
  await again.getByTestId("prompt-variant").getByRole("radio", { name: "내 지시문" }).click()
  await expect(again.getByTestId("prompt-custom-text")).toHaveValue(CUSTOM)
  await again.getByTestId("prompt-custom-reset").click()
  const dialog = page.getByTestId("prompt-custom-reset-dialog")
  await expect(dialog).toContainText("내 지시문을 고른 대화와 새 대화는 다음 요청부터 개선판으로 일해요.")
  await shot(page, "4-reset-dialog")
  await dialog.getByTestId("prompt-custom-reset-confirm").click()
  await expect(page.getByText("내 지시문을 지웠어요. 내 지시문을 고른 대화는 개선판으로 일해요.")).toBeVisible()
  await expect(again.getByTestId("prompt-custom-missing")).toBeVisible()
  await expect(again.locator('[data-testid="prompt-part"][data-kind="base"]')).toContainText("You are Codex")

  // The same conversation still names 내 지시문 and now runs 개선판; its pill says what runs.
  await page.goto(conversation)
  await expect(page.getByTestId("harness-pill")).toHaveAttribute("data-prompt", "custom")
  await expect(page.getByTestId("harness-pill")).toContainText("개선판")
  await page.locator("#own-composer-input").fill("두 번째 질문이에요")
  await page.locator("#own-composer-input").press("Control+Enter")
  await expect
    .poll(async () => (await baseOf("두 번째 질문이에요"))?.startsWith("You are Codex"), {
      timeout: 30_000,
    })
    .toBe(true)
})

test("omo (원본) (own/docs/15): offered where own-omo runs, no 지시문 to pick, its note, and a conversation that runs omo", async ({
  page,
}) => {
  const root = await openPage(page)
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "omo (원본)" }).click()
  await expect(root.getByTestId("prompt-note")).toHaveText(/^omo는 SUL-1\.0 라이선스예요\./)
  await expect(root.getByTestId("prompt-preview")).toHaveCount(0)

  // A new conversation on omo (원본), picked on its pill: its line comes from the lazy strings, it has no 지시문.
  await page.goto("/")
  await page.getByTestId("project-row").first().getByTestId("project-new-session").click()
  const pill = page.getByTestId("harness-pill")
  await pill.click()
  const menu = page.getByTestId("harness-menu")
  await expect(menu.getByTestId("harness-omo")).toContainText("omo (원본)")
  await expect(menu.getByTestId("harness-omo")).toContainText("oh-my-opencode(omo) 코드를 그대로 가져와 돌려요.")
  await menu.getByTestId("harness-omo").click()
  await expect(pill).toHaveAttribute("data-harness", "omo")
  await expect(pill).toContainText("omo (원본)")
  await expect(pill).not.toContainText("개선판")
  await pill.click()
  await expect(menu.getByTestId("harness-prompt-own")).toHaveCount(0)
  await expect(menu.getByTestId("harness-prompt-edit")).toHaveCount(0)
  await shot(page, "omo-1-menu")
  await page.keyboard.press("Escape")
  const composer = page.locator("#own-composer-input")
  await composer.fill("ulw omo 첫 질문이에요")
  await composer.press("Control+Enter")
  await expect(page).toHaveURL(/\/srv\/local\/s\//)
  const sent = async () => {
    const bodies = (await (await fetch(state.requests)).json()) as ReadonlyArray<Record<string, unknown>>
    return bodies.findLast((body) => JSON.stringify(body.input ?? []).includes("ulw omo 첫 질문이에요"))
  }
  // omo's Sisyphus runs the conversation, ulw's block follows the user's words, and omo's tools are listed by name.
  await expect
    .poll(async () => JSON.stringify((await sent()) ?? {}).includes('Your designated identity for this session is \\"Sisyphus\\"'), {
      timeout: 60_000,
    })
    .toBe(true)
  const body = JSON.stringify(await sent())
  expect(body.indexOf("<ultrawork-mode>")).toBeGreaterThan(body.indexOf("ulw omo 첫 질문이에요"))
  expect(body).toContain('"todowrite"')
  expect(body).not.toContain("omo_todowrite")
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 60_000 })

  // A service whose own.harness does not list omo (own-omo not running there) offers no omo row.
  await page.route("**/api/rpc/own.harness/list**", async (route: Route) => {
    const response = await route.fetch()
    const json = (await response.json()) as { output: { harnesses: string[] } }
    json.output.harnesses = json.output.harnesses.filter((id) => id !== "omo")
    await route.fulfill({ response, json })
  })
  await page.goto("/")
  await page.getByTestId("project-row").first().getByTestId("project-new-session").click()
  await page.getByTestId("harness-pill").click()
  await expect(page.getByTestId("harness-menu").getByTestId("harness-codex")).toBeVisible()
  await expect(page.getByTestId("harness-menu").getByTestId("harness-omo")).toHaveCount(0)
})

test("비교: 원본 beside 개선판 part by part, why under each change, `자세히` opens the manual there", async ({
  page,
}) => {
  const root = await openPage(page)
  // DeepSeek 방식's 개선판 changes something for every model.
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "DeepSeek 방식" }).click()
  const toggle = root.getByTestId("prompt-compare-toggle")
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  // The keyboard reaches it: Enter on the focused toggle.
  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  const compare = root.getByTestId("prompt-compare")
  await expect(compare).toHaveAttribute("data-pair", "reference")
  await expect(root.getByTestId("prompt-sent")).toHaveCount(0)
  const row = (key: string) => root.locator(`[data-testid="prompt-compare-row"][data-key="${key}"]`)

  // Parts that are the same fold to 같음, those in a row into one entry; both open from the keyboard.
  const group = root.getByTestId("prompt-compare-same-group").first()
  await expect(group).toContainText("같음")
  await expect(group).toContainText("dsh 소개")
  await expect(group).not.toHaveAttribute("open", "")
  await group.locator("summary").first().focus()
  await page.keyboard.press("Enter")
  await expect(group).toHaveAttribute("open", "")
  const same = row("harness#0")
  await expect(same).toHaveAttribute("data-same", "true")
  await expect(same).not.toHaveAttribute("open", "")
  await same.locator("summary").focus()
  await page.keyboard.press("Enter")
  await expect(same).toHaveAttribute("open", "")
  await expect(same.locator("pre")).toBeVisible()
  // Rows are rebuilt for another approval mode; the ones the user opened stay open.
  await root.getByTestId("prompt-mode").getByRole("radio", { name: "전체 허용" }).click()
  await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
  await expect(group).toHaveAttribute("open", "")
  await expect(same).toHaveAttribute("open", "")
  await root.getByTestId("prompt-mode").getByRole("radio", { name: "묻기" }).click()
  await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")

  // A changed part: 원본 on the left, 개선판 on the right, marked, with the reason under the run.
  const environment = row("environment#0")
  await expect(environment).toHaveAttribute("open", "")
  const hunk = environment.getByTestId("prompt-compare-hunk").first()
  await expect(hunk.locator('[data-side="left"] del').first()).toBeVisible()
  await expect(hunk.locator('[data-side="right"]')).toContainText("Approval mode: ask.")
  const policy = hunk.locator('[data-testid="prompt-compare-note"][data-id="dsh.policy"]')
  await expect(policy).toContainText("승인 모드 설명")
  const left = await hunk.locator('[data-side="left"]').boundingBox()
  const right = await hunk.locator('[data-side="right"]').boundingBox()
  expect(right!.x).toBeGreaterThan(left!.x + left!.width - 2)
  await expect(environment.getByTestId("prompt-compare-copy-left")).toHaveText("원본 복사")
  await expect(environment.getByTestId("prompt-compare-copy-right")).toHaveText("개선판 복사")
  await expect(row("time#0").locator('[data-testid="prompt-compare-note"][data-id="dsh.zone"]')).toBeVisible()
  // The shell tool's description lost its sandbox sentence; the Code Mode list differs per conversation.
  await expect(root.getByTestId("prompt-compare-tools").locator('[data-id="dsh.sandbox"]')).toBeVisible()
  await expect(root.getByTestId("prompt-compare-elsewhere").locator('[data-id="dsh.catalog"]')).toBeVisible()
  await environment.scrollIntoViewIfNeeded()
  await shot(page, "6-compare")

  // 자세히: the manual opens at that change's entry.
  const more = policy.getByTestId("prompt-change-more")
  await expect(more).toHaveAttribute("data-anchor", "pc-dsh-policy")
  await more.click()
  await expect(page.getByTestId("manual-viewer")).toBeVisible()
  await expect(page.getByTestId("manual-frame")).toHaveAttribute("src", /#pc-dsh-policy$/)
  const entry = page.frameLocator('[data-testid="manual-frame"]').locator("#pc-dsh-policy")
  await expect(entry).toContainText("승인 모드 설명")
  await expect(entry).toBeInViewport()
  await shot(page, "7-manual-entry")
  await page.getByTestId("manual-close").click()
  await expect(page.getByTestId("manual-viewer")).toHaveCount(0)
  // An anchor this build's manual lacks (a change a newer service adds) opens 10.13 rather than the manual's top.
  await page.evaluate(async () => {
    const url = "/src/manual/index.tsx"
    const manual = (await import(url)) as { openManual: (place: string, anchor?: string) => void }
    manual.openManual("prompts", "pc-not-in-this-build")
  })
  await expect(page.getByTestId("manual-frame")).toHaveAttribute("src", /#pc-not-in-this-build$/)
  const chapter = page.frameLocator('[data-testid="manual-frame"]')
  await expect.poll(() => chapter.locator("body").evaluate(() => location.hash)).toBe("#ch10-13")
  await expect(chapter.locator("#ch10-13")).toBeInViewport()
  await page.getByTestId("manual-close").click()

  // Codex 방식 for a model outside Codex's catalog, where 개선판 rewrites lines of the base text.
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "Codex 방식" }).click()
  const outside = await root
    .getByTestId("prompt-model")
    .locator("option")
    .evaluateAll(
      (options, provider) =>
        options.map((option) => (option as HTMLOptionElement).value).find((value) => !value.startsWith(`${provider}/`)),
      state.account.providerID,
    )
  if (outside !== undefined) {
    await root.getByTestId("prompt-model").selectOption(outside)
    await expect(row("base#0").locator('[data-testid="prompt-compare-note"][data-id="codex.base.where"]')).toBeVisible()
    await expect(row("base#0").getByTestId("prompt-compare-fold").first()).toBeVisible()
    // spawn_agent: the model list it loses (codex.spawn.models) beside the one sentence its `model` line gains
    // (codex.spawn.model-arg); that sentence is the right side's only mark there.
    const spawn = root.locator('[data-testid="prompt-compare-row"][data-key$="spawn_agent"]')
    const first = spawn.getByTestId("prompt-compare-hunk").first()
    await expect(first.locator('[data-side="right"] ins')).toHaveCount(1)
    await expect(first.locator('[data-side="right"] ins')).toContainText(
      "It is only ever a model id of your own provider",
    )
    await expect(first.locator('[data-side="right"]')).toContainText("Spawn a sub-agent for a well-scoped task.")
    await expect(first.locator('[data-side="left"] del').first()).toContainText("Available model overrides")
    await expect(first.locator('[data-testid="prompt-compare-note"][data-id="codex.spawn.model-arg"]')).toBeVisible()
    await shot(page, "8-compare-codex")
    await root.getByTestId("prompt-model").selectOption(`${state.account.providerID}/${state.model}`)
  }
  // A GPT model of Codex's catalog: the two texts are the same.
  await expect(root.getByTestId("prompt-compare-summary")).toHaveText("두 글이 같아요.")

  // 내 지시문 beside 개선판; none saved here, so they match.
  await root.getByTestId("prompt-variant").getByRole("radio", { name: "내 지시문" }).click()
  await expect(compare).toHaveAttribute("data-pair", "custom")
  await expect(root.getByTestId("prompt-compare-nocustom")).toBeVisible()

  // A narrow window stacks the sides and never scrolls sideways.
  await root.getByTestId("prompt-variant").getByRole("radio", { name: "개선판" }).click()
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "DeepSeek 방식" }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  const narrow = row("environment#0").getByTestId("prompt-compare-hunk").first()
  await expect(narrow).toBeVisible()
  const top = await narrow.locator('[data-side="left"]').boundingBox()
  const bottom = await narrow.locator('[data-side="right"]').boundingBox()
  expect(bottom!.y).toBeGreaterThanOrEqual(top!.y + top!.height - 2)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await narrow.scrollIntoViewIfNeeded()
  await shot(page, "9-compare-narrow")
  // Off again: one variant as before.
  await root.getByTestId("prompt-compare-toggle").click()
  await expect(root.getByTestId("prompt-sent")).toBeVisible()
})

test("비교 draws whitespace: Pi 방식 내 지시문 = 개선판 + a line break shows ⏎ and says only line ends differ", async ({
  page,
}) => {
  const root = await openPage(page)
  await piWithLineBreak(page, root)
  await root.getByTestId("prompt-compare-toggle").click()
  await expect(root.getByTestId("prompt-compare")).toHaveAttribute("data-pair", "custom")
  await expect(root.getByTestId("prompt-compare-summary")).toContainText("다른 부분 1개")
  const preamble = root.locator('[data-testid="prompt-compare-row"][data-key="preamble#0"]')
  await expect(preamble).toHaveAttribute("open", "")
  const hunk = preamble.getByTestId("prompt-compare-hunk")
  await expect(hunk).toHaveCount(1)
  // Both sides have the part: no `missing` label, the text on both, the line break marked on the right only.
  await expect(hunk.locator(".own-pcmp-empty")).toHaveCount(0)
  await expect(hunk.locator('[data-side="left"]')).toContainText("You are a coding assistant running inside pi")
  await expect(hunk.locator('[data-side="left"] del')).toHaveCount(0)
  const mark = hunk.locator('[data-side="right"] ins[data-space]')
  await expect(mark).toHaveText("⏎")
  await expect(mark).toBeVisible()
  const box = await mark.boundingBox()
  expect(box!.width).toBeGreaterThan(4)
  // Screen readers hear what it is, not the glyph.
  expect(await mark.evaluate((element) => getComputedStyle(element, "::before").content)).toContain("추가 시작")
  expect(
    await mark.locator(".own-pcmp-ws").evaluate((element) => getComputedStyle(element, "::before").content),
  ).toContain("줄바꿈 1개")
  expect(await mark.evaluate((element) => getComputedStyle(element, "::after").content)).toContain("추가 끝")
  await expect(mark.locator(".own-pcmp-glyph")).toHaveAttribute("aria-hidden", "true")
  await expect(hunk.getByTestId("prompt-compare-whitespace")).toHaveText("줄 끝·빈 줄만 달라요")
  await hunk.scrollIntoViewIfNeeded()
  await shot(page, "10-compare-whitespace")
})

test("keyboard only: 같은 줄 보기 opens and closes in place, and the focus stays on it", async ({ page }) => {
  const root = await openPage(page)
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "Codex 방식" }).click()
  await root.getByTestId("prompt-variant").getByRole("radio", { name: "개선판" }).click()
  const outside = await root
    .getByTestId("prompt-model")
    .locator("option")
    .evaluateAll(
      (options, provider) =>
        options.map((option) => (option as HTMLOptionElement).value).find((value) => !value.startsWith(`${provider}/`)),
      state.account.providerID,
    )
  expect(outside, "a model outside Codex's catalog, whose 개선판 rewrites lines").toBeDefined()
  await root.getByTestId("prompt-model").selectOption(outside!)
  const toggle = root.getByTestId("prompt-compare-toggle")
  await toggle.focus()
  await page.keyboard.press("Enter")
  const base = root.locator('[data-testid="prompt-compare-row"][data-key="base#0"]')
  const fold = base.getByTestId("prompt-compare-fold").first()
  await expect(fold).toHaveAttribute("aria-expanded", "false")
  // Tab from the part's copy button to the first fold.
  await base.getByTestId("prompt-compare-copy-right").focus()
  for (let step = 0; step < 8 && !(await fold.evaluate((element) => element === document.activeElement)); step++)
    await page.keyboard.press("Tab")
  await expect(fold).toBeFocused()
  const hidden = page.locator(`[id="${await fold.getAttribute("aria-controls")}"]`)
  await expect(hidden).toBeHidden()
  const label = (await fold.textContent()) ?? ""
  expect(label).toMatch(/^같은 줄 \d+개 보기$/)
  const button = await fold.elementHandle()
  await page.keyboard.press("Enter")
  await expect(fold).toHaveAttribute("aria-expanded", "true")
  await expect(fold).toHaveText("같은 줄 접기")
  await expect(hidden).toBeVisible()
  // The very same button keeps the focus (a swapped element would leave it on <body>).
  expect(await page.evaluate((element) => element === document.activeElement, button)).toBe(true)
  await shot(page, "11-fold-open")
  await page.keyboard.press("Space")
  await expect(fold).toHaveAttribute("aria-expanded", "false")
  await expect(fold).toHaveText(label)
  await expect(hidden).toBeHidden()
  expect(await page.evaluate((element) => element === document.activeElement, button)).toBe(true)
})

test("a fold opened in 비교 stays open, and keeps the focus, when another 승인 모드 rebuilds the stretches", async ({
  page,
}) => {
  const root = await openPage(page)
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "Codex 방식" }).click()
  await root.getByTestId("prompt-variant").getByRole("radio", { name: "개선판" }).click()
  const outside = await root
    .getByTestId("prompt-model")
    .locator("option")
    .evaluateAll(
      (options, provider) =>
        options.map((option) => (option as HTMLOptionElement).value).find((value) => !value.startsWith(`${provider}/`)),
      state.account.providerID,
    )
  expect(outside, "a model outside Codex's catalog, whose 개선판 rewrites lines").toBeDefined()
  await root.getByTestId("prompt-model").selectOption(outside!)
  await root.getByTestId("prompt-compare-toggle").click()
  const fold = root
    .locator('[data-testid="prompt-compare-row"][data-key="base#0"]')
    .getByTestId("prompt-compare-fold")
    .first()
  await fold.focus()
  await page.keyboard.press("Enter")
  await expect(fold).toHaveAttribute("aria-expanded", "true")
  // Named by its part and the lines it hides.
  const name = (await fold.getAttribute("data-fold"))!
  expect(name).toMatch(/^fold:base#0:\d+-\d+$/)
  const button = await fold.elementHandle()
  const mode = (label: string) => root.getByTestId("prompt-mode").getByRole("radio", { name: label })
  const permissions = root.locator('[data-testid="prompt-compare-row"][data-key="permissions#0"]')
  const before = await permissions.textContent()
  // Another mode chosen from a script, so that the focus stays where it is: the stretches are rebuilt (the
  // permissions text is another), and the very same button is still open and still has the focus.
  await mode("전체 허용").evaluate((element) => (element as HTMLElement).click())
  await expect(mode("전체 허용")).toHaveAttribute("aria-checked", "true")
  await expect.poll(() => permissions.textContent()).not.toBe(before)
  await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
  const same = root.locator(`[data-fold="${name}"]`)
  await expect(same).toHaveAttribute("aria-expanded", "true")
  expect(
    await page.evaluate((element) => element?.isConnected === true && element === document.activeElement, button),
  ).toBe(true)
  // Chosen by a click as a user would: the fold the focus comes back to is still open, its lines shown.
  await mode("묻기").click()
  await expect.poll(() => permissions.textContent()).toBe(before)
  await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
  await expect(same).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(`[id="${await same.getAttribute("aria-controls")}"]`)).toBeVisible()
  expect(await page.evaluate((element) => element?.isConnected === true, button)).toBe(true)
})

test("비교 draws a blank line added beside an edited line as ⏎ on its own line, boxed alone, copied as it is", async ({
  page,
}) => {
  const root = await openPage(page)
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "Codex 방식" }).click()
  await root.getByTestId("prompt-model").selectOption(`${state.account.providerID}/${state.model}`)
  await root.getByTestId("prompt-variant").getByRole("radio", { name: "내 지시문" }).click()
  const editor = root.getByTestId("prompt-custom-text")
  const start = root.getByTestId("prompt-custom-from-own")
  await expect(editor.or(start)).toBeVisible()
  // 개선판 글로 바꾸기 copies the preview on screen: wait for the chosen model's (a test before this one left another).
  await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
  await ((await editor.isVisible()) ? root.getByRole("button", { name: "개선판 글로 바꾸기" }) : start).click()
  // 개선판's text with one word of a line in capitals and a blank line added after that line (a\nb\nc → a\nB\n\nc).
  const lines = (await editor.inputValue()).split("\n")
  const at = lines.findIndex(
    (line, index) => index > 4 && /\b[a-z]{5,}\b/.test(line) && (lines[index + 1] ?? "") !== "",
  )
  const word = /\b[a-z]{5,}\b/.exec(lines[at]!)![0]
  const edited = lines[at]!.replace(word, word.toUpperCase())
  await editor.fill([...lines.slice(0, at), edited, "", ...lines.slice(at + 1)].join("\n"))
  await root.getByTestId("prompt-custom-save").click()
  await expect(page.getByText("내 지시문을 저장했어요")).toBeVisible()
  await root.getByTestId("prompt-compare-toggle").click()
  await expect(root.getByTestId("prompt-compare")).toHaveAttribute("data-pair", "custom")
  const hunk = root.locator('[data-testid="prompt-compare-row"][data-key="base#0"]').getByTestId("prompt-compare-hunk")
  await expect(hunk).toHaveCount(1)
  const right = hunk.locator('[data-side="right"]')
  const changed = right.locator("ins:not([data-space])")
  await expect(changed).toHaveText(word.toUpperCase())
  await expect(hunk.locator('[data-side="left"] del')).toHaveText(word)
  // The added blank line is a mark of its own, ⏎, on the line below the edited word; the left side has no glyph.
  const blank = right.locator("ins[data-space]")
  await expect(blank).toHaveText("⏎")
  await expect(hunk.locator('[data-side="left"] .own-pcmp-glyph')).toHaveCount(0)
  const wordBox = (await changed.boundingBox())!
  const glyphBox = (await blank.locator(".own-pcmp-glyph").boundingBox())!
  expect(glyphBox.y).toBeGreaterThanOrEqual(wordBox.y + wordBox.height - 1)
  // The mark keeps to the glyph's line: its line break is drawn after it, outside the box.
  expect((await blank.boundingBox())!.height).toBeLessThanOrEqual(glyphBox.height + 2)
  await hunk.scrollIntoViewIfNeeded()
  await hunk.screenshot({ path: path.join(SHOTS, "13-compare-blank-line-hunk.png") })
  // Copying the side gives the real text, without the glyph.
  const copied = await right.locator("pre").evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  })
  expect(copied.startsWith(`${edited}\n`)).toBe(true)
  expect(copied).not.toContain("⏎")
  await hunk.scrollIntoViewIfNeeded()
  await shot(page, "13-compare-blank-line")
  // No 내 지시문 again for the tests after this one.
  await root.getByTestId("prompt-compare-toggle").click()
  await root.getByTestId("prompt-custom-reset").click()
  await page.getByTestId("prompt-custom-reset-dialog").getByTestId("prompt-custom-reset-confirm").click()
  await expect(root.getByTestId("prompt-custom-missing")).toBeVisible()
})

test("비교 draws what renders as nothing: each its own glyph, named with its code point, a soft hyphen marked alone", async ({
  page,
}) => {
  const root = await openPage(page)
  // Pi 방식 내 지시문 = 개선판 with, in its first line, a soft hyphen, a zero-width space and a tag character put in
  // three words, and a right-to-left mark and a NEL after a fourth.
  const inserts = ["\u{AD}", "\u{200B}", "\u{E0041}", "\u{200F}\u{85}"]
  const words: string[] = []
  await piCustom(page, root, (text) => {
    const [first, ...rest] = text.split("\n")
    const found = [...first!.matchAll(/\b[a-z]{6,}\b/g)].slice(0, inserts.length)
    expect(found.length, "four long words in Pi's first line").toBe(inserts.length)
    for (const match of found) words.push(match[0])
    // From the line's end, so that the places found stay where they are.
    const line = found.reduceRight((out, match, at) => {
      const place = match.index + (at === inserts.length - 1 ? match[0].length : 3)
      return `${out.slice(0, place)}${inserts[at]}${out.slice(place)}`
    }, first!)
    return [line, ...rest].join("\n")
  })
  await root.getByTestId("prompt-compare-toggle").click()
  await expect(root.getByTestId("prompt-compare")).toHaveAttribute("data-pair", "custom")
  const hunk = root
    .locator('[data-testid="prompt-compare-row"][data-key="preamble#0"]')
    .getByTestId("prompt-compare-hunk")
  await expect(hunk).toHaveCount(1)
  await expect(hunk.getByTestId("prompt-compare-whitespace")).toHaveText("보이지 않는 문자만 달라요")
  // Nothing on the left is marked, and on the right only the characters themselves, not the words around them.
  await expect(hunk.locator('[data-side="left"] del')).toHaveCount(0)
  const right = hunk.locator('[data-side="right"]')
  await expect(right.locator("ins:not([data-space])")).toHaveCount(0)
  for (const word of words) await expect(hunk.locator('[data-side="left"]')).toContainText(word)
  const glyphs = right.locator("ins[data-space] .own-pcmp-glyph")
  await expect(glyphs).toHaveText(["¬", "⁞", "⌑", "⇄", "␤"])
  // Each run of a glyph is named with its code point, for screen readers (`::before`) and as its tooltip.
  const names = [
    "소프트 하이픈 1개 (U+00AD)",
    "폭 없는 문자 1개 (U+200B)",
    "태그 문자 1개 (U+E0041)",
    "방향 제어 문자 1개 (U+200F)",
    "다음 줄 문자 1개 (U+0085)",
  ]
  for (const [at, name] of names.entries()) {
    const glyph = glyphs.nth(at)
    await expect(glyph).toHaveAttribute("title", name)
    await expect(glyph).toHaveAttribute("aria-hidden", "true")
    expect(await glyph.locator("..").evaluate((element) => getComputedStyle(element, "::before").content)).toContain(
      name,
    )
    expect((await glyph.boundingBox())!.width).toBeGreaterThan(4)
  }
  await hunk.scrollIntoViewIfNeeded()
  await hunk.screenshot({ path: path.join(SHOTS, "14-compare-invisible-hunk.png") })
})

test("copying a selection in 비교 with Ctrl+C keeps its no-break space, and no glyph", async ({ page }) => {
  // This test's own context only: the clipboard, to read back what Ctrl+C wrote.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  const root = await openPage(page)
  // Pi 방식 내 지시문 = 개선판 with one space of its first line a no-break space.
  const pair = { before: "", after: "" }
  await piCustom(page, root, (text) => {
    const [first, ...rest] = text.split("\n")
    const match = /\b([a-z]{4,}) ([a-z]{4,})\b/.exec(first!)!
    pair.before = match[0]
    pair.after = `${match[1]}\u{A0}${match[2]}`
    return [first!.replace(pair.before, pair.after), ...rest].join("\n")
  })
  await root.getByTestId("prompt-compare-toggle").click()
  const hunk = root
    .locator('[data-testid="prompt-compare-row"][data-key="preamble#0"]')
    .getByTestId("prompt-compare-hunk")
  await expect(hunk.locator('[data-side="right"] ins[data-space] .own-pcmp-glyph')).toHaveText("⍽")
  // Chromium's own copy would write a space for the no-break space.
  const copy = async (side: "left" | "right") => {
    await hunk.locator(`[data-side="${side}"] pre`).evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    })
    await page.keyboard.press("Control+c")
    return page.evaluate(() => navigator.clipboard.readText())
  }
  const right = await copy("right")
  expect(right).toContain(pair.after)
  expect(right).not.toMatch(/[⍽·⏎]/)
  const left = await copy("left")
  expect(left).toContain(pair.before)
  expect(left).not.toContain("\u{A0}")
})

// The text and lines of 비교 against the surface they are drawn on, in the light and the dark theme: text 4.5:1 (it is
// all small), the lines that tell a mark without colour 3:1 (WCAG 1.4.11).
for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: 비교's marks, labels and notes keep their contrast`, async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: state.dev,
      viewport: { width: 1280, height: 900 },
      locale: "ko-KR",
      colorScheme: scheme,
    })
    await context.addInitScript((value) => localStorage.setItem("opencode-color-scheme", value), scheme)
    const page = await context.newPage()
    const root = await openPage(page)
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme)
    // Pi 방식 내 지시문 = 개선판 + ⏎: a whitespace mark and its note.
    await piWithLineBreak(page, root)
    await root.getByTestId("prompt-compare-toggle").click()
    await expect(root.getByTestId("prompt-compare-whitespace")).toBeVisible()
    const found = await contrast(page)
    // Codex 방식 outside the catalog: word marks, a part on one side only, folds, reasons, the same parts' names.
    await root.getByTestId("prompt-harness").getByRole("radio", { name: "Codex 방식" }).click()
    await root.getByTestId("prompt-variant").getByRole("radio", { name: "개선판" }).click()
    const outside = await root
      .getByTestId("prompt-model")
      .locator("option")
      .evaluateAll(
        (options, provider) =>
          options
            .map((option) => (option as HTMLOptionElement).value)
            .find((value) => !value.startsWith(`${provider}/`)),
        state.account.providerID,
      )
    await root.getByTestId("prompt-model").selectOption(outside!)
    await expect(
      root.locator('[data-testid="prompt-compare-row"][data-key="identity#0"] .own-pcmp-empty'),
    ).toBeVisible()
    await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
    const codex = await contrast(page)
    await root.getByTestId("prompt-harness").getByRole("radio", { name: "DeepSeek 방식" }).click()
    await expect(root.locator('[data-testid="prompt-compare-note"][data-id="dsh.policy"]')).toBeVisible()
    await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
    const dsh = await contrast(page)
    await page.screenshot({ path: path.join(SHOTS, `12-contrast-${scheme}.png`), fullPage: true })
    await context.close()
    const all = [...found, ...dsh, ...codex]
    fs.writeFileSync(path.join(SHOTS, `12-contrast-${scheme}.json`), JSON.stringify(all, null, 1))
    // Every kind was measured somewhere.
    expect([...new Set(all.map((item) => item.what))].sort()).toEqual(
      [
        "chip",
        "del",
        "del line",
        "empty",
        "fold",
        "ins",
        "ins line",
        "label left",
        "label right",
        "more",
        "note",
        "note title",
        "same text",
        "space",
        "whitespace note",
      ].sort(),
    )
    expect(all.filter((item) => item.ratio < item.min).map((item) => `${item.what}: ${item.ratio.toFixed(2)}`)).toEqual(
      [],
    )
  })
}

// The layout audit (e2e/ui-audit/audit.ts) of 비교 at the widths the app supports. The ui-audit's demo world runs
// without own.harness, so its own sweep of 설정 > 에이전트 방식 sees no preview; this world has the plugin.
for (const width of [1440, 1280, 1152, 1024, 820, 375] as const) {
  test(`${width} px: 비교 has no wrapped, cut or covered labels`, async ({ browser }, info) => {
    const phone = width < 600
    const page = await auditPage(browser, width, !phone)
    const audit = new Audit(info, width, ALLOWED, phone ? undefined : WINDOW_BUTTONS, new Set())
    const root = await openPage(page)
    await root.getByTestId("prompt-compare-toggle").click()
    const outside = await root
      .getByTestId("prompt-model")
      .locator("option")
      .evaluateAll(
        (options, provider) =>
          options
            .map((option) => (option as HTMLOptionElement).value)
            .find((value) => !value.startsWith(`${provider}/`)),
        state.account.providerID,
      )
    if (outside !== undefined) await root.getByTestId("prompt-model").selectOption(outside)
    for (const [harness, prompt] of [
      ["Codex 방식", "개선판"],
      ["DeepSeek 방식", "개선판"],
      ["Pi 방식", "내 지시문"],
    ] as const) {
      await root.getByTestId("prompt-harness").getByRole("radio", { name: harness }).click()
      await root.getByTestId("prompt-variant").getByRole("radio", { name: prompt }).click()
      await expect(root.getByTestId("prompt-compare")).toBeVisible()
      await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
      const group = root.getByTestId("prompt-compare-same-group").first()
      if (await group.isVisible().catch(() => false)) await group.locator("summary").first().click()
      const folded = root.getByTestId("prompt-compare-fold").first()
      if (await folded.isVisible().catch(() => false)) await folded.click()
      await page.waitForTimeout(400)
      await audit.check(page, `settings/harness · 비교 ${harness} ${prompt}`)
      await audit.shoot(page, `compare-${harness}-${prompt}`, [page.locator("body")])
    }
    const lines = await audit.write("compare-audit")
    await page.context().close()
    expect(audit.violations().map(line), lines.join("\n")).toEqual([])
  })
}

/**
 * Pi 방식's 내 지시문 saved as 개선판's text plus one line break: a difference of whitespace alone, which 비교 must
 * still show. It stays saved for the tests after this one (the audit's `Pi 방식 · 내 지시문` draws it too).
 */
async function piWithLineBreak(page: Page, root: Locator) {
  await piCustom(page, root, (text) => `${text}\n`)
}

/** Pi 방식's 내 지시문 saved as 개선판's text, `change`d. It stays saved for the tests after this one. */
async function piCustom(page: Page, root: Locator, change: (text: string) => string) {
  await root.getByTestId("prompt-harness").getByRole("radio", { name: "Pi 방식" }).click()
  await root.getByTestId("prompt-variant").getByRole("radio", { name: "내 지시문" }).click()
  const editor = root.getByTestId("prompt-custom-text")
  const start = root.getByTestId("prompt-custom-from-own")
  await expect(editor.or(start)).toBeVisible()
  // A text saved before: back to 개선판's text first, the one the preview shows once it has loaded.
  await expect(root.getByTestId("prompt-preview")).not.toHaveAttribute("data-loading", "true")
  await ((await editor.isVisible()) ? root.getByRole("button", { name: "개선판 글로 바꾸기" }) : start).click()
  await editor.fill(change(await editor.inputValue()))
  const save = root.getByTestId("prompt-custom-save")
  if (await save.isDisabled()) return
  await save.click()
  await expect(page.getByText("내 지시문을 저장했어요")).toBeVisible()
}

/**
 * The contrast of 비교's text (and of the lines under or through its marks) on what is drawn beneath it: every
 * background from the page down to the element, mixed in order. Measures what the page shows now.
 */
function contrast(page: Page) {
  return page.evaluate(() => {
    type RGBA = readonly [number, number, number, number]
    const parse = (color: string): RGBA => {
      const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color)
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])]
      const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(color)
      if (srgb)
        return [
          Number(srgb[1]) * 255,
          Number(srgb[2]) * 255,
          Number(srgb[3]) * 255,
          srgb[4] === undefined ? 1 : Number(srgb[4]),
        ]
      throw new Error(`unknown color ${color}`)
    }
    const over = (top: RGBA, under: RGBA): RGBA => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1,
    ]
    const surface = (element: Element) => {
      const chain: Element[] = []
      for (let node: Element | null = element; node !== null; node = node.parentElement) chain.unshift(node)
      const start = chain.findLastIndex((node) => parse(getComputedStyle(node).backgroundColor)[3] === 1)
      if (start < 0) throw new Error("no opaque surface under the element")
      return chain
        .slice(start + 1)
        .reduce(
          (under, node) => over(parse(getComputedStyle(node).backgroundColor), under),
          parse(getComputedStyle(chain[start]!).backgroundColor),
        )
    }
    const luminance = (color: RGBA) => {
      const channel = (value: number) => {
        const c = value / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2])
    }
    const ratio = (a: RGBA, b: RGBA) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (light! + 0.05) / (dark! + 0.05)
    }
    const probes = [
      ["del", ".own-pcmp-text del:not([data-space])", "color", 4.5],
      ["del line", ".own-pcmp-text del:not([data-space])", "textDecorationColor", 3],
      ["ins", ".own-pcmp-text ins:not([data-space])", "color", 4.5],
      ["ins line", ".own-pcmp-text ins:not([data-space])", "textDecorationColor", 3],
      ["space", ".own-pcmp-text [data-space]", "color", 4.5],
      ["label left", '[data-side="left"] > .own-pcmp-label', "color", 4.5],
      ["label right", '[data-side="right"] > .own-pcmp-label', "color", 4.5],
      ["note", '[data-testid="prompt-compare-note"]', "color", 4.5],
      ["note title", '[data-testid="prompt-compare-note"] > b', "color", 4.5],
      ["more", ".own-pcmp-more", "color", 4.5],
      ["whitespace note", '[data-testid="prompt-compare-whitespace"]', "color", 4.5],
      ["empty", ".own-pcmp-empty", "color", 4.5],
      ["fold", ".own-pcmp-fold", "color", 4.5],
      ["same text", ".own-pcmp-same > .own-pcmp-text", "color", 4.5],
      ["chip", ".own-pcmp-chip", "color", 4.5],
    ] as const
    return probes.flatMap(([what, selector, property, min]) =>
      [...document.querySelectorAll(selector)].slice(0, 3).map((element) => {
        const under = surface(element)
        return { what, min, ratio: ratio(over(parse(getComputedStyle(element)[property]), under), under) }
      }),
    )
  })
}

/** A page in a fresh context as the ui-audit opens it: the desktop window with its title bar band, or a phone. */
async function auditPage(browser: Browser, width: number, band: boolean) {
  const phone = width < 600
  const context = await browser.newContext({
    baseURL: state.dev,
    viewport: { width, height: phone ? 812 : 900 },
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    colorScheme: "dark",
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  if (band) await emulateWindowControls(page)
  return page
}

test("하위 에이전트: what goes to a subagent and what comes back, on every tab, read from the service", async ({
  page,
}) => {
  const root = await openPage(page)
  const tab = (name: string) => root.getByTestId("prompt-harness").getByRole("radio", { name })
  const part = root.getByTestId("prompt-subagent")
  // Codex 방식 on GPT-5.5 (Codex's catalog, its v1 agent tools): Codex's own spawn_agent text, the parent's text alone.
  await root.getByTestId("prompt-model").selectOption(`${state.account.providerID}/${state.model}`)
  await expect(part).toHaveAttribute("data-kind", "codex-v1")
  await expect(part.getByTestId("prompt-subagent-tool")).toContainText("multi_agent_v1__spawn_agent")
  await expect(part).toContainText("Codex의 원래 글이에요.")
  await expect(part.getByTestId("prompt-subagent-first")).toHaveText("(메인 모델이 message에 쓴 글 그대로)")
  await expect(part.getByTestId("prompt-subagent-returns")).toContainText("<subagent_notification>")

  // Pi 방식: core's subagent as this service registers it, with core's list for a new conversation's agent.
  await tab("Pi 방식").click()
  await expect(part).toHaveAttribute("data-kind", "core")
  const tool = part.getByTestId("prompt-subagent-tool")
  await tool.locator("summary").click()
  await expect(tool).toContainText("Spawns an agent in a child session to work on the specified task.")
  await expect(tool).toContainText("Available subagents:")
  await expect(tool).toContainText("- explore:")
  await expect(part).toContainText("새 대화의 기본 에이전트(build)가 맡길 수 있는 역할이에요.")
  await expect(part.getByTestId("prompt-subagent-first")).toContainText("You are a subagent spawned by another session.")
  await expect(part.getByTestId("prompt-subagent-first")).toContainText("(메인 모델이 prompt에 쓴 글 그대로)")
  await expect(part.getByTestId("prompt-subagent-returns")).toContainText(
    "2,000줄이나 50 KiB를 넘으면 앞부분만 남기고 잘라요.",
  )
  await expect(part.getByTestId("prompt-subagent-returns")).toContainText("이 알림은 자르지 않아요.")

  // OpenCode 기본 has no preview: the same part, from prompt.subagent.
  await tab("OpenCode 기본").click()
  await expect(root.getByTestId("prompt-preview")).toHaveCount(0)
  await expect(part).toHaveAttribute("data-kind", "core")
  await expect(part).toContainText("모델별 기본 지시문 대신 그 역할의 지시문을 받아요.")
  await expect(part.getByTestId("prompt-subagent-tool")).toContainText("subagent")

  // omo (원본), where own-omo runs: one line, nothing of this app's.
  if ((await tab("omo (원본)").count()) > 0) {
    await tab("omo (원본)").click()
    await expect(part).toHaveAttribute("data-kind", "omo")
    await expect(part).toHaveText(/omo는 task 도구로 맡겨요\..*이 앱은 아무것도 더하지 않아요\./)
  }

  // A phone's width: the part wraps, nothing scrolls sideways.
  await page.setViewportSize({ width: 375, height: 812 })
  await tab("Pi 방식").click()
  await expect(part).toHaveAttribute("data-kind", "core")
  await part.scrollIntoViewIfNeeded()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test("narrow window: the page fits without sideways scrolling", async ({ page }) => {
  // GPT-5.5 is in Codex's catalog: 개선판 changes nothing for it, and other models' changes are folded.
  await page.goto("/settings/harness")
  await expect(page.getByTestId("prompt-preview")).toBeVisible()
  await expect(page.getByTestId("prompt-changes")).toContainText("이 모델에는 고친 곳이 없어요")
  await page.getByTestId("prompt-changes-others").locator("summary").click()
  await expect(page.getByTestId("prompt-changes").getByTestId("prompt-change").first()).toBeVisible()
  await shot(page, "0-changes-wide")
  await page.getByTestId("prompt-tools").scrollIntoViewIfNeeded()
  await shot(page, "0-tools-section")
  await page.getByTestId("prompt-changes").scrollIntoViewIfNeeded()
  await shot(page, "0-changes-section")
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/settings/harness")
  await expect(page.getByTestId("prompt-preview")).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await shot(page, "5-narrow")
  await page.getByTestId("prompt-harness").getByRole("radio", { name: "OpenCode 기본" }).click()
  await expect(page.getByTestId("settings-harness")).toContainText(
    "OpenCode 기본은 OpenCode가 만든 지시문을 그대로 보내요.",
  )
})

test("a service that cannot show the page says so plainly; another failure offers 다시 시도, which loads it", async ({
  page,
}) => {
  // A service without own.harness answers `rpc.unavailable` (core's RPC registry); any other error is a failure.
  const list = (url: URL) => url.pathname.endsWith("/api/rpc/own.harness/list")
  const answer = (type: string) => (route: Route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ _tag: "RpcError", type, message: `RPC is unavailable: own.harness (${type})` }),
    })
  await page.route(list, answer("rpc.unavailable"))
  await page.goto("/settings/harness")
  const root = page.getByTestId("settings-harness")
  const problem = root.getByTestId("prompt-problem")
  await expect(problem).toHaveText("이 서비스에서는 지시문을 볼 수 없어요.")
  await expect(problem.getByRole("button")).toHaveCount(0)
  await expect(root).not.toContainText("RPC is unavailable")

  await page.unroute(list)
  await page.route(list, answer("e2e.broken"))
  await page.reload()
  await expect(problem).toContainText("지시문을 불러오지 못했어요")
  await expect(root).not.toContainText("RPC is unavailable")
  await page.unroute(list)
  await problem.getByRole("button", { name: "다시 시도" }).click()
  await expect(root.getByTestId("prompt-preview")).toBeVisible()
  await expect(problem).toHaveCount(0)
})

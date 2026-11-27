// Preset screens (07 §7; PG1 and PG11 on screen) in the whole own-web app in Edge against backend.ts: the real server
// with own-accounts, fake model providers driven by own-team's directive responder. One window walks:
//   - settings 프리셋: the ultra caps levels (아껴서 / 추천 / 크게 / 직접 정하기), stored and in force in a session;
//   - the two-question editor: the starters (an unusable one greyed with its reason), ① with a hint under each radio
//     and `다른 모델 하나로` whose picker leaves out `메인과 같게` (UC 2026-10-18), ②, a role's target picker with the
//     paid row closed until asked, a budget typed in place before a paid model can be picked, saved;
//   - the composer's preset button (the group's presets, `비용 없음 · 바로 적용`, no cost dialog);
//   - the ultra switch: the cost dialog on a model without per-message effort updates, none on GPT-6 Sol;
//   - the neutral chips of refused subagent calls: a cap with `이번 메시지만 늘리기` while the turn runs, a model outside
//     the preset with `하위 에이전트에 추가…` (the editor prefilled, nothing saved before 저장), a paid move that asks
//     for consent, a used-up budget with this conversation's amount;
//   - the model pool (T4, 07 §8.1–§8.3): `모델 묶음에서 알아서` with its checklist in dark and light, `추천 묶음`, the paid
//     rows behind their budget, saved as `메인과 같은 모델로` with the pool; a model outside the pool as a chip whose
//     `묶음에 추가…` opens the editor with it checked (nothing saved); a gone pool model's repair line, `직접 고르기` on
//     that entry and `[<후속>로 고치기]`;
//   - PF5 (01 §16.3): a production build whose initial JS stays within budget without the team and preset screens.
// The main e2e/playwright.config.ts ignores this folder; without this suite's backend it skips.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type BrowserContext, type Page } from "@playwright/test"

interface PresetsState {
  readonly dev: string
  readonly control: string
  readonly ownHome: string
  readonly workspace: string
  readonly sessions: {
    readonly button: string
    readonly sol: string
    readonly caps: string
    readonly model: string
    readonly consent: string
    readonly budget: string
    readonly pool: string
    readonly claude: string
  }
  readonly presets: { readonly once: string; readonly consent: string }
  readonly accounts: { readonly deepseek: string }
  readonly models: { readonly "01": { readonly providerID: string; readonly id: string } }
}

const TMP = process.env.OWN_WEB_PRESETS_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as PresetsState
const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
/** The screens that must stay lazy chunks (06 §9.8, 07 §8.2, 01 §16.3 PF5). */
const SCREENS =
  /src\/(team\/(summary|area-menu|confirm|view-model|model|strings)|presets\/(editor|details|target-picker|pool-list|roles|role-guide|pe-strings)|settings\/(team|presets))\.tsx?$/

test.describe.configure({ mode: "serial" })

test.describe("preset screens (07 §7)", () => {
  test.skip(!TMP, "needs e2e/presets/backend.ts: bun run test:e2e:presets")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test("settings 프리셋: ultra caps 아껴서 / 추천 / 크게 / 직접 정하기, stored for every group", async () => {
    await page.goto("/settings/presets")
    await ready(page)
    const row = page.getByTestId("presets-ultra")
    await expect(row).toContainText("울트라 상한: 추천")
    await expect(row).toContainText("동시 8 · 메시지당 24 · 대화당 제한 없음")

    const levels = [
      { label: "아껴서", numbers: "동시 3 · 메시지당 12 · 대화당 제한 없음", stored: "save" },
      { label: "크게", numbers: "동시 64 · 메시지당 128 · 대화당 제한 없음", stored: "large" },
      { label: "추천", numbers: "동시 8 · 메시지당 24 · 대화당 제한 없음", stored: "recommended" },
    ]
    for (const level of levels) {
      await row.getByTestId("presets-ultra-change").click()
      const radios = row.getByTestId("presets-ultra-level").getByRole("radio")
      await expect(radios).toHaveText(["아껴서", "추천", "크게", "직접 정하기"])
      await radios.filter({ hasText: level.label }).click()
      await expect(row).toContainText(level.numbers)
      await expect(row.getByTestId("presets-ultra-large")).toHaveCount(level.stored === "large" ? 1 : 0)
      await row.getByTestId("presets-ultra-save").click()
      await expect(row).toContainText(`울트라 상한: ${level.label}`)
      await expect.poll(async () => (await accounts(page, "presets.list", {})).ultraCaps).toBe(level.stored)
    }

    // 직접 정하기, by keyboard from the chosen level (추천): the arrows move the choice, the numbers are typed; the
    // conversation cap is 제한 없음 until it is turned on (SC 2026-11-03).
    await row.getByTestId("presets-ultra-change").click()
    const level = row.getByTestId("presets-ultra-level")
    await level.getByRole("radio", { checked: true }).focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    await expect(level.getByRole("radio", { name: "직접 정하기" })).toBeFocused()
    await expect(level.getByRole("radio", { name: "직접 정하기" })).toBeChecked()
    await row.getByLabel("동시 N개").fill("5")
    await row.getByLabel("메시지 하나당 최대 N개").fill("10")
    await expect(row.getByLabel("대화당 N개")).toHaveCount(0)
    await expect(row.getByTestId("presets-ultra-perSession-on")).not.toBeChecked()
    await expect(row).toContainText("대화당 제한 없음")
    await row.getByTestId("presets-ultra-perSession-on").check()
    await expect(row.getByLabel("대화당 N개")).toHaveValue("100")
    await row.getByLabel("대화당 N개").fill("50")
    await row.getByTestId("presets-ultra-save").click()
    await expect(row).toContainText("울트라 상한: 직접 정하기")
    await expect(row).toContainText("동시 5 · 메시지당 10 · 대화당 50")
    await expect
      .poll(async () => (await accounts(page, "presets.list", {})).ultraCaps)
      .toEqual({ concurrent: 5, perMessage: 10, perSession: 50 })

    // 하위 에이전트 역할 (PE 2026-11-08): the group's ★ preset, every role with what it may do and where it runs now.
    const guide = page.getByTestId("presets-roles")
    await guide.locator("summary").click()
    const roles = guide.getByTestId("preset-role")
    await expect(roles).toHaveCount(5)
    await expect(guide.getByTestId("presets-roles-guide")).toContainText("'평소대로' 기준")
    await expect(roles.locator('[data-access="full"]')).toHaveCount(3)
    await expect(guide.locator('[data-role="explore"]')).toContainText("읽고 찾기만")
    await expect(guide.locator('[data-role="explore"] [data-testid="preset-role-runs"]')).toHaveAttribute(
      "data-source",
      "main",
    )
    await expect(guide.locator('[data-role="explore"]')).toContainText(/지금: .+ @ .+ · /)
    await expect(guide.locator('[data-role="own-quick"] [data-testid="preset-role-unnamed"]')).toBeVisible()
  })

  test("the two-question editor: starters, ① and ②, the paid row only when asked and its budget first; saved", async () => {
    await expect(page.getByTestId("preset-tab-codex")).toHaveAttribute("aria-selected", "true")
    await page.getByTestId("presets-new").click()
    const editor = page.getByTestId("preset-editor")
    await expect(editor).toContainText("ChatGPT 프리셋 › 새 프리셋")
    await expect(editor.getByTestId("preset-editor-shared")).toHaveText("모든 ChatGPT 계정(3개)에서 써요")
    // No main model or main effort here (U1): the top bar picks them.
    await expect(editor.getByRole("combobox")).toHaveCount(0)
    await expect(editor.getByTestId("preset-starter-light-split")).toBeEnabled()
    await expect(editor.getByTestId("preset-starter-light-split")).toHaveText("가볍게 나눠 쓰기")
    await expect(editor.getByTestId("preset-starter-cross-review")).toBeDisabled()
    await expect(editor.getByTestId("preset-starter-cross-review")).toHaveText("Claude 구독 없음")
    await expect(editor.getByTestId("preset-starter-local-explore")).toBeDisabled()
    await expect(editor.getByTestId("preset-starter-local-explore")).toHaveText("로컬 LLM 없음")
    await expect(editor.getByRole("button", { name: "설정하기" })).toHaveCount(2)

    const workers = editor.getByTestId("preset-editor-workers")
    await expect(workers.locator("legend")).toHaveText("① 하위 에이전트를 어디서 돌릴까요?")
    // The service offers a model pool, so `모델 묶음에서 알아서` is the third of four choices (T4).
    await expect(workers.getByRole("radio")).toHaveCount(4)
    await expect(workers.getByRole("radio", { name: "메인과 같은 모델로" })).toBeChecked()
    // UC 2026-10-18: each choice says what it runs on, in a line under its radio (the radio's description).
    await expect(workers.getByRole("radio", { name: "메인과 같은 모델로" })).toHaveAccessibleDescription(
      "지금 대화의 계정·모델·추론 강도를 그대로 씀",
    )
    const delegation = editor.getByTestId("preset-editor-delegation")
    await expect(delegation.locator("legend")).toHaveText("② 얼마나 맡길까요?")
    await expect(delegation.getByRole("radio")).toHaveCount(4)
    await expect(delegation.getByRole("radio", { name: "모델 기본" })).toBeChecked()
    await expect(editor.getByTestId("preset-editor-caps")).toContainText(
      "동시 3개 · 메시지 하나당 최대 6개 · 대화당 제한 없음 (자세히에서 바꿈)",
    )
    // 자세히: the conversation cap shows 제한 없음 until the user turns it on; off again saves no number (SC).
    await editor.getByTestId("preset-editor-details").click()
    const caps = editor.getByTestId("preset-detail-caps")
    await expect(caps).toContainText("대화당 제한 없음")
    await expect(caps.getByTestId("preset-detail-caps-fields-perSession")).toHaveCount(0)
    await caps.getByTestId("preset-detail-caps-fields-perSession-on").check()
    await expect(caps.getByTestId("preset-detail-caps-fields-perSession")).toHaveValue("100")
    await expect(editor.getByTestId("preset-editor-caps")).toContainText("대화당 100개")
    await caps.getByTestId("preset-detail-caps-fields-perSession-on").uncheck()
    await expect(editor.getByTestId("preset-editor-caps")).toContainText("대화당 제한 없음")
    await editor.getByTestId("preset-editor-details").click()
    await expect(editor.getByTestId("preset-editor-resolution")).toContainText(
      "하위 에이전트는 모두 메인과 같은 모델로 돌아요",
    )

    // 다른 모델 하나로 never points at the main: it starts with no model, and its picker leaves 메인과 같게 out.
    await workers.getByRole("radio", { name: "다른 모델 하나로" }).check()
    const single = editor.getByTestId("preset-editor-single")
    await expect(single).toContainText("고른 모델 없음")
    await single.getByRole("button", { name: /대상 고르기/ }).click()
    const singlePicker = page.getByTestId("preset-target-picker")
    await expect(singlePicker).toContainText("모든 하위 에이전트를 돌릴 모델")
    await expect(singlePicker.getByTestId("preset-target-main")).toHaveCount(0)
    await expect(singlePicker.getByTestId("preset-target-single-note")).toHaveText(
      "지금 대화와 같은 모델로 돌리려면 ①에서 '메인과 같은 모델로'를 고르세요.",
    )
    await singlePicker.getByTestId("preset-target-lighter").click()
    await expect(single).toContainText("메인 계정의 더 가벼운 모델")
    await expect(editor.getByTestId("preset-editor-resolution")).toContainText("모든 하위 에이전트 = ")
    await workers.getByRole("radio", { name: "메인과 같은 모델로" }).check()

    // A starter fills the rows (by role, 도움될 때); its suggestions never name the paid accounts (PG11).
    await editor.getByTestId("preset-starter-light-split").click()
    await expect(workers.getByRole("radio", { name: /일마다 정하기/ })).toBeChecked()
    await expect(delegation.getByRole("radio", { name: "도움될 때" })).toBeChecked()
    const role = (name: string) => editor.locator(`[data-testid="preset-editor-role"][data-role="${name}"]`)
    await expect(role("explore")).toContainText("메인 계정의 더 가벼운 모델")
    await expect(role("explore").getByTestId("preset-source")).toHaveText("추천")
    await expect(editor.getByTestId("preset-editor-roles")).not.toContainText("DeepSeek")
    await expect(editor.getByTestId("preset-editor-roles")).not.toContainText("Anthropic")

    await role("own-review").getByTestId("preset-editor-change").click()
    const picker = page.getByTestId("preset-target-picker")
    await expect(picker.getByTestId("preset-target-main")).toBeVisible()
    await expect(picker.getByTestId("preset-target-lighter")).toBeVisible()
    await expect(picker.getByTestId("preset-target-hidden")).toHaveText(
      "다른 ChatGPT 계정은 쓸 수 없어 목록에 없어요. 같은 회사 모델은 '메인 계정의 …'으로 고르세요.",
    )
    const paid = picker.getByTestId("preset-target-paid")
    await expect(paid).toHaveText(/API 키로 돌리기 · 돈이 들어요/)
    await expect(paid).toHaveAttribute("aria-expanded", "false")
    await expect(picker.getByTestId("preset-target-row")).toHaveCount(0)
    await paid.click()
    await expect(paid).toHaveAttribute("aria-expanded", "true")
    const deepseek = picker.locator('[data-testid="preset-target-row"][data-badge="prepaid"]')
    await expect(deepseek.first()).toBeDisabled()
    await expect(picker.locator('[data-testid="preset-target-row"][data-badge="metered"]').first()).toBeDisabled()
    const budget = picker.getByTestId("preset-target-budget").first()
    await expect(budget).toHaveText("예산 없음 · 이번 달 $0.00")
    const form = picker.getByTestId("preset-target-budget-form").first()
    await form.getByLabel("월 예산($)").fill("1")
    await form.getByRole("button", { name: "예산 정하기" }).click()
    await expect(budget).toHaveText("월 예산 $1.00 · 이번 달 $0.00")
    await expect(deepseek.first()).toBeEnabled()
    await expect(picker.locator('[data-testid="preset-target-row"][data-badge="metered"]').first()).toBeDisabled()
    await deepseek.filter({ hasText: "DeepSeek V4.1 Flash" }).click()
    await expect(picker).toHaveCount(0)
    await expect(role("own-review")).toContainText(
      "1순위 DeepSeek · DeepSeek V4.1 Flash 1017(고정) → 마지막 메인과 같게",
    )
    await expect(role("own-review").getByTestId("preset-source")).toHaveText("직접 고름")
    await expect(role("own-review")).toContainText("선불 · 이번 달 $0.00 / 예산 $1.00")
    await expect(editor.getByTestId("preset-editor-resolution")).toContainText("리뷰 = DeepSeek V4.1 Flash 1017")

    await editor.getByTestId("preset-editor-name").fill("DeepSeek 리뷰")
    await editor.getByTestId("preset-editor-save").click()
    await expect(page.getByTestId("toasts")).toContainText("프리셋을 저장했어요")
    await expect(editor).toHaveCount(0)
    await expect(page.getByTestId("presets-row").filter({ hasText: "DeepSeek 리뷰" })).toContainText(
      "일마다 정하기 · 역할 3개 · 도움될 때",
    )
    const listed = await accounts(page, "accounts.list", {})
    expect(
      (listed.accounts as ReadonlyArray<{ readonly id: string; readonly budget?: unknown }>).find(
        (account) => account.id === state().accounts.deepseek,
      )?.budget,
    ).toEqual({ monthlyUSD: 1 })
  })

  test("the composer's preset button: the group's presets, 비용 없음 · 바로 적용, no cost dialog", async () => {
    await open(page, state().sessions.button)
    const button = page.getByTestId("composer-preset")
    await expect(button).toHaveText(/프리셋: 평소대로/)
    await button.click()
    const menu = page.getByTestId("preset-menu")
    const items = menu.getByTestId("preset-menu-item")
    await expect(items).toHaveText(["★ 평소대로", "한 번만", "Claude 리뷰", "DeepSeek 리뷰"])
    await expect(menu.getByTestId("preset-menu-note")).toHaveText("비용 없음 · 바로 적용")
    await items.filter({ hasText: "DeepSeek 리뷰" }).click()
    await expect(page.getByTestId("toasts")).toContainText("프리셋 'DeepSeek 리뷰' · 비용 없음 · 바로 적용")
    await expect(button).toHaveText(/프리셋: DeepSeek 리뷰/)
    await expect(page.getByTestId("switch-dialog")).toHaveCount(0)
    await expect(page.getByTestId("ultra-cost-dialog")).toHaveCount(0)
    await expect(page.getByTestId("preset-banner")).toContainText("종량제 대상이 있어요 · 이번 대화 $0.00")
    const view = await accounts(page, "session.preset.get", { sessionID: state().sessions.button }, state().workspace)
    expect((view.preset as { readonly name: string }).name).toBe("DeepSeek 리뷰")
  })

  test("울트라 asks with the cost dialog on a model without effort updates; on GPT-6 Sol it applies at once", async () => {
    const ultra = page.getByTestId("composer-ultra")
    const variant = page.getByTestId("composer-variant")
    await expect(ultra).toHaveAttribute("aria-checked", "false")
    await expect(variant).toHaveText(/^기본/)
    await ultra.click()
    const dialog = page.getByTestId("ultra-cost-dialog")
    await expect(dialog).toContainText("울트라 켜기")
    await expect(dialog).toContainText("추론 강도: 기본 → max")
    await expect(dialog).toContainText("이 모델은 추론 강도를 바꾸면 대화 앞부분을 캐시에 다시 써요.")
    await expect(dialog.getByTestId("ultra-cost-line")).toContainText("전환 비용")
    await dialog.getByRole("button", { name: "취소" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(ultra).toHaveAttribute("aria-checked", "false")

    await ultra.click()
    await dialog.getByTestId("ultra-cost-confirm").click()
    await expect(ultra).toHaveAttribute("aria-checked", "true")
    await expect(variant).toHaveText(/^max\b/)
    await expect(page.getByTestId("toasts")).toContainText("울트라를 켰어요")
    // The ultra caps set above are in force: 5 at once.
    await expect(page.getByTestId("composer-subagent-badge")).toHaveText("하위 에이전트 0/5 실행 중 · 이 메시지 0개")
    await expect(page.getByTestId("preset-banner")).toContainText("울트라 · ChatGPT 01")
    await ultra.click()
    await expect(dialog).toContainText("추론 강도: max → 기본")
    await dialog.getByTestId("ultra-cost-confirm").click()
    await expect(ultra).toHaveAttribute("aria-checked", "false")
    await expect(variant).toHaveText(/^기본/)

    await open(page, state().sessions.sol)
    await expect(variant).toHaveText(/^high\b/)
    await ultra.click()
    await expect(ultra).toHaveAttribute("aria-checked", "true")
    await expect(variant).toHaveText(/^max\b/)
    await expect(dialog).toHaveCount(0)
    await ultra.click()
    await expect(ultra).toHaveAttribute("aria-checked", "false")
    await expect(dialog).toHaveCount(0)
  })

  test("울트라 stays on through a model change; off the effort-update path its new effort waits for the dialog", async () => {
    const ultra = page.getByTestId("composer-ultra")
    const variant = page.getByTestId("composer-variant")
    const dialog = page.getByTestId("ultra-cost-dialog")
    const retune = page.getByTestId("composer-ultra-retune")
    const sessionID = state().sessions.sol
    await open(page, sessionID)
    await ultra.click()
    await expect(variant).toHaveText(/^max\b/)
    await expect(retune).toHaveCount(0)
    // The main moves to GPT-5.6 Sol (no effort updates) with the effort the user had (07 §2.9: ultra's effort is decided again for it).
    const target = { ...state().models["01"], variant: "high" }
    const planned = await accounts(page, "switch.estimate", { sessionID, target, reason: "manual" }, state().workspace)
    await accounts(
      page,
      "switch.apply",
      { sessionID, estimateID: planned.estimateID, target, strategy: "now", reason: "manual" },
      state().workspace,
    )
    await expect(retune).toBeVisible()
    await expect(ultra).toHaveAttribute("aria-checked", "true")
    await retune.click()
    await expect(dialog).toContainText("울트라 강도 맞추기")
    await expect(dialog).toContainText("추론 강도: high → max")
    await dialog.getByTestId("ultra-cost-confirm").click()
    await expect(variant).toHaveText(/^max\b/)
    await expect(retune).toHaveCount(0)
    await expect(page.getByTestId("toasts")).toContainText("울트라 추론 강도를 새 모델에 맞췄어요")
    await ultra.click()
    await dialog.getByTestId("ultra-cost-confirm").click()
    await expect(ultra).toHaveAttribute("aria-checked", "false")
    await expect(variant).toHaveText(/^high\b/)
  })

  test("Claude (UC 2026-10-18): 켤 때 강도도 xhigh로 sits with the switch, kept per conversation, in the effort menu too", async () => {
    const sessionID = state().sessions.claude
    await open(page, sessionID)
    const group = page.locator('.own-cp-ultra-group[data-claude][role="group"]')
    const ultra = group.getByTestId("composer-ultra")
    const box = group.getByRole("checkbox", { name: /켤 때 강도도 xhigh로/ })
    const variant = page.getByTestId("composer-variant")
    const dialog = page.getByTestId("ultra-cost-dialog")
    await expect(ultra).toHaveAttribute("title", /Claude는 추론 강도를 그대로 둬요/)
    await expect(box).not.toBeChecked()
    await expect(box).toHaveAccessibleDescription(/^Claude는 울트라를 켜도 추론 강도를 그대로 둬요\./)
    // This model's levels are high and max: the xhigh intent fits to max (the dry run's change).
    await expect(group.getByTestId("composer-ultra-raise-preview")).toHaveText("(high → max)")
    await page.getByTestId("composer-ultra-info").click()
    await expect(page.getByTestId("composer-ultra-claude-line")).toHaveText(
      "Claude는 강도를 바꿔도 울트라가 켜진 채예요.",
    )
    await page.keyboard.press("Escape")

    // Ticked with ultra off: kept for this conversation across a reload, and the effort menu shows it.
    await box.check()
    await page.reload()
    await unfold(page)
    await expect(box).toBeChecked()
    await variant.click()
    const raiseItem = page.getByTestId("composer-variant-ultra-raise")
    await expect(raiseItem).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("composer-variant-ultra")).toContainText("Claude는 강도를 그대로 둬요")
    await page.keyboard.press("Escape")

    // On: the effort goes up; the box now applies at once. The thinking budget is a variant switch: the cost dialog
    // comes when it rewrites the cache.
    const settle = async (checked: "true" | "false") => {
      await expect(dialog.or(group.locator(`[data-testid="composer-ultra"][aria-checked="${checked}"]`))).toBeVisible()
      if (await dialog.isVisible()) await dialog.getByTestId("ultra-cost-confirm").click()
      await expect(ultra).toHaveAttribute("aria-checked", checked)
    }
    await ultra.click()
    await settle("true")
    await expect(variant).toHaveText(/^max\b/)
    await expect(box).toHaveAccessibleDescription(/바꾸면 바로 적용돼요\.$/)
    const binding = async () => {
      const view = await accounts(page, "session.preset.get", { sessionID }, state().workspace)
      return (view.binding as { readonly ultra?: unknown } | undefined)?.ultra
    }
    await expect.poll(binding).toEqual({ raiseClaude: true, before: "high" })
    // Off: the effort comes back and the box stays ticked for next time.
    await ultra.click()
    await settle("false")
    await expect(variant).toHaveText(/^high\b/)
    await expect(box).toBeChecked()
    await box.uncheck()
    await expect(box).not.toBeChecked()
  })

  test("a cap: the neutral chip offers 이번 메시지만 늘리기 while the turn runs", async () => {
    await open(page, state().sessions.caps)
    await send(page, "[subagent general 첫째 일] [subagent general 둘째 일]")
    const chip = page.locator('[data-testid="subagent-preset-rejected"][data-kind="caps"]')
    await expect(chip).toContainText("하위 에이전트 대기: 메시지 하나당 최대 1개", { timeout: 60_000 })
    await chip.getByTestId("subagent-chip-raise").click()
    await expect(chip).toContainText("이번 메시지만 2개까지 늘렸어요")
    await expect(chip.getByTestId("subagent-chip-raise")).toHaveCount(0)
    await neutral(page)
    await idle(page, state().sessions.caps)
  })

  test("PG1: a model outside the preset is a neutral chip; 하위 에이전트에 추가… prefills the editor, saving nothing", async () => {
    await open(page, state().sessions.model)
    await send(page, "[sub-model own-ds-tmds/deepseek-flash] 딥시크로 맡겨 줘")
    const chip = page.locator('[data-testid="subagent-preset-rejected"][data-kind="model"]')
    await expect(chip).toContainText(
      "하위 에이전트 요청을 막았어요: DeepSeek V4.1 Flash 1017 @ DeepSeek는 이 프리셋에 없어요",
      { timeout: 60_000 },
    )
    await expect(chip.locator("[title]").first()).toHaveAttribute("title", /^model not in this preset\..*Ask the user/)
    await neutral(page)
    await idle(page, state().sessions.model)

    const before = JSON.stringify(await accounts(page, "presets.list", { group: "codex" }))
    await chip.getByTestId("subagent-chip-add").click()
    const editor = page.getByTestId("preset-editor")
    await expect(editor).toContainText("ChatGPT 프리셋 › 새 프리셋")
    await expect(
      editor.getByTestId("preset-editor-workers").getByRole("radio", { name: /일마다 정하기/ }),
    ).toBeChecked()
    const general = editor.locator('[data-testid="preset-editor-role"][data-role="general"]')
    await expect(general).toContainText("1순위 DeepSeek · DeepSeek V4.1 Flash 1017(고정)")
    await expect(general.getByTestId("preset-source")).toHaveText("직접 고름")
    await expect(general).toContainText("선불 · 이번 달 $0.00 / 예산 $1.00")
    await editor.getByRole("button", { name: "취소" }).click()
    await expect(editor).toHaveCount(0)
    expect(JSON.stringify(await accounts(page, "presets.list", { group: "codex" }))).toBe(before)

    await chip.getByTestId("subagent-chip-keep").click()
    await expect(chip.getByTestId("subagent-chip-add")).toHaveCount(0)
  })

  test("PG11 consent: a review that would move onto DeepSeek asks; 이 대화에서만 lets the next one run there", async () => {
    await open(page, state().sessions.consent)
    await send(page, "[subagent own-review 리뷰해 줘]")
    const chip = page.locator('[data-testid="subagent-preset-rejected"][data-kind="consent"]')
    await expect(chip).toContainText("리뷰를 DeepSeek(종량제)로 돌릴까요?", { timeout: 60_000 })
    await expect(chip.getByTestId("subagent-chip-allow")).toHaveText("이 대화에서만")
    await expect(chip.getByTestId("subagent-chip-deny")).toHaveText("아니오")
    await neutral(page)
    await idle(page, state().sessions.consent)
    await chip.getByTestId("subagent-chip-allow").click()
    await expect(chip).toContainText("이 대화에서 DeepSeek를 쓰기로 했어요")

    await send(page, "[subagent own-review 다시 리뷰해 줘]")
    await idle(page, state().sessions.consent)
    await expect(page.getByTestId("subagent-preset-rejected")).toHaveCount(1)
    const view = await accounts(page, "session.preset.get", { sessionID: state().sessions.consent }, state().workspace)
    expect((view.counts as { readonly session: number }).session).toBe(1)
  })

  test("PG11 budget: past the $1 budget the next paid call is declined; the banner shows this conversation's amount", async () => {
    await open(page, state().sessions.budget)
    await page.getByTestId("composer-preset").click()
    await page.getByTestId("preset-menu").getByTestId("preset-menu-item").filter({ hasText: "DeepSeek 리뷰" }).click()
    await expect(page.getByTestId("composer-preset")).toHaveText(/프리셋: DeepSeek 리뷰/)

    await send(page, "[subagent own-review 크게 리뷰 <<big>>]")
    await idle(page, state().sessions.budget)
    await expect
      .poll(
        async () => {
          const snapshot = await accounts(page, "quota.snapshot", { accountIDs: [state().accounts.deepseek] })
          return (snapshot.windows as ReadonlyArray<{ readonly kind: string; readonly status: string }>).some(
            (window) => window.kind === "budget" && window.status === "exhausted",
          )
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    await expect(page.getByTestId("preset-banner")).toContainText(/이번 대화 \$1\.2/)

    await send(page, "[subagent own-review 한 번 더]")
    const chip = page.locator('[data-testid="subagent-preset-rejected"][data-kind="budget"]')
    await expect(chip).toContainText("하위 에이전트 요청을 막았어요: DeepSeek의 이번 달 예산을 다 썼어요", {
      timeout: 60_000,
    })
    await neutral(page)
    await idle(page, state().sessions.budget)
    expect(errors).toEqual([])
  })

  test("모델 묶음: the third choice and its checklist in dark and light, 추천 묶음, paid rows behind a budget; saved", async () => {
    await page.goto("/settings/presets")
    await ready(page)
    await page.getByTestId("preset-tab-codex").click()
    await page.getByTestId("presets-new").click()
    const editor = page.getByTestId("preset-editor")
    const workers = editor.getByTestId("preset-editor-workers")
    await expect(workers.locator(".own-pe-choice-text > span:first-child")).toHaveText([
      "메인과 같은 모델로",
      "다른 모델 하나로",
      "모델 묶음에서 알아서",
      "일마다 정하기",
    ])
    await workers.getByRole("radio", { name: /모델 묶음에서 알아서/ }).check()
    const list = editor.getByTestId("preset-pool")
    await expect(list.getByTestId("preset-pool-main")).toContainText(
      "메인 계정에서 (어느 ChatGPT 계정이 메인이든 그 계정에서 돌아요)",
    )
    await expect(list.getByTestId("preset-pool-hidden")).toHaveText(
      "다른 ChatGPT 계정은 쓸 수 없어 목록에 없어요. 같은 회사 모델은 '메인 계정에서'로 고르세요.",
    )
    const row = (key: string) => list.locator(`[data-testid="preset-pool-row"][data-key="${key}"]`).first()
    const checked = list.locator('[data-testid="preset-pool-row"][data-checked]')

    // 추천 묶음: the newest model of each family on the main account (a subscription group), never a paid one.
    await list.getByTestId("preset-pool-recommended").click()
    await expect(checked.first()).toBeVisible()
    await expect(list.locator('[data-testid="preset-pool-row"][data-runs="paid"][data-checked]')).toHaveCount(0)
    for (let left = await checked.count(); left > 0; left = await checked.count())
      await checked.first().getByTestId("preset-pool-check").uncheck()
    await row("gpt-5.6-sol").getByTestId("preset-pool-check").check()
    await row("gpt-6-luna").getByTestId("preset-pool-check").check()
    await expect(checked).toHaveCount(2)
    await expect(row("gpt-6-luna").getByTestId("preset-pool-badge")).toHaveText("메인 계정")
    await expect(list.getByTestId("preset-pool-defaults")).toContainText("모델을 고르지 않으면:")

    // The paid accounts only behind their row: DeepSeek has the budget set above, the Anthropic API key none yet.
    await expect(list.locator('[data-runs="paid"]')).toHaveCount(0)
    await list.getByTestId("preset-pool-paid").click()
    const paid = list.locator('[data-testid="preset-pool-row"][data-runs="paid"]')
    await expect(paid.filter({ hasText: "DeepSeek V4.1 Flash" }).getByTestId("preset-pool-check")).toBeEnabled()
    await expect(
      paid
        .filter({ hasText: /Claude/ })
        .first()
        .getByTestId("preset-pool-check"),
    ).toBeDisabled()
    await expect(paid.first()).toContainText("돈이 들어요 · 다른 모델로 안 될 때만 써요")

    // Dark (own-web's default) and light: the header's theme toggle is behind the modal editor, so the choice comes
    // the way another window's does (the theme context follows the stored scheme's `storage` events).
    const backgrounds: string[] = []
    for (const scheme of ["dark", "light"] as const) {
      await colorScheme(page, scheme)
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme)
      await expect(list).toBeVisible()
      const colors = await row("gpt-6-luna").evaluate((element) => ({
        text: getComputedStyle(element).color,
        background: getComputedStyle(element.closest("dialog") ?? document.body).backgroundColor,
      }))
      expect(colors.text).not.toBe(colors.background)
      backgrounds.push(colors.background)
      await editor.screenshot({ path: path.join(TMP!, "results", `preset-pool-${scheme}.png`) })
    }
    expect(backgrounds[0]).not.toBe(backgrounds[1])
    await colorScheme(page, "dark")

    await editor.getByTestId("preset-editor-name").fill("모델 묶음 e2e")
    await editor.getByTestId("preset-editor-delegation").getByRole("radio", { name: "도움될 때" }).check()
    await editor.getByTestId("preset-editor-save").click()
    await expect(page.getByTestId("toasts")).toContainText("프리셋을 저장했어요")
    await expect(editor).toHaveCount(0)
    await expect(page.getByTestId("presets-row").filter({ hasText: "모델 묶음 e2e" })).toContainText(
      "모델 묶음에서 알아서 · 모델 2개 · 도움될 때",
    )
    const saved = (await codexPresets(page)).find((item) => item.name === "모델 묶음 e2e")
    // Stored as `메인과 같은 모델로` with the pool (an older build reads it so); the service froze each card.
    expect(saved?.workers).toMatchObject({
      mode: "same",
      pool: [
        { key: "gpt-5.6-sol", model: "gpt-5.6-sol" },
        { key: "gpt-6-luna", model: "gpt-6-luna" },
      ],
    })
    expect(saved?.workers.pool?.every((entry) => typeof entry.card?.at === "number")).toBe(true)
  })

  test("묶음에 추가…: a model outside the pool is a neutral chip; the editor opens with it checked, saving nothing", async () => {
    await open(page, state().sessions.pool)
    await page.getByTestId("composer-preset").click()
    await page.getByTestId("preset-menu").getByTestId("preset-menu-item").filter({ hasText: "모델 묶음 e2e" }).click()
    await expect(page.getByTestId("composer-preset")).toHaveText(/프리셋: 모델 묶음 e2e/)

    await send(page, `[sub-model ${state().models["01"].providerID}/gpt-6-sol] 솔로 맡겨 줘`)
    const chip = page.locator('[data-testid="subagent-preset-rejected"][data-kind="model"]')
    await expect(chip).toContainText("이 모델 묶음에 없어요", { timeout: 60_000 })
    await expect(chip.locator("[title]").first()).toHaveAttribute(
      "title",
      /^model not in this preset\. Allowed models: gpt-5.6-sol, gpt-6-luna\. Ask the user/,
    )
    await neutral(page)
    await idle(page, state().sessions.pool)

    const before = JSON.stringify(await accounts(page, "presets.list", { group: "codex" }))
    await expect(chip.getByTestId("subagent-chip-add")).toHaveText("묶음에 추가…")
    await chip.getByTestId("subagent-chip-add").click()
    const editor = page.getByTestId("preset-editor")
    await expect(editor).toContainText("ChatGPT 프리셋 › 모델 묶음 e2e")
    await expect(
      editor.getByTestId("preset-editor-workers").getByRole("radio", { name: /모델 묶음에서 알아서/ }),
    ).toBeChecked()
    // The main slot's model is a main-account entry: whichever ChatGPT account is the main runs it.
    const sol = editor.locator('[data-testid="preset-pool-row"][data-key="gpt-6-sol"]')
    await expect(sol.getByTestId("preset-pool-check")).toBeChecked()
    await expect(sol.getByTestId("preset-pool-badge")).toHaveText("메인 계정")
    await expect(editor.locator('[data-testid="preset-pool-row"][data-checked]')).toHaveCount(3)
    await editor.getByRole("button", { name: "취소" }).click()
    await expect(editor).toHaveCount(0)
    expect(JSON.stringify(await accounts(page, "presets.list", { group: "codex" }))).toBe(before)
    await chip.getByTestId("subagent-chip-keep").click()
    await expect(chip.getByTestId("subagent-chip-add")).toHaveCount(0)
  })

  test("a pool model that is gone: one repair line; 직접 고르기 opens that entry; 고치기 swaps in the successor", async () => {
    const id = "pr_01JB0000000000000000000009"
    // Codex metadata names a successor for the gone model (07 §4.3 `upgrade.model`), as a fetch would have stored it.
    await replaceJson(path.join(state().ownHome, "codex-meta.json"), {
      version: 1,
      kinds: {
        codex: {
          source: "backend",
          fetchedAt: Date.now(),
          rows: 2,
          models: [{ slug: "gpt-5.4", upgrade: { model: "gpt-6-luna" } }],
        },
      },
    })
    // A hand-edited pool keeps a main-account model the ChatGPT accounts no longer offer.
    const preset = {
      id,
      name: "묶음 수리",
      group: "codex",
      workers: {
        mode: "same",
        roles: {},
        pool: [
          { key: "gpt-5-4", model: "gpt-5.4", note: "예전 모델" },
          { key: "gpt-5.6-sol", model: "gpt-5.6-sol" },
        ],
      },
      delegation: "when-useful",
      caps: { concurrent: 3, perMessage: 6, perSession: 100 },
      ultraCaps: null,
      revision: 1,
    }
    await handWrite(page, preset)

    await page.goto("/settings/presets")
    await ready(page)
    await page.getByTestId("preset-tab-codex").click()
    const line = page.locator('[data-testid="preset-repair"][data-model="gpt-5.4"]')
    await expect(line).toContainText(
      /모델 묶음의 gpt-5-4: .+가 없어져 고칠 때까지 고르면 기본 규칙으로 돌아요 · 프리셋 1개/,
      {
        timeout: 60_000,
      },
    )
    await expect(line.getByTestId("preset-repair-fix")).toHaveText("GPT-6 Luna로 고치기")
    await expect(page.getByTestId("presets-row").filter({ hasText: "묶음 수리" })).toContainText("고칠 것 있음")

    await line.getByTestId("preset-repair-pick").click()
    const editor = page.getByTestId("preset-editor")
    await expect(editor).toContainText("ChatGPT 프리셋 › 묶음 수리")
    const entry = editor.locator('[data-testid="preset-detail-pool-entry"][data-key="gpt-5-4"]')
    await expect(entry).toHaveAttribute("data-focus", "")
    await expect(entry.getByTestId("preset-detail-pool-note")).toHaveValue("예전 모델")
    await expect(editor.getByTestId("preset-detail-targets")).toHaveCount(0)
    await editor.getByRole("button", { name: "취소" }).click()
    await expect(editor).toHaveCount(0)

    await line.getByTestId("preset-repair-fix").click()
    await expect(page.getByTestId("toasts")).toContainText("고쳤어요")
    await expect(line).toHaveCount(0)
    const fixed = (await codexPresets(page)).find((item) => item.id === id)
    expect(fixed?.workers.pool?.map((item) => item.model)).toEqual(["gpt-6-luna", "gpt-5.6-sol"])
    expect(fixed?.workers.pool?.[0]).toMatchObject({ note: "예전 모델" })
    const view = (await accounts(page, "presets.list", { group: "codex" })).groups as ReadonlyArray<{
      readonly poolHistory?: ReadonlyArray<{ readonly presetID: string; readonly from: string; readonly to?: string }>
    }>
    expect(view[0]?.poolHistory?.filter((record) => record.presetID === id)).toMatchObject([
      { from: "gpt-5.4", to: "gpt-6-luna" },
    ])
    expect(errors).toEqual([])
  })

  test("PF 2026-11-03: three Claude accounts in [계정 ▾], the local model group, hiding a model and a fixed effort", async () => {
    // This backend installs no Claude slot and no local server: the service's answers carry three Claude accounts
    // (AC-01 is the slot's own) and an OpenAI-compatible local model, as own-accounts makes them (unit-tested in
    // own-accounts test/presets/pf.test.ts). Everything else is the real service.
    const claude = ["acc_claude_slot", "acc_01J9PFC4AD0000000000000002", "acc_01J9PFC4AD0000000000000003"]
    await page.route("**/own.accounts/accounts.list**", async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as { output: { accounts: Array<Record<string, unknown>> } }
      const base = body.output.accounts.find((account) => account.kind === "anth") ?? body.output.accounts[0]!
      const views = claude.map((id, index) => ({
        ...base,
        id,
        kind: "claude-sub",
        label: `AC-0${index + 1}`,
        shortLabel: `C${index + 1}`,
        providerID: "anthropic",
        billing: "subscription",
        status: "ready",
      }))
      await route.fulfill({
        response,
        json: { ...body, output: { ...body.output, accounts: [...body.output.accounts, ...views] } },
      })
    })
    await page.route("**/own.accounts/presets.suggest**", async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as {
        output: { pool?: { candidates: Array<Record<string, unknown>>; recommended: string[] } }
      }
      const pool = body.output.pool
      if (!pool) return route.fulfill({ response })
      const models = [
        { model: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { model: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      ]
      const rows = claude.flatMap((account) =>
        models.map((item) => ({
          key: item.model,
          model: item.model,
          account,
          card: { name: item.name, window: 1_000_000, reasoning: true, image: true },
          runs: "subscription",
          company: "anthropic",
          released: 1_790_000_000_000,
        })),
      )
      const local = {
        key: "local-flash-model-q4-0001",
        model: "local-flash-model-q4-0001",
        card: { name: "local-flash-model-q4-0001", window: 1_000_000, image: true },
        runs: "local",
        released: 1_790_000_000_000,
      }
      await route.fulfill({
        response,
        json: {
          ...body,
          output: { ...body.output, pool: { ...pool, candidates: [...pool.candidates, local, ...rows] } },
        },
      })
    })
    await page.goto("/settings/presets")
    await ready(page)
    await page.getByTestId("preset-tab-codex").click()
    await page.getByTestId("presets-new").click()
    const editor = page.getByTestId("preset-editor")
    await editor
      .getByTestId("preset-editor-workers")
      .getByRole("radio", { name: /모델 묶음에서 알아서/ })
      .check()
    const list = editor.getByTestId("preset-pool")
    const row = (key: string) => list.locator(`[data-testid="preset-pool-row"][data-key="${key}"]`).first()

    // [계정 ▾]: every Claude account, not only account 1; another account moves the rows to its own.
    const company = list.locator('[data-testid="preset-pool-company"][data-company="anthropic"]')
    await expect(company).toContainText("Claude 구독")
    const select = company.getByTestId("preset-pool-account")
    await expect(select.locator("option")).toHaveText(["AC-01", "AC-02", "AC-03"])
    await select.selectOption(claude[2]!)
    await expect(select).toHaveValue(claude[2]!)
    await expect(row("claude-opus-5-5")).toBeVisible()
    await expect(row("claude-sonnet-5-5")).toBeVisible()

    // 로컬 모델: its own group, free, never "only when others fail".
    await expect(list.getByTestId("preset-pool-local")).toContainText("로컬 모델")
    const local = row("local-flash-model-q4-0001")
    await expect(local).toHaveAttribute("data-runs", "local")
    await expect(local.getByTestId("preset-pool-badge")).toHaveText("로컬 · 무료")
    await expect(local).not.toContainText("돈이 들어요")

    // 목록에서 숨기기: the row leaves the list, 숨긴 모델 1개 shows it again, 다시 보이기 restores it.
    await expect(row("gpt-5.6-sol")).toBeVisible()
    await row("gpt-5.6-sol").getByTestId("preset-pool-hide").click()
    await expect(row("gpt-5.6-sol")).toHaveCount(0)
    await expect
      .poll(async () => ((await accounts(page, "policy.get", {})).policy as { hiddenModels?: unknown }).hiddenModels)
      .toEqual([{ group: "codex", model: "gpt-5.6-sol" }])
    const tucked = list.getByTestId("preset-pool-hidden-models")
    await expect(tucked).toHaveText(/숨긴 모델 1개/)
    await tucked.click()
    await expect(row("gpt-5.6-sol").getByTestId("preset-pool-hidden-tag")).toHaveText("숨김")
    await row("gpt-5.6-sol").getByTestId("preset-pool-hide").click()
    await expect(row("gpt-5.6-sol").getByTestId("preset-pool-hidden-tag")).toHaveCount(0)
    await expect
      .poll(async () => ((await accounts(page, "policy.get", {})).policy as { hiddenModels?: unknown }).hiddenModels)
      .toEqual([])

    // A checked model the user hides stays in the pool and in view, marked hidden; the preset still uses it.
    await row("gpt-6-luna").getByTestId("preset-pool-check").check()
    await row("gpt-6-luna").getByTestId("preset-pool-hide").click()
    await expect(row("gpt-6-luna").getByTestId("preset-pool-hidden-tag")).toHaveText("숨김")
    await expect(row("gpt-6-luna")).toHaveAttribute("data-checked", "")

    // 강도 고정: the whole preset at low, the Luna entry at medium of its own; saved with the preset.
    await editor.getByTestId("preset-editor-details").click()
    const detail = editor.getByTestId("preset-detail")
    await detail.getByTestId("preset-detail-force-level").selectOption("low")
    // One labelled 추론 강도 per entry (PE 2026-11-08): usual efforts and fixed levels in two groups; the preset's
    // fixed low comes first until the entry fixes its own.
    const entryEffort = detail.getByTestId("preset-detail-pool-effort")
    await expect(entryEffort).toHaveAccessibleName(/추론 강도/)
    await expect(entryEffort.locator("optgroup")).toHaveCount(2)
    const entryHint = detail.getByTestId("preset-detail-pool-effort-hint")
    await expect(entryHint).toContainText("강도 고정(low)이 먼저")
    await entryEffort.selectOption("fixed:medium")
    await expect(entryHint).toContainText("언제나 medium")
    await expect(detail.getByTestId("preset-detail-force")).toContainText("강도 고정")
    // 하위 에이전트 역할: every role with what it may do and where it runs now.
    const roles = detail.getByTestId("preset-detail-roles").getByTestId("preset-role")
    await expect(roles).toHaveCount(5)
    await expect(roles.locator('[data-access="search"]')).toHaveCount(1)
    await expect(detail.locator('[data-testid="preset-role"][data-role="explore"]')).toContainText("읽고 찾기만")
    await expect(detail.locator('[data-testid="preset-role"][data-role="own-review"]')).toContainText(
      "파일을 고치지 않아요",
    )
    await expect(roles.getByTestId("preset-role-runs").first()).toContainText(/지금: .+ @ .+ · (low|medium) 고정/)
    await editor.getByTestId("preset-editor-name").fill("강도 고정 e2e")
    await editor.getByTestId("preset-editor-save").click()
    await expect(page.getByTestId("toasts")).toContainText("프리셋을 저장했어요")
    const saved = (await codexPresets(page)).find((item) => item.name === "강도 고정 e2e") as
      | (ListedPreset & { readonly forcedEffort?: string })
      | undefined
    expect(saved?.forcedEffort).toBe("low")
    expect(saved?.workers.pool).toMatchObject([{ key: "gpt-6-luna", forcedEffort: "medium" }])
    await page.unrouteAll({ behavior: "wait" })

    // Applied to the GPT-6 Sol conversation (high): its main runs at low, and the switcher says the preset set it.
    await open(page, state().sessions.sol)
    await page.getByTestId("composer-preset").click()
    await page.getByTestId("preset-menu").getByTestId("preset-menu-item").filter({ hasText: "강도 고정 e2e" }).click()
    await expect(page.getByTestId("composer-variant")).toHaveText(/^low\b/, { timeout: 60_000 })
    await page.getByTestId("composer-switcher").click()
    await expect(page.getByTestId("switcher-forced-effort")).toHaveText(
      /프리셋 '강도 고정 e2e'.{1,2} 강도를 low.{1,2} 정해요/,
    )

    // The switcher's model column: a model the user hides leaves it; 숨긴 모델 n개 shows it again to bring it back.
    const hideable = page
      .getByTestId("switcher-model")
      .filter({ has: page.getByTestId("switcher-model-hide") })
      .first()
    const rowID = await hideable.getAttribute("id")
    await hideable.getByTestId("switcher-model-hide").click()
    await expect(page.locator(`[id="${rowID}"]`)).toHaveCount(0)
    // Luna, hidden in the editor above, is one of them.
    await expect(page.getByTestId("switcher-hidden-models")).toContainText("숨긴 모델 2개")
    await page.getByTestId("switcher-hidden-models").click()
    const back = page.locator(`[id="${rowID}"]`)
    await expect(back.getByTestId("switcher-model-hidden")).toHaveText("숨김")
    await back.getByTestId("switcher-model-hide").click()
    await expect(back.getByTestId("switcher-model-hidden")).toHaveCount(0)
    await page.keyboard.press("Escape")

    // 설정 > 프리셋 > 숨긴 모델 lists the hidden Luna and brings it back.
    await page.goto("/settings/presets")
    await ready(page)
    const hidden = page.getByTestId("presets-hidden-models")
    const luna = hidden.locator('[data-testid="presets-hidden-row"][data-model="gpt-6-luna"]')
    await expect(luna).toBeVisible()
    await luna.getByTestId("presets-hidden-show").click()
    await expect(luna).toHaveCount(0)
    await expect
      .poll(async () => ((await accounts(page, "policy.get", {})).policy as { hiddenModels?: unknown }).hiddenModels)
      .toEqual([])
    expect(errors).toEqual([])
  })

  test("PF5: the production build's initial JS stays within budget and holds no team or preset screen", async () => {
    test.setTimeout(300_000)
    // Under test:e2e:all (OWN_WEB_DIST_BUILT=1) dist/ is that run's build, which the other worker's suite may be
    // serving: vite would empty it under that suite. Run alone, the check measures a build of its own.
    if (process.env.OWN_WEB_DIST_BUILT !== "1") {
      const build = bun(["run", "build"])
      expect(build.status, build.stderr).toBe(0)
    }
    const size = bun(["run", "script/bundle-size.ts", "--json"])
    expect(size.status, size.stdout).toBe(0)
    const report = JSON.parse(size.stdout.trim().split("\n").at(-1)!) as {
      readonly initialJsGzip: number
      readonly desktopLeak: boolean
      readonly files: ReadonlyArray<{ readonly file: string }>
    }
    expect(report.initialJsGzip).toBeLessThanOrEqual(400 * 1024)
    expect(report.desktopLeak).toBe(false)
    const sources = report.files.flatMap((item) => {
      const map = path.join(PACKAGE, "dist", `${item.file}.map`)
      return fs.existsSync(map)
        ? (JSON.parse(fs.readFileSync(map, "utf8")) as { readonly sources: readonly string[] }).sources
        : []
    })
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.map((source) => source.replaceAll("\\", "/")).filter((source) => SCREENS.test(source))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

async function open(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  await ready(page)
  await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)).toBeVisible()
  await unfold(page)
}

/** With the sidebar and the work panel open the composer folds its tools behind ⋯ (03 §4.6): unfold them. */
async function unfold(page: Page) {
  await expect(page.getByTestId("composer-switcher")).toBeVisible({ timeout: 60_000 })
  const more = page.getByTestId("composer-more")
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true") await more.click()
}

/** Types into the real composer and sends with Enter (does not wait for the turn). */
async function send(page: Page, text: string) {
  const box = page.locator("#own-composer-input")
  await box.click()
  await box.fill(text)
  await box.press("Control+Enter")
  await expect(box).toHaveValue("")
}

/** The session's newest message is its `idle` marker: the turn ended. */
async function idle(page: Page, sessionID: string) {
  const query = `location%5Bdirectory%5D=${encodeURIComponent(state().workspace)}`
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/session/${sessionID}/message?limit=1&${query}`)
        const body = (await response.json()) as { readonly data?: ReadonlyArray<{ readonly type: string }> }
        return body.data?.[0]?.type
      },
      { timeout: 90_000 },
    )
    .toBe("idle")
}

/** A refusal is the gate working: no failure card and no core failure text (07 §5.4 거절 경로, PG1). */
async function neutral(page: Page) {
  await expect(page.locator('[data-kind="tool-error-card"]')).toHaveCount(0)
  await expect(page.getByText("Unknown agent")).toHaveCount(0)
}

/** Bun from this package's folder; on Windows `bun` may be a `.cmd` shim, which only a shell starts. */
function bun(args: readonly string[]) {
  return spawnSync("bun", args, { cwd: PACKAGE, encoding: "utf8", shell: process.platform === "win32" })
}

/**
 * Adds a ChatGPT-group preset to `presets.json` by hand, as a user may, until the service lists it: the service writes
 * the file too and does not take this writer's lock, so a write of its may replace this one (backend.ts `handWrite`).
 */
async function handWrite(page: Page, preset: { readonly id: string }) {
  const file = path.join(state().ownHome, "presets.json")
  await expect
    .poll(
      async () => {
        const current = JSON.parse(await fs.promises.readFile(file, "utf8")) as {
          readonly groups: Record<string, { readonly presets?: ReadonlyArray<unknown> }>
        }
        if (!JSON.stringify(current).includes(preset.id)) {
          const codex = current.groups.codex ?? {}
          await replaceJson(file, {
            ...current,
            groups: { ...current.groups, codex: { ...codex, presets: [...(codex.presets ?? []), preset] } },
          })
        }
        return (await codexPresets(page)).some((item) => item.id === preset.id)
      },
      { timeout: 60_000 },
    )
    .toBe(true)
}

/** Sets own-web's color scheme as another window would: the stored choice and its `storage` event. */
async function colorScheme(page: Page, scheme: "dark" | "light") {
  await page.evaluate((value) => {
    localStorage.setItem("opencode-color-scheme", value)
    window.dispatchEvent(new StorageEvent("storage", { key: "opencode-color-scheme", newValue: value }))
  }, scheme)
}

/** Writes JSON next to `file` and renames it over, so the service's watcher never reads half a file. */
async function replaceJson(file: string, value: unknown) {
  const temp = `${file}.e2e-${process.pid}`
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2))
  await fs.promises.rename(temp, file)
}

interface ListedPreset {
  readonly id: string
  readonly name: string
  readonly workers: {
    readonly pool?: ReadonlyArray<{
      readonly key: string
      readonly model: string
      readonly note?: string
      readonly card?: { readonly at?: number }
    }>
  }
}

/** The ChatGPT group's presets as `presets.list` gives them. */
async function codexPresets(page: Page) {
  const listed = await accounts(page, "presets.list", { group: "codex" })
  return (listed.groups as ReadonlyArray<{ readonly presets?: ReadonlyArray<ListedPreset> }>)[0]?.presets ?? []
}

/** An own.accounts RPC through the page's API path (the dev proxy adds the auth), at the control location by default. */
async function accounts(page: Page, method: string, input: unknown, directory = state().control) {
  const response = await page.request.post(
    `/api/rpc/own.accounts/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    { data: { input } },
  )
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`own.accounts ${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}
